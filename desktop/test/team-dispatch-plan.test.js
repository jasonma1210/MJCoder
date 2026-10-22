// 第八轮 B-05 / B-08 门禁：派活计划装配（teamDispatchPlan）
//
// 这两条的共同点是「声明与实现不符」，而且都发生在**同一处**（planWaves 钩子产出什么）：
//   · B-05：类型闸 `deferred` 产出了却不落地 —— 快照用全量名册 ⇒ 被闸挡下的人运行期照样被派活；
//   · B-08：协作模式 `select` 只有一句提示词，没有任何运行期分支 ⇒ 模式名不副实。
//
// 本套件的判据刻意打在**可观察结果**上（快照收窄了谁、有没有指派表），不打在注释或字面量上：
// 「说它有」和「它真的有」的区别，只能靠读产出物来分。
//
// 同时锁住两条**不能被顺手改掉**的边界：
//   ① 统筹（lead）恒留在册 —— 被类型闸挡下也要留（中断矩阵的 actorRoleKind、审计名解析、
//      成员会话键三处都从快照里取它）；
//   ② 收窄逻辑自己出错时要**回退全量**而不是产出空名册（宁可多派一个人，也不要空跑一次）。
const path = require('path');
const {
  buildDispatchPlan, pickParticipatingRoster, SELECT_MODE, isChatOnlyGoal, buildChatTasks,
} = require('../main/teamDispatchPlan');
const { MAX_PER_TYPE_IN_RUN } = require('../main/teamWaves');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const mkMember = (id, extra = {}) => ({ id, name: id, roleKind: 'member', ...extra });
const mkTasks = (n) => Array.from({ length: n }, (_, i) => ({ id: `t${i + 1}`, title: `任务${i + 1}` }));

// ── ① 类型闸：同类型只留 2 人，其余进 deferred（reason=typeCap）──
{
  // 5 个同类型成员（同一 templateRef ⇒ 同类型）+ 1 个统筹（不同类型）
  const roster = [
    mkMember('lead', { roleKind: 'lead', templateRef: 'tpl-boss' }),
    mkMember('a', { templateRef: 'tpl-dev' }),
    mkMember('b', { templateRef: 'tpl-dev' }),
    mkMember('c', { templateRef: 'tpl-dev' }),
    mkMember('d', { templateRef: 'tpl-dev' }),
    mkMember('e', { templateRef: 'tpl-dev' }),
  ];
  const plan = buildDispatchPlan({ tasks: mkTasks(3), roster, mode: 'lead' });
  const typeCapped = plan.deferredMembers.filter((d) => d.reason === 'typeCap');
  check('B-05 同类型上限生效：挡下 3 人', typeCapped.length === 3,
    `deferred=${JSON.stringify(plan.deferredMembers)}`);
  check('B-05 参与名单 = 统筹 + 同类型前 2 人',
    plan.activeMemberIds.length === 3 && plan.activeMemberIds.includes('lead'),
    plan.activeMemberIds.join(','));
  // 核心：快照必须**不含**被挡下的人 —— 改前用全量 roster，这三人运行期照样被派活
  const snapIds = plan.roster.map((m) => m.id);
  const leaked = ['c', 'd', 'e'].filter((id) => snapIds.includes(id));
  check('B-05 编制快照已收窄（被 typeCap 挡下者不在快照内）', leaked.length === 0,
    leaked.length ? `仍在快照：${leaked.join(',')}` : `快照 ${snapIds.length} 人`);
  check('B-05 闸门取值随计划返回（界面能解释「为什么」）',
    plan.caps && plan.caps.maxPerType === MAX_PER_TYPE_IN_RUN, JSON.stringify(plan.caps));
}

// ── ② 统筹被类型闸挡下时也必须留在册（三条硬依赖都从快照取它）──
{
  // 统筹与两名成员同类型，按名册序统筹排第 3 → 会被 typeCap 挡下
  const roster = [
    mkMember('m1', { templateRef: 'tpl-dev' }),
    mkMember('m2', { templateRef: 'tpl-dev' }),
    mkMember('boss', { roleKind: 'lead', templateRef: 'tpl-dev' }),
  ];
  const plan = buildDispatchPlan({ tasks: mkTasks(2), roster, mode: 'lead' });
  const deferredIds = plan.deferredMembers.map((d) => String(d.id));
  const snapIds = plan.roster.map((m) => m.id);
  check('B-05 统筹确实被类型闸点名（构造前提成立）', deferredIds.includes('boss'),
    `deferred=${deferredIds.join(',')}`);
  check('B-05 统筹被挡下仍留在编制快照内（中断矩阵/审计名/会话键的前提）', snapIds.includes('boss'),
    `快照=${snapIds.join(',')}`);
  check('B-05 参与名单仍如实记录统筹未获派活', !plan.activeMemberIds.includes('boss'),
    plan.activeMemberIds.join(','));
}

// ── ③ 协作模式：select = 无预置指派（走被动认领），lead = 有指派表 ──
{
  const roster = [mkMember('lead', { roleKind: 'lead' }), mkMember('a'), mkMember('b')];
  const tasks = mkTasks(3);
  const leadPlan = buildDispatchPlan({ tasks, roster, mode: 'lead' });
  const selectPlan = buildDispatchPlan({ tasks, roster, mode: SELECT_MODE });
  check('B-08 lead 模式：产出任务→成员指派表',
    Object.keys(leadPlan.assignments).length === 3, JSON.stringify(leadPlan.assignments));
  check('B-08 select 模式：**不产出**任何预置指派（⇒ workerPool 走 pickOwnerMember 被动认领）',
    Object.keys(selectPlan.assignments).length === 0, JSON.stringify(selectPlan.assignments));
  check('B-08 两模式的批次计划一致（模式只影响「谁来干」，不改分批）',
    JSON.stringify(selectPlan.waves) === JSON.stringify(leadPlan.waves),
    `waves=${selectPlan.waves.length}`);
  check('B-08 模式记录在 runMeta.dispatch 内（可追溯本次用的是哪种模式）',
    selectPlan.runMeta?.dispatch?.mode === 'select' && leadPlan.runMeta?.dispatch?.mode === 'lead',
    `${selectPlan.runMeta?.dispatch?.mode}/${leadPlan.runMeta?.dispatch?.mode}`);
}

// ── ④ runMeta 形状：预算位置不变（既有消费者 groupBudget 读 dag.runMeta.budget）──
{
  const budget = { tokens: 1234, wallMs: 60000 };
  const plan = buildDispatchPlan({ tasks: mkTasks(1), roster: [mkMember('a')], budget, mode: 'lead' });
  check('B-05 runMeta.budget 仍在原位（groupBudget 零改动）', plan.runMeta.budget === budget);
  check('B-05 runMeta.dispatch 与 budget 并列，不互相覆盖',
    plan.runMeta.dispatch && plan.runMeta.budget && plan.runMeta.dispatch !== plan.runMeta.budget);
}

// ── ⑤ 收窄函数的两条边界 ──
{
  const roster = [mkMember('a'), mkMember('b')];
  check('B-05 空 activeMemberIds ⇒ 原样返回（计划不可用时不做无依据裁剪）',
    pickParticipatingRoster(roster, []).length === 2);
  check('B-05 收窄结果为空 ⇒ 回退全量（收窄逻辑自己出错时不许产出空名册）',
    pickParticipatingRoster(roster, ['zzz']).length === 2);
  check('B-05 非法入参不抛异常（脏数据不得把派活打挂）',
    (() => { try { pickParticipatingRoster(null, null); return true; } catch { return false; } })());
}

// ── ⑦ 对话型目标旁路（2026-10-21 用户实测「只想让他们报数」）──
// 判据必须窄：只认「每人说一句」类目标；明确要写程序/做文件的目标不得被误判。
{
  check('对话型判据：报数类目标命中', isChatOnlyGoal('大家报数'));
  check('对话型判据：明确要写程序的目标不命中（避免把编码任务做丢）',
    !isChatOnlyGoal('实现一个命令行报数程序'));
  check('对话型判据：普通编码目标不命中', !isChatOnlyGoal('修复登录接口的空指针异常'));

  const roster = [
    mkMember('lead', { roleKind: 'lead' }),
    mkMember('dev'), mkMember('qa'), mkMember('ops'),
  ];
  const tasks = buildChatTasks({ roster });
  check('对话型任务：每人一个', tasks.length === roster.length, `tasks=${tasks.length}`);
  check('对话型任务：按名册序编号（角色名：序号）',
    tasks[0].title === 'lead：1' && tasks[3].title === 'ops：4',
    tasks.map((t) => t.title).join(','));
  check('对话型任务：prompt 显式禁工具/文件/命令',
    tasks.every((t) => /不要调用任何工具/.test(t.prompt) && /不要读写文件/.test(t.prompt)));
  // 同类型闸对「每人一句话」不生效：4 名同类型成员也必须都参与报数
  const sameType = ['a', 'b', 'c', 'd'].map((id) => mkMember(id, { templateRef: 'tpl-dev' }));
  const plan = buildDispatchPlan({
    tasks: buildChatTasks({ roster: sameType }), roster: sameType, mode: SELECT_MODE, chatOnly: true,
  });
  check('对话型计划：同类型 4 人全部参与（类型闸不适用）',
    plan.activeMemberIds.length === 4 && plan.deferredMembers.length === 0,
    `active=${plan.activeMemberIds.join(',')}`);
  check('对话型计划：select 模式仍预置指派（任务文本与成员一一对应）',
    Object.keys(plan.assignments).length === 4, JSON.stringify(plan.assignments));
  check('对话型计划：runMeta.chatOnly 落库（Worker 据此禁用工具/收紧轮次）',
    plan.runMeta.chatOnly === true);
}

// ── ⑥ 接线：ipc/teams.js 必须调用本模块，且**不得**回退成全量快照 ──
{
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'teams.js'), 'utf8');
  check('B-05 接线：派活钩子调用 buildDispatchPlan', src.includes('buildDispatchPlan({'));
  // 反向：`roster: snapshotRoster(roster)` 是改前的全量快照形态，回来一个就说明修法被回退
  check('B-05 接线：已不存在「全量快照」旧写法', !/roster:\s*snapshotRoster\(roster\)\s*,/.test(src));
  check('对话型接线：派活层把确定性任务交给编排器（跳过 LLM 拆解）',
    src.includes('isChatOnlyGoal(goal)') && src.includes('buildChatTasks({ roster })')
      && src.includes('presetTasks'));
  const pool = fs.readFileSync(path.join(__dirname, '..', 'main', 'workerPool.js'), 'utf8');
  check('对话型接线：Worker 读 runMeta.chatOnly 并下发空工具表',
    pool.includes('runMeta.chatOnly') && pool.includes('tools: []'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
