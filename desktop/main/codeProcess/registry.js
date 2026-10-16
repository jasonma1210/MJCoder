// T4-7：Code Mode 代码执行子进程 RPC 协议登记表（单一事实来源）。
// 与 cuaProcess 的关键差异：Code Mode 是「有状态会话」（cell 语义——
// 同一对话的多次 exec 共享持久 vm 上下文），因此宿主侧【不做透明重启】：
// 子进程一旦死亡，会话状态必然丢失，静默重建会让模型误以为状态还在。
// 消息形状（与 engineProcess/transport 双形态兼容的纯数据）：
//   主→子  {t:'call', callId, name, args}           name ∈ CODE_CHANNELS
//   主→子  {t:'shutdown'}                           会话结束（宿主 kill 兜底，协议留位）
//   子→主  {t:'ready'}                              vm 上下文初始化完成
//   子→主  {t:'callRes', callId, ok, result|error}  调用回执
// 审批/审计/预览句柄发放全部留主进程（codeTools.js）——子进程只做纯执行。
const CODE_CHANNELS = ['exec', 'reset', 'probe'];

module.exports = { CODE_CHANNELS };
