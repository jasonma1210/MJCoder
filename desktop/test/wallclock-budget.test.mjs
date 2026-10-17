// P1-1 整任务墙钟预算门禁（2026-10-18 全量修复）
//
// 缺口：轮次/token/abort 三闸都只能约束「单次调用」或「累计用量」，模型每次都很"乖"地
//   在 100s 内返回、但一轮接一轮不停，任务可以跑几小时——三闸都不响。
// 本套件锁三件事：
//   ① 命中后走「暂停而非失败」：onSuspend 收到 kind:'wallclock'，断点落盘；
//   ② 收尾文案对用户说清「总时长预算」（不是「轮次预算」，否则用户以为续轮次就能救）；
//   ③ **不得新增 budgetKind 枚举值**——新增会外溢到 workerPool 收尾文案与 main.js humanize，
//      表现为「编排 Worker 静默丢文案」。故 budgetKind 仍为 'rounds'，另以 wallclock:true 区分。
//
// 陷阱（规格 §2）：不要断言「轮次预算」字样——已刻意改为「总时长预算」。
import {
  runAgent, DEFAULT_RUN_WALL_CLOCK_MS,
} from '../agent-core/index.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

check('DEFAULT_RUN_WALL_CLOCK_MS === 30 分钟', DEFAULT_RUN_WALL_CLOCK_MS === 30 * 60 * 1000, `got=${DEFAULT_RUN_WALL_CLOCK_MS}`);

{
  const traces = [];
  const budgetSnapshots = [];
  const suspends = [];
  let chatCount = 0;
  const toolHandlers = {
    // 每次模型调用都慢 20ms：单轮远低于任何单轮超时，但整体会越过 5ms 的墙钟闸
    chat: async () => {
      chatCount += 1;
      await sleep(20);
      return {
        content: `第 ${chatCount} 步`,
        tool_calls: [{ id: `s${chatCount}`, type: 'function', function: { name: 'shell', arguments: '{"command":"echo 1"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
    },
    shell: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
  };
  const model = {
    provider: { id: 1, isGlobal: false, base_url: 'http://local' },
    model: { id: 1, model_id: 'm', context_window: 200000 },
  };
  let finalText = null;
  await runAgent({
    messages: [{ role: 'user', content: '干一长串活' }],
    model,
    toolHandlers,
    runWallClockMs: 5,
    maxRounds: 40,
    tokenBudget: 0,
    onMessage: () => {},
    onTrace: (e) => traces.push(e),
    onBudget: (s) => budgetSnapshots.push({ ...s }),
    onSuspend: (info) => { suspends.push(info); return true; },
    onDone: (t) => { finalText = t; },
  });

  check('墙钟命中后调用 onSuspend 且 kind 为 wallclock',
    suspends.length === 1 && suspends[0].kind === 'wallclock',
    `suspends=${JSON.stringify(suspends.map((s) => s.kind))}`);
  check('onSuspend 收到断点摘要与轮数（宿主可据此落断点）',
    typeof suspends[0]?.summary === 'string' && Number(suspends[0]?.roundsUsed) >= 1,
    `roundsUsed=${suspends[0]?.roundsUsed}`);
  check('收尾文案同时含「总时长预算」与「断点已保存」',
    String(finalText).includes('总时长预算') && String(finalText).includes('断点已保存'),
    String(finalText).slice(-120));
  check('收尾文案不再错误地说「执行轮次预算」',
    !String(finalText).includes('执行轮次预算'), String(finalText).slice(-120));

  const runEnds = traces.filter((e) => e.type === 'run_end');
  // 2026-10-18：**一次 run 只能有一条 run_end**。此前墙钟分支先发 `{wallclock:true}`、
  // break 后统一出口又发一条 → 下游按「最后一条」判断会把超时读成正常结束（实测 true,false）。
  check('墙钟路径只发 1 条 run_end（时间线不出现双尾事件）', runEnds.length === 1,
    `run_end=${runEnds.length} 条，wallclock 标记=${runEnds.map((e) => !!e.wallclock).join(',')}`);
  const runEnd = runEnds[0] || {};
  // 三者必须同时成立（team-lead 2026-10-18 口径）：
  //   wallclock===true 标记命中来源；budgetExhausted===true 标记确实熔断；
  //   budgetKind 仍是 'rounds' —— **刻意复用值**，新增枚举会让 workerPool 与 main.js humanize 静默漏文案。
  check('run_end 同时满足 wallclock===true / budgetExhausted===true / budgetKind===\'rounds\'',
    runEnd.wallclock === true && runEnd.budgetExhausted === true && runEnd.budgetKind === 'rounds',
    `wallclock=${runEnd.wallclock} budgetExhausted=${runEnd.budgetExhausted} budgetKind=${runEnd.budgetKind}`);
  const finalSnap = budgetSnapshots.filter((s) => s.running === false).pop() || {};
  check('收尾快照 budgetKind 未新增枚举值', finalSnap.budgetKind === 'rounds', `kind=${finalSnap.budgetKind}`);
  check('墙钟闸不会每轮都触发（实际只跑了有限轮）', chatCount >= 1 && chatCount < 40, `chat=${chatCount}`);
}

console.log(`\nwallclock-budget: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
