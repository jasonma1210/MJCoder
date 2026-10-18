#!/usr/bin/env node
// V 层 L3 的宿主侧集成（J3）：验证 verifyRun 的编排决策，而不是 L3 内部逻辑
//
// 三件必须成立的事：
//   ① L1 已 BLOCK 时**不**跑 L3 —— 已经拦住了，再花一次模型调用是纯浪费；
//   ② level='l3' 但未注入 chat → 只做 L1，并在结果里如实标记 skipped（不谎称跑过）；
//   ③ level='l1' → 完全不受 L3 影响（零额外调用、零行为变化）。
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { runVerification } = require(path.join(DESKTOP, 'main/verifyRun.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const E = (name, o = {}) => ({
  name, ok: o.ok !== false, ms: 5, round: 1,
  paths: o.paths || [], command: o.command || '',
  exitCode: o.exitCode === undefined ? null : o.exitCode,
});
const FLAG_REPLY = { content: '{"verdict":"FLAG","reasons":[{"claim":"改了 a.js","problem":"台账里没有成功写入","severity":"high"}]}' };

// ── ① L1 PASS + L3 FLAG → 标注追加、l3 结果透传 ─────────
{
  let l3Calls = 0;
  const r = await runVerification({
    runId: 'r1', level: 'l3', warn: () => {},
    ledger: [E('write_file', { paths: ['/w/a.js'] })],
    finalText: '已修改 a.js，完成',
    diff: { statusPorcelain: ' M a.js', stat: '1 file changed' },
    l3: { chat: async () => { l3Calls += 1; return FLAG_REPLY; } },
  });
  check('L1 通过后确实调用了 L3', l3Calls === 1, `l3Calls=${l3Calls}`);
  check('L3 FLAG 会追加可见提示', /独立复核/.test(r.finalText), r.finalText.slice(-60));
  check('结果里带 l3 明细供下游消费', r.l3?.verdict === 'FLAG' && r.l3.reasons.length === 1);
  check('L1 的 verdict 不被 L3 改写（L3 只是提示，不改判）', r.verdict === 'PASS');
}

// ── ② L1 BLOCK 时不跑 L3（省一次调用）─────────────────
{
  let l3Calls = 0;
  const r = await runVerification({
    runId: 'r2', level: 'l3', warn: () => {},
    ledger: [],
    finalText: '已修改 a.js，完成',
    diff: null,
    l3: { chat: async () => { l3Calls += 1; return FLAG_REPLY; } },
  });
  check('L1 BLOCK 时**完全不调用** L3', l3Calls === 0, `l3Calls=${l3Calls}`);
  check('BLOCK 判定与提示照常（不受 L3 未跑影响）',
    r.verdict === 'BLOCK' && /自检提示/.test(r.finalText));
}

// ── ③ level=l3 但未注入 chat → 只跑 L1 且明确标记 skipped ──
{
  const warns = [];
  const r = await runVerification({
    runId: 'r3', level: 'l3', warn: (m) => warns.push(String(m)),
    ledger: [E('write_file', { paths: ['/w/a.js'] })],
    finalText: '已修改 a.js，完成',
    diff: { statusPorcelain: ' M a.js', stat: '1 file' },
  });
  check('未注入 chat：结果标记 l3.skipped + no_chat',
    r.l3?.skipped === true && r.l3?.reason === 'no_chat');
  check('未注入 chat：有明确告警（不静默）',
    warns.some((w) => /l3Chat/.test(w)), warns.join(' | ').slice(0, 80));
  check('未注入 chat：L1 结果仍正常', r.verdict === 'PASS' && !/独立复核/.test(r.finalText));
}

// ── ④ level=l1 完全不受影响 ──────────────────────────
{
  let l3Calls = 0;
  const r = await runVerification({
    runId: 'r4', level: 'l1', warn: () => {},
    ledger: [E('write_file', { paths: ['/w/a.js'] })],
    finalText: '已修改 a.js，完成',
    diff: { statusPorcelain: ' M a.js', stat: '1 file' },
    l3: { chat: async () => { l3Calls += 1; return FLAG_REPLY; } },
  });
  check('level=l1 即使注入了 chat 也不调用', l3Calls === 0);
  check('level=l1 结果无 l3 字段', r.l3 === undefined);
}

console.log(`\nverify-l3-integration: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;
