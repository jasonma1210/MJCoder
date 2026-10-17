// 远程 MCP 传输回归（2026-10-17）
//
// 两个真机上「大量 MCP 连不上」的根因，在这里各锁一条：
//
// ① SSE 行尾：规范允许 LF / CRLF / CR。实测 DeepWiki 用 **CRLF**，而旧实现只按 '\n\n' 切分
//    ——CRLF 的事件分隔是 '\r\n\r\n'（不含连续 '\n\n'），事件永远切不开 → initialize 卡满 30s
//    报「MCP initialize 超时」。返回单 JSON 的服务端却正常，于是表现为「有的能连有的不能」。
//
// ② initialize 之后的 notifications/initialized：旧实现**只对 stdio 发**。
//    宽容的服务端（24haowan）不校验，严格的服务端会拒绝后续 tools/list。
//
// 用本地 http server 造三种响应形态，不触外网（CI 可跑、结果确定）。
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

const TOOLS = [
  { name: 'search_templates', description: '搜索模板', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
  { name: 'get_template', description: '取模板', inputSchema: { type: 'object', properties: {} } },
];

/**
 * 造一个最小可用的 streamable-http MCP 服务端。
 * @param {'sse-crlf'|'sse-lf'|'json'} mode 响应形态
 */
function startServer(mode) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      seen.push(msg.method);

      // 通知：规范允许 202 无 body
      if (!msg.id && String(msg.method || '').startsWith('notifications/')) {
        res.writeHead(202).end();
        return;
      }
      const result = msg.method === 'initialize'
        ? {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'local-fake', version: '0.0.1' },
        }
        : msg.method === 'tools/list'
          ? { tools: TOOLS }
          : null;
      if (!result) { res.writeHead(404).end(); return; }

      const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
      if (mode === 'json') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(payload);
        return;
      }
      // SSE 两种行尾
      const nl = mode === 'sse-crlf' ? '\r\n' : '\n';
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(`event: message${nl}data: ${payload}${nl}${nl}`);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }));
  });
}

async function roundTrip(mode) {
  const { server, port, seen } = await startServer(mode);
  const name = `fake-${mode}`;
  try {
    const r = await connectMcpServer({ name, transport: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: {} });
    return { r, seen };
  } finally {
    disconnectMcpServer(name);
    server.close();
  }
}

// ── ① SSE 三种行尾 ──
const crlf = await roundTrip('sse-crlf');
check('SSE + CRLF（DeepWiki 形态）：能完成握手并列出工具', () => {
  eq(crlf.r.ok, true, `连接失败：${crlf.r.error || ''}`);
  eq(crlf.r.toolCount, TOOLS.length);
});

const lf = await roundTrip('sse-lf');
check('SSE + LF：不回归', () => {
  eq(lf.r.ok, true, `连接失败：${lf.r.error || ''}`);
  eq(lf.r.toolCount, TOOLS.length);
});

const js = await roundTrip('json');
check('单 JSON 响应（24haowan 形态）：不回归', () => {
  eq(js.r.ok, true, `连接失败：${js.r.error || ''}`);
  eq(js.r.toolCount, TOOLS.length);
});

// ── ② initialized 通知必须发（HTTP 也要发） ──
check('HTTP 传输在 initialize 之后发送 notifications/initialized', () => {
  ok(crlf.seen.includes('initialize'), '未发 initialize');
  ok(crlf.seen.includes('notifications/initialized'), `实际顺序：${crlf.seen.join(' → ')}`);
  ok(crlf.seen.includes('tools/list'), '未发 tools/list');
});

// ── ③ 工具形状：进对话前必须能被转成 function 定义 ──
check('工具定义保留 inputSchema（缺失会被转成空参数，模型无法正确调用）', () => {
  const t = crlf.r.tools.find((x) => x.name === 'search_templates');
  ok(t, '未返回 search_templates');
  ok(t.inputSchema && t.inputSchema.type === 'object', 'inputSchema 丢失');
});

// ── ④ 401 必须被识别成「需要授权」而不是一般网络错误 ──
{
  const s = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => res.writeHead(401, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: 'invalid_token' })));
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  const r = await connectMcpServer({ name: 'fake-401', transport: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: {} });
  s.close();
  check('401 → 连接失败且错误里带 HTTP 401（上层据此提示重新授权）', () => {
    eq(r.ok, false);
    ok(/401/.test(String(r.error || '')), `错误文案没有状态码：${r.error}`);
  });
}

console.log(`\n结果：${pass}/${total} 通过`);
