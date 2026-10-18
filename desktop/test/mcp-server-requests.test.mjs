// P2-4 MCP 服务端 → 客户端请求应答门禁（2026-10-18 能力残差收敛）
//
// 背景：客户端此前对服务端主动发来的**所有请求**一律回 -32601——包括规范强制要求
//   应答的 ping（不回会被服务端当保活失败判死）。P2-4 补齐 ping / roots / completion
//   三项应答 + logging 能力声明；sampling / elicitation 保持显式拒绝（需要逐次同意 UI
//   与模型中继链路，是明确的非目标，不是缺位）。
//
// 本套件锁四件事：
//   ① 已实现能力的请求得到**正确结果**（ping 空结果 / roots 空清单 / completion 空补全集）；
//   ② 未实现能力（sampling / elicitation / 未知方法）仍回 -32601（绝不静默——静默 = 服务端挂死）；
//   ③ **声明 ⇔ 实现**一致性：mcpProtocol.CLIENT_CAPABILITIES 声明的能力都有应答实现，
//      应答表里的方法也都可由声明导出（防两侧漂移）；
//   ④ 通知路径不受影响（notifications/message 落日志不回执，迟到响应静默忽略）。
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const { handleServerMessage } = require(path.join(ROOT, 'main/mcpClient.js'));
const { SERVER_REQUEST_HANDLERS } = require(path.join(ROOT, 'main/mcpServerRequests.js'));
const { CLIENT_CAPABILITIES } = require(path.join(ROOT, 'main/mcpProtocol.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// 伪 server：transport.send 捕获全部出站消息；extra 用于覆写 server 字段（如 args）
function fakeServer(extra = {}) {
  const sent = [];
  return {
    server: { name: 't', transport: { send: async (payload) => { sent.push(JSON.parse(payload)); } }, ...extra },
    sent,
    async flushed() { await new Promise((r) => setImmediate(r)); return sent; },
  };
}

// ── ① 已实现能力的请求得到正确结果 ──
{
  const t = fakeServer();
  handleServerMessage(t.server, { jsonrpc: '2.0', id: 1, method: 'ping' });
  const [msg] = await t.flushed();
  check('ping 回空结果且无 error（规范强制保活应答）',
    msg && msg.id === 1 && !msg.error && typeof msg.result === 'object', JSON.stringify(msg));

  const t2 = fakeServer();
  handleServerMessage(t2.server, { jsonrpc: '2.0', id: 2, method: 'roots/list' });
  const [msg2] = await t2.flushed();
  check('roots/list 无授权目录时回空清单（诚实应答，不扩大授权面）',
    msg2 && msg2.id === 2 && Array.isArray(msg2.result?.roots) && msg2.result.roots.length === 0,
    JSON.stringify(msg2));

  // 2026-10-18 新增：服务启动参数里的绝对目录 = 该服务被授权的根 → 原样透出给服务端。
  // 此前恒回空清单，官方 filesystem 服务端据此以零目录启动（No valid root directories）。
  const realDir = os.tmpdir();
  const t2b = fakeServer({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', realDir] });
  handleServerMessage(t2b.server, { jsonrpc: '2.0', id: 22, method: 'roots/list' });
  const [msg2b] = await t2b.flushed();
  check('roots/list 透出启动参数中的真实授权目录（filesystem 不再零目录启动）',
    msg2b && Array.isArray(msg2b.result?.roots) && msg2b.result.roots.length === 1
      && msg2b.result.roots[0].uri === pathToFileURL(realDir).href
      && msg2b.result.roots[0].name === path.basename(realDir),
    JSON.stringify(msg2b));

  // 相对路径 / 不存在的路径 / 非目录一律不作根（避免把不可信参数当授权面暴露）
  const t2c = fakeServer({ args: ['relative/dir', '/no/such/dir/xyz-123', path.join(realDir, 'nope-missing')] });
  handleServerMessage(t2c.server, { jsonrpc: '2.0', id: 23, method: 'roots/list' });
  const [msg2c] = await t2c.flushed();
  check('roots/list 只认绝对且真实存在的目录（相对/不存在/非目录被过滤）',
    msg2c && Array.isArray(msg2c.result?.roots) && msg2c.result.roots.length === 0,
    JSON.stringify(msg2c));

  const t3 = fakeServer();
  handleServerMessage(t3.server, { jsonrpc: '2.0', id: 3, method: 'completion/complete', params: { ref: { type: 'ref/prompt', name: 'p' }, argument: { name: 'q', value: 'a' } } });
  const [msg3] = await t3.flushed();
  check('completion/complete 回空补全集（规范允许的最小合法应答）',
    msg3 && msg3.result?.completion?.values?.length === 0 && msg3.result.completion.total === 0
      && msg3.result.completion.hasMore === false, JSON.stringify(msg3));
}

// ── ② 未实现能力仍显式拒绝 ──
{
  for (const method of ['sampling/createMessage', 'elicitation/create', 'totally/unknown']) {
    const t = fakeServer();
    handleServerMessage(t.server, { jsonrpc: '2.0', id: 9, method });
    const [msg] = await t.flushed();
    check(`未实现能力 ${method} 回 -32601（不静默挂死服务端）`,
      msg && msg.id === 9 && msg.error?.code === -32601, JSON.stringify(msg).slice(0, 120));
  }
}

// ── ③ 声明 ⇔ 实现 一致性（防能力表与应答表漂移）──
{
  const declared = Object.keys(CLIENT_CAPABILITIES).sort();
  check('能力声明恰好为 completion/logging/roots（sampling/elicitation 不虚报）',
    JSON.stringify(declared) === JSON.stringify(['completion', 'logging', 'roots']),
    `declared=${JSON.stringify(declared)}`);
  // 请求型能力 → 应答表必须有对应方法；logging 是通知型（notifications/message 在 handleServerMessage 落日志）
  const REQUEST_OF_CAP = { roots: 'roots/list', completion: 'completion/complete' };
  for (const [cap, req] of Object.entries(REQUEST_OF_CAP)) {
    check(`声明 ${cap} ⇒ 应答表实现 ${req}`, typeof SERVER_REQUEST_HANDLERS[req] === 'function');
  }
  // 应答表不得出现声明之外的能力（ping 是协议强制，豁免）
  const extra = Object.keys(SERVER_REQUEST_HANDLERS).filter((m) => !['ping', ...Object.values(REQUEST_OF_CAP)].includes(m));
  check('应答表无声明之外的方法（ping 豁免）', extra.length === 0, `extra=${JSON.stringify(extra)}`);
}

// ── ④ 通知路径不受影响 ──
{
  const t = fakeServer();
  handleServerMessage(t.server, { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'hello' } });
  const sent = await t.flushed();
  check('notifications/message 落日志且不产生回执', sent.length === 0, `出站 ${sent.length} 条`);

  const t2 = fakeServer();
  handleServerMessage(t2.server, { jsonrpc: '2.0', id: 77 }); // 只有 id、无 method = 迟到的响应
  const sent2 = await t2.flushed();
  check('迟到响应（仅 id）静默忽略', sent2.length === 0, `出站 ${sent2.length} 条`);
}

console.log(`\nmcp-server-requests: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
