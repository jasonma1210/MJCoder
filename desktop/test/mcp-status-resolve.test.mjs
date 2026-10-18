#!/usr/bin/env node
// MCP 崩溃五态回归（P1-2）
//
// 缺陷：`crashed` 标记被「派生态 ok」遮蔽 —— `useMcpStatus.resolve` 曾有
//   `derived === 'ok' ? 'ok' : (...)` 的优先分支，而 derived 的 'ok' 来自上一次
//   listServers 的**快照**（崩溃后仍是「已连接」）。结果：崩溃徽标与重连按钮永不出现，
//   P0-5④ 五态在真机主路径上等于没做。
//
// 本套件锁三件事：
//   ① crashed 必须压过任何派生态（含 'ok'）—— 去掉修复即红
//   ② 任何后继非 crashed 事件自动撤标记（重连成功 / 主动断开）
//   ③ 事件归约的边界：非 mcp_status 忽略、缺 name 忽略、code 缺失为 null（不伪造 0）
import {
  applyMcpStatusEvent, clearMcpCrash, getMcpStatusSnapshot, resetMcpStatus, resolveMcpState,
} from '../renderer/src/lib/mcpStatusState.ts';

let total = 0;
let passed = 0;
function check(name, fn) {
  total += 1;
  try {
    fn();
    passed += 1;
    console.log(`[PASS] ${name}`);
  } catch (e) {
    console.log(`[FAIL] ${name} — ${e instanceof Error ? e.message : String(e)}`);
  }
}
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || ''} 实际=${JSON.stringify(actual)} 预期=${JSON.stringify(expected)}`);
}

// ── ① crashed 压过派生态（核心回归） ──────────────────────────
check('crashed 压过 ok：崩溃后陈旧连接列表不能把状态翻回已连接', () => {
  eq(resolveMcpState({ srv: { code: 137, ts: 1 } }, 'srv', 'ok'), 'crashed');
});
check('crashed 压过 fail/connecting/saved', () => {
  const crashed = { srv: { code: null, ts: 1 } };
  for (const d of ['fail', 'connecting', 'saved']) eq(resolveMcpState(crashed, 'srv', d), 'crashed');
});
check('无崩溃标记时派生态原样透传', () => {
  for (const d of ['ok', 'fail', 'connecting', 'saved']) eq(resolveMcpState({}, 'srv', d), d);
});
check('崩溃标记只作用于同名服务', () => {
  eq(resolveMcpState({ srv: { code: 1, ts: 1 } }, 'other', 'ok'), 'ok');
});

// ── ② 事件归约 ───────────────────────────────────────────
resetMcpStatus();
check('crashed 事件写入标记（含 exit code）', () => {
  applyMcpStatusEvent({ type: 'mcp_status', name: 'srv', status: 'crashed', code: 137, ts: 10 });
  eq(getMcpStatusSnapshot().crashed.srv?.code, 137);
});
check('崩溃期间派生态仍为 ok 时 resolve 必须给 crashed（端到端）', () => {
  const snap = getMcpStatusSnapshot();
  eq(resolveMcpState(snap.crashed, 'srv', 'ok'), 'crashed');
});
check('后继 ok 事件撤标记（重连成功）', () => {
  applyMcpStatusEvent({ type: 'mcp_status', name: 'srv', status: 'ok', ts: 11 });
  eq(getMcpStatusSnapshot().crashed.srv, undefined);
  eq(resolveMcpState(getMcpStatusSnapshot().crashed, 'srv', 'ok'), 'ok');
});

// ── ③ 边界 ───────────────────────────────────────────────
check('code 缺失记为 null，不伪造 0', () => {
  applyMcpStatusEvent({ type: 'mcp_status', name: 'x', status: 'crashed', ts: 12 });
  eq(getMcpStatusSnapshot().crashed.x?.code, null);
});
check('非 mcp_status 事件被忽略', () => {
  resetMcpStatus();
  applyMcpStatusEvent({ type: 'todos', name: 'srv', status: 'crashed' });
  eq(Object.keys(getMcpStatusSnapshot().crashed).length, 0);
});
check('缺 name 的事件被忽略（不产生空键崩溃标记）', () => {
  resetMcpStatus();
  applyMcpStatusEvent({ type: 'mcp_status', status: 'crashed' });
  eq(Object.keys(getMcpStatusSnapshot().crashed).length, 0);
});
check('clearMcpCrash 撤单个标记，不误伤其他服务', () => {
  resetMcpStatus();
  applyMcpStatusEvent({ type: 'mcp_status', name: 'a', status: 'crashed', ts: 1 });
  applyMcpStatusEvent({ type: 'mcp_status', name: 'b', status: 'crashed', ts: 2 });
  clearMcpCrash('a');
  const c = getMcpStatusSnapshot().crashed;
  eq(c.a, undefined);
  eq(c.b?.code, null);
});
check('resetMcpStatus 清空全部状态', () => {
  resetMcpStatus();
  const s = getMcpStatusSnapshot();
  eq(Object.keys(s.crashed).length, 0);
  eq(s.lastEvent, null);
});

console.log(`\n总计 ${total} · 通过 ${passed}`);
if (passed !== total) process.exit(1);
