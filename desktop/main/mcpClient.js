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

const servers = new Map(); // name -> server 实例（跨传输统一注册表）

const PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_TIMEOUT_MS = 30000;

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

// ── SSE 传输（旧版 HTTP+SSE，MCP 2024-11-05 的 http 形态）──
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
      return { ok: true, server: name, toolCount: cached.tools.length, tools: cached.tools, cached: true };
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
    stderrTail: '',
    handshakeDone: false,
    onNotify: null,
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
  if (transportObj.kind === 'stdio') {
    transportObj.child.on('close', (code) => {
      servers.delete(name);
      const wasConnected = server.handshakeDone === true;
      console.log(`[MCP ${name}] 进程退出 code=${code}${wasConnected ? '（运行期崩溃，工具已失效）' : '（握手阶段退出）'}`);
      if (wasConnected) {
        if (onStatus) onStatus(name, 'crashed', code);
      } else {
        const tail = String(server.stderrTail || '').trim().slice(0, 300);
        failHandshake(`MCP 服务进程在握手阶段退出（code=${code}）${tail ? `：${tail}` : ''}`);
      }
    });
    transportObj.child.on('error', (err) => {
      servers.delete(name);
      console.error(`[MCP ${name}] 启动失败:`, err.message);
      if (server.handshakeDone === true) {
        if (onStatus) onStatus(name, 'crashed', null);
      } else {
        // spawn ENOENT 就是这条路径：命令/解释器不存在
        failHandshake(`MCP 服务启动失败：${err.message}`);
      }
    });
  }
  servers.set(name, server);

  try {
    // 1. initialize → 2. notifications/initialized → 3. tools/list（三步分离，各自超时）
    await mcpRpc(server, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mj-coder', version: '1.0' },
    });
    // 2026-10-17：streamableHttp 与 stdio 一样，initialize 之后必须发 initialized 通知。
    // 此前只对 stdio 发：宽容的服务端（24haowan）不校验，严格的服务端会拒绝后续 tools/list。
    Promise.resolve(transportObj.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })))
      .catch((e) => { console.warn('[MCP] initialized 通知发送失败（不影响主流程）:', e.message); });
    const listRes = await mcpRpc(server, 'tools/list', {});
    server.tools = listRes?.tools || [];
    server.handshakeDone = true;
    return { ok: true, server: name, kind: server.kind, toolCount: server.tools.length, tools: server.tools };
  } catch (err) {
    transportObj.close();
    servers.delete(name);
    return { ok: false, error: err.message, needsAuth: err.mcpAuthRequired === true, stderr: server.stderrTail };
  }
}

function getMcpServer(name) { return servers.get(name) || null; }
function listMcpServers() { return [...servers.keys()]; }

function disconnectMcpServer(name) {
  const s = servers.get(name);
  if (s) { s.transport.close(); servers.delete(name); }
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
  mcpRpc, dispatchMessage,
  createStdioTransport, createHttpTransport, consumeSse,
  connectMcpServer, getMcpServer, listMcpServers, disconnectMcpServer, killAllMcpServers,
  PROTOCOL_VERSION, DEFAULT_TIMEOUT_MS,
};
