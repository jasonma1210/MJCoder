'use strict';
// 供应商错误的「人话翻译」（纯函数，零依赖）。
//
// 为什么需要：定时任务是无人值守的，失败信息就是用户唯一的诊断入口。而供应商返回的原文
// 往往是英文短语（`The request was rejected because it was considered high risk`），
// 用户看到只会以为「软件坏了」，实际上这是**模型服务商的内容安全策略**在拒绝这次请求 ——
// 常见于抓取类任务：新闻/网页原文进了上下文，其中某段触发了对端的输入过滤。
//
// 纪律：**不吞原始错误**。提示在前、原文在后，两者都留在运行记录里，便于排查与反馈。
const RULES = [
  {
    kind: 'content_filter',
    re: /considered high risk|content[_ ]?filter|content management policy|safety (system|policy|violat)|flagged|敏感|违规内容|内容安全/i,
    hint: '模型服务商以「内容安全」拒绝了这次请求（不是程序错误，通常是检索到的原文触发的）。'
      + '建议：把条数从 100 降到 20–30、缩小主题范围，或换一个模型/供应商再跑。',
  },
  {
    kind: 'context_overflow',
    re: /context[_ ]length|maximum context|too long|reduce the length|exceed.{0,12}context|超出.{0,6}(上下文|长度)/i,
    hint: '上下文超出模型窗口。建议：降低单次抓取量，或在模型设置里选窗口更大的模型。',
  },
  {
    kind: 'rate_limit',
    re: /\b429\b|rate limit|too many requests|quota exceeded|限流/i,
    hint: '供应商限流或额度不足。建议：稍后重试，或检查该模型的配额。',
  },
  {
    kind: 'auth',
    re: /\b401\b|\b403\b|invalid api key|unauthor|KEY_MISSING|凭证/i,
    hint: '模型凭证失效或权限不足。建议：在模型设置里重新填写 API Key。',
  },
];

/**
 * classifyProviderError(errOrMsg) → { kind, hint, raw }
 *   kind ∈ content_filter | context_overflow | rate_limit | auth | unknown
 * 没命中任何规则时 hint 为空串（调用方就只显示原文，不做无根据的猜测）。
 */
function classifyProviderError(errOrMsg) {
  const raw = String(errOrMsg && errOrMsg.message ? errOrMsg.message : (errOrMsg || ''));
  for (const r of RULES) {
    if (r.re.test(raw)) return { kind: r.kind, hint: r.hint, raw };
  }
  return { kind: 'unknown', hint: '', raw };
}

/** 供运行记录直接落盘的 error 文本：提示在前，原文在后（原文永不丢） */
function describeRunError(errOrMsg) {
  const { kind, hint, raw } = classifyProviderError(errOrMsg);
  const body = String(raw || '未知错误').slice(0, 1500);
  return { kind, error: hint ? `${hint}\n（原始错误：${body}）` : body };
}

module.exports = { classifyProviderError, describeRunError, RULES };
