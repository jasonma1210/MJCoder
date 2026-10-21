// 第八轮 B-01 / 决策 D-808：军团成员运行期配置**是否真的生效**（per-bot / DS Bot 特性 S-3~S-6）
//
// 为什么单独建这个套件：
//   `member-model.test.js` 覆盖的是「引用串编解码 + resolveModelRef」——**测的是解析，不是绑定**。
//   第八轮审查实测发现：配置存进了 dag.roster 快照，但 Worker 的 runOpts 一个字段都不读，
//   结果「声明了限制却不执行」（配 toolNames=['read','grep'] 实际拿到全量工具）。
//   本套件直接断言**引擎实际收到的 runOpts**，堵的就是这个「存了但没消费」的洞。
//
// 覆盖七件事：
//   ① 工具子集：成员 toolNames → runOpts.rolePreset.toolNames（引擎据此做交集裁剪 + 空交集 fail-closed）
//   ② 人格：成员 systemPrompt → runOpts.rolePreset.systemPrompt（走引擎 guardUntrusted 注入检测）
//   ③ 模型：成员 model → runOpts.model 覆盖为成员绑定（per-agent 优先于默认模型）
//   ④ 技能：成员 skillNames → 按名装载后进 runOpts.skills
//   ⑤ 治理档取更严：成员 approvalMode / sandboxPolicy 只会收紧，不会放宽
//   ⑥ per-bot 隔离：成员 A 的配置不会串到成员 B
//   ⑦ 零回归：非军团组 / 未认领任务 → 不注入 rolePreset，行为与第八轮之前完全一致
//   另有一条「收尾纪律不被人格挤掉」：systemPrompt 仍是 Worker 基线（自测验证 + summary）。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDbAsync } = require('../main/db');
const { TaskStore } = require('../main/taskStore');
const { initWorkerPool, runGroup } = require('../main/workerPool');

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

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-mrc-'));
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  const store = new TaskStore(db);

  // m1 六项配置全配；m2 一项都不配（用于验证 per-bot 隔离 + 「不配就不限制」）
  const roster = [
    {
      id: 'm1', name: '架构师', roleKind: 'member',
      systemPrompt: '你是本团队的架构师：只做接口设计与评审，不写实现代码。',
      toolNames: ['read_file', 'grep'],
      model: 'provA/M1',
      approvalMode: 'always',
      sandboxPolicy: 'read-only',
      skillNames: ['arch-review'],
    },
    { id: 'm2', name: '测试员', roleKind: 'member' },
  ];

  const runs = [];
  initWorkerPool({
    loadAgentCore: async () => ({
      runAgent: async (opts) => {
        runs.push({
          conversationId: opts.conversationId,
          model: opts.model,
          approvalMode: opts.approvalMode,
          sandboxPolicy: opts.sandboxPolicy,
          systemPrompt: opts.systemPrompt,
          skills: opts.skills,
          rolePreset: opts.rolePreset,
        });
        return '已完成本子任务';
      },
    }),
    createToolHandlers: () => ({}),
    store,
    maxConcurrent: 2,
    emit: () => {},
    // 基线模型：与成员绑定的 provA/M1 明显不同，用来证明「覆盖真的发生了」
    resolveModel: () => ({ providerId: 'base', isGlobal: false, baseUrl: '', model: 'base-model' }),
    resolveModelRef: (ref) => (ref === 'provA/M1' ? { providerId: 'provA', isGlobal: false, baseUrl: '', model: 'M1' } : null),
    loadSkillContents: (names) => names.map((n) => `SKILL:${n}`),
    buildTaskPrompt: (g, t) => t.title,
    resolveTeamRoster: (g) => (g.group_id === 's1' ? roster : null),
    getCheckpoint: () => null,
    saveCheckpoint: () => true,
  });

  // ── 军团组：两个任务分别分给 m1 / m2（seq 取模：t1→m1, t2→m2）──
  store.createGroup({
    groupId: 's1', goal: '成员配置生效验证', cwd: '', dag: null, threadId: 'conv-1', tasks: [
      { id: 't1', title: '接口设计', prompt: 'x', dependsOn: [] },
      { id: 't2', title: '补测试', prompt: 'x', dependsOn: [] },
    ],
  });
  await runGroup('s1');
  await waitSettled(store, 's1');

  const r1 = runs.find((r) => r.conversationId === 'agent:m1');
  const r2 = runs.find((r) => r.conversationId === 'agent:m2');

  // 前提：两个成员任务都真的跑了（否则下面全是空过）
  check('两名成员的 Worker 都实际执行', !!r1 && !!r2, `runs=${runs.length}`);

  // ① 工具子集
  check('成员 toolNames 进入引擎 rolePreset（引擎据此做交集裁剪）',
    !!r1 && Array.isArray(r1.rolePreset?.toolNames)
      && r1.rolePreset.toolNames.length === 2
      && r1.rolePreset.toolNames.includes('read_file')
      && r1.rolePreset.toolNames.includes('grep'),
    JSON.stringify(r1?.rolePreset?.toolNames || null));

  // ② 人格
  check('成员 systemPrompt 进入 rolePreset（走引擎注入检测，不裸拼接）',
    !!r1 && String(r1.rolePreset?.systemPrompt || '').includes('只做接口设计与评审'));

  // ②b 收尾纪律不被人格挤掉：runOpts.systemPrompt 仍是 Worker 基线
  check('Worker 收尾纪律保留（自测验证 + summary），与成员人格叠加而非互斥',
    !!r1 && typeof r1.systemPrompt === 'string'
      && r1.systemPrompt.includes('并行任务 Worker')
      && r1.systemPrompt.includes('summary'));

  // ③ 模型覆盖
  const m1Model = JSON.stringify(r1?.model || {});
  check('成员 model 覆盖默认模型（per-agent 优先于 resolveModel 基线）',
    m1Model.includes('provA') && m1Model.includes('M1') && !m1Model.includes('base-model'),
    m1Model.slice(0, 160));

  // ④ 技能装载
  check('成员 skillNames 按名装载后进 skills',
    !!r1 && Array.isArray(r1.skills) && r1.skills.includes('SKILL:arch-review'),
    JSON.stringify(r1?.skills || null));

  // ⑤ 治理档取更严（always 严于 auto-safe 地板；read-only 严于组快照）
  check('成员 approvalMode 与基线取更严者（always 胜出）', r1?.approvalMode === 'always', r1?.approvalMode);
  check('成员 sandboxPolicy 与基线取更严者（read-only 胜出）', r1?.sandboxPolicy === 'read-only', r1?.sandboxPolicy);

  // ⑥ per-bot 隔离：m2 没配任何东西 ⇒ 不能被 m1 的配置污染，也不能自我限制
  check('成员 B 未配置工具集 ⇒ 不受成员 A 影响（空数组 = 不限制）',
    !!r2 && Array.isArray(r2.rolePreset?.toolNames) && r2.rolePreset.toolNames.length === 0,
    JSON.stringify(r2?.rolePreset?.toolNames || null));
  check('成员 B 未配置人格 / 技能 / 模型绑定',
    !!r2 && !r2.rolePreset?.systemPrompt && !r2.rolePreset?.model
      && (!r2.skills || r2.skills.length === 0));
  check('成员 B 的模型仍是基线模型（未被成员 A 的绑定串味）',
    JSON.stringify(r2?.model || {}).includes('base-model'),
    JSON.stringify(r2?.model || {}).slice(0, 120));

  // ── ⑦ 零回归：非军团组（名册为 null）──
  const runs2 = [];
  initWorkerPool({
    loadAgentCore: async () => ({
      runAgent: async (opts) => { runs2.push({ rolePreset: opts.rolePreset, approvalMode: opts.approvalMode }); return 'ok'; },
    }),
    createToolHandlers: () => ({}),
    store,
    maxConcurrent: 1,
    emit: () => {},
    resolveModel: () => ({ providerId: 'base', isGlobal: false, baseUrl: '', model: 'base-model' }),
    buildTaskPrompt: (g, t) => t.title,
    resolveTeamRoster: () => null,
    getCheckpoint: () => null,
    saveCheckpoint: () => true,
  });
  store.createGroup({
    groupId: 'plain1', goal: '普通编排组', cwd: '', dag: null, tasks: [
      { id: 'p1', title: '普通任务', prompt: 'x', dependsOn: [] },
    ],
  });
  await runGroup('plain1');
  await waitSettled(store, 'plain1');
  check('非军团组不注入 rolePreset（零回归）', runs2.length === 1 && runs2[0].rolePreset === undefined,
    JSON.stringify(runs2[0]?.rolePreset || null));

  console.log(`\nmember-runtime-config: ${pass}/${pass + fail} 通过`);
  if (fail > 0) process.exitCode = 1;
  try { db.close(); } catch { /* sqljs 关闭失败不影响判定 */ }
})();
