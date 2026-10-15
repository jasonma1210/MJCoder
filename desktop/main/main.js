const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage } = require('electron');
const path = require('path');
const os = require('os');
const { exec, execFile, spawn } = require('child_process');
const fsp = require('fs/promises');
const fs = require('fs');

let mainWindow;

// ═══════════════════════════════════════════
//  MODEL SECRETS（仅主进程持有，严禁流向渲染层）
// ═══════════════════════════════════════════
// 服务端地址三级解析：设置页偏好（server.apiBase）→ env MJ_SERVER_API → 默认本机 3001。
// 打包版从 Finder 启动拿不到 shell env，此前写死 localhost:3001 → server（Spring Boot）没跑时
// 服务端数据（共享模型/登录/审计）全离线且无法配置远程地址；现可在设置-通用里改。
const MJ_SERVER_DEFAULT = 'http://localhost:3001/api';
function serverBase() {
  const pref = localStore?.getPreference?.('server.apiBase');
  return String(pref || process.env.MJ_SERVER_API || MJ_SERVER_DEFAULT).replace(/\/+$/, '');
}
const secrets = new Map(); // `${isGlobal ? 'g' : 'u'}:${id}` -> { api_key, base_url }
let secretsInFlight = null; // 凭证拉取进行中的 promise（去重用）
const activeChats = new Set(); // 进行中的 chat AbortController

// ── 审批中心（分级确认 + 规则记忆）──
const approval = require('./approval');
// P0-A：Web 检索/抓取工具（含 SSRF 防护、HTML 转文本、超时与体积上限）
const webTools = require('./webTools');
const searchProviders = require('./webSearchProviders');
// 本地定时任务调度器（Bug2：到点自动执行提示词，离线可用）
const scheduler = require('./scheduler');
const APPROVAL_RULES_FILE = () => path.join(app.getPath('userData'), 'approval-rules.json');
let alwaysRules = [];        // 「始终允许」：持久化
const conversationRules = []; // 「本对话同类」：进程内存

try {
  alwaysRules = JSON.parse(fs.readFileSync(APPROVAL_RULES_FILE(), 'utf8'));
  if (!Array.isArray(alwaysRules)) alwaysRules = [];
} catch (e) {
  alwaysRules = []; // 首次启动
}

function saveAlwaysRules() {
  try {
    fs.writeFileSync(APPROVAL_RULES_FILE(), JSON.stringify(alwaysRules, null, 2));
  } catch (e) {
    console.warn('[approval] 规则持久化失败:', e.message);
  }
}

// 向渲染层发起审批，返回 'once' | 'conversation' | 'always' | 'deny'
// P0-2：审批响应按 approvalId 精确分发。原实现 ipcMain.once 共享一条无 id 通道，
// 多工具并发审批时第一个响应会被任一等待者消费，决策可能张冠李戴（把「允许」发给更危险的命令）。
const { ApprovalChannel } = require('./approvalChannel');
const approvalChannel = new ApprovalChannel({ timeoutMs: 120000 });
// 模型形状转换（扁平形 ⇄ 嵌套形）：全项目唯一事实来源，见 modelShape.js 顶部事故背景
const { toAgentModel, toChatRequest } = require('./modelShape');

// 审批结束广播：让渲染层撤下对应卡片。
// 没有这条通道时，主进程侧 pending 一旦因超时消失，UI 卡片却仍挂着——用户事后点击
// 会命中「无法匹配的审批响应」。并发（自动 DAG 多 Worker 同时申请）下尤其明显。
function broadcastApprovalEnd(approvalId, reason) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tool:approval-end', { approvalId, reason });
    }
  } catch { /* 窗口已销毁时无需广播 */ }
}

function requestApproval(tool, args) {
  const summary = approval.approvalSummary(tool, args);
  const approvalId = approvalChannel.nextId();
  const waitP = approvalChannel.wait(approvalId, broadcastApprovalEnd);
  mainWindow.webContents.send('tool:approval-request', { approvalId, tool, ...summary });
  return waitP;
}

// 全局唯一监听器：按 approvalId 分发（替代原先每次请求注册一次的 ipcMain.once）
ipcMain.on('tool:approval-response', (_, payload) => {
  const hasId = payload && typeof payload === 'object';
  const approvalId = hasId ? payload.approvalId : null;
  const decision = hasId ? payload.decision : payload;
  const dispatched = approvalId != null
    ? approvalChannel.dispatch(approvalId, decision)
    : approvalChannel.dispatchLegacy(decision); // 旧渲染层兼容：仅唯一挂起时接受
  if (!dispatched) console.warn('[approval] 收到无法匹配的审批响应，已忽略（防串扰）');
});

function applyApprovalDecision(decision, tool, args, conversationId) {
  if (decision === 'conversation') {
    conversationRules.push({ tool, pattern: approval.approvalTarget(tool, args), conversationId });
  } else if (decision === 'always') {
    alwaysRules.push({ tool, pattern: approval.approvalTarget(tool, args), scope: 'always', createdAt: Date.now() });
    saveAlwaysRules();
  }
}

// A7：「始终允许」规则必须可见可撤销 —— 列表 + 删除 IPC
ipcMain.handle('approval:listRules', async () => ({
  ok: true,
  rules: alwaysRules.map((r, index) => ({
    id: index,
    tool: r.tool,
    pattern: r.pattern,
    level: approval.toolLevel(r.tool, r.tool === 'shell' ? { command: r.pattern } : { path: r.pattern }) || 'L2',
    createdAt: r.createdAt || null,
  })),
}));
ipcMain.handle('approval:deleteRule', async (_, { id }) => {
  if (typeof id !== 'number' || !alwaysRules[id]) return { ok: false, error: '规则不存在' };
  alwaysRules.splice(id, 1);
  saveAlwaysRules();
  return { ok: true };
});

// ── 审计日志（工具执行脱敏上报服务端）──
let authToken = '';

// ── Seatbelt 沙箱（M3）──
const sandbox = require('./sandbox');
// P0-3：写路径白名单守卫（写目标必须位于 {项目 cwd, userData, 系统临时目录} 内）
const writeGuard = require('./writeGuard');

// ── 桌面端功能开关（战略收敛：默认冻结协同/云端/小程序，聚焦桌面端单点）──
const { loadFeatureFlags } = require('./featureFlags');
const featureFlags = loadFeatureFlags(process.env);
// SKILL.md 兼容层（生态互通）与 IDE 跳转
const skillCompat = require('./skillCompat');
const ideLib = require('./ide');
// 本地项目工作区（~/Documents/.MJCoder）
const workspace = require('./workspace');
// 统一降级日志原语（区分「服务端不可达」与真错误）
const degrade = require('./degrade');
// Git worktree 隔离工作区
const worktree = require('./worktree');

// ── 本地优先数据层（离线模式）──
const { LocalStore } = require('./localStore');
const { CredentialCrypto } = require('./credentialCrypto');
let localStore = null;   // whenReady 后初始化
let credentialCrypto = null; // 凭证加密双轨：safeStorage 首选，不可用降级文件密钥 AES-GCM（打包版真机事故）
const localVault = new Map(); // 本地 provider id -> { api_key, base_url }（解密后的内存态）

// 统一凭证解析（本地优先）：全局共享 g: → 本机保险库 → 服务端私有 u:
// 渲染层对服务端 provider 的 id 加 s 前缀做命名空间隔离，避免与本机 id 冲突；此处剥离后命中 u: 轨道
function resolveSecret(providerId, isGlobal = false) {
  if (isGlobal) return secrets.get(`g:${providerId}`);
  const local = localVault.get(Number(providerId));
  if (local) return local;
  return secrets.get(`u:${String(providerId ?? '').replace(/^s/, '')}`);
}

function initLocalStore() {
  try {
    localStore = new LocalStore(app.getPath('userData'));
    // web_search 配置来源注入（webSearchProviders 读 localStore 偏好，见 设置 → 网络配置）
    webTools.setLocalStore(localStore);
    // 凭证加密双轨（credentialCrypto.js）：safeStorage 不可用（打包版 macOS 27 真机复现）
    // 时降级文件密钥 AES-256-GCM——凭证仍可保存，保护级别显式降级并留痕
    credentialCrypto = new CredentialCrypto(app.getPath('userData'), safeStorage);
    if (credentialCrypto.scheme === 'file-key') {
      console.warn('[local] safeStorage 不可用，凭证改用本地文件密钥加密（userData/credential.key，0600）');
    }
    for (const p of localStore.data.providers) {
      try {
        const key = credentialCrypto.decrypt(p.keyEncrypted);
        localVault.set(p.id, { api_key: key, base_url: p.base_url });
      } catch (e) {
        console.warn('[local] 凭证解密失败:', p.id, e.message);
      }
    }
    console.log(`[local] 本地数据层就绪：${localStore.listThreads().length} 线程 / ${localStore.listProviders().length} 私有服务（加密轨：${credentialCrypto.scheme}）`);
  } catch (err) {
    console.error('[local] 初始化失败:', err);
  }
}

ipcMain.handle('server:health', async () => {
  try {
    const r = await fetch(`${serverBase()}/health`, { signal: AbortSignal.timeout(3000) });
    return { online: r.ok };
  } catch (e) {
    return { online: false };
  }
});

ipcMain.handle('local:threads/list', async (_, { projectPath } = {}) => (localStore ? localStore.listThreads(projectPath) : []));
ipcMain.handle('local:threads/create', async (_, payload) => {
  if (!localStore) throw new Error('本地数据层未初始化');
  return localStore.createThread(payload || {});
});
ipcMain.handle('local:threads/set-status', async (_, { id, status }) => {
  if (!localStore) return null;
  return localStore.setThreadStatus(id, status);
});
ipcMain.handle('local:messages/add', async (_, payload) => {
  if (!localStore) throw new Error('本地数据层未初始化');
  return localStore.addMessage(payload || {});
});
ipcMain.handle('local:messages/list', async (_, { threadId }) => localStore ? localStore.listMessages(threadId) : []);
// /compact 落库：压缩摘要历史整体替换（P2-6 收口）
ipcMain.handle('local:messages/replace', async (_, payload) => {
  if (!localStore) throw new Error('本地数据层未初始化');
  return localStore.replaceMessages(payload?.threadId, payload?.messages || []);
});
ipcMain.handle('local:threads/delete', async (_, { threadId }) => localStore ? localStore.archiveThread(threadId) : { ok: false });
// A1：会话重命名
ipcMain.handle('local:threads/rename', async (_, { threadId, title }) => localStore ? localStore.renameThread(threadId, title) : { ok: false });
// A3：归档可见 —— 恢复 / 彻底删除 / 列表
ipcMain.handle('local:threads/archived', async () => localStore ? localStore.listArchivedThreads() : []);
ipcMain.handle('local:threads/restore', async (_, { threadId }) => localStore ? localStore.restoreThread(threadId) : { ok: false });
ipcMain.handle('local:threads/purge', async (_, { threadId }) => localStore ? localStore.purgeThread(threadId) : { ok: false });
// B1：孤儿会话归组
ipcMain.handle('local:threads/set-project', async (_, { threadId, projectPath }) => localStore ? localStore.setThreadProject(threadId, projectPath) : { ok: false });

ipcMain.handle('local:providers/list', async () => localStore ? localStore.listProviders() : []);
ipcMain.handle('local:providers/add', async (_, { name, base_url, api_key, model_id }) => {
  if (!localStore) throw new Error('本地数据层未初始化');
  if (!credentialCrypto) throw new Error('本地数据层未初始化');
  const keyEncrypted = credentialCrypto.encrypt(String(api_key || ''));
  const p = localStore.addProvider({ name, base_url, keyEncrypted, modelId: model_id });
  localVault.set(p.id, { api_key: String(api_key || ''), base_url });
  return p;
});
ipcMain.handle('local:providers/set-model', async (_, { id, model_id }) => {
  if (!localStore) throw new Error('本地数据层未初始化');
  return localStore.setProviderModel(id, model_id);
});
// 多模型：本机 provider 模型条目可增可删（修复「单模型不可删、UI 假装无限添加」）
ipcMain.handle('local:providers/add-model', async (_, { id, model_id, display_name }) => {
  if (!localStore) throw new Error('本地数据层未初始化');
  return localStore.addProviderModel(id, { model_id, display_name });
});
ipcMain.handle('local:providers/remove-model', async (_, { id, model_id }) => {
  if (!localStore) throw new Error('本地数据层未初始化');
  return localStore.removeProviderModel(id, model_id);
});
ipcMain.handle('local:providers/delete', async (_, { id }) => {
  if (localStore) localStore.deleteProvider(id);
  localVault.delete(Number(id));
  return { ok: true };
});
// B2：供应商编辑（name/base_url/换 Key；Key 走凭证加密双轨落库）
ipcMain.handle('local:providers/update', async (_, { id, name, base_url, api_key }) => {
  if (!localStore) throw new Error('本地数据层未初始化');
  if (!credentialCrypto) throw new Error('本地数据层未初始化');
  let keyEncrypted;
  if (api_key) {
    keyEncrypted = credentialCrypto.encrypt(String(api_key));
    const cur = localVault.get(Number(id)) || {};
    localVault.set(Number(id), { ...cur, api_key: String(api_key), base_url: base_url || cur.base_url });
  } else if (base_url && localVault.get(Number(id))) {
    localVault.get(Number(id)).base_url = base_url;
  }
  return localStore.updateProvider(id, { name, base_url, keyEncrypted });
});
// B2：测试连接（对 base_url 的 /models 发起探测，返回延迟；Key 仅在主进程内存解析）
ipcMain.handle('model:testConnection', async (_, { id, base_url }) => {
  const vault = localVault.get(Number(id));
  const url = (base_url || vault?.base_url || '').replace(/\/+$/, '');
  if (!url) return { ok: false, error: '缺少接口地址' };
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
ipcMain.handle('local:projects/list', async () => localStore ? localStore.listProjects() : []);
ipcMain.handle('local:projects/add', async (_, { path, name }) => localStore ? localStore.addProject({ path, name }) : null);
ipcMain.handle('local:projects/remove', async (_, { path }) => localStore ? localStore.removeProject(path) : { ok: false });
ipcMain.handle('local:projects/rename', async (_, { path, name }) => localStore ? localStore.renameProject(path, name) : { ok: false });

ipcMain.handle('local:preferences/get', async (_, { key }) => localStore ? localStore.getPreference(key) : undefined);
ipcMain.handle('local:preferences/set', async (_, { key, value }) => localStore ? localStore.setPreference(key, value) : { ok: false });

// 服务端地址读写（设置-通用）：写偏好（三级解析之首）；读返回当前生效地址与来源
ipcMain.handle('local:server/base', async (_, { base } = {}) => {
  if (base != null) {
    const v = String(base).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(v)) throw new Error('服务端地址需以 http:// 或 https:// 开头');
    if (!localStore) throw new Error('本地数据层未初始化');
    localStore.setPreference('server.apiBase', v);
  }
  return {
    base: serverBase(),
    default: MJ_SERVER_DEFAULT,
    source: localStore?.getPreference?.('server.apiBase') ? 'preference' : (process.env.MJ_SERVER_API ? 'env' : 'default'),
  };
});

ipcMain.handle('local:memories/add', async (_, { projectPath, content }) => {
  // P2-1：写入收口 MemoryManager（SQLite）；不可用时回落旧 localStore 链路
  if (memoryManager) {
    const m = memoryManager.remember({ spaceId: projectPath, domain: 'global_knowledge', content, source: 'ipc' });
    return m ? { id: m.id, content: m.content } : null;
  }
  return localStore ? localStore.addMemory({ projectPath, content }) : null;
});
ipcMain.handle('local:memories/list', async (_, { projectPath, limit, query } = {}) => {
  // P2-6：分层召回路由（importance×recency×相关性 Top-K）；不可用时回落旧链路
  if (memoryManager) {
    return memoryManager.recallContents({ spaceId: projectPath, query, topK: limit || 5 });
  }
  return localStore ? localStore.listMemories(projectPath, limit) : [];
});
// P2-8 数据源：记忆统计与后台任务列表（可视化 UI 后续接入）
ipcMain.handle('memory:stats', async () => (memoryManager ? { ok: true, stats: memoryManager.stats() } : { ok: false }));
ipcMain.handle('memory:bgTasks', async (_, opts) => (memoryScheduler ? { ok: true, tasks: memoryScheduler.listTasks(opts) } : { ok: false }));

// ═══════════════════════════════════════════
//  P3-1/P3-5：ResourceQuotaCenter——全局唯一资源额度中心（槽位预占 + 前后台隔离 + 熔断节流）
//  fg = 用户会话 / Worker / 编排 / 定时任务（一切用户可感知请求）；bg = 记忆后台作业。
//  接入点：chatStreamOnce（流式）/ scheduledAgentChat（非流式，Worker 与编排同源）统一占用 fg 槽位，
//  MemoryBgScheduler 经 bgGate 让路。快照经 quota:snapshot 供渲染层（AgentDock 资源行）轮询。
// ═══════════════════════════════════════════
const { ResourceQuotaCenter } = require('./resourceQuotaCenter');
const quota = new ResourceQuotaCenter({ providerLimit: 8, fgReserve: 2 });
ipcMain.handle('quota:snapshot', () => quota.snapshot());
// Phase 3-1：Agent 任务断点持久化（预算熔断 = 暂停；「继续」时渲染层取回断点摘要注入）
const checkpointStore = require('./checkpointStore');
checkpointStore.initCheckpointStore(app.getPath('userData'));
ipcMain.handle('checkpoint:get', (_, threadKey) => checkpointStore.getCheckpoint(threadKey));
ipcMain.handle('checkpoint:clear', (_, threadKey) => ({ ok: checkpointStore.clearCheckpoint(threadKey) }));
// Phase 3-4：token 仪表盘数据源（最近一次运行的逐轮用量快照）
ipcMain.handle('agent:token/state', () => agentRunner.getTokenState());
// P3-4：本地后端探测（Ollama）——启动时一次 + 每 5 分钟复探；结果进快照供渲染层展示
quota.detectLocalBackend().catch(() => {});
setInterval(() => { quota.detectLocalBackend().catch(() => {}); }, 5 * 60 * 1000).unref?.();

// ── 协同（P4/P5）：主进程侧 Yjs 本地优先快照层 ──
// 渲染层经 HTTP 与服务端 CRDT 同步；主进程提供离线可读的本地快照与增量编解码
const { LocalCollab, makeDocId } = require('./collab');
const COLLAB_DIR = () => path.join(app.getPath('home'), '.mjcode', 'collab');
let localCollab = null;
const getLocalCollab = () => {
  if (!localCollab) localCollab = new LocalCollab(COLLAB_DIR());
  return localCollab;
};

// 功能开关查询（渲染层据此隐藏入口）
ipcMain.handle('app:flags', async () => ({ ok: true, flags: featureFlags }));

// 本机数据目录（状态条展示「数据保存在本机」的真实证据）
ipcMain.handle('app:userDataPath', async () => ({ ok: true, path: app.getPath('userData') }));
// 版本号动态下发（Sidebar 此前硬编码 v1.0.0，发版后永远显示旧版本）
ipcMain.handle('app:version', async () => app.getVersion());

if (featureFlags.collab) {
  ipcMain.handle('collab:open', async (_, { docId } = {}) => {
    try {
      const lc = getLocalCollab();
      lc.open(String(docId || ''));
      return { ok: true, docId };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('collab:docId', async (_, { type, entityId } = {}) => ({ docId: makeDocId(type, entityId) }));

  ipcMain.handle('collab:persist', async (_, { docId } = {}) => {
    try {
      return getLocalCollab().persist(String(docId || ''));
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 推给服务端的增量：传服务端已确认的 stateVector（base64），缺省推全量
  ipcMain.handle('collab:encodePush', async (_, { docId, stateVector } = {}) => {
    try {
      return { ok: true, update: getLocalCollab().encodePush(String(docId || ''), stateVector) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('collab:applyUpdate', async (_, { docId, update } = {}) => {
    try {
      return { ok: true, ...getLocalCollab().applyServerUpdate(String(docId || ''), update) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('collab:listLocal', async () => ({ ok: true, docs: getLocalCollab().listLocalDocs() }));
  ipcMain.handle('collab:closeAll', async () => { getLocalCollab().closeAll(); return { ok: true }; });
} else {
  console.log('[features] 协同模块已冻结（默认）。如需恢复设置 MJCODE_FEATURES=\'{"collab":true}\'');
}

// ── SKILL.md 兼容层 IPC（生态互通：生态目录安装 + 外部技能仓库导入）──
// 生态目录候选：userData/ecosystem（打包/用户目录）优先，回落仓库根 ecosystem/（开发模式）
function ecosystemDirCandidates() {
  const candidates = [ECOSYSTEM_DIR(), path.join(app.getAppPath(), '..', 'ecosystem')];
  return candidates.filter((d) => fs.existsSync(path.join(d, 'skills.json')));
}

ipcMain.handle('skills:installEcosystem', async (_, { id } = {}) => {
  try {
    const dirs = ecosystemDirCandidates();
    if (dirs.length === 0) return { ok: false, error: '未找到生态技能目录（skills.json）' };
    const r = skillCompat.installCatalogSkill(dirs, SKILLS_DIR(), id);
    if (r.ok) audit('skill_install', r.name || id, `dir=${r.dir}`);
    return r;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('skills:importFromDir', async (_, { dir } = {}) => {
  try {
    const scan = skillCompat.importSkillsFromDir(dir);
    if (!scan.ok) return scan;
    const installed = [];
    const failed = [];
    for (const entry of scan.skills) {
      const r = skillCompat.installSkillToDir(SKILLS_DIR(), entry, { overwrite: true });
      if (r.ok) installed.push({ dir: r.dir, name: r.name });
      else failed.push({ name: entry.name, error: r.error });
    }
    if (installed.length) audit('skill_import', dir, `installed=${installed.length}`);
    return { ok: true, found: scan.skills.length, installed, failed };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── IDE 跳转（代码视图一键跳转既有编辑器）──
ipcMain.handle('app:openInIDE', async (_, { path: p } = {}) => {
  try {
    if (!p || typeof p !== 'string') return { ok: false, error: '缺少文件路径' };
    if (p.includes('..') && !path.isAbsolute(p)) return { ok: false, error: '非法路径' };
    const platform = process.platform;
    const candidates = ideLib.IDE_CANDIDATES[platform] || ideLib.IDE_CANDIDATES.linux;
    const whichCmd = platform === 'win32' ? 'where' : 'which';
    const available = await Promise.all(candidates.map((cmd) =>
      new Promise((resolve) => {
        execFile(whichCmd, [cmd], (err) => resolve(err ? null : cmd));
      })
    )).then((list) => list.filter(Boolean));
    const picked = ideLib.pickIde(platform, available);
    const args = [...(picked.args || []), p];
    const child = spawn(picked.cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
    audit('open_in_ide', p, `ide=${picked.ide}`);
    return { ok: true, ide: picked.ide, cmd: picked.cmd };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── 生态资产目录（M7）：50 数字员工 / 100 MCP 连接器 / 100 Skill ──
const ecosystemLib = require('./ecosystem');
const ECOSYSTEM_DIR = () => path.join(app.getPath('userData'), 'ecosystem');

// 读路径统一解析：userData 无资产时回落仓库根 ecosystem/（开发模式）
// 事故根因：四个读 IPC 只读 userData/ecosystem，而打包前该目录不存在 →
// 生态中心/PlusMenu 的数字员工、技能、连接器全部空载（数据本身 50/100/100 完好）
function resolveEcosystemDir() {
  const dirs = ecosystemDirCandidates();
  return dirs[0] || ECOSYSTEM_DIR();
}

ipcMain.handle('ecosystem:summary', async () => {
  try {
    const all = ecosystemLib.loadEcosystem(resolveEcosystemDir());
    return { ok: true, stats: all.stats };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('ecosystem:employees', async (_, { category } = {}) => {
  try {
    let list = ecosystemLib.loadDigitalEmployees(resolveEcosystemDir());
    if (category) list = list.filter((e) => e.category === category);
    return { ok: true, employees: list };
  } catch (err) {
    return { ok: false, error: err.message, employees: [] };
  }
});

ipcMain.handle('ecosystem:connectors', async (_, { category } = {}) => {
  try {
    let list = ecosystemLib.loadMcpConnectors(resolveEcosystemDir());
    if (category) list = list.filter((c) => c.category === category);
    return { ok: true, connectors: list };
  } catch (err) {
    return { ok: false, error: err.message, connectors: [] };
  }
});

// ── 网络配置（web_search 提供方）：读写 + 元数据，见 设置 → 网络配置 ──
ipcMain.handle('websearch:getConfig', async () => ({
  ok: true,
  meta: searchProviders.SEARCH_PROVIDERS,
  config: searchProviders.loadSearchConfig(localStore),
}));
ipcMain.handle('websearch:setConfig', async (_, { providers } = {}) => {
  try {
    // Key 属敏感凭证：审计只记启用了哪些提供方，绝不落 Key 本体
    const r = searchProviders.saveSearchConfig(localStore, providers);
    const enabled = r.providers.filter((p) => p.enabled).map((p) => p.id);
    audit('settings', 'web_search providers', `enabled=${enabled.join(',') || '(none)'}`, 'ok');
    return { ok: true, config: r };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('ecosystem:skills', async () => {
  try {
    return { ok: true, skills: ecosystemLib.loadSkillCatalog(resolveEcosystemDir()) };
  } catch (err) {
    return { ok: false, error: err.message, skills: [] };
  }
});

// 审计上报：可丢失遥测。服务端不可达时熔断并静默，仅保留计数，绝不刷屏
const AUDIT_BREAKER_THRESHOLD = 3;
let auditFailures = 0;
let auditBreakerUntil = 0;

// 本地审计（P0-C）：无服务端令牌时落盘 userData/audit-log.jsonl（可丢失遥测，滚动上限 10MB）
// 「本地优先」产品的最基本合规基线——纯本地场景（shell/写文件/git/MCP/审批放行）也必须留痕，
// 否则误操作或安全事件发生时无任何事后追溯材料。
const AUDIT_LOG_FILE = () => path.join(app.getPath('userData'), 'audit-log.jsonl');
const AUDIT_LOG_MAX_BYTES = 10 * 1024 * 1024;
let auditLogBytes = -1; // 懒加载：首次写入时探测现有体积

function auditLocal(action, target, detail, approvalResult) {
  try {
    const file = AUDIT_LOG_FILE();
    fs.mkdirSync(path.dirname(file), { recursive: true }); // userData 理论上恒存在，防御性确保
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      action,
      target: String(target || '').slice(0, 500),
      detail: String(detail || '').slice(0, 2000),
      approval_result: approvalResult || 'auto',
      mode: 'local',
    }) + '\n';
    if (auditLogBytes < 0) {
      try { auditLogBytes = fs.statSync(file).size; } catch (e) { auditLogBytes = 0; }
    }
    if (auditLogBytes + Buffer.byteLength(line) > AUDIT_LOG_MAX_BYTES) {
      // 滚动：旧文件转 .1（只保留一代），重新计数
      try { fs.renameSync(file, `${file}.1`); } catch (e) { /* 不存在则忽略 */ }
      auditLogBytes = 0;
    }
    fs.appendFileSync(file, line);
    auditLogBytes += Buffer.byteLength(line);
  } catch (e) {
    console.warn('[audit] 本地审计落盘失败:', e.message); // 审计失败绝不阻塞主流程
  }
}

function audit(action, target, detail, approvalResult) {
  if (!authToken) { auditLocal(action, target, detail, approvalResult); return; } // 本地优先：无令牌时落盘留痕
  if (Date.now() < auditBreakerUntil) { auditFailures++; return; } // 熔断期内不再发起连接
  fetch(`${serverBase()}/audit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    body: JSON.stringify({
      action,
      target: String(target || '').slice(0, 500),
      detail: String(detail || '').slice(0, 2000),
      approval_result: approvalResult || 'auto',
    }),
    signal: AbortSignal.timeout(3000),
  }).then(() => {
    if (auditFailures) degrade.markHealthy('audit');
    auditFailures = 0;
    auditBreakerUntil = 0;
  }).catch((err) => {
    auditFailures++;
    const degradable = degrade.report('audit', err, { silent: true });
    if (degradable && auditFailures >= AUDIT_BREAKER_THRESHOLD) {
      auditBreakerUntil = Date.now() + 5 * 60 * 1000; // 连续失败 → 熔断 5 分钟
      console.warn(`[audit] 审计上报连续失败 ${auditFailures} 次（服务端不可达），已熔断 5 分钟`);
    }
  });
}

ipcMain.handle('model:getSecrets', async (_, { token }) => {
  if (!token) return { ok: false, error: 'NO_TOKEN' };
  // in-flight 去重：并发窗口内复用同一请求，避免重复触发服务端探测
  if (secretsInFlight) return secretsInFlight;
  secretsInFlight = (async () => {
    const headers = { Authorization: `Bearer ${token}` };
    let count = 0;
    try {
      const [userRes, globalRes] = await Promise.all([
        fetch(`${serverBase()}/providers/secrets`, { headers, signal: AbortSignal.timeout(5000) }),
        fetch(`${serverBase()}/global/providers/secrets`, { headers, signal: AbortSignal.timeout(5000) }),
      ]);
      if (userRes.ok) {
        for (const p of await userRes.json()) {
          secrets.set(`u:${p.id}`, { api_key: p.api_key, base_url: p.base_url });
          count++;
        }
      } else {
        console.error(`[secrets] 私有凭证拉取失败：HTTP ${userRes.status}`);
      }
      if (globalRes.ok) {
        for (const p of await globalRes.json()) {
          secrets.set(`g:${p.id}`, { api_key: p.api_key, base_url: p.base_url });
          count++;
        }
      } else {
        console.error(`[secrets] 全局凭证拉取失败：HTTP ${globalRes.status}`);
      }
      // 仅在拉取成功后开门：失败不应让 audit 全量穿透
      authToken = token;
      degrade.markHealthy('secrets');
      return { ok: true, count };
    } catch (err) {
      degrade.report('secrets', err);
      return { ok: false, error: err.message };
    } finally {
      secretsInFlight = null;
    }
  })();
  return secretsInFlight;
});

const WINDOW_STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(WINDOW_STATE_FILE(), 'utf8'));
  } catch (e) {
    return null; // 首次启动或文件损坏时回落默认值
  }
}

function saveWindowState() {
  if (!mainWindow) return;
  try {
    fs.writeFileSync(WINDOW_STATE_FILE(), JSON.stringify(mainWindow.getBounds()));
  } catch (e) {
    console.warn('[window] 状态保存失败:', e.message);
  }
}

function createWindow() {
  const state = loadWindowState();
  mainWindow = new BrowserWindow({
    width: state?.width || 1600,
    height: state?.height || 1000,
    x: state?.x,
    y: state?.y,
    minWidth: 1200, minHeight: 700,
    title: 'MJ Coder', backgroundColor: '#0d0d0d', titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true },
  });
  // 生产构建走 file:// 加载打包产物；开发走 vite dev server
  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, '../renderer/dist/index.html'));
  } else {
    mainWindow.loadURL('http://localhost:5173');
    if (process.env.NODE_ENV === 'development') mainWindow.webContents.openDevTools();
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  mainWindow.on('close', saveWindowState);
}

// 打包版诊断日志：console 全量 tee 到 userData/logs/main-YYYYMMDD.log。
// 背景：连续三起打包版问题（SIGSEGV/凭证加密/运行中停止）都因「主进程日志不可见」只能靠猜。
// dev 模式终端可见，不 tee（避免双写）；打包版启用。崩溃类另有 uncaughtException → crash.log。
function setupFileLogging() {
  if (!app.isPackaged) return;
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `main-${new Date().toISOString().slice(0, 10)}.log`);
    const orig = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
    const tee = (level) => (...args) => {
      orig[level](...args);
      try {
        const body = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        fs.appendFileSync(file, `[${new Date().toISOString()}] [${level}] ${body.slice(0, 4000)}\n`);
      } catch { /* 日志落盘失败不影响主流程 */ }
    };
    console.log = tee('log');
    console.warn = tee('warn');
    console.error = tee('error');
  } catch (e) {
    console.warn('[logging] 文件日志初始化失败:', e.message);
  }
}

// 单实例锁：第二个实例启动时聚焦已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(() => {
    setupFileLogging();
    createWindow();
    // P1-N：更新检查延迟 10s 自动触发（initUpdater 仍保留供手动检查即时初始化）
    scheduleAutoUpdateCheck();
    initLocalStore();
    initTaskOrchestration(); // P1：任务编排子系统（SQLite 队列 + Worker 池 + 断点恢复）
    reconnectMcpServers(); // 启动自动重连已持久化的 MCP 服务
    // 定时任务：IPC + 调度循环
    // P0-D：执行通道升级为 Agent（工具循环+审批+沙箱）；chatOnce 保留为无 Agent 通道时的回落
    scheduler.registerIpc();
    scheduler.startScheduler({
      chatOnce: scheduledChatOnce,
      runAgentTask: runScheduledAgentTask,
      notify: (payload) => {
        for (const w of BrowserWindow.getAllWindows()) {
          try { w.webContents.send('scheduled:changed', payload); } catch { /* 窗口已销毁 */ }
        }
      },
    });
  });

// 崩溃日志（M3-5）：主进程未捕获异常落盘
process.on('uncaughtException', (err) => {
  try {
    const line = `[${new Date().toISOString()}] ${err.stack || err.message}\n`;
    fs.appendFileSync(path.join(app.getPath('userData'), 'crash.log'), line);
  } catch (e) { /* 崩溃兜底路径，避免二次抛出 */ }
});

// P0-C 修复：补unhandledRejection 兜底。
// 事故背景：此前只挂了 uncaughtException，而 Promise 拒绝**不会**触发它——
// Node/Electron 默认在unhandledRejection 后终止进程。于是任何一处漏接的
// `.catch()`（典型是异步 IIFE、定时器回调、事件监听里的 async 函数）都会让
// 整个桌面应用直接退出，用户正在跑的全部 Agent 任务与对话一起丢失，且无任何提示。
// Node 15+ 可用 process.on('unhandledRejection') 覆盖该行为。
process.on('unhandledRejection', (reason) => {
  const msg = String(reason?.message || reason || '');
  try {
    const line = `[${new Date().toISOString()}] unhandledRejection: ${reason?.stack || msg}\n`;
    fs.appendFileSync(path.join(app.getPath('userData'), 'crash.log'), line);
  } catch (e) { /* 兜底路径，避免二次抛出 */ }
  console.error('[main]未捕获的 Promise 拒绝（已兜底，未退出进程）:', msg);
});
}

// ── 自动更新（electron-updater，仅打包态生效；延迟 require 避免非 electron 环境崩溃）──
// P1-N：更新链路默认值三件套——
//   1) 启动延迟 10s 自动 checkForUpdates（autoDownload 保持 false，下载仍需用户确认）；
//   2) error/available 态附手动下载链接（GitHub Releases 页），检查失败也能降级自助；
//   3) 更新通道：MJ_UPDATE_CHANNEL=beta 走预发布通道（默认 latest，与 publish.channel 对齐）。
// 修复潜在 bug：autoUpdater 原在 initUpdater 内 const 声明，却被模块级 IPC handler 引用，
// 打包态点「检查更新」必抛 ReferenceError（手动检查链路从未真正工作过）。
const UPDATE_CHECK_DELAY_MS = 10 * 1000;
const UPDATE_CHANNEL = process.env.MJ_UPDATE_CHANNEL || 'latest';
let autoUpdater = null;
let updaterInitialized = false;
let autoUpdateChecked = false;
// 手动下载兜底链接：由 build.publish 推导（owner/repo 缺失时为空串，前端隐藏链接）
function resolveManualDownloadUrl() {
  try {
    const pub = require('../package.json').build?.publish;
    if (pub?.owner && pub?.repo) return `https://github.com/${pub.owner}/${pub.repo}/releases`;
  } catch (e) { /* package.json 读取失败不影响主流程 */ }
  return '';
}
const MANUAL_DOWNLOAD_URL = resolveManualDownloadUrl();
function initUpdater() {
  if (!app.isPackaged || updaterInitialized) return autoUpdater;
  updaterInitialized = true;
  // eslint-disable-next-line global-require
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  if (UPDATE_CHANNEL && UPDATE_CHANNEL !== 'latest') {
    try { autoUpdater.channel = UPDATE_CHANNEL; } catch (e) { console.warn('[updater] 更新通道设置失败:', e.message); }
  }
  const send = (status, data = {}) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('updater:status', { status, ...data });
  };
  autoUpdater.on('checking-for-update', () => send('checking'));
  autoUpdater.on('update-available', (info) => send('available', { version: info.version, downloadUrl: MANUAL_DOWNLOAD_URL }));
  autoUpdater.on('update-not-available', () => send('up-to-date'));
  autoUpdater.on('download-progress', (p) => send('downloading', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', () => send('downloaded'));
  autoUpdater.on('error', (err) => send('error', { message: err.message, downloadUrl: MANUAL_DOWNLOAD_URL }));
  return autoUpdater;
}

// P1-N：启动延迟自动检查（不打扰首启；失败仅提示，不阻断使用）
function scheduleAutoUpdateCheck() {
  if (!app.isPackaged) return;
  setTimeout(() => {
    if (autoUpdateChecked) return;
    autoUpdateChecked = true;
    const up = initUpdater();
    up?.checkForUpdates().catch((err) => console.warn('[updater] 启动自动检查失败（忽略，用户可手动检查）:', err.message));
  }, UPDATE_CHECK_DELAY_MS).unref?.();
}

ipcMain.handle('updater:check', async () => {
  if (!app.isPackaged) return { ok: false, error: '仅打包后可检查更新' };
  const up = initUpdater();
  if (!up) return { ok: false, error: '更新器初始化失败' };
  try {
    await up.checkForUpdates();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message, downloadUrl: MANUAL_DOWNLOAD_URL };
  }
});

ipcMain.handle('updater:install', async () => {
  if (!app.isPackaged) return { ok: false, error: '仅打包后可安装更新' };
  const up = initUpdater();
  if (!up) return { ok: false, error: '更新器初始化失败' };
  up.quitAndInstall();
  return { ok: true };
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
// P0-1：退出前强制落盘合并窗口内未写盘的内存变更（消息/状态）
// P1-1：同时清理 MCP 子进程，避免孤儿进程占用端口导致下次启动握手失败
app.on('will-quit', () => {
  try { localStore?.flushSync(); } catch (e) { console.warn('[local] 退出刷盘失败:', e.message); }
  try { taskStore?.db?.flush?.(); } catch (e) { console.warn('[tasks] 退出刷盘失败:', e.message); }
  try { memoryScheduler?.stop(); } catch { /* 调度器已停 */ }
  approvalChannel.disposeAll();
  try { killAllMcpServers(); } catch (e) { console.warn('[MCP] 退出清理异常:', e.message); }
});
// SIGTERM/SIGINT 优雅退出：pkill/终端 Ctrl+C 也会走 will-quit 落盘（事故教训：强杀导致任务静默中断且丢状态）
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    try { console.log(`[main] 收到 ${sig}，优雅退出（落盘后关闭）`); } catch { /* 日志尽力而为 */ }
    try { app.quit(); } catch { process.exit(0); }
    setTimeout(() => process.exit(0), 2000).unref(); // 兜底：2s 内必须退出
  });
}
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ═══════════════════════════════════════════
//  AGENT TOOL EXECUTION LAYER
// ═══════════════════════════════════════════

// 打包版 GUI 进程（Finder/Dock 启动）继承的 PATH 极简（/usr/bin:/bin:/usr/sbin:/sbin），
// homebrew（node/npm/git 等用户工具）全部找不到——真机复盘：模型被迫每轮先
// `export PATH=/usr/local/bin:/opt/homebrew/bin:$PATH` 自救，白烧轮次。
// 统一为子 shell 注入完整 PATH（homebrew 优先，其次系统路径），沙箱内外一致。
// 复盘文档 P0-1 采纳：增补 bun/volta 等用户级工具目录（存在 HOME 时前置）。
const SHELL_PATH = '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin';
const shellEnv = () => {
  const home = process.env.HOME || '';
  const userPaths = home ? [`${home}/.bun/bin`, `${home}/.volta/bin`] : [];
  return { ...process.env, PATH: [...userPaths, SHELL_PATH].join(':') };
};

// 命令失败审查修复（真机复盘 2026-10-14）：
// 1）execFile 的 err.message 是 "Command failed: <file> <args 全文>"——沙箱路径下 args 含整个
//    Seatbelt profile（数千字符），每次非零退出都把 profile 全文灌进模型上下文，
//    并让「Command failed」成为模型看到的主信号（stdout 里明明已有答案）。
// 2）链式命令（a; b; c）退出码只取最后一段：探测类命令（ls 不存在的目录、env|grep 无命中）
//    非零退出是正常控制流，不是失败。
// 统一收敛为简洁的退出码说明；stdout/stderr 原样返回（答案在输出里，不靠 error 字段）。
// 仅真正的 spawn 异常（ENOENT 等，code 非数字且非 killed）保留原始 message。
function shellErrorNote(error) {
  if (!error) return null;
  if (typeof error.code === 'number') {
    return `命令以退出码 ${error.code} 结束${error.killed ? '（超时被终止）' : ''}（非零退出≠失败，链式命令仅取最后一段的退出码；请以 stdout/stderr 内容为准）`;
  }
  if (error.killed) return '命令超时被终止';
  return String(error.message || '命令执行异常').slice(0, 300);
}

// P0-D：工具实现提取为命名函数——IPC 处理器与定时任务 Agent 执行通道共用同一实现
async function toolShell({ command, cwd, timeout = 60000, approvalMode = 'on-request', conversationId, requireApproval = true, sandboxPolicy }) {
  let neededApproval = false;
  let ruleMatched = 'none'; // 审批规则命中情况（always/conversation/none），随审计留痕
  if (requireApproval) {
    const verdict = approval.needsApproval({ tool: 'shell', args: { command }, approvalMode, conversationId, alwaysRules, conversationRules });
    if (verdict.matched) ruleMatched = verdict.matched;
    if (verdict.need) {
      neededApproval = true;
      const decision = await requestApproval('shell', { command });
      if (decision === 'deny') {
        audit('shell', command, '用户拒绝', 'denied');
        return { stdout: '', stderr: '用户拒绝执行', exitCode: -1, error: 'Approval denied' };
      }
      applyApprovalDecision(decision, 'shell', { command }, conversationId);
    }
  }
  // 三平台 OS 级沙箱（2026-10）：macOS Seatbelt / Linux bubblewrap / Windows 受限用户。
  // 方案对齐 OpenAI Codex（各后端实现见 main/sandbox*.js 顶部注释）。
  // P0-B fail-safe：调用方未显式指定策略时，有项目目录至少 workspace-write，无目录则 read-only。
  // 此前默认 full-access——任何漏传 sandboxPolicy 的新调用链（定时任务/CUA/skill 自造工具）都会无隔离直跑。
  const policy = sandboxPolicy || (cwd ? 'workspace-write' : 'read-only');
  // sb 仍是 macOS Seatbelt 的专用判定（shouldSandbox 历史上只管 darwin，保留语义不扩散）
  const sb = sandbox.shouldSandbox(policy, cwd);
  // 三平台各自的「为何没能 OS 级沙箱」原因，用于日志自解释。
  // Linux 走统一分发读取 bwrap 真实原因；Windows 的就绪态是异步的，此处只能给静态提示。
  const fallbackReason = process.platform === 'linux'
    ? (sandbox.osSandboxUsable(policy, cwd).reason || 'bubblewrap 不可用')
    : (sb.reason || (process.platform === 'win32' ? 'Windows 受限用户沙箱未就绪' : 'seatbelt 不可用'));

  // 守卫 + 直跑：无 OS 级沙箱（或沙箱未就绪/执行失败）时的统一落点。
  // 守卫先于执行，命中即拒，审批不可绕过。
  const runFallback = (resolve) => {
    if (policy !== 'full-access') {
      // 已确认走到这里 = 本次没有 OS 级沙箱兜底，显式传 backendAvail=false，避免再走平台推断
      const guard = sandbox.checkCommandGuard(policy, command, process.platform, false, false);
      if (guard.blocked) {
        audit('shell', command, guard.reason, 'blocked');
        resolve({ stdout: '', stderr: guard.reason, exitCode: -1, error: guard.reason, blocked: true });
        return;
      }
      console.warn(`[sandbox] 未沙箱执行（${fallbackReason}）policy=${policy}`);
    }
    exec(command, { cwd: cwd || process.cwd(), timeout, maxBuffer: 5 * 1024 * 1024, env: shellEnv() }, (error, stdout, stderr) => {
      const result = { stdout: (stdout || '').slice(0, 50000), stderr: (stderr || '').slice(0, 10000), exitCode: typeof error?.code === 'number' ? error.code : (error ? -1 : 0), error: shellErrorNote(error) };
      audit('shell', command, `exitCode=${result.exitCode} rule=${ruleMatched}`, neededApproval ? 'approved' : 'auto');
      resolve(result);
    });
  };

  // ── macOS：Seatbelt ──
  if (sb.use) {
    const profile = sandbox.buildSeatbeltProfile(policy, cwd);
    return new Promise((resolve) => {
      execFile(sandbox.SANDBOX_EXEC, ['-p', profile, '/bin/zsh', '-c', command],
        { cwd: cwd || process.cwd(), timeout, maxBuffer: 5 * 1024 * 1024, env: shellEnv() }, (error, stdout, stderr) => {
          const result = { stdout: (stdout || '').slice(0, 50000), stderr: (stderr || '').slice(0, 10000), exitCode: typeof error?.code === 'number' ? error.code : (error ? -1 : 0), error: shellErrorNote(error), sandboxed: true, sandboxBackend: 'seatbelt' };
          audit('shell', command, `sandbox=${policy} exitCode=${result.exitCode} rule=${ruleMatched}`, neededApproval ? 'approved' : 'auto');
          resolve(result);
        });
    });
  }

  // ── Linux：bubblewrap（ro-bind 全盘 + unshare-all 断网 + seccomp + 项目目录唯一可写）──
  if (process.platform === 'linux' && policy !== 'full-access') {
    const built = sandbox.linuxBackend.buildBwrapExec(policy, cwd, command, '/bin/sh');
    if (built.argv.length) {
      return new Promise((resolve) => {
        execFile(built.argv[0], built.argv.slice(1),
          { cwd: cwd || process.cwd(), timeout, maxBuffer: 5 * 1024 * 1024, env: shellEnv() }, (error, stdout, stderr) => {
            const result = { stdout: (stdout || '').slice(0, 50000), stderr: (stderr || '').slice(0, 10000), exitCode: typeof error?.code === 'number' ? error.code : (error ? -1 : 0), error: shellErrorNote(error), sandboxed: true, sandboxBackend: 'bubblewrap' };
            audit('shell', command, `sandbox=bubblewrap/${policy} exitCode=${result.exitCode} rule=${ruleMatched}`, neededApproval ? 'approved' : 'auto');
            resolve(result);
          });
      });
    }
    console.warn(`[sandbox] Linux 未走 bubblewrap（${built.reason}），落到命令守卫`);
  }

  // ── Windows：受限专用用户（需一次性管理员设置；未就绪/失败则落到命令守卫）──
  if (process.platform === 'win32' && policy !== 'full-access') {
    return new Promise((resolve) => {
      sandbox.windowsBackend.windowsSandboxReady().then(async (st) => {
        if (st.ready) {
          const r = await sandbox.windowsBackend.execAsSandboxUser(command, cwd);
          if (r.ok) {
            audit('shell', command, `sandbox=windows-restricted-user/${policy} ok=true`, neededApproval ? 'approved' : 'auto');
            // schtasks 的 stdout 不易捕获，故以回执形式返回（命令本身的输出由任务体承载）
            resolve({ stdout: r.stdout || '', stderr: r.stderr || '', exitCode: 0, sandboxed: true, sandboxBackend: 'windows-restricted-user' });
            return;
          }
          console.warn(`[sandbox] Windows 受限用户执行失败（${r.error}），落到命令守卫`);
        } else {
          console.warn(`[sandbox] Windows 沙箱未就绪（${st.reason}），落到命令守卫`);
        }
        runFallback(resolve);
      });
    });
  }

  return new Promise((resolve) => runFallback(resolve));
}
ipcMain.handle('tool:shell', (_, payload) => toolShell(payload));

async function toolReadFile({ path: p, cwd, offset, limit }) {
  // cwd 贯通：相对路径以项目目录为基准解析（此前按主进程 CWD 解析必然失败）
  const target = resolveToolPath(p, cwd);
  try {
    const content = await fsp.readFile(target, 'utf8');
    const lines = content.split('\n');
    const body = (offset !== undefined && limit !== undefined)
      ? lines.slice(offset, offset + limit).join('\n')
      : content;
    return { ok: true, path: target, content: body, totalLines: lines.length };
  } catch (err) {
    // 文件不存在是设计内的正常控制流（如 AGENTS.md 逐级向上探测），绝不 reject
    if (err.code === 'ENOENT' || err.code === 'EISDIR') {
      // 错误信息必须包含「解析后的绝对路径」与「当前项目目录」：
      // 否则模型只知道「文件不存在」，无法判断是自己路径写错、
      // 还是该文件属于项目外的其他工程（如应用自身源码），只会反复重试同样的错路径。
      const base = cwd || process.cwd();
      const where = path.isAbsolute(p)
        ? `绝对路径不存在：${target}`
        : `相对路径已按当前项目目录解析：${target}（项目目录：${base}）。`
          + `若目标不在当前项目内，请改用绝对路径，或先用 list_dir 确认项目结构。`;
      const error = err.code === 'EISDIR'
        ? `${target} 是目录，不是文件。请改用 list_dir 浏览其内容。`
        : where;
      return { ok: false, notFound: true, path: target, cwd: base, error };
    }
    if (err.code === 'EACCES') return { ok: false, error: '没有读取权限' };
    return { ok: false, error: err.message };
  }
}
ipcMain.handle('tool:readFile', (_, payload) => toolReadFile(payload));

// 写操作统一走审批中心（L2）
const WRITE_TOOLS = ['writeFile', 'editFile', 'applyPatch'];
// P0-D：写工具实现提取为函数（IPC 与定时任务 Agent 通道共用）
// P0-3：写路径白名单——写目标越出 {项目 cwd, userData, 系统临时目录} 时：
//   · auto-safe / on-request：强制弹审批（不走 needsApproval，任何「始终允许」规则不可豁免）；
//   · never 档（全不询问）或 requireApproval=false（无审批通道的调用方）：直接硬拒绝，fail-closed。
//   白名单外的批准也不落地 conversation/always 规则，防止一次批准演变为永久绕过。
function outsideWriteTarget(toolName, args) {
  const roots = writeGuard.allowedWriteRoots({
    cwd: args.cwd,
    userDataDir: app.getPath('userData'),
  });
  if (toolName === 'applyPatch') {
    return writeGuard.firstOutsideTarget(writeGuard.patchTargets(args.patch), roots, args.cwd || process.cwd());
  }
  if (!args.path) return null;
  const target = resolveToolPath(args.path, args.cwd);
  return writeGuard.firstOutsideTarget([target], roots, args.cwd || process.cwd());
}

async function runWriteTool(toolName, args) {
  const { approvalMode = 'on-request', conversationId, requireApproval = true, ...rest } = args;
  const toolKey = { writeFile: 'write_file', editFile: 'edit_file', applyPatch: 'apply_patch' }[toolName];
  let ruleMatched = 'none'; // P1-C：审批规则命中情况随审计留痕
  const outside = outsideWriteTarget(toolName, rest);
  if (outside) {
    if (!requireApproval || approvalMode === 'never') {
      audit(toolKey, rest.path || '(patch)', `白名单外写入被拦截：${outside}`, 'blocked');
      return { ok: false, blocked: true, outsideWhitelist: true, path: outside, error: `写入目标超出允许范围（仅限项目目录 / 应用数据 / 系统临时目录）：${outside}` };
    }
    const decision = await requestApproval(toolKey, rest);
    if (decision === 'deny') {
      audit(toolKey, rest.path || '(patch)', `白名单外写入被拒绝：${outside}`, 'denied');
      return { ok: false, error: '用户拒绝执行', denied: true };
    }
    // 决策仅本次有效（once），不调用 applyApprovalDecision——白名单外路径不允许沉淀「始终允许」
  } else if (requireApproval) {
    const verdict = approval.needsApproval({ tool: toolKey, args: rest, approvalMode, conversationId, alwaysRules, conversationRules });
    if (verdict.matched) ruleMatched = verdict.matched;
    if (verdict.need) {
      const decision = await requestApproval(toolKey, rest);
      if (decision === 'deny') {
        audit(toolKey, rest.path || 'patch', '用户拒绝', 'denied');
        return { ok: false, error: '用户拒绝执行', denied: true };
      }
      applyApprovalDecision(decision, toolKey, rest, conversationId);
    }
  }
  // 工具实现抛错绝不能冒泡成 IPC rejection：渲染层只能拿到一句 message，
  // 模型无从判断是路径错、文件被改过还是权限问题，只会用同样的参数再试一次
  // → 表现就是「明明改完了却一直循环不结束」。统一转成结构化失败，带上可行动上下文。
  let result;
  try {
    result = await executeWriteTool(toolName, rest);
  } catch (err) {
    result = { ok: false, error: err?.message || String(err) };
    if (targetMissing(err)) {
      result.notFound = true;
      result.error = `${result.error}（目标：${rest.path || '(空)'}；项目目录：${rest.cwd || process.cwd()}）`;
    }
  }
  audit(toolKey, rest.path || '(patch)', `${result.error ? `error: ${result.error}` : 'ok'} rule=${ruleMatched}`, 'recorded');
  return result;
}
function targetMissing(err) { return err?.code === 'ENOENT' || err?.code === 'EISDIR'; }
for (const toolName of WRITE_TOOLS) {
  ipcMain.handle(`tool:${toolName}`, (_, args) => runWriteTool(toolName, args));
}

async function executeWriteTool(toolName, { path: p, content, search, replace, patch, cwd }) {
  // 相对路径同样以项目 cwd 为基准（此前按主进程 CWD 解析，会写错位置或失败）
  const target = p ? resolveToolPath(p, cwd) : p;
  if (toolName === 'writeFile') {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content, 'utf8');
    return { ok: true, path: target };
  }
  if (toolName === 'editFile') {
    // 空 search 必须先拦：'' 对 includes 恒真，会把 replace 插到文件最开头——静默破坏文件
    if (typeof search !== 'string' || search.length === 0) {
      return { ok: false, path: target, error: 'search 为空：空片段会匹配到文件开头并把内容插到最前面。请先用 read_file 读取当前内容，再给出精确的待替换片段。' };
    }
    if (typeof replace !== 'string') {
      return { ok: false, path: target, error: 'replace 必须是字符串（当前为 ' + typeof replace + '）' };
    }
    let fileContent;
    try {
      fileContent = await fsp.readFile(target, 'utf8');
    } catch (err) {
      const base = cwd || process.cwd();
      return {
        ok: false, notFound: true, path: target, cwd: base,
        error: err.code === 'EISDIR'
          ? `${target} 是目录，不是文件。请改用 list_dir 浏览其内容。`
          : `读取失败：${target} 不存在（项目目录：${base}）。若目标不在当前项目内请改用绝对路径。`,
      };
    }
    if (!fileContent.includes(search)) {
      // 未命中必须给出「为什么 + 现在是什么样」，否则模型只会重复同一片段 → 空转循环
      const d = diagnoseEditMiss(fileContent, search);
      const near = nearestContext(fileContent, search);
      return {
        ok: false, path: target, cwd: cwd || process.cwd(), editMiss: true,
        error: `${d.reason}（文件：${target}；待替换片段 ${search.length} 字符，开头：${d.preview}）`,
        hint: d.hints.join(' '),
        ...(near ? {
          nearest: `${near.matched ? `文件第 ${near.line} 行附近最接近（文件当前内容）` : '文件中没有相似行，这是文件开头'}：\n${near.snippet}`,
        } : {}),
      };
    }
    const occurrences = fileContent.split(search).length - 1;
    // 函数形式替换：避免 replace 文本里的 $& / $1 / $` 被当成特殊替换模式展开（静默写坏内容）
    const next = fileContent.replace(search, () => replace);
    await fsp.writeFile(target, next, 'utf8');
    return {
      ok: true, path: target, replaced: 1, occurrences,
      warn: occurrences > 1
        ? `文件中有 ${occurrences} 处完全相同的片段，本次只替换了第 1 处；若需全部替换请逐次调用，或改用 write_file 重写全文。`
        : null,
    };
  }
  // apply_patch：stdin 送入 patch，在项目 cwd 执行
  if (!patch || typeof patch !== 'string') throw new Error('patch 内容为空');
  // 2026-10-15 加固（三类失败模式全部实测复现后修复）：
  //   · --batch                 永不交互提问。此前 "Reversed (or previously applied)
  //                             patch detected! Assume -R? [n]" 会等 stdin 回答，
  //                             而 stdin 是补丁本身（写完即 end）→ EOF 异常或挂死
  //   · --forward               已应用过的补丁跳过而非报错（重复调用幂等）
  //   · --no-backup-if-mismatch 失败时不落 .orig / .ouD0ErF 备份
  //   · -r /dev/null            失败不再写 app.js.rej —— 此前会在用户项目里留下
  //                             拒绝文件，污染工作区、混进 git status 干扰后续提交
  const runPatchProcess = (extraArgs) => new Promise((resolve) => {
    const child = spawn('patch', ['-p1', '--batch', '--forward', '--no-backup-if-mismatch', '-r', '/dev/null', ...extraArgs], { cwd: cwd || process.cwd() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ stdout: stdout.slice(0, 10000), stderr: 'patch 执行超时', error: 'timeout', exitCode: -1 });
    }, 30000);
    child.on('close', (code) => {
      clearTimeout(timer);
      // 已应用过的补丁：--forward 会跳过（hunk ignored），语义上应视为幂等成功。
      // 若当失败返回，模型会反复重试同一个补丁直到轮次耗尽（repeat 熔断）。
      // 注意：GNU patch 的「Reversed / hunk ignored」提示走 **stdout** 而非 stderr（实测），
      // 所以两个流都要查。
      const out = `${stdout}\n${stderr}`;
      if (/previously applied|hunk ignored/i.test(out)) {
        resolve({ stdout: stdout.slice(0, 10000), stderr: stderr.slice(0, 5000), exitCode: 0, alreadyApplied: true, error: null });
        return;
      }
      resolve({
        stdout: stdout.slice(0, 10000),
        stderr: stderr.slice(0, 5000),
        exitCode: code ?? 0,
        error: code ? `patch exit ${code}` : null,
      });
    });
    child.stdin.write(patch);
    child.stdin.end();
  });

  const result = await runPatchProcess([]);
  if (result.exitCode && !result.alreadyApplied) {
    // 二次机会：-l（忽略空白差异）。补丁失败的头号真实原因是空白对不上
    //（缩进空格数/制表符/行尾空白），严格模式拒绝而宽松模式能命中。
    const retry = await runPatchProcess(['-l']);
    if (!retry.exitCode || retry.alreadyApplied) {
      return { ...retry, lenientWhitespace: true, note: '严格模式应用失败后已按宽松空白匹配重试成功。' };
    }
    // 两次都失败：必须可行动（与 editFile 未命中诊断同一原则）——
    // 回传目标绝对路径 + 当前内容（截断）+ 最近锚点行，模型据此改用
    // edit_file 精确替换或重新生成补丁，而不是原样重试同一 patch。
    const target = patchTargetPath(patch);
    const abs = target ? resolveToolPath(target, cwd) : null;
    let currentContent = null;
    let nearest = null;
    try {
      if (abs && fs.existsSync(abs)) {
        currentContent = fs.readFileSync(abs, 'utf8');
        const anchor = patchAnchorLine(patch);
        if (anchor) nearest = nearestContext(currentContent, anchor);
      }
    } catch (e) { /* 读不到就不附加，不掩盖原始错误 */ }
    return {
      ...retry,
      error: `patch exit ${retry.exitCode}（补丁上下文与文件当前内容不一致，未做任何修改）`,
      target: abs || target || undefined,
      hint: '不要原样重试同一补丁。请先 read_file 确认现状（下方 currentContent），'
        + '改用 edit_file 精确替换，或基于当前内容重新生成补丁。',
      currentContent: currentContent ? currentContent.slice(0, 4000) : undefined,
      nearest: nearest || undefined,
    };
  }
  return result;
}

// 从补丁解析目标路径（+++ b/ 行）：-p1 语义去一层前缀、去时间戳
function patchTargetPath(patch) {
  const line = String(patch || '').split('\n').find((l) => l.startsWith('+++ '));
  if (!line) return null;
  let p = line.slice(4).trim();
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.replace(/^[ab]\//, '');
  return p || null;
}

// 首个 hunk 的锚点行：取第一条上下文/删除行的内容（文件中应存在），供 nearestContext 定位
function patchAnchorLine(patch) {
  const lines = String(patch || '').split('\n');
  const hunkIdx = lines.findIndex((l) => l.startsWith('@@'));
  if (hunkIdx < 0) return null;
  for (let i = hunkIdx + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.startsWith('@@')) break;
    if (l.startsWith(' ') || l.startsWith('-')) {
      const t = l.slice(1).trim();
      if (t) return t;
    }
  }
  return null;
}

// ── editFile 未命中诊断 ──
// 背景（真机反馈）：「未找到要替换的内容」这句话本身不可行动——模型不知道是文件被前面的
// 步骤改过了、还是自己缩进抄错、还是换行符差异，唯一能做的就是原样再试一次，
// 于是同一个失败片段被重试到轮次耗尽，用户看到「明明改完了却一直在转」。
// 原则：**工具失败必须回传可行动信息**（为什么失败 + 文件现在长什么样 + 下一步该做什么）。
function diagnoseEditMiss(fileContent, search) {
  const src = String(fileContent || '');
  if (src.length === 0) {
    return { reason: '文件为空（0 字节）', preview: '', hints: ['文件当前没有任何内容：要写入全文请改用 write_file，edit_file 只能替换已有文本。'] };
  }
  const hints = [];
  const norm = (s) => String(s || '').replace(/\r\n/g, '\n');
  if (norm(src).includes(norm(search))) {
    hints.push('差异只来自换行符：文件用 CRLF（\\r\\n）而你给的是 LF（\\n），或反之。请按 read_file 返回的原始内容原样复制。');
  }
  const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  if (squash(src).includes(squash(search))) {
    hints.push('差异只来自空白（缩进空格数 / 制表符 / 空行）。请逐字符比对缩进，或改用更长且唯一的片段定位。');
  }
  const firstLine = String(search).split('\n').find((l) => l.trim()) || '';
  if (firstLine && src.includes(firstLine)) {
    hints.push('片段首行在文件中存在，但后续行不匹配——这一处很可能已被前面的步骤改掉了；请先确认该步骤是否其实已经完成，不要重复修改。');
  }
  if (!hints.length) {
    hints.push('该片段可能已被前面的步骤修改或删除，也可能你改的是另一个文件。请先用 read_file 读取当前内容确认，再给出精确片段。');
  }
  return { reason: '文件中不存在该精确片段', preview: String(search).slice(0, 120).replace(/\n/g, '\\n'), hints };
}

// 未命中时给出「文件里最接近的锚点」：模型据此重新对齐，而不是盲改。
// 即使一行都对不上也必须回传文件当前样貌（回退到开头若干行）——
// 否则模型手里既没有旧片段也没有新内容，只剩「再试一次」这一个选项。
function nearestContext(fileContent, search) {
  const lines = String(fileContent || '').split('\n');
  if (!lines.length) return null;
  const needles = String(search || '').split('\n').map((l) => l.trim()).filter(Boolean);
  let best = -1;
  let bestScore = 0;
  if (needles.length) {
    lines.forEach((line, i) => {
      const t = line.trim();
      if (!t) return;
      const score = needles.filter((n) => t.includes(n) || n.includes(t)).length;
      if (score > bestScore) { bestScore = score; best = i; }
    });
  }
  const anchor = best >= 0 ? best : 0; // 无相似行：退回文件开头，至少让模型看到现状
  const from = Math.max(0, anchor - 2);
  const to = Math.min(lines.length, anchor + 3);
  return {
    line: anchor + 1,
    matched: best >= 0,
    snippet: lines.slice(from, to).map((l, i) => `${from + i + 1}: ${l}`).join('\n').slice(0, 800),
  };
}

// 工具路径解析：相对路径以项目目录（cwd）为基准，避免按主进程 CWD 解析导致 ENOENT
function resolveToolPath(p, cwd) {
  const raw = String(p || '');
  if (!raw) return cwd ? path.resolve(cwd) : process.cwd();
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(cwd || process.cwd(), raw);
}

// ── 文件预览与「在系统中打开」（右侧预览面板 / 侧栏右键菜单共用）──
// 预览白名单：只有可安全内联渲染的类型才读二进制进渲染层，
// 其余一律交给系统默认应用打开——避免把 4K 视频、数据库文件等读进内存撑爆渲染进程。
const PREVIEW_BINARY_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
};
const PREVIEW_MAX_BYTES = 24 * 1024 * 1024; // 24MB：图片/PDF/音视频内联上限
const MEDIA_KINDS = /^(image|audio|video)\//;

function previewKindOfMime(mime) {
  if (mime === 'application/pdf') return 'pdf';
  if (MEDIA_KINDS.test(mime)) return mime.split('/')[0]; // image | audio | video
  return 'text';
}

// 预览元信息 + 二进制内容（文本类只回元信息，正文由 tool:readFile 分页取）
ipcMain.handle('file:preview', async (_, { path: p, cwd } = {}) => {
  const target = resolveToolPath(p, cwd);
  try {
    const st = await fsp.stat(target);
    if (st.isDirectory()) return { ok: false, path: target, error: '这是目录，请用「打开文件夹」在系统中浏览' };
    const ext = path.extname(target).toLowerCase();
    const mime = PREVIEW_BINARY_MIME[ext];
    if (!mime) {
      // 未知扩展名：按文本处理（渲染层读到非法编码会自行降级为「不支持预览」）
      return { ok: true, path: target, kind: 'text', size: st.size, ext };
    }
    const kind = previewKindOfMime(mime);
    if (st.size > PREVIEW_MAX_BYTES) {
      return {
        ok: true, path: target, kind, size: st.size, tooLarge: true, mime,
        error: `文件 ${(st.size / 1048576).toFixed(1)}MB，超出应用内预览上限 ${PREVIEW_MAX_BYTES / 1048576}MB，请在系统应用中打开`,
      };
    }
    const buf = await fsp.readFile(target);
    return { ok: true, path: target, kind, size: st.size, mime, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, notFound: true, path: target, error: `文件不存在：${target}` };
    if (err.code === 'EACCES') return { ok: false, path: target, error: '没有读取权限' };
    return { ok: false, path: target, error: err.message };
  }
});

// 用系统默认应用打开文件或目录（目录 → Finder / 资源管理器）
ipcMain.handle('shell:openPath', async (_, { path: p, cwd } = {}) => {
  const target = resolveToolPath(p, cwd);
  try {
    if (!fs.existsSync(target)) return { ok: false, error: `路径不存在：${target}` };
    const err = await shell.openPath(target);
    if (err) return { ok: false, error: err };
    audit('open_path', target, '在系统中打开');
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 打开外链：只允许 http/https（shell.openExternal 能拉起任意协议处理器，
// 传入 file:// 或自定义 scheme 等于把「打开任意本地程序」的能力暴露给渲染层）
ipcMain.handle('shell:openExternal', async (_, { url } = {}) => {
  const raw = String(url || '').trim();
  let parsed;
  try { parsed = new URL(raw); } catch (e) { return { ok: false, error: '链接格式不正确' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `出于安全考虑，只允许打开 http/https 链接（当前：${parsed.protocol}）` };
  }
  try {
    await shell.openExternal(raw);
    return { ok: true, url: raw };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Git 环境信息（设置页 Git 面板：署名与可用性探测，只读）
ipcMain.handle('tool:gitConfig', async (_, { cwd } = {}) => {
  const run = (args) => new Promise((resolve) => {
    execFile('git', args, { cwd: cwd || process.cwd(), timeout: 8000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout).trim());
    });
  });
  try {
    const [version, name, email, globalName, globalEmail] = await Promise.all([
      run(['--version']),
      run(['config', '--get', 'user.name']),
      run(['config', '--get', 'user.email']),
      run(['config', '--global', '--get', 'user.name']),
      run(['config', '--global', '--get', 'user.email']),
    ]);
    return {
      ok: true,
      available: !!version,
      version,
      // 仓库级署名优先展示（未配置时回落全局），空字符串表示未配置
      repoName: name, repoEmail: email,
      globalName, globalEmail,
      cwd: cwd || process.cwd(),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 在文件管理器中定位（高亮选中该条目而非打开）
ipcMain.handle('shell:reveal', async (_, { path: p, cwd } = {}) => {
  const target = resolveToolPath(p, cwd);
  try {
    if (!fs.existsSync(target)) return { ok: false, error: `路径不存在：${target}` };
    shell.showItemInFolder(target);
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// P0-D：提取为命名函数（IPC 与定时任务 Agent 通道共用）
async function toolListDir({ path: p, cwd } = {}) {
  const target = resolveToolPath(p, cwd);
  try {
    const entries = await fsp.readdir(target, { withFileTypes: true });
    return entries.map(e => ({ name: e.name, isDir: e.isDirectory(), type: e.isDirectory() ? 'dir' : 'file' }));
  } catch (err) {
    // 返回空列表而非 reject：渲染层按数组消费，rejection 会在主进程刷 Electron 错误栈
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR' && err.code !== 'EACCES') {
      console.error(`[listDir] 读取目录失败：${target} — ${err.message}`);
    }
    return [];
  }
}
ipcMain.handle('tool:listDir', (_, payload) => toolListDir(payload));

// grep：execFile argv 化，杜绝 LLM 可控参数注入 shell
async function toolGrep({ pattern, path: p, glob: include, cwd } = {}) {
  if (!pattern) return { matches: '' };
  const args = ['-rn'];
  if (include) args.push('--include', String(include));
  args.push(String(pattern), p || '.');
  return new Promise((resolve) => {
    execFile('grep', args, { cwd: cwd || undefined, timeout: 15000, maxBuffer: 5 * 1024 * 1024 }, (error, stdout) => {
      resolve({ matches: (stdout || '').slice(0, 20000) });
    });
  });
}
ipcMain.handle('tool:grep', (_, payload) => toolGrep(payload));

// glob：execFile argv 化
async function toolGlob({ pattern, path: p, cwd } = {}) {
  if (!pattern) return { files: [] };
  const args = [p || '.', '-name', String(pattern), '-type', 'f', '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*'];
  return new Promise((resolve) => {
    execFile('find', args, { cwd: cwd || undefined, timeout: 20000 }, (error, stdout) => {
      resolve({ files: (stdout || '').trim().split('\n').filter(Boolean).slice(0, 100) });
    });
  });
}
ipcMain.handle('tool:glob', (_, payload) => toolGlob(payload));

// ── Git 工具（execFile argv 化 + cwd 贯通）──
// git 提交/暂存属于 L2 写操作，走审批中心
async function gitWithApproval(toolKey, args, gitArgs) {
  const { approvalMode = 'on-request', conversationId, cwd, requireApproval = true } = args;
  let neededApproval = false;
  let ruleMatched = 'none'; // P1-C：审批规则命中情况随审计留痕
  if (requireApproval) {
    const verdict = approval.needsApproval({ tool: toolKey, args, approvalMode, conversationId, alwaysRules, conversationRules });
    if (verdict.matched) ruleMatched = verdict.matched;
    if (verdict.need) {
      neededApproval = true;
      const decision = await requestApproval(toolKey, args);
      if (decision === 'deny') {
        audit(toolKey, args.message || args.files || '', '用户拒绝', 'denied');
        return { stdout: '', stderr: '用户拒绝执行', error: 'Approval denied', denied: true };
      }
      applyApprovalDecision(decision, toolKey, args, conversationId);
    }
  }
  const result = await runGit(gitArgs, cwd);
  audit(toolKey, args.message || args.files || '', `${result.error ? `error: ${result.error}` : 'ok'} rule=${ruleMatched}`, neededApproval ? 'approved' : 'auto');
  return result;
}

// P0-D：提取为命名函数（IPC 与定时任务 Agent 通道共用）
const toolGitStatus = ({ cwd } = {}) => runGit(['status', '--short'], cwd);
const toolGitDiff = ({ cwd, staged } = {}) => runGit(['diff', ...(staged ? ['--staged'] : [])], cwd);
ipcMain.handle('tool:gitStatus', (_, p) => toolGitStatus(p));
ipcMain.handle('tool:gitDiff', (_, p) => toolGitDiff(p));
// hunk 级还原（对标 Codex 三级还原中的最小粒度）：反向应用指定代码块
ipcMain.handle('tool:gitApplyHunk', async (_, { cwd, patch }) => {
  if (!patch || typeof patch !== 'string') return { stdout: '', stderr: 'patch 为空', error: 'patch 为空' };
  return new Promise((resolve) => {
    const child = spawn('git', ['apply', '--reverse', '--unidiff-zero', '-'], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ stdout, stderr: 'git apply 超时', error: 'timeout' });
    }, 15000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 0, error: code ? `git apply 失败（退出码 ${code}）` : null });
    });
    child.stdin.write(patch);
    child.stdin.end();
  });
});
const toolGitLog = ({ cwd, count = 10 } = {}) => runGit(['log', '--oneline', `-${Math.min(Math.max(Number(count) || 10, 1), 100)}`], cwd);
const toolGitBranch = ({ cwd } = {}) => runGit(['branch', '-a'], cwd);
const toolGitCommit = (args = {}) => gitWithApproval('git_commit', args, ['commit', '-m', String(args.message || '')]);
const toolGitAdd = (args = {}) => {
  const list = Array.isArray(args.files) ? args.files.map(String) : String(args.files || '.').split(/\s+/).filter(Boolean);
  return gitWithApproval('git_add', args, ['add', ...list]);
};
ipcMain.handle('tool:gitLog', (_, p) => toolGitLog(p));
ipcMain.handle('tool:gitBranch', (_, p) => toolGitBranch(p));
ipcMain.handle('tool:gitCommit', (_, p) => toolGitCommit(p));
ipcMain.handle('tool:gitAdd', (_, p) => toolGitAdd(p));
// DiffReviewPanel：接受（add）/ 拒绝（checkout -- / restore --staged）
ipcMain.handle('tool:gitCheckout', async (_, { cwd, files }) => {
  const list = Array.isArray(files) ? files.map(String) : String(files || '').split(/\s+/).filter(Boolean);
  if (list.length === 0) return { stdout: '', stderr: 'files required', error: 'files required' };
  return runGit(['checkout', '--', ...list], cwd);
});
ipcMain.handle('tool:gitRestoreStaged', async (_, { cwd, files }) => {
  const list = Array.isArray(files) ? files.map(String) : String(files || '').split(/\s+/).filter(Boolean);
  if (list.length === 0) return { stdout: '', stderr: 'files required', error: 'files required' };
  return runGit(['restore', '--staged', ...list], cwd);
});

function runGit(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: cwd || process.cwd(), timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ stdout: (stdout || '').slice(0, 30000), stderr: (stderr || '').slice(0, 5000), error: error?.message || null });
    });
  });
}

// ── SKILL.md 技能体系（~/.mjcode/skills/<name>/SKILL.md）──
const skillsLib = require('./skills');
const SKILLS_DIR = () => path.join(app.getPath('home'), '.mjcode', 'skills');

ipcMain.handle('skills:list', async () => {
  try {
    return { ok: true, skills: skillsLib.listSkills(SKILLS_DIR()) };
  } catch (err) {
    console.error('[skills] 列表失败:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('skills:get', async (_, { name }) => {
  try {
    const content = skillsLib.getSkill(SKILLS_DIR(), String(name || ''));
    return content ? { ok: true, content } : { ok: false, error: '技能不存在' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── 插件市场（M6-P1/P2/P3）：git 一键安装 + 权限双闸 + 签名 fail-closed ──
const pluginMarket = require('./pluginMarket');
const registryLib = require('./registry');
const PLUGINS_ROOT = () => path.join(app.getPath('home'), '.mjcode', 'plugins');
const getPluginRegistry = () => new pluginMarket.PluginRegistry(PLUGINS_ROOT());
const getMarketRegistry = () => new registryLib.Registry({
  cacheFile: path.join(PLUGINS_ROOT(), 'registry-cache.json'),
});

// 远端注册中心索引（可选；未配置时 refresh 回落本地缓存）
const MARKET_INDEX_URL = () => process.env.MJ_MARKET_INDEX_URL || '';

// 注册中心热更新：有远端则拉取，失败保留缓存
ipcMain.handle('market:refresh', async () => {
  try {
    const reg = new registryLib.Registry({
      cacheFile: path.join(PLUGINS_ROOT(), 'registry-cache.json'),
      remoteUrl: MARKET_INDEX_URL(),
    });
    return await reg.refresh();
  } catch (err) {
    console.error('[market] 索引刷新失败:', err);
    return { ok: false, error: err.message };
  }
});

// 浏览/搜索市场索引（关键字/类型/标签过滤）
ipcMain.handle('market:search', async (_, options = {}) => {
  try {
    return { ok: true, ...getMarketRegistry().search(options || {}) };
  } catch (err) {
    console.error('[market] 搜索失败:', err);
    return { ok: false, error: err.message, plugins: [] };
  }
});

// ── 网络插件发现与对话内安装（LobeChat 式：输入框说一句，app 搜公网并装）──
// 公共源：npm registry（MCP Server 生态）+ GitHub（技能仓库）；不依赖自建市场索引
const pluginDiscovery = require('./pluginDiscovery');

ipcMain.handle('market:searchNetwork', async (_, { query, types } = {}) => {
  try {
    const net = await pluginDiscovery.searchNetworkPlugins(query || '', { types });
    // 本地已装/缓存索引结果并入（source: 'local'），模型可一并参考
    let local = [];
    try {
      const r = getMarketRegistry().search({ query: query || '' });
      local = (r.plugins || []).map((p) => ({ ...p, source: 'local' }));
    } catch { /* 本地索引失败不影响网络结果 */ }
    return { ok: true, results: [...local, ...net.results], notes: net.notes };
  } catch (err) {
    return { ok: false, error: err.message, results: [], notes: [] };
  }
});

// 对话内插件搜索（只读工具，不走审批）：已装插件 + 本地市场索引 + 网络源合并
// 「先本地后网络」的本地侧数据源：installed=已装插件（直接可用，无需安装）；local=市场索引
async function searchPluginsTool(args = {}) {
  const query = String(args.query || '').trim();
  if (!query) return { ok: false, error: '缺少搜索关键词 query' };
  const r = await pluginDiscovery.searchNetworkPlugins(query, { types: args.types, timeoutMs: 10000 });
  const q = query.toLowerCase();
  const match = (s) => String(s || '').toLowerCase().includes(q);
  let installed = [];
  try {
    installed = (getPluginRegistry().list() || [])
      .filter((p) => match(p.name) || match(p.description) || match(p.type))
      .map((p) => ({ ...p, source: 'installed' }));
  } catch { /* 已装列表失败不影响后续结果 */ }
  let local = [];
  try {
    const lr = getMarketRegistry().search({ query });
    local = (lr.plugins || []).map((p) => ({ ...p, source: 'local' }));
  } catch { /* 本地索引失败不影响网络结果 */ }
  return {
    ok: true, query,
    count: installed.length + local.length + r.results.length,
    results: [...installed, ...local, ...r.results].slice(0, 12),
    notes: r.notes,
  };
}

// 对话内安装（工具 install_plugin 的实现）。恒走 L3 审批卡（approval.js TOOL_LEVEL），
// 卡片展示安装对象与风险说明，用户允许才执行；npm 源包名白名单校验防注入。
async function installNetworkPlugin(args, { approvalMode = 'on-request', conversationId = '' } = {}) {
  const kind = String(args.kind || '');
  // 审批闸（L3）：与 toolShell 同一套审批中心，弹卡内容见 approval.approvalSummary
  const verdict = approval.needsApproval({ tool: 'install_plugin', args, approvalMode, conversationId, alwaysRules, conversationRules });
  if (verdict.need) {
    const decision = await requestApproval('install_plugin', args);
    if (decision === 'deny') {
      audit('install_plugin', JSON.stringify(args).slice(0, 200), '用户拒绝', 'denied');
      return { ok: false, error: '用户拒绝安装', denied: true };
    }
    applyApprovalDecision(decision, 'install_plugin', args, conversationId);
  }

  if (kind === 'mcp') {
    const pkg = String(args.pkg || '').trim();
    if (!pluginDiscovery.isValidNpmPkg(pkg)) {
      return { ok: false, error: `npm 包名非法：${pkg}` };
    }
    const name = pluginDiscovery.repoToSkillName(args.name || pkg) || `mcp-${Date.now().toString(36)}`;
    // connectMcpServer：连接成功才持久化 mcp-servers.json（fail-closed），失败即回报
    const r = await connectMcpServer({ name, command: 'npx', args: ['-y', pkg] });
    audit('install_plugin', `mcp ${pkg}`, r.ok ? `连接成功 tools=${r.toolCount}` : `失败 ${r.error}`, r.ok ? 'ok' : 'error');
    return r.ok
      ? { ok: true, kind: 'mcp', name, package: pkg, toolCount: r.toolCount, tools: (r.tools || []).map((t) => t.name).slice(0, 30), message: `MCP 服务 ${name} 已安装并连接，新增 ${r.toolCount} 个工具` }
      : { ok: false, error: `安装后连接失败：${r.error}（未写入配置；请检查包是否为有效的 stdio MCP Server）` };
  }

  if (kind === 'skill') {
    const url = String(args.url || '').trim();
    const r = await pluginMarket.installFromGit(url, {
      pluginsRoot: PLUGINS_ROOT(),
      registry: getPluginRegistry(),
      skillsRoot: SKILLS_DIR(), // 技能包落 ~/.mjcode/skills/<name>，listSkills 现读即热生效
      ref: args.ref,
      // 网络第三方仓库普遍无签名：签名闸门放宽，但注入检测照常 + 审批卡为用户显式同意
      policy: { allowUnsigned: true, requireSigstore: false },
      skillFallback: true,
      fallbackName: args.name,
    });
    if (!r.ok) return { ok: false, error: `安装失败（${r.stage}）：${(r.errors || [r.error]).join('；')}` };
    const rec = r.plugin || {};
    audit('install_plugin', `skill ${rec.name}`, `来源=${url} 版本=${rec.version}`, 'ok');
    return {
      ok: true, kind: 'skill', name: rec.name, version: rec.version,
      skillHotLoaded: !!rec.skillsDir,
      message: `技能 ${rec.name} v${rec.version} 已安装${rec.skillsDir ? '并生效，下一轮对话即可使用' : ''}`,
    };
  }

  return { ok: false, error: `不支持的安装类型：${kind}（仅支持 mcp / skill）` };
}

// 从 git 地址安装（P1 手动装路径）；签名与提示注入检测 fail-closed
ipcMain.handle('market:installGit', async (_, payload = {}) => {
  try {
    // P0-S2 修复：安全开关不得由渲染层决定。
    // 事故背景：此处原样把 payload.allowUnsigned / payload.allowUnsafeInjection
    // 透传给 pluginMarket.installFromGit，而 preload 的 marketInstallGit 也原样
    // invoke 透传 payload（无字段白名单）——这意味着渲染层只要出现一次 XSS，
    // 就能传 { allowUnsigned: true, allowUnsafeInjection: true } 直接关闭
    // fail-closed 签名校验与提示注入扫描两道闸门，安装任意恶意 skill。
    // 正解：签名策略只能来自主进程侧的环境变量（resolveSignaturePolicy），
    //客户端无权放宽。此处显式剥离这两个字段并留痕，避免以后再被加回来。
    const { allowUnsigned: _ignoredUnsigned, allowUnsafeInjection: _ignoredInjection, ...safePayload } = payload || {};
    if (_ignoredUnsigned || _ignoredInjection) {
      console.warn('[market:installGit] 已忽略来自渲染层的安全降级参数（allowUnsigned/allowUnsafeInjection）：签名与注入检测策略只能由主进程环境变量决定');
    }
    const r = await pluginMarket.installFromGit(String(safePayload.url || ''), {
      pluginsRoot: PLUGINS_ROOT(),
      registry: getPluginRegistry(),
      ref: safePayload.ref,
      policy: pluginMarket.resolveSignaturePolicy(),
      // 固定为 false：不允许任何来源（含客户端）绕过签名与注入检测。
      // 确需放宽的开发场景走环境变量 MJCODE_ALLOW_UNSIGNED_PLUGIN=1（仅影响签名，不涉及注入扫描）。
      allowUnsigned: false,
      allowUnsafeInjection: false,
    });
    if (r.ok && r.record) {
      audit('plugin.installed', r.record.name, `类型=${r.record.type} 版本=${r.record.version} 来源=git`);
    }
    return r;
  } catch (err) {
    console.error('[market] git 安装失败:', err);
    return { ok: false, error: err.message };
  }
});

// 已安装插件列表（含权限摘要，供权限面板展示）
ipcMain.handle('market:listInstalled', async () => {
  try {
    return { ok: true, plugins: getPluginRegistry().list() };
  } catch (err) {
    return { ok: false, error: err.message, plugins: [] };
  }
});

// 单插件权限面板详情
ipcMain.handle('market:inspect', async (_, payload = {}) => {
  try {
    const reg = getPluginRegistry();
    const entry = reg.get(String(payload.name || ''));
    if (!entry) return { ok: false, error: '插件未安装' };
    return {
      ok: true,
      plugin: entry,
      permissions: pluginMarket.summarizePermissions(entry.permissions),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 启停插件（停用后运行期权限闸门直接拒绝）
ipcMain.handle('market:setEnabled', async (_, payload = {}) => {
  try {
    const reg = getPluginRegistry();
    const r = reg.setEnabled(String(payload.name || ''), !!payload.enabled);
    if (r.ok) audit('plugin.enabled_changed', payload.name, `enabled=${!!payload.enabled}`);
    return r;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 卸载插件
ipcMain.handle('market:uninstall', async (_, payload = {}) => {
  try {
    const r = pluginMarket.uninstall(getPluginRegistry(), String(payload.name || ''));
    if (r.ok) audit('plugin.uninstalled', payload.name, '用户卸载插件');
    return r;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 运行期实扣：校验插件是否被授予某级别权限（fail-closed）
ipcMain.handle('market:checkPermission', async (_, payload = {}) => {
  try {
    const reg = getPluginRegistry();
    const res = pluginMarket.authorizePluginAction(
      reg, String(payload.name || ''), String(payload.level || ''), payload.scope
    );
    const allow = !!(res && res.allow);
    if (allow) audit('plugin.permission_granted', payload.name, `level=${payload.level} scope=${payload.scope || '*'}`);
    return { ok: true, allow, reason: res && res.reason };
  } catch (err) {
    return { ok: false, allow: false, error: err.message };
  }
});

// ── 目录选择 / 文件选择对话框 ──
ipcMain.handle('dialog:pickDirectory', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || r.filePaths.length === 0) return { ok: false };
  return { ok: true, path: r.filePaths[0] };
});

ipcMain.handle('dialog:pickFiles', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] });
  if (r.canceled || r.filePaths.length === 0) return { ok: false };
  return { ok: true, paths: r.filePaths };
});

// ── 本地项目工作区（~/Documents/.MJCoder，隐藏目录；项目目录按 日期+随机数 创建）──
ipcMain.handle('project:workspaceInfo', async () => {
  try {
    const { root, created } = await workspace.ensureWorkspaceRoot(
      app.getPath('documents'), app.getPath('home'),
    );
    return { ok: true, root, created };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('project:create', async (_, { name } = {}) => {
  try {
    const proj = await workspace.createProject({
      docsDir: app.getPath('documents'), homeDir: app.getPath('home'), name,
    });
    return { ok: true, ...proj };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── 项目探测（git 分支/远端/文件数/技术栈标记）──
const LANG_MARKERS = {
  'package.json': 'Node.js', 'Cargo.toml': 'Rust', 'pom.xml': 'Java', 'build.gradle': 'Java',
  'go.mod': 'Go', 'requirements.txt': 'Python', 'pyproject.toml': 'Python', 'Gemfile': 'Ruby',
};

ipcMain.handle('tool:probeProject', async (_, { path: p }) => {
  const proj = { path: p, name: path.basename(p || ''), branch: '', remote: '', fileCount: 0, languages: [] };
  if (!p) return proj;
  try {
    const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], p);
    if (!branch.error && branch.stdout.trim()) proj.branch = branch.stdout.trim();
    const remote = await runGit(['remote', 'get-url', 'origin'], p);
    if (!remote.error && remote.stdout.trim()) proj.remote = remote.stdout.trim();
    const entries = await fsp.readdir(p, { withFileTypes: true });
    proj.fileCount = entries.filter(e => e.isFile()).length;
    proj.languages = Object.keys(LANG_MARKERS).filter(m => entries.some(e => e.name === m)).map(m => LANG_MARKERS[m]);
  } catch (e) {
    console.warn('[probe] 项目探测失败:', p, e.message);
  }
  return proj;
});

// ── Git Worktree 隔离工作区（对标 Codex Worktree 模式）──
ipcMain.handle('worktree:create', async (_, { path: projectPath, taskTitle }) => {
  try {
    return { ok: true, ...(await worktree.createWorktree(projectPath, taskTitle)) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('worktree:list', async (_, { path: projectPath }) => {
  try {
    const root = await worktree.repoRoot(projectPath);
    if (!root) return { ok: true, list: [], isRepo: false };
    return { ok: true, isRepo: true, list: await worktree.listWorktrees(root, root) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('worktree:promote', async (_, { path: worktreePath }) => {
  try {
    return { ok: true, ...(await worktree.promoteToBranch(worktreePath)) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('worktree:sync', async (_, { path: worktreePath }) => {
  try {
    return { ok: true, ...(await worktree.syncToLocal(worktreePath)) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('worktree:remove', async (_, { path: worktreePath }) => {
  try {
    return { ok: true, ...(await worktree.removeWorktree(worktreePath)) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── A2：DiffReview 放弃修改前的磁盘快照（撤销出口）──
// 快照落 userData/backup/<snapshotId>/，保持相对路径结构；不写入用户项目目录
const backupRoot = () => path.join(app.getPath('userData'), 'backup');

ipcMain.handle('backup:create', async (_, { cwd, files }) => {
  try {
    const list = (Array.isArray(files) ? files : [files]).filter(Boolean);
    if (!cwd || list.length === 0) return { ok: false, error: '缺少项目目录或文件列表' };
    const snapshotId = `snap-${Date.now()}`;
    const dir = path.join(backupRoot(), snapshotId);
    let snapshotted = 0;
    for (const rel of list) {
      const abs = path.join(cwd, rel);
      try {
        const stat = await fsp.stat(abs);
        if (!stat.isFile()) continue;
        const dest = path.join(dir, rel);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.copyFile(abs, dest);
        snapshotted += 1;
      } catch (e) {
        // 单文件快照失败不阻断（如新建未保存文件），放弃操作本身仍继续
        console.warn(`[backup] 跳过 ${rel}:`, e.message);
      }
    }
    await fsp.writeFile(path.join(dir, '.meta.json'), JSON.stringify({ cwd, files: list, createdAt: Date.now() }));
    return { ok: true, snapshotId, dir, count: snapshotted };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('backup:restore', async (_, { snapshotId }) => {
  try {
    const dir = path.join(backupRoot(), String(snapshotId).replace(/[^a-zA-Z0-9-]/g, ''));
    const meta = JSON.parse(await fsp.readFile(path.join(dir, '.meta.json'), 'utf8'));
    let restored = 0;
    for (const rel of meta.files) {
      const src = path.join(dir, rel);
      try {
        const dest = path.join(meta.cwd, rel);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.copyFile(src, dest);
        restored += 1;
      } catch (e) {
        console.warn(`[backup] 恢复跳过 ${rel}:`, e.message);
      }
    }
    return { ok: true, restored };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// A12：粘贴/无路径文件落盘（渲染层 ArrayBuffer → userData/uploads）
ipcMain.handle('files:saveUpload', async (_, { name, dataBase64 }) => {
  try {
    const dir = path.join(app.getPath('userData'), 'uploads');
    await fsp.mkdir(dir, { recursive: true });
    const safeName = String(name || 'file').replace(/[/\\:*?"<>|]/g, '_').slice(0, 120);
    const dest = path.join(dir, `${Date.now()}-${safeName}`);
    await fsp.writeFile(dest, Buffer.from(String(dataBase64 || ''), 'base64'));
    return { ok: true, path: dest };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── MCP 客户端（多传输：stdio + Streamable HTTP）──
// 2026-10-15：客户端实现抽到 main/mcpClient.js（God Object 拆分）并新增 HTTP 传输
//（MCP Streamable HTTP spec）。本层只保留配置持久化与 IPC 接线。
const mcp = require('./mcpClient');
const mcpServers = { get: (n) => mcp.getMcpServer(n), names: () => mcp.listMcpServers() };

// MCP 配置持久化（userData/mcp-servers.json）+ 子进程 env 白名单
const MCP_CONFIG_FILE = () => path.join(app.getPath('userData'), 'mcp-servers.json');
const ENV_WHITELIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SHELL', 'USER', 'TMPDIR', 'NODE_ENV'];

function loadMcpConfig() {
  try {
    const list = JSON.parse(fs.readFileSync(MCP_CONFIG_FILE(), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function saveMcpConfig(list) {
  try {
    fs.writeFileSync(MCP_CONFIG_FILE(), JSON.stringify(list, null, 2));
  } catch (e) {
    console.warn('[mcp] 配置持久化失败:', e.message);
  }
}

// env 白名单：仅透传系统基础变量 + 用户显式配置，杜绝 process.env 全量泄漏（P2-10）
// PATH 特殊处理：打包版 GUI 进程继承的 PATH 极简（/usr/bin:/bin:...），
// npx/uvx（homebrew）全找不到——真机复盘：MCP 服务全部 spawn ENOENT。
// 注入与 toolShell 子 shell 一致的完整 PATH（见 SHELL_PATH 定义）。
function sanitizeEnv(env) {
  const out = {};
  for (const k of ENV_WHITELIST) {
    if (process.env[k]) out[k] = process.env[k];
  }
  return { ...out, PATH: shellEnv().PATH, ...(env || {}) };
}

// MCP 连接核心逻辑（IPC 处理器与启动重连共用）：委托给 mcpClient（stdio/http 双传输）
async function connectMcpServer({ name, transport = 'stdio', command, args = [], env = {}, url, headers = {} } = {}) {
  const r = await mcp.connectMcpServer({
    name, transport, command, args, env: sanitizeEnv(env), url, headers,
    onStatus: (n, st, code) => emitMcpStatus(n, st, code),
    onLog: (line) => console.log(`[MCP ${name}]`, line),
  });
  // 连接成功 → 持久化配置（重启后自动重连）。fail-closed：握手失败不写盘。
  if (r.ok && name) {
    const config = loadMcpConfig().filter((s) => s.name !== name);
    config.push(transport === 'http'
      ? { name, transport, url, headers, env }
      : { name, transport: 'stdio', command, args, env });
    saveMcpConfig(config);
  }
  return r;
}

ipcMain.handle('mcp:connect', async (_, payload) => connectMcpServer(payload));

// P1-1：MCP 服务状态变更 → 通知渲染层（AgentDock / 设置页据此标红断开的服务）
function emitMcpStatus(name, status, code) {
  try {
    emitTaskEvent({ type: 'mcp_status', name, status, code, ts: Date.now() });
  } catch (e) { /* 事件发送失败不影响主流程 */ }
}

// P1-1：统一清理全部 MCP 子进程（应用退出时调用）→ 委托 mcpClient（stdio SIGTERM→SIGKILL）
function killAllMcpServers() {
  return mcp.killAllMcpServers();
}

// P0-D：提取为命名函数（IPC 与定时任务 Agent 通道共用）
async function callMcpTool({ server, tool, arguments: args, approvalMode = 'on-request', conversationId }) {
  const s = mcpServers.get(server);
  if (!s) throw new Error(`MCP 服务 ${server} 未连接`);
  // L3：MCP 工具调用审批（auto-safe 档仍询问）
  const verdict = approval.needsApproval({ tool: `mcp__${server}__${tool}`, args: args || {}, approvalMode, conversationId, alwaysRules, conversationRules });
  if (verdict.need) {
    const decision = await requestApproval(`mcp__${server}__${tool}`, args || {});
    if (decision === 'deny') {
      audit(`mcp:${server}`, tool, '用户拒绝', 'denied');
      return { error: '用户拒绝执行', denied: true };
    }
    applyApprovalDecision(decision, `mcp__${server}__${tool}`, args || {}, conversationId);
  }
  try {
    const result = await mcp.mcpRpc(s, 'tools/call', { name: tool, arguments: args || {} });
    audit(`mcp:${server}`, tool, `${result?.error ? `error: ${result.error}` : 'ok'} rule=${verdict.matched || 'none'}`, verdict.need ? 'approved' : 'auto');
    return result;
  } catch (err) {
    audit(`mcp:${server}`, tool, `error: ${err.message}`, 'error');
    return { error: err.message };
  }
}
ipcMain.handle('mcp:callTool', (_, payload) => callMcpTool(payload));

ipcMain.handle('mcp:disconnect', async (_, { name }) => {
  // 断开 + 同步移除持久化配置（http 传输无子进程，close 为空操作）
  mcp.disconnectMcpServer(name);
  saveMcpConfig(loadMcpConfig().filter((s) => s.name !== name));
  return { ok: true };
});

// ═══════════════════════════════════════════
//  P0-F：沙箱状态查询（UI 明示隔离能力与兜底状态）
// ═══════════════════════════════════════════
ipcMain.handle('sandbox:status', async () => {
  // 2026-10：三平台均已有 OS 级后端，状态不能再只看 macOS Seatbelt。
  // Windows 的就绪态是异步的（要 net user 查专用用户），在此统一异步确认，
  // 让 UI 能显示「为什么没隔离 + 下一步怎么做」，而不是一句笼统的「你的系统不支持」。
  const detected = sandbox.detectBackend();
  let available = detected.backend !== 'none';
  let hint = detected.reason;
  if (detected.backend === 'windows-restricted-user') {
    const st = await sandbox.windowsBackend.windowsSandboxReady();
    available = st.ready;
    hint = st.reason;
  }
  return {
    ok: true,
    platform: process.platform,
    available,            // OS 级沙箱是否就绪（三平台：seatbelt / bubblewrap / windows-restricted-user）
    backend: detected.backend,
    hint,                 // 未就绪时的可行动提示（如「apt install bubblewrap」）
    fallbackActive: !available, // 无 OS 级沙箱时启用命令级硬拦截兜底
  };
});

// ═══════════════════════════════════════════
//  P0-E：GitHub 最小闭环（gh CLI 封装）
//  diff 审查的「交付」出口：创建 PR。依赖本机 gh 登录态，不做云端 OAuth。
// ═══════════════════════════════════════════
const github = require('./github');

ipcMain.handle('github:status', async () => {
  const available = await github.ghAvailable();
  if (!available) {
    return { ok: true, available: false, authed: false, hint: '未检测到 GitHub CLI（gh）。请先安装 https://cli.github.com 并执行 gh auth login' };
  }
  const auth = await github.ghAuthed();
  return { ok: true, available: true, authed: auth.ok, hint: auth.ok ? '' : 'gh 未登录，请先执行 gh auth login' };
});

ipcMain.handle('github:createPr', async (_, payload = {}) => {
  const available = await github.ghAvailable();
  if (!available) {
    return { ok: false, error: '未检测到 GitHub CLI（gh）。请先安装 https://cli.github.com 并执行 gh auth login' };
  }
  const r = await github.createPullRequest(payload);
  if (r.ok) {
    audit('github:createPr', String(payload.cwd || ''), `title=${String(payload.title || '').slice(0, 80)} url=${r.url}`, 'recorded');
  } else {
    audit('github:createPr', String(payload.cwd || ''), `error: ${r.error}`, 'error');
  }
  return r;
});

ipcMain.handle('mcp:listServers', async () => {
  return mcp.listMcpServers().map((name) => {
    const s = mcp.getMcpServer(name);
    return { name, toolCount: s?.tools?.length || 0, kind: s?.kind || 'stdio' };
  });
});

// Bug3：已连接服务的全量工具清单（含 inputSchema）——
// 应用重启后主进程自动重连，但渲染层 mcpTools 状态为空，
// 渲染层启动时调此通道重建 agent 工具集，MCP 工具即全程可用
ipcMain.handle('mcp:listTools', async () => {
  return mcp.listMcpServers().map((name) => {
    const s = mcp.getMcpServer(name);
    return { server: name, tools: s?.tools || [] };
  });
});

// B3：已保存（持久化）的 MCP 配置列表 —— 前端据此渲染「已保存但未连接」状态
// P1-M：env 可能含用户配置的 API Key 等敏感变量——跨 IPC 出口一律剥离，
//  spawn 路径直接读磁盘配置（不经此通道），渲染层永远拿不到 env
ipcMain.handle('mcp:getConfig', async () => ({
  ok: true,
  servers: loadMcpConfig().map(({ env, ...rest }) => rest),
}));

// A5：语音本地转写（whisper.cpp；音频不出本机）
const voice = require('./voice');
ipcMain.handle('voice:transcribe', async (_, { wavBase64, language }) => voice.transcribeWav({ wavBase64, language }));

// 启动时自动重连已持久化的 MCP 服务
async function reconnectMcpServers() {
  const config = loadMcpConfig();
  if (config.length === 0) return;
  console.log(`[mcp] 自动重连 ${config.length} 个已保存服务...`);
  for (const s of config) {
    try {
      const res = await connectMcpServer(s);
      console.log(`[mcp] 重连 ${s.name}: ${res.ok ? `${res.toolCount} 个工具` : res.error}`);
    } catch (err) {
      console.warn(`[mcp] 重连 ${s.name} 失败:`, err.message);
    }
  }
}

// ═══════════════════════════════════════════
//  MODEL PROXY (streaming, main-process direct)
//  P0-4：抽为可复用函数——model:chat IPC 与主进程 Agent 运行器（agentRunner）共用。
//  externalSignal：外部中止信号（交互式运行的 AbortController）；信号中止时级联中止在途 fetch。
//  streamTag：运行标识（runId）。带标签时 delta/reasoning 事件发 {tag,text} 对象，
//  渲染层据此把流式输出归到正确的会话（多会话并行/后台运行不串显）；无标签保持旧纯文本协议。
// ═══════════════════════════════════════════
async function chatStreamOnce({ providerId, isGlobal = false, baseUrl, messages, model, tools, reasoningEffort }, sender, externalSignal, streamTag) {
  const secret = resolveSecret(providerId, isGlobal);
  if (!secret || !secret.api_key) {
    throw new Error('KEY_MISSING: 模型凭证未加载，请在本机模型设置中重新填写 API Key');
  }
  const root = (baseUrl || secret.base_url || '').replace(/\/+$/, '');
  if (!root) throw new Error('BASE_URL_MISSING: 模型服务地址为空');
  // P3-2：fg 槽位预占（超时抛错=真过载，调用方按普通失败处理；AbortError 不计错误连击）
  const slot = await quota.acquire('fg', providerId || 'default');
  const body = { model, messages, stream: true, stream_options: { include_usage: true } };
  if (tools) body.tools = tools;
  // 思考强度：仅在用户显式选择时下发（OpenAI 兼容 reasoning_effort；空值不发送，避免严格服务端 400）
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;

  let fullContent = '';
  let usage = null;
  const controller = new AbortController();
  activeChats.add(controller);
  // 级联中止：外部信号（一次 Agent 运行的 controller.signal）→ 本次 chat。
  // 注意必须保存 handler 引用并在 finally 里摘除：一次运行会连续发起十几次 chat，
  // 每次都往同一个 externalSignal 上挂一个 abort 监听。{ once: true } 只在**触发时**
  // 才自动摘除，运行不中止就永远留着 → 11 次后触发 MaxListenersExceededWarning，
  // 且每个闭包都持有本次请求的 controller/缓冲区，长任务下是实打实的内存泄漏。
  let onExternalAbort = null;
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else {
      onExternalAbort = () => controller.abort();
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }
  try {
    const res = await fetch(`${root}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${secret.api_key}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`API ${res.status}: ${err.slice(0, 500)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let toolCalls = [];
    let finishReason = null; // Bug：finish_reason=length 截断时 agent 引擎据此续跑

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta;
          if (json.choices?.[0]?.finish_reason) finishReason = json.choices[0].finish_reason;
          // 推理模型（mimo / DeepSeek-R 系）思考阶段输出 reasoning_content，
          // 此前被丢弃 → 思考全程只有「思考中...」，用户误以为 API 很慢
          if (delta?.reasoning_content) {
            sender.send('model:reasoning', streamTag ? { tag: streamTag, text: delta.reasoning_content } : delta.reasoning_content);
          }
          if (delta?.content) {
            fullContent += delta.content;
            sender.send('model:delta', streamTag ? { tag: streamTag, text: delta.content } : delta.content);
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index || 0;
              if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id, type: 'function', function: { name: tc.function?.name || '', arguments: '' } };
              if (tc.function?.name) toolCalls[idx].function.name = tc.function.name;
              if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
            }
          }
          if (json.usage) usage = json.usage;
        } catch (e) {
          console.warn('[model] SSE 分片解析失败:', e.message);
        }
      }
    }
    quota.reportSuccess(providerId || 'default');
    return { content: fullContent, tool_calls: toolCalls.filter(Boolean), usage, finish_reason: finishReason };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { aborted: true, content: fullContent, usage };
    }
    quota.reportError(providerId || 'default');
    throw err;
  } finally {
    if (onExternalAbort && externalSignal?.removeEventListener) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
    activeChats.delete(controller);
    slot.release();
  }
}

ipcMain.handle('model:chat', (event, payload) => chatStreamOnce(payload || {}, event.sender));

// 中止全部进行中的 chat（停止生成）
// P0-4：同时中止主进程 Agent 运行器中挂起的交互式运行（run controller 级联中止在途 fetch）
ipcMain.handle('model:abort', async () => {
  const n = activeChats.size;
  for (const c of activeChats) c.abort();
  activeChats.clear();
  const abortedRuns = agentRunner.abortAllRuns();
  return { ok: true, aborted: n, abortedRuns };
});

// 定时任务执行通道：非流式单轮直连（凭证解析与 model:chat 同源）
// 模型由渲染层 scheduled:setModel 推送（跟随用户当前选择）；未推送时拒绝执行并给出明确错误
async function scheduledChatOnce({ messages }, model) {
  const secret = resolveSecret(model.providerId, !!model.isGlobal);
  if (!secret || !secret.api_key) {
    throw new Error('KEY_MISSING: 模型凭证未加载，请在模型设置中重新填写 API Key');
  }
  const root = (model.baseUrl || secret.base_url || '').replace(/\/+$/, '');
  if (!root) throw new Error('BASE_URL_MISSING: 模型服务地址为空');
  const res = await fetch(`${root}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${secret.api_key}` },
    body: JSON.stringify({ model: model.model, messages, stream: false }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  return j.choices?.[0]?.message?.content || '';
}

// ═══════════════════════════════════════════
//  P0-D：定时任务 Agent 执行通道
//  此前执行通道为单轮纯文本对话（无工具），「每天跑测试并汇总」只能输出文本不能执行；
//  现复用 agent-core 引擎（工具循环 + 审批分级 + 沙箱 + 轮次预算 + 上下文压缩），
//  与前端会话共用同一套主进程工具实现（toolShell/runWriteTool/... 提取后双通道复用）。
// ═══════════════════════════════════════════
// ESM 边界：agent-core/package.json 声明 "type": "module"，其 index.js 是 ES Module，
// 而主进程是 CommonJS（desktop/package.json 无 type 字段）。此处若用 require() 会在
// **模块加载期**抛 ERR_REQUIRE_ESM —— 不是任务失败，而是整个主进程启动即崩：
// require 之后的所有 IPC 注册与窗口创建都不会执行，表现为「app 起来了但一片空白」。
// 改为惰性动态 import 并缓存 promise：只在真的要跑定时任务时才加载，
// 加载失败可被 runScheduledAgentTask 捕获成「任务失败」，降级为单轮文本而非进程崩溃。
let agentCorePromise = null;
async function loadAgentCore() {
  if (!agentCorePromise) {
    agentCorePromise = import('../agent-core/index.js').catch((err) => {
      agentCorePromise = null; // 清空以便下一次重试，否则一次失败永久失败
      throw new Error(`Agent 引擎加载失败（动态 import）：${err?.message || err}`);
    });
  }
  return agentCorePromise;
}

// 非流式 + 工具调用（OpenAI 兼容）：agent-core chatFn 契约
async function scheduledAgentChat(payload) {
  const secret = resolveSecret(payload.providerId, !!payload.isGlobal);
  if (!secret || !secret.api_key) {
    throw new Error('KEY_MISSING: 模型凭证未加载，请在模型设置中重新填写 API Key');
  }
  const root = (payload.baseUrl || secret.base_url || '').replace(/\/+$/, '');
  if (!root) throw new Error('BASE_URL_MISSING: 模型服务地址为空');
  // P3-2：fg 槽位预占——Worker / 编排 / 记忆后台 compress 均经此通道，统一占用 fg 槽位
  const slot = await quota.acquire('fg', payload.providerId || 'default');
  const body = { model: payload.model, messages: payload.messages, stream: false };
  if (Array.isArray(payload.tools) && payload.tools.length > 0) {
    body.tools = payload.tools;
    body.tool_choice = 'auto';
  }
  try {
    const res = await fetch(`${root}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret.api_key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) {
      quota.reportError(payload.providerId || 'default');
      throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const j = await res.json();
    quota.reportSuccess(payload.providerId || 'default');
    const choice = j.choices?.[0] || {};
    const m = choice.message || {};
    return {
      content: m.content || '',
      tool_calls: (m.tool_calls || []).map((tc) => ({
        id: tc.id, type: 'function',
        function: { name: tc.function?.name || '', arguments: tc.function?.arguments || '{}' },
      })),
      usage: j.usage ? { prompt_tokens: j.usage.prompt_tokens || 0, completion_tokens: j.usage.completion_tokens || 0 } : null,
      finish_reason: choice.finish_reason || null,
    };
  } finally {
    slot.release();
  }
}

// ── GitHub PR 审查闭环工具（gh CLI）──
// 读操作（list/view/diff）直连；写操作（review/comment）对外可见 → L3 审批（见 approval.js TOOL_LEVEL）
// cwd 解析：PR 工具必须拿到项目目录 gh 才能定位仓库——优先模型显式传的 args.cwd
// （agent-core 的 CWD_TOOLS 会注入项目 cwd），缺失时回退主进程 CWD 并在结果中提示。
function prCwdOf(args = {}) {
  const c = String(args.cwd || '').trim();
  if (c) return c;
  return process.cwd();
}
function prReadTool(run) {
  return (args = {}) => run({ cwd: prCwdOf(args), ...args });
}
function prWriteTool(toolKey, run) {
  return async (args = {}) => {
    const { approvalMode = 'on-request', conversationId } = args;
    const verdict = approval.needsApproval({ tool: toolKey, args, approvalMode, conversationId, alwaysRules, conversationRules });
    if (verdict.need) {
      const decision = await requestApproval(toolKey, args);
      if (decision === 'deny') {
        audit(toolKey, `PR #${args.number || '?'}`, '用户拒绝', 'denied');
        return { ok: false, error: '用户拒绝执行', denied: true };
      }
      applyApprovalDecision(decision, toolKey, args, conversationId);
    }
    const r = await run({ cwd: prCwdOf(args), ...args });
    audit(toolKey, `PR #${args.number || '?'} ${args.event || 'comment'}`, r.ok ? 'ok' : `error: ${r.error}`, verdict.need ? 'approved' : 'auto');
    return r.ok ? r : { ...r, ...(String(args.cwd || '') ? {} : { hint: '未提供 cwd，已按主进程工作目录执行；若找不到仓库请先在项目内运行' }) };
  };
}
const prTools = {
  prList: prReadTool((a) => github.prList(a)),
  prView: prReadTool((a) => github.prView(a)),
  prDiff: prReadTool((a) => github.prDiff(a)),
  prReview: prWriteTool('pr_review', (a) => github.prReview(a)),
  prComment: prWriteTool('pr_comment', (a) => github.prComment(a)),
};

// 定时任务专用 toolHandlers：与渲染层会话同源（复用主进程工具实现）
function scheduledToolHandlers() {
  return {
    chat: scheduledAgentChat,
    shell: toolShell,
    readFile: toolReadFile,
    writeFile: (args) => runWriteTool('writeFile', args),
    editFile: (args) => runWriteTool('editFile', args),
    applyPatch: (args) => runWriteTool('applyPatch', args),
    listDir: toolListDir,
    grep: toolGrep,
    glob: toolGlob,
    gitStatus: toolGitStatus,
    gitDiff: toolGitDiff,
    gitLog: toolGitLog,
    gitBranch: toolGitBranch,
    gitCommit: toolGitCommit,
    gitAdd: toolGitAdd,
    mcpCallTool: callMcpTool,
    prList: prTools.prList,
    prView: prTools.prView,
    prDiff: prTools.prDiff,
    prReview: prTools.prReview,
    prComment: prTools.prComment,
  };
}

// P0-4：主进程 Agent 运行器——交互式会话工具循环迁移至主进程。
// 渲染层只负责发起（agent:run）、订阅事件（agent:event）、中止（agent:abort）；
// 循环本体与全部工具副作用都在主进程，刷新/关闭窗口不再杀死进行中任务。
const agentRunner = require('./agentRunner');
const { waitGroupSettled, humanizeGroupResult } = require('./orchestrator/invoke');

// orchestrate_task 工具实现：对话内自动多 Agent 编排（模型自主决策触发）。
// 同步等待整组收尾，返回人话聚合结果；用户「停止」时立即返回未完成说明。
// 注意：仅在主会话 handlers 注入——Worker 内不可再编排（防递归失控）。
async function toolOrchestrateTask(args, { signal } = {}) {
  const goal = String(args?.goal || '').trim();
  if (!goal) return { ok: false, error: 'goal 不能为空' };
  if (!taskStore) return { ok: false, error: '任务编排子系统不可用（初始化失败）' };
  const cwd = String(args?.cwd || '');
  const maxAgents = Number(args?.max_agents);
  if (maxAgents >= 1 && maxAgents <= 8) workerPool.setMaxConcurrent(Math.floor(maxAgents));
  const plan = await orchestrator.autoOrchestrate({ goal, cwd });
  if (!plan.ok) return { ok: false, error: `编排启动失败：${plan.error}` };
  const waited = await waitGroupSettled(taskStore, plan.groupId, { signal });
  if (waited.aborted) {
    // 用户已停止：强停该组全部在役 Agent（已完成结果保留在组内，胶囊面板可查）
    for (const a of workerPool.listActive()) {
      if (a.groupId === plan.groupId) workerPool.abortTask(a.groupId, a.taskId);
    }
    return { ok: false, aborted: true, groupId: plan.groupId,
      error: `用户已停止：编排组 ${plan.groupId} 的在役 Agent 已中止（已完成的部分结果已保留）` };
  }
  if (waited.timedOut || waited.missing) {
    return { ok: false, groupId: plan.groupId, error: `编排组 ${plan.groupId} 等待超时或状态异常，可稍后在对话中查询进度` };
  }
  return { ok: true, groupId: plan.groupId, taskCount: plan.tasks.length, summary: humanizeGroupResult(waited.group) };
}

agentRunner.initAgentRunner({
  loadAgentCore,
  // 每次运行独立工具处理器：chat 用流式实现（externalSignal=运行 controller，级联中止在途 fetch），
  // 其余工具与定时任务通道同源（toolShell/runWriteTool/toolGrep/... 主进程实现直调）
  createToolHandlers: ({ sender, signal, runId }) => ({
    ...scheduledToolHandlers(),
    // runId 作为 streamTag：Agent 运行的流式输出带标签，渲染层按活跃会话过滤（切会话/后台运行不串显）
    chat: (chatPayload) => chatStreamOnce(chatPayload, sender, signal, runId),
    orchestrateTask: (args) => toolOrchestrateTask(args, signal),
    // 对话内网络插件搜索/安装（LobeChat 式）：搜索只读；安装恒走 L3 审批卡
    searchPlugins: (args) => searchPluginsTool(args),
    installPlugin: (args) => installNetworkPlugin(args, {
      approvalMode: args.approvalMode || 'on-request',
      conversationId: args.conversationId || '',
    }),
    // P0-A：Web 检索/抓取。内网地址已由 webTools 自行拦截（SSRF 防护）。
    // todoWrite 由 agent-core 内置处理（纯状态，不出网、不触盘），故不在此注册。
    webSearch: (args) => webTools.webSearch(args),
    webFetch: (args) => webTools.webFetch(args),
    // GitHub PR 审查闭环（读直连；review/comment 走 L3 审批）
    prList: prTools.prList,
    prView: prTools.prView,
    prDiff: prTools.prDiff,
    prReview: prTools.prReview,
    prComment: prTools.prComment,
  }),
});
ipcMain.handle('agent:run', (event, payload) => agentRunner.startAgentRun(payload || {}, event.sender));
ipcMain.handle('agent:abort', (_, { runId } = {}) => ({ ok: agentRunner.abortRun(runId) }));

// 定时任务 Agent 入口：scheduler.runTask 到点调用
// 审批策略 auto-safe：L2 写操作自动放行（本地审计已留痕），L1 危险命令/L3 MCP 仍弹审批卡
// （2 分钟无响应按拒绝，与交互式一致）；沙箱有项目目录 workspace-write、无目录 read-only（P0-B 一致）
async function runScheduledAgentTask({ prompt, model: schedModel, signal }) {
  if (!schedModel || !schedModel.model) {
    throw new Error('未配置执行模型：请在任意会话中选择模型（定时任务复用会话模型与凭证）');
  }
  // 扁平形 → 嵌套形：改用共享转换（此前是此处手抄，Worker 路径漏抄导致崩溃）
  const runModel = toAgentModel(schedModel);
  const cwd = schedModel.cwd || '';
  let toolCount = 0;
  let totalUsage = { prompt_tokens: 0, completion_tokens: 0 };
  const agentCore = await loadAgentCore();
  const finalText = await agentCore.runAgent({
    messages: [{ role: 'user', content: String(prompt || '') }],
    model: runModel,
    cwd,
    signal,
    approvalMode: 'auto-safe',
    sandboxPolicy: cwd ? 'workspace-write' : 'read-only',
    conversationId: 'scheduled',
    maxRounds: 20,
    chatRetryBaseMs: 2000, // 无人值守：退避基数放宽，弱网下更耐心
    systemPrompt: '你是定时任务执行器：使用工具完成任务提示词中的要求，产出精炼可读的结果摘要。'
      + '不要反问、不要输出无关寒暄；工具失败时换方式重试或如实说明，不要假装完成。',
    toolHandlers: scheduledToolHandlers(),
    onToolCall: () => { toolCount += 1; },
    onDone: (_text, usage) => { if (usage) totalUsage = usage; },
  });
  return { output: finalText || '', toolCalls: toolCount, usage: totalUsage };
}

// ═══════════════════════════════════════════
//  P1：任务编排子系统（Orchestrator + WorkerPool + 持久化队列 + Aggregator）
//  目标 → LLM 拆解 DAG → 并行分层执行（wait_all）→ 聚合收尾；SQLite 断点续跑。
//  与定时任务通道同源：loadAgentCore / scheduledAgentChat / scheduledToolHandlers 复用。
// ═══════════════════════════════════════════
const { openDbAsync } = require('./db');
const { TaskStore } = require('./taskStore');
const { MemoryManager } = require('./memory');
const { MemoryBgScheduler } = require('./memory/bgScheduler');
const workerPool = require('./workerPool');
const orchestrator = require('./orchestrator');

let taskStore = null;
let taskDb = null;
let memoryManager = null;   // P2-1：记忆唯一写入入口（SQLite，五域四层）
let memoryScheduler = null; // P2-5：记忆后台任务调度器

function emitTaskEvent(evt) {
  // 事件桥接：编排器监听组终态/暂停事件，驱动 auto 组自动重规划
  try { orchestrator.onTaskEvent(evt); } catch (e) { console.error('[orchestrator] 事件处理异常:', e.message); }
  for (const w of BrowserWindow.getAllWindows()) {
    try { if (!w.isDestroyed()) w.webContents.send('tasks:event', evt); } catch { /* 窗口已销毁 */ }
  }
}

// 任务执行模型：与定时任务同源（跟随用户当前选择；未选择时给出可行动错误）
function resolveTaskModel() {
  const m = scheduler.getModel();
  if (!m || !m.model) {
    throw new Error('未配置执行模型：请在任意会话中选择模型（任务编排复用会话模型与凭证）');
  }
  return { providerId: m.providerId, isGlobal: !!m.isGlobal, baseUrl: m.baseUrl || '', model: m.model };
}

function initTaskOrchestration() {
  // 异步初始化：驱动选择可能包含子进程金丝雀探测（最长 ~10s），不阻断启动
  openDbAsync(app.getPath('userData'), { isPackaged: app.isPackaged })
    .then(setupTaskOrchestration)
    .catch((err) => {
      // 编排子系统初始化失败不阻断应用启动（任务功能不可用，其余不受影响）
      console.error('[tasks] 初始化失败（任务编排不可用）:', err.message);
      taskStore = null;
    });
}

function setupTaskOrchestration(db) {
  try {
    taskDb = db;
    taskStore = new TaskStore(db);

    // P2：记忆体系初始化（与任务编排共用 SQLite 底座）
    memoryManager = new MemoryManager({ db });
    // 旧 JSON 记忆一次性导入（幂等：localStore 清空后不再重复；按标记只导一次）
    try {
      if (db.prepare("SELECT COUNT(*) AS n FROM memories WHERE source = 'legacy-import'").get().n === 0) {
        const legacy = localStore?.data?.memories || [];
        const n = memoryManager.importLegacy(legacy);
        if (n > 0) console.log(`[memory] 旧记忆导入完成：${n} 条`);
      }
    } catch (e) { console.warn('[memory] 旧记忆导入跳过:', e.message); }
    memoryScheduler = new MemoryBgScheduler({
      db,
      memory: memoryManager,
      chatOnce: scheduledAgentChat,
      resolveModel: resolveTaskModel,
      bgGate: () => quota.bgAllowed(), // P3-3：前台过载/熔断时后台作业全部让路
      emit: emitTaskEvent,
    });
    memoryScheduler.start({ intervalMs: 60 * 1000 });

    workerPool.initWorkerPool({
      loadAgentCore,
      store: taskStore,
      maxConcurrent: Number(localStore?.getPreference('tasks.max_concurrent')) || 4,
      emit: emitTaskEvent,
      resolveModel: resolveTaskModel,
      createToolHandlers: ({ signal }) => ({
        ...scheduledToolHandlers(),
        // Worker 的 chat 走非流式直连（无 UI 消费流式 token），运行中止由池的 controller 级联
        chat: (payload) => scheduledAgentChat(payload),
        // P0-A：Worker 同样需要 Web 能力（子任务常需查文档/查报错）
        webSearch: (args) => webTools.webSearch(args),
        webFetch: (args) => webTools.webFetch(args),
      }),
      buildTaskPrompt: (group, task) => {
        // 注入总体目标 + 已完成前置任务的结论摘要（跨 Worker 数据传递的唯一通道）
        const gNow = taskStore.getGroup(group.group_id);
        const doneSiblings = (gNow?.tasks || [])
          .filter((t) => t.status === 'done' && t.taskId !== task.taskId)
          .map((t) => `- ${t.title}：${String(t.result?.summary || '').slice(0, 300)}`);
        // P2-6：分层召回——按「目标+任务标题」查询该空间相关记忆，Top-3 注入
        let memoryBlock = '';
        try {
          if (memoryManager && group.cwd) {
            const hits = memoryManager.recallContents({
              spaceId: group.cwd, query: `${group.goal} ${task.title}`, topK: 3,
              domains: ['global_knowledge', 'entity', 'reflection'],
            });
            if (hits.length) {
              memoryBlock = `【相关记忆（历史沉淀，供参考）】\n${hits.map((m) => `- ${m.content.slice(0, 200)}`).join('\n')}`;
            }
          }
        } catch { /* 记忆召回失败不阻塞任务 */ }
        return [
          `【总体目标】\n${group.goal}`,
          doneSiblings.length ? `【已完成前置任务的结论摘要】\n${doneSiblings.join('\n')}` : '',
          memoryBlock,
          `【你的子任务】${task.title}\n${task.prompt}\n\n只完成该子任务，产出可执行的结论；工作目录即项目目录。`,
        ].filter(Boolean).join('\n\n');
      },
    });

    orchestrator.initOrchestrator({
      loadAgentCore,
      store: taskStore,
      chatOnce: scheduledAgentChat,
      resolveModel: resolveTaskModel,
      emit: emitTaskEvent,
      runGroup: (gid) => workerPool.runGroup(gid),
    });

    // 崩溃恢复：中断的 running 任务回队；上轮运行中的组自动续跑（断点续跑）
    const rec = taskStore.recoverInterrupted();
    if (rec.recoveredTasks > 0 || rec.runningGroups.length > 0) {
      console.log(`[tasks] 崩溃恢复：${rec.recoveredTasks} 个任务回队，${rec.runningGroups.length} 个组续跑`);
      for (const gid of rec.runningGroups) {
        workerPool.runGroup(gid).catch((e) => console.error(`[tasks] 组 ${gid} 续跑失败:`, e.message));
      }
    }
    console.log('[tasks] 任务编排子系统就绪（SQLite 持久化队列 + Worker 池）');
  } catch (err) {
    // 编排子系统初始化失败不阻断应用启动（任务功能不可用，其余不受影响）
    console.error('[tasks] 初始化失败（任务编排不可用）:', err.message);
    taskStore = null;
  }
}

// ── 任务编排 IPC ──
ipcMain.handle('tasks:autoRun', async (_, { goal, cwd } = {}) => {
  if (!taskStore) return { ok: false, error: '任务编排子系统不可用（初始化失败）' };
  // 一键自动：拆解（失败自动修复重试）→ 直接执行；组失败后由 orchestrator 自动重规划
  return orchestrator.autoOrchestrate({ goal, cwd });
});
ipcMain.handle('tasks:plan', async (_, { goal, cwd } = {}) => {
  if (!taskStore) return { ok: false, error: '任务编排子系统不可用（初始化失败）' };
  return orchestrator.planGoal({ goal, cwd });
});
ipcMain.handle('tasks:execute', async (_, { groupId } = {}) => {
  if (!taskStore) return { ok: false, error: '任务编排子系统不可用' };
  try {
    const g = await workerPool.runGroup(groupId);
    return { ok: true, group: g };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('tasks:list', async (_, opts) => (taskStore ? { ok: true, groups: taskStore.listGroups(opts) } : { ok: false, error: '不可用' }));
ipcMain.handle('tasks:get', async (_, { groupId } = {}) => (taskStore ? { ok: true, group: taskStore.getGroup(groupId) } : { ok: false, error: '不可用' }));
ipcMain.handle('tasks:cancel', async (_, { groupId } = {}) => {
  if (!taskStore) return { ok: false, error: '不可用' };
  try {
    // v1：仅允许取消未在执行的组（ready/paused）；running 组等收尾或用任务级重试干预
    const g = taskStore.getGroup(groupId);
    if (!g) return { ok: false, error: '任务组不存在' };
    if (g.status === 'running') return { ok: false, error: '组执行中，暂不支持取消；请等待收尾后处理' };
    return { ok: true, group: taskStore.setGroupStatus(groupId, 'cancelled') };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
// 强制关闭正在执行的子任务（Agent 面板入口）：中止运行且不重试
ipcMain.handle('tasks:abortTask', async (_, { groupId, taskId } = {}) => {
  if (!taskStore) return { ok: false, error: '不可用' };
  const done = workerPool.abortTask(groupId, taskId);
  return done ? { ok: true } : { ok: false, error: '该任务不在执行中（可能已完成或尚未开始）' };
});
// 组级强停（对话中止联动 / 胶囊面板「全部停止」）
ipcMain.handle('tasks:abortGroup', async (_, { groupId } = {}) => {
  if (!taskStore) return { ok: false, error: '不可用' };
  const n = workerPool.abortGroup(groupId);
  return { ok: true, aborted: n };
});
ipcMain.handle('tasks:retryTask', async (_, { groupId, taskId } = {}) => {  if (!taskStore) return { ok: false, error: '不可用' };
  try {
    const t = taskStore.getTask(groupId, taskId);
    if (!t) return { ok: false, error: '子任务不存在' };
    if (t.status !== 'failed') return { ok: false, error: `仅失败任务可重试（当前：${t.status}）` };
    taskStore.setTaskStatus(groupId, taskId, 'queued');
    const g = taskStore.getGroup(groupId);
    if (g.status === 'paused') taskStore.setGroupStatus(groupId, 'running'); // paused → running（重试续跑）
    workerPool.schedule();
    return { ok: true, group: taskStore.getGroup(groupId) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('tasks:config', async (_, { maxConcurrent } = {}) => {
  const n = workerPool.setMaxConcurrent(maxConcurrent);
  localStore?.setPreference('tasks.max_concurrent', n);
  return { ok: true, maxConcurrent: n };
});

// ═══════════════════════════════════════════
//  COMPUTER USE (M4-C)：macOS AX 结构化界面自动化
//  事件契约与实现细节见 computerUse.js 头部注释
// ═══════════════════════════════════════════
const cua = require('./computerUse');
let activeCuaLoop = null; // 当前进行中的 CUA 循环（供 cua:stop 中断）

// CUA 逐次确认弹窗：独立通道，避免与并行工具审批（tool:approval-response）互相串扰
// 决策不进入 applyApprovalDecision 规则库 —— 敏感动作必须逐次确认，不可会话/永久放行
function requestCuaApproval(summary) {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) { resolve('deny'); return; }
    const timer = setTimeout(() => resolve('deny'), 120000); // 2 分钟无响应按拒绝处理
    ipcMain.once('cua:approval-response', (_, decision) => {
      clearTimeout(timer);
      resolve(decision || 'deny');
    });
    mainWindow.webContents.send('cua:approval-request', summary);
  });
}

// CUA 循环用非流式 chat（复用 model:chat 同款凭证解析结果）
async function cuaChat(root, apiKey, model, messages) {
  const res = await fetch(`${root}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, stream: false }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API ${res.status}: ${err.slice(0, 500)}`);
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content || '';
}

ipcMain.handle('cua:status', async () => {
  // 能力矩阵：截图/屏幕尺寸已跨平台（win32 PowerShell / linux scrot 链），
  // AX 树与键鼠执行仍 macOS 独有。UI 据此只隐藏不可用的部分，不再笼统报「仅 macOS」。
  const support = cua.cuaSupport();
  if (!support.automation) {
    return {
      available: false,
      granted: false,
      ...support,
      message: support.message,
    };
  }
  const granted = await cua.isAccessibilityGranted();
  return {
    available: true,
    granted,
    ...support,
    message: granted
      ? ''
      : '未授予辅助功能权限：请在 系统设置 > 隐私与安全性 > 辅助功能 中允许本应用后重试',
  };
});

ipcMain.handle('cua:run', async (_, { objective, appName, approvalMode = 'on-request', conversationId, model, providerId, isGlobal = false, baseUrl, allowedApps, maxSteps }) => {
  if (activeCuaLoop) return { ok: false, error: '已有进行中的界面自动化任务，请先停止' };
  if (!objective || !appName) return { ok: false, error: 'objective 与 appName 必填' };
  if (process.platform !== 'darwin') return { ok: false, error: '界面自动化仅支持 macOS' };
  if (!(await cua.isAccessibilityGranted())) {
    return { ok: false, error: 'NEED_ACCESSIBILITY: 未授予辅助功能权限，请在 系统设置 > 隐私与安全性 > 辅助功能 中允许本应用' };
  }
  // 凭证解析：与 model:chat 同款（本地优先）
  const secret = resolveSecret(providerId, isGlobal);
  if (!secret || !secret.api_key) return { ok: false, error: 'KEY_MISSING: 模型凭证未加载，请在本机模型设置中重新填写 API Key' };
  const root = (baseUrl || secret.base_url || '').replace(/\/+$/, '');
  if (!root) return { ok: false, error: 'BASE_URL_MISSING: 模型服务地址为空' };

  const send = (evt) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('cua:event', evt);
  };
  const hud = cua.createHudWindow(BrowserWindow);
  const loop = new cua.ComputerUseLoop({
    objective,
    appName,
    maxSteps,
    model,
    approvalMode,
    allowedApps: allowedApps || [appName],
    toolHandlers: {
      chat: (messages) => cuaChat(root, secret.api_key, model, messages),
      collectAx: (name) => cua.collectAxTree(name || appName),
      perform: (action, node) => cua.performAction(action, node, { appName: appName || node?.name || '' }),
      isLocked: () => cua.isScreenLocked(),
    },
    approval: {
      requestApproval: (summary) => requestCuaApproval(summary),
      // 全部动作脱敏审计上报（审批结果随行）
      audit: (step, actionText, result) => audit('cua', appName, `step${step}: ${actionText} -> ${result}`, result === 'denied' ? 'denied' : 'approved'),
    },
    hud,
    onEvent: send,
  });
  activeCuaLoop = loop;
  loop.run()
    .catch((err) => send({ type: 'error', message: err.message }))
    .finally(() => {
      activeCuaLoop = null;
      cua.destroyHud();
    });
  return { ok: true };
});

ipcMain.handle('cua:stop', async () => {
  if (!activeCuaLoop) return { ok: false, error: '没有进行中的界面自动化任务' };
  activeCuaLoop.stop();
  return { ok: true };
});
// ═══════════════════════════════════════════
//  END COMPUTER USE (M4-C)
// ═══════════════════════════════════════════
