// T6-4（设计稿 §5.1）任务状态扩展 quota_suspend 的守护测试（sql.js 驱动）。
//
// 覆盖「必须同步修改的点」里可单测的判据：
//   ① 迁移合法性：queued/running → quota_suspend，恢复唯一入口 queued，取消 skipped；
//   ② 非终态：quota_suspend 不进 TERMINAL_TASK_STATUSES，不消耗重试次数、不写 finished_at；
//   ③ 收尾守卫：存在 quota_suspend 时 isGroupSettled=false（否则组会被误判完成并 finalize）；
//   ④ 依赖语义：quota_suspend 不算「已完成依赖」，下游任务不会被提前入队；
//   ⑤ 恢复：按 seq 升序、小批量回 queued，并清掉旧的暂停理由；
//   ⑥ 投影与文案口径：teamStream.taskProgress 有独立计数键、teamTrace 有独立状态词。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDbAsync } = require('../main/db');
const { TaskStore, TASK_TRANSITIONS, TERMINAL_TASK_STATUSES, canTransition } = require('../main/taskStore');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-quota-suspend-'));
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  const store = new TaskStore(db);

  // ── ① 状态机边（单一事实来源）──
  check('queued 可迁移到 quota_suspend', TASK_TRANSITIONS.queued.includes('quota_suspend'));
  check('running 可迁移到 quota_suspend', TASK_TRANSITIONS.running.includes('quota_suspend'));
  check('quota_suspend 可恢复回 queued', TASK_TRANSITIONS.quota_suspend.includes('queued'));
  check('quota_suspend 可取消为 skipped', TASK_TRANSITIONS.quota_suspend.includes('skipped'));
  check('quota_suspend 不允许直接转 failed（暂停不是失败）',
    !TASK_TRANSITIONS.quota_suspend.includes('failed') && canTransition('task', 'quota_suspend', 'failed') === false);
  check('quota_suspend 不在终态集合', !TERMINAL_TASK_STATUSES.includes('quota_suspend'));

  const TASKS = [
    { id: 't1', title: '并行 A', prompt: 'p1', dependsOn: [] },
    { id: 't2', title: '串行 B', prompt: 'p2', dependsOn: ['t1'], maxRetry: 1 },
    { id: 't3', title: '并行 C', prompt: 'p3', dependsOn: [] },
  ];
  store.createGroup({ groupId: 'gq', goal: '配额暂停', cwd: '/tmp', tasks: TASKS });
  store.setGroupStatus('gq', 'running');

  // ── ② 从 running 暂停：不消耗重试、不写完成时间 ──
  store.enqueueReady('gq');
  const claimed = store.claimNext('gq', 'w-q');
  check('派发前领取成功（t1 running）', claimed.taskId === 't1' && claimed.status === 'running');
  const suspended = store.suspendTask('gq', 't1', { reason: 'quota' });
  check('running → quota_suspend 落库', suspended?.status === 'quota_suspend');
  check('暂停不消耗自动重试次数', store.getTask('gq', 't1').retryCount === 0);
  check('暂停不写 finished_at（非终态）', !store.getTask('gq', 't1').finishedAt);
  check('暂停理由可读（配额不足）', /配额不足/.test(store.getTask('gq', 't1').error || ''));
  check('重复暂停幂等（不重复迁移）', store.suspendTask('gq', 't1').status === 'quota_suspend');
  check('熔断理由独立文案', (() => {
    store.suspendTask('gq', 't3', { reason: 'breaker' });
    return /熔断/.test(store.getTask('gq', 't3').error || '');
  })());

  // ── ③ 收尾守卫：存在 quota_suspend 即未结算 ──
  check('存在 quota_suspend 时 isGroupSettled=false', store.isGroupSettled('gq') === false);

  // ── ④ 依赖语义：暂停的前置不算完成 ──
  store.enqueueReady('gq');
  check('依赖 quota_suspend 的下游仍 pending（不提前入队）', store.getTask('gq', 't2').status === 'pending');
  check('pending 不可被暂停（未入队不属派发闸）', store.suspendTask('gq', 't2') === null
    && store.getTask('gq', 't2').status === 'pending');

  // ── ⑤ 恢复：按 seq 升序、小批量、清理由 ──
  const first = store.resumeSuspendedTasks('gq', { limit: 1 });
  check('恢复按 seq 升序取最小批（t1 先于 t3）', JSON.stringify(first) === JSON.stringify(['t1']));
  check('恢复后状态回 queued', store.getTask('gq', 't1').status === 'queued');
  check('恢复清掉旧暂停理由', !store.getTask('gq', 't1').error);
  check('未恢复的任务保持 quota_suspend', store.getTask('gq', 't3').status === 'quota_suspend');
  const rest = store.resumeSuspendedTasks('gq', { limit: 10 });
  check('第二批恢复剩余任务', JSON.stringify(rest) === JSON.stringify(['t3']));
  check('无可恢复任务时返回空数组', store.resumeSuspendedTasks('gq').length === 0);

  // ── 恢复后重新派发：t1 完成 → t2 才入队（依赖链仍然成立）──
  const again = store.claimNext('gq', 'w-q2');
  check('恢复后可被重新领取', again.taskId === 't1');
  store.setTaskStatus('gq', 't1', 'done', { result: { summary: 'ok' } });
  store.enqueueReady('gq');
  check('前置完成后下游才入队', store.getTask('gq', 't2').status === 'queued');

  // ── 终态任务不可再暂停；暂停任务可被取消 ──
  const claimed2 = store.claimNext('gq', 'w-q3');
  check('下游任务按 seq 被领取', claimed2.taskId === 't2');
  store.setTaskStatus('gq', 't2', 'done', { result: { summary: 'ok' } });
  check('终态任务不可暂停', store.suspendTask('gq', 't2') === null);
  store.suspendTask('gq', 't3');
  store.setTaskStatus('gq', 't3', 'skipped', { error: '用户取消' });
  check('配额暂停可被取消为 skipped', store.getTask('gq', 't3').status === 'skipped');
  check('全部终态后组可结算', store.isGroupSettled('gq') === true);

  // ── ⑥ 投影口径（ESM 动态 import，避免 CJS/ESM 互操作限制）──
  const teamStream = await import('../shared/teamStream.mjs');
  const progress = teamStream.taskProgress([
    { status: 'done' }, { status: 'running' }, { status: 'quota_suspend' }, { status: 'quota_suspend' },
  ]);
  check('投影进度含 quota_suspend 独立计数', progress.quota_suspend === 2 && progress.total === 4);
  check('投影进度不把配额暂停计入 done/failed', progress.done === 1 && progress.failed === 0);
  const teamTrace = await import('../shared/teamTrace.mjs');
  check('状态词表有 quota_suspend 独立 key', teamTrace.TASK_STATUS_KEY.quota_suspend === 'teams.streamTaskQuotaSuspend');

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
