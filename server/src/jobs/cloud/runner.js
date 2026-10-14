// 云端任务编排：provision -> run -> diff/report 落库 -> review -> 审批 finalize
const db = require('../../db');
const queue = require('./queue');
const { createProvider } = require('./provider');
const { resolveProvider } = require('../task-runner');

// 按 container_image 选择 provider：e2b 前缀走 E2B，其余走本地替身
function pickProvider(task, override) {
  if (override) return override;
  const image = String(task.container_image || '').toLowerCase();
  if (image.startsWith('e2b')) return createProvider('e2b');
  return createProvider('local');
}

// 执行一个云端运行（由队列 worker 或测试直连调用）
// task: scheduled_tasks 行；run: scheduled_task_runs 行
// opts.provider 可注入确定性假 provider（测试用）
async function executeCloudTask(task, run, opts = {}) {
  const runId = run.id;

  // 1. provisioning：创建沙箱并登记 sandbox_id
  await queue.transition(runId, 'queued', 'provisioning');
  const provider = pickProvider(task, opts.provider);
  const sandbox = await provider.provision({ ...task, objective: task.prompt });
  await db.query('UPDATE scheduled_task_runs SET sandbox_id = $1 WHERE id = $2', [sandbox.sandboxId, runId]);

  try {
    // 2. running：组装任务载荷并执行
    await queue.transition(runId, 'provisioning', 'running');
    // 解密模型凭证（复用 task-runner 的解析链路），契约字段对齐 agent-core cli
    let providerCred = null;
    try {
      const cred = await resolveProvider(task, task.user_id);
      providerCred = {
        id: task.thread_id || 'default',
        base_url: cred.base_url,
        model_id: cred.model,
        api_key: cred.api_key,
      };
    } catch (err) {
      // 无可用模型凭证：直接失败（本地 provider 也会以 report.ok=false 收敛）
      await failRun(runId, `模型凭证解析失败: ${err.message}`);
      return { ok: false, error: err.message };
    }

    const payload = {
      objective: task.prompt,
      repo: (run.report && run.report.repo) || null,
      provider: providerCred,
      cwd: sandbox.workdir,
      maxRounds: 20,
    };
    const result = await provider.run(sandbox, payload);

    // 3. 落库 diff/report；diff 为 URL 时同时写入 diff_url
    const prevReport = run.report || {};
    const report = { ...prevReport, ...(result.report || {}) };
    const diffUrl = typeof result.diff === 'string' && /^https?:\/\//.test(result.diff) ? result.diff : null;
    await db.query(
      `UPDATE scheduled_task_runs SET report = $1::jsonb, diff_url = COALESCE($2, diff_url) WHERE id = $3`,
      [JSON.stringify(report), diffUrl, runId]
    );

    // 4. 状态推进：成功进 review 等审批，失败直接落 failed
    if (result.ok) {
      await queue.transition(runId, 'running', 'review');
      return { ok: true, state: 'review' };
    }
    await failRun(runId, (result.report && result.report.error) || '云端执行失败');
    return { ok: false, error: report.error || '云端执行失败' };
  } finally {
    await provider.destroy(sandbox).catch(() => {});
  }
}

// 失败收敛：running/provisioning -> failed，同步 status/error 与任务侧 last_*
async function failRun(runId, message) {
  const cur = await db.query('SELECT state, task_id FROM scheduled_task_runs WHERE id = $1', [runId]);
  if (cur.rows.length === 0) return;
  const { state, task_id } = cur.rows[0];
  await queue.transition(runId, state, 'failed');
  await db.query(
    `UPDATE scheduled_task_runs SET status = 'failed', finished_at = NOW(), error = $1 WHERE id = $2`,
    [message, runId]
  );
  if (task_id) {
    await db.query(
      `UPDATE scheduled_tasks SET last_run_at = NOW(), last_status = 'failed', last_result = $1, updated_at = NOW() WHERE id = $2`,
      [message, task_id]
    );
  }
}

// 审批 finalize：approve -> done；reject -> failed（重试指令写入 report）
async function finalizeRun(runId, decision, note) {
  const cur = await db.query('SELECT state, task_id, report FROM scheduled_task_runs WHERE id = $1', [runId]);
  if (cur.rows.length === 0) throw new Error('运行不存在');
  const row = cur.rows[0];
  if (row.state !== 'review') {
    const err = new Error(`仅 review 状态可审批，当前状态: ${row.state || '未知的'}`);
    err.status = 400;
    throw err;
  }
  queue.clearReviewTimer(runId);

  if (decision === 'approve') {
    await queue.transition(runId, 'review', 'done');
    const report = { ...(row.report || {}), reviewNote: note || null, reviewedAt: new Date().toISOString() };
    await db.query(
      `UPDATE scheduled_task_runs SET status = 'success', finished_at = NOW(), report = $1::jsonb WHERE id = $2`,
      [JSON.stringify(report), runId]
    );
    await db.query(
      `UPDATE scheduled_tasks SET last_run_at = NOW(), last_status = 'success', updated_at = NOW() WHERE id = $1`,
      [row.task_id]
    );
    console.log(`[cloud-runner] 运行 ${runId} 审批通过，已完结`);
    return { ok: true, state: 'done' };
  }

  // reject：失败收尾，审批意见（含重试指令）并入 report
  await queue.transition(runId, 'review', 'failed');
  const report = { ...(row.report || {}), reviewNote: note || null, rejectedAt: new Date().toISOString() };
  await db.query(
    `UPDATE scheduled_task_runs SET status = 'failed', finished_at = NOW(), error = $1, report = $2::jsonb WHERE id = $3`,
    [note ? `审批拒绝: ${note}` : '审批拒绝', JSON.stringify(report), runId]
  );
  await db.query(
    `UPDATE scheduled_tasks SET last_run_at = NOW(), last_status = 'failed', last_result = $1, updated_at = NOW() WHERE id = $2`,
    [note ? `审批拒绝: ${note}` : '审批拒绝', row.task_id]
  );
  console.log(`[cloud-runner] 运行 ${runId} 审批拒绝，已完结`);
  return { ok: true, state: 'failed' };
}

module.exports = { executeCloudTask, finalizeRun, failRun };
