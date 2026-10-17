// T2-1：本地数据域 IPC（自主进程 main.js 原样搬移，行为不变）
// 覆盖：models.json 同步（mtime 驱动）/ UI 对 file 来源 provider 的写回 /
//       会话·消息·provider·项目·偏好·记忆的本地 IPC（localStore 薄封装）。
//
// 依赖注入（沿用 initXxx(deps) 模式）：
//   initLocalDataIpc({ getLocalStore, getCredentialCrypto, localVault, serverBase,
//                      MJ_SERVER_DEFAULT, getMemoryManager, getMemoryScheduler })
//   - localVault 为共享 Map 引用（provider id → 解密内存态），resolveSecret 在 main.js 读取；
//   - localStore/credentialCrypto 在 whenReady 后才初始化，故用 getter。
const { ipcMain, shell } = require('electron');
const modelsFile = require('../modelsFile');
const guard = require('./payloadGuard');

let deps = null;

let modelsFileMtime = 0;
let modelsFileLastStatus = { path: modelsFile.modelsFilePath(), exists: false, synced: 0, removed: 0, errors: [] };

// ── 自定义模型配置文件（~/.mjcode/models.json）同步 ──
// 时机：启动一次 + providers/list 与 status 查询时按 mtime 变化热同步（保存文件即生效，无需重启）。
// 失败/文件不存在只告警不影响启动；解析错误收集后在设置页展示，绝不静默吞。
function syncModelsFile({ reason = 'manual' } = {}) {
  const localStore = deps.getLocalStore();
  const credentialCrypto = deps.getCredentialCrypto();
  const filePath = modelsFile.modelsFilePath();
  const exists = require('fs').existsSync(filePath);
  try {
    if (!exists) {
      modelsFileLastStatus = { path: filePath, exists: false, synced: 0, removed: 0, errors: [] };
      return modelsFileLastStatus;
    }
    modelsFileMtime = require('fs').statSync(filePath).mtimeMs;
    const raw = modelsFile.readModelsFile(filePath);
    const r = modelsFile.syncFileModels({ store: localStore, encrypt: (k) => credentialCrypto.encrypt(k), vault: deps.localVault, raw, filePath });
    modelsFileLastStatus = { path: filePath, exists: true, synced: r.synced, removed: r.removed.length, errors: r.errors };
    if (r.synced || r.removed.length) {
      console.log(`[modelsFile] 同步完成（${reason}）：导入 ${r.synced} 个模型 / 移除 ${r.removed.length} 个 provider${r.errors.length ? `，${r.errors.length} 条解析告警` : ''}`);
    }
    if (r.errors.length) console.warn('[modelsFile] 配置告警:', r.errors.map((e) => e.error).join('；'));
  } catch (e) {
    console.error('[modelsFile] 同步失败:', e.message);
    modelsFileLastStatus = { path: filePath, exists, synced: 0, removed: 0, errors: [{ error: `同步失败：${e.message}` }] };
  }
  return modelsFileLastStatus;
}

// mtime 未变则跳过（cheap：一次 statSync），变了才重新解析对账
function maybeSyncModelsFile() {
  try {
    const filePath = modelsFile.modelsFilePath();
    if (!require('fs').existsSync(filePath)) return modelsFileLastStatus;
    const mtime = require('fs').statSync(filePath).mtimeMs;
    if (mtime !== modelsFileMtime) return syncModelsFile({ reason: 'file-changed' });
  } catch { /* stat 失败按未变化处理 */ }
  return modelsFileLastStatus;
}

// ── 迁移：把 UI 手工配置的模型写入配置文件（用户要求：旧模型统一由 models.json 承载）──
// 触发条件（防覆盖用户手写内容）：文件不存在，或内容仍是初始模板，或文件解析不出任何 provider。
// 迁移后删除已被文件承载的 UI provider（同 url+Key 的模型已并入文件组，避免双份显示）。
function migrateLocalModelsToFile() {
  const localStore = deps.getLocalStore();
  const credentialCrypto = deps.getCredentialCrypto();
  try {
    const filePath = modelsFile.modelsFilePath();
    const raw = modelsFile.readModelsFile(filePath);
    const parsed = raw ? modelsFile.parseModelsFile(raw) : { providers: [] };
    // 模板/占位判定：文件缺失、解析不出 provider，或全部条目都是 example.com 占位
    // （同时兼容 v1 扁平模板与 v2 分组模板——两者文本不同，不能按文本比对）
    const isPlaceholder = parsed.providers.length > 0
      && parsed.providers.every((g) => g.base_url.startsWith('https://api.example.com'));
    const uiProviders = localStore.data.providers.filter((p) => p.source !== 'file');
    const shouldMigrate = (raw == null || parsed.providers.length === 0 || isPlaceholder) && uiProviders.length > 0;
    if (!shouldMigrate) return;

    const { raw: nextRaw, migrated } = modelsFile.migrateLocalProviders({
      raw: isPlaceholder ? '[]' : (raw || ''), // 占位内容直接丢弃，避免示例模型混入真实列表
      providers: uiProviders,
      decrypt: (enc) => credentialCrypto.decrypt(enc),
    });
    modelsFile.writeModelsFile(nextRaw, filePath);
    let removed = 0;
    for (const m of migrated) {
      try {
        localStore.deleteProvider(m.id);
        deps.localVault.delete(Number(m.id));
        removed += 1;
      } catch { /* 已不存在则忽略 */ }
    }
    console.log(`[modelsFile] 迁移完成：${migrated.length} 个本机模型服务已写入 ${filePath}（其中 ${migrated.filter((x) => x.matched).length} 个并入已有组），UI 侧移除 ${removed} 个（改由文件承载）`);
  } catch (e) {
    console.error('[modelsFile] 迁移失败（不影响启动，可稍后在设置页重试）:', e.message);
  }
}

// ── UI 对 file 来源 provider 的写回（删除/添加模型 → 修改 models.json → 热同步）──
function rewriteModelsFileRaw(nextRaw, { reason }) {
  modelsFile.writeModelsFile(nextRaw);
  modelsFileMtime = require('fs').statSync(modelsFile.modelsFilePath()).mtimeMs; // 写回后手动对齐，防 mtime 双触发
  return syncModelsFile({ reason });
}

function register() {
  ipcMain.handle('local:models-file/remove-model', async (_, { fileKey, modelId } = {}) => {
    try {
      // X14：fileKey/modelId 用来在 models.json 里定位条目并整个文件重写——非字符串会写成
      // "[object Object]" 且匹配不到任何条目，用户看到的是「删了但没删掉」
      guard.assertStrings({ fileKey, modelId }, { fileKey: 200, modelId: 300 });
      const raw = modelsFile.readModelsFile();
      const r = modelsFile.removeModelFromRaw(raw, fileKey, modelId);
      if (!r.ok) return r;
      return { ok: true, ...rewriteModelsFileRaw(r.raw, { reason: 'remove-model' }) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('local:models-file/remove-provider', async (_, { fileKey } = {}) => {
    try {
      // X14：同 remove-model——fileKey 决定整组服务是否被从 models.json 抹掉
      guard.assertStrings({ fileKey }, { fileKey: 200 });
      const raw = modelsFile.readModelsFile();
      const r = modelsFile.removeProviderFromRaw(raw, fileKey);
      if (!r.ok) return r;
      return { ok: true, ...rewriteModelsFileRaw(r.raw, { reason: 'remove-provider' }) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('local:models-file/add-model', async (_, { fileKey, model_id, display_name } = {}) => {
    try {
      // X14：新增模型条目直接写盘；model_id 必填非空（空 id 会生成一条无法调用的模型），
      // display_name 允许缺省或留空（addModelToRaw 内回落成 model_id）
      guard.assertStrings({ fileKey, model_id, display_name }, {
        fileKey: 200, model_id: 300, display_name: { max: 200, optional: true, allowEmpty: true },
      });
      const raw = modelsFile.readModelsFile();
      const r = modelsFile.addModelToRaw(raw, fileKey, model_id, display_name);
      if (!r.ok) return r;
      return { ok: true, ...rewriteModelsFileRaw(r.raw, { reason: 'add-model' }) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('local:models-file/status', async () => (deps.getLocalStore() ? maybeSyncModelsFile() : modelsFileLastStatus));
  ipcMain.handle('local:models-file/open', async () => {
    try {
      const r = modelsFile.ensureModelsFile();
      const err = await shell.openPath(r.path);
      return { ok: !err, created: r.created, error: err || null };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('server:health', async () => {
    try {
      const r = await fetch(`${deps.serverBase()}/health`, { signal: AbortSignal.timeout(3000) });
      return { online: r.ok };
    } catch (e) {
      return { online: false };
    }
  });

  ipcMain.handle('local:threads/list', async (_, { projectPath } = {}) => (deps.getLocalStore() ? deps.getLocalStore().listThreads(projectPath) : []));
  ipcMain.handle('local:threads/create', async (_, payload) => {
    // X14：会话标题/目录都可缺省（新建即空会话），但类型与长度必须守住——
    // 路径允许空格，故用 assertStrings 而非 assertTokens
    guard.assertStrings(payload || {}, {
      title: { max: 200, optional: true, allowEmpty: true },
      cwd: { max: 1024, optional: true, allowEmpty: true },
      projectPath: { max: 1024, optional: true, allowEmpty: true },
      providerName: { max: 200, optional: true, allowEmpty: true },
      modelName: { max: 200, optional: true, allowEmpty: true },
    });
    if (!deps.getLocalStore()) throw new Error('本地数据层未初始化');
    return deps.getLocalStore().createThread(payload || {});
  });
  ipcMain.handle('local:threads/set-status', async (_, payload) => {
    guard.assertTokens(payload, { id: 128 });
    guard.assertEnum(payload, 'status', ['running', 'idle', 'done', 'awaiting_approval']);
    const { id, status } = payload;
    if (!deps.getLocalStore()) return null;
    return deps.getLocalStore().setThreadStatus(id, status);
  });
  ipcMain.handle('local:messages/add', async (_, payload) => {
    // X14：消息是用户数据的核心，role 是闭集、content 允许为空（纯工具调用轮）
    guard.assertTokens(payload || {}, { threadId: 128 });
    guard.assertEnum(payload || {}, 'role', ['user', 'assistant', 'system', 'tool']);
    guard.assertStrings(payload || {}, { content: { max: 2 * 1024 * 1024, optional: true, allowEmpty: true } });
    if (!deps.getLocalStore()) throw new Error('本地数据层未初始化');
    return deps.getLocalStore().addMessage(payload || {});
  });
  ipcMain.handle('local:messages/list', async (_, { threadId }) => deps.getLocalStore() ? deps.getLocalStore().listMessages(threadId) : []);
  // /compact 落库：压缩摘要历史整体替换（P2-6 收口）
  ipcMain.handle('local:messages/replace', async (_, payload) => {
    // /compact 会整体替换历史：threadId 必填，messages 必须是数组且有条数上限
    guard.assertTokens(payload || {}, { threadId: 128 });
    guard.assertArray(payload || {}, 'messages', { max: 5000 });
    if (!deps.getLocalStore()) throw new Error('本地数据层未初始化');
    return deps.getLocalStore().replaceMessages(payload?.threadId, payload?.messages || []);
  });
  ipcMain.handle('local:threads/delete', async (_, payload) => {
    guard.assertTokens(payload, { threadId: 128 });
    return deps.getLocalStore() ? deps.getLocalStore().archiveThread(payload.threadId) : { ok: false };
  });
  // A1：会话重命名
  ipcMain.handle('local:threads/rename', async (_, payload) => {
    guard.assertTokens(payload, { threadId: 128 });
    guard.assertStrings(payload, { title: 200 });
    const { threadId, title } = payload;
    return deps.getLocalStore() ? deps.getLocalStore().renameThread(threadId, title) : { ok: false };
  });
  // A3：归档可见 —— 恢复 / 彻底删除 / 列表
  ipcMain.handle('local:threads/archived', async () => deps.getLocalStore() ? deps.getLocalStore().listArchivedThreads() : []);
  ipcMain.handle('local:threads/restore', async (_, payload) => {
    guard.assertTokens(payload, { threadId: 128 });
    return deps.getLocalStore() ? deps.getLocalStore().restoreThread(payload.threadId) : { ok: false };
  });
  ipcMain.handle('local:threads/purge', async (_, payload) => {
    guard.assertTokens(payload, { threadId: 128 });
    return deps.getLocalStore() ? deps.getLocalStore().purgeThread(payload.threadId) : { ok: false };
  });
  // B1：孤儿会话归组
  ipcMain.handle('local:threads/set-project', async (_, payload) => {
    guard.assertTokens(payload, { threadId: 128 });
    guard.assertStrings(payload, { projectPath: { max: 1024, optional: true, allowEmpty: true } });
    const { threadId, projectPath } = payload;
    return deps.getLocalStore() ? deps.getLocalStore().setThreadProject(threadId, projectPath) : { ok: false };
  });

  ipcMain.handle('local:providers/list', async () => {
    if (!deps.getLocalStore()) return [];
    maybeSyncModelsFile(); // 文件保存即生效（mtime 变化才真正重解析）
    return deps.getLocalStore().listProviders();
  });
  ipcMain.handle('local:providers/add', async (_, payload) => {
    // X14：写凭证的通道必须先在边界校验形状（历史上 `{}` 也能写出一条空 provider）
    guard.assertStrings(payload, {
      name: 120, base_url: 2000, api_key: { max: 4000, allowEmpty: true }, model_id: { max: 200, allowEmpty: true },
    });
    const { name, base_url, api_key, model_id } = payload;
    if (!deps.getLocalStore()) throw new Error('本地数据层未初始化');
    if (!deps.getCredentialCrypto()) throw new Error('本地数据层未初始化');
    const keyEncrypted = deps.getCredentialCrypto().encrypt(String(api_key || ''));
    const p = deps.getLocalStore().addProvider({ name, base_url, keyEncrypted, modelId: model_id });
    deps.localVault.set(p.id, { api_key: String(api_key || ''), base_url });
    return p;
  });
  ipcMain.handle('local:providers/set-model', async (_, payload) => {
    guard.assertIds(payload, ['id']);
    guard.assertStrings(payload, { model_id: 200 });
    const { id, model_id } = payload;
    if (!deps.getLocalStore()) throw new Error('本地数据层未初始化');
    return deps.getLocalStore().setProviderModel(id, model_id);
  });
  // 多模型：本机 provider 模型条目可增可删（修复「单模型不可删、UI 假装无限添加」）
  ipcMain.handle('local:providers/add-model', async (_, payload) => {
    guard.assertIds(payload, ['id']);
    guard.assertStrings(payload, { model_id: 200, display_name: { max: 200, optional: true } });
    const { id, model_id, display_name } = payload;
    if (!deps.getLocalStore()) throw new Error('本地数据层未初始化');
    return deps.getLocalStore().addProviderModel(id, { model_id, display_name });
  });
  ipcMain.handle('local:providers/remove-model', async (_, payload) => {
    guard.assertIds(payload, ['id']);
    guard.assertStrings(payload, { model_id: 200 });
    const { id, model_id } = payload;
    if (!deps.getLocalStore()) throw new Error('本地数据层未初始化');
    return deps.getLocalStore().removeProviderModel(id, model_id);
  });
  ipcMain.handle('local:providers/delete', async (_, payload) => {
    guard.assertIds(payload, ['id']);
    const { id } = payload;
    if (deps.getLocalStore()) deps.getLocalStore().deleteProvider(id);
    deps.localVault.delete(Number(id));
    return { ok: true };
  });
  // B2：供应商编辑（name/base_url/换 Key；Key 走凭证加密双轨落库）
  ipcMain.handle('local:providers/update', async (_, payload) => {
    guard.assertIds(payload, ['id']);
    guard.assertStrings(payload, {
      name: { max: 120, optional: true }, base_url: { max: 2000, optional: true }, api_key: { max: 4000, optional: true, allowEmpty: true },
    });
    const { id, name, base_url, api_key } = payload;
    if (!deps.getLocalStore()) throw new Error('本地数据层未初始化');
    if (!deps.getCredentialCrypto()) throw new Error('本地数据层未初始化');
    let keyEncrypted;
    if (api_key) {
      keyEncrypted = deps.getCredentialCrypto().encrypt(String(api_key));
      const cur = deps.localVault.get(Number(id)) || {};
      deps.localVault.set(Number(id), { ...cur, api_key: String(api_key), base_url: base_url || cur.base_url });
    } else if (base_url && deps.localVault.get(Number(id))) {
      deps.localVault.get(Number(id)).base_url = base_url;
    }
    return deps.getLocalStore().updateProvider(id, { name, base_url, keyEncrypted });
  });
  // B2：测试连接（对 base_url 的 /models 发起探测，返回延迟；Key 仅在主进程内存解析）
  ipcMain.handle('model:testConnection', async (_, { id, base_url } = {}) => {
    // X14：base_url 会被拼成 `${url}/models` 直接发请求——非字符串会拼出 "[object Object]/models"，
    // 用户看到的是一个莫名其妙的网络错误；id 允许缺省（只测地址、不测 Key 的场景）
    try {
      guard.assertStrings({ base_url }, { base_url: { max: 2000, optional: true, allowEmpty: true } });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const vault = deps.localVault.get(Number(id));
    const url = (base_url || vault?.base_url || '').replace(/\/+$/, '');
    if (!url) return { ok: false, error: '缺少接口地址' };
    // Key 含非 ASCII（典型：模板占位「sk-请替换成你的Key」未替换）时 fetch 头部会抛
    // ByteString 错误（真机复现），提前拦截给出可行动提示，而不是让用户看到天书报错
    if (vault?.api_key && /[^\x20-\x7E]/.test(vault.api_key)) {
      return { ok: false, error: 'API Key 含非 ASCII 字符（可能仍是模板占位符），请先替换为真实 Key' };
    }
    const started = Date.now();
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (vault?.api_key) headers['Authorization'] = `Bearer ${vault.api_key}`;
      const r = await fetch(`${url}/models`, { headers, signal: AbortSignal.timeout(8000) });
      const latencyMs = Date.now() - started;
      if (!r.ok) return { ok: false, latencyMs, error: `HTTP ${r.status}` };
      return { ok: true, latencyMs };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, error: err.message };
    }
  });

  // B1：项目一等实体（本机持久化）
  ipcMain.handle('local:projects/list', async () => deps.getLocalStore() ? deps.getLocalStore().listProjects() : []);
  ipcMain.handle('local:projects/add', async (_, payload) => {
    guard.assertStrings(payload, { path: 1024, name: { max: 200, optional: true, allowEmpty: true } });
    const { path, name } = payload;
    return deps.getLocalStore() ? deps.getLocalStore().addProject({ path, name }) : null;
  });
  ipcMain.handle('local:projects/remove', async (_, payload) => {
    guard.assertStrings(payload, { path: 1024 });
    return deps.getLocalStore() ? deps.getLocalStore().removeProject(payload.path) : { ok: false };
  });
  ipcMain.handle('local:projects/rename', async (_, payload) => {
    guard.assertStrings(payload, { path: 1024, name: 200 });
    const { path, name } = payload;
    return deps.getLocalStore() ? deps.getLocalStore().renameProject(path, name) : { ok: false };
  });

  ipcMain.handle('local:preferences/get', async (_, { key }) => deps.getLocalStore() ? deps.getLocalStore().getPreference(key) : undefined);
  ipcMain.handle('local:preferences/set', async (_, { key, value } = {}) => {
    // X14：key 是偏好表的键（决定写哪一行），非字符串会落成 "[object Object]" 键——数据还在，
    // 但读端永远读不回来；value 的形状由各偏好项自己约定，边界不校验
    try {
      guard.assertStrings({ key }, { key: 200 });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    return deps.getLocalStore() ? deps.getLocalStore().setPreference(key, value) : { ok: false };
  });

  // 服务端地址读写（设置-通用）：写偏好（三级解析之首）；读返回当前生效地址与来源
  ipcMain.handle('local:server/base', async (_, { base } = {}) => {
    if (base != null) {
      const v = String(base).trim().replace(/\/+$/, '');
      if (!/^https?:\/\//.test(v)) throw new Error('服务端地址需以 http:// 或 https:// 开头');
      if (!deps.getLocalStore()) throw new Error('本地数据层未初始化');
      deps.getLocalStore().setPreference('server.apiBase', v);
    }
    return {
      base: deps.serverBase(),
      default: deps.MJ_SERVER_DEFAULT,
      source: deps.getLocalStore()?.getPreference?.('server.apiBase') ? 'preference' : (process.env.MJ_SERVER_API ? 'env' : 'default'),
    };
  });

  // P1-16：MemoryManager 未就绪时的写入内存队列——就绪后（下一次记忆 IPC 调用）flush。
  // 绝不落 localStore JSON：那正是「双轨分裂」的根——JSON 轨永不迁移、永不可读，
  // 用户以为存了记忆，实际上召回与 UI 都只读 SQLite 轨。
  // 队列只在进程存活期有效：未就绪即退出 = 从未真正开始使用记忆，无实际损失。
  let memoryWriteQueue = [];
  function flushMemoryQueue() {
    const memoryManager = deps.getMemoryManager();
    if (!memoryManager || memoryWriteQueue.length === 0) return 0;
    const pending = memoryWriteQueue;
    memoryWriteQueue = [];
    let n = 0;
    for (const item of pending) {
      try {
        if (memoryManager.remember(item)) n += 1;
      } catch (e) {
        // 单条失败即丢弃（不重试爆栈）：该条已被调用方视为「已受理」
        console.warn('[memory] 队列补写失败（丢弃该条）:', e.message);
      }
    }
    if (n > 0) console.log(`[memory] 就绪后补写队列：${n} 条`);
    return n;
  }

  ipcMain.handle('local:memories/add', async (_, { projectPath, content, source = 'model_conclusion' } = {}) => {
    // P0-2b/P1-16：写入收口 MemoryManager（SQLite）+ 显式来源（未知来源被 remember 拒绝）
    // X14：content 进 SQLite 且会被召回进模型上下文，projectPath 是记忆空间分区键——
    // 形状与长度在边界守（source 的白名单仍由 remember 判，属业务语义）
    try {
      guard.assertStrings({ projectPath, content, source }, {
        projectPath: { max: 1024, optional: true, allowEmpty: true },
        content: 50000,
        source: { max: 100, optional: true },
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const memoryManager = deps.getMemoryManager();
    if (memoryManager) {
      flushMemoryQueue(); // 就绪后补写积压（P1-16）
      const m = memoryManager.remember({ spaceId: projectPath, domain: 'global_knowledge', content, source });
      return m ? { id: m.id, content: m.content } : { ok: false, error: '写入被拒绝：内容为空或来源不在白名单' };
    }
    memoryWriteQueue.push({ spaceId: projectPath || 'default', domain: 'global_knowledge', content, source });
    return { queued: true };
  });
  ipcMain.handle('local:memories/list', async (_, { projectPath, limit, query } = {}) => {
    // P2-6：分层召回路由（importance×recency×相关性 Top-K）+ P0-2c 域/可信度过滤
    const memoryManager = deps.getMemoryManager();
    if (memoryManager) {
      flushMemoryQueue();
      return memoryManager.recallContents({ spaceId: projectPath, query, topK: limit || 5 });
    }
    // P1-16：未就绪返回空——不再回落 localStore JSON 轨
    return [];
  });
  // P2-8 数据源：记忆统计与后台任务列表（可视化 UI 后续接入）
  ipcMain.handle('memory:stats', async () => (deps.getMemoryManager() ? { ok: true, stats: deps.getMemoryManager().stats() } : { ok: false }));
  ipcMain.handle('memory:bgTasks', async (_, opts) => (deps.getMemoryScheduler() ? { ok: true, tasks: deps.getMemoryScheduler().listTasks(opts) } : { ok: false }));
  // P0-2c/P1-17：记忆管理 IPC（设置页「记忆与后台作业」分区消费）——
  // invalidate 早已在 memory/index.js 实现但无 IPC 出口；promote 对应「人工确认长期留存」。
  ipcMain.handle('memory:list', async (_, { projectPath, limit = 50, offset = 0 } = {}) => {
    const memoryManager = deps.getMemoryManager();
    if (!memoryManager) return { ok: false, error: '记忆子系统未就绪' };
    return { ok: true, items: memoryManager.list({ spaceId: projectPath, limit, offset }) };
  });
  ipcMain.handle('memory:invalidate', async (_, { id, reason } = {}) => {
    const memoryManager = deps.getMemoryManager();
    if (!memoryManager) return { ok: false, error: '记忆子系统未就绪' };
    const m = memoryManager.invalidate(id, reason || '用户在设置页手动作废');
    return m ? { ok: true, item: m } : { ok: false, error: '记忆不存在' };
  });
  ipcMain.handle('memory:promote', async (_, { id } = {}) => {
    const memoryManager = deps.getMemoryManager();
    if (!memoryManager) return { ok: false, error: '记忆子系统未就绪' };
    const m = memoryManager.promoteToLongTerm(id);
    return m ? { ok: true, item: m } : { ok: false, error: '记忆不存在或已失效' };
  });
}

function initLocalDataIpc(d) {
  deps = d;
  register();
}

module.exports = {
  initLocalDataIpc,
  syncModelsFile,
  maybeSyncModelsFile,
  migrateLocalModelsToFile,
  getModelsFileLastStatus: () => modelsFileLastStatus,
};
