// 定时任务调度器纯逻辑回归：cron 语法校验与分钟匹配（不依赖 Electron 运行时）
const assert = require('node:assert/strict');

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

// electron 在纯 node 下返回二进制路径字符串，解构出的 app/ipcMain 为 undefined；
// 模块顶层未使用它们，cronValid/cronMatches 纯函数可直接测试。
// P0-D：执行通道测试需要 app.getPath/ipcMain —— 先装 electron stub 再 require scheduler
const fs = require('fs');
const Module = require('module');
const handlers = new Map();
const noop = () => {};
const electronPath = require.resolve('electron');
const stubModule = new Module(electronPath, null);
stubModule.filename = electronPath;
stubModule.loaded = true;
stubModule.exports = {
  app: { getPath: () => '/tmp/mjcode-test', whenReady: () => Promise.resolve(), on: noop },
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), once: noop, on: noop },
};
require.cache[electronPath] = stubModule;

const { cronValid, cronMatches } = require('../main/scheduler.js');
const { localDate } = require('../main/scheduledOutput.js');

check('合法 cron 表达式', () => {
  for (const expr of ['0 9 * * *', '*/5 * * * *', '0 9 * * 1-5', '30 8 1,15 * *', '0 0 * * 0', '59 23 31 12 6']) {
    assert.ok(cronValid(expr), `应合法：${expr}`);
  }
});

check('非法 cron 表达式（字段数/字符/越界）', () => {
  for (const expr of ['', '0 9 * *', '0 9 * * * *', 'a b c d e', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '0 9 * * *; rm -rf']) {
    assert.ok(!cronValid(expr), `应非法：${expr}`);
  }
});

check('分钟匹配：每天 10:00', () => {
  const d = new Date(2026, 9, 13, 10, 0, 0);
  assert.ok(cronMatches('0 10 * * *', d));
  assert.ok(!cronMatches('0 10 * * *', new Date(2026, 9, 13, 10, 1, 0)));
  assert.ok(!cronMatches('0 10 * * *', new Date(2026, 9, 13, 9, 0, 0)));
});

check('周字段：工作日 1-5 命中周一/周五、不命中周日', () => {
  assert.ok(cronMatches('0 9 * * 1-5', new Date(2026, 9, 12, 9, 0)));  // 周一
  assert.ok(cronMatches('0 9 * * 1-5', new Date(2026, 9, 9, 9, 0)));   // 周五
  assert.ok(!cronMatches('0 9 * * 1-5', new Date(2026, 9, 11, 9, 0))); // 周日
});

check('步进：*/15 分钟命中 0/15/30/45', () => {
  for (const m of [0, 15, 30, 45]) {
    assert.ok(cronMatches('*/15 * * * *', new Date(2026, 9, 13, 9, m)), `应命中 ${m} 分`);
  }
  assert.ok(!cronMatches('*/15 * * * *', new Date(2026, 9, 13, 9, 17)));
});

check('列表：30 8 1,15 * * 命中 1 日与 15 日', () => {
  assert.ok(cronMatches('30 8 1,15 * *', new Date(2026, 9, 1, 8, 30)));
  assert.ok(cronMatches('30 8 1,15 * *', new Date(2026, 9, 15, 8, 30)));
  assert.ok(!cronMatches('30 8 1,15 * *', new Date(2026, 9, 2, 8, 30)));
});

// ── P0-D：执行通道（Agent 优先 / chatOnce 回落 / 重入 / 失败 / 超时 / 模型引导）──
// 异步布尔断言助手（check 接收同步函数，此处直接断言布尔值）
function checkOk(name, ok, detail = '') {
  total++;
  if (ok) { console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`); pass++; }
  else { console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`); process.exitCode = 1; }
}

const scheduler = require('../main/scheduler.js');
scheduler.registerIpc();
const saveHandler = handlers.get('scheduled:save');
const runsHandler = handlers.get('scheduled:runs');
const TEST_MODEL = { providerId: 1, isGlobal: false, baseUrl: 'https://api.test/v1', model: 'test-model', cwd: '/tmp' };

(async () => {
  fs.rmSync('/tmp/mjcode-test/scheduled-tasks.json', { force: true });
  fs.rmSync('/tmp/mjcode-test/.MJCoder', { recursive: true, force: true });

  // 1. Agent 通道优先：runAgentTask 被调用，运行记录带 channel/tools/tokens
  let agentCalls = [];
  scheduler.startScheduler({
    chatOnce: async () => 'chat-fallback',
    runAgentTask: async ({ prompt, model, signal }) => {
      agentCalls.push({ prompt, model, signal: !!signal });
      return { output: 'agent-done', toolCalls: 3, usage: { prompt_tokens: 100, completion_tokens: 20 } };
    },
    notify: noop,
    taskTimeoutMs: 5000,
  });
  scheduler.setModel(TEST_MODEL);
  const { task: t1 } = await saveHandler({}, { name: '跑测试', prompt: '运行单测并汇总', schedule: '0 9 * * *' });
  const r1 = await scheduler.runTask(t1.id, 'manual');
  checkOk('Agent 通道优先：任务成功且取到 Agent 输出', r1.ok === true && r1.output === 'agent-done', JSON.stringify(r1));
  checkOk('P0-8b：成功状态写回任务对象（UI 卡片直读的三个字段）',
    t1.last_status === 'success' && !!t1.last_run_at && t1.last_result === 'agent-done',
    JSON.stringify({ status: t1.last_status, at: t1.last_run_at, result: t1.last_result }));
  // 2026-10-17：输出归档——stub 的 documents 目录是 /tmp/mjcode-test
  const archiveFile = `/tmp/mjcode-test/.MJCoder/tasks/${'跑测试'}/${localDate()}.md`;
  checkOk('运行输出归档到 <Documents>/.MJCoder/tasks/<任务名>/<日期>.md',
    fs.existsSync(archiveFile) && fs.readFileSync(archiveFile, 'utf8').includes('agent-done'),
    archiveFile);
  checkOk('runAgentTask 收到 prompt/model/signal', agentCalls.length === 1
    && agentCalls[0].prompt === '运行单测并汇总'
    && agentCalls[0].model.model === 'test-model'
    && agentCalls[0].signal === true);
  const runs1 = await runsHandler({}, { id: t1.id });
  checkOk('运行记录标记 channel=agent 与工具计数', runs1.runs[0].channel === 'agent' && runs1.runs[0].tools === 3
    && runs1.runs[0].tokens?.prompt_tokens === 100, JSON.stringify(runs1.runs[0]));

  // 2. 执行中重入拒绝（互斥）
  let release;
  const blocker = new Promise((res) => { release = res; });
  scheduler.startScheduler({ runAgentTask: async () => { await blocker; return { output: 'slow-done' }; }, notify: noop });
  const p2 = scheduler.runTask(t1.id, 'manual');
  const r2 = await scheduler.runTask(t1.id, 'manual');
  checkOk('执行中重入被拒绝', r2.ok === false && String(r2.error).includes('正在执行中'), JSON.stringify(r2));
  release();
  await p2;

  // 3. 失败记录：runAgentTask 抛错 → status=failed 且 error 落库
  // P0-8b：错误消息加长到 600 字符，验证 last_result 截断到 500。
  // startScheduler 会重载 store（任务对象整体替换），断言落盘文件里的任务副本
  scheduler.startScheduler({ runAgentTask: async () => { throw new Error(`API 429: rate limit ${'x'.repeat(600)}`); }, notify: noop });
  const r3 = await scheduler.runTask(t1.id, 'manual');
  checkOk('Agent 执行失败被记录', r3.ok === false && String(r3.error).includes('429'), JSON.stringify(r3));
  const persistedAfterFail = JSON.parse(fs.readFileSync('/tmp/mjcode-test/scheduled-tasks.json', 'utf8'))
    .tasks.find((x) => x.id === t1.id);
  checkOk('P0-8b：失败状态写回任务对象（落盘）且 last_result 截断到 500',
    persistedAfterFail.last_status === 'failed' && String(persistedAfterFail.last_result).includes('429')
    && persistedAfterFail.last_result.length === 500,
    `status=${persistedAfterFail.last_status} len=${persistedAfterFail.last_result?.length}`);

  // 4. 墙钟超时：mock 尊重 signal.abort，taskTimeoutMs=30ms
  scheduler.startScheduler({
    runAgentTask: ({ signal }) => new Promise((_res, rej) => {
      signal.addEventListener('abort', () => rej(new Error('aborted')));
    }),
    notify: noop,
    taskTimeoutMs: 30,
  });
  const r4 = await scheduler.runTask(t1.id, 'manual');
  checkOk('墙钟超时中止并给出中文提示', r4.ok === false && String(r4.error).includes('超时'), JSON.stringify(r4));

  // 5. 模型缺失：中文引导（而非裸报错）
  scheduler.startScheduler({ runAgentTask: async () => ({ output: 'x' }), notify: noop });
  scheduler.setModel(null);
  const r5 = await scheduler.runTask(t1.id, 'manual');
  // 2026-10-18：文案改为同时提示「任务级模型」入口（现在任务可以单独选模型）
  checkOk('未配置模型时给出中文引导', r5.ok === false && String(r5.error).includes('请在定时任务里选一个模型'), JSON.stringify(r5));

  // 6. 回落 chatOnce（无 runAgentTask 时兼容旧行为）
  let chatCalls = 0;
  scheduler.startScheduler({ chatOnce: async () => { chatCalls++; return 'chat-done'; }, notify: noop });
  scheduler.setModel(TEST_MODEL);
  const r6 = await scheduler.runTask(t1.id, 'manual');
  checkOk('无 Agent 通道时回落 chatOnce', r6.ok === true && r6.output === 'chat-done' && chatCalls === 1, JSON.stringify(r6));
  const runs6 = await runsHandler({}, { id: t1.id });
  checkOk('回落记录 channel=chat', runs6.runs[0].channel === 'chat');

  // ── P0-8a：启动补跑扫描（错过标记 / 同日宽限补跑 / 超长缺失只标记 / 窗口内无到期不动）──
  // 固定 now 消除时钟依赖：2026-10-17 是周六，10-15 周四、10-16 周五为工作日
  const FIXED_NOW = new Date(2026, 9, 17, 10, 0, 0); // 今天 10:00（每日 09:00 已过期）
  let scanAgentCalls = [];
  scheduler.startScheduler({
    runAgentTask: async ({ prompt }) => { scanAgentCalls.push(prompt); return { output: 'catchup-done' }; },
    notify: noop,
    taskTimeoutMs: 5000,
  });
  scheduler.setModel(TEST_MODEL);

  // A：工作日任务，3 天前（周三 09:00）最后触发 → 10-15/10-16 两次到期，最近一次是昨天 → missed
  const { task: tA } = await saveHandler({}, { name: '工作日跑测试', prompt: 'prompt-weekday', schedule: '0 9 * * 1-5' });
  tA.last_fired = new Date(2026, 9, 14, 9, 0).toISOString();
  // B：每日任务，昨天 09:00 最后触发 → 今天 09:00 到期且与今天同日 → 宽限补跑一次
  const { task: tB } = await saveHandler({}, { name: '每天跑测试', prompt: 'prompt-daily', schedule: '0 9 * * *' });
  tB.last_fired = new Date(2026, 9, 16, 9, 0).toISOString();
  // C：每日任务，30 天未运行 → 超过 7 天回放上限 → 只标记 missed，不补跑
  const { task: tC } = await saveHandler({}, { name: '长期缺席任务', prompt: 'prompt-long-absent', schedule: '0 9 * * *' });
  tC.last_fired = new Date(2026, 8, 17, 9, 0).toISOString(); // 9 月 17 日（30 天前）
  // D：年度任务（1 月 1 日），10 个月未运行 → 窗口截断内无到期分钟 → 不标记，仅推进游标
  const { task: tD } = await saveHandler({}, { name: '年度任务', prompt: 'prompt-yearly', schedule: '0 9 1 1 *' });
  tD.last_fired = new Date(2025, 0, 1, 9, 0).toISOString();

  await scheduler.scanMissedTasks(FIXED_NOW);

  checkOk('P0-8a：昨天及更早到期 → 标记 missed 并写明错过次数（绝不静默）',
    tA.missed === true && tA.last_status === 'missed' && /错过 2 次/.test(String(tA.last_result)),
    JSON.stringify({ missed: tA.missed, status: tA.last_status, result: tA.last_result }));
  const runsB = await runsHandler({}, { id: tB.id });
  checkOk('P0-8a：今天日内到期 → 补跑一次（trigger=catchup）且清掉 missed',
    scanAgentCalls.length === 1 && scanAgentCalls[0] === 'prompt-daily'
    && runsB.runs[0].trigger === 'catchup'
    && tB.last_status === 'success' && tB.missed === false,
    JSON.stringify({ calls: scanAgentCalls, trigger: runsB.runs[0]?.trigger, status: tB.last_status }));
  checkOk('P0-8a：超长缺失（>7 天）→ 只标记不补跑',
    tC.missed === true && tC.last_status === 'missed' && /超过 30 天/.test(String(tC.last_result))
    && !scanAgentCalls.includes('prompt-long-absent'),
    JSON.stringify({ result: tC.last_result, calls: scanAgentCalls }));
  checkOk('P0-8a：窗口内无到期分钟 → 不误标记 missed，仅推进 last_fired 游标',
    !tD.missed && tD.last_fired === new Date(2026, 9, 17, 10, 0, 0).toISOString(),
    JSON.stringify({ missed: tD.missed, last_fired: tD.last_fired }));

  // ── 2026-10-17：假成功识别（模型自述做不到时不得标 success）──
  // 事故：定时任务漏注入 web 工具 → 模型回「无法完成…如实说明」→ 因未抛异常被判成功，
  // UI 上显示「成功」，内容却是做不到。这条断言把「没抛异常 ≠ 成功」钉住。
  const { task: tF } = await saveHandler({}, { name: '假成功任务', prompt: '搜索最新 AI 新闻', schedule: '0 9 * * *' });
  scheduler.startScheduler({
    runAgentTask: async () => ({ output: '无法完成本次任务，如实说明情况：web_search 工具不存在', toolCalls: 0, usage: null }),
    notify: noop,
  });
  const r7 = await scheduler.runTask(tF.id, 'manual');
  checkOk('自述无法完成 + 零工具调用 → 判失败（不再假成功）',
    r7.ok === false && /无法完成/.test(String(r7.error)),
    JSON.stringify({ ok: r7.ok, error: r7.error }));
  // startScheduler 会重载 store（任务对象整体替换），断言落盘副本而非内存引用
  const persistedAfterFake = JSON.parse(fs.readFileSync('/tmp/mjcode-test/scheduled-tasks.json', 'utf8'))
    .tasks.find((x) => x.id === tF.id);
  checkOk('失败态写回任务对象（last_status=failed，卡片不再显示「成功」）',
    persistedAfterFake.last_status === 'failed' && /无法完成/.test(String(persistedAfterFake.last_result)),
    JSON.stringify({ status: persistedAfterFake?.last_status, result: persistedAfterFake?.last_result }));

  // 反向：真调用过工具时，结尾出现「无法获取」等措辞不该推翻整轮成功
  scheduler.startScheduler({
    runAgentTask: async () => ({ output: '已搜到 5 条，其中 2 条无法获取正文，摘要在下……', toolCalls: 3, usage: null }),
    notify: noop,
  });
  const r8 = await scheduler.runTask(tF.id, 'manual');
  checkOk('有工具调用时保留成功（「无法获取」措辞不误判）', r8.ok === true, JSON.stringify(r8));

  // 空输出也算失败（模型什么都没产出，不能标成功）
  scheduler.startScheduler({ runAgentTask: async () => ({ output: '   ', toolCalls: 0 }), notify: noop });
  const r9 = await scheduler.runTask(tF.id, 'manual');
  checkOk('空输出 → 判失败并给出原因', r9.ok === false && /空结果/.test(String(r9.error)), JSON.stringify(r9));

  // 2026-10-18：引擎因闸门停下（熔断）时，**即使有工具调用**也不能标成功。
  // 实测事故：抓 50 条新闻的任务被上下文闸停下，输出写着「任务尚未完成」，卡片却是绿色成功。
  scheduler.startScheduler({
    runAgentTask: async () => ({
      output: '任务尚未完成。\n\n（上下文已到模型窗口（累计 50097 tokens），且历史里没有可裁的早期内容…）',
      toolCalls: 7,
    }),
    notify: noop,
  });
  const r10 = await scheduler.runTask(tF.id, 'manual');
  checkOk('引擎报告未完成（有工具调用也算失败）', r10.ok === false && /引擎报告任务未完成/.test(String(r10.error)), JSON.stringify(r10));
  checkOk('未完成识别与工具调用次数无关',
    scheduler.detectExhausted('上下文已到模型窗口（累计 1 tokens）').length > 0
    && scheduler.detectExhausted('正常完成，共抓到 50 条').length === 0,
    `命中=${scheduler.detectExhausted('上下文已到模型窗口')}`);

  scheduler.stopScheduler();
  fs.rmSync('/tmp/mjcode-test/scheduled-tasks.json', { force: true });
  console.log(`\nPASS：${pass}/${total} 项通过`);
  process.exit(pass === total ? 0 : 1);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
