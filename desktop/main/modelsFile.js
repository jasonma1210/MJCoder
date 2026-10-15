// 自定义模型配置文件（对标 WorkBuddy ~/.workbuddy/models.json）：
// ~/.mjcode/models.json → 解析校验 → 同步进 LocalStore providers（source:'file'）+ localVault。
// 设计要点：
//   · 文件是一等事实来源：增/改/删都在文件里做，UI 只读展示（badge「配置文件」），
//     sync 按 fileKey（url+key 稳定哈希）对账——新增 upsert、消失即剪除，重复 sync 幂等。
//   · 兼容 WorkBuddy 格式：{ id, name, vendor, url, apiKey, supportsToolCall, ... }；
//     url 允许写完整 chat/completions 端点（自动剥成 base_url），也允许直接写 base_url。
//   · Key 安全：文件在本机（~/.mjcode，仓库外），同步时 best-effort chmod 0600；
//     Key 进 localVault 走既有加密/内存轨道；日志绝不打印 Key；支持 apiKeyEnv 间接引用环境变量。
//   · 同 url+Key 的多条目归并为一个 provider 多模型（与 UI 手工添加的结构一致）。
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

// WorkBuddy 的 url 可能是完整端点（.../chat/completions）也可能是 base_url——统一剥成 base_url
function toBaseUrl(url) {
  return String(url || '').trim().replace(/\/chat\/completions\/?$/i, '').replace(/\/+$/, '');
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
  if (!Array.isArray(list)) return { providers: [], errors: [{ error: '配置文件必须是数组（形如 [{ id, url, apiKey, ... }]）' }] };

  const groups = new Map(); // fileKey -> provider
  list.forEach((entry, index) => {
    const at = `第 ${index + 1} 条${entry && entry.id ? `（${entry.id}）` : ''}`;
    if (!entry || typeof entry !== 'object') { errors.push({ index, error: `${at}：不是对象` }); return; }
    const id = String(entry.id || '').trim();
    if (!id) { errors.push({ index, error: `${at}：缺少 id` }); return; }
    const url = String(entry.url || '').trim();
    if (!/^https?:\/\//i.test(url)) { errors.push({ index, error: `${at}：url 缺失或非 http(s) 地址` }); return; }

    // Key 解析：apiKey 明文 / apiKeyEnv 环境变量间接引用（值不落文件）
    let apiKey = '';
    let keyRef = '';
    if (entry.apiKeyEnv) {
      const envName = String(entry.apiKeyEnv).trim();
      apiKey = String(env[envName] || '');
      keyRef = `env:${envName}`;
      if (!apiKey) errors.push({ index, error: `${at}：环境变量 ${envName} 未设置（模型仍会导入，Key 为空）` });
    } else if (entry.apiKey != null) {
      apiKey = String(entry.apiKey);
      keyRef = `key:${apiKey ? 'set' : 'empty'}`;
    } else {
      keyRef = 'key:empty'; // 本地推理服务（Ollama/LM Studio）常无 Key
    }

    const base = toBaseUrl(url);
    const fileKey = fileKeyFor(base, keyRef === 'key:empty' ? 'key:empty' : `${keyRef}|${apiKey}`);
    const model = {
      modelId: id,
      displayName: String(entry.name || '').trim() || id,
      caps: {
        supportsToolCall: entry.supportsToolCall !== false,
        supportsImages: entry.supportsImages === true,
        supportsReasoning: entry.supportsReasoning === true,
        ...(entry.reasoning?.supportedEfforts ? { supportedEfforts: entry.reasoning.supportedEfforts } : {}),
      },
    };
    if (!groups.has(fileKey)) {
      groups.set(fileKey, {
        fileKey,
        name: String(entry.vendor || '').trim() || model.displayName,
        base_url: base,
        apiKey,
        models: [model],
      });
    } else {
      groups.get(fileKey).models.push(model);
    }
  });

  return { providers: [...groups.values()], errors };
}

// 首次使用模板（不含任何真实 Key；用户手动触发「初始化配置文件」时创建）
function templateContent() {
  return JSON.stringify([
    {
      id: 'my-model',
      name: '我的模型',
      vendor: 'Custom',
      url: 'https://api.example.com/v1',
      apiKey: 'sk-请替换成你的Key',
      supportsToolCall: true,
      supportsImages: false,
      supportsReasoning: false,
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
  // best-effort 收紧文件权限（含真实 Key 的文件不应组/众可读）；失败不影响同步
  try {
    if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600);
  } catch { /* 只读介质等场景忽略 */ }
  return { ok: errors.length === 0, synced: providers.length, removed, errors, path: filePath };
}

module.exports = {
  MODELS_FILE_ENV, modelsFilePath, fileKeyFor, toBaseUrl,
  parseModelsFile, templateContent, ensureModelsFile, readModelsFile, syncFileModels,
};
