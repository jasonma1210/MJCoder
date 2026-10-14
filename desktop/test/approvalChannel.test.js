// 审批通道分发逻辑测试：按 id 精确分发 / 超时 deny / 未知 id 忽略 / legacy 兼容
const { ApprovalChannel } = require('../main/approvalChannel');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  // ── 并发审批按 id 精确分发（原竞态场景：两个等待者，响应不得串扰）──
  const ch = new ApprovalChannel();
  const idA = ch.nextId();
  const idB = ch.nextId();
  let resolvedA = null;
  let resolvedB = null;
  const pA = ch.wait(idA).then((d) => { resolvedA = d; });
  const pB = ch.wait(idB).then((d) => { resolvedB = d; });
  check('并发两个挂起审批', ch.size === 2);
  const okB = ch.dispatch(idB, 'once');
  const okA = ch.dispatch(idA, 'deny');
  check('按 id 分发成功', okA === true && okB === true);
  await Promise.all([pA, pB]);
  check('决策不串扰：A=deny，B=once', resolvedA === 'deny' && resolvedB === 'once');
  check('分发后无残留挂起', ch.size === 0);

  // ── 未知 / 重复 id 拒绝分发（防串扰与重放）──
  check('未知 id 分发被拒绝', ch.dispatch('ap-unknown-999', 'once') === false);
  check('已消费 id 不可重放', ch.dispatch(idA, 'once') === false);

  // ── 超时按 deny ──
  const chT = new ApprovalChannel({ timeoutMs: 50 });
  let timeoutResult = null;
  const pT = chT.wait(chT.nextId()).then((d) => { timeoutResult = d; });
  await new Promise((r) => setTimeout(r, 150));
  await pT;
  check('超时未响应自动 deny', timeoutResult === 'deny' && chT.size === 0);

  // ── legacy 兼容：无 id 裸 decision，仅唯一挂起时接受 ──
  const chL = new ApprovalChannel();
  const idL1 = chL.nextId();
  const idL2 = chL.nextId();
  let legacyResult = null;
  const pL1 = chL.wait(idL1).then((d) => { legacyResult = d; });
  chL.wait(idL2); // 第二个挂起
  check('多挂起时 legacy 分发被拒绝（不猜测）', chL.dispatchLegacy('once') === false);
  await chL.dispatch(idL2, 'once'); // 消费掉一个
  const okLegacy = chL.dispatchLegacy('conversation');
  await pL1;
  check('唯一挂起时 legacy 分发成功', okLegacy === true && legacyResult === 'conversation');

  // ── disposeAll：全部按 deny 收尾 ──
  const chD = new ApprovalChannel();
  const results = [];
  results.push(chD.wait(chD.nextId()));
  results.push(chD.wait(chD.nextId()));
  chD.disposeAll();
  const denied = await Promise.all(results);
  check('disposeAll 全部按 deny 收尾', denied.every((d) => d === 'deny') && chD.size === 0);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})();
