// 云端任务轻量队列：不引入 Redis，基于 PostgreSQL scheduled_task_runs.state + 内存驱动
// 状态机：queued -> provisioning -> running -> review -> done | failed
const db = require('../../db');

// 单并发 worker：同一时刻只跑一个云端运行
let busy = false;
let started = false;

// review 审批超时定时器（runId -> Timeout）
const reviewTimers = new Map();
const REVIEW_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 小时

// 合法流转表：非法流转一律拒绝
const ALLOWED = {
  queued: ['provisioning'],
  provisioning: ['running', 'failed'],
  running: ['review', 'failed'],
  review: ['done', 'failed'],
};

// 状态流转（CAS 校验）：仅当当前状态为 from 时才落到 to，否则抛错
async function transition(runId, from, to) {
  if (!ALLOWED[from] || !ALLOWED[from].includes(to)) {
    throw new Error(`非法状态流转: ${from} -> ${to}`);
  }
  const r = await db.query(
    `UPDATE scheduled_task_runs SET state = $1 WHERE id = $2 AND state = $3 RETURNING id`,
    [to, runId, from]
  );
  if (r.rows.length === 0) {
    const cur = await db.query('SELECT state FROM scheduled_task_runs WHERE id = $1', [runId]);
    const actual = cur.rows[0] ? cur.rows[0].state : '不存在';
    throw new Error(`非法状态流转: 期望 ${from}，实际 ${actual}，拒绝落到 ${to}`);
  }
  // 进入 review 时挂 24h 审批超时定时器
  if (to === 'review') scheduleReviewTimeout(runId);
  return true;
}

async function getState(runId) {
  const r = await db.query('SELECT state FROM scheduled_task_runs WHERE id = $1', [runId]);
  return r.rows[0] ? r.rows[0].state : null;
}

// 入队：写 state=queued 并触发 worker 拾取（Promise.resolve 让出当前调用栈后立即拾取）
async function enqueue(taskRunId) {
  const r = await db.query(
    `UPDATE scheduled_task_runs SET state = 'queued', started_at = NOW() WHERE id = $1 RETURNING id`,
    [taskRunId]
  );
  if (r.rows.length === 0) throw new Error(`入队失败：运行 ${taskRunId} 不存在`);
  Promise.resolve().then(pickNext).catch(err => {
    console.error('[cloud-queue] 拾取异常:', err.message);
  });
  return true;
}

// 启动 worker：单并发循环，取最旧 queued 运行交给执行器
function startWorker() {
  if (started) return;
  started = true;
  // 服务重启后遗留的 queued 运行也能被重新拾取
  Promise.resolve().then(pickNext).catch(err => {
    console.error('[cloud-queue] 启动拾取异常:', err.message);
  });
}

async function pickNext() {
  if (busy) return;
  busy = true;
  try {
    for (;;) {
      const r = await db.query(
        `SELECT * FROM scheduled_task_runs WHERE state = 'queued' ORDER BY started_at ASC, id ASC LIMIT 1`
      );
      if (r.rows.length === 0) break;
      const run = r.rows[0];
      // 延迟 require 避免 queue <-> runner 循环依赖
      const runner = require('./runner');
      const task = await db.query('SELECT * FROM scheduled_tasks WHERE id = $1', [run.task_id]);
      if (task.rows.length === 0) {
        await transition(run.id, 'queued', 'failed');
        await db.query(
          `UPDATE scheduled_task_runs SET status = 'failed', finished_at = NOW(), error = $1 WHERE id = $2`,
          ['所属任务不存在', run.id]
        );
        continue;
      }
      try {
        await runner.executeCloudTask(task.rows[0], run);
      } catch (err) {
        console.error(`[cloud-queue] 运行 ${run.id} 执行异常:`, err.message);
        // 执行器内部异常兜底：尽量落到 failed（若状态已推进则由其自身负责）
        try {
          const state = await getState(run.id);
          if (state && state !== 'done' && state !== 'failed') {
            await transition(run.id, state, 'failed');
            await db.query(
              `UPDATE scheduled_task_runs SET status = 'failed', finished_at = NOW(), error = $1 WHERE id = $2`,
              [err.message, run.id]
            );
          }
        } catch (e2) {
          console.error(`[cloud-queue] 运行 ${run.id} 兜底失败:`, e2.message);
        }
      }
    }
  } finally {
    busy = false;
  }
  // 执行期间可能有新运行入队，补拾一次
  setImmediate(() => pickNext().catch(() => {}));
}

// review 审批超时：24h 无人审批则自动通过并 finalize（避免运行永久悬挂）
function scheduleReviewTimeout(runId) {
  clearReviewTimer(runId);
  const timer = setTimeout(async () => {
    reviewTimers.delete(runId);
    try {
      const state = await getState(runId);
      if (state !== 'review') return;
      console.log(`[cloud-queue] 运行 ${runId} review 超时 24h，自动通过`);
      const runner = require('./runner');
      await runner.finalizeRun(runId, 'approve', 'review 超时 24h 自动通过');
    } catch (err) {
      console.error(`[cloud-queue] 运行 ${runId} 超时处理异常:`, err.message);
    }
  }, REVIEW_TIMEOUT_MS);
  timer.unref(); // 不阻止进程退出
  reviewTimers.set(runId, timer);
}

function clearReviewTimer(runId) {
  const timer = reviewTimers.get(runId);
  if (timer) {
    clearTimeout(timer);
    reviewTimers.delete(runId);
  }
}

// 测试辅助：重置内部状态
function _resetForTest() {
  busy = false;
  started = false;
  for (const timer of reviewTimers.values()) clearTimeout(timer);
  reviewTimers.clear();
}

module.exports = { enqueue, transition, getState, startWorker, scheduleReviewTimeout, clearReviewTimer, _resetForTest, REVIEW_TIMEOUT_MS };
