// 第七轮审查 F-006 / B1-B-04 门禁：MCP Streamable HTTP 必须带 `MCP-Protocol-Version`
//
// 规范（MCP 2025-06-18 起）：客户端在 initialize 之后发往服务端的**每一个** HTTP 请求
//   MUST 带 `MCP-Protocol-Version: <协商到的版本>`。不带的话，严格实现直接回 400，
//   而本仓 `main/mcpProtocol.js` 明确声称支持四代版本——「声明支持」与「按规范发头」
//   不一致就是能力虚报（F-006）。
//
// 本套件用本地 http stub 记录**每个请求的头**，锁四条语义：
//   ① initialize 请求本身**不带**该头（此时协商值还不存在）；
//   ② initialize **之后**的请求（notifications/initialized、tools/list）**都带**，且值等于
//      stub 在 initialize 响应里返回的 protocolVersion（不拿本端提议值冒充）；
//   ③ 值随协商结果走：换个 stub 返回另一版本 → 头跟着变（防「写死 2025-11-25 恰好过测」）；
//   ④ 服务端**未声明**版本（老服务端）→ 其后请求也不带该头（旧服务端兼容，不硬塞）。
//
// 不触外网：stub 监听 127.0.0.1:0（随机端口），结束必然 server.close()，不留挂起进程。
// 反向验证（人工做过一次，见交付说明）：删掉 mcpClient.js 里那行取值，本套件必须变红。
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const { connectMcpServer, disconnectMcpServer } = require(path.join(ROOT, 'main/mcpClient.js'));

const HEADER = 'mcp-protocol-version';

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try {
    fn();
    console.log(`[PASS] ${name}`);
    pass++;
  } catch (e) {
    console.error(`[FAIL] ${name} — ${e.message}`);
    process.exitCode = 1;
  }
}
const eq = (a, b, m = '') => { if (a !== b) throw new Error(`${m} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };
const ok = (v, m) => { if (!v) throw new Error(m || '断言为假'); };

const TOOLS = [
  { name: 'get_time', description: '取当前时间', inputSchema: { type: 'object', properties: {} } },
  { name: 'search', description: '搜索', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
];

/**
 * 最小可用 streamable-http MCP stub。
 * @param {string} peerVersion initialize 响应里回给客户端的协议版本（空串=服务端未声明）
 * @returns {Promise<{server: import('node:http').Server, port: number,
 *                    seen: Array<{method: string, header: string|undefined}>}>}
 */
function startStub(peerVersion) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      // 逐请求记录「方法 + 该头的值」——本套件的全部断言都基于这张表
      seen.push({ method: String(msg.method || ''), header: req.headers[HEADER] });

      // 通知：规范允许 202 无 body
      if (!msg.id && String(msg.method || '').startsWith('notifications/')) {
        res.writeHead(202).end();
        return;
      }
      let result = null;
      if (msg.method === 'initialize') {
        result = {
          // peerVersion 为空时**不带 protocolVersion 字段**，模拟未声明版本的老服务端
          ...(peerVersion ? { protocolVersion: peerVersion } : {}),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'local-stub', version: '0.0.1' },
        };
      } else if (msg.method === 'tools/list') {
        result = { tools: TOOLS };
      }
      if (!result) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }));
  });
}

/** 起 stub → 连一次 → 断连关 stub，返回握手结果与逐请求头记录。 */
async function roundTrip(name, peerVersion) {
  const { server, port, seen } = await startStub(peerVersion);
  try {
    const r = await connectMcpServer({ name, transport: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: {} });
    return { r, seen };
  } finally {
    disconnectMcpServer(name);
    await new Promise((resolve) => server.close(resolve));
  }
}

const pick = (seen, method) => seen.filter((x) => x.method === method);

// ── ① + ② 主用例：服务端回 2025-11-25 ──
const main = await roundTrip('pv-2025-11-25', '2025-11-25');

check('握手成功且协商结果被采纳（前置条件）', () => {
  eq(main.r.ok, true, `连接失败：${main.r.error || ''}`);
  eq(main.r.protocolVersion, '2025-11-25');
  eq(main.r.toolCount, TOOLS.length);
});

check('① initialize 请求本身不带 MCP-Protocol-Version（协商值尚不存在）', () => {
  const inits = pick(main.seen, 'initialize');
  eq(inits.length, 1, 'initialize 次数');
  ok(inits[0].header === undefined, `initialize 竟然带了该头：${inits[0].header}`);
});

check('② notifications/initialized 带 MCP-Protocol-Version = 2025-11-25', () => {
  const notified = pick(main.seen, 'notifications/initialized');
  eq(notified.length, 1, 'initialized 通知次数');
  eq(notified[0].header, '2025-11-25');
});

check('② tools/list 带 MCP-Protocol-Version = 2025-11-25', () => {
  const lists = pick(main.seen, 'tools/list');
  ok(lists.length >= 1, '未发 tools/list');
  for (const l of lists) eq(l.header, '2025-11-25', 'tools/list 该头取值');
});

check('② 时序：只有 initialize 那一条不带，其后每一条都带', () => {
  const idx = main.seen.findIndex((x) => x.method === 'initialize');
  ok(idx >= 0, '未找到 initialize');
  const after = main.seen.slice(idx + 1);
  ok(after.length >= 2, `initialize 之后的请求数偏少：${after.length}`);
  for (const x of after) eq(x.header, '2025-11-25', `initialize 之后的 ${x.method}`);
});

// ── ③ 值来自协商结果，不是写死 ──
const other = await roundTrip('pv-2025-03-26', '2025-03-26');
check('③ 换成协商到 2025-03-26 → 头跟着变（证明值取自协商结果）', () => {
  eq(other.r.ok, true, `连接失败：${other.r.error || ''}`);
  const lists = pick(other.seen, 'tools/list');
  ok(lists.length >= 1, '未发 tools/list');
  for (const l of lists) eq(l.header, '2025-03-26');
  const inits = pick(other.seen, 'initialize');
  ok(inits[0].header === undefined, `initialize 竟然带了该头：${inits[0].header}`);
});

// ── ④ 老服务端未声明版本 → 不发该头（不能把我们提议的值硬塞过去） ──
// D-804（2026-10-21）双栈之后有一处**必须排除**的例外：无状态栈的探测请求 `server/discover`
// 天生就要带版本头——新版取消了 initialize，没有别的机会声明自己说的是哪一代。
// 所以判据改成「唯一允许带头的是那次探测，其余一律不许带」——比原判据更严格（原来只要求全不带）。
const legacy = await roundTrip('pv-undeclared', '');
check('④ 服务端未声明 protocolVersion → 其后请求不带该头（探测请求除外，见注释）', () => {
  eq(legacy.r.ok, true, `连接失败：${legacy.r.error || ''}`);
  eq(legacy.r.protocolVersion, '', '未声明时应保持空，不得用提议值冒充');
  const withHeader = legacy.seen.filter((x) => x.header !== undefined);
  const offenders = withHeader.filter((x) => x.method !== 'server/discover');
  ok(offenders.length === 0,
    `除探测外仍有请求带了该头：${offenders.map((x) => `${x.method}=${x.header}`).join(', ')}`);
  ok(withHeader.every((x) => x.header === '2026-07-28'),
    `探测请求的头应为无状态版本，实际：${withHeader.map((x) => `${x.method}=${x.header}`).join(', ')}`);
  // 反向：握手与后续业务请求必须**没有**该头（服务端没声明版本，就不能硬塞）
  ok(legacy.seen.some((x) => x.method === 'initialize' && x.header === undefined),
    'initialize 不应带该头');
});

console.log(`\n结果：${pass}/${total} 通过`);
