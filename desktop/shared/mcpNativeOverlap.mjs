// 「原生已覆盖」的 MCP 能力表 —— 跨宿主单一事实来源（第八轮 A-04）
//
// ── 问题（改前）──────────────────────────────────────────────────────────────
//   `main/intentMcpPrewarm.js` 的「原生优先」规则已经写了：某能力若被原生工具覆盖，
//   就不去拉对应的 MCP 服务（表里 `native: true` + `nativeTools`）。但那条规则**只作用于
//   「意图预热时新增的连接」**，不作用于**已连接**的服务。而 `filesystem` 属于懒启动白名单
//   （`mcpPrewarm.PREWARM_NAMES`），默认就会被拉起并常驻连接，于是它的
//   read/write/list 类工具每轮都在工具表里，与原生 `read_file / write_file / edit_file /
//   apply_patch / list_dir / grep / glob` **同 run 同框** —— 恰恰是 `intentMcpPrewarm.js`
//   文件头声称要避免的「两套实现同框」。
//
//   代价有两条，都不是理论问题：
//     ① **上下文税**：重复能力常驻工具表，每轮都进 prompt 前缀；工具表字节一变还会
//        打掉前缀缓存（`inspectToolTableBudget` 只观测不强制）；
//     ② **模型选择歧义**：两条路径都能读写同一目录，模型可能一半用原生、一半用 MCP，
//        写入台账（`verify_ledger`）的口径因此可能漏计。
//
// ── 本模块的职责 ────────────────────────────────────────────────────────────
//   只声明「哪些 server 的哪些 tool 已被原生实现覆盖」，以及一个纯过滤函数。
//   判定与执行留在消费方（`agent-core` 的 allTools 组装点、`intentMcpPrewarm` 的意图规则），
//   本文件不 import 任何东西、不碰 IO —— 与 `shared/contextBudget.mjs` 同构，
//   主进程（CJS 动态 import）与引擎/渲染层（ESM 静态 import）可共用。
//
// ── 三条设计约束（改表前必读）───────────────────────────────────────────────
//   ① **只认显式声明**：表里没有的 server/tool 一律**保留**。默认保留的理由是
//      「宁可多一个工具，也不要无声削掉一个用户依赖的能力」——MCP server 的工具名由第三方
//      决定，猜名字就是在赌，赌错的代价是用户的功能凭空消失。
//   ② **只写「有直接原生对应」的工具**：`move_file` 这类没有一对一原生实现的**不列入**
//      （shell 能做不算「原生工具覆盖」——shell 是通用能力，不是同名替代）。
//   ③ **可回退**：环境变量 `MJCODE_MCP_NATIVE_OVERLAP=0` 关闭本机制（排查「某个 MCP 工具
//      怎么不见了」时的第一开关）。关闭后行为与改前逐字一致。
//
// ── 与「schema 超限下架」的关系 ─────────────────────────────────────────────
//   两者都在 `agent-core` 的 allTools 组装处、都走「只减不增、绝不抛异常」的纪律，
//   但**理由不同、判据独立**：一个是「这个工具不可调用」，一个是「这个工具与原生重复」。
//   日志必须分开打，否则排查时分不清是「太大」还是「重复」。

/** 关闭本机制的环境变量（值为 `0` / `false` / `off`，大小写不敏感）。 */
export const NATIVE_OVERLAP_ENV = 'MJCODE_MCP_NATIVE_OVERLAP';

/**
 * 覆盖表：`server 名（未编码的原始名） → { tools: { mcp 工具名: 原生工具名 }, note }`。
 *
 * 只收录官方参考 server 的稳定工具名。第三方同名 server（比如某个也叫 `filesystem` 的
 * 自研实现）如果工具名不同，本表自然不命中——这正是「按工具名精确匹配」的好处：
 * 不会因为服务名撞车而误删。
 */
export const NATIVE_OVERLAP = {
  filesystem: {
    note: '官方 filesystem server：全部读写/列目录能力与原生文件工具有一对一对应',
    tools: {
      read_file: 'read_file',
      read_text_file: 'read_file',
      read_multiple_files: 'read_file',
      read_media_file: 'read_file',
      write_file: 'write_file',
      edit_file: 'edit_file',
      create_directory: 'list_dir',
      list_directory: 'list_dir',
      list_directory_with_sizes: 'list_dir',
      directory_tree: 'glob',
      search_files: 'grep',
      get_file_info: 'list_dir',
      list_allowed_directories: 'list_dir',
    },
  },
  fetch: {
    note: '官方 fetch server：单次抓取与原生 web_fetch 重叠（web_fetch 已含 SSRF 守卫，见 main/ssrfGuard.js）',
    tools: { fetch: 'web_fetch' },
  },
};

/**
 * 该 MCP 工具是否已被原生实现覆盖。
 * @param {string} serverName 解码后的服务名
 * @param {string} toolName 服务侧原始工具名（不含 `mcp__` 前缀）
 * @returns {string} 覆盖它的原生工具名；未覆盖返回空串
 */
export function nativeToolFor(serverName, toolName) {
  const entry = NATIVE_OVERLAP[String(serverName || '')];
  if (!entry || !entry.tools) return '';
  const native = entry.tools[String(toolName || '')];
  return native ? String(native) : '';
}

/**
 * 本机制是否启用。
 * @param {Record<string,string>} [env]
 */
export function nativeOverlapEnabled(env = globalThis.process?.env || {}) {
  const raw = String(env?.[NATIVE_OVERLAP_ENV] ?? '').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off');
}

/**
 * 过滤一批 MCP 工具定义：把「原生已覆盖」的挑出去。
 *
 * @param {Array<object>} tools 工具定义数组（`{ type, function: { name } }`）
 * @param {(fullName: string) => ({server: string, tool: string}|null)} decode 名字反解（注入以避免循环依赖）
 * @param {{env?: Record<string,string>, exempt?: (fullName:string)=>boolean}} [opts]
 *   exempt：显式豁免判定。**用户/角色显式点名要的工具不在这里下架**——默认策略（原生优先）
 *   不该压过显式声明：数字员工的 `toolNames` 白名单里写了 `mcp__filesystem__read_file`，
 *   说明作者是刻意选的，把它按「重复」删掉等于让白名单静默失效。
 * @returns {{kept: Array<object>, removed: Array<{fullName:string, server:string, tool:string, native:string}>}}
 */
export function filterNativeOverlapped(tools, decode, { env, exempt } = {}) {
  const list = Array.isArray(tools) ? tools : [];
  if (!nativeOverlapEnabled(env) || typeof decode !== 'function') {
    return { kept: list, removed: [] };
  }
  const exempted = typeof exempt === 'function' ? exempt : () => false;
  const kept = [];
  const removed = [];
  for (const t of list) {
    const fullName = t && t.function && typeof t.function.name === 'string' ? t.function.name : '';
    const parsed = fullName ? decode(fullName) : null;
    const native = parsed && !exempted(fullName) ? nativeToolFor(parsed.server, parsed.tool) : '';
    if (native) removed.push({ fullName, server: parsed.server, tool: parsed.tool, native });
    else kept.push(t);
  }
  return { kept, removed };
}
