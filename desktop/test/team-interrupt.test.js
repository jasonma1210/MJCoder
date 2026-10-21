// M5 / T5-10：中断权限矩阵与留痕测试（sql.js 驱动）
//
// 覆盖三主体矩阵（§9.2）的每一条分支：
//   · user  ：任意任务 / 任意成员范围，无需理由；
//   · lead  ：可中断本团队任意成员（含自己认领的任务），但成员范围禁止指向自己；
//             必须填理由 + 每次显式 confirmed=true（L1 逐次确认，不允许同类豁免）；
//   · member：仅可中断自己认领的任务，成员范围一律拒绝。
//
// 以及运行期语义：
//   · 快照优先：成员被实时下架后，本 run 内仍可按快照身份中断自己认领的任务；
//   · running 任务走 workerPool.abortTask（不直接写库），queued/pending 才由本模块落终态；
//   · 中断即终态：等待它的任务被级联唤醒；每条中断都写 system 消息留痕（含理由）。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDbAsync } = require('../main/db');
const { TeamStore } = require('../main/teamStore');
const { TaskStore } = require('../main/taskStore');
const teamInterrupt = require('../main/teamInterrupt');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-team-interrupt-'));
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  const teamStore = new TeamStore(db);
  const taskStore = new TaskStore(db);

  const team = teamStore.createTeam({ name: '交付组', description: 'x', projectPath: '/tmp/p' });
  const lead = teamStore.createLead(team.id, {});
  const eng = teamStore.addMember(team.id, { name: '工程师', toolNames: ['read', 'write'] });
  const qa = teamStore.addMember(team.id, { name: '测试', toolNames: ['read'] });

  // 编制快照（派活时写入 dag_json.roster 的形态；启用字段不在快照判据内）
  const roster = [
    { id: lead.id, name: lead.name, roleKind: 'lead' },
    { id: eng.id, name: eng.name, roleKind: 'member' },
    { id: qa.id, name: qa.name, roleKind: 'member' },
  ];

  const aborted = [];
  const emitted = [];
  // 假 Worker 池：running/waiting 任务由池中止并按真实语义落 skipped（真机由 run 收尾写入），
  // 同时级联唤醒等待者——这样测试才能验证「只有池能处置在役任务」这一接线边界。
  const workerPool = {
    abortTask: (runId, taskId) => {
      aborted.push(`${runId}/${taskId}`);
      const t = taskStore.getTask(runId, taskId);
      if (t && !['done', 'failed', 'skipped'].includes(t.status)) {
        taskStore.setTaskStatus(runId, taskId, 'skipped', { error: '已中断', force: true });
        for (const w of taskStore.settleWaitingTasks(runId, taskId) || []) {
          emitted.push({ type: 'task_update', groupId: runId, taskId: w.taskId, status: 'queued' });
        }
      }
      return true;
    },
    schedule: () => {},
  };
  teamInterrupt.initTeamInterrupt({
    getTeamStore: () => teamStore,
    getTaskStore: () => taskStore,
    workerPool,
    emit: (e) => emitted.push(e),
    postMessage: (m) => teamStore.appendMessage(m).message,
  });

  let runSeq = 0;
  // 建一个 run：tasks 形如 { id, status, owner }，按合法状态链推进
  function makeRun(taskSpecs) {
    runSeq += 1;
    const runId = `run-${runSeq}`;
    taskStore.createGroup({
      groupId: runId,
      goal: `目标${runSeq}`,
      cwd: '/tmp',
      dag: { roster },
      tasks: taskSpecs.map((t) => ({ id: t.id, title: `任务${t.id}`, prompt: `完成 ${t.id}` })),
    });
    for (const spec of taskSpecs) {
      if (spec.status === 'skipped') {
        taskStore.setTaskStatus(runId, spec.id, 'skipped', { force: true });
        continue;
      }
      // 合法状态链：pending → queued → running → done（owner 仅在 running 迁移写入）
      taskStore.setTaskStatus(runId, spec.id, 'queued');
      if (spec.status === 'queued') {
        // 排队任务没有 running 迁移，用 reassignTask 补写认领者（成员范围中断需要 owner）
        if (spec.owner) taskStore.reassignTask(runId, spec.id, spec.owner);
      } else if (spec.status === 'running') {
        taskStore.setTaskStatus(runId, spec.id, 'running', { ownerMemberId: spec.owner || null });
      } else if (spec.status === 'done') {
        taskStore.setTaskStatus(runId, spec.id, 'running', { ownerMemberId: spec.owner || null });
        taskStore.setTaskStatus(runId, spec.id, 'done');
      }
    }
    return runId;
  }
  const sysMessages = (runId) => teamStore.listMessages({ teamId: team.id, runId })
    .filter((m) => m.kind === 'system' && m.payload && m.payload.sys === 'interrupt');

  // ── 1. 纯策略矩阵（不经执行，先把三主体边界钉死）──
  const permitUser = teamInterrupt.checkInterruptPermit(
    { actorKind: 'user', actorMemberId: null, actorRoleKind: null, targetOwnerId: eng.id, scope: 'member' });
  check('user 可中断任意成员范围', permitUser.ok === true);

  const permitLeadSelf = teamInterrupt.checkInterruptPermit(
    { actorKind: 'lead', actorMemberId: lead.id, actorRoleKind: 'lead', targetOwnerId: lead.id, scope: 'member' });
  check('lead 成员范围指向自己 → LEAD_SELF_FORBIDDEN', permitLeadSelf.ok === false && permitLeadSelf.code === 'LEAD_SELF_FORBIDDEN');

  const permitLeadOther = teamInterrupt.checkInterruptPermit(
    { actorKind: 'lead', actorMemberId: lead.id, actorRoleKind: 'lead', targetOwnerId: eng.id, scope: 'task' });
  check('lead 可中断本团队其他成员的任务', permitLeadOther.ok === true);

  const permitMemberScope = teamInterrupt.checkInterruptPermit(
    { actorKind: 'member', actorMemberId: eng.id, actorRoleKind: 'member', targetOwnerId: eng.id, scope: 'member' });
  check('member 按成员范围中断 → MEMBER_SCOPE_FORBIDDEN', permitMemberScope.ok === false && permitMemberScope.code === 'MEMBER_SCOPE_FORBIDDEN');

  const permitMemberOther = teamInterrupt.checkInterruptPermit(
    { actorKind: 'member', actorMemberId: eng.id, actorRoleKind: 'member', targetOwnerId: qa.id, scope: 'task' });
  check('member 中断他人任务 → MEMBER_NOT_OWNER', permitMemberOther.ok === false && permitMemberOther.code === 'MEMBER_NOT_OWNER');

  const permitMemberOwn = teamInterrupt.checkInterruptPermit(
    { actorKind: 'member', actorMemberId: eng.id, actorRoleKind: 'member', targetOwnerId: eng.id, scope: 'task' });
  check('member 可中断自己认领的任务', permitMemberOwn.ok === true);

  const permitBad = teamInterrupt.checkInterruptPermit(
    { actorKind: 'guest', actorMemberId: null, actorRoleKind: null, targetOwnerId: null, scope: 'task' });
  check('非法发起方 → INVALID_ACTOR', permitBad.ok === false && permitBad.code === 'INVALID_ACTOR');

  // ── 2. user 中断 running 任务：走 abortTask + 写 system 留痕 ──
  const r1 = makeRun([{ id: 't1', status: 'running', owner: eng.id }]);
  const i1 = teamInterrupt.interruptTask({ teamId: team.id, runId: r1, taskId: 't1' });
  check('user 中断 running 任务成功', i1.ok === true && i1.scope === 'task');
  check('running 任务交给 workerPool.abortTask（由池收尾落终态）', aborted.includes(`${r1}/t1`)
    && taskStore.getTask(r1, 't1').status === 'skipped');
  const m1 = sysMessages(r1);
  check('中断写入 system 留痕（payload.sys=interrupt）', m1.length === 1 && m1[0].payload.sys === 'interrupt');
  check('留痕记录目标成员名与任务 id', m1[0].payload.name === '工程师'
    && Array.isArray(m1[0].payload.taskIds) && m1[0].payload.taskIds.includes('t1'));

  // ── 3. 终态任务不可中断 ──
  const r2 = makeRun([{ id: 't1', status: 'done', owner: eng.id }]);
  const i2 = teamInterrupt.interruptTask({ teamId: team.id, runId: r2, taskId: 't1' });
  check('终态任务 → ALREADY_SETTLED', i2.ok === false && i2.code === 'ALREADY_SETTLED');

  const i2b = teamInterrupt.interruptTask({ teamId: team.id, runId: 'no-such-run', taskId: 't1' });
  check('run 不存在 → RUN_NOT_FOUND', i2b.ok === false && i2b.code === 'RUN_NOT_FOUND');
  const i2c = teamInterrupt.interruptTask({ teamId: team.id, runId: r2, taskId: 'no-such-task' });
  check('任务不存在 → TASK_NOT_FOUND', i2c.ok === false && i2c.code === 'TASK_NOT_FOUND');

  // ── 4. 排队任务：本模块直接落 skipped 并补 board_task_settled ──
  const r3 = makeRun([{ id: 't1', status: 'queued', owner: eng.id }]);
  emitted.length = 0;
  const i3 = teamInterrupt.interruptTask({ teamId: team.id, runId: r3, taskId: 't1' });
  check('排队任务被置 skipped', i3.ok === true && taskStore.getTask(r3, 't1').status === 'skipped');
  check('排队任务中断补发 board_task_settled',
    emitted.some((e) => e.type === 'board_task_settled' && e.taskId === 't1'));
  check('排队任务不占用 abortTask 通道', !aborted.includes(`${r3}/t1`));

  // ── 5. 等待任务中断：级联唤醒等待它的任务 ──
  const r4 = makeRun([{ id: 't1', status: 'running', owner: eng.id }, { id: 't2', status: 'running' }]);
  taskStore.waitOnTasks(r4, 't2', ['t1'], { timeoutMs: 60000 });
  check('前置：t2 进入等待态', taskStore.getTask(r4, 't2').status === 'waiting');
  emitted.length = 0;
  const i4 = teamInterrupt.interruptTask({ teamId: team.id, runId: r4, taskId: 't1' });
  check('中断被等待任务成功', i4.ok === true);
  check('等待方被级联唤醒为 queued', taskStore.getTask(r4, 't2').status === 'queued');

  // ── 6. Lead 路径：理由必填 + L1 逐次确认（无同类豁免）──
  const r5 = makeRun([{ id: 't1', status: 'running', owner: eng.id }]);
  const l1 = teamInterrupt.interruptTask({
    teamId: team.id, runId: r5, taskId: 't1', actorKind: 'lead', actorMemberId: lead.id });
  check('lead 缺理由 → REASON_REQUIRED', l1.ok === false && l1.code === 'REASON_REQUIRED');

  const l2 = teamInterrupt.interruptTask({
    teamId: team.id, runId: r5, taskId: 't1', actorKind: 'lead', actorMemberId: lead.id, reason: '方向已调整' });
  check('lead 有理由但未确认 → NEED_CONFIRM（L1）', l2.ok === false && l2.code === 'NEED_CONFIRM');

  // 同一目标、同一理由再调一次：仍要确认——L1 不允许「同类操作一次确认后永久放行」
  const l2b = teamInterrupt.interruptTask({
    teamId: team.id, runId: r5, taskId: 't1', actorKind: 'lead', actorMemberId: lead.id, reason: '方向已调整' });
  check('重复调用仍需逐次确认（无同类豁免）', l2b.ok === false && l2b.code === 'NEED_CONFIRM');

  const l3 = teamInterrupt.interruptTask({
    teamId: team.id, runId: r5, taskId: 't1', actorKind: 'lead', actorMemberId: lead.id, reason: '方向已调整', confirmed: true });
  check('lead 理由 + 逐次确认 → 成功', l3.ok === true && l3.interrupted.includes('t1'));
  const m5 = sysMessages(r5);
  check('lead 中断留痕含理由', m5.length === 1 && m5[0].payload.reason === '方向已调整'
    && m5[0].payload.actor === 'lead');

  const l5 = teamInterrupt.interruptTask({
    teamId: team.id, runId: r5, targetMemberId: lead.id, actorKind: 'lead', actorMemberId: lead.id,
    reason: '自停', confirmed: true });
  check('lead 成员范围指向自己 → LEAD_SELF_FORBIDDEN', l5.ok === false && l5.code === 'LEAD_SELF_FORBIDDEN');

  // ── 7. Member 路径：仅自己认领的任务；成员范围一律拒绝 ──
  const r6 = makeRun([{ id: 't1', status: 'running', owner: eng.id }, { id: 't2', status: 'running', owner: qa.id }]);
  const l6 = teamInterrupt.interruptTask({
    teamId: team.id, runId: r6, taskId: 't2', actorKind: 'lead', actorMemberId: qa.id,
    reason: '越权', confirmed: true });
  check('非统筹以 lead 身份发起 → NOT_LEAD', l6.ok === false && l6.code === 'NOT_LEAD');
  const n1 = teamInterrupt.interruptTask({
    teamId: team.id, runId: r6, taskId: 't2', actorKind: 'member', actorMemberId: eng.id });
  check('member 中断他人任务 → MEMBER_NOT_OWNER', n1.ok === false && n1.code === 'MEMBER_NOT_OWNER');
  const n2 = teamInterrupt.interruptTask({
    teamId: team.id, runId: r6, targetMemberId: eng.id, actorKind: 'member', actorMemberId: eng.id });
  check('member 成员范围中断 → MEMBER_SCOPE_FORBIDDEN', n2.ok === false && n2.code === 'MEMBER_SCOPE_FORBIDDEN');
  const n3 = teamInterrupt.interruptTask({
    teamId: team.id, runId: r6, taskId: 't1', actorKind: 'member', actorMemberId: eng.id });
  check('member 中断自己认领的任务成功', n3.ok === true && n3.interrupted.includes('t1'));
  const n4 = teamInterrupt.interruptTask({
    teamId: team.id, runId: r6, taskId: 't1', actorKind: 'member', actorMemberId: 'ghost' });
  check('发起方不在编制快照 → ACTOR_NOT_IN_ROSTER', n4.ok === false && n4.code === 'ACTOR_NOT_IN_ROSTER');

  // ── 8. 快照优先：成员被实时下架后，本 run 仍可按快照身份中断 ──
  // 软删 = enabled=0 + removed_at（teamStore 无物理删除），实时名册不再含该成员。
  teamStore.setMemberEnabled(team.id, eng.id, false);
  check('前置：实时名册已不含被下架成员',
    !teamStore.getTeam(team.id).members.some((m) => m.id === eng.id));
  const r7 = makeRun([{ id: 't1', status: 'running', owner: eng.id }]);
  const s1 = teamInterrupt.interruptTask({
    teamId: team.id, runId: r7, taskId: 't1', actorKind: 'member', actorMemberId: eng.id });
  check('快照内成员下架后仍可中断本 run 任务（快照优先）', s1.ok === true && s1.interrupted.includes('t1'));

  // ── 9. 成员范围中断：一次处置该成员在本 run 的全部非终态任务 ──
  const r8 = makeRun([
    { id: 't1', status: 'running', owner: eng.id },
    { id: 't2', status: 'queued', owner: eng.id },
    { id: 't3', status: 'done', owner: eng.id },
  ]);
  const u1 = teamInterrupt.interruptTask({ teamId: team.id, runId: r8, targetMemberId: eng.id });
  check('user 成员范围中断处置全部非终态任务', u1.ok === true && u1.scope === 'member'
    && u1.interrupted.includes('t1') && u1.interrupted.includes('t2') && !u1.interrupted.includes('t3'));
  check('终态任务保持 done 不受影响', taskStore.getTask(r8, 't3').status === 'done');
  const u2 = teamInterrupt.interruptTask({ teamId: team.id, runId: r8, targetMemberId: eng.id });
  check('该成员已无活跃任务 → NO_ACTIVE_TASK', u2.ok === false && u2.code === 'NO_ACTIVE_TASK');

  // ── 10. 留痕失败不阻断中断（fail-open）──
  const r9 = makeRun([{ id: 't1', status: 'queued', owner: eng.id }]);
  teamInterrupt.initTeamInterrupt({
    getTeamStore: () => teamStore,
    getTaskStore: () => taskStore,
    workerPool,
    emit: (e) => emitted.push(e),
    postMessage: () => { throw new Error('总线不可用'); },
  });
  const f1 = teamInterrupt.interruptTask({ teamId: team.id, runId: r9, taskId: 't1' });
  check('留痕失败不阻断中断（fail-open）', f1.ok === true
    && taskStore.getTask(r9, 't1').status === 'skipped');

  console.log(`\nteam-interrupt：${pass} 项通过 / ${fail} 项失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('team-interrupt 测试崩溃：', e);
  process.exit(2);
});
