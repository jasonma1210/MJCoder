const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const path = require('path');
const fsp = require('fs/promises');
const fs = require('fs');
const { writeFileDurable } = require('./data/durableWrite');
const { AsyncLocalStorage } = require('async_hooks');
// X14：写通道载荷边界校验（形状与上限，不判业务语义）——只在 main.js 直连的写通道上用
const guard = require('./ipc/payloadGuard');

// ── D2（2026-10-16）：任务写通道（tasks:*）载荷契约 ──
// 契约本身仍是 shared-ipc/taskPayloads.mjs（zod，动态 import + ready 门）；X14 批次把 tasks:*
// 的 IPC 注册整体搬到 main/ipc/tasks.js（拆分理由是模块边界，不是行数告急——见第 1133 行附近
// 对 max-lines 口径的说明：该门禁按去空行注释的 code 行数算，raw 与它差约 400 行），
// 校验入口 validateTaskPayload 随之搬走，此处不再保留副本。

let mainWindow;

// ── N5 rootExecution 统一取消的运行上下文（2026-10-16）──
// runScope：agentRunner 的工具 handler 全部在 { runId } 上下文内执行——
//   requestApproval 据此把挂起审批挂到 runId（运行取消 → cancelApprovalsForRun 统一撤下）；
//   exec.js 据此把 shell 子进程注册到 runId（运行取消 → killChildrenForRun 终止子进程）。
const runScope = new AsyncLocalStorage();
// P0-1：运行级子进程注册表（单一事实来源，main/childRegistry.js）——
// initToolExec（工具层）与 initAgentRunner（编排/子代理）共用，取消运行时整组杀灭
const childRegistry = require('./childRegistry').createChildRegistry();

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
    // P0-持久化（2026-10-16）：原为裸 writeFileSync（无 tmp+rename、无 fsync）。
    // 审批规则写坏的后果是「用户设过的白名单消失」⇒ 同样的操作开始反复弹审批，
    // 或更糟：曾拒绝过的模式不再被拒绝。改走 writeFileDurable。
    const res = writeFileDurable(APPROVAL_RULES_FILE(), JSON.stringify(alwaysRules, null, 2));
    if (!res.ok) console.warn('[approval] 规则持久化失败:', res.error);
  } catch (e) {
    console.warn('[approval] 规则持久化异常:', e.message);
  }
}

// 向渲染层发起审批，返回 'once' | 'conversation' | 'always' | 'deny'
// P0-2：审批响应按 approvalId 精确分发。原实现 ipcMain.once 共享一条无 id 通道，
// 多工具并发审批时第一个响应会被任一等待者消费，决策可能张冠李戴（把「允许」发给更危险的命令）。
// P1-4：approvalReasonOf/denialText——拒绝理由取回与文案（单一事实来源在 approvalChannel.js）
// 差集 A：initDiffCommentChannel——diff 行内评论存储（挂 localStore 线程）
const { ApprovalChannel, approvalReasonOf, denialText, initDiffCommentChannel } = require('./approvalChannel');
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
  // N5：审批挂到发起它的运行（AsyncLocalStorage 上下文由 agentRunner 的 handler 包装注入），
  // 运行取消时 cancelApprovalsForRun 统一撤下（rootExecution 统一取消之「撤审批」）。
  const waitP = approvalChannel.wait(approvalId, broadcastApprovalEnd, runScope.getStore()?.runId || null);
  // P0-5：无可用窗口（启动早期 / 窗口已销毁）无法征求用户 → fail-closed 按 deny 收尾，
  // 不再对 mainWindow.webContents 裸解引用（IPC rejection 会把工具循环打进不可诊断态）
  const win = mainWindow && (typeof mainWindow.isDestroyed !== 'function' || !mainWindow.isDestroyed()) ? mainWindow : null;
  if (!win) {
    console.warn(`[approval] 无可用窗口，审批按 deny 收尾（tool=${tool}）`);
    approvalChannel.dispatch(approvalId, 'deny');
    return waitP;
  }
  // V21：审批卡需显示请求来源的工作根——cwd 随摘要下发（无 cwd 时不带该字段）
  win.webContents.send('tool:approval-request', { approvalId, tool, rememberable: approval.isRememberable(tool), ...(args?.cwd ? { cwd: args.cwd } : {}), ...summary });
  return waitP;
}

// 全局唯一监听器：按 approvalId 分发（替代原先每次请求注册一次的 ipcMain.once）
ipcMain.on('tool:approval-response', (_, payload) => {
  const hasId = payload && typeof payload === 'object';
  const approvalId = hasId ? payload.approvalId : null;
  const decision = hasId ? payload.decision : payload;
  // P1-4：用户可选的决策理由随决议回传（无理由时行为不变）
  const reason = hasId ? payload.reason : undefined;
  const dispatched = approvalId != null
    ? approvalChannel.dispatch(approvalId, decision, reason)
    : approvalChannel.dispatchLegacy(approvalId, decision); // P2-3：无 id 响应一律拒绝并告警
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

// T2-1：沙箱（Seatbelt/bwrap/Windows）与写路径白名单守卫现由 main/tools/exec.js 直接使用，
// main.js 不再持有引用（审批中心与 IPC 接线仍在本文件）。

// ── 桌面端功能开关（战略收敛：默认冻结协同/云端/小程序，聚焦桌面端单点）──
const { loadFeatureFlags } = require('./featureFlags');
const featureFlags = loadFeatureFlags(process.env);
// T2-1：SKILL.md 兼容层与 IDE 跳转 IPC 已随生态域拆出 main/ipc/ecosystem.js
// T2-1：本地项目工作区/worktree IPC 已拆出 main/ipc/project.js
// 统一降级日志原语（区分「服务端不可达」与真错误）
const degrade = require('./degrade');

// ── 本地优先数据层（离线模式）──
const { LocalStore } = require('./localStore');
// P1-1：无人值守路径的审批/沙箱档来源（用户设置），与交互 run 的 payload 档严格分开
const approvalSettings = require('./approvalSettings');
const { CredentialCrypto } = require('./credentialCrypto');
// 自定义模型配置文件（对标 WorkBuddy models.json）：~/.mjcode/models.json → providers 同步
const modelsFile = require('./modelsFile');
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
    // 凭证加密双轨（credentialCrypto.js）：safeStorage 不可用（打包版 macOS 27 真机复现）
    // 时降级文件密钥 AES-256-GCM——凭证仍可保存，保护级别显式降级并留痕
    credentialCrypto = new CredentialCrypto(app.getPath('userData'), safeStorage);
    // web_search 配置读取/写入同样通过 credentialCrypto 加密，P0-20 不得留明文旁路。
    webTools.setLocalStore(localStore, credentialCrypto);
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
    // 配置文件来源的模型（~/.mjcode/models.json）：Key 不走 keyEncrypted 解密回填，
    // 由 sync 直接注入 vault（文件是事实来源，见 syncModelsFile）
    for (const p of localStore.data.providers) {
      if (p.source === 'file') localVault.delete(p.id); // 先清，随后 sync 重注（文件可能已删条目）
    }
    migrateLocalModelsToFile(); // 旧 UI 模型 → 配置文件（仅文件缺失/仍是模板时触发，见下）
    syncModelsFile({ reason: 'startup' });
    console.log(`[local] 本地数据层就绪：${localStore.listThreads().length} 线程 / ${localStore.listProviders().length} 私有服务（加密轨：${credentialCrypto.scheme}）`);
  } catch (err) {
    console.error('[local] 初始化失败:', err);
  }
}

// T2-1：本地数据域已拆出 main/ipc/localData.js（只搬移不改行为）——
// models.json 同步/写回 + 会话·消息·provider·项目·偏好·记忆 IPC。
// localStore/credentialCrypto/memory* 在 whenReady 后才存在，经 getter 注入；localVault 为共享 Map 引用。
const localDataIpc = require('./ipc/localData');
localDataIpc.initLocalDataIpc({
  getLocalStore: () => localStore,
  getCredentialCrypto: () => credentialCrypto,
  localVault,
  serverBase,
  MJ_SERVER_DEFAULT,
  getMemoryManager: () => memoryManager,
  getMemoryScheduler: () => memoryScheduler,
});
const { syncModelsFile, maybeSyncModelsFile, migrateLocalModelsToFile } = localDataIpc;

// 差集 A：diff 行内评论存储——评论挂到 localStore 的线程对象（t.diffComments）随
// local-data.json 持久化；localStore 未就绪时 getter 返回 null，内部退化为进程内 Map。
initDiffCommentChannel({ getLocalStore: () => localStore });
// P0-8c：开机自启 IPC（实现抽到 main/autoLaunch.js——系统能力与调度器解耦，与行数无关；
// 理由与 autoLaunch.js 文件头保持一致，别再写成「逼近 max-lines 门禁」）
require('./autoLaunch').initAutoLaunchIpc({ getStore: () => localStore });


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
// T0-5：本地结构化运行 trace（userData/traces/<runId>.jsonl，不上报；供排障与诊断包）
const runTrace = require('./runTrace');
runTrace.initRunTrace(app.getPath('userData'));
// P2-8 / V-L1：V 层判定落盘目录（userData/eval/verdicts-YYYYMMDD.jsonl，仅元数据，不上报）
require('./verifyRun').initVerifyRun(app.getPath('userData'));
// 定时通道的 V 层装配（L1 全量 + L3 风险门/抽样 + 无人值守 fail-closed）
const { createScheduledVerify, createScheduledL3Target } = require('./scheduledVerify');
// 对外动作闸门（产物形态即校验）：默认拦截提交/推送/MCP/破坏性 shell，转成「待确认动作清单」
const { createScheduledGuard } = require('./scheduledGuard');
// L3 评审目标工厂：延迟到调用时解析（配置可变，且启动早期 model 尚未就绪）
const scheduledL3Target = createScheduledL3Target({
  resolveModel: () => scheduler.getModel(),
  getModelOverrides: () => localStore?.getPreference('model_overrides') || {},
  chatOnce: (p, m) => scheduledChatOnce(p, m),
});

// T2-5：本地崩溃/异常聚合（结构化 JSONL + trace 尾部 + 渲染层错误转发 + 原生崩溃 dump）。
// 全部落本机不上传；agentRunner 在本文件后段声明，经 getter 延迟读取（异常发生才调用）。
const { initDiagnostics, reportError, startCrashReporter } = require('./diagnostics');
initDiagnostics({ app, getActiveRunIds: () => agentRunner.getActiveRunIds(), readTraceEvents: (rid) => runTrace.readTraceEvents(rid) });
startCrashReporter(app);
// T2-6：诊断包一键导出（设置页触发；审计/崩溃/trace/日志/脱敏配置打 zip，凭证一律剔除）
const { registerDiagExportIpc } = require('./diagExport');
registerDiagExportIpc();
// T3-1：大消息 IPC 可靠传输——超限工具结果落临时文件+句柄分页（agentRunner 发送前卸载）；
// 大文件预览改 mjpreview:// 流式协议（scheme 特权注册必须早于 app ready）
const bigPayload = require('./bigPayload');
// T1（2026-10-17）：流式三层守卫（首字节 / 空闲 / 单轮总时长）。
// 替代原来的 AbortSignal.timeout(125000)——那是「总时长」语义，会把推理模型
// （mimo 等思考阶段长时间无正文）误判成「无响应」并整轮杀掉。
const { createStreamGuard, streamTimeoutMessage } = require('./streamGuard');
// T6：三层超时可在设置页调整（用户设置 > 环境变量 > 默认），每次请求现读，改完立即生效
const streamSettings = require('./streamSettings');
const resolveStreamTimeouts = () => streamSettings.getStreamTimeouts();
// T6：注入 localStore getter（此时 localStore 变量已声明，whenReady 后才赋值）
streamSettings.initStreamSettings({ getLocalStore: () => localStore });
const { createScheduledChannels } = require('./scheduledChannels');
bigPayload.initBigPayload({ dataDir: app.getPath('userData') });
bigPayload.registerBigPayloadIpc(ipcMain);
const previewScheme = require('./previewScheme');
previewScheme.registerPreviewSchemePrivileges();
ipcMain.handle('checkpoint:get', (_, threadKey) => checkpointStore.getCheckpoint(threadKey));
ipcMain.handle('checkpoint:clear', (_, threadKey) => {
  // X14：threadKey 直接当断点存储的键（对象/数组会变成 "[object Object]" 这类键，
  // 清掉的不是用户以为的那个会话）；可缺省（清全部调用方不传），故 optional + 长度上限
  try {
    guard.assertStrings({ threadKey }, { threadKey: { max: 256, optional: true, allowEmpty: true } });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: checkpointStore.clearCheckpoint(threadKey) };
});
// Phase 3-4：token 仪表盘数据源（最近一次运行的逐轮用量快照）
ipcMain.handle('agent:token/state', () => agentRunner.getTokenState());
// P3-4：本地后端探测（Ollama）——启动时一次 + 每 5 分钟复探；结果进快照供渲染层展示
quota.detectLocalBackend().catch(() => {});
setInterval(() => { quota.detectLocalBackend().catch(() => {}); }, 5 * 60 * 1000).unref?.();


// T2-1：审计域已拆出 main/audit/auditLog.js（只搬移不改行为）。
// 33 处调用点仍以同名 audit() 使用；authToken 归属本文件（model:getSecrets 成功后赋值），
// 经 getter 注入供审计读取；serverBase 同源。
const { initAudit, audit } = require('./audit/auditLog');
initAudit({ getAuthToken: () => authToken, serverBase });

// T2-1：生态与杂项 IPC 域已拆出 main/ipc/ecosystem.js（只搬移不改行为）——
// flags/协同/skillCompat/IDE/ecosystem/websearch。audit 与 SKILLS_DIR 经注入保持同源。
const { initEcosystemIpc } = require('./ipc/ecosystem');
initEcosystemIpc({ getLocalStore: () => localStore, getCredentialCrypto: () => credentialCrypto, featureFlags, audit, getSkillsDir: () => SKILLS_DIR() });

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

// T2-1：窗口生命周期域已拆出 main/lifecycle/window.js（只搬移不改行为）——
// 窗口状态持久化 / 主窗口创建 / 打包版 console tee。mainWindow 归属本文件，经 getter/setter 注入。
const windowLifecycle = require('./lifecycle/window');
// C2：进程级崩溃守卫（render-process-gone / child-process-gone / unresponsive）
const { createCrashGuard } = require('./lifecycle/crashGuard');
windowLifecycle.init({ getMainWindow: () => mainWindow, setMainWindow: (w) => { mainWindow = w; } });
const { createWindow, setupFileLogging } = windowLifecycle;

// C2（2026-10-17）：进程级崩溃的可观测性 + 自愈。
// 此前全仓没有 render-process-gone / child-process-gone / unresponsive 监听：
// JS 层异常有 window.onerror → diag:report 兜底，但渲染进程**整体崩掉**（OOM / GPU / 被杀）
// 时渲染层自己报不了，主进程也没人听，现场只剩「白屏 + 无证据」。
// 自动 reload 依赖 local-data.json 里的会话数据，重载不丢历史。
const crashGuard = createCrashGuard({
  reportError,
  getMainWindow: () => mainWindow,
});
crashGuard.attach(app);
// 渲染层启动时领取「上次崩过」的通知（取完即清）：App 首帧就会问，必须早注册
ipcMain.handle('app:crash-notice', () => crashGuard.takeNotices());
// T6：设置页读取三层超时（生效值 / 来源 / 可调区间 / 默认值）。
// 写入复用既有 local:prefs/set（key = stream_timeouts），主进程每次请求现读，改完立即生效。
ipcMain.handle('app:stream-timeouts', () => streamSettings.getStreamSettingsView());

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
    crashGuard.attachWindow(mainWindow); // C2：unresponsive / responsive 只存在于 BrowserWindow
    previewScheme.initPreviewScheme(); // T3-1：流式预览协议处理器（必须 ready 后注册）
    // P1-N：更新检查延迟 10s 自动触发（initUpdater 仍保留供手动检查即时初始化）
    updater.scheduleAutoUpdateCheck();
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

// T2-5：崩溃/异常聚合收口升级（原 M3-5 crash.log 纯文本 → 结构化 JSONL）：
// 主进程未捕获异常统一进 main/diagnostics.js——userData/diagnostics/crash-YYYYMMDD.jsonl，
// 每条含 ts/kind/stack + 活跃 runId + 该 run 的 trace 尾部（T0-5），只落本机不上传。
process.on('uncaughtException', (err) => {
  reportError('uncaughtException', err);
});

// P0-C 修复：补unhandledRejection 兜底。
// 事故背景：此前只挂了 uncaughtException，而 Promise 拒绝**不会**触发它——
// Node/Electron 默认在unhandledRejection 后终止进程。于是任何一处漏接的
// `.catch()`（典型是异步 IIFE、定时器回调、事件监听里的 async 函数）都会让
// 整个桌面应用直接退出，用户正在跑的全部 Agent 任务与对话一起丢失，且无任何提示。
// Node 15+ 可用 process.on('unhandledRejection') 覆盖该行为。
process.on('unhandledRejection', (reason) => {
  reportError('unhandledRejection', reason);
  console.error('[main]未捕获的 Promise 拒绝（已兜底，未退出进程）:', String(reason?.message || reason || ''));
});
}

// ── 自动更新（electron-updater，仅打包态生效；延迟 require 避免非 electron 环境崩溃）──
// T2-1：自动更新域已拆出 main/updater/index.js（只搬移不改行为）。
// IPC 注册与状态推送目标（主窗口）经 getMainWindow getter 注入；延迟检查由 whenReady 接线。
const updater = require('./updater');
updater.init({ getMainWindow: () => mainWindow });

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
// P0-1：退出前强制落盘合并窗口内未写盘的内存变更（消息/状态）
// P1-1：同时清理 MCP 子进程，避免孤儿进程占用端口导致下次启动握手失败
app.on('will-quit', () => {
  try { localStore?.flushSync(); } catch (e) { console.warn('[local] 退出刷盘失败:', e.message); }
  try { taskStore?.db?.flush?.(); } catch (e) { console.warn('[tasks] 退出刷盘失败:', e.message); }
  try { scheduler?.persist?.(); } catch (e) { console.warn('[scheduled] 退出刷盘失败:', e.message); }
  try {
    const flushResults = require('./data/intentLogRegistry').flushAllIntentLogs();
    if (flushResults.some((result) => !result.ok || !result.durable)) {
      console.error('[intentLog] 退出前仍有意图日志未确认 durable:', JSON.stringify(flushResults));
    }
  } catch (e) { console.warn('[intentLog] 退出刷盘失败:', e.message); }
  try { memoryScheduler?.stop(); } catch { /* 调度器已停 */ }
  try { approvalChannel.disposeAll(); } catch (e) { console.warn('[approval] 退出清理异常:', e.message); }
  try { cuaApprovalChannel.disposeAll(); } catch (e) { console.warn('[cuaApproval] 退出清理异常:', e.message); }
  try { killAllMcpServers(); } catch (e) { console.warn('[MCP] 退出清理异常:', e.message); }
  // T4-1：退出前杀掉全部浏览器子进程（Playwright 驱动+浏览器不留孤儿）
  try { require('./browserTools').disposeAll(); } catch (e) { console.warn('[browser] 退出清理异常:', e.message); }
  // T4-2：关闭 Chrome 接管中继（断开扩展连接，端口不残留）
  try { require('./chromeRelay/server').close(); } catch (e) { console.warn('[chromeRelay] 退出清理异常:', e.message); }
});
// SIGTERM/SIGINT/SIGHUP 优雅退出：pkill/终端关闭/Ctrl+C 也会走 will-quit 落盘（事故教训：强杀导致任务静默中断且丢状态）
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
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
// T2-1：工具执行层已拆出 main/tools/exec.js（只搬移不改行为）——
// shell/读写/预览/list_dir·grep·glob/git 全部工具实现与 IPC 注册。
// 审批中心（requestApproval/applyApprovalDecision/alwaysRules/conversationRules）归属本文件，经注入同源。
const toolExec = require('./tools/exec');
toolExec.initToolExec({
  requestApproval, applyApprovalDecision, getAlwaysRules: () => alwaysRules, conversationRules,
  // N2 cwd 信任契约：漏传 cwd 的工具调用落到「最近打开的项目目录」（无项目则 HOME），
  // 绝不回主进程 cwd（打包版=应用安装目录，既无意义又危险）；结果以 cwdFallback 标记、审计留痕。
  getDefaultCwd: () => {
    try {
      const projects = localStore?.listProjects?.() || [];
      const recent = projects.find((p) => p.path && fs.existsSync(p.path));
      return recent?.path || app.getPath('home');
    } catch { return app.getPath('home'); }
  },
  // P0-1：shell/seatbelt/bwrap/git 子进程注册到 runId（缺失即抛错由 exec.js 保证接线存在）
  registerChild: (child) => childRegistry.register(runScope.getStore()?.runId, child),
});
const { toolShell, toolReadFile, runWriteTool, toolListDir, toolGrep, toolGlob, toolGitStatus, toolGitDiff, toolGitLog, toolGitBranch, toolGitCommit, toolGitAdd, shellEnv, runGit } = toolExec;

// T4-1：Browser Use——Playwright 下沉独立子进程（T3-6 驻留模式），主进程只做编排/审批/审计。
// 六工具（navigate/click/fill/select/screenshot/extract）经 browserTools 挂进会话 toolHandlers；
// click/fill/select 恒逐次审批，navigate/screenshot/extract 走 L3 可规则豁免。
const browserTools = require('./browserTools');
browserTools.initBrowserTools({
  requestApproval, applyApprovalDecision,
  getAlwaysRules: () => alwaysRules, conversationRules,
  userDataDir: app.getPath('userData'),
});

// T4-2：Chrome 接管——本地 WebSocket 中继 + 扩展（CDP）操作用户真实浏览器。
// 中继只监听 127.0.0.1；每次连接逐次弹审批卡（fail-closed：拒绝/超时即断开，授权不沉淀）。
// 端口占用等启动失败仅降级（chrome_* 工具报未连接），不影响主程序。
const chromeRelay = require('./chromeRelay/server');
chromeRelay.initChromeRelay({
  requestApproval,
  port: Number(process.env.MJ_CHROME_RELAY_PORT) || undefined,
});
chromeRelay.start();
const chromeTools = require('./chromeTools');
chromeTools.initChromeTools({
  requestApproval, applyApprovalDecision,
  getAlwaysRules: () => alwaysRules, conversationRules,
  userDataDir: app.getPath('userData'),
  relay: chromeRelay,
});

// T4-7：Code Mode——JavaScript 代码执行下沉独立子进程（持久 vm 上下文 = cell 状态载体）。
// 每对话一个代码进程（30 分钟闲置回收）；子进程死亡即状态丢失、不透明重启（见 codeProcess/host.js）。
// 普通代码 L3 可规则豁免；危险代码（child_process/rm -rf）由 approval 判 L1 恒逐次确认。
const codeTools = require('./codeTools');
codeTools.initCodeTools({
  requestApproval, applyApprovalDecision,
  getAlwaysRules: () => alwaysRules, conversationRules,
  userDataDir: app.getPath('userData'),
});


// T2-1：技能与插件市场域已拆出 main/ipc/plugins.js（只搬移不改行为）——
// SKILL.md 技能体系 / 插件市场（git 安装+权限双闸+签名 fail-closed）/ 网络插件发现与对话内安装。
// connectMcpServer 归属 MCP 域，经 getter 注入；SKILLS_DIR 导出供生态域接线复用。
const pluginsIpc = require('./ipc/plugins');
pluginsIpc.initPluginsIpc({ requestApproval, applyApprovalDecision, getAlwaysRules: () => alwaysRules, conversationRules, audit, getConnectMcpServer: () => connectMcpServer });
const { SKILLS_DIR, searchPluginsTool, installNetworkPlugin } = pluginsIpc;

// T2-1：项目与工作区域已拆出 main/ipc/project.js（只搬移不改行为）——
// 对话框 / 本地工作区 / 项目探测 / worktree / 磁盘快照 / 粘贴文件落盘。
const { initProjectIpc } = require('./ipc/project');
initProjectIpc({ getMainWindow: () => mainWindow, runGit });

// ── MCP 客户端（多传输：stdio + Streamable HTTP）──
// T2-1：MCP 与杂项 IPC 域已拆出 main/ipc/mcp.js（只搬移不改行为）——
// MCP 配置持久化/连接/状态 + 沙箱状态查询 + GitHub 闭环 IPC + 语音转写。
// emitTaskEvent 归属任务编排域（本文件，函数声明提升可用），经注入转发 MCP 状态事件。
const mcpIpc = require('./ipc/mcp');
mcpIpc.initMcpIpc({ requestApproval, applyApprovalDecision, getAlwaysRules: () => alwaysRules, conversationRules, audit, emitTaskEvent, getCredentialCrypto: () => credentialCrypto });
const { connectMcpServer, callMcpTool, killAllMcpServers, reconnectMcpServers, mcpServers } = mcpIpc;
// GitHub PR 审查闭环工具仍在本文件组装（gh CLI 封装见 main/github.js）
const github = require('./github');


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
  // T1：三层流式守卫（首字节 90s / 空闲 300s / 单轮总时长 15min）。
  // 语义是「多久没有动静」而不是「总共花了多久」——只要还有数据在动就一直等，
  // 真正的挂起才断。直连路径（无 externalSignal，用户手动对话）不设总时长上限：
  // 那边可能本来就是正当的长回答，硬切会把文章砍半。
  const streamTimeouts = resolveStreamTimeouts();
  const streamGuard = createStreamGuard({
    firstByteMs: streamTimeouts.firstByteMs,
    idleMs: streamTimeouts.idleMs,
    totalMs: externalSignal ? streamTimeouts.totalMs : 0,
    onFire: () => controller.abort(),
  });
  streamGuard.start();
  try {
    const res = await fetch(`${root}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${secret.api_key}` },
      body: JSON.stringify(body),
      // 超时必须「真中断」（上层 withTimeout 只放弃等待，连接挂着则 finally 的 slot.release 不执行 → fg 槽位泄漏）。
      // 超时判定已交给 streamGuard（空闲语义），这里只负责把 abort 级联到 fetch。
      signal: externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal,
    });
    streamGuard.firstByte(); // 收到响应头：首字节达成，转入空闲计时

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
      // 任何字节到达都算「有动静」：正文 delta、reasoning_content、tool_calls 分片，
      // 以及供应商的 SSE 注释心跳行（`: keep-alive`）——全部在这一层计入。
      // 逐个字段判断容易漏（漏掉 reasoning 就会在 mimo 思考阶段被误判成挂起）。
      streamGuard.touch();
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
    // 守卫触发的中断先判：必须给出「首字节没来 / 连续没动静 / 超过总上限」的可读原因，
    // 而不是一个裸 AbortError（用户会误以为是模型回答出错）。
    const fired = streamGuard.reason();
    if (fired) {
      quota.reportError(providerId || 'default');
      throw new Error(streamTimeoutMessage(fired, streamGuard.config()));
    }
    // 只有「用户主动中止」才算 aborted；守卫触发的中断走上面的错误路径
    if (err.name === 'AbortError' && externalSignal?.aborted) {
      return { aborted: true, content: fullContent, usage };
    }
    quota.reportError(providerId || 'default');
    throw err;
  } finally {
    streamGuard.stop();
    if (onExternalAbort && externalSignal?.removeEventListener) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
    activeChats.delete(controller);
    slot.release();
  }
}

// 直连聊天通道：透传 payload.streamTag 作为第 4 个位置参数（chatStreamOnce 的 streamTag），
// 带标签时 delta/reasoning 事件发 {tag,text}，渲染层据此把流式输出归到正确的会话；
// 不带标签（主会话/压缩历史等旧调用方）维持原纯文本协议，行为不变。
ipcMain.handle('model:chat', (event, payload) => chatStreamOnce(payload || {}, event.sender, undefined, payload?.streamTag));

// 中止全部进行中的 chat（停止生成）
// P0-4：同时中止主进程 Agent 运行器中挂起的交互式运行（run controller 级联中止在途 fetch）
ipcMain.handle('model:abort', async () => {
  const n = activeChats.size;
  for (const c of activeChats) c.abort();
  activeChats.clear();
  const abortedRuns = agentRunner.abortAllRuns();
  return { ok: true, aborted: n, abortedRuns };
});

// 定时任务 / 子代理的非流式通道已抽到 main/scheduledChannels.js（2026-10-17）：
// main.js 顶到 1500 行硬门禁，且它们与主交互链路（chatStreamOnce）是并列关系。
// 非流式没有 idle 可言，那边只启用「首字节 + 单轮总时长」两层。
const { scheduledChatOnce, scheduledAgentChat } = createScheduledChannels({ resolveSecret, quota });


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
      const approvalWait = requestApproval(toolKey, args);
      const decision = await approvalWait;
      if (decision === 'deny') {
        // P1-4：拒绝理由回传——拼进工具结果（模型可见）与审计行（用户可复盘）
        const reason = approvalReasonOf(approvalWait);
        audit(toolKey, `PR #${args.number || '?'}`, reason ? `用户拒绝。理由：${reason}` : '用户拒绝', 'denied');
        return { ok: false, error: denialText(reason), denied: true };
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
// 定时任务 / Worker 共用的工具集：清单已在 main/scheduledTools.js（按能力边界拆，与行数无关）
const { scheduledToolHandlers: buildScheduledToolHandlers, scheduledCreate: scheduledCreateTool } = require('./scheduledTools');
const scheduledToolHandlers = () => buildScheduledToolHandlers({
  scheduledAgentChat, webTools,
  toolShell, toolReadFile, runWriteTool, toolListDir, toolGrep, toolGlob,
  toolGitStatus, toolGitDiff, toolGitLog, toolGitBranch, toolGitCommit, toolGitAdd,
  callMcpTool, prTools,
});

// P0-4：主进程 Agent 运行器——交互式会话工具循环迁移至主进程。
// 渲染层只负责发起（agent:run）、订阅事件（agent:event）、中止（agent:abort）；
// 循环本体与全部工具副作用都在主进程，刷新/关闭窗口不再杀死进行中任务。
const agentRunner = require('./agentRunner');
// T3-7：引擎子进程驻留——runAgent 迁入独立 utilityProcess 子进程（每 run 一个，用后即杀），
// 工具实现/审批/凭证/流式推送全部留在主进程，由子进程经 RPC 回调（依赖方向反转）。
// 崩溃半径从「整个应用」收缩到「单个任务」；utilityProcess 不可用（单测 stub 环境）时
// isAvailable()=false，agentRunner 自动回退主进程 in-process 路径（生产降级链）。
const engineHost = require('./engineProcess/host');
engineHost.initEngineHost({});
const { waitGroupSettled, humanizeGroupResult, diffGroupEvents } = require('./orchestrator/invoke');

// orchestrate_task 工具实现：对话内自动多 Agent 编排（模型自主决策触发）。
// 同步等待整组收尾，返回人话聚合结果；用户「停止」时立即返回未完成说明。
// 注意：仅在主会话 handlers 注入——Worker 内不可再编排（防递归失控）。
// T1-3：emitSubagent 注入——把编排组内每个子任务的状态流转 diff 上报为 subagent 事件
//（spawn/progress/done/failed + tokens + 结论摘要），供渲染层子任务树可视化。
async function toolOrchestrateTask(args, { signal, emitSubagent, conversationId } = {}) {
  const goal = String(args?.goal || '').trim();
  if (!goal) return { ok: false, error: 'goal 不能为空' };
  if (!taskStore) return { ok: false, error: dbStatus.toolFailure() };
  const cwd = String(args?.cwd || '');
  // P0 治理修复（2026-10-16）：原实现 `workerPool.setMaxConcurrent(args.max_agents)`
  // 存在三个问题：
  //   ① 治理方向反了——这是**模型**经工具调用在改并发上限，模型可自行调大（1→8）；
  //   ② 改的是模块级全局变量 ⇒ 污染同进程内所有其他会话与组；
  //   ③ 不写回偏好 ⇒ 重启即丢，行为不可预测。
  // 现移除该副作用：并发宽度应由用户设置（tasks:config，唯一会持久化的入口）决定，
  // 模型侧的动态宽度由 Wave D 的决策器按「复杂度 × 模型能力 × 预算」计算后下发。
  // 在决策器落地前，max_agents 仅作提示性信息被忽略并记录——不让模型越权。
  const requestedAgents = Number(args?.max_agents);
  if (Number.isFinite(requestedAgents) && requestedAgents >= 1) {
    console.warn(`[orchestrate] 忽略模型请求的 max_agents=${requestedAgents}`
      + `（并发上限由用户设置决定，不接受模型侧改写；动态宽度待决策器落地）`);
  }
  // R6：对话内编排的组绑定发起会话（threadId=conversationId，渲染层按会话归属显示）
  // P1-1：组快照必须记「发起本次编排的 run 的档」。此前取全局「最后一次 run」的档——
  // 会话级档可不同（thread.approval_mode 覆盖），会记成别的会话的档。run 已结束则回落用户设置。
  const orchestratorRunId = runScope.getStore()?.runId || null;
  const orchestratorApproval = agentRunner.getApprovalModeFor(orchestratorRunId)
    || approvalSettings.getUserApprovalMode();
  const plan = await orchestrator.autoOrchestrate({ goal, cwd, threadId: conversationId || null, ...hostPolicySnapshot(cwd, orchestratorApproval) });
  if (!plan.ok) return { ok: false, error: `编排启动失败：${plan.error}` };
  // T1-3：spawn 上报（编排落地即逐任务发出，先于任何轮询）
  const reportSubagent = (evt) => {
    try { emitSubagent?.({ tool: 'orchestrate_task', groupId: plan.groupId, ...evt }); }
    catch (e) { console.warn('[orchestrate] 子任务事件上报失败:', e.message); }
  };
  for (const t of plan.tasks || []) {
    // T1-4：spawn 事件透出 DAG 依赖边，渲染层子任务树据此建图（无需二次查询编排器）
    reportSubagent({ phase: 'spawn', taskId: t.id, title: t.title, dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [] });
  }
  // T1-3：轮询 diff——每次快照与上次比较，状态变化即上报（映射逻辑在 diffGroupEvents，可单测）
  const seen = new Map(); // taskId -> { status, retryCount }
  const waited = await waitGroupSettled(taskStore, plan.groupId, {
    signal,
    onPoll: (g) => {
      for (const evt of diffGroupEvents(seen, g)) reportSubagent(evt);
    },
  });
  if (waited.aborted) {
    // 用户已停止：整组强停（在役中止 + 排队置 skipped + 组 cancelled）。只 abort 在役任务时组仍是 running，pump() 会继续派发队列 → 用户点了停止仍在烧 token
    workerPool.abortGroup(plan.groupId);
    return { ok: false, aborted: true, groupId: plan.groupId,
      error: `用户已停止：编排组 ${plan.groupId} 的在役 Agent 已中止（已完成的部分结果已保留）` };
  }
  if (waited.timedOut || waited.missing) {
    // P0-4：超时/状态异常与用户停止同语义——必须整组强停，否则 pump() 继续派发队列，后台继续烧 token
    const killed = workerPool.abortGroup(plan.groupId);
    return { ok: false, groupId: plan.groupId, timedOut: !!waited.timedOut, abortedTasks: killed,
      error: `编排组 ${plan.groupId} 等待超时/状态异常，已中止在役任务（已完成部分保留），可稍后在对话中查询进度` };
  }
  return { ok: true, groupId: plan.groupId, taskCount: plan.tasks.length, summary: humanizeGroupResult(waited.group) };
}

// P1-1：把 localStore getter 注入进去（localStore 在 whenReady 后才非 null，故传闭包）
// P2-7：执行后告知的出口必须在此接（emit 是 main.js 作用域函数；挂 ipc/mcp.js 会被本行后续调用清成 null）
approvalSettings.initApprovalSettings({ getLocalStore: () => localStore, emit: emitTaskEvent });

agentRunner.initAgentRunner({
  loadAgentCore,
  // T3-7：引擎子进程宿主（isAvailable 时 runAgent 走独立进程，否则回退 loadAgentCore in-process）
  engineHost,
  // T4-3 技能接线：数字员工 starter_skills 按名装载本地 SKILL.md 内容（~/.mjcode/skills）
  loadSkillContents: (names) => require('./skills').loadSkillContents(pluginsIpc.SKILLS_DIR(), names),
  // N5 rootExecution 统一取消：runScope（handler 包装用）/ 撤审批 / 终止子进程 / 子进程注册
  runScope,
  cancelApprovalsForRun: (runId) => approvalChannel.cancelByRun(runId),
  // P0-1：registerChild/killChildrenForRun 收敛到 childRegistry（与 initToolExec 同源）
  registerChild: (child) => childRegistry.register(runScope.getStore()?.runId, child),
  killChildrenForRun: (runId) => childRegistry.kill(runId),
  // 2026-10-15：会话消息持久化通道（agentRunner 收归主进程落库用）——
  // conversationId 即 threadKey（thread.id），camelCase 形状与 localStore.addMessage 对齐
  persistMessage: ({ conversationId, message }) => {
    if (!localStore) throw new Error('本地数据层未初始化');
    return localStore.addMessage({ threadId: conversationId, ...message });
  },
  // V08：持久 ACK——最终总结落库后强制刷盘，只有 durable 成功才允许 mainPersisted:true
  flushPersistence: () => {
    if (!localStore) return { ok: false, error: '本地数据层未初始化' };
    return localStore.flushSync();
  },
  // 每次运行独立工具处理器：chat 用流式实现（externalSignal=运行 controller，级联中止在途 fetch），
  // 其余工具与定时任务通道同源（toolShell/runWriteTool/toolGrep/... 主进程实现直调）
  // V01：createToolHandlers 接收本 run 的宿主治理值（agentRunner 已按角色钳制），
  // 工具处理器内一律使用宿主值，不读模型参数里的治理字段。
  createToolHandlers: ({ sender, signal, runId, emitSubagent, approvalMode: runApprovalMode, conversationId }) => ({
    ...scheduledToolHandlers(),
    // runId 作为 streamTag：Agent 运行的流式输出带标签，渲染层按活跃会话过滤（切会话/后台运行不串显）
    chat: (chatPayload) => chatStreamOnce(chatPayload, sender, signal, runId),
    orchestrateTask: (args) => toolOrchestrateTask(args, { signal, emitSubagent, conversationId: conversationId || '' }),
    // 对话内网络插件搜索/安装（LobeChat 式）：搜索只读；安装恒走 L3 审批卡
    searchPlugins: (args) => searchPluginsTool(args),
    installPlugin: (args) => installNetworkPlugin(args, {
      // V01/V04：审批档由宿主绑定（run 的有效档），模型传参里的 approvalMode 不可信
      approvalMode: runApprovalMode || 'on-request',
      conversationId: args.conversationId || '',
    }),
    // P0-A：Web 检索/抓取。内网地址已由 webTools 自行拦截（SSRF 防护）。
    // todoWrite 由 agent-core 内置处理（纯状态，不出网、不触盘），故不在此注册。
    webSearch: (args) => webTools.webSearch(args),
    webFetch: (args) => webTools.webFetch(args),
    // 2026-10-17：模型侧创建定时任务（此前零入口，用户只能手动去界面建）。恒走 L3 审批，
    // 且审批只对本次有效（不落规则库）——见 main/scheduledTools.js 的说明。
    scheduledCreate: (args) => scheduledCreateTool(args, {
      approvalMode: runApprovalMode || 'on-request',
      conversationId: conversationId || '',
      requestApproval,
      createTask: scheduler.createTask,
      cronValid: scheduler.cronValid,
    }),
    // GitHub PR 审查闭环（读直连；review/comment 走 L3 审批）
    prList: prTools.prList,
    prView: prTools.prView,
    prDiff: prTools.prDiff,
    prReview: prTools.prReview,
    prComment: prTools.prComment,
    // T4-1：Browser Use 六工具（子进程执行 + L3 审批；仅主会话注入——
    // Worker/定时任务无审批通道语义，浏览器操作必须有人在场确认）
    browserNavigate: browserTools.toolBrowserNavigate,
    browserClick: browserTools.toolBrowserClick,
    browserFill: browserTools.toolBrowserFill,
    browserSelect: browserTools.toolBrowserSelect,
    browserScreenshot: browserTools.toolBrowserScreenshot,
    browserExtract: browserTools.toolBrowserExtract,
    // T4-2：Chrome 接管七工具（经中继转发扩展；仅主会话注入——与 browser_* 同纪律，
    // Worker/定时任务无审批通道语义，不允许触碰用户真实浏览器）
    chromeStatus: chromeTools.toolChromeStatus,
    chromeTabs: chromeTools.toolChromeTabs,
    chromeNavigate: chromeTools.toolChromeNavigate,
    chromeClick: chromeTools.toolChromeClick,
    chromeFill: chromeTools.toolChromeFill,
    chromeScreenshot: chromeTools.toolChromeScreenshot,
    chromeExtract: chromeTools.toolChromeExtract,
    // T4-7：Code Mode（子进程持久会话 + L3/L1 审批；仅主会话注入——
    // Worker/定时任务无审批通道语义，不允许执行任意代码）
    codeExec: codeTools.toolCodeExec,
  }),
});
ipcMain.handle('agent:run', (event, payload) => agentRunner.startAgentRunWhenReady(payload || {}, event.sender));
ipcMain.handle('agent:abort', (_, { runId } = {}) => ({ ok: agentRunner.abortRun(runId) }));

// 定时任务 Agent 入口：scheduler.runTask 到点调用
// 审批策略 auto-safe：L2 写操作自动放行（本地审计已留痕），L1 危险命令/L3 MCP 仍弹审批卡
// （2 分钟无响应按拒绝，与交互式一致）；沙箱有项目目录 workspace-write、无目录 read-only（P0-B 一致）
async function runScheduledAgentTask({ prompt, model: schedModel, signal, taskId = '' }) {
  if (!schedModel || !schedModel.model) {
    throw new Error('未配置执行模型：请在任意会话中选择模型（定时任务复用会话模型与凭证）');
  }
  // 扁平形 → 嵌套形：改用共享转换（此前是此处手抄，Worker 路径漏抄导致崩溃）
  const runModel = toAgentModel(schedModel);
  const cwd = schedModel.cwd || '';
  // V 层：L1 对账全量跑（零成本）+ L3 按风险门/抽样触发，且**无人值守 fail-closed**
  //（判不出来就不许宣告成功）。策略与成本口径见 main/scheduledVerify.js 的注释。
  const sv = createScheduledVerify({ taskId, cwd, ...scheduledL3Target() });
  // 对外动作闸门：默认拦（无人值守没有人能批准），任务显式 allow 才放行
  const sguard = createScheduledGuard({ enabled: schedModel.externalPolicy !== 'allow' });
  let toolCount = 0;
  let totalUsage = { prompt_tokens: 0, completion_tokens: 0 };
  const agentCore = await loadAgentCore();
  const finalText = await agentCore.runAgent({
    messages: [{ role: 'user', content: String(prompt || '') }],
    model: runModel,
    cwd,
    signal,
    // P0-8c/P1-1：审批档与用户设置对齐——原为硬编码 'auto-safe'，用户选「全部询问」时被静默
    // 忽略（产品对用户设置撒谎）。与 workerPool.js:206 同源：取「用户当前档（或调用方显式传入）
    // 与 auto-safe 地板」中更严者。2026-10-17（P1-1）：用户档来源改为 approvalSettings.getUserApprovalMode()
    // （读持久化设置，而不是「最后一次交互 run 的档」）；stricterApproval 仍由 approvalPolicy.js 提供。
    approvalMode: agentRunner.stricterApproval(schedModel.approvalMode || approvalSettings.getUserApprovalMode(), 'auto-safe'),
    sandboxPolicy: cwd ? 'workspace-write' : 'read-only',
    conversationId: 'scheduled',
    maxRounds: 20,
    // P0-8c：无人值守成本闸——定时执行强制注入 tokenBudget，与 workerPool.js:211 的 200k 口径对齐
    tokenBudget: 200000,
    chatRetryBaseMs: 2000, // 无人值守：退避基数放宽，弱网下更耐心
    systemPrompt: '你是定时任务执行器：使用工具完成任务提示词中的要求，产出精炼可读的结果摘要。'
      + '不要反问、不要输出无关寒暄；工具失败时换方式重试或如实说明，不要假装完成。',
    toolHandlers: sguard.wrap(scheduledToolHandlers()),
    // V 层旁路：台账（父 run 才有）+ 最近一次测试输出（J3 输入）
    onTrace: (evt) => sv.onTrace(evt),
    onToolCall: (tc) => { toolCount += 1; sv.onToolCall(tc); },
    onDone: (_text, usage) => { if (usage) totalUsage = usage; },
  });
  // 收尾判定：产物照常返回，但 delivery.downgrade=true 时调用方不得标成功
  const vres = await sv.finish(finalText || '');
  return {
    output: finalText || '', toolCalls: toolCount, usage: totalUsage,
    verify: vres.verify, delivery: vres.delivery, pendingActions: sguard.take(),
  };
}

// ═══════════════════════════════════════════
//  P1：任务编排子系统（Orchestrator + WorkerPool + 持久化队列 + Aggregator）
//  目标 → LLM 拆解 DAG → 并行分层执行（wait_all）→ 聚合收尾；SQLite 断点续跑。
//  与定时任务通道同源：loadAgentCore / scheduledAgentChat / scheduledToolHandlers 复用。
// ═══════════════════════════════════════════
const { openDbAsync } = require('./db');
const dbStatus = require('./dbStatus');
const { TaskStore } = require('./taskStore');
const { MemoryManager } = require('./memory');
const { MemoryBgScheduler } = require('./memory/bgScheduler');
const workerPool = require('./workerPool');
const orchestrator = require('./orchestrator');

let taskStore = null;
let taskDb = null;
let memoryManager = null;   // P2-1：记忆唯一写入入口（SQLite，五域四层）
let memoryScheduler = null; // P2-5：记忆后台任务调度器
// X4：库状态交由 main/dbStatus.js 持有（失败原因 → 状态条 + 工具错误）
dbStatus.register(ipcMain, () => !!taskStore);

// V04：编排建组的「宿主治理快照」（审批档取用户当前设置、沙箱按 cwd 有无推导、不接受模型参数）
// 单一事实来源在 main/approvalPolicy.js（纯函数，零依赖）——模型侧 orchestrate_task 工具与
// tasks:* IPC（main/ipc/tasks.js）各自 import，避免两份实现漂移。
const { hostPolicySnapshot } = require('./approvalPolicy');

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
  // P0-3①：思考强度必须随模型下发（定时任务/编排此前恒发默认档）
  return { providerId: m.providerId, isGlobal: !!m.isGlobal, baseUrl: m.baseUrl || '', model: m.model, reasoningEffort: m.reasoningEffort || m.reasoning_effort || '' };
}

function initTaskOrchestration() {
  // 异步初始化：驱动选择可能包含子进程金丝雀探测（最长 ~10s），不阻断启动
  openDbAsync(app.getPath('userData'), { isPackaged: app.isPackaged })
    .then((db) => { if (setupTaskOrchestration(db) === true) dbStatus.markReady(); })
    .catch((err) => {
      // 初始化失败不阻断启动，但必须让用户看得见（X4）
      console.error('[tasks] 初始化失败（任务编排不可用）:', err.message);
      taskStore = null;
      dbStatus.markUnavailable(err && err.message);
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
      acquireSlot: (kind, providerId) => quota.acquire(kind, providerId), // P3-3：后台压缩走 bg 槽位（不吃前台预留）
      getDailyQuota: () => Number(localStore?.getPreference('memory.bgDailyQuota')) || null, // P3-3：每日报费上限可配置
      emit: emitTaskEvent,
    });
    memoryScheduler.start({ intervalMs: 60 * 1000 });

    workerPool.initWorkerPool({
      loadAgentCore,
      store: taskStore,
      maxConcurrent: Number(localStore?.getPreference('tasks.max_concurrent')) || 4,
      // 2026-10-16：子任务继承用户当前审批档（此前硬编码 auto-safe，用户设 always 时被静默忽略）
      getApprovalMode: () => approvalSettings.getUserApprovalMode(),
      // P1-11c：Worker 分档模型。渲染层设置页写入 → localSetPreference 同步到 preferences。
      // 主进程读不到 localStorage，没有这行注入时 workerPool 的 `deps.getModelOverrides`
      // 恒为 undefined → 分档永远回落主模型（此前正是这个状态）。
      getModelOverrides: () => localStore?.getPreference('model_overrides') || null,
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
      // P0-2c：转异步——记忆块经 shared/untrustedContent 结构性隔离后再注入
      // （Worker prompt 是模型上下文的一部分，历史沉淀可能已被污染，与 agent-core 注入口同处置）
      buildTaskPrompt: async (group, task) => {
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
              const { wrapUntrusted } = await import('../shared/untrustedContent.mjs');
              const raw = hits.map((m) => `- ${m.content.slice(0, 200)}`).join('\n');
              memoryBlock = wrapUntrusted(raw, { source: 'memory', label: '相关记忆（历史沉淀，供参考）' }).text;
            }
          }
        } catch (e) { console.warn('[worker] 记忆召回/隔离失败，本任务不带记忆块:', e.message); }
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

    // 崩溃恢复（V14，2026-10-16）：中断的 running 任务 → failed + needsReview（不自动重放——
    // 已执行的副作用无法确认，重放 = 同一操作执行两次且用户不知情）；运行中的组 → paused，
    // 等待用户人工核对后手动续跑。渲染层经 task_update 事件刷新。
    const rec = taskStore.recoverInterrupted();
    if (rec.recoveredTasks.length > 0 || rec.pausedGroups.length > 0) {
      console.log(`[tasks] 崩溃恢复：${rec.recoveredTasks.length} 个中断任务待人工审查，${rec.pausedGroups.length} 个组已暂停（不自动重放副作用）`);
      // N5 副作用账本：各组 uncertain 清单随日志与事件透出（人工核对的输入）
      for (const gid of rec.pausedGroups) {
        const uncertain = taskStore.listUncertainEffects(gid);
        if (uncertain.length > 0) console.log(`[tasks] 组 ${gid} 副作用待核对：${uncertain.join(', ')}`);
      }
      for (const t of rec.recoveredTasks) {
        emitTaskEvent({ type: 'task_update', groupId: t.groupId, taskId: t.taskId, status: 'failed', needsReview: true, error: '应用重启导致执行中断' });
      }
    }
    console.log('[tasks] 任务编排子系统就绪（SQLite 持久化队列 + Worker 池）');
    return true;
  } catch (err) {
    console.error('[tasks] 初始化失败（任务编排不可用）:', err.message);
    taskStore = null;
    dbStatus.markUnavailable(err && err.message);
    return false;
  }
}

// ── 任务编排 IPC（X14：整体搬出 main/ipc/tasks.js）──
// 拆分理由：tasks 域有独立边界（11 条通道 + 载荷契约入口），且本批要在其中加校验。
// **不要**把这理解成「本文件快撞 1500 行门禁了」——`max-lines` 的 max 是**去掉空行与注释**
// 之后的 code 行数（eslint.config.mjs 里 skipBlankLines/skipComments 都为 true）：
// 拆前 raw 1496 但 eslint 实计只有 1093，离 1500 还有 407 行余量。`wc -l` 与这个门禁
// 不是同一把尺子，两者差 400 行上下（2026-10-17 实测）。
// 行为不变；tasks:autoRun / tasks:plan 在模块内加了载荷边界校验，tasks:execute 复用
// taskGroupRefSchema（与 tasks:cancel 同构）。编排状态与初始化仍在本文件，经 getter 注入。
const { initTasksIpc } = require('./ipc/tasks');
initTasksIpc({
  getTaskStore: () => taskStore,
  getLocalStore: () => localStore,
  // V04 治理快照的审批档来源：与模型侧 orchestrate_task 同源（都是用户当前设置）
  getApprovalMode: () => approvalSettings.getUserApprovalMode(),
  emitTaskEvent,
  orchestrator,
  workerPool,
});

// ═══════════════════════════════════════════
//  COMPUTER USE (M4-C)：macOS AX 结构化界面自动化
//  事件契约与实现细节见 computerUse.js 头部注释
// ═══════════════════════════════════════════
const cua = require('./computerUse');
// T3-6：高风险原生执行下沉独立子进程——osascript 键鼠执行/AX 采集不再跑在主进程里，
// 崩溃或挂起只影响单步：宿主透明重启重试，超限抛能力降级错误经 cua:event 提示（主会话不崩）。
// utilityProcess 不可用（单测 stub 环境）时 isAvailable()=false，回退主进程直调（T3-7 同纪律）。
const cuaProcess = require('./cuaProcess/host');
cuaProcess.initCuaProcess({});
// T4-6：操作录制与回放——LLM 跑通的任务录成确定性 AX 脚本，回放不调模型
const cuaRecorder = require('./cuaRecorder');
const cuaRecordingsDir = () => path.join(app.getPath('userData'), 'recordings');
let activeCuaLoop = null; // 当前进行中的 CUA 循环（供 cua:stop 中断）
let activeReplayLoop = null; // 当前进行中的回放循环（与录制互斥，共用 stop）

// CUA 逐次确认弹窗：独立通道，避免与并行工具审批（tool:approval-response）互相串扰
// 决策不进入 applyApprovalDecision 规则库 —— 敏感动作必须逐次确认，不可会话/永久放行
//
// P0 修复（2026-10-16）：原实现是 `ipcMain.once('cua:approval-response')`——
// 即 main.js:54 注释所述 P0-2 缺陷在 CUA 通道的重演（tool: 通道早已用
// ApprovalChannel 按 approvalId 精确分发修掉，此处漏改）。后果：
//   ① 每次请求都注册一个新的一次性监听器，并发两个 CUA 确认时，
//      先到的响应被「先注册的那个」消费 ⇒ 决策张冠李戴。CUA 要求逐次确认，
//      张冠李戴的后果比工具审批更严重（把「允许」发给另一条敏感动作）；
//   ② 超时分支只 resolve 不摘监听器 ⇒ 监听器残留，可能吃掉后续无关响应。
// 现与 tool: 通道同款：生成 approvalId → 按 id 精确分发；无 id 的旧响应走
// dispatchLegacy（仅在恰有一个挂起时按唯一挂起处理，多于一个则拒绝猜测、按超时 deny）。
const cuaApprovalChannel = new ApprovalChannel({ timeoutMs: 120000 });
ipcMain.on('cua:approval-response', (_, payload) => {
  const hasId = payload && typeof payload === 'object' && payload.approvalId;
  const dispatched = hasId
    ? cuaApprovalChannel.dispatch(payload.approvalId, payload.decision, payload.reason)
    : cuaApprovalChannel.dispatchLegacy(null, payload && payload.decision !== undefined ? payload.decision : payload); // P2-3：无 id 一律拒绝并告警
  if (!dispatched) {
    console.warn('[cua] 收到无法匹配的审批响应，已忽略（fail-closed，按 deny 收尾）');
  }
});

function requestCuaApproval(summary) {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve('deny');
  const approvalId = cuaApprovalChannel.nextId();
  // 无论以何种方式收尾（含超时）都通知渲染层撤下卡片——否则卡片常驻，
  // 用户再点时主进程已无挂起项，表现为「点了没反应」
  const settled = cuaApprovalChannel.wait(approvalId, () => {
    try { mainWindow?.webContents?.send('cua:approval-settled', { approvalId }); }
    catch { /* 窗口已销毁 */ }
  });
  mainWindow.webContents.send('cua:approval-request', { ...summary, approvalId });
  return settled;
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

ipcMain.handle('cua:run', async (_, { objective, appName, approvalMode = 'on-request', conversationId, model, providerId, isGlobal = false, baseUrl, allowedApps, maxSteps, record = false, recordingName = '' }) => {
  if (activeCuaLoop || activeReplayLoop) return { ok: false, error: '已有进行中的界面自动化任务，请先停止' };
  if (!objective || !appName) return { ok: false, error: 'objective 与 appName 必填' };
  if (process.platform !== 'darwin') return { ok: false, error: '界面自动化仅支持 macOS' };
  // X14：objective/appName 会进模型上下文并被审计落盘，allowedApps 是执行白名单——
  // 形状与长度先在边界守住（非字符串 allowedApps 会让 ComputerUseLoop 以为带了白名单）。
  // 注意 providerId 不在此列：本机 provider 是数字 id、服务端是 's...' 前缀串，两种形态都合法。
  try {
    guard.assertStrings({ objective, appName, model, baseUrl, conversationId, recordingName }, {
      objective: 20000,
      appName: 200,
      model: { max: 200, optional: true, allowEmpty: true },
      baseUrl: { max: 2000, optional: true, allowEmpty: true },
      conversationId: { max: 200, optional: true, allowEmpty: true },
      recordingName: { max: 200, optional: true, allowEmpty: true },
    });
    if (allowedApps !== undefined) guard.assertArray({ allowedApps }, 'allowedApps', { max: 50 });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  // T3-6：原生执行会话（每 run 一个子进程，惰性 spawn，finally dispose）
  const cuaSession = cuaProcess.isAvailable() ? cuaProcess.createSession() : null;
  const cuaExec = (name, ...args) => (cuaSession ? cuaSession.call(name, ...args) : cua[name](...args));
  const bail = async (result) => { try { cuaSession?.dispose(); } catch (e) { console.warn('[cua] 会话释放失败:', e.message); } return result; };
  if (!(await cuaExec('isAccessibilityGranted'))) {
    return bail({ ok: false, error: 'NEED_ACCESSIBILITY: 未授予辅助功能权限，请在 系统设置 > 隐私与安全性 > 辅助功能 中允许本应用' });
  }
  // 凭证解析：与 model:chat 同款（本地优先）
  const secret = resolveSecret(providerId, isGlobal);
  if (!secret || !secret.api_key) return bail({ ok: false, error: 'KEY_MISSING: 模型凭证未加载，请在本机模型设置中重新填写 API Key' });
  const root = (baseUrl || secret.base_url || '').replace(/\/+$/, '');
  if (!root) return bail({ ok: false, error: 'BASE_URL_MISSING: 模型服务地址为空' });

  const send = (evt) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('cua:event', evt);
  };
  // T4-6 录制模式：累积实际执行成功的 AX 步骤（每步截图），run 完成后整体落盘；
  // 视觉兜底步骤（node=null）不可确定性回放，不入录制。
  const rec = record ? {
    id: cuaRecorder.newRecordingId(),
    name: String(recordingName || objective).slice(0, 80),
    steps: [],
  } : null;
  let recChain = Promise.resolve(); // 截图串行链：保证步骤序号与落盘顺序一致
  let recCounter = 0; // 步骤序号独立计数（截图异步，不能依赖 steps.length——链未 flush 时会重复）
  const onEvent = (evt) => {
    if (rec && evt.type === 'step' && evt.mode !== 'vision' && evt.node && evt.result?.ok) {
      const index = ++recCounter;
      const step = cuaRecorder.sanitizeStep(evt, index);
      recChain = recChain.then(async () => {
        try {
          const shot = await cua.captureScreen();
          if (shot && shot.dataUrl) {
            step.screenshotFile = cuaRecorder.writeScreenshot(rec.id, index, shot.dataUrl, { dir: cuaRecordingsDir() });
          }
        } catch (e) { console.warn('[cua] 录制截图失败（不影响步骤）:', e.message); }
        rec.steps.push(step);
      });
    }
    send(evt);
  };
  const hud = cua.createHudWindow(BrowserWindow);
  const loop = new cua.ComputerUseLoop({
    objective,
    appName,
    maxSteps,
    model,
    // P1-2：审批档入参钳制——取「调用方传入 与 用户当前档」中更严者（地板语义），
    // 渲染层被注入脚本传弱档（never）不再生效；敏感动作逐次确认不受档位影响（设计不变）
    approvalMode: agentRunner.stricterApproval(approvalMode || 'on-request', approvalSettings.getUserApprovalMode()),
    allowedApps: allowedApps || [appName],
    toolHandlers: {
      // chat 留主进程（凭证不出界）；原生执行面全部经子进程会话（T3-6）
      chat: (messages) => cuaChat(root, secret.api_key, model, messages),
      collectAx: (name) => cuaExec('collectAxTree', name || appName),
      perform: (action, node) => cuaExec('performAction', action, node, { appName: appName || node?.name || '' }),
      isLocked: () => cuaExec('isScreenLocked'),
    },
    approval: {
      requestApproval: (summary) => requestCuaApproval(summary),
      // 全部动作脱敏审计上报（审批结果随行）
      audit: (step, actionText, result) => audit('cua', appName, `step${step}: ${actionText} -> ${result}`, result === 'denied' ? 'denied' : 'approved'),
    },
    hud,
    onEvent,
  });
  activeCuaLoop = loop;
  loop.run()
    // T4-6：任务成功完成且有已执行步骤 → 录制落盘；中途失败/停止 → 清理半成品截图不留脏数据
    .then(async (res) => {
      if (!rec) return;
      await recChain;
      if (res && res.completed && rec.steps.length) {
        const saved = cuaRecorder.saveRecording(
          { version: 1, id: rec.id, name: rec.name, objective, appName, createdAt: Date.now(), steps: rec.steps },
          { dir: cuaRecordingsDir() },
        );
        if (saved.ok) send({ type: 'recorded', recordingId: rec.id, stepCount: rec.steps.length });
        else send({ type: 'error', message: saved.error });
      } else if (rec.steps.length) {
        cuaRecorder.deleteRecording(rec.id, { dir: cuaRecordingsDir() });
      }
    })
    // cuaDegraded：子进程重启超限——消息本身即能力降级提示（degraded 标记供渲染层区分展示）
    .catch((err) => send({ type: 'error', message: err.message, degraded: !!err.cuaDegraded }))
    .finally(() => {
      activeCuaLoop = null;
      cua.destroyHud();
      try { cuaSession?.dispose(); } catch (e) { console.warn('[cua] 会话释放失败:', e.message); }
    });
  return { ok: true };
});

ipcMain.handle('cua:stop', async () => {
  if (activeReplayLoop) { activeReplayLoop.stop(); return { ok: true }; }
  if (!activeCuaLoop) return { ok: false, error: '没有进行中的界面自动化任务' };
  activeCuaLoop.stop();
  // P1-24：停止运行时统一撤下挂起的 CUA 确认卡（按 deny 收尾）——
  // 此前卡残留：循环已死、卡还在，用户点「允许」打到已无消费者的通道上
  try { cuaApprovalChannel.disposeAll(); } catch (e) { console.warn('[cua] 撤卡失败:', e.message); }
  return { ok: true };
});

// T4-6：确定性回放——不调模型，按录制步骤逐一「定位节点→（敏感则逐次确认）→执行」；
// 节点定位失败 fail-closed 中止；审批/审计与录制路径共用同一套通道（requestCuaApproval/audit）
ipcMain.handle('cua:replay', async (_, { recordingId, approvalMode = 'on-request' } = {}) => {
  if (activeCuaLoop || activeReplayLoop) return { ok: false, error: '已有进行中的界面自动化任务，请先停止' };
  if (process.platform !== 'darwin') return { ok: false, error: '界面自动化仅支持 macOS' };
  // X14：recordingId 会拼成录制文件路径（cuaRecorder 内部另有净化），边界先守类型与长度
  try {
    guard.assertStrings({ recordingId }, { recordingId: { max: 200, optional: true, allowEmpty: true } });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const loaded = cuaRecorder.loadRecording(String(recordingId || ''), { dir: cuaRecordingsDir() });
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const recording = loaded.recording;
  const cuaSession = cuaProcess.isAvailable() ? cuaProcess.createSession() : null;
  const cuaExec = (name, ...args) => (cuaSession ? cuaSession.call(name, ...args) : cua[name](...args));
  const bail = (result) => { try { cuaSession?.dispose(); } catch (e) { console.warn('[cua] 会话释放失败:', e.message); } return result; };
  if (!(await cuaExec('isAccessibilityGranted'))) {
    return bail({ ok: false, error: 'NEED_ACCESSIBILITY: 未授予辅助功能权限，请在 系统设置 > 隐私与安全性 > 辅助功能 中允许本应用' });
  }
  const send = (evt) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('cua:event', { mode: 'replay', ...evt });
  };
  const loop = new cuaRecorder.ReplayLoop({
    recording,
    // P1-2：同 cua:run——审批档入参钳制（更严者生效）
    approvalMode: agentRunner.stricterApproval(approvalMode || 'on-request', approvalSettings.getUserApprovalMode()),
    toolHandlers: {
      collectAx: (name) => cuaExec('collectAxTree', name || recording.appName),
      perform: (action, node) => cuaExec('performAction', action, node, { appName: recording.appName || node?.name || '' }),
    },
    approval: {
      requestApproval: (summary) => requestCuaApproval(summary),
      audit: (step, actionText, result) => audit('cua', recording.appName, `replay step${step}: ${actionText} -> ${result}`, result === 'denied' ? 'denied' : 'approved'),
    },
    onEvent: send,
  });
  activeReplayLoop = loop; // eslint-disable-line require-atomic-updates -- 互斥守卫已在 await 前检查，单窗口串行赋值安全
  loop.run()
    .catch((err) => send({ type: 'error', message: err.message, degraded: !!err.cuaDegraded }))
    .finally(() => {
      activeReplayLoop = null;
      try { cuaSession?.dispose(); } catch (e) { console.warn('[cua] 会话释放失败:', e.message); }
    });
  return { ok: true };
});

// 录制列表/删除（数据仅存本机 userData/recordings/，不上传）
ipcMain.handle('cua:recordings:list', async () => ({
  ok: true,
  recordings: cuaRecorder.listRecordings({ dir: cuaRecordingsDir() }),
}));
ipcMain.handle('cua:recordings:delete', async (_, { recordingId } = {}) => {
  // X14：删除录制会真的 unlink 用户文件，recordingId 走文件路径拼接——先守形状与长度
  try {
    guard.assertStrings({ recordingId }, { recordingId: { max: 200, optional: true, allowEmpty: true } });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const r = cuaRecorder.deleteRecording(String(recordingId || ''), { dir: cuaRecordingsDir() });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
});
// ═══════════════════════════════════════════
//  END COMPUTER USE (M4-C)
// ═══════════════════════════════════════════
