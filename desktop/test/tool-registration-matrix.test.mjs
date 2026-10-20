// N4（第六轮）/ F-002（第七轮）门禁：工具登记矩阵——「新增一个工具必须逐环节全接线」。
//
// 背景：历史事故反复证明「有实现无入口 / 有声明无通道」会以**不同环节**复发（git_add/git_branch
// 缺 BASE_TOOLS 声明、scheduled_create 缺通道、pdf_generate/pptx_create 缺 TOOL_CHANNELS 登记…）。
// 单点门禁（如 engine-process 只守通道）挡不住换环节的下一次复发。
//
// 第七轮（F-002）发现的新一类复发：**审批分级登记**缺失。这不是「少弹一次卡」，
// 而是**静默默认批准**——approval.js 的 toolLevel() 末行是唯一兜底
// `return TOOL_LEVEL[tool] || 'L2'`，而未登记工具在 auto-safe 档下 L2 **直接放行**
// （见 needsApproval 的 `if (approvalMode === 'auto-safe' && level === 'L2') return { need: false }`）。
// 于是「新工具忘登记 TOOL_LEVEL」＝一个新加的写文件/外发工具默认自动批准。
// 旧版门禁只查「无孤儿条目」（反向），对这个方向**完全无感**：未登记工具不在任何集合里，
// 不产生孤儿，恒绿。本版因此改为**逐工具正向覆盖**。
//
// 本套件做法：从**单一事实来源**（引擎 BASE_TOOLS ∪ TOOL_HANDLER_NAMES）推导「模型可见工具清单」（53 个），
// 以它为**驱动集**，逐工具 × 逐环节断言；同时保留原反向孤儿检测（两者互补，不冲突）。
//
//   ① 引擎 schema（BASE_TOOLS ∪ 运行时追加）  ② MCP 通道白名单（TOOL_CHANNELS）
//   ③ 主进程 handler 注册                    ④ 超时/CWD/审批透传登记（集合包含性）
//   ⑤ 审批分级登记（TOOL_LEVEL ⊕ 特判 ⊕ 只读，**不得依赖 || 'L2' 兜底**）← 本轮核心
//   ⑥ BASE_PROMPT 承诺                       ⑦ UI 轨迹标签（toolNameCN）+ i18n 双语言包
//
// 验收：故意造一个「有 schema + 有通道 + 有 handler 但没写 TOOL_LEVEL」的假工具 → 本套件必须非零退出。
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const core = await import(pathToFileURL(path.join(ROOT, 'agent-core', 'index.js')).href);
const registry = require(path.join(ROOT, 'main/engineProcess/registry.js'));
const approval = require(path.join(ROOT, 'main/approval.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
// 逐工具断言用：通过时静默（53×2 条打在日志里会淹没其他套件），失败时必打。
function checkQuiet(name, ok, detail = '') {
  if (ok) pass += 1;
  else { fail += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function blankComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:\\])\/\/[^\n]*/g, (_m, p1) => p1);
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const asSet = (arr) => new Set(arr || []);
const diff = (expected, actualSet) => expected.filter((n) => !actualSet.has(n));

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
// ⚠ 只有本清单成员有「逐工具提示词义务」。其余工具（浏览器/Chrome/PR/定时/引擎内部…）
// 刻意不在提示词中逐条承诺——提示词是逐字节钉死的外部契约，扩写属产品文案变更，不在门禁职权内。
const MUST_ADVERTISE = ['shell', 'read_file', 'write_file', 'edit_file', 'apply_patch', 'list_dir', 'grep',
  'glob', 'git_status', 'git_diff', 'git_log', 'git_commit', 'browser_navigate', 'chrome_status', 'clipboard',
  'notify', 'http_request', 'sqlite', 'sandbox_code_run', 'doc_create', 'xlsx_create', 'pptx_create', 'pdf_generate',
  'latex_compile',
  'spawn_subagent', 'orchestrate_task', 'search_plugins', 'install_plugin', 'web_fetch', 'todo_write'];

// ── 审批分级登记面（F-002）──
const TL = approval.TOOL_LEVEL;                       // 显式登记的「工具 → 默认分级」
const RO = approval.READONLY_TOOLS;                   // 只读工具（任何档位不询问）
const SP = approval.SPECIAL_CASED_TOOLS;              // toolLevel 在兜底前按工具名特判的工具
// 既在 TOOL_LEVEL 又有特判分支的工具：TOOL_LEVEL 条目**对 toolLevel 不可达**（分支先 return）。
// 这是刻意保留的「默认分级表可读性」冗余（见 approval.js 注释），不是漏登记。
// 钉成常量而不是动态推导：新增重叠必须显式改这里并交代理由，防止冗余悄悄扩散。
const SHADOWED = ['code_exec', 'latex_compile', 'shell'];
// TOOL_LEVEL 中「非模型工具」的合法登记（UI/IPC 驱动，模型不可直接调用，故不在 53 个驱动集里）。
//   · chrome_connect：扩展侧连接授权（IPC，非模型工具）
//   · unconfined_exec：沙箱不可用时 exec.js 的**内部**审批通道名，非模型工具
//   · git_checkout / git_restore_staged：diff 面板的 hunk/文件级操作（UI 驱动）
//   · mcp__：前缀通配哨兵（toolLevel 用 startsWith 判），不是工具名
const NON_MODEL_LEVEL_ENTRIES = ['mcp__', 'chrome_connect', 'unconfined_exec', 'git_checkout', 'git_restore_staged'];

// 覆盖判据（**纯函数**，便于自检证明它不是恒真）：一个工具要么显式登记在 TOOL_LEVEL，
// 要么被 toolLevel 特判（SPECIAL_CASED_TOOLS），要么在 READONLY_TOOLS 里。
// 三者都不命中 ⇒ 它的级别由 `|| 'L2'` 兜底得来 ⇒ 在 auto-safe 档被静默放行。
function levelCoverage(tool, { tl = TL, sp = SP, ro = RO } = {}) {
  const hits = [];
  if (hasOwn(tl, tool)) hits.push('TOOL_LEVEL');
  if (sp.has(tool)) hits.push('SPECIAL_CASED');
  if (ro.has(tool)) hits.push('READONLY');
  return { covered: hits.length > 0, hits, exactlyOne: hits.length === 1 };
}

// ── 0. 前置：驱动集与登记面可解析（前置不成立时后续断言无意义）──
check('0 驱动集：模型可见工具清单可解析', ALL_TOOLS.length >= 50, `${ALL_TOOLS.length} 个工具`);
check('0 审批登记面已从 approval.js 导出（TOOL_LEVEL / READONLY_TOOLS / SPECIAL_CASED_TOOLS）',
  TL && typeof TL === 'object' && RO instanceof Set && SP instanceof Set,
  `TOOL_LEVEL=${Object.keys(TL).length} 条 / READONLY=${RO.size} / SPECIAL=${SP.size}`);

// ── 各环节的数据源（只读一次，逐工具断言复用）──
const indexSrc = read('agent-core/index.js');
const mainSrc = blankComments(read('main/main.js'));
const hStart = mainSrc.indexOf('createToolHandlers: ({ sender');
const hEnd = mainSrc.indexOf("ipcMain.handle('agent:run'");
const handlerRegion = (hStart !== -1 && hEnd > hStart ? mainSrc.slice(hStart, hEnd) : mainSrc)
  + '\n' + blankComments(read('main/scheduledTools.js'));
function extractSetLiteral(src, varName) {
  const m = src.match(new RegExp(`const ${varName} = new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  return m ? Array.from(m[1].matchAll(/'([a-z_]+)'/g)).map((x) => x[1]) : null;
}
const CWD = asSet(extractSetLiteral(indexSrc, 'CWD_TOOLS'));
const APPR = asSet(extractSetLiteral(indexSrc, 'APPROVAL_TOOLS'));
const TIMEOUT = asSet(Object.keys(core.TOOL_TIMEOUT_OVERRIDES));
const CHANNELS = asSet(registry.TOOL_CHANNELS);
const bpMatch = indexSrc.match(/const BASE_PROMPT = `([\s\S]*?)`;/);
const PROMPT = bpMatch ? bpMatch[1] : '';

// UI 标签（ToolTrace.tsx 的 toolNameCN 映射）与 i18n 双语言包
const tt = read('renderer/src/components/tools/ToolTrace.tsx');
const LABELED = new Map(Array.from(tt.matchAll(/([a-z_]+):\s*'(toolTrace\.\w+)'/g)).map((m) => [m[1], m[2]]));
const LOCALES = ['zh-CN', 'en-US'];
const PACK = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(read(`renderer/src/i18n/locales/${l}/toolTrace.json`))]));

// ── 1. 逐工具 × 逐环节（驱动集 53 个工具，每个工具一行断言）──
const matrixRows = [];
for (const t of ALL_TOOLS) {
  const inTH = t in core.TOOL_HANDLER_NAMES;
  const channel = inTH ? core.TOOL_HANDLER_NAMES[t] : null;
  const engineInternal = ENGINE_INTERNAL_TOOLS.includes(t);

  // ① schema
  const okSchema = BASE_NAMES.includes(t) || RUNTIME_SCHEMA_TOOLS.includes(t);
  // ② RPC 通道白名单（引擎内部工具不过 RPC，无通道义务）
  const okChan = engineInternal ? true : (channel != null && CHANNELS.has(channel));
  // ③ handler：引擎内部工具由 agent-core 显式分支处理；其余必须在主进程 createToolHandlers 注册
  const okHandler = engineInternal
    ? new RegExp(`['"\`]${t}['"\`]`).test(indexSrc)
    : (channel != null && new RegExp(`\\b${channel}\\b`).test(handlerRegion));
  // ④ 超时/CWD/审批透传：**集合包含性**环节，不是逐工具义务（并非每个工具都需要 CWD 注入或超时覆盖）。
  //    逐工具侧只记录「是否登记」，越界（登记了不存在的工具名）由下方 4 条反向断言守。
  const regs = [];
  if (TIMEOUT.has(t)) regs.push('timeout');
  if (CWD.has(t)) regs.push('cwd');
  if (APPR.has(t)) regs.push('approval');
  const okReg = true;
  // ⑤ 审批分级（本轮核心）：不得依赖 `|| 'L2'` 兜底
  const cov = levelCoverage(t);
  const shadowed = SHADOWED.includes(t);
  const okLevel = cov.covered && (shadowed ? cov.hits.length === 2 : cov.exactlyOne);
  // ⑥ BASE_PROMPT 承诺（仅 MUST_ADVERTISE 成员有义务）
  const needPrompt = MUST_ADVERTISE.includes(t);
  const okPrompt = !needPrompt || PROMPT.includes(t);
  // ⑦ UI 标签 + i18n（引擎内部/编排类无轨迹标签，见 NO_LABEL_TOOLS）
  const needLabel = inTH && !NO_LABEL_TOOLS.includes(t);
  const labelKey = LABELED.get(t);
  const okLabel = !needLabel || (!!labelKey && LOCALES.every((l) => labelKey.replace('toolTrace.', '') in PACK[l]));

  const cols = [okSchema, okChan, okHandler, okReg, okLevel, okPrompt, okLabel];
  const names = ['①schema', '②通道', '③handler', '④登记', '⑤分级', '⑥提示词', '⑦标签'];
  const bad = names.filter((_n, i) => !cols[i]);
  checkQuiet(`工具 ${t}：8 环节全登记`, bad.length === 0, bad.join(',') || '');
  matrixRows.push({ t, cols, regs, level: cov.hits.join('+') || '（兜底 L2）' });
}

// ── 2. 逐工具审批分级覆盖（核心断言：53 条，每条一个工具）──
// 这条与第 1 节的 ⑤ 列重复计数是**刻意**的：它是本卡的核心风险面，必须能单独被数出来。
for (const t of ALL_TOOLS) {
  const cov = levelCoverage(t);
  const shadowed = SHADOWED.includes(t);
  const ok = cov.covered && (shadowed ? cov.hits.length === 2 : cov.exactlyOne);
  checkQuiet(`⑤ ${t}：审批分级不依赖 || 'L2' 兜底（显式登记 / 特判 / 只读，恰居其一）`, ok,
    cov.covered ? `命中 ${cov.hits.join('+')}（${cov.hits.length} 个，应为 1）` : '三处均未登记 → 级别由兜底 L2 提供');
}

// 矩阵表（人眼可读证据：53 行 × 7 环节）
console.log('\n── 工具登记矩阵（53 个模型工具 × 7 环节）──');
console.log(['工具'.padEnd(22), '①schema', '②通道', '③handler', '④登记', '⑤分级', '⑥提示词', '⑦标签', '审批依据'].join(' '));
for (const r of matrixRows) {
  const cells = r.cols.map((v) => (v ? '✓' : '✗').padEnd(6));
  console.log([r.t.padEnd(22), ...cells].join(' ') + ' ' + r.level);
}
console.log('');

// ── 3. 逐环节聚合（正向：任一工具漏登记即红；与逐工具断言互为印证）──
{
  const schemaSet = asSet([...BASE_NAMES, ...RUNTIME_SCHEMA_TOOLS]);
  const missing = diff(ALL_TOOLS, schemaSet);
  check('① 引擎 schema：每个模型工具均已声明（BASE_TOOLS ∪ 运行时追加）', missing.length === 0,
    missing.length ? `缺 schema 声明：${missing.join(', ')}` : `${ALL_TOOLS.length} 个工具全覆盖`);
  const orphanSchema = BASE_NAMES.filter((n) => !TOOL_SET.has(n));
  check('① 引擎 schema：无孤儿声明（schema 名必须在工具清单内）', orphanSchema.length === 0, orphanSchema.join(', '));
}
{
  const needChan = ALL_TOOLS.filter((t) => !ENGINE_INTERNAL_TOOLS.includes(t));
  const missing = needChan.filter((t) => !CHANNELS.has(core.TOOL_HANDLER_NAMES[t]));
  check('② TOOL_CHANNELS：非引擎内部工具全部通道已登记', missing.length === 0,
    missing.length ? `漏登记通道：${missing.map((t) => `${t}→${core.TOOL_HANDLER_NAMES[t]}`).join(', ')}` : `${needChan.length} 个工具通道全覆盖`);
  const known = asSet([...ALL_TOOLS.map((t) => core.TOOL_HANDLER_NAMES[t]).filter(Boolean), ...NON_TOOL_CHANNELS]);
  const orphanChan = registry.TOOL_CHANNELS.filter((c) => !known.has(c));
  check('② TOOL_CHANNELS：无孤儿通道（除 chat / mcpCallTool）', orphanChan.length === 0, orphanChan.join(', '));
}
{
  check('③ 主进程 handler：createToolHandlers 区间可定位', hStart !== -1 && hEnd > hStart, `start=${hStart} end=${hEnd}`);
  const needHandler = ALL_TOOLS.filter((t) => !ENGINE_INTERNAL_TOOLS.includes(t));
  const missing = needHandler.filter((t) => !new RegExp(`\\b${core.TOOL_HANDLER_NAMES[t]}\\b`).test(handlerRegion));
  check('③ 主进程 handler：每个非引擎内部工具均有注册（createToolHandlers / scheduledToolHandlers 区域）', missing.length === 0,
    missing.length ? `未注册：${missing.join(', ')}` : `${needHandler.length} 个工具全覆盖`);
}
{
  // ④ 集合包含性：登记表里的每一项都必须是真实工具（防「登记了不存在的工具」= 死配置/错别字）
  const orphanTimeout = [...TIMEOUT].filter((k) => !TOOL_SET.has(k));
  check('④ TOOL_TIMEOUT_OVERRIDES：无孤儿超时条目', orphanTimeout.length === 0,
    orphanTimeout.length ? `孤儿：${orphanTimeout.join(', ')}` : `${TIMEOUT.size} 条有效`);
  check('④ 源码可解析 CWD_TOOLS / APPROVAL_TOOLS', CWD.size > 0 && APPR.size > 0, `cwd=${CWD.size} approval=${APPR.size}`);
  const orphanCwd = [...CWD].filter((n) => !TOOL_SET.has(n));
  check('④ CWD_TOOLS：无孤儿条目', orphanCwd.length === 0, orphanCwd.length ? `孤儿：${orphanCwd.join(', ')}` : `${CWD.size} 条有效`);
  const orphanAp = [...APPR].filter((n) => !TOOL_SET.has(n));
  check('④ APPROVAL_TOOLS：无孤儿条目', orphanAp.length === 0, orphanAp.length ? `孤儿：${orphanAp.join(', ')}` : `${APPR.size} 条有效`);
}
{
  // ⑤-a 聚合：零工具依赖兜底（等价于 53 条逐工具断言的汇总，保留以便一眼看结论）
  const uncovered = ALL_TOOLS.filter((t) => !levelCoverage(t).covered);
  check('⑤ 审批分级：零工具依赖 «TOOL_LEVEL[tool] || \'L2\'» 兜底（漏登记即＝auto-safe 档静默默认批准）',
    uncovered.length === 0,
    uncovered.length ? `未登记：${uncovered.join(', ')}` : `${ALL_TOOLS.length} 个工具全部有显式依据`);

  // ⑤-b 聚合：三处恰居其一（防「两处都登记」导致读者无法判断谁生效）
  const multi = ALL_TOOLS.filter((t) => !SHADOWED.includes(t) && levelCoverage(t).hits.length > 1);
  check('⑤ 审批分级：同一工具在 TOOL_LEVEL / 特判 / 只读中恰居其一（除已固定化的 SHADOWED 冗余）',
    multi.length === 0,
    multi.length ? `多处登记：${multi.map((t) => `${t}(${levelCoverage(t).hits.join('+')})`).join(', ')}` : `非 SHADOWED 工具均为单点登记`);

  // ⑤-c 聚合：显式登记的级别必须就是**生效**级别（防「登记了 A 档、实际走 B 档」的假登记）
  const registeredInTable = ALL_TOOLS.filter((t) => hasOwn(TL, t) && !SHADOWED.includes(t) && !SP.has(t));
  const mismatch = registeredInTable.filter((t) => approval.toolLevel(t, {}) !== TL[t]);
  check('⑤ 审批分级：TOOL_LEVEL 登记值 === toolLevel() 实际生效值（登记即生效，无架空）',
    mismatch.length === 0,
    mismatch.length ? `不一致：${mismatch.map((t) => `${t} 登记${TL[t]}/实际${approval.toolLevel(t, {})}`).join(', ')}`
      : `${registeredInTable.length} 个显式登记工具逐一一致`);

  // ⑤-d 特判清单与 toolLevel() 源码分支 **双向**同步（漏登记/多登记都会让门禁误判）
  const lvBody = read('main/approval.js').match(/function toolLevel\(tool, args = \{\}\) \{([\s\S]*?)\n\}/);
  const branches = asSet(lvBody ? Array.from(lvBody[1].matchAll(/tool === '([a-z_][a-z0-9_]*)'/g)).map((m) => m[1]) : []);
  const notInList = [...branches].filter((n) => !SP.has(n));
  const notInSrc = [...SP].filter((n) => !branches.has(n));
  check('⑤ SPECIAL_CASED_TOOLS 与 toolLevel() 特判分支双向同步（漏一个会让门禁误判）',
    notInList.length === 0 && notInSrc.length === 0 && branches.size > 0,
    `分支=${branches.size} 清单=${SP.size}${notInList.length ? ` 未入清单：${notInList.join(', ')}` : ''}${notInSrc.length ? ` 无对应分支：${notInSrc.join(', ')}` : ''}`);
}
{
  // ⑥ BASE_PROMPT 承诺
  check('⑥ BASE_PROMPT 可解析', PROMPT.length > 100, `${PROMPT.length} 字符`);
  const notAdvertised = MUST_ADVERTISE.filter((n) => !PROMPT.includes(n));
  check('⑥ BASE_PROMPT：核心工具承诺齐全', notAdvertised.length === 0,
    notAdvertised.length ? `提示词缺：${notAdvertised.join(', ')}` : `${MUST_ADVERTISE.length} 个承诺齐全`);
  const phantom = MUST_ADVERTISE.filter((n) => !TOOL_SET.has(n));
  check('⑥ BASE_PROMPT：无幻影工具承诺（承诺名必须真实存在）', phantom.length === 0, phantom.join(', '));
}
{
  // ⑦ UI 标签 + i18n
  const needLabel = TH_KEYS.filter((n) => !NO_LABEL_TOOLS.includes(n));
  const missingLabel = needLabel.filter((n) => !LABELED.has(n));
  check('⑦ UI 轨迹标签：每个工具名均有 toolNameCN 映射', missingLabel.length === 0,
    missingLabel.length ? `缺标签：${missingLabel.join(', ')}` : `${needLabel.length} 个已映射`);
  const phantomLabel = [...LABELED.keys()].filter((n) => !TOOL_SET.has(n));
  check('⑦ UI 轨迹标签：无幻影标签', phantomLabel.length === 0, phantomLabel.join(', '));
  const missingI18n = [];
  for (const [toolName, key] of LABELED) {
    const leaf = key.replace('toolTrace.', '');
    for (const l of LOCALES) if (!(leaf in PACK[l])) missingI18n.push(`${toolName}→${l}:${leaf}`);
  }
  check('⑦ i18n：toolNameCN 引用的 key 在 zh-CN/en-US 均存在', missingI18n.length === 0,
    missingI18n.length ? missingI18n.join(', ') : `${LABELED.size} 个标签 key 双语齐全`);
}

// ── 4. 反向断言（登记表不得自我膨胀；与正向断言互补）──
{
  const phantomLevel = Object.keys(TL).filter((k) => !TOOL_SET.has(k) && !NON_MODEL_LEVEL_ENTRIES.includes(k));
  check('⑤反 TOOL_LEVEL：无幻影条目（登记的工具必须真实存在，或属已知非模型工具清单）',
    phantomLevel.length === 0, phantomLevel.length ? `幻影：${phantomLevel.join(', ')}` : `${Object.keys(TL).length} 条全部可解释`);

  const overlap = [...SP].filter((n) => RO.has(n));
  check('⑤反 SPECIAL_CASED_TOOLS ∩ READONLY_TOOLS === ∅（两表重叠会让「恰居其一」失效）',
    overlap.length === 0, overlap.join(', '));

  const roNotInTools = [...RO].filter((n) => !TOOL_SET.has(n));
  check('⑤反 READONLY_TOOLS：成员必须都是真实模型工具', roNotInTools.length === 0,
    roNotInTools.length ? `幻影：${roNotInTools.join(', ')}` : `${RO.size} 个只读工具全部真实`);

  // SHADOWED 钉死：这 3 个必须仍然「两处登记」（TOOL_LEVEL 条目不可达但保留可读性）。
  // 有人把条目删掉 → 本断言红（需同步改 SHADOWED 常量与注释，避免冗余无声消失或扩散）。
  const shadowActual = ALL_TOOLS.filter((t) => hasOwn(TL, t) && SP.has(t)).sort();
  check('⑤反 SHADOWED 冗余集合固定为 code_exec / latex_compile / shell（新增重叠必须显式交代）',
    JSON.stringify(shadowActual) === JSON.stringify([...SHADOWED].sort()),
    `实际：${shadowActual.join(', ')}`);
}

// ── 5. 自检（防「恒绿」假闸）──
{
  const detected = diff(['a', 'b'], asSet(['a']));
  check('自检：差集断言能检出缺失项（删一环即红）', detected.length === 1 && detected[0] === 'b', detected.join(','));

  // 覆盖判据自检：给一个「有 schema + 有通道 + 有 handler 但没写 TOOL_LEVEL」的假工具名，
  // levelCoverage 必须判 covered=false。否则 53 条逐工具断言全是恒真（假闸）。
  const FAKE = 'matrix_fake_unregistered_tool';
  const fake = levelCoverage(FAKE);
  check('自检：审批覆盖判据能抓出「未登记 TOOL_LEVEL」的假工具（否则逐工具断言＝恒绿假闸）',
    fake.covered === false && fake.hits.length === 0, JSON.stringify(fake));
  // 反向自检：真实已登记工具必须判 covered=true（防判据退化成恒假）
  const realOk = levelCoverage('write_file').covered && levelCoverage('read_file').covered
    && levelCoverage('notify').covered;
  check('自检：审批覆盖判据对已登记工具判 true（三条路径 TOOL_LEVEL / 只读 / 特判各验一次）', realOk);
}

console.log(`\ntool-registration-matrix: ${pass}/${pass + fail} 通过`
  + `（含逐工具断言 ${ALL_TOOLS.length} × 2 条：8 环节逐工具 + 审批分级逐工具）`);
process.exit(fail === 0 ? 0 : 1);
