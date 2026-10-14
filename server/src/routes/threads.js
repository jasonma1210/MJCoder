const express = require('express');
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const router = express.Router();
router.use(authMiddleware);

// List threads
router.get('/threads', asyncHandler(async (req, res) => {
  const result = await db.query(
    'SELECT t.*, p.name as provider_name, m.model_id as model_name FROM threads t LEFT JOIN model_providers p ON t.provider_id = p.id LEFT JOIN models m ON t.model_id = m.id WHERE t.user_id = $1 AND t.archived = false ORDER BY t.updated_at DESC',
    [req.userId]
  );
  res.json(result.rows);
}));

// Create thread
router.post('/threads', asyncHandler(async (req, res) => {
  const { title, cwd, provider_id, model_id, provider_name, model_name, sandbox_policy, approval_mode } = req.body;
  const result = await db.query(
    `INSERT INTO threads (user_id, title, cwd, provider_id, model_id, provider_name, model_name, sandbox_policy, approval_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'workspace-write'), COALESCE($9, 'on-request')) RETURNING *`,
    [req.userId, title || 'New Chat', cwd || '', provider_id, model_id, provider_name, model_name, sandbox_policy, approval_mode]
  );
  res.json(result.rows[0]);
}));

// Get thread messages（校验线程归属）
router.get('/threads/:id/messages', asyncHandler(async (req, res) => {
  const own = await db.query('SELECT id FROM threads WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  if (own.rows.length === 0) return res.status(404).json({ error: 'Thread not found' });
  const result = await db.query(
    'SELECT * FROM messages WHERE thread_id = $1 ORDER BY created_at ASC',
    [req.params.id]
  );
  res.json(result.rows);
}));

// Add message
router.post('/threads/:id/messages', asyncHandler(async (req, res) => {
  const { role, content, tool_calls, tool_call_id, tokens_input, tokens_output, model_name } = req.body;
  const own = await db.query('SELECT id, title FROM threads WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  if (own.rows.length === 0) return res.status(404).json({ error: 'Thread not found' });
  const result = await db.query(
    'INSERT INTO messages (thread_id, role, content, tool_calls, tool_call_id, tokens_input, tokens_output, model_name) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
    [req.params.id, role, content, JSON.stringify(tool_calls || null), tool_call_id || null, tokens_input || 0, tokens_output || 0, model_name]
  );
  // 标题仅由首条用户消息设定（修复 assistant 内容覆盖标题，P1-6）
  if (role === 'user') {
    await db.query(
      `UPDATE threads SET updated_at = NOW(), title = COALESCE(NULLIF(title, 'New Chat'), $2) WHERE id = $1`,
      [req.params.id, titleFromContent(content)]
    );
  } else {
    await db.query('UPDATE threads SET updated_at = NOW() WHERE id = $1', [req.params.id]);
  }
  res.json(result.rows[0]);
}));

// Rename thread title（A1：服务端此前缺重命名接口）
router.put('/threads/:id/title', asyncHandler(async (req, res) => {
  const title = String(req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: '标题不能为空' });
  const result = await db.query(
    `UPDATE threads SET title = $2, updated_at = NOW() WHERE id = $1 AND user_id = $3 RETURNING id, title`,
    [req.params.id, title.slice(0, 100), req.userId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Thread not found' });
  res.json(result.rows[0]);
}));

// Delete thread
router.delete('/threads/:id', asyncHandler(async (req, res) => {
  await db.query('UPDATE threads SET archived = true WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  res.json({ ok: true });
}));

function titleFromContent(content) {
  if (!content) return 'New Chat';
  return content.slice(0, 60);
}

module.exports = router;
