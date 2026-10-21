// 第八轮 B-02 / 决策 D-809：组级三键预算**运行期强制点**（此前只进提示词文案与审计串）
//
// 为什么必须单独测：
//   `team-lead-dispatch.test.js` 只断言「预算字符串进了提示词」（`ctx.includes('max_rounds=6')`），
//   证明的是「模型被告知有上限」，不是「越界会被叫停」。第八轮审查正是判在这里：
//   三键运行期零强制点，实际只有 per-task timeoutMs 一闸。本套件断言的是**行为**：
//   ① max_rounds 真的成为引擎侧 maxRounds（不再是硬编码 20）；
//   ② max_tokens 越界后，剩余未开始任务被确定性置 skipped（不是交给模型判断）；
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
      runs.push({ groupId: opts.conversationId, maxRounds: opts.maxRounds, prompt: String(opts.messages[0].content) });
      // 模拟引擎上报用量（onMessage 是宿主侧的 usage 汇总通道）
      opts.onMessage?.({ role: 'assistant', tokens_input: tokensPerTask, tokens_output: 0, content: 'x' });
      return '已完成';
    },
  });

  // 场景 1：带预算的组，max_rounds 进 runOpts；首任务烧爆 token ⇒ 后续任务被跳过
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
    dag: { levels: [['t1'], ['t2']], runMeta: { budget: { max_rounds: 3, max_tokens: 1000, max_wall_ms: 600000 } } },
    tasks: [
      { id: 't1', title: '烧 token 的任务', prompt: 'x', dependsOn: [] },
      { id: 't2', title: '本该被跳过的任务', prompt: 'x', dependsOn: ['t1'] },
    ],
  });
  await runGroup('gb1');
  const g1 = await waitSettled(store, 'gb1');
  const t1 = g1.tasks.find((t) => t.taskId === 't1');
  const t2 = g1.tasks.find((t) => t.taskId === 't2');

  check('max_rounds 进引擎 runOpts（不再是硬编码 20）',
    runs.length >= 1 && runs[0].maxRounds === 3, String(runs[0] && runs[0].maxRounds));
  check('token 越界后剩余未开始任务被确定性置 skipped',
    !!t2 && t2.status === 'skipped', t2 && t2.status);
  check('跳过原因可读且标明预算耗尽',
    !!t2 && String(t2.error || '').includes('预算耗尽'), String(t2 && t2.error).slice(0, 80));
  check('越界不误伤已完成任务', !!t1 && t1.status === 'done', t1 && t1.status);
  check('组最终收尾（不悬挂在 running）',
    ['done', 'failed', 'paused'].includes(g1.status), g1.status);

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

  console.log(`\ngroup-budget: ${pass}/${pass + fail} 通过`);
  if (fail > 0) process.exitCode = 1;
  try { db.close(); } catch { /* sqljs 关闭失败不影响判定 */ }
})();
