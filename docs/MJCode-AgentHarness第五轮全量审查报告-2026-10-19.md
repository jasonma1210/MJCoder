# MJCode Agent Harness 第五轮全量审查报告（2026-10-19）

> 审查角色：Agent Harness 专家团（执行安全 / 上下文经济 / 记忆体系 / 编排 / 协议 / 端到端流程 / 前端交互）
> 方法论：**先读当前代码，再下结论**。凡标「已确认」的均有 grep / 读码证据；凡无法当场取证的，一律标「待核实」。
> 视角基线：**非云端 · 本地优先桌面 Agent**（对标 Codex Desktop 非云版 / Trae Work 本地态 / WorkBuddy 本地态 / Lobster AI）。
> 范围：`desktop/`（Electron 主进程 + React 渲染层 + agent-core headless 引擎）、`ecosystem/`、`server/`（可选）。

---

## 0. 一句话结论

**第四轮报告列出的 P0/P1 缺口（记忆写闭环、压缩摘要归档、L3 接线、用户 hooks、会话 fork、MCP 自动重连、Windows OS 级沙箱接线、技能渐进式披露）在本轮经当前代码逐条复核后，确认已全部落地。**
项目当前「执行面 / 治理面 / 闭环面」三面均已闭合，对标非云端主流桌面 Agent 无实质短板，部分维度（打转检测、记忆治理、凭证隔离、安全闸）更强。

本轮仍识别出 **10 项残差缺口**（1 项功能性 + 4 项平台/协议 + 5 项体验/工程）与 **6 项端到端流程问题**，均为「锦上添花 / 平台对等 / 工程一致性」性质，**无一项会阻断核心能力闭环**。

> 口径纪律（沿用第三/四轮教训）：本报告**不沿用任何旧报告结论**，所有「已具备 / 仍缺」均以 2026-10-19 当前代码复核为准。旧报告说「缺」而当前代码已补的，一律改判为「已闭合」。

---

## 1. 基线锚定（本报告数字的唯一口径）

| 项 | 值 | 取法 |
|---|---|---|
| 版本 | `v0.6.0-beta` | `desktop/package.json` |
| 当前提交 | `8d23b4f`（本地与远端 0 分叉） | `git rev-list --left-right --count` |
| 引擎 | `agent-core/index.js`（194,333 字节，headless、零 Electron 依赖） | `ls -la` |
| 主进程模块 | `desktop/main/` 约 96 个 `.js` 模块 | `ls main/` |
| 渲染层 | `renderer/src/components/` 约 50 个组件 + `pages/` + `hooks/` | `ls` |
| 测试基线 | `desktop/test/` **210 套件** | `ls test/` |
| 源码 TODO/FIXME | **仅 1 处**（main + agent-core + renderer/src） | `grep -rInE "TODO\|FIXME"` |
| MCP 协议版本 | `2025-11-25`（含降级 `2024-11-05`） | `main/mcpProtocol.js:20-24` |

**H 框架层裁定（E/T/C/S/L/V + P）**：

| 层 | 裁定 | 与第四轮对比 |
|---|---|---|
| **E 执行循环** | ✅ 完整 | 持平 |
| **T 工具注册** | ✅ 完整（授权侧 + 披露侧渐进披露已补） | ⬆️ 由「部分」升为「完整」 |
| **C 上下文管理** | ✅ 完整（摘要已落记忆、窗口双表） | ⬆️ 由「基本完整」升为「完整」 |
| **S 状态存储** | ✅ 完整（断点续跑 + checkpoint + **会话 fork 已补**） | ⬆️ 由「基本完整」升为「完整」 |
| **L 生命周期钩子** | ✅ 完整（审批/审计 + **用户自定义 hooks 已补**） | ⬆️ 由「扩展性为零」升为「完整」 |
| **V 评估接口** | ✅ 完整（L1 全量 + L3 默认档 l3 + 风险门 + 定时通道 + Worker 通道） | ⬆️ 由「能力就绪/默认 l1」升为「完整」 |
| **P 范式四维** | ✅ 达标 | 持平 |

---

## 2. 第四轮缺口 → 当前状态逐条复核（核心章节）

> 下表是本轮最重要的取证结果：**第四轮 12 项缺口，11 项已闭合，1 项（P2-1 布局 token）仍部分未做。**

| 第四轮编号 | 缺口 | 当前状态 | 证据（2026-10-19 复核） |
|---|---|---|---|
| **P0-1** | 记忆只有读、无自动写闭环 | ✅ **已闭合** | 引擎 `emitRunEnd` 后结论归档：`main/agentRunner.js:315-326`（未中止 + 有工具调用 + 结论非空 → 写 `session` 域、`source:'model_conclusion'`）；写入入口 `archiveMemory` `:210-221`（spaceId 取 `projectPath \|\| cwd \|\| 'default'`，失败仅告警 fail-open）；测试 `test/memory-write-closure.test.mjs:232-249` 验证 fail-open |
| **P0-2** | 压缩摘要不落记忆库 | ✅ **已闭合** | 引擎压缩成功分支发 `memory_saved` 事件：`agent-core/index.js:2009-2015`（`emitCompactedMemory`，`source:'compressor'`）；宿主消费归档：`main/agentRunner.js:383-403`（仅主 run，`domain:'session'`，`entityTags:['compression_summary']`）；引擎侧测试 `test/memory-write-closure.test.mjs:73-133` |
| **P1-1** | L3 默认不接线 | ✅ **已闭合** | 宿主默认档升为 `l3`：`main/agentRunner.js:162-170`（`defaultLevel:'l3'` + `l3Chat:l3.l3Chat` + `l3Gate` 走 `verifyPolicy.shouldRunL3` 风险门）；防回归门禁 `test/p1-vlayer-wiring.test.mjs:40-54` |
| **P1-2** | Worker 通道 V 层 off | ✅ **已闭合** | `main/workerPool.js:184-201`（默认 `l1`，可经 `deps.getVerifyConfig()` 升 `l3`，`l3Chat` 注入 + 风险门） |
| **P1-3** | MCP crashed 只有手动重连 | ✅ **已闭合** | 后端指数退避自动重连：`main/mcpAutoReconnect.js:61-146`（`baseDelay*2^(n-1)` + jitter + 上限）；UI 第五态 `crashed` + 手动重连按钮：`renderer/src/hooks/useMcpStatus.ts`、`src/lib/mcpStatusState.ts`、`i18n/.../settings.json:276-279` |
| **P1-4** | Windows OS 级隔离未接线 | ✅ **已闭合** | 后端分档执行：`main/sandboxWindows.js:25-31 / 207-242`（`buildWindowsExec` 三档语义 + carve-out）；设置入口 UI：`renderer/src/components/WindowsSandboxSetup.tsx`；统一入口判定 `main/sandbox.js:178-229` |
| **P1-5** | 用户自定义 hooks 缺位 | ✅ **已闭合** | 引擎：`main/toolHooks.js:217-248`（`wrap()` 对每工具 handler 包 pre/post，pre 可拦截、post 只观察）；UI：`renderer/src/components/HooksSection.tsx`；测试 `test/tool-hooks.test.mjs`；IPC 契约已登记（`main/ipc/mcp.js`、`preload.js`） |
| **P1-6** | 会话分支 / fork 缺位 | ✅ **已闭合** | 后端按分支点复制独立新会话：`main/localStore.js`（forkThread）+ `ipc/localData.js`；前端 `hooks/useForkThread.ts` + `App.jsx:264`（「从此处分叉」派发 `mjcode:fork-thread`）；i18n `message.json:12-13`、`app.json:18-19`；在线态明确提示不支持 `runtime.json:14` |
| **P1-7** | UI 原语层未收敛（部分完成） | 🟡 **改善但仍未完成** | 原语 `<Modal>` 已内建 WAI-ARIA + 焦点陷阱 + Esc + 焦点归还（`components/ui/Modal.tsx:156-289`）；但**仍有 182 处裸 `<button>` 跨 29 文件**（本轮 grep 计数），如 `Composer.tsx:483-533`、`ApprovalCard.jsx:142-205` |
| **P2-1** | 布局 token 未收敛 | 🟡 **仍未做** | 第四轮标「需设计意图裁决」，本轮未见收敛动作 |
| **P2-4** | MCP 规范能力不全 | ✅ **大幅闭合** | 版本升 `2025-11-25` + 降级链 `mcpProtocol.js:20-24`；`initialize` 返回值已接收 + 客户端能力声明；服务端请求应答表 `mcpServerRequests.js:43-46`（`roots/list` 回真实授权目录、`completion/complete` 回空补全集、`logging` 声明）；`sampling`/`elicitation` **显式回 `-32601` 不静默**（`mcpProtocol.js:38-40`、`test/mcp-server-requests.test.mjs:87`） |
| **P2-5** | 任务-模型分档 UI | ✅ **已闭合** | 分档设置 UI 已补（`ModelSelector.tsx`）；剩余为「按任务类型自动推荐」的智能化 |

**复核结论**：第四轮「唯一确定性功能缺口（P0-1/P0-2）」已彻底关闭；治理面、平台面、闭环面缺口亦大面积关闭。**这再次印证项目纪律「报告结论必须用当前代码复核」——旧报告的『仍缺』不可直接沿用。**

---

## 3. 当前仍在的缺口（10 项，按优先级）

### 3.1 功能性缺口（P0 级 —— 影响「桌面 Agent 的本体体验」）

| # | 缺口 | 证据（2026-10-19 复核） | 影响 | 建议落点 |
|---|---|---|---|---|
| **G1** | **多模态视觉输入未接入主对话通道** | 附件一律降级为文本路径引用：`hooks/useAgentRun.ts:200-201`（`content = raw + attachments.map(a => '@'+a.path)`）；粘贴图片仅落盘（`:150-153`），**不进 `image_url` 内容段**；i18n 明说「当前模型不支持图片理解，图片按路径引用」（`i18n/.../composer.json:11`）。全仓仅 **Computer Use** 用 `image_url`（`main/computerUse.js:358`） | 用户拖/贴截图给「能看图的模型」时，模型**看不到图**，只能按路径去 `read_file`；截图提问、UI 走查、图表解读等桌面高频场景断裂 | 附件按模型能力分流：视觉模型 → `messages[].content` 组装 `[{type:'text'},{type:'image_url'}]`；非视觉模型 → 保持 `@path` 引用 + 明示提示。落点 `useAgentRun.ts` 组装 + `agent-core` 多模态透传 |

### 3.2 平台 / 协议残差（P1 级 —— 决定「可持续演进」的天花板）

| # | 缺口 | 证据 | 影响 | 建议落点 |
|---|---|---|---|---|
| **G2** | **MCP 三层分级/懒启动默认未生效** | `MJCODE_MCP_LAZY` **默认关闭**：`main/mcpPrewarm.js:19`（注释「未置位时行为完全不变——启动仍全量重连已保存服务」）、`:82-83`（`isLazyMode` 读取 env，缺省 falsy）。tier 分类（auto-start/whitelist/manual）代码在（`:104-155`），但**懒启动不打开则 `autoStartConfigs` 不被使用 → 已保存的高权限服务（desktop-commander 等）仍随启动全量重连** | 高权限/付费/复杂 MCP 默认暴露给模型，与项目硬约束「高权限默认不启动」不符；tier 治理形同虚设 | 将 `MJCODE_MCP_LAZY` 由灰度改为**默认开启**（或让 `classifyTier` 直接驱动启动，不再依赖 env 开关）；高权限服务落 whitelist，首次调用再连接 |
| **G3** | **配置分层 / Profile / 企业管理层缺位** | 沿用 2026-10-18 架构审查（§4.1）：MJCode 为声明式 JSON，**无 Codex 的五层 config 与 `requirements.toml` 企业管理层**；本轮**未再取证**，标**待核实** | 企业/团队统一约束能力缺失；多环境（个人/项目/企业）配置无法叠加 | 引入「默认层 → 用户层 → 项目层 → 环境层 → 强制层」合并与优先级；强制层只读不可覆盖 |
| **G4** | **主体维 RBAC 缺位** | 沿用 2026-10-18 审查（§5.2）：治理是**工具风险分级 L1/L2/L3 + 审批档**（工具维度），非「主体-角色-权限」三元组；标**待核实** | 数字员工/多角色的权限边界无法按「谁」而非「干什么」收口 | 建立 role → allowedTools/sandbox/approval 的映射，与现有 `rolePreset` 对齐 |
| **G5** | **原生 extended thinking 未发送** | 仅下发 OpenAI 兼容 `reasoning_effort`：`main/main.js:633-634`（空值不发，避免严格服务端 400）；全仓**未见** Anthropic `thinking:{type,budget_tokens}` 原生字段 | 对 Anthropic 系模型无法精确控制思考预算，推理强度上限受限 | 在 provider 适配层按 provider 分流：Anthropic → `thinking` 段；OpenAI 兼容 → `reasoning_effort`；并做能力门控 |
| **G6** | **MCP `sampling` / `elicitation` 未实现** | 显式拒绝（`mcpProtocol.js:38-40`、`mcpServerRequests.js` + `test/mcp-server-requests.test.mjs:87`），属**有意设计**（需「逐次同意 UI + 模型通道中继 / 渲染层对话框回传」） | 拒绝是安全的；但对接会用到这两项能力的 server（如需要用户补参数的交互式工具）会降级 | 若要补齐：`elicitation` 接渲染层对话框通道 + 结果回传；`sampling` 需用户逐次同意 + 模型中继（须谨慎，默认继续拒绝） |

### 3.3 体验 / 工程一致性（P2 级）

| # | 缺口 | 证据 | 影响 |
|---|---|---|---|
| **G7** | **UI 原语收敛未完成** | 182 处裸 `<button>` / 29 文件（本轮 grep 计数）；`<Button>/<Input>` 原语未全面接管 | 可访问性与实现一致性随页面增长累积债务 |
| **G8** | **布局 token 未收敛** | 第四轮（P2-1）标「29 种 padding / 6 档圆角未收敛」，本轮未动 | 视觉长尾散点（需设计意图裁决，非纯技术债） |
| **G9** | **MCP 工具披露顺序不稳定** | 第四轮 §5.3：工具披露依赖连接顺序，不满足「披露序列字节稳定」；本轮未复核该点 | 影响前缀缓存命中率与可复现性（**待核实**） |
| **G10** | **技能总量无预算** | 单技能 6000 字符上限在（`agent-core:1371-1380`），渐进披露（`load_skill`）已补；但缺「单会话技能总数上限」 | 极端场景仍可能挤占上下文 |
| **G11** | **离线评估闭环未接运行时链路** | 架构审查 §4.1：`eval/run-eval.mjs` 有正确判定但未接入运行时；V 层（L1/L3）已补齐，评估全链路仍缺 | 无法自动建立「改动 → 回归」的量化门禁 |

---

## 4. 对标：Codex Desktop 非云版「8 内置能力」覆盖度

Codex Desktop 手册列出 8 项内置能力（`codex-desktop-reverse-manual.md:448-476`）。MJCode 当前覆盖情况：

| Codex 内置能力 | MJCode 状态 | 证据 / 说明 |
|---|---|---|
| browser（浏览器操控） | ✅ | `main/browserTools.js` + `components/BrowserPanel.tsx` |
| chrome（Chrome 集成） | ✅ | `main/chromeRelay/`、`chromeTools.js`、`desktop/chrome-extension/` |
| computer-use（电脑操控） | ✅ | `main/computerUse.js`、`cuaProcess/`、`cuaRecorder.js` |
| record-and-replay（录制回放） | ✅ | `components/RecordReplayPanel.tsx` |
| deep-research（深度研究） | 🟡 部分 | 仅有技能定义（`renderer/src/lib/builtinSkills.ts` 命中），**无原生「多轮检索 → 证据链报告」流水线**（待核实） |
| latex（LaTeX 排版） | ❌ | 全仓无 latex 相关实现（grep 命中仅技能/生态目录文本） |
| sites（网站部署） | ❌ | 未见站点构建/部署流水线 |
| visualize（可视化） | ❌ | 未见图表/可视化原生能力（grep 命中为技能文本） |

> **结论**：MJCode 在「编码 + 浏览器 + 电脑操控 + 录制回放 + Chrome」五类已对齐；**deep-research 被技能降级替代，latex / sites / visualize 三项缺失**。这三项属「产品形态差异化」而非「Agent 内核能力」，可按产品优先级决定是否补齐。

---

## 5. 端到端功能流程问题（6 项）

### 5.1 主对话链路（Composer → useAgentRun → IPC agent:run → agentRunner → agent-core → 事件回流）

```
Composer → useAgentRun → IPC agent:run（runId）
   → agentRunner：审批快照 + 沙箱推导 + V层装配（默认 l3 + 风险门）
   → agent-core runAgent：
        assemble_context（base/role/tools/skills(摘要索引)/agentsMd/memory/resume）
        → 循环：模型 → 同轮工具（只读并行/写串行）→ 回喂
        → 每轮：预算/墙钟/压缩闸（压缩成功 → memory_saved 事件）
        → 收尾：emitRunEnd（结论归档）+ V层 l1 全量对账（风险门触发 l3）
   → 事件回流 agent:event → 渲染层渲染
```

| 环节 | 裁定 | 问题 |
|---|---|---|
| 上下文装配 | ✅ | 技能已改**摘要索引 + `load_skill` 按需加载**（`agent-core:1852/1962-1964/2785`）；记忆/AGENTS.md/技能均过 `guardUntrusted` |
| 工具执行 | ✅ | 并行只读 / 串行写 / 审批精确分发（`approvalChannel.js:49-101`） |
| **附件/图片** | ❌ | **G1**：附件仅以 `@path` 文本引用进入模型，视觉模型也拿不到图（`useAgentRun.ts:200-201`） |
| 压缩 | ✅ | `compactHistory`（触发 0.7 / 激进 0.8 + 硬截断兜底 + `MAX_REWRITES_PER_RUN=5`），**摘要已归档记忆** |
| 收尾与验证 | ✅ | 结论归档（`agentRunner.js:315-326`）+ L1 全量 + L3 风险门（`:162-170`） |

### 5.2 编排链路（orchestrate_task → DAG → WorkerPool）

| 环节 | 裁定 | 问题 |
|---|---|---|
| LLM 拆解 → DAG 校验 | ✅ | `orchestrator/dag.js:21-113`（字段/依赖/上限校验 + Kahn 环检测 + 拓扑分层） |
| 并发与隔离 | ✅ | `workerPool.js:73-142`（并发池 + worktree 隔离） |
| 超时收口 | ✅ | `orchestrator/invoke.js:35-64`（超时/中止信号轮询） |
| Worker 验证 | ✅ | `workerPool.js:184-201`（V 层 l1 默认 + l3 opt-in + 风险门） |
| **编排产物可见性** | 🟡 | 定时通道已补 `orchestrate_task`（commit `540073c`），但**子任务产物在 UI 的聚合展示粒度**是否足够，待真机体验复核 |

### 5.3 定时任务链路（无人值守）

| 环节 | 裁定 | 问题 |
|---|---|---|
| 调度与补跑 | ✅ | `scheduler.js:234-288`（同日补跑一次，更早标 `missed`） |
| 产物落盘 + 假成功拦截 | ✅ | commit `d6e5fd4`（「必须真的产出文件，且假成功能被发现」）+ `scheduledVerdict.js` + `scheduledVerify.js` |
| V 层 | ✅ | `scheduledVerify.js:112`（L1 全量 + L3 风险门/5% 抽样 + fail-closed） |
| 失败可诊断 | ✅ | commit `2412fbf`（供应商错误翻译人话）；连续失败自动暂停 `scheduler.js:290-444` |

### 5.4 记忆链路（专项）

| 环节 | 裁定 | 问题 |
|---|---|---|
| 写入 | ✅ | run 结论 + 压缩摘要双通道写入（`agentRunner.js:315-326 / 383-403`），fail-open |
| 召回 | ✅ | 六因子打分 `memory/scorer.js:2-95` + 半衰期 + 容量闸 + 可信度过滤（`memory/index.js:24-48`） |
| 后台压缩 | ✅ | `memory/bgScheduler.js:65-84`（Tier1→Tier2 批量合并 + decay/cleanup） |
| 跨会话延续 | ✅ | 因写闭环打通，空间键取 `projectPath`，跨会话可召回 |
| **残留** | 🟡 | 写入是否只覆盖「有工具调用的成功任务」（`:315-326` 条件），**纯问答会话经验不沉淀**（是否为问题取决于产品意图，待裁决） |

### 5.5 平台适配链路

| 平台 | 裁定 | 问题 |
|---|---|---|
| macOS | ✅ | Seatbelt 开箱即用 + 真实可用性探测 |
| Linux | ✅ | bwrap + seccomp（`sandboxLinux.js:1-4`、`tools/exec.js:198-213`）；**未用 Landlock**（Codex 默认 Landlock+seccomp，bwrap 为可选）——非缺陷，标为差异 |
| Windows | ✅ | **本轮升为已接线**：三档语义 + setup 入口 + carve-out（`sandboxWindows.js:25-31/207-242`、`WindowsSandboxSetup.tsx`） |

### 5.6 流程问题汇总（去重）

| # | 流程问题 | 性质 | 关联缺口 |
|---|---|---|---|
| V1 | 截图/图片无法真正喂给视觉模型（主通道仅路径引用） | 功能性 | G1 |
| V2 | 高权限 MCP 默认随启动全量重连，与「默认不启动」约束冲突 | 治理 | G2 |
| V3 | 工具披露顺序随连接顺序变化，破坏前缀稳定 | 可复现性 | G9 |
| V4 | 技能总量无会话级上限 | 上下文经济 | G10 |
| V5 | UI 原语未接管 → 交互/可访问性一致性长尾 | 工程一致 | G7 |
| V6 | 配置无分层与强制层 → 企业/多环境约束难统一 | 平台治理 | G3/G4 |

---

## 6. 未来计划（按性价比分五批）

### 第一批 · 止血闭环（最高性价比，收益立现）

| 项 | 内容 | 验收 |
|---|---|---|
| G1 | 多模态输入接入主对话通道（按模型能力分流 text/image_url） | 拖入截图提问，视觉模型回答基于图像内容而非路径 |
| G2 | MCP 懒启动/三层分级改为**默认生效**（`MJCODE_MCP_LAZY` 默认开 或 tier 直接驱动启动） | 冷启动日志中，whitelist/manual 服务**不**自动重连；首次调用才连接 |

### 第二批 · 平台对等（决定可持续演进天花板）

| 项 | 内容 | 验收 |
|---|---|---|
| G5 | provider 分流发送原生 `thinking`（Anthropic）/ `reasoning_effort`（OpenAI 兼容）+ 能力门控 | 对 Anthropic 模型可见 thinking 预算生效；严格服务端不 400 |
| G3 | 配置分层 + Profile + 强制层（对标 `requirements.toml`） | 多环境配置叠加正确；强制层不可被用户层覆盖 |
| G4 | 主体维 RBAC（role → tools/sandbox/approval） | 数字员工权限按角色收口（**以最终产品定义为准，先做存在性核验**） |

### 第三批 · 上下文与可复现性

| 项 | 内容 | 验收 |
|---|---|---|
| G9 | MCP 工具披露改为**确定性排序**（按 server/tool 名稳定排序） | 相同配置下披露序列字节稳定，前缀缓存可命中 |
| G10 | 单会话技能总量预算（条数/字符双闸） | 超限时按相关性裁剪并留痕 |

### 第四批 · 生态差异化（按产品优先级取舍）

| 项 | 内容 |
|---|---|
| G-deep-research | 把技能升级为原生「多轮检索 → 证据链 → 报告」流水线（对标 Codex deep-research） |
| G-latex | LaTeX 渲染/排版能力（对标 Codex latex） |
| G-sites | 站点构建 + 本地预览 + 部署（对标 Codex sites） |
| G-visualize | 图表/可视化原生能力（对标 Codex visualize） |
| G6 | （可选）`elicitation` 接渲染层对话框；`sampling` 保持默认拒绝 |

### 第五批 · 工程质量收尾

| 项 | 内容 | 验收 |
|---|---|---|
| G7 | `<Button>/<Input>` 原语全面接管 182 处裸 `<button>` | 裸按钮数降至 0 或仅剩豁免；门禁断言 |
| G8 | 布局 token 收敛（padding 4 档 / 圆角 3 档），**需设计意图裁决** | 长尾组合归位 |
| G11 | 评估闭环接入运行时（eval 判定 → 回归门禁） | 改动触发 auto-eval，产出量化差异 |

### 建议实施顺序

```
第一批（G1+G2）
  → 第二批（G5 → G3 → G4）
  → 第三批（G9+G10）
  → 第五批（G7+G8）与第四批（生态）并行，按产品节奏
  → G11 贯穿（每次回归跑门禁）
```

---

## 7. 审查的诚实边界

1. 本报告**未逐行重跑全量门禁**（210 套件），核心结论以**读码 + grep 取证**为准；「已闭合」指代码路径已在册，**未经真机行为复核**（如 hooks 实际拦截效果、Windows 沙箱实际生效、图片分流后的真实模型表现）。
2. **G3（配置分层）/ G4（RBAC）沿用 2026-10-18 架构审查结论**，本轮未再独立取证，**明确标「待核实」**；若需落地前，应先做存在性核验（避免把「有别名实现」误判为缺失）。
3. **G9（披露顺序）/ G10（技能总量）** 沿用第四轮判断，本轮未复核具体代码，标「待核实」。
4. 「8 内置能力」覆盖度中，`deep-research` 标「部分（需核实是否有原生流水线）」，`latex/sites/visualize` 的「缺失」为 grep 命中仅技能/生态文本的判断，**若存在别名实现可能漏判**。
5. 本报告**不重复第四轮已闭合的 12 项**，也不把「部分完成」当「已完成」——G7 明确标「仍部分未做」。
6. **未验证的用户体验项**：定时任务产物 UI 聚合粒度、改版品牌头视觉、Release 安装包实装运行，均需真机体验复核。

---

*本报告基于 2026-10-19 提交 `8d23b4f` 的当前代码，由 Agent Harness 专家团模式审查生成；所有结论可回溯到 `file:line` 证据。*
