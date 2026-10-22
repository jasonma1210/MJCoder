// 团队 Worker 链路的调试日志事实装配（2026-10-21）
//
// 从 `workerPool.js` 抽出：该文件原本 789 行，直接内联埋点会越过 800 行软档
//（God File 门禁 test/max-lines.test.js 明确「新文件超 800 行直接红」）。
// 本模块只负责把运行期对象裁剪成可读事实，真正的写盘/脱敏/轮转仍由
// `teamDebugLog` 单点完成——不存在第二套日志通道。
//
// 覆盖的关键节点，与「任务无人认领 / 看板显示完成但没有产出」一一对应：
//   run_group → task_claim → dispatch → engine_start → engine_done
//   → task_incomplete → task_settle → group_finalized
const teamDebug = require('./teamDebugLog');

/** run 起跑快照：任务、依赖、批次、名册、预算一次看全（「谁该干哪件事」的第一现场）。 */
function runGroup(g, waves) {
  teamDebug.log('worker', 'run_group', {
    groupId: g.group_id,
    status: g.status,
    goal: g.goal,
    cwd: g.cwd,
    projectPath: g.project_path || null,
    approvalMode: g.approval_mode || null,
    sandboxPolicy: g.sandbox_policy || null,
    threadId: g.thread_id || null,
    waves: waves || null,
    roster: Array.isArray(g.dag?.roster)
      ? g.dag.roster.map((m) => ({ id: m.id, name: m.name, roleKind: m.roleKind, enabled: m.enabled }))
      : null,
    runMeta: g.dag?.runMeta || null,
    tasks: (g.tasks || []).map((t) => ({
      taskId: t.taskId, title: t.title, status: t.status,
      dependsOn: t.dependsOn || [], critical: !!t.critical,
      ownerMemberId: t.ownerMemberId || null, maxRetry: t.maxRetry,
    })),
  });
}

/** 认领结果：「无人认领」在此一眼可判——owner=null 且 planned=null 或名册为空。 */
function claim(g, task, { planned = null, owner = null, roster = null } = {}) {
  teamDebug.log('worker', 'task_claim', {
    groupId: g.group_id,
    taskId: task.taskId,
    title: task.title,
    plannedOwner: planned || null,
    resolvedOwner: owner || null,
    rosterSize: Array.isArray(roster) ? roster.length : null,
  });
}

/** 已经有认领者（续跑/重跑）：记录原认领者，便于对照「这次是谁接的」。 */
function claimReused(g, task, planned) {
  teamDebug.log('worker', 'task_claim', {
    groupId: g.group_id, taskId: task.taskId, title: task.title,
    plannedOwner: planned || null,
    resolvedOwner: task.ownerMemberId || null,
    reused: true,
  });
}

function claimFailed(g, task, error) {
  teamDebug.log('worker', 'task_claim_failed', { groupId: g.group_id, taskId: task.taskId, error });
}

function dispatch(runKey, group, task, name, groupSandboxPolicy, wantsIsolation, activeRuns, maxConcurrent) {
  teamDebug.log('worker', 'dispatch', {
    runKey,
    groupId: group.group_id,
    taskId: task.taskId,
    title: task.title,
    worker: name,
    ownerMemberId: task.ownerMemberId || null,
    cwd: group.cwd,
    sandboxPolicy: groupSandboxPolicy,
    wantsIsolation,
    activeRuns,
    maxConcurrent,
  });
}

/** 引擎实际收到的配置（成员技能/工具/模型/治理档是否真的生效，在此可证伪）。 */
function engineStart({ runKey, group, task, sessionKey, runOpts, runCwd, resumeContext }) {
  teamDebug.log('worker', 'engine_start', {
    runKey,
    groupId: group.group_id,
    taskId: task.taskId,
    title: task.title,
    sessionKey,
    ownerMemberId: task.ownerMemberId || null,
    provider: runOpts.model?.provider?.id || null,
    model: runOpts.model?.model?.model_id || runOpts.model?.model?.id || null,
    cwd: runCwd,
    approvalMode: runOpts.approvalMode,
    sandboxPolicy: runOpts.sandboxPolicy,
    maxRounds: runOpts.maxRounds,
    runWallClockMs: runOpts.runWallClockMs,
    tokenBudget: runOpts.tokenBudget,
    toolCount: runOpts.toolHandlers ? Object.keys(runOpts.toolHandlers).length : 0,
    roleToolNames: Array.isArray(runOpts.rolePreset?.toolNames) ? runOpts.rolePreset.toolNames : null,
    roleSystemPromptLen: runOpts.rolePreset?.systemPrompt ? String(runOpts.rolePreset.systemPrompt).length : 0,
    skills: Array.isArray(runOpts.skills)
      ? runOpts.skills.map((s) => (typeof s === 'string' ? s.slice(0, 120) : (s?.name || '[skill]')))
      : [],
    skillDisclosure: runOpts.skillDisclosure || null,
    teamContext: !!runOpts.teamContext,
    resumeContextLen: String(resumeContext || '').length,
    prompt: runOpts.messages?.[0]?.content,
  }, { level: 'verbose' });
}

/** 引擎返回的原始结果：是否中止、错误、token、结论文本同框（「假完成」的直接证据）。 */
function engineDone({ runKey, group, task, abortReason, errorMsg, result }) {
  teamDebug.log('worker', 'engine_done', {
    runKey,
    groupId: group.group_id,
    taskId: task.taskId,
    title: task.title,
    ownerMemberId: task.ownerMemberId || null,
    aborted: abortReason,
    error: errorMsg,
    // usedTokens 是调用方 try 块的局部变量（块作用域），这里只从 result 取值；
    // 引擎抛错时 result 为空，记 null 而不是让调用方引用越界变量。
    tokensUsed: result?.tokensUsed ?? null,
    summary: result?.summary,
    artifacts: result?.artifacts,
  });
}

function incomplete({ runKey, group, task, retried, result }) {
  teamDebug.log('worker', 'task_incomplete', {
    runKey, groupId: group.group_id, taskId: task.taskId,
    retried: !!retried, tokensUsed: result?.tokensUsed ?? null, summary: result?.summary,
  });
}

/** 终态落库结果：与看板卡片是否一致，以下字段为唯一判据。 */
function settle({ runKey, group, task, finalTask, status }) {
  teamDebug.log('worker', 'task_settle', {
    runKey,
    groupId: group.group_id,
    taskId: task.taskId,
    title: task.title,
    ownerMemberId: finalTask?.owner_member_id || task.ownerMemberId || null,
    status,
    error: finalTask?.error || null,
    retryCount: finalTask?.retry_count ?? null,
    summary: finalTask?.result?.summary,
    artifacts: finalTask?.result?.artifacts,
  });
}

/**
 * 单条 assistant 消息的 token 增量（与 spawn_subagent 同口径）：usage 缺失时按内容估算
 * （≈4 字符/token + 每次工具调用 60）。供 workerPool 逐轮累计与预算硬中止共用。
 */
function messageTokens(m) {
  if (m?.role !== 'assistant') return 0;
  const reported = (m.tokens_input || 0) + (m.tokens_output || 0);
  if (reported > 0) return reported;
  return Math.ceil(String(m.content || '').length / 4)
    + (Array.isArray(m.tool_calls) ? m.tool_calls.length * 60 : 0);
}

/**
 * 依赖级联：前置 failed/skipped 时把传递依赖置 skipped 并广播事件。
 * 不做这一步，依赖任务会永久 pending、组永不收尾（预算软上限后尤其容易触发）。
 */
function cascadeSkip(deps, group, task, error) {
  const ids = deps.store.skipDependentsOf?.(group.group_id, task.taskId, error) || [];
  for (const id of ids) {
    deps.emit?.({ type: 'task_update', groupId: group.group_id, taskId: id, status: 'skipped' });
    deps.emit?.({ type: 'board_task_settled', groupId: group.group_id, taskId: id, status: 'skipped' });
  }
  return ids.length;
}

/** 组收尾的逐任务终态（含失败原因/产出摘要长度），对照看板是否与事实一致。 */
function finalize({ groupId, status, error, subResults, g, result, skippedNote }) {
  teamDebug.log('worker', 'group_finalized', {
    groupId,
    status,
    error,
    skipped: skippedNote || null,
    tasks: subResults.map((r) => ({
      taskId: r.taskId, title: r.title, critical: !!r.critical, ok: r.ok,
      status: g.tasks.find((t) => t.taskId === r.taskId)?.status || null,
      error: r.error || null,
      summaryLen: r.result?.summary ? String(r.result.summary).length : 0,
      tokensUsed: r.result?.tokensUsed || null,
    })),
    failed: result.failed,
    warnings: result.warnings,
  });
}

/**
 * 组收尾：把「未执行 / 失败」任务写进 warnings，并返回可读原因（全部成功返回 null）。
 * 2026-10-21 真机事故：预算耗尽跳过 3 个任务，组却落成 done；同批还有「非关键任务失败但组 done」
 * 导致用户拿到错误结果。现在两类未完成都算组失败，不再用 done 掩盖部分完成。
 */
function finalizeNote(g, result) {
  const tasks = g.tasks || [];
  const skipped = tasks.filter((t) => t.status === 'skipped');
  const failed = tasks.filter((t) => t.status === 'failed');
  if (skipped.length) result.warnings.push(`有 ${skipped.length} 个任务未执行：${skipped.map((t) => t.title || t.taskId).join('、')}`);
  if (failed.length) result.warnings.push(`有 ${failed.length} 个任务失败：${failed.map((t) => t.title || t.taskId).join('、')}`);
  if (skipped.length) return skipped[0].error || `存在未执行任务（${skipped.length} 个）`;
  if (failed.length) return `存在失败任务（${failed.length} 个）：${failed.map((t) => t.title || t.taskId).join('、')}`;
  return null;
}

module.exports = {
  runGroup, claim, claimReused, claimFailed, dispatch,
  engineStart, engineDone, incomplete, settle, cascadeSkip, finalize, finalizeNote, messageTokens,
};
