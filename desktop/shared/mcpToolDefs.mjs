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
//
// 背景（第七轮 F-007 / B1-B-06）：工具**定义**侧此前零守卫 —— 第三方 server 的 `description`
//   与 `inputSchema` **原样**进入 function schema 直达模型上下文（`mcpClient.js` 只清洗工具名，
//   `mcpToolCache.js` 原样缓存）。对照工具**结果**侧早就有 `detectPromptInjection` 级别的守卫，
//   定义侧却可以被一个失控/恶意 server 用来：
//     · 用 50 KB 描述挤占上下文（挤掉系统提示与真实工具）；
//     · 在描述里夹带「IGNORE ALL PREVIOUS INSTRUCTIONS」这类指令，直接影响工具选择与行为；
//     · 用爆炸式枚举 / 深 20 层嵌套 schema 拖垮序列化与模型理解。
//   本文件因此在构造点加三道闸（上限常量全部 import 自 shared/contextBudget.mjs，**不在这里
//   写第二份数字**）：
//     ① `description` 超 `MAX_TOOL_DESCRIPTION_CHARS` → 截断 + `TOOL_DESCRIPTION_TRUNCATION_SUFFIX`；
//     ② `inputSchema` 超字节/深度上限 → **不截断 schema**（截断会产出非法 schema，调用必失败），
//        改为把该工具标记为不可用（`__blocked__` + description 前缀），由调用方过滤；
//     ③ 所有 MCP 工具一律携带 `__untrusted__: true`（来源是第三方）。
//   铁律：**任何一个坏工具都不能拖垮整个 server** —— 三道闸只标记/截断，绝不抛异常中断连接。

import {
  MAX_TOOL_DESCRIPTION_CHARS,
  MAX_INPUT_SCHEMA_BYTES,
  MAX_INPUT_SCHEMA_DEPTH,
  TOOL_DESCRIPTION_TRUNCATION_SUFFIX,
  inspectToolDefinition,
  truncateDescription,
} from './contextBudget.mjs';
import { detectPromptInjection } from './untrustedContent.mjs';
// 第八轮 F-005 / B1-B-05：工具名**拼名**收敛到 codec（与 agent-core 的反解严格互逆）。
// 改前这里是内联 `` `mcp__${s}__${t.name}` ``，而 agent-core 反解时把名字按 `__` 切分取服务名 ——
// 二者不互逆，server 名含 `__` 时调用会静默打到另一个服务上。详见 shared/mcpNameCodec.mjs 文件头。
import { buildToolName } from './mcpNameCodec.mjs';

export { MAX_TOOL_DESCRIPTION_CHARS, MAX_INPUT_SCHEMA_BYTES, MAX_INPUT_SCHEMA_DEPTH };

/**
 * 在工具定义上打**不可枚举**标记。
 *
 * 为什么不可枚举（关键设计决策，勿改）：
 *   `toToolDefs` 的产出经 `agent-core` 的 `allTools` 直接作为 `tools` 交给宿主
 *   （`agent-core/index.js:2714` → `main/scheduledChannels.js:82-83` 原样写入
 *   `body.tools` → 供应商 HTTP body）。若标记是可枚举属性，它会被序列化进每一次模型请求，
 *   等于给所有供应商的 tool schema 塞了规范外的字段——轻则被忽略，重则 400，
 *   而下游消费方（agent-core / scheduledChannels）本轮不在本任务可改范围内。
 *   改成不可枚举后：**线上报文与改动前逐字节一致**，而进程内的调用方
 *   （`isBlockedToolDef` / 审计 / 测试）仍可正常读到标记。
 */
function defineHidden(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return target;
}

/** 该工具定义是否被长度闸判为不可用（调用方据此过滤；返回原因字符串或空串）。 */
export function isBlockedToolDef(def) {
  return (def && typeof def === 'object' && def.__blocked__) || '';
}

/**
 * 服务端工具清单 → OpenAI function 定义（agent-core 消费格式）。
 *
 * 返回结构保持与改动前**完全同形**（`{type, function:{name, description, parameters}}`），
 * 长度闸产生的元信息一律以不可枚举属性挂在定义对象上：
 *   · `__untrusted__: true`  —— 所有 MCP 工具恒有（第三方来源）；
 *   · `__blocked__: '<原因>'` —— 仅 schema 超限的工具（调用方应过滤掉）；
 *   · `__injection__: [规则id]` —— 描述命中注入特征的规则清单（只留痕，不阻断：
 *     定义侧阻断会因误报把正常工具整块下架，处置权留给调用方/审计）。
 *
 * 不抛异常：单个坏工具只影响它自己。
 */
export function toToolDefs(server, tools) {
  const s = String(server || '');
  return (Array.isArray(tools) ? tools : [])
    .filter((t) => t && t.name)
    .map((t) => {
      const inspected = inspectToolDefinition(t);

      // ① description：保留原有的 `t.description || t.name` 回落语义，再做长度闸
      const rawDescription = t.description || t.name;
      const { text: truncatedText, truncated } = truncateDescription(rawDescription);
      let description = truncatedText;

      // ② inputSchema：只判不截断（schema 被截断 = 非法 schema = 调用必失败）
      let blocked = '';
      if (inspected.schemaTooLarge) {
        blocked = `[schema-too-large] ${inspected.reason}`;
        // 前缀让「即使调用方忘了过滤」时模型也能看出这个工具当前不可用
        description = `[schema-too-large] ${description}`;
      }

      const def = {
        type: 'function',
        function: {
          // F-005：唯一拼名入口（server 段编码后不含 `_`，反解无歧义）；不在此手写模板字符串
          name: buildToolName(s, t.name),
          description,
          parameters: t.inputSchema || { type: 'object', properties: {} },
        },
      };

      // ③ 不可信标记 + 闸门留痕（全部不可枚举，不进线上报文）
      defineHidden(def, '__untrusted__', true);
      if (truncated) defineHidden(def, '__descriptionTruncated__', true);
      if (blocked) defineHidden(def, '__blocked__', blocked);
      // 描述里的注入特征（与工具结果侧同一套规则表）：只记录，不阻断
      try {
        const hit = detectPromptInjection(String(rawDescription || ''));
        if (hit && hit.suspicious) {
          defineHidden(def, '__injection__', (hit.findings || []).map((f) => f.id));
        }
      } catch {
        // 扫描失败不影响工具可用性（守卫是增益，不是前置条件）
      }
      return def;
    });
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

/** 后缀再导出：测试与调用方断言「截断后长度」时必须与实现同源，不得二次硬编码。 */
export { TOOL_DESCRIPTION_TRUNCATION_SUFFIX };
