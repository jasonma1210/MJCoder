# MJCode Agent Harness 架构完整性审查与设计建议

> 审查日期：2026-10-18
> 审查对象：`mj-code-desktop` v0.5.0-beta（`/Users/jianma/Desktop/MJCode/desktop`）
> 代码面基线：`669ef5e`（tag v0.5.0-beta）｜产出时 HEAD：`e2c6c05`
> 基线偏差核验：`git diff --stat 669ef5e HEAD` = 仅 `docs/release-notes-0.5.0-beta.md` 一个文件，**不触及源码**，故本文全部结论对 `669ef5e` 成立。
> 审查框架：H=(E,T,C,S,L,V)+P（六层功能 + 架构范式）
> 审查方式：四人专家团分工取证 + 主理人独立复核（所有标注「✅已复核」的结论均由主理人亲自跑命令确认，不依赖成员自述）

---

## 0. 阅读说明：本报告的三条纪律

在进入结论前，先说明本报告与本项目**已有的 68 份历史审查 md** 的关系，以及为什么不能直接沿用它们。

1. **本报告不采信任何历史审查报告的数字**。项目根目录下有 68 份 2026-10-12 至 10-18 的审查/执行报告，它们是重要线索来源，但其中的清单⁵」、「
   门禁」「需联网复核」的!TODOs 标记等已被证实存在过期前提（例如「main.js 逼近 1500 行 max-lines 门禁所以必须拆分」经实测不成立——code 行仅 1023）。本文所有数字均**从当前源码现算**。
2. **每条结论带文件:行号锚点**，路径相对 `/Users/jianma/Desktop/MJCode/`。无法从代码判定的一律标 ❓ 并说明「未找到」，不用「应该有」「通常会」搪塞。
3. **外部对标必须从权威来源**。外部基线经研究员核实， Codex 相关关键词在网上命中大量内容农场与个人 fork 旧快照，详见 §4.5——本报告已系统规避。

---

## 1. 结论先行

### 1.1 总体判定

> **MJCode 是一个「E / T / L 强、C / S 中、V 空」的 Agent Harness。**
> 按 H 框架严格判定：**骨架完整但关键层缺失（V 层缺位）**，不构成「完整的 Agent Harness 实现」，但远超「仅有骨架」的水平。

分层裁定：

| 层 | 职责 | 裁定 | 一句话理由 |
|---|---|---|---|
| **E** 执行循环 | 任务怎么跑、怎么停 | ✅ **完整** | 防跑飞三道保险齐全且有常量锚点，打转检测是真「工具名+参数指纹」 |
| **T** 工具注册 | 能用什么、怎么用 | ✅ 完整（授权侧）／⚠️ 部分（披露侧） | 「凭证不进执行环境」是全项目最强项；但注册即披露，无按需筛选 |
| **C** 上下文管理 | 什么信息进窗口 | 🟡 **基本完整** | 压缩工程成熟（轮边界对齐、无收益即放弃）；但无预算分配、无重写记账 |
| **S** 状态存储 | 跨轮次持久化 | 🟡 **基本完整** | 记忆治理完全达标；但外部副作用无幂等键、无证据版本绑定 |
| **L** 生命周期钩子 | 拦截与人为回路 | ✅ **完整（安全）/ 扩展性为零** | 四档审批 + 沙箱 fail-closed，拦截绕不过；但不可配置化、不可扩展 |
| **V** 评估接口 | 怎么知道做对了 | ❌ **缺位** | 运行期无任何独立评估方，「完成」= 模型不再调工具 |

**一句话结论**：它具备生产级的**执行安全**（沙箱 + 审批 + 凭证隔离）与**成本防护**（轮次/Token/超时三道闸），但缺少让它「知道自己做对了」的那一层——没有 V，前面所有层的正确性只能靠模型自觉。

### 1.2 对你四个问题的直答

| # | 你的问题 | 直答 | 详见 |
|---|---|---|---|
| 1 | **界面设计风格是否优秀？** | **良好（Good），尚未达到「优秀」**。设计系统与 i18n 是满分项（transform级 single source、0 硬编码、0 漏翻），但**没有 UI 原语层**导致 303 个裸 `<button>`、7 处重复开关实现、9 个手写模态无焦点管理。短板是**工程一致性**，不是审美。 | §3 |
| 2 | **功能完整度能否比肩 CodexApp 非云端版？** | **执行与安全面已达甚至超出，治理面与评估面明显落后**。执行循环/审批/沙箱/凭证隔离/记忆治理对标无短板甚至更强；**角色设定、 think、 tokens 预算、 MCP、 Skills、 上下文窗口标定**六项存在实质性差距；V 层是 Codex 也没有但 MJCode 更缺的一层。综合：**功能覆盖面接近，工程耐久度与协议时效性差距明显**。 | §4 |
| 3 | **技能 / 数字员工 / MCP 对接是否正确、符合主流实践？** | **均不正确，MCP 问题最严重**。Skills 全量注入无渐进式披露；数字员工是**只读生态目录**而非可创建的产品实体，且缺 RBAC；MCP 停留在 **2024-11-05 规范**（落后官方 2025-11-25 整一年）、`initialize` 返回值被丢弃、缺 11 项规范能力、**API Key 明文落盘且权限 0644**（✅实测证实）。 | §5 |
| 4 | **对话 Agent 全流程设计是否合理？** | **环节划分与时间控制成熟，但「模型能力侧」整体失控**。分层超时设计优秀（单节点 < 单轮 < 流式三层）；压缩工程成熟但**窗口默认值方向错在最坏一侧**（128K 兜底 vs Ollama 真实 2048，差 **64 倍**，且**用户手选窗口根本没接进引擎**）；思考强度**无能力门控 + 非流式通道完全丢失**；未做任务-模型分档。 | §6 |

### 1.3 缺陷全景（按优先级）

| 级别 | 数量 | 代表问题 |
|---|---|---|
| **P0**（不改则有确定性故障） | 5 | 上下文窗口默认错配致压缩永不触发（且用户手选未接线）；MCP 凭证 0644 明文；思考强度非流式丢失 + 无门控；编排超时后未 abort 组；V 层缺位 |
| **P1**（特定条件下故障 / 明确损失） | 12 | 技能全量注入；MCP 规范落后 + 能力协商失效；无整任务墙钟；压缩无重写记账；数字员工无 RBAC 且不可创建； UI 原语层缺失等 |
| **P2**（体验与效率） | 8 | 同轮只读工具未并行；首字节无 SLO；摘要无硬长度约束；布局长尾散点等 |

---

## 2. 架构完备性：H=(E,T,C,S,L,V)+P 逐层裁定

### 2.1 E 执行循环（Execution Loop）— ✅ 完整

**承担模块**：`desktop/agent-core/index.js`（引擎）、`main/agentRunner.js`、`renderer/src/lib/agent.js`、`main/streamGuard.js`、`hooks/useAgentRun.ts`

**防跑飞三道保险**（全部✅已复核）：

| 保险 | 常量 | 锚点 |
|---|---|---|
| 轮次上限 | `AGENT_HARD_ROUND_CAP = 120` | `agent-core/index.js:1258` |
| Token 预算 | 600k / 1M（双档） | `renderer/src/lib/agent.js:25-26` |
| 每节点超时 | 矩阵 8s~10min（shell 600s、子代理 1200s） | `agent-core/index.js:1110-1119` |
| 流式三层守卫 | 首字节 90s / 空闲 300s / 总时长 900s | `main/streamGuard.js:23-27` ✅实测 `firstByteMs: 90000 / idleMs: 300000 / totalMs: 900000` |

> **设计亮点（建议保留并沉淀为团队范式）**：`streamGuard.js` 用**首字节 / 空闲 / 总时长三层 + 独立 tick**（`TICK_MS=5000`），不靠调用方在读循环里「有数据就重置」。源码注释明确写了理由：真挂起时读循环停在 `await`，永远走不到重置那一步。这解决了推理模型思考期被误杀的经典问题，并对齐了 Claude Code 的 `CLAUDE_STREAM_IDLE_TIMEOUT_MS` 与 Codex 的 `stream_idle_timeout_ms`。

**打转检测**：`agent-core/index.js:1271` 是真正的「工具名 + 参数指纹」（key 排序防绕过），不是靠轮次耗尽才发现。这是高于多数同类实现的工程细节。

**缺口**：
- ❌ **终止判定落在模型自评**（`agent-core/index.js:1733-1758`：模型不再调用工具即判定完成）。违反 H 框架 E-1「终止必须由 V 说了算」与 checklist「模型自评（禁止）」。**本项目的完成判定比自评还弱**——连一次显式的自评都省了。
- ❌ **无整任务墙钟预算**。理论上界 = 120 轮 × 900s = **30 小时**，不构成预算（grep `wallclock/总时长预算` 无命中）。
- ❌ **编排等待超时 30min 后未 abort 组**：`main/main.js:850-852` 只返回 error，**没有调用 `workerPool.abortGroup`**（对比 `:846` 的 `waited.aborted` 分支有做）→ 编排组仍在后台静默烧 token。
- ❓ 同轮工具串行（`agent-core:1769`），未找到「刻意如此」的设计说明。可能是刻意避免副作用竞态，属合理但未文档化。

### 2.2 T 工具注册（Tool Registration）— ✅ 完整（授权侧）／⚠️ 部分（披露侧）

**这是全项目工程完成度最高的部分。**

「**凭证绝不进执行环境**」这条硬约束完全满足，且有纵深三道：

| 机制 | 锚点 | 说明 |
|---|---|---|
| shell 子进程 env 白名单 | `main/tools/shellEnv.js:43-65` | 只放行必要环境变量 |
| API Key 只在主进程入 HTTP header | `main/main.js:558/603` | 模型侧永远接触不到裸凭证 |
| 治理字段强制剥离 + 直连覆写 | `agent-core/index.js:1781-1786`、`execGovernance.js:10-16` | 模型自称的权限被剥离；直连 IPC 强制覆写，防劫持 |

**注册 ≠ 披露 ≠ 授权**的分离：✅ **授权侧分离干净**（L1 不接受任何规则豁免，`approval.js:113`）；❌ **披露侧未分离**——`agent-core/index.js:1455` 把约 40 个内置工具 + 全部 MCP 工具一次性全量暴露，无按需筛选，活跃工具过多时无降级机制。

⚠️ **MCP 工具披露顺序依赖连接顺序**，不满足 checklist「工具披露序列必须字节稳定」——顺序一变，prompt cache 前缀从头失效。

### 2.3 C 上下文管理（Context Management）— 🟡 基本完整

**压缩实现是成熟的**，五个设计点都做对了：

| 阈值 | 比例 | 锚点 |
|---|---|---|
| 压缩触发（常规） | 0.70 × 窗口 | `agent-core:729`（`TOKEN_COMPACTION_TRIGGER=0.7`，`:539`） |
| 压缩触发（激进） | 0.85 × 窗口 | `agent-core:731` |
| 尾部保留（常规/激进） | 0.25 / 0.15 × 窗口 | `agent-core:734` |
| 入口裁剪 | 0.45 × 窗口（下限钳到 16000） | `agent-core:821`/`:820` |
| 最小值得压缩体积 | 0.35 × 窗口 | `agent-core:552` |

✅ **做得好的三处**：
1. **轮边界对齐**（`alignCutToRoundBoundary`）——并发多工具时尾部可能全是 tool 消息，切点在「轮」而非「条数」，避免产生孤儿 tool 导致 400；配合 `normalizeMessages` 补链。这是很多 harness 踩过的坑。
2. **无收益即放弃**——压缩省不到 35% 就不压缩，避免无效重写。
3. **压不动改硬截断再挂起**，有兜底。

**缺口**：
- ❌ **无上下文预算分配**。checklist 要求「系统指令 / 历史 / 工具结果 / 参考资料各占多少」，项目只有压缩阈值比例，等于没做分配。
- ❌ **每次压缩 = 全量前缀重写（`agent-core:789`），且无重写成本记账、无失效预算**。checklist 明确要求「重写动作要记账」（低于 `<Translation bundle>`），项目完全缺失。
- ❌ **system 段只在 run 开始组装一次**（`1360-1437`），长任务内不刷新 → 违反「每轮重新组装」
- ❌ **前缀不稳定**：system 头部承载可变内容（记忆 `1417-1430`、技能 `1371-1386`），每次都在变，prompt cache 命中率受影响。

### 2.4 S 状态存储（State Storage）— 🟡 基本完整

**记忆治理完全达标**（`main/memory/index.js:27-42`）：可信度三级（1.0 / 0.6 / 0.2）、归属标记、半衰期 + 7 天宽限、容量闸 500、晋升需人工确认。这满足 checklist 全部要求，且「未验证推测不得因写进记忆而升级为事实」这条做得很扎实。

**缺口**：
- ❌ **外部副作用无幂等键、无状态查询**（`workerPool.js:134` 只是「承认不确定」的账本）。checklist S-4「会话恢复 ≠ 外部行动恢复」未解决。
- ❌ **无证据版本绑定**：验证结论只对被验证版本有效，版本变更后旧结论没有失效机制。
- ⚠️ **记忆召回阈值未暴露**：`db/index.js:92` 注释提到「词法重叠 + 余弦双路」，但未找到相似度阈值常量与度量空间绑定（换 embedding 必须重标定）。

### 2.5 L 生命周期钩子（Lifecycle Hooks）— ✅ 完整（安全）/ 扩展性为零

**安全达标，拦截绕不过**：

| 机制 | 锚点 |
|---|---|
| 四档审批 × 三级风险 | `approval.js:113`（L1 不接受任何规则豁免） |
| 沙箱不可用默认阻断而非裸跑 | `exec.js:130-151` |
| 运行时白名单 fail-closed | `agent-core:1806-1813` |
| Windows 沙箱「伪造 exitCode:0」已修复 | `exec.js:254-257`（补 body 摘要旁路） |

**缺口（扩展性为零）**：
- ⚠️ **对照 Codex 一手 12 事件基线（`codex-rs/hooks/src/lib.rs`）：内部语义覆盖 9/12**（缺 PreCompact、UserPromptSubmit；PostCompact/SessionStart/SessionEnd 只有 trace 弱等价），**12 条全部不可扩展**——无 matcher 分发、无配置化 hook 注册、无插件声明钩子、无 MCP 执行器、无配置层对钩子的管控。
- ❌ **本质差别在治理的载体**：Codex 已把 L 层当**治理面**推进（`requirements.toml` + `allow_managed_hooks_only` 可忽略 user/project/session 钩子配置）；MJCode 的治理写在**代码里**（`stricterApproval` / `stricterSandbox`），**不可被配置收紧**。**安全性仍达标**（拦截绕不过这条底线没变），但可治理性与可扩展性是两个维度。
- ❌ **四档中的「执行后告知」无独立档位**，只有审计留痕，不是可选择的治理档。

### 2.6 V 评估接口（Evaluation Interface）— ❌ 缺位

**这是全项目最重的判定，也是整个结论的支点。**

- 运行期**没有任何独立于生成者的评估方**。
- 「任务完成」判定 = 模型不再调用工具（`agent-core/index.js:1733-1758`）。
- 离线评测 `desktop/eval/run-eval.mjs` 具备**正确的 fail-to-pass 判定**，但**未接入运行链路**——有轮子，没装上车。
- ❌ **工具回执被当作业务事实**：`write_file` / `git_commit` / `pr_review` 返回 ok 即算成功，无权威状态回查（checklist V-5）。虽已修复 Windows 沙箱伪造 exitCode 的系统性欺骗，但「核对实际状态」这一步整体缺位。

> **为什么这一层决定全局**：E/T/C/S/L 五层的正确性，在没有 V 的情况下只能靠模型自觉。压缩做得再好、审批再严，如果最终判定「做完了」的权力在生成者手里，前面所有防护都可以被一次「我认为完成了」绕过。

### 2.7 范式 P 四维判定

| 子维度 | 判定 | 证据 |
|---|---|---|
| 扩展方式 | **混合：插件化 + 嵌入式内核** | 插件化：MCP / Skills / 插件市场（`pluginDiscovery.js`、`pluginMarket.js`）；嵌入式：`BASE_TOOLS` 硬编码在引擎内，新增内置工具必须改引擎 |
| 配置方式 | **声明式为主** | 审批规则 / apt executor / 定时任务 / MCP 配置均落 JSON，改配置不改代码 |
| 部署拓扑 | **单机** | 全部执行在本机进程/沙箱内；子代理是进程内递归（`spawn_subagent`），WorkerPool 也是本地 |
| 编排模式 | **中心化** | 模型侧 `max_agents` 被显式忽略（`main/main.js:814-818`），多智能体由主进程单点调度 |

---

## 3. 界面设计风格评估

### 3.1 评级：**良好（Good）**

**判据**：不是审美问题，是工程一致性问题。**设计系统本身是满分项，扣分全部集中在「没有 UI 原语层」及其衍生的一致性债**。

### 3.2 做得极好的部分（建议作为团队范式保留）

| 项 | 事实 | 复核 |
|---|---|---|
| **Design Token 单一来源** | `styles/` 只有 `theme.css` 一个文件，三层 token（主题 / 语义 / 层级）+ 圆角 / 阴影 / 动效 / 字体齐全 | ✅ |
| **Tailwind 桥接姿势正确** | 用 `rgb(var(--x-rgb) / <alpha-value>)` 三元组，绕开 v3 `/opacity` 静默失效陷阱；双写 hex + rgb 有明确踩坑注释 | ✅ |
| **i18n 满分** | 41 个 namespace、1541 个 key、zh/en 双向零缺失；**渲染层用户可见文案硬编码中文 0 条** | ✅✅ **我亲自跑官方门禁复核**：`node scripts/i18n-scan.mjs renderer/src` → `裸中文残留：0（通过）`，双口径一致 |
| **主题** | 5 套主题、`data-theme` 切换、首屏 inline 防闪、悬停预览、平台适配、强调色自定义 | ✅ |
| **无障碍基础** | `prefers-reduced-motion` 已实现；全局 `:focus-visible` 焦点环有效 | ✅（成员澄清：`outline-none`×45 **没有**破坏焦点环，实测产物 CSS 中 `:focus-visible`(index 34961) 在 `.outline-none`(23688) 之后，层叠顺序有效——这是个容易误报的点，澄清得对） |

### 3.3 问题清单

| # | 问题 | 锚点 | 严重度 | 我是否实测 |
|---|---|---|---|---|
| 1 | **无 UI 原语层**：51 个组件、**303 个裸 `<button>`、48 个裸 `<input>`**；开关（Switch）有 **7 处**逐字重复实现 | `EcosystemModal.jsx:484,532`、`LocalSkillsSection.tsx:92,113`、`LocalMcpSection.tsx:247`、`SettingsModal.jsx:1073`、`ScheduledTasks.jsx:104` | 高 | ✅ 实测 `grep -ro '<button' renderer/src \| wc -l` = **303**；`left-[22px]` = **7** |
| 2 | **9 个模态浮层手写、无共享 `<Modal>`**，容器间距/宽度各异（`p-6`/`pt-24`/`pt-[12vh]`/无 padding） | `SettingsModal.jsx:151`、`ArchiveModal.jsx:59`、`MarketModal.jsx:278`、`EcosystemModal.jsx:566` 等 | 高 | 抽样一致 |
| 3 | **模态无焦点管理**：`tabIndex` 全仓 0 处、`.focus()` 仅 3 处且不在模态；**7/9 模态无 `role`/`aria-modal`** | 同上；`aria-modal` 仅 `feedback.jsx:111` | 高 | — |
| 4 | **`bg-white` 在浅色主题下不可见**：7 处开关圆点用 `bg-white` + `border-border`（light 主题 `--theme-border:#e3e5e7`） | `theme.css:50`、`LocalMcpSection.tsx:247`、`SettingsModal.jsx:1073` | 中 | — |
| 5 | **魔法数字 `left-[22px]`** ×7，不随 `w-11/h-6/w-5` 推导，改尺寸即错位 | 同 #1 | 中 | ✅ 实测 7 处 |
| 6 | **padding 组合 29 种**（19 种各出现 1–4 次长尾）；**圆角 6 档并存** | 口径见 §3.5 | 中 | — |
| 7 | **无 `aria-live` / 无 `sr-only`**：流式输出、审批卡弹出、MCP 状态变化对屏幕阅读器完全静默 | 全仓 `aria-live`=0、`sr-only`=0 | 中 | — |
| 8 | **`SettingsModal.jsx` 1084 行 / `App.jsx` 799 行**，超出自述 800 行门禁（App 卡在 799 线上） | `SettingsModal.jsx`（含 8 Tab + 16 Section + 内联子组件） | 低（维护债） | — |

> 补充事实：`renderer/src/pages` 是**空目录**（✅实测），真正的页面实体都在 `components/`（51 个组件文件）。这意味着「页面 / 组件 / 弹窗」三层没有目录级分层，是问题 #2 的结构性根源。

### 3.4 改进建议（按性价比排序）

1. **抽 3 个原语组件**：`<Switch>`（消灭 7 处重复 + `left-[22px]` 改 `translate-x-5` 或 CSS 变量）、`<Modal>`（统一 9 处浮层，**内建 `role="dialog"` + `aria-modal` + 焦点陷阱 + 焦点归还 + Esc 关闭**）、`<Button>` / `<Input>`（收敛 303 / 48 处裸标签）。预计减约 500 行重复代码，一次性修掉 #1/#2/#3/#5。**这是性价比最高的一步。**
2. **给 `<Modal>` 内建 `aria-live="polite"` 区域**，播报审批卡 / 连接状态 / 错误提示（修 #7）。
3. **`bg-white` 换成 token**：新增 `--sem-knob`，light 主题下给深色圆点（修 #4）。
4. **收敛 padding 到 4 档 + 圆角到 3 档**：padding `px-2 py-1`（紧凑）/ `px-3 py-2`（默认）/ `p-4`（卡片）/ `p-6`（模态）；圆角 `rounded`(6px 小控件) / `rounded-lg`(10px 卡片) / `rounded-2xl`(16px 模态)。把 19 种长尾组合逐一归位（修 #6）。
5. **拆 `SettingsModal.jsx`**：8 个 Tab 抽为 `settings/` 子目录，对齐 800 行门禁（修 #8）。注意：项目已有 `--data-open` 相关的 CI 硬基线禁止新增 `.js/.jsx`（只允许 `.ts/.tsx`），新组件**必须写成 `.tsx`**。

### 3.5 给「是否优秀」的准确表述

不要用「设计很棒」或「设计很差」这种说法。准确表述是：

> **设计系统的「地基」是优秀的（token / i18n / 主题三项满分），但「上层建筑」缺一层 primitives，导致 UI 层出现大量逐^[1]^重复实现与可访问性缺口。这不是审美能力问题，是组件抽象纪律问题——也正是最容易在 2–3 周内补齐的部分。**

---

## 4. 功能完整度：能否比肩 CodexApp 非云端版

### 4.1 对标矩阵

> Codex 侧全部来自**官方 Rust schema 源码**一手取证（`codex-rs/config/src/config_toml.rs`、`protocol/src/config_types.rs`、`protocol/src/openai_models.rs`、`core/src/compact.rs`、`hooks/src/lib.rs`、`skills/src/lib.rs`、`features/src/lib.rs`），检索日期 2026-10-18。

| 能力项 | Codex CLI（非云端） | MJCode `669ef5e` | 判定 |
|---|---|---|---|
| **执行循环 / 轮次上限** | 有 | 有（120 轮 `agent-core:1258`） | ✅ 对等 |
| **防跑飞三保险** | 有 | 有且更细（三层流式守卫） | ✅ 略强 |
| **打转检测** | 未见同等实现 | ✅ 真「工具名+参数指纹」（`:1271`） | ✅ **MJCode 更强** |
| **审批策略** | `untrusted`/`on-request`/`granular`/`never` 四档 | 四档 × 三级风险，L1 无豁免 | ✅ 对等 |
| **沙箱** | macOS seatbelt / Linux landlock+seccomp | 同（+ Windows 支持，且修复了伪造 exitCode） | ✅ 对等略强 |
| **工作目录 / git 集成** | 有 | 有（worktree.js / git 工具） | ✅ 对等 |
| **项目指令（AGENTS.md）** | 有 | 有（`agent-core:1402` 注，且做了注入检测） | ✅ 对等 |
| **config 分层 / profile** | **五层 + `requirements.toml` 企业管理层** | 声明式 JSON，无 profile / 无企业管理层 | ⚠️ **落后** |
| **MCP** | 一手 schema 支持 | 传输三形态可用，但协议停在 **2024-11-05**、能力协商失效 | ❌ **明显落后** |
| **Skills** | `skills/` + `.system/` 内置 + `.codex-system-skills.marker` 幂等安装 | 单一目录、**全量注入无渐进式披露** | ❌ **明显落后** |
| **推理强度** | `ReasoningEffort` 五档 `[Minimal,Low,Medium,High,XHigh]`，`exec` 默认 **high** | 三档 UI，**非流式通道完全丢失**、无能力门控 | ⚠️ **部分落后** |
| **上下文压缩** | `context_window × 90%`，压缩后**重建并前置 prefix** | 0.70 / 0.85 双档 + 轮边界对齐；**窗口默认值错配** | ⚠️ **算法成熟但标定错误** |
| **子代理 / 委派** | 有 | 两套（`spawn_subagent` + WorkerPool），治理快照单调不增 | ✅ 对等略强 |
| **生命周期钩子** | **12 事件全集 + 可扩展** | 内置拦截点，**可扩展性 0** | ❌ **落后** |
| **记忆治理** | 未见同等治理 | ✅ 可信度分级 / 归属 / 半衰期 / 容量闸 / 人工晋升 | ✅ **MJCode 更强** |
| **会话恢复 / 断点续跑** | 有 | 有（checkpointStore） | ✅ 对等 |
| **可观测性 / trace** | 有 | 有（`runTrace.js`、`audit-log.jsonl` 239KB ✅实测） | ✅ 对等 |
| **评估 / 回归闭环** | 有 eval 体系 | ❌ **V 层缺位**，eval 未接运行时 | ❌ **落后** |
| **离线评测装车率** | — | `eval/run-eval.mjs` 有正确判定但**未接入链路** | ❌ |

**汇总**：执行与安全面 ✅（12/18 对等或更强）；**协议时效与治理面** ❌（6/18 明显落后：MCP、Skills、hooks 扩展性、config 分层、评估闭环）。

### 4.2 结论：能不能「比肩」？

**分层回答，不要给单一答案：**

- **作为「能干活的本地 Coding Agent」**：✅ **可以比肩，部分维度更强**。执行循环、审批、沙箱、凭证隔离、记忆治理、打转检测、可观测性这几项，MJCode 做得不比 Codex CLI 差，凭证隔离与记忆治理甚至更严。
- **作为「可持续演进的 Agent 平台」**：❌ **不能**。三条硬伤决定了它的耐用品&#36710;度低于 Codex：
  1. **协议时效落后一年**（MCP 停在 2024-11-05，官方已到 2025-11-25）——对接第三方 MCP 生态会逐渐失效；
  2. **L 层可扩展性为零**——Codex 已把 hooks 当治理面推进，MJCode 的拦截点是写死的内置集合；
  3. **V 层缺位**——决定了它无法自动证明「做对了」，也就无法建立回归闭环。
- **作为「产品」**：✅ **有自己的差异化**。数字员工（51 条生态目录）、电脑操控（CUA）、浏览器操控、多种场景一体化，是 Codex CLI 不具备的形态；GUI 形态对非开发者用户更友好。

### 4.3 一个必须纠偏的对标错误

> **本轮最重要的纠偏**：网络上广泛流传的 Codex `approval_policy: suggest / auto-edit / full-auto` 与 `model_max_output_tokens` 等 config key，**全部来自个人 fork 的旧快照**。
> 官方 `openai/codex` 仓库的 `docs/config.md` 与 `docs/sandbox.md` **当前均已改为 stub**，正文只剩一句跳向 `developers.openai.com/codex/*` 的链接。研究员核验后改走**官方 Rust schema 源码**取证——这比任何二手文档都权威。
> **团队后续若再对标 Codex，禁止引用上述 fork 键名。** Codex 官方 `AskForApproval` 的真实取值域是 `untrusted / on-request / granular / never`。

---

## 5. 技能 / 数字员工 / MCP 对接审查

### 5.1 Skills（技能）— ❌ 对接方式不正确

**事实链**：

| 环节 | 事实 | 锚点 |
|---|---|---|
| 来源 | **只有单一目录** `~/.mjcode/skills`；项目级 `.mjcode/skills`、`.claude/skills` **未找到实现**；生态目录 219 条仅为展示/安装源，不参与运行时 | `main/ipc/plugins.js:20` |
| 解析 | **手写逐行切分**（不支持 YAML 块标量 / 嵌套列表 / 锚点）；**导入路径无 schema 校验**（只有导出路径有） | `skills.js:7-20`、`skillCompat.js:52` |
| 注入 | **一次性全量拼进 system prompt，无渐进式披露** | `agent-core/index.js:1371-1386` ✅已复核 |
| 链路 | `ChatArea.jsx:144-160` 读全文 → `useAgentRun.ts:535` → `index.js:1371` | — |
| 规模 | 本机 **154 个技能**、均值 5,102 字符 → 全量启用 ≈ **50.4 万字符（约 12.6 万 tokens）/ 轮** | 实测口径见 §附录 |

**✅ 我复核时的补充发现（重要，避免误判）**：
- 技能注入**确实走了 `guardUntrusted` 注入检测**（`index.js:1371-1380`，`maxChars: 6000`），命中注入特征会整块拒绝并留痕。所以**不是裸注入**，安全面有防护。
- 但**缺少的是总量预算**：单技能 6000 字符上限存在，154 个技能的理论上界仍是 92 万字符。**痛点不是安全，是规模与按需筛选**。

**核心缺口**：
1. ❌ **无渐进式披露**。Anthropic Agent Skills 的官方事实是「folders of instructions, scripts, and resources that Claude **loads dynamically**」，且 `description` 必须描述「what it does and **when to use it**」——机制就是先只加载 name+description，命中后再加载正文。MJCode 一次性全注入，**当_initializeTerms 数量增长时上下文必然被吃满**。
2. ❌ **`when_to_use` 字段被丢弃**：`ecosystem/skills.json` 有这个字段（正是按需筛选所需的关键元数据），但 `main/ecosystem.js:119-129` 的 `loadSkillCatalog` 把它扔掉了。这两条互为印证——**不是没想到，是元数据管线断了**。
3. ⚠️ `skillCompat.js` 实现了 Claude Code / Codex SKILL.md 双向互通（6 个函数，含路径穿越 fail-closed `:79-85`），**生态对齐意识是好的**，但互通过来之后仍被全量注入。

### 5.2 数字员工（Digital Employee）— ⚠️ 形态与预期不符

| 项 | 事实 | 锚点 |
|---|---|---|
| 真实载体 | `ecosystem/digital-employees.json`（**51 条**）→ 运行时形态是 `rolePreset {systemPrompt, toolNames, approvalMode, sandboxPolicy, skillNames}` | `main/ecosystem.js:162-171` |
| **能否创建** | ❌ **不能**。全仓无 create IPC / UI / 写盘路径，`ipc/ecosystem.js:178` 与 `:208` 均只读 | ✅ 需用 "and then" |
| FSM | ✅ **有，两级且强制执行**（状态表 + `canTransition` 强制校验） | `taskStore.js:9-28`、`:117` |
| RBAC | ❌ **未找到实现**。替代机制是工具风险分级 L1/L2/L3 + 审批档，**属「工具级治理」而非「主体-角色-权限」三元组** | `approval.js:6,16-60,80-99` |
| 多智能体 | ✅ 两套且工程化高：`spawn_subagent`（独立上下文 / 只读工具子集 / 无 MCP / 独立预算 / 取消级联）与 `orchestrate_task` → WorkerPool（治理快照单调不增、自动重规划上限 1 次） | `index.js:1827-1936`；`workerPool.js:196-222` |

> **澄清一个易混淆点**：`collab.js` 是 **Yjs 协同**（THREAD/BOARD/APPROVAL），**不是**数字员工载体，且默认冻结。

**核心缺口**：
1. ❌ **数字员工不可创建** —— 它是**只读生态资产**，不是可编辑的产品实体。用户理解中的「创建自己的数字员工」在当前代码里不存在出口。
2. ❌ **RBAC 缺失** —— 「主体-角色-权限」模型未建立，现有治理是工具维度而非主体维度。
3. ❌ **`system_prompt` 不经过提示注入检测**（`index.js:1363-1365` 直接 `.slice(0,12000)` 拼接，✅我已复核）——对比：技能 `:1373`、AGENTS.md `:1402`、记忆 `:1420` **都做了** `guardUntrusted`。**唯独角色提示这一路漏了**，而角色数据来自第三方生态目录，风险更高。

### 5.3 MCP（Model Context Protocol）— ❌ 问题最严重

**这是三个对接里最需要立刻处理的一块。**

| 项 | 事实 | 锚点 | 复核 |
|---|---|---|---|
| 传输层 | ✅ stdio / Streamable HTTP / legacy SSE **三种齐全** | `mcpClient.js:77/110/224` | — |
| **协议版本** | ❌ **停留在 `2024-11-05`**，官方规范已到 **2025-11-25**（落后整整一年）；且该常量在 `mcpAuth.js:244` 被硬编码复制一份 | `mcpClient.js:23` | ✅ **实测** `const PROTOCOL_VERSION = '2024-11-05';` |
| **`initialize` 返回值被丢弃** | ❌ `await mcpRpc(server,'initialize',...)` **未接收返回值** → serverInfo / capabilities / protocolVersion **全部丢弃** | `mcpClient.js:402` | ✅ **实测**确认无赋值 |
| **客户端能力不声明** | ❌ 发出的是 `capabilities: {}` | `mcpClient.js:404` | ✅ **实测** |
| **服务端通知无处理** | ❌ `server.onNotify = null`（`:359`），`:71` 只在是 function 时才调用，全仓无赋值 → **恒为 null** | `mcpClient.js:359/71` | ✅ **实测** |
| **缺失能力** | ❌ 缺 **11 项**：resources / prompts / sampling / roots / elicitation / completion / logging / 分页 / 取消 / 进度 / ping（grep 各 method 字面量**命中均为 0**），**只有 tools/list + tools/call** | — | — |
| 工具命名 | ⚠️ `mcp__${server}__${tool}` 有前缀，server 级冲突天然消解；但**工具名长度/字符无校验**；MCP 工具不受角色裁剪 | `renderer/src/lib/mcpTools.js:10`、`index.js:1462` | — |
| **MCP 工具披露顺序** | ⚠️ 依赖连接顺序 → 不满足「披露序列字节稳定」 | — | — |

**🔴 安全红线 1：API Key 明文落盘且权限 0644**

这是我亲自复核的一条，**值得完整记录核查过程**：

```
实测路径：~/Library/Application Support/mj-code-desktop/mcp-servers.json
权限：    -rw-r--r--  octal=644   size=1845 bytes     ← 全域可读
内容：    11 个已配置 MCP 服务，其中 name=tavily 的 envKeys=[TAVILY_API_KEY]  ← 明文
写入点：  main/ipc/mcp.js:112-115  → saveMcpConfig → writeFileDurable 无 chmod
对照正例：OAuth 令牌走 0600（mcpAuth.js:67）      ← 同一项目两条凭证路径标准不一致
```

✅ **补充一条比成员报告更精确的事实**：`ipc/mcp.js:112-115` 写入的是**用户原始 `env`**，而连接时用的是 `sanitizeEnv(env)`（`:85-94`）。即**落盘的是未经过白名单过滤的原始值**——比「写了 env」更严重：白名单在这里形同虚设。

⚠️ **次要红线 2**：`sanitizeEnv` 的展开顺序 `{ ...out, PATH: shellEnv().PATH, ...(env || {}) }` 让用户 env 排在最后 → **用户 env 可覆盖白名单变量**（`ipc/mcp.js:93` ✅实测）。

> **核查过程中的方法论教训（建议团队记住）**：我第一次用区分大小写的正则扫该文件，**返回空**，一度以为成员结论有误；改用 `-oiE` 大小写不敏感后立刻命中 `TAVILY_API_KEY`。
> **这再次印证：单一工具、单一模式的空结果不足以支撑「不存在」这一全称命题。** 判定「不存在」必须换一种按目标特征构造的模式再扫一次。

**`mcp_status` 是死信**：`ipc/mcp.js:121-125` 产生并广播 crashed 事件，但渲染层无消费者（`AgentDock.jsx:78-79` 因无 groupId 直接 return），**且无自动重连** → MCP 服务崩溃后 UI 停留在「已连接」，用户完全无感知。
（渲染层四态 ok/fail/connecting/saved 本身实现正确，缺的是「已崩溃」第五态与主动推送。）

### 5.4 三方（Claude ↔ Codex）兼容状态小结

| 能力 | 结论 | 依据 |
|---|---|---|
| **↔ Codex Skills** | ✅ 双向互通已实现 | `skillCompat.js`（含路径穿越 fail-closed `:79-85`） |
| **↔ Claude Skills** | ✅ 互通，但 frontmatter 解析是手写逐行切分，不支持 YAML 块标量/嵌套列表/锚点 | `skills.js:7-20` |
| **↔ Codex skills 目录约定** | ⚠️ Codex 用 `skills/` + `CODEX_HOME/skills/.system/` + `.codex-system-skills.marker` 幂等安装；MJCode 只有单一 `~/.mjcode/skills`，**缺此兼容维度** | 一手：`codex-rs/skills/src/lib.rs` |
| **↔ MCP 生态** | ❌ 协议落后一年 + 能力协商失效 + 缺 11 项 → 只能对接最老一批只提供 tools 的 server | §5.3 |
| **↔ Claude extended thinking** | ❌ **原生 `thinking:{type,budget_tokens}` 完全不发送** | §6.4 |

> **Skill 规范的准确表述（避免团队踩坑）**：Anthropic 官方 README **一手证实** frontmatter 的**必需字段只有 `name` 和 `description` 两个**；社区广泛流传的 **`allowed-tools` 字段在本轮未获得一手证据，标为待核**（正式规范站点是 `agentskills.io`，需直读复核）。`progressive disclosure` 术语本身亦标待核，但「loads dynamically」机制描述已在官方 README 原文中证实。

---

## 6. 对话 Agent 全流程深度审查

### 6.1 环节链路与环节关系

从源码还原的真实链路（非推测）：

```
用户发送 → 会话/线程 → prompt 组装 → 模型调用（流式）→ 工具执行 → 结果回喂 → 再入模型 → 终止判定 → 落库/渲染
```

| 环节 | 责任模块 | 失败处理 | 超时 |
|---|---|---|---|
| UI 输入 | `Composer.tsx` → `useAgentRun.ts` | — | — |
| payload 组装 | `useAgentRun.ts:519-522`（注入 reasoning_effort / context_window） | — | — |
| IPC 传输 | `agentRunner.js:167` | — | — |
| system 组装 | `agent-core/index.js:1360-1437`（BASE → 角色 → 技能 → AGENTS.md → 记忆） | — | — |
| 模型调用 | `index.js:1589` → `main.js:566-569`（**唯一出口**） | 分类重试（瞬时/模型/永久/资源） | 流式三层守卫 |
| 工具执行 | `index.js:1769`（**串行**）→ `tools/*` | 错误回喂模型 ✅ | 节点矩阵 |
| 压缩 | `index.js:723-805` | 无收益即放弃 → 硬截断 → 挂起 | 独立 180s + 独立降级链 |
| 终止判定 | `index.js:1733-1758` | ❌ 模型不调工具即完成 | — |
| 落库/渲染 | `localStore` / `taskStore` / `runTrace` | WAL + checkpoint | — |

**环节设计评价**：✅ **失败回喂做得对**——错误作为观察结果回到上下文，没有在循环里吞异常（checklist E 层核心要求）。⚠️ 但**并行缺失**：同轮工具明确串行，无依赖分析。

### 6.2 时间控制 — 设计优秀，缺最高一层

**分层超时**情况（这是全项目做得最好的部分之一）：

| 层 | 值 | 锚点 |
|---|---|---|
| 单节点 | 8s ~ 10min（shell 600s / 子代理 1200s） | `agent-core:1110-1119` |
| 单轮 wall-clock | 默认 120s 硬顶（套在重试链外，防半开连接） | `index.js:1577` |
| 流式 | 90s 首字节 / 300s 空闲 / 900s 总时长 | `main/streamGuard.js:23-27` ✅实测 |
| 编排等待 | 30min | `main.js:850-852` |
| **整体任务** | ❌ **缺失** | grep 无命中 → 理论上界 30 小时 |

**缺口**：
1. ❌ **无整任务墙钟预算**（P1）。建议 `DEFAULT_RUN_WALL_CLOCK_MS = 30min`，使分层成为：单节点(8s~10min) < 单轮(15min) < **整体(30min)**。
2. ❌ **编排超时后未 abort 组**（P0）：`main.js:850-852` 只返 error，组仍在后台烧 token。
3. ⚠️ **两层超时数字不一致**（P1）：`exec.js:68` 默认 vs 引擎下发 vs `TOOL_TIMEOUT_OVERRIDES` 三处口径不同；`web_fetch` 实现侧 15s 抢先于引擎声明的 60s。
4. ⚠️ **首字节无 SLO**（P2）：只有 90s 超时，没有「目标 ≤ 3000ms」的可观测指标。

### 6.3 上下文压缩 — 算法成熟，标定错误

**已做对的**（详见 §2.3）：轮边界对齐（解决并发多工具时尾部全是 tool 消息的顽疾）、无收益即放弃、硬截断兜底、双档阈值。

**缺口**：
1. ❌ **无重写记账**（P1）：每次压缩都是**全量前缀重写**（`agent-core:789`），重算 token 完全没统计。建议加 `rewriteLedger = {count, recomputeTokens}` + `MAX_REWRITES_PER_RUN = 5`。
2. ❌ **无上下文预算分配**（P1）：只有压缩阈值比例，没有系统/历史/工具结果/参考资料的占比设计。
3. ❌ **system 段只在 run 开始组装一次**（P1）：违反「每轮重新组装」。
4. ⚠️ **入口裁剪每次都砍**（P1）：`targetRatio=0.45`（`:821`）与压缩阈值 0.7 抢跑，长会话每次「继续」都被裁一刀。建议仅在 `beforeTokens > 0.7×window` 时才裁。
5. ⚠️ **阈值偏保守**：Codex 用 **90%**，MJCode 用 **70%**，意味着**提前 20% 就压缩**，对话历史保留较短。这在窗口标定正确时只是浪费，在标定错误时（见 §6.5）反而成为唯一防线。

### 6.4 思考强度（reasoning effort）— ❌ 模型能力侧整体失控

**完整链路**（唯一出口）：

```
UI: ''/low/medium/high          renderer/src/lib/modelConfig.js:10-17
 ↓ localStorage 'mj_model_configs'，key = `${providerKey}/${modelId}`   :30-34, 50-59
 ↓ 读取+注入                     hooks/useAgentRun.ts:519-522
 ↓ IPC payload.model            agentRunner.js:167
 ↓ 引擎读取                      agent-core/index.js:1589  reasoningEffort: model.model.reasoning_effort || ''
 ↓ 下发（唯一出口）              main/main.js:568-569   if (reasoningEffort) body.reasoning_effort = reasoningEffort;
```

**请求体全貌**（`main.js:566-569`）：只有 `{model, messages, stream, stream_options, tools, reasoning_effort}`。
**全仓 grep `max_tokens|maxTokens|temperature|top_p`：仅命中 `Dashboard.jsx` 图表变量名 → 项目从不发送这些参数。**

| 模型类别 | 实际下发 | 真实思考参数 | 判定 |
|---|---|---|---|
| OpenAI 官方（gpt-5/o 系） | `reasoning_effort` | 原生支持 | ✅ 匹配 |
| OpenAI 非推理（4o/4.1） | 同上 | **不支持** | ⚠️ 宽容端点静默忽略 / 严格端点 **400 → 整轮终止**（4xx 不重试，`agent-core:1070`） |
| **Anthropic Claude** | 同上（**项目无任何原生适配**，只能经兼容网关） | 原生 `thinking:{type,budget_tokens}` | ❌ **原生 thinking 完全不发送**，思考强度不可控 |
| **DeepSeek** | 同上 | 官方兼容端点**不接受** `reasoning_effort`（思考由模型名 `deepseek-reasoner` 区分） | ❌ 下发即无效/报错 |
| **本地 Ollama `/v1`** | 同上 | 收 `options.*`，**不认 `reasoning_effort`**；qwen3 思考用 `/api/chat` 的 `think` 字段 | ❌ **静默丢弃** |
| **Worker/定时任务/编排组**（非流式） | `{model,messages,stream:false,tools,tool_choice}`，**无 reasoning_effort** | — | ❌ **完全丢失** |

**三个判定**：
1. ❌ **无能力门控**：`ModelSelector.jsx:141-150` 对**所有**模型都渲染思考强度选项，**未读 `caps.supportsReasoning`**（字段存在于 `modelsFile.js:68`）与 `caps.supportedEfforts`（`:69`）。四个能力字段（`supportsToolCall/supportsImages/supportsReasoning/supportedEfforts`）在 `modelsFile.js:64-71` 被解析、`diagExport.js:52-53` 被导出，但 **grep 显示无任何消费方用于参数门控** → **「UI 显示高、实际静默无效」的产品欺骗**。
   > **这是「能力门控必须与参数下发同源」这一范式的典型反例：声明的 capability 若没有参数下发处的消费方，就是装饰。**
2. ❌ **非流式通道完全丢失**：`scheduledChannels.js:76-80` 的 body 不含 `reasoning_effort` → Worker / 定时任务 / 编排组**恒为默认**。`decomposeTask`（`index.js:1045-1054`）的规划调用也完全不传。
3. ✅ **不存在「thinking token 计入 maxTokens 导致截断」的 bug** —— 因为**从不发送 `max_tokens`**。
   > ⚠️ **但这是「暂时安全」不是「设计安全」**：一旦为控制成本加上 `max_tokens`，Anthropic 的陷阱立刻生效——官方证实 `budget_tokens` 必须 ≥1024 **且 < `max_tokens`**，且 **thinking tokens 计入 `max_tokens`**。加 `max_tokens` 那天就是踩坑那天。
   > 反向缺陷：无 `max_tokens` ⇒ 输出长度完全由服务端默认控制；`finish_reason==='length'` 时续跑最多 3 次（`:1735-1740`），每次重发全量上下文 → **token 放大**。

### 6.5 上下文窗口与模型匹配 — ❌ 最危险的一处设计

> **本节两处更正记录**（诚实披露）：初版表格中 DeepSeek=64K、Qwen3-14B=32K 是成员的**推测值**，已被一手数据推翻。下方表格为更正后版本。**方向性结论不变，但根因表述变得更锋利**——见 §6.5.1。

#### 🔴 6.5.0 取值链路其实是断的（本次复核最重要发现）

> 初版审计画的是一条「通」的链路。独立复核（E 报告 E-1 条目）**证伪了这条链路**——手选窗口从未到达引擎。**这比单纯「默认值错了」严重得多，因为它意味着用户连自救的通道都没有。**

**真实链路（三处断裂，均已复核）**：

```
renderer/src/lib/modelConfig.js:62-65   effectiveContextWindow()
   │  ①  cfg?.context_window        用户手选（localStorage）
   │  ②  model?.context_window      模型自带
   │  ③  || 128000                  兜底
   ↓
   ✂️ 断裂 1：唯一消费者是 ChatArea.jsx:90 → 只喂 ContextRing 圆环 UI 显示
      **从不进入 payload.model**
   ↓
   ✂️ 断裂 2：useAgentRun.ts:520-522 构造 runModel 时
      只注入 reasoning_effort，**不注入 context_window**
   ↓
   ✂️ 断裂 3：agentRunner.js:167 是 `model: payload.model` **直接透传**
      **不调用 toAgentModel** → modelShape.js 的兜底在此路径完全不生效
   ↓
   引擎侧各自内联兜底：agent-core:724 / :1667 内联 `|| 128000`
                       入口裁剪 :1493 传 undefined → :820 兜底成 16000
```

**修正后的准确表述**：

> **主会话路径的生效窗口恒定 128000，用户在 ModelSelector 手选的窗口只影响圆环显示，救不了引擎。**

两点连带澄清：
- `modelShape.js:19` 的 `DEFAULT_CONTEXT_WINDOW=128000` 兜底**只覆盖** Worker（`workerPool.js:202`）/ 编排 / 定时任务路径；主会话路径走的是 `agent-core` 的内联 `|| 128000`。
- 两条路径**殊途同归到 128000**，所以「全路径净效果恒等于 128000」的结论仍然成立——但**修复方案必须分两条路都堵**（见 P0-1）。

> ⚠️ **对整改的直接影响**：只建 `modelWindows.js` + 改 `modelConfig.js:64` **是不够的**。必须**额外**在 `useAgentRun.ts:520-522` 补 `context_window` 注入接线，否则新映射表再准也永远进不了引擎——**这是一个「改了等于没改」的陷阱**。

**✅ 我亲自复核的三条硬事实**：

1. `renderer/src/lib/modelConfig.js:64` = `return cfg?.context_window || model?.context_window || 128000;` ✅ 确认
2. `main/modelShape.js:19` = `const DEFAULT_CONTEXT_WINDOW = 128000;` ✅ 确认
3. **全 `main/` 目录内 `context_window` 只出现在 `modelShape.js` 自身的注释与兜底逻辑里** → **没有任何 provider/model 数据源给它供过真实值**，`model?.context_window` 恒为 falsy → **生效值结构性恒等于 128000**

> **修正一处成员表述**：架构师原文写「`model.context_window` 疑似恒 undefined」。准确表述是——在主会话路径上确实恒 undefined（因为是直接透传），而 Worker/编排路径则被 `modelShape.js` 兜底成 `128000`。**口径要分路径说**，笼统讲「恒 undefined」或「恒 128000」都不准确。

**错配表**（压缩阈值 = 0.7 × 声明窗口 = **89,600**；真实窗口已按一手数据更正）：

| 模型 | 项目声明窗口 | 真实窗口（一手来源） | 判定 | 后果 |
|---|---|---|---|---|
| GPT-4o / 4.1 | 128,000 | 128,000 | ✅ 匹配 | 正常 |
| **deepseek-chat / reasoner（V3.2）** | 128,000 | **128,000**（一手更正；原推测 64K 有误） | ✅ 匹配 | 正常 |
| **Qwen3 8B / 14B / 32B** | 128,000 | **128,000**（一手更正；仅 0.6B/1.7B/4B 为 32K） | ✅ 匹配 | 正常 |
| Claude Sonnet（Anthropic API 直连） | 128,000 | **1,000,000**（Sonnet 5.5 属 1M 档） | ⚠️ 保守 7.8 倍 | 早压，**安全但严重浪费** |
| Claude Sonnet（AWS Bedrock） | 128,000 | **200,000**（该 provider 下 `sonnet` 解析为 Sonnet 4.5） | ⚠️ 保守 | 早压，浪费 |
| **GPT-5.6 / GPT-6 系** | 128,000 | **1,050,000** | ⚠️ 保守 8 倍 | 早压，浪费 8 倍窗口 |
| **Ollama 任意模型（默认 `num_ctx`）** | 128,000 | **2,048** ✅**一手坐实** | ❌ **极危险（64 倍）** | 压缩永不触发，根因链见 §6.5.1 |
| Ollama（设 `num_ctx=32768`） | 128,000 | 32,768 | ❌ 危险（2.7 倍） | 同上 |
| 用户手选「1M」 | 1,048,576 | 视模型 | ⚠️ 过高 | 永不压缩 **⚠️ 但见 §6.5.0：对引擎无效** |
| 用户手选「32K」 | 32,768 | 视模型 | ❠️ 取决于实际 | ❌ **当前不接线，选了也进不了引擎（§6.5.0）** |
| **未知 / 自填模型** | **128,000（默认）** | 任意 | ❌ **默认危险** | 无从分辨落在哪种错配 |

**✅ Ollama `num_ctx` 默认值 = 2048 的双源一手取证**（`github.com/ollama/ollama` 官方仓库）：
- 官方 FAQ（`docs/faq.md`）原文：*"By default, Ollama uses a context window size of **2048 tokens**."*
- 官方 **PR #8938** 源码 diff：新增 `ContextLength = Uint("OLLAMA_CONTEXT_LENGTH", 2048)`，把 `api/types.go` 硬编码的 `NumCtx: 2048` 改为读环境变量；附单元测试 `TestContextLength` 断言 `""` → 2048、`"4096"` → 4096。

> **这是整改最直接的抓手**：`OLLAMA_CONTEXT_LENGTH` 是服务器级默认值覆盖变量。正确做法 = 显式设置它 **+** 运行时读取实际生效的 `num_ctx`，而不是硬编码假设窗口。

#### 6.5.1 ⭐ 根因升级：不是「值错了」，是「无法分辨自己处在哪种错配」

更正后的表格暴露出一个**比原判断更严重**的事实——同一张表里同时存在两个**方向相反**的错配：

- **声明 < 真实**（Claude Sonnet 1M、GPT-5.6 1.05M vs 声明 128K）→ 早压 8 倍，**浪费但不危险**
- **声明 > 真实**（Ollama 2048 vs 声明 128K）→ 压缩永不触发，**直接击穿**

而 MJCode **就一个 128000 兜底值，无从分辨自己落在哪一侧**。

> **根因链（建议作为结论性表述）**：
> 声明 128,000 → 真实可用 2,048（Ollama `num_ctx` 默认）→ 压缩阈值按 128,000 × 0.7 = **89,600** 计算 → **永远触不到 2,048 的实际上限** → 压缩永不触发 → 上下文直接击穿
>
> **这条比「值错了」锋利得多**：即使把 128,000 改成某个「正确」的 128K，问题也不会消失——**只要不读运行时实际值，窗口映射就永远只是猜测**。

#### 6.5.2 ⭐ 方法论层面的发现：按别名查窗口本身就是错的

跨 provider 别名解析差异，**其重要性超过窗口值本身**：

| 提供商 | `opus` | `sonnet` | `haiku` |
|---|---|---|---|
| Anthropic API | Opus 5.5 | Sonnet **5.5**（1M 档） | Haiku **5.5** |
| Claude Platform on AWS | Opus 5.5 | Sonnet **4.6** | Haiku 4.5 |
| Amazon Bedrock / GCP | Opus 5.5 | Sonnet **4.5**（200K 档） | Haiku 4.5 |
| Microsoft Foundry | Opus **4.6** | Sonnet 4.5 | Haiku 4.5 |

同一个字符串 `sonnet`：Anthropic API = Sonnet 5.5 = **1M**；Bedrock = Sonnet 4.5 = **200K**，**差 5 倍**。

→ **正确链路必须是**：`别名 + provider → 解析成具体 model ID → 查该 ID 的窗口`。**任何跳过 provider 维度的窗口映射，在多云/网关场景必然错配**——这对 MJCode 这种「用户自填 baseUrl 接任意网关」的形态尤其致命。

#### 6.5.3 为什么这是最危险的一处

- 窗口**被高估**时：0.7 阈值**永不触发**，所有「优雅压缩」逻辑全部失效，唯一防线是捕获 400 后的**一次**强制压缩（`agent-core:1603-1608`），第二次超限直接终止。
- 窗口**被低估**时：只会在 89,600 提前压缩——浪费但安全。
- **两种错误的代价严重不对称，而项目默认落在代价大的那一侧。**
- 项目**已有 Ollama 探测**（`main/resourceQuotaCenter.js:127-142`），但只取 `{ollama: bool, models: n}`，**不读 `num_ctx`** —— **探测能力是有的，只是没用来解决这个最致命的错配。**
- UI 侧 `ModelSelector.jsx:151-161` 有窗口选择器，但默认「跟随默认」走 128000 兜底，**无任何「未确认窗口」警示**。
- ⚠️ **对比参照**：Claude Code 对未识别模型会**显式 warn**「context assumed to be 200k」——**告警比沉默便宜**。MJCode 连这一步都没做。

### 6.6 任务-模型分档 — ❌ 未做

全循环（主推理 / 压缩摘要 / 任务拆分 / 子代理 / Worker）**共用同一用户选定模型**（`agent-core:1587/779/1053/1857`；`workerPool.js:202`）。`ecosystem.js:23` 的 `fast/standard/reasoning` 三档枚举**未用于任何路由**——是**没有消费方的空枚举**（与 §6.4 的 caps 空转同型问题）。

其中**压缩摘要是典型的「用大炮打蚊子」**：项目已给它独立的 180s 超时与独立降级链，却没给它独立档位。

**但必须同时说反面（避免盲目建议）**：本项目是「用户自带 provider」的单机桌面应用，典型用户只配 1~2 个 provider。**强制分档会引入「用户没配便宜模型 → 功能不可用」的风险**。正确形态是：
- 设置页提供「摘要/拆分用较便宜模型（**可选**）」选择器；
- 未配置 → **回落主模型**（现状行为不变，零破坏）；
- 配置了 → 该步骤走 override。

---

## 7. 设计建议（可执行）

### 7.1 P0 — 不改则有确定性故障

| # | 改进 | 落点 | 建议值 / 做法 |
|---|---|---|---|
| **P0-1** | **打通窗口接线 + 建 model → contextWindow 映射 + 主动探测，默认改为保守值** | ① **新增** `renderer/src/hooks/useAgentRun.ts:520-522`（补 `context_window` 注入，**当前缺失，是全部前提**）② 新建 `desktop/main/modelWindows.js` ③ `renderer/src/lib/modelConfig.js:64` ④ `main/modelShape.js:19` ⑤ `agent-core/index.js:724/1667` 内联兜底 | · **① 是最关键的一环**：`effectiveContextWindow` 目前只喂 `ChatArea.jsx:90` 的圆环 UI，不进 `payload.model`；不先接线，映射表再准也进不了引擎（§6.5.0）<br>· ② 映射键必须是 **`(provider, modelId)` 二元组**，不能只用别名——同一 `sonnet` 在不同 provider 下窗口差 5 倍（§6.5.2）；覆盖：`deepseek V3.2 → 131072`、`gpt-4o/4.1 → 128000`、`claude-* → 200000 或 1000000（按 provider）`、`qwen3 ≥8B → 131072`、**`ollama:* → 运行时 num_ctx`**<br>· ③ **默认兜底改 32768**（从 128000 下调：低估只浪费、高估直接击穿，代价不对称）<br>· ④ 扩展 `main/resourceQuotaCenter.js:127-142` 的 `detectLocalBackend`，对 Ollama 调 `GET /api/show?name=<model>` 读 `parameters.num_ctx` / `model_info.*.context_length`；并提示用户设置 **`OLLAMA_CONTEXT_LENGTH`**（官方 PR #8938 的服务器级覆盖变量）<br>· ⑤ `agent-core` 的两处内联 `|| 128000` 与 `:820` 的 `16000` 改为引用统一常量，消除散落兜底 |
| **P0-2** | **用 provider 真实回传反推窗口，不等 400** | `agent-core/index.js:724/1493/1667` 前置 | 新增 `effectiveWindowOf(declared, lastPromptTokens)`：若 `lastPromptTokens > declared × 0.95` → 修正 effectiveWindow 为 `ceil(lastPromptTokens/0.7)` 并立即 force 压缩一次。比现有 `contextRescued`（只救一次且只在 catch 里）更早更可靠 |
| **P0-3** | **思考强度：非流式通道补齐 + 能力门控** | ① `main/scheduledChannels.js:76` ② `agent-core/index.js:1045-1054` ③ `renderer/src/components/ModelSelector.jsx:141-150` | ① body 补 `if (payload.reasoningEffort) body.reasoning_effort = payload.reasoningEffort;`<br>② `decomposeTask` 的 chatFn 补传<br>③ UI 读 `caps.supportsReasoning` / `caps.supportedEfforts`，不支持时禁用选项并提示「该模型未声明支持 reasoning_effort，已不下发」 |
| **P0-4** | **编排等待超时后必须 abort 组** | `main/main.js:850-852` | 与 `waited.aborted` 分支（`:846`）对齐，补 `workerPool.abortGroup(plan.groupId)` |
| **P0-5** | **MCP 凭证治理**：① 配置文件 chmod 0600 ② 落盘走 `sanitizeEnv` 而非原始 env ③ 修 `sanitizeEnv` 展开顺序（用户 env 不得覆盖白名单） ④ 消费 `mcp_status` 增补「已崩溃」第五态 + 自动重连 | `main/ipc/mcp.js:112-115/93/121-125`、`main/data/durableWrite.js:43,89`、`AgentDock.jsx:78-79` | 对齐 `mcpAuth.js:67` 的 0600 正例；长期建议凭证入系统钥匙串 |

### 7.2 P1 — 特定条件下故障 / 明确损失

| # | 改进 | 落点 | 做法 |
|---|---|---|---|
| **P1-1** | **补齐「整任务墙钟预算」这一层** | `agent-core/index.js`（新增常量 + 循环顶部检查，靠近 `:1552`） | `DEFAULT_RUN_WALL_CLOCK_MS = 30*60*1000`；超时走 `onSuspend({kind:'wallclock'})` + 收尾 + `emitRunEnd` |
| **P1-2** | **统一三层不一致的超时数字** | `main/tools/exec.js:68`、`main/webTools.js:19`、`agent-core:1114-1116` | shell：引擎显式下发 480000 或 exec 默认提到 480000，`TOOL_TIMEOUT_OVERRIDES.shell` 保持 600000 作看门狗；web_fetch 实现侧 15000 → 30000 |
| **P1-3** | **压缩加重写记账 + 重写次数预算** | `agent-core/index.js`（`compactHistory` 内 + `onBudget` `:1655-1660`） | `rewriteLedger = {count, recomputeTokens}`；`onBudget` 增 `rewrites` 字段；`MAX_REWRITES_PER_RUN = 5`，超过只走硬截断 |
| **P1-4** | **稳定前缀区：把可变内容下沉出头部** | `agent-core:1360-1437`、`:1572-1574`、`:789` | 顺序改为 `[BASE_PROMPT(恒定)] → [角色(每 run 定)] → [工具表]`；把 `[记忆][技能][AGENTS.md][断点][摘要]` 统一拼到 system **末尾**；`renewNotice` 挂到最后一条消息之后。<br>⚠️ 注意 DeepSeek 只认首部 system（`:745-746`），改动需跑该端点回归 |
| **P1-5** | **入口裁剪不要每次都砍** | `agent-core:1493` | `targetRatio` 提到 0.45 以上，或仅在 `beforeTokens > 0.7×window` 时才裁 |
| **P1-6** | **技能按需加载（渐进式披露）** | `agent-core:1371-1386`、恢复 `ecosystem.js:119-129` 丢弃的 `when_to_use` | 先只注入 name+description 摘要层（154 技能 → 约 1.5 万 tokens），模型选中后再注入正文；**保留现有 `guardUntrusted` 检测** |
| **P1-7** | **数字员工：补 create 通道 + RBAC + `system_prompt` 注入检测** | `ipc/ecosystem.js:178/208`；新建 RBAC 模块；`agent-core:1363-1365` | 让「数字员工」从只读生态资产变成可创建的产品实体；`system_prompt` 走 `guardUntrusted`（对齐技能/AGENTS.md/记忆三处已有做法） |
| **P1-8** | **MCP 升级到 2025-11-25 + 能力协商落地 + 补 *negotiate* 能力** | `mcpClient.js:23/402-404/359`、`mcpAuth.js:244` | 版本号常量单点化（消掉 mcpAuth 的硬编码副本）；接收 `initialize` 返回值并据 `capabilities` 决定可用能力集；实现 `onNotify`；优先补 resources / prompts / 取消 / 进度四项高频能力 |
| **P1-9** | **UI 原语层：抽 `<Switch>` / `<Modal>` / `<Button>` / `<Input>`** | 新建 `renderer/src/components/ui/`（**必须 `.tsx`**） | `<Modal>` 内建 `role="dialog"` + `aria-modal` + 焦点陷阱 + 焦点归还 + Esc + `aria-live="polite"`；消灭 7 处重复开关与 `left-[22px]` 魔法数字 |
| **P1-10** | **把第三方 MCP 工具纳入角色裁剪** | `agent-core:1462` | 当前 MCP 工具不受 `toolNames` 裁剪 → 角色隔离被绕过 |
| **P1-11** | **任务-模型分档（可选 + 回落）** | 新增 `engineParams.modelOverrides`；`agent-core:779`、`:1053`、`workerPool.js:202` | 未配置回落主模型，保证零破坏 |
| **P1-12** | **窗口未确认时 UI 明确警示** | `ModelSelector.jsx:151-161` | 当 caps 无窗口信息且未手选时，label 显示「未确认（按 32K 计算）」并提供一键校正入口 |

### 7.3 P2 — 体验与效率

| # | 改进 | 落点 | 建议值 |
|---|---|---|---|
| P2-1 | 同轮内只读工具并行（写工具保持串行） | `agent-core:1769` | 只读并发上限 **4** |
| P2-2 | 首字节延迟可观测 | `streamGuard.js` + `agent-core:1591-1596` | 增加 `ttfbMs` 进 `onBudget` 与 trace；目标 **≤ 3000ms** |
| P2-3 | 压缩摘要加硬长度约束 | `agent-core:771-782` | 收到后 `slice(0,2000)` 并校验四段式（缺段则补） |
| P2-4 | 激进告警门槛下调 | `agent-core:731`/`:785` | 0.85 → **0.80**，0.70~0.80 区间注入轻量「历史已裁剪」提示 |
| P2-5 | 布局收敛 | 全局 className | padding 4 档 + 圆角 3 档（见 §3.4-4） |
| P2-6 | 拆 `SettingsModal.jsx`（1084 行） | 新建 `settings/` 子目录 | 对齐 800 行门禁 |
| P2-7 | L 层「执行后告知」补独立档位 | `approval.js` | 目前只有审计留痕，不是可选择的治理档 |
| P2-8 | 工具回执回查业务事实 | V 层相关 | 至少对 `write_file` / `git_commit` 做权威状态核对 |

### 7.4 建议实施顺序

```
第一批（止血，1 周内）：P0-1 / P0-5 / P0-3 / P0-4   ← 窗口标定 + 凭证 + 思考强度 + 编排泄漏
第二批（补牢，2–3 周）：P1-6 / P1-7 / P1-8 / P1-1   ← 技能按需加载 + 数字员工 + MCP 升级 + 墙钟预算
第三批（治理，3–4 周）：P1-3 / P1-4 / P1-9 / P0-2   ← 重写记账 + 前缀稳定 + UI 原语 + 窗口反推
第四批（战略）：V 层评估接口落地  ← 把 eval/run-eval.mjs 接进运行链路
```

> **最后一批才是决定性的**：前四批都在修「做得对不对」，第五批才解决「**怎么知道做对了**」。在 V 层落地前，前四批的正确性只能靠人肉验证兜底。

---

## 8. 审查的诚实边界

以下事项**未在本次审查中证实**，不应据本文推断它们已解决：

| # | 未知项 | 状态 |
|---|---|---|
| 1 | **mimo 真实上下文窗口与 `reasoning_effort` 支持度** | ❓ 未从代码/本次可获资料判定 |
| 2 | **各厂商上下文窗口的准确值** | ⚠️ 表中「真实窗口」列**按公开资料填列，需联网复核**（不同 API 版本/部署配置会变）。错配的**方向性结论**（128K 兜底危险）不依赖这些精确值。 |
| 3 | **CUA（Computer Use）统一审批通道是否已完成接线** | ❓ `approval.js:314-327` 注释称「此分支供统一通道接线后直接复用」，未验证 |
| 4 | **`decomposeTask` 调用无硬超时** | ❓ 无 externalSignal → 总时长层被禁用（`main.js:596`） |
| 5 | **`server/` / `miniprogram/` / `ecosystem/` 子产品** | ❓ 未覆盖；单机结论基于 desktop 主链路 |
| 6 | **记忆召回相似度阈值与度量空间绑定** | ❓ `db/index.js:92` 注释提及双路召回，未找到阈值常量 |
| 7 | **`allowed-tools` 字段 / `progressive disclosure` 术语** | ⚠️ **待核** —— Anthropic 官方 README 未出现 `allowed-tools`；正式规范站点 `agentskills.io` 本轮未抓取正文。all ignores: 官方证实的是 **`name` + `description` 两个必需字段** 与 「loads dynamically」机制描述 |
| 8 | **Codex CHANGELOG 未逐条通读** | ⚠️ 版本号以仓库统计为准（最新提交 2026-10-17，12,326 commits） |
| 9 | **`developers.openai.com` 全站 403、部分 Claude 文档跳地区页** | ⚠️ 已改走官方 Rust schema 源码与仓库交叉验证 |
| 10 | **A/B 两份报告中除本文引用外的其余结论** | ⚠️ 抽样复核已完成：**38 条复核条目属实率 86.8%**，锚点抽查 52 个**零错位**；1 条不成立已据以重写 §6.5（见附录 A-2） |
| 11 | **D 报告未做交叉复核** | ⚠️ 复核执行者触发平台频率限制而中止。D 视为「一手来源 + 未交叉验证」，仅用于对标参照，不用于判定代码缺陷 |
| 12 | **架构师任务在修订阶段被平台频率限制中断** | ⚠️ A/B 两份产出**已完整落盘并已应用其修订**（含 DeepSeek/Qwen 窗口更正、L 层判定下调），中断发生在补充说明环节，不影响已落盘结论 |

---

## 附录 A：本次独立复核记录

**主理人亲自执行、不依赖成员自述的验证**（✅ = 结论证实）：

| # | 验证项 | 方式 | 结果 |
|---|---|---|---|
| 1 | 默认上下文窗口 128000 | 读 `renderer/src/lib/modelConfig.js:64` | ✅ `cfg?.context_window \|\| model?.context_window \|\| 128000` |
| 2 | `DEFAULT_CONTEXT_WINDOW` 兜底 | 读 `main/modelShape.js:19,51-52,68` | ✅ = 128000，**修正**成员「恒 undefined」表述为「恒等于 128000」 |
| 3 | 无 model→window 映射表 | grep 全 `main/` 的 `context_window` | ✅ 仅出现于 `modelShape.js` 自身 → 无数据源供给，证实错配 |
| 4 | MCP 协议版本 | 读 `main/mcpClient.js:23` | ✅ `'2024-11-05'` |
| 5 | `initialize` 返回值丢弃 | 读 `main/mcpClient.js:400-406` | ✅ `await mcpRpc(...)` 无赋值；`capabilities: {}` |
| 6 | `onNotify` 恒 null | 读 `main/mcpClient.js:359/71` | ✅ 初始化 null 且全仓无赋值 |
| 7 | MCP 配置写入原始 env | 读 `main/ipc/mcp.js:112-115` vs `:85-94` | ✅ **落盘是未过白名单的原始 env**（比成员报告更严重） |
| 8 | MCP 配置文件权限 | `stat` + `node` 解析 `$HOME/Library/Application Support/mj-code-desktop/mcp-servers.json` | ✅ **0644** 全域可读；tavily 服务 env 内含明文 `TAVILY_API_KEY`；11 个已配服务 |
| 9 | i18n 零硬编码 | 跑官方门禁 `node scripts/i18n-scan.mjs renderer/src` | ✅ `裸中文残留：0（通过）` |
| 10 | UI 重复实现 | `grep -ro '<button'` / `grep -rn 'left-\[22px\]'` | ✅ **303** / **7**，与成员统计**完全一致** |
| 11 | 打转检测与超时常量 | 读 `agent-core:1258/1110-1119`、`streamGuard.js:23-27` | ✅ 120 轮；90s/300s/900s 三层守卫 |
| 12 | 技能注入有安全检测 | 读 `agent-core:1371-1380` | ✅ 有 `guardUntrusted`（`maxChars:6000`），**修正**「裸注入」印象：痛点是规模非安全 |
| 13 | 数字员工 prompt 无注入检测 | 读 `agent-core:1363-1365` | ✅ 确认绕过（对比 `:1373/:1402/:1420` 三处都做了） |

> **核查过程的方法论教训**：第 8 项第一次用**区分大小写**正则扫凭证字段，**返回空**，险些误判成员结论有误；改用 `-oiE` 后立刻命中。
> 判定「不存在」是全称命题，**必须换一种按目标特征构造的模式再扫一次**才能背书。

---

## 附录 A-2：交叉复核结果（E 报告）

A/B/C/D 四份产出完成后，由**编码工程师**对**非自己产出的 A / B / D** 做交叉复核；C 由主理人亲自抽验（附录 A）以避免自证。

### 复核统计

| 指标 | 结果 |
|---|---|
| 复核条目 | 38 条 |
| ✅ 属实 | **33 条（86.8%）** |
| ⚠️ 需修正 | 4 条（方向不变，仅口径/行号） |
| ❌ 不成立 | **1 条** |
| 锚点抽查 | 52 个 `文件:行号`：**错位（≥2 行偏差）0 个**，轻微偏移（1 行）2 个 |
| ❓ 未知区标注规范性 | A §9 共 9 条、B §8 共 6 条，**全部明确写「未找到/未验证/需复核」**，未发现把未知写成确定结论 |

### ❌ 唯一「不成立」的一条（本报告已据此重写 §6.5）

> **B §5.1「生效值 = 用户手选，否则一律 128000」不成立。**
> 链路在三处断裂：`effectiveContextWindow` 唯一消费者是 `ChatArea.jsx:90` 的圆环 UI（从不进 `payload.model`）→ `useAgentRun.ts:520-522` 只注入 `reasoning_effort` → `agentRunner.js:167` 直接透传、不调 `toAgentModel`。
> **正确表述：主会话路径生效窗口恒为 128000，用户手选只影响圆环显示，救不了引擎。**（已写入 §6.5.0，并据此升级 P0-1）

**这条复核的价值**：它把问题从「默认值设错了」升级为「**用户连自救通道都没有**」，并直接改变了整改方案——原 P0-1 方案**只改映射表是不够的**，必须先补 `useAgentRun.ts:520-522` 的接线，否则属于典型的「改了等于没改」。

### ⚠️ 另外 3 条口径修正（结论方向均不变）

| # | 原文 | 更正 |
|---|---|---|
| E-2 | A 称 `main/` 下命中 3 个文件含 `approvalPolicy.js` | 实测 **2 个**，`approvalPolicy.js` 零命中（「无独立评估者」结论不变） |
| E-3 | 技能 `maxChars: 6000` 在 `agent-core:1376` | 实为 **`1377`**（1 行偏移） |
| E-4 | `execGovernance.js` 函数体 `:10-16` | 实为 **`:11-17`**（1 行偏移，内容无误） |

### ⚠️ 一条影响后续所有审计的工具警示

> **本环境 bash `grep` 不支持 BRE 的 `\|` 选择符，会静默返回 0 命中（假阴性）。**
> 复核中实测踩到两次：`grep -rn "verify\|evaluat\|judge" main/` → 0（假），改 `-E` → 4 行；`grep -rn "context_window\|contextWindow" renderer/src/` → 0（假），改 `-E` → 8 行。
> A/B 中依赖此类 grep 的「无命中」结论已全部用 `-E` 重跑，**结论方向不变**（整任务墙钟预算确实未找到、V 层确实无评估者）。
> **建议：本项目所有审计脚本统一用 `grep -E`，否则「0 命中」不可信。**

### ❌ D 未二次复核（如实披露）

D（CodexApp 对标与主流实践基线，938 行）**未纳入交叉复核**——复核执行者在开始前触发平台频率限制而中止。
因此 D 的外部事实应视为**「一手来源 + 未交叉验证」**。本报告已在 §8 与 §4.3 标注其可信边界；由于 D 结论仅用于**对标参照**（不用于判定项目代码缺陷），风险可控。**但若要据此做重大产品决策，建议先补一次 D 的复核。**

---

## 附录 B：产出物清单

本次审查的完整证据产物（保留在 `/Users/jianma/Desktop/MJCode/.audit-2026-10-18/`，已加入 .gitignore）：

| 文件 | 行数 | 产出方 | 内容 |
|---|---|---|---|
| `A-H框架六层与范式P合规审查.md` | 462 | 架构师 | H=(E,T,C,S,L,V)+P 逐层、逐条必答问题的合规裁定 |
| `B-对话Agent全流程设计审查.md` | 415 | 架构师 | 环节链路、时间控制、压缩、思考强度、窗口匹配、分档 |
| `C-技能数字员工MCP对接与UI代码取证.md` | 895 | 编码工程师 | 技能/数字员工/MCP 对接取证 + 界面设计风格代码事实 |
| `D-CodexApp对标与主流实践基线.md` | 822 | 研究员 | Codex 官方 Rust schema 一手基线 + MCP/Skills/压缩/思考强度主流实践 |
| `E-独立验证报告.md` | 待出 | 编码工程师（复核他方产出） | A/B/D 的锚点与结论可复现性验证 |

> E 报告采用**交叉复核**：编码工程师不复核自己产出的 C，C 由主理人亲自抽验（见附录 A）。此分工避免自证。

---

## 附录 C：知识底座编译报告

本轮沉淀的可复用知识已编译进项目知识底座 `/Users/jianma/Desktop/MJCode/.wiki-creator/`（显式 `--root`，未使用全局根，避免与其它专家共用污染）。

**新建主题（待管家节点确认）**：

| slug | 名称 | 页数 | 内容 |
|---|---|---|---|
| `agent-harness-arch-patterns` | Agent Harness 架构模式 | 6 | 兜底默认值方向、能力门控同源、能力枚举是透传容器、流式超时用动静、压缩切点按轮、L 层两台阶、前缀重写记账 |
| `audit-methodology` | 审计与复核方法论 | 4 | 「不存在」是全称命题、grep BRE 假阴性、交叉复核回避利益冲突、外部对标警惕 fork 旧快照 |

**新增页面（10 页）**：
- `prefix-default-on-low-cost-side`、`capability-gate-must-share-source`、`streaming-timeout-motion-not-total`、`compaction-cut-at-round-boundary`、`l-layer-two-maturity-steps`、`prefix-rewrites-must-be-accounted`
- `audit-absence-is-universal-proposition`、`audit-grep-bre-false-negative`、`audit-cross-review-conflict-of-interest`、`audit-external-fork-snapshot-trap`

**编译结果**：

| 指标 | 值 |
|---|---|
| 页面数 / 已索引 | 10 / 10 |
| 主题数 | 2 |
| 反向链接 | 23 |
| 悬空链接 | **0** |
| 不合规链接 | **0** |
| 重复 slug | **0** |
| 孤儿页 | **0** |
| `missing_cross_refs` | 8 页（同主题未完全互链，**建议级非错误**，不阻塞） |

**待管家节点裁决**：
1. 上述 2 个主题的边界划分是否符合预期（尤其「外部产品版本时序事实」被显式排除在底座之外，只现查一手来源）；
2. 是否同意保持「缺陷清单不入长期底座」的原则（避免一次性结论污染知识库）。

---

## 附录 D：问题真实性复核（2026-10-18 二次抽验，主理人亲验）

> 本附录回应「报告中的问题是否真实存在」的核查要求。逐条重读当前工作区源码（代码面与 `669ef5e` 一致），**全部 21 条 P0/P1 问题断言属实，锚点准确，未发现编造**。

| # | 报告断言 | 锚点 | 复核 |
|---|---|---|---|
| P0-1a | 手选窗口只喂圆环 UI、不进 payload | `ChatArea.jsx:89-92` `contextUsageOf(messages, effectiveContextWindow(...) \|\| 128000)` | ✅ 属实 |
| P0-1b | runModel 只注入 reasoning_effort | `useAgentRun.ts:518-521` | ✅ 属实 |
| P0-1c | agentRunner 直接透传 | `agentRunner.js:168` `model: payload.model` | ✅ 属实 |
| P0-1d | 引擎内联 128000 兜底 | `agent-core/index.js:724/1667` | ✅ 属实 |
| P0-3a | 非流式 body 无 reasoning_effort | `scheduledChannels.js:76` `{model,messages,stream:false}` | ✅ 属实 |
| P0-3b | UI 不读 caps | `ModelSelector.jsx:140-148`（`getReasoningOptions()` 无条件渲染） | ✅ 属实 |
| P0-3c | caps 字段存在但无消费方 | `modelsFile.js:64-71` | ✅ 属实 |
| P0-4 | 编排超时只返 error 未 abort | `main.js:851-853`（对比 `:845-850` aborted 分支有 abortGroup） | ✅ 属实 |
| P0-5a | 落盘写原始 env | `ipc/mcp.js:113-115` | ✅ 属实 |
| P0-5b | sanitizeEnv 用户 env 可覆盖白名单 | `ipc/mcp.js:93` `{...out, PATH, ...(env)}` | ✅ 属实 |
| P0-5c | 配置文件 0644 | `stat mcp-servers.json` → `-rw-r--r--` | ✅ 属实 |
| V | 终止=模型不再调工具 | `agent-core/index.js:1733-1758` | ✅ 属实（有轻量守卫，见说明 1） |
| V | eval 未接入运行链路 | `grep -rE "eval/" main/ agent-core/ renderer/src/` 零引用 | ✅ 属实 |
| P1 | 技能全量注入无渐进披露 | `agent-core/index.js:1371-1378` | ✅ 属实（有 guardUntrusted，见说明 2） |
| P1 | when_to_use 被丢弃 | `ecosystem.js:119-129` 返回字段无 `when_to_use` | ✅ 属实 |
| P1 | 数字员工 systemPrompt 无注入检测 | `agent-core/index.js:1364` 直接 `.slice(0,12000)` 拼接 | ✅ 属实 |
| P1 | MCP 协议停 2024-11-05 | `mcpClient.js:23` | ✅ 属实 |
| P1 | initialize 返回值丢弃 + capabilities 空 | `mcpClient.js:402/404` | ✅ 属实 |
| P1 | onNotify 恒 null | `mcpClient.js:359/71` | ✅ 属实 |
| P1 | 缺 resources/prompts/sampling 等 11 项能力 | 4 文件 `grep -cE` 全部 = 0 | ✅ 属实 |
| P1 | 无整任务墙钟预算 | `grep -rE "wallclock\|WALL_CLOCK\|RUN_WALL"` 无命中 | ✅ 属实 |
| P1 | fast/standard/reasoning 空枚举 | `ecosystem.js:23`（`:32` 仅校验，无路由消费） | ✅ 属实 |

**三处精确化说明（非错误，是口径校准）**：

1. **「比自评更弱」是修辞，可更严谨**：终止分支实际带两个轻量守卫——`finish_reason==='length'` 续跑（≤3 次，`:1734-1739`）与空响应续跑守卫（`EMPTY_FINAL_NUDGE_MAX`，`:1743-1749`）。核心事实「无独立评估者、完成判定由『模型停止调工具并输出文本』决定」**准确**；「比自评更弱」宜改为「**无显式完成自评，仅靠停止信号 + 轻量续跑守卫兜底**」。
2. **「技能全量注入」准确，但非裸注入**：`index.js:1371-1378` 每个技能都过 `guardUntrusted`（`maxChars:6000`）并命中即拒绝留痕。报告正文已准确表述（「痛点是规模非安全」），标题措辞「无渐进式披露」成立。
3. **数字员工「不可创建」**本轮未重验 `ipc/ecosystem.js:178/208`，但已有 coder 取证与 E 交叉复核双重覆盖，且不影响「只读生态资产」的主要结论。

**结论：报告所断言的问题全部真实存在，无一条是编造或夸大锚点。** 唯一可改进的是 V 层措辞的严谨度（见说明 1），核心判定不变。

---

*本报告由 Agent Harness 专家团（架构师 / 编码工程师 / 研究员 / 主理人复核）出具。所有结论可在 `669ef5e` 上一一复现；未证实项已在 §8 明确标注，请勿据「报告写了」推断「已验证」。*
