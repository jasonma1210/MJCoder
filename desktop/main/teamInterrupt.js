// M5 / T5-10：中断权限矩阵与留痕（设计稿 §9.2）
//
// 为什么需要独立模块：中断是「杀死别人的工作」，权限判定、执行处置、审计留痕三件事
// 必须在**同一入口**闭环。分散到 IPC / workerPool / 工具面各写一份，必然出现
// 「界面能停、模型能停、审计漏一半」的规则漂移（与 §9.2 的单一事实来源要求冲突）。
//
// 三主体矩阵（§9.2 表格逐字落地）：
//   · 用户：可中断任意对象（Lead / 任意成员 / 任意任务）——用户主权，不需要理由；
//   · Lead：可中断本团队内任意成员的任务（含自己的任务），但**不允许自我中止**（修成员范围时）；
//   · 成员：仅可中断**自己认领**的任务，不能按成员范围中断。
//
// 两条硬约束：
//   ① Lead 中断成员必须留 `kind='system'` 的团队消息（理由不可为空）——无理由不可审计；
//   ② Lead 中断按 L1 逐次确认，且**不允许同类豁免**：每次都要求 `confirmed=true`，
//      同一目标重复调用也不会被静默放行（本项目既有 L1 规则的同口径）。
//
// 接线边界（§8.1）：`team_interrupt` **不接给模型**——成员 run 走无人值守通道，
// 审批一律 deny，接进来就是「schema 可见、调用必失败」的死工具。控制层动作由用户经
// `teams:interrupt` IPC 完成；本模块同时保留 lead/member 两条策略路径，供后续
// 「成员 run 审批通道」落地后直接复用（策略与执行分离，避免届时重写）。
//
// ── 第八轮 B-07：lead / member 分支的「预置策略」标注（勿删）────────────────
//   改前唯一入口 `main.js` 把它硬编码成 `actorKind:'user'`，于是 lead/member 两条分支、
//   以及 `REASON_REQUIRED` / `NEED_CONFIRM` 两处判据在生产**永远走不到**，`teams:interrupt`
//   传进来的 `confirmed` 没有人检查——治理承诺（§9.2 两条硬约束）与实现不符的死代码。
//   现在改为**显式声明式**：入口经 `resolveActor(payload)` 解析发起方，未声明/非法一律回落
//   `user`（fail-closed —— user 是权限最宽的主体，回落不会放大权限）；调用方显式传
//   `actorKind:'lead'|'member'` 时两条分支立即生效，理由与逐次确认判据随之为真。
//   安全边界：`teams:interrupt` 只有渲染层调得到，而渲染层本就能声明 `user`（全权）——
//   所以「允许声明 lead/member」不会带来任何提权面，只是让更**窄**的主体可被表达，
//   从而让审计串里的 actor 与真实意图一致（此前恒为 'user'，将来接通道时历史语义会漂移）。
//   仍未接线的那一半：**模型侧**中断通道（成员 run 审批）尚未落地，届时直接把
//   `actorKind` 从成员会话维度带进来即可，矩阵本身无需改动。
//
// 中断 ≠ 删除：任务产物（result.artifacts）在中断时写入审计消息的 refs，数据保留可追溯。
const { TERMINAL_TASK_STATUSES } = require('./taskStore');

// 结构化错误码：渲染层 / 调用方据此分支，文案只作兜底展示。
const INTERRUPT_ERRORS = {
  UNAVAILABLE: '团队子系统或任务存储不可用',
  INVALID_ACTOR: '非法中断发起方（仅支持 user / lead / member）',
  RUN_NOT_FOUND: '本次运行不存在',
  TEAM_NOT_FOUND: '团队不存在',
  ACTOR_NOT_IN_ROSTER: '中断发起方不在本次运行的编制快照内',
  NOT_LEAD: '发起方不是本次运行的统筹负责人',
  LEAD_SELF_FORBIDDEN: '统筹不能中止自己（防失控，§9.2）',
  MEMBER_SCOPE_FORBIDDEN: '成员只能按任务中断，不能按成员范围中断',
  MEMBER_NOT_OWNER: '成员只能中断自己认领的任务',
  REASON_REQUIRED: '统筹中断下属必须填写理由（留痕要求）',
  NEED_CONFIRM: '需要用户逐次确认后才能执行中断（L1，不允许同类豁免）',
  TASK_NOT_FOUND: '任务不存在',
  MEMBER_NOT_FOUND: '成员不在本次运行的名册内',
  NO_ACTIVE_TASK: '该成员在本次运行中没有可中断的任务',
  ALREADY_SETTLED: '任务已是终态，无需中断',
};

let deps = null;

/** 中断发起方白名单（§9.2 三主体）：矩阵与 IPC 共用这一份，避免两处各写一串字面量。 */
const ACTOR_KINDS = ['user', 'lead', 'member'];

/**
 * 发起方解析（IPC 入参 → 矩阵入参）。第八轮 B-07 —— 让 lead/member 分支真正可达。
 *
 * 三条硬规则：
 *   ① 未声明 `actorKind` → `'user'`。**默认值必须是最宽的那个**：本文件其它地方
 *      随处可见的 fail-closed 是「判不出来就拒绝」，而这里是「判不出来就当作最有权限的人」——
 *      看似相反，其实同源：`teams:interrupt` 是**用户点按钮**发起的通道，用户本来就是主权方；
 *      把「没写 actorKind」判成 member 会让用户的正常中断被矩阵拒掉（体验事故）。
 *   ② 声明了但不在白名单 → 同样回落 `'user'`，并由 `interruptTask` 之外的调用方决定是否拒绝。
 *      这里不直接抛错：非法值多半是渲染层版本错位，宁可按既有语义放行用户的中断。
 *   ③ `actorKind==='user'` 时 `actorMemberId` 一律清空 —— 审计串里不该出现「用户 + 某个成员 id」
 *      这种自相矛盾的组合（旧实现靠入口硬编码掩盖，放开入参后必须显式清理）。
 *
 * @param {{actorKind?:string, actorMemberId?:string|null}} payload
 * @returns {{actorKind:'user'|'lead'|'member', actorMemberId:string|null}}
 */
function resolveActor(payload = {}) {
  const raw = payload && typeof payload === 'object' ? payload.actorKind : null;
  const actorKind = ACTOR_KINDS.includes(raw) ? raw : 'user';
  const memberId = actorKind === 'user' ? '' : String(payload?.actorMemberId || '');
  return { actorKind, actorMemberId: memberId || null };
}


/**
 * 注入依赖（与其它主进程模块同款 initXxx 风格）。
 * @param {{
 *   getTeamStore: () => any,
 *   getTaskStore: () => any,
 *   workerPool?: { abortTask?: Function, schedule?: Function },
 *   emit?: (evt: any) => void,
 *   postMessage?: (input: any) => any,
 * }} d
 */
function initTeamInterrupt(d) {
  deps = d || null;
}

function fail(code) {
  return { ok: false, code, error: INTERRUPT_ERRORS[code] || String(code), interrupted: [] };
}

/**
 * 三主体权限矩阵（纯函数，§9.2）。
 * @param {{
 *   actorKind: 'user'|'lead'|'member',
 *   actorMemberId?: string|null,
 *   actorRoleKind?: string,
 *   targetOwnerId?: string|null,
 *   scope: 'task'|'member',
 * }} input
 * @returns {{ok:boolean, code:string|null, error:string}}
 */
function checkInterruptPermit({ actorKind, actorMemberId, actorRoleKind, targetOwnerId, scope }) {
  if (actorKind === 'user') return { ok: true, code: null, error: '' };
  if (actorKind === 'lead') {
    if (actorRoleKind !== 'lead') return { ok: false, code: 'NOT_LEAD', error: INTERRUPT_ERRORS.NOT_LEAD };
    // 任务范围允许「含自己的任务」；成员范围禁止指向自己（不允许自我中止）。
    if (scope === 'member' && String(targetOwnerId || '') === String(actorMemberId || '')) {
      return { ok: false, code: 'LEAD_SELF_FORBIDDEN', error: INTERRUPT_ERRORS.LEAD_SELF_FORBIDDEN };
    }
    return { ok: true, code: null, error: '' };
  }
  if (actorKind === 'member') {
    if (scope === 'member') {
      return { ok: false, code: 'MEMBER_SCOPE_FORBIDDEN', error: INTERRUPT_ERRORS.MEMBER_SCOPE_FORBIDDEN };
    }
    if (!actorMemberId || String(targetOwnerId || '') !== String(actorMemberId)) {
      return { ok: false, code: 'MEMBER_NOT_OWNER', error: INTERRUPT_ERRORS.MEMBER_NOT_OWNER };
    }
    return { ok: true, code: null, error: '' };
  }
  return { ok: false, code: 'INVALID_ACTOR', error: INTERRUPT_ERRORS.INVALID_ACTOR };
}

/** run 级名册：编制快照优先（T5-9），缺失才回落实时名册。 */
function resolveRoster(group, team) {
  const snapshot = group?.dag?.roster;
  if (Array.isArray(snapshot) && snapshot.length) return snapshot;
  return Array.isArray(team?.members) ? team.members : [];
}

/** 中断任务的执行处置：running/waiting 走 Worker 池唯一入口，其余直接落 skipped 并唤醒下游。 */
function interruptOne(taskStore, task, runId, why) {
  const error = why ? `任务已被中断：${why}` : '任务已被中断';
  if (task.status === 'running' || task.status === 'waiting') {
    return deps.workerPool?.abortTask?.(runId, task.taskId) === true;
  }
  try {
    taskStore.setTaskStatus(runId, task.taskId, 'skipped', { error, force: true });
    deps.emit?.({ type: 'task_update', groupId: runId, taskId: task.taskId, status: 'skipped', error });
    // 中断即终态：等它的任务必须立刻被唤醒，否则会白等到各自墙钟超时（§7 规则 2 同型级联）。
    const woken = taskStore.settleWaitingTasks?.(runId, task.taskId) || [];
    for (const w of woken) {
      deps.emit?.({ type: 'task_update', groupId: runId, taskId: w.taskId, status: 'queued' });
    }
    deps.emit?.({ type: 'board_task_settled', groupId: runId, taskId: task.taskId, status: 'skipped' });
    deps.workerPool?.schedule?.();
    return true;
  } catch (e) {
    console.warn(`[teamInterrupt] 任务 ${runId}/${task.taskId} 中断失败:`, e?.message || e);
    return false;
  }
}

/** 任务产物路径（审计 refs）：中断 ≠ 删除，已有产物记录进留痕供事后追溯。 */
function artifactsOf(task) {
  const list = task?.result?.artifacts;
  if (!Array.isArray(list)) return [];
  return list.map((a) => (typeof a === 'string' ? a : a?.path)).filter(Boolean).map(String);
}

/**
 * 执行一次中断（权限判定 → 执行 → 留痕）。
 *
 * @param {{
 *   teamId?: string, runId: string,
 *   taskId?: string, targetMemberId?: string,
 *   actorKind?: 'user'|'lead'|'member', actorMemberId?: string|null,
 *   reason?: string, confirmed?: boolean,
 * }} params
 * @returns {{ok:boolean, code?:string, error?:string, scope?:'task'|'member', interrupted?:string[]}}
 */
function interruptTask({
  teamId = '', runId = '', taskId = '', targetMemberId = '',
  actorKind = 'user', actorMemberId = null, reason = '', confirmed = false,
} = {}) {
  if (!deps) return fail('UNAVAILABLE');
  const taskStore = deps.getTaskStore?.();
  const teamStore = deps.getTeamStore?.();
  if (!taskStore || !teamStore) return fail('UNAVAILABLE');
  if (!ACTOR_KINDS.includes(actorKind)) return fail('INVALID_ACTOR');

  const group = taskStore.getGroup?.(runId);
  if (!group) return fail('RUN_NOT_FOUND');
  const team = teamId ? teamStore.getTeam?.(teamId) : null;
  if (teamId && !team) return fail('TEAM_NOT_FOUND');

  const roster = resolveRoster(group, team);
  const memberById = new Map(roster.filter((m) => m && m.id).map((m) => [String(m.id), m]));
  if (actorKind !== 'user') {
    const actor = memberById.get(String(actorMemberId || ''));
    if (!actor) return fail('ACTOR_NOT_IN_ROSTER');
  }

  const scope = targetMemberId ? 'member' : 'task';
  const tasks = taskStore.listTasks?.(runId) || [];
  let targets = [];
  let targetOwnerId = null;

  if (scope === 'member') {
    const target = memberById.get(String(targetMemberId));
    if (!target) return fail('MEMBER_NOT_FOUND');
    targetOwnerId = String(targetMemberId);
  } else {
    const task = tasks.find((t) => String(t.taskId) === String(taskId));
    if (!task) return fail('TASK_NOT_FOUND');
    if (TERMINAL_TASK_STATUSES.includes(task.status)) return fail('ALREADY_SETTLED');
    targets = [task];
    targetOwnerId = task.ownerMemberId ? String(task.ownerMemberId) : null;
  }

  const actorRoleKind = actorKind === 'user'
    ? null : memberById.get(String(actorMemberId || ''))?.roleKind;
  const permit = checkInterruptPermit({
    actorKind, actorMemberId, actorRoleKind, targetOwnerId, scope,
  });
  if (!permit.ok) return fail(permit.code);

  const why = String(reason || '').trim();
  // 留痕硬约束：Lead 中断下属必须给理由（§9.2）。
  if (actorKind === 'lead' && !why) return fail('REASON_REQUIRED');
  // L1 逐次确认：每次调用都要显式确认，不存在「本 run 同类豁免」。
  if (actorKind === 'lead' && confirmed !== true) return fail('NEED_CONFIRM');

  if (scope === 'member') {
    targets = tasks.filter((t) => String(t.ownerMemberId || '') === String(targetMemberId)
      && !TERMINAL_TASK_STATUSES.includes(t.status));
    if (targets.length === 0) return fail('NO_ACTIVE_TASK');
  }

  const interrupted = [];
  const refs = [];
  for (const t of targets) {
    if (interruptOne(taskStore, t, runId, why)) interrupted.push(t.taskId);
    refs.push(...artifactsOf(t));
  }
  if (interrupted.length === 0) return fail('ALREADY_SETTLED');

  // 审计留痕：所有主体都写一条 system 消息；界面按 payload.sys 翻译，summary 保持中性机器文本。
  // 普通编排（无团队）没有总线可写，跳过留痕（users 仍可从任务轨迹看到 skipped 事件）。
  const targetName = scope === 'member'
    ? (memberById.get(String(targetMemberId))?.name || String(targetMemberId))
    : (memberById.get(String(targetOwnerId || ''))?.name || '');
  if (team) {
    try {
      deps.postMessage?.({
        teamId: String(team.id),
        runId,
        kind: 'system',
        fromMemberId: actorKind === 'user' ? null : String(actorMemberId),
        summary: `interrupt: ${targetName || 'unclaimed'}${why ? ` · ${why}` : ''}`,
        payload: {
          sys: 'interrupt', name: targetName || 'unclaimed', reason: why,
          actor: actorKind, scope, taskIds: interrupted,
        },
        refs: [...new Set(refs)],
      });
    } catch (e) {
      // 留痕失败不回滚中断：任务已经停了，回滚会让用户看到「点了没停」。
      console.warn('[teamInterrupt] 中断留痕失败:', e?.message || e);
    }
  }

  return { ok: true, scope, interrupted, reason: why };
}

module.exports = {
  initTeamInterrupt, checkInterruptPermit, resolveActor, interruptTask, resolveRoster,
  ACTOR_KINDS, INTERRUPT_ERRORS,
};
