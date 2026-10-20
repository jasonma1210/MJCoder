#!/usr/bin/env node
/**
 * harness-r7 事实核验断言集（只读检查器）
 * 用法: node check.mjs <ROOT>
 * 退出码: 0 = 全部通过（基线绿）; 1 = 至少一条 FAIL
 * 只读：绝不写入被检查目录。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2];
if (!ROOT) { console.error('usage: node check.mjs <ROOT>'); process.exit(2); }

let pass = 0, fail = 0;
const failures = [];

function ok(id, desc, actual, expect) {
  const good = JSON.stringify(actual) === JSON.stringify(expect);
  if (good) { pass++; console.log(`[PASS] ${id} ${desc} | actual=${JSON.stringify(actual)}`); }
  else { fail++; failures.push(id); console.log(`[FAIL] ${id} ${desc} | actual=${JSON.stringify(actual)} expect=${JSON.stringify(expect)}`); }
}
function okTrue(id, desc, cond, info) { ok(id, desc, !!cond, true, ); if (info !== undefined && !cond) console.log(`       ↳ ${info}`); }
function okAbsent(id, desc, n) { ok(id, desc, n, 0); }
function okPresent(id, desc, n) { const g = n > 0; ok(id, desc, g, true); if (!g) console.log(`       ↳ 实际命中 ${n}（应 >0）`); }

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
{
  const cli = read('desktop/main/mcpClient.js');
  const hdrSeg = cli.slice(cli.indexOf('async send(payload, requestId)'), cli.indexOf('async send(payload, requestId)') + 900);
  okAbsent('A08a', 'HTTP transport 请求头无 MCP-Protocol-Version',
    (hdrSeg.match(/MCP-Protocol-Version|Mcp-Protocol-Version/gi) || []).length);
  okTrue('A08b', '请求头确有 Mcp-Session-Id（证明读到了 header 区块）', /Mcp-Session-Id/.test(hdrSeg));
  okTrue('A08c', '请求头确有 Accept: application/json, text/event-stream', /Accept:/.test(hdrSeg));
  okTrue('A09a', 'server.protocolVersion 被保存（有值可发但没发）', /server\.protocolVersion\s*=/.test(cli));
  okTrue('A09b', 'protocolVersion 未进入 createHttpTransport 传参',
    !/createHttpTransport\(\{[^}]*protocolVersion/s.test(cli));
  const proto = read('desktop/main/mcpProtocol.js');
  okTrue('A09c', 'mcpProtocol 声明支持 2025-11-25', /2025-11-25/.test(proto));
  okTrue('A09d', 'mcpProtocol 声明支持 2025-06-18', /2025-06-18/.test(proto));
}

// ── A10/A11  F-007 定义侧无守卫 / 结果侧有守卫 ───────────────────────────
{
  const defs = read('desktop/shared/mcpToolDefs.mjs');
  okTrue('A10a', 'definition 侧原样透传 description', /description:\s*t\.description/.test(defs));
  okTrue('A10b', 'definition 侧原样透传 inputSchema', /parameters:\s*t\.inputSchema/.test(defs));
  okAbsent('A10c', 'definition 侧无 guardUntrusted/detectInjection/长度闸',
    (defs.match(/guardUntrusted|detectInjection|\.slice\(\s*0,\s*\d{3,}|maxLength|MAX_DESC/g) || []).length);
  const cache = read('desktop/main/mcpToolCache.js');
  okAbsent('A10d', 'mcpToolCache 无不可信守卫', (cache.match(/guardUntrusted|detectInjection/g) || []).length);
  const ac = read(agentCore);
  okPresent('A11', '阳性对照：工具结果侧确有 detectInjection', (ac.match(/detectInjection/g) || []).length);
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
  ok('A17d', 'desktop/main JS/MJS 文件数 = 137', mainFiles.length, 137);
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

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
if (fail) console.log(`失败项: ${failures.join(', ')}`);
process.exit(fail ? 1 : 0);
