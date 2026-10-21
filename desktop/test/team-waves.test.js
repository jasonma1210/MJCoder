// M5 / T5-12 批次编排与降级单测（§13.4）：
//   批次计划（拓扑分层 / 人数闸 / 类型闸 / MAX_WAVES 尾部合并） / 探活三通道 /
//   备用成员选择 / 撤员重派落库（reassignTask） / 入队门控（enqueueReady allowIds）。
// 全部确定性：探活用注入的假时钟 tick 驱动，不依赖真实等待。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDbAsync } = require('../main/db');
const { TaskStore } = require('../main/taskStore');
const {
  MAX_ACTIVE_MEMBERS, MAX_PER_TYPE_IN_RUN, WAVE_PROBE_MAX_MISSES, WAVE_PROBE_IDLE_MS,
  MAX_REASSIGN_PER_TASK, MAX_WAVES,
  memberTypeOf, selectActiveMembers, planWaves, normalizeWaves, currentWave,
  allowedTaskIds, createWaveProbe, startWaveProbe, pickBackupMember,
} = require('../main/teamWaves');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const mkMember = (id, extra = {}) => ({ id, name: id, ...extra });

(async () => {
  // ── 常量（单一事实来源）──
  check('人数硬闸 = 10', MAX_ACTIVE_MEMBERS === 10);
  check('同类型软闸 = 2', MAX_PER_TYPE_IN_RUN === 2);
  check('探活连续无进展阈值 = 3', WAVE_PROBE_MAX_MISSES === 3);
  check('批次数上限 = 3', MAX_WAVES === 3);

  // ── 类型判据三级回落 ──
  check('类型判据①模板优先', memberTypeOf({ id: 'a', templateRef: 'ops-bot', toolNames: ['x'] }) === 'tpl:ops-bot');
  check('类型判据②工具签名与顺序无关',
    memberTypeOf({ id: 'a', toolNames: ['b', 'a'] }) === memberTypeOf({ id: 'b', toolNames: ['a', 'b'] }));
  check('类型判据③无标签回落 role_kind', memberTypeOf({ id: 'a', roleKind: 'lead' }) === 'role:lead');
  check('类型判据③缺省 role=member', memberTypeOf({ id: 'a' }) === 'role:member');

  // ── 人数闸 / 类型闸 ──
  const twelveDistinct = Array.from({ length: 12 }, (_, i) => mkMember(`m${i}`, { templateRef: `t${i}` }));
  const capR = selectActiveMembers(twelveDistinct);
  check('人数闸：12 人只放行 10 人', capR.active.length === 10);
  check('人数闸：超出者 reason=memberCap',
    capR.deferred.length === 2 && capR.deferred.every((d) => d.reason === 'memberCap'));

  const sameType = Array.from({ length: 5 }, (_, i) => mkMember(`s${i}`, { templateRef: 'same' }));
  const typeR = selectActiveMembers(sameType);
  check('类型闸：同类型只放行 2 人', typeR.active.length === 2);
  check('类型闸：超出者 reason=typeCap',
    typeR.deferred.length === 3 && typeR.deferred.every((d) => d.reason === 'typeCap'));

  // ── 批次计划：拓扑分层 + 批大小 = 参与人数 ──
  const tasks3 = [
    { id: 'a', dependsOn: [] },
    { id: 'b', dependsOn: [] },
    { id: 'c', dependsOn: ['a'] },
  ];
  const twoMembers = [mkMember('m1', { templateRef: 'x' }), mkMember('m2', { templateRef: 'y' })];
  const plan = planWaves({ tasks: tasks3, members: twoMembers });
  check('批次计划生成成功', plan.ok === true);
  check('批次 1 = 无依赖的最小子集', plan.waves[0].taskIds.join(',') === 'a,b');
  check('批次 2 = 依赖后的下一层', plan.waves[1].taskIds.join(',') === 'c');
  check('批次序号连续', plan.waves.map((w) => w.index).join(',') === '1,2');
  check('每个任务都分配到成员', Object.keys(plan.assignments).length === 3
    && plan.activeMemberIds.includes(plan.assignments.a));

  // ── MAX_WAVES 尾部合并 ──
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, dependsOn: [] }));
  const merged = planWaves({ tasks: many, members: twoMembers });
  check(`批次数被 MAX_WAVES=${MAX_WAVES} 截断`, merged.waves.length === MAX_WAVES);
  check('尾部批次被合并（merged 标记）', merged.waves[MAX_WAVES - 1].merged === true);
  check('合并后任务总数不丢', merged.waves.reduce((n, w) => n + w.taskIds.length, 0) === 12);

  // ── 空任务：不生成计划（调用方据此回落既有 DAG 调度）──
  check('空任务返回 ok=false', planWaves({ tasks: [], members: twoMembers }).ok === false);

  // ── normalizeWaves：脏数据整条丢弃 ──
  const norm = normalizeWaves({ dag: { waves: [{ taskIds: ['a'] }, { taskIds: [] }, null, { taskIds: ['b'] }] } });
  check('normalizeWaves 丢弃空批次', norm.length === 2 && norm[1].taskIds[0] === 'b');
  check('无 waves → null（退化为无分批）', normalizeWaves({ dag: {} }) === null);
  check('非数组 waves → null', normalizeWaves({ dag: { waves: 'x' } }) === null);

  // ── currentWave / allowedTaskIds：批间串行的门控依据 ──
  const waves = [
    { index: 1, taskIds: ['a', 'b'] },
    { index: 2, taskIds: ['c'] },
  ];
  check('当前批 = 含未终态任务的第一个批',
    currentWave(waves, [{ taskId: 'a', status: 'done' }, { taskId: 'b', status: 'running' }, { taskId: 'c', status: 'pending' }])
      .index === 1);
  check('当前批全部终态 → 前移到下一批',
    currentWave(waves, [{ taskId: 'a', status: 'done' }, { taskId: 'b', status: 'failed' }, { taskId: 'c', status: 'pending' }])
      .index === 2);
  check('全部终态 → null（组即将收尾）',
    currentWave(waves, [{ taskId: 'a', status: 'done' }, { taskId: 'b', status: 'done' }, { taskId: 'c', status: 'skipped' }]) === null);
  check('allowedTaskIds 只放行当前批', allowedTaskIds(waves, [{ taskId: 'c', status: 'pending' }]).join(',') === 'c');

  // ── 探活：三通道全无变化才判停滞 ──
  const probe = createWaveProbe({ maxMisses: 3 });
  const sig = { traceSeq: 1, messageSeq: 2, statusSignature: 'a:running' };
  check('第 1 拍基准（不判停滞）', probe.sample(sig).stalled === false);
  check('第 2 拍无变化 misses=1', probe.sample(sig).misses === 1);
  check('第 3 拍无变化 misses=2', probe.sample(sig).misses === 2);
  check('第 4 拍连续 3 次无变化 → stalled', probe.sample(sig).stalled === true);

  const probe2 = createWaveProbe({ maxMisses: 3 });
  probe2.sample(sig);
  probe2.sample(sig);
  check('任一通道变化即清零（第三通道）',
    probe2.sample({ ...sig, statusSignature: 'a:done' }).misses === 0);
  probe2.sample({ ...sig, statusSignature: 'a:done', traceSeq: 99 });
  check('第一通道变化也清零', probe2.misses === 0);
  probe2.sample({ ...sig, traceSeq: 99, messageSeq: 77 });
  check('第二通道（团队消息）变化也清零', probe2.misses === 0);

  // ── 探活：静止时间窗（2026-10-21 真机事故）──
  // 签名连续不变但整组仍在推理（idleMs < 窗口）⇒ 不判停滞。
  const idleProbe = createWaveProbe({ maxMisses: 3, idleWindow: 120000 });
  const idleSig = { traceSeq: 0, messageSeq: 0, statusSignature: 'a:running', idleMs: 8000 };
  let idleStalled = false;
  for (let i = 0; i < 10; i += 1) idleStalled = idleProbe.sample(idleSig).stalled || idleStalled;
  check('静止窗口内（推理等待）不判停滞', idleStalled === false && idleProbe.misses === 0);
  check('静默超过窗口后才开始累计',
    idleProbe.sample({ ...idleSig, idleMs: 130000 }).misses === 1);
  const idleProbe2 = createWaveProbe({ maxMisses: 3, idleWindow: 120000 });
  idleProbe2.sample({ ...idleSig, idleMs: 130000 }); // 基准拍
  idleProbe2.sample({ ...idleSig, idleMs: 130000 });
  idleProbe2.sample({ ...idleSig, idleMs: 130000 });
  check('静默超窗且连续 3 次签名不变 → stalled',
    idleProbe2.sample({ ...idleSig, idleMs: 130000 }).stalled === true);
  check('单任务撤员上限 = 1', MAX_REASSIGN_PER_TASK === 1);
  check('静止窗口默认值 = 120s', WAVE_PROBE_IDLE_MS === 120000);

  // ── startWaveProbe：注入假定时器，onStall 每轮只触发一次并自动复位 ──
  let tickFn = null;
  let stallCount = 0;
  const handle = startWaveProbe({
    sample: () => ({ traceSeq: 0, messageSeq: 0, statusSignature: 'frozen' }),
    onStall: () => { stallCount += 1; },
    setIntervalFn: (fn) => { tickFn = fn; return { unref() {} }; },
    clearIntervalFn: () => { tickFn = null; },
  });
  for (let i = 0; i < 4; i += 1) tickFn();
  check('连续 3 次无进展触发一次撤员', stallCount === 1);
  // 触发后自动复位 ⇒ 下一拍重建基准，再连续 3 次无变化才会第二次触发（共 4 拍）
  for (let i = 0; i < 4; i += 1) tickFn();
  check('复位后重新累计满 3 次才再次触发', stallCount === 2);
  handle.stop();
  check('stop 后定时器被清除', tickFn === null);
  void handle.probe;

  // ── 备用成员选择 ──
  const roster = [
    mkMember('lead', { templateRef: 'x', roleKind: 'lead' }),
    mkMember('e1', { templateRef: 'x' }),
    mkMember('e2', { templateRef: 'x' }),
    mkMember('o1', { templateRef: 'y' }),
  ];
  check('优先同类型且排除被撤者与在役者',
    pickBackupMember({ members: roster, typeKey: 'tpl:x', excludeIds: ['e1'], busyIds: ['lead'] }) === 'e2');
  check('无同类型备用 → null（按失败收尾）',
    pickBackupMember({ members: roster, typeKey: 'tpl:z' }) === null);

  // ── 存储层：入队门控 + 撤员重派 ──
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-team-waves-'));
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  const store = new TaskStore(db);
  const groupId = 'g-wave';
  store.createGroup({
    groupId,
    goal: '批次门控验证',
    cwd: '',
    dag: { levels: [], waves: [{ index: 1, taskIds: ['a', 'b'] }, { index: 2, taskIds: ['c'] }], assignments: {} },
    tasks: [
      { id: 'a', title: 'A', prompt: 'a', dependsOn: [], timeoutMs: 1000 },
      { id: 'b', title: 'B', prompt: 'b', dependsOn: [], timeoutMs: 1000 },
      { id: 'c', title: 'C', prompt: 'c', dependsOn: ['a'], timeoutMs: 1000 },
    ],
  });

  const queued1 = store.enqueueReady(groupId, { allowIds: ['a', 'b'] });
  check('门控：只放行本批任务入队', queued1.sort().join(',') === 'a,b');
  check('门控：后批任务保持 pending', store.getTask(groupId, 'c').status === 'pending');
  const queued2 = store.enqueueReady(groupId, { allowIds: ['a', 'b'] });
  check('门控幂等：已在队中的任务不重复入队', queued2.length === 0);
  // 不传 allowIds（普通组语义）→ 门控不收紧，但 depends_on 仍强制
  check('无批次计划时门控不收紧、依赖仍强制', store.enqueueReady(groupId).length === 0
    && store.getTask(groupId, 'c').status === 'pending');

  // 撤员重派：running → queued + owner 覆盖
  const claimed = store.claimNext(groupId, 'w1', { ownerMemberId: 'e1' });
  check('认领写入 owner_member_id', claimed?.ownerMemberId === 'e1' && claimed.status === 'running');
  const reassigned = store.reassignTask(groupId, 'a', 'e2', { error: '探活无进展：改派' });
  check('撤员重派：任务回 queued', reassigned?.status === 'queued');
  check('撤员重派：owner 被覆盖为新成员', reassigned?.ownerMemberId === 'e2');
  check('撤员重派：不消耗自动重试次数', reassigned?.retryCount === 0);

  // 已完成/已跳过任务不在生命周期内，撤员重派必须返回 null（不得把成果改回 queued 重跑）
  store.claimNext(groupId, 'w2');
  store.setTaskStatus(groupId, 'a', 'done', { result: { summary: 'ok' } });
  check('已完成任务不可重派（返回 null）', store.reassignTask(groupId, 'a', 'e2') === null);
  store.setTaskStatus(groupId, 'b', 'skipped', { force: true });
  check('已跳过任务不可重派（返回 null）', store.reassignTask(groupId, 'b', 'e2') === null);

  // dag_json 往返：批次计划随组持久化，读回结构不变
  const g = store.getGroup(groupId);
  check('批次计划随 dag_json 落库并可读回',
    normalizeWaves(g)?.length === 2 && normalizeWaves(g)[1].taskIds[0] === 'c');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
