// 上下文预算闸 —— 全项目唯一常量源（B1-B-06 落地；B2-B-01 消费）
//
// 为什么必须单独一个文件：
//   第七轮审查 F-007 指出，第三方 MCP server 的 `description` / `inputSchema` 此前**原样**
//   进入 function schema 直达模型上下文（`shared/mcpToolDefs.mjs`），而工具**结果**侧已有
//   `detectInjection` 同级守卫——定义侧零守卫。加闸就必然引入「上限数字」，而这些数字如果
//   各写一份（mcpToolDefs 一份、mcpToolCache 一份、将来 agent-core 再一份），阈值一改就会
//   出现「构造时按 2000 截断、审计时按 4000 判超标」的自相矛盾。故本文件是**唯一**定义处：
//   任何模块要用上限，一律 import 这里的常量，禁止第二份硬编码。
//
// 取值依据（本轮口径：观测 + 轻截断，阈值后续按实测调整 —— B2-B-01 再收紧）：
//   · MAX_TOOL_DESCRIPTION_CHARS = 2000
//       观测模式先跑一轮的起点值。依据：
//         - 存量 MCP 服务（filesystem / time / fetch / git / playwright / desktop-commander）
//           的真实工具描述绝大多数在 100–800 字符区间，2000 相当于给它们留 2.5 倍余量，
//           本轮不会误伤存量工具；
//         - 单条 2000 字符 ≈ 500–700 token，52 个静态工具 + 3 个预热服务的 MCP 工具全量
//           披露仍在十万 token 级预算的可控区间内；
//         - 50 KB 级描述（F-007 的攻击形态）会被压到 2000 + 后缀，压缩比 > 25:1。
//       未验证项：这个值对「工具选择质量」的实际影响需要用真实模型跑一轮才能定，本轮**未验证**；
//       故本轮只做「超限即截断 + 留痕」，不做「超限即丢弃」。
//   · MAX_INPUT_SCHEMA_BYTES = 20000
//       单个 inputSchema 的 JSON 序列化字节上限。依据：存量工具 schema 实测多在 200–3000 字节；
//       20000 相当于 6 倍余量，只拦「爆炸式枚举/深嵌套」这类失控 schema，不拦正常复杂工具。
//   · MAX_INPUT_SCHEMA_DEPTH = 8
//       schema 嵌套层数上限（root 记 1 层；`properties`/`$defs` 这类「名字 → 子 schema」的
//       字典容器不额外计一层，见 schemaDepth 注释）。依据：存量工具 schema 深度 ≤ 4；
//       8 层足够表达 `object → properties → object → items → object` 这类合法结构，
//       而深 20 层的 schema 已无实际表达价值，只会拖垮序列化与模型理解。
//   · MAX_MCP_TOOL_CALLS_PER_SERVER / MAX_RESIDENT_MCP_SERVERS
//       先给**占位常量**：B2-B-01（工具发现粒度策略 / 常驻服务数上限）启用，本轮**不做强制**。
//       只是为了「上限只在一处定义」这条纪律先落地，避免 B2 又开第二份硬编码。
//
// 纪律：本文件是纯常量 + 纯函数（零依赖、无 Node 内置模块），可被主进程（CJS 动态 import）、
//   渲染层（Vite ESM）与 Node 测试共同消费——与 shared/untrustedContent.mjs 同构。

/** 单个工具 `description` 的字符上限（超限截断，见 truncateDescription）。 */
export const MAX_TOOL_DESCRIPTION_CHARS = 2000;

/** 单个 `inputSchema` 的 JSON 序列化字节上限（超限**不截断**，改为标记工具不可用）。 */
export const MAX_INPUT_SCHEMA_BYTES = 20000;

/** 单个 `inputSchema` 的最大嵌套层数（超限同上，标记不可用而非截断）。 */
export const MAX_INPUT_SCHEMA_DEPTH = 8;

/** 每服务单轮 MCP 工具调用上限 —— 占位，B2-B-01 启用，本轮不强制。 */
export const MAX_MCP_TOOL_CALLS_PER_SERVER = 40;

/** 常驻 MCP 服务数上限 —— 占位，B2-B-01 启用，本轮不强制。 */
export const MAX_RESIDENT_MCP_SERVERS = 8;

/**
 * 截断后缀。单独导出是为了「后缀也算进长度预算」时不出现第二处字面量
 * （测试断言 `length <= MAX_TOOL_DESCRIPTION_CHARS + 后缀长度` 必须与实现同源）。
 */
export const TOOL_DESCRIPTION_TRUNCATION_SUFFIX = '…[truncated]';

/**
 * 按字符上限截断工具描述；未超限原样返回。
 * @param {string} text
 * @param {number} [max]
 * @returns {{ text: string, truncated: boolean }}
 */
export function truncateDescription(text, max = MAX_TOOL_DESCRIPTION_CHARS) {
  const s = typeof text === 'string' ? text : String(text == null ? '' : text);
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max) + TOOL_DESCRIPTION_TRUNCATION_SUFFIX, truncated: true };
}

/**
 * schema 的 JSON 序列化字节数（UTF-8）。
 * 用 TextEncoder 而不是 Buffer/node:buffer —— 本模块要在渲染层（浏览器）里跑。
 * 序列化失败（含循环引用）时返回 Infinity：宁可判「超限」也不让一个坏 schema 静默通过。
 * @param {unknown} schema
 * @returns {number}
 */
export function schemaByteSize(schema) {
  try {
    const json = JSON.stringify(schema);
    if (typeof json !== 'string') return 0; // undefined / function：等价于空 schema
    return new TextEncoder().encode(json).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// 「名字 → 子 schema」的字典容器：本身不是一层 schema 嵌套。
// 不排除它们的话，`{properties:{q:{...}}}` 会被算成 3 层（root→properties 字典→q），
// 存量普通工具的深度会凭空 +1~2 层，8 层的闸就会误伤正常工具。
const SCHEMA_DICT_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);

// 递归硬顶：只用于防「程序构造出来的病态深嵌套」把调用栈打爆。
// 超过此值一律按此值报告（早已远超任何合理闸位，判定结论不受影响）。
const DEPTH_RECURSION_CAP = 64;

/**
 * schema 嵌套层数（root schema 记 1 层；字典容器不额外计层，见 SCHEMA_DICT_KEYS）。
 * 只有「普通对象 / 数组」算一层，原始值（string/number/bool/null）不加深。
 * @param {unknown} schema
 * @returns {number} 0 表示非对象结构（视作空 schema）
 */
export function schemaDepth(schema, _depth = 0, _key = '', _seen = new WeakSet()) {
  if (schema === null || typeof schema !== 'object') return _depth;
  if (_seen.has(schema)) return DEPTH_RECURSION_CAP; // 循环引用：fail-closed，按超限处理
  if (_depth >= DEPTH_RECURSION_CAP) return DEPTH_RECURSION_CAP;
  _seen.add(schema);
  const here = SCHEMA_DICT_KEYS.has(_key) ? _depth : _depth + 1;
  let deepest = here;
  const entries = Array.isArray(schema)
    ? schema.map((v, i) => [String(i), v])
    : Object.entries(schema);
  for (const [k, v] of entries) {
    const d = schemaDepth(v, here, k, _seen);
    if (d > deepest) deepest = d;
  }
  _seen.delete(schema); // 同一子 schema 被多处引用不重复计入
  return deepest;
}

/**
 * 一次性给出某个 schema / 描述相对预算闸的判定结果（供审计与守卫共用，避免两处各算一遍）。
 * @param {{description?: unknown, inputSchema?: unknown}} tool
 * @returns {{descriptionChars: number, schemaBytes: number, schemaDepth: number,
 *            descriptionTruncated: boolean, schemaTooLarge: boolean, reason: string}}
 */
export function inspectToolDefinition(tool) {
  const t = tool && typeof tool === 'object' ? tool : {};
  const descriptionChars = typeof t.description === 'string' ? t.description.length : 0;
  const schema = t.inputSchema === undefined || t.inputSchema === null ? { type: 'object', properties: {} } : t.inputSchema;
  const schemaBytes = schemaByteSize(schema);
  const schemaDepthValue = schemaDepth(schema);
  const sizeOver = schemaBytes > MAX_INPUT_SCHEMA_BYTES;
  const depthOver = schemaDepthValue > MAX_INPUT_SCHEMA_DEPTH;
  const parts = [];
  if (sizeOver) parts.push(`schema ${schemaBytes} bytes > ${MAX_INPUT_SCHEMA_BYTES}`);
  if (depthOver) parts.push(`schema 深度 ${schemaDepthValue} > ${MAX_INPUT_SCHEMA_DEPTH}`);
  return {
    descriptionChars,
    schemaBytes,
    schemaDepth: schemaDepthValue,
    descriptionTruncated: descriptionChars > MAX_TOOL_DESCRIPTION_CHARS,
    schemaTooLarge: sizeOver || depthOver,
    reason: parts.join('；'),
  };
}
