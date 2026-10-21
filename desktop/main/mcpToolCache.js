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
const crypto = require('crypto');
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
//
// B2-B-12（F-007 磁盘侧残留）：`shared/mcpToolDefs.mjs` 在**构造 function 定义**时已把
// 超长 description 截断，但本缓存此前**原样**落盘未截断的原始描述 —— 于是磁盘上仍然躺着
// 50 KB 描述（清单文件体积、以及「从缓存重建工具集」这条路径会把原始大描述再喂回模型）。
// 现在落盘前对 `description` 应用**同一套** `truncateDescription`（阈值从
// shared/contextBudget.mjs 取，本文件不写第二份数字），`inputSchema` **不动**
// （截断 schema 会产出非法 schema，调用必然失败 —— 与 mcpToolDefs 侧同一取舍）。
//
// @param {Array<object>} tools 服务端原始工具清单
// @param {{truncateDescription?: Function}|null} [budget] 预算模块（contextBudget.mjs）；
//   未提供时按未截断原样返回（仅供不需要截断的纯单测直接调用，生产路径 saveManifest 恒传入）
function slimTools(tools, budget) {
  const truncate = budget && typeof budget.truncateDescription === 'function'
    ? budget.truncateDescription
    : null;
  return (Array.isArray(tools) ? tools : [])
    .filter((t) => t && typeof t === 'object' && t.name)
    .map((t) => {
      const rawDesc = typeof t.description === 'string' ? t.description : '';
      return {
        name: String(t.name),
        description: truncate ? truncate(rawDesc).text : rawDesc,
        inputSchema: t.inputSchema || { type: 'object', properties: {} },
      };
    });
}

/**
 * 工具清单指纹（第八轮 L-3 补：把「定义钉定」从口头承诺变成可核对的事实）。
 *
 * 为什么需要：缓存此前只存 `{tools, updatedAt}`，没有指纹也没有版本号。于是第三方 server
 * **静默改定义**（加一个必填参数、改描述、删一个工具）时：磁盘清单被直接覆盖，没有任何事件可查；
 * 而模型侧看到的是**变了字节的工具表**——前缀缓存被打掉、行为也可能变，排查时无从判断
 * 「是服务端改了定义」还是「我们改了下发逻辑」。这与「定义侧已有三道闸」的成熟度不匹配：
 * 那三道闸管的是**体积/注入**，管不了**漂移**。
 *
 * 口径：排序后逐工具取 `name \0 description \0 inputSchema(JSON)`，整体 SHA-256。
 *   · 用**落盘后的 slim 形态**计算（不是服务端原始体）——因为模型看到的就是这一份；
 *   · 排序使结果与 server 返回顺序无关；同一份定义重连两次必须得到同一指纹（有测试钉住）。
 *
 * @param {Array<object>} tools slim 形态的工具清单
 * @returns {string} 十六进制指纹；空清单也返回确定值（sha256('')）
 */
function fingerprintOf(tools) {
  const list = (Array.isArray(tools) ? tools : [])
    .filter((t) => t && typeof t === 'object' && t.name)
    .map((t) => [String(t.name), String(t.description || ''), JSON.stringify(t.inputSchema || {})])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const h = crypto.createHash('sha256');
  for (const [name, desc, schema] of list) h.update(`${name}\u0000${desc}\u0000${schema}\u0000`);
  return h.digest('hex');
}

/**
 * @param {{filePath: string,
 *          log?: (msg: string, detail?: unknown) => void,
 *          audit?: (event: string, payload: object) => void}} opts
 *   audit —— 可选审计通道（未注入即零开销）。事件：
 *     `audit('mcp_tool_def_limited', { server, tool, descriptionChars, descriptionTruncated,
 *                                      schemaBytes, schemaDepth, schemaTooLarge, limits, reason })`
 *     口径：**只记超限**（未超限的工具不产生事件，避免把审计日志刷成工具清单副本）。
 *     `audit('mcp_tool_defs_changed', { server, before, after, added, removed, tools })`
 *     —— 第八轮 L-3：定义漂移事件，只在指纹变化时记（首次写入不记）。
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
      // B2-B-12：截断只发生在**落盘侧**，原始长度必须留在审计里 ——
      // 否则「磁盘上有多大」与「服务端实际给了多大」两个事实都被截断掩盖，
      // 排障时无法区分「服务本身失控」与「我们把它的东西压小了」。
      const stored = mod.truncateDescription(
        typeof t.description === 'string' ? t.description : '',
      );
      const detail = {
        server: String(serverName),
        tool: String(t.name),
        descriptionChars: r.descriptionChars, // 服务端给出的**原始**字符数
        storedDescriptionChars: stored.text.length, // 落盘后的字符数（未截断时两者相等）
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
  async function saveManifest(name, tools) {
    if (!name) return writeChain;
    const raw = Array.isArray(tools) ? tools : [];
    // B2-B-12：落盘前先取预算模块 —— 截断阈值只从 shared/contextBudget.mjs 取。
    // fail-open：模块取不到（异常产物包 / 动态 import 失败）时按未截断原样落盘并告警，
    // 绝不因为「压不住体积」而让缓存整条丢失（缓存是懒启动的前提）。
    let budgetMod = null;
    try {
      budgetMod = await loadBudgetModule();
    } catch (e) {
      logWarn('[mcp] 预算模块不可用，工具描述按原样落盘（未截断）:', e && e.message ? e.message : String(e));
    }
    const slim = slimTools(raw, budgetMod);
    const fingerprint = fingerprintOf(slim);
    // 漂移检测（第八轮 L-3）：只在**已有指纹且变了**时才记事件——首次写入不算漂移，
    // 否则每个新服务都会先刷一条无意义记录。这里读的是**写前**的磁盘状态，
    // 因此必须在 enqueue 之前取（写链内部再去读就已经被覆盖了）。
    const prev = loadAll()[String(name)] || null;
    const prevFp = prev && typeof prev.fingerprint === 'string' ? prev.fingerprint : '';
    const entry = { tools: slim, updatedAt: Date.now(), fingerprint };
    // 落盘与审计并行：审计既不在写链里（不拖慢落盘），也不会因自己的错误让落盘失败。
    // 返回 promise 仍只代表「这次 save 处理完」（落盘 + 审计都结束），解析值维持 undefined。
    // 注意：审计拿到的是 raw（原始清单）—— 审计里的 descriptionChars 必须是**服务端给的原始值**，
    // 用落盘后的截断体去算，会让「原始有多大」这个唯一有排障价值的事实丢失。
    const written = enqueue((all) => { all[String(name)] = entry; });
    if (prevFp && prevFp !== fingerprint) reportDefDrift(name, prev, slim, prevFp, fingerprint);
    return Promise.all([written, auditToolDefs(name, raw)])
      .then(() => undefined)
      .catch(() => undefined); // 两者内部都已各自兜错；这里只保证调用方 await 永不抛
  }

  /**
   * 定义漂移上报（第八轮 L-3）：日志 + 审计双写，失败均不影响缓存落盘。
   * 只上报**差异摘要**（新增/消失的工具名），不把两份完整清单塞进审计——
   * 审计是排障线索，不是工具清单的副本。
   */
  function reportDefDrift(serverName, prev, next, before, after) {
    const prevNames = new Set((prev?.tools || []).map((t) => String(t?.name || '')).filter(Boolean));
    const nextNames = new Set((next || []).map((t) => String(t?.name || '')).filter(Boolean));
    const added = [...nextNames].filter((n) => !prevNames.has(n));
    const removed = [...prevNames].filter((n) => !nextNames.has(n));
    const sameSet = added.length === 0 && removed.length === 0;
    logWarn(`[mcp] 服务「${serverName}」的工具定义发生变化（指纹 ${before.slice(0, 12)} → ${after.slice(0, 12)}`
      + `${sameSet ? '，工具名集合未变但描述/schema 已变' : `，新增 ${added.length} 个 / 移除 ${removed.length} 个`}）`);
    if (!auditFn) return;
    try {
      auditFn('mcp_tool_defs_changed', {
        server: String(serverName), before, after, added, removed,
        toolsBefore: prevNames.size, toolsAfter: nextNames.size, schemaOnly: sameSet,
      });
    } catch (e) {
      logWarn('[mcp] 定义漂移审计写入失败（不影响缓存）:', e && e.message ? e.message : String(e));
    }
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

module.exports = { createMcpToolCache, slimTools, fingerprintOf };
