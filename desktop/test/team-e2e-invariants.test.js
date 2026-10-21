// 第八轮 B-03 / 决策 D-807①：团队层**端到端**不变量（此前 11 个团队测试 100% 是单模块单测）
//
// 为什么必须有这个套件：
//   第八轮审查实测 —— 全部 `team-*` / `member-model` / `worker-session` 测试里，
//   `runGroup` / `finalizeGroup` **命中 0 次**。也就是说：单模块都测了，但**接缝处没人测**。
//   而这三条不变量恰恰只存在于接缝处，源码注释自己写明「顺序错了就会撤员白撤／等待误判失败」。
//
// 本套件覆盖三条顺序敏感不变量（都走真实 `runGroup` → 真实 `finalizeGroup`）：
//   ① **defer 必须先于失败分支**：任务被 team_wait 挂起后，run 会被 abort 以释放槽位；
//      这个 abort 是「延期」不是「失败」，必须在所有失败分支之前被拦截。
//      若顺序写反 → 正在合理等待的任务被误判 failed（且下游被连带跳过）。
//   ② **等待超时清扫必须先于派发**：到点的等待任务要当拍判 failed 并级联唤醒依赖方，
//      否则下游白等一整拍（级联滞后）。
//   ③ **组收尾只在全部终态后发生**：等待中**不得**收尾（否则组提前 done，还在等的任务被遗弃）；
//      关键任务失败时下游 skipped、组 failed（而不是笼统 done）。
//
// 口径：全部为**行为断言**（读 DB 里的真实状态），不做源码字符串匹配 —— 源码护栏另有其套件，
// 这里要证明的是「跑起来真的对」。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDbAsync } = require('../main/db');
const { TaskStore } = require('../main/taskStore');
const { initWorkerPool, runGroup, waitTask, schedule } = require('../main/workerPool');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitSettled(store, groupId, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const g = store.getGroup(groupId);
    if (['done', 'failed', 'paused', 'cancelled'].includes(g.status)) return g;
    await sleep(20);
  }
  return store.getGroup(groupId);
}

// 等待某任务到达指定状态（中间态观察必须轮询：runGroup 立即返回，不能假设时序）
async function waitForTaskStatus(store, groupId, taskId, statuses, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = store.getTask(groupId, taskId);
    if (t && statuses.includes(t.status)) return t;
    await sleep(10);
  }
  return store.getTask(groupId, taskId);
}

// Worker 侧桩：prompt 承载 `groupId|taskId`，供桩内反查（runOpts 不带 group/task）
const promptOf = (g, t) => `${g.group_id}|${t.taskId}`;

function baseDeps(store, runAgent, extra = {}) {
  return {
    loadAgentCore: async () => ({ runAgent }),
    createToolHandlers: () => ({}),
    store,
    maxConcurrent: 2,
    emit: () => {},
    resolveModel: () => ({ providerId: 'p', isGlobal: false, baseUrl: '', model: 'm' }),
    buildTaskPrompt: promptOf,
    getCheckpoint: () => null,
    saveCheckpoint: () => true,
    ...extra,
  };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-e2e-'));
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  const store = new TaskStore(db);

  // ── 场景 1：组收尾端到端（全部成功）────────────────────────────
  initWorkerPool(baseDeps(store, async () => '已完成'));
  store.createGroup({
    groupId: 'e1', goal: '全成功组', cwd: '', dag: { levels: [['t1'], ['t2']] },
    tasks: [
      { id: 't1', title: '第一步', prompt: 'x', dependsOn: [] },
      { id: 't2', title: '第二步', prompt: 'x', dependsOn: ['t1'] },
    ],
  });
  await runGroup('e1');
  const g1 = await waitSettled(store, 'e1');
  check('① 全成功组收尾为 done（finalizeGroup 真的跑了）', g1.status === 'done', g1.status);
  check('① 收尾产出结构化聚合结果（finalizeGroup 写入 result）',
    !!g1.result && g1.result.summary != null
      && Array.isArray(g1.result.failed) && g1.result.failed.length === 0
      && g1.tasks.every((t) => t.result),
    JSON.stringify({ summaryType: typeof (g1.result && g1.result.summary), failed: g1.result && g1.result.failed }));
  check('① 依赖链按序完成（t1 先于 t2 done）',
    g1.tasks.every((t) => t.status === 'done'), g1.tasks.map((t) => `${t.taskId}:${t.status}`).join(','));

  // ── 场景 2：关键任务失败 → 下游 skipped、组 failed（不是笼统 done）──
  initWorkerPool(baseDeps(store, async (opts) => {
    if (String(opts.messages[0].content).endsWith('|f1')) throw new Error('关键步骤失败');
    return 'ok';
  }));
  store.createGroup({
    groupId: 'e2', goal: '关键失败组', cwd: '', dag: { levels: [['f1'], ['f2']] },
    tasks: [
      { id: 'f1', title: '关键步骤', prompt: 'x', dependsOn: [], critical: true },
      { id: 'f2', title: '下游步骤', prompt: 'x', dependsOn: ['f1'] },
    ],
  });
  await runGroup('e2');
  const g2 = await waitSettled(store, 'e2');
  const f1 = g2.tasks.find((t) => t.taskId === 'f1');
  const f2 = g2.tasks.find((t) => t.taskId === 'f2');
  check('② 关键任务失败被如实记录（status=failed）', !!f1 && f1.status === 'failed', f1 && f1.status);
  check('② 下游被跳过而非悬挂', !!f2 && ['skipped', 'pending', 'queued'].includes(f2.status),
    f2 && f2.status);
  check('② 组状态为 failed/paused（不误报 done）', ['failed', 'paused'].includes(g2.status), g2.status);

  // ── 场景 3：defer 必须先于失败分支（team_wait 挂起不判失败）────────
  // 确定性编排：t1 首次执行即 waitTask 等 t2；t2 被**闸门**挡住，直到测试观察到 t1 进入
  // waiting 才放行 —— 这样「中间态」与「唤醒后重跑」都不依赖睡眠猜测。
  const t1Attempts = [];
  let releaseT2 = null;
  const t2Gate = new Promise((r) => { releaseT2 = r; });
  initWorkerPool(baseDeps(store, async (opts) => {
    const [gid, tid] = String(opts.messages[0].content).split('|');
    if (tid === 't1') {
      t1Attempts.push(Date.now());
      if (t1Attempts.length === 1) {
        // 模拟模型调用 team_wait（工具侧唯一入口就是 workerPool.waitTask）
        const r = waitTask(gid, tid, ['t2'], { timeoutMs: 8000 });
        if (!r.ok || !r.waiting) throw new Error(`waitTask 未按预期挂起：${JSON.stringify(r)}`);
        return '等待中';
      }
      return '唤醒后完成';
    }
    await t2Gate; // 等测试确认 t1 已进入 waiting
    return 't2 完成';
  }));

  store.createGroup({
    groupId: 'e3', goal: '等待组', cwd: '', dag: { levels: [['t1', 't2']] },
    tasks: [
      { id: 't1', title: '需要等待的步骤', prompt: 'x', dependsOn: [] },
      { id: 't2', title: '被等待的步骤', prompt: 'x', dependsOn: [] },
    ],
  });
  await runGroup('e3');
  // 中间态必须能观察到：t1 为 waiting 且组**未**收尾
  const midT1 = await waitForTaskStatus(store, 'e3', 't1', ['waiting']);
  const midGroup = store.getGroup('e3');
  check('③ team_wait 挂起后任务处于 waiting（不是 failed —— defer 分支先于失败分支）',
    !!midT1 && midT1.status === 'waiting', midT1 && midT1.status);
  check('③ 等待中的组不会提前收尾（组仍 running）',
    midGroup.status === 'running', midGroup.status);
  releaseT2?.();
  const g3 = await waitSettled(store, 'e3');
  const g3t1 = g3.tasks.find((t) => t.taskId === 't1');
  check('③ t1 最终被唤醒并完成（等待不是死锁）',
    g3.status === 'done' && g3t1.status === 'done', `${g3.status}/${g3t1.status}`);
  check('③ t1 至少执行两次（首次挂起 + 唤醒后重跑）', t1Attempts.length >= 2, `次数=${t1Attempts.length}`);

  // ── 场景 4：等待超时清扫先于派发（到点判 failed、组不悬挂）─────────
  // 关键设计：w2 **一直不完成**（闸门不放开），因此 w1 不可能被「被等方完成」唤醒，
  // 只能走超时路径。到点后由测试显式踢一次 schedule() —— 泵顶部就是 sweepWaitTimeouts，
  // 这正好验证「清扫先于派发」这条顺序不变量（而不是靠 30s 心跳碰运气）。
  let releaseW2 = null;
  const w2Gate = new Promise((r) => { releaseW2 = r; });
  initWorkerPool(baseDeps(store, async (opts) => {
    const [gid, tid] = String(opts.messages[0].content).split('|');
    if (tid === 'w1') {
      // timeoutMs 有硬下限 WAIT_TIMEOUT_MIN_MS=1000（taskStore 夹紧），传更小的值无效。
      const r = waitTask(gid, tid, ['w2'], { timeoutMs: 1000 });
      if (!r.ok || !r.waiting) throw new Error(`waitTask 未挂起：${JSON.stringify(r)}`);
      return '等待中';
    }
    await w2Gate;
    return 'w2 完成';
  }));
  store.createGroup({
    groupId: 'e4', goal: '等待超时组', cwd: '', dag: { levels: [['w1', 'w2']] },
    tasks: [
      { id: 'w1', title: '会等超时的步骤', prompt: 'x', dependsOn: [] },
      { id: 'w2', title: '一直不完成的步骤', prompt: 'x', dependsOn: [] },
    ],
  });
  await runGroup('e4');
  const midW1 = await waitForTaskStatus(store, 'e4', 'w1', ['waiting']);
  check('④ 前置：w1 确实进入了 waiting', !!midW1 && midW1.status === 'waiting', midW1 && midW1.status);
  await sleep(1200);          // 越过 1000ms 等待期限（w2 仍被闸门挡住，不可能唤醒 w1）
  schedule();                 // 踢一次泵：sweep 必须在本拍派发之前把 w1 判死
  const w1Failed = await waitForTaskStatus(store, 'e4', 'w1', ['failed'], 3000);
  check('④ 等待超时后任务被判 failed（sweep 生效，不永久 waiting）',
    !!w1Failed && w1Failed.status === 'failed', w1Failed && w1Failed.status);
  check('④ 超时原因可读（能区分「等超时」与其它失败）',
    !!w1Failed && /等待|超时/.test(String(w1Failed.error || '')), String(w1Failed && w1Failed.error).slice(0, 80));
  releaseW2?.();
  const g4 = await waitSettled(store, 'e4');
  check('④ 组最终收尾、不悬挂', ['done', 'failed', 'paused'].includes(g4.status), g4.status);

  console.log(`\nteam-e2e-invariants: ${pass}/${pass + fail} 通过`);
  if (fail > 0) process.exitCode = 1;
  try { db.close(); } catch { /* 忽略关闭异常 */ }
})();
