#!/usr/bin/env node
// P1-1 / P1-2 门禁：V 层在「主对话通道」与「Worker 通道」的接线。
//
// 背景（第四轮审查报告 §3.2）：
//   P1-1 主对话通道 L3 未接线 —— verifyRun 的 l3Chat 默认 null，无注入即降级 skipped，
//        「做对了没」只到 L1 对账，语义级正确性无独立复核。
//   P1-2 Worker 通道 V 层 off —— 子任务（编排产出）无任何对账，只靠主任务 L1 兜底。
//
// 本门禁锁四件事：
//   ① 主对话通道默认档为 l3，且注入 l3Chat/l3Model + 风险门（源码断言，防改回去）；
//   ② Worker 通道默认档为 l1（不再是 off），且注入 l3 能力（源码断言）；
//   ③ 风险门语义：命中对外/不可逆动作才跑 L3，良性台账不跑，l1 档位永远不跑（行为断言）；
//   ④ 端到端：风险台账 + 已注入 chat → 结果里 l3.skipped=false 且 triggered=true（验收口径）。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { runVerification } = require(path.join(DESKTOP, 'main/verifyRun.js'));
const verifyPolicy = require(path.join(DESKTOP, 'main/verifyPolicy.js'));

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.log(`[FAIL] ${name}\n       ${e.message}`); }
}
async function checkAsync(name, fn) {
  total++;
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.log(`[FAIL] ${name}\n       ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const read = (rel) => fs.readFileSync(path.join(DESKTOP, rel), 'utf8');

// ── ① 主对话通道接线（源码断言）──
check("P1-1：主对话通道默认档为 'l3'，且注入 l3Chat/l3Model/l3Gate", () => {
  const src = read('main/agentRunner.js');
  assert(/defaultLevel:\s*'l3'/.test(src), "agentRunner 未把主对话通道默认档升为 'l3'");
  assert(/l3Chat:\s*l3\.l3Chat/.test(src), 'agentRunner 未注入 l3Chat');
  assert(/l3Model:\s*l3\.l3Model/.test(src), 'agentRunner 未注入 l3Model');
  assert(/l3Gate:\s*\(ctx\)\s*=>\s*verifyPolicy\.shouldRunL3/.test(src), 'agentRunner 未接风险门 l3Gate');
  assert(/deps\.l3Target/.test(src), 'agentRunner 未接 l3Target 工厂');
});

// ── ② Worker 通道接线（源码断言）──
check("P1-2：Worker 通道默认档为 'l1'（不再 off），且注入 l3 能力", () => {
  // 2026-10-21（第八轮 B-02）：workerPool 逼近 800 行软档，V 层装配整体搬至
  // main/workerVerify.js（语义逐字等价）。断言按新契约拆分：
  //   ① workerPool 仍委托（搬走不是断线）；② 装配细节与默认档在 workerVerify 内被守护。
  // 任一处缺失都仍判红 —— 不是放宽，是把同一不变量钉在新位置。
  const src = read('main/workerPool.js');
  assert(/createWorkerVerifyRun\(\{\s*deps,\s*runKey,\s*sessionKey,\s*runCwd\s*\}\)/.test(src),
    'workerPool 未委托 createWorkerVerifyRun（V 层接线断了）');
  const v = read('main/workerVerify.js');
  assert(/defaultLevel:\s*'l1'/.test(v), "workerVerify 默认档未升为 'l1'");
  assert(!/defaultLevel:\s*'off'/.test(v), 'workerVerify 仍残留默认 off');
  assert(/l3Chat:\s*l3\.l3Chat/.test(v), 'workerVerify 未注入 l3Chat');
  assert(/verifyPolicy\.shouldRunL3/.test(v), 'workerVerify 未接风险门');
});

// ── ③ 风险门语义（行为断言，策略层是纯函数）──
check('P1-1 风险门：命中对外/不可逆动作才跑 L3', () => {
  const r = verifyPolicy.shouldRunL3({
    level: 'l3', verdict: 'PASS', ledger: [{ name: 'git_push', ok: true }],
    trigger: { risk: true, sampleRate: 0 },
  });
  assert(r.run === true && r.why === 'risk', `风险台账未触发 L3：${JSON.stringify(r)}`);
});

check('P1-1 风险门：良性台账（仅本地写）不跑 L3（无抽样）', () => {
  const r = verifyPolicy.shouldRunL3({
    level: 'l3', verdict: 'PASS', ledger: [{ name: 'write_file', ok: true }],
    trigger: { risk: true, sampleRate: 0 },
  });
  assert(r.run === false && r.why === 'not_triggered', `良性台账不应触发：${JSON.stringify(r)}`);
});

check('P1-1 风险门：失败的对外动作（ok!==true）不算风险', () => {
  const r = verifyPolicy.shouldRunL3({
    level: 'l3', verdict: 'PASS', ledger: [{ name: 'git_push', ok: false }],
    trigger: { risk: true, sampleRate: 0 },
  });
  assert(r.run === false, `失败的副作用不该多花钱：${JSON.stringify(r)}`);
});

check('P1-1/P1-2 风险门：l1 档位永远不问闸门、永远不跑 L3', () => {
  const r = verifyPolicy.shouldRunL3({
    level: 'l1', verdict: 'PASS', ledger: [{ name: 'git_push', ok: true }],
    trigger: { risk: true, sampleRate: 0 },
  });
  assert(r.run === false && r.why === 'level_not_l3', `l1 不应跑 L3：${JSON.stringify(r)}`);
});

// ── ④ 端到端：风险台账 + 已注入 chat → l3.triggered=true 且 skipped=false ──
const E = (name, o = {}) => ({
  name, ok: o.ok !== false, ms: 5, round: 1,
  paths: o.paths || [], command: o.command || '', exitCode: null,
});
const PASS_REPLY = { content: '{"verdict":"PASS","reasons":[]}' };
const riskGate = (ctx) => verifyPolicy.shouldRunL3({ ...ctx, trigger: { risk: true, sampleRate: 0 } });

await checkAsync('P1-1 端到端：高风险台账（git_push）触发 L3 且 skipped=false', async () => {
  let calls = 0;
  const r = await runVerification({
    runId: 'p1-1', level: 'l3', warn: () => {},
    ledger: [E('git_push', { command: 'git push origin main' })],
    finalText: '已推送并完成',
    diff: null,
    l3: { chat: async () => { calls += 1; return PASS_REPLY; } },
    l3Gate: riskGate,
  });
  assert(calls === 1, `L3 应恰好调用一次，got=${calls}`);
  assert(r.l3 && r.l3.triggered === true && r.l3.skipped === false,
    `验收口径：高风险任务 l3.status 不得为 skipped，实际 ${JSON.stringify(r.l3)}`);
});

await checkAsync('P1-1 端到端：良性台账 → 触发闸不放行（triggered=false，零调用）', async () => {
  let calls = 0;
  const r = await runVerification({
    runId: 'p1-1b', level: 'l3', warn: () => {},
    ledger: [E('write_file', { paths: ['/w/a.js'] })],
    finalText: '已修改 a.js',
    diff: { statusPorcelain: ' M a.js', stat: '1 file' },
    l3: { chat: async () => { calls += 1; return PASS_REPLY; } },
    l3Gate: riskGate,
  });
  assert(calls === 0, `良性台账不该调用 L3，got=${calls}`);
  assert(r.l3 && r.l3.triggered === false, `应标记未触发：${JSON.stringify(r.l3)}`);
});

console.log(`\np1-vlayer-wiring: ${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
