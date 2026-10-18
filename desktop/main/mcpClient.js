// MCP 客户端（2026-10-15 从 main.js 抽出 + 多传输）
//
// 此前只有 stdio 一种传输，且实现内联在 main.js（God Object 清单项）。
// 本模块把传输抽象出来：
//   stdio —— 子进程 + 按行 JSON-RPC（原实现，行为不变）
//   http  —— MCP Streamable HTTP（spec 2025-03-26）：POST JSON-RPC，响应可为
//            application/json（单响应）或 text/event-stream（SSE，含响应与后续通知）；
//            initialize 时捕获 Mcp-Session-Id，后续请求回带。
//
// 安全说明（与 webTools 的 SSRF 防护刻意不同）：
//   MCP 服务地址来自**用户显式配置**（设置页/连接器目录），不是模型可控参数——
//   且本地 localhost 恰是自托管 MCP 最常见的形态，因此 http 传输**不套用**
//   webTools 的私网拦截；模型只能调用「已连接服务」的已注册工具（callMcpTool 按
//   server/tool 名分发），无法引导客户端连到任意 URL。
//
// 生命周期与原实现一致：initialize → notifications/initialized → tools/list 三步分离，
// 各自超时；握手完成后的进程退出/SSE 断开才算「运行期崩溃」并回报上层。

const { spawn } = require('child_process');
// P1-8：协议版本/客户端能力的单一事实来源（mcpAuth.js 的 401 探测也引用同一份）
const {
  PROTOCOL_VERSION, MIN_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS,
  CLIENT_CAPABILITIES, CLIENT_INFO, isSupportedProtocolVersion,
} = require('./mcpProtocol');

const servers = new Map(); // name -> server 实例（跨传输统一注册表）

const DEFAULT_TIMEOUT_MS = 30000;
// P1-8：tools/list 分页上限——服务端若返回恒真的 nextCursor（实现 bug），无上限会死循环
const MAX_TOOL_PAGES = 20;// H-4：工具名规范为 1–128 字符、仅 [A-Za-z0-9_.-]（SHOULD）。越界名字一律清洗后暴露给模型，
// 真实名字保留在 server.toolNameMap 里供 tools/call 还原。
const TOOL_NAME_MAX = 128;
const TOOL_NAME_BAD_CHARS = /[^A-Za-z0-9_.-]/g;
// P2-5：缓存命中但**握手仍在途**时，最多等这么久让在途连接完成（略大于 initialize 超时）。
// 不能直接返回 toolCount:0 —— 调用方会把它当成「已连接但没有工具」。
const HANDSHAKE_WAIT_MS = DEFAULT_TIMEOUT_MS + 5000;

// ── JSON-RPC 请求（跨传输通用）──
function mcpRpc(server, method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const id = server.nextId++;
    const timer = setTimeout(() => {
      server.pending.delete(id);
      reject(new Error(`MCP ${method} 超时（${timeoutMs / 1000}s）`));
    }, timeoutMs);
    server.pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message || 'MCP 返回错误'));
      else resolve(msg.result);
    });
    // 传输层负责真实投递；投递失败要同时清理 pending，否则调用方要等满超时
    let payload;
    try {
      payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
    } catch (e) {
      clearTimeout(timer);
      server.pending.delete(id);
      reject(new Error(`MCP 请求序列化失败：${e.message}`));
      return;
    }
    Promise.resolve()
      .then(() => server.transport.send(payload, id))
      .catch((e) => {
        clearTimeout(timer);
        server.pending.delete(id);
        const err = new Error(`MCP 请求发送失败：${e.message}`);
        // T7：needsAuth 标记必须穿过重包装，否则上层无法区分「要授权」与「网络故障」
        if (e.mcpAuthRequired) err.mcpAuthRequired = true;
        // H-4：会话失效标记同理——丢了它就无法触发「重新 initialize 后重试一次」
        if (e.mcpSessionExpired) err.mcpSessionExpired = true;
        reject(err);
      });
  });
}

// 分发收到的 JSON-RPC 消息：响应按 id 唤醒等待者；通知/请求（服务端主动）走 onNotify 钩子
function dispatchMessage(server, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.id !== undefined && server.pending.has(msg.id)) {
    const cb = server.pending.get(msg.id);
    server.pending.delete(msg.id);
    cb(msg);
    return;
  }
  if (typeof server.onNotify === 'function') {
    try { server.onNotify(msg); } catch (e) { /* 通知处理失败不影响主流程 */ }
  }
}

// ── P1-8：工具名清洗 / 映射（H-4：1–128 字符、仅 [A-Za-z0-9_.-]）──
//
// 为什么必须有这一层：工具名直接被拼进 `mcp__<server>__<tool>` 交给模型，
// 而模型厂商对 function.name 的字符集要求比 MCP 规范更严（部分供应商直接 400）。
// 清洗必须**可逆**：调用时用真实名字发给服务端，否则服务端收到的是被替换过的名字 → unknown tool。
function sanitizeToolName(name) {
  const cleaned = String(name || '').trim().replace(TOOL_NAME_BAD_CHARS, '_').slice(0, TOOL_NAME_MAX);
  return cleaned || 'tool';
}

// 登记工具：返回暴露给模型的列表，并把 exposedName → originalName 存进映射表
function registerTools(server, rawTools) {
  const map = new Map();
  const used = new Set();
  const tools = [];
  for (const t of rawTools || []) {
    if (!t || typeof t !== 'object') continue;
    const original = String(t.name || '');
    if (!original) continue;
    let exposed = sanitizeToolName(original);
    if (used.has(exposed)) {
      // 清洗后重名（如 `a b` 与 `a/b` 都变 `a_b`）：加序号区分，避免模型调用时歧义
      let i = 2;
      while (used.has(`${exposed}_${i}`)) i += 1;
      exposed = `${exposed}_${i}`.slice(0, TOOL_NAME_MAX);
    }
    used.add(exposed);
    map.set(exposed, original);
    tools.push(exposed === original ? t : { ...t, name: exposed, originalName: original });
  }
  server.tools = tools;
  server.toolNameMap = map;
  return tools;
}

/** 暴露名 → 服务端真实工具名（未登记时按原名透传，兼容测试/裸调用） */
function resolveToolName(server, name) {
  const map = server && server.toolNameMap;
  if (map && map.has(name)) return map.get(name);
  return name;
}

// ── P1-8④：服务端主动消息处理（此前 onNotify 恒 null，dispatchMessage 的通知分支永不进入）──
function handleServerMessage(server, msg, { onLog } = {}) {
  const log = typeof onLog === 'function' ? onLog : () => {};
  // 迟到的响应（请求已超时、pending 已清理）：静默忽略，不刷日志
  if (msg.id !== undefined && !msg.method) return;
  // 服务端 → 客户端的**请求**（有 id 且有 method，但不在 pending 里）：
  // 我们没实现 roots/sampling/elicitation，必须立刻回 -32601 让它失败，
  // 绝不能静默丢弃——静默会让服务端一直等我们应答，表现为「调用挂死」。
  if (msg.id !== undefined && msg.method) {
    const payload = JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      error: { code: -32601, message: `客户端未实现 ${msg.method}（未声明该能力）` },
    });
    Promise.resolve(server.transport.send(payload, msg.id)).catch(() => { /* 回执失败不影响主流程 */ });
    log(`服务端请求 ${msg.method} 未实现，已回 -32601`);
    return;
  }
  const method = String(msg.method || '');
  if (method === 'notifications/tools/list_changed') {
    // 工具集变更（服务端热更新）：重拉并换装，模型下一轮就能看到新工具
    server.toolsChangedAt = Date.now();
    refreshTools(server)
      .then((tools) => console.log(`[MCP ${server.name}] 工具列表已变更，重新拉取 ${tools.length} 个工具`))
      .catch((e) => console.warn(`[MCP ${server.name}] 工具列表刷新失败:`, e.message));
    return;
  }
  if (method === 'notifications/message') {
    const p = msg.params || {};
    const data = typeof p.data === 'string' ? p.data : JSON.stringify(p.data);
    log(`[${p.level || 'info'}] ${data}`);
    return;
  }
  if (method === 'notifications/progress') {
    // 请求级进度：pending 只按 id 索引，progressToken 路由本轮未实现（列入遗留）。
    // 只记录最近一条，避免长任务把内存撑起来。
    const p = msg.params || {};
    server.lastProgress = { token: p.progressToken, progress: p.progress, total: p.total, ts: Date.now() };
    return;
  }
  log(`未处理的服务端消息：${method || '(无 method)'}`);
}

// ── P1-8：握手 / 工具列表（initialize → notifications/initialized → tools/list 分页）──

async function notifyInitialized(server) {
  // 2026-10-17：streamableHttp 与 stdio 一样，initialize 之后必须发 initialized 通知。
  // 此前只对 stdio 发：宽容的服务端（24haowan）不校验，严格的服务端会拒绝后续 tools/list。
  try {
    await server.transport.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  } catch (e) {
    console.warn('[MCP] initialized 通知发送失败（不影响主流程）:', e.message);
  }
}

/**
 * 握手并**采纳服务端返回值**（P1-8②③）。
 * 返回值里带 protocolVersion / capabilities / serverInfo —— 原实现直接丢弃，
 * 导致 server.capabilities 恒为发出值、上层无法得知服务端到底支持什么。
 * @param {object} server
 * @param {string} [version] 本次提议的协议版本（降级重试时传 MIN_PROTOCOL_VERSION）
 */
async function performHandshake(server, version = PROTOCOL_VERSION) {
  // 提议版本如实记录（降级后记 MIN，而不是永远记 2025-11-25）
  server.proposedProtocolVersion = version;
  const initRes = await mcpRpc(server, 'initialize', {
    protocolVersion: version,
    capabilities: { ...CLIENT_CAPABILITIES },
    clientInfo: { ...CLIENT_INFO },
  });
  const peerVersion = initRes && typeof initRes.protocolVersion === 'string' ? initRes.protocolVersion : '';
  if (peerVersion && !isSupportedProtocolVersion(peerVersion)) {
    // H-4：服务端回不支持的版本 → disconnect（不自行降级重试），由 connectMcpServer 的 catch 收尾
    const err = new Error(
      `MCP 协议版本不受支持：服务端返回 ${peerVersion}，本客户端支持 ${SUPPORTED_PROTOCOL_VERSIONS.join(' / ')}。`
      + '按 MCP 规范已断开该连接，请升级该 MCP 服务或其网关。',
    );
    err.mcpVersionUnsupported = true;
    throw err;
  }
  // 落状态时以**服务端实际返回值**为准：peerVersion 为空（服务端未声明版本）时保持空，
  // 不拿我们自己提议的版本冒充协商结果（提议值单独记在 proposedProtocolVersion）。
  server.protocolVersion = peerVersion;
  server.capabilities = (initRes && initRes.capabilities) || {};
  server.serverInfo = (initRes && initRes.serverInfo) || {};
  if (initRes && typeof initRes.instructions === 'string') server.instructions = initRes.instructions;
  if (peerVersion && peerVersion !== version) {
    console.warn(`[MCP ${server.name}] 服务端协议版本 ${peerVersion}（本端提议 ${version}），按规范采纳服务端返回值`);
  }
  await notifyInitialized(server);
  return initRes;
}

/**
 * 判断错误是否是「服务端直接拒绝握手」的版本兼容性问题（区别于「回了个不支持的版本号」）。
 * 只有前者允许用 MIN_PROTOCOL_VERSION 重试一次；后者一律按 H-4 disconnect。
 */
function isProtocolVersionRejection(err) {
  if (!err) return false;
  if (err.mcpVersionUnsupported) return false; // 协商失败（已回版本号）→ 不重试
  if (err.mcpAuthRequired || err.mcpSessionExpired) return false;
  const m = String(err.message || '');
  const mentionsVersion = /protocolversion|protocol\s*version|protocol|version/i.test(m);
  const mentionsReject = /unsupported|not\s*support|invalid|unknown|mismatch|reject|unrecogni[sz]ed/i.test(m);
  return mentionsVersion && mentionsReject;
}

/**
 * 握手 + **最多一次**的 legacy 降级（team-lead 2026-10-17 裁决，修正 H-4 的绝对化表述）。
 * 触发条件三条全满足：① initialize 自身抛错（不是「回了不支持的版本号」）；
 * ② 错误文本能匹配 protocol/version + unsupported 语义；③ 本次连接尚未重试过。
 * 降级后必须留痕（server.legacy + console.warn），不静默、不无限次。
 */
async function negotiateHandshake(server) {
  try {
    return await performHandshake(server, PROTOCOL_VERSION);
  } catch (err) {
    if (server.legacyRetried || !isProtocolVersionRejection(err)) throw err;
    server.legacyRetried = true;
    console.warn(
      `[MCP ${server.name}] initialize 被拒（${String(err.message || '').slice(0, 120)}）；`
      + `按兼容性降级用 ${MIN_PROTOCOL_VERSION} 重试一次（不是静默降级，将留痕）`,
    );
    const res = await performHandshake(server, MIN_PROTOCOL_VERSION);
    server.legacy = true;
    console.warn(`[MCP ${server.name}] 该服务已降级为 ${MIN_PROTOCOL_VERSION} legacy 模式（协商结果：${server.protocolVersion || '服务端未声明'}）`);
    return res;
  }
}

// tools/list 翻页到底（H-4：nextCursor 必须翻，上限 MAX_TOOL_PAGES 防服务端死循环）
async function fetchAllTools(server) {
  const all = [];
  let cursor = '';
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const res = await mcpRpcWithSessionRetry(server, 'tools/list', cursor ? { cursor } : {});
    if (Array.isArray(res && res.tools)) all.push(...res.tools);
    cursor = (res && res.nextCursor) || '';
    if (!cursor) return all;
  }
  console.warn(`[MCP ${server.name}] tools/list 分页达到上限 ${MAX_TOOL_PAGES} 页，已停止翻页（可能有工具未加载）`);
  return all;
}

/** 重拉工具列表并换装（连接期与 notifications/tools/list_changed 共用） */
async function refreshTools(server) {
  return registerTools(server, await fetchAllTools(server));
}

/**
 * 会话恢复互斥（P2-5）：并发请求同时收到 404 时，只让**一个**真正重建会话。
 *
 * 不互斥的后果：N 个并发请求各自 resetSession + initialize → N 次握手，http 传输的
 * `sessionId` 被后完成者覆盖（`mcpClient.js` 的 createHttpTransport 里 sessionId 是闭包变量），
 * 先完成的那次握手可能已被服务端作废 → 再次 404；而重试预算只有一次，于是这些请求全失败。
 *
 * 失败语义：在途者负责把错误抛给**它自己的**调用方；其余等待者吞掉错误后各自重试，
 * 重试若再失败会抛出原始错误（不会静默成功）。
 */
async function recoverSession(server, version, { handshake = performHandshake } = {}) {
  if (server._sessionRecovery) {
    try { await server._sessionRecovery; } catch { /* 由在途者向其调用方抛出 */ }
    return;
  }
  const recovery = (async () => {
    if (server.transport && typeof server.transport.resetSession === 'function') server.transport.resetSession();
    await handshake(server, version);
  })();
  server._sessionRecovery = recovery;
  try {
    await recovery;
  } finally {
    server._sessionRecovery = null;
  }
}

/**
 * 带会话恢复的 RPC（H-4：HTTP 传输收到 404 MUST 重新 initialize（不带 session id））。
 * 仅对「传输层明确报告会话失效」的错误重试一次，其余错误原样抛出。
 */
async function mcpRpcWithSessionRetry(server, method, params, timeoutMs) {
  try {
    return await mcpRpc(server, method, params, timeoutMs);
  } catch (err) {
    if (!err || !err.mcpSessionExpired || method === 'initialize') throw err;
    console.warn(`[MCP ${server.name}] 会话已失效（HTTP 404），按规范重新握手后重试 ${method}`);
    // 重新握手沿用上次协商用的提议版本（若已降级为 legacy，不要又提回 2025-11-25）
    await recoverSession(server, server.proposedProtocolVersion || PROTOCOL_VERSION);
    return mcpRpc(server, method, params, timeoutMs);
  }
}

// ── stdio 传输 ──
function createStdioTransport({ name, command, args = [], env, onLog }) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
  let buf = '';
  const transport = {
    kind: 'stdio',
    child,
    send(payload) {
      child.stdin.write(payload + '\n');
    },
    close() { try { child.kill('SIGTERM'); } catch { /* 已退出 */ } },
    alive() { return child.exitCode === null && child.signalCode === null; },
  };
  child.stdout.on('data', (data) => {
    buf += data.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try { dispatchMessage(transport.serverRef, JSON.parse(line)); }
      catch (e) { if (onLog) onLog(`非 JSON 输出: ${line.slice(0, 120)}`); }
    }
  });
  child.stderr.on('data', (d) => {
    transport.stderrTail = (transport.stderrTail + d.toString()).slice(-2000);
    if (onLog) onLog(d.toString().trim());
  });
  return transport;
}

// ── Streamable HTTP 传输 ──
// auth（T7 OAuth 引擎注入，均可缺省）：
//   getHeader() -> 'Bearer xxx' | null  —— 每次发送前取有效令牌（静态 headers 已带 Authorization 时不覆盖）
//   refresh()   -> 'Bearer xxx' | null  —— 401 时强制续期，成功重试一次，仍 401 抛 mcpAuthRequired
function createHttpTransport({ name, url, headers = {}, onLog, auth }) {
  const base = String(url || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('HTTP 传输需要服务地址（url）');
  let sessionId = '';
  const transport = {
    kind: 'http',
    async send(payload, requestId) {
      const call = (bearer) => fetch(base, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
          ...headers,
          ...(bearer ? { Authorization: bearer } : {}),
        },
        body: payload,
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      let res = await call(auth && !headers.Authorization ? await auth.getHeader() : null);
      if (res.status === 401 && auth) {
        await res.text().catch(() => {});
        const fresh = await auth.refresh().catch(() => null);
        if (fresh) res = await call(fresh);
        if (res.status === 401) {
          await res.text().catch(() => {});
          const err = new Error('授权无效或已过期（HTTP 401），请在连接器面板重新授权该服务');
          err.mcpAuthRequired = true;
          throw err;
        }
      }
      // 会话建立：initialize 的响应头带 Mcp-Session-Id，后续请求必须回带
      const sid = res.headers.get('mcp-session-id');
      if (sid) sessionId = sid;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // H-4：会话失效（服务端已丢弃 Mcp-Session-Id，常见于服务重启/会话超时）→ 404。
        // 规范要求：MUST 重新 initialize（不带 session id）后重试。这里只把「会话失效」标记出来，
        // 由 mcpClient 的 mcpRpcWithSessionRetry 统一重新握手，避免传输层自己发起握手造成递归。
        if (res.status === 404 && sessionId && requestId !== undefined) {
          const err = new Error(`MCP 会话已失效（HTTP 404${text ? `: ${text.slice(0, 120)}` : ''}），将重新握手`);
          err.mcpSessionExpired = true;
          throw err;
        }
        // 通知（无 id）没有响应：JSON-RPC 规范里它的失败不影响主流程。
        // 实测部分服务端对 notifications/initialized 直接回 404/405（只有真实请求才建会话），
        // 若按错误抛出会把「通知被拒」误报成「连接失败」。
        if (requestId === undefined) {
          if (onLog) onLog(`通知返回 HTTP ${res.status}（按规范忽略）`);
          return;
        }
        throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
      }
      const ctype = String(res.headers.get('content-type') || '');
      if (/text\/event-stream/i.test(ctype)) {
        // SSE：逐事件解析 data: 行，命中对应 id 即完成；流保持到服务端关闭
        await consumeSse(res, (msg) => dispatchMessage(transport.serverRef, msg));
        return;
      }
      // 单 JSON 响应
      const text = await res.text();
      if (!text.trim()) return; // 通知（notifications/*）的 202 无 body：不是错误，别刷日志
      try { dispatchMessage(transport.serverRef, JSON.parse(text)); }
      catch (e) { if (onLog) onLog(`非 JSON 响应: ${text.slice(0, 120)}`); }
    },
    close() { /* HTTP 无子进程；会话随进程结束（DELETE 语义属服务端可选实现，不强制） */ },
    // H-4：重新 initialize 前必须清掉旧会话 id，否则新握手仍带着已失效的会话
    resetSession() { sessionId = ''; },
    alive() { return true; },
    stderrTail: '',
  };
  return transport;
}

// 解析 SSE 流：事件 → JSON
//
// 2026-10-17 真机修复（远程 MCP 大面积连不上的根因）：
//   SSE 规范允许三种行尾（LF / CRLF / CR），实测 DeepWiki 用 **CRLF**——原实现只按 '\n\n' 切分，
//   CRLF 下事件分隔是 '\r\n\r\n'（序列为 \r \n \r \n，不含连续 '\n\n'），于是**永远切不开**：
//   initialize 的响应到了却没人解析 → 卡满 30s 报「MCP initialize 超时」。
//   而返回单 JSON 的服务端（24haowan）正常 ⇒ 现象恰好表现为「一部分能连、一部分连不上」。
// 同时按规范处理一个事件内多行 data（用 '\n' 拼接后再 parse）与注释/event/id/retry 行。
async function consumeSse(res, onData, onNamedEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const handleEvent = (raw) => {
    let evtName = 'message';
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) { evtName = line.slice(6).trim() || 'message'; continue; }
      if (!line.startsWith('data:')) continue; // id: / retry: / ':' 注释行一律跳过
      dataLines.push(line.slice(5).replace(/^ /, '')); // 规范：冒号后首个空格是分隔符
    }
    if (!dataLines.length) return;
    const data = dataLines.join('\n').trim();
    // 命名事件（SSE 传输的 `endpoint`）的 data 是路径而非 JSON-RPC，交给调用方
    if (evtName !== 'message' && typeof onNamedEvent === 'function') { onNamedEvent(evtName, data); return; }
    if (!data || data === '[DONE]') return;
    try { onData(JSON.parse(data)); } catch { /* 非 JSON 事件忽略 */ }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // 行尾归一后再切事件。归一化是幂等的；跨 chunk 被截断的 '\r' 会在下一轮重新归一，
    // 最坏情况只是把一个事件提前切开一次，data 内容仍完整（已推演边界）。
    buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const events = buf.split('\n\n');
    buf = events.pop();
    for (const evt of events) handleEvent(evt);
  }
  if (buf.trim()) handleEvent(buf); // 流结束时没有尾随空行
}

// ── SSE 传输（旧版 HTTP+SSE，即 MIN_PROTOCOL_VERSION 那一代的 http 形态）──
//
// 与 streamableHttp 的区别（为什么必须单独一个 transport）：
//   · streamableHttp：一个 POST 携带一条消息，响应在同一次 POST 里回来（JSON 或 SSE 流）；
//   · SSE：先 GET 建一条长连接，服务端用 `event: endpoint` 告知消息投递路径，
//     之后客户端 POST 到该路径，**响应从那条长连接回来**。
// 两者的 endpoint 发现与发送语义完全不同，共用一个 transport 会把两种情况都做错。
//
// 2026-10-17 新增：WorkBuddy 目录里有 11 条 `type: sse` 的服务，此前被直接跳过（导入时排除），
// 用户点不到。这里补上，按官方实现顺序：GET → 等 endpoint → POST。
function createSseTransport({ name, url, headers = {}, onLog, auth }) {
  const base = String(url || '').trim();
  if (!base) throw new Error('SSE 传输需要服务地址（url）');
  let endpoint = '';
  let closed = false;
  let started = false;
  let abortCtl = null;
  let readyResolve = null;
  let readyReject = null;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  ready.catch(() => { /* 未消费的 rejection 会刷 unhandledRejection 日志，这里兜住 */ });

  const withAuth = async (extra) => {
    const h = { ...extra, ...headers };
    if (auth && !headers.Authorization) {
      const bearer = await auth.getHeader().catch(() => null);
      if (bearer) h.Authorization = bearer;
    }
    return h;
  };

  const transport = {
    kind: 'sse',
    // 由 connectMcpServer 在 transportObj.serverRef 赋值后调用：
    // 必须等到 serverRef 就绪才能 dispatch（否则事件到达时找不到分发表）
    ensureStarted() {
      if (started) return;
      started = true;
      abortCtl = new AbortController();
      (async () => {
        const res = await fetch(base, { headers: await withAuth({ Accept: 'text/event-stream' }), signal: abortCtl.signal });
        if (res.status === 401) {
          const err = new Error('授权无效或已过期（HTTP 401），请在连接器面板重新授权该服务');
          err.mcpAuthRequired = true;
          throw err;
        }
        if (!res.ok) throw new Error(`SSE 建流失败：HTTP ${res.status}`);
        if (!res.body || typeof res.body.getReader !== 'function') throw new Error('SSE 建流失败：响应不是流');
        await consumeSse(
          res,
          (msg) => dispatchMessage(transport.serverRef, msg),
          (evtName, data) => {
            if (evtName !== 'endpoint') return;
            // data 可能是相对路径（`/messages?sessionId=xxx`）——按建流地址解析成绝对 URL
            try { endpoint = new URL(data, base).toString(); } catch { endpoint = data; }
            if (onLog) onLog(`SSE endpoint: ${endpoint}`);
            readyResolve();
          },
        );
      })()
        .catch((e) => {
          closed = true;
          if (!endpoint) readyReject(e);
          else if (onLog) onLog(`SSE 流已断开：${e.message}`);
        })
        .finally(() => { closed = true; });
    },
    async send(payload, requestId) {
      await ready; // endpoint 未就绪时先等（initialize 也走这条路）
      if (closed) throw new Error('SSE 连接已断开，请重新连接该服务');
      const isNotification = requestId === undefined;
      const post = (h) => fetch(endpoint, {
        method: 'POST',
        headers: { ...h, 'Content-Type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      let res = await post(await withAuth({}));
      if (res.status === 401 && auth) {
        await res.text().catch(() => {});
        const fresh = await auth.refresh().catch(() => null);
        if (fresh) res = await post({ ...headers, Authorization: fresh });
        if (res.status === 401) {
          await res.text().catch(() => {});
          const err = new Error('授权无效或已过期（HTTP 401），请在连接器面板重新授权该服务');
          err.mcpAuthRequired = true;
          throw err;
        }
      }
      // 规范：消息投递成功即 202；部分实现回 200/204，也算成功
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (isNotification) { if (onLog) onLog(`通知返回 HTTP ${res.status}（按规范忽略）`); return; }
        throw new Error(`SSE 发送失败：HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
      }
      await res.text().catch(() => {});
    },
    close() {
      closed = true;
      try { abortCtl?.abort(); } catch { /* 已关闭 */ }
    },
    alive() { return started && !closed; },
    stderrTail: '',
  };
  return transport;
}

// ── 连接（IPC 处理器与启动重连共用）──
// transport: 'stdio'（默认，command/args/env）| 'http'（url/headers）
async function connectMcpServer({
  name, transport = 'stdio', command, args = [], env = {}, url, headers = {},
  auth, onStatus, onLog,
}) {
  if (!name || typeof name !== 'string') return { ok: false, error: 'name 必填' };
  if (servers.has(name)) {
    const cached = servers.get(name);
    // 缓存命中前校验底层是否还活着（stdio 子进程可能已崩；http 恒活但会话可能失效）
    const alive = cached.transport && cached.transport.alive();
    if (alive) {
      // P2-5：握手在途时不能直接返回 toolCount:0（调用方会当成「已连接但无工具」）。
      // 等它就绪；若等待超时或期间断开 → 转走重建路径（下面 servers.delete 之后的正常连接流程）。
      if (cached.handshakeDone === false && cached.ready) {
        let ready = false;
        try {
          ready = (await Promise.race([
            cached.ready,
            new Promise((r) => setTimeout(() => r(false), HANDSHAKE_WAIT_MS)),
          ])) === true;
        } catch { ready = false; }
        if (ready && cached.transport && cached.transport.alive()) {
          return { ok: true, server: name, toolCount: cached.tools.length, tools: cached.tools, cached: true };
        }
        console.warn(`[MCP ${name}] 缓存命中但握手未完成或期间断开，转为重新连接`);
        servers.delete(name);
      } else {
        return { ok: true, server: name, toolCount: cached.tools.length, tools: cached.tools, cached: true };
      }
    }
    console.warn(`[MCP ${name}] 缓存命中但底层已断开，转为重新连接`);
    servers.delete(name);
  }

  let transportObj;
  try {
    transportObj = transport === 'http'
      ? createHttpTransport({ name, url, headers, onLog, auth })
      : transport === 'sse'
        ? createSseTransport({ name, url, headers, onLog, auth })
        : createStdioTransport({ name, command, args, env: env, onLog });
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const server = {
    name,
    kind: transportObj.kind,
    transport: transportObj,
    pending: new Map(),
    nextId: 1,
    tools: [],
    // P1-8：清洗名 → 真实工具名（H-4 要求客户端有映射层）；未清洗时为空 Map
    toolNameMap: new Map(),
    stderrTail: '',
    handshakeDone: false,
    // P2-5：就绪信号（connectMcpServer 内新建）。缓存命中时若握手仍在途，等它完成再返回，
    // 否则会把 `toolCount: 0` 当成「连上了但没有工具」返回给调用方。
    ready: null,
    // P1-8②③：握手协商结果（由 performHandshake 写入，上层可查询）
    // protocolVersion 只放**服务端实际返回值**；我们提议的值单独存，避免把提议当协商结果。
    protocolVersion: '',
    proposedProtocolVersion: '',
    // legacy：服务端拒绝 2025-11-25 后已降级为 MIN_PROTOCOL_VERSION（仅一次，留痕可查）
    legacy: false,
    legacyRetried: false,
    capabilities: {},
    serverInfo: {},
    toolsChangedAt: 0,
    lastProgress: null,
    // P1-8④：此前恒 null → dispatchMessage 的通知分支永不进入（服务端通知全被丢弃）
    onNotify: (msg) => handleServerMessage(server, msg, { onLog }),
  };
  transportObj.serverRef = server; // 传输层回环到分发器
  // SSE 需要主动建流（GET），且必须在 serverRef 就绪之后——否则 endpoint/消息事件到达时无处分发
  transportObj.ensureStarted?.();
  // 握手阶段进程就没了（命令不存在 / 坏 shebang / 立刻崩）→ 立刻结算挂起的 RPC。
  // 不这么做的后果（2026-10-17 实测）：spawn ENOENT 明明几百毫秒就发生，但 initialize 要
  // 干等满 30s 超时，最后返回「MCP initialize 超时（30s）」——错误信息把「进程根本起不来」
  // 误报成「服务不响应」，用户按超时去排查网络/服务端，方向全错。
  const failHandshake = (message) => {
    if (server.handshakeDone) return;
    for (const [id, cb] of [...server.pending]) {
      server.pending.delete(id);
      try { cb({ error: { message } }); } catch (e) { /* 回调所属请求已结束 */ }
    }
  };
  // stderr 尾巴由**传输层**写入（transport.stderrTail），server.stderrTail 从来没人写。
  // 此前读 server.stderrTail 恒为空 ⇒ 「握手阶段退出」与「启动失败」的真实原因被吞掉，
  // 用户只看到 code=1 而看不到服务端自己打印的报错。统一从传输层取。
  const stderrTailOf = () => String((transportObj && transportObj.stderrTail) || server.stderrTail || '');
  if (transportObj.kind === 'stdio') {
    transportObj.child.on('close', (code) => {
      servers.delete(name);
      const wasConnected = server.handshakeDone === true;
      console.log(`[MCP ${name}] 进程退出 code=${code}${wasConnected ? '（运行期崩溃，工具已失效）' : '（握手阶段退出）'}`);
      if (wasConnected) {
        if (server.disconnecting) return; // 主动断开：不上报 crashed
        if (onStatus) onStatus(name, 'crashed', code);
      } else {
        const tail = stderrTailOf().trim().slice(0, 300);
        failHandshake(`MCP 服务进程在握手阶段退出（code=${code}）${tail ? `：${tail}` : ''}`);
      }
    });
    transportObj.child.on('error', (err) => {
      servers.delete(name);
      console.error(`[MCP ${name}] 启动失败:`, err.message);
      if (server.handshakeDone === true) {
        if (server.disconnecting) return; // 主动断开：不上报 crashed
        if (onStatus) onStatus(name, 'crashed', null);
      } else {
        // spawn ENOENT 就是这条路径：命令/解释器不存在
        failHandshake(`MCP 服务启动失败：${err.message}`);
      }
    });
  }
  // P2-5：就绪信号必须在 set 之前建好——缓存分支可能在握手完成前就命中这个条目
  let markServerReady;
  server.ready = new Promise((resolve) => { markServerReady = resolve; });
  servers.set(name, server);

  try {
    // 1. initialize（采纳服务端返回的版本/能力/自述；被拒时最多一次 legacy 降级）→ 2. initialized → 3. tools/list
    await negotiateHandshake(server);
    await refreshTools(server);
    server.handshakeDone = true;
    markServerReady(true);
    return {
      ok: true, server: name, kind: server.kind, toolCount: server.tools.length, tools: server.tools,
      protocolVersion: server.protocolVersion, proposedProtocolVersion: server.proposedProtocolVersion,
      legacy: server.legacy, serverInfo: server.serverInfo, capabilities: server.capabilities,
    };
  } catch (err) {
    // H-4：版本不受支持 → 这里就是规范要求的 disconnect（关传输 + 摘注册表）
    markServerReady(false);
    transportObj.close();
    servers.delete(name);
    return {
      ok: false, error: err.message, needsAuth: err.mcpAuthRequired === true,
      unsupportedVersion: err.mcpVersionUnsupported === true, legacy: !!server.legacy,
      stderr: stderrTailOf(),
    };
  }
}

function getMcpServer(name) { return servers.get(name) || null; }
function listMcpServers() { return [...servers.keys()]; }

function disconnectMcpServer(name) {
  const s = servers.get(name);
  if (s) {
    // 主动断开不是崩溃：打标记后让 close 回调不再上报 crashed，
    // 否则「用户点了断开」会在渲染层显示成红色故障（P0-5④ 的状态消费会把两者混为一谈）。
    s.disconnecting = true;
    s.transport.close();
    servers.delete(name);
  }
}

// 应用退出：终止全部 stdio 子进程（SIGTERM → 1s 后 SIGKILL），防孤儿进程占端口
function killAllMcpServers() {
  let killed = 0;
  for (const [, s] of servers) {
    const t = s?.transport;
    if (!t || t.kind !== 'stdio' || !t.child) continue;
    try {
      const child = t.child;
      if (child.exitCode !== null || child.signalCode !== null) continue;
      // 应用退出不是崩溃：避免退出瞬间给渲染层刷一批「服务已崩溃」的红色状态
      s.disconnecting = true;
      child.kill('SIGTERM');
      killed += 1;
      setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        } catch { /* 已退出 */ }
      }, 1000).unref();
    } catch (e) {
      console.warn(`[MCP ${s.name}] 退出清理失败:`, e.message);
    }
  }
  if (killed > 0) console.log(`[MCP] 退出清理：已终止 ${killed} 个 MCP 子进程`);
  return killed;
}

module.exports = {
  mcpRpc, mcpRpcWithSessionRetry, dispatchMessage, handleServerMessage,
  createStdioTransport, createHttpTransport, consumeSse,
  connectMcpServer, getMcpServer, listMcpServers, disconnectMcpServer, killAllMcpServers,
  refreshTools, sanitizeToolName, resolveToolName, recoverSession,
  PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, DEFAULT_TIMEOUT_MS,
};
