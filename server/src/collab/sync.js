// 协同同步编排：把 CRDT 原语与 DocStore 组合成桌面端可调用的同步动作
//
// 同步模型（本地优先 + 云端同步）：
//   离线期：本地 Y.Doc 累积 update，UI 直接读本地 doc，完全不依赖网络
//   联网后：push 本地累积 update → 服务端 apply 并落库 → pull 服务端 diff → 本地 apply
// 因为 Yjs update 可交换且幂等，重复 push 同一批 update 不会造成重复内容。
const crdt = require('./crdt');

function toBytes(u) {
  if (!u) return null;
  if (u instanceof Uint8Array) return u;
  return crdt.fromBase64(u);
}

function listUpdates(u) {
  if (!u) return [];
  return Array.isArray(u) ? u.filter(Boolean) : [u];
}

class CollabSync {
  constructor(docStore) {
    this.store = docStore;
  }

  // 打开/创建文档：桌面端进入会话或看板时调用
  async open(docId, type) {
    const { doc } = await this.store.open(docId, type);
    return crdt.snapshotView(doc);
  }

  // 客户端推送本地累积的增量
  async push(docId, type, updates, actor) {
    const bytes = listUpdates(updates).map(toBytes).filter(Boolean);
    const r = await this.store.applyUpdates(docId, type, bytes, actor);
    return { docId, seq: r.seq, applied: r.applied };
  }

  // 客户端按 stateVector 拉取缺失增量（离线端上线后的补齐路径）
  async pull(docId, type, stateVectorB64) {
    const { doc, seq, update } = await this.store.pullUpdates(docId, type, stateVectorB64);
    return {
      docId,
      seq,
      update: crdt.toBase64(update),
      stateVector: crdt.toBase64(crdt.encodeStateVector(doc)),
      view: crdt.snapshotView(doc),
    };
  }

  // 一步到位：推本地增量 + 拉服务端 diff（对齐实施方案的「联网后一次性合并」）
  async sync(docId, type, { updates, stateVector, actor } = {}) {
    const pushed = await this.push(docId, type, updates, actor);
    const pulled = await this.pull(docId, type, stateVector);
    return { ...pulled, pushed: pushed.applied, seq: pulled.seq };
  }

  // ── 会话线程动作 ────────────────────────────────────────
  async appendMessage(docId, msg) {
    const { doc } = await this.store.open(docId, crdt.DOC_TYPES.THREAD);
    crdt.appendMessage(doc, msg);
    return this._flush(docId, crdt.DOC_TYPES.THREAD, { actor: msg.actor });
  }

  async editMessage(docId, msgId, patch) {
    const { doc } = await this.store.open(docId, crdt.DOC_TYPES.THREAD);
    const r = crdt.editMessageText(doc, msgId, patch);
    if (!r.ok) throw new Error(r.error);
    return this._flush(docId, crdt.DOC_TYPES.THREAD, { actor: patch && patch.actor });
  }

  async deleteMessage(docId, msgId, opts = {}) {
    const { doc } = await this.store.open(docId, crdt.DOC_TYPES.THREAD);
    const r = crdt.deleteMessage(doc, msgId, opts);
    if (!r.ok) throw new Error(r.error);
    return this._flush(docId, crdt.DOC_TYPES.THREAD, { actor: opts.actor });
  }

  // ── 任务看板动作 ────────────────────────────────────────
  async upsertCard(docId, card) {
    const { doc } = await this.store.open(docId, crdt.DOC_TYPES.BOARD);
    crdt.upsertCard(doc, card);
    return this._flush(docId, crdt.DOC_TYPES.BOARD, { actor: card && card.actor });
  }

  // 移动卡片：位置走业务层 LWW，并发移动时后写者胜出
  async moveCard(docId, cardId, pos) {
    const { doc } = await this.store.open(docId, crdt.DOC_TYPES.BOARD);
    crdt.moveCard(doc, cardId, pos);
    return this._flush(docId, crdt.DOC_TYPES.BOARD, { actor: pos && pos.actor });
  }

  async deleteCard(docId, cardId, opts = {}) {
    const { doc } = await this.store.open(docId, crdt.DOC_TYPES.BOARD);
    const r = crdt.deleteCard(doc, cardId, opts);
    if (!r.ok) throw new Error(r.error);
    return this._flush(docId, crdt.DOC_TYPES.BOARD, { actor: opts.actor });
  }

  // ── 共享审批动作 ────────────────────────────────────────
  // 幂等：同一 approval-id 重复提交（不论来自同端重试还是另一端并发）只记一次
  async submitApproval(docId, approval) {
    const { doc } = await this.store.open(docId, crdt.DOC_TYPES.APPROVAL);
    const r = crdt.recordApproval(doc, approval);
    const flushed = await this._flush(docId, crdt.DOC_TYPES.APPROVAL, { actor: approval && approval.actor });
    return { ...flushed, applied: r.applied, deduped: r.deduped, approvalId: r.approvalId, note: r.error };
  }

  // ── 通用状态字段（走业务层 LWW）─────────────────────────
  async setState(docId, key, value, opts = {}) {
    const type = crdt.parseDocId(docId).type;
    const { doc } = await this.store.open(docId, type);
    crdt.writeState(doc, key, value, opts);
    return this._flush(docId, type, { actor: opts.actor });
  }

  // 服务端主动动作（发起审批、移动卡片等）的落库出口：
  // 服务端 doc 本身即权威副本，直接固化为快照并清空已折叠的增量日志
  async _flush(docId, type, { actor } = {}) {
    const { doc } = await this.store.open(docId, type);
    crdt.reconcile(doc);
    await this.store.compact(docId, type, { actor });
    return crdt.snapshotView(doc);
  }
}

module.exports = { CollabSync };