// T4-1：Browser Use 子进程 RPC 协议登记表（单一事实来源）。
// Playwright 执行面全部出界（子进程内跑），主进程只做编排/审批/审计/凭证——
// 崩溃半径收缩到浏览器会话本身，主会话不受波及（T3-6 驻留模式复用）。
// 消息形状与 cuaProcess 一致（structured clone / JSON 均可承载的纯数据）：
//   主→子  {t:'call', callId, name, args}           浏览器能力调用
//   主→子  {t:'shutdown'}                           会话结束（宿主 kill 兜底，协议留位）
//   子→主  {t:'ready'}                              playwright-core 加载完成
//   子→主  {t:'callRes', callId, ok, result|error}  调用回执
// 幂等通道（RETRYABLE_CHANNELS）：重复执行无副作用或副作用可忽略——子进程崩溃后
// 宿主可透明重启重试；click/fill/select 有真实页面副作用（可能已提交表单），
// 崩溃后绝不自动重试，直接报错由模型决策（防重复点击/重复提交）。
const BROWSER_CHANNELS = ['probe', 'navigate', 'click', 'fill', 'select', 'screenshot', 'extract'];
const RETRYABLE_CHANNELS = new Set(['probe', 'navigate', 'screenshot', 'extract']);

module.exports = { BROWSER_CHANNELS, RETRYABLE_CHANNELS };
