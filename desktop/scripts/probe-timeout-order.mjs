// 探针：判定「工具看门狗」与「组级等待超时」谁先到点，以及看门狗到点后编排组是否被 abort。
//
// 复跑：node scripts/probe-timeout-order.mjs
//
// 为什么可以把 30min 缩短到毫秒：两个时长都是注入参数
//   · 看门狗：agent-core 的 TOOL_TIMEOUT_OVERRIDES.orchestrate_task = 1800000
//   · 组等待：orchestrator/invoke.js 的 DEFAULT_TIMEOUT_MS = 1800000
// 同值时「谁先到点」只取决于 **timer 注册顺序**，与毫秒数无关，故 300ms 的结论对 30min 同样成立。
//
// 结论（2026-10-17 实测，Node 22.22.2 / darwin）：
//   A 同值 300/300 → 看门狗先 reject（301ms），内层 306ms 才因自身超时收尾 ⇒ 看门狗先到点，且组未被 abort
//   B 看门狗更短 200/300 → 看门狗 200ms 先到，内层 306ms 才收尾 ⇒ 同上
//   C 组等待更短 300/150（即「组超时 = 看门狗 × 0.8」形态）→ 组等待 152ms 先 settle，看门狗从未触发
// 推论：
//   ① `agent-core` 注释「组级超时先于看门狗生效」与实测不符（同值时看门狗必先，因为它的 timer 先注册）；
//   ② 0.8 倍只改变「谁先到点」，**不改变「没人 abort 组」**——超时路径必须显式 abortGroup 才能真正止血。
import { createRequire } from 'node:module';
import path from 'node:path';

const DESKTOP = path.dirname(import.meta.dirname);
const { withTimeout } = await import(path.join(DESKTOP, 'agent-core/index.js'));
const require = createRequire(import.meta.url);
const { waitGroupSettled, DEFAULT_TIMEOUT_MS } = require(path.join(DESKTOP, 'main/orchestrator/invoke.js'));

console.log(`默认值：DEFAULT_TIMEOUT_MS = ${DEFAULT_TIMEOUT_MS}ms（${DEFAULT_TIMEOUT_MS / 60000}min）`);

// 假 store：组状态由外部时间点翻转为 done，模拟「组还在派发、稍后才收尾」
function makeStore(doneAt) {
  return { getGroup: () => ({ status: Date.now() >= doneAt ? 'done' : 'running' }) };
}

async function scenario(name, { watchdogMs, groupTimeoutMs, groupFinishesAtMs }) {
  const t0 = Date.now();
  const store = makeStore(t0 + groupFinishesAtMs);

  // 复刻 agent-core 的工具执行形态：withTimeout(工具实现)，工具实现内部再调 waitGroupSettled
  let innerSettledAt = null;
  let innerResult = null;
  const inner = waitGroupSettled(store, 'g', { timeoutMs: groupTimeoutMs, pollIntervalMs: 10 })
    .then((r) => { innerSettledAt = Date.now() - t0; innerResult = r; return r; });

  let outerRejectedAt = null;
  try {
    await withTimeout(inner, watchdogMs, 'orchestrate_task');
  } catch {
    outerRejectedAt = Date.now() - t0;
  }
  await new Promise((r) => setTimeout(r, Math.max(groupFinishesAtMs, groupTimeoutMs) + 120));

  const first = outerRejectedAt != null && (innerSettledAt == null || outerRejectedAt <= innerSettledAt)
    ? '看门狗'
    : '组级等待';
  console.log(`\n[${name}]`);
  console.log(`  看门狗 ${watchdogMs}ms / 组等待 ${groupTimeoutMs}ms / 组实际收尾 ${groupFinishesAtMs}ms`);
  console.log(`  看门狗 reject 于 ${outerRejectedAt ?? '—'}ms；内层 settle 于 ${innerSettledAt ?? '—'}ms`);
  console.log(`  ⇒ 先到点：${first}`);
  console.log(`  ⇒ 看门狗到点后内层是否仍在跑：${innerSettledAt != null ? `是（未被 abort，${innerSettledAt}ms 才收尾）` : '否'}`);
  if (innerResult) console.log(`  ⇒ 内层最终结果：${JSON.stringify(innerResult)}`);
}

await scenario('A 同值 300/300（生产默认形态：30min = 30min）', {
  watchdogMs: 300, groupTimeoutMs: 300, groupFinishesAtMs: 900,
});
await scenario('B 看门狗更短 200/300', {
  watchdogMs: 200, groupTimeoutMs: 300, groupFinishesAtMs: 900,
});
await scenario('C 组等待更短 300/150（第 3 章 R1 建议的 0.8 倍形态）', {
  watchdogMs: 300, groupTimeoutMs: 150, groupFinishesAtMs: 900,
});
