'use strict';
// MCP 协议常量（P1-8 单点化）
//
// 为什么单独一个文件而不是从 mcpClient 导出：
//   `mcpAuth.js` 也需要协议版本（它的 401 探测会先发一个 initialize 探针），
//   若 mcpAuth → mcpClient，而 mcpClient 未来又需要 mcpAuth，就会形成循环 require。
//   本文件零依赖（只放常量与纯函数），两侧都可以安全引用。
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

// 客户端能力声明。
//
// 严守「宁可少声明，不可虚报」：roots / sampling / elicitation 一个都**未实现**，
// 一旦声明，服务端就会主动向我们发 `roots/list`、`sampling/createMessage` 等**请求**，
// 而我们没有应答实现 → 服务端一直等，表现为「连上了但一调用就挂死」（比少声明危险得多）。
// 未来的开启条件：先在 mcpClient.handleServerMessage 里实现对应的请求应答，再改这里。
const CLIENT_CAPABILITIES = Object.freeze({});
const CLIENT_INFO = Object.freeze({ name: 'mj-coder', version: '1.0' });

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
