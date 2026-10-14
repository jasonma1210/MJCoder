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
  createGroup({ groupId, goal, cwd, dag, tasks, auto, replanDepth, replanOf }) {
    const now = this.now();
    const tx = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO task_groups (group_id, goal, cwd, status, dag_json, auto, replan_depth, replan_of, created_at, updated_at)
                       VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?)`)
        .run(groupId, goal, cwd || '', JSON.stringify(dag || null),
          auto ? 1 : 0, Number(replanDepth) || 0, replanOf || null, now, now);
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

  setTaskStatus(groupId, taskId, status, { error, result, workerId, skipRetryCount } = {}) {
    const t = this.getTask(groupId, taskId);
    if (!t) throw new Error(`子任务不存在：${groupId}/${taskId}`);
    if (t.status !== status && !canTransition('task', t.status, status)) {
      throw new Error(`非法任务状态迁移：${t.status} → ${status}（${groupId}/${taskId}）`);
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
  handleFailure(groupId, taskId, errorMsg, result) {
    const t = this.getTask(groupId, taskId);
    this.setTaskStatus(groupId, taskId, 'failed', { error: errorMsg, result: result || null });
    if (t.retryCount < t.maxRetry) {
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
  recoverInterrupted() {
    const rows = this.db.prepare(`UPDATE sub_tasks SET status = 'queued', worker_id = NULL
      WHERE status = 'running'`).run();
    const groups = this.db.prepare(`SELECT group_id FROM task_groups WHERE status = 'running'`).all();
    return { recoveredTasks: rows.changes, runningGroups: groups.map((g) => g.group_id) };
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
