// 第八轮 B-02 / 决策 D-809：组级三键预算**运行期强制点**（此前只进提示词文案与审计串）
//
// 为什么必须单独测：
//   `team-lead-dispatch.test.js` 只断言「预算字符串进了提示词」（`ctx.includes('max_rounds=6')`），
//   证明的是「模型被告知有上限」，不是「越界会被叫停」。第八轮审查正是判在这里：
//   三键运行期零强制点，实际只有 per-task timeoutMs 一闸。本套件断言的是**行为**：
//   ① max_rounds 真的成为引擎侧 maxRounds（不再是硬编码 20）；
//   ② max_tokens 是**软上限**：越界只告警，不跳过任务、不按人头切份额、不硬中止成员
//      （2026-10-21 真机 regression：人均份额把 4 个成员全部在自己额度处掐断，4 任务全 failed）；
//   ③ max_wall_ms 判定为确定性判定；
//   ④ 无预算的普通编排组零回归（maxRounds 仍 20、不跳任何任务）。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDbAsync } = require('../main/db');
const { TaskStore } = require('../main/taskStore');
const { initWorkerPool, runGroup } = require('../main/workerPool');
const groupBudget = require('../main/groupBudget');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitSettled(store, groupId, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const g = store.getGroup(groupId);
    if (['done', 'failed', 'paused', 'cancelled'].includes(g.status)) return g;
    await sleep(25);
  }
  return store.getGroup(groupId);
}

// ── A. 纯函数层：读预算 / 判定 / 账本 ──────────────────────────────
(function unitPart() {
  groupBudget.reset();

  // 无 runMeta → 不设限（普通编排组零回归的结构前提）
  check('无 dag.runMeta 的组读出 null 预算（普通编排组不设限）',
    groupBudget.readBudget({ group_id: 'x', dag: { levels: [] } }) === null);

  // 有 runMeta.budget → 归一（缺键补默认、越界夹紧）
  const b = groupBudget.readBudget({ dag: { runMeta: { budget: { max_tokens: 1000 } } } });
  check('预算缺键补默认值（max_rounds / max_wall_ms）',
    !!b && b.max_tokens === 1000 && b.max_rounds === 8 && b.max_wall_ms === 30 * 60 * 1000,
    JSON.stringify(b));
  const clamped = groupBudget.readBudget({ dag: { runMeta: { budget: { max_rounds: 999 } } } });
  check('预算越界被夹到硬区间（max_rounds 上限 50）', !!clamped && clamped.max_rounds === 50,
    String(clamped && clamped.max_rounds));

  // begin 幂等：重复登记不重置计时（防重入把墙钟清零）
  groupBudget.begin('gb-idem');
  const s1 = groupBudget.snapshotOf('gb-idem');
  groupBudget.begin('gb-idem');
  const s2 = groupBudget.snapshotOf('gb-idem');
  check('begin 幂等：重复调用不重置墙钟', !!s1 && !!s2 && s1.startedAt === s2.startedAt);

  // token 越界判定
  groupBudget.begin('gb-tok');
  groupBudget.addTokens('gb-tok', 5000);
  const vTok = groupBudget.assess('gb-tok', { max_rounds: 8, max_tokens: 1000, max_wall_ms: 600000 });
  check('token 越界被判定为 exhausted 且标明 key',
    vTok.exhausted === true && vTok.key === 'max_tokens' && vTok.message.includes('预算耗尽'), vTok.message);

  // 未越界不误报
  const vOk = groupBudget.assess('gb-tok', { max_rounds: 8, max_tokens: 999999, max_wall_ms: 600000 });
  check('未越界不误报 exhausted', vOk.exhausted === false);

  // 2026-10-21：预算计划不再按人头切份额，也不产出宿主侧硬中止阈值
  {
    const plan = groupBudget.planForTask(
      { group_id: 'gb-plan', dag: { runMeta: { budget: { max_tokens: 200000, max_rounds: 8, max_wall_ms: 600000 } } } },
      { taskId: 't1' },
    );
    check('planForTask 不再产出人均份额硬闸（无 tokenLimit 字段）', plan.tokenLimit === undefined,
      JSON.stringify(Object.keys(plan)));
    check('planForTask 的引擎预算取组剩余额度（不按任务数切分）', plan.tokenBudget === 200000,
      String(plan.tokenBudget));
  }

  // 2026-10-21：越界处置分工——token 软（不停派/不跳任务）、墙钟硬（停派并跳未开始任务）
  {
    const mkDeps = () => {
      const calls = { skipped: [], updates: [] };
      return {
        calls,
        store: {
          getGroup: () => ({ group_id: 'gb-trip', tasks: [
            { taskId: 'a', status: 'pending' }, { taskId: 'b', status: 'running' },
          ] }),
          setTaskStatus: (gid, tid, status) => { calls.skipped.push(`${tid}:${status}`); },
        },
        emit: (e) => calls.updates.push(e.type),
      };
    };
    groupBudget.begin('gb-trip-tok');
    groupBudget.addTokens('gb-trip-tok', 5000);
    const dTok = mkDeps();
    const tokStopped = groupBudget.tripIfExhausted(dTok, {
      group_id: 'gb-trip-tok', dag: { runMeta: { budget: { max_tokens: 1000, max_rounds: 8, max_wall_ms: 600000 } } },
    });
    check('token 越界：tripIfExhausted 不停派、不跳任务（软上限）',
      tokStopped === false && dTok.calls.skipped.length === 0, JSON.stringify(dTok.calls.skipped));

    const wallState = groupBudget.begin('gb-trip-wall');
    wallState.startedAt = Date.now() - 2000; // 直接拨回起跑时刻，避免测试真等 1s
    const dWall = mkDeps();
    const wallStopped = groupBudget.tripIfExhausted(dWall, {
      group_id: 'gb-trip-wall', dag: { runMeta: { budget: { max_tokens: 999999, max_rounds: 8, max_wall_ms: 1000 } } },
    });
    check('墙钟越界：硬闸停派，且只跳未开始任务（在途不动）',
      wallStopped === true && dWall.calls.skipped.join(',') === 'a:skipped', dWall.calls.skipped.join(','));
  }

  // 2026-10-21：非关键任务失败同样不得用 done 掩盖（真机 t2 失败但组 done）
  {
    const teamTrace = require('../main/teamWorkerTrace');
    const res = { warnings: [] };
    const note = teamTrace.finalizeNote({ tasks: [{ taskId: 'x', title: '失败步骤', status: 'failed' }] }, res);
    check('组收尾：非关键任务失败也返回可读失败原因',
      !!note && note.includes('失败任务') && res.warnings.length === 1, String(note));
  }

  groupBudget.clear('gb-tok');
  check('clear 后账本清空（组收尾不残留）', groupBudget.snapshotOf('gb-tok') === null);
})();

// ── B. 集成层：真正进 runOpts / 真正停派 ────────────────────────────
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-gb-'));
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  const store = new TaskStore(db);
  groupBudget.reset();

  const runs = [];
  const mkCore = (tokensPerTask) => async () => ({
    runAgent: async (opts) => {
      runs.push({ groupId: opts.conversationId, maxRounds: opts.maxRounds, tokenBudget: opts.tokenBudget, prompt: String(opts.messages[0].content) });
      // 模拟引擎上报用量（onMessage 是宿主侧的 usage 汇总通道）
      opts.onMessage?.({ role: 'assistant', tokens_input: tokensPerTask, tokens_output: 0, content: 'x' });
      return '已完成';
    },
  });

  // 场景 1：带预算的组，max_rounds 进 runOpts；token 越界是**软上限**（继续派发，不跳过任务）
  initWorkerPool({
    loadAgentCore: mkCore(5000),
    createToolHandlers: () => ({}),
    store,
    maxConcurrent: 2,
    emit: () => {},
    resolveModel: () => ({ providerId: 'p', isGlobal: false, baseUrl: '', model: 'm' }),
    buildTaskPrompt: (g, t) => t.title,
    getCheckpoint: () => null,
    saveCheckpoint: () => true,
  });

  // dag.runMeta.budget 是派活层随 dag_json 落库的位置（见 ipc/teams.js 的 planWaves）
  store.createGroup({
    groupId: 'gb1', goal: '预算组', cwd: '', threadId: 'c1',
    dag: { levels: [['t1', 't2', 't3']], runMeta: { budget: { max_rounds: 3, max_tokens: 1000, max_wall_ms: 600000 } } },
    tasks: [
      { id: 't1', title: '烧 token 的任务', prompt: 'x', dependsOn: [], critical: true },
      { id: 't2', title: '独立任务二', prompt: 'x', dependsOn: [] },
      { id: 't3', title: '独立任务三', prompt: 'x', dependsOn: [] },
    ],
  });
  await runGroup('gb1');
  const g1 = await waitSettled(store, 'gb1');
  const t1 = g1.tasks.find((t) => t.taskId === 't1');
  const t2 = g1.tasks.find((t) => t.taskId === 't2');
  const t3 = g1.tasks.find((t) => t.taskId === 't3');

  check('max_rounds 进引擎 runOpts（不再是硬编码 20）',
    runs.length >= 1 && runs[0].maxRounds === 3, String(runs[0] && runs[0].maxRounds));
  check('单任务 tokenBudget 取组剩余额度（不再按人头切份额）',
    runs.length >= 1 && runs[0].tokenBudget === 1000, String(runs[0] && runs[0].tokenBudget));
  check('token 越界后仍会派发全部任务（软上限，不跳过）',
    runs.length === 3 && !g1.tasks.some((t) => t.status === 'skipped'), `runs=${runs.length}`);
  // 2026-10-21 真机 regression：按人头切份额时，4 个成员各自在 44k/26k/20k 处被掐断、全员 failed。
  // 主流口径下成员可以动用组剩余额度，只由 max_rounds 与墙钟硬停，因此这里必须全部 done。
  check('成员不再因「人均 token 额度」被硬中止（全员完成，不再伪装 done 也不全员失败）',
    g1.tasks.every((t) => t.status === 'done'),
    g1.tasks.map((t) => `${t.taskId}:${t.status}`).join(','));
  check('独立任务同样执行（证明预算越界未阻断调度）',
    !!t2 && !['pending', 'queued'].includes(t2.status) && !!t3 && !['pending', 'queued'].includes(t3.status),
    `${t2 && t2.status} / ${t3 && t3.status}`);
  check('全部任务完成时组落 done（预算软上限不制造假失败）', g1.status === 'done', g1.status);

  // 场景 2：无预算的普通编排组 —— 零回归
  const runs2 = [];
  initWorkerPool({
    loadAgentCore: async () => ({
      runAgent: async (opts) => {
        runs2.push({ maxRounds: opts.maxRounds });
        return 'ok';
      },
    }),
    createToolHandlers: () => ({}),
    store,
    maxConcurrent: 1,
    emit: () => {},
    resolveModel: () => ({ providerId: 'p', isGlobal: false, baseUrl: '', model: 'm' }),
    buildTaskPrompt: (g, t) => t.title,
    getCheckpoint: () => null,
    saveCheckpoint: () => true,
  });
  store.createGroup({
    groupId: 'gb2', goal: '普通编排组', cwd: '', dag: { levels: [['p1']] },
    tasks: [{ id: 'p1', title: '普通任务', prompt: 'x', dependsOn: [] }],
  });
  await runGroup('gb2');
  const g2 = await waitSettled(store, 'gb2');
  check('无预算组 maxRounds 仍为历史值 20（零回归）',
    runs2.length === 1 && runs2[0].maxRounds === 20, String(runs2[0] && runs2[0].maxRounds));
  check('无预算组不跳过任何任务', g2.tasks.every((t) => t.status === 'done'), g2.status);

  // 场景 3：依赖级联 —— 前置 failed 时，传递依赖必须 skipped（否则组悬挂）
  store.createGroup({
    groupId: 'gb3', goal: '级联组', cwd: '', dag: { levels: [['a'], ['b'], ['c']] },
    tasks: [
      { id: 'a', title: 'a', prompt: 'x', dependsOn: [] },
      { id: 'b', title: 'b', prompt: 'x', dependsOn: ['a'] },
      { id: 'c', title: 'c', prompt: 'x', dependsOn: ['b'] },
    ],
  });
  store.setTaskStatus('gb3', 'a', 'failed', { error: '前置失败', force: true });
  const skippedIds = store.skipDependentsOf('gb3', 'a', '前置失败');
  check('依赖级联：传递依赖全部 skipped（防组悬挂）',
    skippedIds.length === 2 && ['b', 'c'].every((id) => store.getTask('gb3', id).status === 'skipped'),
    skippedIds.join(','));

  console.log(`\ngroup-budget: ${pass}/${pass + fail} 通过`);
  if (fail > 0) process.exitCode = 1;
  try { db.close(); } catch { /* sqljs 关闭失败不影响判定 */ }
})();
