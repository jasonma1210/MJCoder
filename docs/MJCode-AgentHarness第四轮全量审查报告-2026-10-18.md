# MJCode Agent Harness 第四轮全量审查报告（2026-10-18）

> 审查角色：Agent Harness 专家团（执行安全 / 上下文经济 / 记忆体系 / 编排 / 协议 / 端到端流程）
> 方法论：**先读代码，再下结论**。凡本报告写「已确认」的，均有 grep / 读码证据；凡无法当场取证的，一律标「待核实」，不当成已证事实。
> 视角基线：**非云端 · 本地优先桌面 Agent**（对标 Codex App 非云版 / Trae Work 本地态 / WorkBuddy 本地态 / Lobster AI）。
> 范围：`desktop/`（Electron 主进程 + React 渲染层 + agent-core headless 引擎）、`ecosystem/`、`server/`（可选）。

---

## 0. 一句话结论

**执行面（引擎循环 / 沙箱 / 审批 / 凭证隔离 / 上下文压缩 / 成本防护）已达生产级，且明显强于「同类本地 Agent 的骨架阶段」；
但「治理面」与「闭环面」仍有 2 个确定性缺口：**

1. **记忆只有「读」闭环，没有「写」闭环** —— 引擎会召回记忆注入 prompt，但**没有任何自动写入路径**：一次任务/会话跑完，经验不会沉淀成记忆。这是当前最实质的 harness 缺口。
2. **上下文压缩与记忆体系互不相通** —— 压缩产出的结构化摘要只写回对话（system 消息），**不落记忆库**；下一轮可召回，但跨会话丢失。

其余为「平台适配 / 协议时效 / 交互一致性 / 规模化」四类二阶差距（贱在 Windows OS 级隔离未接线、用户自定义 hooks 缺位、会话分支缺位等）。

> 口径说明：2026-10-18 已完成 25 项整改（21 完成 / 2 部分 / 2 未做），本报告**不重复已修项**，
> 只列「**当前仍在**」的缺失与流程问题。所有「已具备」能力经代码复核确认在册。

---

## 1. 基线锚定（本报告数字的唯一口径）

| 项 | 值 | 取法 |
|---|---|---|
| 分支 | `fix/harness-full-2026-10-18` 后续主干 | `git log --oneline` |
| 引擎 | `agent-core/index.js`（2801 行，headless、零 Electron 依赖） | `wc -l` |
| 主进程模块 | `desktop/main/` 约 70 个 `.js` 模块 | `ls main/` |
| 记忆体系 | `main/memory/`（index / scorer / bgScheduler） | 读码 |
| V 层 | `agent-core/verifier.js` + `agent-core/verifierL3.js` + `main/verifyRun.js` + `main/scheduledVerify.js` | 读码 |
| 测试基线 | 158+ 套件全绿（2026-10-18 交付报告口径） | 交付报告 |

**H 框架层裁定（E/T/C/S/L/V + P）**：

| 层 | 裁定 | 依据 |
|---|---|---|
| **E 执行循环** | ✅ 完整 | 工具循环、失败回喂、轮次/Token/墙钟三闸、预算救援、撤回 |
| **T 工具注册** | ✅ 完整（授权侧）/ ⚠️ 部分（披露侧） | 内置 + MCP + 技能 + 角色裁剪；渐进披露已补 |
| **C 上下文管理** | 🟡 基本完整 | LLM 摘要 + 硬截断兜底 + 重写记账；**缺：摘要不落记忆、前缀仍非全稳** |
| **S 状态存储** | 🟡 基本完整 | SQLite 落盘、断点续跑、checkpoint；**缺：会话分支/fork** |
| **L 生命周期钩子** | ✅ 完整（安全）/ ❌ 扩展性为零 | 审批/审计齐备；**缺：用户自定义 hooks** |
| **V 评估接口** | 🟡 能力就绪 / 默认 l1 | L1 全量、L3 默认不接线；定时通道已接、Worker off |
| **P 范式四维** | ✅ 基本达标 | 本地优先、数据/执行不出机、显式 opt-in 放飞 |

---

## 2. 已具备能力盘点（防止把「已做」当「缺失」）

以下能力**经代码复核确认在册**，本报告后续不再重复列入缺失：

- **执行循环**：模型→工具→回喂循环；`maxRounds` 硬顶；同轮只读工具并行（上限 4，写/MCP/审批串行）；失败回喂不吞异常。
- **三道安全闸**：L1 危险命令 / L2 文件写入 / L3 MCP 工具分级审批；拒绝可绕过；`stricterApproval` / `stricterSandbox` 唯一事实来源。
- **沙箱分档**：`read-only` / `workspace-write` / `full-access`；macOS Seatbelt + Linux bwrap（OS 级）；Windows 命令级；`.git` / `.mjcode` 只读 carve-out；fail-closed。
- **上下文经济**：`compactHistory`（LLM 摘要 + 四段式 + 硬截断兜底 + `MAX_REWRITES_PER_RUN`）；`budgetDecision`；窗口映射 `(provider, modelId)` 二元组双表 + Ollama 探测；真实回传反推窗口（只抬不降，上限 4×）。
- **成本防护**：轮次闸 + Token 预算闸 + **整任务墙钟 30min** + 压缩救援上限。
- **记忆体系**：五域（private/session/global_knowledge/entity/reflection）× 四层 Tier；来源可信度分级；hash 去重；分域半衰期衰减；容量总闸；`recall` 六因子打分 + Top-K 钳制。
- **编排**：LLM 拆解 → DAG 校验（环检测/拓扑分层）→ SQLite 状态机断点续跑 → 信号量并发池 → git worktree 隔离 → 结果聚合（冲突检测）。
- **子代理**：`spawn_subagent` 生命周期事件透出。
- **V 层**：L1 确定性对账（R1–R6 规则，零依赖零网络）；L3 独立评审（能力就绪、默认不接线）；定时任务通道已接（风险门 + 5% 抽样 + fail-closed）。
- **MCP**：协议升 `2025-11-25`、能力协商、`onNotify`、翻页、工具名清洗、404 会话重建、凭证 0600。
- **技能**：渐进式披露（索引 name+description + `load_skill` 按需加载正文）、注入检测。
- **数字员工**：实体化（create/update/delete）+ RBAC + 路径穿越拦截 + 注入检测。
- **生态与产品面**：定时任务、Computer Use（AX 结构化驱动）、协同（Yjs）、数据看板、换肤、自动更新、i18n（0 硬编码）。
- **UI 原语**：`Switch/Modal/Button/Input` 四原语；8/9 模态换壳；焦点陷阱/Esc/焦点归还。

---

## 3. 缺失清单（按优先级，全部标注证据）

### 3.1 P0 —— 不改则能力闭环不成立

| # | 缺失 | 证据（本次复核） | 影响 | 建议落点 |
|---|---|---|---|---|
| **P0-1** | **记忆只有读、无自动写闭环** | 全仓 `remember(` 调用点仅 4 处：`memory/index.js`（内部 compress/import）、`ipc/localData.js:385`（legacy 导入）、`:411`（**用户显式 /mem**）。**引擎侧零写入**：`agent-core/index.js` 只 `recallContents` 注入（`main.js:1147` → `agent-core:1806`），无任何 run 结束写记忆路径 | 一次任务的经验无法沉淀；「记忆体系」实为只读缓存，跨任务学习不成立 | 新增 run 收尾钩子：`emitRunEnd` 后把「任务结论 + 验证结果 + 关键路径」经 `MemoryManager.remember` 落库（`source: model_conclusion`），写入走 `_serialized` 串行 |
| **P0-2** | **压缩摘要不落记忆库** | 全仓 grep `MemorySaved` / `auto_compact` / `compression_summary` **命中 0**；`compactHistory` 只 `return next`（写回对话），无持久化 | 压缩产生的结构化摘要（已完成/关键发现/待办/约束）**跨会话即丢**；下一轮可召回，新会话归零 | 在压缩成功分支（`agent-core/index.js` 摘要产出后）发 `memory_saved` 事件 → 主进程 sink 落 `MemoryManager`（`domain: session` / `source: compressor`），对齐 skill 的「压缩摘要自动持久化」范式 |

> P0-1 / P0-2 是同一根因的两面：**压缩层与记忆层各自独立，没有「产出物自动归档」的通道**。
> `agent-safety-compression` 三件套中的「记忆自动持久化」在本项目**未落地**——沙箱接入与 LLM 压缩已落地。

### 3.2 P1 —— 特定条件下故障 / 明确体验损失

| # | 缺失 / 问题 | 证据 | 影响 |
|---|---|---|---|
| **P1-1** | **L3（独立 verifier turn）默认不接线** | `verifyRun` 的 `l3Chat` 默认 `null`，无注入即降级 `skipped`；`agentRunner.js` 未注入 | 「怎么知道做对了」只到 L1（对账），语义级正确性无独立复核 |
| **P1-2** | **Worker 通道 V 层 `off`** | 交付报告：Worker `off` 已接线 | 子任务（编排产出）无验证，只靠 L1 主任务兜底 |
| **P1-3** | **MCP `crashed` 态只有手动重连** | 交付报告已知项；仅 `mcp:reconnect` 一条通道 | 子进程崩溃后所有工具静默失效，用户须自己发现并手点 |
| **P1-4** | **Windows OS 级隔离未接线** | README 自述：`sandboxWindows.js` 后端存在但**无入口执行管理员设置** | Windows 用户实际只有命令级守卫，非对等隔离（README 已如实标注） |
| **P1-5** | **用户自定义生命周期 hooks 缺位** | 全仓 grep `hooks.json` / `preToolUse` / `PostToolUse` **命中 0** | L 层扩展性为零：用户无法在工具前后注入自定义脚本/校验（Codex/主流 Agent 的常见能力） |
| **P1-6** | **会话分支 / fork 缺位** | 全仓 grep `forkThread` / `branchThread` **命中 0** | 无法「从某个历史点开分支重跑」，长任务试错只能重开 |
| **P1-7** | **UI 原语层未收敛**（部分完成） | 原语 4 个已建，但仍有大量裸 `<button>`、`h-1 魔法数`；`feedback.jsx` confirm 自绘 | 工程一致性债：可访问性缺口与逐处重复实现随页面增长累积 |

### 3.3 P2 —— 体验 / 效率 / 规模化

| # | 缺失 / 问题 | 证据 | 影响 |
|---|---|---|---|
| **P2-1** | **布局 token 未收敛** | 交付报告：`29 种 padding / 6 档圆角`未收敛（P2-5 未做） | 视觉长尾散点，需设计意图裁决（非纯技术债） |
| **P2-2** | **首字节延迟无 SLO 收敛** | 已有 `ttfbMs` 可观测 + `slow_ttfb` 告警（3000ms 只告警） | 缺端到端目标值与回归门禁 |
| **P2-3** | **技能总量无预算** | 单技能 6000 字符上限存在，但渐进披露后仍缺「单会话技能总数上限」 | 极端场景下仍可能挤占上下文 |
| **P2-4** | **MCP 规范能力仍不全** | 已补 resources/取消/进度部分；`sampling` / `roots` / `elicitation` / `completion` / `logging` / `ping` 仍未齐 | 与官方 2025-11-25 全能力对齐有残差 |
| **P2-5** | **任务-模型分档 UI** | 数据层与三槽位已就绪，分档设置 UI 已补（交付报告 P1-11c ✅） | 基本闭环，剩余为「按任务类型自动推荐」的智能化 |

---

## 4. 功能流程问题（端到端链路逐环节）

### 4.1 主对话链路（渲染层 → 主进程引擎 → 工具 → 回喂 → 收尾）

```
Composer → useAgentRun → IPC agent:run（runId）
   → agentRunner：审批快照 + 沙箱推导 + V层装配（l1）
   → agent-core runAgent：
        assemble_context（base/role/tools/skills/agentsMd/memory/resume）
        → 循环：模型 → 同轮工具（只读并行/写串行）→ 回喂
        → 每轮：预算/墙钟/压缩闸
        → 收尾：emitRunEnd + V层 l1 对账
   → 事件回流 agent:event → 渲染层渲染
```

| 环节 | 裁定 | 问题 |
|---|---|---|
| 上下文装配 | ⚠️ | **记忆只读注入**（P0-1）；技能/AGENTS.md/记忆/断点均过 `guardUntrusted` ✅ |
| 工具执行 | ✅ | 并行只读 / 串行写 / 审批精确分发 ✅ |
| 压缩 | ⚠️ | 算法成熟；**摘要不归档记忆**（P0-2）；前缀稳定性已改进（A/B 开关） |
| 收尾与验证 | ⚠️ | L1 生效 ✅；**L3 不接线**（P1-1）；**收尾不写记忆**（P0-1） |

### 4.2 编排链路（orchestrate_task → DAG → Worker）

| 环节 | 裁定 | 问题 |
|---|---|---|
| LLM 拆解 | ✅ | 任务数 2~8 硬闸、环检测、拓扑分层 |
| 并发与隔离 | ✅ | 信号量并发 + worktree 隔离 + abort |
| 超时收口 | ✅ | 超时已补 `abortGroup`（P0-4 已修） |
| 验证 | ⚠️ | **Worker V 层 off**（P1-2）→ 编排产出无对账 |

### 4.3 定时任务链路（无人值守）

| 环节 | 裁定 | 问题 |
|---|---|---|
| 调度与补跑 | ✅ | 错过即标记、启动可补跑 |
| V 层 | ✅（本轮复核） | `scheduledVerify.js` 已接：L1 全量 + L3 风险门/5% 抽样 + fail-closed 降级 ✅ |
| 审批 | ✅ | 沿用完整 Agent 通道（含审批/沙箱/超时） |

> 结论：定时通道的 V 层**已接线**（`main.js:990` + `scheduledVerify.js`），此前报告的「未接线」已被本轮复核推翻。
> 这正说明:**报告结论必须用当前代码复核**，否则会把「已修」当「仍缺」。

### 4.4 记忆链路（专项）

| 环节 | 裁定 | 问题 |
|---|---|---|
| 写入 | ❌ | **无自动写**（P0-1）：仅 /mem 显式、legacy 导入、后台压缩 |
| 召回 | ✅ | 分域分层 + 可信度过滤 + Top-K 钳制 + 半衰期衰减 |
| 压缩归档 | ❌ | **不落库**（P0-2） |
| 后台压缩 | ✅ | `bgScheduler` 批量合并 Tier1→Tier2 |
| 跨会话延续 | ❌ | 因无自动写 + 摘要不归档，**跨会话学习闭环断裂** |

**这是本报告最重要的结论**：记忆体系的「存储 + 召回」是成熟的，但**「采集」缺失**，导致整套体系停在「人工喂料」状态。

### 4.5 平台适配链路

| 平台 | 裁定 | 问题 |
|---|---|---|
| macOS | ✅ | Seatbelt 开箱即用 + 真实可用性探测 |
| Linux | ⚠️ | bwrap 需安装；**无 seccomp**（已知标注） |
| Windows | ❌ | **OS 级隔离未接线**（P1-4）；仅命令级 |

---

## 5. `agent-safety-compression` 三件套专项裁定

以 skill 的三个核心范式逐项核对本项目实现：

| 范式 | 本项目状态 | 裁定 |
|---|---|---|
| **① 沙箱权限接入**（mode → full_access 映射） | `approvalPolicy.js` 的 `stricterApproval` / `stricterSandbox` 单点收敛；`read-only` / `workspace-write` / `full-access` 三档落地；`full-access` 跳过 guard 与审批 | ✅ **已落地** |
| **② 上下文 LLM 压缩**（超阈值 → summarize → 失败降级截断） | `compactHistory`：0.7 触发 / 0.8 激进；LLM 结构化四段摘要在前；失败回落硬截断；重写记账 + 次数预算；看门狗超时 | ✅ **已落地** |
| **③ 记忆自动持久化**（压缩摘要 → memory_items，跨任务召回） | **未落地**：无 `MemorySaved`/`auto_compact`；摘要只回对话；引擎无自动写记忆 | ❌ **未落地（P0-1 / P0-2）** |

**skill 给出的对照模式（本项目可直接借鉴）**：

```
compact_history 成功路径
   → emit LoopEvent::MemorySaved {memory_id, scope, chars, summary_text}
   → TauriTaskSink::on_event 的 MemorySaved arm
        try_state<AppState>() → db.lock() → LayeredMemoryStore::upsert(MemoryItem{
           content_type:'summary', weight:0.7, tags:['compression_summary'],
           source_ref:{origin:'auto_compact', task_id}
        })
        upsert 失败 → 仅告警，不中断主循环（fail-open 降级）
```

映射到本项目（Electron/JS）：

| skill（Tauri/Rust） | 本项目对应改造 |
|---|---|
| `LoopEvent::MemorySaved` 枚举 | 在引擎 `emit` 通道新增 `memory_saved` 事件类型 + `shared-ipc/contract.mjs` 登记 |
| `TauriTaskSink::on_event` 的 arm | 在 `main/agentRunner.js` 的事件消费侧新增 arm，落 `MemoryManager` |
| `try_state` 拿 db（Option） | 主进程已持 `memoryManager` 单例，直接 `_serialized` 串行落库 |
| `MemoryItem{content_type, weight, tags, source_ref}` | `MemoryManager.remember({domain:'session', source:'compressor', importance:0.7, entityTags:['compression_summary']})` |
| 失败只告警不中断 | `remember` 已返回 `null` 不抛；调用点 catch 记日志即可 |

> 关键决策模式可直接照搬：**压缩层不碰 DB（引擎侧只发事件），持久化放宿主侧**。
> 好处：所有既有 sink 构造器零改动，且避免引擎引入存储依赖（保持 headless 纯净）。

---

## 6. 结论与建议实施顺序

### 6.1 结论

- **执行面**：生产级。沙箱 / 审批 / 凭证隔离 / 上下文压缩 / 成本防护 / 编排 / V-L1 均已落地，**对标非云端主流 Agent 无实质短板，部分能力更强**。
- **治理面缺口**：记忆采集闭环（P0-1 / P0-2）是本轮**唯一确定性功能缺口**。
- **平台/协议残差**：Windows OS 级隔离（P1-4）、MCP 全能力对齐（P2-4）、用户 hooks（P1-5）、会话分支（P1-6）属二阶。
- **流程问题**：集中在「收尾环节」——跑完不沉淀、不独立复核（L3）、不自动重连。

### 6.2 建议顺序（按性价比）

| 批次 | 内容 | 理由 |
|---|---|---|
| **第一批（止血闭环）** | P0-1 记忆自动写 + P0-2 压缩摘要归档 | 同一事件通道一次改造即可同时打通；收益最高、风险最低（fail-open） |
| **第二批（可信度）** | P1-1 注入 `l3Chat`（至少高风险任务开）+ P1-2 Worker 接 V 层 | 让「做对了没」从 L1 对账升到语义复核 |
| **第三批（体验韧性）** | P1-3 MCP 自动重连带退避 + P1-5 用户 hooks + P1-6 会话分支 | 本地 Agent 的健壮性与可玩性 |
| **第四批（平台对等）** | P1-4 Windows OS 级隔离接线（含设置入口 + carve-out） | 三平台隔离水位对齐 |
| **第五批（一致性）** | P2-1 布局 token 收敛（需设计意图）+ P1-7 UI 原语补完 | 工程一致性收尾 |

### 6.3 验收建议

- P0-1：跑一次完整任务后，**DB `memories` 表新增记录数 > 0**，且 `source = model_conclusion`；重启新会话能召回该结论。
- P0-2：触发一次压缩后，**DB 出现 `tags` 含 `compression_summary` 的 Tier1/Tier2 记录**；`upsert` 失败不影响主循环（注入故障验证 fail-open）。
- P1-1：高风险任务（产生对外/不可逆动作）run 结束后 trace 中 `l3.status != skipped`。

---

## 7. 审查的诚实边界

1. 本报告**未逐行重跑全量门禁**（沿用 2026-10-18 交付报告的 158/158 口径），核心结论以读码 + grep 取证为准。
2. 「视觉输入（图片）」「会话分支」等条目为**全仓 grep 命中为空**的判断，若存在别名实现可能漏判，标注为「疑缺」。
3. 「Windows OS 级隔离未接线」「Linux 无 seccomp」沿用项目 README 自述，属**已知如实标注**，非本轮新发现。
4. 本报告不重复 2026-10-18 已修的 21 项，也不把「部分完成」当「已完成」——P1-7 / P2-1 明确标为部分/未做。
