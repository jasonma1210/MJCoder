// DS Bots / T6-8 测试：单 Bot 熔断（§5.3 closed / open / half_open）
//
// 覆盖验收点：
//   · 判据 = 10 分钟窗口 ≥ 桶总量 30% 且 ≥ 100k（两个条件缺一不可）；
//   · open 只锁该成员，其他成员 closed；
//   · 熔断持续满 10 分钟 → half_open，且每次半开周期只放行一个探针；
//   · 探针消耗后重新聚合：仍超限 → 重新 open；回落阈值下 → 彻底 closed；
//   · 调度接线：breakerBlocked 只暂停该成员任务；tickAll 不恢复熔断成员的暂停任务。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDbAsync } = require('../main/db');
const { TaskStore } = require('../main/taskStore');
const { ProjectStore } = require('../main/projectStore');
const { QuotaLedger } = require('../main/quotaLedger');
const { createQuotaGate } = require('../main/quotaGate');
const { createMemberBreaker, WINDOW_MS, MIN_TOKENS } = require('../main/memberBreaker');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-breaker-'));
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  const store = new TaskStore(db);
  const projects = new ProjectStore(db);
  const ledger = new QuotaLedger(db);
  const breaker = createMemberBreaker({ ledger });
  const events = [];
  const gate = createQuotaGate({
    ledger, store, db, breaker,
    projectOfThread: (tid) => projects.getProjectByThread(tid),
    emit: (e) => events.push(e),
  });

  const base = Date.now();
  const min = 60 * 1000;
  const round = (projectId, memberId, tokens, at) => ledger.recordRound({
    projectId, runId: 'r', taskId: `${memberId}-${at}`, memberId, tokens, at,
  });

  // ── 场景 1：判据（30% 且 100k）──
  ledger.ensureBucket('prj_small', { totalLimit: 200000 }); // 30% = 60k < 100k
  round('prj_small', 'm1', 70000, base);                    // 35% 但未到 100k
  check('30% 但不足 100k → closed', breaker.state('prj_small', 'm1', base) === 'closed');
  round('prj_small', 'm1', 40000, base);                    // 累计 110k
  check('达到 30% 且 100k → open', breaker.state('prj_small', 'm1', base) === 'open');
  check('无成员身份 → closed', breaker.state('prj_small', '', base) === 'closed');
  check('未知项目桶 → closed', breaker.state('prj_none', 'm1', base) === 'closed');
  check('open 成员不放行', breaker.allow('prj_small', 'm1', base) === false);
  check('同项目其他成员不受影响', breaker.allow('prj_small', 'm2', base) === true
    && breaker.state('prj_small', 'm2', base) === 'closed');

  // ── 场景 2：half_open 只放行一个探针，探针仍超限 → 重新 open ──
  ledger.ensureBucket('prj_h', { totalLimit: 1000000 }); // 阈值 max(100k, 300k) = 300k
  round('prj_h', 'm1', 400000, base);
  check('m1 首次超限即 open', breaker.state('prj_h', 'm1', base) === 'open');
  for (let i = 1; i <= 10; i += 1) round('prj_h', 'm1', 60000, base + i * min); // 维持窗口热度
  const halfAt = base + 10 * min + 1;
  check('熔断满 10 分钟 → half_open', breaker.state('prj_h', 'm1', halfAt) === 'half_open');
  check('half_open 放行第一个探针', breaker.allow('prj_h', 'm1', halfAt) === true);
  check('同一半开周期第二个任务仍被拦', breaker.allow('prj_h', 'm1', halfAt) === false);
  round('prj_h', 'm1', 10000, halfAt + 1);
  check('探针仍超限 → 重新 open', breaker.state('prj_h', 'm1', halfAt + 1) === 'open');
  check('重新 open 后不再放行', breaker.allow('prj_h', 'm1', halfAt + 1) === false);

  // ── 场景 3：探针消耗回落到阈值下 → 彻底 closed ──
  // 独立桶：effectiveNow 以「本项目最新扣费」为锚，同桶会被 m1 的未来时间戳把窗口整体推前。
  ledger.ensureBucket('prj_h3', { totalLimit: 1000000 });
  round('prj_h3', 'm3', 400000, base);
  breaker.state('prj_h3', 'm3', base); // 记录 openedAt
  for (let i = 1; i <= 10; i += 1) round('prj_h3', 'm3', 30000, base + i * min); // 窗口恰好 300k
  check('m3 半开（窗口恰好阈值）', breaker.state('prj_h3', 'm3', halfAt) === 'half_open');
  check('m3 放行探针', breaker.allow('prj_h3', 'm3', halfAt) === true);
  round('prj_h3', 'm3', 1000, halfAt + 1);
  // 再过一个窗口段：早期按分钟记账老化掉一部分，窗口回落到 271k < 300k
  const settleAt = base + 11 * min + 3;
  check('探针回落阈值下 → closed', breaker.state('prj_h3', 'm3', settleAt) === 'closed');
  check('closed 后恢复放行', breaker.allow('prj_h3', 'm3', settleAt) === true);

  // ── 场景 4：调度接线——只暂停熔断成员任务，tickAll 跳过其暂停任务 ──
  projects.createProject({ projectId: 'prj_i', name: '项目I', objective: '目标I', threadId: 'thr-i' });
  ledger.ensureBucket('prj_i', { totalLimit: 1000000 });
  round('prj_i', 'mem1', 400000, base); // mem1 熔断，mem2 正常
  store.createGroup({
    groupId: 'g-i', goal: '熔断隔离', cwd: '', threadId: 'thr-i',
    tasks: [
      { id: 'i1', title: '一', prompt: 'x' },
      { id: 'i2', title: '二', prompt: 'x' },
      { id: 'i3', title: '三', prompt: 'x' },
      { id: 'i4', title: '四', prompt: 'x' },
    ],
  });
  store.enqueueReady('g-i');
  const own = (taskId, member) => store.setTaskStatus('g-i', taskId, 'running', { ownerMemberId: member });
  own('i1', 'mem1');
  own('i2', 'mem1');
  own('i3', 'mem2');
  const i4 = own('i4', 'mem2');
  store.suspendTask('g-i', 'i4', { reason: 'quota' }); // 额度型暂停（与熔断型区分）
  store.setGroupStatus('g-i', 'running');
  events.length = 0;

  check('熔断成员任务被拦', gate.breakerBlocked(store.getGroup('g-i'), store.getTask('g-i', 'i1')) === true);
  check('被拦任务转 quota_suspend（reason=breaker）', store.getTask('g-i', 'i1').status === 'quota_suspend'
    && /熔断/.test(store.getTask('g-i', 'i1').error || ''));
  check('同组其他成员任务照常放行', gate.breakerBlocked(store.getGroup('g-i'), store.getTask('g-i', 'i3')) === false
    && store.getTask('g-i', 'i3').status === 'running');
  check('广播 breaker_state=open', events.some((e) => e.type === 'breaker_state'
    && e.memberId === 'mem1' && e.state === 'open'));

  const tick = gate.tickAll();
  check('tickAll 只恢复非熔断成员任务', tick.resumed === 1
    && store.getTask('g-i', 'i4').status === 'queued'
    && store.getTask('g-i', 'i1').status === 'quota_suspend', `resumed=${tick.resumed}, i4=${i4 && store.getTask('g-i', 'i4').status}`);

  // 熔断窗口老化到阈值下 → 允许恢复
  ledger.recordRound({ projectId: 'prj_i', taskId: 'old', memberId: 'mem1', tokens: 1, at: base + WINDOW_MS + 1000 });
  check('窗口老化后熔断解除', breaker.state('prj_i', 'mem1', base + WINDOW_MS + 1000) === 'closed');
  const tick2 = gate.tickAll();
  check('解除后 tickAll 恢复该成员任务', tick2.resumed === 1 && store.getTask('g-i', 'i1').status === 'queued');

  check('常量口径 = 10 分钟 / 100k', WINDOW_MS === 600000 && MIN_TOKENS === 100000);

  console.log(`\nmember-breaker: ${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail === 0 ? 0 : 1;
  try { db.close?.(); } catch { /* sql.js 关闭幂等 */ }
})();
