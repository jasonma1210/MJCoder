// 协同路由：协同文档的读 / 写 / 增量同步 + 团队空间成员
//
// 边界：代码协同归 git，本路由只协同 AI 会话线程、任务看板、审批流。
// 所有 doc 按业务实体分片：thread:<id> / board:<id> / approval:<id>。
const express = require('express');
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const crdt = require('../collab/crdt');
const { DocStore, PgStore } = require('../collab/docStore');
const { CollabSync } = require('../collab/sync');

// 进程内单例：DocStore 持有 Y.Doc 内存缓存，避免每请求重复加载快照
const docStore = new DocStore(new PgStore(db));
const collab = new CollabSync(docStore);

const router = express.Router();
router.use(authMiddleware);

// ── 内部工具 ────────────────────────────────────────────────
// 解析并校验 docId，格式非法直接 400，避免脏 id 进存储层
function readDocId(req) {
  const docId = String(req.params.docId || req.body.doc_id || '');
  try {
    const parsed = crdt.parseDocId(docId);
    return { docId, type: parsed.type };
  } catch (err) {
    return { error: err.message };
  }
}

// 在线成员：按 space 维度维护 last_seen，供团队空间展示
async function touchMember(spaceId, userId, displayName) {
  await db.query(
    `INSERT INTO collab_space_members (space_id, user_id, display_name, last_seen_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (space_id, user_id) DO UPDATE SET last_seen_at = NOW(),
       display_name = COALESCE(EXCLUDED.display_name, collab_space_members.display_name)`,
    [spaceId, userId, displayName || null]
  );
}

// ── 文档读 / 写 / 增量同步 ───────────────────────────────────

// POST /collab/docs/open：{ docId, spaceId?, displayName? } 打开文档，返回视图快照
router.post('/collab/docs/open', asyncHandler(async (req, res) => {
  const docId = String(req.body.doc_id || '');
  let parsed;
  try {
    parsed = crdt.parseDocId(docId);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const view = await collab.open(docId, parsed.type);
  res.json({ doc_id: docId, seq: docStore.cache.get(docId)?.seq || 0, view });
}));

// GET /collab/docs：列出可见的协同文档（团队空间入口用）
router.get('/collab/docs', asyncHandler(async (req, res) => {
  const docs = await docStore.listDocs();
  res.json(docs);
}));

// GET /collab/docs/:docId：读当前视图快照
router.get('/collab/docs/:docId', asyncHandler(async (req, res) => {
  const parsed = readDocId(req);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const view = await collab.open(parsed.docId, parsed.type);
  res.json({ doc_id: parsed.docId, view });
}));

// POST /collab/docs/:docId/sync：{ updates?: string[], stateVector?: string }
// 推本地离线累积的增量，并回推服务端差量（一步完成合并）
router.post('/collab/docs/:docId/sync', asyncHandler(async (req, res) => {
  const parsed = readDocId(req);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { updates, state_vector, actor } = req.body;
  const r = await collab.sync(parsed.docId, parsed.type, {
    updates: Array.isArray(updates) ? updates : (updates ? [updates] : []),
    stateVector: state_vector,
    actor: actor || req.userEmail || `user:${req.userId}`,
  });
  res.json({ doc_id: parsed.docId, ...r });
}));

// POST /collab/docs/:docId/pull：只拉不改（客户端首次上线或重连时用）
router.post('/collab/docs/:docId/pull', asyncHandler(async (req, res) => {
  const parsed = readDocId(req);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const r = await collab.pull(parsed.docId, parsed.type, req.body.state_vector);
  res.json({ doc_id: parsed.docId, ...r });
}));

// POST /collab/docs/:docId/compact：把内存文档固化为快照并清理增量日志
router.post('/collab/docs/:docId/compact', asyncHandler(async (req, res) => {
  const parsed = readDocId(req);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const r = await docStore.compact(parsed.docId, parsed.type);
  res.json({ doc_id: parsed.docId, seq: r.seq });
}));

// ── 会话线程动作 ────────────────────────────────────────────

// POST /collab/docs/:docId/messages：{ id, role, text, actor, ts }
router.post('/collab/docs/:docId/messages', asyncHandler(async (req, res) => {
  const parsed = readDocId(req);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (parsed.type !== crdt.DOC_TYPES.THREAD) return res.status(400).json({ error: '消息追加仅支持 thread 类型文档' });
  const { id, role, text, actor, ts } = req.body;
  if (!id) return res.status(400).json({ error: '消息 ID 必填' });
  let view;
  try {
    view = await collab.appendMessage(parsed.docId, { id, role, text, actor: actor || req.userEmail, ts });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.json({ doc_id: parsed.docId, view });
}));

// POST /collab/docs/:docId/messages/:msgId/delete：写入 tombstone，不做自动复活
router.post('/collab/docs/:docId/messages/:msgId/delete', asyncHandler(async (req, res) => {
  const parsed = readDocId(req);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  let view;
  try {
    view = await collab.deleteMessage(parsed.docId, req.params.msgId, {
      actor: req.body.actor || req.userEmail,
      reason: req.body.reason || '',
      ts: req.body.ts,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.json({ doc_id: parsed.docId, view });
}));

// ── 任务看板动作 ────────────────────────────────────────────

// POST /collab/docs/:docId/cards：{ id, title, actor }
router.post('/collab/docs/:docId/cards', asyncHandler(async (req, res) => {
  const parsed = readDocId(req);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (parsed.type !== crdt.DOC_TYPES.BOARD) return res.status(400).json({ error: '卡片操作仅支持 board 类型文档' });
  const { id, title, actor, ts } = req.body;
  if (!id) return res.status(400).json({ error: '卡片 ID 必填' });
  let view;
  try {
    view = await collab.upsertCard(parsed.docId, { id, title, actor: actor || req.userEmail, ts });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.json({ doc_id: parsed.docId, view });
}));

// POST /collab/docs/:docId/cards/:cardId/move：{ column, position, actor, ts }
// 位置同步走业务层 LWW：并发移动时后写者胜出
router.post('/collab/docs/:docId/cards/:cardId/move', asyncHandler(async (req, res) => {
  const parsed = readDocId(req);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { column, position, actor, ts } = req.body;
  if (!column) return res.status(400).json({ error: '目标列必填' });
  let view;
  try {
    view = await collab.moveCard(parsed.docId, req.params.cardId, { column, position, actor: actor || req.userEmail, ts });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.json({ doc_id: parsed.docId, view });
}));

// POST /collab/docs/:docId/cards/:cardId/delete
router.post('/collab/docs/:docId/cards/:cardId/delete', asyncHandler(async (req, res) => {
  const parsed = readDocId(req);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  let view;
  try {
    view = await collab.deleteCard(parsed.docId, req.params.cardId, {
      actor: req.body.actor || req.userEmail,
      reason: req.body.reason || '',
      ts: req.body.ts,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.json({ doc_id: parsed.docId, view });
}));

// ── 共享审批动作 ────────────────────────────────────────────

// POST /collab/docs/:docId/approvals：{ approval_id, decision, note, actor, instance_id }
// 幂等：同一 approval-id 重复提交只记一次，返回 deduped=true
router.post('/collab/docs/:docId/approvals', asyncHandler(async (req, res) => {
  const parsed = readDocId(req);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (parsed.type !== crdt.DOC_TYPES.APPROVAL) return res.status(400).json({ error: '审批操作仅支持 approval 类型文档' });
  const { approval_id: approvalId, decision, note, actor, ts, instance_id: instanceId } = req.body;
  if (!approvalId) return res.status(400).json({ error: '审批 ID 必填' });
  if (!['approve', 'deny', 'note'].includes(String(decision))) {
    return res.status(400).json({ error: "decision 必须为 'approve'、'deny' 或 'note'" });
  }
  let r;
  try {
    r = await collab.submitApproval(parsed.docId, {
      approvalId, decision, note, instanceId, actor: actor || req.userEmail, ts,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.json({ doc_id: parsed.docId, applied: r.applied, deduped: r.deduped, approval_id: r.approvalId, view: r });
}));

// ── 团队空间成员 ────────────────────────────────────────────

// POST /collab/spaces/:spaceId/presence：上报在线状态（团队空间打开时调用）
router.post('/collab/spaces/:spaceId/presence', asyncHandler(async (req, res) => {
  await touchMember(req.params.spaceId, req.userId, req.body.display_name);
  res.json({ ok: true, space_id: req.params.spaceId });
}));

// GET /collab/spaces/:spaceId/members：在线成员列表
router.get('/collab/spaces/:spaceId/members', asyncHandler(async (req, res) => {
  const r = await db.query(
    `SELECT m.user_id, m.role, m.display_name, m.last_seen_at, u.username, u.email
     FROM collab_space_members m
     LEFT JOIN users u ON u.id = m.user_id
     WHERE m.space_id = $1
     ORDER BY m.last_seen_at DESC LIMIT 100`,
    [req.params.spaceId]
  );
  res.json(r.rows.map(row => ({
    user_id: row.user_id,
    role: row.role,
    display_name: row.display_name || row.username || row.email || `用户 ${row.user_id}`,
    last_seen_at: row.last_seen_at,
  })));
}));

module.exports = router;
module.exports.docStore = docStore;
module.exports.collab = collab;