// MCP 工具定义 —— 跨宿主单一事实来源（第六轮 N5）
//
// 背景（第六轮审查 N5）：`toToolDefs` 曾在渲染层（renderer/src/lib/mcpTools.js）与主进程
//   （main/intentMcpPrewarm.js）各有一份「同形」实现，靠人工同步。一旦其中一处改了命名/描述
//   规范化策略，另一条路径就会**静默产出不同形状**的 MCP 工具定义（同一服务经两条路径不兼容）。
//   本文件把构造 / 排序 / 去重三项收敛到唯一实现：
//     · 渲染层（ESM）静态 `import { ... } from '.../shared/mcpToolDefs.mjs'`；
//     · 主进程（CJS）经 `import('../shared/mcpToolDefs.mjs')` 动态加载（见 intentMcpPrewarm.loadMcpToolDefs）。
//   与 shared/untrustedContent.mjs、shared/resumeIntent.mjs、shared/sandboxNotice.mjs 同构。
//
// 背景（第六轮 G9）：MCP 工具披露顺序此前 = 主进程返回顺序（`flatMap` 原序、无排序），
//   披露序列随连接顺序/配置顺序变化 → **前缀缓存不稳定**。这里提供 `sortServerEntries`，
//   按「服务名 → 工具名」稳定排序，保证相同配置下披露序列**字节稳定**。

/** 服务端工具清单 → OpenAI function 定义（agent-core 消费格式）。 */
export function toToolDefs(server, tools) {
  const s = String(server || '');
  return (Array.isArray(tools) ? tools : [])
    .filter((t) => t && t.name)
    .map((t) => ({
      type: 'function',
      function: {
        name: `mcp__${s}__${t.name}`,
        description: t.description || t.name,
        parameters: t.inputSchema || { type: 'object', properties: {} },
      },
    }));
}

/**
 * 披露确定性排序：对 [{server, tools}] 条目先按服务名、再按工具名做稳定排序。
 * 返回值是**新对象/新数组**（不改动入参），供 flatMap(toToolDefs) 使用。
 * 排序键为纯字符串比较（不依赖 locale），跨平台/跨宿主结果一致。
 */
export function sortServerEntries(list) {
  return (Array.isArray(list) ? list : [])
    .filter((e) => e && e.server)
    .map((e) => ({
      server: String(e.server),
      tools: (Array.isArray(e.tools) ? e.tools : []).filter((t) => t && t.name),
    }))
    .sort((a, b) => (a.server < b.server ? -1 : a.server > b.server ? 1 : 0))
    .map((e) => ({
      server: e.server,
      tools: [...e.tools].sort((x, y) => {
        const nx = String(x.name);
        const ny = String(y.name);
        return nx < ny ? -1 : nx > ny ? 1 : 0;
      }),
    }));
}

/** 按「服务名 → 工具名」稳定排序并直接产出 OpenAI function 定义（排序 + 构造一步到位）。 */
export function sortedToolDefs(list) {
  return sortServerEntries(list).flatMap(({ server, tools }) => toToolDefs(server, tools));
}

/** 合并工具定义：按 function.name 去重，base（本轮已有）优先，避免同一工具出现两份。 */
export function mergeToolDefs(base = [], additions = []) {
  const seen = new Set();
  const out = [];
  for (const t of [...(Array.isArray(base) ? base : []), ...(Array.isArray(additions) ? additions : [])]) {
    const n = t && t.function && t.function.name;
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(t);
  }
  return out;
}
