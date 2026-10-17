// X14：直连写通道的载荷边界校验出口（tool:git* / shell:open* / tool:gitCommit·gitAdd 共用）。
//
// 为什么单独一个出口、而不是每个 handler 里 try/catch 一遍：**返回约定错了比不校验更糟**。
// 这些通道的消费面有两类，混用会让「载荷不合法」在 UI 上显示成「功能不可用」：
//   · tool 型：调用方按 { stdout, stderr, error } 读错误（工具面板 / Agent 结果回传）
//   · 信封型：调用方按 r.ok 判成败（设置页、文件树、Diff 面板的动作通道）
// 校验本身只判形状与上限，业务语义（路径是否存在、仓库是否合法）交给下游实现。
const guard = require('./payloadGuard');

const toolShapeError = (message) => ({ stdout: '', stderr: message, error: message });
const envelopeError = (message) => ({ ok: false, error: message });

/**
 * 校验载荷。合法返回 null；非法返回该通道约定形状的错误对象（不抛异常）。
 * @param {object} payload 原始载荷
 * @param {object} spec assertStrings 规格（字段 → 长度上限 / optional / allowEmpty）
 * @param {{kind?: 'tool'|'envelope', arrayKey?: string, maxItems?: number}} [opts]
 *   kind     返回形状，默认 tool
 *   arrayKey 允许「字符串或数组」两种形态的字段名（如 files）：非此两类一律拒绝，是数组时再限条数
 */
function payloadShapeError(payload, spec, { kind = 'tool', arrayKey, maxItems = 5000 } = {}) {
  const shape = kind === 'envelope' ? envelopeError : toolShapeError;
  try {
    guard.assertStrings(payload || {}, spec);
    if (arrayKey) {
      const v = payload?.[arrayKey];
      if (v !== undefined && v !== null && typeof v !== 'string' && !Array.isArray(v)) {
        throw new Error(`${arrayKey} 必须是字符串或数组（收到 ${typeof v}）`);
      }
      if (Array.isArray(v)) guard.assertArray(payload, arrayKey, { max: maxItems });
    }
    return null;
  } catch (e) {
    return shape(e.message);
  }
}

module.exports = { payloadShapeError };
