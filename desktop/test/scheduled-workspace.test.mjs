// A / 阻断①② 回归门禁：定时任务的产出目录、产出契约提示词、以及「零写入不判成功」
//
// 真机现场（两层原因）：
//   ① writeFile 走 Node fs、**不经过 shell 沙箱**，能否落盘由 main/writeGuard.js 的 allowedWriteRoots
//      决定（只放行 cwd/userData/tmp）。越界写会走审批分支——无人值守没人能批（已单独用
//      scheduled-write-fastfail 钉住「必须快拒」）。
//   ② 更直接的一条：事故时任务**是有 cwd 的**（/Users/.../Documents/.MJCoder/20261017-5742），
//      全天 audit 里 0 条 write_file —— 模型从头到尾没尝试写文件。原 systemPrompt 只说「产出摘要」，
//      而 agent-core 的 systemPrompt 是**整体替换**语义，把 BASE_PROMPT 里「能写文件/写在哪」一起丢了。
//
// 所以本文件锁：
//   ① 定时任务 cwd **一律**是产出目录（会话 cwd 只作可读参考）—— 复用会话 cwd 等于本修复不生效；
//   ② 产出契约提示词是**追加**在 BASE_PROMPT 之后，且含三条硬约束；
//   ③ 交付判定：writes>0 → success；writes===0 → failed 且文案可行动；writes 未知 → 不判（防假失败）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); fail++; }
}

// 假 Documents：必须落在**系统临时目录之外**，否则「修前被拦」的正反对照在 Linux（tmpdir=/tmp）上失效
const DOCS = fs.mkdtempSync(path.join(os.homedir(), '.mj-sched-ws-'));
const USER_DATA = path.join(DOCS, 'userData-fixture');
const noop = () => {};
const ipcHandlers = new Map(); // 捕获 ipcMain.handle，供 scheduled:save 的边界用例直接调用

// electron stub：scheduler 顶层 require electron；ensureTaskWorkDir 需要 app.getPath
const Module = require('node:module');
const electronPath = require.resolve('electron');
const stub = new Module(electronPath, null);
stub.filename = electronPath;
stub.loaded = true;
stub.exports = {
  app: { getPath: (n) => ({ documents: DOCS, userData: USER_DATA }[n] || ''), whenReady: () => Promise.resolve(), on: noop },
  ipcMain: { handle: (ch, fn) => ipcHandlers.set(ch, fn), once: noop, on: noop },
};
require.cache[electronPath] = stub;

const scheduledOutput = require(path.join(ROOT, 'main', 'scheduledOutput.js'));
const { taskWorkDir, ensureTaskWorkDir, safeTaskDirName, scheduledRunContext, buildScheduledPrompt } = scheduledOutput;
const { allowedWriteRoots, firstOutsideTarget, isWithinRoot } = require(path.join(ROOT, 'main', 'writeGuard.js'));
const scheduler = require(path.join(ROOT, 'main', 'scheduler.js'));

// ── ① 产出目录：复用 safeTaskDirName + 幂等 ──
await check('产出目录 = <base>/.MJCoder/output/<safeTaskDirName>（与归档目录同级、同一套消毒）', () => {
  assert.equal(taskWorkDir('/tmp/base', '每日 AI 新闻'),
    path.join('/tmp/base', '.MJCoder', 'output', safeTaskDirName('每日 AI 新闻')));
});

await check('复用同一个消毒函数（没有第二套规则）：保留中文、拦住穿越、保留名加后缀', () => {
  for (const name of ['每日 AI 新闻', '../../etc/passwd', 'a/b\\c', 'con', 'NUL', '..', '   ', '新'.repeat(120)]) {
    assert.equal(path.basename(taskWorkDir('/tmp/base', name)), safeTaskDirName(name), `消毒规则漂移：${name}`);
  }
  assert.ok(!taskWorkDir('/tmp/base', '../../etc/passwd').includes('..'));
  assert.equal(path.basename(taskWorkDir('/tmp/base', 'con')), 'con_task');
  assert.equal(path.basename(taskWorkDir('/tmp/base', '   ')), 'untitled');
});

await check('幂等：同一任务名（含多次运行）恒落同一目录，不掺时间戳', () => {
  assert.equal(taskWorkDir(DOCS, '娱乐八卦'), taskWorkDir(DOCS, '娱乐八卦'));
});

await check('建目录：Documents 优先，目录真实存在且幂等', () => {
  const dir = ensureTaskWorkDir({ app: stub.exports.app, taskName: '幂等测试' });
  assert.equal(dir, path.join(DOCS, '.MJCoder', 'output', '幂等测试'));
  assert.ok(fs.statSync(dir).isDirectory());
  assert.equal(ensureTaskWorkDir({ app: stub.exports.app, taskName: '幂等测试' }), dir);
});

await check('取不到 Documents 时兜底 userData（同样走 taskWorkDir）并留痕告警', () => {
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const dir = ensureTaskWorkDir({ app: { getPath: (n) => (n === 'userData' ? USER_DATA : (() => { throw new Error('no documents'); })()) }, taskName: '降级' });
    assert.equal(dir, path.join(USER_DATA, '.MJCoder', 'output', '降级'));
    assert.ok(fs.existsSync(dir));
  } finally { console.warn = orig; }
  assert.ok(warns.some((w) => w.includes('降级')), `降级未留痕：${JSON.stringify(warns)}`);
});

await check('两处都不可用才返回空串（调用方据此回落只读），不抛', () => {
  assert.equal(ensureTaskWorkDir({ app: { getPath: () => { throw new Error('none'); } }, taskName: 'x' }), '');
});

// ── 阻断①：cwd 一律是产出目录（会话 cwd 只作可读参考）──
const PROJ = path.join(DOCS, 'fake-project'); // 真实存在的参考项目目录（S-2 要求存在性校验）
fs.mkdirSync(PROJ, { recursive: true });

await check('阻断①：任务带会话 cwd 时，runAgent 的 cwd 仍是产出目录（不是复用会话 cwd）', () => {
  const rc = scheduledRunContext({ app: stub.exports.app, taskName: '娱乐八卦', contextCwd: PROJ });
  assert.equal(rc.dir, path.join(DOCS, '.MJCoder', 'output', '娱乐八卦'), `cwd 被会话目录接管了：${rc.dir}`);
  assert.ok(fs.existsSync(rc.dir));
  assert.notEqual(rc.dir, PROJ);
  // 读能力不丢：会话 cwd 作为可读参考写进提示词
  assert.ok(rc.appendPrompt.includes(PROJ), '会话 cwd 没作为可读参考传给模型');
  assert.match(rc.appendPrompt, /但产出只写/);
});

await check('S-2：参考目录不存在时按「无项目上下文」执行，并留痕告警', () => {
  const gone = path.join(DOCS, 'deleted-project'); // 从未创建 = 被删/移动
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  let rc;
  try { rc = scheduledRunContext({ app: stub.exports.app, taskName: '项目被删了', contextCwd: gone }); }
  finally { console.warn = orig; }
  assert.ok(!rc.appendPrompt.includes(gone), '提示词里仍带着不存在的项目目录（git/读类会全部 fatal/ENOENT）');
  assert.match(rc.appendPrompt, /本次没有可参考的项目目录/);
  assert.ok(warns.some((w) => w.includes('参考项目目录已不存在')), `未留痕：${JSON.stringify(warns)}`);
  assert.ok(rc.dir, '产出目录不受影响（项目没了也要能落盘）');
});

await check('阻断①：没有会话 cwd 时同样拿到产出目录（不能因为无 cwd 就回落只读）', () => {
  const rc = scheduledRunContext({ app: stub.exports.app, taskName: '无项目任务' });
  assert.ok(rc.dir.startsWith(path.join(DOCS, '.MJCoder', 'output')), rc.dir);
  assert.ok(rc.appendPrompt.length > 0);
});

// ── ② 产出契约提示词：三条硬约束（缺一条都会退化成「只回文本」）──
await check('产出契约：必须写成文件 + 给出绝对目录 + 不用 mkdir + 建议文件名', () => {
  const dir = path.join(DOCS, '.MJCoder', 'output', '契约');
  const p = buildScheduledPrompt({ dir, contextCwd: '/proj' });
  assert.ok(p.includes(dir), '没给出产物绝对目录');
  assert.match(p, /必须把产物写成文件/);
  assert.match(p, /不需要你 mkdir/);
  assert.match(p, /不要写到别处/);
  assert.match(p, /<主题>-YYYY-MM-DD\.md/);
});

await check('产出契约：最终回答只给「一句汇总 + 产物绝对路径」（别把正文再贴一遍）', () => {
  const p = buildScheduledPrompt({ dir: '/out/x', contextCwd: '' });
  assert.match(p, /只给「一句汇总 \+ 产物绝对路径」/);
  // S-1：回读要用绝对路径，否则相对路径会按项目目录解析、读不到刚写的文件
  assert.match(p, /回读\/校验产物时请用\*\*绝对路径\*\*/);
  assert.match(p, /不要重复正文/);
});

await check('产出契约：两条目录同时出现（读从 contextCwd、写只写产出目录）', () => {
  const p = buildScheduledPrompt({ dir: '/out/x', contextCwd: '/proj/y' });
  assert.match(p, /可以从 \/proj\/y 读取/);
  assert.match(p, /产出只写 \/out\/x/);
  // 没有参考目录时如实说明，不编造路径
  assert.match(buildScheduledPrompt({ dir: '/out/x', contextCwd: '' }), /没有可参考的项目目录/);
});

await check('产出契约：目录解析失败时不下发空契约（跳过）并留痕告警', () => {
  // 没有可写目录时「必须写入 X」是无法执行的指令，只会让模型去找别的路径（然后被判白名单外）
  assert.equal(buildScheduledPrompt({ dir: '', contextCwd: '/proj' }), '');
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  let rc;
  try {
    rc = scheduledRunContext({ app: { getPath: () => { throw new Error('no dirs'); } }, taskName: '无目录任务', contextCwd: '/proj' });
  } finally { console.warn = orig; }
  assert.equal(rc.dir, '');
  assert.equal(rc.appendPrompt, '');
  assert.ok(warns.some((w) => w.includes('解析不到可写的产物目录')), `未留痕：${JSON.stringify(warns)}`);
});

await check('产出契约无条件追加：与会话 cwd 无关（有 cwd 也追加 —— 上一版就是在这里对事故场景零生效）', () => {
  const withSession = scheduledRunContext({ app: stub.exports.app, taskName: '带会话cwd', contextCwd: '/Users/x/proj' });
  const withoutSession = scheduledRunContext({ app: stub.exports.app, taskName: '无会话cwd' });
  for (const rc of [withSession, withoutSession]) {
    assert.ok(rc.dir, '拿不到产出目录');
    assert.match(rc.appendPrompt, /必须把产物写成文件/, '有会话 cwd 时没追加写文件指令');
    assert.ok(rc.appendPrompt.includes(rc.dir));
  }
});

// ── 写白名单正反对照（根因①能否成立的判据）──
await check('真机形态：给产出目录当 cwd 后 writeFile 目标在白名单内；无 cwd 时被拦', () => {
  const rc = scheduledRunContext({ app: stub.exports.app, taskName: '娱乐八卦' });
  const file = path.join(rc.dir, '新闻.md');
  // 前置：假 Documents 不在系统临时目录内，否则「无 cwd 被拦」这条对照不成立
  assert.ok(!isWithinRoot(file, os.tmpdir()) && !isWithinRoot(file, '/tmp'), '前置失败：Documents 落在临时目录内');
  const fakeTmp = path.join(DOCS, 'fake-tmp');
  const before = allowedWriteRoots({ cwd: '', userDataDir: USER_DATA, tmpDir: fakeTmp });
  const after = allowedWriteRoots({ cwd: rc.dir, userDataDir: USER_DATA, tmpDir: fakeTmp });
  assert.notEqual(firstOutsideTarget([file], before, rc.dir), null, '修前（cwd 为空）本该被拦——否则本用例无意义');
  assert.equal(firstOutsideTarget([file], after, rc.dir), null, '给了产出目录当 cwd 仍被判白名单外 → 修复无效');
});

// ── ③ 接线 ──
await check('main.js：cwd 用产出目录、系统提示走 appendSystemPrompt、trace 落盘（runId）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main', 'main.js'), 'utf8');
  assert.match(src, /scheduledRunContext\(\{\s*app, taskName, contextCwd: schedModel\.cwd\s*\}\)/);
  assert.match(src, /cwd: rc\.dir,/, 'runAgent 未收到产出目录');
  assert.match(src, /sandboxPolicy: rc\.dir \? 'workspace-write' : 'read-only'/);
  assert.match(src, /appendSystemPrompt: rc\.appendPrompt/, '仍在整体替换 BASE_PROMPT');
  assert.ok(!/systemPrompt: '你是定时任务执行器/.test(src), '旧的整段替换 systemPrompt 还在');
  assert.match(src, /appendTraceEvent\(runId, evt\)/, '定时运行的 trace 未落盘（排障无从还原）');
  assert.match(src, /writes: vres\.writes/, '未把写入次数交给调度器判定');
  assert.match(src, /workDir: rc\.dir/, '未把产物目录交给判定文案');
});

await check('scheduler.js：runTask 传任务名 + 用 judgeRun 判定（四条规则收敛）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main', 'scheduler.js'), 'utf8');
  assert.match(src, /execCtx\.runAgentTask\(\{[\s\S]{0,300}?taskName: String\(t\.name \|\| ''\)/);
  assert.match(src, /const verdict = judgeRun\(\{[^}]*writes: r\?\.writes/, '未用 judgeRun 判定');
});

await check('normalizeTaskModel 保留 cwd（缺失/非字符串时保持「未指定」，不报错）', () => {
  const withCwd = scheduler.normalizeTaskModel({ providerId: 1, model: 'm', cwd: '/Users/x/Documents/.MJCoder/20261017-5742' });
  assert.equal(withCwd.cwd, '/Users/x/Documents/.MJCoder/20261017-5742');
  assert.equal(scheduler.normalizeTaskModel({ providerId: 1, model: 'm' }).cwd, undefined, '缺 cwd 时不该凭空补值');
  assert.equal(scheduler.normalizeTaskModel({ providerId: 1, model: 'm', cwd: 12345 }).cwd, undefined, 'cwd 非字符串应忽略');
  assert.equal(scheduler.normalizeTaskModel({ providerId: 1, model: 'm', cwd: 'x'.repeat(2000) }).cwd.length, 1024);
  // 老快照（没有 cwd 字段）仍能通过形状校验：不因新增字段把存量任务判成坏配置
  assert.ok(scheduler.normalizeTaskModel({ providerId: 'p', model: 'm', baseUrl: '' }));
});

// ── 阻断②：零写入不判成功（run 级正/反样本）──
await check('阻断②正样本：真写了文件 → success', async () => {
  scheduler.setModel({ providerId: 1, isGlobal: false, baseUrl: 'https://api.test/v1', model: 'test-model', cwd: '' });
  scheduler.startScheduler({
    runAgentTask: async () => ({
      output: '已写入 news-2026-10-18.md', toolCalls: 6, writes: 3, shellWrites: 0, workDir: '/out/娱乐八卦', usage: null,
      verify: { level: 'l3', verdict: 'PASS', stats: { tools: 6, writes: 3, shellWrites: 0 } },
    }),
    notify: noop, taskTimeoutMs: 5000,
  });
  const { task } = scheduler.createTask({ name: '写文件任务', prompt: '写一份 md', schedule: '0 9 * * *' });
  const r = await scheduler.runTask(task.id, 'manual');
  assert.equal(r.ok, true, JSON.stringify(r));
  const run = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'scheduled-tasks.json'), 'utf8')).runs.find((x) => x.task_id === task.id);
  assert.equal(run.status, 'success');
  assert.equal(run.writes, 3);
  assert.equal(run.workDir, '/out/娱乐八卦', '运行记录里没有产物目录，事后无法知道文件写在哪');
  scheduler.stopScheduler();
});

await check('阻断②反样本：只回文本（writes=0）→ failed，文案含「未产出文件」与产物目录', async () => {
  scheduler.setModel({ providerId: 1, isGlobal: false, baseUrl: 'https://api.test/v1', model: 'test-model', cwd: '' });
  scheduler.startScheduler({
    runAgentTask: async () => ({
      output: '以下是 100 条全球娱乐八卦新闻的摘要……', toolCalls: 5, writes: 0, shellWrites: 0, workDir: '/out/娱乐八卦', usage: null,
      // 真机形态：V 层收到了 ledger（stats 存在），5 次工具调用、0 次写入
      verify: { level: 'l3', verdict: 'SKIP', stats: { tools: 5, writes: 0, shellWrites: 0 } },
    }),
    notify: noop, taskTimeoutMs: 5000,
  });
  const { task } = scheduler.createTask({ name: '只回文本任务', prompt: '获取 100 篇八卦并输出 md', schedule: '0 9 * * *' });
  const r = await scheduler.runTask(task.id, 'manual');
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(String(r.error), /未产出文件/);
  assert.match(String(r.error), /\/out\/娱乐八卦/, '文案没给产物目录');
  const run = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'scheduled-tasks.json'), 'utf8')).runs.find((x) => x.task_id === task.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.writes, 0);
  scheduler.stopScheduler();
});

await check('阻断②护栏：V 层没给写入统计（writes=null）时不许判「未产出文件」', async () => {
  scheduler.setModel({ providerId: 1, isGlobal: false, baseUrl: 'https://api.test/v1', model: 'test-model', cwd: '' });
  scheduler.startScheduler({
    runAgentTask: async () => ({
      output: '整理完成，结果见摘要', toolCalls: 4, writes: null, shellWrites: null, usage: null,
      // V 层没收到 ledger：stats 为 null → 写入次数未知，不得据此判失败
      verify: { level: 'l3', verdict: 'SKIP', reason: 'no_ledger', stats: null },
    }),
    notify: noop, taskTimeoutMs: 5000,
  });
  const { task } = scheduler.createTask({ name: '无统计任务', prompt: 'x', schedule: '0 9 * * *' });
  const r = await scheduler.runTask(task.id, 'manual');
  assert.equal(r.ok, true, `没数据被当成「没写文件」→ 新的假失败：${JSON.stringify(r)}`);
  scheduler.stopScheduler();
});

// ── D2：expects_file（要求产出文件）──
await check('expects_file 边界：非布尔拒绝、布尔落盘、缺省默认 true、支持部分更新', async () => {
  scheduler.registerIpc();
  const save = ipcHandlers.get('scheduled:save');
  const bad = await save({}, { name: 'x', prompt: 'y', schedule: '0 9 * * *', expects_file: 'false' });
  assert.equal(bad.ok, false, '字符串 "false" 被当成合法值（会悄悄变成 true）');
  assert.match(String(bad.error), /布尔/);
  const off = await save({}, { name: '关掉产出校验', prompt: 'y', schedule: '0 9 * * *', expects_file: false });
  assert.equal(off.ok, true, JSON.stringify(off));
  assert.equal(off.task.expects_file, false);
  const dflt = await save({}, { name: '默认要求产出', prompt: 'y', schedule: '0 9 * * *' });
  assert.equal(dflt.task.expects_file, true, '缺省必须为 true（否则真实任务不再被校验）');
  // UI 的开关只发 { id, expects_file }：部分更新路径也要能改
  const upd = await save({}, { id: off.task.id, expects_file: true });
  assert.equal(upd.task.expects_file, true);
});

await check('D2：expects_file:false 的任务零产出不判失败（只做提交/汇报的任务不再被 auto-pause 停用）', async () => {
  scheduler.setModel({ providerId: 1, isGlobal: false, baseUrl: 'https://api.test/v1', model: 'test-model', cwd: '' });
  scheduler.startScheduler({
    runAgentTask: async () => ({
      output: '已提交 commit 并把结论汇报给用户', toolCalls: 3, writes: 0, shellWrites: 0, usage: null,
      verify: { level: 'l3', verdict: 'SKIP', stats: { tools: 3, writes: 0, shellWrites: 0 } },
    }),
    notify: noop, taskTimeoutMs: 5000,
  });
  const { task } = scheduler.createTask({ name: '只提交任务', prompt: '提交并汇报', schedule: '0 9 * * *', expects_file: false });
  const r = await scheduler.runTask(task.id, 'manual');
  assert.equal(r.ok, true, `关掉产出校验后仍被判失败：${JSON.stringify(r)}`);
  // 对照：同形态但默认要求产出 → 必须失败（规则本身没被削弱）
  const { task: t2 } = scheduler.createTask({ name: '仍要求产出', prompt: 'x', schedule: '0 9 * * *' });
  const r2 = await scheduler.runTask(t2.id, 'manual');
  assert.equal(r2.ok, false, '缺省任务不再判零产出，规则被削弱');
  assert.match(String(r2.error), /未产出文件/);
  scheduler.stopScheduler();
});

await check('D2-b：模型侧建任务能传 expects_file（提醒类 false / 文档类缺省 true / 非布尔不被采纳）', async () => {
  const { scheduledCreate } = require(path.join(ROOT, 'main', 'scheduledTools.js'));
  scheduler.registerIpc();
  const ctx = { createTask: scheduler.createTask, cronValid: scheduler.cronValid, approvalMode: 'never' }; // never 档：不弹卡
  const listTasks = async () => (await ipcHandlers.get('scheduled:list')({})).tasks;
  const r1 = await scheduledCreate({ name: '提醒开会', schedule: '0 9 * * *', prompt: '每天 9 点提醒我开会', expects_file: false }, ctx);
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal((await listTasks()).find((t) => t.id === r1.taskId).expects_file, false, '模型传 false 没落到任务对象（提醒类会天天被判失败）');
  const r2 = await scheduledCreate({ name: '生成周报', schedule: '0 9 * * 1', prompt: '生成本周周报 markdown' }, ctx);
  assert.equal((await listTasks()).find((t) => t.id === r2.taskId).expects_file, true, '缺省必须为 true（文档类仍要被校验）');
  const r3 = await scheduledCreate({ name: '怪输入', schedule: '0 9 * * *', prompt: 'x', expects_file: 'false' }, ctx);
  assert.equal((await listTasks()).find((t) => t.id === r3.taskId).expects_file, true, '非布尔输入应被忽略并回落默认');
});

// ── 产品调用形态端到端 ──
await check('产品调用形态：runTask → 执行器拿 taskName 建产出目录 → 真的写成 md（writes>0 判成功）', async () => {
  scheduler.setModel({ providerId: 1, isGlobal: false, baseUrl: 'https://api.test/v1', model: 'test-model', cwd: '' });
  let written = '';
  scheduler.startScheduler({
    // 复刻 main.js 的接线形态：scheduledRunContext 拿产出目录与契约提示，并在其中落 md
    runAgentTask: async ({ taskName, model }) => {
      const rc = scheduledRunContext({ app: stub.exports.app, taskName, contextCwd: model?.cwd });
      assert.ok(rc.dir, '执行器没拿到可写目录');
      const file = path.join(rc.dir, 'news-2026-10-18.md');
      fs.writeFileSync(file, '# 100 条全球娱乐八卦新闻\n\n1. 示例条目\n', 'utf8');
      written = file;
      return { output: `已写入 ${file}`, toolCalls: 8, writes: 1, shellWrites: 0, workDir: rc.dir, usage: null, verify: { level: 'l3', verdict: 'PASS', stats: { tools: 8, writes: 1, shellWrites: 0 } } };
    },
    notify: noop, taskTimeoutMs: 5000,
  });
  const { task } = scheduler.createTask({ name: '全球娱乐八卦新闻', prompt: '获取最新的 100 篇全球娱乐八卦新闻，输出一份 md 文档', schedule: '0 9 * * *' });
  const r = await scheduler.runTask(task.id, 'manual');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(written, path.join(DOCS, '.MJCoder', 'output', '全球娱乐八卦新闻', 'news-2026-10-18.md'));
  assert.match(fs.readFileSync(written, 'utf8'), /100 条全球娱乐八卦新闻/);
  scheduler.stopScheduler();
});

fs.rmSync(DOCS, { recursive: true, force: true });
console.log(`\nscheduled-workspace: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
