// 云端委派路由：创建运行 / 查询状态 / 审批 finalize / 运行列表
const express = require('express');
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const queue = require('../jobs/cloud/queue');
const { finalizeRun } = require('../jobs/cloud/runner');

const router = express.Router();
router.use(authMiddleware);

// 运行摘要：状态 + report/diff 摘要（供 GET 单个与列表复用）
function summarize(row) {
  const report = row.report || {};
  return {
    id: row.id,
    task_id: row.task_id,
    state: row.state,
    status: row.status,
    sandbox_id: row.sandbox_id,
    diff_url: row.diff_url,
    final_text: report.finalText ? String(report.finalText).slice(0, 500) : null,
    error: row.error,
    review_note: report.reviewNote || null,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

// POST /cloud/tasks：{ taskId | objective, repo? } 创建云端运行并入队
router.post('/cloud/tasks', asyncHandler(async (req, res) => {
  const { taskId, objective, repo, container_image } = req.body;
  if (!taskId && !objective) {
    return res.status(400).json({ error: 'taskId 与 objective 至少提供一个' });
  }

  let task;
  if (taskId) {
    const own = await db.query(
      'SELECT * FROM scheduled_tasks WHERE id = $1 AND user_id = $2',
      [taskId, req.userId]
    );
    if (own.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    task = own.rows[0];
  } else {
    // 仅给 objective 时创建一个云端任务行（禁用 cron，仅作云端委派载体）
    const created = await db.query(
      `INSERT INTO scheduled_tasks (user_id, name, prompt, schedule, enabled, execution_mode, container_image)
       VALUES ($1, $2, $3, $4, false, 'cloud', $5) RETURNING *`,
      [req.userId, String(objective).slice(0, 80), objective, '* * * * *', container_image || null]
    );
    task = created.rows[0];
  }

  // 新建运行行并置 queued，附 repo（透传给 agent-core）
  const runResult = await db.query(
    `INSERT INTO scheduled_task_runs (task_id, status, state, started_at, report)
     VALUES ($1, 'running', 'queued', NOW(), $2::jsonb) RETURNING *`,
    [task.id, JSON.stringify(repo ? { repo } : {})]
  );
  const run = runResult.rows[0];
  await queue.enqueue(run.id);
  res.json(summarize(run));
}));

// GET /cloud/tasks：当前用户云端运行列表（最近 50 条）
router.get('/cloud/tasks', asyncHandler(async (req, res) => {
  const r = await db.query(
    `SELECT r.* FROM scheduled_task_runs r
     JOIN scheduled_tasks t ON t.id = r.task_id
     WHERE t.user_id = $1 AND r.state IS NOT NULL
     ORDER BY r.started_at DESC LIMIT 50`,
    [req.userId]
  );
  res.json(r.rows.map(summarize));
}));

// GET /cloud/tasks/:runId：状态 + report/diff 摘要（含归属校验）
router.get('/cloud/tasks/:runId', asyncHandler(async (req, res) => {
  const r = await db.query(
    `SELECT r.* FROM scheduled_task_runs r
     JOIN scheduled_tasks t ON t.id = r.task_id
     WHERE r.id = $1 AND t.user_id = $2`,
    [req.params.runId, req.userId]
  );
  if (r.rows.length === 0) return res.status(404).json({ error: '运行不存在' });
  res.json(summarize(r.rows[0]));
}));

// POST /cloud/tasks/:runId/approve：{ decision: 'approve'|'reject', note? }
router.post('/cloud/tasks/:runId/approve', asyncHandler(async (req, res) => {
  const { decision, note } = req.body;
  if (!['approve', 'reject'].includes(decision)) {
    return res.status(400).json({ error: "decision 必须为 'approve' 或 'reject'" });
  }
  // 归属校验：他人运行一律 404
  const own = await db.query(
    `SELECT r.id FROM scheduled_task_runs r
     JOIN scheduled_tasks t ON t.id = r.task_id
     WHERE r.id = $1 AND t.user_id = $2`,
    [req.params.runId, req.userId]
  );
  if (own.rows.length === 0) return res.status(404).json({ error: '运行不存在' });

  // finalizeRun 对非 review 态抛出带 status 的业务错误，这里按状态码返回
  try {
    const result = await finalizeRun(own.rows[0].id, decision, note);
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
}));

module.exports = router;
