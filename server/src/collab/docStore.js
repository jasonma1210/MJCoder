// 协同文档仓库：Y.Doc 内存缓存 + 快照存储 + update 追加日志
//
// 存储策略（对齐实施方案）：
//   collab_docs      每个 doc 一行，存最新快照（Y.encodeStateAsUpdate）与快照对应的 seq
//   collab_doc_updates 追加日志，存 seq 之后的增量，用于离线端拉取与崩溃恢复
// 客户端离线期产生的 update 先在本地 Y.Doc 累积，联网后一次性 push，服务端 apply 后回推 diff。
//
// 持久化通过 store 适配器注入：生产用 PgStore，测试用 MemoryStore（不依赖 PG）。
const crdt = require('./crdt');
const { Y } = crdt;

// ── 内存适配器：单测与本地单机演示用 ────────────────────────
class MemoryStore {
  constructor() {
    this.docs = new Map(); // docId -> { snapshot: Uint8Array|null, type, seq }
    this.logs = new Map(); // docId -> [{ seq, update }]
  }

  async ensureDoc(docId, type) {
    if (!this.docs.has(docId)) this.docs.set(docId, { snapshot: null, type, seq: 0 });
    return this.docs.get(docId);
  }

  async loadDoc(docId) {
    return this.docs.get(docId) || null;
  }

  async appendUpdates(docId, entries) {
    if (!this.logs.has(docId)) this.logs.set(docId, []);
    const log = this.logs.get(docId);
    for (const e of entries) log.push(e);
    const row = this.docs.get(docId);
    if (row) row.seq = log.length ? log[log.length - 1].seq : row.seq;
    return entries.length;
  }

  async loadUpdates(docId, sinceSeq) {
    const log = this.logs.get(docId) || [];
    return log.filter(e => e.seq > sinceSeq);
  }

  async saveSnapshot(docId, snapshot, seq) {
    const row = this.docs.get(docId);
    if (row) {
      row.snapshot = snapshot;
      row.seq = seq;
    }
  }

  // 压缩：删除已折叠进快照的增量日志
  async compactUpdates(docId, seq) {
    const log = this.logs.get(docId) || [];
    this.logs.set(docId, log.filter(e => e.seq > seq));
  }

  async listDocs() {
    return Array.from(this.docs.entries()).map(([docId, row]) => ({ docId, type: row.type, seq: row.seq }));
  }

  async dropDoc(docId) {
    this.docs.delete(docId);
    this.logs.delete(docId);
  }
}

// ── PostgreSQL 适配器：生产持久化 ────────────────────────────
class PgStore {
  constructor(db) {
    this.db = db;
  }

  async ensureDoc(docId, type) {
    const r = await this.db.query(
      `INSERT INTO collab_docs (doc_id, doc_type, last_seq)
       VALUES ($1, $2, 0)
       ON CONFLICT (doc_id) DO UPDATE SET doc_type = EXCLUDED.doc_type
       RETURNING doc_id, doc_type, last_seq, snapshot`,
      [docId, type]
    );
    return r.rows[0];
  }

  async loadDoc(docId) {
    const r = await this.db.query(
      'SELECT doc_id, doc_type, last_seq, snapshot FROM collab_docs WHERE doc_id = $1',
      [docId]
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    // pg 返回 Buffer；统一为 Uint8Array 供 Yjs 消费
    return {
      docId: row.doc_id,
      type: row.doc_type,
      seq: Number(row.last_seq) || 0,
      snapshot: row.snapshot ? new Uint8Array(row.snapshot) : null,
    };
  }

  async appendUpdates(docId, entries) {
    if (entries.length === 0) return 0;
    // 单事务内批量追加并推进 last_seq，保证 seq 连续且不与快照错位
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      for (const e of entries) {
        await client.query(
          `INSERT INTO collab_doc_updates (doc_id, seq, update_blob, actor)
           VALUES ($1, $2, $3, $4)`,
          [docId, e.seq, Buffer.from(e.update), e.actor || null]
        );
      }
      const last = entries[entries.length - 1].seq;
      await client.query(
        `UPDATE collab_docs SET last_seq = GREATEST(last_seq, $2), updated_at = NOW() WHERE doc_id = $1`,
        [docId, last]
      );
      await client.query('COMMIT');
      return entries.length;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async loadUpdates(docId, sinceSeq) {
    const r = await this.db.query(
      `SELECT seq, update_blob, actor FROM collab_doc_updates
       WHERE doc_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT 2000`,
      [docId, sinceSeq]
    );
    return r.rows.map(row => ({
      seq: Number(row.seq),
      update: new Uint8Array(row.update_blob),
      actor: row.actor,
    }));
  }

  async saveSnapshot(docId, snapshot, seq) {
    await this.db.query(
      `UPDATE collab_docs SET snapshot = $2, last_seq = $3, updated_at = NOW() WHERE doc_id = $1`,
      [docId, Buffer.from(snapshot), seq]
    );
  }

  // 压缩：删除已折叠进快照的增量日志
  async compactUpdates(docId, seq) {
    await this.db.query('DELETE FROM collab_doc_updates WHERE doc_id = $1 AND seq <= $2', [docId, seq]);
  }

  async listDocs() {
    const r = await this.db.query(
      'SELECT doc_id, doc_type, last_seq FROM collab_docs ORDER BY updated_at DESC LIMIT 500'
    );
    return r.rows.map(row => ({ docId: row.doc_id, type: row.doc_type, seq: Number(row.last_seq) }));
  }

  async dropDoc(docId) {
    await this.db.query('DELETE FROM collab_docs WHERE doc_id = $1', [docId]);
  }
}

// ── DocStore：Y.Doc 缓存 + 快照/增量落库 ─────────────────────
class DocStore {
  constructor(store) {
    this.store = store || new MemoryStore();
    this.cache = new Map(); // docId -> { doc, seq }
  }

  // 取（或加载）指定 doc：快照 + 快照之后的增量重放，保证崩溃后可完整恢复
  // 注意 last_seq 是「增量日志已推进到的最大 seq」，不是快照覆盖范围；
  // 快照覆盖范围由 compactUpdates 已删除的日志隐式表达，因此这里一律从 seq 0 重放剩余日志。
  async open(docId, type) {
    const hit = this.cache.get(docId);
    if (hit) return hit;

    const row = await this.store.ensureDoc(docId, type);
    const doc = crdt.createDoc(docId);
    if (row && row.snapshot && row.snapshot.byteLength > 0) {
      Y.applyUpdate(doc, row.snapshot instanceof Uint8Array ? row.snapshot : new Uint8Array(row.snapshot));
    }
    const seq = row ? Number(row.seq) || 0 : 0;
    const pending = await this.store.loadUpdates(docId, 0);
    for (const e of pending) {
      if (e.update && e.update.byteLength > 0) Y.applyUpdate(doc, e.update);
    }
    // 重放后归约一次：日志里的墓碑标记与状态物化在此统一生效
    crdt.reconcile(doc);
    const entry = { doc, seq };
    this.cache.set(docId, entry);
    return entry;
  }

  // 应用一批客户端增量并追加落库（调用方负责传入已 encode 的 update 列表）
  async applyUpdates(docId, type, updates, actor) {
    const { doc, seq } = await this.open(docId, type);
    const entries = [];
    for (const u of updates) {
      const bytes = u instanceof Uint8Array ? u : crdt.fromBase64(u);
      if (!bytes || bytes.byteLength === 0) continue;
      Y.applyUpdate(doc, bytes);
      const next = seq + 1 + entries.length;
      entries.push({ seq: next, update: bytes, actor: actor || null });
    }
    // 合并归约：墓碑单调化 + 状态字段 LWW 物化
    // 归约自身也会产生 update（墓碑标记、状态物化），必须一并落库，
    // 否则崩溃恢复后重放日志会得到未归约的中间态
    const svBeforeReconcile = Y.encodeStateVector(doc);
    crdt.reconcile(doc);
    const reconciled = Y.encodeStateAsUpdate(doc, svBeforeReconcile);
    if (reconciled && reconciled.byteLength > 0) {
      entries.push({ seq: seq + 1 + entries.length, update: reconciled, actor: 'reconcile' });
    }
    if (entries.length > 0) await this.store.appendUpdates(docId, entries);
    this.cache.set(docId, { doc, seq: seq + entries.length });
    return { doc, seq: seq + entries.length, applied: entries.length };
  }

  // 取某客户端缺失的增量（按 stateVector 计算 diff；未给 stateVector 时返回 seq 之后的全部）
  async pullUpdates(docId, type, stateVectorB64) {
    const { doc, seq } = await this.open(docId, type);
    if (!stateVectorB64) {
      const entries = await this.store.loadUpdates(docId, 0);
      return { doc, seq, update: crdt.encodeUpdate(doc) };
    }
    const sv = crdt.fromBase64(stateVectorB64);
    return { doc, seq, update: crdt.encodeUpdate(doc, sv) };
  }

  // 压缩：把内存文档固化为快照，并清掉已折叠进快照的增量日志
  async compact(docId, type) {
    const { doc, seq } = await this.open(docId, type);
    await this.store.saveSnapshot(docId, crdt.encodeUpdate(doc), seq);
    if (typeof this.store.compactUpdates === 'function') await this.store.compactUpdates(docId, seq);
    return { docId, seq };
  }

  async listDocs() {
    return this.store.listDocs();
  }

  async drop(docId) {
    this.cache.delete(docId);
    await this.store.dropDoc(docId);
  }

  // 仅供测试：清空内存缓存，强制下次从持久层重建
  clearCache() {
    this.cache.clear();
  }
}

module.exports = { DocStore, MemoryStore, PgStore };