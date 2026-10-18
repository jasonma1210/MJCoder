#!/usr/bin/env node
// 熔断收尾文案回归（2026-10-18）
//
// 背景（用户实测）：任务跑完只看到「单任务 token 预算已用尽（…累计 50097 tokens…）」，
// 于是以为预算是 50k。真实情况是**上下文已到窗口且压不动**（历史里全是必留内容），
// 与「累计花费超预算」是两回事；而且定时任务无人值守，文案还让他「发送继续」——没有人能发。
//
// 判据：把 contextStuck 分支删掉（退回旧文案）、或让 unattended 仍出现「发送继续」、
// 或把窗口压不动说成「预算已用尽」—— 本套件必须变红。
import { buildExhaustedNotice } from '../agent-core/index.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const usage = { prompt_tokens: 48000, completion_tokens: 2097 }; // 用户实测那一次的用量

// ① 上下文压不动 + 无人值守（用户实际场景）
{
  const t = buildExhaustedNotice({ budgetKind: 'tokens', contextStuck: true, unattended: true, usage, tokenRescues: 1 });
  check('说清真实原因：上下文已到模型窗口、压不动',
    /上下文已到模型窗口/.test(t) && /压缩与硬截断/.test(t), t.slice(0, 40));
  check('不再谎称「token 预算已用尽」（用户会被 50k/200k 绕晕）', !/预算已用尽/.test(t));
  check('无人值守不出现「发送继续」（没有人能发）', !/发送「继续」/.test(t));
  check('给出可操作的下一步：分批 / 换窗口更大的模型',
    /分批/.test(t) && /窗口更大的模型/.test(t));
  check('保留累计用量（便于判断是不是真的烧多了）', /50097/.test(t));
}

// ② 同一原因，但有人值守 → 允许提示「继续」
{
  const t = buildExhaustedNotice({ budgetKind: 'tokens', contextStuck: true, unattended: false, usage });
  check('有人值守时保留「继续」这个动作', /「继续」/.test(t));
}

// ③ 真的是预算耗尽（非压不动）+ 无人值守
{
  const t = buildExhaustedNotice({ budgetKind: 'tokens', contextStuck: false, unattended: true, usage, tokenRescues: 2 });
  check('预算耗尽分支仍明说「token 预算已用尽」', /token 预算已用尽/.test(t));
  check('预算耗尽 + 无人值守：不出现「发送继续」', !/发送「继续」/.test(t));
  check('预算耗尽 + 无人值守：给出缩小范围/调高预算', /缩小任务范围/.test(t));
}

// ④ 墙钟超时
{
  const t = buildExhaustedNotice({ budgetKind: 'rounds', wallClockHit: true, runWallClockMs: 61 * 60 * 1000, usage });
  check('墙钟超时按分钟数说清（不与轮次预算混淆）', /61 分钟/.test(t) && !/轮次预算/.test(t));
}

// ⑤ 轮次预算
{
  const t = buildExhaustedNotice({ budgetKind: 'rounds', unattended: false, usage });
  check('轮次预算耗尽如实说明', /执行轮次预算已用尽/.test(t) && /「继续」/.test(t));
}

// ⑥ 边界
{
  const t = buildExhaustedNotice({});
  check('无参数调用不抛且给出占位文案', typeof t === 'string' && t.length > 0);
  const withText = buildExhaustedNotice({ finalText: '已抓到 12 条', budgetKind: 'tokens', contextStuck: true, unattended: true, usage });
  check('已有部分产出时保留它（不覆盖模型写的正文）', withText.startsWith('已抓到 12 条'));
}

console.log(`\nexhausted-notice: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;
