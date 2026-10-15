// 自定义模型配置文件（对标 WorkBuddy ~/.workbuddy/models.json）：
// ~/.mjcode/models.json → 解析校验 → 同步进 LocalStore providers（source:'file'）+ localVault。
// 路径跨 OS：os.homedir()（macOS /Users/x/.mjcode、Linux /home/x/.mjcode、Windows C:\Users\x\.mjcode）。
//
// 支持两种条目格式（2026-10-15 v2 起）：
//   A. 分组格式（推荐，与 App「一个 base_url + 一个 Key + 多 ModelId」的设计一致）：
//      { "name": "deepseek", "url": "https://api.deepseek.com", "apiKey": "sk-...",
//        "models": ["deepseek-flash", { "id": "m2", "name": "模型二" }] }
//      url 键名兼容 url / baseUrl / base_url；models 项可为字符串（=模型 id）或对象。
//   B. 扁平格式（WorkBuddy 原生，向后兼容）：每条一个模型
//      { "id": "m1", "name": "...", "vendor": "...", "url": "...", "apiKey": "..." }
//      同 url+Key 的扁平条目自动归并为一个 provider 多模型。
//
// 文件是一等事实来源：UI 对 file 来源 provider 的删除/添加会写回文件（见 removeModelFromRaw 等）；
// sync 按 fileKey（url+key 稳定哈希）对账——新增 upsert、消失即剪除，重复 sync 幂等。
// Key 安全：文件在本机（仓库外），写回时 best-effort chmod 0600；日志绝不打印 Key；
// 支持 apiKeyEnv 间接引用环境变量；Key 含非 ASCII（如占位中文）产生解析告警。
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODELS_FILE_ENV = 'MJCODE_MODELS_FILE';

function modelsFilePath() {
  if (process.env[MODELS_FILE_ENV]) return String(process.env[MODELS_FILE_ENV]);
  return path.join(os.homedir(), '.mjcode', 'models.json');
}

// 稳定标识：同一 url+Key 的条目集合在多次 sync 间保持同一 provider 身份
function fileKeyFor(baseUrl, keyRef) {
  const h = crypto.createHash('sha1').update(`${baseUrl}|${keyRef}`).digest('hex');
  return `f-${h.slice(0, 10)}`;
}

// url 兼容三种键名 + 剥完整端点（.../chat/completions）成 base_url
function entryBaseUrl(entry) {
  const raw = String(entry.url || entry.baseUrl || entry.base_url || '').trim();
  return raw.replace(/\/chat\/completions\/?$/i, '').replace(/\/+$/, '');
}

function defaultCaps(entry = {}) {
  return {
    supportsToolCall: entry.supportsToolCall !== false,
    supportsImages: entry.supportsImages === true,
    supportsReasoning: entry.supportsReasoning === true,
    ...(entry.reasoning?.supportedEfforts ? { supportedEfforts: entry.reasoning.supportedEfforts } : {}),
  };
}

function keyRefOf(entry, apiKey) {
  if (entry.apiKeyEnv) return `env:${String(entry.apiKeyEnv).trim()}`;
  return apiKey ? 'key:set' : 'key:empty';
}

// 解析单个模型项：字符串（=id）或 { id, name, ...caps }
// 能力字段 = 条目级（capsSource）打底、模型级覆盖——扁平格式的 entry caps 不能丢
function parseModelItem(item, capsSource = {}) {
  const caps = defaultCaps({ ...(capsSource || {}), ...(item && typeof item === 'object' ? item : {}) });
  if (typeof item === 'string') {
    const id = item.trim();
    return id ? { modelId: id, displayName: id, caps } : null;
  }
  if (item && typeof item === 'object') {
    const id = String(item.id || item.modelId || item.model_id || '').trim();
    if (!id) return null;
    return {
      modelId: id,
      displayName: String(item.name || item.displayName || item.display_name || '').trim() || id,
      caps,
    };
  }
  return null;
}

// 解析 Key：apiKey 明文 / apiKeyEnv 环境变量间接引用（值不落文件）
function resolveApiKey(entry, env) {
  if (entry.apiKeyEnv) {
    const envName = String(entry.apiKeyEnv).trim();
    return { apiKey: String(env[envName] || ''), envName };
  }
  return { apiKey: entry.apiKey != null ? String(entry.apiKey) : '' };
}

// 纯函数：解析 + 校验 + 归并。raw 为 JSON 文本。返回 { providers, errors }
// provider: { fileKey, name, base_url, apiKey, models: [{ modelId, displayName, caps }] }
function parseModelsFile(raw, { env = process.env } = {}) {
  const errors = [];
  let list;
  try {
    list = JSON.parse(String(raw || ''));
  } catch (e) {
    return { providers: [], errors: [{ error: `JSON 解析失败：${e.message}` }] };
  }
  if (!Array.isArray(list)) return { providers: [], errors: [{ error: '配置文件必须是数组（形如 [{ name, url, apiKey, models: [...] }]）' }] };

  const groups = new Map(); // fileKey -> provider
  const ensureGroup = (fileKey, name, base, apiKey) => {
    if (!groups.has(fileKey)) {
      groups.set(fileKey, { fileKey, name, base_url: base, apiKey, models: [] });
    }
    return groups.get(fileKey);
  };

  list.forEach((entry, index) => {
    const at = `第 ${index + 1} 条`;
    if (!entry || typeof entry !== 'object') { errors.push({ index, error: `${at}：不是对象` }); return; }

    const base = entryBaseUrl(entry);
    if (!/^https?:\/\//i.test(base)) { errors.push({ index, error: `${at}：url/baseUrl 缺失或非 http(s) 地址` }); return; }

    const { apiKey, envName } = resolveApiKey(entry, env);
    if (entry.apiKeyEnv && !apiKey) {
      errors.push({ index, error: `${at}：环境变量 ${envName} 未设置（模型仍会导入，Key 为空）` });
    }
    if (apiKey && /[^\x20-\x7E]/.test(apiKey)) {
      errors.push({ index, error: `${at}：apiKey 含非 ASCII 字符（可能是占位符未替换），请求时会失败，请替换为真实 Key` });
    }

    const fileKey = fileKeyFor(base, `${keyRefOf(entry, apiKey)}|${apiKey}`);

    // 分组格式：顶层无 id、有 models 数组
    if (Array.isArray(entry.models)) {
      const name = String(entry.name || entry.vendor || '').trim();
      const group = ensureGroup(fileKey, name, base, apiKey);
      if (!group.name && name) group.name = name;
      let added = 0;
      for (const item of entry.models) {
        const m = parseModelItem(item, entry);
        if (!m) { errors.push({ index, error: `${at}：models 中存在无法解析的项（缺少 id）` }); continue; }
        if (!group.models.some((x) => x.modelId === m.modelId)) group.models.push(m);
        added += 1;
      }
      if (!group.name) group.name = group.models[0]?.displayName || base;
      if (added === 0 && entry.models.length > 0) { /* 逐项错误已记录 */ }
      return;
    }

    // 扁平格式（WorkBuddy 兼容）：顶层 id = 单模型
    const id = String(entry.id || '').trim();
    if (!id) { errors.push({ index, error: `${at}：缺少 id（扁平格式）或 models 数组（分组格式）` }); return; }
    const group = ensureGroup(fileKey, String(entry.vendor || '').trim() || String(entry.name || '').trim(), base, apiKey);
    if (!group.name) group.name = String(entry.name || '').trim() || id;
    const m = parseModelItem({ id, name: entry.name }, entry);
    if (m && !group.models.some((x) => x.modelId === m.modelId)) group.models.push(m);
  });

  return { providers: [...groups.values()], errors };
}

// 序列化（写回用）：统一产出分组格式；模型带非默认能力时保留能力字段
function serializeProviders(groups) {
  const arr = (groups || []).map((g) => {
    const models = (g.models || []).map((m) => {
      const caps = m.caps || {};
      const plain = { id: m.modelId };
      if (m.displayName && m.displayName !== m.modelId) plain.name = m.displayName;
      if (caps.supportsToolCall === false) plain.supportsToolCall = false;
      if (caps.supportsImages === true) plain.supportsImages = true;
      if (caps.supportsReasoning === true) plain.supportsReasoning = true;
      return plain;
    });
    const out = { name: g.name || '', url: g.base_url };
    if (g.apiKey) out.apiKey = g.apiKey;
    out.models = models;
    return out;
  });
  return `${JSON.stringify(arr, null, 2)}\n`;
}

// ── 迁移：把 UI 手工配置的 provider 写入配置文件（分组格式）──
// providers: store 中的 UI provider [{ id, name, base_url, keyEncrypted, models }]
// decrypt(keyEncrypted) -> 明文 Key。返回 { raw, migrated: [{ id, matched }] }
//   matched = 文件里已有同 url+Key 组（模型并入）；否则新增组。两条路都视为「已由文件承载」，
//   调用方（main）在写盘成功后删除这些 UI provider，避免同模型双份显示。
function migrateLocalProviders({ raw, providers, decrypt, env = process.env } = {}) {
  const { providers: fileGroups } = parseModelsFile(raw || '[]', { env });
  const groups = fileGroups.map((g) => ({ ...g, models: [...g.models] }));
  const migrated = [];

  for (const p of providers || []) {
    const key = String(decrypt ? decrypt(p.keyEncrypted) : p.keyEncrypted || '');
    const models = (p.models || []).map((m) => ({
      modelId: String(m.modelId || m.model_id || ''),
      displayName: String(m.displayName || m.display_name || m.modelId || m.model_id || ''),
      caps: defaultCaps(),
    })).filter((m) => m.modelId);
    if (!models.length) continue;

    let group = groups.find((g) => g.base_url === p.base_url && g.apiKey === key);
    const matched = !!group;
    if (!group) {
      group = { fileKey: fileKeyFor(p.base_url, `${key ? 'key:set' : 'key:empty'}|${key}`), name: p.name, base_url: p.base_url, apiKey: key, models: [] };
      groups.push(group);
    }
    for (const m of models) {
      if (!group.models.some((x) => x.modelId === m.modelId)) group.models.push(m);
    }
    migrated.push({ id: p.id, matched });
  }

  return { raw: serializeProviders(groups), migrated };
}

// ── 文件写回（UI 对 file 来源 provider 的增删）──
// 按 fileKey 定位组；组内最后一个模型被删除时整组移除（sync 随后剪除该 provider）。
function removeModelFromRaw(raw, fileKey, modelId, { env = process.env } = {}) {
  const { providers } = parseModelsFile(raw || '[]', { env });
  const group = providers.find((g) => g.fileKey === String(fileKey));
  if (!group) return { ok: false, error: '配置文件中找不到对应的模型服务（可能已被删除）' };
  const remaining = group.models.filter((m) => m.modelId !== String(modelId));
  if (remaining.length === group.models.length) return { ok: false, error: `该服务下不存在模型 ${modelId}` };
  const next = providers
    .map((g) => (g.fileKey === group.fileKey ? { ...group, models: remaining } : g))
    .filter((g) => g.models.length > 0);
  return { ok: true, raw: serializeProviders(next) };
}

function removeProviderFromRaw(raw, fileKey, { env = process.env } = {}) {
  const { providers } = parseModelsFile(raw || '[]', { env });
  const group = providers.find((g) => g.fileKey === String(fileKey));
  if (!group) return { ok: false, error: '配置文件中找不到对应的模型服务（可能已被删除）' };
  const next = providers.filter((g) => g.fileKey !== group.fileKey);
  return { ok: true, raw: serializeProviders(next) };
}

function addModelToRaw(raw, fileKey, modelId, displayName, { env = process.env } = {}) {
  const { providers } = parseModelsFile(raw || '[]', { env });
  const group = providers.find((g) => g.fileKey === String(fileKey));
  if (!group) return { ok: false, error: '配置文件中找不到对应的模型服务（可能已被删除）' };
  const id = String(modelId || '').trim();
  if (!id) return { ok: false, error: '模型 ID 不能为空' };
  if (group.models.some((m) => m.modelId === id)) return { ok: false, error: '该模型已存在' };
  const next = providers.map((g) => (g.fileKey === group.fileKey
    ? { ...group, models: [...group.models, { modelId: id, displayName: String(displayName || '').trim() || id, caps: defaultCaps() }] }
    : g));
  return { ok: true, raw: serializeProviders(next) };
}

// ── 模板与文件 IO ──
function templateContent() {
  return JSON.stringify([
    {
      name: '我的模型服务',
      url: 'https://api.example.com/v1',
      apiKey: 'sk-请替换成你的Key',
      models: ['model-id-1', 'model-id-2'],
    },
  ], null, 2) + '\n';
}

// 确保文件存在（不存在则写模板，目录 0700 / 文件 0600）；返回 { path, created }
function ensureModelsFile(filePath = modelsFilePath()) {
  if (fs.existsSync(filePath)) return { path: filePath, created: false };
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, templateContent(), { mode: 0o600 });
  return { path: filePath, created: true };
}

// 读取文件原文（不存在返回 null）
function readModelsFile(filePath = modelsFilePath()) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function writeModelsFile(raw, filePath = modelsFilePath()) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, raw, { mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch { /* 只读介质等场景忽略 */ }
}

// 同步：parse → 对账进 store（addProvider/updateFileProvider）→ 剪除已从文件消失的条目 → vault 注入。
// 依赖注入：{ store: LocalStore, encrypt(plain)->cipher, vault: Map, env }
// 返回 { ok, synced, removed, errors, path }
function syncFileModels({ store, encrypt, vault, raw, filePath = modelsFilePath(), env = process.env } = {}) {
  const { providers, errors } = parseModelsFile(raw, { env });
  const keep = [];
  for (const fp of providers) {
    if (!store.findProviderByFileKey(fp.fileKey)) {
      store.addProvider({
        name: fp.name, base_url: fp.base_url,
        keyEncrypted: encrypt(fp.apiKey || ''),
        modelId: fp.models[0]?.modelId || '',
        source: 'file', fileKey: fp.fileKey,
      });
    }
    // 统一走 updateFileProvider：首同步也落完整模型列表（addProvider 仅落首模型兼容字段）
    const p = store.updateFileProvider(store.findProviderByFileKey(fp.fileKey).id, {
      name: fp.name, base_url: fp.base_url,
      keyEncrypted: encrypt(fp.apiKey || ''),
      models: fp.models,
    });
    if (vault) vault.set(Number(p.id), { api_key: fp.apiKey || '', base_url: fp.base_url });
    keep.push(fp.fileKey);
  }
  const removed = store.pruneFileProviders(keep);
  return { ok: errors.length === 0, synced: providers.length, removed, errors, path: filePath };
}

module.exports = {
  MODELS_FILE_ENV, modelsFilePath, fileKeyFor, entryBaseUrl,
  parseModelsFile, serializeProviders, migrateLocalProviders,
  removeModelFromRaw, removeProviderFromRaw, addModelToRaw,
  templateContent, ensureModelsFile, readModelsFile, writeModelsFile, syncFileModels,
};
