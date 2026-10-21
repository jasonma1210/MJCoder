// 第八轮 D-804 S2–S5：MCP 双栈（无状态 2026-07-28 + 握手 2025-11-25）互通门禁
//
// 要防的形态：支持集里写了 `2026-07-28` 但**实际连不上**——典型「声称但无守护」。
// 所以本节不是断言常量，而是**起两个真实本地 HTTP 服务端**跑真连接：
//   A. 新服务端：认 `server/discover`，不认 `initialize`（新版已移除）。
//      → 必须走无状态栈：不收到 initialize、不带 Mcp-Session-Id、带 Mcp-Method 路由头。
//   B. 老服务端：不认 `server/discover`（回 400），认 initialize 并下发 session id。
//      → 必须回落到握手栈，且**不能**把无状态版本号当成已协商版本发出去。
// 另加 S4 的能力声明分叉：无状态栈不得再声明 roots / logging（新版已弃用）。
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DESKTOP = path.resolve(import.meta.dirname, '..');
const mcp = require(path.join(DESKTOP, 'main/mcpClient.js'));
const proto = require(path.join(DESKTOP, 'main/mcpProtocol.js'));

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const readBody = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
});

function startServer(handler) {
  const srv = http.createServer((req, res) => { handler(req, res, readBody); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })));
}

const reply = (res, id, result) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
};

(async () => {
  // ── A. 新服务端（无状态 2026-07-28）──
  {
    const seen = { methods: [], initCount: 0, sessionHeaders: [], routeHeaders: [], versionHeaders: [] };
    const { srv, port } = await startServer(async (req, res, bodyOf) => {
      const msg = await bodyOf(req);
      seen.methods.push(msg.method);
      if (msg.method === 'initialize') seen.initCount += 1;
      if (req.headers['mcp-session-id']) seen.sessionHeaders.push(req.headers['mcp-session-id']);
      if (req.headers['mcp-method']) seen.routeHeaders.push(req.headers['mcp-method']);
      if (req.headers['mcp-protocol-version']) seen.versionHeaders.push(req.headers['mcp-protocol-version']);

      if (msg.method === 'server/discover') {
        // 新版的 discover 取代 initialize：回协议版本 + 能力 + 自述
        reply(res, msg.id, {
          protocolVersion: proto.NEXT_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'stateless-mock', version: '1.0.0' },
        });
        return;
      }
      if (msg.method === 'tools/list') {
        reply(res, msg.id, { tools: [{ name: 'echo', description: '回显', inputSchema: { type: 'object' } }] });
        return;
      }
      // 新版不认 initialize：明确拒绝（若实现错误地走握手栈，这里会让它失败）
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32601, message: 'method not found: initialize' } }));
    });

    const r = await mcp.connectMcpServer({ name: 't-stateless', transport: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: {} });
    check('A 新服务端：连接成功并列出工具', r.ok && r.toolCount === 1, r.error || '');
    check('A 新服务端：走无状态栈（result.stateless）', r.stateless === true, String(r.stateless));
    check('A 新服务端：协商到 2026-07-28', r.protocolVersion === proto.NEXT_PROTOCOL_VERSION, String(r.protocolVersion));
    check('A 新服务端：**完全没有发 initialize**（新版已移除握手）',
      seen.initCount === 0, `initialize 次数=${seen.initCount}`);
    check('A 新服务端：**没有带 Mcp-Session-Id**（无状态语义）',
      seen.sessionHeaders.length === 0, `session 头 ${seen.sessionHeaders.length} 次`);
    check('A 新服务端：带了 MCP-Protocol-Version 头且值为 2026-07-28',
      seen.versionHeaders.length > 0 && seen.versionHeaders.every((v) => v === proto.NEXT_PROTOCOL_VERSION),
      seen.versionHeaders.slice(0, 3).join(','));
    check('A 新服务端：按新规范带 Mcp-Method 路由头',
      seen.routeHeaders.includes('server/discover') && seen.routeHeaders.includes('tools/list'),
      seen.routeHeaders.join(','));

    // 工具调用同样走无状态（再多验一次，防止只有握手阶段对、调用阶段退回有状态）
    const s = mcp.getMcpServer('t-stateless');
    const call = await mcp.mcpRpc(s, 'tools/list', {});
    check('A 新服务端：后续 RPC 仍在无状态栈上', Array.isArray(call.tools) && seen.initCount === 0);
    mcp.disconnectMcpServer('t-stateless');
    srv.close();
  }

  // ── B. 老服务端（握手 2025-11-25）──
  {
    const seen = { discoverCount: 0, initCount: 0, sessionHeaders: 0, versionHeaders: [] };
    const { srv, port } = await startServer(async (req, res, bodyOf) => {
      const msg = await bodyOf(req);
      if (msg.method === 'server/discover') {
        seen.discoverCount += 1;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32601, message: 'method not found' } }));
        return;
      }
      if (msg.method === 'initialize') {
        seen.initCount += 1;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-legacy' });
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'legacy-mock', version: '0.9' } },
        }));
        return;
      }
      if (msg.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
      if (msg.method === 'tools/list') {
        if (req.headers['mcp-session-id']) seen.sessionHeaders += 1;
        if (req.headers['mcp-protocol-version']) seen.versionHeaders.push(req.headers['mcp-protocol-version']);
        reply(res, msg.id, { tools: [{ name: 'legacy_tool', description: '老工具', inputSchema: { type: 'object' } }] });
        return;
      }
      res.writeHead(404); res.end();
    });

    const r = await mcp.connectMcpServer({ name: 't-legacy', transport: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: {} });
    check('B 老服务端：回落握手栈后连接成功', r.ok && r.toolCount === 1, r.error || '');
    check('B 老服务端：result.stateless = false（明确标注走的是握手栈）', r.stateless === false, String(r.stateless));
    check('B 老服务端：确实探测过无状态（server/discover 1 次后失败）', seen.discoverCount === 1, String(seen.discoverCount));
    check('B 老服务端：随后走 initialize', seen.initCount === 1, String(seen.initCount));
    check('B 老服务端：握手后回带 Mcp-Session-Id', seen.sessionHeaders >= 1, String(seen.sessionHeaders));
    check('B 老服务端：协议版本头是**协商到的 2025-11-25**，不是无状态的 2026-07-28',
      seen.versionHeaders.length > 0 && seen.versionHeaders.every((v) => v === '2025-11-25'),
      seen.versionHeaders.slice(0, 3).join(','));
    mcp.disconnectMcpServer('t-legacy');
    srv.close();
  }

  // ── C. S4 能力声明按版本分叉（纯函数）──
  {
    const legacy = proto.clientCapabilitiesFor('2025-11-25');
    const modern = proto.clientCapabilitiesFor(proto.NEXT_PROTOCOL_VERSION);
    check('C 握手栈仍声明 roots / logging（老服务端要靠 roots 协商文件系统）',
      'roots' in legacy && 'logging' in legacy);
    check('C 无状态栈不再声明 roots / logging（S4：新版已弃用）',
      !('roots' in modern) && !('logging' in modern), Object.keys(modern).join(','));
    check('C 无状态能力 = 握手能力 − deprecatedInNext（集合等式，防分叉写歪）',
      JSON.stringify(Object.keys(modern).sort())
      === JSON.stringify(Object.keys(legacy).filter((k) => !proto.MCP_PROTOCOL_ROADMAP.deprecatedInNext.includes(k)).sort()),
      `modern=${Object.keys(modern).join('/')}`);
    check('C completion 两条栈都保留（新版仍需要，且有既有应答实现）', 'completion' in modern && 'completion' in legacy);
  }

  // ── D. 传输层真有无状态开关（不是只在协议常量里记账）──
  {
    const { createHttpTransport } = require(path.join(DESKTOP, 'main/mcpHttpTransport.js'));
    const t = createHttpTransport({ name: 'probe', url: 'http://127.0.0.1:1/mcp' });
    check('D http 传输暴露 setStateless / isStateless（S2 的载体）',
      typeof t.setStateless === 'function' && typeof t.isStateless === 'function');
    t.setStateless(true, proto.NEXT_PROTOCOL_VERSION);
    check('D setStateless(true) 生效', t.isStateless() === true);
    t.setStateless(false);
    check('D setStateless(false) 复位（否则回落握手时会带错版本号）', t.isStateless() === false);
  }

  console.log(`\nmcp-dual-stack: ${pass}/${pass + fail} 通过`);
  if (fail > 0) process.exitCode = 1;
  void assert;
})();
