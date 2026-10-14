const express = require('express');
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const router = express.Router();
router.use(authMiddleware);

// 桌面端主进程上报工具执行审计（脱敏后）
router.post('/audit', asyncHandler(async (req, res) => {
  const { action, target, detail, approval_result } = req.body;
  if (!action) return res.status(400).json({ error: 'action required' });
  await db.query(
    'INSERT INTO audit_logs (user_id, action, target, detail, approval_result) VALUES ($1, $2, $3, $4, $5)',
    [req.userId, String(action).slice(0, 100), String(target || '').slice(0, 500), String(detail || '').slice(0, 2000), String(approval_result || '').slice(0, 30)]
  );
  res.json({ ok: true });
}));

// 最近 100 条审计记录
router.get('/audit', asyncHandler(async (req, res) => {
  const r = await db.query(
    'SELECT id, action, target, detail, approval_result, created_at FROM audit_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100',
    [req.userId]
  );
  res.json(r.rows);
}));

module.exports = router;
