# MJCode Agent Harness 第八轮全量审查 —— 角度 A：执行引擎与能力层

> **审查人**：agent-harness-architect（架构师）
> **团队**：mjcode-harness-r8　**阶段**：P1 设计/审查
> **HEAD 锚点**：`24acc1531f55d70d8f591f0435d48eb114fbf3d0`（`git log -1 --format='%H %ad %s'`，2026-10-20 12:50:35 +0800）
> **口径声明**：本文所有事实均以 **工作区（working tree）** 为默认口径；凡 HEAD 与工作区不一致处，**两个数字都给**，并标 `git show HEAD:<path>` 取法。工作区有大量未提交改动（`git status --short | wc -l` → `99`），角度 A 关键文件的 diff 规模见 §4.6。
> **锚点纪律**：证据一律用「文件路径 + 函数名/常量名 + 可复核命令」定位，**不使用行号**（行号随编辑位移）。
> **未验证声明**：凡「是否主流」判断，标注「待 P0 主流基线简报确认」，不凭印象下结论。
> **增补记录（2026-10-21）**：研究员的主流基线简报交付后，本文增补 **§6 主流基线对照**（含角度 A 范围内的自检表填值 17 行，以及新发现 **A-10**）。§0～§5 为原始审查结论，未回改；**§6.3 有一条据此调整的措辞建议**（A-01 应表述为"长时运行的可中断性缺口"而非"性能问题"）。发现总数由 9 增至 10。
> **勘误记录（2026-10-21）**：§6.1 自检表 **C-23 行**原写「子代理 `result: subResult` 原样进入父上下文、未截断」，**该表述有误**。经角度 B 的 architect-2 实测指出并复验：回传会被 `truncateToolResult`（15000 字符）截断，但 `summarizeToolOutput` 的字段白名单只含 `['stdout','content']`、不含子代理回传键 `result`，故**不走落盘、尾部不可恢复**。已改为「截断了但不可恢复」。结论仍为 ⚠️ 部分，判据未变。与角度 B 的 **B-20（P2）** 同源，以该报告为准。
> **协作裁定**：角度 B 的 **B-01**（军团成员配置在 Worker 链路不生效）经本人独立复验成立，但发生在 `workerPool.js` 编排链路、属角度 B 范围，**本文不重复收录**，避免双计。

---

## §0 结论先行

**整体判断**：执行引擎与能力层是本项目 Harness 中**完成度最高的一块**——E 层（工具调用循环）有六道独立闸门、T 层（工具注册）已有 143/143 全绿的逐工具八环节矩阵门禁、进程隔离与崩溃恢复已真机落地；**当前的主要风险不是"能力缺失"，而是三类"契约与运行时不一致"**：(a) 取消信号在无人值守通道断链；(b) 登记矩阵扫字面量键、看不见条件展开，于是"登记全绿 ≠ 运行时可得"；(c) MCP 默认自启档与"原生优先"自相矛盾。

**本角度最严重的 3 个问题**：

| # | 一句话 |
|---|---|
| **A-01** | **Worker / 定时任务通道的"停止"无法穿透到在途模型 HTTP 请求**——`signal` 在 Worker 工具工厂被解构后从未使用，`scheduledAgentChat` 只收一个形参且内部自建 controller，中止后最长要等 15 分钟内部流式守卫超时才真正停。 |
| **A-02** | **引擎向工具通道承诺的 `{ signal }` 第二参被 `resolveChannel` 无条件丢弃**——注释写"signal 可用于长阻塞工具响应中止"，实现只转发 `args`，取消能力实际全靠主进程 handler 闭包这一条隐式链路兜底。 |
| **A-03** | **`team_*` 四工具"三处登记全有、交互式运行时一个都没有"，而登记矩阵判 143/143 通过**——矩阵扫的是 `scheduledTools.js` 里的字面量键，看不见 `...(teamTools ? {...} : {})` 的条件展开，是 F-002 想消灭的"假闭环"的新变种。 |

**对第七轮结论的两处校准（重要，避免重复造结论）**：

1. **第七轮 F-002（工具登记矩阵是假闭环）在工作区已实质性修复**。矩阵已改为"逐工具正向覆盖"，实跑 `143/143 通过`（含 57 工具 × 8 环节 + 审批分级逐工具断言），并自带"删一环即红"的自检。但**它仍有盲区**，即本文 A-03。→ 不应再按"假闭环"重报，应改为"矩阵已闭合但存在条件展开盲区"。
2. **第七轮 F-003 / F-018 / F-019（capability gate 不生效、角色空交集 fail-open、`allowMcp` 缺省 true）在 HEAD `24acc153` 上已修复并提交**（`git show HEAD:desktop/agent-core/index.js | grep -c toolCallCapable` → `6`；工作区 diff 未再触碰这三处）。→ 这三条不应作为第八轮新发现重复计入；第八轮要守的是**"修好后有没有门禁钉住"**。
3. **历史上"89% 后端命令未被前端调用"的结论在当前代码上已不成立**：preload 桥接 208 个 `ipcRenderer.invoke`，渲染层源码中完全找不到引用的只有 **22 个（10.6%）**。详见 §4.5。

---

## §1 模块现状表（角度 A 范围）

评级口径：**完整** = 有实现 + 有门禁 + 运行时可得；**部分** = 有实现、门禁或运行时可得缺其一；**断裂** = 声明与运行时不一致且无守护；**缺失** = 无实现。

| 模块 | 关键文件 | 现状 | 评级 | 证据（可复核命令） |
|---|---|---|---|---|
| E·引擎子进程隔离 | `desktop/main/engineProcess/host.js`、`childEntry.js`、`transport.js`、`registry.js` | 每 run 一个 `utilityProcess`，依赖方向反转（工具实现全留主进程），`abort`/`runDone`/`runError`/`exit` 四类收敛；`utilityProcess` 缺失时回落 in-process | **完整** | `node -e "console.log(Object.keys(require('./desktop/main/engineProcess/registry.js')))"`；`ls desktop/test/engine-process.test.mjs` |
| E·崩溃恢复 | `host.js` 的 `runEngine` / `tr.onExit` | 子进程退出未收尾 → reject 带 `engineExited:true`；`agentRunner` 据此存 `kind:'engine-exit'` 断点并提示"发送继续" | **完整** | `grep -n "engineExited" desktop/main/engineProcess/host.js desktop/main/agentRunner.js` |
| E·执行主循环 | `desktop/agent-core/index.js` 的 `runAgent` | 六道闸门：轮次双闸（40×3，硬顶 `AGENT_HARD_ROUND_CAP=120`）、token 预算、整任务墙钟、重复失败熔断、空收尾守卫、模型超时兜底 | **完整** | `grep -n "AGENT_HARD_ROUND_CAP\|budgetDecision\|failStreak\|EMPTY_FINAL_NUDGE_MAX\|runWallClockMs > 0" desktop/agent-core/index.js` |
| E·取消（cancellation） | `agentRunner.abortRun` / `abortAllRuns`；`resolveChannel` | 主进程侧三层联动（controller.abort + abortEngine + cancelApprovalsForRun + killChildrenForRun）；**交互通道穿透 OK，Worker/定时通道断链** | **部分**（见 A-01/A-02） | `grep -n "abortRun" -A 12 desktop/main/agentRunner.js`；`grep -n "resolveChannel" -A 8 desktop/agent-core/index.js` |
| T·工具注册与接线 | `BASE_TOOLS`、`TOOL_HANDLER_NAMES`、`TOOL_CHANNELS`、`scheduledToolHandlers`、`createToolHandlers` | 三处登记 55/56/52 条；矩阵门禁 143/143；存在条件展开盲区 | **部分**（见 A-03） | `node desktop/test/tool-registration-matrix.test.mjs \| tail -3` |
| T·原生工具矩阵 | `desktop/main/tools/exec.js`、`execWrite.js`、`timeouts.js`、`execGovernance.js` | shell/read/write/edit/grep/glob/git 六族齐备，超时表与看门狗对账 | **完整** | `node desktop/test/scheduled-tools.test.mjs`；`grep -n "TOOL_TIMEOUT_OVERRIDES" -A 20 desktop/agent-core/index.js` |
| T·大载荷卸载 | `desktop/main/bigPayload.js` | `tool_call` 事件超限字段落临时文件，IPC 只传句柄，run 结束释放 | **完整** | `grep -n "offloadToolCall\|releaseRun" desktop/main/bigPayload.js desktop/main/agentRunner.js` |
| C·上下文压缩 | `compactHistory`、`budgetDecision`、`trimHistoryForRun`、`splitFixedHead` | 压缩→硬截断→换窗口续跑三级降级；`rewriteLedger` 记重写次数（前缀缓存税） | **完整** | `grep -n "rewriteLedger\|MAX_REWRITES_PER_RUN\|MAX_AUTO_RESTARTS" desktop/agent-core/index.js` |
| L·生命周期钩子 | `main/toolHooks` + `preToolUse/postToolUse` | 包在真实 handler 之外、ALS 之内；三条通道（交互/Worker/定时）同源 | **完整** | `grep -n "toolHooks.wrap" desktop/main/agentRunner.js desktop/main/workerPool.js desktop/main/main.js` |
| V·评估接口 | `verifyRun` / `verifyPolicy` / V-L1 / V-L3 | 主通道默认档 `l3`、L1 全量零成本、L3 走风险门；Worker 默认 `l1` | **完整** | `grep -n "defaultLevel" desktop/main/agentRunner.js desktop/main/workerPool.js` |
| MCP·三层治理 | `desktop/main/mcpPrewarm.js` | `auto-start`/`whitelist`/`manual` 三档 + `MJCODE_MCP_LAZY` 默认开启 + 包名兜底 | **完整** | `grep -n "TIER = \|PREWARM_NAMES\|isLazyMode" desktop/main/mcpPrewarm.js` |
| MCP·意图预热 | `desktop/main/intentMcpPrewarm.js` + `agentRunner.intentPrewarmToolDefs` | 离线规则词典、原生优先、只连已保存连接器、6s 单服务超时、fail-open、`governanceStats` 观测 | **完整** | `grep -n "CAPABILITY_RULES\|planPrewarm" desktop/main/intentMcpPrewarm.js`；实跑 `node desktop/test/intent-mcp-prewarm.test.mjs` |
| MCP·结构化输出 | `desktop/main/ipc/mcp.js` 的 `mcp:callTool` | `structuredContent` 去重、`isError` 与 JSON-RPC `error` 二分 | **完整** | `grep -n "structuredContent\|isError === true" desktop/main/ipc/mcp.js`；`ls desktop/test/mcp-structured-output.test.mjs` |
| 技能·渐进披露 | `skillDisclosure` + `LOAD_SKILL_TOOL` + `load_skill` case | 渲染层显式下发 `'summary'`；索引只给 name+description；正文 `load_skill` 按需加载，过 `guardUntrusted` | **完整** | `grep -n "skillDisclosure: 'summary'" desktop/renderer/src/hooks/useAgentRun.ts`；`grep -n "LOAD_SKILL_TOOL\|case 'load_skill'" desktop/agent-core/index.js`；实跑 `node desktop/test/skill-disclosure.test.mjs` |
| 生态·数字员工 | `desktop/main/ecosystem.js` 的 `buildEmployeeRuntimePreset` | 51 员工 → `rolePreset`（systemPrompt/toolNames/审批/沙箱/模型引用串/skillNames）；审批沙箱取"更严格者" | **完整** | `node -e "..."` 见 §4.4 |
| 工具裁剪链 | `agent-core` 的 ① capability ② 角色子集 ③ planMode | 三段顺序写死、全部 fail-closed（HEAD 口径即已如此） | **完整** | `grep -n "toolCallCapable\|allowMcp === true" desktop/agent-core/index.js` |

---

## §2 发现清单（A-01 ～ A-10）

> **A-10 在 §6.2**（依研究员的主流基线简报增补，MCP 代际差距），不在本节——请一并阅读。

### A-01　Worker / 定时任务通道的"停止"无法穿透到在途模型请求　**P1**

- **现状**：交互式通道的 `chat` handler 是 `chatStreamOnce(chatPayload, sender, signal, runId)`，`signal` 经闭包进 `fetch`，中止即刻生效。而 **Worker 与定时任务两条无人值守通道的 `chat` handler 是 `scheduledAgentChat(payload)`**——`scheduledAgentChat` 只声明一个形参，内部用 `guardFor()` 自建 `controller`，**不接受外部 signal**。
- **问题**：Worker 工具工厂 `createToolHandlers: ({ signal, cwd, teamContext }) => ({...})` **解构了 `signal` 却一次都没用**（该工厂块内 `signal` 仅出现在解构处）；`scheduledAgentChat` 没有外部 signal 入口；`chatWithRetry(chatFn, params, signal, opts)` 内部只调 `chatFn(params)`（单参），也不把 signal 交给 chatFn。于是 Worker/定时任务被 abort 后，**在途 HTTP 请求不会被取消**，只能等 `scheduledAgentChat` 内部三层流式守卫（首字节 90s / 空闲 300s / 总时长 15min）自行超时。
- **证据**（可复核）：
  - `sed -n '/createToolHandlers: ({ signal, cwd, teamContext }/,/^      }),/p' desktop/main/main.js | grep -n signal` → 只命中第 1 行（解构处）
  - `grep -n "async function scheduledAgentChat" desktop/main/scheduledChannels.js` → `scheduledAgentChat(payload)` 单形参
  - `grep -n "export async function chatWithRetry" -A 8 desktop/agent-core/index.js` → 函数体为 `return await chatFn(params);`
  - 对照（交互式正确做法）：`grep -n "chatStreamOnce(chatPayload, sender, signal, runId)" desktop/main/main.js`
- **影响**：
  1. 用户点"停止编排"/"中止定时任务"后，Worker 最长仍占着模型连接与 **`quota` 的 `fg` 并发槽位**约 15 分钟才释放——槽位不释放会连带拖慢其它通道（`scheduledAgentChat` 内 `quota.acquire('fg', ...)`）。
  2. 计费侧：请求发出后服务端仍在推理，客户端已"停止"，费用照计。
  3. 与 A-02 叠加后，这条断链**没有任何测试覆盖**（`desktop/test/` 下无 "abort 后在途 fetch 被中断" 的断言）。
- **建议**：
  1. `scheduledAgentChat(payload, externalSignal)` 增加第二参；`guardFor()` 返回的 controller 与 `externalSignal` 用 `AbortSignal.any([...])` 合并后喂给 `fetch`（Node 20+ 支持 `AbortSignal.any`）。
  2. Worker 工厂与 `runScheduledAgentTask` 两处把 `controller.signal` / `signal` 传进去（当前解构后弃用，属明显的"写了一半"）。
  3. 补一条测试：Worker 通道 abort 后，在途 fetch 的 `signal.aborted === true`。
- **连带文件**：`desktop/main/main.js`（Worker 工具工厂 + `runScheduledAgentTask`）、`desktop/main/scheduledChannels.js`、`desktop/main/workerPool.js`、`desktop/test/`（新增用例）

---

### A-02　`resolveChannel` 丢弃第二参 `{ signal }`，引擎的工具取消契约是空头支票　**P2**

- **现状**：`agent-core` 的 default 分支注释明确写"第二参传运行上下文（signal 可用于长阻塞工具响应中止，如 orchestrate_task）"，并调用 `channel(toolArgs, { signal })`；但 `resolveChannel` 返回的是 `(args) => toolHandlers[camelName](args)`——**只转发第一个参数**。
- **问题**：`{ signal }` 在**所有**经 `resolveChannel` 的工具通道上被无条件丢弃（in-process 与 subprocess 两条路径皆然）。工具侧拿到的取消能力，实际全部来自主进程 `createToolHandlers` 的**闭包**（`signal: controller.signal`），而不是引擎契约。
- **证据**：
  - `grep -n "function resolveChannel" -A 10 desktop/agent-core/index.js`
  - `grep -n "toolResult = await channel(toolArgs, { signal })" desktop/agent-core/index.js`
  - `grep -n "signal 由主进程 handler 闭包各自供给" desktop/main/engineProcess/childEntry.js`（子进程侧注释已承认这一点）
- **影响**：
  1. 今天**不致命**：闭包链路在两条路径上都存在，冗余兜住了。
  2. 但契约是失真的：注释承诺的能力不存在。任何不经 `createToolHandlers` 闭包的调用方（单测直传 `toolHandlers`、未来的新宿主）会**静默**失去工具级取消，且不会报错。
  3. 与 A-01 同源：两者都是"signal 传了但没人接"。
- **建议**：
  - 短期（零风险）：把注释改成与实现一致——说明"signal 由宿主 handler 闭包供给，引擎第二参仅保留形态兼容"，避免后续开发者误以为可用。
  - 中期：`resolveChannel` 改为 `(args, ctx) => toolHandlers[camelName](args, ctx)`；subprocess 路径需同步评估 `ctx` 可序列化性（`signal` 不可结构化克隆，故子进程路径应维持"闭包供给"并显式文档化，不做 RPC 透传）。
- **连带文件**：`desktop/agent-core/index.js`、`desktop/main/engineProcess/childEntry.js`、`desktop/test/agent-core.test.mjs`

---

### A-03　`team_*` 四工具：三处登记全有、交互式运行时一个都没有，而矩阵判全绿　**P2**

- **现状**：
  - `TOOL_CHANNELS`（`desktop/main/engineProcess/registry.js`）已登记 `teamListMembers / teamSendMessage / teamBoard / teamWait`（工作区 diff 新增 2 行）。
  - `TOOL_HANDLER_NAMES`（`desktop/agent-core/index.js`）已映射 `team_list_members → teamListMembers` 等 4 条。
  - 但**交互式主会话的 handler 集合里没有这 4 个键**：`main.js` 的交互式 `createToolHandlers` 调 `...scheduledToolHandlers()`，`scheduledToolHandlers(deps)` 的 `teamTools` 默认 `null`，4 个键由 `...(teamTools ? {...} : {})` 条件展开——**不带参调用即不展开**。只有 Worker 工厂（`createToolHandlers({ ..., teamContext })`）在成员任务时才注入。
- **问题**：登记矩阵 `tool-registration-matrix.test.mjs` 的第 ③ 环节判定"每个非引擎内部工具均有注册（createToolHandlers / scheduledToolHandlers 区域）— 54 个工具全覆盖"，**实跑 143/143 通过**。它扫的是 `scheduledTools.js` 里的**字面量键**，看不见条件展开，因此把 `team_*` 判为"已注册"。这正是 F-002 想消灭的"假闭环"的另一形态（那次是"漏登记不产生孤儿所以恒绿"，这次是"条件注册被当成无条件注册"）。
- **证据**：
  - `node desktop/test/tool-registration-matrix.test.mjs | tail -3` → `143/143 通过`
  - 交互式集合推导：`grep -n "scheduledToolHandlers()" desktop/main/main.js`（无参调用）→ 对照 `grep -n "teamTools = null" desktop/main/scheduledTools.js`
  - 三段交叉核对脚本：解析 `TOOL_HANDLER_NAMES` × `TOOL_CHANNELS` × 交互式 handler 并集 → 交互式缺 4 项（仅 `todoWrite` 引擎内置例外）
- **影响**：
  - **当前不爆炸**：引擎只在 `teamContext` 非空且非 `customTools` 时才把 `TEAM_TOOLS` 并入通告；交互式从不传 `teamContext`，模型看不到这 4 个 schema，因此不会调用，不会报"未知工具"。
  - **但它是定时炸弹**：一旦将来把 `teamContext` 接到交互式（或任何非 Worker 通道），模型会立刻开始调用 4 个不存在的 handler → 每轮 `未知工具: team_*`。而矩阵与单测都查不出来。
- **建议**：
  1. 把 `TOOL_CHANNELS` 从"字符串数组"升级为结构化登记（含 `scope: 'always' | 'member-task' | 'engine-builtin'`），让"成员任务专属"成为机器可读事实（顺带解决 A-08 的 `todoWrite` 例外只存在于注释的问题）。
  2. 矩阵第 ③ 环节改为**按调用形态求值**：分别断言「交互式集合 = 全集 − team_*」与「Worker/成员任务集合 = 全集」两个方向。
- **连带文件**：`desktop/main/engineProcess/registry.js`、`desktop/main/scheduledTools.js`、`desktop/test/tool-registration-matrix.test.mjs`、`desktop/test/team-tools.test.mjs`

---

### A-04　MCP `auto-start` 档默认连接 ⇒ 与"原生优先"自相矛盾，且每轮无条件注入　**P2**

- **现状**：`mcpPrewarm.js` 的 `PREWARM_NAMES = {'filesystem','time','fetch'}`，懒启动默认开启（`isLazyMode` 仅 `MJCODE_MCP_LAZY=0/false/off` 时关闭）。渲染层 `App.jsx` 启动时 `restoreMcpTools()` 取**全部已连接服务**的工具，`useAgentRun.ts` 每轮把 `mcpTools` **无条件下发**。
- **问题**：`intentMcpPrewarm.js` 的"原生优先"规则（能力若已被原生工具覆盖则不拉 MCP）**只作用于意图预热新增的连接**，不作用于**已连接**的服务。于是 `filesystem` MCP（默认自启、常驻已连接）的 read/write/list 类工具每轮都在工具表里，与原生 `read_file / write_file / edit_file / apply_patch / list_dir / grep / glob` **功能重叠、同 run 同框**——恰恰是 `intentMcpPrewarm.js` 文件头声称要避免的"同一次 run 内两套实现同框"。
- **证据**：
  - `grep -n "PREWARM_NAMES\|isLazyMode" desktop/main/mcpPrewarm.js`
  - `grep -n "restoreMcpTools()" desktop/renderer/src/App.jsx`；`grep -n "mcpTools," desktop/renderer/src/hooks/useAgentRun.ts`
  - `grep -n "永不同框\|native: true" desktop/main/intentMcpPrewarm.js`
- **影响**：
  1. **上下文税**：重复能力常驻工具表，每轮都进 prompt 前缀；工具表字节变动还会打掉前缀缓存（`inspectToolTableBudget` 只观测不强制，默认档 `warn`）。
  2. **模型选择歧义**：两条路径都能读写同一目录，模型可能一半用原生、一半用 MCP，`V` 层 `verify_ledger` 的写入台账口径因此可能漏计（shell/原生写的记录与 MCP 写的记录是否同源需另行核验——**本轮未验证**）。
- **建议**：把"原生覆盖下架"从意图预热扩展到**已连接服务**：在 `allTools` 组装处，对"原生已覆盖能力"的 MCP 工具做下架（与现有 `__blocked__` schema 超限下架同一机制、同一处代码）；或把 `filesystem` 从 `auto-start` 降为按需。
- **连带文件**：`desktop/main/mcpPrewarm.js`、`desktop/agent-core/index.js`（`allTools` 组装处）、`desktop/main/intentMcpPrewarm.js`

---

### A-05　`onSuspend` 跨进程返回值退化为恒真（已文档化 fail-open）　**P3**

- **现状**：`childEntry.js` 的 `cbs.onSuspend` 返回 Promise；引擎侧 `suspendNoticed = !!onSuspend?.(...)` 对 Promise 取 `!!` **恒为真**。文件内注释已如实记录："返回值退化为『恒已保存』（Promise 恒真值）"。
- **问题**：子进程路径下，「断点是否真的落盘」这个事实**无法**回传引擎。引擎据此在两个分支做决策：模型超时分支 `if (suspendNoticed) { emitRunEnd(...); throw err; }`——恒 throw（行为正确），但判据是假的；收尾文案"断点已保存"在磁盘写失败时会失实。
- **证据**：`grep -n "suspendNoticed" desktop/agent-core/index.js`；`grep -n "Promise 恒真值" desktop/main/engineProcess/childEntry.js`
- **影响**：低。行为正确（`throw` 是想要的）、有文档、主进程侧 `onSuspend` 确实返回真实 `saved` 并通过 `emit('suspended', { saved, ...})` 如实上报给 UI。仅引擎内部判据失真。
- **建议**：把引擎侧改为 `suspendNoticed = !!(await onSuspend?.(...))`（Promise 与布尔都兼容），或显式写 `Promise` 分支判据；顺带让"磁盘写失败"不再被说成"已保存"。
- **连带文件**：`desktop/agent-core/index.js`、`desktop/main/engineProcess/childEntry.js`、`desktop/main/engineProcess/host.js`

---

### A-06　`engineParams` 未下发超时/轮次参数，两条执行路径靠"默认值隐式对齐"　**P3**

- **现状**：`agentRunner` 组装的 `engineParams` 不含 `maxRounds / maxTotalRounds / modelTimeoutMs / toolTimeoutMs / runWallClockMs / unattended`；in-process 与 subprocess 两条路径都靠 `runAgent` 的解构默认值（40 / 120 / 960000 / 120000 / `DEFAULT_RUN_WALL_CLOCK_MS` / false）保持一致，**今天等价**。
- **问题**：一旦有人想给交互通道单独设轮次或超时（这是很自然的下一步优化），只改 `agentRunner` 会**同时**改到两条路径，而 subprocess 路径上"参数是否被正确序列化过去"没有任何断言。另外"交互通道 `unattended=false`"是**隐式**的，而定时任务路径是显式传 `true`——同一语义两种表达。
- **证据**：`grep -n "const engineParams = {" -A 32 desktop/main/agentRunner.js`（逐项核对缺上述 6 个键）；`grep -n "maxRounds = 40\|maxTotalRounds = AGENT_HARD_ROUND_CAP\|runWallClockMs = DEFAULT" desktop/agent-core/index.js`
- **影响**：低（当前等价），属**易碎契约**：两条路径的一致性没有测试钉住。
- **建议**：`engineParams` 显式带上这 6 个值；在 `engineProcess/host.js` 的 `runEngine` 入口加一条"参数键白名单完整性"断言（与 `NOTIFY_CBS` 登记同源的纪律）。
- **连带文件**：`desktop/main/agentRunner.js`、`desktop/main/engineProcess/host.js`

---

### A-07　`BASE_TOOLS` 条数被测试钉死 → 工具全集分裂为"静态 1 处 + 运行时 3 处"　**P2**

- **现状**：`BASE_TOOLS` 的条数被 `desktop/test/web-todo-tools.test.js` 的"工具总数断言"钉死，因此新增工具**一律不能进 `BASE_TOOLS`**，只能运行时条件追加，目前已有 3 处：`LOAD_SKILL_TOOL`（summary 模式）、`COMPUTER_USE_TOOL`（macOS + 用户 opt-in）、`TEAM_TOOLS`（`teamContext` 非空）。
- **问题**：工具的"全集"只在**运行时**才确定，静态清单不再是单一事实来源。登记矩阵因此必须自己重建 57 个的清单（它做到了，但这是把复杂度推给了门禁）。这正是中期"声明式 registry"要解决的问题（与 F-002 的中期建议同向）。
- **证据**：`grep -n "effectiveBaseTools = \[" desktop/agent-core/index.js`（3 处追加）；`grep -n "工具总数" desktop/test/web-todo-tools.test.js`
- **影响**：中。每加一个条件工具，就有 4 个地方要同步（BASE_TOOLS 排除、运行时追加、TOOL_CHANNELS、矩阵驱动集），漏一处就是"未知工具"或"模型看不到"。
- **建议**：把 `BASE_TOOLS` 的"总数断言"改为"按名集合断言"（集合可增长、条数不再钉死），让条件工具回归静态清单 + 运行时裁剪；或一步到位建声明式 registry（每条工具一张卡片：schema / 通道 / 超时 / CWD / 审批 / scope），矩阵从卡片驱动。
- **连带文件**：`desktop/agent-core/index.js`、`desktop/test/web-todo-tools.test.js`、`desktop/test/tool-registration-matrix.test.mjs`

---

### A-08　`todoWrite` 的"引擎内置不经 RPC"例外只存在于注释，无机器可读标注　**P3**

- **现状**：`registry.js` 文件头注释说明"`todoWrite` 由引擎显式 case 内置处理（纯状态、不出网不触盘），不经 RPC，故不登记"；`TOOL_CHANNELS` 数组中确实没有它。但这是**纯注释事实**，没有结构化标记。
- **问题**：与 A-03 同源——"为什么这个工具不在登记表里"只有人能读。矩阵测试对 `todo_write` 走 `SPECIAL_CASED` 分支处理，靠的是测试里的另一份特判清单。
- **证据**：`grep -n "todoWrite 由引擎显式 case 内置处理" desktop/main/engineProcess/registry.js`；`grep -n "SPECIAL_CASED" desktop/test/tool-registration-matrix.test.mjs`
- **影响**：低。当前矩阵已能正确处理（143/143 含 `todo_write` 的 `SPECIAL_CASED`）。
- **建议**：随 A-03 的结构化登记一并解决（`scope: 'engine-builtin'`）。
- **连带文件**：`desktop/main/engineProcess/registry.js`、`desktop/test/tool-registration-matrix.test.mjs`

---

### A-09　子进程"内存硬上限 2GB"只约束 V8 堆，不等于进程 RSS 上限　**P3**

- **现状**：`host.js` 的 `defaultSpawn()` 用 `execArgv: ['--max-old-space-size=2048']`，注释写"引擎内存硬上限：失控任务最多吃掉 2GB 子进程堆，主进程与 UI 不受波及（验收②的资源护栏）"。
- **问题**：`--max-old-space-size` 只约束 V8 老生代堆，**不约束** Buffer / ArrayBuffer / 原生模块内存 / 子进程 RSS。注释措辞已限定为"堆"，所以不算失真；但若"资源护栏"验收项被理解为"进程内存 ≤ 2GB"，则不成立。
- **证据**：`grep -n "MEM_LIMIT_MB\|max-old-space-size" desktop/main/engineProcess/host.js`
- **影响**：低（崩溃半径隔离本身是有效的：子进程 OOM 只杀子进程，`tr.onExit` 收敛为 `engineExited`）。
- **建议**：措辞改为"V8 堆上限"，并在验收项里区分"堆上限"与"RSS 观测"（可选：进程退出时记录 `child.pid` 的峰值 RSS 用于诊断）。
- **连带文件**：`desktop/main/engineProcess/host.js`

---

## §3 需要决策的点（DA-01 ～ DA-05）

### DA-01　无人值守通道的取消语义：补齐穿透，还是接受"守卫超时即停"

| 方案 | 代价 | 说明 |
|---|---|---|
| **A. 补 `externalSignal` 穿透**（推荐） | `scheduledChannels.js` +2 参、`main.js` 两处传参、新增 1 个测试 | 与交互式 `chatStreamOnce` 同形；`AbortSignal.any` 合并内部守卫信号，语义清晰；顺带修掉"解构了 `signal` 却不用"的半成品代码 |
| B. 保持现状，文档化为"无人值守最长 15min 收敛" | 0 改动 | 但 `quota` 的 `fg` 槽位被占 15 分钟是实打实的资源浪费；且"停止"按钮在编排页对用户撒谎 |
| C. 改为 `Promise.race` 外层竞态（不改 fetch） | 最低改动 | 只让**引擎循环**提前返回，在途 socket 仍挂着——**不解决问题**，不推荐 |

- **推荐 A**。理由：交互式已经是对的做法，无人值守是同一份代码漏接，不是设计取舍；且 A-02 的根因相同，一次改完能同时收敛两处契约失真。
- **若采纳 A，需连带改**：`desktop/main/scheduledChannels.js`（`scheduledAgentChat` 加第二参 + `AbortSignal.any`）、`desktop/main/main.js`（Worker 工具工厂 与 `runScheduledAgentTask` 的 `toolHandlers` 组装处）、`desktop/main/workerPool.js`（确认 `controller.signal` 可达）、`desktop/test/`（新增 abort 穿透用例）。

---

### DA-02　`resolveChannel` 的第二参：修实现，还是修注释

| 方案 | 代价 | 说明 |
|---|---|---|
| **A. 先修注释 + 补一条"契约失真"回归测试**（推荐，本轮） | 极小 | 承认"signal 由宿主闭包供给"这一既有事实，消除误导；不改行为、零回归风险 |
| B. 改 `resolveChannel` 透传第二参 | 需同步评估 subprocess 路径的序列化边界 | `signal` 不可结构化克隆，子进程路径必须维持闭包供给 → 改完会出现"两条路径行为不同"，复杂度上升 |
| C. 完全移除第二参 | 需改所有调用点 | 最干净，但会丢掉未来做真正工具级取消的挂钩 |

- **推荐 A（本轮）→ 观察一轮后视需要走 B**。理由：当前有闭包兜底、无实际故障，本轮优先消除"注释与实现不符"这一**可复现的误导**；真正的工具级取消应作为独立议题排期。
- **若采纳 A，需连带改**：`desktop/agent-core/index.js`（default 分支注释 + `read_file`/`load_skill` 两处显式传参点的注释对齐）、`desktop/main/engineProcess/childEntry.js`（文件头"依赖方向反转"说明补一句）。

---

### DA-03　登记矩阵要不要"按调用形态求值"（即 A-03 的修法）

| 方案 | 代价 | 说明 |
|---|---|---|
| **A. 结构化登记 + 矩阵双向断言**（推荐） | `registry.js` 由字符串数组改对象数组（约 56 条），矩阵第 ③ 环节重写 | 把 `always / member-task / engine-builtin` 变成机器可读事实，同时解决 A-03 与 A-08 |
| B. 保持字符串数组，矩阵加一份"成员任务专属"硬编码清单 | 极小 | 快，但新增第四份清单，与"单一事实来源"纪律相悖 |
| C. 不动（接受这个盲区） | 0 | 直到有人把 `teamContext` 接到交互式才爆，届时是真机回归才发现 |

- **推荐 A**。理由：`team_*` 已经登记进 `TOOL_CHANNELS`（工作区 diff 已做），说明团队已经踩到"漏登记"的坑；现在补的是**下一类**坑（条件注册被当成无条件），结构化登记一次解决两代问题，且与 F-002 的中期建议（声明式 registry）同向。
- **若采纳 A，需连带改**：`desktop/main/engineProcess/registry.js`、`desktop/main/engineProcess/childEntry.js`（`TOOL_CHANNELS` 的消费者）、`desktop/test/tool-registration-matrix.test.mjs`、`desktop/test/engine-process.test.mjs`。

---

### DA-04　`filesystem` MCP 是否保留 `auto-start` 档

| 方案 | 代价 | 说明 |
|---|---|---|
| **A. 保留连接，但在 `allTools` 组装处下架"原生已覆盖"的 MCP 工具**（推荐） | 需定义"能力覆盖映射表"（可复用 `intentMcpPrewarm` 的 `nativeTools` 字段） | 不动连接策略（用户无感），只动通告；直接消掉重复能力与上下文税 |
| B. 把 `filesystem` 从 `auto-start` 降为 `whitelist`（按需） | 改 `mcpPrewarm.js` 一处 | 更彻底，但已习惯"开箱可用"的用户会突然失去它，属行为变弱且无预告（与 F-019 的教训同类） |
| C. 不动 | 0 | 维持"原生与 MCP 同框"，与 `intentMcpPrewarm` 文件头声明的红线自相矛盾 |

- **推荐 A**。理由：改通告不改连接，风险最低且可逆；若实测下架有误伤，加白名单即可回退。**注意**：本方案会使"用户已连接的 filesystem 工具突然从工具表消失"，需在 UI 上有可见说明（例如 MCP 面板标注"已被原生工具覆盖"），否则是另一种"产品对用户撒谎"。
- **若采纳 A，需连带改**：`desktop/agent-core/index.js`（`allTools` 组装处，与 `__blocked__` 下架同处）、`desktop/main/intentMcpPrewarm.js`（`nativeTools` 字段复用为覆盖映射）、渲染层 MCP 面板。

---

### DA-05　工具全集的组织方式（A-07）：解锁 `BASE_TOOLS` 条数，还是维持"运行时追加"

| 方案 | 代价 | 说明 |
|---|---|---|
| **A. 把"总数断言"改为"按名集合断言"**（推荐，先做这步） | 改 `web-todo-tools.test.js` 一条断言 | 让静态清单可增长，条件工具回归静态清单 + 运行时裁剪；复杂度从"4 处同步"降为"1 处声明 + 1 处裁剪" |
| B. 一步到位建声明式 registry | 大（56 条工具卡片 + 矩阵重写） | 终极形态，与 F-002 中期建议一致；但本轮工期内不建议与 A-03 的结构化登记重复投入 |
| C. 维持现状 | 0 | 每加一个条件工具仍要同步 4 处 |

- **推荐 A（本轮）→ B 作为中期议题单独立项**。理由：A 是 B 的前置（先让条数不再钉死，卡片化才有意义），且 A 本身就把当前最大的痛点（4 处同步）解决了。
- **若采纳 A，需连带改**：`desktop/test/web-todo-tools.test.js`、`desktop/agent-core/index.js`（`LOAD_SKILL_TOOL`/`COMPUTER_USE_TOOL`/`TEAM_TOOLS` 三处追加可保留为裁剪逻辑，不必立即搬进 `BASE_TOOLS`）、`desktop/test/tool-registration-matrix.test.mjs`。

---

## §4 数字基线（角度 A）

> **口径标注规则**：每个数字标 `HEAD`（`git show HEAD:<path>` 取到的值）、`工作区`（当前磁盘）、`文档声称`（既有文档/注释里写的值）。三者不一致处**明确列出**。
> **HEAD**：`24acc1531f55d70d8f591f0435d48eb114fbf3d0`

### 4.1 工具登记三段交叉（核心事实）

取数命令（三段交叉脚本，解析三处登记的键集合后求差集）：

```bash
cd /Users/jianma/Desktop/MJCode
# ① agent-core 的 TOOL_HANDLER_NAMES（模型工具名 → 通道名）
grep -n "const TOOL_HANDLER_NAMES = {" -A 62 desktop/agent-core/index.js
# ② engineProcess/registry.js 的 TOOL_CHANNELS
node -e "const r=require('./desktop/main/engineProcess/registry.js');console.log(r.TOOL_CHANNELS.length, r.NOTIFY_CBS.join(','), r.REQUEST_CBS.join(','))"
# ③ 主进程交互式 handler 集合 = scheduledTools.js 返回键 ∪ main.js createToolHandlers 显式键
grep -n "  return {" -A 40 desktop/main/scheduledTools.js
grep -n "createToolHandlers: ({ sender, signal, runId" -A 76 desktop/main/main.js
```

| 指标 | 数值 | 口径 | 备注 |
|---|---|---|---|
| `TOOL_HANDLER_NAMES` 条目数 | **55** | 工作区 | 模型工具名 → 通道名 |
| `TOOL_CHANNELS` 条目数 | **56** | 工作区 | HEAD 为 **54**（工作区 `+2` 行新增 `team_*` 四个名字；`git diff HEAD -- desktop/main/engineProcess/registry.js` → `+2 -0`） |
| 交互式 handler 集合（基础 23 ∪ 显式 37，去重） | **52** | 工作区 | `scheduledTools.js` 23 键 + `main.js` 37 键，去重后 52 |
| `BASE_TOOLS` 静态条目数 | **52** | 工作区 | 用 `name: '...', description:` 模式从 `BASE_TOOLS` 字面量提取 |
| 矩阵测试认定的"模型可见工具全集" | **57** | 工作区 | `node desktop/test/tool-registration-matrix.test.mjs \| tail -3` → `143/143 通过`，其中"① 引擎 schema — 57 个工具全覆盖"、"② TOOL_CHANNELS — 54 个工具通道全覆盖"、"③ 主进程 handler — 54 个工具全覆盖" |
| 模型工具 → 通道**未登记** | **1**（`todo_write → todoWrite`） | 工作区 | 引擎内置 case，不经 RPC（A-08） |
| 登记了通道但交互式**无** handler | **4**（`teamListMembers/teamSendMessage/teamBoard/teamWait`） | 工作区 | A-03 核心 |
| 反向孤儿通道（登记了但无模型工具映射） | **0** | 工作区 | 除 `chat`（模型通道）与 `mcpCallTool`（通配入口） |
| 交互式有 handler 但无模型工具映射 | **0** | 工作区 | — |

**一致性结论**：三段登记**结构性对齐**（无反向孤儿、无无主 handler）；唯一的实质性偏差是 `team_*` 的条件注册（A-03）与 `todoWrite` 的引擎内置例外（A-08），两者都由注释而非机器可读标记表达。

### 4.2 执行循环闸门常量

```bash
grep -n "export const AGENT_HARD_ROUND_CAP" desktop/agent-core/index.js          # 120
grep -n "export const DEFAULT_MODEL_TIMEOUT_MS\|DEFAULT_TOOL_TIMEOUT_MS" desktop/agent-core/index.js
grep -n "export const TOOL_TIMEOUT_OVERRIDES" -A 20 desktop/agent-core/index.js
grep -n "maxRounds = 40\|maxTotalRounds = AGENT_HARD_ROUND_CAP" desktop/agent-core/index.js
```

| 常量 | 值 | 口径 |
|---|---|---|
| `AGENT_HARD_ROUND_CAP` | 120 | 工作区（`test/agent-core.test.mjs` 有 `=== 120` 硬断言） |
| `runAgent` 默认 `maxRounds` | 40（可续期 2 次 → 有效 120） | 工作区 |
| `DEFAULT_MODEL_TIMEOUT_MS` | 960000（16 min） | 工作区 |
| `DEFAULT_TOOL_TIMEOUT_MS` | 120000（120 s） | 工作区 |
| `TOOL_TIMEOUT_OVERRIDES` 条目数 | **18**（矩阵实测："④ 无孤儿超时条目 — 18 条有效"） | 工作区 |
| `CWD_TOOLS` / `APPROVAL_TOOLS` | 25 / 33（矩阵实测） | 工作区 |
| `TOOL_LEVEL` 显式登记 / 特判 / 只读 | 43 / 10 / 10（矩阵实测） | 工作区 |
| `BASE_PROMPT` 长度 | 2409 字符；核心工具承诺 30 个（矩阵实测） | 工作区 |
| 引擎子进程 V8 堆上限 | 2048 MB（`--max-old-space-size`） | 工作区（见 A-09） |

### 4.3 取消链路（A-01 / A-02 的事实基础）

```bash
sed -n '/createToolHandlers: ({ signal, cwd, teamContext }/,/^      }),/p' desktop/main/main.js | grep -c signal   # → 1（仅解构处）
grep -n "async function scheduledAgentChat" desktop/main/scheduledChannels.js   # → (payload) 单参
grep -n "chatStreamOnce(chatPayload, sender, signal, runId)" desktop/main/main.js  # 交互式：有 signal
grep -n "export async function chatWithRetry" -A 8 desktop/agent-core/index.js  # → chatFn(params) 单参
grep -n "function resolveChannel" -A 8 desktop/agent-core/index.js             # → (args) => ... 丢弃第二参
```

| 通道 | 在途 fetch 是否可被 abort 取消 | 依据 |
|---|---|---|
| 交互式主会话 | **是** | `chat: (chatPayload) => chatStreamOnce(chatPayload, sender, signal, runId)` |
| Worker（编排子任务） | **否** | `chat: (payload) => scheduledAgentChat(payload)`；工厂解构的 `signal` 未使用 |
| 定时任务 | **否** | 同上 `scheduledAgentChat`；`runScheduledAgentTask` 的 `signal` 只传给 `runAgent`，未进 `toolHandlers.chat` |
| 引擎 → 工具通道 | **否（契约层面）** | `resolveChannel` 丢弃第二参 `{ signal }`；工具实际靠主进程闭包 |

### 4.4 生态资产计数（技能体系 / 生态中心 / 数字员工）

```bash
cd /Users/jianma/Desktop/MJCode
node -e "
const e=require('./desktop/main/ecosystem.js');const r=e.loadEcosystem('./ecosystem');
console.log('employees='+r.employees.length,'connectors='+r.connectors.length,'skills='+r.skills.length);
console.log('categories:',r.stats.employeeCategories.length,r.stats.connectorCategories.length,r.stats.skillCategories.length);"
node -e "const fs=require('fs');const l=d=>Array.isArray(d)?d:(d.connectors||d.items||[]);
console.log('curated='+l(JSON.parse(fs.readFileSync('./ecosystem/mcp-connectors.json','utf8'))).length);
console.log('workbuddy='+l(JSON.parse(fs.readFileSync('./ecosystem/mcp-connectors-workbuddy.json','utf8'))).length);"
find ~/.mjcode/skills -name "SKILL.md" | wc -l
```

| 指标 | 数值 | 口径 | 对照"文档声称" |
|---|---|---|---|
| 数字员工 | **51** | 工作区（`digital-employees.json`） | 第七轮 README 两处矛盾：一处 "80/50/230"、一处 "77/51/52"（见 R7 §2 D-06/F-021）。**两处都与当前 51 不符** |
| MCP 连接器（合并后） | **291** | 工作区 | 精选目录 `mcp-connectors.json` = **77**（符合该文件"≤90 条防膨胀"不变式）；`mcp-connectors-workbuddy.json` = **214**；合并去重后 291 |
| 技能目录条目（`skills.json`） | **219** | 工作区 | — |
| 磁盘真实 `SKILL.md` | **154** | 工作区（`~/.mjcode/skills`） | 与 `skills.json` 的 219 **不一致**（65 条目录条目无对应落盘文件） |
| 生态分类数 | 员工 10 / 连接器 16 / 技能 13 | 工作区 | — |

> ⚠️ 生态数字**逐条与既有文档对不上**（R7 已记 F-021）。本节只给可复刻命令与当前值，不替主理人裁定文档该怎么改。

### 4.5 IPC 接线：后端注册 vs 前端桥接 vs 前端引用（校准"89% 未被调用"）

```bash
cd /Users/jianma/Desktop/MJCode
# ① 主进程静态注册（含模板族 tool:${toolName} 展开 3 条）
grep -rn "ipcMain\.handle(" desktop/main --include=*.js | wc -l          # 206
grep -n "ipcMain.handle(\`tool:\${toolName}\`" desktop/main/tools/exec.js # 模板族 → writeFile/editFile/applyPatch
# ② preload 桥接方法数
grep -c "ipcRenderer.invoke(" desktop/main/preload.js                    # 208
# ③ 三段交叉（注册 / 桥接 / 渲染层引用）—— 下列脚本可直接粘贴执行
cat > /tmp/audit_ipc4.js <<'EOF'
const fs=require('fs');const R='/Users/jianma/Desktop/MJCode';
function walk(d,o=[]){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=d+'/'+e.name;
 if(e.isDirectory()){if(!/node_modules|\.git|dist|build|assets/.test(e.name))walk(p,o);}
 else if(/\.(js|mjs|jsx|ts|tsx)$/.test(e.name))o.push(p);}return o;}
const reg=new Set();
for(const f of walk(R+'/desktop/main')){const s=fs.readFileSync(f,'utf8');
 for(const m of s.matchAll(/ipcMain\.handle\(\s*['"`]([a-zA-Z0-9:_/.\-]+)['"`]/g))reg.add(m[1]);}
const FAMILY=['tool:writeFile','tool:editFile','tool:applyPatch'];
const all=new Set([...reg].filter(c=>!c.includes('${')));FAMILY.forEach(c=>all.add(c));
const pre=fs.readFileSync(R+'/desktop/main/preload.js','utf8');const map=new Map();
for(const m of pre.matchAll(/^\s{2}([a-zA-Z0-9_]+):\s*.*?ipcRenderer\.invoke\(\s*['"`]([a-zA-Z0-9:_/.\-]+)['"`]/gm))map.set(m[2],m[1]);
let blob='';for(const f of new Set(walk(R+'/desktop/renderer'))){try{blob+=fs.readFileSync(f,'utf8')+'\n';}catch{}}
const unused=[];for(const [ch,name] of map){
 const re=new RegExp('(\\.'+name+'\\b)|([\'"`]'+name+'[\'"`])|(\\b'+name+'\\s*:)');
 if(!re.test(blob))unused.push(name+' -> '+ch);}
console.log('REGISTERED='+all.size);console.log('BRIDGED='+map.size);
console.log('NOT_BRIDGED='+[...all].filter(c=>!map.has(c)).join(', '));
console.log('UNREFERENCED='+unused.length);console.log(unused.join('\n'));
EOF
node /tmp/audit_ipc4.js
```

| 指标 | 数值 | 口径 |
|---|---|---|
| 主进程 `ipcMain.handle` 注册通道 | **209** = 静态 **206** + 模板族 `tool:${toolName}` 展开 **3**（`writeFile/editFile/applyPatch`） | 工作区 |
| preload 桥接的 `ipcRenderer.invoke` 方法 | **208**（唯一通道 208） | 工作区 |
| 注册了但 preload **未桥接**（前端永远调不到） | **2** → `diag:preview`、`scheduled:ingestEvent` | 工作区 |
| 桥接了但渲染层源码中**完全找不到引用** | **22 / 208 = 10.6%** | 工作区 |
| — 其中整族死代码 | `collab*` 6 个（`collabOpen/DocId/Persist/EncodePush/ApplyUpdate/ListLocal/CloseAll`）、`teams*` 4 个（`Update/Archive/SetMemberEnabled/CreateLead`） | 工作区 |

**未被引用的 22 个**（渲染层源码中既无 `.name` 属性访问、也无 `'name'` 字符串、也无 `name:` 键）：
`getSecrets`、`gitCheckout`、`listWorktrees`、`collabOpen`、`collabDocId`、`collabPersist`、`collabEncodePush`、`collabApplyUpdate`、`collabListLocal`、`collabCloseAll`、`serverHealth`、`mcpGovernanceGet`、`tasksAutoRun`、`tasksPlan`、`governanceStats`、`marketSearchNetwork`、`diagExport`、`tasksConfig`、`teamsUpdate`、`teamsArchive`、`teamsSetMemberEnabled`、`teamsCreateLead`

> **校准结论**："89% 后端命令未被前端调用"在**当前代码上不成立**，实测为 **10.6%**。该方法学的已知局限（避免过读）：渲染层可能通过动态属性访问（`api[name]()`）调用，本脚本扫不到；本报告已对 `agentRun/teamsList/ecosystemSummary/marketSearch` 等做人工抽检确认（分别经 `mj?.agentRun`、`api.teamsList`、`api.ecosystemSummary`、`call('marketSearch', ...)` 调用），确认主要误报已排除。

### 4.6 HEAD vs 工作区（角度 A 关键文件 diff 规模）

```bash
git rev-parse HEAD                                   # 24acc1531f55d70d8f591f0435d48eb114fbf3d0
git status --short | wc -l                           # 99
for f in desktop/agent-core/index.js desktop/main/agentRunner.js \
         desktop/main/engineProcess/registry.js desktop/main/modelShape.js desktop/main/ecosystem.js; do
  git diff --numstat HEAD -- "$f"; done
```

| 文件 | HEAD → 工作区 | 内容 |
|---|---|---|
| `desktop/agent-core/index.js` | **+79 / -1** | 新增 `TEAM_TOOLS`（4 个协同工具定义）、`TEAM_PROMPT_SECTION`、`teamContext` 条件追加分支 |
| `desktop/main/agentRunner.js` | **+19 / -0** | `intentPrewarmToolDefs` 的 `decodeToolName` 反解（F-005 相关）等 |
| `desktop/main/engineProcess/registry.js` | **+2 / -0** | 新增 `teamListMembers/teamSendMessage/teamBoard/teamWait` 四通道登记 |
| `desktop/main/modelShape.js` | **+89 / -0** | `MODEL_REF_*` 引用串编解码（`encodeModelRef/decodeModelRef/canonicalizeModelRef/resolveModelRef`） |
| `desktop/main/ecosystem.js` | **+6 / -0** | `buildEmployeeRuntimePreset` 的 `model: canonicalizeModelRef(emp.model)` |

**工作区行数（含未提交改动）**：`agent-core/index.js` 3668、`main/agentRunner.js` 696、`engineProcess/childEntry.js` 122、`engineProcess/host.js` 124、`engineProcess/registry.js` 50、`engineProcess/transport.js` 65、`main/modelShape.js` 252、`main/ecosystem.js` 249、`main/tools/exec.js` 622、`main/tools/execWrite.js` 200、`main/ipc/mcp.js` 782。取数：`wc -l <上述文件>`。

### 4.7 测试基线（角度 A 相关）

```bash
ls desktop/test/*.test.mjs | wc -l          # 153
node desktop/test/tool-registration-matrix.test.mjs | tail -1
```

| 指标 | 数值 | 口径 |
|---|---|---|
| `desktop/test/*.test.mjs` 文件数 | **153** | 工作区 |
| 工具登记矩阵断言 | **143/143 通过** | 工作区（实跑） |
| 角度 A 相关测试文件 | 43 个（含 `agent-core` / `agent-engine` / `engine-process` / `tool-registration-matrix` / `tool-call-capability` / `mcp-*`（18 个）/ `skill-disclosure` / `team-tools` / `ecosystem-*`（4 个）/ `scheduled-tool-surfaces` 等） | 工作区 |
| 逐工具断言规模 | 57 × 2 条（8 环节逐工具 + 审批分级逐工具） | 工作区（矩阵自报） |

---

## §5 遗留问题与未知区（本轮未验证 / 不敢下结论的）

1. **`V` 层写入台账在「原生写」与「MCP 写」之间是否同源**：A-04 若成立（两套写路径同框），`verify_ledger` 的 `writes` 计数是否覆盖 MCP 写入——**本轮未验证**，需读 `verifyRun` 与 `mcpCallTool` 的 trace 落点后确认。
2. **MCP 严格服务端对缺 `MCP-Protocol-Version` 返回 400**（第七轮 F-006）：本轮未复现，维持"未验证"。
3. **`--max-old-space-size` 在 Electron `utilityProcess.fork` 的 `execArgv` 上是否真的生效**：只读了 `host.js` 的传参，未做真机内存压测（A-09 因此定为 P3）。
4. **A-01 的实际停止延迟**：推论为"最长 15 min（内部流式守卫总时长档）"，但 `streamGuard` 的三层配置可由 `localSetPreference` 改写，实际值依赖用户设置——**未实测**，需真机或注入测试确认。
5. **主流性判断（全部待 P0 主流基线简报确认）**：
   - "每 run 一个子进程 + 依赖方向反转"是否属 2026 主流进程隔离形态；
   - "条件工具运行时追加 vs 声明式 registry"的主流取向；
   - 工具取消是否主流上要求引擎层 signal 直达工具（A-02 的方向选择依赖此答案）。
6. **`disk SKILL.md 154` vs `skills.json 219` 的差是否属于预期**（目录含"可安装但未安装"条目）：未读 `ipc/plugins.js` 的安装逻辑确认，不作裁定。

---

## §6 主流基线对照（增补，依据 `docs/harness-r8/01-research/主流技术基线简报.md`）

> 本节在研究员交付基线简报后增补。**只填角度 A 范围内的 C-xx 行**；范围外的留白不臆测。
> 判定依据一律回指简报的「主线 N · 判据 x.y」编号；每个判定附可复核命令。
> 简报 §3 的三条避坑提示已遵守：未引用任何 OTel 稳定性结论（不涉本角度）、未把 `AGENTS.md` 与 `SKILL.md` 混用、未引用任何外部生态绝对数字（§4.4 的数字全部由仓库内文件经命令算出）。

### 6.1 角度 A 自检表填值

| 编号 | 检查项 | 判定 | 依据（命令 / 判据） |
|---|---|---|---|
| C-01 | `MCP-Protocol-Version` 头 | **✅ 对齐** | 已发（B1-B-04 修复）。`grep -n "MCP-Protocol-Version" desktop/main/mcpHttpTransport.js` → initialize 后所有 POST 带协商值 · 判据 1.1 |
| C-02 | 支持集含 `2026-07-28` 或有显式升级排期 | **❌ 偏离** | `grep -n "SUPPORTED_PROTOCOL_VERSIONS" desktop/main/mcpProtocol.js` → `['2025-11-25','2025-06-18','2025-03-26','2024-11-05']`，**不含 2026-07-28**；降级路径只向更旧版本（MIN=2024-11-05），不向更新版本 · 判据 1.2 → 见 **A-10** |
| C-03 | 对 `initialize`/`Mcp-Session-Id` 依赖可关闭 | **❌ 偏离** | `grep -n "mcp-session-id\|Mcp-Session-Id" desktop/main/mcpHttpTransport.js` → 捕获并回带，无无状态路径；`mcpAuth.js` 的 401 探针也发 `initialize` · 判据 1.3 → 见 **A-10** |
| C-04 | `mcp__<server>__<tool>` 拼名可逆 | **✅ 对齐** | `desktop/shared/mcpNameCodec.mjs` 百分号编码（`_`→`%5F`、`%`→`%25`），安全名零迁移、旧格式兼容、已知残余歧义已如实注释；`ls desktop/test/mcp-name-codec.test.mjs` · 判据 1.4（第七轮 F-005 已闭合） |
| C-05 | 第三方工具定义钉定 + 变更可见 | **❓ 未核** | `mcpToolCache.js` 有 manifest 缓存，是否有 description 哈希与变更 diff 本轮未读 · 判据 1.5 |
| C-07 | skill 三级渐进披露 | **✅ 对齐** | 渲染层显式 `skillDisclosure: 'summary'`，引擎只注入 name+description 索引，正文 `load_skill` 按需 · 判据 2.1 |
| C-08 | skill 目录只识别直接子目录、不递归 | **❓ 未核** | 未读 `ipc/plugins.js` 的扫描实现 · 判据 2.2 |
| C-13 | 单一工具调用循环 + 明确停止条件 | **✅ 对齐** | `runAgent` 单循环，六道闸门（轮次双闸 40×3 / 硬顶 120、token、墙钟、重复失败熔断、空收尾守卫、模型超时 960s）· 判据 3.1 |
| C-21 | 工具输出入上下文前截断 + offload 可取回 | **✅ 对齐** | `bigPayload.offloadToolCall` / `bigPayload:fetch` 分页取回；`truncateToolResult` · 判据 4.3 |
| C-23 | 子代理回传有 token 上限（量级 10³） | **⚠️ 部分**<br>（**措辞已更正**，见下） | **不是"原样未截断"，而是"截断了但不可恢复"**：`truncateToolResult(await summarizeToolOutput(toolResult, name))` 在工具分派 switch 之后**无条件执行**，故子代理回传同样过 `TOOL_RESULT_MAX_CHARS = 15000` 硬顶；但 `summarizeToolOutput` 的字段白名单仅 `['stdout','content']`，而子代理回传键是 **`result`** ⇒ 不走 PASS 折叠、不走头尾保留、**不落盘**（对比 shell 长输出落 `${TMPDIR}/mjcode-tool-outputs/` 且可用 `read_file` 取回），**尾部永久丢失**。另：`SUBAGENT_DEFAULT_BUDGET = 50000` 闸的是**生成侧**（子代理自己烧多少 token），与"回传多长"是两件事 · 判据 4.5<br>⚠️ 本行初稿误写为"原样未截断"，经角度 B 的 architect-2 实测指出后更正；与角度 B 的 **B-20（P2）同源**，详见该报告 |
| C-34 | 每层 max-step / max-cost / max-wallclock | **⚠️ 部分** | `runAgent` 三层齐全；Worker/编排层在 `workerPool.js` 未见 `maxRounds`/`tokenBudget`/`wallClock` 键（本轮未核到，非断言其缺失）· 判据 6.3 |
| C-36 | 派生深度硬上限 | **✅ 对齐（结构性）** | `SUBAGENT_TOOL_NAMES` 仅 7 个只读工具，不含 `spawn_subagent`/`orchestrate_task`；`scheduledToolHandlers` 亦不含 `orchestrateTask` ⇒ 派生深度**恒为 1**，由工具集而非计数保证 · 判据 6.5 |
| C-51 | run 生命周期独立于渲染进程 | **✅ 对齐** | P0-4 迁移：循环与工具副作用全在主进程，渲染层只发 `agent:run` 与订阅 `agent:event` · 判据 8.2 |
| C-52 | 有从中断点恢复的入口 | **✅ 对齐** | `checkpointStore` + `resumeContext` + `onSuspend`（kind 区分 tokens/timeout/wallclock/engine-exit）· 判据 8.3 |
| C-56 | session / harness / sandbox 可独立失败与替换 | **✅ 对齐** | harness = `utilityProcess` 子进程（`engineExited` 收敛为可恢复错误）；sandbox 独立；session（落库/trace）留在主进程 · 判据 8.7（**但 A-01 削弱了这条的可中断性**） |
| C-68 | 扩展必须过逐项全覆盖登记门禁 | **⚠️ 部分** | 矩阵已逐项全覆盖且实跑 143/143，但存在 **A-03** 条件展开盲区 · 判据 10.5 |
| C-69 | 声称能力与机器守护不变量一一对应 | **⚠️ 部分** | **A-02**（承诺 `{signal}` 但被丢弃）与 **A-03**（登记全绿但运行时无 handler）正是"声称与守护落差"的两个实例 · 判据 10.6 |

### 6.2 基线带来的新发现

### A-10　MCP 客户端停留在 `2025-11-25` 一代，落后整整一代且已声明的两项能力在新版属弃用清单　**P2**

- **现状**：`desktop/main/mcpProtocol.js` 的 `PROTOCOL_VERSION = '2025-11-25'`，`SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25','2025-06-18','2025-03-26','2024-11-05']`。**主流当前版本是 `2026-07-28`**（简报 §0-2 / 主线 1，一手来源 modelcontextprotocol.io 版本页），且该版是**断裂式升级**：移除 `initialize`/`initialized` 握手与 `Mcp-Session-Id`，改为无状态请求/响应；新增 `server/discover`、`Mcp-Method`/`Mcp-Name` 头路由、MRTR、可缓存 list、正式扩展框架，并设 **12 个月最低弃用窗口**。
- **问题（三层）**：
  1. **版本集不含 `2026-07-28`**（判据 1.2 → 偏离）。降级路径只向**更旧**版本（服务端拒 `2025-11-25` 时降到 `2024-11-05` 并打 `legacy` 标记），不向更新版本。
  2. **硬依赖握手与 session**（判据 1.3 → 偏离）。`mcpHttpTransport.js` 从 initialize 响应头捕获 `mcp-session-id` 并在后续请求回带；`mcpAuth.js` 的 401 探针也发 `initialize`。无无状态路径。
  3. **声明的两项客户端能力在新版已入弃用清单**：`CLIENT_CAPABILITIES = { roots, completion, logging }`，而 `roots` 与 `logging` 在 `2026-07-28` 均属被弃用项（12 个月窗口）；同时支持的最低版本 `2024-11-05` 对应 legacy HTTP+SSE 传输，也在弃用清单内。
- **证据**：
  - `grep -n "PROTOCOL_VERSION\|SUPPORTED_PROTOCOL_VERSIONS\|CLIENT_CAPABILITIES" -A 5 desktop/main/mcpProtocol.js`
  - `grep -n "mcp-session-id\|Mcp-Session-Id" desktop/main/mcpHttpTransport.js`
  - `grep -n "protocolVersion: PROTOCOL_VERSION" desktop/main/mcpAuth.js`
  - 基线：简报 §1 主线 1「被弃用（12 个月窗口）：roots、sampling、logging、DCR、legacy HTTP+SSE 传输」
- **重要定性**：**这是已知且有意的推迟，不是疏漏**。`mcpProtocol.js` 文件头注释明确写「当前最新的 2026-07-28 取消了 initialize 握手，属架构级改造，不在本批范围」，`mcpHttpTransport.js` 也标注了「本处是『2026 双栈』的唯一改造点（D-01 退路）」。因此**不应按"不知道"重报**，第八轮要判的是**"推迟有没有排期与到期日"**。
- **影响**：
  1. 生态连接器正按新版发布，MJCode 只能连仍兼容旧握手的服务端——**"291 个连接器目录"里能用多少是个未知数**（本轮未核，建议单独立项抽样）。
  2. 弃用窗口 12 个月：roots/logging/legacy SSE 到期后，现有声明会变成对端的错误源。
  3. 与 A-04 叠加：MCP 是本角度对外部世界的主要接口面，代际落后 + 默认自启档重叠，两条应一起排期。
- **建议**：
  1. 把「支持 `2026-07-28`」写成带**目标日期**的排期项（不是"将来做"），并在 `mcpProtocol.js` 的 `SUPPORTED_PROTOCOL_VERSIONS` 上方注释里写明到期触发条件。
  2. 优先做**无状态路径**：2026-07-28 的核心是每个请求自描述（版本 + 客户端身份 + 能力放 `_meta`），这与现有"initialize 后回带"是两套；`mcpHttpTransport.js` 已是唯一改造点，成本可控。
  3. 弃用到期前把 `roots` / `logging` 从 `CLIENT_CAPABILITIES` 摘掉（否则新版服务端会把它们当未知能力）。
- **连带文件**：`desktop/main/mcpProtocol.js`、`desktop/main/mcpHttpTransport.js`、`desktop/main/mcpClient.js`、`desktop/main/mcpAuth.js`、`desktop/test/mcp-protocol-version.test.mjs`

### 6.3 基线对既有发现/决策的强化（据此调整措辞，不调整严重度）

- **A-01 获得主流依据**：简报主线 8 反模式「让 run 生命周期依赖浏览器/渲染进程」与判据 8.7（session/harness/sandbox 可独立失败与替换）已由 MJCode 满足（C-56 ✅）；但**"可独立失败"不等于"可中断"**——A-01 指出 harness 与 session 之间缺一条取消通道。→ 建议把 A-01 的表述从"性能问题"升级为"**长时运行的可中断性缺口**"，对齐主线 8 的 table-stakes 语义。
- **A-02 / A-03 获得主流依据**：判据 10.6「对外声称的能力与机器守护的不变量一一对应，无『声称但无守护』」——A-02（承诺 `{signal}` 无实现）与 A-03（登记全绿但运行时无 handler）是这条判据的两个直接反例。
- **A-04 获得主流依据**：判据 4.4「每轮请求保持稳定前缀（工具集/顺序/模型不中途变）以利 prefix cache」与主线 10 反模式「预载全量工具目录」——默认自启的 `filesystem` MCP 让每轮工具表常驻一套与原生重复的读写能力，正踩这条（既占前缀字节，又与主线 1 的 progressive discovery 方向相反）。
- **DA-03 排序提前**：判据 10.5 明确要求门禁是"逐项全覆盖而非只查孤儿"。矩阵已做到逐项全覆盖，唯独漏了条件展开（A-03）→ **DA-03 是本角度唯一一个直接对应主流判据的改造项，建议优先于 DA-05**。
- **一处"主流性"判断现已可下结论**（此前标"待 P0 确认"）：基线主线 6 判据 6.1/6.8 明确「单主循环 + 一次性隔离子代理」为收敛形态、peer GroupChat 与"部门式文档传递"为反模式（判据 6.8 直指"三省六部幻觉"）。据此可判：**MJCode 的 `spawn_subagent`（只读 7 工具、深度恒为 1、只回传结论）+ `orchestrate_task`（编排者持全局、Worker 不可再派生）在形态上是对齐的**；需继续观察的是工作区新增的 `team_*` 四工具（成员可互发消息、共享看板）——**它引入了 peer 消息通道，正是判据 6.1 点名的"子任务之间直接互相发消息的通道"**。建议对军团协同单独立一项判 6.1/6.2（消息是否类型化且两端校验）。

---

## §7 交付台账

| 项 | 值 |
|---|---|
| 审查角度 | A —— 执行引擎与能力层 |
| HEAD 锚点 | `24acc1531f55d70d8f591f0435d48eb114fbf3d0` |
| 默认口径 | 工作区（`git status --short` = 99 项改动） |
| 发现条数 | **10**（A-01 ～ A-10）：P1 × 1（A-01）、P2 × 5（A-02/A-03/A-04/A-07/**A-10**）、P3 × 4（A-05/A-06/A-08/A-09） |
| 决策点数 | **5**（DA-01 ～ DA-05） |
| 对第七轮的校准 | 3 条（F-002 已实质修复、F-003/F-018/F-019 已在 HEAD 修复、"89% 未调用"实测为 10.6%） |
| 基线自检表 | 已填角度 A 范围内 17 行：✅ 9 / ⚠️ 4 / ❌ 2 / ❓ 2 |
| 改动代码 | **无**（本阶段只做审查与设计，落盘仅限本文件） |
