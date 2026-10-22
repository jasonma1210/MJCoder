// DS Bots / T6-8：单 Bot 熔断（设计稿 §5.3）。
//
// 判据（三种状态，全部由 `quota_consumptions` 的 10 分钟窗口实时聚合得出）：
//   closed    : 窗口内该成员消耗 < 桶总量 30%（或 < 100k）        → 正常派发
//   open      : 窗口内 ≥ 30% 且 ≥ 100k                            → 该成员新任务 quota_suspend(breaker)
//   half_open : 熔断持续满 10 分钟后重新聚合                       → 放行一个探针任务；再超限 → 重新 open
//
// 为什么**不建 breaker 表**（§5.1 末条）：状态可由消耗流水推导，落表就出现第二事实源，
// 且重启后需要额外的一致性修复。本模块的内存态只记录「何时进入 open」与「探针是否已放行」，
// 进程重启即丢——重启后按当前窗口重新聚合，与设计「重启后自然恢复」一致。
//
// 隔离性（T6-8 验收）：判定粒度 = projectId + memberId。某一成员 open 只影响它自己的任务，
// 同组其他成员照常派发；无 owner_member_id 的普通单 Bot 任务不进入本闸（member 为空 → closed）。

const WINDOW_MS = 10 * 60 * 1000; // 10 分钟聚合窗口（§5.3）
const RATIO = 0.3;                // 占桶总量 30%
const MIN_TOKENS = 100000;        // 且绝对量 ≥ 100k

function keyOf(projectId, memberId) {
  return `${String(projectId || '').trim()}::${String(memberId || '').trim()}`;
}

/**
 * @param {object} opts
 * @param {object} opts.ledger QuotaLedger（memberUsed / getBucket 的唯一数据源）
 * @param {Function} [opts.now] 时钟注入（测试用）
 */
function createMemberBreaker({ ledger, now = Date.now } = {}) {
  if (!ledger) throw new Error('memberBreaker 需要 quotaLedger');
  // key → { openedAt, probeAt, probeUsed }。仅内存态，重启重新聚合。
  const episodes = new Map();

  /** 该成员当前的熔断态：closed / open / half_open（聚合判定，会推进内存状态机）。 */
  function state(projectId, memberId, at = now()) {
    const mid = String(memberId || '').trim();
    if (!mid) return 'closed';
    const bucket = ledger.getBucket(projectId);
    if (!bucket) return 'closed';
    const used = ledger.memberUsed(projectId, mid, WINDOW_MS, at);
    const threshold = bucket.totalLimit * RATIO;
    const over = used >= threshold && used >= MIN_TOKENS;
    const key = keyOf(projectId, mid);
    const ep = episodes.get(key);
    // 探针已产生消耗（窗口聚合值变化）→ 重新聚合：仍超限则重新 open（重新计时），否则彻底 closed。
    // 探针未产生消耗时窗口只会因老化而变小，同样会走 `!over` → closed，故不存在半开态卡死。
    if (ep && ep.probeAt != null && used !== ep.probeUsed) {
      if (over) { episodes.set(key, { openedAt: at, probeAt: null, probeUsed: 0 }); return 'open'; }
      episodes.delete(key);
      return 'closed';
    }
    if (!over) { episodes.delete(key); return 'closed'; }
    if (!ep) { episodes.set(key, { openedAt: at, probeAt: null, probeUsed: 0 }); return 'open'; }
    // 熔断持续满 10 分钟 → 半开，允许一个探针任务验证是否仍会打满
    return at - ep.openedAt >= WINDOW_MS ? 'half_open' : 'open';
  }

  /**
   * 该成员此刻是否允许再派发任务。
   * open → false（只锁本成员）；half_open → 每次半开周期只放行一个探针；closed → true。
   */
  function allow(projectId, memberId, at = now()) {
    const st = state(projectId, memberId, at);
    if (st === 'closed') return true;
    if (st === 'open') return false;
    const key = keyOf(projectId, memberId);
    const ep = episodes.get(key);
    if (!ep) return true;
    if (ep.probeAt != null) return false; // 本半开周期探针已放行，等它产生消耗后再聚合
    ep.probeAt = at;
    ep.probeUsed = ledger.memberUsed(projectId, memberId, WINDOW_MS, at);
    return true;
  }

  /** 测试/诊断用：当前记录（不触发聚合）。 */
  function peek(projectId, memberId) {
    return episodes.get(keyOf(projectId, memberId)) || null;
  }

  function reset() { episodes.clear(); }

  return { state, allow, peek, reset };
}

module.exports = { createMemberBreaker, WINDOW_MS, RATIO, MIN_TOKENS };
