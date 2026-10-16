// T4-2：Chrome 接管中继协议——MJ Code 桌面端（本地 WebSocket 服务）与 Chrome 扩展之间的消息形状约定。
// 扩展侧用 chrome.debugger（CDP）操作用户真实浏览器标签页；本模块只是纯常量与注释（无实现），
// 两侧（server.js 与 chrome-extension/background.js）共同遵守这里的形状。
//
// 消息均为 JSON 文本帧，顶层 t 字段判别：
//   服务→扩展：
//     { t:'hello', nonce }                       连接建立后的质询（identify 必须回显 nonce，防预授权消息）
//     { t:'call', callId, method, args }         工具调用（method 见 RELAY_METHODS）
//   扩展→服务：
//     { t:'identify', extension, version, userAgent, nonce }  身份声明（hello 的唯一合法应答）
//     { t:'callRes', callId, ok, result|error }  调用回执
//
// 授权纪律（fail-closed）：identify 校验通过后，服务端弹「Chrome 接管连接」审批卡；
// 批准前该连接不能执行任何 call；拒绝/超时直接断开。授权只对当次连接有效，不沉淀规则。
const RELAY_METHODS = ['listTabs', 'navigate', 'click', 'fill', 'screenshot', 'extract'];

// 默认监听端口（仅 127.0.0.1）：扩展默认连 ws://127.0.0.1:49813；
// 端口冲突或多实例场景可用环境变量 MJ_CHROME_RELAY_PORT 覆盖（扩展侧同步改 chrome.storage.relayUrl）
const DEFAULT_RELAY_PORT = 49813;

// 单次 call 超时：CDP 操作（导航/点击/截图）正常都在秒级，30s 无回执视为扩展侧失控 → 断开
const CALL_TIMEOUT_MS = 30000;

module.exports = { RELAY_METHODS, DEFAULT_RELAY_PORT, CALL_TIMEOUT_MS };
