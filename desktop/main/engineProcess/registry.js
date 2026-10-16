// T3-7：引擎子进程 RPC 协议——两端共享的通道登记表（单一事实来源）。
// 消息形状（structured clone，均为纯数据）：
//   主→子  {t:'run', id, params}            启动一次 runAgent（params 全可序列化）
//   主→子  {t:'abort', id}                  中止（子进程侧 AbortController 级联）
//   主→子  {t:'toolRes', callId, ok, result|error}   工具通道调用回执
//   主→子  {t:'cbRes', callId, result}      请求-响应型回调回执（onSuspend）
//   子→主  {t:'ready'}                      子进程引擎加载完成
//   子→主  {t:'evt', id, cb, args}          通知型回调透出（args 为回调实参数组，onDone 多参）
//   子→主  {t:'cbReq', id, callId, cb, args} 请求-响应型回调（onSuspend 需返回值）
//   子→主  {t:'toolReq', callId, name, args} 工具通道调用请求（依赖方向反转的核心）
//   子→主  {t:'runDone', id, finalText}     引擎正常收尾
//   子→主  {t:'runError', id, message}      引擎异常终止
const TOOL_CHANNELS = [
  'chat', 'shell', 'readFile', 'writeFile', 'editFile', 'applyPatch', 'listDir', 'grep', 'glob',
  'gitStatus', 'gitDiff', 'gitLog', 'gitBranch', 'gitCommit', 'gitAdd', 'mcpCallTool',
  'orchestrateTask', 'searchPlugins', 'installPlugin', 'webSearch', 'webFetch',
  'prList', 'prView', 'prDiff', 'prReview', 'prComment',
];
// 通知型回调（fire-and-forget，单向序列化即可）
const NOTIFY_CBS = ['onStream', 'onToolCall', 'onMessage', 'onTodos', 'onSubagentEvent', 'onBudget', 'onTrace', 'onDone'];
// 请求-响应型回调（需要返回值语义：onSuspend 返回断点是否保存成功）
const REQUEST_CBS = ['onSuspend'];

module.exports = { TOOL_CHANNELS, NOTIFY_CBS, REQUEST_CBS };
