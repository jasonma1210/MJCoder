// N4（第六轮）门禁：工具登记矩阵——「新增一个工具必须 8 环节全接线」的聚合断言。
//
// 背景：历史事故反复证明「有实现无入口 / 有声明无通道」会以**不同环节**复发（git_add/git_branch
// 缺 BASE_TOOLS 声明、scheduled_create 缺通道、pdf_generate/pptx_create 缺 TOOL_CHANNELS 登记…）。
// 单点门禁（如 engine-process 只守通道）挡不住换环节的下一次复发。
//
// 本套件做法：从**单一事实来源**（引擎 BASE_TOOLS ∪ TOOL_HANDLER_NAMES）推导「模型可见工具清单」，
// 再对 8 个环节逐一做**差集断言**（期望集合 ↔ 实际集合），任一环节漏登记即红。
//
//   ① 引擎 schema（BASE_TOOLS）      ② MCP 通道白名单（TOOL_CHANNELS）
//   ③ 主进程 handler 注册           ④ 超时配置（TOOL_TIMEOUT_OVERRIDES）
//   ⑤ CWD 注入（CWD_TOOLS）         ⑥ 审批透传（APPROVAL_TOOLS）
//   ⑦ BASE_PROMPT 承诺             ⑧ UI 轨迹标签（toolNameCN）+ i18n 双语言包
//
// 验收对应：故意删任一环节的登记 → 本套件变红（见文末自检：差集工具非空即被检出）。
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const core = await import(pathToFileURL(path.join(ROOT, 'agent-core', 'index.js')).href);
const registry = require(path.join(ROOT, 'main/engineProcess/registry.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function blankComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:\\])\/\/[^\n]*/g, (_m, p1) => p1);
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── 单一事实来源：模型可见工具清单 ──
// BASE_TOOLS 是引擎对外声明的工具 schema；TOOL_HANDLER_NAMES 是「模型工具名 → 宿主通道名」映射。
// 两者并集 = 所有「模型能调用的工具名」。computer_use 属运行时条件追加（不在 BASE_TOOLS 静态清单）。
const BASE_NAMES = core.BASE_TOOLS.map((t) => t.function.name);
const TH_KEYS = Object.keys(core.TOOL_HANDLER_NAMES);
const ALL_TOOLS = Array.from(new Set([...BASE_NAMES, ...TH_KEYS])).sort();
const TOOL_SET = new Set(ALL_TOOLS);

// 允许的「非静态 schema」工具：运行时条件追加，不进 BASE_TOOLS（其条数被基线条数测试钉死）。
const RUNTIME_SCHEMA_TOOLS = ['computer_use'];
// 「无 UI 轨迹标签」允许清单：编排/插件/定时/PR 类工具在其它视图展示，无 toolTrace.* 条目。
const NO_LABEL_TOOLS = ['orchestrate_task', 'search_plugins', 'install_plugin', 'scheduled_create',
  'pr_list', 'pr_view', 'pr_diff', 'pr_review', 'pr_comment'];
// 引擎内部工具（引擎显式 case 处理，无宿主通道）：不出网不触盘，仅状态/子代理/编排。
const ENGINE_INTERNAL_TOOLS = ['todo_write', 'spawn_subagent', 'deep_research'];
// TOOL_CHANNELS 中非「模型工具名→通道」映射产物的通道（模型调用通道 / mcp__* 统一入口）。
const NON_TOOL_CHANNELS = ['chat', 'mcpCallTool'];

// BASE_PROMPT 契约承诺（必须持续在提示词中告知模型的工具名；删除/改名即红）。
const MUST_ADVERTISE = ['shell', 'read_file', 'write_file', 'edit_file', 'apply_patch', 'list_dir', 'grep',
  'glob', 'git_status', 'git_diff', 'git_log', 'git_commit', 'browser_navigate', 'chrome_status', 'clipboard',
  'notify', 'http_request', 'sqlite', 'sandbox_code_run', 'doc_create', 'xlsx_create', 'pptx_create', 'pdf_generate',
  'latex_compile',
  'spawn_subagent', 'orchestrate_task', 'search_plugins', 'install_plugin', 'web_fetch', 'todo_write'];

const diff = (expected, actualSet) => expected.filter((n) => !actualSet.has(n));
const asSet = (arr) => new Set(arr || []);

// ── ① 引擎 schema：每个模型工具必须有 schema 声明（静态 BASE_TOOLS 或运行时追加允许清单）──
{
  const schemaSet = asSet([...BASE_NAMES, ...RUNTIME_SCHEMA_TOOLS]);
  const missing = diff(ALL_TOOLS, schemaSet);
  check('① 引擎 schema：每个模型工具均已声明（BASE_TOOLS ∪ 运行时追加）', missing.length === 0,
    missing.length ? `缺 schema 声明：${missing.join(', ')}` : `${ALL_TOOLS.length} 个工具全覆盖`);
  // 反向：BASE_TOOLS 里的名字必须都是「已知工具」（防手写 schema 却忘登记通道映射=有 schema 无通道）
  const orphanSchema = BASE_NAMES.filter((n) => !TOOL_SET.has(n));
  check('① 引擎 schema：无孤儿声明（schema 名必须在工具清单内）', orphanSchema.length === 0,
    orphanSchema.join(', '));
}

// ── ② TOOL_CHANNELS 白名单：每个宿主通道必须登记（漏登记 → 子进程「未知工具」）──
{
  const channels = Object.values(core.TOOL_HANDLER_NAMES).filter((n) => !ENGINE_INTERNAL_TOOLS.map((t) => core.TOOL_HANDLER_NAMES[t]).includes(n));
  const reg = asSet(registry.TOOL_CHANNELS);
  const missing = channels.filter((c) => !reg.has(c));
  check('② TOOL_CHANNELS：TOOL_HANDLER_NAMES 全部通道已登记', missing.length === 0,
    missing.length ? `漏登记通道：${missing.join(', ')}` : `${channels.length} 个通道全覆盖`);
  // 反向：登记表不得出现「无人使用的孤儿通道」（除模型调用通道 chat / mcp__* 统一入口）
  const known = asSet([...channels, ...NON_TOOL_CHANNELS]);
  const orphanChan = registry.TOOL_CHANNELS.filter((c) => !known.has(c));
  check('② TOOL_CHANNELS：无孤儿通道（除 chat / mcpCallTool）', orphanChan.length === 0, orphanChan.join(', '));
}

// ── ③ 主进程 handler 注册：每个通道必须由 main 侧实现 ──
{
  const mainSrc = blankComments(read('main/main.js'));
  const start = mainSrc.indexOf('createToolHandlers: ({ sender');
  const end = mainSrc.indexOf("ipcMain.handle('agent:run'");
  check('③ 主进程 handler：createToolHandlers 区间可定位', start !== -1 && end > start, `start=${start} end=${end}`);
  const region = (start !== -1 && end > start ? mainSrc.slice(start, end) : mainSrc) + '\n' + blankComments(read('main/scheduledTools.js'));
  const channels = Object.values(core.TOOL_HANDLER_NAMES).filter((n) => !ENGINE_INTERNAL_TOOLS.map((t) => core.TOOL_HANDLER_NAMES[t]).includes(n));
  const missing = channels.filter((c) => !new RegExp(`\\b${c}\\b`).test(region));
  check('③ 主进程 handler：每个通道均有注册（createToolHandlers / scheduledToolHandlers 区域）', missing.length === 0,
    missing.length ? `未注册：${missing.join(', ')}` : `${channels.length} 个通道全覆盖`);
}

// ── ④ 超时配置：每个超时条目必须对应真实工具（孤儿条目 = 死配置）──
{
  const keys = Object.keys(core.TOOL_TIMEOUT_OVERRIDES);
  const orphan = keys.filter((k) => !TOOL_SET.has(k));
  check('④ TOOL_TIMEOUT_OVERRIDES：无孤儿超时条目', orphan.length === 0,
    orphan.length ? `孤儿：${orphan.join(', ')}` : `${keys.length} 条有效`);
}

// ── ⑤ CWD 注入 / ⑥ 审批透传：集合成员必须是真实工具（从源码 Set 字面量解析）──
function extractSetLiteral(src, varName) {
  const m = src.match(new RegExp(`const ${varName} = new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  return m ? Array.from(m[1].matchAll(/'([a-z_]+)'/g)).map((x) => x[1]) : null;
}
{
  const indexSrc = read('agent-core/index.js');
  const cwd = extractSetLiteral(indexSrc, 'CWD_TOOLS');
  const approval = extractSetLiteral(indexSrc, 'APPROVAL_TOOLS');
  check('⑤ 源码可解析 CWD_TOOLS / APPROVAL_TOOLS', Array.isArray(cwd) && Array.isArray(approval),
    `cwd=${cwd && cwd.length} approval=${approval && approval.length}`);
  const orphanCwd = (cwd || []).filter((n) => !TOOL_SET.has(n));
  check('⑤ CWD_TOOLS：无孤儿条目', orphanCwd.length === 0,
    orphanCwd.length ? `孤儿：${orphanCwd.join(', ')}` : `${(cwd || []).length} 条有效`);
  const orphanAp = (approval || []).filter((n) => !TOOL_SET.has(n));
  check('⑥ APPROVAL_TOOLS：无孤儿条目', orphanAp.length === 0,
    orphanAp.length ? `孤儿：${orphanAp.join(', ')}` : `${(approval || []).length} 条有效`);
}

// ── ⑦ BASE_PROMPT 承诺：核心工具名必须持续在提示词中，且都是真实工具（无幻影承诺）──
{
  const bpMatch = read('agent-core/index.js').match(/const BASE_PROMPT = `([\s\S]*?)`;/);
  const prompt = bpMatch ? bpMatch[1] : '';
  check('⑦ BASE_PROMPT 可解析', prompt.length > 100, `${prompt.length} 字符`);
  const notAdvertised = MUST_ADVERTISE.filter((n) => !prompt.includes(n));
  check('⑦ BASE_PROMPT：核心工具承诺齐全', notAdvertised.length === 0,
    notAdvertised.length ? `提示词缺：${notAdvertised.join(', ')}` : `${MUST_ADVERTISE.length} 个承诺齐全`);
  const phantom = MUST_ADVERTISE.filter((n) => !TOOL_SET.has(n));
  check('⑦ BASE_PROMPT：无幻影工具承诺（承诺名必须真实存在）', phantom.length === 0, phantom.join(', '));
}

// ── ⑧ UI 轨迹标签 + i18n 双语言包：每个工具名需有标签（或允许清单），标签 key 双语言齐全 ──
{
  const tt = read('renderer/src/components/tools/ToolTrace.tsx');
  const pairs = Array.from(tt.matchAll(/([a-z_]+):\s*'(toolTrace\.\w+)'/g)).map((m) => [m[1], m[2]]);
  const labeled = new Map(pairs);
  const needLabel = TH_KEYS.filter((n) => !NO_LABEL_TOOLS.includes(n));
  const missingLabel = needLabel.filter((n) => !labeled.has(n));
  check('⑧ UI 轨迹标签：每个工具名均有 toolNameCN 映射', missingLabel.length === 0,
    missingLabel.length ? `缺标签：${missingLabel.join(', ')}` : `${needLabel.length} 个已映射`);
  // 反向：标签映射的键必须是真实工具（防为不存在的工具留标签）
  const phantomLabel = [...labeled.keys()].filter((n) => !TOOL_SET.has(n));
  check('⑧ UI 轨迹标签：无幻影标签', phantomLabel.length === 0, phantomLabel.join(', '));
  // i18n 双语言包：每个 toolTrace.* key 必须在 zh-CN / en-US 均存在
  const locales = ['zh-CN', 'en-US'];
  const pack = Object.fromEntries(locales.map((l) => {
    const j = JSON.parse(read(`renderer/src/i18n/locales/${l}/toolTrace.json`));
    return [l, j];
  }));
  const missingI18n = [];
  for (const [toolName, key] of labeled) {
    const leaf = key.replace('toolTrace.', '');
    for (const l of locales) if (!(leaf in pack[l])) missingI18n.push(`${toolName}→${l}:${leaf}`);
  }
  check('⑧ i18n：toolNameCN 引用的 key 在 zh-CN/en-US 均存在', missingI18n.length === 0,
    missingI18n.length ? missingI18n.join(', ') : `${labeled.size} 个标签 key 双语齐全`);
}

// ── 自检：差集工具非空即被检出（防「恒绿」假闸）──
{
  const detected = diff(['a', 'b'], asSet(['a']));
  check('自检：差集断言能检出缺失项（删一环即红）', detected.length === 1 && detected[0] === 'b', detected.join(','));
}

console.log(`\ntool-registration-matrix: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
