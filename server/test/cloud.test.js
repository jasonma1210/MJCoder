// 云端委派直连测试：不经过 HTTP，直连真实 PG + 真实用户行
// 运行：node test/cloud.test.js（连接串读 server/.env）
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../src/db');
const queue = require('../src/jobs/cloud/queue');
const runner = require('../src/jobs/cloud/runner');
const { LocalWorkerProvider, E2BProvider } = require('../src/jobs/cloud/provider');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '[通过]' : '[失败]'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// 确定性假 provider：直接 resolve diff/report，用于全状态机流转验证
function makeMockProvider() {
  return {
    name: 'mock',
    async provision(task) {
      return { sandboxId: 'mock-sandbox-1', workdir: fs.mkdtempSync(path.join(os.tmpdir(), 'mj-mock-')) };
    },
    async run(sandbox, task) {
      return {
        ok: true,
        diff: 'https://example.com/diff/mock-1',
        report: { ok: true, finalText: '模拟完成', usage: { input: 10, output: 5 } },
      };
    },
    async destroy(sandbox) {},
  };
}

async function insertFixture() {
  const stamp = Date.now();
  const user = await db.query(
    `INSERT INTO users (email, username, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
    [`cloud-test-${stamp}@mjcode.dev`, `cloudtest${stamp}`]
  );
  const userId = user.rows[0].id;
  const provider = await db.query(
    `INSERT INTO model_providers (user_id, name, base_url, api_key) VALUES ($1, 'test-prov', 'https://api.example.com/v1', 'sk-test') RETURNING id`,
    [userId]
  );
  const thread = await db.query(
    `INSERT INTO threads (user_id, title, cwd, provider_id, model_name) VALUES ($1, 'cloud-test', '/tmp', $2, 'test-model') RETURNING id`,
    [userId, provider.rows[0].id]
  );
  const task = await db.query(
    `INSERT INTO scheduled_tasks (user_id, name, prompt, schedule, enabled, execution_mode, thread_id)
     VALUES ($1, '云端测试任务', '修复登录页空指针', '* * * * *', false, 'cloud', $2) RETURNING *`,
    [userId, thread.rows[0].id]
  );
  // 第二个用户：验证他人 run 归属隔离
  const user2 = await db.query(
    `INSERT INTO users (email, username, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
    [`cloud-test2-${stamp}@mjcode.dev`, `cloudtest2_${stamp}`]
  );
  return { userId, otherUserId: user2.rows[0].id, task: task.rows[0] };
}

// 新建一个 state=queued 的运行行
async function insertQueuedRun(taskId, report = {}) {
  const r = await db.query(
    `INSERT INTO scheduled_task_runs (task_id, status, state, started_at, report)
     VALUES ($1, 'running', 'queued', NOW(), $2::jsonb) RETURNING *`,
    [taskId, JSON.stringify(report)]
  );
  return r.rows[0];
}

// 归属校验查询（与 routes/cloud.js 中 approve/GET 的口径一致）
function ownershipQuery(runId, userId) {
  return db.query(
    `SELECT r.id FROM scheduled_task_runs r
     JOIN scheduled_tasks t ON t.id = r.task_id
     WHERE r.id = $1 AND t.user_id = $2`,
    [runId, userId]
  );
}

(async () => {
  let fixture;
  try {
    fixture = await insertFixture();
    const { userId, otherUserId, task } = fixture;

    // ---- 场景一：MockProvider 全状态机流转 queued -> provisioning -> running -> review -> done
    {
      const run = await insertQueuedRun(task.id, { repo: 'https://example.com/repo.git' });
      const result = await runner.executeCloudTask(task, run, { provider: makeMockProvider() });
      const afterRun = await db.query('SELECT * FROM scheduled_task_runs WHERE id = $1', [run.id]);
      check('1.1 执行后进入 review 状态', result.ok && afterRun.rows[0].state === 'review', `state=${afterRun.rows[0].state}`);
      check('1.2 sandbox_id 已落库', afterRun.rows[0].sandbox_id === 'mock-sandbox-1');
      check('1.3 diff_url 已落库', afterRun.rows[0].diff_url === 'https://example.com/diff/mock-1');
      const report = afterRun.rows[0].report;
      check('1.4 report 落库且保留 repo', report.ok === true && report.repo === 'https://example.com/repo.git');
      check('1.5 report 含 finalText/usage', report.finalText === '模拟完成' && !!report.usage);

      // 非法审批前置校验（此处顺便覆盖场景二的 400 分支之一）
      const fin = await runner.finalizeRun(run.id, 'approve', '通过');
      const done = await db.query('SELECT * FROM scheduled_task_runs WHERE id = $1', [run.id]);
      check('1.6 approve 后进入 done', fin.state === 'done' && done.rows[0].state === 'done');
      check('1.7 done 后 status=success 且带审批意见', done.rows[0].status === 'success' && done.rows[0].report.reviewNote === '通过');
    }

    // ---- 场景二：approve 校验（非 review 态 400、他人 run 404）
    {
      const run = await insertQueuedRun(task.id);
      // 非 review 态：queued 直接审批应 400
      let caught = null;
      try { await runner.finalizeRun(run.id, 'approve'); } catch (err) { caught = err; }
      check('2.1 非 review 态审批被拒（400）', caught && caught.status === 400, caught && caught.message);

      // 他人 run：归属查询 0 行 => 路由层 404
      const own = await ownershipQuery(run.id, otherUserId);
      check('2.2 他人 run 归属校验为空（404 路径）', own.rows.length === 0);

      // reject 路径：先推进到 review 再拒绝，重试指令入 report
      await queue.transition(run.id, 'queued', 'provisioning');
      await queue.transition(run.id, 'provisioning', 'running');
      await queue.transition(run.id, 'running', 'review');
      const rej = await runner.finalizeRun(run.id, 'reject', '请补充单测后重试');
      const after = await db.query('SELECT * FROM scheduled_task_runs WHERE id = $1', [run.id]);
      check('2.3 reject 后进入 failed 且 note 入 report', rej.state === 'failed' && after.rows[0].report.reviewNote === '请补充单测后重试');
      check('2.4 reject 后 error 字段记录拒绝原因', (after.rows[0].error || '').includes('请补充单测后重试'));
    }

    // ---- 场景三：非法流转被拒
    {
      const run = await insertQueuedRun(task.id);
      let caught = null;
      try { await queue.transition(run.id, 'queued', 'done'); } catch (err) { caught = err; }
      check('3.1 跳级流转 queued->done 被拒', !!caught && caught.message.includes('非法状态流转'), caught && caught.message);

      let caught2 = null;
      try { await queue.transition(run.id, 'review', 'done'); } catch (err) { caught2 = err; }
      check('3.2 状态不符 CAS 流转被拒', !!caught2 && caught2.message.includes('实际 queued'), caught2 && caught2.message);

      const state = await queue.getState(run.id);
      check('3.3 非法流转后状态未被破坏', state === 'queued');
    }

    // ---- 场景四：LocalWorkerProvider 对 agent-core 缺失时的失败路径
    {
      // 注入不存在的 cli 路径，验证 report.ok=false 带错误
      const badProvider = new LocalWorkerProvider({ cliPath: path.join(os.tmpdir(), `no-such-cli-${Date.now()}.js`) });
      const sandbox = await badProvider.provision({});
      const res = await badProvider.run(sandbox, { objective: 'x', provider: {} });
      check('4.1 cli 缺失时 report.ok=false', res.ok === false && res.report.ok === false);
      check('4.2 失败 report 带错误信息', typeof res.report.error === 'string' && res.report.error.includes('不存在'), res.report.error);

      // 全链路：注入坏 provider 走 runner，应落 failed
      const run = await insertQueuedRun(task.id);
      const result = await runner.executeCloudTask(task, run, { provider: badProvider });
      const after = await db.query('SELECT * FROM scheduled_task_runs WHERE id = $1', [run.id]);
      check('4.3 执行失败后状态落 failed', result.ok === false && after.rows[0].state === 'failed', `state=${after.rows[0].state}`);
      check('4.4 failed 运行 error 字段含 cli 缺失原因', (after.rows[0].error || '').includes('不存在'), after.rows[0].error);
      check('4.5 任务侧 last_status 同步为 failed', after.rows.length > 0 && (await db.query('SELECT last_status FROM scheduled_tasks WHERE id=$1', [task.id])).rows[0].last_status === 'failed');
    }

    // ---- 场景五（附加）：E2BProvider 缺 Key 构造即抛「未配置」
    {
      const saved = process.env.E2B_API_KEY;
      delete process.env.E2B_API_KEY;
      let caught = null;
      try { new E2BProvider(); } catch (err) { caught = err; }
      check('5.1 E2BProvider 缺 E2B_API_KEY 构造即抛未配置', !!caught && caught.message.includes('未配置'), caught && caught.message);
      if (saved !== undefined) process.env.E2B_API_KEY = saved;
    }
  } catch (err) {
    console.error('[测试异常]', err);
    results.push({ name: '测试执行', ok: false });
  } finally {
    // 清理临时数据（用户级联删除 threads/providers/tasks/runs）
    if (fixture) {
      const u = await db.query(`DELETE FROM users WHERE id IN ($1, $2) RETURNING id`, [fixture.userId, fixture.otherUserId]);
      console.log(`[清理] 已删除临时用户 ${u.rows.length} 个（级联清理任务与运行）`);
    }
    await db.pool.end();
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length > 0 ? 1 : 0);
})();
