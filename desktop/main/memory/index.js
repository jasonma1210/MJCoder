// P2-1/P2-2/P2-6：MemoryManager——记忆唯一写入入口（写锁串行）+ 五域 + 四层 Tier + 分层召回
// 域（domain）：private / session / global_knowledge / entity / reflection
// 层（tier）  ：1 原文 / 2 压缩摘要 / 3 长期固化（Tier0 瞬时只在内存，不入库）
// 写入路径收口：渲染层/Worker 不再直写，全部经本模块（主进程单线程 + promise 链串行化）
//
// P0-2b（2026-10-17 记忆回路修复）：
//   · 写入前置校验：内容归一化（trim/连续空白压缩/大小写折叠）后取 sha1 前 16 位 hash，
//     同 space+domain+hash 已存在则刷新元数据（updated_at/usage_count/source）而非重复 INSERT；
//   · 来源可信度分级（随 source 列持久化，读取时确定性推导，无需新列）：
//       user_input 1.0 > model_conclusion 0.6 > external_content 0.2；
//   · external_content 禁止入 global_knowledge（强制降级 session 域）；未知来源拒绝写入；
//   · content_hash 列由本模块惰性补齐（PRAGMA table_info 探测 + ALTER，幂等）——
//     db/index.js 的迁移链不归本模块维护，故列补齐放在离使用方最近处。
// P0-2c：recallContents 按域 + 可信度过滤——低可信（external_content）条目默认不进
//   system prompt 注入，仅当 query 显式命中（词法相关性 > 0）时按低权重返回
//   （权重 = trust 乘子，体现在 recall 打分）。
// P1-17：分域半衰期（scorer.halfLifeDaysFor）+ 物理删除宽限 7 天 + promoteToLongTerm
//   （global_knowledge 等需人工确认才长期留存：晋升 Tier3 后永不被衰减/清理）。
// P3-3：容量总闸——recall 限量载入 + Top-K 钳制（打分成本由 O(总量) 降为 O(scanLimit)）；
//   单空间写入上限 MAX_MEMORIES_PER_SPACE（先清过期失效行，再按域优先级失效最旧 session 行）。
const crypto = require('crypto');
const { scoreMemory, relevance, halfLifeDaysFor } = require('./scorer');

// ── P0-2b：来源可信度白名单（唯一事实来源）──
// 说明：trust 不单独建列——source 列本就持久化，trust 是 source 的确定性函数，
// 读取时经 trustOf() 推导，避免双列不一致（最小可靠实现）。
const SOURCE_TRUST = {
  user_input: 1.0,        // 用户显式输入/指令（如 /mem）
  model_conclusion: 0.6,  // 模型结论（默认来源；历史无 source 的条目也按此档）
  external_content: 0.2,  // 外部内容（网页/文件/MCP 输出等不可信来源）
  compressor: 0.6,        // 内部压缩产物（LLM 摘要，按模型结论档）
  'legacy-import': 0.6,   // 旧 JSON 记忆导入（源自历史自动写入的模型结论）
};
// 低于该可信度的来源默认不进 system prompt 注入（P0-2c）
const TRUST_THRESHOLD = 0.6;

// ── P3-3：容量总闸常量 ──
const RECALL_SCAN_LIMIT = 200;        // recall 单次最多扫描打分的行数（按 updated_at 取最新窗口）
const RECALL_TOP_K_MAX = 50;          // Top-K 硬上限
const MAX_MEMORIES_PER_SPACE = 500;   // 单空间（项目）记忆总量上限（有效 + 失效）
const DAY_MS = 24 * 60 * 60 * 1000;
const INVALID_GRACE_MS = 7 * DAY_MS;  // 失效行物理删除宽限（P1-17：半衰期 + 7 天）

function trustOf(memory) {
  const s = String(memory?.source || '').trim();
  if (Object.prototype.hasOwnProperty.call(SOURCE_TRUST, s)) return SOURCE_TRUST[s];
  return SOURCE_TRUST.model_conclusion; // 未知来源（含历史 'ipc' 等）按模型结论档：不放大、不误杀
}

// P0-2b：内容归一化——trim + 连续空白压缩为单空格 + 大小写折叠（去重键的计算基础）
function normalizeContent(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// P0-2b：归一化内容的 sha1 十六进制前 16 位
function contentHashOf(normalized) {
  return crypto.createHash('sha1').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

class MemoryManager {
  // deps: { db }（better-sqlite3 或 sql.js 适配层）
  constructor({ db }) {
    this.db = db;
    this.writeChain = Promise.resolve(); // 写锁：异步操作（如压缩的 LLM 调用）串行排队
    this._ensureHashColumn();
  }

  _id() { return `mem-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`; }
  _now() { return Date.now(); }

  // P0-2b：content_hash 列惰性补齐（幂等）。
  // 为什么不进 db/index.js 迁移链：该文件的迁移由任务编排底座统一维护，本模块只做
  // 「使用前确保列存在」的自包含补齐；两个驱动（better-sqlite3 / sql.js 适配层）
  // 均支持 PRAGMA table_info 与 ALTER TABLE。
  _ensureHashColumn() {
    try {
      const cols = this.db.prepare('PRAGMA table_info(memories)').all();
      if (!cols.some((c) => c.name === 'content_hash')) {
        this.db.exec('ALTER TABLE memories ADD COLUMN content_hash TEXT');
        console.log('[memory] 已补齐 memories.content_hash 列（P0-2b 去重键）');
      }
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(space_id, domain, content_hash)');
    } catch (e) {
      // 补齐失败不阻断启动：去重退化为「同内容可重复插入」，召回过滤等其余能力不受影响
      console.warn('[memory] content_hash 列补齐失败（去重降级）：', e.message);
    }
  }

  // 串行化入口：所有「可能涉及 LLM 调用」的写操作排进写链，避免并发写脏数据
  _serialized(fn) {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.catch(() => {}); // 链不因单次失败断裂
    return run;
  }

  // ── 写入（Tier1）──
  remember({ spaceId, domain = 'session', content, importance = 0.5, entityTags = [], source = '', summary = null }) {
    // P0-2b：来源白名单校验——未知来源拒绝写入并返回 null（调用方据此报错），
    // 不静默按模型结论档收留（那会让不可控来源混入长期记忆）
    const src = String(source || '').trim() || 'model_conclusion';
    if (!Object.prototype.hasOwnProperty.call(SOURCE_TRUST, src)) {
      console.warn(`[memory] 拒绝写入：未知来源「${src}」（白名单：${Object.keys(SOURCE_TRUST).join(' / ')}）`);
      return null;
    }
    const text = String(content || '').trim();
    if (!text) return null;
    let dom = ['private', 'session', 'global_knowledge', 'entity', 'reflection'].includes(domain) ? domain : 'session';
    // P0-2b：external_content 禁止入 global_knowledge——强制降级 session 域
    // （不可信内容不配进「长期知识域」，从入口切断污染正反馈）
    if (src === 'external_content' && dom === 'global_knowledge') {
      console.warn('[memory] external_content 来源禁止入 global_knowledge，已降级为 session 域');
      dom = 'session';
    }
    const now = this._now();
    const space = spaceId || 'default';
    const hash = contentHashOf(normalizeContent(text));
    // P0-2b：hash 去重——同 space+domain+hash 已存在则刷新元数据，不重复 INSERT。
    // re_hit_count 不在此刷新：它只由召回命中驱动（recall），重复写入刷高会误触发
    // promoteByHits 的「高频晋升」，把一次性重复当成多次使用。
    const dup = this.db.prepare('SELECT * FROM memories WHERE space_id = ? AND domain = ? AND content_hash = ? LIMIT 1')
      .get(space, dom, hash);
    if (dup) {
      this.db.prepare('UPDATE memories SET updated_at = ?, usage_count = usage_count + 1, source = ?, importance = MAX(importance, ?) WHERE id = ?')
        .run(now, src, Math.max(0, Math.min(1, Number(importance) || 0.5)), dup.id);
      return this.get(dup.id);
    }
    const mem = {
      id: this._id(),
      space_id: space,
      domain: dom,
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
      source: src,
      created_at: now,
      updated_at: now,
      trust: trustOf({ source: src }), // 返回值与 _rowToMemory 输出同构（含可信度）
    };
    this.db.prepare(`INSERT INTO memories (id, space_id, domain, tier, content, summary, importance, entity_tags,
      expire_at, is_valid, compressed, re_hit_count, usage_count, source, created_at, updated_at, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(mem.id, mem.space_id, mem.domain, mem.tier, mem.content, mem.summary, mem.importance,
        mem.entity_tags, mem.expire_at, mem.is_valid, mem.compressed, mem.re_hit_count, mem.usage_count,
        mem.source, mem.created_at, mem.updated_at, hash);
    this._enforceSpaceCap(space); // P3-3：容量总闸（写入侧）
    return mem;
  }

  // P3-3：单空间容量总闸——总量超 MAX_MEMORIES_PER_SPACE 时：
  //   ① 先物理删除已失效且过宽限期的行（与 cleanupJob 同口径）；
  //   ② 仍超限则物理删除最旧的 session 域行（session 是瞬时域，优先淘汰；
  //      硬总闸必须硬删除——只置 is_valid=0 不缩表，闸门永远合不拢）；
  //   global_knowledge / entity / reflection 受保护——那是用户显式确认的知识资产，
  //   宁可超限也不自动删（超限时由上方统计与 UI 暴露，交用户处理）。
  _enforceSpaceCap(spaceId) {
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE space_id = ?').get(spaceId).n;
    if (total <= MAX_MEMORIES_PER_SPACE) return 0;
    let removed = 0;
    const stale = this.db.prepare('DELETE FROM memories WHERE space_id = ? AND is_valid = 0 AND updated_at < ?')
      .run(spaceId, this._now() - INVALID_GRACE_MS);
    removed += stale.changes || 0;
    const still = this.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE space_id = ?').get(spaceId).n - MAX_MEMORIES_PER_SPACE;
    if (still > 0) {
      const victims = this.db.prepare(`SELECT id FROM memories WHERE space_id = ? AND domain = 'session'
        ORDER BY updated_at ASC LIMIT ?`).all(spaceId, still);
      for (const v of victims) {
        this.db.prepare('DELETE FROM memories WHERE id = ?').run(v.id);
        removed += 1;
      }
      if (victims.length) {
        console.warn(`[memory] 空间 ${spaceId} 超容量总闸（${MAX_MEMORIES_PER_SPACE} 条），物理淘汰最旧 session 记忆 ${victims.length} 条`);
      }
    }
    return removed;
  }

  _rowToMemory(r) {
    return r ? {
      id: r.id, spaceId: r.space_id, domain: r.domain, tier: r.tier,
      content: r.content, summary: r.summary, importance: r.importance,
      entityTags: (() => { try { return JSON.parse(r.entity_tags || '[]'); } catch { return []; } })(),
      expireAt: r.expire_at, isValid: !!r.is_valid, compressed: !!r.compressed,
      reHitCount: r.re_hit_count, usageCount: r.usage_count, source: r.source,
      trust: trustOf(r), // P0-2b：可信度随条目输出（由 source 推导）
      createdAt: r.created_at, updatedAt: r.updated_at,
    } : null;
  }

  get(id) {
    return this._rowToMemory(this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id));
  }

  // ── 分层召回路由（P2-6）──
  // 路由顺序：先 Tier3/Tier2（摘要层，性价比高）→ Tier1（原文）；按六因子 Top-K 重排。
  // query 为空（如启动注入）→ 跳过相关性因子，退化为 importance×recency 排序。
  // P3-3：限量载入 + Top-K 钳制——只扫描最近 scanLimit 条进入打分（复杂度 O(scanLimit)，
  // 与记忆总量解耦）；topK 超硬上限时按上限截断。
  recall({ spaceId, query = '', topK = 5, domains = null, minScore = 0, scanLimit = RECALL_SCAN_LIMIT }) {
    const space = spaceId || 'default';
    const k = Math.min(Math.max(1, Number(topK) || 5), RECALL_TOP_K_MAX);
    const scan = Math.min(Math.max(1, Number(scanLimit) || RECALL_SCAN_LIMIT), RECALL_SCAN_LIMIT);
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE space_id = ? AND is_valid = 1 AND compressed = 0 ORDER BY tier DESC, updated_at DESC LIMIT ?'
    ).all(space, scan);
    const memories = rows.map((r) => this._rowToMemory(r))
      .filter((m) => !domains || domains.includes(m.domain));
    const scored = memories
      // P0-2c：可信度乘子——external_content 0.2 / model_conclusion 0.6 / user_input 1.0，
      // 低可信条目即使被返回也排在低权重位置
      .map((m) => ({ memory: m, score: scoreMemory(m, { query }), trust: trustOf(m) }))
      .map((x) => ({ memory: x.memory, score: { ...x.score, total: x.score.total * x.trust } }))
      .filter((x) => x.score.total > minScore)
      .sort((a, b) => b.score.total - a.score.total)
      .slice(0, k);
    // 命中反馈：re_hit_count / usage_count 自增（防抖合并刷盘由 SQLite 同步写承担，量级极小）
    for (const { memory } of scored) {
      this.db.prepare('UPDATE memories SET re_hit_count = re_hit_count + 1, usage_count = usage_count + 1, updated_at = ? WHERE id = ?')
        .run(this._now(), memory.id);
    }
    return scored.map(({ memory, score }) => ({ ...memory, score: Number(score.total.toFixed(4)) }));
  }

  // 注入格式兼容旧链路（renderer 取 content 列表）
  // P0-2c：域 + 可信度过滤——低可信（trust < TRUST_THRESHOLD，即 external_content）条目
  // 默认不进 system prompt 注入；仅当 query 显式命中（词法相关性 > 0）时才返回
  // （打分侧的 trust 乘子保证其权重仍然低）。
  recallContents({ spaceId, query, topK = 5, domains, includeLowTrust = false }) {
    const q = String(query || '').trim();
    const hits = this.recall({ spaceId, query, topK, domains });
    const kept = includeLowTrust
      ? hits
      : hits.filter((m) => trustOf(m) >= TRUST_THRESHOLD
        || (q && relevance(q, `${m.summary || ''}\n${m.content || ''}`) > 0));
    return kept.map((m) => ({ id: m.id, content: m.summary || m.content, domain: m.domain, trust: trustOf(m) }));
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

  // ── P1-17：人工确认长期留存（confirm/promote）──
  // 语义：global_knowledge 等域的半衰期衰减只作用于 tier < 3（见 decayJob）；用户显式
  // 晋升 Tier3 后，该条不再被时间衰减失效，也不再被容量总闸优先淘汰——
  // 「需人工确认才长期留存」的落地口。失效条目不予晋升（先作废再确认没有意义）。
  promoteToLongTerm(id) {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    if (!row || !row.is_valid) return null;
    this.db.prepare('UPDATE memories SET tier = 3, importance = MIN(1, importance + 0.2), expire_at = NULL, updated_at = ? WHERE id = ?')
      .run(this._now(), id);
    return this.get(id);
  }

  // ── 衰减（P2-3 时间维度的批量执行）：importance 按分域半衰期衰减，低分失效 ──
  // P1-17：分域半衰期（session 7 天 / entity 30 天 / global_knowledge 30 天），
  // 把「一条污染记忆约 54 天才物理删除」提速到「半衰期 + 7 天宽限」。
  decayJob({ minImportance = 0.05 } = {}) {
    const rows = this.db.prepare('SELECT id, domain, importance, updated_at FROM memories WHERE is_valid = 1 AND tier < 3').all();
    const now = this._now();
    const DAY = DAY_MS;
    let decayed = 0;
    let invalidated = 0;
    for (const r of rows) {
      const days = Math.max(0, (now - r.updated_at) / DAY);
      if (days < 1) continue; // 1 天内不打折
      const halfLife = halfLifeDaysFor(r.domain); // P1-17：分域半衰期
      const next = (r.importance || 0) * Math.pow(0.5, days / halfLife);
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

  // ── 清理：失效且过宽限期的记忆物理删除（防膨胀）──
  // P1-17：宽限 7 天 = 半衰期衰减到失效后仍留 7 天可人工回看；expire_at 到期的直接删。
  cleanupJob({ graceDays = 7 } = {}) {
    const cutoff = this._now() - graceDays * DAY_MS;
    const r1 = this.db.prepare('DELETE FROM memories WHERE is_valid = 0 AND updated_at < ?').run(cutoff);
    const r2 = this.db.prepare('DELETE FROM memories WHERE expire_at IS NOT NULL AND expire_at < ?').run(this._now());
    return { purged: r1.changes + r2.changes };
  }

  // ── 失效（显式：被新事实推翻时；设置页单条作废也走这里）──
  invalidate(id, reason = '') {
    this.db.prepare('UPDATE memories SET is_valid = 0, source = COALESCE(source, \'\') || ?, updated_at = ? WHERE id = ?')
      .run(reason ? `（失效原因：${String(reason).slice(0, 100)}）` : '', this._now(), id);
    return this.get(id);
  }

  // ── 列表（P0-2c 记忆管理 UI 数据源）：项目维度分页，含可信度/域/层级/有效期 ──
  list({ spaceId, limit = 50, offset = 0, includeInvalid = false } = {}) {
    const lim = Math.min(Math.max(1, Number(limit) || 50), 200);
    const off = Math.max(0, Number(offset) || 0);
    const where = includeInvalid ? 'space_id = ?' : 'space_id = ? AND is_valid = 1';
    const rows = this.db.prepare(`SELECT * FROM memories WHERE ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(spaceId || 'default', lim, off);
    return rows.map((r) => this._rowToMemory(r));
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
  // P1-16：按条目幂等——remember 的 hash 去重保证重复导入只刷新元数据不重复插，
  // 主进程因此可在导入后安全清空 localStore 的 JSON 轨（见 main.js 迁移点）。
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

module.exports = { MemoryManager, SOURCE_TRUST, TRUST_THRESHOLD, normalizeContent, contentHashOf, trustOf };
