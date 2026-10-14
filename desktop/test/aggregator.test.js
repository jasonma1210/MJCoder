// P1-6 Aggregator 纯逻辑测试：合并 / 降级警告 / 关键失败 / patch 冲突检测
const { aggregateGroup, extractPatchTargetsFromText } = require('../main/aggregator/merge');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── 正常合并 ──
const r1 = aggregateGroup([
  { taskId: 't1', title: 'A', ok: true, critical: false, result: { summary: 'A 结论', artifacts: ['/proj/a.js'] } },
  { taskId: 't2', title: 'B', ok: true, critical: false, result: { summary: 'B 结论' } },
]);
check('成功结果合并（summary 两条 / artifacts 1 条）', r1.merged.summary.length === 2 && r1.merged.artifacts.length === 1);
check('无警告无失败无冲突', r1.warnings.length === 0 && r1.failed.length === 0 && r1.conflicts.length === 0);

// ── 非关键失败降级为警告 ──
const r2 = aggregateGroup([
  { taskId: 't1', title: 'A', ok: true, critical: false, result: { summary: 'ok' } },
  { taskId: 't3', title: '探索', ok: false, critical: false, error: '超时' },
]);
check('非关键失败降级为 warnings', r2.warnings.length === 1 && r2.warnings[0].includes('探索') && r2.warnings[0].includes('超时'));
check('失败不计入 failed（非关键）', r2.failed.length === 0);

// ── 关键失败进入 failed（组级 failed 判定依据）──
const r3 = aggregateGroup([
  { taskId: 'k1', title: '编译', ok: false, critical: true, error: 'tsc 12 errors' },
  { taskId: 't1', title: 'A', ok: true, critical: false, result: { summary: 'ok' } },
]);
check('关键失败进入 failed 列表', r3.failed.length === 1 && r3.failed[0].taskId === 'k1');

// ── patch 冲突检测：两个任务改同一文件 ──
const r4 = aggregateGroup([
  { taskId: 't1', title: 'A', ok: true, critical: false, result: { summary: 's', patches: [{ path: 'src/app.js', patch: '--- a\n+++ b' }] } },
  { taskId: 't2', title: 'B', ok: true, critical: false, result: { summary: 's', patches: [{ path: 'src/app.js', patch: '--- a\n+++ c' }] } },
  { taskId: 't3', title: 'C', ok: true, critical: false, result: { summary: 's', patches: [{ path: 'src/other.js', patch: '--- a\n+++ d' }] } },
]);
check('同文件多任务补丁检出冲突', r4.conflicts.length === 1 && r4.conflicts[0].path === 'src/app.js' && JSON.stringify(r4.conflicts[0].taskIds.sort()) === JSON.stringify(['t1', 't2']));

// ── extractPatchTargetsFromText：从原始文本提取 diff 目标 ──
const targets = extractPatchTargetsFromText('--- a/src/x.js\n+++ b/src/x.js\n@@ -1 +1 @@\n--- /dev/null\n+++ b/README.md');
check('文本提取 patch 目标并剥离前缀', JSON.stringify(targets) === JSON.stringify(['src/x.js', 'src/x.js', 'README.md']));

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);
