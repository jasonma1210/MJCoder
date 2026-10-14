// 协同 CRDT 核心层：会话线程 / 任务看板 / 审批实例的文档结构与合并语义
//
// 范围边界（不可动摇）：代码协同归 git，本模块只协同「AI 会话线程 / 任务看板 / 审批流」。
// 文档按业务实体分片：一个会话线程一个 doc，一个看板一个 doc，一个审批实例一个 doc，避免大文档。
//
// 纯 Yjs 实现，不触碰数据库，因此可单测、可在桌面端本地先行运行。
const Y = require('yjs');

// ── 文档类型与分片 ID ───────────────────────────────────────
const DOC_TYPES = { THREAD: 'thread', BOARD: 'board', APPROVAL: 'approval' };

// 归一化类型：同时接受枚举键（THREAD）与枚举值（thread）
function normalizeType(type) {
  const t = String(type || '').trim();
  const hit = Object.keys(DOC_TYPES).find(k => k === t.toUpperCase() || DOC_TYPES[k] === t.toLowerCase());
  return hit ? DOC_TYPES[hit] : null;
}

function makeDocId(type, entityId) {
  const t = normalizeType(type);
  if (!t) throw new Error(`未知的协同文档类型：${type}`);
  const id = String(entityId || '').trim();
  if (!id) throw new Error('协同文档实体 ID 不能为空');
  return `${t}:${id}`;
}

function parseDocId(docId) {
  const idx = String(docId).indexOf(':');
  if (idx <= 0) throw new Error(`协同文档 ID 格式非法：${docId}`);
  const type = normalizeType(String(docId).slice(0, idx));
  if (!type) throw new Error(`未知的协同文档类型：${String(docId).slice(0, idx)}`);
  return { type, entityId: String(docId).slice(idx + 1) };
}

// ── 二进制与 JSON 互转（HTTP 传输用）─────────────────────────
function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(b64) {
  return new Uint8Array(Buffer.from(String(b64 || ''), 'base64'));
}

// ── 文档骨架 ───────────────────────────────────────────────
// thread doc：messages（消息体 Y.Map，text 为 Y.Text）/ stateLog + state（业务层 LWW）/ tombstones
// board  doc：cards（卡片 Y.Map）/ stateLog + state（卡片位置走 LWW）/ tombstones
// approval doc：approvalActions（按 approvalId#decision 幂等去重索引）
//                / approvalLog（原始动作流水）/ tombstones
function createDoc(docId) {
  const { type } = parseDocId(docId);
  const doc = new Y.Doc();
  doc.getMap('meta').set('docId', docId);
  doc.getMap('meta').set('type', type);
  doc.getMap('meta').set('createdAt', Date.now());
  return doc;
}

function meta(doc) {
  const m = doc.getMap('meta');
  return { docId: m.get('docId'), type: m.get('type'), createdAt: m.get('createdAt') };
}

// ── 会话消息：消息体用 Y.Map，正文用 Y.Text ─────────────────
// 同一条消息被两端并发编辑时，Y.Text 按字符级 CRDT 自动合并且不产生重复。
function appendMessage(doc, { id, role, text, actor, ts }) {
  const msgId = String(id || '').trim();
  if (!msgId) throw new Error('消息 ID 不能为空');
  const messages = doc.getMap('messages');
  if (messages.has(msgId)) throw new Error(`消息已存在：${msgId}`);
  const body = new Y.Text();
  const msg = new Y.Map();
  msg.set('id', msgId);
  msg.set('role', String(role || 'assistant'));
  msg.set('actor', String(actor || 'unknown'));
  msg.set('ts', Number(ts) || Date.now());
  msg.set('deleted', false);
  msg.set('text', body);
  messages.set(msgId, msg);
  if (text) body.insert(0, String(text));
  return msgId;
}

function hasMessage(doc, id) {
  return doc.getMap('messages').has(String(id));
}

// 编辑消息正文；返回是否为 tombstone（已删除消息不接受正文编辑）
function editMessageText(doc, id, patch) {
  const msg = doc.getMap('messages').get(String(id));
  if (!msg) return { ok: false, error: `消息不存在：${id}` };
  if (msg.get('deleted') === true) return { ok: false, error: `消息已删除，拒绝编辑：${id}` };
  const body = msg.get('text');
  if (!(body instanceof Y.Text)) return { ok: false, error: `消息正文结构异常：${id}` };
  const s = String(patch == null ? '' : patch);
  if (s) body.insert(body.length, s);
  return { ok: true, text: body.toString() };
}

function replaceMessageText(doc, id, next) {
  const msg = doc.getMap('messages').get(String(id));
  if (!msg) return { ok: false, error: `消息不存在：${id}` };
  if (msg.get('deleted') === true) return { ok: false, error: `消息已删除，拒绝编辑：${id}` };
  const body = msg.get('text');
  if (!(body instanceof Y.Text)) return { ok: false, error: `消息正文结构异常：${id}` };
  body.delete(0, body.length);
  body.insert(0, String(next || ''));
  return { ok: true, text: body.toString() };
}

// 读取消息（按 ts + id 稳定排序，跨端结果一致）
function listMessages(doc) {
  const out = [];
  doc.getMap('messages').forEach((msg, id) => {
    const body = msg.get('text');
    out.push({
      id: String(id),
      role: msg.get('role'),
      actor: msg.get('actor'),
      ts: msg.get('ts'),
      deleted: msg.get('deleted') === true,
      text: body instanceof Y.Text ? body.toString() : '',
    });
  });
  out.sort((a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

// 活消息（UI 默认视图，tombstone 被过滤）
function listLiveMessages(doc) {
  return listMessages(doc).filter(m => !m.deleted);
}

// ── 删除语义：tombstone 单调，不做自动复活 ───────────────────
function deleteMessage(doc, id, { actor, ts, reason } = {}) {
  const msgId = String(id);
  const msg = doc.getMap('messages').get(msgId);
  if (!msg) return { ok: false, error: `消息不存在：${msgId}` };
  const t = writeTombstone(doc, 'message', msgId, { actor, ts, reason });
  // 墓碑已存在说明此前已删除过：保持幂等，不刷新元数据
  if (!t.ok) return { ok: false, id: msgId, error: t.error };
  msg.set('deleted', true);
  return { ok: true, id: msgId };
}

// 写入墓碑。墓碑一旦存在就不再被任何并发编辑移除。
function writeTombstone(doc, kind, entityId, { actor, ts, reason } = {}) {
  const store = doc.getMap('tombstones');
  const key = `${kind}:${entityId}`;
  if (store.has(key)) return { ok: false, error: `墓碑已存在：${key}` };
  const rec = new Y.Map();
  rec.set('kind', kind);
  rec.set('entityId', String(entityId));
  rec.set('actor', String(actor || 'unknown'));
  rec.set('ts', Number(ts) || Date.now());
  rec.set('reason', String(reason || ''));
  store.set(key, rec);
  return { ok: true, key };
}

function listTombstones(doc) {
  const out = [];
  doc.getMap('tombstones').forEach((rec, key) => {
    out.push({
      key: String(key),
      kind: rec.get('kind'),
      entityId: rec.get('entityId'),
      actor: rec.get('actor'),
      ts: rec.get('ts'),
      reason: rec.get('reason'),
    });
  });
  out.sort((a, b) => (a.ts - b.ts) || (a.key < b.key ? -1 : 1));
  return out;
}

// ── 状态字段：CRDT 保底 + 业务层 last-writer-wins ─────────────
//
// 实现要点：状态写入不是直接覆盖 Y.Map，而是把每次写入追加进 stateLog（Y.Array），
// 读时按 (ts, actor) 做业务层 LWW 归约。Y.Array 合并后各端顺序确定，
// 因此归约结果在所有端一致，且不受各端本地时钟先后到达顺序影响。
function writeState(doc, key, value, { actor, ts } = {}) {
  const k = String(key || '').trim();
  if (!k) throw new Error('状态字段名不能为空');
  const entry = new Y.Map();
  entry.set('key', k);
  entry.set('value', value === undefined ? null : value);
  entry.set('actor', String(actor || 'unknown'));
  entry.set('ts', Number(ts) || Date.now());
  doc.getArray('stateLog').push([entry]);
  return k;
}

// 业务层 LWW 归约：ts 大者胜；ts 相同则 actor 字典序大者胜（保证跨端确定性）
function resolveState(doc) {
  const winner = new Map();
  doc.getArray('stateLog').forEach((entry) => {
    if (!entry) return;
    const key = entry.get('key');
    if (!key) return;
    const cand = { ts: entry.get('ts') || 0, actor: entry.get('actor') || '', value: entry.get('value') };
    const cur = winner.get(key);
    if (!cur || cand.ts > cur.ts || (cand.ts === cur.ts && cand.actor > cur.actor)) {
      winner.set(key, cand);
    }
  });
  return winner;
}

// 把归约结果物化回 state Y.Map（读快路径；不影响归约真值）
function materializeState(doc) {
  const winner = resolveState(doc);
  const state = doc.getMap('state');
  const keys = new Set();
  state.forEach((_, k) => keys.add(String(k)));
  winner.forEach((v, k) => keys.add(k));
  let changed = false;
  keys.forEach((k) => {
    const w = winner.get(k);
    if (!w) return; // 已被墓碑清除的键不回填
    const cur = state.get(k);
    if (!cur || cur.ts !== w.ts || cur.actor !== w.actor || cur.value !== w.value) {
      state.set(k, { value: w.value, ts: w.ts, actor: w.actor });
      changed = true;
    }
  });
  return { changed, keys: Array.from(winner.keys()) };
}

function getState(doc, key, fallback = null) {
  const w = resolveState(doc).get(String(key));
  return w ? w.value : fallback;
}

function listState(doc) {
  const winner = resolveState(doc);
  const out = {};
  winner.forEach((v, k) => { out[k] = v.value; });
  return out;
}

// ── 任务看板：卡片元数据在 Y.Map，列位置与排序走 LWW ──────────
function upsertCard(doc, { id, title, actor, ts }) {
  const cardId = String(id || '').trim();
  if (!cardId) throw new Error('看板卡片 ID 不能为空');
  const cards = doc.getMap('cards');
  if (!cards.has(cardId)) {
    const card = new Y.Map();
    card.set('id', cardId);
    card.set('title', String(title || ''));
    card.set('createdAt', Number(ts) || Date.now());
    cards.set(cardId, card);
  } else if (title != null) {
    cards.get(cardId).set('title', String(title));
  }
  return cardId;
}

// 移动卡片：列与位置作为状态字段交给业务层 LWW 裁决
function moveCard(doc, id, { column, position, actor, ts }) {
  const cardId = String(id || '').trim();
  if (!cardId) throw new Error('看板卡片 ID 不能为空');
  upsertCard(doc, { id: cardId, title: null, actor, ts });
  return writeState(doc, `card:${cardId}`, { column: String(column || ''), position: Number(position || 0) }, { actor, ts });
}

function deleteCard(doc, id, { actor, ts, reason } = {}) {
  const cardId = String(id);
  if (!doc.getMap('cards').has(cardId)) return { ok: false, error: `看板卡片不存在：${cardId}` };
  const t = writeTombstone(doc, 'card', cardId, { actor, ts, reason });
  if (!t.ok) return { ok: false, id: cardId, error: t.error };
  return { ok: true, id: cardId };
}

function listCards(doc) {
  const winner = resolveState(doc);
  const out = [];
  doc.getMap('cards').forEach((card, id) => {
    const cardId = String(id);
    if (doc.getMap('tombstones').has(`card:${cardId}`)) return;
    const pos = winner.get(`card:${cardId}`);
    out.push({
      id: cardId,
      title: card.get('title'),
      createdAt: card.get('createdAt'),
      column: pos ? pos.value.column : 'backlog',
      position: pos ? pos.value.position : 0,
      ts: pos ? pos.ts : card.get('createdAt'),
      actor: pos ? pos.actor : 'unknown',
    });
  });
  out.sort((a, b) => (a.column < b.column ? -1 : a.column > b.column ? 1 : 0) || (a.position - b.position) || (a.id < b.id ? -1 : 1));
  return out;
}

// ── 共享审批：按 approval-id 幂等去重 ───────────────────────
//
// 两人同时批准同一实例 = 一次审批。
//   approvalLog：原始动作流水，合并后可能同一 approval-id 有多条（各端各提交一次）。
//   approvals  ：幂等索引，只记录该 approval-id「已被记录过」，不作为取值真值。
// 读取时按 approval-id 做业务层 LWW 归约，因此无论多少端并发提交，业务侧始终只看到一次审批。
// 幂等键 = approvalId + decision。
//   同一 approval-id 的同一动作被并发/重复提交（含网络重试），只记一条——
//   这正是「两人同时批准同一实例 = 一次审批」的落点。
//   不同动作（发起 note → 批准 approve → 驳回 deny）属于同一审批实例的不同阶段，各自成键，不会互相吞掉。
function approvalActionKey(approvalId, decision) {
  return `${approvalId}#${decision}`;
}

function newApprovalEntry(fields) {
  const entry = new Y.Map();
  entry.set('approvalId', String(fields.approvalId));
  entry.set('actionKey', approvalActionKey(fields.approvalId, fields.decision));
  entry.set('instanceId', String(fields.instanceId || ''));
  entry.set('decision', String(fields.decision));
  entry.set('note', String(fields.note || ''));
  entry.set('actor', String(fields.actor || 'unknown'));
  entry.set('ts', Number(fields.ts) || Date.now());
  return entry;
}

function recordApproval(doc, { approvalId, decision, note, actor, ts, instanceId }) {
  const id = String(approvalId || '').trim();
  if (!id) throw new Error('审批 ID 不能为空');
  if (!['approve', 'deny', 'note'].includes(String(decision))) {
    throw new Error(`审批动作非法：${decision}（允许 approve / deny / note）`);
  }
  const key = approvalActionKey(id, decision);
  const index = doc.getMap('approvalActions');
  // 该 (approval-id, 动作) 已存在：本地即拦截，不污染流水
  if (index.has(key)) {
    return { ok: true, applied: false, deduped: true, approvalId: id, error: `审批动作已记录，幂等去重：${key}` };
  }
  const fields = { approvalId: id, instanceId, decision, note, actor, ts };
  doc.getArray('approvalLog').push([newApprovalEntry(fields)]);
  index.set(key, newApprovalEntry(fields));
  return { ok: true, applied: true, deduped: false, approvalId: id, error: '' };
}

// 读取审批：每个 approval-id 归约成一条（阶段推进取 ts/actor 最大者），保证业务侧只看到一次审批
function listApprovals(doc) {
  const winner = new Map();
  doc.getArray('approvalLog').forEach((entry) => {
    if (!entry) return;
    const id = entry.get('approvalId');
    if (!id) return;
    const cand = { ts: entry.get('ts') || 0, actor: entry.get('actor') || '', decision: entry.get('decision') };
    const cur = winner.get(id);
    if (!cur || cand.ts > cur.ts || (cand.ts === cur.ts && cand.actor > cur.actor)) winner.set(id, cand);
  });
  const out = [];
  winner.forEach((w, id) => {
    const rec = doc.getMap('approvalActions').get(approvalActionKey(id, w.decision));
    if (!rec) return; // 幂等索引缺失视为非法状态，直接忽略
    out.push({
      approvalId: id,
      instanceId: rec.get('instanceId'),
      decision: rec.get('decision'),
      note: rec.get('note'),
      actor: w.actor,
      ts: w.ts,
    });
  });
  out.sort((a, b) => (a.ts - b.ts) || (a.approvalId < b.approvalId ? -1 : 1));
  return out;
}

// 审批实例的当前阶段：pending（仅发起/备注）/ approved / denied
function approvalStatus(doc, approvalId) {
  const list = approvalId ? listApprovals(doc).filter(a => a.approvalId === approvalId) : listApprovals(doc);
  let pending = false;
  let decided = null;
  for (const a of list) {
    if (a.decision === 'approve') decided = 'approved';
    else if (a.decision === 'deny') decided = 'denied';
    else pending = true;
  }
  if (decided) return decided;
  return pending ? 'pending' : 'none';
}

// 幂等索引中被标记为墓碑的审批实例不再出现在列表里（审批实例被撤回）
function approvalCount(doc, approvalId) {
  const list = listApprovals(doc);
  if (approvalId) return list.filter(a => a.approvalId === approvalId).length;
  return list.length;
}

// ── 合并后归约（tombstone 单调 + LWW 物化）────────────────────
// 每次 applyUpdate 之后都要跑一遍：把墓碑实体强制标记为已删除，
// 保证「删除与编辑并发时删除不被复活」。
function reconcile(doc) {
  let tombstonesApplied = 0;
  const store = doc.getMap('tombstones');
  store.forEach((rec, key) => {
    const kind = rec.get('kind');
    const entityId = String(rec.get('entityId'));
    if (kind === 'message') {
      const msg = doc.getMap('messages').get(entityId);
      if (msg && msg.get('deleted') !== true) {
        msg.set('deleted', true);
        tombstonesApplied += 1;
      }
    } else if (kind === 'card') {
      // 卡片墓碑在列表层过滤，无需改动 Y.Map 本体
      tombstonesApplied += 1;
    }
  });
  const state = materializeState(doc);
  return { tombstonesApplied, stateChanged: state.changed, stateKeys: state.keys };
}

// ── 视图快照（给路由与 UI 用）────────────────────────────────
function snapshotView(doc) {
  const { type } = meta(doc);
  const base = { ...meta(doc), state: listState(doc), tombstones: listTombstones(doc) };
  if (type === DOC_TYPES.THREAD) return { ...base, messages: listMessages(doc), liveMessageCount: listLiveMessages(doc).length };
  if (type === DOC_TYPES.BOARD) return { ...base, cards: listCards(doc) };
  if (type === DOC_TYPES.APPROVAL) return { ...base, approvals: listApprovals(doc) };
  return base;
}

// ── 增量同步原语 ────────────────────────────────────────────
//
// 重要协议约束（y-protocols 的固有语义，非本层缺陷）：
//   encodeUpdate(doc, sv) 产出的差量，只有在接收方「已经拥有 sv 所描述的全部内容」时才可应用。
//   若接收方缺少 sv 中任何一条 struct，Yjs 会静默丢弃该差量（不报错、不部分应用）。
//   因此差量必须基于「对端已确认持有的 stateVector」计算，而非自己的本地 stateVector。
//   客户端（desktop/renderer/src/lib/collab.js）据此维护同步光标 syncedStateVector：
//   推增量基于 syncedStateVector，收增量后把 syncedStateVector 前移到最新 stateVector。
function encodeUpdate(doc, stateVector) {
  return Y.encodeStateAsUpdate(doc, stateVector instanceof Uint8Array ? stateVector : undefined);
}

function encodeStateVector(doc) {
  return Y.encodeStateVector(doc);
}

function applyUpdate(doc, update) {
  if (!update || (update instanceof Uint8Array && update.byteLength === 0)) return false;
  Y.applyUpdate(doc, update instanceof Uint8Array ? update : fromBase64(update));
  return true;
}

// ── 客户端同步光标 ─────────────────────────────────────────
//
// 桌面端（desktop/renderer/src/lib/collab.js）据此实现本地优先同步：
//   1. 首次接触服务端：光标为空 → 推全量 update（否则服务端缺少本端 struct，差量会被静默丢弃）
//   2. 收到回包并 apply 后：用服务端返回的 stateVector 前移光标
//   3. 之后每次联网：基于光标推差量
function createSyncCursor() {
  return { sv: null };
}

function encodePushUpdate(doc, cursor) {
  const base = cursor && cursor.sv ? fromBase64(cursor.sv) : undefined;
  return encodeUpdate(doc, base);
}

function advanceCursor(cursor, stateVectorB64) {
  if (cursor && stateVectorB64) cursor.sv = String(stateVectorB64);
  return cursor;
}

module.exports = {
  Y,
  DOC_TYPES,
  normalizeType,
  makeDocId,
  parseDocId,
  toBase64,
  fromBase64,
  createDoc,
  meta,
  appendMessage,
  hasMessage,
  editMessageText,
  replaceMessageText,
  listMessages,
  listLiveMessages,
  deleteMessage,
  writeTombstone,
  listTombstones,
  writeState,
  resolveState,
  materializeState,
  getState,
  listState,
  upsertCard,
  moveCard,
  deleteCard,
  listCards,
  recordApproval,
  listApprovals,
  approvalStatus,
  approvalCount,
  approvalActionKey,
  reconcile,
  snapshotView,
  encodeUpdate,
  encodeStateVector,
  applyUpdate,
  createSyncCursor,
  encodePushUpdate,
  advanceCursor,
};