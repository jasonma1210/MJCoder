#!/usr/bin/env node
// 探针：判定当前看门狗是「总时长语义」还是「空闲语义」。
// 背景（2026-10-17）：mimo 等推理模型单轮 >120s 被 agent-core:1524 的 withTimeout 终止，
// 文案写「>120000ms 无响应」——但在持续流式输出时这句话是假的。本脚本用缩小 1000 倍的
// 比例复现该语义差异，不依赖网络与模型，结论可复核。
// 用法：node scripts/probe-watchdog-semantics.mjs
//
// 自检纪律：C 是反向用例（真挂起必须被杀），若 C 没在 idleMs 附近被杀，
// 说明对照实现本身写坏了 —— 首版就踩过（idle 计时被固定 interval 错误重置，
// C 被拖到总量闸才杀，看着"也红了"其实分支从未生效）。改脚本后必须重跑核对 C 的耗时量级。
import { withTimeout } from '../agent-core/index.js';

const TICK = 20;    // 每 20ms 一个 delta（模拟流式 token）
const HARD = 120;   // 缩小 1000 倍的看门狗阈值（对应生产 120000ms）

// 「一直在吐数据」的流：每次 tick 回调 onTick（模拟 bump 空闲计时）
function makeStream(ticks, interval = TICK, onTick = null) {
  let n = 0;
  let timer = null;
  const promise = new Promise((resolve) => {
    timer = setInterval(() => {
      n += 1;
      onTick?.();
      if (n >= ticks) { clearInterval(timer); timer = null; resolve(); }
    }, interval);
  });
  return { promise, stop: () => { if (timer) { clearInterval(timer); timer = null; } } };
}

// 对照实现：空闲语义（收到数据就重置 idle 计时）+ 总时长兜底
// 返回 { promise, bump }：bump 必须由「真的收到数据」驱动，不能挂固定 interval
function withIdleTimeout(promise, idleMs, totalMs) {
  let idleTimer = null, totalTimer = null;
  let bump = () => {};
  const p = new Promise((resolve, reject) => {
    const clearAll = () => { clearTimeout(idleTimer); clearTimeout(totalTimer); };
    bump = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { clearAll(); reject(new Error(`空闲超时（>${idleMs}ms 无数据）`)); }, idleMs);
    };
    totalTimer = setTimeout(() => { clearAll(); reject(new Error(`总时长上限（>${totalMs}ms）`)); }, totalMs);
    bump();
    Promise.resolve(promise).then(
      (v) => { clearAll(); resolve(v); },
      (e) => { clearAll(); reject(e); },
    );
  });
  return { promise: p, bump };
}

const results = [];
async function run(name, fn) {
  const t0 = Date.now();
  let ok = true, err = '';
  try { await fn(); } catch (e) { ok = false; err = e.message; }
  results.push({ name, ms: Date.now() - t0, ok, err });
}

// A：当前实现——流一直在吐数据，总时长 300ms > 阈值 120ms
await run('A 当前 withTimeout(120ms) + 持续有数据', async () => {
  const s = makeStream(15);
  try { await withTimeout(s.promise, HARD, '模型调用'); } finally { s.stop(); }
});

// B：空闲语义——同一场景不应被杀（每个 delta 都 bump）
await run('B 空闲语义(idle120,total1000) + 持续有数据', async () => {
  let w;
  const s = makeStream(15, TICK, () => w.bump());
  w = withIdleTimeout(s.promise, HARD, 1000);
  try { await w.promise; } finally { s.stop(); }
});

// C：反向用例——真挂起（一个 delta 都没有），必须在 idleMs 附近被杀
await run('C 空闲语义 + 真挂起（无数据）', async () => {
  await withIdleTimeout(new Promise(() => {}), HARD, 5000).promise;
});

// D：无限流——数据一直来但永不结束，总时长闸必须兜底
await run('D 空闲语义 + 无限流（总量闸 500ms）', async () => {
  let w;
  const s = makeStream(1e9, TICK, () => w.bump());
  w = withIdleTimeout(s.promise, HARD, 500);
  try { await w.promise; } finally { s.stop(); }
});

console.log('场景'.padEnd(44), '耗时'.padStart(7), '  结果');
for (const r of results) {
  console.log(r.name.padEnd(44), `${String(r.ms).padStart(5)}ms`, ' ', r.ok ? '✅ 正常完成' : `❌ ${r.err.slice(0, 50)}`);
}
const c = results.find((r) => r.name.startsWith('C'));
console.log('\n判读：');
console.log(`  A 在 ~${HARD}ms 被杀 → 当前实现只计「本轮总时长」，不看流式进度（生产表现：打字打到一半被断）`);
console.log('  B 正常完成     → 空闲语义下「同样 300ms 但一直有数据」不会被误杀');
console.log(`  C 在 ${c.ms}ms 被杀 → 真挂起仍能被识别（反向用例：防止对照实现写坏后静默变绿）`);
console.log('  D 在 ~500ms 被杀 → 无限流仍被总时长闸兜底，不会永久挂住');
