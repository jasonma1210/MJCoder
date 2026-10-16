// T3-6：Computer Use 原生执行子进程 RPC 协议登记表（单一事实来源）。
// 下沉面取证：ComputerUseLoop 经 toolHandlers 使用的全部原生调用——
//   collectAxTree / performAction（osascript 键鼠执行，最高危）
//   isScreenLocked（osascript 探针）/ isAccessibilityGranted（osascript 权限探针，cua:run 前置检查）
// 消息形状（structured clone / JSON 均可承载的纯数据）：
//   主→子  {t:'call', callId, name, args}           原生能力调用
//   主→子  {t:'shutdown'}                           会话结束（宿主 kill 兜底，协议留位）
//   子→主  {t:'ready'}                              原生模块加载完成
//   子→主  {t:'callRes', callId, ok, result|error}  调用回执
// 编排（循环/审批/HUD/审计/chat）全部留主进程——只有触碰系统权限的原生执行出界。
const CUA_CHANNELS = ['isAccessibilityGranted', 'collectAxTree', 'performAction', 'isScreenLocked'];

module.exports = { CUA_CHANNELS };
