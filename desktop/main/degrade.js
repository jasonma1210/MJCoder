// 统一降级日志原语：把「可预期的环境不可达」与「真错误」在日志级别上彻底分开
// 背景：服务端未启动时，secrets / audit 反复刷屏且 0 行携带可行动信息；
//      而真正的 HTTP 状态异常反而只打 warn。严重性完全倒置，缺一个统一裁决点。
//
// 策略约定：
//   可降级（服务端不可达）→ 首条 warn + 后续同签名静默；提供 shouldSkip 让调用方直接短路
//   真错误（HTTP 4xx/5xx、解析失败、代码缺陷）→ 始终 console.error，不静默
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE']);

const seen = new Map(); // signature -> 是否已提示过
const stats = new Map(); // scope -> { skipped, failures }

/** 判断错误是否属于「可降级」：网络不可达或 fetch 层失败 */
function isDegradable(err) {
  if (!err) return false;
  const code = err.code || err.cause?.code || '';
  if (NETWORK_CODES.has(code)) return true;
  const msg = String(err.message || err);
  return /fetch failed|ECONNREFUSED|ENOTFOUND|socket hang up|network/i.test(msg);
}

/** 错误签名：用于去重，同签名只提示一次 */
function signatureOf(err) {
  return String(err?.code || err?.cause?.code || err?.message || err || 'unknown');
}

/**
 * 统一上报入口
 * @param {string} scope   来源标识，如 'audit' / 'secrets'
 * @param {Error}  err
 * @param {object} opts    { silent: true } 表示遥测类，完全静默仅计数
 * @returns {boolean}     true = 可降级（调用方可短路）
 */
function report(scope, err, opts = {}) {
  const degradable = isDegradable(err);
  if (!degradable) {
    // 真错误：始终报错，不受静默策略影响
    console.error(`[${scope}]`, err?.message || err);
    return false;
  }
  const sig = `${scope}:${signatureOf(err)}`;
  const bucket = stats.get(scope) || { skipped: 0, failures: 0 };
  bucket.failures++;
  stats.set(scope, bucket);

  if (opts.silent) {
    seen.set(sig, true); // 标记已提示，后续同类彻底静默
    return true;
  }
  if (!seen.has(sig)) {
    seen.set(sig, true);
    console.warn(`[${scope}] 服务端不可达，已降级：${signatureOf(err)}（后续同类不再提示）`);
  }
  return true;
}

/** 供调用方判断是否应跳过工作（如离线时不再发请求） */
function shouldSkip(scope) {
  return stats.has(scope);
}

/** 失败计数（用于退出时或周期性汇总） */
function failureCount(scope) {
  return stats.get(scope)?.failures || 0;
}

/** 成功后清零该 scope 的跳过状态（服务端恢复后重新允许尝试） */
function markHealthy(scope) {
  if (stats.delete(scope)) {
    for (const key of [...seen.keys()]) if (key.startsWith(`${scope}:`)) seen.delete(key);
    return true;
  }
  return false;
}

/** 供测试与诊断导出内部状态 */
function _snapshot() {
  return { seen: [...seen.keys()], stats: Object.fromEntries(stats) };
}

function _reset() {
  seen.clear();
  stats.clear();
}

module.exports = {
  NETWORK_CODES,
  isDegradable,
  signatureOf,
  report,
  shouldSkip,
  failureCount,
  markHealthy,
  _snapshot,
  _reset,
};