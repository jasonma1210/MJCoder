// M5 / T5-3 跨成员依赖与防死锁守护测试（设计稿 §7「防死锁核心」，sql.js 驱动）。
//
// 覆盖四条硬规则的**可证伪**判据：
//   规则 1「等待图必须无环」——含①并发建边同临界区（Kahn 组合图）②静态 depends_on ∪ 运行期
//     waiting_on 合并判环（只查 waiting_on 会漏「A 动态等 B、B 静态依赖 A」这类互等）；
//   规则 2「等待必须超时」——到点判 failed(wait_timeout) + 级联唤醒 + 不消耗自动重试次数；
//   规则 3「等待不叠加」——单任务等待边上限 MAX_WAIT_DEPS；
//   规则 4「唤醒必须幂等」——重复投递完成事件只放行一次；部分满足不提前放行。
// 另含 R2 观测口径（waitStats 动态等待占比）、isGroupSettled 计入 waiting、被动认领 owner 落库。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDbAsync } = require('../main/db');
const {
  TaskStore, TASK_TRANSITIONS, MAX_WAIT_DEPS, TERMINAL_TASK_STATUSES,
  WAIT_TIMEOUT_DEFAULT_MS, WAIT_TIMEOUT_MAX_MS,
} = require('../main/taskStore');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-dagwait-'));
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  const store = new TaskStore(db);

  const indep = (ids) => ids.map((id) => ({ id, title: id.toUpperCase(), prompt: `p-${id}`, dependsOn: [] }));

  // ── 状态机：waiting 链必须存在（否则运行期等待根本无法落库）──
  check('running 可迁移到 waiting', TASK_TRANSITIONS.running.includes('waiting'));
  check('waiting 可迁移到 queued/failed/skipped',
    ['queued', 'failed', 'skipped'].every((s) => TASK_TRANSITIONS.waiting.includes(s)));
  check('终态集合含 done/failed/skipped',
    JSON.stringify(TERMINAL_TASK_STATUSES) === JSON.stringify(['done', 'failed', 'skipped']));

  // ══ 组 gA：被动认领 owner + 建边 + 环检测 + 不叠加 ══
  store.createGroup({ groupId: 'gA', goal: 'g', cwd: '/tmp', tasks: indep(['a', 'b', 'c', 'd', 'e']) });
  store.enqueueReady('gA');
  // M5「看板被动认领」：owner_member_id 记录谁认领的
  const claimedA = store.claimNext('gA', 'w1', { ownerMemberId: 'member-a' });
  check('claimNext 记录认领者 ownerMemberId', claimedA.taskId === 'a' && claimedA.ownerMemberId === 'member-a');
  check('普通 run 不传 owner 时列为 null（不发明身份）',
    store.claimNext('gA', 'w2').ownerMemberId === null); // 领取 b

  // pending 任务不允许进入等待（可预见的依赖应写进拆解阶段的 dependsOn）
  let r = store.waitOnTasks('gA', 'c', ['d']);
  check('非 running 任务不能进入等待（L2 只兜底运行期新依赖）', r.ok === false && r.waiting === false);

  // 自等待被拒（规则 1）
  const runningA = store.getTask('gA', 'a');
  check('任务 a 已 running', runningA.status === 'running');
  r = store.waitOnTasks('gA', 'a', ['a']);
  check('自等待被拒（等待图必须无环）', r.ok === false && /无环/.test(r.error || ''));

  // 等待目标不存在被拒
  r = store.waitOnTasks('gA', 'a', ['nope']);
  check('等待不存在的任务被拒', r.ok === false && /不存在/.test(r.error || ''));

  // 等待不叠加：上限 MAX_WAIT_DEPS（规则 3）——b 已 running，c/d/e 仍 queued，四者均非终态
  r = store.waitOnTasks('gA', 'a', ['b', 'c', 'd', 'e']);
  check(`等待目标数超过上限 ${MAX_WAIT_DEPS} 被拒（等待不叠加）`, r.ok === false && /上限/.test(r.error || ''));

  // 合法建边：a 等待 b（b 仍 running，未终态）
  r = store.waitOnTasks('gA', 'a', ['b'], { timeoutMs: 999999999 });
  check('合法等待建边成功', r.ok === true && r.waiting === true && r.waitingOn.includes('b'));
  check('等待时长超上限被夹到 WAIT_TIMEOUT_MAX_MS',
    r.deadlineAt - Date.now() <= WAIT_TIMEOUT_MAX_MS + 50 && r.deadlineAt - Date.now() > WAIT_TIMEOUT_MAX_MS - 5000);
  const aWaiting = store.getTask('gA', 'a');
  check('a 落库为 waiting 且记录等待边与超时时刻',
    aWaiting.status === 'waiting' && aWaiting.waitingOn.includes('b') && typeof aWaiting.waitDeadlineAt === 'number');
  check('waitCount 记录进入等待的次数', aWaiting.waitCount === 1);

  // 组结算判定必须计入 waiting：a 仍 waiting ⇒ 组未结算
  check('isGroupSettled 把 waiting 计为未结算（防提前收尾成孤儿）', store.isGroupSettled('gA') === false);

  // 规则 1：等待图成环被拒（b 等待 a，而 a 已等待 b）
  r = store.waitOnTasks('gA', 'b', ['a']);
  check('运行期等待成环被拒（同一临界区判环）', r.ok === false && /成环/.test(r.error || ''));

  // ══ 组 gC：静态 depends_on ∪ 动态 waiting_on 合并判环（只查 waiting_on 会漏）══
  store.createGroup({
    groupId: 'gC', goal: 'g', cwd: '/tmp',
    tasks: [
      { id: 'cx', title: 'X', prompt: 'px', dependsOn: [] },
      { id: 'cy', title: 'Y', prompt: 'py', dependsOn: ['cx'] }, // 静态：cy 依赖 cx
    ],
  });
  store.enqueueReady('gC'); // cx 入队，cy 因依赖未满足仍 pending
  store.claimNext('gC', 'w4'); // cx → running
  check('cy 因静态依赖未满足仍 pending', store.getTask('gC', 'cy').status === 'pending');
  // cx 动态等待 cy：合并图出现 cx→cy 与 cy→cx（静态）⇒ 成环，必须拒绝
  r = store.waitOnTasks('gC', 'cx', ['cy']);
  check('静态依赖 + 动态等待合并成环被拒（合并判环）', r.ok === false && /成环/.test(r.error || ''));

  // ══ 组 gS：目标已终态 ⇒ 无需挂起（省一次空往返）══
  store.createGroup({ groupId: 'gS', goal: 'g', cwd: '/tmp', tasks: indep(['sa', 'sb']) });
  store.enqueueReady('gS');
  store.claimNext('gS', 'w5'); // sa running
  store.setTaskStatus('gS', 'sb', 'done', { force: true }); // queued→done 非法迁移，测试直落终态需 force
  r = store.waitOnTasks('gS', 'sa', ['sb']);
  check('等待目标已终态 ⇒ waiting=false 且给出 reason（无需挂起）',
    r.ok === true && r.waiting === false && r.reason === 'deps_already_settled');

  // ══ 组 gW：幂等唤醒 + 部分满足不提前放行 + R2 观测 ══
  store.createGroup({ groupId: 'gW', goal: 'g', cwd: '/tmp', tasks: indep(['wa', 'wb', 'wc']) });
  store.enqueueReady('gW');
  store.claimNext('gW', 'w6'); // wa
  store.claimNext('gW', 'w7'); // wb
  store.claimNext('gW', 'w8'); // wc
  r = store.waitOnTasks('gW', 'wc', ['wa', 'wb']);
  check('wc 同时等待 wa 与 wb', r.ok === true && r.waiting === true && r.waitingOn.length === 2);

  // 部分满足：wa 完成，wb 未完成 ⇒ wc 不唤醒
  store.setTaskStatus('gW', 'wa', 'done');
  let woken = store.settleWaitingTasks('gW', 'wa');
  check('部分满足不提前放行（wa 完成，wb 未完成）', woken.length === 0 && store.getTask('gW', 'wc').status === 'waiting');

  // 全部满足：wb 完成 ⇒ wc 唤醒
  store.setTaskStatus('gW', 'wb', 'done');
  woken = store.settleWaitingTasks('gW', 'wb');
  check('全部依赖终态后唤醒等待者', woken.length === 1 && woken[0].taskId === 'wc');
  check('唤醒后落库为 queued 且清空等待边',
    store.getTask('gW', 'wc').status === 'queued' && store.getTask('gW', 'wc').waitingOn.length === 0);

  // 幂等：重复投递完成事件不再唤醒
  woken = store.settleWaitingTasks('gW', 'wb');
  check('唤醒幂等（重复投递不重复放行）', woken.length === 0);

  // R2 观测口径：动态等待占比 = 进入过等待的任务数 / 总数
  const stats = store.waitStats('gW');
  check('waitStats 观测动态等待占比（R2）',
    stats.total === 3 && stats.waited === 1 && stats.waiting === 0 && Math.abs(stats.ratio - 1 / 3) < 1e-9);

  // ══ 组 gT：等待超时（规则 2）+ 级联唤醒 + 不消耗自动重试 ══
  store.createGroup({ groupId: 'gT', goal: 'g', cwd: '/tmp', tasks: indep(['ta', 'tb', 'tc']) });
  store.enqueueReady('gT');
  store.claimNext('gT', 'w9');   // ta
  store.claimNext('gT', 'w10');  // tb
  store.claimNext('gT', 'w11');  // tc
  r = store.waitOnTasks('gT', 'ta', ['tb'], { timeoutMs: 1000 });
  check('ta 等待 tb（1s 超时）', r.ok === true && r.waiting === true);
  r = store.waitOnTasks('gT', 'tc', ['ta']);
  check('tc 等待 ta（用于验证超时级联）', r.ok === true && r.waiting === true);

  // 未到点：不判超时
  let timedOut = store.sweepWaitTimeouts(Date.now());
  check('未到超时时刻不判失败', timedOut.length === 0);

  // 到点：判 failed(wait_timeout) + 级联唤醒 tc
  timedOut = store.sweepWaitTimeouts(Date.now() + 2000);
  const taFired = timedOut.find((t) => t.taskId === 'ta');
  check('到点判 failed 且给出结构化未满足清单', !!taFired && taFired.unmet.includes('tb'));
  const taAfter = store.getTask('gT', 'ta');
  check('超时任务落库 failed + wait_timeout 结果',
    taAfter.status === 'failed' && taAfter.result && taAfter.result.waitTimeout === true);
  check('等待超时不消耗自动重试次数（retry_count 不增）', taAfter.retryCount === 0);
  check('超时任务成为终态 ⇒ 级联唤醒等它的任务', taFired.woken.includes('tc') && store.getTask('gT', 'tc').status === 'queued');

  // ══ 组 gX：组强停清等待任务（cancelWaiting）══
  store.createGroup({ groupId: 'gX', goal: 'g', cwd: '/tmp', tasks: indep(['xa', 'xb']) });
  store.enqueueReady('gX');
  store.claimNext('gX', 'w12'); // xa
  store.claimNext('gX', 'w13'); // xb
  store.waitOnTasks('gX', 'xa', ['xb']);
  r = store.waitOnTasks('gX', 'xb', ['xa']);
  check('互等被拒（xa 已等 xb）', r.ok === false);
  const cancelled = store.cancelWaiting('gX', { error: '组已被用户强制停止' });
  check('cancelWaiting 把等待任务置 skipped（强停不漏）',
    cancelled.length === 1 && cancelled[0].taskId === 'xa' && store.getTask('gX', 'xa').status === 'skipped');

  // ══ 默认超时值单一事实来源 ══
  store.createGroup({ groupId: 'gD', goal: 'g', cwd: '/tmp', tasks: indep(['da', 'db']) });
  store.enqueueReady('gD');
  store.claimNext('gD', 'w14'); // da
  store.claimNext('gD', 'w15'); // db
  r = store.waitOnTasks('gD', 'da', ['db']); // 不传 timeoutMs → 用默认
  check('缺省等待超时为 WAIT_TIMEOUT_DEFAULT_MS',
    Math.abs((r.deadlineAt - Date.now()) - WAIT_TIMEOUT_DEFAULT_MS) < 5000);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
