#!/usr/bin/env node
// MCP 会话恢复互斥回归（P2-5）
//
// 缺陷：HTTP 传输收到 404 时每个请求各自 resetSession + initialize。并发 N 个 404 →
// N 次握手，`sessionId` 闭包变量被后完成者覆盖，先完成的那次会话可能已被服务端作废 →
// 再次 404；而重试预算只有一次，于是这批请求全部失败（偶发工具调用失败）。
//
// 本套件锁死：并发只重建一次；串行每次都要重建；失败只抛给发起者、不让等待者误以为成功。
import { recoverSession } from '../main/mcpClient.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkServer() {
  const counters = { resets: 0, handshakes: 0 };
  const server = {
    name: 'srv',
    transport: { resetSession() { counters.resets += 1; } },
  };
  return { server, counters };
}

// ① 并发 3 个 404：只应重置 1 次、握手 1 次
{
  const { server, counters } = mkServer();
  const handshake = async () => { counters.handshakes += 1; await sleep(30); };
  await Promise.all([
    recoverSession(server, 'v1', { handshake }),
    recoverSession(server, 'v1', { handshake }),
    recoverSession(server, 'v1', { handshake }),
  ]);
  check('并发 404 只重建一次（resetSession=1 / handshake=1）',
    counters.resets === 1 && counters.handshakes === 1,
    `实际 reset=${counters.resets} handshake=${counters.handshakes}`);
}

// ② 串行：每次都要重建（互斥不能变成"只重建一次就永久跳过"）
{
  const { server, counters } = mkServer();
  const handshake = async () => { counters.handshakes += 1; };
  await recoverSession(server, 'v1', { handshake });
  await recoverSession(server, 'v1', { handshake });
  check('串行两次 404 → 重建两次（互斥不吞后续恢复）',
    counters.resets === 2 && counters.handshakes === 2,
    `实际 reset=${counters.resets} handshake=${counters.handshakes}`);
}

// ③ 失败语义：发起者收到错误；等待者不静默成功
{
  const { server, counters } = mkServer();
  const boom = async () => { counters.handshakes += 1; await sleep(20); throw new Error('handshake failed'); };
  const first = recoverSession(server, 'v1', { handshake: boom });
  const second = recoverSession(server, 'v1', { handshake: boom });

  let firstErr = false;
  let secondThrew = false;
  try { await first; } catch { firstErr = true; }
  try { await second; } catch { secondThrew = true; }

  check('握手失败：发起者收到错误（不静默成功）', firstErr === true);
  check('握手失败：等待者不重复握手，且不被误判为成功',
    counters.handshakes === 1 && secondThrew === false,
    `handshake=${counters.handshakes} secondThrew=${secondThrew}`);
}

// ④ 恢复后状态清空（下一次 404 能再次重建）
{
  const { server } = mkServer();
  const handshake = async () => {};
  await recoverSession(server, 'v1', { handshake });
  check('恢复完成后清空在途标记', server._sessionRecovery === null || server._sessionRecovery === undefined);
}

console.log(`\nmcp-session-recovery: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;
