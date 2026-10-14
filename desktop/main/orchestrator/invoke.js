// orchestrate_task 工具支撑：等待组终态 + 结果人话化（供主会话 Agent 的工具实现调用）
// 设计要点：
//   · 同步等待整组收尾——对话内「全自动」语义：Agent 发起编排后拿到聚合结果再向用户转述
//   · signal 透传——用户点「停止」时立即返回（在役任务由 AgentDock 强制关闭兜底）
//   · 墙钟上限防挂死（默认 30 分钟）
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;

const SETTLED = ['done', 'failed', 'paused', 'cancelled'];

function waitGroupSettled(store, groupId, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (signal?.aborted) { clearInterval(timer); resolve({ timedOut: false, aborted: true }); return; }
      if (Date.now() - start > timeoutMs) { clearInterval(timer); resolve({ timedOut: true, aborted: false }); return; }
      const g = store.getGroup(groupId);
      if (!g) { clearInterval(timer); resolve({ timedOut: false, aborted: false, missing: true }); return; }
      if (SETTLED.includes(g.status)) { clearInterval(timer); resolve({ timedOut: false, aborted: false, group: g }); }
    }, POLL_INTERVAL_MS);
  });
}

// 组结果 → 人话（Agent 直接转述给用户；失败/暂停时给出「减少 Agent」的可行动建议）
function humanizeGroupResult(group) {
  const tasks = group.tasks || [];
  const done = tasks.filter((t) => t.status === 'done');
  const failed = tasks.filter((t) => t.status === 'failed');
  const skipped = tasks.filter((t) => t.status === 'skipped');
  const result = group.result || {};
  const lines = [];

  if (group.status === 'done' && failed.length === 0) {
    lines.push(`编排完成：${done.length} 个子任务全部执行成功。`);
  } else if (group.status === 'done') {
    lines.push(`编排收尾：${done.length} 个成功，${failed.length} 个失败已降级${skipped.length ? `，${skipped.length} 个跳过` : ''}。`);
  } else if (group.status === 'paused') {
    lines.push(`编排暂停：关键子任务失败，已停止后续执行（${done.length} 个已完成的结果已保留）。`);
  } else if (group.status === 'failed') {
    lines.push(`编排失败：${failed.length} 个子任务最终失败（${done.length} 个已完成的结果已保留）。`);
  } else if (group.status === 'cancelled') {
    lines.push('编排已取消。');
  }

  if (failed.length) {
    lines.push(`失败明细：${failed.map((t) => `「${t.title}」${String(t.error || '').slice(0, 120)}`).join('；')}`);
  }
  if (result.warnings?.length) {
    lines.push(`降级警告 ${result.warnings.length} 条：${result.warnings.slice(0, 3).join('；')}${result.warnings.length > 3 ? ' 等' : ''}`);
  }
  if (result.summary) {
    lines.push(`各子任务结论摘要：\n${String(result.summary).slice(0, 4000)}`);
  }
  if (group.status === 'paused' || group.status === 'failed' || failed.length > 0) {
    lines.push('建议：并发 Agent 出现问题时，把 max_agents 调小（如 1 个串行重试）再次调用 orchestrate_task；已完成的子任务结论可直接复用，不必重复执行。');
  }
  return lines.filter(Boolean).join('\n');
}

module.exports = { waitGroupSettled, humanizeGroupResult, DEFAULT_TIMEOUT_MS };
