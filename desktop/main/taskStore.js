// P1-3：任务持久化队列——SQLite 状态机 + 断点续跑（计划文档「本地任务队列」目标）
// 状态机：
//   group: ready → running → done | failed | paused | cancelled
//   task : pending → queued → running → done | failed | skipped
//          failed --(retry, retry_count<max_retry)--> queued
// 关键失败 → 组 paused（等待重新规划/人工处置）；非关键失败 → 降级继续（聚合附警告）。
// 写入全部经由本模块的同步 better-sqlite3 事务（主进程单线程，天然串行，无并发写脏数据）。

const TASK_TRANSITIONS = {
  pending: ['queued', 'skipped'],
  queued: ['running', 'pending', 'skipped'], // pending：取消排队回退
  running: ['done', 'failed', 'queued'],     // queued：崩溃恢复 / 重试
  done: [],
  failed: ['queued'],                        // 手动重试入口
  skipped: [],
};

const GROUP_TRANSITIONS = {
  ready: ['running', 'cancelled'],
  running: ['done', 'failed', 'paused', 'cancelled'],
  paused: ['running', 'cancelled'],
  done: [], failed: [], cancelled: [],
};

function canTransition(kind, from, to) {
  const table = kind === 'group' ? GROUP_TRANSITIONS : TASK_TRANSITIONS;
  return (table[from] || []).includes(to);
}

class TaskStore {
  constructor(db) {
    this.db = db;
  }

  now() { return Date.now(); }

  // ── 组 ──
  // meta：{ auto, replanDepth, replanOf } 自动编排元数据（auto 组失败后由主进程自动重规划）
  // V04（2026-10-16）：approvalMode/sandboxPolicy 是「建组时刻」的宿主治理快照，
  // 由调用方（main.js 从用户当前设置取值）传入并持久化——Worker 执行时读组内快照，
  // 不再读取全局最近一次会话设置（否则会话中途改审批档会串到已在排队的组）。
  // R6（2026-10-16，用户实测反馈）：threadId = 创建组的会话——组绑定会话而非全局可见。
  createGroup({ groupId, goal, cwd, projectPath, dag, tasks, auto, replanDepth, replanOf, approvalMode, sandboxPolicy, threadId }) {
    const now = this.now();
    const tx = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO task_groups (group_id, goal, cwd, status, dag_json, auto, replan_depth, replan_of, approval_mode, sandbox_policy, thread_id, project_path, created_at, updated_at)
                       VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(groupId, goal, cwd || '', JSON.stringify(dag || null),
          auto ? 1 : 0, Number(replanDepth) || 0, replanOf || null,
          approvalMode || null, sandboxPolicy || null, threadId || null, projectPath || null, now, now);
      tasks.forEach((t, i) => {
        this.db.prepare(`INSERT INTO sub_tasks
          (task_id, group_id, seq, title, prompt, depends_on, critical, max_retry, timeout_ms, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
          .run(t.id, groupId, i, t.title, t.prompt, JSON.stringify(t.dependsOn || []), t.critical ? 1 : 0, t.maxRetry || 0, t.timeoutMs || 600000);
      });
    });
    tx();
    return this.getGroup(groupId);
  }

  getGroup(groupId) {
    const g = this.db.prepare('SELECT * FROM task_groups WHERE group_id = ?').get(groupId);
    if (!g) return null;
    return { ...g, dag: safeParse(g.dag_json), result: safeParse(g.result_json), tasks: this.listTasks(groupId) };
  }

  listGroups({ limit = 30 } = {}) {
    return this.db.prepare('SELECT * FROM task_groups ORDER BY created_at DESC LIMIT ?').all(limit)
      .map((g) => ({ ...g, dag: safeParse(g.dag_json), result: safeParse(g.result_json) }));
  }

  // R6（2026-10-16，用户实测反馈）：删除任务组——否则终态组永远留在任务面板。
  // fail-closed：running 组不可直接删（先取消/强制关闭，避免账目悬空）；
  // 事务级联清理 side_effects + sub_tasks + 组本体。
  deleteGroup(groupId) {
    const g = this.db.prepare('SELECT status FROM task_groups WHERE group_id = ?').get(groupId);
    if (!g) return { ok: false, error: `任务组不存在：${groupId}` };
    if (g.status === 'running') return { ok: false, error: '任务组正在运行，请先取消再删除' };
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM side_effects WHERE group_id = ?').run(groupId);
      this.db.prepare('DELETE FROM sub_tasks WHERE group_id = ?').run(groupId);
      this.db.prepare('DELETE FROM task_groups WHERE group_id = ?').run(groupId);
    });
    tx();
    return { ok: true };
  }

  setGroupStatus(groupId, status, { error, result } = {}) {
    const g = this.db.prepare('SELECT status FROM task_groups WHERE group_id = ?').get(groupId);
    if (!g) return null;
    if (g.status !== status && !canTransition('group', g.status, status)) {
      throw new Error(`非法组状态迁移：${g.status} → ${status}`);
    }
    this.db.prepare('UPDATE task_groups SET status = ?, error = ?, result_json = ?, updated_at = ? WHERE group_id = ?')
      .run(status, error ?? null, result != null ? JSON.stringify(result) : null, this.now(), groupId);
    return this.getGroup(groupId);
  }

  // ── 任务 ──
  listTasks(groupId) {
    return this.db.prepare('SELECT * FROM sub_tasks WHERE group_id = ? ORDER BY seq ASC').all(groupId)
      .map(rowToTask);
  }

  getTask(groupId, taskId) {
    const r = this.db.prepare('SELECT * FROM sub_tasks WHERE group_id = ? AND task_id = ?').get(groupId, taskId);
    return r ? rowToTask(r) : null;
  }

  // force: 终态强制落位（workerPool.js:382 组收尾场景）——非法迁移但目标是终态
  // （done/failed/skipped）时放行并留痕。此前签名无 force：调用方传了也被忽略，
  // 迁移被拒 → 任务卡在 queued → 组「无待执行任务」判定永不成立 → 界面永久转圈（P0-10）。
  setTaskStatus(groupId, taskId, status, { error, result, workerId, skipRetryCount, force } = {}) {
    const t = this.getTask(groupId, taskId);
    if (!t) throw new Error(`子任务不存在：${groupId}/${taskId}`);
    const transitionLegal = t.status === status || canTransition('task', t.status, status);
    if (!transitionLegal) {
      const terminal = status === 'done' || status === 'failed' || status === 'skipped';
      if (force && terminal) {
        console.warn(`[taskStore] force 强制落位：${t.status} → ${status}（${groupId}/${taskId}）——组收尾需要`);
      } else {
        throw new Error(`非法任务状态迁移：${t.status} → ${status}（${groupId}/${taskId}）`);
      }
    }
    const now = this.now();
    // retry_count 语义 = 自动重试次数：强制关闭（skipRetryCount）不计入
    this.db.prepare(`UPDATE sub_tasks SET status = ?, error = ?, result_json = ?, worker_id = ?,
      retry_count = CASE WHEN ? = 'failed' AND ? = 0 THEN retry_count + 1 ELSE retry_count END,
      started_at = CASE WHEN ? = 'running' THEN ? ELSE started_at END,
      finished_at = CASE WHEN ? IN ('done','failed','skipped') THEN ? ELSE finished_at END
      WHERE group_id = ? AND task_id = ?`)
      .run(status, error ?? null, result != null ? JSON.stringify(result) : null, workerId ?? null,
        status, skipRetryCount ? 1 : 0, status, now, status, now, groupId, taskId);
    this.touchGroup(groupId);
    return this.getTask(groupId, taskId);
  }

  // 入队：pending 且全部依赖已 done 的任务 → queued
  enqueueReady(groupId) {
    const tasks = this.listTasks(groupId);
    const doneIds = new Set(tasks.filter((t) => t.status === 'done' || t.status === 'skipped').map((t) => t.taskId));
    const ready = tasks.filter((t) => t.status === 'pending' && t.dependsOn.every((d) => doneIds.has(d)));
    for (const t of ready) this.setTaskStatus(groupId, t.taskId, 'queued');
    return ready.map((t) => t.taskId);
  }

  // 领取一个 queued 任务（占位 running，带 workerId）——由 WorkerPool 循环调用
  claimNext(groupId, workerId) {
    const row = this.db.prepare(`SELECT task_id FROM sub_tasks
      WHERE group_id = ? AND status = 'queued' ORDER BY seq ASC LIMIT 1`).get(groupId);
    if (!row) return null;
    return this.setTaskStatus(groupId, row.task_id, 'running', { workerId });
  }

  // 失败处置：可重试 → 回 queued；不可重试 → failed（调用方决定组级动作）
  // result：部分结果（如 Agent 未完成收尾时已有的产出摘要），失败也保留供 UI/重规划参考
  // P1-13：自动重试前查副作用核对闸（hasPriorUncertainEffects）——账本里残留更早运行的
  // uncertain 记录（崩溃/强杀恢复）时，自动回 queued 会重复执行同一批写操作/发请求。
  // 此时置 failed 并在错误信息中说明核对入口，重试交人工触发（IPC 层带 confirmReview）。
  handleFailure(groupId, taskId, errorMsg, result) {
    const t = this.getTask(groupId, taskId);
    this.setTaskStatus(groupId, taskId, 'failed', { error: errorMsg, result: result || null });
    if (t.retryCount < t.maxRetry) {
      if (this.hasPriorUncertainEffects(groupId, taskId)) {
        console.warn(`[taskStore] 任务 ${groupId}/${taskId} 自动重试被副作用核对闸拦截（残留更早运行的 uncertain 账本），置 failed 待人工重试`);
        this.setTaskStatus(groupId, taskId, 'failed', {
          error: `${errorMsg}；检测到上次未确认的副作用记录，自动重试已拦截——请先核对副作用后手动重试`,
          result: result || null, force: true,
        });
        return { retried: false, blockedByReview: true };
      }
      this.setTaskStatus(groupId, taskId, 'queued');
      return { retried: true };
    }
    return { retried: false };
  }

  // 组是否已无待执行任务（收尾判定）
  isGroupSettled(groupId) {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM sub_tasks
      WHERE group_id = ? AND status IN ('pending','queued','running')`).get(groupId);
    return row.n === 0;
  }

  groupHasBlockingFailure(groupId) {
    const tasks = this.listTasks(groupId);
    const byId = new Map(tasks.map((t) => [t.taskId, t]));
    // 关键任务失败，且任何「未完结」任务（直接或传递）依赖它 → 阻塞，组需要暂停
    const unfinished = (t) => !['done', 'failed', 'skipped'].includes(t.status);
    return tasks
      .filter((t) => t.status === 'failed' && t.critical)
      .some((failed) => tasks.some((x) => x.taskId !== failed.taskId && unfinished(x)
        && dependsTransitively(byId, x, failed.taskId, new Set())));
  }

  // 崩溃恢复：running → queued（Electron 重启后 WorkerPool 重新领取）
  // V14（2026-10-16，方案 §11 / R4-N5）：重启恢复**不再盲目重放**。
  // 原实现 running → queued 直接回队 + 组自动续跑——被中断任务可能已完成部分副作用
  //（写文件/发请求/安装包），重放 = 同一操作执行两次且用户不知情；副作用账本
  //（pending/committed/uncertain）就位前，执行状态不可确认的任务一律不自动重放（fail-closed）。
  // 现契约：running → failed（needsReview：中断原因写入 error，不消耗自动重试次数）；
  //         运行中的组 → paused（等待用户人工核对后手动续跑）；
  //         queued 保持原状（从未启动，无副作用，无风险）。
  recoverInterrupted() {
    const now = this.now();
    const interrupted = this.db.prepare(`SELECT group_id, task_id FROM sub_tasks WHERE status = 'running'`).all();
    const runningGroups = this.db.prepare(`SELECT group_id FROM task_groups WHERE status = 'running'`).all();
    const tx = this.db.transaction(() => {
      for (const r of interrupted) {
        this.db.prepare(`UPDATE sub_tasks SET status = 'failed',
          error = ?, result_json = ?, worker_id = NULL, finished_at = ?
          WHERE group_id = ? AND task_id = ?`)
          .run('应用重启导致执行中断（不自动重放：已执行的副作用无法确认，请人工核对后重试）',
            JSON.stringify({ needsReview: true, interruptedByRestart: true }),
            now, r.group_id, r.task_id);
      }
      for (const g of runningGroups) {
        this.db.prepare(`UPDATE task_groups SET status = 'paused', updated_at = ? WHERE group_id = ?`).run(now, g.group_id);
      }
    });
    tx();
    return {
      recoveredTasks: interrupted.map((r) => ({ groupId: r.group_id, taskId: r.task_id })),
      pausedGroups: runningGroups.map((g) => g.group_id),
    };
  }

  // ── 副作用账本（N5，方案 §11）──
  // V14「不自动重放」的可审计地基：Worker 领取任务即记 uncertain（可能产生副作用），
  // 任务终态时 resolved。重启恢复时 uncertain 记录原样保留——它们正是「副作用无法确认」
  // 的清单，随 needsReview 一起供人工核对（UI 消费在 R6 编排波次）。
  markEffectUncertain(groupId, taskId) {
    const existing = this.db.prepare('SELECT id FROM side_effects WHERE group_id = ? AND task_id = ?').get(groupId, taskId);
    if (existing) {
      // 重试重新领取：回到 uncertain（resolved_at 清空）
      this.db.prepare(`UPDATE side_effects SET state = 'uncertain', resolved_at = NULL WHERE id = ?`).run(existing.id);
      return;
    }
    this.db.prepare('INSERT INTO side_effects (group_id, task_id, state, created_at) VALUES (?, ?, ?, ?)')
      .run(groupId, taskId, 'uncertain', this.now());
  }

  resolveEffect(groupId, taskId) {
    this.db.prepare(`UPDATE side_effects SET state = 'resolved', resolved_at = ? WHERE group_id = ? AND task_id = ?`)
      .run(this.now(), groupId, taskId);
  }

  // 组内副作用仍为 uncertain 的任务清单（needsReview 人工核对的输入）
  listUncertainEffects(groupId) {
    return this.db.prepare(`SELECT task_id FROM side_effects WHERE group_id = ? AND state = 'uncertain'`).all(groupId).map((r) => r.task_id);
  }

  // P1-13：是否存在「早于最近一次领取」的未闭合副作用记录。
  // 正常运行到达终态时账本会被 resolveEffect 闭合；残留的更早记录只可能来自
  // 崩溃/强杀恢复（那次运行没走到终态，副作用是否落盘不可知）。自动重试前必须人工核对，
  // 否则重复执行同一批写操作/发请求（重复 pr / 重复转账类事故面）。
  // 注意不能用 needsRetryReview（它把**本次领取**刚记的 uncertain 也算进去——
  // 每次失败都会命中，自动重试功能整体失效）。
  hasPriorUncertainEffects(groupId, taskId) {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM side_effects
      WHERE group_id = ? AND task_id = ? AND state = 'uncertain'
      AND created_at < (SELECT MAX(created_at) FROM side_effects WHERE group_id = ? AND task_id = ?)`)
      .get(groupId, taskId, groupId, taskId);
    return (row?.n || 0) > 0;
  }

  // A5（2026-10-16）：重试前置核对的判定——纯查询，供 IPC 层与测试共用。
  // 语义：该任务上次运行留下了「副作用无法确认」的记录（可能已写文件/已发请求），
  // 且调用方尚未显式确认（confirmReview !== true）→ 必须先核对再重试，避免重复执行同一批操作。
  // 提取为方法而非内联在 IPC handler 里，是为了让它可被单测直接驱动（handler 依赖 electron，不可单测）。
  needsRetryReview(groupId, taskId, confirmReview = false) {
    if (confirmReview === true) return false;
    return this.listUncertainEffects(groupId).includes(taskId);
  }

  touchGroup(groupId) {
    this.db.prepare('UPDATE task_groups SET updated_at = ? WHERE group_id = ?').run(this.now(), groupId);
  }
}

function dependsTransitively(byId, task, targetId, visiting) {
  if (visiting.has(task.taskId)) return false;
  visiting.add(task.taskId);
  for (const d of task.dependsOn) {
    if (d === targetId) return true;
    const dep = byId.get(d);
    if (dep && dependsTransitively(byId, dep, targetId, visiting)) return true;
  }
  return false;
}

function rowToTask(r) {
  return {
    taskId: r.task_id, groupId: r.group_id, seq: r.seq, title: r.title, prompt: r.prompt,
    dependsOn: safeParse(r.depends_on) || [], critical: !!r.critical,
    maxRetry: r.max_retry, timeoutMs: r.timeout_ms, status: r.status, retryCount: r.retry_count,
    result: safeParse(r.result_json), error: r.error, workerId: r.worker_id,
    startedAt: r.started_at, finishedAt: r.finished_at,
  };
}

function safeParse(s) {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return null; }
}

module.exports = { TaskStore, canTransition, TASK_TRANSITIONS, GROUP_TRANSITIONS };
