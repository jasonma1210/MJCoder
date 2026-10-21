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
// 工具通道登记表 = 子进程「可经 RPC 回调主进程」的 handler 名白名单（单一事实来源）。
// ⚠️ 维护规则：agent-core 的 TOOL_HANDLER_NAMES（模型工具名 → camelCase 通道名）是 SSOT，
// 主进程 createToolHandlers 里注册的每个通道名都必须在此登记——引擎走到 default 分支时用
// resolveChannel(toolHandlers, camelName) 取通道，而子进程的 toolHandlers 只由本名单构建；
// 漏登记 → resolveChannel 返回 null → `未知工具: xxx`（G-doc 真机回归的直接根因：
// pdf_generate/pptx_create 因 pdfGenerate/pptxCreate 未登记，即便主进程 handler 已就绪也不可达）。
// 例外：todoWrite 由引擎显式 case 内置处理（纯状态、不出网不触盘），不经 RPC，故不登记。
const TOOL_CHANNELS = [
  // 核心工具循环（chat = 模型调用通道，非模型可见工具；mcpCallTool = mcp__* 统一入口）
  'chat', 'shell', 'readFile', 'writeFile', 'editFile', 'applyPatch', 'listDir', 'grep', 'glob',
  'gitStatus', 'gitDiff', 'gitLog', 'gitBranch', 'gitCommit', 'gitAdd', 'mcpCallTool',
  'orchestrateTask', 'searchPlugins', 'installPlugin', 'webSearch', 'webFetch',
  'prList', 'prView', 'prDiff', 'prReview', 'prComment',
  // 2026-10-17：模型侧创建定时任务（有声明无通道就会出现「未知工具」）
  'scheduledCreate',
  // T4-1 Browser Use 六工具
  'browserNavigate', 'browserClick', 'browserFill', 'browserSelect', 'browserScreenshot', 'browserExtract',
  // T4-2 Chrome 接管七工具
  'chromeStatus', 'chromeTabs', 'chromeNavigate', 'chromeClick', 'chromeFill', 'chromeScreenshot', 'chromeExtract',
  // T4-7 Code Mode
  'codeExec',
  // 期 3 原生内置工具
  'clipboard', 'notify', 'httpRequest', 'sqlite', 'sandboxCodeRun',
  // G-doc 文档生成原生工具
  'docCreate', 'xlsxCreate', 'pptxCreate', 'pdfGenerate',
  // G-CUA 桌面自动化（模型 opt-in 调用；漏登记 → 子进程「未知工具: computer_use」）
  'computerUse',
  // G-latex LaTeX 编译原生工具（漏登记 → 子进程「未知工具: latex_compile」）
  'latexCompile',
  // M5 / T5-8 军团协同工具（漏登记 → 子进程「未知工具: team_*」）
  // B-04（2026-10-21）补入 teamReadMessages：模型侧读消息
  'teamListMembers', 'teamSendMessage', 'teamBoard', 'teamWait', 'teamReadMessages',
];
// 通知型回调（fire-and-forget，单向序列化即可）
const NOTIFY_CBS = ['onStream', 'onToolCall', 'onMessage', 'onTodos', 'onSubagentEvent', 'onBudget', 'onTrace', 'onDone'];
// 请求-响应型回调（需要返回值语义：onSuspend 返回断点是否保存成功）
const REQUEST_CBS = ['onSuspend'];

module.exports = { TOOL_CHANNELS, NOTIFY_CBS, REQUEST_CBS };
