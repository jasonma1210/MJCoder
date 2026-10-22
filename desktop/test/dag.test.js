// P1-4 DAG 纯逻辑测试：校验 / 环检测 / 引号围栏提取 / 拓扑分层
const { validateDag, topoLevels } = require('../main/orchestrator/dag');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const okDag = {
  tasks: [
    { id: 't1', title: 'A', prompt: '做 A', dependsOn: [] },
    { id: 't2', title: 'B', prompt: '做 B', dependsOn: [] },
    { id: 't3', title: 'C', prompt: '做 C', dependsOn: ['t1', 't2'], critical: true, maxRetry: 2 },
  ],
};

// ── 合法 DAG ──
const r1 = validateDag(okDag);
check('合法 DAG 通过校验', r1.ok === true && r1.tasks.length === 3);
check('规范化默认值（critical=false / maxRetry=0 / timeout=10min）',
  r1.tasks[0].critical === false && r1.tasks[0].maxRetry === 0 && r1.tasks[0].timeoutMs === 600000);
check('显式 critical/maxRetry 保留', r1.tasks[2].critical === true && r1.tasks[2].maxRetry === 2);
check('拓扑分层：t1/t2 同层可并行，t3 落第 2 层', JSON.stringify(topoLevels(r1.tasks)) === JSON.stringify([['t1', 't2'], ['t3']]));

// ── 结构错误 ──
check('缺少 tasks 数组被拒', validateDag({}).ok === false);
check('任务数下限被拒（1 个）', validateDag({ tasks: [{ id: 'a', title: 'x', prompt: 'y' }] }).ok === false);
check('任务数上限被拒（9 个）', validateDag({ tasks: Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, title: 'x', prompt: 'y' })) }).ok === false);
check('字段缺失被拒', validateDag({ tasks: [{ id: 'a', title: '', prompt: 'y' }, { id: 'b', title: 'x', prompt: 'y' }] }).ok === false);
check('id 重复被拒', validateDag({ tasks: [{ id: 'a', title: 'x', prompt: 'y' }, { id: 'a', title: 'z', prompt: 'y' }] }).ok === false);
check('依赖不存在被拒', validateDag({ tasks: [{ id: 'a', title: 'x', prompt: 'y', dependsOn: ['ghost'] }, { id: 'b', title: 'z', prompt: 'y' }] }).ok === false);
check('自依赖被拒', validateDag({ tasks: [{ id: 'a', title: 'x', prompt: 'y', dependsOn: ['a'] }, { id: 'b', title: 'z', prompt: 'y' }] }).ok === false);

// 2026-10-21 真机 regression：设计文档类拆解常出现「汇总任务依赖全部章节」，
// 旧 MAX_DEPS=4 会把整份拆解判失败（「任务 t6 依赖数超过 4」→ PLAN_FAILED，一个任务都没派）。
const fanIn = validateDag({
  tasks: ['s1', 's2', 's3', 's4', 's5', 's6'].map((id) => ({ id, title: id, prompt: 'x' }))
    .concat([{ id: 'sum', title: '汇总', prompt: 'y', dependsOn: ['s1', 's2', 's3', 's4', 's5', 's6'] }]),
});
check('fan-in 不设人工上限（6 个依赖的汇总任务通过校验）',
  fanIn.ok === true && fanIn.tasks[6].dependsOn.length === 6);
check('大 fan-in 汇总任务落在最后一层',
  JSON.stringify(topoLevels(fanIn.tasks)) === JSON.stringify([['s1', 's2', 's3', 's4', 's5', 's6'], ['sum']]));

// ── 循环依赖（Kahn 环检测）──
const cycle = validateDag({ tasks: [
  { id: 'a', title: 'x', prompt: 'y', dependsOn: ['c'] },
  { id: 'b', title: 'x', prompt: 'y', dependsOn: ['a'] },
  { id: 'c', title: 'x', prompt: 'y', dependsOn: ['b'] },
] });
check('循环依赖被拒且指出环内节点', cycle.ok === false && cycle.error.includes('循环依赖'));

// ── LLM 输出容错：围栏/杂文本包裹 ──
const fenced = '以下是拆解结果：\n```json\n' + JSON.stringify(okDag) + '\n```\n请确认。';
check('```json 围栏内容可提取', validateDag(fenced).ok === true);
const noisy = '好的，拆解如下：\n' + JSON.stringify(okDag) + '\n如需调整请告诉我。';
check('前后杂文本中的 JSON 块可提取', validateDag(noisy).ok === true);

// ── id 规范化（大写/空格 → slug）──
const slug = validateDag({ tasks: [
  { id: 'Step One', title: 'x', prompt: 'y' },
  { id: 'step-two', title: 'z', prompt: 'y', dependsOn: ['step one'] },
] });
check('id slug 化且依赖引用同步归一', slug.ok === true && slug.tasks[1].dependsOn[0] === 'step-one');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);
