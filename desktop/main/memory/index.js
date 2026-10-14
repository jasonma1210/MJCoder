// P2-1/P2-2/P2-6：MemoryManager——记忆唯一写入入口（写锁串行）+ 五域 + 四层 Tier + 分层召回
// 域（domain）：private / session / global_knowledge / entity / reflection
// 层（tier）  ：1 原文 / 2 压缩摘要 / 3 长期固化（Tier0 瞬时只在内存，不入库）
// 写入路径收口：渲染层/Worker 不再直写，全部经本模块（主进程单线程 + promise 链串行化）
const crypto = require('crypto');
const { scoreMemory, relevance } = require('./scorer');

class MemoryManager {
  // deps: { db }（better-sqlite3 或 sql.js 适配层）
  constructor({ db }) {
    this.db = db;
    this.writeChain = Promise.resolve(); // 写锁：异步操作（如压缩的 LLM 调用）串行排队
  }

  _id() { return `mem-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`; }
  _now() { return Date.now(); }

  // 串行化入口：所有「可能涉及 LLM 调用」的写操作排进写链，避免并发写脏数据
  _serialized(fn) {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.catch(() => {}); // 链不因单次失败断裂
    return run;
  }

  // ── 写入（Tier1）──
  remember({ spaceId, domain = 'session', content, importance = 0.5, entityTags = [], source = '', summary = null }) {
    const text = String(content || '').trim();
    if (!text) return null;
    const now = this._now();
    const mem = {
      id: this._id(),
      space_id: spaceId || 'default',
      domain: ['private', 'session', 'global_knowledge', 'entity', 'reflection'].includes(domain) ? domain : 'session',
      tier: 1,
      content: text.slice(0, 8000),
      summary: summary ? String(summary).slice(0, 2000) : null,
      importance: Math.max(0, Math.min(1, Number(importance) || 0.5)),
      entity_tags: JSON.stringify(Array.isArray(entityTags) ? entityTags.slice(0, 20) : []),
      expire_at: null,
      is_valid: 1,
      compressed: 0,
      re_hit_count: 0,
      usage_count: 0,
      source: String(source || '').slice(0, 200),
      created_at: now,
      updated_at: now,
    };
    this.db.prepare(`INSERT INTO memories (id, space_id, domain, tier, content, summary, importance, entity_tags,
      expire_at, is_valid, compressed, re_hit_count, usage_count, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(mem.id, mem.space_id, mem.domain, mem.tier, mem.content, mem.summary, mem.importance,
        mem.entity_tags, mem.expire_at, mem.is_valid, mem.compressed, mem.re_hit_count, mem.usage_count,
        mem.source, mem.created_at, mem.updated_at);
    return mem;
  }

  _rowToMemory(r) {
    return r ? {
      id: r.id, spaceId: r.space_id, domain: r.domain, tier: r.tier,
      content: r.content, summary: r.summary, importance: r.importance,
      entityTags: (() => { try { return JSON.parse(r.entity_tags || '[]'); } catch { return []; } })(),
      expireAt: r.expire_at, isValid: !!r.is_valid, compressed: !!r.compressed,
      reHitCount: r.re_hit_count, usageCount: r.usage_count, source: r.source,
      createdAt: r.created_at, updatedAt: r.updated_at,
    } : null;
  }

  get(id) {
    return this._rowToMemory(this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id));
  }

  // ── 分层召回路由（P2-6）──
  // 路由顺序：先 Tier3/Tier2（摘要层，性价比高）→ Tier1（原文）；按六因子 Top-K 重排。
  // query 为空（如启动注入）→ 跳过相关性因子，退化为 importance×recency 排序。
  recall({ spaceId, query = '', topK = 5, domains = null, minScore = 0 }) {
    const space = spaceId || 'default';
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE space_id = ? AND is_valid = 1 AND compressed = 0 ORDER BY tier DESC, updated_at DESC LIMIT 400'
    ).all(space);
    const memories = rows.map((r) => this._rowToMemory(r))
      .filter((m) => !domains || domains.includes(m.domain));
    const scored = memories
      .map((m) => ({ memory: m, score: scoreMemory(m, { query }) }))
      .filter((x) => x.score.total > minScore)
      .sort((a, b) => b.score.total - a.score.total)
      .slice(0, topK);
    // 命中反馈：re_hit_count / usage_count 自增（防抖合并刷盘由 SQLite 同步写承担，量级极小）
    for (const { memory } of scored) {
      this.db.prepare('UPDATE memories SET re_hit_count = re_hit_count + 1, usage_count = usage_count + 1, updated_at = ? WHERE id = ?')
        .run(this._now(), memory.id);
    }
    return scored.map(({ memory, score }) => ({ ...memory, score: Number(score.total.toFixed(4)) }));
  }

  // 注入格式兼容旧链路（renderer 取 content 列表）
  recallContents({ spaceId, query, topK = 5, domains }) {
    return this.recall({ spaceId, query, topK, domains }).map((m) => ({ id: m.id, content: m.summary || m.content }));
  }

  // ── 压缩（P2-4）：同空间同域的未压缩 Tier1 批量合并为 1 条 Tier2 摘要 ──
  // chatOnce 由调用方注入（主进程非流式通道）；返回 { wrote, skipped } 供后台任务记账
  async compress({ spaceId, domain = 'session', batchSize = 10, chatOnce, model }) {
    return this._serialized(async () => {
      const rows = this.db.prepare(`SELECT * FROM memories
        WHERE space_id = ? AND domain = ? AND tier = 1 AND compressed = 0 AND is_valid = 1
        ORDER BY updated_at ASC LIMIT ?`).all(spaceId || 'default', domain, batchSize);
      if (rows.length < 3) return { wrote: 0, skipped: rows.length, reason: '不足一批（<3 条）' };

      let summaryText = '';
      if (chatOnce && model) {
        try {
          const res = await chatOnce({
            ...model,
            messages: [
              { role: 'system', content: '你是记忆压缩器。把多条记忆合并为一条第三人称的结构化摘要（要点式，保留具体路径/命令/结论），不超过 500 字，不要评论。' },
              { role: 'user', content: rows.map((r, i) => `${i + 1}. ${r.content.slice(0, 500)}`).join('\n') },
            ],
          });
          summaryText = String(res?.content || '').trim();
        } catch (e) {
          return { wrote: 0, skipped: rows.length, reason: `压缩调用失败：${e.message}` };
        }
      }
      if (!summaryText) summaryText = rows.map((r) => r.content.slice(0, 120)).join('；').slice(0, 800);

      const now = this._now();
      const maxImportance = Math.max(...rows.map((r) => r.importance || 0));
      const mem = this.remember({
        spaceId, domain,
        content: summaryText,
        summary: summaryText.slice(0, 400),
        importance: Math.min(1, maxImportance + 0.1), // 摘要继承最高重要性并小幅提升
        entityTags: [],
        source: 'compressor',
      });
      // Tier2 落库后：源 Tier1 标记 compressed（保留原文供审计，但召回不再返回）
      this.db.prepare(`UPDATE memories SET tier = 2, compressed = 0, updated_at = ? WHERE id = ?`).run(now, mem.id);
      this.db.prepare(`UPDATE memories SET compressed = 1, updated_at = ? WHERE id IN (${rows.map(() => '?').join(',')})`)
        .run(now, ...rows.map((r) => r.id));
      return { wrote: 1, compressed: rows.length, skipped: 0 };
    });
  }

  // ── 晋升（P3 前置简化版）：高频命中的 Tier2 → Tier3 固化 ──
  promoteByHits(minHits = 3) {
    const rows = this.db.prepare(`SELECT id FROM memories WHERE tier = 2 AND re_hit_count >= ? AND is_valid = 1`).all(minHits);
    for (const r of rows) {
      this.db.prepare('UPDATE memories SET tier = 3, importance = MIN(1, importance + 0.2), updated_at = ? WHERE id = ?')
        .run(this._now(), r.id);
    }
    return rows.length;
  }

  // ── 衰减（P2-3 时间维度的批量执行）：importance 按半衰期衰减，低分失效 ──
  decayJob({ minImportance = 0.05 } = {}) {
    const rows = this.db.prepare('SELECT id, importance, updated_at FROM memories WHERE is_valid = 1 AND tier < 3').all();
    const now = this._now();
    const DAY = 24 * 60 * 60 * 1000;
    let decayed = 0;
    let invalidated = 0;
    for (const r of rows) {
      const days = Math.max(0, (now - r.updated_at) / DAY);
      if (days < 1) continue; // 1 天内不打折
      const next = (r.importance || 0) * Math.pow(0.5, days / 14);
      if (next < minImportance) {
        this.db.prepare('UPDATE memories SET is_valid = 0, updated_at = ? WHERE id = ?').run(now, r.id);
        invalidated += 1;
      } else if (Math.abs(next - r.importance) > 0.01) {
        this.db.prepare('UPDATE memories SET importance = ?, updated_at = ? WHERE id = ?').run(next, now, r.id);
        decayed += 1;
      }
    }
    return { decayed, invalidated };
  }

  // ── 清理：失效且过期的记忆物理删除（防膨胀）──
  cleanupJob({ graceDays = 7 } = {}) {
    const cutoff = this._now() - graceDays * 24 * 60 * 60 * 1000;
    const r1 = this.db.prepare('DELETE FROM memories WHERE is_valid = 0 AND updated_at < ?').run(cutoff);
    const r2 = this.db.prepare('DELETE FROM memories WHERE expire_at IS NOT NULL AND expire_at < ?').run(this._now());
    return { purged: r1.changes + r2.changes };
  }

  // ── 失效（显式：被新事实推翻时）──
  invalidate(id, reason = '') {
    this.db.prepare('UPDATE memories SET is_valid = 0, source = COALESCE(source, \'\') || ?, updated_at = ? WHERE id = ?')
      .run(reason ? `（失效原因：${String(reason).slice(0, 100)}）` : '', this._now(), id);
    return this.get(id);
  }

  // ── 统计（可视化 UI 数据源）──
  stats() {
    const rows = this.db.prepare(`SELECT domain, tier, COUNT(*) AS n FROM memories WHERE is_valid = 1
      GROUP BY domain, tier`).all();
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE is_valid = 1').get().n;
    const bg = this.db.prepare(`SELECT status, COUNT(*) AS n FROM memory_bg_tasks GROUP BY status`).all();
    return { total, byDomainTier: rows, bgTasks: bg };
  }

  // ── 旧 JSON 记忆一次性导入（localStore POC → SQLite）──
  importLegacy(items) {
    let n = 0;
    for (const it of items || []) {
      if (!it?.content) continue;
      this.remember({
        spaceId: it.projectPath || 'default',
        domain: 'global_knowledge',
        content: it.content,
        importance: 0.5,
        source: 'legacy-import',
      });
      n += 1;
    }
    return n;
  }

  // 词法相关性暴露给外部（Worker 注入时按任务标题查询）
  relevanceFor(query, text) { return relevance(query, text); }
}

module.exports = { MemoryManager };
