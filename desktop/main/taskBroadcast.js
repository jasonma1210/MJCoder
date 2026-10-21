// 任务事件广播（T5-3 / T5-12 共用）——把「状态机已推进」的事实翻译成 UI 可消费的事件。
//
// 抽出理由（2026-10-20，T5-12 接入后 workerPool.js 越过 800 行软档）：这两条广播是**纯事件映射**，
// 不含状态与计时器，且 waveEngine 也需要同一份「唤醒广播」语义（撤员重派后级联唤醒）。
// 收敛在此处可让 workerPool 与 waveEngine 共用一份实现，避免两处措辞/字段漂移。

/**
 * 等待超时清扫的结果广播（§7 规则 2/5：超时必须落终态且可见）。
 * 每条超时任务发三件事：超时任务自身 → failed（带结构化原因）；被它级联唤醒的任务 → queued；
 * 一条 board_task_settled 供看板消费（与终态唤醒同型，保持事件口径一致）。
 */
function broadcastWaitSweep(deps, timedOut) {
  for (const t of timedOut) {
    // error 文本从 store 读取（sweepWaitTimeouts 已把结构化原因落库）——单一事实来源，
    // 不在此处重复拼一遍中文文案（否则两处措辞必然漂移）。
    const err = deps.store.getTask?.(t.groupId, t.taskId)?.error || '';
    deps.emit?.({ type: 'task_update', groupId: t.groupId, taskId: t.taskId, status: 'failed', error: err });
    for (const wokenId of t.woken || []) {
      deps.emit?.({ type: 'task_update', groupId: t.groupId, taskId: wokenId, status: 'queued' });
    }
    deps.emit?.({ type: 'board_task_settled', groupId: t.groupId, taskId: t.taskId, status: 'failed' });
  }
}

/**
 * 终态唤醒的结果广播（§7 规则 4/5）。唤醒 = waiting → queued，用户看到卡片从「等待中」回到
 * 「排队中」；wake 活动流文案解释是哪条依赖把它放行的。
 */
function broadcastWoken(deps, groupId, woken) {
  for (const w of woken) {
    deps.emit?.({ type: 'task_update', groupId, taskId: w.taskId, status: 'queued' });
    deps.emit?.({ type: 'task_activity', groupId, taskId: w.taskId, kind: 'wake',
      textKey: 'runtime.workerWoken', textParams: { deps: (w.waitingOn || []).join(', ') } });
  }
}

module.exports = { broadcastWaitSweep, broadcastWoken };
