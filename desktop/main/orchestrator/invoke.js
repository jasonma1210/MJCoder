// orchestrate_task 工具支撑：等待组终态 + 结果人话化（供主会话 Agent 的工具实现调用）
// 设计要点：
//   · 同步等待整组收尾——对话内「全自动」语义：Agent 发起编排后拿到聚合结果再向用户转述
//   · signal 透传——用户点「停止」时立即返回（在役任务由 AgentDock 强制关闭兜底）
//   · 墙钟上限防挂死（默认 30 分钟）
//   · T1-3：onPoll 可选回调——每次轮询拿到组快照即调用（任务≤8，2s 轮询开销可忽略），
//     供 toolOrchestrateTask 做状态 diff 上报子任务事件（spawn/progress/done/failed）
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;

const SETTLED = ['done', 'failed', 'paused', 'cancelled'];

// 等待组终态。墙钟上限防挂死（默认 30 分钟）；signal 透传（用户点「停止」时立即返回）。
// onPoll 可选回调——每次轮询拿到组快照即调用，供 toolOrchestrateTask 做状态 diff 上报子任务事件。
//
// ── P0 修复（2026-10-16，独立 PR）：原实现把 `store.getGroup(groupId)` 放在 try 之外 ──
// 事故链：getGroup 抛错（sqljs 句柄异常 / store 为空）→ 回调内异常无人接 →
//   setInterval 每 2s 再抛一次，产生三条叠加缺陷：
//   ① 正常路径永不 resolve ⇒ toolOrchestrateTask 永久 await ⇒ 对话卡死；
//   ② clearInterval 永不执行 ⇒ interval 永久泄漏，每 2s 空转；
//   ③ 每 2s 一次 uncaughtException ⇒ main.js 的 reportError 写一条 crash 记录
//      （含活跃 run 的 traceTail，每次从磁盘重读）⇒ 一小时约 1800 条，
//      写满 diagnostics 单日 5MB 上限后**静默丢弃新记录，真实崩溃也被挤掉**。
// 注意：abort（:17）与超时（:18）检查都在抛错点之上，故「停止」与「超时」能力未丢失——
// 修复前两条路径仍生效，缺陷在「永不 resolve + 无限泄漏 + 崩溃日志洪水」。
//
// 修法（最小侵入，不重写函数主体）：
//   · 整个 interval 回调进 try，异常走兜底 teardown ⇒ 修 ①；
//   · teardown 统一收口 clearInterval ⇒ 修 ②；
//   · abort 改事件监听而非轮询检查 ⇒ 解套不再依赖「interval 还活着」这个前提，
//     这是 ② 的根治而非绕过；signal 已中止时直接返回、根本不起 interval。
function waitGroupSettled(store, groupId, { signal, timeoutMs = DEFAULT_TIMEOUT_MS, pollIntervalMs = POLL_INTERVAL_MS, onPoll } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    let timer = null; // 先声明：teardown 可能在 timer 赋值前被调用（signal 已中止），避免 TDZ
    // teardown 可重复调用：resolve 与 clearInterval 均幂等，故 abortHandler（once:true）
    // 与 interval 体内的中止/超时检查可能各调一次，结果是安全的——不要为此加锁。
    const teardown = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      signal?.removeEventListener('abort', abortHandler);
      resolve(payload);
    };
    const abortHandler = () => teardown({ timedOut: false, aborted: true });
    if (signal?.aborted) { abortHandler(); return; } // 已中止：不起 interval，无从泄漏
    signal?.addEventListener('abort', abortHandler, { once: true });
    timer = setInterval(() => {
      try {
        if (Date.now() - start > timeoutMs) { teardown({ timedOut: true, aborted: false }); return; }
        const g = store.getGroup(groupId);
        if (!g) { teardown({ timedOut: false, aborted: false, missing: true }); return; }
        try { onPoll?.(g); } catch (e) { console.warn('[invoke] onPoll 上报失败:', e.message); }
        if (SETTLED.includes(g.status)) { teardown({ timedOut: false, aborted: false, group: g }); }
      } catch (e) {
        // 兜底：绝不让异常逃出 interval 回调（否则回到 uncaughtException 洪水）
        teardown({ timedOut: false, aborted: false, missing: true, error: String(e?.message || e) });
      }
    }, pollIntervalMs);
  });
}

// T1-3：组快照 diff → 子任务事件数组（纯函数，单测直接覆盖）。
// seen 由调用方持有（跨轮询帧的状态档案）；返回的事件经 reportSubagent 统一补 tool/groupId。
// 映射：queued→running=progress；done/failed=终态（带 tokens/summary/error）；skipped 归
// failed（依赖未达成）；failed→queued=失败自动重试回队，发 progress 提示。
// 防御：轮询启动晚于任务终态时（首帧即 done/failed/skipped）也补发对应事件，不丢终态。
function diffGroupEvents(seen, g) {
  const events = [];
  for (const t of g.tasks || []) {
    const prev = seen.get(t.taskId);
    if (prev && prev.status === t.status && prev.retryCount === t.retryCount) continue;
    seen.set(t.taskId, { status: t.status, retryCount: t.retryCount });
    const base = { taskId: t.taskId, title: t.title, round: t.retryCount };
    if (t.status === 'running') {
      events.push({ phase: 'progress', ...base });
    } else if (t.status === 'done') {
      events.push({ phase: 'done', ...base, tokens: t.result?.tokensUsed, summary: String(t.result?.summary || '').slice(0, 500) });
    } else if (t.status === 'failed') {
      events.push({ phase: 'failed', ...base, tokens: t.result?.tokensUsed, error: String(t.error || '执行失败').slice(0, 500), summary: String(t.result?.summary || '').slice(0, 500) });
    } else if (t.status === 'skipped') {
      events.push({ phase: 'failed', ...base, error: '依赖未达成，已跳过' });
    } else if (t.status === 'queued' && prev?.status === 'failed') {
      events.push({ phase: 'progress', ...base, error: '执行失败已自动重试，重新排队' });
    }
    // pending/queued 首帧建档不发事件（spawn 已由编排落地时逐任务发出）
  }
  return events;
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

module.exports = { waitGroupSettled, humanizeGroupResult, diffGroupEvents, DEFAULT_TIMEOUT_MS };
