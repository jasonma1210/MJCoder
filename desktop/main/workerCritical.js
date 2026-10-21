'use strict';
// 关键失败处理（P1-7 组级失败策略）——从 workerPool.js 抽出（B-15 补线后越过 800 行软档）。
//
// 语义与抽走前逐字等价：不可重试的关键任务失败且阻塞下游时，跳过所有未开始任务并把组置 paused；
// 状态迁移失败不再静默吞掉（否则任务永远停在 queued，组永远无法收尾/界面一直转圈）。
function pauseOnCriticalFailure(deps, groupId, task) {
  if (!deps?.store || !task?.critical) return false;
  if (!deps.store.groupHasBlockingFailure(groupId)) return false;

  const tasks = deps.store.listTasks(groupId);
  for (const t of tasks) {
    if (t.status !== 'queued' && t.status !== 'pending') continue;
    try {
      deps.store.setTaskStatus(groupId, t.taskId, 'skipped');
    } catch (e) {
      const stillPending = deps.store.getTask?.(groupId, t.taskId)?.status;
      if (stillPending === 'queued' || stillPending === 'pending') {
        console.error(`[workerPool] 子任务 ${t.taskId} 标记 skipped 失败且状态未推进`
          + `（${stillPending}）：${e.message}；强制置为 skipped 以免组无法收尾`);
        try { deps.store.setTaskStatus(groupId, t.taskId, 'skipped', { force: true }); }
        catch (e2) { console.error(`[workerPool] 强制置 skipped 仍失败：${e2.message}`); }
      } else {
        console.warn(`[workerPool] 子任务 ${t.taskId} 状态竞争（已为 ${stillPending}），忽略`);
      }
    }
  }
  deps.store.setGroupStatus(groupId, 'paused', {
    error: `关键任务「${task.title}」失败，下游任务已跳过：组已暂停（可重试失败任务或取消）`,
  });
  deps.emit?.({ type: 'group_update', groupId, status: 'paused', error: `关键任务「${task.title}」失败` });
  return true;
}

module.exports = { pauseOnCriticalFailure };
