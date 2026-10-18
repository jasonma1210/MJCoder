#!/usr/bin/env node
// V 层 L3（独立 verifier turn）单测（J3）
//
// 三条必须钉住的性质：
//   ① 输入裁剪：不把完整 args / 文件内容 / 工具输出原文送进第二次模型调用（隐私 + 成本）
//   ② 容错解析：模型爱给 ```json 围栏或前后加解释；FLAG 必须带理由，否则视为无效输出
//   ③ **fail-open**：无 chat / 抛错 / 超时 / 解析失败 一律 PASS + skipped ——
//      L3 依赖网络，基础设施失败不能把用户已完成的活判死（与 L1 的 fail-close 取向相反）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildL3Messages, parseL3Response, runL3Verify, formatL3Annotation,
  L3_MAX_REASONS, L3_MAX_INPUT_CHARS,
} from '../agent-core/verifierL3.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── ① 输入裁剪 ─────────────────────────────────
{
  const ledger = Array.from({ length: 120 }, (_, i) => ({
    name: 'shell', ok: true, paths: ['/a/b.js'], command: 'x'.repeat(400), args: { secret: 'sk-LEAK' },
  }));
  const msgs = buildL3Messages({
    finalText: 'y'.repeat(30000), ledger, diff: { statusPorcelain: ' M a.js', stat: '1 file' }, lastTestOutput: 'ok',
  });
  const user = msgs[1].content;
  // 关键：payload 必须是**合法 JSON**（超限时逐级缩字段，不截断字符串）
  const parsed = JSON.parse(user);
  check('system 携带判定规则', /只核对「有没有发生」/.test(msgs[0].content));
  check('payload 始终是合法 JSON（超限不靠 slice 硬截断）', typeof parsed === 'object' && parsed !== null);
  check('台账最多 60 条', (parsed.toolLedger || []).length <= 60);
  check('command 截断到 160', parsed.toolLedger.every((e) => e.command.length <= 160));
  check('最终回答被裁剪（不超过 12k）', parsed.finalAnswer.length <= 12000);
  check('**不进** args（防凭证/大正文进第二次调用）', !user.includes('sk-LEAK') && !user.includes('"args"'));
  check('整体不超过 MAX_INPUT_CHARS', user.length <= L3_MAX_INPUT_CHARS);
}

// ── ② 容错解析 ─────────────────────────────────
check('直接 JSON 可解析',
  parseL3Response('{"verdict":"PASS","reasons":[]}')?.verdict === 'PASS');
check('带 ```json 围栏可解析',
  parseL3Response('```json\n{"verdict":"FLAG","reasons":[{"claim":"改了 a.js","problem":"台账无写记录","severity":"high"}]}\n```')?.verdict === 'FLAG');
check('前后带解释文字也能取到 JSON',
  parseL3Response('我的判断如下：\n{"verdict":"PASS","reasons":[]}\n以上。')?.verdict === 'PASS');
check('FLAG 但无理由 → 视为无效（null）',
  parseL3Response('{"verdict":"FLAG","reasons":[]}') === null);
check('非法 verdict → null', parseL3Response('{"verdict":"MAYBE"}') === null);
check('非 JSON → null', parseL3Response('一切正常，没有问题') === null);
check(`reasons 最多 ${L3_MAX_REASONS} 条`, (() => {
  const many = Array.from({ length: 9 }, (_, i) => ({ claim: `c${i}`, problem: `p${i}`, severity: 'low' }));
  return parseL3Response(JSON.stringify({ verdict: 'FLAG', reasons: many })).reasons.length === L3_MAX_REASONS;
})());

// ── ③ fail-open ────────────────────────────────
{
  const r = await runL3Verify({ finalText: 'done', ledger: [] });
  check('未注入 chat → PASS + skipped(no_chat)', r.verdict === 'PASS' && r.skipped === true && r.reason === 'no_chat');
}
{
  const r = await runL3Verify({ finalText: 'done', ledger: [], chat: async () => { throw new Error('429 rate limited'); } });
  check('chat 抛错 → PASS + skipped 并保留原因',
    r.verdict === 'PASS' && r.skipped === true && /429/.test(r.reason));
}
{
  const r = await runL3Verify({ finalText: 'done', ledger: [], chat: async () => ({ content: '不是 JSON' }) });
  check('返回非 JSON → PASS + skipped(unparseable)',
    r.verdict === 'PASS' && r.skipped === true && r.reason === 'unparseable');
}
{
  const r = await runL3Verify({
    finalText: 'done', ledger: [], timeoutMs: 20,
    chat: () => new Promise((resolve) => setTimeout(() => resolve({ content: '{"verdict":"FLAG","reasons":[{"problem":"x"}]}' }), 100)),
  });
  check('超时 → PASS + skipped(timeout)', r.verdict === 'PASS' && r.skipped === true && /timeout/.test(r.reason));
}
{
  const r = await runL3Verify({
    finalText: '已修改 a.js', ledger: [],
    chat: async () => ({ content: '{"verdict":"FLAG","reasons":[{"claim":"改了 a.js","problem":"台账无成功写入","severity":"high"}]}' }),
  });
  check('正常 FLAG 透传理由', r.verdict === 'FLAG' && !r.skipped && r.reasons.length === 1 && r.reasons[0].severity === 'high');
}

// ── ④ 文案纪律 ─────────────────────────────────
{
  const a = formatL3Annotation([{ claim: '改了 a.js', problem: '台账无写记录', severity: 'high' }]);
  check('提示含「独立复核」且回显自述', /独立复核/.test(a) && /改了 a\.js/.test(a));
  check('提示不含「已验证正确」类断言', !/已验证正确|已通过验证|是正确的/.test(a));
  check('空理由 → 空提示', formatL3Annotation([]) === '');
}

// ── ⑤ 零依赖纪律 ───────────────────────────────
{
  const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const src = fs.readFileSync(path.join(DESKTOP, 'agent-core/verifierL3.js'), 'utf8');
  const stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  check('verifierL3.js 零 import / 零 require（chat 由宿主注入）',
    !/^\s*import\s/m.test(stripped) && !/\brequire\s*\(/.test(stripped));
}

console.log(`\nverifier-l3: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;
