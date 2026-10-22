// DS Bots / T6-3 测试：滑动配额账本（老化 / 预留 / 结算补差 / 迟滞 / 时钟回拨 / 水位）
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDbAsync } = require('../main/db');
const { QuotaLedger, DEFAULT_GRANT } = require('../main/quotaLedger');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-quota-'));
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  const ledger = new QuotaLedger(db);
  const now = Date.now();

  // ── 桶默认值与幂等补建 ──
  const b = ledger.ensureBucket('prj_a');
  check('默认桶 3M / 6h / 70% / 90% / 100k / 85%',
    b.totalLimit === 3000000 && b.windowSeconds === 21600 && b.warnRatio === 0.7
    && b.throttleRatio === 0.9 && b.resumeMinTokens === 100000 && b.resumeHysteresisRatio === 0.85);
  const b2 = ledger.ensureBucket('prj_a');
  check('重复 ensureBucket 幂等（不重置）', b2.createdAt === b.createdAt);
  check('缺 projectId 抛错', (() => { try { ledger.ensureBucket(''); return false; } catch { return true; } })());

  // ── 滑动窗口：只统计窗口内，老化=查询口径 ──
  ledger.recordRound({ projectId: 'prj_a', runId: 'r1', taskId: 't-old', tokens: 500000, at: now - 6.5 * 3600 * 1000 });
  ledger.recordRound({ projectId: 'prj_a', runId: 'r1', taskId: 't1', tokens: 1000000, at: now - 60 * 1000 });
  check('窗口外消耗被老化剔除', ledger.usedInWindow('prj_a', now) === 1000000);
  check('available = 总量 − 窗口内消耗', ledger.available('prj_a', now) === 2000000);
  check('老化记录仍在库中（保留审计，不删数据）',
    db.prepare('SELECT COUNT(*) AS c FROM quota_consumptions WHERE project_id = ?').get('prj_a').c === 2);

  // ── 预留：授予即扣，释放即还，重复授予不叠加 ──
  const granted = ledger.grant('prj_a', 'task-x', DEFAULT_GRANT, now);
  check('授予额取 min(请求, 可用)', granted === DEFAULT_GRANT, `granted=${granted}`);
  check('预留占用可用额度', ledger.available('prj_a', now) === 2000000 - DEFAULT_GRANT);
  check('同任务重复授予返回既有预留（不叠加）', ledger.grant('prj_a', 'task-x', 999999, now) === DEFAULT_GRANT);
  check('reservedOf 汇总本桶预留', ledger.reservedOf('prj_a') === DEFAULT_GRANT);
  ledger.release('task-x');
  check('释放预留后额度归还', ledger.available('prj_a', now) === 2000000);

  // ── 结算补差：只补正差，按轮已记账不重复计入 ──
  ledger.recordRound({ projectId: 'prj_a', runId: 'r1', taskId: 'task-y', tokens: 5000, at: now });
  ledger.grant('prj_a', 'task-y', 50000, now);
  const s1 = ledger.settle({ projectId: 'prj_a', runId: 'r1', taskId: 'task-y', memberId: 'm1', actual: 8000 });
  check('结算补差 = 实际 − 按轮', s1.delta === 3000 && s1.rounds === 5000);
  check('结算释放预留', ledger.reservedOf('prj_a') === 0);
  const s2 = ledger.settle({ projectId: 'prj_a', runId: 'r1', taskId: 'task-y', memberId: 'm1', actual: 4000 });
  check('实际低于按轮记账不产生负补差', s2.delta === 0);

  // ── 水位：70% 告警 / 90% 限流 / 100% 熔断 ──
  const st0 = ledger.state('prj_a', now);
  check('当前利用率约 33%（1M+8k / 3M）', st0.util > 0.33 && st0.util < 0.35, `util=${st0.util.toFixed(3)}`);
  check('水位为 ok', st0.state === 'ok');

  const mk = (id, used, extra = {}) => {
    ledger.ensureBucket(id, {
      totalLimit: 1000000, resumeMinTokens: 100000, resumeHysteresisRatio: 0.85, ...extra,
    });
    if (used > 0) ledger.recordRound({ projectId: id, taskId: `${id}-t`, tokens: used, at: now });
    return ledger.state(id, now);
  };
  check('75% → warn', mk('prj_warn', 750000).state === 'warn');
  // 92% 水位：可用 80k < 恢复下限 100k 时会先命中 suspended（伪代码口径「低于下限一律熔断」），
  // 故限流档用恢复下限更低的桶验证「90% ≤ 利用率 < 100%」区间
  check('92% → throttle（恢复下限放宽）', mk('prj_thr', 920000, { resumeMinTokens: 1000 }).state === 'throttle');
  check('99% → suspended（低于恢复下限）', mk('prj_sus', 990000).state === 'suspended');

  // ── 迟滞：可用已过下限但利用率未回落 → 不恢复（防「恢复→打满→再暂停」）──
  const d1 = ledger.resumeDecision('prj_sus', now); // util=0.99
  check('利用率 99% 不恢复', d1.resume === false && d1.limit === 0);
  const d2 = ledger.resumeDecision('prj_warn', now); // util=0.75
  check('利用率 75%（<85%）+ 可用≥下限 → 恢复', d2.resume === true && d2.limit === 2);
  const d3 = ledger.resumeDecision('prj_thr', now); // util=0.92
  check('利用率 92% 仍不恢复（迟滞生效）', d3.resume === false);

  // ── 前置换算：允许 / 限流 / 熔断 ──
  const gateOk = ledger.beforeDispatch('prj_warn', now);
  check('增量空间充足时放行且 grant≤200k', gateOk.allow === true && gateOk.grant <= DEFAULT_GRANT);
  const gateThr = ledger.beforeDispatch('prj_thr', now);
  check('90% 水位标记 throttle 但仍放行增量任务', gateThr.allow === true && gateThr.throttle === true);
  const gateSus = ledger.beforeDispatch('prj_sus', now);
  check('低于恢复下限拒绝派发', gateSus.allow === false && gateSus.reason === 'quota');

  // ── 单 Bot 聚合（T6-8 的数据源）──
  ledger.ensureBucket('prj_m');
  ledger.recordRound({ projectId: 'prj_m', memberId: 'm1', taskId: 'a1', tokens: 400000, at: now - 60 * 1000 });
  ledger.recordRound({ projectId: 'prj_m', memberId: 'm2', taskId: 'a2', tokens: 100000, at: now - 60 * 1000 });
  ledger.recordRound({ projectId: 'prj_m', memberId: 'm1', taskId: 'a3', tokens: 999999, at: now - 20 * 60 * 1000 }); // 10 分钟窗口外
  check('成员窗口聚合只算 10 分钟内', ledger.memberUsed('prj_m', 'm1', 10 * 60 * 1000, now) === 400000);
  check('不同成员互不污染', ledger.memberUsed('prj_m', 'm2', 10 * 60 * 1000, now) === 100000);

  // ── 时钟回拨：now 早于库内最新扣费 → 以最新扣费为基准 ──
  const future = now + 3600 * 1000;
  ledger.ensureBucket('prj_clock');
  ledger.recordRound({ projectId: 'prj_clock', taskId: 'c1', tokens: 700000, at: future });
  check('最新扣费时间为回拨基准', ledger.effectiveNow('prj_clock', now) === future);
  check('回拨后额度不凭空恢复', ledger.available('prj_clock', now) === 3000000 - 700000);

  // ── tick：判定 + 回调恢复（账本不直接改任务表）──
  const resumedCalls = [];
  const t1 = ledger.tick('prj_warn', { now, resumeTasks: (pid, limit) => { resumedCalls.push([pid, limit]); return 2; } });
  check('tick 满足恢复条件时回调并回报恢复数', t1.resume === true && t1.resumed === 2 && resumedCalls[0][0] === 'prj_warn');
  const t2 = ledger.tick('prj_sus', { now, resumeTasks: () => 99 });
  check('tick 未满足条件不触发恢复', t2.resume === false && t2.resumed === 0);
  const t3 = ledger.tick('prj_warn', { now });
  check('无回调时只判定不报错', t3.resume === true && t3.resumed === 0);

  // ── 未知桶：不崩，按不可派发处理 ──
  check('未知项目 available=0 / beforeDispatch 拒绝',
    ledger.available('prj_none', now) === 0 && ledger.beforeDispatch('prj_none', now).allow === false);

  // ── 更新配置白名单 ──
  const updated = ledger.updateBucket('prj_a', { totalLimit: 5000000, tier: 'large', bogus: 1 });
  check('updateBucket 只写白名单字段', updated.totalLimit === 5000000 && updated.tier === 'large');

  db.close();
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  if (fail > 0) process.exit(1);
})().catch((e) => {
  console.error('T6-3 测试异常：', e);
  process.exit(1);
});
