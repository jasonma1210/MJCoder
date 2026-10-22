// DS Bots / T6-7：项目配额闸的**调度侧接线**（设计稿 §7.1 检查点 / §6.3 暂停→恢复时序）。
//
// 分层不变量 I1（§3）：配额判定只允许 `quotaLedger.beforeDispatch` 一处；本模块不新增任何
// 判定规则，只做三件接线：
//   ① 泵前置闸 `blocked(group)`——配额不足时把组内 **queued** 任务转 quota_suspend，
//      在途 running 一律不动（§8.3：暂停只挡新推理，跑完手头这一轮）；
//   ② 开跑前预留 `beginRun(group, task)`——grant 失败同样落 quota_suspend，绝不判 failed
//      （I3：暂停不是失败，文档/任务/消息全部保留）；
//   ③ 后台 `tickAll()`——60s 老化判定 + 小批量 `resumeSuspendedTasks` 回 queued，自动续跑。
//
// 无项目绑定的组（普通编排组）一律 fail-open：返回 false / null，调度行为与 T6-7 之前完全一致。
// 组↔项目只认 `task_groups.thread_id` → `project_spaces.thread_id`（UNIQUE，单一事实来源），
// 不读 cwd：项目身份一旦挂到临时值上，换目录/换会话就再也找不回来（T6-2 的建表理由）。
'use strict';

const RESUME_BATCH = 2;     // §8「恢复要迟滞 + 小批量」：每轮最多放行 2 个，防瞬间再打满
const ROUND_FLUSH_MS = 500; // §16 风险表：扣费按轮合并写入，不逐轮 flush 触发整库序列化

/**
 * @param {object} opts
 * @param {object} opts.ledger       QuotaLedger 实例（唯一判定入口）
 * @param {object} opts.store        TaskStore（suspendTask / resumeSuspendedTasks / getGroup）
 * @param {object} [opts.db]         SQLite 句柄（写 project_runs.quota_state；缺省只广播不落库）
 * @param {Function} [opts.projectOfThread] threadId → project（缺省 = 无项目，全体 fail-open）
 * @param {Function} [opts.emit]     任务事件出口（tasks:event）
 * @param {Function} [opts.onResumed] 恢复放行后的推进回调（通常 = workerPool.schedule）
 * @param {object} [opts.breaker]    单成员熔断器（T6-8；缺省 = 不做成员级拦截）
 * @param {Function} [opts.now]      时钟注入（测试用；缺省 Date.now）
 */
function createQuotaGate({ ledger, store, db, projectOfThread, emit, onResumed, breaker, now = Date.now } = {}) {
  if (!ledger || !store) throw new Error('quotaGate 需要 ledger 与 taskStore');
  // groupId → 最近一次广播的配额态签名（只在变化时发事件：泵每拍都会问一次，不能刷屏）
  const states = new Map();
  const ensured = new Set(); // projectId 已确认存在配额桶（懒补建，只做一次）

  /** 组 → 项目；桶缺失时按迁移默认值补建（幂等）。任何异常都 fail-open，不阻断调度。 */
  function projectOf(group) {
    try {
      const threadId = String((group && group.thread_id) || '').trim();
      if (!threadId) return null;
      const p = projectOfThread ? projectOfThread(threadId) : null;
      if (!p || !p.projectId) return null;
      if (!ensured.has(p.projectId)) {
        if (!ledger.getBucket(p.projectId)) ledger.ensureBucket(p.projectId);
        ensured.add(p.projectId);
      }
      return p;
    } catch (e) {
      console.warn('[quota] 项目反查失败（本组不设配额闸）:', e.message);
      return null;
    }
  }

  /** 记录 run 的成本状态（§5.2：run 本身不新增枚举，暂停态由 project_runs.quota_state 表达）。 */
  function saveRunState(group, project, state) {
    if (!db) return;
    try {
      const ts = now();
      db.prepare(`INSERT INTO project_runs (run_id, project_id, thread_id, quota_state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET quota_state = excluded.quota_state, updated_at = excluded.updated_at`)
        .run(group.group_id, project.projectId, (group && group.thread_id) || null, state, ts, ts);
    } catch (e) {
      // 状态落库是观测辅助：失败只记日志，绝不影响调度判定
      console.warn('[quota] 记录 run 配额态失败（不阻塞调度）:', e.message);
    }
  }

  function markState(group, project, state, extra = {}) {
    const sig = `${state}|${extra.reason || ''}`;
    if (states.get(group.group_id) === sig) return;
    states.set(group.group_id, sig);
    saveRunState(group, project, state);
    const st = ledger.state(project.projectId, now());
    emit?.({
      type: 'quota_state', groupId: group.group_id, projectId: project.projectId, state,
      reason: extra.reason || null, used: st.used, available: st.available, util: st.util,
    });
  }

  /**
   * 泵前置闸（§7.1「派发每个任务前」）。返回 true = 本组本轮停派（调用方 continue）。
   * 只处置 queued：running 属于在途 run，由 beginRun 结算与 finally 收尾。
   */
  function blocked(group) {
    const project = projectOf(group);
    if (!project) return false;
    const v = ledger.beforeDispatch(project.projectId, now());
    if (v.allow) {
      markState(group, project, v.state === 'throttle' ? 'throttle' : 'ok');
      return false;
    }
    const full = store.getGroup(group.group_id) || group;
    for (const t of full.tasks || []) {
      if (t.status !== 'queued') continue;
      const r = store.suspendTask(group.group_id, t.taskId, { reason: v.reason || 'quota' });
      if (!r) continue;
      emit?.({ type: 'task_update', groupId: group.group_id, taskId: t.taskId, status: 'quota_suspend', error: r.error });
    }
    markState(group, project, 'suspended', { reason: v.reason || 'quota' });
    return true;
  }

  /** 在途用量聚合器：500ms 合并写一条 round 流水；settle 时补差并释放预留（幂等）。 */
  function makeHandle({ project, group, task, granted }) {
    let pending = 0;
    let lastFlush = now();
    let settled = false;
    const context = {
      projectId: project.projectId, runId: group.group_id,
      taskId: task.taskId, memberId: task.ownerMemberId || null,
    };
    const flush = () => {
      if (pending <= 0) return;
      const tokens = pending;
      pending = 0;
      lastFlush = now();
      ledger.recordRound({ ...context, tokens });
    };
    return {
      ok: true, grant: granted, projectId: project.projectId,
      note(tokens) {
        const n = Math.max(0, Math.trunc(Number(tokens) || 0));
        if (!n) return;
        pending += n;
        if (now() - lastFlush >= ROUND_FLUSH_MS) flush();
      },
      settle(actual) {
        if (settled) return;
        settled = true;
        flush();
        ledger.settle({ ...context, actual });
      },
      release() {
        if (settled) return;
        settled = true;
        flush();
        ledger.release(task.taskId);
      },
    };
  }

  /**
   * 任务开跑前（§7.1「任务开跑前」）：
   *   · 无项目 → null（普通编排组零回归）；
   *   · 闸不放行 / 预留授予为 0 → 任务转 quota_suspend，返回 { ok:false }；
   *   · 放行 → 返回带 note/settle 的句柄，tokenBudget 由调用方取 min(组剩余, 授予额)。
   */
  function beginRun(group, task) {
    const project = projectOf(group);
    if (!project) return null;
    const v = ledger.beforeDispatch(project.projectId, now());
    const granted = v.allow ? ledger.grant(project.projectId, task.taskId, v.grant) : 0;
    if (!granted) {
      const reason = v.reason || 'quota';
      const r = store.suspendTask(group.group_id, task.taskId, { reason });
      if (r) {
        emit?.({ type: 'task_update', groupId: group.group_id, taskId: task.taskId, status: 'quota_suspend', error: r.error });
      }
      markState(group, project, 'suspended', { reason });
      return { ok: false, reason, projectId: project.projectId };
    }
    markState(group, project, v.state === 'throttle' ? 'throttle' : 'ok');
    return makeHandle({ project, group, task, granted });
  }

  /**
   * T6-8（§5.3）：单成员熔断闸——只拦「已被熔断的 owner 成员」的已认领任务。
   * 落点必须在 owner 解析之后：认领前不知道这条任务归谁，拦早了会把正常成员一起挡掉。
   * 返回 true = 本任务已转 quota_suspend(breaker)，调用方不要再派发。
   */
  const breakerMarks = new Map(); // `${groupId}::${memberId}` → 最近广播的熔断态
  function breakerBlocked(group, task) {
    if (!breaker) return false;
    const project = projectOf(group);
    if (!project) return false;
    const memberId = String((task && task.ownerMemberId) || '').trim();
    if (!memberId) return false;
    const markKey = `${group.group_id}::${memberId}`;
    if (breaker.allow(project.projectId, memberId, now())) {
      if (breakerMarks.get(markKey) === 'open') {
        breakerMarks.set(markKey, 'closed');
        emit?.({ type: 'breaker_state', groupId: group.group_id, projectId: project.projectId, memberId, state: 'closed' });
      }
      return false;
    }
    if (breakerMarks.get(markKey) !== 'open') {
      breakerMarks.set(markKey, 'open');
      emit?.({ type: 'breaker_state', groupId: group.group_id, projectId: project.projectId, memberId, state: 'open' });
    }
    const r = store.suspendTask(group.group_id, task.taskId, { reason: 'breaker' });
    if (r) {
      emit?.({ type: 'task_update', groupId: group.group_id, taskId: task.taskId, status: 'quota_suspend', error: r.error });
    }
    return true;
  }

  /**
   * 后台轮询（§6.3 / §8.2 tick）：只对 running 组所属项目做恢复判定；
   * 恢复按 `resumeDecision` 的迟滞与批量上限执行，绝不一次性全放。
   */
  function tickAll() {
    const groups = (store.listGroups({ limit: 50 }) || []).filter((g) => g.status === 'running');
    const byProject = new Map();
    for (const g of groups) {
      const p = projectOf(g);
      if (!p) continue;
      if (!byProject.has(p.projectId)) byProject.set(p.projectId, []);
      byProject.get(p.projectId).push(g);
    }
    let resumed = 0;
    for (const [projectId, list] of byProject) {
      const d = ledger.resumeDecision(projectId, now(), RESUME_BATCH);
      if (!d.resume) continue;
      let quota = d.limit;
      for (const g of list) {
        if (quota <= 0) break;
        // T6-8：熔断成员的暂停任务不随项目额度恢复而放行——否则「恢复→再熔断」每 60s 空转一次
        const allow = (row) => !breaker || !row.owner_member_id
          || breaker.allow(projectId, row.owner_member_id, now());
        const ids = store.resumeSuspendedTasks(g.group_id, { limit: quota, allow }) || [];
        if (!ids.length) continue;
        quota -= ids.length;
        resumed += ids.length;
        for (const taskId of ids) emit?.({ type: 'task_update', groupId: g.group_id, taskId, status: 'queued' });
        markState(g, projectOf(g), 'ok');
      }
    }
    // 放行回队列后必须踢一脚调度：pump 是异步泵，不主动 schedule 就等下一次事件才推进
    if (resumed > 0) onResumed?.();
    return { resumed };
  }

  return { blocked, beginRun, breakerBlocked, tickAll, markState, projectOf };
}

module.exports = { createQuotaGate, RESUME_BATCH, ROUND_FLUSH_MS };
