// P0-2：审批响应按 approvalId 分发（纯逻辑，可单测）
// 背景：原实现 ipcMain.once('tool:approval-response') 共享一条无 id 通道——
// 多个工具并发触发审批时，第一个到达的响应会被「任一个」等待中的 Promise 消费，
// 审批决策可能张冠李戴（把「允许」发给另一条更危险的命令）。CUA 仅为自身开了独立通道。
// 方案：requestApproval 生成唯一 approvalId，响应负载回带 id，按 id 精确分发；
//      未知 / 已超时的审批响应一律忽略（fail-closed，防串扰与重放）。

// V12：合法决策枚举——未知值 fail-closed 收敛为 deny
const VALID_DECISIONS = new Set(['once', 'conversation', 'always', 'deny']);
function normalizeDecision(decision) {
  return VALID_DECISIONS.has(decision) ? decision : 'deny';
}

class ApprovalChannel {
  constructor({ timeoutMs = 120000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.pending = new Map(); // approvalId -> { resolve, timer }
    this.seq = 0;
  }

  // 生成唯一审批 id（时间无关，进程内单调递增即可）
  nextId() {
    this.seq += 1;
    return `ap-${Date.now().toString(36)}-${this.seq}`;
  }

  // 发起一次审批等待：返回 Promise<'once'|'conversation'|'always'|'deny'>，超时按 deny
  // onSettle(approvalId, reason)：本次审批**无论以何种方式结束**（用户决策 / 超时 /
  // 进程退出）都会回调一次。渲染层据此撤下卡片——
  // 事故背景：此前卡片一旦弹出就常驻，主进程侧 pending 超时消失后用户再点，
  // 主进程找不到该 id 只能记「收到无法匹配的审批响应，已忽略」，用户看到的是
  // 「点了没反应 / 命令继续执行」，实际是这次审批早已按 deny 收尾。
  // N5（2026-10-16）：可选 runId——审批挂到发起它的运行上，运行取消时统一撤下（cancelByRun）。
  wait(approvalId, onSettle, runId = null) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value, reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(approvalId);
        resolve(value);
        try { onSettle?.(approvalId, reason); } catch { /* 回调失败不影响审批结果 */ }
      };
      const timer = setTimeout(() => finish('deny', 'timeout'), this.timeoutMs);
      // unref：测试/纯 Node 环境下不阻止进程退出
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(approvalId, { finish, timer, runId: runId || null });
    });
  }

  // 按 id 精确分发决策。返回是否成功分发（未知/已超时 id → false）
  // V12（2026-10-16）：决策枚举校验——只接受 once/conversation/always/deny，
  // 非法值（含被篡改的任意字符串/对象）一律按 deny 收尾，杜绝未知决策值沿审批链扩散。
  dispatch(approvalId, decision) {
    const entry = (approvalId != null) ? this.pending.get(approvalId) : null;
    if (!entry) return false;
    entry.finish(normalizeDecision(decision), 'decided');
    return true;
  }

  // 旧渲染层兼容：无 id 的裸 decision。仅当「恰有一个挂起审批」时按唯一挂起处理，
  // 多于一个挂起时拒绝猜测（宁可让该次审批走超时 deny，也不做错误分发）。
  dispatchLegacy(decision) {
    if (this.pending.size !== 1) return false;
    const [id, entry] = [...this.pending.entries()][0];
    entry.finish(normalizeDecision(decision), 'decided');
    return true;
  }

  // 挂起数量（诊断/UI 展示用）
  get size() { return this.pending.size; }

  // 退出/重置：全部按 deny 收尾，清理定时器
  disposeAll() {
    for (const [, entry] of this.pending) {
      try { entry.finish('deny', 'disposed'); } catch { /* 已收尾的忽略 */ }
    }
    this.pending.clear();
  }

  // N5：运行取消时撤下该 run 的全部挂起审批（rootExecution 统一取消之「撤审批」）。
  // 全部按 deny 收尾（运行已不在，审批卡继续挂着只会让用户对着已终止的运行做决策）；
  // onSettle 回调照常触发，渲染层撤卡。返回撤下的数量。
  cancelByRun(runId) {
    if (!runId) return 0;
    let n = 0;
    for (const [, entry] of this.pending) {
      if (entry.runId !== runId) continue;
      try { entry.finish('deny', 'run-cancelled'); n += 1; } catch { /* 已收尾的忽略 */ }
    }
    return n;
  }
}

module.exports = { ApprovalChannel };
