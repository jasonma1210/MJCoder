// B2-B-01（D-03 第一阶段）门禁：上下文预算闸 —— 常量有效性 + 单一来源 + 观测函数行为
// 运行：node test/context-budget.test.mjs
//
// 背景：第七轮审查 F-007 指出工具**定义**侧零守卫（描述/ schema 原样直达模型上下文）。
//   B1-B-06 已在 `shared/contextBudget.mjs` 建立唯一常量源并落地三道单工具闸；
//   B2-B-01 补齐两个此前是占位的常量（常驻服务数 / 工具表总字节），本轮**只设阈值不强制**
//   （观测档：超限只留痕，不截断、不改行为），故本套件锁三件事：
//     ① 所有上限都是有效正整数（`0`/`NaN`/`undefined` 会让闸门静默失效——比不设闸更危险）；
//     ② 上限**只有一个来源**：`mcpToolDefs.mjs` / `mcpToolCache.js` / `agent-core/index.js`
//        都不得再出现第二份硬编码数字（阈值一改就会出现「构造按 A、审计按 B」的自相矛盾）；
//     ③ 观测函数真能区分超限与未超限（超限产出告警文案、未超限静默），且**不修改入参**。
//
// 另锁「实测基线仍然成立」：52 个静态工具 + 3 个默认预热服务的字节量级若发生数量级变化，
// 说明 MAX_TOOL_SCHEMA_TOTAL_BYTES 的取值依据已失效，需要重新定值（这里只判量级，不钉死字节数，
// 避免又造出一处会过期的写死数字）。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');

const budget = await import(path.join(ROOT, 'shared/contextBudget.mjs'));
const {
  MAX_TOOL_DESCRIPTION_CHARS,
  MAX_INPUT_SCHEMA_BYTES,
  MAX_INPUT_SCHEMA_DEPTH,
  MAX_MCP_TOOL_CALLS_PER_SERVER,
  MAX_RESIDENT_MCP_SERVERS,
  MAX_TOOL_SCHEMA_TOTAL_BYTES,
  TOOL_DESCRIPTION_TRUNCATION_SUFFIX,
  toolTableByteSize,
  inspectToolTableBudget,
} = budget;
const { BASE_TOOLS, LOAD_SKILL_TOOL, runAgent } = await import(path.join(ROOT, 'agent-core/index.js'));
const mcpToolDefs = await import(path.join(ROOT, 'shared/mcpToolDefs.mjs'));

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
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── ① 常量有效性 ──
const ALL_LIMITS = {
  MAX_TOOL_DESCRIPTION_CHARS,
  MAX_INPUT_SCHEMA_BYTES,
  MAX_INPUT_SCHEMA_DEPTH,
  MAX_MCP_TOOL_CALLS_PER_SERVER,
  MAX_RESIDENT_MCP_SERVERS,
  MAX_TOOL_SCHEMA_TOTAL_BYTES,
};

check('① 六个上限都是有效正整数（0/NaN/undefined 会让闸门静默失效）', () => {
  for (const [k, v] of Object.entries(ALL_LIMITS)) {
    eq(typeof v, 'number', `${k} 不是数字`);
    ok(Number.isInteger(v), `${k} 不是整数：${v}`);
    ok(v > 0, `${k} 必须为正：${v}`);
    ok(Number.isFinite(v), `${k} 必须有限：${v}`);
  }
});

check('① 两个 B2 补齐的常量不再是占位（有取值依据、可被观测逻辑直接用）', () => {
  eq(MAX_RESIDENT_MCP_SERVERS, 8, '常驻服务数上限');
  eq(MAX_TOOL_SCHEMA_TOTAL_BYTES, 65536, '工具表总字节上限');
  // 结构与量级自洽：单工具字节上限必须远小于整表上限，否则一个合法工具就能撑爆整表
  ok(MAX_INPUT_SCHEMA_BYTES * 2 < MAX_TOOL_SCHEMA_TOTAL_BYTES,
    `单工具上限 ${MAX_INPUT_SCHEMA_BYTES} 与整表上限 ${MAX_TOOL_SCHEMA_TOTAL_BYTES} 不成比例`);
  // 整表上限必须容得下「静态工具 + 1 个默认预热服务」，否则开箱即告警（观测档的信噪比要求）
  ok(MAX_TOOL_SCHEMA_TOTAL_BYTES > toolTableByteSize(BASE_TOOLS) * 1.5,
    '整表上限对静态工具余量不足 1.5 倍，默认配置就会持续告警');
});

check('① 截断后缀与 description 上限同源（实现与测试不得各写一份）', () => {
  ok(TOOL_DESCRIPTION_TRUNCATION_SUFFIX.length > 0, '后缀为空');
  const { text, truncated } = budget.truncateDescription('x'.repeat(MAX_TOOL_DESCRIPTION_CHARS + 10));
  eq(truncated, true, '超限未标记截断');
  eq(text.length, MAX_TOOL_DESCRIPTION_CHARS + TOOL_DESCRIPTION_TRUNCATION_SUFFIX.length, '截断长度');
  const exact = budget.truncateDescription('x'.repeat(MAX_TOOL_DESCRIPTION_CHARS));
  eq(exact.truncated, false, '恰好等于上限不应判截断（差一错误）');
});

// ── ② 单一来源：不得出现第二份硬编码 ──
// 判定口径：在被扫描文件里，若出现「常量名 = 数字字面量」的赋值/声明，即判为第二份定义。
const SOURCES = [
  'shared/mcpToolDefs.mjs',
  'shared/contextBudget.mjs',
  'main/mcpToolCache.js',
  'agent-core/index.js',
];

check('② 除 contextBudget.mjs 外，无人再声明同名阈值常量（第二份硬编码）', () => {
  const offenders = [];
  for (const rel of SOURCES) {
    const src = readSrc(rel);
    for (const name of Object.keys(ALL_LIMITS)) {
      // 允许：export const X = <非纯数字表达式>（如引用别的常量）；禁止：X = 纯数字字面量
      const re = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*\\d`, 'g');
      const hits = src.match(re) || [];
      if (!hits.length) continue;
      // contextBudget.mjs 是唯一合法定义处
      if (rel === 'shared/contextBudget.mjs') continue;
      offenders.push(`${rel}: ${hits.join(', ')}`);
    }
  }
  ok(offenders.length === 0, `出现第二份阈值定义（必须 import shared/contextBudget.mjs）：\n  ${offenders.join('\n  ')}`);
});

check('② contextBudget.mjs 自己确实是定义处（正例，避免上面那条因正则写错而空过）', () => {
  const src = readSrc('shared/contextBudget.mjs');
  for (const name of Object.keys(ALL_LIMITS)) {
    ok(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*\\d`).test(src), `${name} 未在 contextBudget.mjs 中定义`);
  }
});

check('② mcpToolDefs / mcpToolCache / agent-core 都从 contextBudget.mjs 取值（不是各写一份）', () => {
  ok(/from '\.\/contextBudget\.mjs'/.test(readSrc('shared/mcpToolDefs.mjs')),
    'mcpToolDefs.mjs 未 import contextBudget.mjs');
  ok(/import\('\.\.\/shared\/contextBudget\.mjs'\)/.test(readSrc('main/mcpToolCache.js')),
    'mcpToolCache.js 未动态 import contextBudget.mjs');
  ok(/from '\.\.\/shared\/contextBudget\.mjs'/.test(readSrc('agent-core/index.js')),
    'agent-core 未 import contextBudget.mjs（观测逻辑必须用同一份上限）');
});

check('② agent-core 的观测逻辑不得自带上限数字（必须走 inspectToolTableBudget 缺省值）', () => {
  const src = readSrc('agent-core/index.js');
  const call = (src.match(/inspectToolTableBudget\([^)]*\)/g) || []);
  eq(call.length, 1, `inspectToolTableBudget 调用次数（期望恰好 1 处）：${call.join(' | ')}`);
  ok(!/\d{4,}/.test(call[0]), `调用处传了字面量上限：${call[0]}`);
});

// ── ③ 观测函数行为：超限告警、未超限静默 ──
check('③ 未超限：over=false、reason 为空串（静默，不产生告警噪声）', () => {
  const r = inspectToolTableBudget([], 1024);
  eq(r.over, false, '空工具表被判超限');
  eq(r.reason, '', '未超限却给了告警文案');
  eq(r.bytes, 2, '空数组 JSON 字节数应为 2（"[]"）');
  eq(r.toolCount, 0);
  eq(r.limit, 1024, 'limit 未按入参生效');
});

check('③ 超限：over=true 且 reason 同时含实际字节与上限（排查信息不能缺）', () => {
  const tools = [{ type: 'function', function: { name: 'a', description: 'x'.repeat(200), parameters: { type: 'object' } } }];
  const bytes = toolTableByteSize(tools);
  const r = inspectToolTableBudget(tools, 10);
  eq(r.over, true, '未判超限');
  eq(r.bytes, bytes, '字节数与 toolTableByteSize 不同源');
  ok(r.reason.includes(String(bytes)), `reason 缺实际字节：${r.reason}`);
  ok(r.reason.includes('10'), `reason 缺上限：${r.reason}`);
  eq(r.toolCount, 1, 'reason 之外还应给出工具数');
});

check('③ 边界：恰好等于上限不算超限（> 而非 >=，避免「刚好卡线」时误报）', () => {
  const tools = [{ type: 'function', function: { name: 'b', parameters: {} } }];
  const exact = toolTableByteSize(tools);
  eq(inspectToolTableBudget(tools, exact).over, false, '等于上限被判超限');
  eq(inspectToolTableBudget(tools, exact - 1).over, true, '比上限多 1 字节却未判超限');
});

check('③ 不可枚举的内部标记不计入字节（与线上报文同口径）', () => {
  const plain = [{ type: 'function', function: { name: 'c', parameters: {} } }];
  const marked = [{ type: 'function', function: { name: 'c', parameters: {} } }];
  Object.defineProperty(marked[0], '__blocked__', { value: '[schema-too-large] '.repeat(50), enumerable: false });
  Object.defineProperty(marked[0], '__untrusted__', { value: true, enumerable: false });
  eq(toolTableByteSize(marked), toolTableByteSize(plain), '不可枚举标记被算进了字节数（口径与报文不一致）');
  eq(toolTableByteSize(marked), Buffer.byteLength(JSON.stringify(marked), 'utf8'), '计量口径应与 JSON.stringify 一致');
});

check('③ 坏输入不抛：循环引用 / 非数组一律安全返回', () => {
  const cyclic = { type: 'function', function: { name: 'd', parameters: {} } };
  cyclic.self = cyclic;
  eq(toolTableByteSize([cyclic]), Number.POSITIVE_INFINITY, '循环引用应返回 Infinity（fail-closed）');
  eq(inspectToolTableBudget([cyclic], 1024).over, true, '循环引用未判超限');
  eq(toolTableByteSize(null), 2, 'null 应按空表处理');
  eq(toolTableByteSize({ notArray: 1 }), 2, '非数组应按空表处理');
  eq(inspectToolTableBudget(null).toolCount, 0, 'null 入参应返回 0 个工具');
});

check('③ 观测是纯函数：不修改入参（观测档绝不允许改行为）', () => {
  const tools = [{ type: 'function', function: { name: 'e', parameters: { type: 'object' } } }];
  const before = JSON.stringify(tools);
  const keysBefore = Object.keys(tools[0]).join(',');
  inspectToolTableBudget(tools, 1);
  toolTableByteSize(tools);
  eq(JSON.stringify(tools), before, '观测过程改动了工具定义');
  eq(Object.keys(tools[0]).join(','), keysBefore, '观测过程给工具定义加了键');
});

// ── ③b 端到端：runAgent 里超限只留痕、不改下发的工具集合 ──
// 这一条是本轮「观测档」语义的核心证据：如果观测逻辑误改成截断，工具数会变少 → 这里必红。
// 构造方式：custom tools 通道喂一张**真的超限**的工具表（40 × 1800 字符描述 ≈ 72 KB > 64 KiB）。
const MODEL = {
  provider: { id: 1, isGlobal: false, base_url: 'https://api.test/v1' },
  model: { id: 1, model_id: 'budget-test', context_window: 128000 },
};
function bigToolTable(n, descChars) {
  return Array.from({ length: n }, (_, i) => ({
    type: 'function',
    function: { name: `fake_${i}`, description: 'x'.repeat(descChars), parameters: { type: 'object', properties: {} } },
  }));
}

await checkAsync('③b 超限时 runAgent 仍下发全量工具，只多一条 tool_table_budget trace（不截断）', async () => {
  const tools = bigToolTable(40, 1800);
  const bytes = toolTableByteSize(tools);
  ok(bytes > MAX_TOOL_SCHEMA_TOTAL_BYTES, `构造失败：工具表只有 ${bytes} 字节，未超上限 ${MAX_TOOL_SCHEMA_TOTAL_BYTES}`);
  const traceEvents = [];
  let captured = null;
  await runAgent({
    messages: [{ role: 'user', content: 'hi' }],
    model: MODEL,
    cwd: path.resolve(ROOT),
    tools,
    onTrace: (e) => traceEvents.push(e),
    toolHandlers: { chat: async (payload) => { captured = payload; return { content: 'ok', usage: { prompt_tokens: 1, completion_tokens: 1 } }; } },
  });
  ok(captured, 'chat 通道未被调用');
  eq(captured.tools.length, 40, `超限时工具数被改动（观测档不得截断）：${captured.tools.length}`);
  eq(captured.tools[0].function.description.length, 1800, '超限时工具描述被改动');
  const events = traceEvents.filter((e) => e && e.type === 'tool_table_budget');
  eq(events.length, 1, `超限应恰好留一条 trace，实际 ${events.length} 条`);
  eq(events[0].bytes, bytes, 'trace 里的字节数与实际不符');
  eq(events[0].limit, MAX_TOOL_SCHEMA_TOTAL_BYTES, 'trace 里的上限与常量不同源');
  eq(events[0].tools, 40, 'trace 里的工具数不符');
});

await checkAsync('③b 未超限时 runAgent 不产出 tool_table_budget 事件（无噪声）', async () => {
  const traceEvents = [];
  let captured = null;
  const tools = [{ type: 'function', function: { name: 'tiny', description: 't', parameters: { type: 'object' } } }];
  await runAgent({
    messages: [{ role: 'user', content: 'hi' }],
    model: MODEL,
    cwd: path.resolve(ROOT),
    tools,
    onTrace: (e) => traceEvents.push(e),
    toolHandlers: { chat: async (payload) => { captured = payload; return { content: 'ok', usage: { prompt_tokens: 1, completion_tokens: 1 } }; } },
  });
  eq((captured?.tools || []).length, 1, '工具数被改动');
  const noise = traceEvents.filter((e) => e && e.type === 'tool_table_budget');
  eq(noise.length, 0, `未超限却产生了告警：${JSON.stringify(noise)}`);
});

// ── ④ 实测基线量级仍成立（阈值取值依据的有效性检查）──
check('④ 实测基线量级未失效：52 个静态工具整表 20–60 KB，且远小于整表上限', () => {
  eq(BASE_TOOLS.length, 52, `静态工具条数变了（${BASE_TOOLS.length}），阈值取值依据需重算`);
  const bytes = toolTableByteSize(BASE_TOOLS);
  ok(bytes > 20000 && bytes < 60000, `静态工具表 ${bytes} 字节不在实测基线量级（20–60 KB）`);
  ok(bytes < MAX_TOOL_SCHEMA_TOTAL_BYTES, `静态工具表 ${bytes} 已超整表上限 ${MAX_TOOL_SCHEMA_TOTAL_BYTES}`);
  ok(toolTableByteSize([...BASE_TOOLS, LOAD_SKILL_TOOL]) < MAX_TOOL_SCHEMA_TOTAL_BYTES,
    '53 工具形态（+load_skill）已超整表上限');
});

check('④ 单工具闸与整表闸不冲突：所有静态工具都过单工具闸', () => {
  for (const t of BASE_TOOLS) {
    // 注意字段映射：function 定义里叫 parameters，inspectToolDefinition 读的是 inputSchema
    const r = budget.inspectToolDefinition({ description: t.function.description, inputSchema: t.function.parameters });
    eq(r.schemaTooLarge, false, `${t.function.name} 的 schema 超单工具闸（整表闸之前就先失控了）：${r.reason}`);
    ok(r.descriptionChars <= MAX_TOOL_DESCRIPTION_CHARS, `${t.function.name} 的描述 ${r.descriptionChars} 超单工具描述上限`);
  }
});

// ── ⑤ 与定义侧闸门同源：blocked 标记的生产者与消费者口径一致 ──
check('⑤ `__blocked__` 的语义仍由 mcpToolDefs.isBlockedToolDef 定义（agent-core 读同一契约）', () => {
  const marker = mcpToolDefs.isBlockedToolDef({ __blocked__: 'reason' });
  eq(marker, 'reason', 'isBlockedToolDef 读取语义变了');
  const blocked = mcpToolDefs.toToolDefs('srv', [{
    name: 'deep',
    inputSchema: (() => { let n = { type: 'string' }; for (let i = 0; i < 20; i += 1) n = { type: 'object', properties: { [`n${i}`]: n } }; return n; })(),
  }])[0];
  ok(mcpToolDefs.isBlockedToolDef(blocked).length > 0, '20 层 schema 未被标记 blocked');
  ok(!Object.keys(blocked).includes('__blocked__'), '标记必须不可枚举（否则进线上报文）');
  ok(!JSON.stringify(blocked).includes('__blocked__'), '标记进了 JSON 报文');
});

console.log(`\n结果：${pass}/${total} 通过`);
