// 第八轮 B-20 / 决策 D-806：子代理结论回传的**可回取性**
//
// 缺陷背景（角度 B 实测）：
//   `spawn_subagent` 的产出形状是 `{ ok, objective, tokens_used, result: '<长结论>', ... }`。
//   而 `summarizeToolOutput` 的字段白名单只有 `stdout` / `content` —— `result` 不在其中。
//   于是子代理长结论既不折叠、也不落盘，直接被后面的 `truncateToolResult` 腰斩：
//   5 万 token 的结论 → 前 15000 字符，**尾部永久丢失、无从取回**。
//   （`SUBAGENT_DEFAULT_BUDGET = 50000` 闸的是子代理**生成侧**，与回传长度是两件事 ——
//    把两者混为一谈，正是这条缺陷被漏掉的原因。）
//
// 修复纪律（重要，别按「加个截断」去改）：
//   **已经有截断了，缺的是落盘可取回。** 本套件锁的就是这一点：
//   超阈值 → 头尾保留 + 原文落盘 + 提示路径；模型可用 read_file 取回尾部。
//
// 本套件锁四件事：
//   ① 超阈值（> TOOL_RESULT_MAX_CHARS）的 `result` 被摘要化，且提示里有可读的落盘路径；
//   ② 该路径**真实存在**且内容 = 原文全文（尾部真的能取回，不是只给个安慰字符串）；
//   ③ 经 truncateToolResult 后仍不超 TOOL_RESULT_MAX_CHARS（不再二次腰斩）；
//   ④ 无损行为不变：≤ 阈值（含原本能完整进上下文的 8k~15k 段）一律原样返回，不落盘。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  summarizeToolOutput,
  truncateToolResult,
  TOOL_RESULT_MAX_CHARS,
  TOOL_OUTPUT_SAVE_THRESHOLD,
} from '../agent-core/index.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// 造一段「首尾可辨识」的长结论，便于验证尾部真的取回
function makeLongConclusion(n) {
  return `HEAD-MARKER\n${'中间内容行。'.repeat(Math.ceil(n / 6)).slice(0, n - 40)}\nTAIL-MARKER-END`;
}

const longText = makeLongConclusion(TOOL_RESULT_MAX_CHARS + 5000);
const subagentResult = {
  ok: true,
  objective: '调研某个模块的实现细节',
  task_type: 'explore',
  tokens_used: 42000,
  result: longText,
};

assert.ok(longText.length > TOOL_RESULT_MAX_CHARS, '前置：原文必须超过截断阈值');

// ── ① 摘要化 + 落盘提示 ──────────────────────────────
const summarized = await summarizeToolOutput(subagentResult, 'spawn_subagent');
check('① 超阈值 result 被摘要化（不再是原样返回）',
  summarized && typeof summarized === 'object' && summarized.result !== longText);
check('① 保留了其它字段（ok/objective/tokens_used 不被摘要化带走）',
  summarized.ok === true && summarized.objective === subagentResult.objective
    && summarized.tokens_used === 42000);
check('① 头部与尾部都可辨识（头尾保留策略生效）',
  String(summarized.result).includes('HEAD-MARKER') && String(summarized.result).includes('TAIL-MARKER-END'),
  `len=${String(summarized.result).length}`);
check('① 摘要里给出「原文已落盘」的可读提示',
  /完整原文已落盘/.test(String(summarized.result)));

// ── ② 落盘文件真实存在且内容为原文全文 ─────────────────
const m = /完整原文已落盘：([^\s（]+)/.exec(String(summarized.result));
const savedPath = m && m[1];
check('② 提示里能解析出落盘路径', !!savedPath, savedPath || '(未解析到)');
let fileContent = '';
try { fileContent = savedPath ? fs.readFileSync(savedPath, 'utf8') : ''; } catch { fileContent = ''; }
check('② 落盘文件真实存在且内容 = 原文全文（尾部可回取）',
  fileContent === longText, `落盘长度=${fileContent.length} 原文长度=${longText.length}`);

// ── ③ 经 truncateToolResult 后不再二次腰斩 ─────────────
const finalContent = truncateToolResult(summarized);
check('③ 摘要化后经 truncateToolResult 仍不超上限（不再二次腰斩）',
  finalContent.length <= TOOL_RESULT_MAX_CHARS, `最终长度=${finalContent.length}`);
check('③ 最终内容仍可定位落盘路径（模型据此取回细节）',
  savedPath ? finalContent.includes(savedPath) : false);

// ── ④ 无损行为不变 ────────────────────────────────
const midText = 'x'.repeat(TOOL_RESULT_MAX_CHARS - 1000); // 落在 8k~15k 区间的「原本能完整进上下文」
const midRes = await summarizeToolOutput({ ok: true, result: midText }, 'spawn_subagent');
check('④ 未超阈值的长结论原样返回（不摘要、不落盘，无损行为不变）',
  midRes.result === midText);

const smallRes = await summarizeToolOutput({ ok: true, result: '短结论' }, 'spawn_subagent');
check('④ 短结论原样返回', smallRes.result === '短结论');

// stdout 通道的老阈值不受影响（8k 即摘要化，保持既有行为）
const stdoutRes = await summarizeToolOutput(
  { stdout: 'y'.repeat(TOOL_OUTPUT_SAVE_THRESHOLD + 100) }, 'shell');
check('④ stdout 仍按原阈值（TOOL_OUTPUT_SAVE_THRESHOLD）摘要化，未被本次改动波及',
  stdoutRes.stdout !== undefined && stdoutRes.stdout.length < TOOL_OUTPUT_SAVE_THRESHOLD + 100);

console.log(`\nsubagent-result-offload: ${pass}/${pass + fail} 通过`);
if (fail > 0) process.exitCode = 1;
