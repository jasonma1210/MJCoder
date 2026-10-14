// P2-5：MemoryBgScheduler——记忆后台任务调度器
// 任务队列持久化到 memory_bg_tasks 表（重启恢复：queued 任务继续跑）；
// 60s 轮询驱动，按优先级取任务（1 最高）；前台任务不受阻塞（所有调用均异步且低频）。
// 处理器（文档③第六节裁剪为当前可落地 4 类）：
//   compress  优先级 1  Tier1 批量合并摘要（LLM，经写锁串行）
//   promote   优先级 3  高频 Tier2 → Tier3 固化
//   decay     优先级 4  importance 时间衰减 + 低分失效
//   cleanup   优先级 5  失效/过期记忆物理删除（防膨胀）
//   embed     优先级 2  （预留：embedding 端点配置后启用，未配置直接跳过）
const crypto = require('crypto');

const PROCESSORS = {
  compress: async (payload, deps) => deps.memory.compress({
    spaceId: payload.spaceId,
    domain: payload.domain || 'session',
    batchSize: payload.batchSize || 10,
    chatOnce: deps.chatOnce,
    model: deps.resolveModel?.() || null,
  }),
  promote: async (_payload, deps) => ({ promoted: deps.memory.promoteByHits(3) }),
  decay: async (_payload, deps) => deps.memory.decayJob({}),
  cleanup: async (_payload, deps) => deps.memory.cleanupJob({}),
  embed: async () => ({ skipped: 'embedding 端点未配置（P3 LocalBackend/向量就绪后启用）' }),
};

class MemoryBgScheduler {
  // deps: { db, memory, chatOnce?, resolveModel?, emit? }
  constructor(deps) {
    this.deps = deps;
    this.timer = null;
    this.running = false;
  }

  _id() { return `bg-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`; }

  enqueue(type, payload = {}, { priority = 3 } = {}) {
    const now = Date.now();
    const task = { id: this._id(), type, payload, priority, status: 'queued', attempts: 0, created_at: now, updated_at: now };
    this.deps.db.prepare(`INSERT INTO memory_bg_tasks (id, type, payload, priority, status, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(task.id, task.type, JSON.stringify(task.payload), task.priority, task.status, task.attempts, now, now);
    return task;
  }

  // 周期性自检：自动产生维护任务（compress/decay/cleanup 按需入队，避免空转）
  autoEnqueue({ compressMinBatch = 3 } = {}) {
    const db = this.deps.db;
    const spaces = db.prepare(`SELECT space_id, domain, COUNT(*) AS n FROM memories
      WHERE tier = 1 AND compressed = 0 AND is_valid = 1 GROUP BY space_id, domain`).all();
    let enqueued = 0;
    for (const s of spaces) {
      if (s.n >= compressMinBatch) {
        const dup = db.prepare(`SELECT COUNT(*) AS n FROM memory_bg_tasks
          WHERE type = 'compress' AND status IN ('queued','running') AND payload LIKE ?`).get(`%"spaceId":"${s.space_id}"%`);
        if (!dup.n) { this.enqueue('compress', { spaceId: s.space_id, domain: s.domain }, { priority: 1 }); enqueued += 1; }
      }
    }
    const hasDecay = db.prepare(`SELECT COUNT(*) AS n FROM memory_bg_tasks WHERE type = 'decay' AND status IN ('queued','running')`).get();
    if (!hasDecay.n) { this.enqueue('decay', {}, { priority: 4 }); enqueued += 1; }
    const hasCleanup = db.prepare(`SELECT COUNT(*) AS n FROM memory_bg_tasks WHERE type = 'cleanup' AND status IN ('queued','running')`).get();
    if (!hasCleanup.n) { this.enqueue('cleanup', {}, { priority: 5 }); enqueued += 1; }
    return enqueued;
  }

  // 取一个可执行任务（优先级 1 最高，FIFO 同级）；attempts>=3 直接判死（卡死防线）
  _claim() {
    const dead = this.deps.db.prepare(`UPDATE memory_bg_tasks SET status = 'failed', error = '超过 3 次尝试上限', updated_at = ?
      WHERE status = 'queued' AND attempts >= 3`).run(Date.now());
    if (dead.changes) this.deps.emit?.({ type: 'memory_bg_failed', purged: dead.changes });
    const row = this.deps.db.prepare(`SELECT * FROM memory_bg_tasks WHERE status = 'queued'
      ORDER BY priority ASC, created_at ASC LIMIT 1`).get();
    if (!row) return null;
    this.deps.db.prepare(`UPDATE memory_bg_tasks SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?`)
      .run(Date.now(), row.id);
    return { ...row, payload: (() => { try { return JSON.parse(row.payload || '{}'); } catch { return {}; } })() };
  }

  async runOne() {
    // P3-3 节流联动：bgGate（ResourceQuotaCenter.bgAllowed）返回 false = 前台过载/熔断中，
    // 后台 LLM 作业全部让路（任务留在队列里，下轮再试；不 claim 不消耗 attempts）
    if (typeof this.deps.bgGate === 'function' && !this.deps.bgGate()) return null;
    const task = this._claim();
    if (!task) return null;
    const processor = PROCESSORS[task.type];
    try {
      if (!processor) throw new Error(`未知任务类型：${task.type}`);
      const result = await processor(task.payload, this.deps);
      this.deps.db.prepare(`UPDATE memory_bg_tasks SET status = 'done', error = NULL, updated_at = ? WHERE id = ?`)
        .run(Date.now(), task.id);
      this.deps.emit?.({ type: 'memory_bg_done', taskType: task.type, result });
      return { task, result };
    } catch (e) {
      this.deps.db.prepare(`UPDATE memory_bg_tasks SET status = 'queued', error = ?, updated_at = ? WHERE id = ?`)
        .run(String(e.message || e).slice(0, 300), Date.now(), task.id); // 回队重试（attempts 上限兜底）
      this.deps.emit?.({ type: 'memory_bg_retry', taskType: task.type, error: String(e.message || e) });
      return { task, error: String(e.message || e) };
    }
  }

  async drain(max = 10) {
    const results = [];
    for (let i = 0; i < max; i += 1) {
      const r = await this.runOne();
      if (!r) break;
      results.push(r);
    }
    return results;
  }

  start({ intervalMs = 60 * 1000 } = {}) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return; // 上一轮未完不叠加（防堆积）
      this.running = true;
      (async () => {
        this.autoEnqueue({});
        await this.drain(5);
      })().catch(() => {}).finally(() => { this.running = false; });
    }, intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  listTasks({ limit = 30 } = {}) {
    return this.deps.db.prepare('SELECT * FROM memory_bg_tasks ORDER BY created_at DESC LIMIT ?').all(limit);
  }
}

module.exports = { MemoryBgScheduler, PROCESSORS };
