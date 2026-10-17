// T2-1：MCP 与杂项 IPC 域（自主进程 main.js 原样搬移，行为不变）
// 覆盖：MCP 配置持久化（userData/mcp-servers.json + env 白名单）/ 连接·断开·调用·重连 /
//       P0-F 沙箱状态查询 / P0-E GitHub 最小闭环（gh CLI 封装）IPC / 语音本地转写。
//
// 依赖注入：initMcpIpc({ requestApproval, applyApprovalDecision, getAlwaysRules,
//                        conversationRules, audit, emitTaskEvent, getCredentialCrypto })
//   - shellEnv 来自工具执行层（与 toolShell 同一 PATH 注入，MCP spawn 复用）；
//   - emitTaskEvent 归属任务编排域（main.js），MCP 状态事件经注入转发；
//   - getCredentialCrypto 供 T7 OAuth 引擎加密落盘令牌（whenReady 后才存在，故 getter）。
const { app, ipcMain, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const approval = require('../approval');
// P2-7：用户偏好「执行后告知」（正交布尔，缺省关闭）
const approvalSettings = require('../approvalSettings');
const mcp = require('../mcpClient');
const guard = require('./payloadGuard');
const sandbox = require('../sandbox');
const github = require('../github');
const voice = require('../voice');
const { McpAuthManager } = require('../mcpAuth');
// P0-5①：落盘必须显式设权限（对齐 mcpAuth.js:67 的正例）——配置文件含用户自配凭证
const { writeFileDurableWithMode } = require('../data/durableWrite');
const { shellEnv } = require('../tools/exec');

const mcpServers = { get: (n) => mcp.getMcpServer(n), names: () => mcp.listMcpServers() };

// MCP 配置持久化（userData/mcp-servers.json）+ 子进程 env 白名单
const MCP_CONFIG_FILE = () => path.join(app.getPath('userData'), 'mcp-servers.json');
const ENV_WHITELIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SHELL', 'USER', 'TMPDIR', 'NODE_ENV'];
// P0-5①：仅本人可读写（POSIX）；Windows 上 chmod 语义受限，durableWrite 会如实上报 modeApplied=false
const MCP_CONFIG_MODE = 0o600;
// P0-5①：受保护 env 键——用户 env **只能补充**这些之外的键，不能覆盖它们。
// 为什么要拦：spawn({env}) 会**完全替换**父进程环境，PATH 被覆盖即等价于「子进程可劫持任意可执行文件」；
// HOME/SHELL/TMPDIR 被覆盖会把服务进程的读写重定向到用户指定位置（沙箱外副作用）。
const PROTECTED_ENV = new Set([...ENV_WHITELIST, 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES']);

let deps = null;

// T7：OAuth 令牌管理器（懒建：凭证加密就绪才可用；令牌加密落 userData/mcp-oauth.json）。
// 授权窗口用独立 BrowserWindow（无 preload、沙箱化），loopback 收到回调即由引擎关窗。
let oauthManager = null;
function getOauthManager() {
  if (oauthManager) return oauthManager;
  const cc = deps && deps.getCredentialCrypto ? deps.getCredentialCrypto() : null;
  if (!cc) return null;
  oauthManager = new McpAuthManager({
    storeFile: path.join(app.getPath('userData'), 'mcp-oauth.json'),
    credentialCrypto: cc,
    openAuthWindow: (url) => {
      const win = new BrowserWindow({
        width: 900, height: 700,
        title: '服务授权',
        autoHideMenuBar: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      win.loadURL(url).catch(() => { /* 加载失败由回调超时如实透出 */ });
      return { close: () => { try { if (!win.isDestroyed()) win.close(); } catch { /* 已关闭 */ } } };
    },
    log: (line) => console.warn('[mcp-oauth]', line),
  });
  return oauthManager;
}

// P0-持久化（2026-10-16）修复两处：
//   ① saveMcpConfig 此前裸 writeFileSync（无 tmp+rename、无 fsync），崩溃写坏即全部配置消失；
//   ② loadMcpConfig 此前把「文件损坏」与「尚未配置」当同一回事，catch 里一律 return []
//      且不留下任何痕迹——用户配好的 MCP 服务无声消失，却不知道为什么。
function loadMcpConfig() {
  const file = MCP_CONFIG_FILE();
  if (!fs.existsSync(file)) return []; // 尚未配置过，正常
  // P0-5①：历史版本以 0644 落盘（实测 11 个服务的文件就是 0644）——读取时自愈收紧，
  // 只改权限、不动内容，避免升级后仍长期处于「同机其他用户可读凭证」的状态。
  try {
    if (process.platform !== 'win32') {
      const mode = fs.statSync(file).mode & 0o777;
      if (mode !== MCP_CONFIG_MODE) {
        fs.chmodSync(file, MCP_CONFIG_MODE);
        console.warn(`[mcp] 已将 ${file} 权限从 ${mode.toString(8)} 收紧为 ${MCP_CONFIG_MODE.toString(8)}`);
      }
    }
  } catch (e) {
    console.warn('[mcp] 配置文件权限收紧失败:', e.message);
  }
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(list)) throw new Error('结构非法：顶层不是数组');
    return list;
  } catch (e) {
    const kept = `${file}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(file, kept); } catch { /* 保留失败不阻断 */ }
    console.error(`[mcp] 配置文件损坏：${e.message}；已保留副本 ${kept}。请从副本恢复或重新配置 MCP 服务。`);
    return [];
  }
}

function saveMcpConfig(list) {
  try {
    const res = writeFileDurableWithMode(MCP_CONFIG_FILE(), JSON.stringify(list, null, 2), MCP_CONFIG_MODE);
    if (!res.ok) {
      // 落盘失败绝不静默：下次重启会「服务全红且配置消失」，用户无从归因
      console.warn('[mcp] 配置持久化失败:', res.error);
    } else if (!res.modeApplied) {
      console.warn(`[mcp] 权限未收紧（chmod ${MCP_CONFIG_MODE.toString(8)} 失败）：${res.error || '未知原因'}；该文件含凭证，请手动检查权限`);
    }
  } catch (e) {
    console.warn('[mcp] 配置持久化异常:', e.message);
  }
}

// P0-5③：用户 env 的「可落盘、可注入」部分——受保护键一律剔除（键名不能由用户决定系统行为）。
// 同一函数同时服务两个调用点：spawn 前注入（sanitizeEnv）与写入配置（connectMcpServer），
// 保证「运行时看到的」与「落盘的」是同一视角，不再出现两份漂移的白名单。
function userEnvOf(env) {
  const out = {};
  for (const [k, v] of Object.entries(env && typeof env === 'object' ? env : {})) {
    if (PROTECTED_ENV.has(k)) continue;
    if (v === undefined || v === null) continue;
    out[k] = String(v);
  }
  return out;
}

// env 白名单：仅透传系统基础变量 + 用户显式配置，杜绝 process.env 全量泄漏（P2-10）
// PATH 特殊处理：打包版 GUI 进程继承的 PATH 极简（/usr/bin:/bin:...），
// npx/uvx（homebrew）全找不到——真机复盘：MCP 服务全部 spawn ENOENT。
// 注入与 toolShell 子 shell 一致的完整 PATH（见 SHELL_PATH 定义）。
//
// P0-5③：展开顺序修正。旧实现 `{ ...out, PATH: shellEnv().PATH, ...(env || {}) }` 让用户 env **恒胜**，
// 可覆盖 PATH（子进程劫持任意可执行文件）与 HOME/SHELL/NODE_ENV 等受保护键。
// 现在：用户 env 先按 userEnvOf 过滤（只做增量），白名单与 PATH **最后**展开 → 受保护键恒为系统真实值。
function sanitizeEnv(env) {
  const out = userEnvOf(env);
  for (const k of ENV_WHITELIST) {
    if (process.env[k]) out[k] = process.env[k];
  }
  out.PATH = shellEnv().PATH;
  return out;
}

// MCP 连接核心逻辑（IPC 处理器与启动重连共用）：委托给 mcpClient（stdio/http 双传输）
async function connectMcpServer({ name, transport = 'stdio', command, args = [], env = {}, url, headers = {} } = {}) {
  // T7：http 连接挂 OAuth 钩子——令牌全程主进程闭环，渲染层不经手
  const am = transport === 'http' && name ? getOauthManager() : null;
  const auth = am ? {
    getHeader: async () => { const t = await am.getAccessToken(name); return t ? `Bearer ${t}` : null; },
    refresh: async () => { const t = await am.refreshFor(name); return t ? `Bearer ${t}` : null; },
  } : undefined;
  const r = await mcp.connectMcpServer({
    name, transport, command, args, env: sanitizeEnv(env), url, headers, auth,
    onStatus: (n, st, code) => emitMcpStatus(n, st, code),
    onLog: (line) => console.log(`[MCP ${name}]`, line),
  });
  // 连接成功 → 持久化配置（重启后自动重连）。fail-closed：握手失败不写盘。
  if (r.ok && name) {
    const config = loadMcpConfig().filter((s) => s.name !== name);
    // P0-5②：落盘内容过同一 sanitize 视角——受保护键不写进文件（重启时由 sanitizeEnv 重新注入系统值）。
    // 用户自配 env（含 API Key 等）**必须原样保留**：脱敏会让需要凭证的服务重启后全部连不上
    //（P0-5 取舍：本轮只做「明文 + 0600 权限保护」，加密迁移 safeStorage 列入遗留）。
    const savedEnv = userEnvOf(env);
    config.push(transport === 'http'
      ? { name, transport, url, headers, env: savedEnv }
      : { name, transport: 'stdio', command, args, env: savedEnv });
    saveMcpConfig(config);
  }
  return r;
}

// P1-1：MCP 服务状态变更 → 通知渲染层（AgentDock / 设置页据此标红断开的服务）
function emitMcpStatus(name, status, code) {
  try {
    deps.emitTaskEvent({ type: 'mcp_status', name, status, code, ts: Date.now() });
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
  const startedAt = Date.now(); // P2-7：执行后告知要报耗时
  // L3：MCP 工具调用审批（auto-safe 档仍询问）
  const verdict = approval.needsApproval({ tool: `mcp__${server}__${tool}`, args: args || {}, approvalMode, conversationId, alwaysRules: deps.getAlwaysRules(), conversationRules: deps.conversationRules });
  if (verdict.need) {
    const decision = await deps.requestApproval(`mcp__${server}__${tool}`, args || {});
    if (decision === 'deny') {
      deps.audit(`mcp:${server}`, tool, '用户拒绝', 'denied');
      return { error: '用户拒绝执行', denied: true };
    }
    deps.applyApprovalDecision(decision, `mcp__${server}__${tool}`, args || {}, conversationId);
  }
  let noticeOk = false;
  let noticeError = '';
  try {
    // P1-8：模型侧拿到的是「清洗后的工具名」（H-4：1–128 字符、仅 [A-Za-z0-9_.-]），
    // 调用前必须还原成服务端真实名字——否则服务端收到的名字已被替换，只会回 unknown tool。
    const realTool = mcp.resolveToolName(s, tool);
    // P1-8：走带会话恢复的 RPC（HTTP 会话 404 → 重新 initialize 后重试一次，H-4 要求）
    const result = await mcp.mcpRpcWithSessionRetry(s, 'tools/call', { name: realTool, arguments: args || {} });
    // H-4：结果必须二分——JSON-RPC `error`（协议错，走 catch）与 `result.isError:true`（工具**执行**失败）。
    // 后者是合法工具结果：原样回喂模型自纠（内容不动、不抛错、不改写成 error 字段——
    // 改写成 error 会被引擎的 isToolFailure 计入「重复失败熔断」，同参重试语义过重）。
    const toolErr = !!(result && result.isError === true);
    deps.audit(`mcp:${server}`, tool,
      `${toolErr ? 'isError: 工具执行失败' : (result?.error ? `error: ${result.error}` : 'ok')} rule=${verdict.matched || 'none'}`,
      verdict.need ? 'approved' : 'auto');
    noticeOk = !toolErr;
    return toolErr ? { ...result, toolError: true } : result;
  } catch (err) {
    noticeError = err && err.message ? err.message : String(err);
    deps.audit(`mcp:${server}`, tool, `error: ${err.message}`, 'error');
    return { error: err.message };
  } finally {
    // P2-7：执行后告知。MCP 写的是**外部系统**（通知里会标注不可补偿），这类最需要事后知情。
    // 放 finally：成功/失败都要告知；用 try 兜住——通知失败绝不能影响工具结果。
    try {
      approval.notifyExecuted({
        enabled: approvalSettings.getUserApprovalNotice(),
        tool: `mcp__${server}__${tool}`,
        args: args || {},
        approvalMode,
        conversationId,
        alwaysRules: deps.getAlwaysRules(),
        conversationRules: deps.conversationRules,
        ok: noticeOk,
        ms: Date.now() - startedAt,
        error: noticeError,
      });
    } catch (e) {
      console.warn('[approval] MCP 执行后告知发送失败（不影响结果）:', e.message);
    }
  }
}

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

function register() {
  ipcMain.handle('mcp:connect', async (_, payload) => {
    // X14：connect 会把 name/command/args/env 落到 mcp-servers.json（env 明文），
    // 形状必须先过关，避免把奇怪结构写进配置文件
    try {
      guard.assertStrings(payload, { name: 120, command: { max: 2000, optional: true }, url: { max: 2000, optional: true } });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    return connectMcpServer(payload);
  });

  // 2026-10-17（用户实测反馈「ima 配置完成后 + 菜单里仍然显示需手动配置」）：
  // 按名重连「已保存但当前未连接」的服务。
  //
  // 为什么必须由主进程按名取配置、而不是渲染层把 payload 传进来：
  // mcp-servers.json 里的 env 含 API Key，跨 IPC 出口一律剥离（见 mcp:getConfig），
  // 渲染层拿不到 env 就拼不出完整 payload。此处从磁盘读整条（含 env），
  // env 全程留在主进程内，符合既有「凭证不出主进程」纪律。
  ipcMain.handle('mcp:reconnect', async (_, payload) => {
    try {
      // X14：name 是用户数据（来自目录/配置），先过边界校验
      guard.assertStrings(payload, { name: 120 });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const name = String(payload.name);
    // 幂等：已连接就直接回当前状态，避免重复 spawn 出第二个子进程
    const existing = mcp.getMcpServer(name);
    if (existing) return { ok: true, toolCount: (existing.tools || []).length, already: true };
    const saved = loadMcpConfig().find((s) => s && s.name === name);
    if (!saved) {
      // fail-closed：没有保存过的配置就如实报错，不要拿空 command 去 spawn
      return { ok: false, error: `未找到已保存的 MCP 配置：${name}（请先在生态中心保存该服务）` };
    }
    const r = await connectMcpServer(saved);
    deps.audit(`mcp:reconnect:${name}`, '', r && r.ok ? `tools=${r.toolCount || 0}` : `error: ${(r && r.error) || 'unknown'}`, r && r.ok ? 'connected' : 'error');
    return r;
  });

  // T7：浏览器授权（三级回落在引擎内完成；只回状态与级别，绝不回传令牌）
  ipcMain.handle('mcp:authorize', async (_, { name, url, preset } = {}) => {
    const am = getOauthManager();
    if (!am) return { ok: false, error: '凭证加密未就绪，无法安全保存 OAuth 令牌' };
    const r = await am.authorize(String(name || ''), {
      url: String(url || ''),
      preset: preset && typeof preset === 'object' ? preset : undefined,
    });
    deps.audit(`mcp:authorize:${name}`, '', r.ok ? `level=${r.level}` : `error: ${r.error}`, r.ok ? 'authorized' : 'error');
    return r;
  });

  // T7：授权状态查询（渲染层据此决定「浏览器授权」还是「测试连接」；不回传任何令牌材料）
  ipcMain.handle('mcp:authStatus', async (_, { name } = {}) => {
    const am = getOauthManager();
    return { ok: true, authorized: !!(am && name && am.hasStoredAuth(String(name))) };
  });

  ipcMain.handle('mcp:callTool', (_, payload) => {
    try {
      // 形状以 callMcpTool 的入参为准：{ server, tool, arguments }
      guard.assertStrings(payload, { server: 200, tool: 200 });
      if (payload.arguments !== undefined) guard.assertObject({ arguments: payload.arguments });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    return callMcpTool(payload);
  });

  ipcMain.handle('mcp:disconnect', async (_, { name } = {}) => {
    // X14：name 同时用于断开子进程与重写 mcp-servers.json（filter 掉该条）——
    // 非字符串会让 filter 静默放行全部，用户以为断开了、重启后全部重连
    try {
      guard.assertStrings({ name }, { name: 200 });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    // 断开 + 同步移除持久化配置（http 传输无子进程，close 为空操作）
    mcp.disconnectMcpServer(name);
    saveMcpConfig(loadMcpConfig().filter((s) => s.name !== name));
    return { ok: true };
  });

  // ═══ P0-F：沙箱状态查询（UI 明示隔离能力与兜底状态）═══
  // P0-6 修复（2026-10-17）：原实现用静态 detectBackend()（仅 fs.existsSync 判定
  // sandbox-exec 存在）上报可用性，而执行路径（exec.js）用的是真实探测 seatbeltUsable()
  // （实际 apply 一个带 deny network* 的 profile）。嵌套沙箱环境（本应用被其他 Agent
  // 平台的沙箱包住、或 CI 容器）下 sandbox-exec 存在但无法 apply → UI 显示「已隔离就绪」，
  // 实际执行时落 runFallback 以宿主权限直跑——用户基于错误的安全认知做出放行决策。
  // 现改用 describeCapability()：与执行路径同源的真实能力探测，nestedSandbox 一并下发，
  // UI 对「能力不可用」给出明确文案，不显示「已隔离」。
  ipcMain.handle('sandbox:status', async () => {
    const cap = await sandbox.describeCapability();
    let available = cap.available;
    let hint = cap.reason;
    // Windows 后端的就绪态是异步的（net user 查专用用户），describeCapability 只做静态探测，
    // 此处沿用异步确认（与 exec.js 的 windowsSandboxReady 同源，避免静态误报「已就绪」）
    if (cap.backend === 'windows-restricted-user') {
      const st = await sandbox.windowsBackend.windowsSandboxReady();
      available = st.ready;
      hint = st.reason;
    }
    return {
      ok: true,
      platform: process.platform,
      available,            // OS 级沙箱是否**真实**就绪（三平台：seatbelt / bubblewrap / windows-restricted-user）
      backend: cap.backend,
      hint,                 // 未就绪时的可行动提示（如「apt install bubblewrap」/ 嵌套沙箱说明）
      nestedSandbox: cap.nestedSandbox, // 嵌套沙箱环境：macOS 不允许嵌套 apply，隔离无法生效
      fallbackActive: !available, // 无 OS 级沙箱时启用命令级硬拦截兜底
    };
  });

  // ═══ P0-E：GitHub 最小闭环（gh CLI 封装）═══
  // diff 审查的「交付」出口：创建 PR。依赖本机 gh 登录态，不做云端 OAuth。
  ipcMain.handle('github:status', async () => {
    const available = await github.ghAvailable();
    if (!available) {
      return { ok: true, available: false, authed: false, hint: '未检测到 GitHub CLI（gh）。请先安装 https://cli.github.com 并执行 gh auth login' };
    }
    const auth = await github.ghAuthed();
    return { ok: true, available: true, authed: auth.ok, hint: auth.ok ? '' : 'gh 未登录，请先执行 gh auth login' };
  });

  ipcMain.handle('github:createPr', async (_, payload = {}) => {
    // X14：title/body/base 会作为 argv/--body 交给 gh（createPullRequest 内已做 String() 化），
    // 但长度失控会把整段内容塞进命令行；cwd 决定在哪个仓库开 PR，同样守一下形状
    try {
      guard.assertStrings(payload, {
        cwd: { max: 4096, optional: true, allowEmpty: true },
        title: { max: 300, optional: true, allowEmpty: true },
        body: { max: 60000, optional: true, allowEmpty: true },
        base: { max: 200, optional: true, allowEmpty: true },
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const available = await github.ghAvailable();
    if (!available) {
      return { ok: false, error: '未检测到 GitHub CLI（gh）。请先安装 https://cli.github.com 并执行 gh auth login' };
    }
    const r = await github.createPullRequest(payload);
    if (r.ok) {
      deps.audit('github:createPr', String(payload.cwd || ''), `title=${String(payload.title || '').slice(0, 80)} url=${r.url}`, 'recorded');
    } else {
      deps.audit('github:createPr', String(payload.cwd || ''), `error: ${r.error}`, 'error');
    }
    return r;
  });

  ipcMain.handle('mcp:listServers', async () => {
    return mcp.listMcpServers().map((name) => {
      const s = mcp.getMcpServer(name);
      // P1-8：握手协商结果随列表下发（服务端实际版本 / 能力 / 自述），供设置页与诊断查询。
      // protocolVersion 只放服务端返回值（未声明时为 null）；我们提议的版本单独给，不冒充协商结果。
      return {
        name, toolCount: s?.tools?.length || 0, kind: s?.kind || 'stdio',
        protocolVersion: s?.protocolVersion || null,
        proposedProtocolVersion: s?.proposedProtocolVersion || null,
        // P1-8：legacy=true 表示该服务拒绝过 2025-11-25、已降级为 2024-11-05（诊断/UI 可提示）
        legacy: !!s?.legacy,
        serverInfo: s?.serverInfo || null,
        capabilities: s?.capabilities || {},
      };
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
    // 2026-10-16：同时回传配置文件路径 —— 生态中心连接器弹窗据此提供「打开 JSON 直接改」入口。
    // 只回路径、不读内容：文件里的 env 含 API Key，跨 IPC 出口仍一律剥离（见上一条注释）。
    path: MCP_CONFIG_FILE(),
    servers: loadMcpConfig().map(({ env, ...rest }) => rest),
  }));

  // T2：生态中心「本机服务」区 JSON 编辑入口（开发者通道）——
  //  接收完整数组（含 env），整体覆盖 mcp-servers.json 后重连。
  //  校验：数组元素必须含 name；stdio 必须有 command；http 必须有 url；
  //  非法条目静默丢弃（不阻断整批保存），返回 {ok, saved, dropped} 让 UI 明示。
  ipcMain.handle('mcp:setConfig', async (_, payload) => {
    // X14：servers 非数组时下面的 `: []` 分支会把整份 mcp-servers.json 覆盖成空数组
    //（用户视角：所有 MCP 配置无声消失）。显式传 [] 仍是合法的「清空」，但类型必须守。
    try {
      guard.assertArray(payload || {}, 'servers', { max: 200 });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const list = Array.isArray(payload?.servers) ? payload.servers : [];
    const valid = [];
    let dropped = 0;
    for (const s of list) {
      if (!s || typeof s !== 'object' || !s.name) { dropped++; continue; }
      const t = String(s.transport || 'stdio');
      if (t === 'http' && !s.url) { dropped++; continue; }
      if (t !== 'http' && !s.command) { dropped++; continue; }
      valid.push({
        name: String(s.name),
        transport: t,
        command: s.command ? String(s.command) : undefined,
        args: Array.isArray(s.args) ? s.args.map(String) : [],
        url: s.url ? String(s.url) : undefined,
        env: userEnvOf(s.env), // P0-5②：手改 JSON 的通道同样只落用户增量 env（受保护键不进文件）
        headers: s.headers && typeof s.headers === 'object' ? s.headers : {},
      });
    }
    saveMcpConfig(valid);
    // 断开旧连接后按新配置重连（与 disconnect→save 链路一致）
    try { killAllMcpServers(); } catch { /* 无旧连接时忽略 */ }
    await reconnectMcpServers();
    return { ok: true, saved: valid.length, dropped };
  });

  // A5：语音本地转写（whisper.cpp；音频不出本机）
  ipcMain.handle('voice:transcribe', async (_, { wavBase64, language }) => voice.transcribeWav({ wavBase64, language }));
}

function initMcpIpc(d) {
  deps = d;
  register();
}

module.exports = { initMcpIpc, connectMcpServer, callMcpTool, killAllMcpServers, reconnectMcpServers, mcpServers };
