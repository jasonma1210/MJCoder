# MJCode Agent Harness 第六轮全量审查报告（2026-10-19）

> 审查角色：Agent Harness 专家团（执行安全 / 上下文经济 / 记忆体系 / 编排 / 协议 / 端到端流程 / 前端交互 / 工程质量）
> 方法论：**先读当前代码，再下结论**。凡标「已确认」均有 `file:line` 取证；无法当场取证的一律标「待核实」。
> 视角基线：**非云端 · 本地优先桌面 Agent**（对标 Codex Desktop 非云版 / Trae Work 本地态 / WorkBuddy 本地态 / Lobster AI）。
> 范围：`desktop/`（Electron 主进程 `main/` + React 渲染层 `renderer/` + headless 引擎 `agent-core/index.js`）、`ecosystem/`、`server/`（可选）。
> 口径纪律：**不沿用任何旧报告结论**；旧报告说「缺」而当前代码已补的一律改判并附证据。

---

## 0. 一句话结论

**第五轮 10 项残差中 3 项已闭合（G1 装配 / G5 裁定消解 / G10 技能总量），4 项仍未动（G2 / G7 / G9 / G11），3 项沿用未取证。**

本轮另**新识别 11 项缺口**（其中 3 项 P0/P1 级、均为「第 5 轮之后的改动与新代码」暴露出来的）与 **7 项端到端流程问题**。

核心判断：**能力面（执行 / 治理 / 闭环）已完整，短板集中在「门禁真实性与可达性」**——
① G1 视觉输入已接线，但门控位没有任何 UI 入口，除手改 `~/.mjcode/models.json` 外**事实不可达**；
② G2 高权限 MCP 仍默认随启动全量重连，与项目硬约束「高权限默认不启动」正面冲突；
③ 三项工程门禁是「假绿」：lint 允许 9999 warning、CI 语法门禁只 `node --check` 8 个写死的文件、eval 完全不进 CI。
**无一项会阻断核心能力闭环，但都会让后续改动缺少真实护栏。**

---

## 1. 基线锚定（本报告数字的唯一口径）

| 项 | 值 | 取法 |
|---|---|---|
| 版本 | `v0.6.1-beta` | `desktop/package.json:2` |
| 当前提交 | `7e62a61`（本地领先 `origin/main` 4 个提交） | `git log --oneline` |
| **工作区状态** | **未提交 27 项**（21 改 + 6 新增，+1530 / -104） | `git status --porcelain`、`git diff --stat` |
| 引擎 | `agent-core/index.js`（headless、零 Electron 依赖） | `ls -la` |
| 主进程 | `desktop/main/` 约 100 个模块（含 9 个 `ipc/*`） | `ls main/`、`ls main/ipc` |
| 渲染层 | `renderer/src/components` + `pages` + `hooks` | `ls` |
| 测试基线 | `desktop/test/` **221 套件** | `ls test \| wc -l` |
| 源码 TODO/FIXME | **仅 1 处**（且是实现待办，非缺陷） | `EcosystemModal.jsx:11` |
| 构建期门禁 | lint / typecheck / syntax / CI（见 §5） | `package.json:21`、`.github/workflows/ci.yml` |

**未提交改动 = 三层记忆 M0~M4**：`main/memory/index.js`、`memory/scorer.js`、`memory/bgScheduler.js`、**新增** `memory/memoryFile.js`、`main/ipc/localData.js`、`agentRunner.js`、`ChatArea.jsx`、`useAgentRun.ts`、`MemorySection.tsx`、i18n 双语言包、**新增** 5 个 `memory-*.test.mjs` / `.test.js`。

> **口径提示**：本报告的「当前实现」= **HEAD + 工作区未提交内容**（因为三层记忆是本轮最重要的在研功能）。凡涉及发布结论时必须记住：**已发布的 v0.6.1-beta 不包含这些改动**。

---

## 2. 第五轮缺口 → 当前状态逐条复核

| 第五轮编号 | 缺口 | 当前裁定 | 证据（本轮取证） |
|---|---|---|---|
| **G1** | 多模态视觉输入未接入主对话通道 | 🟡 **装配已闭合，但门控不可达** | 已闭合部分：`lib/visionInput.ts:29-51`（按 `supportsImages` 读图 → `image_url` data URL 部件）、`useAgentRun.ts:367-370`（`runUserMsg = { role:'user', content:[{type:'text'}, ...imageParts] }`）、装配门禁 `test/vision-input-wiring.test.mjs`（16 断言）。**未闭合部分见 N1** |
| **G2** | MCP 三层分级 / 懒启动默认未生效 | ❌ **仍未修（确认）** | `mcpPrewarm.js:82-85`（`isLazyMode` 缺省一律 false）、`ipc/mcp.js:351-353`（`const config = lazy ? autoStartConfigs(...) : all`）→ **非懒启动时 11 个已保存服务（含 desktop-commander / playwright 等高权限）仍随启动全量 spawn**。新增的 `intentMcPrewarm`（`agentRunner.js:115-154`）只做「按意图补差连接」，**不能替代「默认不启动」** |
| **G5** | 原生 extended thinking 未发送 | ⚪ **裁定为「不适用」** | 项目**无原生 Anthropic `/v1/messages` 传输通道**：`visionInput.ts:6-7` 注释明确「本项目全部走 `/chat/completions`，无原生 Anthropic 传输」。故「按 provider 分流 `thinking` 段」无落点；风险仅剩「能力位缺失时仍下发 `reasoning_effort`」——`ModelSelector.jsx:10-11` 的「能力未知不门控」保留了这一缺口（见 N1） |
| **G6** | MCP `sampling`/`elicitation` 未实现 | ⚪ **维持设计性非目标** | 显式 `-32601`，不静默（`mcpProtocol.js:38-40`）。**建议保持拒绝**，无需投入 |
| **G7** | UI 原语层未收敛 | 🟡 **改善但仍在爬坡** | 基线 `test/ui-conventions.test.js:20` `rawButton:260`；本轮实测裸 `<button>` **265 处 / 52 文件**（`grep -rIo`）。4 轮收敛合计 ≈ 从 281 → 260（**约 -21 处**），**收敛速度约 1~2 处/轮** |
| **G9** | MCP 工具披露顺序不稳定 | ❌ **仍未修（确认）** | 顺序 = 主进程返回顺序：`renderer/src/lib/mcpTools.js:18-26`（`restoreMcpTools` 原序 `flatMap`，**无排序**）→ 引擎 `agent-core/index.js:2326`（`allTools = [...effectiveBaseTools, ...mcpTools]`）。**披露序列随连接顺序变化，前缀缓存不稳定**；另有双实现问题（见 N5） |
| **G10** | 技能总量无会话级上限 | ✅ **已闭合** | `agent-core/index.js:752`（`MAX_SKILLS_PER_SESSION = 40`）+ `:2161-2167`（按传入顺序裁剪、同名去重）+ `:2226-2228`（在 system 中**明示上限与被裁数量，不静默丢弃**） |
| **G11** | 离线评估闭环未接运行时链路 | ❌ **仍未接（确认）** | `.github/workflows/ci.yml:92-102`（只跑 `npm test` + lint + typecheck + build）；`grep eval test/run-all.mjs` **无命中**；`npm run eval` 存在但无任何自动触发方 |
| **G3 / G4** | 配置分层 / 主体维 RBAC | ⏳ **待核实** | 本轮未独立取证（沿用 2026-10-18 架构审查判断）。落地前必须先做存在性核验，避免「有别名实现」被误判为缺失 |
| **8 内置能力** | deep-research / latex / sites / visualize | deep-research ✅ **已原生**；latex / sites / visualize ❌ **仍缺** | deep-research：`main/deepResearch.js` + `test/deep-research.test.mjs`（含真机实测记录）；latex：`grep -rIl latex main/ renderer/src` 仅命中 `agent-core/index.js:605-613`（**提示词技能文本**）+ `builtinSkills.ts`，**无编译工具**；sites / visualize：`grep -rIl "visualize\|mermaid\|chart" desktop/main` **零命中** |

**复核结论**：本轮把「功能缺口」进一步收敛到只剩 **G2（治理默认值）** 与 **N1（可达性）** 两项；其余为平台对等、工程一致性与生态差异化。

---

## 3. 本轮新识别缺口（11 项）

### 3.1 P0 —— 影响「功能是否真的能被用上」

| # | 缺口 | 证据 | 影响 | 建议落点 |
|---|---|---|---|---|
| **N1** | **模型能力位无任何 UI 声明入口 → G1 事实不可达** | `caps` 契约只在 `modelsFile.js:64-71 / 178-183` 解析与序列化；**渲染层零编辑入口**（`grep supportsImages renderer/src` 仅 `visionInput.ts` 消费、无写入）；`local:models-file/add-model` 只能写 `model_id + display_name`（`ipc/localData.js:131-145`）；`ModelSelector.jsx:10-11` 对**能力未知**的模型**不门控** | ① 用户拖截图提问时，`supportsImages` 恒为 false → **图片仍只按 `@path` 引用**，G1 等于没上；② 对不支持推理的模型仍可能下发 `reasoning_effort`（严格服务端 400 风险由 `main.js:633` 的空值不发兜住，但非空档位仍会发） | 模型编辑表单增加「图像理解 / 工具调用 / 推理强度」三枚能力开关并写回 `models.json`；或预置主流模型能力目录（DeepSeek/GLM/Qwen-VL 等）作为模板 |
| **N2** | **lint 门禁允许 9999 条 warning，长期不阻断** | `package.json:21`：`--max-warnings=9999`；`ci.yml:86-90` 注释自述「存量 84 个…属项目既有风格」；README 最新章节已记录 **161 条 warning** | 新引入的未用参数 / 空 catch 被噪声淹没，**「0 error」是门禁的全部强度，质量退化无感** | 分批清零后把 CI 切到 `--max-warnings=0`（或按文件棘轮基线） |
| **N3** | **CI 语法门禁只覆盖 8 个写死的文件** | `ci.yml:105-108`：`node --check` 仅 `main.js / preload.js / approval.js / skills.js / sandbox.js / github.js / scheduler.js / localStore.js` | 本轮新增的 `deepResearch.js`、`docTools.js`、`intentMcPrewarm.js`、`memory/memoryFile.js` **全都不在语法门禁内**；`TOOL_CHANNELS` 漏登记那类事故正是这样漏过去的 | 改为 `find main agent-core -name '*.js' -exec node --check`（或直接用 `npm test` 的加载阶段兜底） |
| **N4** | **新增工具的「8 环节接线」仍靠人工 + 事后补测** | 事故已发生并修复（`TOOL_CHANNELS` 26 → 50，见 memory）；现有护栏只有 `test/engine-process.test.mjs` 的「通道名在白名单中」单点断言 | schema / `APPROVAL_TOOLS` / 超时 / `CWD_TOOLS` / `BASE_PROMPT` / 主进程 handler / 工具轨迹标签 / 双语 i18n **8 个环节无一次性聚合断言**，同类「未知工具 / 无审批分级 / UI 无标签」会换个环节复发 | 增加「工具登记矩阵」聚合断言：从一处工具清单推导出 8 个环节的期望集合，逐环节差集断言 |
| **N5** | **`toToolDefs` 双实现，单一事实来源被破坏** | `renderer/src/lib/mcpTools.js:6-15` 与 `main/intentMcpPrewarm.js:141-…`（注释自承「与渲染层 mcpTools.js 的 toToolDefs 同形」） | 两处需人工同步；一旦渲染层改了命名/描述规范化策略，主进程路径**静默产出不同形状的 MCP 工具定义**（争议点：同一服务经两条路径可能不兼容） | 抽到 `shared/` 纯函数，两侧引用同一实现 |

### 3.2 P1 —— 决定「可持续演进与可复现」

| # | 缺口 | 证据 | 影响 |
|---|---|---|---|
| **N6** | **多模态数组 `content` 与压缩/摘要链路未适配** | 引擎全仓 `grep image_url` **零命中 `agent-core`**（数组 content 直穿到 provider，`agent-core:2625` `messages: outbound`）；而压缩摘要把历史整体交给模型：`agent-core:1240`（`messages: [{role:'user', content: '将以下对话历史压缩为...'}]`） | 长会话中**用户发的截图 base64 会随历史进入摘要调用**（重复消耗上下文与费用）；且摘要生成器如何序列化数组 content、token 估算是否对数组失真 —— **待核实**（建议压缩前剥离/降采样图片部件） |
| **N7** | **未提交 + 未推送的改动已达 27 项**（三层记忆全量） | `git status`、`git diff --stat` | 已发布 `v0.6.1-beta` 与工作区**能力不一致**；一旦误发版会把未验收的记忆体系带出去；且 `test/untracked-deps.test.mjs` 会因新增文件未入库而**长期处于失败态**（噪声掩盖真回归） |
| **N8** | **MCP tier 治理只在懒启动模式下生效** | `mcpPrewarm.js:148-156`（`autoStartConfigs` 是唯一消费方）+ `ipc/mcp.js:351`（`lazy` 才用它） | 「三层分级 + Profile 预设」三期功能**在默认配置下完全不参与启动决策**，治理能力形同虚设（与 G2 是同一根因的两面） |

### 3.3 P2 —— 体验 / 工程一致性

| # | 缺口 | 证据 | 影响 |
|---|---|---|---|
| **N9** | Hook / MCP / 技能缺少可观测命中率 | 未见「hook 触发次数」「意图预热命中率」「技能按需加载率」的统计落点（`agentRunner.js:151` 仅 `console.log`） | 无法回答「治理开关是否真的在生效」，与 N2 同属「无可观测 = 无门禁」 |
| **N10** | `EcosystemModal` 残留后端 TODO | `EcosystemModal.jsx:11`（`TODO(backend)：切换为后端接口`） | 与非云端定位**其实一致**（本地资产即事实来源），建议**直接删注释**而非补后端 |
| **N11** | 既有环境类测试长期红灯 | README 多轮记录 `tools-cwd.test.js`（macOS 沙箱环境）与 `untracked-deps.test.mjs` 常态失败或 flaky | 「全量套件总有 1~2 个预期失败」成为习惯后，**真回归会被当成第 3 个噪声**（本轮再次确认两处仍在） |

---

## 4. 端到端流程问题（7 项）

### 4.1 主对话链路（Composer → useAgentRun → IPC agent:run → agentRunner → agent-core → 事件回流）

```
Composer → useAgentRun（附件 → @path；图片 → visionParts；/mem 分流）
  → api.sendMessage（落库，content 恒为字符串）
  → IPC agent:run → agentRunner：审批快照 + 沙箱推导 + V层装配（l3 + 风险门）
      + intentPrewarmToolDefs（有界并发 6s，fail-open）
  → agent-core runAgent：assemble_context → 循环（模型 → 同轮工具 → 回喂）
      → 每轮：预算 / 墙钟 / 压缩闸（压缩成功 → memory_saved）
      → 收尾：emitRunEnd（结论归档）+ V层 L1 全量 + 风险门 L3
  → agent:event → 渲染层
```

| 环节 | 裁定 | 问题 |
|---|---|---|
| 消息落库与展示 | ✅ | 落库保持 `@path` 文本（`useAgentRun.ts:339-371`），DB 结构未被多模态污染 |
| 视觉输入 | ⚠️ | 装配正确，**门控不可达**（N1） |
| 意图预热 | ✅ | 原生优先 + 只连已保存 + 超时不阻塞（`agentRunner.js:109-154`） |
| MCP 工具面 | ❌ | **顺序不稳定 + 双实现**（G9 / N5） |
| 压缩 | ⚠️ | 摘要已归档记忆 ✅，但**对多模态历史未适配**（N6） |
| 收尾验证 | ✅ | `agentRunner.js:412-423`（未中止 + 有工具调用 + 结论非空 → 写 session 域） |
| 存储与召回 | ⚠️ | 三层记忆 **27 文件未提交**；L1 仅沉淀「有工具调用的任务」（纯问答经验不沉淀，属产品裁决项） |

### 4.2 MCP 链路（保存 → 启动 → 披露 → 调用 → 重连）

| 环节 | 裁定 | 问题 |
|---|---|---|
| 启动重连 | ❌ | 默认 **全量重连**（`ipc/mcp.js:351-353`），manual 档也被拉起（G2） |
| 分层治理 | ⚠️ | 分级代码齐备但**默认不参与决策**（N8） |
| 按需补差 | ✅ | 意图预热 + connect-on-demand |
| 披露 | ❌ | 无确定性排序（G9） |
| 崩溃恢复 | ✅ | 指数退避 + 上限 + UI 第五态（`mcpAutoReconnect.js:61-79`） |
| 协议 | ✅ | `2025-11-25` + 降级链 + `-32601` 显式拒绝（`mcpProtocol.js:20-45`） |

### 4.3 定时任务链路
✅ 调度/补跑、假成功拦截、V 层（L1 + L3 风险门/抽样、无人值守 fail-closed）、供应商错误翻译、连续失败暂停 —— 本轮未发现新断点。**残留**：子任务产物在 UI 的聚合展示粒度仍未做真机体验复核（第五轮已列，本轮无法在代码层裁决）。

### 4.4 平台适配链路
macOS（Seatbelt）✅ / Linux（bwrap + seccomp）✅ / Windows（三档 + setup 入口）✅ —— 与第五轮持平，**本轮未复跑真机**。

### 4.5 流程问题汇总（去重）

| # | 流程问题 | 性质 | 关联 |
|---|---|---|---|
| **V1** | 高权限 / 付费 MCP 默认随启动全量重连，与硬约束冲突 | 治理断点 | G2 / N8 |
| **V2** | 接入视觉模型也「看不到图」，因为能力位无处声明 | 可达性断点 | G1 残 / N1 |
| **V3** | 工具披露顺序随连接顺序漂移，前缀缓存不可命中 | 可复现性 | G9 |
| **V4** | 图片部件会随历史进入压缩摘要调用 | 上下文经济 | N6 |
| **V5** | 同一函数两处实现（MCP 工具定义），漂移无门禁 | 一致性 | N5 |
| **V6** | 三项工程门禁为「假绿」：lint 9999 / syntax 8 文件 / eval 不进 CI | 工程质量 | N2 / N3 / G11 |
| **V7** | 新增工具 8 环节接线无聚合断言，同类事故可换环节复发 | 工程质量 | N4 |

---

## 5. 对标 Codex Desktop 非云版「8 内置能力」

| Codex 内置能力 | MJCode | 证据 |
|---|---|---|
| browser | ✅ | `main/browserTools.js` + `BrowserPanel.tsx` |
| chrome | ✅ | `main/chromeRelay/`、`chromeTools.js`、`chrome-extension/` |
| computer-use | ✅ | `main/computerUse.js`、`cuaProcess/`（**opt-in 强门控 + L1 逐次审批**，`agent-core:761-792` 不进 `BASE_TOOLS`） |
| record-and-replay | ✅ | `RecordReplayPanel.tsx`、`cuaRecorder.js` |
| deep-research | ✅ **（本轮升为已原生）** | `main/deepResearch.js` + `test/deep-research.test.mjs`（真机跑通 tavily 检索 → webFetch 精读 → 落盘） |
| latex | ❌ | 仅 `agent-core:605-613` 提示词技能文本 + `builtinSkills.ts`，无编译/渲染工具 |
| sites | ❌ | `grep visualize/mermaid/chart desktop/main` 零命中；无站点构建/预览/部署链路 |
| visualize | ❌ | 同上 |

> **外加超出项**（本轮复核仍在）：V 层校验（L1 全量 + L3 风险门/抽样）、三层记忆（M0-M4 在研）、原生文档生成（docx/xlsx/pptx/pdf）、定时任务 V 层、技能库 100+、数字员工、意图驱动 MCP 动态加载。

---

## 6. 建议批次（按性价比）

### 第一批 · 止血（把「已写好的能力」变成「用户能用上的能力」）
| 项 | 内容 | 验收 |
|---|---|---|
| **N1** | 模型能力位 UI（图像 / 工具调用 / 推理强度）+ 预置能力目录 | 在设置页把某模型标为「支持图像」→ 拖入截图 → 模型回答基于**图像内容**而非路径 |
| **G2 + N8** | 懒启动/tier 分级**改为默认生效**（不再依赖 `MJCODE_MCP_LAZY`） | 冷启动日志中 whitelist/manual 服务**不**自动重连；首次调用才连接 |
| **N7** | 提交 + 推送三层记忆改动（先跑全量门禁） | `untracked-deps` 转绿；远端与本地 0 分叉 |

### 第二批 · 门禁真实性（决定后续所有改动的可信度）
| 项 | 内容 | 验收 |
|---|---|---|
| **N4** | 「工具登记矩阵」聚合断言（8 环节差集） | 故意删一个环节 → 门禁红 |
| **N3** | CI 语法门禁改为全量扫描 | 新增模块被纳入 |
| **N2** | lint 警告棘轮清零 → `--max-warnings=0` | CI 对新增 warning 阻断 |
| **G11** | eval 接入 `npm test` 或 CI | 改动触发量化差异 |

### 第三批 · 上下文与可复现性
| 项 | 内容 | 验收 |
|---|---|---|
| **G9 / N5** | 披露确定性排序（按 `server`→`tool` 稳定排序）+ `toToolDefs` 收敛到 `shared/` | 相同配置下披露序列**字节稳定** |
| **N6** | 压缩前剥离/降采样图片部件；核准 token 估算对数组 content 的失真 | 带图长会话压缩不再重复传 base64 |

### 第四批 · 生态差异化（按产品节奏取舍）
| 项 | 内容 |
|---|---|
| G-latex | LaTeX 渲染/编译（可用 `tectonic`，缺失时如实报错并给安装命令——与 `agent-core:611` 既有承诺对齐） |
| G-visualize | 图表/可视化原生能力（mermaid / chart 渲染 + 落盘） |
| G-sites | 站点构建 + 本地预览 + 部署（可选，云端倾向**不建议**做） |
| G3 / G4 | 配置分层 + 强制层、主体维 RBAC —— **先做存在性核验**再决定投入 |

### 第五批 · 工程与体验收尾
| 项 | 内容 |
|---|---|
| **G7** | 裸 `<button>` 继续分批收敛（当前 260 → 目标 0 或豁免清单）；**建议按「一文件一个 PR、基线只降不升」推进** |
| **N9** | hook / 意图预热 / 技能按需加载的命中率观测落点 |
| **N10** | 删除 `EcosystemModal.jsx:11` 的 backend TODO（定位本就不需要后端） |
| **N11** | 把 `tools-cwd` 环境失败改成 skip 或平台条件断言，消除常态红灯 |

### 建议实施顺序
```
第一批（N1 → G2/N8 → N7）           ← 立刻让 G1/治理"真的生效"
  → 第二批（N4 → N3 → N2 → G11）    ← 建立可信护栏
  → 第三批（G9/N5 → N6）            ← 上下文与可复现性
  → 第五批（G7 / N9 / N10 / N11）
  → 第四批（生态，按产品优先级取舍）
```

---

## 7. 诚实边界（本次审查未能覆盖的部分）

1. **未跑全量门禁（221 套件）**：本轮结论以**读码 + grep 取证**为准；「已闭合」指代码路径在册，**未经真机行为复核**（如 G1 分流后的真实模型表现、意图预热实际命中率、Windows 沙箱实际生效）。
2. **G3（配置分层）/ G4（RBAC）未独立取证**，明确标「待核实」。
3. **未验证的用户体验项**（沿用第五轮）：定时任务产物 UI 聚合粒度、记忆管理 UI 观感一致性、`computer_use` 真机端到端（需先授辅助功能权限）、deep-research 的 ToolTrace 卡片与预览面板视觉。
4. **N6 的 token 估算失真**未取证（仅确认摘要链路会把多模态历史整体交给模型）。
5. 本报告**不重复已闭合项**，也不把「部分完成」当「已完成」——G7 明确标 260 基线仍在、G1 明确标「装配已闭合但门控不可达」。

---

*本报告基于 2026-10-19 `HEAD = 7e62a61` + 工作区未提交三层记忆改动，由 Agent Harness 专家团模式审查生成；所有结论可回溯到 `file:line`。*
