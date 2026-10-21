# 第八轮全量审查 · 角度 B —— 编排与认知层

> **审查范围**：团队层（MJ 军团）· 任务编排与 Worker 池 · 三层记忆体系 M0~M4 · 上下文工程 · 定时任务耦合面
> **SKILL_DIR**：`/Users/jianma/.workbuddy/plugins/cache/experts/agent-harness-expert/1.5.2/skills/agent-harness-architect`
> **主流判据锚点**：`/Users/jianma/Desktop/MJCode/docs/harness-r8/01-research/主流技术基线简报.md`（已读 §0 / 主线 4·5·6）
> **HEAD**：`24acc1531f55d70d8f591f0435d48eb114fbf3d0`（复核：`git rev-parse HEAD`）
> **口径声明**：本文所有数字均为**工作区**实测（未特别标注即工作区口径）；凡引用 HEAD 或文档声称值的，单独标注。
> **定位纪律**：禁用行号锚点，一律「文件 + 函数/常量名 + 复核命令」。

---

## §0 结论先行

### 本角度最严重的 3 个问题

| # | 一句话 | 严重度 |
|---|---|---|
| **B-01** | **军团成员的运行时配置（`model` / `toolNames` / `systemPrompt` / `approvalMode` / `sandboxPolicy` / `skillNames`）在 Worker 执行路径上完全不生效**——编制快照 `dag.roster` 只有 `.id`（偶尔 `.name`/`.roleKind`）被消费，权限是装饰性的、角色是标签、T5-7 的模型绑定落不了地。 | **P0** |
| **B-02** | **G2 三键预算（`max_rounds` / `max_tokens` / `max_wall_ms`）只进 prompt 文案与审计串，运行期零强制点**——`taskStore`/`workerPool` 全库无 `budget` 消费、无组级墙钟，「双终止条件」实际只有 per-task 超时一闸。 | **P0** |
| **B-03** | **团队层零端到端 eval**：相对 HEAD 新增的 11 个测试文件 100% 是单模块确定性单测（`team-*` / `worker-session` / `member-model` / `memory-team`），**没有任何一个触及 `runGroup` / `finalizeGroup`**——多智能体是在接缝处失败的，接缝处无守护。 | **P1** |

### 一句话整体判断

**形态上对齐 2026 主流收敛结论（确定性编排权威 + 一次性隔离子 Worker + 只回传压缩摘要，属 orchestrator-worker 而非 swarm/handoff 流水线），但「多角色」只存在于数据与 UI 层、不存在于运行时能力裁剪面——实质对齐、表达偏离，且偏离方向是「用户以为有闸、实际没有」这一最坏形态。**

**头条三判据速答**（完整论证见 §5）：

| 判据 | 结论 | 一句话理由 |
|---|---|---|
| **6.1 编排权威 / 隔离工作单元** | **⚠️ 形式偏离、实质对齐** | 确实存在 `team_send_message` 这一「子任务间直接发消息」的写通道，且 `approval.js` 按「他人可能已读取并据此行动」标 `reversible:false`；但该通道**当前无人读取**（B-04）——写入即终结，不驱动任何执行；共享看板 `team_board` 是**只读**投影，写由调度器单写者独占。故不构成真实 peer 协作。**风险在于治理标注按设计意图而非实际行为写成**，一旦补读通道（DB-03-A）即刻成立 |
| **6.2 类型化 schema + 两端校验** | **❌ 偏离** | 实测：`kind`/`toMemberId`/`summary` 有校验（非法被拒），身份不可伪造；但 **`payload` 完全无 schema**（深嵌套对象 / 字符串 / 数组全通过，而 schema 声明 object）、`refs` 与 `summary` 长度在 handler 层不校验（下沉到 `teamStore` 才生效）。**且根本没有接收端**——「两端校验」只有半端 |
| **6.8 能力裁剪 vs 三省六部** | **❌ 偏离** | 成员模型（`member.model`/`toolNames`/`systemPrompt`）**全部不参与运行时**（B-01），角色是纯标签；waves 是**确定性分批调度**（人数闸/类型闸/探活撤员），不是「部门间传文档」。所以：**没踩三省六部的执行形态，但也没做到能力裁剪**——落在两者之间的空档 |

补充两条同级判断：

- **与 orchestrator 的关系判定**：**复用，不重叠，无第二套编排实现**。`orchestrator.planGoal` 经 `planWaves` 钩子零侵入扩展，团队语义全部落在 `dag_json`（数据层）而非第二份调度代码——这是本角度做得最正确的一处架构决策。
- **`ipc/teams.js` 798 行，距 800 行软档仅 2 行**（`BASELINE_800` 白名单只有 `main/computerUse.js`、`main/main.js`、`agent-core/index.js` 三条）。**再增 3 行即撞自家门禁**，且它仍在持续承接新需求（`T5-6` 事件流、`T5-10` 中断、`T5-11` 重置都已塞进同一文件）。

---

## §1 团队层专项

### 1.1 模块现状表

| 模块 | 行数 | 状态 | 职责（源码自述） | 本轮审查结论 |
|---|---|---|---|---|
| `main/teamStore.js` | 723 | 工作区新增 | 编制持久化（`teams`/`team_members`）+ 消息总线（`team_messages`）+ 枚举 fail-closed 归一 + G4 体积闸 | 写得最扎实的一个（单一事实来源纪律贯彻到位）；但 723 行逼近黄线，且 `budget` 无下游消费者（B-02） |
| `main/ipc/teams.js` | **798** | 工作区新增 | `teams:*` IPC 域 ~15 个 handler + AI 草稿 + 派活链路 + 事件流 | **撞限在即**（B-06）；派活 handler 是全局唯一编排入口，也是全角度耦合最重的函数 |
| `main/teamWaves.js` | 295 | 工作区新增 | 纯策略层：wave 计划 / 人数闸 / 类型闸 / 探活器 | 纯函数 + 注入时钟，可测性好；但 `deferred` 语义在运行期被绕过（B-05） |
| `main/waveEngine.js` | 257 | 工作区新增 | wave 运行时：批次门控 + 5s×3 探活 + 撤员降级 | 撤员链路设计周密（两道防雪崩闸）；但并发降档是**全局**副作用（B-15） |
| `main/teamInterrupt.js` | 241 | 工作区新增 | 三主体中断权限矩阵 + 执行处置 + 审计留痕 | 矩阵逻辑完整，但 `lead`/`member` 两条分支**生产不可达**（B-07） |
| `main/teamTools.js` | 195 | 工作区新增 | 模型侧四原语：`team_list_members` / `team_send_message` / `team_board` / `team_wait` | 安全边界闭环做得好（from/runId 取自上下文、toMemberId 校验、kind 拒绝 system）；但**只有写没有读**（B-04） |
| `main/workerSession.js` | 89 | 工作区新增 | 成员会话键 `agent:{memberId}` + 断点读写 + 确定性指派 | 键位设计正确；指派算法与 wave 的 assignments 是两套口径（B-19） |
| `main/memory/team.js` | 93 | 工作区新增 | 团队记忆族：容量闸 / 专供召回 / 晋升候选 / 晋升通道 | 提名制（只列不写）符合 U5 定案；默认配置下整条链空转（B-12） |
| `main/memory/recall.js` | 167 | 工作区新增（拆分） | 召回族：分层召回 + 单层取行 + prompt 装配 | 三层配额齐全；但 Worker 路径未启用分层（B-11） |

### 1.2 派活（dispatch）全链路数据流

```
UI ──teams:dispatch──▶ ipc/teams.js
  ├─ dispatchGate(team)                      ← teamStore，「缺统筹」唯一判据
  ├─ normalizeBudget(team.budget)            ← 产出 budget（★ 此后无任何运行期消费者）
  ├─ store.updateTeam({defaultMode, budget}) ← 回写团队默认
  ├─ buildTeamContext(team,{mode,budget,memberIds})   ← 纯文本，注入 LLM 拆解提示
  └─ orchestrator.planGoal({
        contextBlock, planWaves: ({tasks}) => ({
          ...planTeamWaves({tasks, members: roster}),   // waves + assignments + activeMemberIds + deferredMembers
          roster: snapshotRoster(roster),               // 编制快照（含 systemPrompt/toolNames/model/...）
        })})
       ├─ validateDag(content)   ← dag.js：2~8 任务 / 依赖存在性 / Kahn 环检测
       ├─ topoLevels(tasks)      ← 拓扑分层
       └─ store.createGroup({ dag: {levels, waves, assignments, roster}, ... })
  ├─ postMessage({runId: groupId, kind:'assign', ...})   ← ★「团队↔run」唯一事实来源落点
  └─ workerPool.runGroup(groupId)  （不 await）

workerPool.pump
  ├─ waveAllowOf(group)                ← 批次门控（allowedTaskIds）
  ├─ preferredOwnerOf(group, task)     ← dag.assignments 查表
  └─ memberSession.pickOwnerMember(eligibleRoster(...), task)   ← 回落：task.seq % roster.length
workerPool.runWorkerTask
  ├─ sessionKey = memberSessionKey(group, task)   → `agent:{memberId}`
  ├─ resumeContext = memberSession.read(sessionKey)
  ├─ teamContext  = deps.resolveTeamContext(group, task)   ← findTeamByRun 反查
  ├─ runOpts.model = toAgentModel(deps.resolveModel())     ← ★ 全局模型，非成员模型
  ├─ runOpts.systemPrompt = 硬编码 Worker 人格               ← ★ 成员 systemPrompt 不注入
  └─ core.runAgent(runOpts) → result.summary → rememberTeamMemory → finalizeGroup
```

**三条真正的跨成员信息通道**（按实际生效排序）：
1. `buildTaskPrompt` 的 **`doneSiblings`**：同组所有 `done` 任务结论摘要，各 `slice(0, 300)` 字符注入下一个 Worker 的 user message；
2. **团队记忆**：`rememberTeamMemory` 写 `scope='team'`（受 `memory.autoCapture` 总闸，默认关）→ `recallTeamMemories` 读（共享 ∪ 自身私有，`topK:3`，各 `slice(0,200)`）；
3. **消息总线**：模型 `team_send_message` 写入 → **只流向 UI 时间轴与审计，不回流任何模型上下文**（B-04）。

### 1.3 与 orchestrator 的关系判定

**判定：复用（reuse），无重叠、无冲突、无第二实现。**

证据：

- `ipc/teams.js` 派活直接调 `deps.orchestrator.planGoal`，注释明示「不新起第二条编排实现——主管拆解(复用 planGoal) 是设计稿 §6 F2 的明确要求」。
- `orchestrator/index.js` 的 `planWaves` 钩子注释明示「编排器**不认识『团队』概念**（零侵入约束）」，团队语义只以回调返回值形式出现，最终原样落进 `dag_json`。
- 普通编排（不传 `planWaves`）行为完全不变；`waveEngine.attach` 仅在 `normalizeWaves(group)` 非空时触发，普通组「不装配任何东西」。
- DAG 校验/分层/重规划/失败暂停/聚合全部仍是 `orchestrator` + `taskStore` + `workerPool` 的既有实现，团队层未复制任何一份。

**唯一需要点名的张力**：`waveEngine.allowOf` 引入了一条与拓扑分层**并行**的入队门控（`allowedTaskIds`）。它不改变状态机（仍是 `taskStore.enqueueReady` 的 `allowIds` 参数），且失败时 `normalizeWaves` 返回 `null` 即退化为「不限制」——**fail-open 方向正确**（分批是加速与限流，不是正确性依赖）。可接受，但需在文档明确「wave 是调度提示而非依赖语义」，避免后人把它当依赖。

### 1.4 团队层「多角色编排」在 2026 主流范式里的位置

对照 `01-research/主流技术基线简报.md` 主线 6 的判据表（6.1~6.8）：

| 判据 | 结论 | 依据（文件 + 符号） |
|---|---|---|
| **6.1 单一编排权威 + 隔离工作单元** | **对齐** | 编排权威 = 确定性代码（`orchestrator.planGoal` + `workerPool.pump`）；工作单元 = 一次性 Worker，只回传 `result.summary`；`teamTools.js` 文件头明确「看板写必须保持**调度器单写者**」，无 agent 直写共享状态通道 |
| **6.2 typed payload + 两端校验** | **部分对齐** | `teamStore.appendMessage` 有 `MESSAGE_KINDS` 枚举、`normalizeRefs` 归一、G4 体积闸**fail-closed**（超限回落 refs-only，非尽力解析）；但 `payload` 是任意 JSON 无 schema，`toMemberId` 只校验「在本名册内」 |
| **6.3 每层三重上限（step/cost/wallclock）** | **偏离** | 见 B-02：`BUDGET_DEFAULTS`/`normalizeBudget` 无运行期消费者；实际生效的是 `runOpts.maxRounds=20` / `tokenBudget=200000`（固定值，非团队预算）+ per-task `timeoutMs`（无组级墙钟） |
| **6.4 交接载荷不是完整历史** | **对齐** | `doneSiblings` 各 `slice(0,300)`；`MESSAGE_SUMMARY_MAX=600` 字符；refs-only 回落。量级是 10² 而非 10⁴ |
| **6.5 派生深度硬上限** | **对齐** | 无子代理派生（单层 Worker）；`maybeAutoReplan` 的 `replan_depth>=1` 不再重规划 |
| **6.6 派生由确定性代码决定** | **对齐** | `teams:dispatch` → `planGoal` → `runGroup` 全确定性，模型无权派生子任务 |
| **6.7 端到端（系统级）eval** | **偏离** | 见 B-03：11 个新增测试 0 个触及 `runGroup`/`finalizeGroup` |
| **6.8 角色 = 能力裁剪，非三省六部** | **偏离** | 见 B-01：`roster.toolNames`/`systemPrompt`/`model` 全部不被运行时消费。角色目前是**贴标签**——既不是能力裁剪，也（幸好）不是真在跑文档流水线 |

**定位结论**：

- **拓扑 = Orchestrator-worker**（不是 supervisor 三级、不是 swarm 共享黑板、不是 sequential pipeline）。与简报所述「生产默认形态」一致。
- **但角色维度是空转的**：`LEAD_SYSTEM_PROMPT` 的文案（「把用户目标拆解…按成员能力指派…汇总」）是简报点名的**三省六部表述**，而实际干这活的是确定性编排器。所以：**实质不踩反模式（真编排者是代码，不是会互相传文档的部门），表达踩反模式（UI 用部门语言卖一个无裁剪能力的系统）**。
- **信息流不是 peer 聊天**：成员之间唯一的实质通道是「同组 done 结论摘要 + 团队记忆」，这恰恰是简报推荐的「编排层持有类型化上下文 + 外部状态文件」形态。**这一点比它自我描述的「消息总线协作」更主流。**

---

## §2 发现清单

### B-01 · 军团成员的运行时配置在 Worker 路径上完全不生效（P0）

**现状**：`ipc/teams.js` 的 `snapshotRoster` 把成员全量配置（含 `systemPrompt` / `toolNames` / `allowMcp` / `model` / `approvalMode` / `sandboxPolicy` / `skillNames`）随 `dag.roster` 落库；`workerPool.runWorkerTask` 组装 `runOpts` 时完全不读取这些字段。

**问题**：编制快照只有 `.id`（及个别处的 `.name`/`.roleKind`）被真正消费；权限、人格、模型三条产品线在团队派活链路上同时失效。

**证据**（命令 → 应得结果）：

```bash
# ① Worker 侧无 customSystemPrompt / customTools / 成员字段
grep -n "customSystemPrompt\|systemPrompt\|customTools" desktop/main/workerPool.js
# → 0 命中（runOpts.systemPrompt 是硬编码 Worker 人格串，非成员人格）

# ② dag.roster 的全部消费点，只用到 id/name/roleKind
grep -rn "dag\.roster\|dag?\.roster" desktop/main desktop/shared
# → main.js:resolveTeamRoster / resolveTeamContext（仅 .id 比对）
#   teamInterrupt.js:resolveRoster（.id/.name/.roleKind）
#   shared/teamStream.mjs（UI 展示）

# ③ 模型：Worker 用全局模型，不用成员绑定
grep -n "toAgentModel(deps.resolveModel())" desktop/main/workerPool.js
# → 命中 runOpts.model；对比主会话通道 agentRunner.js 的 rolePreset.model 分支（有 resolveModelRef 接线）

# ④ 审批/沙箱：取组快照，不取成员
grep -n "group.approval_mode\|groupSandboxPolicy" desktop/main/workerPool.js

# ⑤ Worker 侧 0 命中（与角度 A 独立复验一致）
grep -c "customSystemPrompt\|customTools\|rolePreset" desktop/main/workerPool.js   # → 0
```

**对照面（本条最关键的一击：同一份能力在两条链路上结论相反）**——主会话通道 `agentRunner.js` 的 `if (payload.rolePreset)` 分支**四项全接**：

```bash
grep -n "rolePreset" -A 4 desktop/main/agentRunner.js | grep -n "stricterApproval\|stricterSandbox\|resolveModelRef\|loadSkillContents"
# → stricterApproval(...) / stricterSandbox(...)（审批与沙箱取严）
#   toAgentModel(deps.resolveModelRef(payload.rolePreset.model))（per-agent 模型绑定）
#   deps.loadSkillContents(payload.rolePreset.skillNames)（starter_skills 注入）
```

且引擎侧 `agent-core/index.js` 的角色工具白名单**是真生效且 fail-closed**：

```bash
grep -n "rolePreset?.toolNames" -B 6 -A 16 desktop/agent-core/index.js
# → ② 角色子集：allowed = new Set(rolePreset.toolNames)
#   picked = effectiveBaseTools.filter(t => allowed.has(t.function?.name))
#   allTools = [...picked, ...mcpAllowed]
#   if (!picked.length) → 空交集收敛为空集（F-018：旧行为「保持全量」已修）
# → F-019：allowMcp 语义翻转为最小权限——只有显式 true 才保留全部 MCP，
#   缺省/false 一律让 MCP 也走同一份白名单
```

**影响**：
1. **权限是装饰性的**：给成员配 `toolNames: ['read','grep']`，实际拿到 `scheduledToolHandlers` 全量工具（含 `shell` / `writeFile` / `editFile` / `gitCommit` / `mcpCallTool` / `prReview`），且无人值守下 `runWriteTool` 被注入 `requireApproval:false`。这是**声明了限制却不执行**——比没有白名单更危险，因为用户会据此放松其它防线。
2. **T5-7 per-member 模型绑定落不了地**：`member-model.test.js`（55 处 `check`）测的是编解码与 `resolveModelRef`；`agentRunner.js` 主会话通道有接线，但**军团派活链路没有**。用户看到「已绑定 XX 模型」的标签，实际跑的是会话默认模型。
3. **角色人格不生效**：所有成员共用 `runOpts.systemPrompt` 那一段「你是 MJ Coder 的并行任务 Worker」。所谓「多角色军团」运行时是**同一个 Worker × N 份标签**。
4. 安全边界实际只剩**沙箱目录 + `stricterApproval(..., 'auto-safe')` 地板**，成员白名单零贡献。
5. **`allowMcp` 的最小权限语义同样落空**：引擎侧 F-019 已把 `rolePreset.allowMcp` 翻转为最小权限（缺省 `false` ⇒ MCP 也走白名单），`teamStore.normalizeMemberInput` 也用同款语义（`out.allowMcp = src.allowMcp === true`）——但成员的 `allowMcp` 同样不参与运行时，所以**一个显式关闭 MCP 的军团成员照样拿到 `mcpCallTool`**。这是与 F-019 完全同型、但未被修复的一处。

**归属**：本条由角度 B 持有并出完整证据链；角度 A（`agent-harness-architect`）已独立复验（`workerPool.js` 内 `customSystemPrompt` / `customTools` / `rolePreset` / `toolNames` / `skillNames` 均 0 命中）并确认**不在角度 A 另开一条**，避免主理人汇总时双份计。

**建议**：
- 最小止血（本轮可做）：把 `snapshotRoster` 中未生效字段在 UI 上标注「编制配置（下一 run 生效）」→ 但**这是错的**，因为它们**永远不会生效**；正确止血是**先禁用/标注为预览**，而不是让用户以为生效。
- 正确修复：在 `workerPool.runWorkerTask` 增加「成员运行时解析」——`resolveMemberRuntime(group, task)` 从 `dag.roster` 取成员，产出 `{ model?, toolNames?, systemPrompt?, approvalMode?, sandboxPolicy? }`，其中
  - `model`：`resolveModelRef(member.model, providers)` 成功则 `toAgentModel(resolved)`，失败回落（fail-open，与 `agentRunner` 同纪律）；
  - `toolNames`：作为**工具白名单**过滤 `handlers`（不是加工具，是减工具；未知名一律不出现——fail-closed 方向必须与 `mapToolAliases` 一致）；
  - `sandboxPolicy`/`approvalMode`：与组快照取**更严者**（复用 `stricterApproval`/`stricterSandbox`）；
  - `systemPrompt`：经 `runOpts.systemPrompt` 或新增 `appendSystemPrompt` 注入，与 Worker 人格串拼接。

**连带文件**：`desktop/main/workerPool.js`、`desktop/main/main.js`（`resolveTeamRoster` 旁新增 `resolveMemberRuntime`）、`desktop/main/modelShape.js`（复用 `resolveModelRef`）、`desktop/test/team-*.test.js`（补断言）。

---

### B-02 · G2 三键预算只进 prompt 与审计，运行期零强制点（P0）

**现状**：`teamStore.BUDGET_DEFAULTS = { max_rounds: 8, max_tokens: 200000, max_wall_ms: 30*60*1000 }`，`normalizeBudget` 归一后存 `teams.budget_json`，派活时取用。

**问题**：`budget` 的三个消费者全是「非强制」——① `buildTeamContext` 拼进 LLM 拆解提示词文本；② 派活消息的 `payload.budget`；③ `audit('team_dispatch', ...)` 字符串。**没有任何一处读它来终止运行**。

**证据**：

```bash
# 全库搜 budget 的运行期消费：taskStore / workerPool 零命中
grep -n "budget" desktop/main/orchestrator/index.js desktop/main/taskStore.js
# → 无输出

# 组级墙钟不存在
grep -n "wallClock\|wall_clock\|groupTimeout\|deadline" desktop/main/taskStore.js desktop/main/workerPool.js
# → 无输出（只有 per-task 的 task.timeoutMs 与 wait_deadline_at）

# max_wall_ms 的全部出现位置
grep -rn "max_wall_ms\|max_rounds\|max_tokens" desktop/main
# → 仅：teamStore.js（常量+归一）、ipc/teams.js（拼文案）、teamWaves.js（注释）、team-lead-dispatch.test.js（断言文案）
```

**影响**：
- 判据 6.3 偏离：`max_wall_ms` 是**唯一能防「一组跑一整天」的闸**，当前完全不存在——组级墙钟没有，只有 per-task `timeoutMs`（默认 `ORCHESTRATE_TASK_DEFAULT_MS`）。8 个任务串行重排，理论总时长 = 8 × per-task 上限。
- 用户在派活面板上看到「预算上限」四个字并填了值，会**据此判断风险**；这是「以为有闸、其实没有」的典型。
- `max_tokens` 名义 200000，实际 Worker 吃的是硬编码 `tokenBudget: 200000`——**数值巧合而非贯通**，一旦用户改团队预算，两者立刻分叉且无人告警。

**建议**：
- 最小集（推荐）：把 `budget` 落进 `createGroup` 的组字段（`group.budget_json`），在 `workerPool` 增加组级墙钟——`runGroup` 入口记 `startedAt`，`pump` 与 `finalizeGroup` 前判 `now - startedAt > budget.max_wall_ms` 则中止在役 run + 组置 `paused`（与 `maybePauseOnCritical` 同型，可复用）。`max_rounds` → 覆盖 `runOpts.maxRounds`；`max_tokens` → 覆盖 `runOpts.tokenBudget`。
- 若短期只做一件：**只做组级墙钟**（`max_wall_ms`），它是三者中唯一「没有兜底」的维度（rounds 有 `maxRounds=20`、tokens 有 `tokenBudget` 兜底）。

**连带文件**：`desktop/main/orchestrator/index.js`（`planGoal` 透传 budget）、`desktop/main/taskStore.js`（`createGroup` 加列/或 `dag` 内）、`desktop/main/workerPool.js`、`desktop/main/ipc/teams.js`。

---

### B-03 · 团队层零端到端 eval，接缝处无守护（P1）

**现状**：相对 HEAD 新增 11 个测试文件，全部团队层。

**问题**：全部是单模块确定性单测（`teamWaves` 的纯函数、`teamStore` 的 SQLite、`teamTools` 的假 store、`teamInterrupt` 的假 deps）。**没有任何一个触及 `runGroup` / `finalizeGroup`**，即没有任何测试覆盖「派活 → 拆解 → 批次门控 → Worker 执行 → 撤员 → 聚合收尾」这条链。

**证据**：

```bash
# ① 新增 11 个团队层测试文件（主理人已确认口径）
git status --porcelain | grep -E "test/(member-model|memory-team|team-)" 

# ② 没有任何一个触及 runGroup / finalizeGroup
grep -l "runGroup\|finalizeGroup" desktop/test/team-*.js desktop/test/team-*.mjs \
     desktop/test/member-model.test.js desktop/test/worker-session.test.js
# → 无输出

# ③ 断言规模（单测密度是够的，缺的是接缝）
for f in team-store team-waves team-message-bus team-tools team-interrupt team-lead-dispatch team-dag-wait worker-session member-model; do
  n=$(ls desktop/test/$f* | head -1); echo "$n -> $(grep -c 'check(' $n)"
done
# team-store 42 / team-waves 57 / team-message-bus 37 / team-tools 53
# team-interrupt 38 / team-lead-dispatch 36 / team-dag-wait 36 / worker-session 13 / member-model 55
```

**影响**：判据 6.7 偏离。团队层的失败恰恰发生在**接缝**——`waveEngine.consumeStall` 与 `runWorkerTask` 失败分支的**先后顺序**（源码注释自己写明「必须早于失败分支，否则撤员被当成超时失败，备用成员永远等不到重派」）就是一条只有端到端才能验证的不变量；`waitTask` 的 defer 分支同理。这两条都是**顺序敏感的不变量**，单测覆盖不到。

**建议**：补一个 `team-e2e.test.js`：假 `loadAgentCore`（`runAgent` 返回可控 summary / 可控挂起）+ 真 `taskStore` + 真 `TeamStore` + 真 `workerPool`，断言三件事：
1. 探活撤员后任务回到 `queued` 且 `ownerMemberId` 换成同类型备用（而非 `failed`）；
2. `team_wait` 登记后任务进 `waiting`，依赖完成后被重新排队（而非 `failed`）；
3. 组级预算（B-02 修好后）触达时组置 `paused` 而非继续跑。

**连带文件**：新增 `desktop/test/team-e2e.test.js`。

---

### B-04 · 消息总线是「模型只写、UI 只读」的单向通道，名实不符（P1）

**现状**：`teamStore.appendMessage` 写入总线；`teamTools.teamSendMessage` 是模型唯一写口；读取方是 `teams:listMessages`（渲染层）与 `teams:listThreadRuns`（对话卡片）。

**问题**：**模型侧没有任何读消息的工具**。`TEAM_TOOLS`（`agent-core/index.js`）只有 `team_list_members`（名册）/ `team_board`（任务投影）/ `team_send_message`（写）/ `team_wait`（等待）。因此：
- `MESSAGE_KINDS` 里的 `question` 是**无回执语义**——成员发出去，没有人能读到并回答；
- `handoff` 同理——交接是单向宣告，接收方看不到；
- `team_send_message` 的返回值只回 `messageId/seq/gated`，不发回任何他人消息。

**证据**：

```bash
# 模型侧四工具的唯一定义处
grep -n "export const TEAM_TOOLS" -A 2 desktop/agent-core/index.js
# → 四个 name：team_list_members / team_board / team_send_message / team_wait（无 read）

# 消息是否进入任何模型上下文：只在 UI IPC 与 shared 投影里
grep -rn "listMessages(\|listMessagesByRuns" desktop/main desktop/shared
# → ipc/teams.js（IPC）、teamStore.js（定义）、shared/teamStream.mjs（UI 投影）
#   → 无一处产出进 runOpts.messages / systemPrompt / buildTaskPrompt
```

**影响**：
- 功能上：`question`/`handoff` 两种 kind 是死语义（占 `MESSAGE_KINDS` 6 分之 2）。
- 认知上：整个「军团协同总线」的自我定位（§2 G4 / §5 表 3）与实际数据流向不符——真正的跨成员信息流是 `doneSiblings` + 团队记忆（§1.2），总线是**审计与 UI 轨迹**。这不算错（反而更主流），但命名与文档会误导后续开发者去「补强总线」而不是「补强结论通道」。
- 风险：模型会以为「发了消息对方就收到了」，从而把关键结论只放进 `summary`（600 字符闸，超限回落 refs-only，**payload 被丢弃**），而不写进 `result.summary`（后者才进 `doneSiblings`）。这是**结论丢失**的静默路径。

**建议**：二选一（见 DB-03）——
- **A（推荐）**：补 `team_read_messages`（只读、按 `afterSeq` 增量、条数与字符双闸），让 `question`/`handoff` 闭环；同时在 `TEAM_PROMPT_SECTION` 明确「结论必须写进你的最终 summary，总线消息只作过程留痕」。
- **B**：把总线降级为纯审计轨迹（源码注释已半承认这一点），从模型工具面**移除** `team_send_message`，避免模型把结论写进一个无人读的通道。

**连带文件**：`desktop/agent-core/index.js`（`TEAM_TOOLS` + `TEAM_PROMPT_SECTION`）、`desktop/main/teamTools.js`、`desktop/main/teamStore.js`、`desktop/shared/teamLabels.mjs`。

---

### B-05 · 类型闸 `deferred` 语义在运行期被绕过（P1）

**现状**：`teamWaves.selectActiveMembers` 按 `MAX_PER_TYPE_IN_RUN=2` 做同类型软闸，超出者进 `deferredMembers`（`reason:'typeCap'`）；`planWaves` 返回 `deferredMembers` 与 `activeMemberIds`。

**问题**：
1. `ipc/teams.js` 的 `planWaves` 回调只把 `waves` / `assignments` / `roster` 交给 orchestrator，`deferredMembers` 与 `activeMemberIds` **被丢弃**，既不落库也不上报——用户永远不知道「20 人里只有 10 人参与、其中 3 人被类型闸挡下」。
2. **更实质的问题**：`snapshotRoster(roster)` 用的是**全量 `roster`**（未被类型闸裁剪），而 `workerPool` 的回落指派 `memberSession.pickOwnerMember(eligibleRoster(groupId, roster), task)` 也从全量 roster 取模。所以**被 `typeCap` 挡下的成员在运行期照样会被指派任务**——类型闸只影响 wave 分批，不影响实际认领。

**证据**：

```bash
# ① deferredMembers 的产出与消费
grep -n "deferredMembers\|activeMemberIds" desktop/main/teamWaves.js desktop/main/ipc/teams.js
# → 产出在 planWaves 返回值；ipc/teams.js 中 orchestrator 只取 waves/assignments/roster（见 planGoal 的取值）

# ② 快照用全量 roster
grep -n "snapshotRoster" desktop/main/ipc/teams.js
# → roster: snapshotRoster(roster)   ← roster = team.members.filter(按 memberIds)，未经 selectActiveMembers

# ③ 运行期回落指派用全量 roster
grep -n "pickOwnerMember" desktop/main/workerPool.js desktop/main/workerSession.js
# → workerPool: memberSession.pickOwnerMember(eligibleRoster(g.group_id, roster), task)
#   eligibleRoster 只剔除 rt.retired（已撤员者），不剔除 typeCap 被挡者
```

**影响**：`MAX_PER_TYPE_IN_RUN` 的实际约束力弱于其声明（注释称「参与成员筛选：人数硬闸 + 同类型软闸」）；且 `deferred` 这个概念在系统里「产出了但不落地」，是典型的可观测性空洞。

**建议**：把 `activeMemberIds` / `deferredMembers` 一并落进 `dag_json`（与 `roster` 同级），并让 `resolveTeamRoster` 优先返回 `activeMemberIds` 子集（快照缺失时回落实时名册，与现有降级同纪律）。UI 侧把 deferred 人数显示在派活卡片上。

**连带文件**：`desktop/main/ipc/teams.js`、`desktop/main/orchestrator/index.js`（透传）、`desktop/main/main.js`（`resolveTeamRoster`）、`desktop/main/waveEngine.js`（`eligibleRoster`）。

---

### B-06 · `ipc/teams.js` 798 行，距 800 行软档 2 行；团队层新增面整体逼近黄线（P1）

**现状**：`main/ipc/teams.js` 798 行；`BASELINE_800` 白名单只有 3 条且不包含它。

**证据**：

```bash
wc -l desktop/main/ipc/teams.js          # → 798
sed -n '/^const BASELINE_800/,/^];/p' desktop/test/max-lines.test.js
# → ['main/computerUse.js', 'main/main.js', 'agent-core/index.js']
wc -l desktop/main/teamStore.js desktop/main/workerPool.js desktop/main/waveEngine.js
# → 723 / 788 / 257
```

**影响**：`teams.js` 再增 3 行即撞 `max-lines.test.js` 的「新文件超 800 行直接红」。而它仍在承接新需求（`T5-6` 事件流、`T5-10` 中断入口、`T5-11` 重置会话、`draftEmployee` 都在同一文件）。同层 `workerPool.js`（788）与 `teamStore.js`（723）也在黄线附近——**团队层三个核心文件同时逼近同一条线**，下一次需求迭代大概率同时引爆。

**建议**：按项目既有「先拆再合入」纪律，优先拆出两个域（见 DB-05）：
- `ipc/teamsDispatch.js`：`teams:dispatch` + `buildTeamContext` + `snapshotRoster` + `DISPATCH_ERRORS`；
- `ipc/teamsDraft.js`：`teams:draftMember` + `teams:draftEmployee` + `DRAFT_SYSTEM` / `EMPLOYEE_DRAFT_SYSTEM` / `extractJson`。
预计可降 ~180 行，留 3~4 个需求的余量。

**连带文件**：新增 2 个 IPC 域文件、`desktop/main/main.js`（`initTeamsIpc` → 分域 init）、`desktop/test/team-lead-dispatch.test.js`（含对 `mainSrc` 的源码级断言，需同步）。

---

### B-07 · 中断权限矩阵的 `lead`/`member` 分支生产不可达（P2）

**现状**：`teamInterrupt.checkInterruptPermit` 实现三主体矩阵（user 全权 / lead 可停他人但禁自我中止 / member 仅可停自己认领的任务），并配套 `REASON_REQUIRED`（lead 必须填理由）与 `NEED_CONFIRM`（L1 逐次确认，不允许同类豁免）。

**问题**：唯一的注入点把 `actorKind` **硬编码为 `'user'`**，因此 lead/member 两条分支在生产永远走不到；连带地 `reason`（`REASON_REQUIRED` 判据）与 `confirmed`（`NEED_CONFIRM` 判据）成为**惰性参数**——`teams:interrupt` IPC 传了 `confirmed`，但没人检查它。

**证据**：

```bash
grep -n "interruptTask" desktop/main/main.js
# → interruptTask: (p) => teamInterrupt.interruptTask({ ...p, actorKind: 'user' })

grep -n "actorKind === 'lead'" desktop/main/teamInterrupt.js
# → REASON_REQUIRED / NEED_CONFIRM 两处判据，前置条件恒不成立
```

**影响**：
- §9.2 的两条硬约束（「Lead 中断下属必须留理由」「L1 逐次确认不允许同类豁免」）**在当前产品形态下是死代码**。
- 安全上不构成洞（user 本就主权最高，`actorKind:'user'` 是 fail-closed 方向的硬编码）；但**治理承诺与实现不符**——文档与代码注释都宣称有这套矩阵，`team-interrupt.test.js` 的 38 处 `check` 里有一部分测的是不可达分支，给人「已验证」的错觉。
- 审计消息里 `actor` 字段恒为 `'user'`，未来真的接 lead 通道时，历史审计串语义会漂移。

**建议**：短期在 `teamInterrupt.js` 文件头加显式标注「lead/member 路径为预置策略，当前唯一入口 `main.js` 固定 `actorKind:'user'`；接线成员 run 审批通道时必须同时放开 `actorKind` 入参」；长期若确认不做模型侧中断，考虑把 `reason`/`confirmed` 从 IPC 契约里移除，或改为「用户中断也强制填理由」以复用既有留痕。

**连带文件**：`desktop/main/main.js`、`desktop/main/teamInterrupt.js`、`desktop/main/ipc/teams.js`。

---

### B-08 · 协作模式 `lead`/`select` 无任何运行期分支（P2）

**现状**：`TEAM_MODES = ['lead','select']`，派活时 `mode` 归一后存 `teams.default_mode`，并拼进 `buildTeamContext` 的提示词文本。

**问题**：全库 `main/` 下 `'select'` 只出现在 `TEAM_MODES` 定义与 `buildTeamContext` 的三元文案里，**没有任何一处 `if (mode === 'select')` 的运行时分支**。两种模式的行为完全由 LLM 对那句文案的理解决定。

**证据**：

```bash
grep -rn "'select'" desktop/main
# → teamStore.js: TEAM_MODES 定义
# → ipc/teams.js: buildTeamContext 的 `mode === 'select' ? 'select（成员按能力认领）' : ...`
# → browserProcess/registry.js 的 'select'（无关：浏览器动作名）
```

**影响**：模式是**提示词级开关**而非行为开关。这本身可接受（甚至符合「编排逻辑放确定性代码，模式只影响拆解提示」），但 UI 把「协作模式」做成用户可选项，用户会预期行为差异；实际差异取决于模型是否读那句话。属于**产品表达与实现强度不匹配**。

**建议**：要么在 UI 上把它标注为「拆解偏好（影响主管如何拆，不改执行机制）」，要么补一条确定性分支（`mode==='select'` 时跳过 `dag.assignments`，一律走 `pickOwnerMember` 被动认领）——后者成本低且能让模式名实相符。

**连带文件**：`desktop/main/ipc/teams.js`、`desktop/main/waveEngine.js`（`preferredOwnerOf`）。

---

### B-09 · `findTeamByRun` 走 `run_id` 单列过滤，索引左前缀不匹配 → 全表扫；每任务 4 次反查（P2）

**现状**：`teamStore.findTeamByRun` 用 `SELECT team_id FROM team_messages WHERE run_id = ? ORDER BY seq DESC LIMIT 1`，被声明为「团队↔run 的唯一事实来源」。

**问题**：唯一索引是 `idx_team_messages_bus ON team_messages(team_id, run_id, seq)`，最左列是 `team_id`。`WHERE run_id = ?` **用不上这个索引**，只能全表扫。而该函数在每个 Worker 任务上被调用 4 次。

**证据**：

```bash
# 索引定义
grep -n "idx_team_messages_bus" desktop/main/db/index.js
# → CREATE INDEX ... ON team_messages(team_id, run_id, seq)

# 查询形态
grep -n "WHERE run_id = ?\|WHERE run_id IN" desktop/main/teamStore.js
# → findTeamByRun（run_id = ?）、latestSeqForRun（MAX(seq) ... WHERE run_id = ?）、listMessagesByRuns（IN）

# 调用点（每个任务 4 次：上下文/名册/提示词/记忆）
grep -n "findTeamByRun" desktop/main/main.js
# → resolveTeamRoster / resolveTeamContext / buildTaskPrompt / rememberTeamMemory
```

**影响**：`team_messages` **没有容量闸**（对比 `memories` 有 `MAX_TEAM_MEMORIES=200`，见 B-14），长期运行的团队该表会持续增长；而每个子任务的 4 次反查都是 O(表行数)。加上探活每 5 秒对在跑组各调一次 `latestSeqForRun`（同样是 `WHERE run_id=?` 全扫），形成**每 5 秒 × 每组 × 全表扫**的固定负载。

**建议**：加一条 `CREATE INDEX IF NOT EXISTS idx_team_messages_run ON team_messages(run_id, seq)`（单点迁移，无行为变更）；并给 `team_messages` 加保留策略（见 B-14）。

**连带文件**：`desktop/main/db/index.js`、`desktop/main/teamStore.js`。

---

### B-10 · 编制快照把成员 `systemPrompt` 写进 `dag_json`，单组最大约 240 KB（P2）

**现状**：`snapshotRoster` 逐成员保存 `systemPrompt: String(m.systemPrompt || '')`；`SYSTEM_PROMPT_MAX = 12000`；`MAX_MEMBERS_PER_TEAM = 20`。

**证据**：

```bash
grep -n "SYSTEM_PROMPT_MAX\|MAX_MEMBERS_PER_TEAM" desktop/main/teamStore.js
# → 12000 / 20
grep -n "systemPrompt: String" desktop/main/ipc/teams.js   # snapshotRoster 内
```

**影响**：单组 `dag_json` 理论上限 = 20 × 12000 字符（UTF-8 中文约 3 字节/字）≈ 数十万字节，`task_groups` 每行都带这份 JSON。而 `getGroup` 在 `pump` / `runWorkerTask` / `buildTaskPrompt` / `finalizeGroup` 每次都读——**这份 240 KB 会被反复读出并 `JSON.parse`**。且快照里 6/8 的字段当前无人消费（B-01）。

**建议**：与 B-01 联动——快照只保留运行期真正需要的字段（`id`/`name`/`roleKind` + 若 B-01 采纳则补 `model`/`toolNames`/`systemPrompt`/`approvalMode`/`sandboxPolicy` 中的**会被消费的那些**）；`systemPrompt` 若确需，落库前 `slice` 到实际注入长度（与 `memberSession.read` 的 6000 上限对齐），而不是 12000。

**连带文件**：`desktop/main/ipc/teams.js`、`desktop/main/teamStore.js`。

---

### B-11 · 分层召回（M0）在 Worker / 团队运行时未启用（P2）

**现状**：`recall` 的分层模式由 `scopes` 数组触发；不传则走旧的单空间路径。

**问题**：主对话管理面（`ipc/localData.js`）传了 `scopes: [...SCOPES]`，走分层；**Worker 通道（`main.js` 的 `buildTaskPrompt`）没传** `scopes`，也没传 `conversationId`，因此走的是旧的「`space_id = ?` 全 scope 混排」路径。团队记忆是单独用 `recallTeamMemories` 补的，绕开了 `_recallLayered` 的跨层去重与配额。

**证据**：

```bash
# Worker 侧：无 scopes / 无 conversationId
grep -n "recallContents({" -A 4 desktop/main/main.js
# → { spaceId, query, topK: 3, domains: [...] }

# 主对话侧：有 scopes
grep -n "recallContents({" -A 4 desktop/main/ipc/localData.js
# → { spaceId, query, topK, scopes: [...SCOPES], conversationId }
```

**影响**：
- Worker 拿不到 `session` 层的会话工作记忆、也拿不到 `global` 层的跨项目资产（两者在旧路径里虽也在同 `space_id` 下被扫到，但**与 project 层混排、不按 `LAYER_QUOTA` 配额分配、不做跨层 `content_hash` 去重**）；
- `LAYER_QUOTA`（session 2 / team 3 / project 3 / global 2）这条「注入 10 条上限」的纪律在真正烧 token 的那条链路上不生效；
- 团队记忆走 `recallTeamMemories` 单独召回，与项目记忆**不做跨层去重**，同一条结论可能既以 project 层又以 team 层进入同一个 Worker 上下文。

**建议**：`buildTaskPrompt` 改用 `recallContents({ ..., scopes: [...SCOPES], conversationId: null, teamId, agentId })`——一次分层召回同时覆盖项目层与团队层（团队层已在 `SCOPES` 内），删掉单独的 `recallTeamMemories` 调用，去重与配额自动生效。

**连带文件**：`desktop/main/main.js`、`desktop/main/memory/recall.js`。

---

### B-12 · 团队记忆链在默认配置下空转（P2）

**现状**：`rememberTeamMemory` 三道闸的第一道是 `localStore.getPreference('memory.autoCapture')`（与主对话沉淀共用开关，注释明示「默认关」）。

**证据**：

```bash
grep -n "memory.autoCapture" desktop/main/main.js
# → if (!localStore?.getPreference('memory.autoCapture')) return;

grep -n "MAX_TEAM_MEMORIES\|recallTeamMemories\|listTeamPromotionCandidates" desktop/main/memory/team.js
# → 容量闸 200 / 专供召回 / 晋升候选 —— 全是读侧与维护侧
```

**影响**：`MAX_TEAM_MEMORIES=200` 容量闸、`PROMOTE_TEAM_MIN_HITS=3` 提名门槛、`recallTeamMemories` 召回、`promoteTeamMemoryToProject` 晋升——**整条团队记忆链在默认配置下什么都不写**，因此读侧全是空转。用户/开发者会以为「团队有记忆」，实际取决于一个与团队无关的总开关。

**建议**：给团队层一个独立的 `memory.teamAutoCapture`（默认仍关，但语义独立），并在派活面板/团队卡片上明示「团队记忆沉淀当前关闭，开启后成员结论会写入团队记忆」。否则把团队记忆的容量闸与晋升链标注为「待开关默认值确定后再验证」。

**连带文件**：`desktop/main/main.js`、`desktop/main/memory/team.js`。

---

### B-13 · 工具输出 offload 落到 `$TMPDIR`，会话内可失效且无清理（P2）

**现状**：`agent-core` 的 `summarizeToolOutput` 超 `TOOL_OUTPUT_SAVE_THRESHOLD=8000` 时折叠 PASS 行 + 头尾保留（`TOOL_OUTPUT_HEAD=2500` / `TOOL_OUTPUT_TAIL=3500`），原文写盘到 `${TMPDIR}/mjcode-tool-outputs/`，并把路径告诉模型供 `read_file` 取回。

**证据**：

```bash
grep -n "TOOL_OUTPUT_SAVE_THRESHOLD\|mjcode-tool-outputs\|TOOL_OUTPUT_HEAD\|TOOL_OUTPUT_TAIL" desktop/agent-core/index.js
grep -n "summarizeToolOutput(toolResult" desktop/agent-core/index.js   # 接线点：确认已启用
```

**影响**：分层压缩的**顺序是对的**（先 offload 再 summarize），判据 4.1 对齐。但落盘目录有两个问题：
1. **会话内可失效**：`$TMPDIR` 会被系统（macOS 定期清理 / 重启清空）回收。简报主线 4 反模式明确点名「offload 后又删掉/移动了落盘内容 → 比留在上下文里更糟」，`observation store 必须在整个会话生命周期内存在`。当前实现让 `read_file` 取回路径可能在会话中途变成 `ENOENT`，且模型无从区分「没有这个文件」和「路径写错」。
2. **无清理**：反向的磁盘泄漏——长会话/长任务反复落盘，永不删除。

**建议**：改为**会话/任务级目录**（如 `<userData>/tool-outputs/{conversationId or runId}/`），并在会话/组终态时清理；落盘失败或目录不可用时，在返回给模型的文案里明示「不可取回」而非只说「当前环境无法落盘」。

**连带文件**：`desktop/agent-core/index.js`、`desktop/main/main.js`（注入输出目录）。

---

### B-14 · `team_messages` 无容量闸、无 TTL（P2）

**现状**：`teams` 与 `team_members` 有 `enabled`/`removed_at` 软删；`memories` 有 `MAX_TEAM_MEMORIES=200` 团队层闸；**`team_messages` 既无条数闸也无保留期**。

**证据**：

```bash
grep -n "CREATE TABLE IF NOT EXISTS team_messages" -A 14 desktop/main/db/index.js
# → 无 deleted_at / 无 expire_at；只有 idx_team_messages_bus
grep -rn "MAX_TEAM_MESSAGES\|purgeTeamMessages\|DELETE FROM team_messages" desktop/main
# → 无命中
```

**影响**：旁路系统广播（`SYSTEM_RUN_ID=''`）在每次编制变更（`memberAdded`/`leadSet`/`memberSessionReset`/`teamArchived`…）都写一条，长期使用的团队会持续累积；叠加 B-09 的全表扫，形成**越用越慢**的退化曲线。团队记忆的设计理由是「团队是临时编制，不留无限增长的工作痕迹」，但同一理由没有应用到消息总线。

**建议**：加 `team_messages` 保留策略（按团队保留最近 N 条，或按 `created_at` 保留 30/90 天），在 `bgScheduler` 或 `teams:*` 写入侧做；同时补 B-09 的索引。

**连带文件**：`desktop/main/db/index.js`、`desktop/main/teamStore.js`、`desktop/main/memory/bgScheduler.js`（或新增清理点）。

---

### B-15 · 探活撤员的并发降档是全局副作用，且基线是模块级单变量（P3）

**现状**：`waveEngine.handleStall` 在首次撤员时 `setMaxConcurrent(Math.max(1, Math.floor(getMaxConcurrent()/2)))`，并在最后一个 wave 运行时 detach 时还原 `concurrencyBefore`。

**证据**：

```bash
grep -n "concurrencyBefore\|setMaxConcurrent" desktop/main/waveEngine.js
```

**影响**：
1. `setMaxConcurrent` 改的是**整个 Worker 池**的并发档——一个团队组停滞，会拖慢**所有并发 run**，包括与团队无关的普通编排组。注释里「本组是否已降过并发档」的措辞暗示是 per-group 语义，实际是全局。
2. `concurrencyBefore` 是**模块级单变量**（`let concurrencyBefore = null`），非 per-group。若组 A 先降档（记基线 4→2）、组 B 随后 detach 且此时 `runtimes.size === 0` 不成立…… 实际顺序是「`runtimes.size === 0` 才还原」，所以只有**最后一个组**结束时还原。但基线记的是**第一个降档组**看到的并发值；若期间用户手动改过并发档，还原会写回一个过期值。

**建议**：把「降档」改为 per-group 的**入队许可上限**（`waveEngine` 内记本组的 effective concurrency，`pump` 取 `min(global, groupEffective)`），不动全局档；基线也随之变成 per-group。

**连带文件**：`desktop/main/waveEngine.js`、`desktop/main/workerPool.js`（`setMaxConcurrent` 的调用语义）。

---

### B-16 · `teams:resetMemberSession` 同步循环最多 200 次 UPDATE，且降权不可逆（P3）

**现状**：该 handler 先清断点，再遍历最多 200 条成员私有记忆逐条 `updateMemory`（`importance = Math.min(0.2, cur*0.5)`）。

**证据**：

```bash
grep -n "resetMemberSession" -A 30 desktop/main/ipc/teams.js | grep -n "limit: 200\|updateMemory\|demoted"
```

**影响**：
1. **阻塞 IPC**：200 次同步 SQLite UPDATE 在主进程串行执行，期间 `teams:*` 域其它调用排队。记忆写入应异步（判据 5.5）。
2. **语义不可逆**：源码注释自己承认「importance 只由写入与本次降权改动，故这是**单向弱化**」。但「重置工作台」在 UI 上是可重复操作——点两次，该成员的历史结论权重被砍到 0.2 且无法恢复，而 `_enforceTeamCap` 的淘汰又是按 `updated_at` 最旧硬淘汰（不看 importance），所以降权后这些条目**既不优先被淘汰、也几乎不会被召回**，等价于软删除但没走删除路径（判据 5.4 的删除路径语义不清）。

**建议**：改为批量 UPDATE（一条 SQL，`UPDATE ... WHERE scope='team' AND team_id=? AND agent_id=?`），并把降权改为**可逆**：要么落一个 `demoted_at` 列供恢复，要么把操作在 UI 上二次确认为「不可撤销」，且明确它不等于删除。

**连带文件**：`desktop/main/ipc/teams.js`、`desktop/main/memory/team.js`（新增批量降权）、`desktop/main/db/index.js`（若加列）。

---

### B-17 · `scheduledTools.js` 的 `team_*` 条件展开与「登记矩阵扫字面量键」的耦合（P3）

**现状**：`scheduledToolHandlers` 用 `...(teamTools ? {...} : {})` 条件展开四个 `team_*` handler；注释说明「四个字面量键必须落在本文件，否则门禁看不见『有通道无 handler』」。

**证据**：

```bash
grep -n "teamTools ? {" -A 6 desktop/main/scheduledTools.js
# → teamListMembers / teamSendMessage / teamBoard / teamWait
grep -n "teamContext\|teamTools" desktop/main/main.js   # 生产注入点：仅 workerPool.createToolHandlers
```

**因果链（必须写死，否则后人会"修坏"它）**：这四个字面量键**不是偶然落在** `scheduledTools.js`，而是**为了让门禁能看见而不得不接受字面量**——

```bash
grep -n "为什么由本模块承载" -A 6 desktop/main/scheduledTools.js
# → 原文：登记矩阵的 handler 扫描区间 = main.js createToolHandlers + 本文件，
#   而 Worker 的工具工厂在 `agent:run` 之后（不在扫描区间内）——
#   因此四个字面量键必须落在本文件，否则门禁看不见「有通道无 handler」。
```

即：**扫描区间的边界决定了键的落点**；条件展开（`...(teamTools ? {...} : {})`）是在「让门禁看见」与「不让主会话工具面被污染」之间做的**有意取舍**，不是疏忽。

**⚠️ 反向风险（本条真正的价值）**：若后人为了让登记矩阵"更准"而**把条件展开改成无条件注册**，主会话与定时任务的模型就会看到四个永远调不通的 `team_*` 工具（handler 为 `null` ⇒ 调用必失败）。故建议：
1. 在 `scheduledTools.js` 的展开处加一行 `// 勿改为无条件注册：见角度 B B-17`；
2. 登记矩阵增加「条件展开键必须标注启用条件」的元信息字段，避免同类（computerUse / MCP 懒加载 / `LOAD_SKILL_TOOL`）被门禁静默判绿。

**与角度 A 的口径对齐**：角度 A 的 **A-03** 与本条是同一件事的两面，**定性已一致**——均为「**门禁方法论问题**」，而非「`scheduledTools` 的实现问题」；A-03 原文写明「当前不爆炸……一旦将来把 `teamContext` 接到交互式才爆」。**两边不需要任何一方修改结论**。

**`&& !customTools` 边界（与 A-07 同源，不另开条目）**：`TEAM_TOOLS` 的追加条件 `if (teamContext && !customTools)` 不是孤例，同款 `&& !customTools` 还有两处——`LOAD_SKILL_TOOL`（`skillDisclosureMode === 'summary' && !customTools`）与 `COMPUTER_USE_TOOL`（`computerUseEnabled && !customTools`）。准确表述是：**走 `customTools` 通道的 run，三个运行时追加工具（load_skill / computer_use / team_*）全部不可得**，这是一致的但**未在任何注释里声明**的边界。详见角度 A 的 **A-07**（连同「`BASE_TOOLS` 条数被 `test/web-todo-tools.test.js` 钉死」这一根因），此处直接引用，不重复开条。

**连带文件**：`desktop/main/scheduledTools.js`、`desktop/test/` 中登记矩阵相关测试（属角度 A 范围，此处仅记录耦合）。

---

### B-18 · 成员断点走 `checkpointStore` 的 50 条 LRU，「跨 run 复用」不保证（P3）

**现状**：`workerSession.save/read` 复用 `checkpointStore` 单例（同一存储、同一清理入口、同一 50 条 LRU）。

**证据**：

```bash
grep -n "checkpointStore\|50 " desktop/main/workerSession.js desktop/main/checkpointStore.js | head
```

**影响**：成员的跨 run 记忆（`resumeContext`，`slice(0,6000)`）与**主对话链路的三处断点**（预算熔断 / 超时 / 引擎退出）共享同一个 50 条 LRU。一个 20 人团队跑几轮，成员断点就会互相挤掉——§13.3「成员跨 run 复用」在规模下不成立。且淘汰是无差别的 LRU，不区分成员键与会话键。

**建议**：给 `agent:` 前缀的成员键单独一个 LRU 分域（或提高成员键的保留优先级），并在 `read` 未命中时留一条 warn 以便度量命中率。

**连带文件**：`desktop/main/workerSession.js`、`desktop/main/checkpointStore.js`。

---

### B-19 · 同一 run 内并存两套任务指派算法，可复现性打折（P3）

**现状**：`planWaves` 产出 `assignments`（批内轮转 `active[(wi+i) % active.length]`）；`workerSession.pickOwnerMember` 是回落算法（`task.seq % roster.length`）。

**证据**：

```bash
grep -n "assignments\[w.taskIds\[i\]\]\|(wi + i) % active.length" desktop/main/teamWaves.js
grep -n "task?.seq\|% list.length" desktop/main/workerSession.js
```

**影响**：一个 run 里，**被 `assignments` 覆盖的任务走轮转、未被覆盖的走取模**，两套算法并存。`waveEngine.preferredOwnerOf` 返回 `null` 时（无 assignment、或该成员已 `retired`）就落到取模。结果是「谁干了哪个任务」无法从单一规则推演，审计时只能查落库的 `owner_member_id`。这与 `pickOwnerMember` 注释自称的「重放同组同一任务必得同一成员」的可复现性目标有出入（两条路径各自确定性，但**合起来不是一条规则**）。

**建议**：统一为一条：`assignments` 缺失时也让 `planWaves` 补出完整指派（对未覆盖任务按同一轮转规则续排），使 `pickOwnerMember` 退化为「快照缺失的旧数据兜底」而非并行路径。

**连带文件**：`desktop/main/teamWaves.js`、`desktop/main/workerSession.js`、`desktop/main/workerPool.js`。

---

### B-20 · 子代理/团队结论回传「截断了但不可恢复」：`summarizeToolOutput` 的 offload 不覆盖 `result` 字段（P2）

**现状**：`agent-core` 的工具结果统一经 `truncateToolResult(await summarizeToolOutput(toolResult, tc.function.name))` 后进入上下文（`TOOL_RESULT_MAX_CHARS=15000`）。

**问题**：`summarizeToolOutput` 内部的 `pick()` **只识别 `stdout` / `content` 两个字符串字段**；`spawn_subagent` 的回传键是 **`result`**（`toolResult.result = subResult || '（子代理未产出结论）'`），因此：
- 长结论**不触发 offload**（不折叠、不头尾保留、**不落盘**）；
- 直接落到 `truncateToolResult` 的 15000 字符硬截（对对象结果逐字段裁剪）。

**证据**：

```bash
# ① offload 的字段白名单只有 stdout/content
grep -n "for (const f of \['stdout', 'content'\])" desktop/agent-core/index.js

# ② 子代理回传键是 result，且工具内不做任何截断
grep -n "result: subResult ||" desktop/agent-core/index.js

# ③ 截断是通用的、switch 之后无条件执行（所以「完全未截断」的说法不准确）
grep -n "truncateToolResult(await summarizeToolOutput" desktop/agent-core/index.js

# ④ 对比：shell 长输出走 offload（8000 阈值，落盘可 read_file 取回）
grep -n "TOOL_OUTPUT_SAVE_THRESHOLD\|mjcode-tool-outputs" desktop/agent-core/index.js
```

**影响**：
- 判据 6.4 **部分对齐**：量级上 15000 字符 ≈ 10⁴ 量级，高于主流建议的「1k–2k token 压缩摘要」；且**尾部不可按标识符取回**——对比 shell 输出（8000 阈值即落盘、可 `read_file` 回取），子代理结论是「截了就永久没了」。
- 这正好命中简报主线 4 的反模式「offload 后又删掉/移动了落盘内容 → 比留在上下文里更糟」的**邻侧变体**：不是内容被删，而是**从一开始就没落盘**。
- 与角度 A 的结论需要对齐：A 记为「子代理 `result: subResult` 原样进父上下文、只有 50k budget 闸」。精确表述应为——**有 15000 字符硬截（不是完全原样），但 `token_budget=50000` 闸的是子代理自身的生成预算、不是回传长度**，两者叠加后最坏形态是「子代理烧满 5 万 token 的产出，被截成 15000 字符进父上下文，且不可恢复」。

**建议**：把 `result` / `summary` 加进 `summarizeToolOutput` 的字段白名单（与 `stdout`/`content` 同级），让长结论同样走「PASS 折叠 → 头尾保留 → 原文落盘 → 可 `read_file` 取回」；并对 `spawn_subagent` 单独设一个**回传上限**（如 4000 字符）而非复用通用的 15000。

**连带文件**：`desktop/agent-core/index.js`（`summarizeToolOutput` 的 `pick` + `spawn_subagent` 回传）、`desktop/test/agent-engine.test.mjs`。

---

## §3 决策点

### DB-01 · 成员运行时配置是否落地到 Worker

| 方案 | 内容 | 代价 | 收益 |
|---|---|---|---|
| **A 全量落地** | `model` + `toolNames` 白名单 + `systemPrompt` + `approvalMode` + `sandboxPolicy` + `skillNames` 全部接入 `runWorkerTask` | 改动面最大（workerPool + main.js 注入 + 模型解析 + 技能装载）；需处理「成员工具白名单 vs 团队协同四工具」的相交规则 | 「多角色」名实相符；安全边界从「沙箱地板」升级为「沙箱 + 白名单」双闸 |
| **B 只落地安全相关（推荐第一步）** | 只落地 `toolNames`（白名单）+ `sandboxPolicy` + `approvalMode` + `model`；`systemPrompt` 人格暂不落 | 中等；人格仍是标签（需在 UI 标注） | 先消灭 P0 的**安全**部分（声明限制却不执行），模型绑定顺带落地；人格缺失只是产品表达问题 |
| **C 维持现状 + 改 UI 口径** | 不改运行时，UI 把工具/模型/沙箱标注为「编制记录（不参与执行）」 | 最小 | 消除误导，但「军团」的核心卖点（角色分工）实质取消 |

**推荐：B → A 分步。** 理由是 P0 的严重程度主要来自**安全方向**（用户以为限制了写权限，实际没限制），人格缺失是次级问题；B 能用较小改动消灭最坏形态。B 落地后，A 只剩 `systemPrompt` 与 `skillNames` 两项，可独立排期。

**采纳 B 后需连带改**：`desktop/main/workerPool.js`（新增成员运行时解析 + 白名单过滤）、`desktop/main/main.js`（`resolveTeamRoster` 旁新增 `resolveMemberRuntime`）、`desktop/main/modelShape.js`（复用 `resolveModelRef`，不改）、`desktop/main/ipc/teams.js`（`snapshotRoster` 字段收敛，与 DB-04 联动）、`desktop/test/`（新增成员运行时断言）。

---

### DB-02 · G2 预算的强制点放哪里

| 方案 | 内容 | 代价 | 收益 |
|---|---|---|---|
| **A 组级墙钟 + 覆盖 runOpts（推荐）** | `budget` 落进组；`workerPool` 加组级墙钟（超时 → 中止在役 run + 组 `paused`）；`max_rounds`/`max_tokens` 覆盖 `runOpts` | 中；需定义「组墙钟到期时已 done 的任务如何保留」（建议保留，与 `maybeAutoReplan` 同处理） | 三键全部兑现；组级墙钟是唯一无兜底的维度 |
| **B 只做组级墙钟** | 仅 `max_wall_ms` 强制，rounds/tokens 沿用引擎固定值 | 小 | 消灭最危险的缺口；但用户在面板改 `max_rounds` 仍无效（需 UI 标注） |
| **C 全部降级为提示词** | 承认预算只是「给拆解 LLM 的软约束」，UI 改称「拆解规模建议」 | 最小 | 诚实，但放弃了一条真实的安全阀 |

**推荐：A（若排期紧则先落 B）。** 关键是**不要选 C 而不改 UI**——现状等价于 C 但 UI 写的是「预算上限」。

**采纳 A 后需连带改**：`desktop/main/orchestrator/index.js`（`planGoal` 透传 `budget`）、`desktop/main/taskStore.js`（`createGroup` 存 budget）、`desktop/main/workerPool.js`（墙钟判定 + `runOpts` 覆盖）、`desktop/main/ipc/teams.js`（派活传 budget）、新增端到端断言（与 DB-03 合并）。

---

### DB-03 · 消息总线的定位

| 方案 | 内容 | 代价 | 收益 |
|---|---|---|---|
| **A 补 `team_read_messages`（推荐）** | 模型侧加只读工具：按 `afterSeq` 增量、条数闸（如 20）+ 字符闸（如 3000）、只回 `summary`+`refs` | 小（一个新工具 + 一个提示词段）；需防「模型反复拉取刷 token」 | 让 `question`/`handoff` 闭环；`team_send_message` 从「写进黑洞」变成「真通道」；坐实判据 6.2 的 typed payload |
| **B 降级为纯审计轨迹** | 从 `TEAM_TOOLS` 移除 `team_send_message`，总线只由宿主（生命周期/派活/中断）写 | 小；但会失去成员主动汇报能力 | 名实相符；消除「模型把结论写进无人读的通道」的丢失路径 |
| **C 维持现状** | 不动 | 零 | `question`/`handoff` 继续是死语义；结论丢失路径继续存在 |

**推荐：A。** B 也可以接受，但会削弱成员主动性；选 A 时**必须同时在 `TEAM_PROMPT_SECTION` 里写明「最终结论必须写进你的收尾 summary，总线消息只作过程留痕」**，否则 A 只是把丢失路径变宽。

**采纳 A 后需连带改**：`desktop/agent-core/index.js`（`TEAM_TOOLS` + `TEAM_PROMPT_SECTION`）、`desktop/main/teamTools.js`（新 handler）、`desktop/main/teamStore.js`（复用 `listMessages`，新增条数/字符双闸常量）、`desktop/test/team-tools.test.mjs`。

---

### DB-04 · 端到端 eval 的形态

| 方案 | 内容 | 代价 | 收益 |
|---|---|---|---|
| **A fixture 级 e2e（推荐）** | 假 `loadAgentCore`（可控 summary / 可控挂起 / 可控工具调用）+ 真 `taskStore` + 真 `TeamStore` + 真 `workerPool`，跑完整 `runGroup` → `finalizeGroup` | 中；需要可控时钟（波次探活已有 `startWaveProbe` 的注入时钟可复用） | 覆盖三条顺序敏感不变量（撤员 vs 失败分支、defer vs 失败分支、组收尾）；判据 6.7 对齐 |
| **B 真机 smoke** | 用真实模型跑一次团队派活 | 大（成本/时长/不稳定） | 最接近真实，但不可入 CI |
| **C 只补单测** | 把 `consumeStall`/`waitTask` 的分支顺序用单测钉住 | 小 | 只能钉住函数内部，钉不住「谁先被调用」 |

**推荐：A。** B-03 列出的三条不变量全是**调用顺序**问题，只有 A 能覆盖。

**采纳 A 后需连带改**：新增 `desktop/test/team-e2e.test.js`；可能需要给 `workerPool` 暴露一个测试用的 `deps` 装配入口（避免 `initWorkerPool` 全局单例耦合）。

---

### DB-05 · `ipc/teams.js` 撞限预案

| 方案 | 内容 | 代价 | 收益 |
|---|---|---|---|
| **A 拆 dispatch + draft 两域（推荐）** | 新增 `ipc/teamsDispatch.js` 与 `ipc/teamsDraft.js`，`teams.js` 保留 CRUD + 消息 + 事件流 + 中断 + 重置 | 中；需同步 `main.js` 的 init 与 `team-lead-dispatch.test.js` 里对 `mainSrc` 的源码级断言 | 降 ~180 行，留 3~4 个需求余量；两个新域职责内聚（派活 / AI 草稿） |
| **B 只拆 draft** | 只把两个 AI 草稿 handler + 两段 prompt 搬走 | 小（降 ~70 行） | 余量不足，下一个需求又撞 |
| **C 先不拆，靠评审卡行数** | 每次 PR 人工看行数 | 零 | 不可持续；门禁会红 |

**推荐：A。** 注意 `desktop/test/team-lead-dispatch.test.js` 有一条**对 `mainSrc` 的源码级断言**（`mainSrc.indexOf('group?.dag?.roster', rosterDecl)`），拆文件后必须同步更新，否则该断言会因找不到符号而空过或误红。

**采纳 A 后需连带改**：新增 2 文件、`desktop/main/main.js`、`desktop/test/team-lead-dispatch.test.js`、`desktop/test/max-lines.test.js`（若文件名进入扫描范围）。

---

### DB-06 · 工具输出 offload 的落盘位置

| 方案 | 内容 | 代价 | 收益 |
|---|---|---|---|
| **A 会话/任务级目录 + 终态清理（推荐）** | `<userData>/tool-outputs/{conversationId|runId}/`，会话/组终态清理 | 中；需传入目录、需定义清理时机 | 会话生命周期内可恢复（判据 4.3 的「可按标识符取回」真正成立）；无磁盘泄漏 |
| **B 保留 `$TMPDIR` + 会话内不清理** | 只补清理（退出时清） | 小 | 仍可能被系统清理 → 不可恢复 |
| **C 维持现状** | 不动 | 零 | 反模式风险保留 |

**推荐：A。**

**采纳 A 后需连带改**：`desktop/agent-core/index.js`（`summarizeToolOutput` 接收输出目录）、`desktop/main/main.js`（注入目录 + 清理钩子）、`desktop/test/agent-engine.test.mjs`（现有断言含 `mjcode-tool-outputs` 路径匹配，需同步）。

---

### DB-07 · 探活降档的作用域

| 方案 | 内容 | 代价 | 收益 |
|---|---|---|---|
| **A per-group 入队许可（推荐）** | `waveEngine` 内记本组 effective concurrency，`pump` 取 `min(global, groupEffective)` | 中；需改 `pump` 的并发判定 | 团队组问题不再外溢到普通编排组；基线变量 per-group 化，消除过期还原 |
| **B 保持全局降档但修基线** | 基线 per-group 化，仍改全局档 | 小 | 修掉过期还原；但「一组停滞拖慢所有 run」仍在 |
| **C 取消降档** | 只撤员，不动并发 | 最小 | 少了这道防雪崩闸 |

**推荐：A。** 全局副作用是设计缺陷而非取舍——「一个团队组停滞」与「整个应用的编排吞吐」之间不该有耦合。

**采纳 A 后需连带改**：`desktop/main/waveEngine.js`、`desktop/main/workerPool.js`（`pump` 的并发判定与 `setMaxConcurrent` 语义）。

---

## §4 数字基线

> 全部数字附取到它的命令；口径分「HEAD / 工作区 / 文档声称」。

### 4.1 仓库与门禁

| 项 | 值 | 命令 | 口径 |
|---|---|---|---|
| HEAD | `24acc1531f55d70d8f591f0435d48eb114fbf3d0` | `git rev-parse HEAD` | HEAD |
| 工作区改动文件数 | **100** | `git status --porcelain \| wc -l` | 工作区（主理人下发时记为 99；差值来自本轮 `01-research/`、`02-design/` 产出落盘，**同属工作区口径**，非代码改动） |
| 800 行软档白名单 | 3 条：`main/computerUse.js`、`main/main.js`、`agent-core/index.js` | `sed -n '/^const BASELINE_800/,/^];/p' desktop/test/max-lines.test.js` | 工作区 |
| `ipc/teams.js` 距软档 | **798 / 800（余 2 行）** | `wc -l desktop/main/ipc/teams.js` | 工作区 |
| eslint `max-lines` 豁免 | 待角度 A 复核（`desktop/eslint.config.mjs`，非仓库根） | `find . -maxdepth 2 -name "eslint.config.*"` | 工作区 |

### 4.2 团队层源码规模（工作区，`wc -l`）

| 文件 | 行数 | 相对 HEAD |
|---|---|---|
| `desktop/main/ipc/teams.js` | 798 | 新增（AM） |
| `desktop/main/teamStore.js` | 723 | 新增（AM） |
| `desktop/main/workerPool.js` | 788 | 改动（M） |
| `desktop/main/teamWaves.js` | 295 | 新增（AM） |
| `desktop/main/waveEngine.js` | 257 | 新增（AM） |
| `desktop/main/teamInterrupt.js` | 241 | 新增（A） |
| `desktop/main/teamTools.js` | 195 | 新增（A） |
| `desktop/main/workerSession.js` | 89 | 新增（A） |
| `desktop/main/memory/team.js` | 93 | 新增（A） |
| `desktop/main/memory/recall.js` | 167 | 新增（A） |
| **团队层合计（上表 8 个团队专属文件）** | **2 691** | 工作区 |

复核命令：`wc -l desktop/main/teamStore.js desktop/main/teamWaves.js desktop/main/teamInterrupt.js desktop/main/teamTools.js desktop/main/ipc/teams.js desktop/main/waveEngine.js desktop/main/workerSession.js desktop/main/memory/team.js`

### 4.3 团队层关键常量（工作区，源码声明值）

| 常量 | 值 | 位置 | 复核命令 |
|---|---|---|---|
| `MAX_MEMBERS_PER_TEAM` | 20（在册） | `teamStore.js` | `grep -n "MAX_MEMBERS_PER_TEAM =" desktop/main/teamStore.js` |
| `MAX_ACTIVE_MEMBERS` | 10（参与） | `teamWaves.js` | `grep -n "MAX_ACTIVE_MEMBERS =" desktop/main/teamWaves.js` |
| `MAX_PER_TYPE_IN_RUN` | 2 | `teamWaves.js` | 同上文件 |
| `MAX_WAVES` | 3 | `teamWaves.js` | 同上文件 |
| `MAX_REASSIGN_PER_TASK` | 1 | `teamWaves.js` | 同上文件 |
| `WAVE_PROBE_INTERVAL_MS` | 5000 | `teamWaves.js` | 同上文件 |
| `WAVE_PROBE_MAX_MISSES` | 3 | `teamWaves.js` | 同上文件 |
| `WAVE_PROBE_IDLE_MS` | 120000（2026-10-21 真机事故后新增） | `teamWaves.js` | 同上文件 |
| `MESSAGE_SUMMARY_MAX` | 600 字符 | `teamStore.js` | `grep -n "MESSAGE_SUMMARY_MAX\|MESSAGE_TOTAL_MAX\|MESSAGE_REFS_MAX\|MESSAGE_REF_MAX" desktop/main/teamStore.js` |
| `MESSAGE_TOTAL_MAX` | 4000 字节 | `teamStore.js` | 同上 |
| `MESSAGE_REFS_MAX` / `MESSAGE_REF_MAX` | 20 条 / 512 字符 | `teamStore.js` | 同上 |
| `MESSAGE_KINDS` | 6（`assign`/`handoff`/`question`/`report`/`artifact_ref`/`system`） | `teamStore.js` | `grep -n "const MESSAGE_KINDS" desktop/main/teamStore.js` |
| `MODEL_MESSAGE_KINDS` | 5（去掉 `system`） | `teamTools.js` | `grep -n "const MODEL_MESSAGE_KINDS" desktop/main/teamTools.js` |
| `SYSTEM_PROMPT_MAX` | 12000 | `teamStore.js` | `grep -n "SYSTEM_PROMPT_MAX =" desktop/main/teamStore.js` |
| `BUDGET_DEFAULTS` | `{max_rounds:8, max_tokens:200000, max_wall_ms:1800000}` | `teamStore.js` | `grep -n "BUDGET_DEFAULTS =" desktop/main/teamStore.js` |
| `BUDGET_LIMITS` | rounds[1,50] / tokens[1000,2e6] / wall[1s,24h] | `teamStore.js` | `grep -n "BUDGET_LIMITS" desktop/main/teamStore.js` |
| 预算运行期消费者 | **0** | — | `grep -n "budget" desktop/main/orchestrator/index.js desktop/main/taskStore.js` → 无输出 |
| 组级墙钟 | **不存在** | — | `grep -n "wallClock\|groupTimeout" desktop/main/taskStore.js desktop/main/workerPool.js` → 无输出 |

### 4.4 编排与 DAG

| 项 | 值 | 位置 / 命令 |
|---|---|---|
| `MAX_TASKS` / `MIN_TASKS` | 8 / 2 | `desktop/main/orchestrator/dag.js`，`grep -n "MAX_TASKS =\|MIN_TASKS =" ...` |
| `MAX_DEPS` | 4 | 同上 |
| `maxRetry` 上限 | 3 | `validateDag` 内 `Math.min(Math.max(...),3)` |
| DAG 校验项 | 结构 / 数量 / 字段 / 重复 id / prompt ≤8000 字符 / 自依赖 / 依赖存在性 / Kahn 环检测 | `desktop/main/orchestrator/dag.js` |
| 重规划深度上限 | 1（`replan_depth>=1` 不再自动重规划） | `desktop/main/orchestrator/index.js`，`maybeAutoReplan` |
| Worker `maxRounds` | 20 | `desktop/main/workerPool.js`，`runOpts` |
| Worker `tokenBudget` | 200000 | 同上 |
| per-task 墙钟 | `task.timeoutMs`（`ORCHESTRATE_TASK_MIN/DEFAULT/MAX_MS`，`main/tools/timeouts.js`） | `dag.js` 引用 |
| 硬轮次顶 | `AGENT_HARD_ROUND_CAP = 120` | `desktop/agent-core/index.js` |

### 4.5 记忆体系（M0~M4）

| 项 | 值 | 位置 / 命令 |
|---|---|---|
| `SCOPES` | `['session','team','project','global']`（顺序即层级，只允许向右晋升） | `memory/index.js`，`grep -n "const SCOPES" ...` |
| `LAYER_QUOTA` | `{session:2, team:3, project:3, global:2}`（合计 10） | 同上，`grep -n "LAYER_QUOTA =" ...` |
| `SOURCE_DEFAULT_SCOPE` | user_input→project；model_conclusion→session；compressor→project；external_content→session；legacy-import→project | 同上 |
| `SOURCE_TRUST` | user_input 1.0 / model_conclusion 0.6 / external_content 0.2 / compressor 0.6 / legacy-import 0.6 | 同上 |
| `TRUST_THRESHOLD` | 0.6 | 同上 |
| `MAX_MEMORIES_PER_SPACE` | 500 | 同上 |
| `MAX_GLOBAL_MEMORIES` | 300 | 同上 |
| `MAX_TEAM_MEMORIES` | 200 | 同上 |
| `INVALID_GRACE_MS` | 7 天 | 同上 |
| `RECALL_SCAN_LIMIT` / `RECALL_TOP_K_MAX` | 200 / 50 | 同上 |
| `SALVAGE_MIN_HITS` / `SALVAGE_MIN_TIER` | 3 / 3 | 同上 |
| `PROMOTE_L1_MIN_HITS` / `PROMOTE_L2_MIN_HITS` | 3 / 5 | 同上 |
| `PROMOTE_TEAM_MIN_HITS` | 3 | 同上 |
| `HALF_LIFE_DAYS_BY_SCOPE` | session 7 / team 30 / project 30 / global 90 | `memory/scorer.js`，`grep -n "HALF_LIFE_DAYS_BY_SCOPE" -A 6 ...` |
| `HALF_LIFE_DAYS_BY_DOMAIN` | session 7 / entity 30 / global_knowledge 30 / reflection 30 / private 30 | 同上 |
| 未知键回落半衰期 | 14 天 | 同上 |
| 打分权重 | relevance .40 / recency .20 / importance .20 / frequency .10 / tierBoost .10 | 同上，`WEIGHTS` |
| `TIER_BOOST` | 1→0.3 / 2→0.6 / 3→1.0 | 同上 |
| `recallForPrompt` 默认 `budgetChars` | 4000（**生产无调用点**） | `memory/recall.js`；`grep -rn "recallForPrompt" desktop/main` → 仅定义 |
| Worker 侧召回是否分层 | **否**（`main.js` 的 `recallContents` 未传 `scopes`） | `grep -n "recallContents({" -A 4 desktop/main/main.js` |
| 主对话侧召回是否分层 | 是（`ipc/localData.js` 传 `scopes: [...SCOPES]`） | `grep -n "recallContents({" -A 4 desktop/main/ipc/localData.js` |
| 团队记忆写入闸 | `memory.autoCapture`（与主对话共用，默认关） | `grep -n "memory.autoCapture" desktop/main/main.js` |
| 后台任务 | `compress` / `promote` / `promote-scope` / `decay` / `cleanup` + `purgeHistory` | `memory/bgScheduler.js`，`grep -n "promote:\|'promote-scope':\|decay:" ...` |
| 文件双通道 | 仅 `project`/`global` 落盘，`session` 不落；防抖 `DEFAULT_DEBOUNCE_MS` | `memory/memoryFile.js`，`onChange` |

### 4.6 上下文工程

| 项 | 值 | 位置 / 命令 |
|---|---|---|
| `TOOL_RESULT_MAX_CHARS` | 15000 | `agent-core/index.js`，`grep -n "TOOL_RESULT_MAX_CHARS =" ...` |
| `TOOL_OUTPUT_SAVE_THRESHOLD` | 8000（offload 触发） | 同上，`grep -n "TOOL_OUTPUT_SAVE_THRESHOLD =" ...` |
| `TOOL_OUTPUT_HEAD` / `TAIL` | 2500 / 3500 | 同上 |
| `PASS_COLLAPSE_RUN` | 20 | 同上 |
| offload 落盘目录 | `${TMPDIR}/mjcode-tool-outputs/`（无清理、无会话绑定） | 同上，`grep -n "mjcode-tool-outputs" ...` |
| `TOKEN_COMPACT_MIN_RATIO` | 0.35 | 同上，`grep -n "TOKEN_COMPACT_MIN_RATIO =" ...` |
| 上下文闸档位 | `new-window` / `compact` / `suspend-context` / `suspend-tokens` | 同上，`grep -n "suspend-context\|'new-window'" ...` |
| `AGENT_HARD_ROUND_CAP` | 120 | 同上 |
| 工具定义闸（唯一常量源） | `MAX_TOOL_DESCRIPTION_CHARS=2000`、`MAX_INPUT_SCHEMA_BYTES=20000`、`MAX_INPUT_SCHEMA_DEPTH=8`、`MAX_TOOL_SCHEMA_TOTAL_BYTES=65536`、`MAX_RESIDENT_MCP_SERVERS=8` | `shared/contextBudget.mjs` |
| 工具表强制档 | `MJCODE_TOOL_TABLE_ENFORCE`，缺省 `'warn'`（观测档，不阻断） | 同上，`toolTableEnforcement` |
| 稳定前缀 | `PROMPT_SECTIONS` + `enablePrefixOrder`（默认 true） | `agent-core/index.js` |
| 团队协同提示词段 | `TEAM_PROMPT_SECTION`（仅 `teamContext && !customTools` 时并入） | 同上，`grep -n "TEAM_PROMPT_SECTION" ...` |
| 成员回传长度 | 注入侧：断点 `slice(0,6000)`、done 结论 `slice(0,300)`、记忆 `slice(0,200)`；**落库侧 `result.summary` 无上限** | `workerSession.js` / `main.js` / `workerPool.js` |

### 4.7 测试覆盖（工作区）

| 文件 | 行数 | `check(` 数 |
|---|---|---|
| `desktop/test/team-waves.test.js` | 213 | 57 |
| `desktop/test/member-model.test.js` | 229 | 55 |
| `desktop/test/team-tools.test.mjs` | 298 | 53 |
| `desktop/test/team-store.test.js` | 145 | 42 |
| `desktop/test/team-interrupt.test.js` | 261 | 38 |
| `desktop/test/team-message-bus.test.js` | 142 | 37 |
| `desktop/test/team-lead-dispatch.test.js` | 139 | 36 |
| `desktop/test/team-dag-wait.test.js` | 186 | 36 |
| `desktop/test/worker-session.test.js` | 156 | 13 |
| `desktop/test/memory-team.test.mjs` | 142 | 0（断言形态不同，非 `check(`） |
| **触及 `runGroup`/`finalizeGroup` 的团队测试** | **0 个** | `grep -l "runGroup\|finalizeGroup" desktop/test/team-* desktop/test/member-model.test.js desktop/test/worker-session.test.js` → 无输出 |

复核命令：
```bash
for f in team-store team-waves team-message-bus team-tools team-interrupt team-lead-dispatch team-dag-wait worker-session member-model; do
  n=$(ls desktop/test/$f* | head -1); echo "$n -> $(wc -l < $n) 行 / $(grep -c 'check(' $n) check"
done
```

### 4.8 判据 6.2 实测：`team_send_message` 入参校验（工作区，探针直调）

> 探针：`/tmp/b02-probe.js`（**临时文件，不在仓库内**）。注入假 `getTeamStore` / `postMessage`，直调 `createTeamToolHandlers().teamSendMessage`。
> 口径：工作区源码实际行为（非文档声称）。

| 用例 | 入参 | 结果 | 判定 |
|---|---|---|---|
| A | 缺 `summary` | ❌ 拒：`summary 必填…` | ✅ 有校验 |
| B | `kind='SYSTEM_FREE_TEXT'` | ❌ 拒：`kind 非法…（可用：assign / handoff / question / report / artifact_ref）` | ✅ 有校验 |
| C | `kind='system'`（模型禁发） | ❌ 拒（同上） | ✅ 有校验 |
| D | `toMemberId='m-evil'`（不在名册） | ❌ 拒：`toMemberId 不在本团队名册内` | ✅ 有校验 |
| E | `payload` = 深嵌套对象（含 500 字符字符串） | ✅ **放行**，落库 `payload` 为 object | ❌ 无 schema |
| F | `payload` = 字符串（schema 声明 `object`） | ✅ **放行**，落库 `payload` 为 `string` | ❌ 无 schema |
| G | `payload` = 数组 | ✅ **放行**，落库 `payload` 为 `array` | ❌ 无 schema |
| H | `refs` = `['ok', 123, null, {}, 'y'×2000]` | ✅ 放行，**handler 层原样透传**（归一在下游 `teamStore.normalizeRefs`） | ⚠️ 分层不齐 |
| I | `summary` = `'S'×5000` | ✅ 放行，handler 层不截断（截断在 `teamStore.appendMessage`，`MESSAGE_SUMMARY_MAX=600`） | ⚠️ 分层不齐 |
| J | 伪造 `fromMemberId='m-lead'` | ✅ 放行但**被忽略**，落库 `fromMemberId='m-a'`（= `ctx.memberId`） | ✅ 身份不可伪造 |

**小结**：4/10 有校验（全部是枚举/存在性/必填），**3/10 载荷体完全无 schema**，2/10 校验下沉到 store 层，1/10 正确。判据 6.2「两端校验」的**接收端不存在**（B-04）。

### 4.9 数字口径报备

- **本表所有数字均为「工作区」实测**，未混入 HEAD 基线值；凡需对比 HEAD 的（如 `BASELINE_800` 清单本身）已单独标注。
- **本角度不使用** `TOOL_HANDLER_NAMES` / `TOOL_CHANNELS` / `BASE_TOOLS` 条数作为判据——那组数字属角度 A 范围，且 HEAD 与工作区口径会漂移（角度 A 实测：`TOOL_CHANNELS` HEAD=54 / 工作区=56）。本角度唯一引用的工具计数是 **§5 判据 6.5 里的 `BASE_TOOLS = 52`**，系本人工作区实测（`node --input-type=module -e "...BASE_TOOLS.map(t=>t.function.name)..."`），与角度 A 的工作区口径一致。
- 工作区改动文件数（§4.1）实测 **100**，主理人下发时记为 99——差值为本轮 `01-research/` 与 `02-design/` 产出陆续落盘所致，**同属工作区口径**，非代码改动，不影响任何判据。
- `ipc/teams.js` 本人实测 **798** 行（`wc -l`），主理人下发为 799——疑为末尾空行计数差异；结论不变（在 800 软档白名单之外，余量 2~3 行）。

---

## §5 团队层对齐 P0 判据 6.1 ~ 6.8 逐条判定表

> 判据原文：`docs/harness-r8/01-research/主流技术基线简报.md` · 主线 6「多智能体编排」· 对 MJCode 的可判定判据表。
> 图例：**✅ 对齐** / **⚠️ 部分对齐** / **❌ 偏离** / **N/A 不适用**。

| # | 判据（简写） | 结论 | 判定依据（文件 + 函数/常量 + 命令） | 关联发现 |
|---|---|---|---|---|
| **6.1** | 单一编排权威 + 一次性隔离子任务 + 只回传压缩结果；**若子任务间可直接互发消息/共改共享可变状态 → 偏离** | **⚠️ 形式偏离、实质对齐** | **对齐面**：编排权威是确定性代码——`ipc/teams.js` `teams:dispatch` → `orchestrator.planGoal` → `workerPool.runGroup`，模型无权派生；工作单元是一次性 Worker，只回传 `result.summary`；共享看板**只读**——`teamTools.projectTask` 只投影 6 个字段（无 `prompt`/`result`），写由调度器单写者独占（`teamTools.js` 文件头「看板写必须保持调度器单写者」）。<br>**偏离面**：确实存在子任务间发消息的写通道 `team_send_message`，且 `approval.js` 的 `team_send_message: { reversible: false }` 理由原文为「消息已进入团队总线，**其它成员可能已读取并据此行动**」。<br>**为何仍判实质对齐**：该通道当前**无人读取**（B-04）——`TEAM_TOOLS` 只有 list/board/send/wait 四个，无读消息工具；`grep -rn "listMessages(" desktop/main` 的产出只流向 `teams:listMessages`（IPC→渲染层）与 `shared/teamStream.mjs`（UI 投影），**不进任何 `runOpts.messages` / `systemPrompt` / `buildTaskPrompt`**。故写入即终结，不驱动任何执行。<br>**风险**：`reversible:false` 的标注是**按设计意图而非实际行为**写的；一旦采纳 DB-03-A（补 `team_read_messages`）该理由即刻成立，**这条判据会从 ⚠️ 翻转为 ❌**。 | B-04 |
| **6.2** | agent 间消息有**类型化 schema 且两端校验**（非法载荷被拒而非尽力解析） | **❌ 偏离** | **实测**（探针 `/tmp/b02-probe.js`，注入假 store/postMessage 直调 `createTeamToolHandlers().teamSendMessage`）：<br>· ❌ 拒：缺 `summary`、非法 `kind`、`kind='system'`（模型禁发）、`toMemberId` 不在名册 → 4/4 有校验<br>· ✅ 放行（**应为拒**）：`payload` 为深嵌套对象 / **字符串**（而 schema 声明 `object`）/ 数组 → **3/3 无 schema**<br>· ⚠️ `refs` 混入 `123 / null / {}` 与 2000 字符超长项：handler 层原样透传（`Array.isArray(args.refs) ? args.refs : []`），归一发生在下游 `teamStore.normalizeRefs`<br>· ⚠️ `summary` 5000 字符：handler 层不截断，截断在 `teamStore.appendMessage` 的 `trimStr(rawSummary, MESSAGE_SUMMARY_MAX=600)`<br>· ✅ `fromMemberId` 伪造为 `m-lead` 被忽略，落库仍为 `ctx.memberId`<br>**致命项**：判据要求「**两端**都校验」，而 MJCode **没有接收端**（B-04）——只有半端，且发送端的载荷体是自由格式。 | B-04 |
| **6.3** | 每一层都有 max-step / max-cost / max-wallclock 三重上限，触达时**确定性终止** | **❌ 偏离** | 引擎层有（`runOpts.maxRounds=20`、`tokenBudget=200000`、`task.timeoutMs`、`AGENT_HARD_ROUND_CAP=120`），但**团队层设的三键预算零强制点**：`grep -n "budget" desktop/main/orchestrator/index.js desktop/main/taskStore.js` → **无输出**；无组级墙钟（`grep -n "wallClock\|groupTimeout" ...` → 无输出）。`max_wall_ms` 三个去向全是文案：`buildTeamContext` 提示词串、派活消息 `payload.budget`、`audit('team_dispatch')` 字符串。 | **B-02 (P0)** |
| **6.4** | 交接载荷**不是完整历史**（有字段白名单或 token 上限，量级 10² 而非 10⁴） | **⚠️ 部分对齐** | **对齐面**：`buildTaskPrompt` 的 `doneSiblings` 每条 `slice(0,300)`；团队记忆每条 `slice(0,200)` × `topK:3`；成员断点 `slice(0,6000)`；总线 `MESSAGE_SUMMARY_MAX=600` 字符 + 超限回落 refs-only（`payload` 丢弃）。<br>**偏离面**：`spawn_subagent` 回传 `result: subResult` 仅受通用 `TOOL_RESULT_MAX_CHARS=15000` 硬截，且 `summarizeToolOutput` 的 `pick()` 只认 `stdout`/`content`、不认 `result` → **不 offload、不可回取**；子代理 `token_budget` 默认 50000 闸的是生成侧不是回传侧。最坏形态：5 万 token 的产出被截成 15000 字符进父上下文且永久丢失尾部。 | **B-20** |
| **6.5** | 交接/派生深度有**硬上限**且超限即失败（不是静默继续） | **✅ 对齐** | 三重结构性保证：① `SUBAGENT_TOOL_NAMES`（7 个只读工具）经 `BASE_TOOLS.filter` 得 `SUBAGENT_TOOLS`，**不含 `spawn_subagent`** → 子代理无法再派生，深度恒为 1；② Worker 的工具集 `scheduledToolHandlers` 不含 `spawn_subagent` 与 `orchestrate_task` → Worker 不可再派生；③ `maybeAutoReplan` 的 `replan_depth >= 1` 不再重规划。<br>实测：`node -e "...BASE_TOOLS.map(t=>t.function.name)"` → 52 个，含 `spawn_subagent`/`orchestrate_task`，**不含任何 `team_*`**。 | — |
| **6.6** | 「是否派生子任务」由**确定性代码**决定，模型不可自行无限派生 | **✅ 对齐** | 派活链路全确定性：`dispatchGate` → `planGoal`（`validateDag` 硬约束 2~8 任务）→ `runGroup`。模型侧唯一的「派生类」工具是 `spawn_subagent`（深度恒 1，见 6.5）与 `orchestrate_task`（审批 L2，产出仍受 `validateDag` 校验）。`team_*` 四工具中**没有任何一个能创建任务或派生成员**。 | — |
| **6.7** | 存在**端到端（系统级）eval**，而非只有 per-agent 单测 | **❌ 偏离** | 新增 11 个团队层测试文件 100% 单模块确定性单测；`grep -l "runGroup\|finalizeGroup" desktop/test/team-* desktop/test/member-model.test.js desktop/test/worker-session.test.js` → **无输出**。三条顺序敏感不变量（探活撤员 vs 失败分支、`team_wait` defer vs 失败分支、组收尾）无覆盖，而这三条在源码注释里都被标注为「顺序错了就会误判」。 | **B-03 (P1)** |
| **6.8** | 角色 = **能力裁剪与提示分工**（工具子集 + 角色提示注入 system），而非「让 agent 扮演公司部门互相评审」 | **❌ 偏离（落在两者之间的空档）** | **不是三省六部**：`teamWaves.planWaves` 是确定性分批调度（`MAX_ACTIVE_MEMBERS=10` 人数闸、`MAX_PER_TYPE_IN_RUN=2` 类型闸、`WAVE_PROBE_*` 探活撤员），成员之间**不传文档、不互相评审**；`teamTools` 甚至刻意不接控制层工具。真正的编排者是代码。<br>**但也不是能力裁剪**：`member.model` / `toolNames` / `systemPrompt` / `approvalMode` / `sandboxPolicy` / `skillNames` **全部不参与运行时**——`dag.roster` 的消费点只用到 `.id`（B-01）。所有成员共用 `runOpts.systemPrompt` 那一段硬编码 Worker 人格。<br>**waves 设计的归属**：waves 属**确定性调度优化**（分批 + 限流 + 防雪崩），与 6.8 的角色维度正交，判为**中性偏对齐**（它恰恰是「编排逻辑放 agent 之外的确定性代码里」这条主流纪律的落地）。<br>`member-model.test.js`（55 处 `check`）测的是引用串编解码与 `resolveModelRef`，**不覆盖「绑定是否生效」**——测试充分但测错了对象。 | **B-01 (P0)** |

### 5.1 三条既有隔离形态与 `team_*` 的关系（判据 6.1 的补充论证）

| 形态 | 工具集 | 派生深度 | 回传 | 与 `team_*` 的关系 |
|---|---|---|---|---|
| `spawn_subagent` | `SUBAGENT_TOOLS`（7 个只读，不含 `spawn_subagent`） | **结构性恒为 1** | `result` 字段（受通用 15000 硬截，不可 offload，见 B-20） | **正交**：主会话内的父子隔离；`team_*` 不在其工具集内，子代理看不到团队 |
| `orchestrate_task`（编排组） | `scheduledToolHandlers`（不含 `spawn_subagent`/`orchestrate_task`） | **不可再派生** | `aggregateGroup` 代码聚合 | **同一底座**：团队派活复用的就是它（`planGoal` + `runGroup`）；`team_*` 是**附加在 Worker 上的协作面**，不是另一套执行形态 |
| `team_*`（军团成员任务） | `scheduledToolHandlers` **+ 4 个 team 工具**（`teamContext && !customTools` 时追加） | 不可再派生 | `result.summary` → `doneSiblings` + 团队记忆 + 总线（总线不回流） | — |

**结论**：`team_*` **不是**第三种隔离形态，而是**挂在 `orchestrate_task` 底座上的一层协作/审计面**。它引入的唯一「新通道」是消息总线，而该总线当前是死通道（B-04）——这就是 6.1 判「形式偏离、实质对齐」的完整依据。

---

## §6 未覆盖与待确认（诚实标注）

1. **`compactHistory` 的摘要是否包含「目标 / 状态 / 约束 / 下一步」四项**（判据 4.2）：本轮未逐行读完 `compactHistory` 的提示词与落库形态，**不下结论**，标注待确认。
2. **记忆的删除路径**（判据 5.4）：`teams:resetMemberSession` 的「降权而非删除」已确认；但「给定用户/项目标识一次删除全部记忆（含派生索引）」是否有测试证明，本轮未验证。
3. **`_enforceTeamCap` 的淘汰是否影响团队记忆的晋升候选**：读侧与写侧的交互未做端到端验证。
4. **`eslint.config.mjs` 的 `max-lines` 豁免清单实际内容**：本轮未读到（文件在 `desktop/` 下而非仓库根，角度 A 已覆盖），不重复结论。
5. **渲染层（`TeamBoard.tsx` / `TeamDispatchPanel.tsx` / `TeamRunStream.tsx`）**：本角度只审主进程；UI 侧对「成员配置未生效」的呈现是否误导用户，需角度 C/UI 侧确认。
6. **主流性判断**：已全部对照 `01-research/主流技术基线简报.md`（§0 + 主线 4/5/6）给出，无二次推断；凡简报标为【二手】或「分化未决」的（如 D2 持久化机制、D5 记忆工业选型），本文未当作判据使用。

---

*产出文件：`/Users/jianma/Desktop/MJCode/docs/harness-r8/02-design/审查-角度B-编排与认知层.md`*
*发现 B-01 ~ B-20（20 条）· 决策点 DB-01 ~ DB-07（7 条）· 严重度：P0 2 / P1 4 / P2 9 / P3 5*
*§5 为团队层对齐 P0 判据 6.1~6.8 的逐条判定表（6.1 ⚠️ / 6.2 ❌ / 6.3 ❌ / 6.4 ⚠️ / 6.5 ✅ / 6.6 ✅ / 6.7 ❌ / 6.8 ❌）*
*判据 6.2 结论基于工作区源码实测（探针 `/tmp/b02-probe.js`，未落入仓库）*
