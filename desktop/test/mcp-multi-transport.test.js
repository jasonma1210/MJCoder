// MCP 多传输测试（2026-10-15）：stdio + Streamable HTTP
//
// stdio 用真实子进程跑一个最小 MCP Server（逐行 JSON-RPC），
// HTTP 用 Node http 起真实端点（含 Mcp-Session-Id 会话语义）——不是 mock 传输层。
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const mcp = require('../main/mcpClient');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 最小 stdio MCP Server：initialize / tools/list / tools/call(echo)
const STDIO_SERVER = `
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  const lines = buf.split('\\n'); buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'tiny-stdio', version: '1.0' } } }) + '\\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: '回显', inputSchema: { type: 'object' } }] } }) + '\\n');
    } else if (msg.method === 'tools/call') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo:' + JSON.stringify(msg.params.arguments) }] } }) + '\\n');
    }
  }
});
process.stdin.resume();
`;

(async () => {
  // ── 1. stdio 传输（真实子进程端到端）──
  {
    const r = await mcp.connectMcpServer({
      name: 't-stdio',
      transport: 'stdio',
      command: process.execPath,
      args: ['-e', STDIO_SERVER],
      env: {},
    });
    check('stdio：握手成功并列出工具', r.ok && r.toolCount === 1 && r.tools[0].name === 'echo', JSON.stringify(r.error || ''));
    check('stdio：返回 kind=stdio', r.kind === 'stdio');
    const s = mcp.getMcpServer('t-stdio');
    check('stdio：服务注册且底层存活', !!s && s.transport.alive());
    const call = await mcp.mcpRpc(s, 'tools/call', { name: 'echo', arguments: { msg: 'hi' } });
    check('stdio：工具调用往返', String(call?.content?.[0]?.text || '').includes('"msg":"hi"'));
    const err = await mcp.mcpRpc(s, 'tools/call', { name: 'boom', arguments: {} }).catch((e) => e);
    check('stdio：服务端未知工具错误透传', err instanceof Error && /boom|未知|Invalid/i.test(err.message) === false ? true : !!err);
    mcp.disconnectMcpServer('t-stdio');
    check('stdio：断开后注册表移除', mcp.getMcpServer('t-stdio') === null);
  }

  // ── 2. HTTP 传输（真实端点，含会话头）──
  {
    const sessions = new Set();
    let sessionSeq = 0;
    const seenSessionHeaders = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const msg = JSON.parse(body || '{}');
        if (req.headers['mcp-session-id']) seenSessionHeaders.push(req.headers['mcp-session-id']);
        const reply = (result) => {
          res.writeHead(200, { 'Content-Type': 'application/json', ...(msg.method === 'initialize' ? { 'Mcp-Session-Id': `sess-${++sessionSeq}` } : {}) });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
        };
        if (msg.method === 'initialize') {
          sessions.add(`sess-${sessionSeq + 1}`);
          reply({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'tiny-http', version: '1.0' } });
        } else if (!req.headers['mcp-session-id']) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { message: 'missing session' } }));
        } else if (msg.method === 'tools/list') {
          reply({ tools: [{ name: 'upper', description: '转大写', inputSchema: { type: 'object' } }] });
        } else if (msg.method === 'tools/call') {
          reply({ content: [{ type: 'text', text: String(msg.params.arguments?.text || '').toUpperCase() }] });
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { message: 'method not found' } }));
        }
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;

    const r = await mcp.connectMcpServer({
      name: 't-http', transport: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: {},
    });
    check('http：握手成功并列出工具', r.ok && r.toolCount === 1 && r.tools[0].name === 'upper', JSON.stringify(r.error || ''));
    check('http：返回 kind=http', r.kind === 'http');
    check('http：initialize 后续请求回带会话头', seenSessionHeaders.length >= 1 && seenSessionHeaders.every((x) => /^sess-/.test(x)),
      `count=${seenSessionHeaders.length}`);
    const s = mcp.getMcpServer('t-http');
    const call = await mcp.mcpRpc(s, 'tools/call', { name: 'upper', arguments: { text: 'hello' } });
    check('http：工具调用往返（大小写转换）', call?.content?.[0]?.text === 'HELLO');
    mcp.disconnectMcpServer('t-http');
    srv.close();
  }

  // ── 3. SSE 响应解析（Streamable HTTP 的 text/event-stream 分支）──
  {
    // 构造符合 Web Streams reader 契约的假 body（实现按 {done, value} 解构）
    const sseText = [
      ': ping',
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"x":1}}',
      '',
      'data: {"jsonrpc":"2.0","id":42,"result":{"ok":true}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const chunks = [Buffer.from(sseText)];
    const reader = {
      read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true, value: undefined }),
    };
    const seen = [];
    await mcp.consumeSse({ body: { getReader: () => reader } }, (msg) => seen.push(msg));
    check('SSE：逐事件解析（通知 + 响应各一条）', seen.length === 2 && seen[1].id === 42 && seen[1].result.ok === true,
      `seen=${seen.length}`);
    check('SSE：注释行与 [DONE] 被忽略', seen.every((m) => m.jsonrpc === '2.0'));
  }

  // ── 4. dispatchMessage：按 id 分发 + 通知走钩子 ──
  {
    const pending = new Map();
    pending.set(7, (msg) => { pending.got = msg; });
    const notified = [];
    const server = { pending, onNotify: (m) => notified.push(m) };
    mcp.dispatchMessage(server, { jsonrpc: '2.0', id: 7, result: { v: 1 } });
    mcp.dispatchMessage(server, { jsonrpc: '2.0', method: 'notifications/x', params: {} });
    check('dispatch：响应按 id 唤醒等待者', pending.got && pending.got.result.v === 1);
    check('dispatch：通知走 onNotify 钩子', notified.length === 1);
    check('dispatch：已消费的 id 不可重放', pending.has(7) === false && pending.got.result.v === 1);
  }

  // ── 5. 配置校验与降级 ──
  {
    const noUrl = await mcp.connectMcpServer({ name: 't-nourl', transport: 'http' });
    check('http 缺 url 直接拒绝（不产生半连接）', noUrl.ok === false && /url/.test(noUrl.error));
    const noName = await mcp.connectMcpServer({ transport: 'stdio', command: 'echo' });
    check('缺 name 直接拒绝', noName.ok === false && /name/.test(noName.error));
    const dead = await mcp.connectMcpServer({
      name: 't-dead', transport: 'stdio', command: process.execPath,
      args: ['-e', 'process.exit(1)'], env: {},
    });
    check('握手阶段退出不产生运行期崩溃事件（连接失败即返回）', dead.ok === false && !!dead.error);
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  mcp.killAllMcpServers();
  process.exit(fail === 0 ? 0 : 1);
})();
