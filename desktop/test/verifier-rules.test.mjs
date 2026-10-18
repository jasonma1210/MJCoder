#!/usr/bin/env node
// V 层判定规则单测（P2-8：第二轮审查发现 verifier.js / verifyRun.js 零直接单测）
//
// 为什么必须有：六条规则、三层抑制、R3>R2 优先级、R5 的 diff=null→SKIP 语义，
// 此前全靠代码评审保证。这一层一旦悄悄改错，用户会看到「你说改了你没改」的假警报
// （或反过来漏掉真实问题），而任何现有套件都覆盖不到。
//
// 判据：删掉任一规则分支、或把 R5 的 skip 改成 block、或把 R4 的证据面收回只认工具，
// 本套件必须变红。
import {
  reconcile, buildLedgerEntry, formatAnnotation, normalizeLevel,
} from '../agent-core/verifier.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// 台账条目（形状与 normalizeLedger 对齐；i 会被丢弃，这里不传）
const E = (name, o = {}) => ({
  name,
  ok: o.ok !== false,
  ms: 5,
  round: 1,
  paths: o.paths || [],
  command: o.command || '',
  exitCode: o.exitCode === undefined ? null : o.exitCode,
});
const R = (finalText, ledger, diff = null, extra = {}) => reconcile({ finalText, ledger, diff, ...extra });
const hasRule = (r, id) => r.findings.some((f) => f.ruleId === id);

// ══ R1 claim_write_no_evidence ═══════════════════════════
{
  const r = R('已修改 a.js', []);
  check('R1 声称改文件但零写证据 → BLOCK',
    r.verdict === 'BLOCK' && hasRule(r, 'claim_write_no_evidence'));
}
{
  const r = R('已修改 a.js', [E('write_file', { paths: ['/w/a.js'] })]);
  check('R1 写工具成功且文件名对得上 → PASS', r.verdict === 'PASS');
}
{
  const r = R('已修改 a.js', [E('write_file', { paths: ['/w/b.js'] })]);
  check('R1 声称 a.js 但只写了 b.js → BLOCK（文件名不符）',
    r.verdict === 'BLOCK' && hasRule(r, 'claim_write_no_evidence'));
}
{
  // 仅 shell 写证据时**不追究文件名**（shell 无法可靠归因，追究会把真实改动误判）
  const r = R('已修改 a.js', [E('shell', { command: "sed -i 's/x/y/' a.js" })]);
  check('R1 仅 shell 就地编辑 → PASS（不追究文件名）', r.verdict === 'PASS');
}
{
  // mkdir / chmod / git checkout 不改内容，不算写证据（否则「mkdir 后自称改文件」漏判）
  const r = R('已修改 a.js', [E('shell', { command: 'mkdir -p build' })]);
  check('R1 mkdir 不算写证据 → BLOCK', r.verdict === 'BLOCK');
}
{
  const r = R('已修改 a.js', [E('write_file', { paths: ['/w/a.js'], ok: false })]);
  check('R1 写工具失败 → 不算证据 → BLOCK', r.verdict === 'BLOCK');
}
{
  const r = R('我看了下代码结构', []);
  check('R1 无声称 → PASS（不产生误报）', r.verdict === 'PASS' && r.findings.length === 0);
}

// ══ R2 / R3 claim_test_* ════════════════════════════
{
  const r = R('测试全部通过', []);
  check('R2 声称测试通过但没跑 → BLOCK', r.verdict === 'BLOCK' && hasRule(r, 'claim_test_no_run'));
}
{
  const r = R('测试全部通过', [E('shell', { command: 'npm test', exitCode: 0 })]);
  check('R2 跑了且成功 → PASS', r.verdict === 'PASS');
}
{
  const r = R('测试全部通过', [E('shell', { command: 'npm test', exitCode: 1 })]);
  check('R3 跑了但失败 → BLOCK，且归因是 R3 不是 R2',
    r.verdict === 'BLOCK' && hasRule(r, 'claim_test_but_failed') && !hasRule(r, 'claim_test_no_run'));
}
{
  // exitCode 缺失时退化看 ok
  const r = R('测试全部通过', [E('shell', { command: 'npx vitest', ok: false, exitCode: null })]);
  check('R3 exitCode 缺失时按 ok 判定（ok:false → BLOCK）',
    r.verdict === 'BLOCK' && hasRule(r, 'claim_test_but_failed'));
}

// ══ R4 claim_commit_no_evidence ═════════════════════
{
  const r = R('已提交', []);
  check('R4 声称提交但无证据 → BLOCK', r.verdict === 'BLOCK' && hasRule(r, 'claim_commit_no_evidence'));
}
{
  const r = R('已提交', [E('git_commit')]);
  check('R4 git_commit 工具成功 → PASS', r.verdict === 'PASS');
}
{
  // 第二轮审查修复：强模型常用 shell 提交，不认会让真实提交被误报 BLOCK
  const r = R('已提交', [E('shell', { command: 'git commit -m "fix: x"', exitCode: 0 })]);
  check('R4 shell 里的成功 git commit 也算证据 → PASS', r.verdict === 'PASS');
}
{
  const r = R('已提交', [E('shell', { command: 'git commit -m "x"', ok: false, exitCode: 1 })]);
  check('R4 shell 里 git commit 失败 → BLOCK', r.verdict === 'BLOCK');
}

// ══ R5 claim_changes_diff_empty ═════════════════════
{
  // 拿不到 diff（非 git / git 不可用）→ 只能 SKIP 单条，verdict 仍 PASS（能力缺失≠事实冲突）
  const r = R('已修改 a.js', [E('write_file', { paths: ['/w/a.js'] })], null);
  const skip = r.findings.find((f) => f.ruleId === 'claim_changes_diff_empty');
  check('R5 diff=null → 单条 SKIP，verdict 仍 PASS',
    r.verdict === 'PASS' && !!skip && skip.severity === 'skip');
}
{
  const r = R('已修改 a.js', [E('write_file', { paths: ['/w/a.js'] })], { statusPorcelain: '', stat: '' });
  check('R5 diff 有值但 status/stat 双空 → BLOCK',
    r.verdict === 'BLOCK' && hasRule(r, 'claim_changes_diff_empty'));
}
{
  const r = R('已修改 a.js', [E('write_file', { paths: ['/w/a.js'] })], { statusPorcelain: ' M a.js', stat: ' 1 file changed' });
  check('R5 工作区确有改动 → PASS', r.verdict === 'PASS');
}

// ══ R6 written_no_mention（warn，永不改 verdict）════════
{
  const r = R('全部搞定', [E('write_file', { paths: ['/w/a.js'] })]);
  const warn = r.findings.find((f) => f.ruleId === 'written_no_mention');
  check('R6 写了但总结没提 → WARN 且 verdict 仍 PASS',
    r.verdict === 'PASS' && !!warn && warn.severity === 'warn');
}
{
  const r = R('已修改 a.js，全部搞定', [E('write_file', { paths: ['/w/a.js'] })]);
  check('R6 总结提到文件名 → 不产生 warn',
    !r.findings.some((f) => f.ruleId === 'written_no_mention'));
}

// ══ 闸门：off / stopHookActive / no_ledger ════════════
check('level=off → SKIP(level_off)', (() => {
  const r = R('已修改 a.js', [], null, { level: 'off' });
  return r.verdict === 'SKIP' && r.reason === 'level_off';
})());
check('stopHookActive → SKIP（防续跑死循环）', (() => {
  const r = R('已修改 a.js', [], null, { stopHookActive: true });
  return r.verdict === 'SKIP' && r.reason === 'stop_hook_active';
})());
check('ledger=null（漏接台账）→ SKIP 并给出 no_ledger，绝不静默 PASS', (() => {
  const r = R('已修改 a.js', null);
  return r.verdict === 'SKIP' && r.reason === 'no_ledger';
})());

// ══ 抑制层：否定语境 / 建议语气 ═════════════════════
{
  const r = R('没有修改 a.js，只是看了一下', []);
  check('否定语境「没有修改」→ 不产生 write claim（不误报）', r.verdict === 'PASS');
}
{
  const r = R('建议修改 a.js 的空值处理', []);
  check('建议语气「建议修改」→ 被抑制（不误报）', r.verdict === 'PASS');
}

// ══ 边界与元数据纪律 ═══════════════════════════════
check('空文本 + 空台账 → PASS', R('', []).verdict === 'PASS');
check('normalizeLevel 只认小写枚举，其余一律 fail-safe 归 off',
  normalizeLevel('l9') === 'off' && normalizeLevel('L1') === 'off');
check('formatAnnotation 不含「已验证正确」类正面断言', (() => {
  const s = formatAnnotation([{ ruleId: 'claim_write_no_evidence', severity: 'block', reason: 'x' }]);
  // 注意：文案里有「也不代表改动是正确的」这种**否定**表述，属正确语义，不能误判
  return !/已验证正确|已通过验证/.test(s) && s.length > 0;
})());
check('buildLedgerEntry 只记白名单：不落 args 原文与输出，且命令里的凭证必须打码', (() => {
  const secret = 'sk-TOPSECRET-'.repeat(40);
  const e = buildLedgerEntry({
    name: 'shell', args: { command: `curl -H "Authorization: Bearer ${secret}" https://x` }, result: { stdout: secret, ok: true },
  });
  const dumped = JSON.stringify(e);
  return !dumped.includes('TOPSECRET')        // 命令里的 token 已脱敏（否则随 traces 落盘）
    && e.command.length <= 200
    && !('args' in e) && !('result' in e);
})());
check('buildLedgerEntry 的 paths 最多 8 条', (() => {
  const e = buildLedgerEntry({ name: 'shell', args: { command: `rm ${Array.from({ length: 20 }, (_, i) => `f${i}.txt`).join(' ')}` } });
  return e.paths.length <= 8;
})());

console.log(`\nverifier-rules: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;
