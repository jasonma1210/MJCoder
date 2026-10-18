#!/usr/bin/env node
// 供应商错误翻译回归（2026-10-18）
//
// 背景：定时任务失败时，用户看到的第一手信息就是 run.error。供应商原文（英文短语）直接透出时，
// 用户只会以为「软件坏了」，而真实原因是模型服务商的内容安全策略在拒绝这次请求。
// 本套件锁三件事：认得出来、提示可执行、**原文永不丢**。
//
// 判据：把 describeRunError 改成只返回 hint（丢原文）、或把 content_filter 规则删掉、
// 或让未知错误也硬套一个提示 —— 本套件必须变红。
import { classifyProviderError, describeRunError } from '../main/providerErrors.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ① 用户实际撞到的那一条（原样）
const REAL = 'The request was rejected because it was considered high risk';
{
  const c = classifyProviderError(new Error(REAL));
  check('认得「内容安全拒绝」（用户实际撞到的原文）', c.kind === 'content_filter', c.kind);
  check('给出可执行建议（条数/主题/换模型），而不是只说失败了', /建议/.test(c.hint));
  const d = describeRunError(REAL);
  check('提示在前、原文在后（两者都要，原文用于排查）',
    d.error.startsWith('模型服务商') && d.error.includes(REAL), d.error.slice(0, 60));
  check('运行记录同时落 error_kind（便于统计「这类失败」有多少）', d.kind === 'content_filter');
}

// ② 另外三类常见失败
check('上下文超限', classifyProviderError("This model's maximum context length is 65536 tokens").kind === 'context_overflow');
check('限流', classifyProviderError('API 429: rate limit exceeded').kind === 'rate_limit');
check('凭证失效', classifyProviderError('API 401: invalid api key').kind === 'auth');
check('Azure content_filter 字段名也认', classifyProviderError('{"code":"content_filter","message":"blocked"}').kind === 'content_filter');

// ③ 不认识就不瞎猜
{
  const c = classifyProviderError('ECONNRESET socket hang up');
  check('未知错误不硬套提示（只显示原文，避免误导）', c.kind === 'unknown' && c.hint === '');
  const d = describeRunError('ECONNRESET socket hang up');
  check('未知错误也保留原文', d.error === 'ECONNRESET socket hang up' && d.kind === 'unknown');
}
check('超时不误判成内容安全', classifyProviderError('第 3 轮模型调用超时（120s）').kind === 'unknown');

// ④ 空输入不炸
{
  const d = describeRunError(null);
  check('空错误不抛异常且给出占位文案', d.kind === 'unknown' && d.error.length > 0);
}

console.log(`\nprovider-errors: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;
