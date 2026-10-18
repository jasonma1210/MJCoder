#!/usr/bin/env node
// P2-7「执行后告知」行为回归（第二轮审查认定：导出了可测函数却零测试）
//
// 被测对象：main/approval.js 的 notifyExecuted / buildExecutionNotice / reversibilityOf
// 四条「不发」是设计边界，每条都对应一个必须守住的场景；一条「发」证明机制可用。
// 判据：把任一分支删掉或语义改反，本套件必须变红（已验证：把 enabled 判断去掉即红）。
import {
  notifyExecuted, buildExecutionNotice, reversibilityOf, setNoticeSink,
} from '../main/approval.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── 四条不发 ────────────────────────────────────────────
// 注意：必须用 auto-safe（不弹卡）才能区分「偏好关闭」与「本次弹过卡」——
// 若用默认 on-request，write_file 本就会走弹过卡分支返回 null，去掉 enabled 判断也不会红（哑断言）。
check('① 偏好关闭（默认）→ 不发，行为与改造前一致（用不弹卡档位隔离本分支）',
  notifyExecuted({ enabled: false, tool: 'write_file', args: { path: 'a' }, approvalMode: 'auto-safe', ok: true, ms: 1 }) === null);

check('② 只读动作 → 不发（否则每次 read/grep 都刷一条，通知立刻变噪声）',
  notifyExecuted({ enabled: true, tool: 'read_file', args: { path: 'a' }, ok: true }) === null);

check('③ L1 高危 → 不发（通知不能替代阻断；应仍按审批档执行前确认）',
  notifyExecuted({ enabled: true, tool: 'shell', args: { command: 'rm -rf /tmp/x' }, ok: true }) === null);

check('④ 本次弹过卡 → 不发（用户刚点过确认，再发是打扰）',
  notifyExecuted({ enabled: true, tool: 'mcp__demo__write', args: {}, approvalMode: 'on-request', ok: true }) === null);

// ── 一条「发」：低危 L2 + auto-safe（不弹卡）→ 必须发 ─────────────────
const sent = [];
setNoticeSink((n) => sent.push(n));
const notice = notifyExecuted({
  enabled: true, tool: 'write_file', args: { path: 'a.txt' }, approvalMode: 'auto-safe', ok: true, ms: 24,
});

check('低危 L2 + auto-safe → 发出 1 条通知',
  !!notice && sent.length === 1 && sent[0] === notice);
check('通知形状：type/textKey/level/ok/ms 齐全',
  notice?.type === 'approval_notice'
  && notice?.textKey === 'approval.notice.executed'
  && notice?.level === 'L2'
  && notice?.ok === true
  && notice?.ms === 24,
  JSON.stringify(notice));
check('主进程不硬编码用户可见文案：textKey 必须存在（UI 走 i18n）',
  typeof notice?.textKey === 'string' && notice.textKey.length > 0);
check('耗时缺失时为 null，不编造 0',
  buildExecutionNotice({ tool: 'write_file', level: 'L2', ok: true }).ms === null);

// ── 可补偿性：结论与文案必须自洽 ─────────────────────────
const rvWrite = reversibilityOf('write_file', 'L2');
const rvGit = reversibilityOf('git_checkout', 'L2');
const rvMcp = reversibilityOf('mcp__x__y', 'L3');
check('本机文件写 → 可补偿，且文案点出修复方式（不出现「不可」类反向措辞）',
  rvWrite.reversible === true && rvWrite.note.length > 0 && !/不可/.test(rvWrite.note), JSON.stringify(rvWrite));
check('git_checkout → 不可补偿（丢弃未提交改动无法找回）',
  rvGit.reversible === false, JSON.stringify(rvGit));
check('MCP 工具 → 不可补偿（写外部系统，本机无法回滚）',
  rvMcp.reversible === false, JSON.stringify(rvMcp));
check('未登记 L2 工具：布尔与文案一致（历史缺陷：false + 「通常可回退」）',
  (() => {
    const rv = reversibilityOf('some_unknown_write_tool', 'L2');
    return rv.reversible === true && !/不可/.test(rv.note);
  })());
check('未登记 L1/L3 工具：保守判不可补偿',
  reversibilityOf('some_unknown_l3', 'L3').reversible === false);

// ── sink 抛错绝不影响执行结果 ────────────────────────────
setNoticeSink(() => { throw new Error('sink boom'); });
let threw = false;
let out;
try {
  out = notifyExecuted({ enabled: true, tool: 'write_file', args: {}, approvalMode: 'auto-safe', ok: true, ms: 5 });
} catch { threw = true; }
check('sink 抛错被吞掉：通知失败不影响主流程，且仍返回通知对象',
  threw === false && !!out && out.type === 'approval_notice');
setNoticeSink(null);

console.log(`\napproval-notice: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;
