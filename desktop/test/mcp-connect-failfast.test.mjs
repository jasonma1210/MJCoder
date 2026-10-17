// MCP 连接「握手阶段失败」必须快速返回且给出真实原因（2026-10-17 用户实测 ima 反馈）。
//
// 背景：`connectMcpServer` 原本只处理「连上之后崩溃」，握手阶段子进程就没了时，
// 挂起的 initialize 请求没有人结算 → 调用方干等满 30s，最后拿到
// 「MCP initialize 超时（30s）」。这个错误信息把「进程根本起不来」误报成
// 「服务不响应」，用户会照着超时去查网络/服务端，方向完全错。
//
// 触发场景都是真实存在的：命令写错（npm 包名不存在）、node 不在 PATH、
// 坏 shebang、服务端缺依赖秒退。所以这条不是边界情况，是常见失败路径。
//
// 断言三件事：① 快（远小于 30s 超时）② 原因准确（不是「超时」）③ 仍 fail-closed（ok:false）
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mcp = require(path.join(DESKTOP, 'main/mcpClient.js'));

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}
async function acheck(name, fn) {
  total++;
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

// 30s 是 mcpRpc 的默认超时；「快」的阈值取 3s：既远小于超时，又给慢机器留余量。
const FAST_MS = 3000;

await acheck('命令不存在（spawn ENOENT）→ 快速失败且报「启动失败」，不报超时', async () => {
  const t0 = Date.now();
  const r = await mcp.connectMcpServer({ name: 'probe-missing-bin', command: '/nonexistent-mcp-bin-xyz', args: [], env: {} });
  const ms = Date.now() - t0;
  if (ms > FAST_MS) throw new Error(`耗时 ${ms}ms，超过 ${FAST_MS}ms（说明仍走 30s 超时路径）`);
  if (r.ok !== false) throw new Error(`应 fail-closed，实际 ok=${r.ok}`);
  if (/超时/.test(r.error || '')) throw new Error(`错误信息误报为超时：「${r.error}」`);
  if (!/启动失败|ENOENT/.test(r.error || '')) throw new Error(`错误信息未说明真实原因：「${r.error}」`);
});

await acheck('进程启动后立刻退出 → 快速失败且报「握手阶段退出」', async () => {
  const t0 = Date.now();
  // 用当前 node 执行一个立刻退出的脚本，模拟「服务端缺依赖/配置错」秒退
  const r = await mcp.connectMcpServer({
    name: 'probe-instant-exit', command: process.execPath, args: ['-e', 'process.exit(3)'], env: {},
  });
  const ms = Date.now() - t0;
  if (ms > FAST_MS) throw new Error(`耗时 ${ms}ms，超过 ${FAST_MS}ms`);
  if (r.ok !== false) throw new Error(`应 fail-closed，实际 ok=${r.ok}`);
  if (!/握手阶段退出|进程.*退出/.test(r.error || '')) throw new Error(`错误信息未说明进程已退出：「${r.error}」`);
});

check('失败后不残留注册表条目（否则后续同名连接会命中死缓存）', () => {
  if (mcp.listMcpServers().includes('probe-missing-bin')) throw new Error('失败的服务仍留在 servers 注册表');
  if (mcp.listMcpServers().includes('probe-instant-exit')) throw new Error('失败的服务仍留在 servers 注册表');
});

console.log(`\nmcp-connect-failfast: ${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
