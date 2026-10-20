'use strict';
// MCP 协议常量（P1-8 单点化）
//
// 为什么单独一个文件而不是从 mcpClient 导出：
//   `mcpAuth.js` 也需要协议版本（它的 401 探测会先发一个 initialize 探针），
//   若 mcpAuth → mcpClient，而 mcpClient 未来又需要 mcpAuth，就会形成循环 require。
//   本文件无模块依赖（唯一的 require 是同目录上层的 package.json 数据文件，见 readClientVersion），
//   两侧都可以安全引用。
//
// 版本策略（H-4 核实）：
//   · 客户端在 initialize 里**提议** PROTOCOL_VERSION（2025-11-25 = 握手时代的最后一版，
//     相对 2025-06-18 增加 OIDC Discovery / icons / 增量 scope / URL mode elicitation /
//     sampling tool calling / 实验性 tasks；当前最新的 2026-07-28 取消了 initialize 握手，
//     属架构级改造，不在本批范围）；
//   · 服务端在 initialize 结果里**回自己的版本**，客户端按规范采纳；
//   · 服务端回一个我们不在支持集里的版本 → 客户端 SHOULD disconnect（**不自行降级重试**）。
//
// 支持集 = 本客户端实现过/兼容握手的版本。四条都共享同一套 initialize →
// notifications/initialized → tools/list 会话流程，差异（icons/tasks 等）我们只透传不解释。

const PROTOCOL_VERSION = '2025-11-25';
// 最低可接受版本：MIN_PROTOCOL_VERSION 是 SSE 时代（旧 HTTP+SSE 传输）的协议版本，
// 仓库在用的 mock / 真实服务端大多回这一版，属于必须能连的底线。
const MIN_PROTOCOL_VERSION = '2024-11-05';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', MIN_PROTOCOL_VERSION];

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
  SUPPORTED_PROTOCOL_VERSIONS,
  CLIENT_CAPABILITIES,
  CLIENT_INFO,
  isSupportedProtocolVersion,
};
