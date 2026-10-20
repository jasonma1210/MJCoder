#!/usr/bin/env node
/**
 * harness-r7 事实核验断言集（只读检查器）
 * 用法: node check.mjs <ROOT>
 * 退出码: 0 = 全部通过（基线绿）; 1 = 至少一条 FAIL
 * 只读：绝不写入被检查目录。
 *
 * 每条断言带类型标记（详见下方 TAG）：
 *   [invariant]   改前改后都必须 PASS。红了 = 真回归。
 *   [defect-Fxxx] 缺陷存在性断言：改前 PASS（缺陷真实存在），修复后 FAIL（缺陷已消失）。
 * 汇总按类型分组，读的人不必再从 `FAIL=N` 里猜「几条是修复证据、几条是坏」。
 *
 * ══ 已知口径（读汇总前必看）════════════════════════════════════════════════
 *
 * 1) 结局有三类 + 一类跳过，不是两类：
 *      PASS     判定成立。
 *      FAIL     判定不成立。defect 类 FAIL = 修复证据；invariant 类 FAIL = 真回归。
 *      BLOCKED  前置断言失败 → 本条**无法验证**。它计入 FAIL 总数与失败清单（绝不让它消失），
 *               但**不计入** defect 的「已修复」统计 —— 否则「没验成」会被读成「缺陷已消失」。
 *      SKIP     显式跳过，不计入 PASS。
 *
 *    【SKIP 的语义】**无法验证，不等于通过**。一条断言之所以被 SKIP，是因为它的判据前提
 *    已被产品变更消灭（例：旧实现不存在，无从取样）；保留其编号是为了让总数稳定、
 *    防止将来新断言悄悄占用旧号。**凡 SKIP 或 BLOCKED 必须同时出现 `⚠ 未执行` 行**，
 *    否则等于静默跳过 —— 本文件因此不肯用「悄悄不执行」来变绿。
 *
 * 2) 断言总数自检（T01）：`EXPECTED_ASSERTION_TOTAL` 是手写常量，与实际执行数不等即 FAIL。
 *    【该常量的语义】**= 已注册断言条数**，不是「期望通过条数」，也不是任何通过率目标。
 *    改它的**唯一合法理由**是「新增/删除断言」，且**必须与断言增删出现在同一次 diff 里**；
 *    单独一次提交只改这个数字 = 有人在动验收的手脚，按回归处理。
 *    为什么必须有：条件分支里的断言（`if (m) { ok('A02b', ...) }`）在条件不成立时
 *    **既不 PASS 也不 FAIL 也不 SKIP** —— 总数静默变少，读的人只会以为「用例调整了」。
 *    逐条修补挡不住将来新写的条件分支，总数对不上能一次抓住全部。增删断言后**必须同步
 *    本常量**，这是本脚本的强制纪律（SELF-2 证明该闸不是恒真）。
 *
 * 3) A09b / A10b 的「通过」**不代表缺陷仍在**。这两条的字面量在修复后仍然成立，因为修复走了
 *    另一条路径（setProtocolVersion 注入；schema「只判不截断」）。它们登记为 defect 类，会
 *    固定出现在 `[defect] 通过` 名单里 —— 那是**断言口径过期**，不是漏修。
 *    真证据是正向断言：A09e（版本确有到达传输层的路径）、A10e（三道闸在位）。
 *
 * 4) 【契约变更台账】—— 断言口径的每一次变更都必须在此留痕，并注明触发提交。
 *    为什么：本项目吃过「口径过期后，后人把旧期望当回归、去改实现」的亏（A01b/A02a 就差点被
 *    当成缺陷继续修）。台账是唯一解药：让人先看到"这条为什么变了"，而不是先看到"它红了"。
 *
 *      · B1-B-05（3af9093）MCP 工具名拼名/反解改为**可逆编码**：分隔符从裸 `__` 改为 `%5F%5F`。
 *        → A01b 的原字面量期望 `mcp__my__svc__x` **按设计作废**，退役为**行为断言**
 *          （`decodeToolName(toToolDefs(样本,'x')[0].name)` 必须还原 `{server: 样本, tool: 'x'}`）。
 *          谁若把它改回"冻结某个具体字符串"，就是把守卫降级成记录现状。
 *        → 新增 A01d：「服务名片段不得含裸 `__`」= 分隔符唯一性的真守卫（比冻结字面量抗格式演进）。
 *        → A02a 由 `expect=true` 的**墓碑**（记的是修复前存在，永远只能红）反转为 `expect=false`
 *          的**护栏**（不得再出现手写 `split('__')`）。墓碑只能证明过去，护栏才能拦住回滚。
 *        → 原 A02e 与新的 A01b 是同一条行为断言，**已并入 A01b**，不再重复计数。
 *      · 断言总数（EXPECTED_ASSERTION_TOTAL）随上述增删同步：80 → 81。
 *
 * 5) 检索类断言一律在 `stripComments()` 后的**代码正文**上计数：注释里出现标识符既能让
 *    「应当不存在」的断言假红（谎报没修），也能让「应当存在」的断言假绿（注释喂饱）。
 *    当前**没有**任何断言刻意扫全文（A13 读的是 JSON 数据、A17d2 读的是 git 索引，都不属
 *    「代码文本」口径）；若将来确实要断言「注释里不得出现某措辞」，必须就地标注
 *    `[全文口径]` 并写明理由，否则下一个人会把它当漏改再扫一遍。
 *
 * 6) `SIMULATE_DROPPED_ASSERTION` 仅用于**演示**「总数闸能红」，正常必须为 false。
 *    **CI 中禁止设置它为 true**：那等于静默关掉一条断言（A14b），而本脚本存在的意义正是
 *    不让断言被静默关掉。任何人提交时把它留成 true，就是在关掉自己的验收。
 *
 * 7) 【定位：本脚本是**审计报告**，不是门禁 —— 它**刻意**不进 `npm test`】
 *    `exit=1` 是本脚本的设计结果，**不是失败信号**：当前 FAIL 全部属于 [defect] 类，而 defect
 *    断言的语义是「FAIL = 缺陷已修复」，所以 exit=1 恰恰意味着「这些缺陷都修好了」。
 *    把一个 `exit=1` 表示成功的脚本挂进 `npm test`，等于把整套通过条件反过来 —— 那不叫接线，叫埋雷。
 *    （事实补充：`run-all.mjs` 的发现范围是 `desktop/test/*.test.{js,mjs}` + 两个 smoke，
 *      `GATES` 只挂 `eval:check`，本文件不在其中。这是**有意保留**的现状，不是待修缺口。）
 *
 *    **唯一可当门禁用的信号，是汇总第二行 `[invariant] 失败: 0`**：
 *      · 非 0 → 真回归 / 扫描器失效，必须立刻查代码（这是本脚本唯一需要人立即动作的输出）；
 *      · 其余 FAIL（defect = 修复证据）与 BLOCKED（无法验证）都属**预期**，不代表"改坏了"。
 *    因此本脚本的「常年红」不是噪声：红的是预期项，而真正要盯的那一行写在最显眼的位置。
 *
 *    若将来真要把它变成门禁，**前置条件是先把 defect 断言改成正常语义**（修好 = 通过）；
 *    否则接线只会让 `npm test` 永久红。这条**优先级高于**第 8 条列出的所有待办。
 *
 * 8) 【下批待办（台账，均未做）】
 *    ① **defect 断言语义改造**（优先级最高）：把「FAIL = 已修复」改为「修好 = PASS」的正常语义。
 *       这是第 7 条所述「本脚本有可能变成门禁」的**唯一前置条件**，会动到全部 defect 类断言。
 *    ② 「源码 `check(` 调用数自洽断言」：根治「有人删了断言又同步改常量」。需要设计，
 *       因为用正则数自己源码里的断言调用时，会把该正则自身也算进去（自指）。
 *    ③ 「不得出现 X」类断言，必须配一条**能匹配 X 任意写法**的检测，否则它守的只是
 *       「上次那个写法」—— 本轮 A02a 就是这样假绿过一次（详见其就地注释）。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2];
if (!ROOT) { console.error('usage: node check.mjs <ROOT>'); process.exit(2); }

// ── 断言类型登记（本轮新增：让脚本能自我解释「红的是什么」）─────────────────
//
// 每条断言属于且只属于两类之一：
//
//   [invariant]     不变量 —— 改前改后都必须 PASS。阳性对照、结构性事实、契约常量属此类。
//                   它红了 = **真回归**，必须去查代码，不能改断言。
//   [defect-Fxxx]   缺陷存在性断言 —— 记录 HEAD `924909c` 时点的缺陷**事实**。
//                   改前应 PASS（证明缺陷真实存在），修复后应 FAIL（证明缺陷已消失）。
//                   它红了通常意味着「修好了」，不是「改坏了」。
//
// 为什么必须分开：原来的 67 条断言里两类混在一起，汇总只报 `FAIL=6`，读的人无法区分
//   「6 条修复证据」与「6 条真回归」——上一轮就有人把预期反转误判成「改坏了」。
//   分组后判读口径变成两句话：`[invariant] 失败` 必须为 0；`[defect] 失败` 越大说明修得越多。
//
// 缺省规则：未登记 → 按 [invariant] 处理。宁可让新写的缺陷断言以「回归」面貌出现（会被追），
//   也不要让缺陷断言默认混进不变量里冒充绿灯。
const TAG = {
  'A02b': 'defect-F005', 'A02c': 'defect-F005',   // MCP 名称反解错服务
  'A03': 'defect-F003', 'A04c': 'defect-F003',    // supportsToolCall 无执行层消费
  'A06': 'defect-F002', 'A07': 'defect-F002',     // 工具矩阵未守审批/可补偿
  'A08a': 'defect-F006', 'A09a': 'defect-F006', 'A09b': 'defect-F006', // Streamable HTTP 缺协议版本头
  'A10a': 'defect-F007', 'A10b': 'defect-F007', // 定义侧无守卫
  'A10c': 'defect-F007', 'A10d': 'defect-F007',
  'A15a': 'defect-F013',                          // 握手自报版本 '1.0'
  'A16a': 'defect-F014', 'A16c': 'defect-F014',   // resources/prompts/tasks 未接
};

let pass = 0, fail = 0, skipped = 0, blocked = 0;
const failures = [];   // 全部失败 id（含 BLOCKED）
const invFailed = [];  // invariant 失败 → 真回归
const defFailed = [];  // defect 失败 → 预期反转（修复证据）
const defPassed = [];  // defect 通过 → 缺陷仍在（或是「修好了但断言口径已过期」，需人工核对）
const blockedIds = []; // 前置断言失败 → 无法验证（既不是修复证据，也不是回归）
let totalCheckOk = true; // T01 结论，供汇总的「判读」引用（T01 自己也算一条断言）
const stats = { invariant: { pass: 0, fail: 0 }, defect: { pass: 0, fail: 0 }, blocked: 0 };

function typeOf(id) { return (TAG[id] || 'invariant'); }

function tally(id, good) {
  const t = typeOf(id);
  const kind = t.startsWith('defect') ? 'defect' : 'invariant';
  stats[kind][good ? 'pass' : 'fail']++;
  if (good) pass++; else { fail++; failures.push(id); }
  if (kind === 'invariant') { if (!good) invFailed.push(id); }
  else if (good) defPassed.push(`${id}(${t})`); else defFailed.push(`${id}(${t})`);
  return t;
}

function ok(id, desc, actual, expect) {
  const good = JSON.stringify(actual) === JSON.stringify(expect);
  const t = tally(id, good);
  if (good) console.log(`[PASS] ${id} [${t}] ${desc} | actual=${JSON.stringify(actual)}`);
  else console.log(`[FAIL] ${id} [${t}] ${desc} | actual=${JSON.stringify(actual)} expect=${JSON.stringify(expect)}`);
}
function okTrue(id, desc, cond, info) { ok(id, desc, !!cond, true); if (info !== undefined && !cond) console.log(`       ↳ ${info}`); }
function okAbsent(id, desc, n) { ok(id, desc, n, 0); }
function okPresent(id, desc, n) { const g = n > 0; ok(id, desc, g, true); if (!g) console.log(`       ↳ 实际命中 ${n}（应 >0）`); }
/** 跳过：**不计入 PASS**（避免"无法判定"被读成"通过"）。 */
function skipAssert(id, desc, why) {
  skipped++;
  console.log(`[SKIP] ${id} [${typeOf(id)}] ${desc} | ${why}`);
}
/**
 * 无法验证：前置断言失败（例：A02a 正则失配，导致 A02b/A02c 无从判定）。
 *
 * 为什么不能「不出声」：条件分支里的断言一旦不执行，就**既不 PASS 也不 FAIL 也不 SKIP**，
 *   总数静默变少；读的人看到「PASS 从 66 变 64」只会以为是用例调整，而实际是两条检查
 *   被悄悄拿掉了。这是最坏的失效方式 —— 它替一次**没有发生**的检查背书。
 * 为什么也不能直接记成普通 FAIL：defect 类的 FAIL 语义是「缺陷已消失 = 修复证据」。
 *   「没验成」被算进修复证据，等于用没做的检查去证明修好了。故单列 BLOCKED：
 *   计入失败总数与清单，但不动 defect 的通过/失败统计。
 */
function blockedAssert(id, desc, why) {
  blocked++; stats.blocked++;
  fail++; failures.push(`${id}(BLOCKED)`); blockedIds.push(id);
  console.log(`[FAIL] ${id} [${typeOf(id)}] ${desc} | BLOCKED: 前置断言失败，本条无法验证 → ${why}`);
}

// ══ 顶层容错：跑不完也必须给出「执行中断」汇总，不许只吐一段栈 ══════════════════
//
// 实测过的坏样子：目标文件缺失时，裸 `read()` 在 A05 处抛 ENOENT，进程直接倒掉 ——
//   **汇总行数 = 0**，A06~A18/SELF/T01 一行都没输出。看报告的人只会以为「脚本坏了」，
//   而不是「判据没过」。两者是完全不同的结论，绝不能长得一样。
// 因此：捕获未处理异常 → 仍然输出一行汇总（形如「执行中断（已执行 N 条…）」）+ 一行原因
//   + 一行「这不是判据红」的判读，然后 exit 1。栈默认不打印（栈留给显式 --trace）。
const TRACE = process.argv.includes('--trace');
let interrupted = false;
function emitInterrupt(err) {
  if (interrupted) return;   // 只出一次，避免 uncaughtException + unhandledRejection 双触发
  interrupted = true;
  const reason = String((err && err.message) || err).split('\n')[0];
  console.log('');
  console.log(`=== 汇总: 执行中断（已执行 ${pass + fail + skipped} 条：PASS ${pass} / FAIL ${fail}`
    + `${skipped ? ` / SKIP ${skipped}` : ''}）===`);
  console.log(`[中断原因] ${reason}`);
  console.log('[判读] 这不是判据红，是脚本**没跑完**：中断点之后的断言一条都没执行，'
    + '不能据此判断任何缺陷状态；先修目标文件/路径，再重跑。');
  if (TRACE) console.log(err && err.stack ? err.stack : '');
  else console.log('（要栈请加 --trace；默认不打印，避免被误读成脚本故障）');
  process.exit(1);
}
process.on('uncaughtException', emitInterrupt);
process.on('unhandledRejection', emitInterrupt);

const P = (...p) => path.join(ROOT, ...p);
const read = (rel) => fs.readFileSync(P(rel), 'utf8');
const exists = (rel) => fs.existsSync(P(rel));

function walk(dir, exts) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  (function rec(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (/^(node_modules|dist|build|\.git)$/.test(e.name)) continue; rec(p); }
      else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
    }
  })(dir);
  return out;
}
/** 在给定根目录集合中统计正则唯一命中（第一捕获组） */
function uniqMatch(dirs, re, exts = ['.js', '.mjs', '.jsx', '.ts', '.tsx']) {
  const set = new Set();
  for (const d of dirs) for (const f of walk(d, exts)) {
    for (const m of read_(f).matchAll(re)) set.add(m[1]);
  }
  return set;
}
/**
 * 跨文件统计命中数。scope='code' 时先过 stripComments（**默认**：断言对象是代码）；
 * scope='raw' 仅用于刻意要连注释一起扫的断言。
 * 返回 { n, files } —— files>0 是「本次真的读到了文件」的证据，供非空前置断言用。
 */
function countMatches(dirs, re, exts = ['.js', '.mjs', '.jsx', '.ts', '.tsx'], scope = 'code') {
  let n = 0, files = 0;
  for (const d of dirs) for (const f of walk(d, exts)) {
    files++;
    const src = read_(f);
    const c = (scope === 'code' ? stripComments(src) : src).match(re);
    if (c) n += c.length;
  }
  return { n, files };
}
function read_(abs) { return fs.readFileSync(abs, 'utf8'); }
/**
 * 读文件并**显式断言其非空**（前置断言）。
 *
 * 为什么必须显式：`okAbsent` 在「文件读不到/是空的」时会读到空串 → 命中数 0 → 直接 PASS。
 *   于是「被检查对象整个消失」反而让缺陷断言变绿。非空前置让这种情况变成 FAIL。
 * 返回去注释正文（scope='code'）或原文（scope='raw'）。
 */
function readGuarded(id, rel, scope = 'code') {
  const p = P(rel);
  let src = '';
  if (fs.existsSync(p)) src = read_(p);
  okTrue(id, `前置：${rel} 存在且非空（空/缺 = FAIL，不是「没有匹配所以通过」）`,
    src.trim().length > 0, `实际 ${src.length} 字符`);
  return scope === 'code' ? stripComments(src) : src;
}

/**
 * 去掉 `//` 与 `/* *\/` 注释（保留换行），只留代码正文。
 *
 * 为什么需要：本仓注释密度很高，注释里大量出现断言要搜的标识符（例如 mcpToolDefs.mjs 的
 * 段首注释就写着 `detectPromptInjection`、「不加 MCP-Protocol-Version」）。若在原文上计数，
 * 一条「改前无守卫」的缺陷断言会被**注释**喂成 FAIL —— 那等于用注释判定事实。
 * 所有"检索类"断言一律在去注释后的正文上计数。
 *
 * 已知边界（不影响本仓现状）：不做正则字面量识别，正则里出现未转义的 `//` 会被误判为注释。
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl === -1 ? src.length : nl; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e === -1 ? src.length : e + 2; continue; }
    out += c; i++;
  }
  return out;
}
/**
 * 在**代码正文**（自动去掉注释）上统计正则命中数。
 *
 * 修正记录：本函数此前名叫「代码正文」但**根本没去注释**（`src.match` 直接跑在原文上），
 * 于是 A10c/A10d 这两条「definition 侧无守卫」的缺陷断言其实是被段首注释喂成 FAIL 的 ——
 * 结论恰好对、理由完全是错的。现在真去注释（A10c 25→17、A10d 16→9，结论不变）。
 * 参数一律传**原文**；已持有去注释正文的调用方用 countIn()，避免二次 strip。
 */
function countCode(rawSrc, re) { return (stripComments(String(rawSrc).replace(/^\uFEFF/, '')).match(re) || []).length; }
/** 在**已去注释**的正文上计数（调用方已持有 code，不再二次 strip）。 */
function countIn(codeSrc, re) { return (String(codeSrc).match(re) || []).length; }
/** desktop/main 下全部 JS/MJS 源码（rel + 去注释正文），供"跨文件存在性"断言用。 */
function mainSources() {
  return walk(MAIN, ['.js', '.mjs']).map((f) => ({
    rel: path.relative(ROOT, f),
    raw: read_(f),
    code: stripComments(read_(f)),
  }));
}

const MAIN = P('desktop/main');
const REND = P('desktop/renderer/src');
const TEST = P('desktop/test');
const agentCore = 'desktop/agent-core/index.js';
const matrixRel = 'desktop/test/tool-registration-matrix.test.mjs';

console.log(`=== harness-r7 事实核验断言集 | ROOT=${ROOT} ===\n`);

// ══ 断言总数闸（结构性加固的核心）═══════════════════════════════════════════
//
// 为什么需要：「断言消失」（`if (cond) { ok('X', ...) }` 条件不成立 → 该断言不进输出、
//   不算 PASS 也不算 SKIP）**无法靠逐条修补根治** —— 补完 A02、A17，下一个人还会写出新的
//   条件分支。逐条盯着防不住，但「实际执行数 ≠ 登记数」能一次性抓住全部消失。
// 纪律：增删断言后**必须**同步本常量。若你正想「改常量太麻烦，先放着」—— 那正是它要拦的人。
const EXPECTED_ASSERTION_TOTAL = 81; // 实测回填：81 条（含 SKIP，不含 T01 自身）。80→81 = 新增 A01d/A01z、A02e 并入 A01b
// 演示开关（正常跑必须 false）：设 true 则 A14b 不执行，用于实测 T01 真的会红。
const SIMULATE_DROPPED_ASSERTION = false;
/** 总数闸判定（抽成纯函数，SELF-2 才能证明它不是恒真表达式）。 */
function totalMatches(executed, expected) { return executed === expected; }

// ── A01/A02  F-005 MCP 名称往返（真跑 ESM） ─────────────────────────────
//
// 口径变更见文件头【契约变更台账】。这里只重复一句最重要的：
//   A01b 的原字面量期望 `mcp__my__svc__x` 已随 B1-B-05（3af9093）**按设计作废**，
//   它退役为**行为断言**；A02a 由「（改前）存在手写 split」的墓碑反转为「不得存在」的护栏。
const SAMPLE_SERVER = 'my__svc';   // 全文件唯一来源，A01b/A01d/A01z 共用，避免字面量各自漂移
let toToolDefs = null, codec = null, impErr = null, codecErr = null;
try {
  toToolDefs = (await import(P('desktop/shared/mcpToolDefs.mjs'))).toToolDefs;
} catch (e) { impErr = e.message.split('\n')[0]; }
try {
  codec = await import(P('desktop/shared/mcpNameCodec.mjs'));
} catch (e) { codecErr = e.message.split('\n')[0]; }

// 断言移到 try 之外：原先 A01a/A01b/A01c 挤在同一个 try 里，A01b 抛错会触发 catch **再记一次
//   A01a** → A01a 被重复计数、总数被污染。拆开后 A01a 只可能记一次（顺带修掉，未额外加断言）。
ok('A01a', 'toToolDefs 可导入', typeof toToolDefs, 'function');
if (impErr) console.log(`       ↳ import 失败：${impErr}`);

// A01z [invariant] 前置：样本名必须被**当前**名称闸接受。
//   为什么必须有：名称闸刚从入口下移到 connectMcpServer 单点（B3#12）。任何一次收紧都可能让
//   A01b/A01d 的样本名**失效**；那时它们不是「红」，而是「无意义」——必须在组变空之前先红。
const sampleBuilt = (() => { try { return codec.buildToolName(SAMPLE_SERVER, 't'); } catch { return null; } })();
const sampleSafe = (() => { try { return !!sampleBuilt && codec.isEncodedNameSafe(sampleBuilt); } catch { return false; } })();
okTrue('A01z', `前置：样本服务名 '${SAMPLE_SERVER}' 必须被当前名称闸接受`
  + "（isEncodedNameSafe(buildToolName(样本,'t'))）",
  sampleSafe, `buildToolName → ${sampleBuilt}；闸拒绝或抛错（${codecErr || 'n/a'}）→ A01b/A01d 成立与否无意义`);

// A01b [invariant] 行为断言：真实拼名 → 真实反解 → 必须还原。
//   为什么不再冻结字面量：字面量只能记录"当时长这样"，编码一演进就过期；往返可逆才是契约本身。
const roundTrip = (() => {
  if (!toToolDefs || !codec) return null;
  try {
    const nm = toToolDefs(SAMPLE_SERVER, [{ name: 'x' }])[0].function.name;
    const dec = codec.decodeToolName(nm);
    return dec ? [dec.server, dec.tool] : null;
  } catch { return null; }
})();
ok('A01b', `拼名 ↔ 反解往返可逆：decodeToolName(toToolDefs('${SAMPLE_SERVER}','x')[0].name) 还原 server/tool`,
  roundTrip, [SAMPLE_SERVER, 'x']);

// A01c 正常名（不含 `__`）仍往返 —— 证明编码没把普通名字改坏（回归保护）
ok('A01c', '正常名 mySvc 往返可逆',
  toToolDefs ? toToolDefs('mySvc', [{ name: 'x' }])[0].function.name : 'IMPORT_FAILED',
  'mcp__mySvc__x');

// A01d [invariant] 分隔符唯一：服务名**片段**里不得残留裸 `__`（否则 `mcp__<s>__<t>` 的切分歧义回归）
const encSeg = (() => { try { return codec.encodeServerSegment(SAMPLE_SERVER); } catch { return 'ERR'; } })();
okTrue('A01d', `服务名片段不得含裸 \`__\`：encodeServerSegment('${SAMPLE_SERVER}') ≠ 原值且不匹配 /__/`,
  encSeg !== SAMPLE_SERVER && !/__/.test(encSeg), `实际片段 = ${encSeg}`);

// ── A02  agent-core 侧反解：护栏 + 回滚时才取样 ──────────────────────────
{
  const src = stripComments(exists(agentCore) ? read(agentCore) : '');
  // 检测器必须匹配**断言声称的东西**，否则就是「措辞比检测宽」的假绿。
  //   实测教训（本轮）：最初只认旧句式 `/const server = ..., toolName = ...;/`，于是按裁决注入
  //   `const [sx, ...tx] = name.split('__');` 时 **A02a 仍 PASS** —— 断言说"不得出现手写 split"，
  //   检测器却只认一种历史写法。现在两条都查：
  //     ① 旧句式（历史形状，便于回滚时取样）
  //     ② 任何手写 `.split('__')`（不限定变量名、写法）
  const legacyExpr = src.match(/const server = ([^,]+), toolName = ([^;]+);/);
  const bareSplit = src.match(/\.split\(\s*(['"])__\1\s*\)/g) || [];
  // A02a [invariant] 护栏，不是墓碑：
  //   原写法 `okTrue('A02a', '（改前）存在手写 split', !!m)` —— expect=true 记的是**修复前**的状态，
  //   修复后它永远只能红，除了逼人改断言以外没有任何守卫作用。
  //   反转成 expect=false 之后：将来谁把手写 split 加回来（回滚、或在新文件里重写一份），它会红。
  okTrue('A02a', "agent-core 不得再出现手写 `split('__')` 反解（B1-B-05 已由 mcpNameCodec.decodeToolName 取代）",
    !legacyExpr && bareSplit.length === 0,
    `旧句式命中 = ${!!legacyExpr}；手写 .split('__') 命中 ${bareSplit.length} 处`
    + `${bareSplit.length ? `（${bareSplit.slice(0, 3).join(' , ')}）` : ''} —— 任一为真即回滚，先查 agent-core 最近改动`);
  if (legacyExpr) {
    // 只有回滚时才取样：此时旧实现确实在，可以展示它会把名字解成什么错值。
    const m = legacyExpr;
    const parts = 'mcp__my__svc__x'.split('__');
    ok('A02b', '（历史）若手写反解回滚：server 被解成 my（工具被静默路由到另一服务）', eval(m[1]), 'my');
    ok('A02c', '（历史）若手写反解回滚：toolName 被解成 svc__x', eval(m[2]), 'svc__x');
  } else {
    // 旧实现不存在 → 本条「无法验证」。
    //   裁决落地记录：曾用 SKIP，但 SKIP 在当前接线下的**可见性为零**（见文件头第 7 条：
    //   本脚本不在 run-all 基线内，没人会看到它的 SKIP）。按"宁可常年红，也不要静默跳"，
    //   改回 BLOCKED：计入 FAIL 与失败清单，代价是脚本永远不可能全绿 —— 这是**故意**的，
    //   它时刻提醒"有两条判据其实没验过"，而不是让它们消失在 SKIP 里。
    blockedAssert('A02b', '（历史）手写反解取样 server',
      '旧反解表达式已不存在（A02a 已断言其为禁止项）→ 无样本可测');
    blockedAssert('A02c', '（历史）手写反解取样 toolName',
      '旧反解表达式已不存在（A02a 已断言其为禁止项）→ 无样本可测');
    // 额外打一行 `⚠ 未执行`：一旦本脚本被登记进 run-all 的 GATES，run-all 第 94 行的
    //   `/⚠.*(跳过|未执行)/` 收集器就能把它收进「未执行」清单（格式现已对齐，接线未做）。
    console.log('⚠ 未执行：A02b/A02c（手写反解取样）—— 判据前提已被产品变更消灭，'
      + '本轮**未验证**，不等于通过；编号保留以稳住总数');
  }
}

// ── A03/A04  F-003 supportsToolCall 无执行层消费 ─────────────────────────
//
// 口径：断言对象是**代码**（「agent-core 是否消费 supportsToolCall」）。此前读原文，
//   于是 agent-core 段首写着「supportsToolCall 全仓只出现在…」的大段注释也在计数里（16 命中，
//   去注释后 15）。方向后果：把实现**注释掉**而不删，原文计数仍 >0 → 缺陷断言 FAIL →
//   被读成「已修复」。这正是用注释判定事实，必须去注释。
{
  const ac = readGuarded('A03n', agentCore);   // 空/缺文件 → 前置 FAIL，A03 不再是「没匹配所以通过」
  okAbsent('A03', '（改前）agent-core 未出现 supportsToolCall', countIn(ac, /supportsToolCall/g));
  okTrue('A04a', 'agent-core 仍构造 allTools', /let allTools\s*=/.test(ac));
  okTrue('A04b', 'agent-core 仍每轮发送 tools: allTools', /tools:\s*allTools/.test(ac));
  const pilot = [];
  for (const d of [P('desktop')]) for (const f of walk(d, ['.js', '.mjs', '.jsx', '.ts', '.tsx'])) {
    if (/supportsToolCall/.test(stripComments(read_(f)))) pilot.push(path.relative(ROOT, f));
  }
  okTrue('A04c', '（改前）supportsToolCall 仅出现在 modelsFile/localData/UI/测试（非 agent-core）',
    !pilot.some((x) => x.includes('agent-core')), `命中文件: ${pilot.join(' | ')}`);
  console.log(`[INFO] A04c' supportsToolCall 命中文件（去注释口径） = ${pilot.join(' , ')}`);
}

// ── A05  F-004 数字员工：renderer 是否真的有 rolePreset 消费（我方的反向断言） ──
// 口径：全部按**代码**计。这一组是「链路每一环都真的接了」的阳性断言，读原文时
//   一句「// 由 ChatArea 监听 mjcode:enable-expert 写入 sessionExtras」就能把 A05c/A05d 喂饱。
{
  const engineChain = [
    read('desktop/renderer/src/components/EcosystemModal.jsx'),
    read('desktop/renderer/src/App.jsx'),
    read('desktop/renderer/src/components/ChatArea.jsx'),
    read('desktop/renderer/src/hooks/useAgentRun.ts'),
  ].map(stripComments).join('\n');
  okTrue('A05a', 'EcosystemModal 真的调用 bridge ecosystemEmployeeRuntime',
    /api\?\.ecosystemEmployeeRuntime|ecosystemEmployeeRuntime\(\{/.test(engineChain));
  okTrue('A05b', '→ dispatch mjcode:recruit-expert', /mjcode:recruit-expert/.test(engineChain));
  okTrue('A05c', '→ App dispatch mjcode:enable-expert', /mjcode:enable-expert/.test(engineChain));
  okTrue('A05d', '→ ChatArea 监听写入 sessionExtras', /mjcode:enable-expert/.test(engineChain) && /setSessionExtras|sessionExtras/.test(engineChain));
  okTrue('A05e', '→ useAgentRun 把 rolePreset 放进 agent:run payload',
    /rolePreset:\s*sessionExtras\?\.expert\?\.runtime/.test(engineChain));
  const ar = stripComments(read('desktop/main/agentRunner.js'));
  okTrue('A05f', '→ agentRunner 消费 payload.rolePreset', /payload\.rolePreset/.test(ar));
  okTrue('A05g', '→ preload 暴露 ecosystemEmployeeRuntime',
    /ecosystemEmployeeRuntime/.test(stripComments(read('desktop/main/preload.js'))));
  okTrue('A05h', '→ 主进程 handle ecosystem:employeeRuntime',
    /ipcMain\.handle\(\s*'ecosystem:employeeRuntime'/.test(stripComments(read('desktop/main/ipc/ecosystem.js'))));
}

// ── A06/A07  F-002 工具矩阵未守审批/可补偿 ───────────────────────────────
{
  // 前置：矩阵文件存在且非空。否则 A06 会在空串上得 0 → 假绿（「没有匹配所以通过」）。
  const mx = readGuarded('A06n', matrixRel);
  okAbsent('A06', '（改前）tool-registration-matrix 未读 TOOL_LEVEL/REVERSIBILITY/toolLevel',
    countIn(mx, /TOOL_LEVEL|REVERSIBILITY|toolLevel/g));
  okTrue('A07', '（改前）approval.js 未登记一律默认 L2',
    /TOOL_LEVEL\[tool\]\s*\|\|\s*'L2'/.test(stripComments(read('desktop/main/approval.js'))));
  // 阳性对照也走代码口径：注释里写满 approval 字样同样能把这条喂绿。
  okPresent('A06p', '阳性对照：矩阵确实引用了 approval 相关（APPROVAL_TOOLS 等）',
    countIn(mx, /APPROVAL_TOOLS|approval/gi));
}

// ── A08/A09  F-006 Streamable HTTP 缺 MCP-Protocol-Version ───────────────
//
// 本块是第七轮修复中**空过（vacuous pass）最严重**的一处，修法记在这里备查：
//
//   原实现把扫描片段钉死在「mcpClient.js 里 `async send(payload, requestId)` 之后 900 字符」。
//   B1-B-04 把整个 HTTP 传输族（createHttpTransport / consumeSse / createSseTransport）
//   搬到了 mcpHttpTransport.js，mcpClient.js 里**已不存在**该签名 →
//   `indexOf` 返回 -1 → `slice(-1, 899)` 得到空串（实测 length=0）→
//     · A08a 断言「头里**没有** MCP-Protocol-Version」，对一个空串当然成立 → **假绿**；
//     · A08b/A08c（阳性对照）因空串而红 —— 说明「防止 A08a 读错位置空过」的机制本身坏了。
//   这是最坏的一种绿灯：它替一次**根本没有发生**的检查背书，比没有校验更危险。
//
// 修法不是「把路径改到新文件」（下次再拆分就再坏一次），而是三件事：
//   ① **自动发现**扫描范围：desktop/main 下任何出现 streamable-HTTP POST 标记
//      （`application/json, text/event-stream`）的文件都纳入，不再写死文件名清单；
//   ② 定位锚点从「具体函数签名」换成「**结构**」：抽出 `headers: { ... }` 对象字面量
//      （大括号配对、跳过字符串与注释），只保留含该 Accept 标记的那一个 ——
//      它**就是**「HTTP 请求头组装段」本身，跟函数怎么命名、放哪个文件无关；
//   ③ 新增自检 A08z/A08y：「扫描片段非空且 >200 字符」「含标记的文件都必须抽到 header 段」。
//      片段为空 = 扫描再次失效 → **直接 FAIL**。这样下一次重构把代码搬走时，坏的是自检，
//      不会再伪装成 A08a 的绿灯。
const HTTP_ACCEPT_MARKER = /application\/json,\s*text\/event-stream/;
// 自检开关：临时设为 ['desktop/main/mcpClient.js'] 可复现"只读老文件"的空过（验证 A08z 真会红）。
// 正常跑必须保持 null（= 全目录自动发现）。
const HTTP_SCAN_FILES = null;

/** 从 `{` 处向后做大括号配对，返回对象字面量文本（跳过字符串与注释）。 */
function extractBalancedObject(src, openBraceIdx) {
  let depth = 0;
  let quote = null;
  for (let i = openBraceIdx; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl === -1 ? src.length : nl; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e === -1 ? src.length : e + 1; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(openBraceIdx, i + 1); }
  }
  return src.slice(openBraceIdx);
}

function httpHeaderSegments() {
  const files = HTTP_SCAN_FILES
    ? HTTP_SCAN_FILES.map((f) => P(f)).filter((f) => fs.existsSync(f))
    : walk(MAIN, ['.js', '.mjs']);
  const segs = [];
  const markerFiles = [];
  const segFiles = [];
  for (const f of files) {
    const raw = read_(f);
    if (!HTTP_ACCEPT_MARKER.test(raw)) continue;
    const rel = path.relative(ROOT, f);
    markerFiles.push(rel);
    for (const m of raw.matchAll(/\bheaders\s*:\s*\{/g)) {
      const obj = extractBalancedObject(raw, m.index + m[0].length - 1);
      if (!HTTP_ACCEPT_MARKER.test(obj)) continue; // 别的 fetch 的 headers，不是 streamable-HTTP 那个
      segs.push(`/* ${rel} */\n${obj}`);
      if (!segFiles.includes(rel)) segFiles.push(rel);
    }
  }
  return { hdrSeg: segs.join('\n'), markerFiles, segFiles };
}

{
  const cli = read('desktop/main/mcpClient.js');
  const { hdrSeg, markerFiles, segFiles } = httpHeaderSegments();
  console.log(`[INFO] A08' HTTP 请求头组装段来源 = ${segFiles.join(' , ') || '(空)'}；片段 ${hdrSeg.length} 字符`);

  // ── 自检（本任务核心交付）：空过必须变成失败，而不是变成绿灯 ──
  okTrue('A08z', '自检：HTTP 头扫描片段非空且 >200 字符（片段空 = 扫描失效，直接 FAIL）',
    hdrSeg.length > 200, `片段长度 ${hdrSeg.length}；含标记的文件 = ${markerFiles.join(' , ') || '(无)'}`);
  okTrue('A08y', '自检：含 streamable-HTTP 标记的文件均已抽到 header 段（防再次拆分后漏扫）',
    markerFiles.length >= 1 && markerFiles.every((f) => segFiles.includes(f)),
    `含标记文件 ${markerFiles.length} 个，抽到 header 段 ${segFiles.length} 个`);

  // 口径：抽出的 header 对象里可能夹注释，一律去注释后再判（A08a 是缺陷断言，
  //   注释里写一句「这里不加 MCP-Protocol-Version」就会把它判成「已修复」）。
  const hdrCode = stripComments(hdrSeg);

  // [defect-F006] 缺陷存在性：改前「头里没有 MCP-Protocol-Version」为真；B1-B-04 修好后这里应 **FAIL**。
  // 若它仍 PASS，只有两种可能：扫描又空过了（看 A08z），或这条头真的还没加。
  okAbsent('A08a', '（改前）HTTP transport 请求头无 MCP-Protocol-Version',
    countIn(hdrCode, /MCP-Protocol-Version|Mcp-Protocol-Version/gi));
  // [invariant] 阳性对照：A08a 必须"读到了真正的 header 区块"，否则 A08a 的 PASS 毫无意义。
  okTrue('A08b', '阳性对照：请求头确有 Mcp-Session-Id（证明读到的是 header 区块）', /Mcp-Session-Id/.test(hdrCode));
  okTrue('A08c', '阳性对照：请求头确有 Accept: application/json, text/event-stream',
    /Accept\s*:\s*['"`]?application\/json,\s*text\/event-stream/.test(hdrCode));

  okTrue('A09a', '（改前）server.protocolVersion 被保存（有值可发但没发）', /server\.protocolVersion\s*=/.test(stripComments(cli)));
  okTrue('A09b', '（改前）protocolVersion 未进入 createHttpTransport 传参',
    !/createHttpTransport\(\{[^}]*protocolVersion/s.test(stripComments(cli)));
  // F-006 修复的**正向**证据（必须补，否则 A09b 会误导：修复走的是 setProtocolVersion 注入，
  //  于是 A09b 至今**仍然 PASS**，只看它的人会以为 F-006 没修）。扫描面取全 desktop/main，
  //  不写死文件名 —— 握手逻辑若再搬家，这条仍然成立。
  const main = mainSources();
  okTrue('A09e', '协商版本确有到达 transport 的路径（构造传参 或 setProtocolVersion 注入）',
    main.some(({ code }) => /setProtocolVersion\s*\(\s*peerVersion\s*\)/.test(code)
      || /createHttpTransport\(\{[^}]*protocolVersion/s.test(code)),
    '两条路径都不存在 → 版本仍到不了传输层，F-006 未修');
  const proto = stripComments(read('desktop/main/mcpProtocol.js'));
  okTrue('A09c', 'mcpProtocol 声明支持 2025-11-25', /2025-11-25/.test(proto));
  okTrue('A09d', 'mcpProtocol 声明支持 2025-06-18', /2025-06-18/.test(proto));
}

// ── A10/A11  F-007 定义侧无守卫 / 结果侧有守卫 ───────────────────────────
{
  const defs = read('desktop/shared/mcpToolDefs.mjs');
  const defsCode = stripComments(defs);
  // A10a/A10b 是**改前事实**（缺陷存在性）：
  //   A10a 修好后转红（description 已截断，不再原样透传）；
  //   A10b 修好后**仍然绿** —— B1-B-06 对 inputSchema 的设计是「只判不截断」（截断 schema
  //        = 非法 schema = 调用必失败），所以字面量 `parameters: t.inputSchema` 保留了下来。
  //   只看 A10b 会误判「F-007 没修」，故补 A10e 作正向证据（见下）。
  okTrue('A10a', '（改前）definition 侧原样透传 description', /description:\s*t\.description/.test(defsCode));
  okTrue('A10b', '（改前）definition 侧原样透传 inputSchema', /parameters:\s*t\.inputSchema/.test(defsCode));
  // 判定面必须跟上**实现的实际命名**，否则闸加上了断言也不会红（上一轮就是这样假绿的）：
  //   旧正则只认 guardUntrusted|detectInjection|.slice(0,NNN)|maxLength|MAX_DESC；
  //   B1-B-06 用的是 detectPromptInjection / MAX_TOOL_DESCRIPTION_CHARS / MAX_INPUT_SCHEMA_BYTES /
  //   contextBudget / __untrusted__ / truncateDescription / inspectToolDefinition —— 一个都没命中。
  const GATE_RE = new RegExp([
    'guardUntrusted', 'detectInjection', 'detectPromptInjection',
    '\\.slice\\(\\s*0,\\s*\\d{3,}', 'maxLength', 'MAX_DESC\\b',
    'MAX_TOOL_DESCRIPTION_CHARS', 'MAX_INPUT_SCHEMA_BYTES', 'MAX_INPUT_SCHEMA_DEPTH',
    'contextBudget', '__untrusted__', 'truncateDescription', 'inspectToolDefinition',
    'isBlockedToolDef', '__blocked__',
  ].join('|'), 'g');
  // 注：这两条此前用 countCode 但该函数**没去注释**（见函数注释的修正记录），
  //   实际是被 mcpToolDefs 段首那段「本段讨论 detectPromptInjection / __untrusted__ …」的
  //   注释喂成 FAIL 的 —— 结论碰巧对，理由完全错。现在真去注释：A10c 25→17、A10d 16→9，
  //   结论不变（F-007 确已修，真证据是 A10e）。
  okAbsent('A10c', '（改前）definition 侧无守卫/长度闸/不可信标记', countCode(defs, GATE_RE));
  const cache = read('desktop/main/mcpToolCache.js');
  okAbsent('A10d', '（改前）mcpToolCache 无不可信守卫 / 无定义预算闸', countCode(cache, GATE_RE));
  const ac = read(agentCore);
  okPresent('A11', '阳性对照：工具结果侧确有 detectInjection', countIn(stripComments(ac), /detectInjection/g));
  // F-007 修复的正向证据：三道闸（描述截断 / schema 只判不截断 / 不可信标记）都在位。
  okTrue('A10e', '定义侧确有预算闸：description 截断 + schema 只判不截断 + __untrusted__ 标记',
    /truncateDescription\s*\(/.test(defsCode) && /inspectToolDefinition\s*\(/.test(defsCode)
      && /__untrusted__/.test(defsCode),
    '三道闸缺任一 → F-007 未完整修');
}

// ── A12  F-009 run-all 的 suite/gate 结构 ────────────────────────────────
{
  const ra = stripComments(read('desktop/test/run-all.mjs'));
  okTrue('A12a', "SMOKE = ['smoke-load.mjs','render-smoke.mjs'] 两项",
    /const SMOKE = \[\s*'smoke-load\.mjs',\s*'render-smoke\.mjs'\s*\]/.test(ra), 'SMOKE 字面量不匹配');
  okTrue('A12b', 'GATES 只有 eval:check 一项（门不是套件）',
    /const GATES = \[\s*\{ label: 'eval:check/.test(ra) && countIn(ra, /eval:check/g) >= 1);
  okTrue('A12c', '套件发现用 /\\.test\\.(js|mjs)$/', /\\\.test\\\.\(js\|mjs\)|\\\.test\\\.\(js/.test(ra) || /\.test\.\(js\|mjs\)/.test(ra));
  const smokes = ['smoke-load.mjs', 'render-smoke.mjs'].filter((f) => exists(`desktop/test/${f}`));
  ok('A12d', '两个 smoke 文件真实存在', smokes.length, 2);
}

// ── A13  F-010 生态资产数量（注意 JSON 顶层结构） ────────────────────────
{
  const c = JSON.parse(read('ecosystem/mcp-connectors.json'));
  const w = JSON.parse(read('ecosystem/mcp-connectors-workbuddy.json'));
  const e = JSON.parse(read('ecosystem/digital-employees.json'));
  const sk = fs.readdirSync(P('ecosystem/skills'), { withFileTypes: true }).filter((x) => x.isDirectory());
  okTrue('A13a', 'mcp-connectors.json 顶层是 Object（不是数组）', !Array.isArray(c));
  ok('A13b', '精选 connectors = 77', Array.isArray(c) ? c.length : c.connectors.length, 77);
  ok('A13c', 'workbuddy connectors = 214', Array.isArray(w) ? w.length : w.connectors.length, 214);
  ok('A13d', 'digital employees = 51', e.length, 51);
  ok('A13e', 'skills 目录 = 100', sk.length, 100);
}

// ── A14  F-011 三处可证伪（证据 1 / 3 可自动化） ─────────────────────────
{
  const sp = JSON.parse(read('server/package.json'));
  okTrue('A14a', 'server 依赖含 express', !!(sp.dependencies && sp.dependencies.express));
  // A14b 是本文件的「演示靶子」：SIMULATE_DROPPED_ASSERTION=true 时它不执行，
  //   用来实测文件末尾的 T01 总数闸真的会红（见该常量注释）。正常跑恒为 false。
  if (!SIMULATE_DROPPED_ASSERTION) {
    okAbsent('A14b', 'server 依赖无 spring', JSON.stringify(sp.dependencies).toLowerCase().split('spring').length - 1);
  }
  const dag = stripComments(read('desktop/main/orchestrator/dag.js'));
  okTrue('A14c', 'DAG MAX_TASKS = 8', /const MAX_TASKS = 8;/.test(dag));
  okTrue('A14d', 'DAG MIN_TASKS = 2', /const MIN_TASKS = 2;/.test(dag));
  okTrue('A14e', 'DAG MAX_DEPS = 4', /const MAX_DEPS = 4;/.test(dag));
}

// ── A15  F-013 握手自报版本 ──────────────────────────────────────────────
{
  const proto = stripComments(read('desktop/main/mcpProtocol.js'));
  okTrue('A15a', "（改前）CLIENT_INFO version 硬编码 '1.0'",
    /CLIENT_INFO\s*=\s*Object\.freeze\(\{[^}]*version:\s*'1\.0'/s.test(proto));
  ok('A15b', 'desktop/package.json version', JSON.parse(read('desktop/package.json')).version, '0.6.1-beta');
  okTrue('A15c', 'mcpClient 每次 initialize 都发 clientInfo',
    /clientInfo:\s*\{\s*\.\.\.CLIENT_INFO\s*\}/.test(stripComments(read('desktop/main/mcpClient.js'))));
}

// ── A16  F-014 resources/prompts/tasks 未接（带阳性对照） ────────────────
{
  const reNeg = /resources\/list|resources\/read|prompts\/list|prompts\/get|tasks\/get/g;
  const scan1 = countMatches([MAIN, REND], reNeg);
  // 前置：扫描面非空。目录改名/删掉时 n1=0 会让 A16a 直接 PASS —— 那是最典型的空过
  //   （「什么都没读到」被读成「什么都没命中」）。阳性对照 A16b 只能证明"读到了一些文件"，
  //   不能证明"扫的是该扫的地方"，所以这里单独把文件数钉成断言。
  okTrue('A16n', '前置：A16 扫描面非空（desktop/main + renderer/src 源文件 ≥ 100）',
    scan1.files >= 100, `实际扫到 ${scan1.files} 个源文件；为 0 说明 A16a 的 0 命中毫无意义`);
  okAbsent('A16a', '（改前）main+renderer 无 resources/prompts/tasks 原语', scan1.n);
  const scan2 = countMatches([MAIN, REND], /tools\/list|tools\/call/g);
  okPresent('A16b', '阳性对照：同一批文件确有 tools/list|tools/call', scan2.n);
  const defs = readGuarded('A16o', 'desktop/shared/mcpToolDefs.mjs');
  okAbsent('A16c', '（改前）mcpToolDefs 未消费 outputSchema/structuredContent/taskSupport',
    countIn(defs, /outputSchema|structuredContent|taskSupport|icons/g));
}

// ── A17  §1.2 契约数量 ───────────────────────────────────────────────────
{
  let TOOL_CHANNELS, NOTIFY_CBS, REQUEST_CBS, regErr = null;
  try {
    const { createRequire } = await import('node:module');
    const require2 = createRequire(import.meta.url);
    const reg = require2(P('desktop/main/engineProcess/registry.js'));
    TOOL_CHANNELS = reg.TOOL_CHANNELS; NOTIFY_CBS = reg.NOTIFY_CBS; REQUEST_CBS = reg.REQUEST_CBS;
  } catch (e) { regErr = e.message.split('\n')[0]; }
  // 清扫记录（本轮）：原先 else 分支只补了一条 A17a —— registry require 失败时
  //   A17b/A17c **既不出现也不计 SKIP**，总数静默少 2。同样的病，同样的治法：BLOCKED 出声。
  if (!regErr) {
    ok('A17a', 'TOOL_CHANNELS = 52', TOOL_CHANNELS.length, 52);
    ok('A17b', 'NOTIFY_CBS = 8', NOTIFY_CBS.length, 8);
    ok('A17c', 'REQUEST_CBS = 1', REQUEST_CBS.length, 1);
  } else {
    ok('A17a', 'registry.js 可 require（=52 的值因此无从判定）', `ERR: ${regErr}`, 52);
    blockedAssert('A17b', 'NOTIFY_CBS = 8', `registry require 失败：${regErr}`);
    blockedAssert('A17c', 'REQUEST_CBS = 1', `registry require 失败：${regErr}`);
  }

  const mainFiles = walk(MAIN, ['.js', '.mjs']);
  // A17d 原为硬等位「= 137」。它每新增一个源文件就失效一次（B1-B-04 抽出 mcpHttpTransport.js
  // 就把它从绿打红），等于把一个**随时点变化的数字**当成契约，逼下一个人手改常量。
  // 换成两条不假绿、也不需手改数字的检查（数字一律**现算**，绝不回抄成常量）：
  //   A17d  [invariant] 现算文件数 ≥ 137 —— 只增不减；减少说明有源文件被删/被挪走，须解释。
  //   A17d2 [invariant] git 已追踪的源文件在工作树中**无缺失** —— 防「文件被误删但计数仍够」。
  // 注意：`git ls-files` 不含未追踪文件（本轮 mcpHttpTransport.js 就是未追踪），
  //   所以它只能做「不得缺失」的下界，不能当"文件数基线"用 —— 那会变成从 git 现算再跟 git 比。
  okTrue('A17d', 'desktop/main JS/MJS 文件数 ≥ 137（只增不减；减少须解释）',
    mainFiles.length >= 137, `现算 ${mainFiles.length}`);
  let tracked = null;
  try {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync('git', ['ls-files', '-z', '--', 'desktop/main'], { cwd: ROOT, encoding: 'utf8' });
    tracked = out.split('\0').filter((f) => /\.(js|mjs)$/.test(f));
  } catch { tracked = null; }
  if (tracked && tracked.length) {
    ok('A17d2', 'git 已追踪的 desktop/main 源文件在工作树中无缺失', tracked.filter((rel) => !fs.existsSync(P(rel))), []);
  } else {
    skipAssert('A17d2', 'git 已追踪源文件在工作树中无缺失', 'git 不可用或非 git 仓库 —— 不计入 PASS');
  }
  console.log(`[INFO] A17d' 现算文件数 = ${mainFiles.length}；git 追踪 = ${tracked ? tracked.length : 'N/A'}（时点值，勿抄成常量）`);
  const ipcSet = new Set();
  for (const f of mainFiles) for (const m of stripComments(read_(f)).matchAll(/ipcMain\.handle\(\s*['"]([^'"]+)['"]/g)) ipcSet.add(m[1]);
  console.log(`[INFO] A17e' ipcMain.handle 唯一字面量 = ${ipcSet.size}（简报称 186，见正文口径说明）`);
  okTrue('A17e', 'ipcMain.handle 唯一字面量在 185±2 内（结构性量级）', ipcSet.size >= 183 && ipcSet.size <= 188, `实测 ${ipcSet.size}`);

  const pre = stripComments(read('desktop/main/preload.js'));
  const seg = pre.slice(pre.indexOf("exposeInMainWorld('mjcode'"));
  const keys = new Set();
  for (const m of seg.matchAll(/^  ([A-Za-z_][A-Za-z0-9_]*)\s*[:=]/gm)) keys.add(m[1]);
  ok('A17f', 'preload bridge 顶层键 = 202', keys.size, 202);
  const inv = new Set();
  for (const m of pre.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)) inv.add(m[1]);
  ok('A17g', 'preload invoke 唯一通道 = 187', inv.size, 187);
}

// ── A18  §1.3 关键常量 ───────────────────────────────────────────────────
{
  let baseTools = null, handlerNames = null;
  try {
    const m = await import(P(agentCore));
    baseTools = m.BASE_TOOLS; handlerNames = m.TOOL_HANDLER_NAMES;
  } catch (e) { /* ignore */ }
  if (baseTools) ok('A18a', 'BASE_TOOLS = 52（真实 ESM import）', baseTools.length, 52);
  else ok('A18a', 'BASE_TOOLS 可导入', 'IMPORT_FAILED', 52);
  if (handlerNames) ok('A18b', 'TOOL_HANDLER_NAMES = 51', Object.keys(handlerNames).length, 51);
  else ok('A18b', 'TOOL_HANDLER_NAMES 可导入', 'IMPORT_FAILED', 51);

  // A18c~g 全是「常量是否按契约写」的**代码**事实：注释里抄一遍同样的字面量
  //   就能把任何一条喂绿，故统一去注释。
  const mem = stripComments(read('desktop/main/memory/index.js'));
  okTrue('A18c', 'LAYER_QUOTA = {session:2, project:3, global:2}',
    /LAYER_QUOTA\s*=\s*\{\s*session:\s*2,\s*project:\s*3,\s*global:\s*2\s*\}/.test(mem));
  const pw = stripComments(read('desktop/main/mcpPrewarm.js'));
  okTrue('A18d', "PREWARM_NAMES = filesystem/time/fetch 三个",
    /PREWARM_NAMES\s*=\s*new Set\(\['filesystem',\s*'time',\s*'fetch'\]\)/.test(pw));
  const ar = stripComments(read('desktop/main/agentRunner.js'));
  okTrue('A18e', 'PREWARM_CONNECT_TIMEOUT_MS = 6000', /PREWARM_CONNECT_TIMEOUT_MS\s*=\s*6000/.test(ar));
  const ap = stripComments(read('desktop/main/approval.js'));
  ok('A18f', '审批四档齐全',
    ['never', 'auto-safe', 'on-request', 'always'].filter((x) => new RegExp(`'${x}'`).test(ap)).length, 4);
  const lr = stripComments(read('desktop/test/lint-ratchet.test.mjs'));
  okTrue('A18g', 'LINT_WARNINGS_BASELINE = 161', /LINT_WARNINGS_BASELINE\s*=\s*161/.test(lr));
}

// ══ 结构性加固：自检 + 断言总数闸 ═══════════════════════════════════════════
//
// 上面的 ①②③ 是「逐条修补」，挡不住下一个人写出新的条件分支（`if (cond) { ok(...) }`）。
// 这里加两层兜底：
//   SELF-1/1b  证明 stripComments 真的在去注释（不是恒等函数）—— 否则①的全部改动都是空转；
//   SELF-2     证明总数闸对「少 1 条 / 多 1 条」都会红（不是恒真表达式）；
//   T01        断言总数必须等于 EXPECTED_ASSERTION_TOTAL —— 任何断言「静默消失/未登记新增」都红。
{
  const probe = 'a /* b */ c';
  okTrue('SELF-1', "自检：stripComments('a /* b */ c') 真的去掉块注释（不是恒等函数）",
    stripComments(probe).replace(/\s+/g, ' ').trim() === 'a c',
    `实际产出 ${JSON.stringify(stripComments(probe))}；若返回原文则「去注释」是空转`);
  const probe2 = "const u = 'x//y'; // tail\nconst z = 1;";
  const out2 = stripComments(probe2);
  okTrue('SELF-1b', "自检：stripComments 去行注释、且不破坏字符串里的 //",
    out2.includes("'x//y'") && !/tail/.test(out2),
    `实际产出 ${JSON.stringify(out2)}；丢了 'x//y' 说明它会吃掉字符串里的 //（那会让所有检索类断言失真）`);

  // 演示开关（正常跑必须 false）：设 true 会让 A14b 不执行，用于**实测**总数闸真的会红。
  //   更彻底的做法是临时注释掉任意一条断言 —— 两种方式都验过（见测试报告）。

  okTrue('SELF-2', '自检：总数闸对「少 1 条 / 多 1 条」都会报红（机制非恒真）',
    totalMatches(EXPECTED_ASSERTION_TOTAL - 1, EXPECTED_ASSERTION_TOTAL) === false
      && totalMatches(EXPECTED_ASSERTION_TOTAL + 1, EXPECTED_ASSERTION_TOTAL) === false
      && totalMatches(EXPECTED_ASSERTION_TOTAL, EXPECTED_ASSERTION_TOTAL) === true,
    'totalMatches 对 expected±1 仍返回 true → 总数闸是恒真的，等于没装');

  const executed = pass + fail + skipped;   // 不含 T01 自身
  totalCheckOk = totalMatches(executed, EXPECTED_ASSERTION_TOTAL);
  okTrue('T01', `断言总数 = ${EXPECTED_ASSERTION_TOTAL}（防「断言静默消失/未登记新增」）`,
    totalCheckOk,
    `实际执行 ${executed}（PASS ${pass} + FAIL ${fail} + SKIP ${skipped}），期望 ${EXPECTED_ASSERTION_TOTAL}。`
    + ' 有断言被静默跳过，或新增了未登记的断言；若确实增删，请同步 EXPECTED_ASSERTION_TOTAL（这是强制纪律）');
}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} SKIP=${skipped} BLOCKED=${blocked} `
  + `(断言 ${pass + fail + skipped - 1} 条 / 登记 ${EXPECTED_ASSERTION_TOTAL}；T01 自身不计入登记数) ===`);
console.log(`[invariant] 失败: ${stats.invariant.fail}` +
  (stats.invariant.fail ? `   ← **真回归，必须查代码**：${invFailed.join(', ')}`
                        : '   ← 非 0 即为真回归，必须查'));
console.log(`[defect]    失败: ${stats.defect.fail}   ← 修复后预期（N 越大说明修得越多）`);
console.log(`[defect]    通过: ${stats.defect.pass}` +
  (defPassed.length ? `   ← 仍通过 = 缺陷仍在，需核对是否漏修：${defPassed.join(', ')}` : '')
  + '\n              （注：A09b/A10b 的通过是**口径过期**，修复走了绕开其字面量的路径，真证据是 A09e/A10e）');
if (blocked) console.log(`[blocked]   无法验证: ${blocked}   ← 前置断言失败，**既不是回归也不是修复证据**：${blockedIds.join(', ')}`);
if (failures.length) console.log(`失败项（全部）: ${failures.join(', ')}`);
if (defFailed.length) console.log(`已消失的缺陷断言: ${defFailed.join(', ')}`);
if (stats.blocked) {
  console.log('[判读] 存在 BLOCKED：有前置断言失败导致后续无法验证。先修前置，别把这几条读成「已修复」。');
} else if (!stats.invariant.fail && stats.defect.fail) {
  console.log('[判读] 剩余 FAIL **全部属于 defect 类** = 预期反转（修复证据），不是回归。');
} else if (stats.invariant.fail) {
  console.log('[判读] 存在 invariant 失败 = 有真回归或扫描器再次失效，先查这一项再谈修复进度。');
}
if (!totalCheckOk) {
  console.log('[判读] 另有 T01 红：断言总数与登记值不符，上面某条断言可能根本没执行。');
}
process.exit(fail ? 1 : 0);
