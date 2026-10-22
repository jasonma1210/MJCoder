// DS Bots / T6-11 测试：项目上下文装配（objective + summary + todo + index）
//
// 验收判据（设计稿 §6.4 / §10.1）：
//   ① 冷启动/跨天迭代只加载四项，工件正文**不得**进入装配（只能工具按需读）；
//   ② 预算硬截断：objective ≤ 800 / summary ≤ 1500 / todo ≤ 40 条×120 字 / 索引 ≤ 1200 字；
//   ③ 无项目绑定的普通对话装配为空串（零侵入）；读取失败 fail-open 不抛。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDbAsync } = require('../main/db');
const {
  OBJECTIVE_MAX_CHARS, SUMMARY_MAX_CHARS, TODO_MAX_ITEMS, TODO_ITEM_MAX_CHARS, INDEX_MAX_CHARS,
  buildProjectContextBlock, collectProjectContext, indexText, readLatestSummary, saveRunSummary,
  summaryText, todoText,
} = require('../main/projectContext');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  // ── 四项齐全：段落顺序 + 标签 ──
  const block = buildProjectContextBlock({
    objective: '目标：做一份订单模块 PRD',
    summary: { lastSummary: '上一轮完成了需求梳理', done: ['需求梳理'], todo: ['原型'], disputes: [] },
    todo: '- [pending] 画原型',
    index: { title: '需求文档', currentVersion: 'V0.12', outline: [{ key: 'order', title: '订单', version: 'V0.12', chars: 320 }], recentChanges: [] },
  });
  check('装配包含四项段落', ['【项目固定目标与约束】', '【上次迭代摘要】', '【待办】', '【工件索引】'].every((h) => block.includes(h)));
  check('顺序为目标→摘要→待办→索引',
    block.indexOf('【项目固定目标与约束】') < block.indexOf('【上次迭代摘要】')
    && block.indexOf('【上次迭代摘要】') < block.indexOf('【待办】')
    && block.indexOf('【待办】') < block.indexOf('【工件索引】'));
  check('工件索引提示按需调工具，且不含正文', block.includes('artifact_get_section') && !/正文[:：]\s*\S{20}/.test(block));

  // ── 空输入：不产任何段落（普通对话零侵入）──
  check('四项全空返回空串', buildProjectContextBlock({}) === '');
  check('空白字符串视同空', buildProjectContextBlock({ objective: '   ', summary: null, todo: '', index: null }) === '');

  // ── 预算硬截断 ──
  const longBlock = buildProjectContextBlock({
    objective: '目'.repeat(OBJECTIVE_MAX_CHARS + 50),
    summary: { lastSummary: '摘'.repeat(SUMMARY_MAX_CHARS + 50), done: [], todo: [], disputes: [] },
    todo: Array.from({ length: TODO_MAX_ITEMS + 10 }, (_, i) => `- [pending] 任${i}`).join('\n'),
    index: { title: 't', currentVersion: 'V0.1', outline: Array.from({ length: 200 }, (_, i) => ({ key: `s${i}`, title: `章${i}`, version: 'V0.1', chars: i })) },
  });
  const objPart = longBlock.slice(longBlock.indexOf('【项目固定目标与约束】'), longBlock.indexOf('【上次迭代摘要】'));
  const sumPart = longBlock.slice(longBlock.indexOf('【上次迭代摘要】'), longBlock.indexOf('【待办】'));
  const idxPart = longBlock.slice(longBlock.indexOf('【工件索引】'));
  check(`objective 截断到 ${OBJECTIVE_MAX_CHARS}（含省略号）`,
    objPart.includes('…') && objPart.length < OBJECTIVE_MAX_CHARS + 100 + 40);
  check(`summary 截断到 ${SUMMARY_MAX_CHARS}`, sumPart.includes('…') && sumPart.length < SUMMARY_MAX_CHARS + 100);
  check(`工件索引截断到 ${INDEX_MAX_CHARS}`, idxPart.includes('…') && idxPart.length < INDEX_MAX_CHARS + 120);

  // ── 待办：上限 40 条、单条 120 字、排除终态与当前任务 ──
  const tasks = [
    { taskId: 'cur', title: '当前任务', status: 'running' },
    { taskId: 't1', title: '待办一', status: 'pending' },
    { taskId: 't2', title: '已完成', status: 'done' },
    { taskId: 't3', title: '失败', status: 'failed' },
    { taskId: 't4', title: '跳过', status: 'skipped' },
    { taskId: 't5', title: '等待', status: 'waiting' },
  ];
  const todo = todoText(tasks, 'cur');
  check('待办排除当前任务与终态', !todo.includes('当前任务') && !todo.includes('已完成') && !todo.includes('失败') && !todo.includes('跳过'));
  check('待办保留 pending / waiting', todo.includes('待办一') && todo.includes('等待'));
  const many = Array.from({ length: TODO_MAX_ITEMS + 5 }, (_, i) => ({ taskId: `m${i}`, title: `任务${i}`, status: 'pending' }));
  check(`待办最多 ${TODO_MAX_ITEMS} 条`, todoText(many).split('\n').length === TODO_MAX_ITEMS);
  const longTodo = todoText([{ taskId: 'x', title: '长'.repeat(TODO_ITEM_MAX_CHARS + 30), status: 'pending' }]);
  check(`单条待办截断到 ${TODO_ITEM_MAX_CHARS} 字`, longTodo.includes('…') && longTodo.length < TODO_ITEM_MAX_CHARS + 20);

  // ── summary_json 渲染：四个子项带前缀 ──
  const st = summaryText({ lastSummary: '主摘要', done: ['a'], todo: ['b'], disputes: ['c'] });
  check('摘要渲染含已完成/计划待办/未决争议', st.includes('已完成：a') && st.includes('计划待办：b') && st.includes('未决争议：c'));
  check('空摘要渲染为空串', summaryText(null) === '');

  // ── 索引不含正文字段（getIndex 只给元信息）──
  const idx = indexText({ title: '文档', currentVersion: 'V0.2', outline: [{ key: 'a', title: 'A', version: 'V0.2', chars: 10 }], recentChanges: [] });
  check('索引含版本与字数、不含正文', idx.includes('V0.2') && idx.includes('10 字') && !idx.includes('content'));

  // ── 数据库读写：summary_json 落库 / 读取（run_id 复用 group_id）──
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-project-ctx-'));
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  check('无历史摘要返回 null', readLatestSummary(db, 'prj_a') === null);
  check('落库成功', saveRunSummary(db, { runId: 'g1', projectId: 'prj_a', threadId: 'th1', summary: '第一轮摘要' }) === true);
  check('读取到刚写入的摘要', readLatestSummary(db, 'prj_a')?.lastSummary === '第一轮摘要');
  saveRunSummary(db, { runId: 'g1', projectId: 'prj_a', threadId: 'th1', summary: '更新后的摘要' });
  check('同一 run 覆盖而非新增', readLatestSummary(db, 'prj_a')?.lastSummary === '更新后的摘要'
    && db.prepare('SELECT COUNT(*) AS c FROM project_runs WHERE project_id = ?').get('prj_a').c === 1);
  check('空摘要不落库', saveRunSummary(db, { runId: 'g2', projectId: 'prj_a', summary: '  ' }) === false);

  // ── collectProjectContext：失败 fail-open + 正文永不进入 ──
  const project = { projectId: 'prj_a', objective: '固定目标', artifactId: 'art_1' };
  const fakeArtifact = { getIndex: () => ({ title: '文档', currentVersion: 'V0.3', outline: [{ key: 'a', title: 'A', version: 'V0.3', chars: 5 }], recentChanges: [] }) };
  const ctx = collectProjectContext({ project, db, artifactStore: fakeArtifact, group: { tasks }, currentTaskId: 'cur' });
  check('采集结果含目标/摘要/待办/索引',
    ctx.includes('固定目标') && ctx.includes('更新后的摘要') && ctx.includes('待办一') && ctx.includes('V0.3'));
  check('无项目返回空串', collectProjectContext({ project: null }) === '');
  const broken = collectProjectContext({
    project, db, artifactStore: { getIndex: () => { throw new Error('boom'); } }, group: { tasks },
  });
  check('工件索引异常时仍保留目标（fail-open 降级而非整体丢空）', broken.includes('固定目标'));

  db.close();
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 存在失败'}：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试异常终止：', e);
  process.exit(1);
});
