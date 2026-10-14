const express = require('express');
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const scheduler = require('../jobs/scheduler');
const router = express.Router();
router.use(authMiddleware);

router.get('/scheduled-tasks', asyncHandler(async (req, res) => {
  const result = await db.query(
    'SELECT * FROM scheduled_tasks WHERE user_id = $1 ORDER BY created_at DESC',
    [req.userId]
  );
  res.json(result.rows);
}));

router.post('/scheduled-tasks', asyncHandler(async (req, res) => {
  const { name, prompt, schedule, thread_id, enabled = true } = req.body;
  if (!name || !prompt || !schedule) {
    return res.status(400).json({ error: 'name, prompt, schedule required' });
  }
  const result = await db.query(
    `INSERT INTO scheduled_tasks (user_id, name, prompt, schedule, thread_id, enabled)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [req.userId, name, prompt, schedule, thread_id || null, enabled]
  );
  const task = result.rows[0];
  if (task.enabled) scheduler.scheduleTask(task);
  res.json(task);
}));

router.put('/scheduled-tasks/:id', asyncHandler(async (req, res) => {
  const { name, prompt, schedule, enabled } = req.body;
  const result = await db.query(
    `UPDATE scheduled_tasks SET name=COALESCE($1,name), prompt=COALESCE($2,prompt), schedule=COALESCE($3,schedule), enabled=COALESCE($4,enabled), updated_at=NOW()
     WHERE id=$5 AND user_id=$6 RETURNING *`,
    [name, prompt, schedule, enabled, req.params.id, req.userId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
  const task = result.rows[0];
  // 调度注册与变更同步
  if (task.enabled) scheduler.scheduleTask(task);
  else scheduler.stopTask(task.id);
  res.json(task);
}));

router.delete('/scheduled-tasks/:id', asyncHandler(async (req, res) => {
  await db.query('DELETE FROM scheduled_tasks WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
  scheduler.stopTask(req.params.id);
  res.json({ ok: true });
}));

// 手动立即运行
router.post('/scheduled-tasks/:id/run', asyncHandler(async (req, res) => {
  const own = await db.query('SELECT id FROM scheduled_tasks WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
  if (own.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
  const result = await scheduler.executeTask(req.params.id);
  if (!result.ok) return res.status(502).json({ error: result.error });
  res.json({ ok: true, output: result.output });
}));

// 运行历史（最近 20 次）
router.get('/scheduled-tasks/:id/runs', asyncHandler(async (req, res) => {
  const own = await db.query('SELECT id FROM scheduled_tasks WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
  if (own.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
  const r = await db.query(
    'SELECT id, status, output, error, started_at, finished_at FROM scheduled_task_runs WHERE task_id=$1 ORDER BY started_at DESC LIMIT 20',
    [req.params.id]
  );
  res.json(r.rows);
}));

module.exports = router;
