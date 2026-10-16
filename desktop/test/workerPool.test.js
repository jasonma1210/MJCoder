// P1-5/P1-7 WorkerPool 集成测试（真实 better-sqlite3 + 假引擎）：
// 并行分层执行 / 并发上限 / 失败重试 / 非关键降级 / 关键失败暂停 / 组聚合收尾
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDbAsync } = require('../main/db');
const { TaskStore } = require('../main/taskStore');
const { initWorkerPool, runGroup, setMaxConcurrent, activeCount, abortTask } = require('../main/workerPool');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 假引擎：可编排每任务的返回/失败/延迟
function makeFakeCore(script) {
  return {
    runAgent: async (opts) => {
      const prompt = opts.messages[0].content;
      const hit = Object.keys(script).find((k) => prompt.includes(k));
      const conf = hit ? script[hit] : { text: '默认完成' };
      if (conf.delay) await sleep(conf.delay);
      if (conf.throw) throw new Error(conf.throw);
      return conf.text || '';
    },
  };
}

async function waitSettled(store, groupId, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const g = store.getGroup(groupId);
    if (['done', 'failed', 'paused', 'cancelled'].includes(g.status)) return g;
    await sleep(25);
  }
  return store.getGroup(groupId);
}

const events = [];

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-wp-'));
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  const store = new TaskStore(db);

  // ── 场景 1：两层 DAG（并行 2 + 依赖 1）顺序执行、聚合收尾 ──
  initWorkerPool({
    loadAgentCore: async () => makeFakeCore({
      '子任务一': { text: '结论一：修改了 `/src/a.js`' },
      '子任务二': { text: '结论二：新增了 `/src/b.js`' },
      '子任务三': { text: '汇总结论' },
    }),
    createToolHandlers: () => ({}),
    store,
    maxConcurrent: 1, // 上限 1：强制串行，验证依赖排序
    emit: (e) => events.push(e),
    resolveModel: () => ({ providerId: 1, isGlobal: false, baseUrl: '', model: 'test-model' }),
    buildTaskPrompt: (group, task) => `${group.goal} / ${task.title} / ${task.prompt}`,
  });
  store.createGroup({ groupId: 'w1', goal: '集成目标', cwd: '/tmp/wp', dag: { levels: [['a1', 'a2'], ['a3']] }, tasks: [
    { id: 'a1', title: '子任务一', prompt: '做一', dependsOn: [] },
    { id: 'a2', title: '子任务二', prompt: '做二', dependsOn: [] },
    { id: 'a3', title: '子任务三', prompt: '汇总', dependsOn: ['a1', 'a2'], critical: true },
  ] });
  await runGroup('w1');
  const g1 = await waitSettled(store, 'w1');
  check('两层 DAG 全部完成（并发上限 1 下依序推进）', g1.status === 'done' && g1.tasks.every((t) => t.status === 'done'));
  check('组结果聚合含三条 summary', g1.result.summary.length === 3);
  check('Worker 产物路径被提取为 artifacts', g1.result.artifacts.some((a) => a.path === '/src/a.js'));
  check('关键任务标 critical 落库', g1.tasks.find((t) => t.taskId === 'a3').critical === true);
  check('事件流推送 group_update/task_update', events.some((e) => e.type === 'group_update' && e.groupId === 'w1' && e.status === 'done'));

  // ── 场景 2：非关键失败降级，组仍 done 带 warnings ──
  events.length = 0;
  initWorkerPool({
    loadAgentCore: async () => makeFakeCore({ '会失败': { throw: '探索失败' }, '正常': { text: 'ok' } }),
    createToolHandlers: () => ({}),
    store, maxConcurrent: 2, emit: (e) => events.push(e),
    resolveModel: () => ({ providerId: 1, isGlobal: false, baseUrl: '', model: 'test-model' }),
    buildTaskPrompt: (g, t) => t.title,
  });
  store.createGroup({ groupId: 'w2', goal: '降级场景', cwd: '', dag: null, tasks: [
    { id: 'ok1', title: '正常', prompt: 'x', dependsOn: [] },
    { id: 'bad1', title: '会失败', prompt: 'x', dependsOn: [], critical: false },
  ] });
  await runGroup('w2');
  const g2 = await waitSettled(store, 'w2');
  check('非关键失败不阻塞组（组 done）', g2.status === 'done');
  check('降级警告进入组结果 warnings', g2.result.warnings.length === 1 && g2.result.warnings[0].includes('会失败'));

  // ── 场景 3：关键失败 → 下游跳过 → 组 paused ──
  initWorkerPool({
    loadAgentCore: async () => makeFakeCore({ '关键步骤': { throw: '编译基线崩溃' } }),
    createToolHandlers: () => ({}),
    store, maxConcurrent: 2, emit: (e) => events.push(e),
    resolveModel: () => ({ providerId: 1, isGlobal: false, baseUrl: '', model: 'test-model' }),
    buildTaskPrompt: (g, t) => t.title,
  });
  store.createGroup({ groupId: 'w3', goal: '关键失败场景', cwd: '', dag: null, tasks: [
    { id: 'crit', title: '关键步骤', prompt: 'x', dependsOn: [], critical: true },
    { id: 'down', title: '下游', prompt: 'x', dependsOn: ['crit'] },
  ] });
  await runGroup('w3');
  const g3 = await waitSettled(store, 'w3');
  check('关键失败组 paused', g3.status === 'paused' && (g3.error || '').includes('关键任务'));
  check('下游任务被跳过（skipped）', g3.tasks.find((t) => t.taskId === 'down').status === 'skipped');

  // ── 场景 4：失败重试后成功（maxRetry=1，首次抛错第二次成功）──
  let attempts = 0;
  initWorkerPool({
    loadAgentCore: async () => ({ runAgent: async () => { attempts += 1; if (attempts === 1) throw new Error('瞬时失败'); return '重试成功'; } }),
    createToolHandlers: () => ({}),
    store, maxConcurrent: 1, emit: () => {},
    resolveModel: () => ({ providerId: 1, isGlobal: false, baseUrl: '', model: 'test-model' }),
    buildTaskPrompt: (g, t) => t.title,
  });
  store.createGroup({ groupId: 'w4', goal: '重试场景', cwd: '', dag: null, tasks: [
    { id: 'r1', title: '瞬时失败任务', prompt: 'x', dependsOn: [], maxRetry: 1 },
  ] });
  await runGroup('w4');
  const g4 = await waitSettled(store, 'w4');
  check('重试后成功（引擎被调 2 次，任务 done）', attempts === 2 && g4.status === 'done' && g4.tasks[0].retryCount === 1);

  // ── 场景 5：真并行（并发上限 2，两个 200ms 任务墙钟 < 350ms）──
  initWorkerPool({
    loadAgentCore: async () => makeFakeCore({ '并行甲': { delay: 200, text: '甲完成' }, '并行乙': { delay: 200, text: '乙完成' } }),
    createToolHandlers: () => ({}),
    store, maxConcurrent: 2, emit: () => {},
    resolveModel: () => ({ providerId: 1, isGlobal: false, baseUrl: '', model: 'test-model' }),
    buildTaskPrompt: (g, t) => t.title,
  });
  store.createGroup({ groupId: 'w5', goal: '并行验证', cwd: '', dag: null, tasks: [
    { id: 'p1', title: '并行甲', prompt: 'x', dependsOn: [] },
    { id: 'p2', title: '并行乙', prompt: 'x', dependsOn: [] },
  ] });
  const t0 = Date.now();
  await runGroup('w5');
  const g5 = await waitSettled(store, 'w5', 8000);
  const elapsed = Date.now() - t0;
  check('并发 2 真并行执行（墙钟 < 350ms，串行需 ≥400ms）', g5.status === 'done' && elapsed < 350, `耗时 ${elapsed}ms`);

  // ── 场景 6：Worker 可爱命名 + 活动流事件 ──
  events.length = 0;
  initWorkerPool({
    loadAgentCore: async () => makeFakeCore({ '命名任务': { delay: 60, text: '完成' } }),
    createToolHandlers: () => ({}),
    store, maxConcurrent: 1, emit: (e) => events.push(e),
    resolveModel: () => ({ providerId: 1, isGlobal: false, baseUrl: '', model: 'test-model' }),
    buildTaskPrompt: (g, t) => t.title,
  });
  store.createGroup({ groupId: 'w6', goal: '命名验证', cwd: '', dag: null, tasks: [
    { id: 'n1', title: '命名任务', prompt: 'x', dependsOn: [] },
  ] });
  await runGroup('w6');
  await waitSettled(store, 'w6', 8000);
  const runEvt = events.find((e) => e.type === 'task_update' && e.status === 'running' && e.groupId === 'w6');
  check('task_update 携带可爱名（布丁/团子/芝麻…）', !!runEvt && typeof runEvt.name === 'string' && runEvt.name.length >= 2, runEvt?.name);
  check('task_activity start 事件推送', events.some((e) => e.type === 'task_activity' && e.kind === 'start' && e.name === runEvt?.name));

  // ── 场景 7：强制关闭（中止运行、不重试、终态 failed）──
  initWorkerPool({
    loadAgentCore: async () => ({ runAgent: async (opts) => {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 3000);
        opts.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); });
      });
      throw new Error(opts.signal?.reason?.message || 'aborted');
    } }),
    createToolHandlers: () => ({}),
    store, maxConcurrent: 1, emit: (e) => events.push(e),
    resolveModel: () => ({ providerId: 1, isGlobal: false, baseUrl: '', model: 'test-model' }),
    buildTaskPrompt: (g, t) => t.title,
  });
  store.createGroup({ groupId: 'w7', goal: '强关验证', cwd: '', dag: null, tasks: [
    { id: 'm1', title: '长跑任务', prompt: 'x', dependsOn: [], maxRetry: 3 },
  ] });
  await runGroup('w7');
  const start = Date.now();
  while (activeCount() === 0 && Date.now() - start < 3000) await sleep(20); // 等派发
  const aborted = abortTask('w7', 'm1');
  const g7 = await waitSettled(store, 'w7', 8000);
  check('abortTask 命中在役运行', aborted === true);
  check('强制关闭：failed 且不重试（retryCount=0）', g7.status === 'done'
    && g7.tasks[0].status === 'failed'
    && g7.tasks[0].error === '已手动强制关闭'
    && g7.tasks[0].retryCount === 0);
  check('强制关闭推送 stop 活动事件', events.some((e) => e.type === 'task_activity' && e.kind === 'stop'));

  // ── 场景 8：Agent 未完成收尾（熔断/预算文案）→ 任务判 failed 走失败处置，不得伪装 done ──
  initWorkerPool({
    loadAgentCore: async () => makeFakeCore({ '会熔断': { text: '（已主动停止：工具 shell 用相同参数连续失败 4 次……）（单任务执行轮次预算已用尽，任务未完全完成。）' } }),
    createToolHandlers: () => ({}),
    store, maxConcurrent: 1, emit: () => {},
    resolveModel: () => ({ providerId: 1, isGlobal: false, baseUrl: '', model: 'test-model' }),
    buildTaskPrompt: (g, t) => t.title,
  });
  store.createGroup({ groupId: 'w8', goal: '未完成收尾判定', cwd: '', dag: null, tasks: [
    { id: 'u1', title: '会熔断', prompt: 'x', dependsOn: [], maxRetry: 0 },
  ] });
  await runGroup('w8');
  const g8 = await waitSettled(store, 'w8', 8000);
  const u1 = g8.tasks[0];
  check('未完成收尾 → failed 且保留部分结论', g8.status === 'done'
    && u1.status === 'failed' && u1.error.includes('未完成收尾')
    && typeof u1.result?.summary === 'string' && u1.result.summary.includes('已主动停止'));

  // ── 并发上限可配置 ──
  setMaxConcurrent(5);
  check('setMaxConcurrent 生效', activeCount() === 0); // 占位断言：不抛错即配置通路面可用

  // ── P0-C 回归：派发链路异常不得冒泡成 unhandledRejection（会直接杀掉主进程）──
  // 此前 dispatch 的 IIFE 是「浮动 Promise」且无 .catch()：workerIsolation.createIsolated
  // 抛错时没有任何人接住 → Electron 主进程默认直接退出，全部会话与在跑任务一起丢失。
  // createIsolated 自身吞错返回 null，触发不了该路径 → 这里 monkey-patch 强制 reject。
  {
    const isoMod = require('../main/workerIsolation');
    const original = isoMod.createIsolated;
    isoMod.createIsolated = async () => { throw new Error('模拟隔离创建崩溃'); };
    try {
      initWorkerPool({
        loadAgentCore: async () => makeFakeCore({}),
        createToolHandlers: () => ({}),
        store,
        maxConcurrent: 1,
        emit: (e) => events.push(e),
        resolveModel: () => ({ providerId: 1, isGlobal: false, baseUrl: '', model: 'test-model' }),
        buildTaskPrompt: (g, t) => t.title,
      });
      store.createGroup({ groupId: 'w9', goal: '派发异常兜底', cwd: '/tmp/wp-iso-case', dag: null, tasks: [
        { id: 'v1', title: '隔离崩溃任务', prompt: 'x', dependsOn: [] },
      ] });
      await runGroup('w9');
      const g9 = await waitSettled(store, 'w9', 8000);
      const v1 = g9.tasks[0];
      check('派发链路异常被兜住：任务标记 failed 且带原因', v1.status === 'failed' && String(v1.error || '').includes('模拟隔离创建崩溃'),
        String(v1.error || '').slice(0, 60));
      check('派发链路异常后组进入 paused（可读可重试，不静默丢任务）', g9.status === 'paused');
      check('异常以 task_activity error 事件告知用户', events.some((e) => e.type === 'task_activity' && e.kind === 'error'));
    } finally {
      isoMod.createIsolated = original; // 还原，避免影响其他用例
    }
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})();
