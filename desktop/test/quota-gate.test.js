// DS Bots / T6-7 测试：配额闸调度侧接线（泵前置拦截 / 开跑预留 / 结算补差 / 老化恢复）
//
// 覆盖设计稿 §7.1 的四个检查点中属于调度侧的三处：
//   ① 派发前 blocked()：配额不足 → 组内 queued 转 quota_suspend，running 不动；
//   ② 开跑前 beginRun()：预留授予失败同样落 quota_suspend（不判 failed）；
//   ③ 结束后 settle：按轮合并记账 + 补差 + 释放预留（额度不泄漏）；
// 以及 §6.3 的后台 tickAll：老化后小批量回 queued → 自动续跑。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDbAsync } = require('../main/db');
const { TaskStore } = require('../main/taskStore');
const { ProjectStore } = require('../main/projectStore');
const { QuotaLedger } = require('../main/quotaLedger');
const { createQuotaGate, RESUME_BATCH } = require('../main/quotaGate');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-qgate-'));
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  const store = new TaskStore(db);
  const projects = new ProjectStore(db);
  const ledger = new QuotaLedger(db);
  const events = [];
  let resumedKicks = 0;
  const gate = createQuotaGate({
    ledger,
    store,
    db,
    projectOfThread: (tid) => projects.getProjectByThread(tid),
    emit: (e) => events.push(e),
    onResumed: () => { resumedKicks += 1; },
  });

  // ── 场景 1：无项目绑定的普通编排组 fail-open（零回归）──
  store.createGroup({ groupId: 'g-none', goal: '普通组', cwd: '', dag: null, tasks: [{ id: 'n1', title: '任务', prompt: 'x' }] });
  check('无 thread 的组不设闸（blocked=false）', gate.blocked(store.getGroup('g-none')) === false);
  check('无 thread 的组不授予预留（beginRun=null）', gate.beginRun(store.getGroup('g-none'), { taskId: 'n1' }) === null);

  // ── 场景 2：项目配额耗尽 → queued 任务转 quota_suspend ──
  projects.createProject({ projectId: 'prj_a', name: '项目A', objective: '目标A', threadId: 'thr-a' });
  // 总量低于恢复下限：beforeDispatch 直接判 suspended（模拟 100% 打满）
  ledger.ensureBucket('prj_a', { totalLimit: 50000, resumeMinTokens: 100000 });
  store.createGroup({
    groupId: 'g-a', goal: '项目组A', cwd: '', threadId: 'thr-a',
    // 两个独立任务：配额闸只拦 queued，依赖任务会让 a2 停在 pending 而不在拦截面内
    tasks: [{ id: 'a1', title: '一', prompt: 'x' }, { id: 'a2', title: '二', prompt: 'x' }],
  });
  const queuedA = store.enqueueReady('g-a');
  check('场景2 前置：两个任务已入队', queuedA.length === 2);
  events.length = 0;
  check('配额不足时泵闸拦截（blocked=true）', gate.blocked(store.getGroup('g-a')) === true);
  const ga = store.getGroup('g-a');
  check('queued 任务全部转 quota_suspend', ga.tasks.every((t) => t.status === 'quota_suspend'));
  check('暂停事件带任务 id 与状态', events.filter((e) => e.type === 'task_update' && e.status === 'quota_suspend').length === 2);
  const quotaEvent = events.find((e) => e.type === 'quota_state');
  check('广播 quota_state=suspended', quotaEvent && quotaEvent.state === 'suspended' && quotaEvent.projectId === 'prj_a');
  check('project_runs.quota_state=suspended（§5.2 用 run 列表达暂停）',
    db.prepare('SELECT quota_state FROM project_runs WHERE run_id = ?').get('g-a').quota_state === 'suspended');
  check('暂停不消耗重试次数（非失败）',
    db.prepare('SELECT SUM(retry_count) AS s FROM sub_tasks WHERE group_id = ?').get('g-a').s === 0);

  // ── 场景 3：开跑前预留授予失败 → running 同样落 quota_suspend（不判 failed）──
  projects.createProject({ projectId: 'prj_b', name: '项目B', objective: '目标B', threadId: 'thr-b' });
  ledger.ensureBucket('prj_b', { totalLimit: 50000, resumeMinTokens: 100000 });
  store.createGroup({ groupId: 'g-b', goal: '项目组B', cwd: '', threadId: 'thr-b', tasks: [{ id: 'b1', title: '一', prompt: 'x' }] });
  store.enqueueReady('g-b');
  store.claimNext('g-b', 'w-test'); // 模拟泵已认领为 running
  const bRun = gate.beginRun(store.getGroup('g-b'), store.getTask('g-b', 'b1'));
  check('授予失败返回 ok=false / reason=quota', bRun && bRun.ok === false && bRun.reason === 'quota');
  check('running 任务被置 quota_suspend（而非 failed）', store.getTask('g-b', 'b1').status === 'quota_suspend');

  // ── 场景 4：授予成功 → 按轮合并记账 + 结算补差 + 释放预留 ──
  projects.createProject({ projectId: 'prj_c', name: '项目C', objective: '目标C', threadId: 'thr-c' });
  ledger.ensureBucket('prj_c');
  store.createGroup({ groupId: 'g-c', goal: '项目组C', cwd: '', threadId: 'thr-c', tasks: [{ id: 'c1', title: '一', prompt: 'x' }] });
  store.enqueueReady('g-c');
  store.claimNext('g-c', 'w-test');
  const cRun = gate.beginRun(store.getGroup('g-c'), store.getTask('g-c', 'c1'));
  check('放行时授予 tokenBudget（≤200k）', cRun && cRun.ok === true && cRun.grant > 0 && cRun.grant <= 200000, `grant=${cRun?.grant}`);
  check('授予即扣预留（防并发超发）', ledger.reservedOf('prj_c') === cRun.grant);
  cRun.note(400);
  cRun.settle(1000);
  const rows = db.prepare('SELECT source, SUM(tokens) AS s FROM quota_consumptions WHERE project_id = ? GROUP BY source')
    .all('prj_c');
  const round = (rows.find((r) => r.source === 'round') || {}).s || 0;
  const settle = (rows.find((r) => r.source === 'settle') || {}).s || 0;
  check('按轮合并写入 + 补差 = 实际消耗 1000', round === 400 && settle === 600, `round=${round} settle=${settle}`);
  check('结算释放预留（额度不泄漏）', ledger.reservedOf('prj_c') === 0);
  check('available 扣除实际消耗', ledger.available('prj_c') === 3000000 - 1000);
  cRun.settle(9999);
  const total = db.prepare('SELECT SUM(tokens) AS s FROM quota_consumptions WHERE project_id = ?').get('prj_c').s;
  check('settle 幂等（重复调用不重复入账）', total === 1000);

  // ── 场景 5：老化恢复 → 小批量回 queued + 踢一脚调度 ──
  ledger.updateBucket('prj_a', { totalLimit: 3000000 });
  store.setGroupStatus('g-a', 'running');
  const tick = gate.tickAll();
  check(`恢复批量上限 ${RESUME_BATCH}（本轮放行 2 个）`, tick.resumed === 2, `resumed=${tick.resumed}`);
  check('暂停任务恢复为 queued（唯一恢复入口）', store.getGroup('g-a').tasks.every((t) => t.status === 'queued'));
  check('恢复后回调 schedule 一次（自动续跑）', resumedKicks === 1);
  check('project_runs.quota_state 回写 ok',
    db.prepare('SELECT quota_state FROM project_runs WHERE run_id = ?').get('g-a').quota_state === 'ok');

  // ── 场景 6：迟滞未回落 → 不恢复（防「恢复→立刻打满→再暂停」抖动）──
  ledger.updateBucket('prj_a', { totalLimit: 200000 });
  // 已用 0，available=200k，util=0 < 0.85 ⇒ 仍可恢复；再把已用推到 90% 以上
  ledger.recordRound({ projectId: 'prj_a', runId: 'g-a', taskId: 'a1', tokens: 180000 });
  ledger.grant('prj_a', 'susp-x', 60000);
  // 先把已恢复的任务重新悬停，否则 resumeSuspendedTasks 无任务可放、断言恒真（假绿）
  for (const t of store.getGroup('g-a').tasks) store.suspendTask('g-a', t.taskId, { reason: 'quota' });
  const tick2 = gate.tickAll();
  check('利用率高于迟滞水位时不再恢复', tick2.resumed === 0, `resumed=${tick2.resumed}`);
  check('迟滞生效时任务保持 quota_suspend',
    store.getGroup('g-a').tasks.every((t) => t.status === 'quota_suspend'));

  console.log(`\nquota-gate: ${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail === 0 ? 0 : 1;
  try { db.close?.(); } catch { /* sql.js 关闭幂等 */ }
})();
