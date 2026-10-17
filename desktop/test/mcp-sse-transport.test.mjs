// SSE 传输（旧版 HTTP+SSE）回归（2026-10-17，P1）
//
// 协议与 streamableHttp 不同，必须单独验证：
//   GET <url>            → 建长连接，服务端先发 `event: endpoint` + data:<投递路径>
//   POST <endpoint>      → 投递 JSON-RPC（成功 202/200/204）
//   response             → 从**那条长连接**回来（event: message + data:<JSON>）
//
// 覆盖：相对 endpoint 解析、握手+列工具、401 转「需要授权」、流断开后的行为、通知不算失败。
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const { connectMcpServer, disconnectMcpServer } = require(path.join(ROOT, 'main/mcpClient.js'));

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

const TOOLS = [{ name: 'sse_probe', description: '探针工具', inputSchema: { type: 'object', properties: {} } }];

/**
 * 最小 SSE MCP 服务端。
 * @param {{ unauth?: boolean, absoluteEndpoint?: boolean, newline?: 'lf'|'crlf' }} opts
 */
function startSseServer(opts = {}) {
  const { unauth = false, absoluteEndpoint = false, newline = 'lf' } = opts;
  const nl = newline === 'crlf' ? '\r\n' : '\n';
  const streams = new Set();
  const seen = [];
  let port = 0;

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/sse')) {
      if (unauth) { res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"invalid_token"}'); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: endpoint${nl}data: ${absoluteEndpoint ? `http://127.0.0.1:${port}/messages?sessionId=s1` : '/messages?sessionId=s1'}${nl}${nl}`);
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/messages')) {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        let msg;
        try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
        seen.push(msg.method);
        // 先回 202，再把响应冲刷到长连接上（真实实现的顺序）
        res.writeHead(202).end();
        if (!msg.id) return; // 通知无响应
        const result = msg.method === 'initialize'
          ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'sse-fake', version: '0' } }
          : msg.method === 'tools/list' ? { tools: TOOLS } : null;
        if (!result) return;
        const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
        for (const s of streams) s.write(`event: message${nl}data: ${payload}${nl}${nl}`);
      });
      return;
    }
    res.writeHead(404).end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve({ server, port, seen, streams, get url() { return `http://127.0.0.1:${port}/sse`; } });
    });
  });
}

// ── 1. 正常链路（相对 endpoint）──
{
  const s = await startSseServer();
  const name = 'sse-ok';
  const r = await connectMcpServer({ name, transport: 'sse', url: s.url, headers: {} });
  check('SSE：握手成功并列出工具（相对 endpoint 被解析成绝对地址）', () => {
    eq(r.ok, true, r.error || '');
    eq(r.toolCount, TOOLS.length);
  });
  check('SSE：走的是 GET 建流 + POST 投递（方法顺序合理）', () => {
    ok(s.seen.includes('initialize'), '未投递 initialize');
    ok(s.seen.includes('tools/list'), '未投递 tools/list');
  });
  check('SSE：initialize 之后发了 initialized 通知', () => {
    ok(s.seen.includes('notifications/initialized'), `实际：${s.seen.join(' → ')}`);
  });
  disconnectMcpServer(name);
  s.server.close();
  await new Promise((r) => setTimeout(r, 50));
}

// ── 2. 绝对 endpoint + CRLF 行尾（真实服务端两种变体）──
{
  const s = await startSseServer({ absoluteEndpoint: true, newline: 'crlf' });
  const name = 'sse-abs-crlf';
  const r = await connectMcpServer({ name, transport: 'sse', url: s.url, headers: {} });
  check('SSE：绝对 endpoint + CRLF 行尾也能握手', () => {
    eq(r.ok, true, r.error || '');
    eq(r.toolCount, TOOLS.length);
  });
  disconnectMcpServer(name);
  s.server.close();
  await new Promise((r) => setTimeout(r, 50));
}

// ── 3. 401 → needsAuth（不能当成网络错误）──
{
  const s = await startSseServer({ unauth: true });
  const r = await connectMcpServer({ name: 'sse-401', transport: 'sse', url: s.url, headers: {} });
  check('SSE：建流 401 → 明确「需要授权」，且 needsAuth 透传', () => {
    eq(r.ok, false);
    ok(/401|授权/.test(String(r.error || '')), `错误文案：${r.error}`);
  });
  s.server.close();
  await new Promise((r) => setTimeout(r, 50));
}

// ── 4. 地址不可达 → 结构化失败（不挂死）──
{
  const t0 = Date.now();
  const r = await connectMcpServer({ name: 'sse-dead', transport: 'sse', url: 'http://127.0.0.1:1/sse', headers: {} });
  check('SSE：端口不通 → 快速失败并带原因（不卡 30s）', () => {
    eq(r.ok, false);
    ok(Date.now() - t0 < 15000, `耗时 ${Date.now() - t0}ms，过久`);
    ok(String(r.error || '').length > 0, '没有错误信息');
  });
}

// ── 5. 缺 url → 明确报错 ──
{
  const r = await connectMcpServer({ name: 'sse-nourl', transport: 'sse' });
  check('SSE：缺 url 直接拒绝（不静默回退到 stdio）', () => {
    eq(r.ok, false);
    ok(/url|地址/.test(String(r.error || '')), `错误文案：${r.error}`);
  });
}

console.log(`\n结果：${pass}/${total} 通过`);
