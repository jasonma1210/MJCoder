// P1-5 入口裁剪触发条件门禁（2026-10-18 全量修复）
//
// 双标问题：压缩闸是「到窗 70% 才压」，而**入口裁剪**是无条件调用且内部按 45% 裁——
//   历史刚过 45% 就被砍掉中段，45%~70% 这段本可完整保留（等于用「丢历史」换「省一点 token」）。
//   真机表现：长任务中段开始「模型忘了刚才读过什么」，反复重读同一批文件。
// 修复语义：runAgent 入口只在 > TRIM_TRIGGER_RATIO(0.7) 时才调 trimHistoryForRun；
//   trimHistoryForRun **本身**行为不变（45% 目标、下限 16000）——直接调用它仍会裁。
//
// 陷阱（规格 §4）：必须与本仓已有的 context-econ 用例共存。变的只是「入口触发条件」，
//   不是 trimHistoryForRun 的裁剪行为。本套件把两件事并列断言，防止有人把两者一起改坏。
import {
  runAgent, trimHistoryForRun, estimateMessagesTokens, TRIM_TRIGGER_RATIO,
} from '../agent-core/index.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const WINDOW = 20000;
check('TRIM_TRIGGER_RATIO === 0.7（与压缩阈值同源）', TRIM_TRIGGER_RATIO === 0.7, `got=${TRIM_TRIGGER_RATIO}`);

// 构造：31 条 assistant/user 交替消息，每条约 1500 字符 ≈ 379 tokens ⇒ 合计 ≈ 11.7k ≈ 窗口 59%
// （规格 §4 的「≈12k ≈60%」；注意「31 对」若按 62 条算会到 116% 直接触发压缩，故按 31 条构造）
const history = Array.from({ length: 31 }, (_, i) => ({
  role: i % 2 === 0 ? 'assistant' : 'user',
  content: `第 ${i} 段：${'y'.repeat(1480)}`,
}));

{
  const before = estimateMessagesTokens([{ role: 'system', content: 'SYS' }, ...history]);
  const pct = before / WINDOW;
  check(`构造落在 60% 附近且低于 70% 触发线（实测 ${(pct * 100).toFixed(1)}%）`,
    pct > 0.5 && pct < 0.7, `est=${before} window=${WINDOW}`);

  const traces = [];
  const toolHandlers = {
    chat: async () => ({ content: '收到，任务完成', usage: { prompt_tokens: before, completion_tokens: 10 } }),
  };
  const model = {
    provider: { id: 1, isGlobal: false, base_url: 'http://local' },
    model: { id: 1, model_id: 'm', context_window: WINDOW },
  };
  await runAgent({
    messages: history,
    model,
    toolHandlers,
    tokenBudget: 0,
    maxRounds: 3,
    onMessage: () => {},
    onTrace: (e) => traces.push(e),
    onDone: () => {},
    onBudget: () => {},
  });
  // 抓一次实际发出的 messages（从 chat 侧记录更可靠，这里用 trace 数量兜底）
  const trimEvents = traces.filter((e) => e.type === 'trim');
  check('60% 占用时入口不产生 trim 事件（旧实现 45% 就裁）', trimEvents.length === 0,
    `trim=${trimEvents.length}${trimEvents[0] ? ` dropped=${trimEvents[0].dropped}` : ''}`);

  // 同一段历史直接调 trimHistoryForRun：45% 目标仍在，故**仍会裁**（两处一起锁住语义）
  const direct = trimHistoryForRun([{ role: 'system', content: 'SYS' }, ...history], { contextWindow: WINDOW });
  check('trimHistoryForRun 本身行为未变（同窗口直接调用仍会裁）',
    direct.trimmed === true && direct.dropped > 0,
    `trimmed=${direct.trimmed} dropped=${direct.dropped} ${direct.beforeTokens}→${direct.afterTokens}`);
  check('直接裁剪后体积降到达标（≤ 45% 预算）', direct.afterTokens <= Math.floor(WINDOW * 0.45),
    `after=${direct.afterTokens} budget=${Math.floor(WINDOW * 0.45)}`);
}

// 对照组：真正越过 70% 时，入口**必须**裁（否则这条闸形同被删）
{
  const bigHistory = Array.from({ length: 61 }, (_, i) => ({
    role: i % 2 === 0 ? 'assistant' : 'user',
    content: `第 ${i} 段：${'z'.repeat(1480)}`,
  }));
  const traces = [];
  const toolHandlers = {
    chat: async () => ({ content: '完成', usage: { prompt_tokens: 100, completion_tokens: 10 } }),
  };
  const model = {
    provider: { id: 1, isGlobal: false, base_url: 'http://local' },
    model: { id: 1, model_id: 'm', context_window: WINDOW },
  };
  await runAgent({
    messages: bigHistory, model, toolHandlers, tokenBudget: 0, maxRounds: 3,
    onMessage: () => {}, onTrace: (e) => traces.push(e), onDone: () => {},
  });
  const trimEvents = traces.filter((e) => e.type === 'trim');
  check('越过 70% 时入口仍会裁（触发条件收紧而非被删）', trimEvents.length === 1,
    `trim=${trimEvents.length}`);
}

console.log(`\ntrim-trigger: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
