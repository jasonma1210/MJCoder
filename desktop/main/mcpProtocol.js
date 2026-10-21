'use strict';
// MCP 协议常量（P1-8 单点化）
//
// 为什么单独一个文件而不是从 mcpClient 导出：
//   `mcpAuth.js` 也需要协议版本（它的 401 探测会先发一个 initialize 探针），
//   若 mcpAuth → mcpClient，而 mcpClient 未来又需要 mcpAuth，就会形成循环 require。
//   本文件无模块依赖（唯一的 require 是同目录上层的 package.json 数据文件，见 readClientVersion），
//   两侧都可以安全引用。
//
// 版本策略（H-4 核实；D-804 于 2026-10-21 升级为双栈）：
//   · 握手栈：客户端在 initialize 里**提议** PROTOCOL_VERSION（2025-11-25 = 握手时代的最后一版），
//     服务端在结果里**回自己的版本**，客户端按规范采纳；服务端回一个我们不在支持集里的版本 →
//     SHOULD disconnect（**不自行降级重试**）。
//   · 无状态栈：2026-07-28 取消了 initialize 握手与 Mcp-Session-Id。客户端先用
//     `server/discover` 探测；成功即采用无状态语义（能力声明同步按版本分叉），失败回落握手栈。
//
// 支持集 = 本客户端实现过/兼容的版本。握手四代共享同一套 initialize →
// notifications/initialized → tools/list 会话流程，差异（icons/tasks 等）我们只透传不解释；
// 无状态栈只认 2026-07-28 一版（规范未定义中间态）。

const PROTOCOL_VERSION = '2025-11-25';
// 最低可接受版本：MIN_PROTOCOL_VERSION 是 SSE 时代（旧 HTTP+SSE 传输）的协议版本，
// 仓库在用的 mock / 真实服务端大多回这一版，属于必须能连的底线。
const MIN_PROTOCOL_VERSION = '2024-11-05';

// ── 双栈的另一栈（D-804 S2–S5，2026-10-21 实现）─────────────────────────────
// 2026-07-28 是**断裂式升级**：取消 initialize 握手与 Mcp-Session-Id，改无状态请求/响应，
// 新增 `server/discover` 取代 initialize，并用 `Mcp-Method` / `Mcp-Name` 头做路由。
// 本客户端现在**两条栈都实现**：
//   · 无状态栈：`server/discover` 探测成功即采用（不发 initialize、不带 session id）；
//   · 有状态栈：探测失败（老服务端不认 discover / 声明了未实现的版本）→ 走原握手流程。
// 顺序刻意是「先新后旧」：新增的 server/discover 在老服务端必然失败（方法不存在/400），
// 是可靠的判别器；反过来先发 initialize 到新服务端同样必失败，但会把「服务端已升级」
// 误判成「连不上」，且无法区分「服务端坏了」与「我们落后」。
const NEXT_PROTOCOL_VERSION = '2026-07-28';
// 支持集 = 两条栈可连的版本。无状态栈只认 NEXT 一版（规范未定义中间态的无状态版本）。
const SUPPORTED_PROTOCOL_VERSIONS = [NEXT_PROTOCOL_VERSION, '2025-11-25', '2025-06-18', '2025-03-26', MIN_PROTOCOL_VERSION];
// 「握手栈」支持集：initialize 提议与 ④ 断言用的子集（PROTOCOL_VERSION 必须是它的最新一版）
const HANDSHAKE_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', MIN_PROTOCOL_VERSION];

// ── D-804：MCP 代际路线（第八轮审查，2026-10-21）──────────────────────────────
//
// 事实：现行规范是 `2026-07-28`，它是一次**断裂式升级** —— 移除 `initialize` 握手与
// `Mcp-Session-Id`，改为无状态请求/响应，并新增 `server/discover`、`Mcp-Method` / `Mcp-Name`
// 头路由、MRTR（多轮往返）、可缓存 list、正式扩展框架，同时给旧特性 **12 个月弃用窗口**。
// 本客户端建在「有状态握手」模型上（initialize → notifications/initialized → tools/list，
// 并捕获 Mcp-Session-Id 回带），因此**不能靠改个常量就声称支持**。
//
// 为什么这里要放一个 roadmap 常量、而不是只写注释：
//   判据 10.6 要求「对外声称的能力」与「机器守护的不变量」一一对应。
//   `nextStatus` 就是那句「声称」：只要它还是 'not-implemented'，下面的
//   `SUPPORTED_PROTOCOL_VERSIONS` **就不得**包含 next —— 由 test/mcp-protocol-roadmap.test.mjs
//   双向断言（改了状态却没实现、或悄悄把版本号塞进支持集，都会红）。
//   这比「注释里写一句未来做」强：注释不会红，状态会。
//
// 到期日 `dueBy` 的口径**不是拍脑袋**：取规范自己给的 12 个月弃用窗口
// （2026-07-28 + 12 个月 = 2027-07-28）。到那天起，仍不支持无状态路径就意味着
// 无法与已升级的服务端互通，届时 `MIN` 一侧的 legacy HTTP+SSE 也会一并退场。
const MCP_PROTOCOL_ROADMAP = Object.freeze({
  current: PROTOCOL_VERSION,
  next: NEXT_PROTOCOL_VERSION,
  // 'not-implemented' | 'implemented'  —— 只有真做出无状态路径并通过互通测试，才允许改这个值
  // 2026-10-21（D-804 S2–S5）：**无状态路径已实现并通过互通测试**，故改为 implemented。
  // 改这个值会让门禁 ② 从「支持集不得含 next」翻成「支持集必须含 next」，形成双向锁。
  nextStatus: 'implemented',
  dueBy: '2027-07-28',
  // 迁移形态：**双栈协商**，不是硬切。理由：大量现实 MCP 服务端仍停在 2025-11-25，
  // 官方规范本身给了 12 个月窗口；按版本协商 + 显式降级路径是规范认可的对齐方式。
  strategy: 'dual-stack-negotiation',
  trackedIn: 'docs/MJCode-AgentHarness第八轮全量审查报告与调整实现方案-2026-10-21.md（§4 D-804）',
  // 在 2026-07-28 中被弃用、届时必须停止声明的能力。
  // 现在**只在无状态栈上不声明**（见 STATELESS_CLIENT_CAPABILITIES），握手栈仍要声明——
  // 老服务端要靠 roots 做文件系统协商。这就是 S4「能力声明按版本分叉」。
  deprecatedInNext: Object.freeze(['roots', 'logging']),
});

// 客户端能力声明（P2-4 残差收敛）。
//
// 严守「宁可少声明，不可虚报」：这里声明的每一项都必须在 mcpClient.handleServerMessage
// 里有对应的请求应答实现——一旦声明，服务端就会主动向我们发请求，没有应答实现 →
// 服务端一直等，表现为「连上了但一调用就挂死」（比少声明危险得多）。
//
// 当前声明（应答实现见 mcpClient.js 的 SERVER_REQUEST_HANDLERS）：
//   · roots      —— roots/list 返回空清单（不为 MCP 服务暴露文件系统根，见该处注释）
//   · completion —— completion/complete 返回空补全集（规范允许的最小合法应答）
//   · logging    —— 接收 notifications/message 日志通知（mcpClient 已按级别落日志）
//
// 仍未声明（明确的非目标，不是缺位）：
//   · sampling    —— 服务端借客户端跑模型推理：需要「用户逐次同意 + 模型通道中继」的
//                    完整信任链路（规范建议客户端逐次征得同意），缺 UI 与治理面，开了就是裸奔
//   · elicitation —— 服务端向用户征询输入：需要渲染层对话框通道与结果回传链路
const CLIENT_CAPABILITIES = Object.freeze({
  roots: Object.freeze({}),
  completion: Object.freeze({}),
  logging: Object.freeze({}),
});

// ── S4（D-804）：能力声明按协议版本分叉 ───────────────────────────────────────
// 无状态栈（2026-07-28）里 roots / logging 已被弃用，声明它们等于自称支持一个已退场的
// 交互模型；而 completion 仍在新版中，且应答实现（SERVER_REQUEST_HANDLERS）没有版本差异。
// 刻意**不删** CLIENT_CAPABILITIES 里的两项：握手栈还要用它们与老服务端协商。
const STATELESS_CLIENT_CAPABILITIES = Object.freeze({
  completion: Object.freeze({}),
});

/** 协商到某版本后应声明哪些客户端能力（单一事实来源；不要在各调用点各自拼）。 */
function clientCapabilitiesFor(version) {
  return version === NEXT_PROTOCOL_VERSION ? STATELESS_CLIENT_CAPABILITIES : CLIENT_CAPABILITIES;
}

/** 该版本是否走无状态栈（无 initialize / 无 Mcp-Session-Id）。 */
function isStatelessVersion(version) {
  return version === NEXT_PROTOCOL_VERSION;
}
// ── 客户端自述版本：必须与应用版本同源（F-013） ──────────────────────────────
//
// 改前写死 `version: '1.0'`：initialize / 401 探针都会把它发给服务端，于是服务端日志、
// 兼容性诊断里看到的是一个**从不存在的版本**。排障时「按版本对照行为差异」这条线索直接失效，
// 而且它看起来很像真值（'1.0' 比 '0.6.1-beta' 更像正式版），误导性比缺省更强。
//
// 取值口径：`desktop/package.json` 的 `version` 是打包产物名的同一来源（electron-builder
// 直接读它），因此这里**直接读它**，不新增第二份版本常量、也不引入任何构建期依赖。
// 为什么不用 readFileSync：require JSON 由 Node 自己缓存与解析，不会在本文件引入 fs/path；
// `../package.json` 与应用同目录，asar 打包后依然可 require（app 的 package.json 恒在包内）。
// 循环依赖风险评估：package.json 是数据文件、不 require 任何模块，不构成环。
function readClientVersion() {
  try {
    const v = require('../package.json').version;
    if (typeof v === 'string' && v.trim()) return v.trim();
  } catch (e) {
    // 只在「产物包被异常裁剪、package.json 不在」这种异常态触发。
    // 此时**宁可显式标记未知**，也不要退回一个看起来像真值的虚构版本号。
    console.warn('[mcp] 读取应用版本失败，clientInfo.version 标记为 unknown:', e && e.message ? e.message : String(e));
  }
  return 'unknown';
}

const CLIENT_INFO = Object.freeze({ name: 'mj-coder', version: readClientVersion() });

/** 服务端返回的版本是否在本客户端支持集内（空值视为「未声明」，由调用方决定回落）。 */
function isSupportedProtocolVersion(v) {
  return typeof v === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(v);
}

module.exports = {
  PROTOCOL_VERSION,
  MIN_PROTOCOL_VERSION,
  NEXT_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  HANDSHAKE_PROTOCOL_VERSIONS,
  MCP_PROTOCOL_ROADMAP,
  CLIENT_CAPABILITIES,
  STATELESS_CLIENT_CAPABILITIES,
  clientCapabilitiesFor,
  isStatelessVersion,
  CLIENT_INFO,
  isSupportedProtocolVersion,
};
