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

let pass = 0, fail = 0, skipped = 0;
const failures = [];   // 全部失败 id
const invFailed = [];  // invariant 失败 → 真回归
const defFailed = [];  // defect 失败 → 预期反转（修复证据）
const defPassed = [];  // defect 通过 → 缺陷仍在（或是「修好了但断言口径已过期」，需人工核对）
const stats = { invariant: { pass: 0, fail: 0 }, defect: { pass: 0, fail: 0 } };

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
function countMatches(dirs, re, exts = ['.js', '.mjs', '.jsx', '.ts', '.tsx']) {
  let n = 0;
  for (const d of dirs) for (const f of walk(d, exts)) {
    const c = read_(f).match(re);
    if (c) n += c.length;
  }
  return n;
}
function read_(abs) { return fs.readFileSync(abs, 'utf8'); }

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
/** 在**代码正文**（已去注释）上统计正则命中数。 */
function countCode(src, re) { return (String(src).replace(/^\uFEFF/, '').match(re) || []).length; }
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

// ── A01/A02  F-005 MCP 名称往返（真跑 ESM） ─────────────────────────────
let toToolDefs, impErr = null;
try {
  const mod = await import(P('desktop/shared/mcpToolDefs.mjs'));
  toToolDefs = mod.toToolDefs;
  ok('A01a', 'toToolDefs 可导入', typeof toToolDefs, 'function');
  ok('A01b', "toToolDefs('my__svc',[{name:'x'}]) → mcp__my__svc__x",
     toToolDefs('my__svc', [{ name: 'x' }])[0].function.name, 'mcp__my__svc__x');
  ok('A01c', '正常名 mySvc 往返可逆',
     toToolDefs('mySvc', [{ name: 'x' }])[0].function.name, 'mcp__mySvc__x');
} catch (e) { impErr = e.message.split('\n')[0];
  ok('A01a', 'toToolDefs 可导入', `IMPORT_ERROR: ${impErr}`, 'function'); }

// A02：真的执行 agent-core 的反解表达式（从源码抽出后 eval），而非读注释
{
  const src = exists(agentCore) ? read(agentCore) : '';
  const m = src.match(/const server = ([^,]+), toolName = ([^;]+);/);
  okTrue('A02a', 'agent-core 存在 split(\'__\') 反解代码', !!m, '未匹配到 `const server = ..., toolName = ...;`');
  if (m) {
    const parts = 'mcp__my__svc__x'.split('__');
    const server = eval(m[1].replace(/parts/g, 'parts'));
    const toolName = eval(m[2].replace(/parts/g, 'parts'));
    ok('A02b', '反解 server 被解成 my（路由错服务）', server, 'my');
    ok('A02c', '反解 toolName 被解成 svc__x', toolName, 'svc__x');
  }
}

// ── A03/A04  F-003 supportsToolCall 无执行层消费 ─────────────────────────
{
  const ac = exists(agentCore) ? read(agentCore) : '';
  okAbsent('A03', 'agent-core 未出现 supportsToolCall', (ac.match(/supportsToolCall/g) || []).length);
  okTrue('A04a', 'agent-core 仍构造 allTools', /let allTools\s*=/.test(ac));
  okTrue('A04b', 'agent-core 仍每轮发送 tools: allTools', /tools:\s*allTools/.test(ac));
  const pilot = [];
  for (const d of [P('desktop')]) for (const f of walk(d, ['.js', '.mjs', '.jsx', '.ts', '.tsx'])) {
    if (/supportsToolCall/.test(read_(f))) pilot.push(path.relative(ROOT, f));
  }
  okTrue('A04c', 'supportsToolCall 仅出现在 modelsFile/localData/UI/测试（非 agent-core）',
    !pilot.some((x) => x.includes('agent-core')), `命中文件: ${pilot.join(' | ')}`);
  console.log(`[INFO] A04c' supportsToolCall 命中文件 = ${pilot.join(' , ')}`);
}

// ── A05  F-004 数字员工：renderer 是否真的有 rolePreset 消费（我方的反向断言） ──
{
  const engineChain = [
    read('desktop/renderer/src/components/EcosystemModal.jsx'),
    read('desktop/renderer/src/App.jsx'),
    read('desktop/renderer/src/components/ChatArea.jsx'),
    read('desktop/renderer/src/hooks/useAgentRun.ts'),
  ].join('\n');
  okTrue('A05a', 'EcosystemModal 真的调用 bridge ecosystemEmployeeRuntime',
    /api\?\.ecosystemEmployeeRuntime|ecosystemEmployeeRuntime\(\{/.test(engineChain));
  okTrue('A05b', '→ dispatch mjcode:recruit-expert', /mjcode:recruit-expert/.test(engineChain));
  okTrue('A05c', '→ App dispatch mjcode:enable-expert', /mjcode:enable-expert/.test(engineChain));
  okTrue('A05d', '→ ChatArea 监听写入 sessionExtras', /mjcode:enable-expert/.test(engineChain) && /setSessionExtras|sessionExtras/.test(engineChain));
  okTrue('A05e', '→ useAgentRun 把 rolePreset 放进 agent:run payload',
    /rolePreset:\s*sessionExtras\?\.expert\?\.runtime/.test(engineChain));
  const ar = read('desktop/main/agentRunner.js');
  okTrue('A05f', '→ agentRunner 消费 payload.rolePreset', /payload\.rolePreset/.test(ar));
  okTrue('A05g', '→ preload 暴露 ecosystemEmployeeRuntime',
    /ecosystemEmployeeRuntime/.test(read('desktop/main/preload.js')));
  okTrue('A05h', '→ 主进程 handle ecosystem:employeeRuntime',
    /ipcMain\.handle\(\s*'ecosystem:employeeRuntime'/.test(read('desktop/main/ipc/ecosystem.js')));
}

// ── A06/A07  F-002 工具矩阵未守审批/可补偿 ───────────────────────────────
{
  const mx = exists(matrixRel) ? read(matrixRel) : '';
  okAbsent('A06', 'tool-registration-matrix 未读 TOOL_LEVEL/REVERSIBILITY/toolLevel',
    (mx.match(/TOOL_LEVEL|REVERSIBILITY|toolLevel/g) || []).length);
  okTrue('A07', 'approval.js 未登记一律默认 L2',
    /TOOL_LEVEL\[tool\]\s*\|\|\s*'L2'/.test(read('desktop/main/approval.js')));
  okPresent('A06p', '阳性对照：矩阵确实引用了 approval 相关（APPROVAL_TOOLS 等）',
    (mx.match(/APPROVAL_TOOLS|approval/gi) || []).length);
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

  // [defect-F006] 缺陷存在性：改前「头里没有 MCP-Protocol-Version」为真；B1-B-04 修好后这里应 **FAIL**。
  // 若它仍 PASS，只有两种可能：扫描又空过了（看 A08z），或这条头真的还没加。
  okAbsent('A08a', '（改前）HTTP transport 请求头无 MCP-Protocol-Version',
    countCode(hdrSeg, /MCP-Protocol-Version|Mcp-Protocol-Version/gi));
  // [invariant] 阳性对照：A08a 必须"读到了真正的 header 区块"，否则 A08a 的 PASS 毫无意义。
  okTrue('A08b', '阳性对照：请求头确有 Mcp-Session-Id（证明读到的是 header 区块）', /Mcp-Session-Id/.test(hdrSeg));
  okTrue('A08c', '阳性对照：请求头确有 Accept: application/json, text/event-stream',
    /Accept\s*:\s*['"`]?application\/json,\s*text\/event-stream/.test(hdrSeg));

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
  const proto = read('desktop/main/mcpProtocol.js');
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
  okAbsent('A10c', '（改前）definition 侧无守卫/长度闸/不可信标记', countCode(defs, GATE_RE));
  const cache = read('desktop/main/mcpToolCache.js');
  okAbsent('A10d', '（改前）mcpToolCache 无不可信守卫 / 无定义预算闸', countCode(cache, GATE_RE));
  const ac = read(agentCore);
  okPresent('A11', '阳性对照：工具结果侧确有 detectInjection', countCode(stripComments(ac), /detectInjection/g));
  // F-007 修复的正向证据：三道闸（描述截断 / schema 只判不截断 / 不可信标记）都在位。
  okTrue('A10e', '定义侧确有预算闸：description 截断 + schema 只判不截断 + __untrusted__ 标记',
    /truncateDescription\s*\(/.test(defsCode) && /inspectToolDefinition\s*\(/.test(defsCode)
      && /__untrusted__/.test(defsCode),
    '三道闸缺任一 → F-007 未完整修');
}

// ── A12  F-009 run-all 的 suite/gate 结构 ────────────────────────────────
{
  const ra = read('desktop/test/run-all.mjs');
  okTrue('A12a', "SMOKE = ['smoke-load.mjs','render-smoke.mjs'] 两项",
    /const SMOKE = \[\s*'smoke-load\.mjs',\s*'render-smoke\.mjs'\s*\]/.test(ra), 'SMOKE 字面量不匹配');
  okTrue('A12b', 'GATES 只有 eval:check 一项（门不是套件）',
    /const GATES = \[\s*\{ label: 'eval:check/.test(ra) && (ra.match(/eval:check/g) || []).length >= 1);
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
  okAbsent('A14b', 'server 依赖无 spring', JSON.stringify(sp.dependencies).toLowerCase().split('spring').length - 1);
  const dag = read('desktop/main/orchestrator/dag.js');
  okTrue('A14c', 'DAG MAX_TASKS = 8', /const MAX_TASKS = 8;/.test(dag));
  okTrue('A14d', 'DAG MIN_TASKS = 2', /const MIN_TASKS = 2;/.test(dag));
  okTrue('A14e', 'DAG MAX_DEPS = 4', /const MAX_DEPS = 4;/.test(dag));
}

// ── A15  F-013 握手自报版本 ──────────────────────────────────────────────
{
  const proto = read('desktop/main/mcpProtocol.js');
  okTrue('A15a', "CLIENT_INFO version 硬编码 '1.0'",
    /CLIENT_INFO\s*=\s*Object\.freeze\(\{[^}]*version:\s*'1\.0'/s.test(proto));
  ok('A15b', 'desktop/package.json version', JSON.parse(read('desktop/package.json')).version, '0.6.1-beta');
  okTrue('A15c', 'mcpClient 每次 initialize 都发 clientInfo',
    /clientInfo:\s*\{\s*\.\.\.CLIENT_INFO\s*\}/.test(read('desktop/main/mcpClient.js')));
}

// ── A16  F-014 resources/prompts/tasks 未接（带阳性对照） ────────────────
{
  const reNeg = /resources\/list|resources\/read|prompts\/list|prompts\/get|tasks\/get/g;
  const n1 = countMatches([MAIN, REND], reNeg);
  okAbsent('A16a', 'main+renderer 无 resources/prompts/tasks 原语', n1);
  const n2 = countMatches([MAIN, REND], /tools\/list|tools\/call/g);
  okPresent('A16b', '阳性对照：同一批文件确有 tools/list|tools/call', n2);
  const defs = read('desktop/shared/mcpToolDefs.mjs');
  okAbsent('A16c', 'mcpToolDefs 未消费 outputSchema/structuredContent/taskSupport',
    (defs.match(/outputSchema|structuredContent|taskSupport|icons/g) || []).length);
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
  if (!regErr) {
    ok('A17a', 'TOOL_CHANNELS = 52', TOOL_CHANNELS.length, 52);
    ok('A17b', 'NOTIFY_CBS = 8', NOTIFY_CBS.length, 8);
    ok('A17c', 'REQUEST_CBS = 1', REQUEST_CBS.length, 1);
  } else { ok('A17a', 'registry.js 可 require', `ERR: ${regErr}`, 52); }

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
  for (const f of mainFiles) for (const m of read_(f).matchAll(/ipcMain\.handle\(\s*['"]([^'"]+)['"]/g)) ipcSet.add(m[1]);
  console.log(`[INFO] A17e' ipcMain.handle 唯一字面量 = ${ipcSet.size}（简报称 186，见正文口径说明）`);
  okTrue('A17e', 'ipcMain.handle 唯一字面量在 185±2 内（结构性量级）', ipcSet.size >= 183 && ipcSet.size <= 188, `实测 ${ipcSet.size}`);

  const pre = read('desktop/main/preload.js');
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

  const mem = read('desktop/main/memory/index.js');
  okTrue('A18c', 'LAYER_QUOTA = {session:2, project:3, global:2}',
    /LAYER_QUOTA\s*=\s*\{\s*session:\s*2,\s*project:\s*3,\s*global:\s*2\s*\}/.test(mem));
  const pw = read('desktop/main/mcpPrewarm.js');
  okTrue('A18d', "PREWARM_NAMES = filesystem/time/fetch 三个",
    /PREWARM_NAMES\s*=\s*new Set\(\['filesystem',\s*'time',\s*'fetch'\]\)/.test(pw));
  const ar = read('desktop/main/agentRunner.js');
  okTrue('A18e', 'PREWARM_CONNECT_TIMEOUT_MS = 6000', /PREWARM_CONNECT_TIMEOUT_MS\s*=\s*6000/.test(ar));
  const ap = read('desktop/main/approval.js');
  ok('A18f', '审批四档齐全',
    ['never', 'auto-safe', 'on-request', 'always'].filter((x) => new RegExp(`'${x}'`).test(ap)).length, 4);
  const lr = read('desktop/test/lint-ratchet.test.mjs');
  okTrue('A18g', 'LINT_WARNINGS_BASELINE = 161', /LINT_WARNINGS_BASELINE\s*=\s*161/.test(lr));
}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} SKIP=${skipped} ===`);
console.log(`[invariant] 失败: ${stats.invariant.fail}` +
  (stats.invariant.fail ? `   ← **真回归，必须查代码**：${invFailed.join(', ')}`
                        : '   ← 非 0 即为真回归，必须查'));
console.log(`[defect]    失败: ${stats.defect.fail}   ← 修复后预期（N 越大说明修得越多）`);
console.log(`[defect]    通过: ${stats.defect.pass}` +
  (defPassed.length ? `   ← 仍通过 = 缺陷仍在，需核对是否漏修：${defPassed.join(', ')}` : ''));
if (failures.length) console.log(`失败项（全部）: ${failures.join(', ')}`);
if (defFailed.length) console.log(`已消失的缺陷断言: ${defFailed.join(', ')}`);
if (!stats.invariant.fail && stats.defect.fail) {
  console.log('[判读] 剩余 FAIL **全部属于 defect 类** = 预期反转（修复证据），不是回归。');
} else if (stats.invariant.fail) {
  console.log('[判读] 存在 invariant 失败 = 有真回归或扫描器再次失效，先查这一项再谈修复进度。');
}
process.exit(fail ? 1 : 0);
