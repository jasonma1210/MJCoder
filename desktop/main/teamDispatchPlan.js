// 派活计划装配：批次计划 + 编制快照 + 协作模式（第八轮 B-05 / B-08，2026-10-21）
//
// 为什么要有这一层：`ipc/teams.js` 已贴着 800 行软档，而本轮两处修正都落在
// 「planWaves 回调产出什么」这一处。按项目纪律「先拆再合入、白名单只减不增」，
// 把「产出计划」这件事从 IPC 文件里整块搬出来，顺手把两个语义缺陷修掉。
//
// ── B-05：类型闸的 deferred 在运行期被绕过 ────────────────────────────────────
//   缺陷有两层，第二层才是真问题：
//     ① `deferredMembers` / `activeMemberIds` 由 `teamWaves.planWaves` 产出后**被丢弃**
//        （orchestrator 只取 waves/assignments/roster）——「20 人里只有 10 人参与、
//        其中 3 人被类型闸挡下」这件事用户永远看不到；
//     ② 更实质：快照用的是**全量 roster**，而运行期回落指派
//        `pickOwnerMember(eligibleRoster(...))` 也从全量名册取模——
//        于是被类型闸挡下的人照样会被派活，`MAX_PER_TYPE_IN_RUN` 只影响分批、不影响认领。
//   修法：① 快照只装「本次真正参与的人」（`activeMemberIds` 子集），让运行期的一切认领
//   都落在这个子集里；② 把 deferred 名单与原因随 `runMeta.dispatch` 落库并回传派活消息，
//   让「谁没被派上、为什么」有账可查。
//
//   一个必须保留的例外：**统筹（roleKind==='lead'）恒留在册**。
//   理由不是特权，而是三处硬依赖都要求它在快照里——`teamInterrupt` 的审计名解析
//   （`targetName` 查不到就退化成裸 id）、`checkInterruptPermit` 的 lead 主体判定
//   （`actorRoleKind` 取自快照），以及 `memberSession` 的 lead 会话键。
//   统筹被类型闸挡下时把它踢出快照，会让「can't interrupt / 审计丢名字」这两个后果
//   同时出现，而它实际上仍在跑（lead 也执行任务）。
//
// ── B-08：协作模式没有运行期分支 ─────────────────────────────────────────────
//   `TEAM_MODES = ['lead','select']` 此前**只影响提示词里的一句话**，两种模式在代码里
//   走的完全是同一条路。UI 把「协作模式」做成用户可选项，等于让用户以为能改行为。
//   修法（成本最低且能让名字名实相符）：`select` 模式**不产出预置指派表**——
//   `dag.assignments` 为空 ⇒ `waveEngine.preferredOwnerOf` 返回 null ⇒
//   `workerPool` 走 `pickOwnerMember` 按能力被动认领。`lead` 模式保持原有的
//   「主管预置指派」（批内轮转，把任务落到具体人头上）。
//   两条分支都是确定性的：模式再也不是一句提示词，而是「有没有指派表」这个可断言的事实。
//
// 纯函数、不碰数据库、不调模型：输入由派活层给，输出原样交给编排器落 dag_json。

'use strict';

const { planWaves } = require('./teamWaves');
const { snapshotRoster } = require('./teamRoster');

/** 协作模式（与 teamStore.TEAM_MODES 同值；此处只做「是否预置指派」的判据）。 */
const SELECT_MODE = 'select';

/**
 * 从全量名册里挑出「本次真正参与」的成员（B-05）。
 *
 * @param {Array<object>} roster 本次被选中的成员（含统筹）
 * @param {Array<string>} activeMemberIds `planWaves` 给出的参与名单
 * @returns {Array<object>} 收窄后的名册
 */
function pickParticipatingRoster(roster, activeMemberIds) {
  const list = (Array.isArray(roster) ? roster : []).filter((m) => m && m.id);
  const active = new Set((Array.isArray(activeMemberIds) ? activeMemberIds : []).map(String));
  if (!active.size) return list; // 计划没给出参与名单（空任务等）→ 保持原样，不做无依据的裁剪
  const kept = list.filter((m) => active.has(String(m.id)) || m.roleKind === 'lead');
  // 兜底：若收窄后为空（理论上不可能：名册非空时 active 至少 1 人），保留全量。
  // 宁可多派一个人，也不要让一次派活因为「裁剪逻辑自己出错」变成空跑。
  return kept.length ? kept : list;
}

/**
 * 装配一次派活的运行期计划（B-05 / B-08 的单一落点）。
 *
 * @param {{
 *   tasks: Array<object>,
 *   roster: Array<object>,
 *   budget?: object|null,
 *   mode?: string,
 * }} input
 * @returns {object} 供 `orchestrator.planGoal` 的 planWaves 钩子原样返回
 */
function buildDispatchPlan({ tasks, roster, budget = null, mode = 'lead' } = {}) {
  const plan = planWaves({ tasks, members: roster });
  const activeMemberIds = Array.isArray(plan.activeMemberIds) ? plan.activeMemberIds : [];
  const deferredMembers = Array.isArray(plan.deferredMembers) ? plan.deferredMembers : [];
  // B-08：select ⇒ 不预置指派（成员按能力被动认领）；lead ⇒ 保留批内轮转指派。
  const assignments = mode === SELECT_MODE ? {} : (plan.assignments || {});
  return {
    ...plan,
    assignments,
    // B-05 ①：快照只装参与成员（统筹例外恒留），运行期只读快照 ⇒ 类型闸真正生效。
    roster: snapshotRoster(pickParticipatingRoster(roster, activeMemberIds)),
    // B-05 ②：预算维持既有 `runMeta.budget` 位置不变（groupBudget 是既有消费者）；
    // `dispatch` 是本轮新增的可观测子块，读不到就是「没有计划」，不影响预算闸。
    runMeta: {
      budget,
      dispatch: {
        mode,
        activeMemberIds,
        deferredMembers,
        caps: plan.caps || null,
      },
    },
  };
}

module.exports = {
  buildDispatchPlan,
  pickParticipatingRoster,
  SELECT_MODE,
};
