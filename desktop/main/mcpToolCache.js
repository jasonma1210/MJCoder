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
 * @param {{filePath: string, log?: (msg: string, detail?: unknown) => void}} opts
 */
function createMcpToolCache({ filePath, log = console.warn } = {}) {
  if (!filePath) throw new Error('createMcpToolCache 需要 filePath');
  const logWarn = typeof log === 'function' ? log : () => {};

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
    return enqueue((all) => { all[String(name)] = entry; });
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
