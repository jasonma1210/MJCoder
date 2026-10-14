// 定时任务调度引擎：croner 驱动，到点执行任务 prompt（服务端模型直连），落运行历史
const { Cron } = require('croner');
const db = require('../db');
const { runTaskPrompt } = require('./task-runner');
const cloudQueue = require('./cloud/queue');
const { features } = require('../config/features');

const jobs = new Map(); // taskId -> Cron 实例

// 载入全部启用任务并注册调度
async function startScheduler() {
  try {
    const r = await db.query('SELECT * FROM scheduled_tasks WHERE enabled = true');
    for (const task of r.rows) {
      scheduleTask(task);
    }
    console.log(`[scheduler] 已注册 ${jobs.size} 个定时任务`);
  } catch (err) {
    console.error('[scheduler] 启动失败:', err.message);
  }
}

function scheduleTask(task) {
  stopTask(task.id);
  try {
    const job = new Cron(task.schedule, async () => {
      await executeTask(task.id);
    });
    jobs.set(String(task.id), job);
  } catch (err) {
    console.error(`[scheduler] 任务 ${task.id} cron 表达式无效: ${task.schedule}`, err.message);
  }
}

function stopTask(taskId) {
  const key = String(taskId);
  if (jobs.has(key)) {
    jobs.get(key).stop();
    jobs.delete(key);
  }
}

function stopScheduler() {
  for (const job of jobs.values()) job.stop();
  jobs.clear();
}

// 执行单个任务（手动运行与定时触发共用）
async function executeTask(taskId) {
  const r = await db.query('SELECT * FROM scheduled_tasks WHERE id = $1', [taskId]);
  if (r.rows.length === 0) throw new Error('任务不存在');
  const task = r.rows[0];

  // 云端委派任务：异步入队即返回，由云端 worker 单并发消费；M6 起云端委派默认停用
  if (task.execution_mode === 'cloud') {
    if (!features.cloud) {
      console.warn(`[scheduler] 任务 ${taskId}（${task.name}）为云端模式，但云端委派已停用（M6 暂停），本次触发已跳过`);
      return { ok: false, skipped: true, reason: '云端委派已停用' };
    }
    const cloudRun = await db.query(
      `INSERT INTO scheduled_task_runs (task_id, status, state, started_at) VALUES ($1, 'running', 'queued', NOW()) RETURNING id`,
      [taskId]
    );
    await cloudQueue.enqueue(cloudRun.rows[0].id);
    console.log(`[scheduler] 任务 ${taskId}（${task.name}）已入云端队列`);
    return { ok: true, queued: true };
  }

  const runResult = await db.query(
    `INSERT INTO scheduled_task_runs (task_id, status, started_at) VALUES ($1, 'running', NOW()) RETURNING id`,
    [taskId]
  );
  const runId = runResult.rows[0].id;

  try {
    const output = await runTaskPrompt(task);
    await db.query(
      `UPDATE scheduled_task_runs SET status = 'success', finished_at = NOW(), output = $1 WHERE id = $2`,
      [output, runId]
    );
    await db.query(
      `UPDATE scheduled_tasks SET last_run_at = NOW(), last_status = 'success', last_result = $1, updated_at = NOW() WHERE id = $2`,
      [output, taskId]
    );
    console.log(`[scheduler] 任务 ${taskId}（${task.name}）执行成功`);
    return { ok: true, output };
  } catch (err) {
    const message = err.message || '执行失败';
    await db.query(
      `UPDATE scheduled_task_runs SET status = 'failed', finished_at = NOW(), error = $1 WHERE id = $2`,
      [message, runId]
    );
    await db.query(
      `UPDATE scheduled_tasks SET last_run_at = NOW(), last_status = 'failed', last_result = $1, updated_at = NOW() WHERE id = $2`,
      [message, taskId]
    );
    console.error(`[scheduler] 任务 ${taskId}（${task.name}）执行失败:`, message);
    return { ok: false, error: message };
  }
}

module.exports = { startScheduler, stopScheduler, scheduleTask, stopTask, executeTask };
