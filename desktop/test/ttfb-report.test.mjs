// P2-2a 首字节延迟（TTFB）观测门禁（2026-10-18 全量修复）
//
// 目的：把「模型到底多久开始返回第一个字节」变成可观测指标（SLI）。**只测不杀**：
//   首字节慢是推理模型（mimo 等）的正常形态，把它做成闸门会引入新的误杀。
// 本套件锁五件事：
//   ① onBudget.ttfbMs 透出宿主测到的首字节耗时；
//   ② trace 的 model 事件带 ttfbMs，且超阈值时额外发一条 slow_ttfb；
//   ③ 取不到时恒为 null —— 必须能区分「宿主没测」与「0ms」；
//   ④ 超阈值**不得中止运行**（finalText 正常）；
//   ⑤ **旧字段名 `_ttfbMs` 永不复活**（契约迁移护栏）：引擎与宿主之间的字段名是
//      2026-10-17 统一为 `ttfbMs`（无下划线）的契约，实现**刻意不保留**旧下划线别名——
//      双名会让口径重新漂移（一半宿主写 A、一半读 B，症状是「ttfb 永远是 null」且无声无息）。
//      因此这里既断言新名生效，也断言旧名**不被消费**、且源码里 0 命中。
//   ⑥ P2-2 SLO 回归门禁：边界「当且仅当 > 目标值」、端到端口径（e2eTtfbMs）在册、主聊天通道接线在册。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  runAgent, TTFB_TARGET_MS,
} from '../agent-core/index.js';

const ROOT = path.resolve(import.meta.dirname, '..');
function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs)$/.test(ent.name)) out.push(p);
  }
  return out;
}

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

check('TTFB_TARGET_MS === 3000', TTFB_TARGET_MS === 3000, `got=${TTFB_TARGET_MS}`);

// 双侧常量一致性（防漂移）：引擎侧的告警阈值与宿主侧（main/streamGuard.js）的导出必须同值。
// 两处都写 3000 是「可接受的双份」，但值一分叉就会出现「引擎告警、宿主不告警」的静默不一致。
{
  const require = createRequire(import.meta.url);
  const sg = require(path.resolve(import.meta.dirname, '../main/streamGuard.js'));
  check('引擎与宿主的 TTFB 阈值同值（agent-core === main/streamGuard）',
    sg.TTFB_TARGET_MS === TTFB_TARGET_MS,
    `engine=${TTFB_TARGET_MS} host=${sg.TTFB_TARGET_MS}`);
}

async function runOnce({ ttfbField, ttfbValue = 3500, maxRounds = 4, maxTotalRounds }) {
  const traces = [];
  const budgets = [];
  let rounds = 0;
  const toolHandlers = {
    chat: async (payload) => {
      const isMain = Array.isArray(payload.tools) && payload.tools.length > 0;
      if (!isMain) return { content: '【已完成】摘要', usage: { prompt_tokens: 20, completion_tokens: 5 } };
      rounds += 1;
      if (rounds === 1) {
        const res = {
          content: '第一轮',
          tool_calls: [{ id: 'f1', type: 'function', function: { name: 'shell', arguments: '{"command":"echo 1"}' } }],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        };
        if (ttfbField === 'underscore') res._ttfbMs = ttfbValue;   // 规格 §10 的构造
        else if (ttfbField === 'plain') res.ttfbMs = ttfbValue;     // 实现实际读取的字段
        return res;
      }
      return { content: '任务完成', usage: { prompt_tokens: 50, completion_tokens: 10 } };
    },
    shell: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
  };
  const model = {
    provider: { id: 1, isGlobal: false, base_url: 'http://local' },
    model: { id: 1, model_id: 'm', context_window: 200000 },
  };
  let doneText = null;
  await runAgent({
    messages: [{ role: 'user', content: '问一句' }],
    model, toolHandlers, tokenBudget: 0, maxRounds, maxTotalRounds,
    onMessage: () => {}, onTrace: (e) => traces.push(e),
    onBudget: (s) => budgets.push({ ...s }), onDone: (t) => { doneText = t; },
  });
  return { traces, budgets, doneText };
}

// ── ① 旧字段名已废弃：不得被消费（迁移护栏）──
// 宿主若仍按旧口径返回 `_ttfbMs`，消费侧必须**当作没测到**（全链 null），而不是悄悄生效。
// 这条与 ② 的「新名生效」合起来构成完整迁移门禁：新名必须工作、旧名必须无效。
{
  const r = await runOnce({ ttfbField: 'underscore' });
  const running = r.budgets.filter((s) => s.running === true);
  check('旧名 `_ttfbMs` 不得被消费：onBudget.ttfbMs 为 null',
    running[0]?.ttfbMs === null, `实测 ttfbMs=${JSON.stringify(running[0]?.ttfbMs)}`);
  const modelEvt = r.traces.find((e) => e.type === 'model');
  check('旧名 `_ttfbMs` 不得被消费：trace model 事件 ttfbMs 为 null',
    modelEvt?.ttfbMs === null, `实测 ttfbMs=${JSON.stringify(modelEvt?.ttfbMs)}`);
  check('旧名 `_ttfbMs` 不得被消费：不产生 slow_ttfb（没测到 ≠ 慢）',
    r.traces.filter((e) => e.type === 'slow_ttfb').length === 0,
    `slow_ttfb=${r.traces.filter((e) => e.type === 'slow_ttfb').length} 条`);
  check('旧名场景下运行不受影响（finalText 正常）', r.doneText === '任务完成', String(r.doneText).slice(0, 30));
}

// ── ② 实现实际契约对照：ttfbMs（无下划线）──
{
  const r = await runOnce({ ttfbField: 'plain' });
  const running = r.budgets.filter((s) => s.running === true);
  check('（实现契约）onBudget.ttfbMs === 3500 —— 构造用 `ttfbMs`',
    running[0]?.ttfbMs === 3500, `实测 ttfbMs=${JSON.stringify(running[0]?.ttfbMs)}`);
  const modelEvt = r.traces.find((e) => e.type === 'model');
  check('（实现契约）trace model 事件带 ttfbMs:3500', modelEvt?.ttfbMs === 3500,
    `实测 ttfbMs=${JSON.stringify(modelEvt?.ttfbMs)}`);
  check('（实现契约）超阈值时额外出现一条 slow_ttfb',
    r.traces.filter((e) => e.type === 'slow_ttfb').length === 1,
    `slow_ttfb=${r.traces.filter((e) => e.type === 'slow_ttfb').length} 条`);
  check('慢首字节不中止运行，任务照常完成', r.doneText === '任务完成', String(r.doneText).slice(0, 30));
}

// ── ③ 缺失：恒为 null（区分「没测到」与 0ms）──
{
  const r = await runOnce({ ttfbField: null });
  const running = r.budgets.filter((s) => s.running === true);
  check('宿主不附带 ttfb 时 onBudget.ttfbMs === null（不是 0）',
    running[0]?.ttfbMs === null, `实测=${JSON.stringify(running[0]?.ttfbMs)}`);
  check('无 ttfb 时不发 slow_ttfb 事件',
    r.traces.filter((e) => e.type === 'slow_ttfb').length === 0,
    `slow_ttfb=${r.traces.filter((e) => e.type === 'slow_ttfb').length} 条`);
}

// ── ④ 收尾快照（running:false）带 ttfbMs，且取不到时为 null ──
// 2026-10-18：正常收尾路径此前在循环内直接 return，**不发** running:false 快照
// （注释写「仪表盘定格显示」但实际只有熔断/挂起路径才发）——已由 tester 报障并在
// emitRunEnd → emitBudgetFinal 统一补上（含去重，一次 run 只发一条）。
// 这里两个场景都验：正常收尾必须有 running:false，熔断路径不得重复发。
{
  const r = await runOnce({ ttfbField: null });
  const finals = r.budgets.filter((s) => s.running === false);
  check('正常收尾也发 running:false 快照（仪表盘能定格）', finals.length === 1,
    `running:false 快照 ${finals.length} 条 / 共 ${r.budgets.length} 条`);
  check('正常收尾快照 budgetKind 为 normal（不是熔断值）', finals[0]?.budgetKind === 'normal',
    `kind=${finals[0]?.budgetKind}`);
  check('正常收尾快照的 ttfbMs 同样为 null（不伪造测量值）', finals[0]?.ttfbMs === null,
    `实测=${JSON.stringify(finals[0]?.ttfbMs)}`);
}
{
  const r = await runOnce({ ttfbField: null, maxRounds: 1, maxTotalRounds: 1 });
  const finals = r.budgets.filter((s) => s.running === false);
  check('熔断路径同样只发 1 条 running:false（去重生效，不重复定格）', finals.length === 1,
    `running:false 快照 ${finals.length} 条 / 共 ${r.budgets.length} 条`);
  check('收尾快照带 ttfbMs 字段且取不到时为 null（不伪造测量值）',
    finals[0] && Object.prototype.hasOwnProperty.call(finals[0], 'ttfbMs') && finals[0].ttfbMs === null,
    `实测=${JSON.stringify(finals[0]?.ttfbMs)}`);
}

// ── ⑤ 源码门禁：旧名在整个引擎与主进程里 0 命中（防契约回退）──
// 只比对代码（去注释），允许注释里解释「为什么不保留下划线别名」。
{
  const files = [...walk(path.join(ROOT, 'agent-core')), ...walk(path.join(ROOT, 'main'))];
  const hits = [];
  for (const f of files) {
    const code = fs.readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
    const n = (code.match(/_ttfbMs/g) || []).length;
    if (n > 0) hits.push(`${path.relative(ROOT, f)}×${n}`);
  }
  check('源码门禁：agent-core/ 与 main/ 代码内 `_ttfbMs` 0 命中（旧名永不复活）',
    hits.length === 0, hits.length ? hits.join(', ') : `扫描 ${files.length} 个文件`);
}

// ── ⑥ P2-2 SLO 回归门禁：边界「当且仅当 > 目标值」──
{
  const ok = await runOnce({ ttfbField: 'plain', ttfbValue: TTFB_TARGET_MS });
  check(`边界：ttfbMs === ${TTFB_TARGET_MS}（恰好达标）不产生 slow_ttfb`,
    ok.traces.filter((e) => e.type === 'slow_ttfb').length === 0,
    `slow_ttfb=${ok.traces.filter((e) => e.type === 'slow_ttfb').length} 条`);
  const breach = await runOnce({ ttfbField: 'plain', ttfbValue: TTFB_TARGET_MS + 1 });
  check(`边界：ttfbMs === ${TTFB_TARGET_MS + 1}（超标 1ms）即产生 slow_ttfb`,
    breach.traces.filter((e) => e.type === 'slow_ttfb').length === 1,
    `slow_ttfb=${breach.traces.filter((e) => e.type === 'slow_ttfb').length} 条`);
}

// ── ⑦ P2-2 端到端口径（e2eTtfbMs）：首个模型轮携带、≥ 模型段、后续轮不带 ──
{
  const r = await runOnce({ ttfbField: 'plain' });
  const modelEvts = r.traces.filter((e) => e.type === 'model');
  check('首个 model 事件带 e2eTtfbMs（端到端口径在册）',
    typeof modelEvts[0]?.e2eTtfbMs === 'number', `实测=${JSON.stringify(modelEvts[0]?.e2eTtfbMs)}`);
  check('e2eTtfbMs ≥ 模型段 ttfbMs（装配段耗时非负）',
    modelEvts[0]?.e2eTtfbMs >= modelEvts[0]?.ttfbMs,
    `e2e=${modelEvts[0]?.e2eTtfbMs} model=${modelEvts[0]?.ttfbMs}`);
  check('后续轮 model 事件不带 e2eTtfbMs（口径仅首轮）',
    modelEvts.length > 1 && !('e2eTtfbMs' in modelEvts[1]),
    `model 事件 ${modelEvts.length} 条`);
}

// ── ⑧ P2-2 主对话通道接线（源码门禁）：main.js 必须消费 reportSlowTtfb ──
// 此前只有 scheduled 通道接了 TTFB 告警，主聊天（最高频路径）测到 ttfb 却不告警——
// 静态断言防接线再次脱落（与 bridge-parity 同款源码门禁风格）。
{
  const src = fs.readFileSync(path.join(import.meta.dirname, '../main/main.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
  check('主对话通道接线：main.js 消费 reportSlowTtfb（chat 通道 TTFB 告警在册）',
    src.includes('reportSlowTtfb('));
}

console.log(`\nttfb-report: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
