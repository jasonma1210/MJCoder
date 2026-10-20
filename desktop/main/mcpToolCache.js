'use strict';
// 期 1（2026-10-18）：MCP 工具清单缓存（懒启动地基）
//
// 背景（打破了「懒启动」的直接前提）：mcp:listTools 此前只回**当前已连接**服务的工具。
// 一旦默认不再全量 spawn（懒启动），未连接服务的工具对模型即不可见——模型会「看不见已装的能力」，
// 表现为「装了 filesystem 却不会用文件工具」。故懒启动**必须**先有一份工具清单缓存。
//
// 职责：把每个服务最近一次成功握手拿到的工具清单落盘（userData/mcp-tool-manifests.json），
// 渲染层据此重建完整工具集；真正调用时由 callMcpTool 按需拉起（connect-on-demand）。
//
// 设计：
//   · 工厂函数 + 注入 filePath —— 不依赖 electron，可在纯 Node 下单测。
//   · 写盘串行化 —— 并发连接多个服务时避免「后写覆盖先写」丢掉先落盘的服务清单。
//   · fail-open —— 读取失败/文件损坏一律按空处理，绝不阻塞启动或调用。

const fs = require('fs');
const { writeFileDurableWithMode } = require('./data/durableWrite');

// 第七轮 F-007 / B1-B-06：定义侧预算闸的**唯一常量源**是 shared/contextBudget.mjs。
// 本文件只 import，不另写数字——阈值一旦要调，只改那一个文件。
//
// 为什么用**动态 import** 而不是 `require('../shared/contextBudget.mjs')`：
//   shared/ 下是 ESM 模块，主进程是 CJS。`require(esm)` 只在 Node ≥22.12 稳定；
//   Electron 内嵌的 Node 版本随 Electron 走（本仓 electron 版本不受此文件控制），
//   用 require 会在低版本 Electron 上直接 `ERR_REQUIRE_ESM` 把主进程启动打挂。
//   仓内既有约定即为此：shared/mcpToolDefs.mjs 也是由 intentMcpPrewarm 用
//   `import('../shared/mcpToolDefs.mjs')` 动态加载（见该文件注释）。
let _budgetMod = null;
function loadBudgetModule() {
  if (!_budgetMod) {
    _budgetMod = import('../shared/contextBudget.mjs').catch((e) => {
      _budgetMod = null; // 失败不缓存，下次再试
      throw e;
    });
  }
  return _budgetMod;
}

// 仅本人可读写（清单含工具描述，不含凭证；与 mcp-servers.json 同级保护，防同机其他用户窥探）
const FILE_MODE = 0o600;

// 只保留模型需要的三字段（name/description/inputSchema），
// 避免把服务端返回的整个工具对象（含无关元数据）落盘造成文件膨胀。
function slimTools(tools) {
  return (Array.isArray(tools) ? tools : [])
    .filter((t) => t && typeof t === 'object' && t.name)
    .map((t) => ({
      name: String(t.name),
      description: typeof t.description === 'string' ? t.description : '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    }));
}

/**
 * @param {{filePath: string,
 *          log?: (msg: string, detail?: unknown) => void,
 *          audit?: (event: string, payload: object) => void}} opts
 *   audit —— 可选审计通道（未注入即零开销）。本轮唯一事件：
 *     `audit('mcp_tool_def_limited', { server, tool, descriptionChars, descriptionTruncated,
 *                                      schemaBytes, schemaDepth, schemaTooLarge, limits, reason })`
 *     口径：**只记超限**（未超限的工具不产生事件，避免把审计日志刷成工具清单副本）。
 */
function createMcpToolCache({ filePath, log = console.warn, audit } = {}) {
  if (!filePath) throw new Error('createMcpToolCache 需要 filePath');
  const logWarn = typeof log === 'function' ? log : () => {};
  const auditFn = typeof audit === 'function' ? audit : null;

  /**
   * 把「原始 description 字符数 / inputSchema 字节数 / 深度」相对预算闸的判定写进审计。
   *
   * 为什么在**缓存写入处**做：这里是「服务端工具清单 → 落盘 → 渲染层重建工具集」的唯一收口，
   * 覆盖所有连接路径（含懒启动的连接-按需），不需要在每个调用点重复埋点。
   *
   * fail-open：预算模块加载失败、审计通道抛错都**不得影响缓存落盘**（缓存是懒启动的前提）。
   * @returns {Promise<Array<object>>} 本轮被判超限的工具明细（没有则空数组）
   */
  async function auditToolDefs(serverName, tools) {
    const list = Array.isArray(tools) ? tools : [];
    if (!auditFn || list.length === 0) return [];
    let mod;
    try {
      mod = await loadBudgetModule();
    } catch {
      return []; // 预算模块不可用：不记审计、不阻塞缓存
    }
    const limited = [];
    for (const t of list) {
      if (!t || typeof t !== 'object' || !t.name) continue;
      const r = mod.inspectToolDefinition(t);
      if (!r.descriptionTruncated && !r.schemaTooLarge) continue;
      const reason = r.reason
        || `description ${r.descriptionChars} chars > ${mod.MAX_TOOL_DESCRIPTION_CHARS}`;
      const detail = {
        server: String(serverName),
        tool: String(t.name),
        descriptionChars: r.descriptionChars,
        descriptionTruncated: r.descriptionTruncated,
        schemaBytes: r.schemaBytes,
        schemaDepth: r.schemaDepth,
        schemaTooLarge: r.schemaTooLarge,
        limits: {
          descriptionChars: mod.MAX_TOOL_DESCRIPTION_CHARS,
          schemaBytes: mod.MAX_INPUT_SCHEMA_BYTES,
          schemaDepth: mod.MAX_INPUT_SCHEMA_DEPTH,
        },
        reason,
      };
      limited.push(detail);
      try {
        auditFn('mcp_tool_def_limited', detail);
      } catch (e) {
        logWarn('[mcp] 工具定义审计写入失败（不影响缓存）:', e && e.message ? e.message : String(e));
      }
    }
    return limited;
  }

  function loadAll() {
    try {
      if (!fs.existsSync(filePath)) return {};
      const obj = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
    } catch (e) {
      logWarn('[mcp] 工具清单缓存读取失败（按空处理）:', e && e.message ? e.message : String(e));
      return {};
    }
  }

  // 读写分离：loadAll 供查询（同步、即时），写操作统一入写链串行化（读-改-写不互相覆盖）
  let writeChain = Promise.resolve();
  function enqueue(mutate) {
    writeChain = writeChain
      .then(() => {
        const all = loadAll();
        mutate(all);
        const res = writeFileDurableWithMode(filePath, JSON.stringify(all, null, 2), FILE_MODE);
        if (!res.ok) logWarn('[mcp] 工具清单缓存落盘失败:', res.error);
      })
      .catch((e) => { logWarn('[mcp] 工具清单缓存写入异常:', e && e.message ? e.message : String(e)); });
    return writeChain;
  }

  /** 记录某服务最近一次成功握手的工具清单。 */
  function saveManifest(name, tools) {
    if (!name) return writeChain;
    const entry = { tools: slimTools(tools), updatedAt: Date.now() };
    // 落盘与审计并行：审计既不在写链里（不拖慢落盘），也不会因自己的错误让落盘失败。
    // 返回 promise 仍只代表「这次 save 处理完」（落盘 + 审计都结束），解析值维持 undefined。
    const written = enqueue((all) => { all[String(name)] = entry; });
    return Promise.all([written, auditToolDefs(name, tools)])
      .then(() => undefined)
      .catch(() => undefined); // 两者内部都已各自兜错；这里只保证调用方 await 永不抛
  }

  /** 移除某服务清单（用户断开/删除该服务时调用）。 */
  function removeManifest(name) {
    return enqueue((all) => { delete all[String(name)]; });
  }

  /** 取某服务的缓存清单；无缓存或不合法返回 null。 */
  function getManifest(name) {
    const all = loadAll();
    const e = all[String(name)];
    return e && Array.isArray(e.tools) ? e : null;
  }

  return { saveManifest, removeManifest, getManifest, loadAll };
}

module.exports = { createMcpToolCache, slimTools };
