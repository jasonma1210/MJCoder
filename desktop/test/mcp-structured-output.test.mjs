// F-014 / A16c 门禁：MCP 结构化输出的消费（用户裁决第三条路「校验走结构化，展示走文本」）
//
// 背景：`tools/call` 的返回可带 `structuredContent`（shape 由服务端 `tools/list` 的
//   `outputSchema` 声明）。此前 MJCode 把它随整个 result 交给 agent-core 的
//   truncateToolResult（index.js:1977 JSON.stringify 进模型上下文）——结构化数据其实
//   **已经在进上下文**，却无人校验它是否符合服务端自己声明的 shape。
//
// 本套件锁七件事：
//   ① 定义侧：`toToolDefs` 以**不可枚举**属性保留 `__outputSchema__`，
//      `JSON.stringify(def)` 与「没有 outputSchema 的同一工具」逐字节一致（没吃工具表预算）；
//   ② `validateStructuredOutput`：合法通过；type 不匹配给 path+reason；缺 required 被报；
//      嵌套数组元素路径形如 `$.rows[1].id`；enum 不匹配被报；**含不认识关键字的 schema
//      不得因该关键字判失败**；空/非对象 schema → ok；循环引用不抛；
//   ③ `applyStructuredOutputPolicy`：无 schema → 原样；合法 → structuredContent 被删、
//      content 一字未动、无 note；不合法 → note 在最前、content 原文保留、structuredContent
//      被删；content 无 text 块 → structuredContent **保留**；入参永不被改；超大 schema →
//      跳过校验但仍剥离、不抛；
//   ④ handler 层：驱动真实 `main/ipc/mcp.js` 的 callMcpTool（electron + mcpClient 打桩），
//      断言「合法 → 返回载荷无 structuredContent」「不合法 → 带 note」「无 outputSchema →
//      结构化数据原样保留（策略只在服务端声明时介入）」；
//   ⑤ 静态断言：接线在位（模块级缓存动态 import + 策略调用在 isError 判定之前）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');

const {
  toToolDefs, validateStructuredOutput, applyStructuredOutputPolicy,
} = await import(path.join(ROOT, 'shared/mcpToolDefs.mjs'));

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try {
    fn();
    console.log(`[PASS] ${name}`);
    pass++;
  } catch (e) {
    console.error(`[FAIL] ${name} — ${e.message}`);
    process.exitCode = 1;
  }
}
function checkAsync(name, fn) {
  total++;
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`[PASS] ${name}`); pass++; })
    .catch((e) => { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; });
}
const eq = (a, b, m = '') => { if (a !== b) throw new Error(`${m} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };
const ok = (v, m) => { if (!v) throw new Error(m || '断言为假'); };
/** 键序无关的深比较（快照比对用：JSON.stringify 对键序敏感，会误报）。 */
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
}
const deepEq = (a, b, m = '') => { if (stable(a) !== stable(b)) throw new Error(`${m} 两对象深不等`); };

// ── ① 定义侧：__outputSchema__ 不可枚举，不吃工具表预算 ──
const QUERY_INPUT = { type: 'object', properties: { sql: { type: 'string' } } };
const QUERY_OUTPUT = {
  type: 'object',
  required: ['rows'],
  properties: {
    rows: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' } } } },
  },
};
const defWithSchema = toToolDefs('db', [{ name: 'query', description: '查数据', inputSchema: QUERY_INPUT, outputSchema: QUERY_OUTPUT }])[0];
const defWithoutSchema = toToolDefs('db', [{ name: 'query', description: '查数据', inputSchema: QUERY_INPUT }])[0];

check('① __outputSchema__ 挂在定义上且值原样（服务端声明一字不改）', () => {
  ok(defWithSchema.__outputSchema__, '__outputSchema__ 缺失');
  deepEq(defWithSchema.__outputSchema__, QUERY_OUTPUT, 'outputSchema 被改动');
});

check('① 无 outputSchema 的工具不挂该属性', () => {
  eq(defWithoutSchema.__outputSchema__, undefined, '不该出现 __outputSchema__');
});

check('① JSON.stringify 与「没有 outputSchema 的同一工具」逐字节一致（没吃工具表预算）', () => {
  eq(JSON.stringify(defWithSchema), JSON.stringify(defWithoutSchema), '线上报文不一致');
});

check('① 报文 shape 与改前一致（顶层只有 type/function，function 键不变）', () => {
  eq(Object.keys(defWithSchema).sort().join(','), 'function,type', '顶层键变了');
  eq(Object.keys(defWithSchema.function).sort().join(','), 'description,name,parameters', 'function 键变了');
});

// ── ② validateStructuredOutput ──
check('② 合法对象通过（ok=true 且无 skipped）', () => {
  const r = validateStructuredOutput(QUERY_OUTPUT, { rows: [{ id: 1 }, { id: 2 }] });
  eq(r.ok, true, '合法值被判不通过');
  eq(r.skipped, undefined, '不该有 skipped');
});

check('② type 不匹配给出 path+reason', () => {
  const schema = { type: 'object', properties: { id: { type: 'number' } } };
  const r = validateStructuredOutput(schema, { id: 'x' });
  eq(r.ok, false, 'string 进了 number 字段却没报');
  eq(r.path, '$.id', 'path');
  ok(/number/.test(r.reason) && /string/.test(r.reason), `reason 未说明期望/实际：${r.reason}`);
});

check('② 缺 required 被报（path 指向缺失属性）', () => {
  const r = validateStructuredOutput(QUERY_OUTPUT, {});
  eq(r.ok, false, '缺 rows 却没报');
  eq(r.path, '$.rows', 'path');
  ok(/required/.test(r.reason), `reason 未说明 required：${r.reason}`);
});

check('② 嵌套数组元素路径形如 $.rows[1].id', () => {
  const r = validateStructuredOutput(QUERY_OUTPUT, { rows: [{ id: 1 }, { id: 'oops' }] });
  eq(r.ok, false, '第二个元素的 id 是 string 却没报');
  eq(r.path, '$.rows[1].id', 'path');
});

check('② enum 不匹配被报', () => {
  const schema = { type: 'object', properties: { mode: { enum: ['fast', 'slow'] } } };
  const r = validateStructuredOutput(schema, { mode: 'medium' });
  eq(r.ok, false, 'enum 外取值却没报');
  ok(/enum/.test(r.reason), `reason 未说明 enum：${r.reason}`);
});

check('② 含不认识关键字的 schema 不得因该关键字判失败（fail-open，防误报泛滥）', () => {
  const schema = {
    type: 'object',
    properties: { id: { type: 'number', minLength: 5, pattern: '^\\d+$', format: 'int64', $comment: 'x' } },
    minProperties: 2,
    additionalProperties: false,
    unevaluatedProperties: false,
  };
  const r = validateStructuredOutput(schema, { id: 1 });
  eq(r.ok, true, `被不懂的关键字误判：${JSON.stringify(r)}`);
});

check('② 联合类型 ["string","null"]：null 合法、number 不合法', () => {
  const schema = { type: 'object', properties: { v: { type: ['string', 'null'] } } };
  eq(validateStructuredOutput(schema, { v: null }).ok, true, 'null 被判不合法');
  eq(validateStructuredOutput(schema, { v: 'x' }).ok, true, 'string 被判不合法');
  eq(validateStructuredOutput(schema, { v: 7 }).ok, false, 'number 混过联合类型');
});

check('② 空 schema / 非对象 schema → ok（没有任何可判的约束）', () => {
  for (const s of [{}, 'nope', 42, null, true]) {
    eq(validateStructuredOutput(s, { anything: [1, 2] }).ok, true, `schema=${JSON.stringify(s)} 被判不通过`);
  }
});

check('② 循环引用的 schema 不抛（按超限/内部错误跳过，绝不抛给调用方）', () => {
  const cyc = { type: 'object', properties: {} };
  cyc.properties.self = cyc;
  let r = null;
  try {
    r = validateStructuredOutput(cyc, { a: 1 });
  } catch (e) {
    throw new Error(`抛异常了：${e.message}`);
  }
  eq(r.ok, true, '循环 schema 应放行');
  ok(r.skipped === 'limit' || r.skipped === 'error', `应标记跳过原因，实际：${JSON.stringify(r)}`);
});

check('② value 深度 > 32 → 跳过校验（skipped=limit），不是判失败', () => {
  let deepValue = { leaf: 1 };
  for (let i = 0; i < 40; i += 1) deepValue = { nested: deepValue };
  const r = validateStructuredOutput({ type: 'object' }, deepValue);
  eq(r.ok, true, '病态深嵌套被判失败');
  eq(r.skipped, 'limit', '未标记 limit 跳过');
});

check('② 访问节点 > 20000 → 跳过校验（skipped=limit）', () => {
  const value = [];
  for (let i = 0; i < 20001; i += 1) value.push('s');
  const r = validateStructuredOutput({ type: 'array', items: { type: 'string' } }, value);
  eq(r.ok, true, '巨型数组被判失败');
  eq(r.skipped, 'limit', '未标记 limit 跳过');
});

check('② 超限 schema（> MAX_INPUT_SCHEMA_BYTES）→ 跳过校验（skipped=limit）', () => {
  const props = {};
  for (let i = 0; i < 800; i += 1) props[`p${i}`] = { type: 'string', description: 'x'.repeat(30) };
  const r = validateStructuredOutput({ type: 'object', properties: props }, { p0: 'ok' });
  eq(r.ok, true, '超大 schema 被判失败');
  eq(r.skipped, 'limit', '未标记 limit 跳过');
});

// ── ③ applyStructuredOutputPolicy ──
const VALID_RESULT = () => ({
  content: [{ type: 'text', text: 'rows: 2' }],
  structuredContent: { rows: [{ id: 1 }, { id: 2 }] },
  isError: false,
});

check('③ 无 outputSchema → 结果深等于入参且 structuredContent 仍在', () => {
  const input = VALID_RESULT();
  const out = applyStructuredOutputPolicy(input, undefined);
  deepEq(out, input, '无 schema 时结果被改动');
  ok(out.structuredContent, 'structuredContent 被剥掉了（无 schema 时不该剥）');
  eq(out, input, '无 schema 时应原样返回（同一引用）');
});

check('③ 有 schema 且合法 → structuredContent 被删、content 文本一字未动、无 note', () => {
  const input = VALID_RESULT();
  const out = applyStructuredOutputPolicy(input, QUERY_OUTPUT);
  ok(!('structuredContent' in out), 'structuredContent 未被剥离');
  eq(out.content.length, 1, '多出了块');
  eq(out.content[0].type, 'text', 'content 类型被改');
  eq(out.content[0].text, 'rows: 2', 'content 文本被改动');
  eq(out.isError, false, 'isError 丢失');
});

check('③ 不合法 → note 在最前、content 原文保留、structuredContent 被删', () => {
  const input = {
    content: [{ type: 'text', text: 'rows: 2' }],
    structuredContent: { rows: [{ id: 1 }, { id: 'oops' }] },
  };
  const out = applyStructuredOutputPolicy(input, QUERY_OUTPUT);
  ok(!('structuredContent' in out), 'structuredContent 未被剥离');
  eq(out.content.length, 2, 'content 块数不对（应为 note + 原文）');
  eq(out.content[0].type, 'text', 'note 不是 text 块');
  ok(/^\[MJCode\] 结构化输出未通过服务端声明的 outputSchema 校验/.test(out.content[0].text), `note 文案不符：${out.content[0].text}`);
  ok(/\$\.rows\[1\]\.id/.test(out.content[0].text), `note 未指出失配点：${out.content[0].text}`);
  ok(out.content[0].text.length <= 300, `note 超长：${out.content[0].text.length}`);
  eq(out.content[1].text, 'rows: 2', '原文 content 被改动');
});

// ── ③b 「有没有文本版」必须在插 note **之前**判定（bug 修复回归）──
// 改前的错：判定放在插 note 之后（hasNonEmptyTextBlock(out.content)），note 自身也是 text 块，
//   「无文本版」的结果被自己的提示伪装成「有文本版」→ structuredContent 被剥 → 模型只剩一句
//   「未通过校验」，眼前没有文本内容、也拿不到任何数据（与 fail-open 朝向可用性正好相反）。
const BAD_STRUCTURED = { rows: [{ id: 1 }, { id: 'oops' }] };

check('③b 无 content 字段 + 不匹配 → structuredContent **仍在**（模型拿得到数据），content 只有一条 note', () => {
  const input = { structuredContent: { rows: [{ id: 1 }, { id: 'oops' }] } };
  const out = applyStructuredOutputPolicy(input, QUERY_OUTPUT);
  ok(out.structuredContent, '无文本版时 structuredContent 被误剥（模型将什么都没有）');
  deepEq(out.structuredContent, BAD_STRUCTURED, 'structuredContent 被改动');
  eq(out.content.length, 1, 'content 块数不对（应只有 note）');
  ok(/^\[MJCode\] 结构化输出未通过服务端声明的 outputSchema 校验/.test(out.content[0].text), `note 缺失：${JSON.stringify(out.content[0])}`);
});

check('③b content 为空数组 + 不匹配 → structuredContent **仍在**', () => {
  const out = applyStructuredOutputPolicy({ content: [], structuredContent: { rows: [{ id: 1 }, { id: 'oops' }] } }, QUERY_OUTPUT);
  ok(out.structuredContent, '空 content 时 structuredContent 被误剥');
  eq(out.content.length, 1, 'content 块数不对（应只有 note）');
});

check('③b content 是裸字符串（不合规服务端）→ 原文被包装成 text 块**保留**、note 在最前、structuredContent **仍在**', () => {
  const input = { content: 'plain string', structuredContent: { rows: [{ id: 1 }, { id: 'oops' }] } };
  const out = applyStructuredOutputPolicy(input, QUERY_OUTPUT);
  ok(out.structuredContent, '字符串 content 不算「非空 text 块数组」，按 fail-open 应保留');
  eq(out.content.length, 2, 'content 块数不对（应为 note + 原文）');
  ok(/^\[MJCode\]/.test(out.content[0].text), `note 不在最前：${JSON.stringify(out.content[0])}`);
  eq(out.content[1].type, 'text', '原文未被包装成 text 块');
  eq(out.content[1].text, 'plain string', '服务端给的原文被静默丢弃');
});

check('③b content 是非数组对象（不合规服务端）→ 原文经 String() 包装保留（不静默丢弃），note 在最前', () => {
  const out = applyStructuredOutputPolicy({ content: { weird: true }, structuredContent: { rows: [{ id: 'oops' }] } }, QUERY_OUTPUT);
  eq(out.content.length, 2, 'content 块数不对');
  eq(out.content[1].type, 'text', '原文未被包装成 text 块');
  // 对象经 String() 退化为 '[object Object]'（有痕但无损语义）——重点是**不被静默丢弃**，
  // 且 note 仍带着失配点与「以文本为准」的可行动信息。比改前「整块替换成只有 note」强。
  eq(out.content[1].text, '[object Object]', '原文包装结果与实现不符');
  ok(/^\[MJCode\]/.test(out.content[0].text), 'note 不在最前');
});

check('③b 既有行为不回归：有文本块 + 不匹配 → 仍是 note 最前 + structuredContent 被剥', () => {
  const out = applyStructuredOutputPolicy({ content: [{ type: 'text', text: 'rows: 2' }], structuredContent: { rows: [{ id: 1 }, { id: 'oops' }] } }, QUERY_OUTPUT);
  ok(!('structuredContent' in out), '有文本版时 structuredContent 应被剥离');
  eq(out.content.length, 2, 'content 块数不对');
  ok(/^\[MJCode\]/.test(out.content[0].text), 'note 不在最前');
  eq(out.content[1].text, 'rows: 2', '原文 content 未保留');
});

check('③ content 无 text 块 → structuredContent **保留**（fail-open 朝向可用性）', () => {
  const input = { content: [{ type: 'image', data: 'base64...' }], structuredContent: { rows: [{ id: 1 }] } };
  const out = applyStructuredOutputPolicy(input, QUERY_OUTPUT);
  ok(out.structuredContent, '无文本块时 structuredContent 被剥掉了（模型将什么都没有）');
  deepEq(out.content, input.content, 'content 被改动');
});

check('③ content 为空数组 → structuredContent **保留**', () => {
  const input = { content: [], structuredContent: { rows: [] } };
  const out = applyStructuredOutputPolicy(input, QUERY_OUTPUT);
  ok(out.structuredContent, '空 content 时 structuredContent 被剥掉了');
});

check('③ 入参在调用前后深等于快照（策略绝不改入参）', () => {
  const input = {
    content: [{ type: 'text', text: 'rows: 2' }],
    structuredContent: { rows: [{ id: 1 }, { id: 'oops' }] },
  };
  const snap = stable(input);
  applyStructuredOutputPolicy(input, QUERY_OUTPUT);
  eq(stable(input), snap, '入参被就地修改');
  ok(input.structuredContent, '入参的 structuredContent 被删');
});

check('③ 超大 schema → 跳过校验但仍剥离、不抛', () => {
  const props = {};
  for (let i = 0; i < 800; i += 1) props[`p${i}`] = { type: 'string', description: 'x'.repeat(30) };
  const input = VALID_RESULT();
  let out = null;
  try {
    out = applyStructuredOutputPolicy(input, { type: 'object', properties: props });
  } catch (e) {
    throw new Error(`抛异常了：${e.message}`);
  }
  ok(!('structuredContent' in out), '超大 schema 时 structuredContent 未被剥离');
  eq(out.content.length, 1, '跳过校验不该产生 note');
});

check('③ 循环引用的 structuredContent 不抛（校验/剥离出错 → 原样返回）', () => {
  const cyc = { a: 1 };
  cyc.self = cyc;
  const input = { content: [{ type: 'text', text: 'x' }], structuredContent: cyc };
  let out = null;
  try {
    out = applyStructuredOutputPolicy(input, { type: 'object', properties: { a: { type: 'number' } } });
  } catch (e) {
    throw new Error(`抛异常了：${e.message}`);
  }
  ok(out && Array.isArray(out.content), '未返回可用结果');
});

check('③ isError 等其余字段保留在浅拷贝里', () => {
  const input = { content: [{ type: 'text', text: 'x' }], structuredContent: { a: 1 }, isError: true, extra: 'keep' };
  const out = applyStructuredOutputPolicy(input, { type: 'object', properties: { a: { type: 'number' } } });
  eq(out.isError, true, 'isError 丢失');
  eq(out.extra, 'keep', '其余字段丢失');
  ok(out !== input, '应返回浅拷贝');
});

check('③ 读 structuredContent 即抛的诡异结果 → 原样返回（策略不放大故障）', () => {
  const nasty = { content: [{ type: 'text', text: 'x' }] };
  Object.defineProperty(nasty, 'structuredContent', {
    enumerable: true, get() { throw new Error('boom'); },
  });
  const out = applyStructuredOutputPolicy(nasty, { type: 'object' });
  eq(out, nasty, '出错时应原样返回');
});

// ── ④ handler 层：驱动真实 main/ipc/mcp.js 的 callMcpTool ──
// electron / mcpClient 以 Module._load 打桩（既有测试无驱动 ipc/mcp.js 的先例，故此处自建：
// 只桩 electron 三个壳与 mcpClient 的取服/还原/RPC 三件事，策略与审批链路全部走真实代码）。
{
  const Module = require('node:module');
  const handlers = new Map();
  const state = { server: null, result: null };
  const electronStub = {
    app: { getPath: () => os.tmpdir() },
    ipcMain: { handle: (ch, fn) => { handlers.set(ch, fn); } },
    BrowserWindow: function () {},
  };
  const mcpClientStub = {
    getMcpServer: (n) => (state.server && state.server.name === n ? state.server : undefined),
    listMcpServers: () => (state.server ? [state.server.name] : []),
    resolveToolName: (_s, t) => t,
    mcpRpcWithSessionRetry: async () => state.result,
    killAllMcpServers: async () => {},
    disconnectMcpServer: () => {},
  };
  const ipcMcpFile = path.join(ROOT, 'main', 'ipc', 'mcp.js');
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const pf = parent && parent.filename ? parent.filename : '';
    if (request === 'electron') return electronStub;
    if (request === '../mcpClient' && pf.endsWith(path.join('main', 'ipc', 'mcp.js'))) return mcpClientStub;
    return origLoad.apply(this, arguments);
  };
  let mcpIpc = null;
  try {
    mcpIpc = require(ipcMcpFile);
    mcpIpc.initMcpIpc({
      requestApproval: async () => 'allow',
      applyApprovalDecision: () => {},
      getAlwaysRules: () => [],
      conversationRules: [],
      audit: () => {},
      emitTaskEvent: () => {},
      getCredentialCrypto: () => null,
    });
  } finally {
    Module._load = origLoad; // 桩只在本套件加载期生效，立即还原
  }
  const callHandler = (tool, args) => {
    const h = handlers.get('mcp:callTool');
    ok(typeof h === 'function', 'mcp:callTool handler 未注册');
    return h(null, { server: 'srv', tool, arguments: args || {} });
  };
  const setServer = (tools) => { state.server = { name: 'srv', tools }; };

  await checkAsync('④ handler：合法 structuredContent → 返回载荷无 structuredContent、无 note、文本原样', async () => {
    setServer([{ name: 'query', description: '查数据', inputSchema: QUERY_INPUT, outputSchema: QUERY_OUTPUT }]);
    state.result = { content: [{ type: 'text', text: 'rows: 2' }], structuredContent: { rows: [{ id: 1 }, { id: 2 }] } };
    const r = await callHandler('query', { sql: 'select 1' });
    ok(r && typeof r === 'object', 'handler 未返回对象');
    ok(!('structuredContent' in r), 'structuredContent 未从返回载荷剥离');
    eq(r.content.length, 1, '多出了 note');
    eq(r.content[0].text, 'rows: 2', 'content 文本被改动');
  });

  await checkAsync('④ handler：不合法 structuredContent → note 在最前且无 structuredContent', async () => {
    setServer([{ name: 'query', description: '查数据', inputSchema: QUERY_INPUT, outputSchema: QUERY_OUTPUT }]);
    state.result = { content: [{ type: 'text', text: 'rows: 2' }], structuredContent: { rows: [{ id: 1 }, { id: 'oops' }] } };
    const r = await callHandler('query', { sql: 'select 1' });
    ok(!('structuredContent' in r), 'structuredContent 未剥离');
    ok(/^\[MJCode\] 结构化输出未通过服务端声明的 outputSchema 校验/.test(r.content[0].text), `note 缺失或位置不对：${JSON.stringify(r.content[0])}`);
    eq(r.content[1].text, 'rows: 2', '原文 content 未保留');
  });

  await checkAsync('④ handler：服务端未声明 outputSchema → 结构化数据原样保留（策略只在声明时介入）', async () => {
    setServer([{ name: 'query', description: '查数据', inputSchema: QUERY_INPUT }]);
    state.result = { content: [{ type: 'text', text: 'rows: 2' }], structuredContent: { rows: [{ id: 1 }] } };
    const r = await callHandler('query', { sql: 'select 1' });
    ok(r.structuredContent, '无 outputSchema 时 structuredContent 被误剥');
    eq(r.content.length, 1, '无 outputSchema 时不该有 note');
  });

  await checkAsync('④ handler：isError 结果不受策略影响（仍带 toolError 透出）', async () => {
    setServer([{ name: 'query', description: '查数据', inputSchema: QUERY_INPUT, outputSchema: QUERY_OUTPUT }]);
    state.result = { content: [{ type: 'text', text: 'boom' }], isError: true };
    const r = await callHandler('query', { sql: 'select 1' });
    eq(r.isError, true, 'isError 丢失');
    eq(r.toolError, true, 'toolError 标记丢失');
  });
}

// ── ⑤ 静态断言：接线在位 ──
check('⑤ main/ipc/mcp.js 在 tools/call 唯一执行路径上接了策略（模块级缓存动态 import + 调用在 isError 判定前）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main/ipc/mcp.js'), 'utf8');
  ok(/function loadStructuredOutputPolicy/.test(src), '缺策略模块加载器');
  ok(/_structuredOutputMod\s*=\s*import\('\.\.\/\.\.\/shared\/mcpToolDefs\.mjs'\)/.test(src),
    '缺模块级缓存的动态 import（shared 是 ESM、本文件是 CJS；且不得在顶层 await）');
  const call = 'applyStructuredOutputPolicy(result, outputSchema)';
  ok(src.includes(call), '缺策略调用接线');
  ok(src.indexOf(call) < src.indexOf('const toolErr'), '接线点必须在 isError 判定之前');
});

console.log(`\n结果：${pass}/${total} 通过`);
