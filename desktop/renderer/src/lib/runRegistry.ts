// @ts-nocheck -- T2-2 存量代码原样搬移（零行为变更）；渐进 TS 路线下补全类型属后续任务（T0-3 门禁只约束新文件扩展名）
// T2-2：运行注册表（自主进程 ChatArea.jsx 原样搬移，行为不变）——
// 运行保活的事实源：threadId → 运行状态快照（runRegistry）与 runId → 快照（runIndex）双索引。
// 多会话并行/后台运行时，流式增量与事件按标签（runId/threadId）归档，切回会话时据此恢复可见 UI。

export const runRegistry = new Map();
export const runIndex = new Map();

export function makeRunState(runId, threadId) {
  const rs = {
    runId, threadId, controller: null,
    inFlight: false, done: false, settledAt: 0,
    streaming: '', reasoning: '', toolCalls: [],
    finalMsg: null, applied: true, // applied=false 表示完成消息还没进过可见消息列表（切回时补挂）
    runSummary: null, startedAt: 0,
    files: [], // 本轮产出文件（write_file/edit_file/apply_patch 目标），切回会话时渲染成卡片
  };
  runRegistry.set(threadId, rs);
  runIndex.set(runId, rs);
  return rs;
}
