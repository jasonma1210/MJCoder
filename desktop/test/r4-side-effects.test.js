// N5 副作用账本行为验收（2026-10-16）：
//   1) Worker 领取即 uncertain（账本记录「可能产生副作用」）；
//   2) 终态 resolved（done/failed 均算账清）；重试重新领取回到 uncertain（upsert）；
//   3) 重启恢复后 uncertain 原样保留 = 「副作用无法确认」清单（V14 不重放的可审计地基）。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDbAsync } = require('../main/db');
const { TaskStore } = require('../main/taskStore');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-n5-'));
  // 测试走 sql.js（WASM，零原生模块依赖），与 taskStore 套件同口径
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  const store = new TaskStore(db);

  store.createGroup({ groupId: 'g5', goal: '副作用账本场景', cwd: '', dag: null, tasks: [
    { id: 'a', title: '会写文件', prompt: 'p-a' },
    { id: 'b', title: '会失败重试', prompt: 'p-b', maxRetry: 1 },
  ] });
  store.enqueueReady('g5');

  // 1) 领取 a → uncertain
  store.claimNext('g5', 'w1'); // a → running
  store.markEffectUncertain('g5', 'a');
  check('账本: 领取即 uncertain', store.listUncertainEffects('g5').includes('a'));

  // 2) a 终态（done）→ resolved
  store.setTaskStatus('g5', 'a', 'done', { result: { summary: 'ok' } });
  store.resolveEffect('g5', 'a');
  check('账本: 终态 resolved（清单不再含 a）', !store.listUncertainEffects('g5').includes('a'));

  // 3) b 走失败重试：uncertain → 终态 → 重试重新领取回到 uncertain（upsert 语义）
  store.claimNext('g5', 'w2'); // b → running
  store.markEffectUncertain('g5', 'b');
  const { retried } = store.handleFailure('g5', 'b', '模拟失败');
  check('账本: 失败重试回队', retried === true);
  store.claimNext('g5', 'w3'); // b 重新 running
  store.markEffectUncertain('g5', 'b'); // 重试：upsert 回 uncertain（不插重复行）
  check('账本: 重试重新领取回到 uncertain（upsert 不重复）', store.listUncertainEffects('g5').includes('b'));

  // 4) 模拟重启恢复：running 的 b → failed + needsReview；账本 uncertain 保留
  store.setGroupStatus('g5', 'running');
  const rec = store.recoverInterrupted();
  check('账本: V14 恢复后 uncertain 保留（副作用无法确认清单）', store.listUncertainEffects('g5').includes('b'));
  check('账本: 恢复清单与账本一致', rec.recoveredTasks.some((t) => t.taskId === 'b' && t.groupId === 'g5'));

  // 5) A5 重试前置核对：有未确认副作用时必须先确认，确认后放行
  check('A5 重试核对: 有未确认副作用 → 要求先核对', store.needsRetryReview('g5', 'b') === true);
  check('A5 重试核对: 用户显式确认后可重试', store.needsRetryReview('g5', 'b', true) === false);
  check('A5 重试核对: 无副作用的任务不额外拦（a 已 resolved）', store.needsRetryReview('g5', 'a') === false);
  check('A5 重试核对: 未知任务不产生假阳性', store.needsRetryReview('g5', 'no-such-task') === false);
  check('A5 重试核对: 未知组不抛错', store.needsRetryReview('no-such-group', 'b') === false);

  try { if (db.close) db.close(); } catch { /* 尽力关闭 */ }
  console.log(`\n──── N5 副作用账本验收汇总：通过 ${pass} · 失败 ${fail} ────`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
