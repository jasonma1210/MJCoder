// P0-2：审批响应按 approvalId 分发（纯逻辑，可单测）
// 背景：原实现 ipcMain.once('tool:approval-response') 共享一条无 id 通道——
// 多个工具并发触发审批时，第一个到达的响应会被「任一个」等待中的 Promise 消费，
// 审批决策可能张冠李戴（把「允许」发给另一条更危险的命令）。CUA 仅为自身开了独立通道。
// 方案：requestApproval 生成唯一 approvalId，响应负载回带 id，按 id 精确分发；
//      未知 / 已超时的审批响应一律忽略（fail-closed，防串扰与重放）。

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
  wait(approvalId) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(approvalId);
        resolve('deny');
      }, this.timeoutMs);
      // unref：测试/纯 Node 环境下不阻止进程退出
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(approvalId, { resolve, timer });
    });
  }

  // 按 id 精确分发决策。返回是否成功分发（未知/已超时 id → false）
  dispatch(approvalId, decision) {
    const entry = (approvalId != null) ? this.pending.get(approvalId) : null;
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(approvalId);
    entry.resolve(decision || 'deny');
    return true;
  }

  // 旧渲染层兼容：无 id 的裸 decision。仅当「恰有一个挂起审批」时按唯一挂起处理，
  // 多于一个挂起时拒绝猜测（宁可让该次审批走超时 deny，也不做错误分发）。
  dispatchLegacy(decision) {
    if (this.pending.size !== 1) return false;
    const [id, entry] = [...this.pending.entries()][0];
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(decision || 'deny');
    return true;
  }

  // 挂起数量（诊断/UI 展示用）
  get size() { return this.pending.size; }

  // 退出/重置：全部按 deny 收尾，清理定时器
  disposeAll() {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve('deny');
    }
    this.pending.clear();
  }
}

module.exports = { ApprovalChannel };
