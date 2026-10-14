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
  scheduler.startScheduler({ runAgentTask: async () => { throw new Error('API 429: rate limit'); }, notify: noop });
  const r3 = await scheduler.runTask(t1.id, 'manual');
  checkOk('Agent 执行失败被记录', r3.ok === false && String(r3.error).includes('429'), JSON.stringify(r3));

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
  checkOk('未配置模型时给出中文引导', r5.ok === false && String(r5.error).includes('请在任意会话中选择模型'), JSON.stringify(r5));

  // 6. 回落 chatOnce（无 runAgentTask 时兼容旧行为）
  let chatCalls = 0;
  scheduler.startScheduler({ chatOnce: async () => { chatCalls++; return 'chat-done'; }, notify: noop });
  scheduler.setModel(TEST_MODEL);
  const r6 = await scheduler.runTask(t1.id, 'manual');
  checkOk('无 Agent 通道时回落 chatOnce', r6.ok === true && r6.output === 'chat-done' && chatCalls === 1, JSON.stringify(r6));
  const runs6 = await runsHandler({}, { id: t1.id });
  checkOk('回落记录 channel=chat', runs6.runs[0].channel === 'chat');

  scheduler.stopScheduler();
  fs.rmSync('/tmp/mjcode-test/scheduled-tasks.json', { force: true });
  console.log(`\nPASS：${pass}/${total} 项通过`);
  process.exit(pass === total ? 0 : 1);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
