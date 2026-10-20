# MJCode 第七轮全量审查报告与调整实现方案

> 审查日期：2026-10-20 ｜ 审查对象：MJCode `desktop/` ｜ 方法：三源交叉（代码 / README / 技术流程文档）+ 四阶段团队作业（P0 研究 → P1 设计 → P3 独立核验 → 主理人汇编）

> ## 交付台账（主理人汇编）
>
> | 项 | 值 |
> |---|---|
> | **审查对象** | MJCode `desktop/`（Electron 桌面 Agent，含 `main/` 宿主、`agent-core/` 引擎、`renderer/`、`shared-ipc/`） |
> | **Git 锚点** | `924909c29330e89372282801aa051ab9220caf52`（`main`，`origin/main...HEAD = 0 2`） |
> | **正文版本** | sha256 **`a7763dd5bc68699b323fd07bb27bee67fdc2c327a9c15755c1d5c56420dbe5b7`**，**968 行**（汇编时现算复验） |
> | **分阶段产出** | P0 `docs/harness-r7/01-research/审查事实简报.md`（523 行）／ P1 `docs/harness-r7/02-design/架构调整实现方案.md`（968 行）／ P3 `docs/harness-r7/04-test/事实核验报告.md`（**579 行**，汇编时现算；正文 §6.5 引用的「545 行」是撰写时值，**保留不改**以免破坏正文哈希 `a7763dd5…` 的可核性） |
> | **发现分布** | **P0 = 0 ／ P1 = 11 ／ P2 = 11（合计 22 条，F-001 ～ F-022）** |
> | **阻断发布的决策** | 3 项：D-10（文档发布纪律）、D-06（工具登记门禁）、D-04（capability gate） |
> | **核验状态** | P3 独立核验 67 条断言（✅ 20 ／ ❌ 1 ／ ⚠️ 2）＋ 8 条反向用例；**6 类结论维持「未验证」** |
> | **交付性质** | 审查报告 + 调整方案。**未改动任何生产代码**；`03-code/` 不存在属预期 |
>
> ⚠️ **两点必须先读**：
> 1. **用户尚未对任何决策拍板**。§4.1 的 10 条推荐、§5 的 B0～B3 批次，全部是架构师建议经主理人放行，不是用户决策。需裁决项见 §7.3。
> 2. **本轮未运行全量 `npm test` / `lint` / `typecheck`**（工作区 12 个未提交改动 + 窗口内有外部写入者活动，全量结果不可复现）。文中任何「全部通过」均指历史结果，不是当前状态。

> **设计台账**：本文件由架构师（agent-harness-architect）于 P1 阶段产出；输入为 `docs/harness-r7/01-research/审查事实简报.md`（523 行）+ `docs/harness-r7/04-test/事实核验报告.md`（545 行，含 §9 终稿定点复核）。本文对简报中的**全部数字独立现算复核**，并已并入 P3 测试工程师的独立核验结论（见 §0.1 与 §6.5）。
> **Git 锚点**：`924909c29330e89372282801aa051ab9220caf52`（`main`，`origin/main...HEAD = 0 2`）
> **工作区状态锚点**：12 个 tracked 未提交文件 + 2 个 untracked（`desktop/test/docs-consistency.test.mjs`、`docs/harness-r7/`）
> **纪律**：本文**不修改任何项目源文件**（README、技术流程文档、`desktop/` 代码一律只读）；预测型结论一律标「未验证」。
> **锚点纪律（P3 裁决后修订）**：技术流程文档在 7 分钟内出现 **3 个不同版本**（§1.1 A-06a），**全篇废弃该文档的 md 行号锚点**，一律改为「章节标题锚点 + 快照哈希」；README 在本轮被**外部写入者持续追加**（3069 行 → 3125 行，§1.1 A-09a），**行数与哈希双双不可作基线**，定位一律改用「语句特征锚点」（§1.6）。**代码行号锚点不受影响**（锚定 Git HEAD `924909c`）。

---

## 0. 执行摘要（结论先行）

### ① 一句话总判断

MJCode 的 Agent Harness 六层骨架**已经完整落地且相当扎实**（E 循环 / T 工具 / C 上下文 / S 记忆 / L 事件 / V 验证均有实现且多数对齐主流），当前的主要风险**不是能力缺失，而是「对外声称的契约与实际生效的约束不一致」**——契约层与执行层之间有 5 处可被反例击穿的缝隙，其中 **2 处方向是权限 fail-open**（F-018 / F-019），必须优先处理。

### ② 本轮发现分布

| 分级 | 条数 | 编号 |
|---|---:|---|
| **P0**（阻断发布） | **0** | — |
| **P1**（发布前应修） | **11** | F-001、F-002、F-003、F-005、F-006、F-007、F-012、F-015、**F-018**、**F-019**、**F-022** |
| **P2**（计划内修） | **11** | F-004、F-008、F-009、F-010、F-011、F-013、F-014、F-016、F-017、**F-020**、**F-021** |
| **合计** | **22** | F-001 ～ F-022 |

> **P0 = 0 是本轮最重要的结论之一**：没有发现会导致数据损坏或不可恢复的安全事故。但 **F-018 / F-019 的 fail-open 方向意味着「权限比声明的更宽」**，属 P1 中优先级最高的一档。

### ③ 五个最重要的判断

1. **工具登记门禁是假闭环（F-002，P1）**。矩阵测试 8 环节只查「条目是否孤儿」，不查「53 个模型工具是否逐个覆盖」；审批分级 `TOOL_LEVEL` 与可补偿性 `REVERSIBILITY` **完全未被读取**，漏登记会静默回落 `L2`（`desktop/main/approval.js:351`）。可证明反例见 §2.2(1)。
2. **角色隔离是 fail-open，不是 fail-closed（F-018 / F-019，P1·安全）**。`desktop/agent-core/index.js:2419-2429`：`rolePreset.toolNames` 与内置工具**交集为空**时只 `console.warn`，`allTools` 保持全量 → 用户给只读角色配了拼错的工具名，该角色反而拿到全部 53 个工具。同一段 `:2416-2425` 的 `allowMcp` **缺省 true** → 只读角色仍可调任意 MCP 写工具。**这是权限方向错误，不是体验缺陷。**
3. **UI→执行断链（F-003，P1）**。`supportsToolCall` 开关只落库，`runAgent` 仍每轮发 `tools: allTools`（`desktop/agent-core/index.js:2413,2714`）。用户已可见的开关不生效 = 信任问题。
4. **MCP 契约两端不闭合（F-005 / F-006 / F-007，P1）**。拼名 `` `mcp__${server}__${tool}` `` 与 `split('__')` 反解不可逆（server=`my__svc` 必错路由）；Streamable HTTP 未发 `MCP-Protocol-Version`；第三方工具描述/schema 无长度闸与不可信标记，而工具**结果**已有 `detectInjection`——**定义侧缺同级守卫**。
5. **文档与数字无法复刻（F-001 / F-015 / F-022，P1）**。技术文档不在 Git 且 7 分钟内 3 个版本；新增的 `docs-consistency.test.mjs` 是**半硬门禁**——常量断言是硬的，但**引用存在性断言与缺文档分支是软的**（`process.exit(0)` fail-open，`desktop/test/docs-consistency.test.mjs:38-40`）。叠加该文档被 `.gitignore` 忽略 → **CI 冷检出必走跳过分支，净效果是在 CI 上它永远不会红**。

### ④ 阻断发布的 3 个决策

| 决策 | 内容 | 为什么阻断 |
|---|---|---|
| **D-10** 文档发布纪律 | 文档入 Git + 计数脚本 + CI 校验 | 不做则其余 9 个决策**验收不可判定**（本轮已实证：同一文档 3 版本） |
| **D-06** 工具登记安全门禁 | 先补「逐工具×逐环节」断言，再收敛声明式 registry | 它是 D-04/D-03/D-05/D-09 共同的**元信息来源**；当前元信息散在 7 处登记面 |
| **D-04** capability gate 语义 | false 时 `allTools=[]` + 无工具 system prompt | 唯一**用户已可见**的契约断裂，且必须与 F-018 的空交集回落一并改为 fail-closed |

### ⑤ 核验状态

P3 独立核验共 **67 条断言**：**✅ 20 通过 / ❌ 1 被推翻 / ⚠️ 2 部分成立**（详见 §6.5）。其中 **1 条被推翻的是简报的 F-004**（「渲染层零调用」不成立，实为 12 环端到端闭合，见 §3.2）。**以下 6 类无法由静态/自动化验证，全部维持「未验证」标注，不得升级为已验证**：MCP 严格 server 返回 400、真实 provider 对 `tools` 的拒绝、恶意 description 的注入行为、Electron 真机 UI、三平台真机沙箱、付费 eval 能力回归。

---

## 0.1 阅读须知：本次复核推翻/修正的四处结论

在开始之前必须先声明——架构师对研究员简报做了独立复算，**有四处结论需要修正**（其中 C-3 经 P3 独立核验裁决为**架构师正确**、**研究员错误**），后续章节均已按修正后结论撰写：

| # | 原结论 | 现算 | 处置 |
|---|---|---|---|
| C-1 | 技术流程文档快照 sha256 前缀 `217a162b53f1f512` | **该文档在 7 分钟内出现 3 个版本**（§1.1 演进表）：冻结 `217a162b…` → 架构师观测 `5401942147…`（712 行） → P3 观测 `175f1b3f11d58b9b`（714 行）。**「某处内容一致」的判定已不可靠**：骨架 `:294` 已位移至 `:296`（架构师原判「一致」**是错的**）；〔§5 MCP·连接与运维小节〕、〔§6 数字员工·卡片操作段〕两处位移 | **全篇废弃该文档的 md 行号锚点**，改为「章节标题锚点 + 快照哈希」；「内容是否同步」改由修好后的 `docs-consistency.test.mjs` CI 门禁承担 |
| C-2 | `desktop/test/*.test.*` = 217 | **git tracked = 217；工作目录实际 = 218**——因为 `docs-consistency.test.mjs` 于 `07:41` 被新建（untracked） | 基线表同时给出「基于 HEAD 打包」与「合并当前 diff 后」两套口径 |
| C-3 | **F-004「渲染层对 `rolePreset` 零调用」** | **该结论不成立；P3 独立核验确认架构师正确**。`rolePreset` 在 HEAD `924909c` 上已存在 **12 环端到端闭合链**（见 §3.2） | F-004 重新定义为「**README 自相矛盾 + 回退路径不钳制**」，从 P1 降为 **P2**；**但 F-018 / F-019 两条 P1 安全项不得随其一起降级沉没** |
| C-4（新增） | 简报称 `ipcMain.handle` 静态通道 186 | **两个口径都成立但含义不同**：**原始调用点 186 处 / 静态唯一字面量 185 个 / 另有 1 个模板字面量 `tool:${toolName}`**（`desktop/main/tools/exec.js:664`）；185 + 1 = 186 个唯一名串 | §1.2 B-08 同时列出三值并注明差别，避免下一轮再对不上 |

> C-3 是本轮**最重要的方法论提醒**：静态「某标识符零命中」类断言极易因 grep 口径（是否含注释 / 事件名 / 间接字段 `runtime`）而误判。判定「半截实现」必须追到**事件链末端**再下结论——P3 用 12 环证据链推翻了研究员的 1 次 grep。

---

## 1. 数字基线表（Single Source of Truth）

> **纪律**：本文后续所有章节引用的数字，**只能取自本节**。禁止出现「约 N」「大概」。同一数字在不同章节必须逐字相同。
> 复核时点：本文件生成时；复核者：架构师；全部数值均由下列「复核命令」现算得出。

### 1.1 Git 与文档快照

| 编号 | 项 | 值 | 口径 | 复核命令 |
|---|---|---|---|---|
| A-01 | Git HEAD | `924909c29330e89372282801aa051ab9220caf52` | `main` 分支 HEAD 完整 SHA | `git -C /Users/jianma/Desktop/MJCode rev-parse HEAD` |
| A-02 | 与远端分叉 | `0 2`（本地领先 2 个提交） | `--left-right --count` | `git -C /Users/jianma/Desktop/MJCode rev-list --left-right --count origin/main...HEAD` |
| A-03 | tracked 未提交文件数 | 12 | `git status --short` 中 `M` 条目 | `git -C /Users/jianma/Desktop/MJCode status --porcelain \| grep -c '^ M'` |
| A-04 | untracked 条目 | 2（`desktop/test/docs-consistency.test.mjs`、`docs/harness-r7/`） | `??` 条目 | `git -C /Users/jianma/Desktop/MJCode status --porcelain \| grep '^??'` |
| A-05 | 12 个脏文件 blob 一致性 | **11 / 12 与下发清单一致；`README.md` 不一致**（下发 `3f19bf3a8348`，架构师 07:4x 现算 `eb99dd2c6bf7`，现已再次变化）。**注：README 这一项的一致性判定不成立**——它在审查窗口内被持续追加（A-09a），**其 blob 不可作任何一致性基线**；其余 11 个文件可 | `git hash-object` 前 12 位 | `git -C /Users/jianma/Desktop/MJCode hash-object <file> \| cut -c1-12` |
| A-06 | 技术流程文档哈希演进 | **3 个版本**（见 A-06a 表） | `shasum -a 256` 前 16 位 + mtime | `shasum -a 256 /Users/jianma/Desktop/MJCode/MJcoder-技术流程功能文档.md; stat -f "%Sm" -t "%H:%M:%S" MJcoder-技术流程功能文档.md` |
| A-07 | 技术流程文档行数 | **714**（v3，最新） | `wc -l`；**行数不可作锚点**（v1 冻结时为 712，v2 为 712，v3 为 714） | `wc -l /Users/jianma/Desktop/MJCode/MJcoder-技术流程功能文档.md` |
| A-08 | 技术流程文档 Git 状态 | **不在版本库中**；被 `.gitignore:46` 的 `*.md` 规则忽略 | `check-ignore` + `ls-files` | `git -C /Users/jianma/Desktop/MJCode check-ignore -v MJcoder-技术流程功能文档.md` |
| A-09 | README sha256（**时点值，不作基线**） | `401475bac76395c3`（08:11 现算） | `shasum -a 256` 前 16 位；**该文件仍在被追加，任何单值都不是基线**（A-09a） | `shasum -a 256 /Users/jianma/Desktop/MJCode/README.md` |
| A-10 | README 行数（**时点值，不作基线**） | **3125**（08:11 现算） | `wc -l`；冻结基线 3069 已作废（A-09a） | `wc -l /Users/jianma/Desktop/MJCode/README.md` |
| A-09a | **README 写入活动记录** | 3069 行（`e10a57d4146d690f`，07:31）→ **3125 行（`401475bac76395c3`，07:43）**，+56 行；其后至 08:11 无写入 | `wc -l` + `shasum` + `stat -f "%Sm"` | `wc -l README.md; shasum -a 256 README.md; stat -f "%Sm" -t "%H:%M" README.md` |

> **A-09a 结论**：README 在**本轮复核期间**被外部写入者追加 +56 行。因此本文对 README 的引用**一律不用行号、不用单点哈希**，只用「语句特征锚点」（§1.6）；上文涉及 README `:107` / `:116` 的旧行号表述均应按 §1.6 的锚点读取。

#### A-06a · 技术流程文档三版本演进表（**核心可复核性缺陷**）

> 该文档**不在 Git 中**（A-08），因此在 7 分钟窗口内被反复重写，且**没有任何机制把它钉住**。这是 F-001 + F-015 合并后的实证。

| 版本 | sha256（前 16） | 行数 | mtime | 观测者 | 与本方案的关系 |
|---:|---|---:|---|---|---|
| v1 | `217a162b53f1f512` | 712 | `07:33:46` | P0 研究员（**冻结基线**） | 简报全部行号锚点基于此版本 |
| v2 | `540194214702922f` | 712 | `07:40:49` | 架构师（P1 现算） | 架构师 §1/§2 的行号锚点基于此版本 |
| v3 | `175f1b3f11d58b9b` | **714** | `07:41:00` | P3 测试工程师（独立核验） | **当前磁盘版本**；公开引用一律以此为准 |

> **另有一次写入未留证（推断，未取证）**：v1→v2 之间可能存在第 4 次写入，但架构师当时未留存哈希副本，P3 亦无法复现，故**不入基线表、不计入版本数**。本文全篇统一表述为「**3 个版本**」（v1/v2/v3），此推断仅作背景。

**三条由此确立的纪律**：

1. **禁止用 md 行号做锚点**。同一段落在 v1/v2/v3 中的行号不同（实证：骨架内容 v1 `:294` → v3 `:296`）。
2. **禁止用行数、也禁止用单点哈希做锚点**。技术文档 v1 与 v2 都是 712 行但内容不同（行数失效）；README 则相反——**行数从 3069 增至 3125（+56 行，A-09a），哈希随之变化**。两者共同说明：审查窗口内被外部写入者改过的文件，**任何单点快照都不是基线**。
3. **公开引用格式**：`技术文档 v3（175f1b3f11d58b9b）·〔章节标题〕`。本方案全篇按此执行（§1.6）。

### 1.2 代码规模与契约数量

| 编号 | 项 | 值 | 口径 | 复核命令 |
|---|---:|---|---|---|
| B-01 | `BASE_TOOLS` 静态工具 | **52** | ESM import `agent-core/index.js`，`BASE_TOOLS.length` | `node --input-type=module -e "const m=await import('/Users/jianma/Desktop/MJCode/desktop/agent-core/index.js');console.log(m.BASE_TOOLS.length)"` |
| B-02 | `TOOL_HANDLER_NAMES` 键数 | **51** | `Object.keys(TOOL_HANDLER_NAMES).length` | 同上，`Object.keys(m.TOOL_HANDLER_NAMES).length` |
| B-03 | 模型可调用工具并集 | **53** | `new Set([...BASE_NAMES, ...TH_KEYS]).size`；BASE 独有 `spawn_subagent`/`deep_research`，TH 独有 `computer_use` | 同上，取并集 |
| B-04 | opt-in 后最多工具数 | **54** | 并集 53 + summary 披露模式追加 `load_skill` | `agent-core/index.js:2405-2412`（`LOAD_SKILL_TOOL`、`COMPUTER_USE_TOOL` 条件追加） |
| B-05 | `TOOL_CHANNELS` | **52** | `require('main/engineProcess/registry.js').TOOL_CHANNELS.length` | `node -e "console.log(require('/Users/jianma/Desktop/MJCode/desktop/main/engineProcess/registry.js').TOOL_CHANNELS.length)"` |
| B-06 | 回调桥 | **8 notify + 1 request = 9** | `NOTIFY_CBS.length` / `REQUEST_CBS.length` | 同上，`(reg.NOTIFY_CBS||[]).length, (reg.REQUEST_CBS||[]).length` |
| B-07 | 主进程 JS/MJS 文件数 | **137** | 递归 `desktop/main/**/*.{js,mjs}`，排除 `node_modules`、`dist` | `find /Users/jianma/Desktop/MJCode/desktop/main -name node_modules -prune -o -name dist -prune -o -type f \( -name '*.js' -o -name '*.mjs' \) -print \| wc -l` |
| B-08 | IPC handler 通道（**三口径，勿混用**） | **原始调用点 186 处** | `rg -o "ipcMain\.handle\("` 计数，含所有调用点（含重复注册） | `rg -o "ipcMain\.handle\(" /Users/jianma/Desktop/MJCode/desktop/main \| wc -l` |
| B-08a | 同上 · **静态唯一字面量** | **185 个** | 扫 `ipcMain.handle('<字面量>'` 去重，并**排除含 `${` 的模板字面量** | `rg -oP "ipcMain\.handle\(\s*[\`'\"]([^\`'\"]+)" desktop/main -N --no-filename \| sed -E "s/^.*[\`'\"]//" \| sort -u \| rg -v "\$\{" \| wc -l` |
| B-08b | 同上 · **唯一名串（含模板）** | **186 个** | 同上去重但**不排除**模板；185 + 1 个模板 = 186 | 同上，去掉 `rg -v` 过滤 |
| B-08c | 三口径关系 | 186 调用点 = 186 名串 = 185 静态 + 1 模板 | 三个数字**同时成立**，差别只在口径；P3 报 185 用的是 B-08a | 见上三行 |
| B-09 | IPC 动态通道注册点 | **1 处**（`tool:${toolName}`） | 模板字面量，逐工具注册；即 B-08b 中的那 1 个模板 | `rg -n "ipcMain\.handle\(\`" desktop/main` → `desktop/main/tools/exec.js:664` |
| B-10 | preload bridge 方法 | **202** | 扫 `exposeInMainWorld('mjcode', {...})` 顶层键（bridge-parity 同口径） | `cd desktop && node test/bridge-parity.test.mjs`（末行输出「桥面 202 个方法，渲染层引用 156 个」） |
| B-11 | 渲染层未引用 bridge 方法 | **46 / 202 = 22.8%** | 202 − 156；门禁上限 40% | 同上（门禁断言 `bridge-parity.test.mjs:108-112`） |
| B-12 | preload invoke 通道 | **187** 个唯一字面量 | 扫 `ipcRenderer.invoke('<字面量>'` 去重 | `rg -oP "ipcRenderer\.invoke\(\s*[\`'\"]([^\`'\"]+)" desktop/main -N --no-filename \| sed -E "s/^.*[\`'\"]//" \| sort -u \| wc -l` |

### 1.3 测试与门禁

| 编号 | 项 | 基于 HEAD 打包 | 合并当前 diff 后 | 口径 | 复核命令 |
|---|---|---:|---:|---|---|
| C-01 | `test/*.test.{js,mjs}` | **217** | **218** | 目录 glob 计数；差值 1 = untracked `docs-consistency.test.mjs`（07:41 新建） | `git ls-files 'desktop/test/*.test.js' 'desktop/test/*.test.mjs' \| wc -l` / `ls desktop/test/*.test.* \| wc -l` |
| C-02 | 明确登记 smoke 套件 | 2 | 2 | `run-all.mjs:26` 常量 `SMOKE = ['smoke-load.mjs','render-smoke.mjs']` | `sed -n '26p' desktop/test/run-all.mjs` |
| C-03 | 发现式 suite 总数 | **219** | **220** | 217/218 + 2 smoke，`run-all.mjs:28-40` | 计算：C-01 + C-02 |
| C-04 | 前置门禁 gate | 1 | 1 | `run-all.mjs:49-51` 的 `GATES` 数组长度（仅 `eval:check`） | `rg -n "const GATES" desktop/test/run-all.mjs` |
| C-05 | `npm test` 汇总检查项 | **220** | **221** | suite 数 + gate 数 | 计算：C-03 + C-04 |
| C-06 | 文档中「220 套件」表述 | 不成立 | 不成立 | 技术文档当前快照 `〔§1 产品定位·目录结构段〕` 写「220 套件基线」；实际 220 是**检查项**总数而非套件数，且仅在「HEAD+2 smoke+1 gate」口径下成立 | `rg -n "220 套件" MJcoder-技术流程功能文档.md` |
| C-07 | eval 任务集规模 | 10（`tasks.json`）+ 5（`tasks-hard.json`）= 15 | 同左 | JSON 数组长度 | `node -e "console.log(JSON.parse(require('fs').readFileSync('desktop/eval/tasks.json','utf8')).length, JSON.parse(require('fs').readFileSync('desktop/eval/tasks-hard.json','utf8')).length)"` |
| C-08 | lint 棘轮基线 | **161** | 161 | `LINT_WARNINGS_BASELINE = 161`（`no-unused-vars` 122 / `require-atomic-updates` 32 / 其他 7） | `sed -n '19p' desktop/test/lint-ratchet.test.mjs` |
| C-09 | 「全部通过」状态 | **未验证** | 未验证 | 本轮纪律禁止运行全量 `npm test`；架构师仅**单独运行**了 `bridge-parity.test.mjs`（4/4 通过）以取得 B-10/B-11 精确值 | `cd desktop && node test/bridge-parity.test.mjs` |

### 1.4 生态资产与关键常量

| 编号 | 项 | 值 | 口径 | 复核命令 |
|---|---|---:|---|---|
| D-01 | Skills | **100** | `ecosystem/skills` 一级目录数 | `node -e "...fs.readdirSync('/Users/jianma/Desktop/MJCode/ecosystem/skills',{withFileTypes:true}).filter(x=>x.isDirectory()).length"` |
| D-02 | 精选 MCP connectors | **77** | `ecosystem/mcp-connectors.json` 的 `connectors` 数组长度（**注意：该文件是对象，不是数组**） | `node -e "console.log(JSON.parse(fs.readFileSync('.../mcp-connectors.json','utf8')).connectors.length)"` |
| D-03 | WorkBuddy 原始 connectors | **214** | `ecosystem/mcp-connectors-workbuddy.json` 的 `connectors` 数组长度。**与 D-02 是两套独立清单，现算交集为 0**：77 为「策展子集」口径、214 为「原始导入」口径，二者**不构成父子/去重关系**（依据 D-03a） | 同口径换文件 |
| D-03a | 两清单交集 | **0** | 按 `id`/`name`/`slug` 取键求交 | `node -e` 读两文件 `connectors` 后 `new Set` 求交（见 §1.5 复核记录） |
| D-04 | Digital Employees | **51** | `ecosystem/digital-employees.json` 数组长度 | `node -e "console.log(JSON.parse(fs.readFileSync('.../digital-employees.json','utf8')).length)"` |
| D-05 | 主目录资产合计 | **228**（100 + 77 + 51） | 精选口径；若按 WorkBuddy 原始口径则为 365，**两种口径都不能得到 README 的 230** | 计算：D-01 + D-02 + D-04 |
| D-06 | README 声明值（A 处） | 100 / **80** / **50** / 合计 **230** | `README.md`〔README·ecosystem 目录行〕（定位用语句锚点，不用行号/哈希） | `rg -n "80 MCP connectors" README.md` |
| D-06a | README 声明值（B 处，**与 A 自相矛盾**） | 技能 219 / MCP **77 条** / 员工 **51 个** / 工具 **52 项** | 同文件〔README·审查流程第 4 步〕；**这一处数字是对的** | `rg -n "77 条 / 15 分类" README.md` |
| D-07 | README 与现算偏差 | connectors **−3**、employees **+1**、合计 **−2** | 现算 − README | 计算 |
| D-08 | DAG `MIN_TASKS` | **2** | `desktop/main/orchestrator/dag.js:9` | `sed -n '8,10p' desktop/main/orchestrator/dag.js` |
| D-09 | DAG `MAX_TASKS` | **8** | `dag.js:8` | 同上 |
| D-10 | DAG `MAX_DEPS` | **4** | `dag.js:10` | 同上 |
| D-11 | 技术文档 DAG 表述 | 写「规模常量 `MIN / MAX_TASKS = 8`」 | 当前快照 `〔§8 编排·流程图常量节点〕`；**MIN 写错，且文件内部 `〔§3 执行流·相关段〕` 又写对了 → 自相矛盾** | `rg -n "MIN / MAX_TASKS\|MIN_TASKS" MJcoder-技术流程功能文档.md` |
| D-12 | MCP 默认预热服务 | **3**（`filesystem` / `time` / `fetch`） | `PREWARM_NAMES` Set 大小 | `sed -n '31p' desktop/main/mcpPrewarm.js` |
| D-13 | 意图连接超时 | **6000 ms** | `PREWARM_CONNECT_TIMEOUT_MS = 6000` | `sed -n '89p' desktop/main/agentRunner.js` |
| D-14 | 记忆层召回配额 | **2 / 3 / 2**（session / project / global，合计 7） | `LAYER_QUOTA` | `sed -n '69,70p' desktop/main/memory/index.js` |
| D-15 | 审批模式档位 | **4**（`never` / `auto-safe` / `on-request` / `always`） | `APPROVAL_MODES` 键数 | `sed -n '32,37p' desktop/main/approval.js` |
| D-16 | 审批默认回落级别 | **L2** | `return TOOL_LEVEL[tool] \|\| 'L2'` | `sed -n '351p' desktop/main/approval.js` |
| D-17 | 应用版本 | **0.6.1-beta** | `desktop/package.json:3` | `node -p "require('/Users/jianma/Desktop/MJCode/desktop/package.json').version"` |
| D-18 | MCP `clientInfo` 自报版本 | **1.0** | `CLIENT_INFO = { name:'mj-coder', version:'1.0' }` | `sed -n '46p' desktop/main/mcpProtocol.js` |
| D-19 | 版本一致性 | **不一致**（D-17 ≠ D-18） | — | 计算 |

### 1.5 与简报 §1 的差异说明（现算为准）

| 项 | 简报值 | 本文现算值 | 处置 |
|---|---:|---:|---|
| 测试文件数 | 217 | 217（tracked）/ 218（工作目录） | **以本文双口径为准**（C-01）；简报值未反映 07:41 新建的 untracked 文件 |
| 发现式 suite | 219 | 219 / 220 | 同上传导（C-03） |
| 汇总检查项 | 220 | 220 / 221 | 同上传导（C-05） |
| 技术文档 sha256 | `217a162b…` | **v3 `175f1b3f11d58b9b`（714 行）** | 共 **3 个版本**（A-06a 表）。以 v3 为当前引用版本，v1 冻结值仅作历史 |
| 技术文档若干「内容一致」判定 | 简报未裁 | **架构师原判「6 处一致」有 1 错**（`:294`→`:296` 已位移） | 已废弃行号锚点，改章节锚点（A-06a 纪律） |
| 12 脏文件 blob | 12/12 一致 | 11/12 一致（`README.md` 不一致） | 以现算为准（A-05） |
| IPC handler 数 | 186 | **186 调用点 / 185 静态字面量 / 186 名串** | 三口径并列（B-08 / B-08a / B-08b）；P3 报的 185 是静态口径 |
| `mcp-connectors.json` 结构 | 隐含为数组 | **实为对象**，工具数在 `.connectors` 键下 | 口径修正（D-02）；简报给的复核命令按数组解析会得到 `undefined`，本文已修正命令 |
| 两套 connectors 关系 | 「运行时合并去重」 | **交集 = 0，两套独立清单** | **删除「合并去重」表述**（D-03 / D-03a）；p7 简报此说无依据 |
| README 生态数字 | 「漂移」 | **同一文件内自相矛盾**：A 处 80/50/230 是错的，B 处 77/51/52 是对的 | 见 D-06 / D-06a、F-021 |
| 其余各项 | — | 全部一致 | 沿用 |

### 1.6 章节锚点对照表（**替代全部 md 行号**）

> 因 A-06a 的三版本问题，本方案引用技术文档一律用「章节标题锚点」。下表是锚点 ↔ 章节标题的映射；**复核时请用 `rg -n "<章节标题>" MJcoder-技术流程功能文档.md` 定位，不要用行号**。

| 本方案使用的锚点 | 技术文档章节标题（v3 `175f1b3f11d58b9b`） |
|---|---|
| 〔§1 产品定位·设置页段〕 | 一、产品定位与整体架构 — 关于「设置页仅保留版本更新」的段落 |
| 〔§1 产品定位·目录结构段〕 | 一、产品定位与整体架构 — 目录树代码块（含「220 套件基线」注释） |
| 〔§1 产品定位·server 目录行〕 | 一、产品定位与整体架构 — 目录树中 `server/` 一行（含「Spring Boot」） |
| 〔§3 执行流·相关段〕 | 三、Agent Harness 执行流（含写对的 `MIN_TASKS`） |
| 〔§4 工具矩阵·单一事实来源段〕 | 四、原生工具矩阵与接线规范 — 「内置 vs MCP 的边界」+「单一事实来源」8 环节 |
| 〔§5 MCP 全章〕 | 五、MCP 三层治理与意图预热 |
| 〔§5 MCP·连接与运维小节〕 | 五、MCP — 「MCP 连接与运维」小节 |
| 〔§5/§9 设置与审批段〕 | 五、MCP 与九、审批沙箱中涉及设置项/审批矩阵的段落 |
| 〔§6 数字员工·卡片操作段〕 | 六、技能、生态中心与数字员工 — 数字员工卡片「详情/招募」段 |
| 〔§8 编排·流程图常量节点〕 | 八、任务编排与 Worker 池 — 流程图 `validateDag` 节点（含「MIN / MAX_TASKS = 8」） |
| 〔§8 编排·流程图末〕 | 八、任务编排 — 流程图末节点 |
| 〔§9 审批段〕 | 九、审批、沙箱与安全约束 — 审批分级矩阵段 |
| 〔§11 i18n 段〕 | 十一、i18n 与界面结构 |
| 〔§12 门禁·命令表〕 | 十二、门禁、CI 与评估 — 12.1 命令级门禁表 |
| 〔§12 门禁·命令表 typecheck 行〕 | 十二 — 上表 `npm run typecheck` 行 |
| 〔README·ecosystem 目录行〕 | README — 「`ecosystem/`」目录说明行（含 80/50/230 与 "not yet wired"） |
| 〔README·测试套件声明段〕 | README — 「all suites green」声明段 |
| 〔README·生态资产计数段〕 | README — 生态资产计数段 |
| 〔README·审查流程第 4 步〕 | README — 审查流程清单第 4 步（含 77/51/52 与「rolePreset 运行时落地」） |

---

## 2. 十三章功能模块完整度评估（逐章）

> **评估口径**
> - **完整**：文档描述 = 源码实现，且关键不变量有机器化守护。
> - **基本完整**：主体已落地，存在文档漂移或局部缺口，但不影响主链路正确性。
> - **半截**：对外声称的能力与实际生效的约束之间存在**可被反例击穿**的落差（UI→执行断链 / 门禁假闭环 / 契约不闭合）。
> - **缺失**：文档中声称但源码中无对应实现。
>
> **锚点口径（P3 裁决后）**：本章**不使用技术文档的 md 行号**（该文档在 7 分钟内有 3 个版本，A-06a），一律用「章节标题锚点」（映射见 §1.6）。代码行号锚定 Git HEAD `924909c`，稳定可用。
> **一处被推翻的自查**：架构师原判「6 处章节内容与冻结快照一致」，经 P3 复核 **`:294` 已位移至 `:296`**，该判定为**错**；已改由章节锚点承载。

| 章 | 标题 | 模块职责 | 实现现状 | 完整度 | 对应发现 | 主流对齐度 |
|---|---|---|---|---|---|---|
| 一 | 产品定位与整体架构 | 产品边界、目录结构、进程拓扑、能力总览 | 已落地；但 `〔§1 产品定位·server 目录行〕` 把 `server/` 写成 Spring Boot、`〔§1 产品定位·设置页段〕` 写「设置页仅保留版本更新」、`〔§1 产品定位·目录结构段〕` 写「220 套件基线」三处与源码冲突 | **基本完整** | F-011、F-009 | 中（架构形态对齐，事实陈述失真） |
| 二 | 引擎进程隔离 `engineProcess` | `utilityProcess` 子进程隔离、`TOOL_CHANNELS` 静态白名单、传输适配 | 已落地；`TOOL_CHANNELS=52`、notify 8 + request 1（B-05/B-06）与文档逐项对得上；`childEntry.js` 反向 RPC 与 transport 双适配齐全 | **完整** | — | 高（进程隔离 + 静态白名单是主流 host 做法） |
| 三 | Agent Harness 执行流 | 多轮循环、工具并发、预算、watchdog、熔断、角色预设 | 已落地；但模型能力开关 `supportsToolCall` 未进入执行流，`tools: allTools` 无条件下发（`:2714`） | **基本完整** | F-003 | 高（循环与预算对齐；capability gate 缺口） |
| 四 | 原生工具矩阵与接线规范 | 工具单一事实来源 `BASE_TOOLS ∪ TOOL_HANDLER_NAMES`、8 环节登记 | **半截**：8 环节矩阵测试只查「孤儿」，不查「逐工具覆盖」；审批分级 `TOOL_LEVEL`、可补偿性 `REVERSIBILITY` 未被矩阵读取 | **半截** | F-002、F-016 | 中（声明式 registry 是主流方向，当前是源码扫描） |
| 五 | MCP 三层治理与意图预热 | 连接/工具缓存/意图预热/tier 懒启动/稳定排序 | **半截**：拼名与反解不可逆、`MCP-Protocol-Version` 头缺失、第三方描述无闸、resources/prompts/tasks 全未接、`clientInfo` 版本错 | **半截** | F-005、F-006、F-007、F-013、F-014 | 中（tools profile；能力协商不完整） |
| 六 | 技能、生态中心与数字员工 | 100 skills / 77 connectors / 51 employees；员工 → `rolePreset` → 运行时 | **已落地（P3 用 12 环证据链确认，推翻简报 F-004 的「零调用」判定）**：`EcosystemModal.jsx:174,179` → `App.jsx:253,250` → `ChatArea:328,321` → `ChatArea:399-401` → `useAgentRun.ts:610` → `lib/agent.js:182,51,138` → `preload.js:253` → `main.js:1093` → `agentRunner.js:350,364-374` → `agent-core/index.js:2139,2226-2233,2419-2429`（完整逐环见 §3.2）。缺口：**README 自相矛盾**（F-021）、**回退路径不钳制**（F-020）、**无 E2E 测试**。**但 G1/G2 是 P1 安全项（F-018/F-019），不随本章降级** | **基本完整** | F-004（重写，降级 P2）、F-010 | 中高（单 runtime preset 对齐主流；无 E2E 守护） |
| 七 | 三层记忆体系 M0–M4 | session/project/global 三层、配额 2/3/2、半衰期、容量闸 | 已落地；`LAYER_QUOTA={session:2,project:3,global:2}`、容量 200/50/500/300（D-14）与文档一致 | **完整** | — | 高（分层记忆 + 配额注入对齐主流 context 工程） |
| 八 | 任务编排与 Worker 池 | `planGoal` → `validateDag` → `createGroup` → WorkerPool → Aggregator | 已落地；但 `〔§8 编排·流程图常量节点〕` 写「`MIN / MAX_TASKS = 8`」，实际 `MIN_TASKS=2 / MAX_TASKS=8 / MAX_DEPS=4`（D-08/D-09/D-10/D-11） | **基本完整** | F-011 | 高（拓扑分层 + worker 池对齐 ADK 渐进式方向） |
| 九 | 审批、沙箱与安全约束 | 四档审批、L1/L2/L3 分级、三平台沙箱、fail-closed | 已落地；但分级默认回落 `L2`（`approval.js:351`）未被登记门禁守护（F-002）；Linux 走 bwrap 而非 Landlock+seccomp（D-09 待决） | **基本完整** | F-002、D-09 | 中高（sandbox/approval 正交对齐 Codex；登记门禁未守） |
| 十 | 验证层 | `verifyPolicy` / `verifyRun` / V-L1 / V-L3 | 已落地但**本章是全篇最薄的一章**（仅一节三小节，无量化指标）；V-L1/V-L3 与无人值守 fail-closed 有实现，但**能力回归（成功率/轮次/token）不在本章闭环内** | **基本完整** | F-008 | 中（verifier 有；eval-driven 闭环缺） |
| 十一 | i18n 与界面结构 | 多语言、界面分区、裸 button 收敛 | 已落地；`desktop/renderer/src/i18n/` 存在 `index.ts` + `locales/`；G7 裸 button 基线 258 尚未归零（第六轮标注为持续收敛） | **基本完整** | F-017 | 中高 |
| 十二 | 门禁、CI 与评估 | 命令级门禁、发现式全量测试、CI 语法门禁、离线评估 | **半截**：`〔§12 门禁·命令表 typecheck 行〕` 写「220 套件全部通过」——220 实为**检查项**总数（219 suite + 1 gate），且随 untracked 新测试变化（C-03/C-05/C-06）；`eval --check` 进基线但**真跑未进 CI** | **半截** | F-008、F-009 | 中（发现式 + 棘轮对齐；持续评估未闭合） |
| 十三 | 里程碑现状 | 里程碑与遗留项清单 | 已落地；内容与本轮发现互为印证，但未标注「哪些承诺只存在于未提交 diff」 | **基本完整** | F-012 | 中 |

### 2.1 完整度汇总

| 完整度 | 章数 | 章号 |
|---:|---:|---|
| 完整 | 2 | 二、七 |
| 基本完整 | 8 | 一、三、六、八、九、十、十一、十三 |
| 半截 | 3 | 四、五、十二 |
| 缺失 | 0 | — |

### 2.2 五处「半截实现」的确定性判定（用户点名项）

#### （1）第 4 章工具矩阵 —— 门禁假闭环

- 文档声称：8 环节逐环节双向差集守护（当前快照 `〔§4 工具矩阵·单一事实来源段〕`）。
- 实际：矩阵测试把 8 环节定义为 schema / RPC 白名单 / handler / timeout / CWD / `APPROVAL_TOOLS` / `BASE_PROMPT` / UI+i18n（`desktop/test/tool-registration-matrix.test.mjs:10-13`）。
- **未覆盖**：`main/approval.js` 的 `TOOL_LEVEL`（`toolLevel()`，`:351` 默认回落 `'L2'`）与 `REVERSIBILITY`（`:44`、`:100` 消费）。
- **断言性质**：`:103-128` 只查「条目是不是孤儿」，**不查 53 个模型工具（B-03）是否逐个有覆盖**。
- **可证明的反例（无需执行）**：新增一个工具，在 `BASE_TOOLS` 与 `TOOL_CHANNELS` 登记齐全，但**不写 `TOOL_LEVEL`、不写 `REVERSIBILITY`** → 矩阵全绿，该工具静默落入 L2 + 泛化可补偿结论。
- 裁定：**半截**。

#### （2）第 5 章 MCP —— 跨包命名契约不可逆

- 拼名：`desktop/shared/mcpToolDefs.mjs:16-27` → `` name: `mcp__${s}__${t.name}` ``。
- 反解：`desktop/agent-core/index.js:3271-3276` → `const parts = name.split('__'); const server = parts[1], toolName = parts.slice(2).join('__');`
- **确定性反例**：server=`my__svc`、tool=`x` → 拼出 `mcp__my__svc__x` → `parts=['mcp','my','svc','x']` → **server=`my`、tool=`svc__x`**。
- 入口校验：`desktop/main/ipc/mcp.js:383-392` 仅 `guard.assertStrings(payload, { name: 120, ... })`——**只校验长度 ≤120，不校验字符集、不禁用分隔符**。
- 裁定：**半截**。修复方向见 §5 的 B1-B-05（编码而非禁止，避免破坏存量配置）。

#### （3）第 5 章 MCP —— 协议头缺失

- 声明：`desktop/main/mcpProtocol.js:9-24` 宣称支持 `2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05`。
- 实际：`desktop/main/mcpClient.js:347-365` 的 `createHttpTransport` 请求头只有 `Content-Type`、`Accept`、`Mcp-Session-Id`、自定义 `headers`、`Authorization`——**无 `MCP-Protocol-Version`**；`server.protocolVersion` 虽在 `:203-235` 保存但未传给 transport。
- 裁定：**半截**（规范 MUST 项缺失；远端是否 400 **未验证**）。

#### （4）第 6 章数字员工 —— 简报判定被推翻（P3 用 12 环证据链确认），完整判定见 §3.2

- **12 环端到端闭合链（HEAD `924909c`，P3 独立核验，逐环可定位）**：

| 环 | 位置 | 作用 |
|---:|---|---|
| 1 | `desktop/renderer/src/components/EcosystemModal.jsx:174` | 「招募」按钮触发 `ecosystemEmployeeRuntime` |
| 2 | `EcosystemModal.jsx:179` | 派发 `mjcode:recruit-expert`，携带 `runtime: r.rolePreset` |
| 3 | `desktop/renderer/src/App.jsx:253` | 监听 `recruit-expert` |
| 4 | `App.jsx:250` | `setTimeout(0)` 后再派发 `mjcode:enable-expert`（时序：等切会话清空 extras 落定） |
| 5 | `desktop/renderer/src/components/ChatArea.jsx:328` | 监听 `enable-expert` |
| 6 | `ChatArea.jsx:321` | 写入 `sessionExtras.expert` |
| 7 | `ChatArea.jsx:399-401` | 把 `sessionExtras` 传给 `useAgentRun` |
| 8 | `desktop/renderer/src/hooks/useAgentRun.ts:610` | `rolePreset: sessionExtras?.expert?.runtime \|\| undefined` |
| 9 | `desktop/renderer/src/lib/agent.js:182`（另 `:51`、`:138`） | 选择主通道 / 进程内回退通道 |
| 10 | `desktop/main/preload.js:253` → `desktop/main/main.js:1093` | bridge → IPC handler |
| 11 | `desktop/main/agentRunner.js:350`、`:364-374` | 传 `engineParams`；`stricterApproval()` / `stricterSandbox()` 取更严格者 + `skillNames` 注入 |
| 12 | `desktop/agent-core/index.js:2139`、`:2226-2233`、`:2419-2429` | 角色提示拼进 system；按 `toolNames` 裁剪 `allTools` |

- **引擎侧行为已被单测覆盖**：`desktop/test/role-preset.test.mjs`（工具子集生效 / 角色提示入 system / 空交集回落 / MCP 与 BASE 分别裁剪 / 无 preset 时行为不变）。
- **真实缺口三点**：(a) **README 自相矛盾**（F-021）：〔README·ecosystem 目录行〕写 "not yet wired into the Agent runtime"，而〔README·审查流程第 4 步〕写「`rolePreset` 运行时落地」——同一文件两个相反结论；(b) **进程内回退路径不钳制**（F-020）：`lib/agent.js:182` 的 `runAgentInProcess` 不经 `agentRunner` 的审批/沙箱钳制；(c) 12 环中第 1–8 环（React 层）无自动化守护。
- 裁定：**基本完整**；F-004 降为 **P2**。
- ⚠️ **不得随 F-004 沉没的两条**：本链第 12 环的 `:2419-2429` 正是 **F-018（空交集 fail-open）** 与 **F-019（`allowMcp` 缺省 true）** 的所在——这两条是 **P1·安全**，与「数字员工是否接通」是**两个独立问题**。

#### （5）第 8 / 10 / 12 章 —— 常量与口径错误

- 第 8 章：`〔§8 编排·流程图常量节点〕` 写「规模常量 `MIN / MAX_TASKS = 8`」，实际 `MIN_TASKS=2`（D-08）。同文件 `〔§3 执行流·相关段〕` 又写对了 → **文件内部自相矛盾**。
- 第 10 章：`desktop/eval/run-eval.mjs:333-350` 的 `--check` 只做 schema + fixture 物化 + fail-to-pass 基线；真正执行在 `:353-366`，需 `--base-url/--model`（或环境变量），**CI 未触发**。
- 第 12 章：`〔§12 门禁·命令表 typecheck 行〕` 的「220 套件」= 219 suite + 1 gate 的**检查项**总数（C-05），不是套件数。
- 裁定：第 8 章 **基本完整**（常量描述错，实现正确）；第 10/12 章因 eval 闭环未成 → 第 12 章 **半截**。

---

## 3. 发现清单（F-001 ～ F-022）

> **编号纪律**：F-001 ～ F-014 沿用研究员简报编号与分级，**不删改、不重排**；架构师新增 F-015/F-016/F-017；P3 独立核验新增 F-018 ～ F-022。
> 分级：**P0** 阻断发布 / **P1** 发布前应修 / **P2** 计划内修 / **P3** 线索观察。本轮 **P0 = 0**，P1 = 11 条，P2 = 11 条。

### 3.1 P1 清单

| 编号 | 问题 | 证据（绝对路径:行号） | 影响 | 修复方案概述 |
|---|---|---|---|---|
| **F-001** | 技术流程文档不在 Git 中，无法绑定 `924909c` | `/Users/jianma/Desktop/MJCode/MJcoder-技术流程功能文档.md`；`.gitignore:46` 的 `*.md` 规则 | 任何「文档与 commit 一致」的结论不可复刻；checkout `924909c` 拿不到该文档 | 纳入 `docs/` 并写 commit + 生成时间 + 计数脚本（D-10） |
| **F-002** | 「工具登记矩阵守 8 环节」是假闭环 | `desktop/test/tool-registration-matrix.test.mjs:10-13,103-128`；`desktop/main/approval.js:351,44,100` | 新增工具漏审批分级 → 静默落 L2；漏可补偿声明 → 走泛化结论；矩阵仍全绿 | 矩阵改为「逐工具 × 逐环节」全覆盖断言；中期建声明式 registry（D-06） |
| **F-003** | `supportsToolCall` 只落库，不控制工具通告 | `desktop/main/modelsFile.js:66,205`、`desktop/main/ipc/localData.js:29`、`desktop/renderer/src/components/settings/ModelsTab.tsx:299-300`；`desktop/agent-core/index.js:2413,2714`（`tools: allTools`） | 对不支持 tool calling 的端点，关掉开关也照发 `tools`，UI 给出错误控制感 | false 时 `allTools=[]` 并切换无工具 system prompt（D-04） |
| **F-005** | MCP 自定义服务名未规范化，`__` 必然破坏路由 | `desktop/main/ipc/mcp.js:383-392`（仅长度 ≤120）；`desktop/shared/mcpToolDefs.mjs:16-27`；`desktop/agent-core/index.js:3271-3276` | 「工具能展示、调用必找错服务」的跨包契约断裂 | 服务端名做**可逆编码**（不是禁止），反解端同步（B1-B-05） |
| **F-006** | Streamable HTTP 未发送 `MCP-Protocol-Version` | `desktop/main/mcpClient.js:347-365` vs `desktop/main/mcpProtocol.js:9-24` | 严格服务端可能对 `tools/list`/`tools/call` 返回 400（**未验证**） | 保存的 `protocolVersion` 注入后续请求头（B1-B-04） |
| **F-007** | 第三方 MCP 工具 `description`/`inputSchema` 无长度闸与不可信守卫 | `desktop/main/mcpClient.js:101-123`、`desktop/main/mcpToolCache.js:22-31`、`desktop/shared/mcpToolDefs.mjs:16-27`；对照工具**结果**已有 `desktop/agent-core/index.js:3345-3355` 的 `detectInjection` | 恶意/失控 server 可用超长或指令化描述挤占上下文、影响工具选择 | 定义侧加长度闸 + schema 深度/大小闸 + 不可信标记（B1-B-06） |
| **F-012** | 第六轮 N7 清洁基线已回退；关键「已实现」只在未提交 diff | `git status --short`（12 dirty）；`origin/main...HEAD = 0 2`；diff 含 `desktop/main/ipc/mcp.js`、`db/index.js`、`main.js`、`taskStore.js` | 基于 HEAD 打包不含 MCP 默认注入修正与 `project_path` 迁移 | 发布前提交 + 推送；方案须给双口径（§3.3） |
| **F-015**（新增） | **技术流程文档在 7 分钟窗口内出现 3 个版本**，冻结锚点失效 | v1 `217a162b…`(712, 07:33:46) → v2 `5401942147…`(712, 07:40:49) → v3 `175f1b3f11d58b9b`(714, 07:41:00)；骨架内容 v1 `:294` → v3 `:296` 位移（A-06a） | 同一窗口内 P0/P1/P3 各读一版，结论不可对齐；行号与行数**双双失去锚点资格** | **B0 第一步冻结只读副本 + 全篇改章节锚点**（B0-B-01） |
| **F-018**（新增·P1 安全） | **角色工具交集为空时 fail-open**：只 `console.warn`，`allTools` 保持全量 | `desktop/agent-core/index.js:2419-2429`（`else { console.warn(...回落全量工具) }`；`allTools` 不被改写） | **只读角色配错 `toolNames` → 反而获得全部 53 个工具**（含写文件 / shell / MCP 写工具）。**权限方向错误，不是体验缺陷** | 空交集必须 **fail-closed**：回落为空集 + 明确错误（B1-B-02 第②项） |
| **F-019**（新增·P1 安全） | **`rolePreset.allowMcp` 缺省 true** → 只读角色仍可调任意 MCP 写工具 | `desktop/agent-core/index.js:2416-2425`（`allowMcp === false` 才走白名单，否则 `mcpTools` 全量）；代码注释自认「翻默认值需同批改 `buildEmployeeRuntimePreset`，属下一版遗留」 | 最小权限闭包在 MCP 维度**未生效**；只读角色可通过 MCP 写外部系统 | 见 §4.4 D-05 的翻转判定（给出触发条件与存量代价） |
| **F-022**（新增·P1 门禁） | 新增的 `docs-consistency.test.mjs` 是**半硬门禁**（常量断言硬 / 引用存在性与缺文档分支软），叠加 CI 恒跳过 → 事实上失效 | `desktop/test/docs-consistency.test.mjs:38-40`（文档缺失 → `console.log(⚠跳过)` + `process.exit(0)` **fail-open**）；该文档受 `.gitignore:46 *.md` 忽略 → CI 冷检出**必然走此分支** | ① 变异测试 R-5：文档内引用改名后计数 28→27 仍 22/22 全绿；② R-6：文档缺失仍 **EXIT=0**；③ CI 上**恒 skip 恒绿**。**「看起来有门禁、实际恒真」比没有校验点更危险**（本项目历史已复现）。**定性为半硬门禁 ≠ 降级：因它在 CI 上恒走跳过分支，对 CI 而言事实上不起作用，故仍为 P1** | 文档入 Git + 计数断言 + **缺失即红**（B0-B-04，见 §5） |

### 3.2 P2 清单

| 编号 | 问题 | 证据（绝对路径:行号） | 影响 | 修复方案概述 |
|---|---|---|---|---|
| **F-004**（**重写，降级 P1→P2**） | 数字员工链路**已 12 环闭合**（§3.2），真实缺口是「README 自相矛盾 + 回退路径不钳制 + 无 E2E 守护」 | 12 环见 §3.2；矛盾见〔README·ecosystem 目录行〕("not yet wired") vs 〔README·审查流程第 4 步〕("`rolePreset` 运行时落地")；回退路径 §3.2 环 9；引擎侧单测 `desktop/test/role-preset.test.mjs` | 对外声明自相矛盾；进程内回退路径绕过审批/沙箱钳制；React 层 8 环无守护 | 修 README 措辞 + 回退路径补钳制（B2-B-11/B2-B-15）；**F-018/F-019 单列为 P1，不随本条降级** |
| **F-020**（新增·P2 边界） | **进程内回退路径不做审批/沙箱钳制**，与主路径行为不一致 | `desktop/renderer/src/lib/agent.js:182`（`mainChannelReady ? runAgentViaMain : runAgentInProcess`）vs `desktop/main/agentRunner.js:364-374`（主路径的 `stricterApproval`/`stricterSandbox`） | 主通道不可用时（回落路径）角色 preset 的审批/沙箱**只收紧不放松**这一保证失效 | 回退路径复用同一钳制函数（B2-B-15） |
| **F-021**（新增·P2 文档） | **README 自相矛盾**：同一文件两个相反结论 | 〔README·ecosystem 目录行〕写 "not yet wired into the Agent runtime"；〔README·审查流程第 4 步〕写「51 个角色 + `rolePreset` 运行时落地 + 审批沙箱只收紧不放宽」 | P3 用 12 环证明后者才是事实；前者会误导外部读者与新成员 | 并入 F-004 处置：删/改前者（B2-B-11） |
| **F-008** | G11 只把 eval「自检」接进基线，未形成性能回归门禁 | `desktop/test/run-all.mjs:45-51`；`desktop/eval/run-eval.mjs:7-10,43-52,333-350`（`--check`）vs `:353-366`（真跑） | 220/221 检查项全绿的同时，15 个 eval 任务（C-07）成功率可下降而无人发现 | PR 小样 + nightly 全量 + 基线差分（D-07） |
| **F-009** | 测试基线把「219/220 suite + 1 gate」统称「220 套件」 | 技术文档当前快照 `〔§1 产品定位·目录结构段〕,〔§12 门禁·命令表〕,〔§12 门禁·命令表 typecheck 行〕`；README `〔README·测试套件声明段〕`；`desktop/test/run-all.mjs:28-40,49-53` | P3 复核易把 gate 当 suite；「全绿」在本轮无新证据（C-09 未验证） | 文档改为「suite 数 + gate 数」双数字；状态标注为历史结果 |
| **F-010** | README 生态数量漂移 | `README.md〔README·ecosystem 目录行〕` 写 100 / 80 / 50 = 230；现算 100 / 77 / 51 = 228（D-02/D-04/D-05/D-07） | 对外能力清单不可复核；「精选 / WorkBuddy 原始 / 合并后」三口径混用 | 数字改为生成式，CI 校验（B1-B-08） |
| **F-011** | 技术文档三处可直接证伪的当前事实 | `〔§1 产品定位·server 目录行〕` 写 Spring Boot（实际 Node.js + Express，`server/package.json:2-20`）；`〔§1 产品定位·设置页段〕` 写「设置页仅保留版本更新」（同文档 `〔§5/§9 设置与审批段〕` 及 `〔§9 审批段〕`、`〔§11 i18n 段〕` 与源码有多项设置）；`〔§8 编排·流程图常量节点〕` 写 `MIN / MAX_TASKS = 8`（实际 MIN=2，D-08） | 按文档施工会选错技术栈 / 误删设置 / 误解 DAG 下限 | 事实类陈述改为代码同源生成 |
| **F-013** | MCP 握手自报版本 `1.0` ≠ 应用版本 `0.6.1-beta` | `desktop/main/mcpProtocol.js:46`；`desktop/package.json:3`（D-17/D-18/D-19） | 服务端日志显示虚构版本，降低故障可追溯性 | `clientInfo.version` 取 `package.json` version |
| **F-014** | MCP 是 tools-only 子集，resources/prompts/tasks 未接 | `desktop/main/mcpClient.js:184-291,717-720`；`desktop/main/ipc/mcp.js:275`；全仓 `resources/list\|resources/read\|prompts/list\|prompts/get\|tasks/get` 零命中 | 资源浏览 / prompt 模板 / 结构化输出校验 / 长任务原语不可用 | 声明为「tools profile」；按 D-02 决定是否补只读面 |
| **F-016**（新增） | 源码注释内嵌的基线数字已腐烂 | `desktop/agent-core/index.js:2401` 注释称「`BASE_TOOLS` 条数被 `test/web-todo-tools.test.js` 钉死为 **41**」；实际该测试 `:43` 标题序列止于 51、`:54` 断言 **52**（B-01） | 后续开发者以注释为准会误改测试基线，制造假红/假绿 | 注释改为引用常量而非写死数字；或加一条「注释数字 vs 断言」的一致性检查 |
| **F-017**（新增） | 存量收敛项无清理计划与归属 | 死 bridge 方法 46/202 = 22.8%（B-11，门禁上限 40%，**会绿**）；裸 button 基线 258（`desktop/test/ui-conventions.test.js:26`，G7 未归零） | 门禁设计成「不恶化」而非「收敛」，存量长期挂账；其中混有数字员工/治理统计等真实半截能力 | 建立存量台账 + 每轮下调配额；死方法逐项判定「补消费 / 下架」 |

#### §3.2.1 · F-004 的 12 环证据链（P3 独立核验，逐环可定位）

> 用途：这是推翻简报「渲染层 `rolePreset` 零调用」的**唯一证据**。任何后续对该结论的质疑，应逐环反驳本表，而不是重新跑一次 grep。

| 环 | 位置（HEAD `924909c`） | 作用 | 归属层 |
|---:|---|---|---|
| 1 | `desktop/renderer/src/components/EcosystemModal.jsx:174` | 「招募」按钮 → `ecosystemEmployeeRuntime` | 渲染层 |
| 2 | `EcosystemModal.jsx:179` | 派发 `mjcode:recruit-expert`，`runtime: r.rolePreset` | 渲染层 |
| 3 | `desktop/renderer/src/App.jsx:253` | 监听 `recruit-expert` | 渲染层 |
| 4 | `App.jsx:250` | `setTimeout(0)` 后派发 `mjcode:enable-expert`（等切会话清空 extras 落定） | 渲染层 |
| 5 | `desktop/renderer/src/components/ChatArea.jsx:328` | 监听 `enable-expert` | 渲染层 |
| 6 | `ChatArea.jsx:321` | 写入 `sessionExtras.expert` | 渲染层 |
| 7 | `ChatArea.jsx:399-401` | `sessionExtras` 传入 `useAgentRun` | 渲染层 |
| 8 | `desktop/renderer/src/hooks/useAgentRun.ts:610` | `rolePreset: sessionExtras?.expert?.runtime \|\| undefined` | Hook |
| 9 | `desktop/renderer/src/lib/agent.js:182`（另 `:51`、`:138`） | 主通道 / 进程内回退通道选择 | 桥 |
| 10 | `desktop/main/preload.js:253` → `desktop/main/main.js:1093` | bridge → IPC handler | 主进程 |
| 11 | `desktop/main/agentRunner.js:350`、`:364-374` | 传 `engineParams`；`stricterApproval()`/`stricterSandbox()` + `skillNames` 注入 | 宿主 |
| 12 | `desktop/agent-core/index.js:2139`、`:2226-2233`、`:2419-2429` | 角色提示入 system；按 `toolNames` 裁剪 `allTools` | 引擎 |

**三处需特别注意的地方**：

- **环 9 是 F-020 的所在**：`mainChannelReady` 为 false 时走 `runAgentInProcess`，该路径**不经过**环 11 的审批/沙箱钳制。
- **环 12 是 F-018 / F-019 的所在**：`:2419-2429` 空交集 fail-open、`:2416-2425` `allowMcp` 缺省 true。**这两条与「链路是否接通」无关，是纯粹的最小权限问题。**
- **环 1–8（React 层）无自动化守护**：`role-preset.test.mjs` 只覆盖环 11–12 的引擎行为。

### 3.3 「基于 HEAD 打包」vs「合并当前 diff 后」的差异（发布基线必读）

工作区当前状态：12 个 tracked 未提交文件（A-03）+ 2 个 untracked 条目（A-04）+ 本地领先远端 2 个提交（A-02）。

| 维度 | 基于 HEAD（`924909c`）打包 | 合并当前 diff 后打包 | 对方案的影响 |
|---|---|---|---|
| 测试套件数 | **217** + 2 smoke = **219** suite | **218** + 2 smoke = **220** suite | 门禁总数 220 / 221（C-03/C-05）。**验收命令里的期望数字必须指明口径**，否则跨环境不可判定 |
| `docs-consistency.test.mjs` | **不存在** | 存在（untracked，07:41 新建） | 该套件若断言文档数字，两种口径下 `npm test` 结论不同 |
| MCP 默认注入修正（`mcp:listTools` 只回已连接服务） | **不在制品中**（位于未提交 `desktop/main/ipc/mcp.js`） | 在制品中 | 若按 HEAD 打包，第五轮/第六轮承诺的 MCP 行为**不生效** |
| `task_groups.project_path` 迁移 | **不在制品中**（位于未提交 `desktop/main/db/index.js`、`main.js`、`taskStore.js`） | 在制品中 | 编排组与项目路径的绑定在 HEAD 制品中缺失 |
| 记忆 `conversationId` 修复（孤儿行） | **不在制品中**（位于未提交 `desktop/renderer/src/hooks/useAgentRun.ts` diff） | 在制品中 | `model_conclusion` 记忆在 HEAD 制品中会落 `conversation_id=NULL` |
| 数字员工 `rolePreset` 链路 | **在**（全部 7 段均在 HEAD） | 在 | 两种口径一致（§2.2(4)） |
| README 生态数字 | 两种口径下均为 100/80/50=230（漂移未修） | 同左 | 见 F-010 |

**结论（建议）**：**发布基线取「合并当前 diff 后」**。理由：第五/六轮的 3 项实质修复（MCP 默认注入、`project_path` 迁移、记忆 `conversationId`）只在 diff 中，按 HEAD 打包等于把这些已完成的修复**退回**。但前提是先完成 B0（提交 + 冻结文档快照 + 生成式数字）。

---

## 4. 决策链路（D-01 ～ D-10）

> **来源纪律**：本节「主流做法 + 来源 URL」条目沿用 P0 研究员 16 次 WebSearch 取证结果（只采用 MCP / OpenAI / Anthropic / Google ADK 官方来源），**架构师本轮未重新联网复核 URL 可达性**。
> **推荐性质**：以下推荐是「架构师的专业建议 + 依据」，**最终拍板在用户**。每个决策均给出「若否决推荐方案，退而求其次的选择」。

### 4.1 决策总表

| 决策点 | 推荐方案 | 一句话理由 | 依赖的上游决策 | 成本档 | 阻断发布 |
|---|---|---|---|:---:|:---:|
| **D-10** 文档发布纪律 | **A**：纳入 `docs/`，头部写 commit + 生成时间 + 计数脚本，CI 校验 | 没有可复核基线，其余 9 个决策的**验收都不可判定** | —（元决策） | 低 | **是** |
| **D-06** 工具登记安全门禁 | **C**：先 A 止血（矩阵改逐工具×逐环节），再 B 收敛到声明式 `toolRegistry` | 它是 D-04/D-03/D-05/D-09 共同的**元信息来源**，必须先有 | D-10 | 中 | **是** |
| **D-04** `supportsToolCall` 语义 | **B 先落地**（false → `allTools=[]` + 无工具 system prompt），C 作为演进。**必与 F-018 同批**：把空交集回落改为 fail-closed | 用户已可见的开关不该是装饰；且与 F-018 共同作用于同一 `allTools` 组装点 | D-06 | 低 | **是** |
| **D-03** 工具发现粒度与 prompt cache | **C**：native 常驻 + MCP server 懒连 + 单工具按需展开 | 只有 registry 元信息齐备后，才能按 policy（而非按源码扫描）决定暴露面 | D-06、D-04 | 中 | 否 |
| **D-02** MCP 产品 surface | **近期 A**（正式声明 tools profile）→ **中期 B**（补只读 resources/prompts），B 的前置是 D-03 的上下文预算闸 | 先保证只有**一套**工具源被治理，再扩 surface | D-03 | 中 | 否 |
| **D-01** MCP 版本路线 | **A+**：补齐 2025-11 合规（版本头）+ 抽 transport 抽象预留 B | 双栈与 D-09-B、D-03 抢同一份 native/传输投入，本轮不排 | D-02 | 低 | 否（但 F-006 修复本身属 P1） |
| **D-05** 数字员工 runtime | **B′**（修正版）：保留现有 12 环实现，改 README 措辞 + 回退路径补钳制 + 补事件链守护；**并裁定 F-019 的 `allowMcp` 缺省值是否本轮翻转** | 实现**已在 HEAD 12 环闭合**（§3.2.1），不需要「接入或下架」二选一；剩余问题是最小权限而非连通性 | D-06、D-04 | 低 | 否（但 F-019 本身 P1） |
| **D-08** Trace 标准化 | **B**：内部 span model + 可选 OTLP exporter（默认本地、不上传） | 为 D-07 的差分指标提供可比结构 | D-10 | 中 | 否 |
| **D-07** Eval 执行频率 | **B**：PR 跑小样、nightly/发布前跑全量、结果做基线差分 | 15 个任务（C-07）全量每次提交跑，成本与非确定性都过高 | D-10、D-08 | 中 | 否 |
| **D-09** Linux sandbox 后端 | **近期 A**（bwrap + 可用性探测/失败说明强化）；中期 B（Landlock+seccomp） | 与 D-01-B 抢资源，本轮明确让位 | D-06 | 低（近期） | 否 |

**阻断发布的 3 项**：D-10、D-06、D-04。其余 7 项不阻断，但 D-03/D-02/D-01 构成一条**必须按序推进**的能力链。

### 4.2 决策主线：一条因果链，不是十条孤立建议

**总纲：先把契约钉死，再谈能力扩张。**

```
D-10 文档发布纪律（元决策：让一切验收可判定）
   │
   ▼
D-06 声明式工具 registry（先止血：矩阵改逐工具×逐环节；再收敛：单一事实来源）
   │
   ├──────────────► D-04 capability gate：registry 提供「每个工具的元信息」，
   │                 capability=false 时才知道该留什么、该怎么降级
   │                        │
   │                        ▼
   │                 D-03 工具发现粒度：有了 registry 元信息 + gate，
   │                 才能按 policy（而非源码扫描）决定常驻/懒连/单工具展开
   │                        │
   │                        ▼
   │                 D-02 MCP surface：工具源已被 registry 统一治理后，
   │                 补 resources/prompts 才不会引入「第二套未被治理的来源」
   │                        │
   │                        ▼
   │                 D-01 MCP 版本路线：surface 定了，双栈要覆盖哪些
   │                 transport/capability 才有边界
   │
   ├──────────────► D-05 数字员工 runtime：角色 preset 的工具子集 /
   │                 审批 / 沙箱继承，都需要 registry 的元信息才有最小权限闭包
   │
   ├──────────────► D-09 Linux sandbox：沙箱策略由 registry 的
   │                 审批分级 + 可补偿性元信息驱动
   │
   └──（与 D-08 并列）► D-07 eval 频率 ←── D-08 trace 标准化
                        （差分指标需要可比 trace 结构）
```

**为什么是这个顺序（第一性原理，不是照搬案例）**：

1. **可判定性优先于正确性**。一个不能被机器判定的「已修复」，在下一轮审查里会重新变成发现项——第六轮 N4（工具 8 环节）就是活证据：当时判「已落地」，本轮 F-002 判「假闭环」。所以 D-10 在最前。
2. **元信息来源唯一，才能谈策略**。capability gate、工具发现粒度、角色最小权限、沙箱策略，这四件事消费的是**同一份**「工具元信息」（名字/schema/通道/超时/审批级/可补偿性/CWD）。当前这份信息散在 `BASE_TOOLS`、`TOOL_HANDLER_NAMES`、`TOOL_CHANNELS`、`APPROVAL_TOOLS`、`TOOL_LEVEL`、`REVERSIBILITY`、`CWD_TOOLS` 七处——**七处登记面 = 七处漂移面**。先收敛（D-06），才能让下游四个策略各自只写一条规则。
3. **先收暴露面，再扩来源**。D-03（减少常驻工具）与 D-02（增加 resources/prompts）对上下文预算的作用相反。若先做 D-02，等于在预算闸还没建立时就往上下文里加东西——这正是 F-007（第三方描述无闸）已经踩到的坑的放大版。所以 **D-02-B 必须排在 D-03 之后**。
4. **版本路线服从 surface 边界**。D-01 的「双栈要覆盖多少」完全由 D-02 决定：若 surface 只是 tools，双栈只需覆盖 transport + tools/list/call；若补了 resources/prompts/tasks，双栈的 capability negotiation 面积会翻倍。所以先定 D-02 再定 D-01。
5. **资源排期服从总纲**。D-01-B（双栈）与 D-09-B（Landlock+seccomp）都要 native/传输层投入，本轮明确让位给 D-06/D-04/D-03——因为前者是「覆盖更多服务端」，后者是「自己声明的契约是真的」，**后者是前者的前提**。

### 4.3 上下文一致性自查（约束对逐条核对）

> 逐条列出「若选了 X，则 Y 必须同步」的约束。我已逐对核对，**发现 1 处真实矛盾（约束对 #4）**，必须在 B1 一并修。

| # | 约束对 | 若选 X | 则 Y 必须同步 | 核对结果 |
|---|---|---|---|---|
| 1 | **D-02 × D-03**（对上下文预算的共同影响） | 若补 resources/prompts（D-02-B） | 必须与 D-03 共用**同一个**上下文预算闸常量；resources 内容一律**按需拉取 + 长度闸**，禁止常驻进 system | ✅ 不矛盾，但**顺序被强制**：D-03 先于 D-02-B。已在 §4.2 第 3 条与 B2/B3 排期中落实 |
| 2 | **D-04 × 任务编排/子代理**（对工具的依赖） | 若 `supportsToolCall=false` 时 `allTools=[]` | `orchestrator` 与 `spawn_subagent` 入口必须 **fail-fast 并给出明确错误**，不得静默跑空轮；可复用已有的 planMode filter 机制（`agent-core/index.js:2432`） | ✅ 不矛盾。实现上「清空」与「planMode 过滤」是同一处 `allTools` 的不同 filter，顺序可确定 |
| 3 | **D-04 × D-05**（两层都裁 `allTools`） | 若 capability gate 与 `rolePreset.toolNames` 同时生效 | 裁剪顺序必须写死：**capability 门（硬）→ 角色子集（软）→ planMode filter** | ✅ 不矛盾，但需在代码中显式固化顺序，不能依赖当前的行文顺序 |
| 4 | **D-04 × F-018 × D-05（三点交汇，重算后）** | 若 capability 门与角色子集都作用于 `allTools` | **裁剪顺序必须三段显式、且每段 fail-closed**：① **capability 门（硬·fail-closed）**：`supportsToolCall===false` → `allTools=[]`，**跳过后续所有“加回来”的回落**；② **角色子集（软·空交集也必须 fail-closed）**：`rolePreset.toolNames` 交集为空 → **回落为空集 + 明确错误**（现状 `agent-core/index.js:2419-2429` 只 `console.warn` 并保持全量，**这是 F-018 本身**）；③ **planMode filter**（既有 `:2432`） | ❌ **已确认为真实矛盾并升级为 P1 安全项**。F-018 不是本条附注，而是**独立缺陷**：即使没有 capability 门，空交集 fail-open 也已使只读角色获得全量工具 |
| 4b | **D-04 × F-019（MCP 维度）** | 若 capability 门清空 native 工具 | 仍须裁定 `allowMcp` 缺省值：现状「缺省 true → 只读角色可调任意 MCP 写工具」。capability=false 与 `allowMcp` 缺省是**两个独立开关**，二者都不应默认放宽 | ❌ **独立缺陷（F-019，P1）**。裁定见 §4.4 D-05 的翻转判定 |
| 5 | **D-07 × local-first 成本约束** | 若 nightly 跑全量 eval（15 任务，C-07） | eval 真跑**默认关闭**，需显式配置 endpoint/model/用户自有 key；结果落本地 `desktop/eval/results/`（目录已存在），**不上传**；CI 里只有零成本的 `--check` | ✅ 不矛盾。与 local-first 定位一致 |
| 6 | **D-01 × D-09**（资源投入排期冲突） | 若选 D-01-A+ 与 D-09-A | 本轮**不做** D-01-B（双栈）与 D-09-B（Landlock+seccomp），两者都推到 B3；释放资源给 D-06/D-04/D-03 | ✅ 不矛盾。已在总表「成本档」中体现（D-01 低、D-09 近期低） |
| 7 | **D-06 × D-03**（元信息消费关系） | 若建立声明式 registry | 单工具延迟加载（D-03）**必须复用** registry 字段，不得另建索引，否则又出现「第二套元信息」 | ✅ 不矛盾。顺序已定：D-06 先于 D-03 |
| 8 | **D-08 × D-07**（差分指标的数据基础） | 若 PR 小样 + nightly 全量做基线差分 | trace 必须先有**稳定 schema + run/span 结构**（D-08-B），否则「成功率/轮次/token/耗时」四项无法跨版本对齐 | ✅ 不矛盾，但**顺序被强制**：D-08 先于 D-07 |
| 9 | **D-10 × 全部** | 若文档纳入 Git 且数字生成式 | 所有验收标准中的期望数字必须来自 §1 基线表，并标注口径（HEAD vs 合并 diff） | ✅ 不矛盾。与 §5 每批验收标准写法一致 |
| 10 | **D-05 × F-004 重写结论** | 若实现已在 HEAD 落地 | D-05 不再是「接入 vs 下架」的二选一；推荐 B′ 只做「改声明 + 补 E2E」 | ✅ 已按修正后结论调整（§2.2(4)、§3.2 F-004） |

**自查结论**：11 个约束对中 9 对自洽；**#4 与 #4b 两对存在真实缺陷**，已定位到 `desktop/agent-core/index.js:2416-2429`（F-018 + F-019），纳入 **B1-B-02** 一并改为 fail-closed。**不存在「选了 A 就不能选 B」的互斥冲突**——但存在「改了 A 不改 B 就会把权限放宽」的**耦合**，这正是本表存在的意义。

### 4.4 逐决策详情（主流做法 + 来源 URL + 退路）

#### D-01 · MCP 版本路线

- **推荐**：**A+**（补齐 2025-11 合规 + 抽 transport 抽象，为 B 预留接口但不实现双栈）。
- **依据**：F-006 是规范 MUST 项缺失（版本头），属确定缺陷、成本极低（把已保存的 `protocolVersion` 注入请求头即可）。而 B（2026-07 双栈）涉及 discover、per-request metadata、MRTR、extensions 与 transport 重构，与 D-09-B、D-03 抢同一份投入。
- **主流做法**：双 era 兼容 / 能力协商；先合规当前 era，预留 transport abstraction。
  来源：<https://modelcontextprotocol.io/specification/2025-06-18/changelog>（要求 Streamable HTTP 后续请求携带协商后版本）、<https://modelcontextprotocol.io/specification/2026-07-28/changelog>（转向 stateless + per-request metadata + extensions）。
- **关联修复**：F-006（B1-B-04）、F-013（B2-B-09）。
- **退而求其次**：若用户否决 A+，**最低可接受是「只修 F-006 版本头」**，transport 抽象可延后——但需在代码注释里写明「此处为 2026 双栈的唯一改造点」，避免届时全仓找入口。

#### D-02 · MCP 产品 surface

- **推荐**：**近期 A**（正式声明 tools profile，sampling/elicitation 继续显式拒绝）→ **中期 B**（补只读 resources/prompts）。**B 的前置是 D-03 的上下文预算闸**。
- **依据**：当前是 tools-only（F-014）。声明为 tools profile 是零成本的诚实化动作；补 resources/prompts 是只读能力、收益高，但会向上下文预算施压——这正是约束对 #1 的核心。
- **主流做法**：MCP primitives 分 server 侧（resources/prompts/tools）与 client 侧（roots/sampling/elicitation），通过 capability negotiation 渐进启用。
  来源：<https://modelcontextprotocol.io/specification/2025-11-25/>、<https://modelcontextprotocol.io/specification/2025-11-25/changelog>。
- **关联修复**：F-014（B2-B-10）、F-007（B1-B-06）。
- **退而求其次**：若用户否决 B，保持 A 即可，不产生技术债——只是「资源浏览 / prompt 模板」能力缺失，且已在文档中明示，不构成契约断裂。

#### D-03 · 工具发现粒度与 prompt cache

- **推荐**：**C 混合**——核心 native 常驻、MCP server 懒连、单工具按需展开。
- **依据**：当前 server 级意图预热已降低暴露面（3 个默认预热服务，D-12），但粒度仍是 server。混合方案在「上下文最低」与「实现复杂度」之间最平衡；且必须复用 D-06 的 registry 元信息（约束对 #7）。
- **主流做法**：progressive discovery + 稳定 cache breakpoint；工具库大时用 tool search / deferred loading 而非全量塞进上下文；KV-cache 友好要求稳定前缀与稳定 tool 顺序。
  来源：<https://modelcontextprotocol.io/docs/2025-06-18/develop/clients/client-best-practices>、<https://anthropic.com/engineering/advanced-tool-use>、<https://anthropic.com/engineering/effective-context-engineering-for-ai-agents>。
- **注意**：按意图增删 tool schema 会造成预期内的 cache rebuild——应记为**成本**而非功能错误（项目已有 `MAX_REWRITES_PER_RUN=5` 与稳定排序）。
- **退而求其次**：若 C 复杂度过高，**退到 A**（保持 server 级 + 修好命名/描述安全，即 F-005/F-007）。A 是本轮 P1 的最低要求，C 可推到 B3。

#### D-04 · `supportsToolCall` 的真实语义

- **推荐**：**B 先落地**（false → `allTools=[]` + 切换无工具 system prompt），C（自动探测 provider 能力 + 用户覆盖）作为演进。
- **依据**：F-003 是「UI 给了开关但执行层不消费」的信任问题，用户已可见。B 的语义清晰、成本极低。C 需要维护 provider 能力目录，属长期成本。
- **⚠️ 必须同步的三件事（P3 裁决后重算）**：
  1. **裁剪顺序固化为三段，且每段 fail-closed**：**capability 门（硬）→ 角色子集（软·空交集 fail-closed）→ planMode filter**。三段都要在代码里显式可读，不得依赖行文顺序。
  2. **修 `agent-core/index.js:2419-2429` 的「空交集 → 回落全量」分支（= F-018）**：改为「回落为空集 + 明确错误」。**注意：这一条即使不做 D-04 也必须做**，因为 F-018 是独立缺陷。
  3. **编排 / 子代理入口 fail-fast**（约束对 #2）：无工具能力时给出明确错误，不得静默跑空轮。
- **主流做法**：capability gate 必须约束请求本身，不能只是展示元数据。
  来源：<https://anthropic.com/engineering/advanced-tool-use>。
- **退而求其次**：若用户认为「无工具模式」不是产品目标，**最低可接受是方案 A（删掉开关）**——比现状好，因为现状是**虚假控制感**；但删开关会失去对兼容端点的能力，需权衡。

#### D-05 · 数字员工是否成为可执行 runtime

- **推荐**：**B′（修正版）**——保留现有线程级单 runtime preset 实现，**改 README 措辞 + 补事件链 E2E**。
- **依据（本轮修正）**：实现已在 HEAD `924909c` 上 **12 环闭合**（§3.2.1，P3 独立核验确认）。原「接入 vs 下架」的二选一建立在 F-004「渲染层零调用」的错误判定上，现该判定已被推翻。真实缺口有三点：**README 自相矛盾**（F-021）、**回退路径不钳制**（F-020）、**React 8 环无守护**；另有两条**独立**的 P1 安全项（F-018/F-019）不得随之降级。
- **主流做法**：先单 runtime preset，再扩多 agent / 编排。
  来源：<https://google.github.io/adk-docs/agents/>（从单 agent 渐进到 graph/multi-agent workflow）、<https://anthropic.com/engineering/building-agents-with-the-claude-agent-sdk>。
- **关联修复**：F-004 / F-020 / F-021（B2-B-11 / B2-B-15）、F-010（B1-B-08）、**F-019（见下方裁定）**。

##### D-05 附：F-019 `allowMcp` 缺省值 —— 本轮是否必须翻转？

| 问题 | 现状 | 裁定 |
|---|---|---|
| 缺省语义 | `rolePreset.allowMcp === false` 才走白名单，否则 `mcpTools` 全量（`agent-core/index.js:2416-2425`）。代码注释自认「翻默认值需同批改 `buildEmployeeRuntimePreset`，属下一版遗留」 | 缺省值当前是 **fail-open** |
| 存量角色兼容代价 | 51 个角色（D-04）中若多数未写 `allowMcp`，翻成 false 后这些角色将**失去全部 MCP 工具**——这是**行为收窄**，会让已发布角色「突然变弱」 | 代价真实但方向正确 |

**架构师的明确建议：本轮（B1）翻转，不做「下一版遗留」。** 三条理由：

1. **方向不可妥协**。合规收窄（少给权限）可以靠文档和提示缓解；放宽（多给权限）无法靠任何提示缓解。只读角色能通过 MCP 写外部系统，是**产品声明与实现相反**。
2. **代价可控**。收窄的影响面是「角色少了 MCP 工具」，不是「数据损坏」。可在同一批**同时**更新 `buildEmployeeRuntimePreset` 让 51 个角色显式写出 `allowMcp: true`（保持既有行为），从而把「翻默认值」变成「显式声明」——存量行为零变化，而**新角色自动安全**。
3. **拖延的复利成本**。留下 fail-open 缺省值，等于在 D-06 registry 收敛时又多一处「未收敛的默认放宽」，与 §4.2「先把契约钉死」的总纲直接冲突。

**若用户否决本轮翻转**，必须给出**强制触发条件**（写进代码注释 + 本文档），满足任一即必须翻：
- (a) 任何角色模板新增 `allowMcp` 字段或被外部导入；(b) D-06 registry 落地（元信息收敛时默认值必须一起收）；(c) 任一角色被标记为「只读 / 只审计」语义；(d) 发布对外宣传「最小权限」表述之前。

- **退而求其次**：若用户确认多员工编排是产品方向，可跳到 **C**，但需先有主体 RBAC、身份 trace、最小权限继承——**成本档跳到高，且必须先完成 D-06**。

#### D-06 · 工具登记安全门禁

- **推荐**：**C 分两步**——A 止血（矩阵改「逐工具 × 逐环节」全覆盖断言，读取 `TOOL_LEVEL` / `REVERSIBILITY`），再 B 收敛（声明式 `toolRegistry` 同时生成 schema / handler 名 / 超时 / 审批级 / 可补偿性 / 标签）。
- **依据**：当前工具元信息散在 **7 处**登记面（`BASE_TOOLS`、`TOOL_HANDLER_NAMES`、`TOOL_CHANNELS`、`APPROVAL_TOOLS`、`TOOL_LEVEL`、`REVERSIBILITY`、`CWD_TOOLS`）= 7 处漂移面。这是 D-04/D-03/D-05/D-09 共同的元信息来源，**必须先收敛**。
- **关键缺口**：`approval.js:351` 的 `TOOL_LEVEL[tool] || 'L2'` 是**静默回落**——漏登记不是报错，而是默认给一个中间级别。可证明的反例见 §2.2(1)。
- **主流做法**：声明式 policy / registry + 生成式校验。
  来源：<https://openai.com/index/running-codex-safely/>（sandbox 负责技术边界、approval 负责越界时机，两者正交）、<https://google.github.io/adk-docs/agents/>（确定性代码与非确定性推理解耦）。
- **关联修复**：F-002（B1-B-01）、F-016（B2-B-12）。
- **退而求其次**：**最低可接受是只做 A**（补测试断言），成本档降到低。但须知：只要还是源码扫描，新增第七处登记面时仍会漏——A 是止血不是根治。

#### D-07 · Eval 执行频率与成本

- **推荐**：**B**——PR 跑 2–3 个小样，nightly / 发布前跑全量，结果做基线差分；固定模型 snapshot / 重复次数 / 置信区间。
- **依据**：15 个 eval 任务（C-07）。每次提交全量（C）的费用、非确定性与时长都过高；只保留 `--check`（A）则测不出能力回归——F-008 已证明「220/221 检查项全绿」与「能力是否退化」是两件事。
- **前置**：D-08（差分指标需要可比 trace 结构，约束对 #8）、D-10（基线可复核）。
- **主流做法**：eval-driven development、任务特定数据集、自动评分与持续评估，反对只靠「感觉有效」。
  来源：<https://platform.openai.com/docs/guides/evaluation-best-practices>。
- **退而求其次**：若用户不接受任何模型成本，**最低可接受是「发布前手工跑一次全量 + 结果入 `desktop/eval/results/`」**，把 A 的「零成本」升级为「发布前一次性成本」。但这依赖人的纪律，不如 B 可靠。

#### D-08 · Trace 标准化

- **推荐**：**B**——内部 span model + 可选 OTLP exporter（默认本地、不上传）。
- **依据**：本地优先定位下不能上云分析平台（C 与定位冲突）；但只靠 JSONL + console 无法做跨版本差分，直接卡住 D-07。
- **主流做法**：OTel-compatible，export 可选；用事件图 / tool provenance 支撑离线评估。
  来源：<https://openai.com/blog/new-tools-for-building-agents>（tracing/observability 作为一等原语）、<https://google.github.io/adk-docs/integrations/bigquery-agent-analytics/>（事件图 + trace 支撑离线评估；本地优先不必上 BigQuery，取其 schema 思想）。
- **退而求其次**：**A**（JSONL 不变，只补 schema version + run graph）成本最低，且足以支撑 D-07 的最小差分；若 B 排不进本轮，A 是可接受的过渡。

#### D-09 · Linux sandbox 后端

- **推荐**：**近期 A**（bwrap 继续 + 强化可用性探测与失败说明），**中期 B**（Landlock+seccomp 主后端，bwrap fallback）。
- **依据**：与 D-01-B 抢同一份 native/传输层投入（约束对 #6），本轮明确让位。且「Linux 非 Landlock 路线」本身**不直接判缺陷**——bwrap 是官方工程文档认可的隔离工具之一。
- **主流做法**：OS-enforced + 网络默认关闭 + approval 正交；macOS 用 Seatbelt，Linux 主流用 Landlock+seccomp。
  来源：<https://openai.com/index/running-codex-safely/>、<https://openai.com/index/building-codex-windows-sandbox/>。
- **退而求其次**：**C（容器后端 opt-in）不推荐本轮**——启动慢、环境桥接复杂，收益/成本比最差。

#### D-10 · 文档发布纪律

- **推荐**：**A**——docs-as-code：技术文档纳入 `docs/`，头部写 commit、生成时间、计数脚本，CI 校验数字与代码同源。
- **依据**：本轮已两次撞上这个问题：F-001（文档不在版本库）+ F-015（审查窗口内被二次写入，sha256 从 `217a162b…` 变到 `5401942147…`）。**这是唯一一个「不做就无法验收其他所有决策」的元决策**。
- **主流做法**：docs-as-code + CI 校验。
  来源：与 <https://platform.openai.com/docs/guides/evaluation-best-practices> 的「反对只靠感觉有效」同源——文档数字也必须是可复算的，不能靠人写。
- **关联修复**：F-001、F-015（B0-B-01）、F-009/F-010/F-011（B1-B-07 / B1-B-08）。
- **退而求其次**：**B**（保持本地生成，但每次输出带内容 hash + `git show` 可重建脚本）在**本轮必须至少做到**——即使 A 排不进，也要先在 B0 冻结一份只读副本（B0-B-01），否则 P1/P3 各读各的，审查结论无法对齐。

---

## 5. 调整实现方案（分批、可执行、可判定）

> **批次顺序与 §4.2 决策依赖链严格一致**：B0 只做 D-10（元决策）+ 基线固化 + 修哑门禁（F-022）→ B1 做 D-06-A + **三段 fail-closed（D-04 + F-018 + F-019 同批）** + 三条 MCP 契约 + 文档数字 → B2 做 D-03 阶段一 + D-02-A + D-05-B′（含 F-020 回退路径）+ 存量台账 + D-09-A → B3 做 D-01-B / D-02-B / D-03-C / D-06-B / D-07 / D-08 / D-09-B。
> **P1 覆盖**：11 条 P1 中，F-001/F-015/F-022→B0，F-002/F-003/F-005/F-006/F-007/F-018/F-019→B1，F-012→B0-B-02。**每条 P1 都有明确归属批次**。
> **不存在「B_N 依赖的决策被排到更后面」的矛盾**：每个条目末尾标注其依赖的上游条目。
> **验收标准纪律**：每条必须是「跑什么命令、期望什么结果」；期望数字一律取自 §1 基线表并标注口径。
> **条目编号说明**：`B<批次>-B-<序号>` 是**稳定句柄**（跨章节引用用），序号有意留空档（如 B1 无 B-03、B2 无 B-02～B-08），便于后续插入新条目时不打乱既有引用，**不是漏项**。

---

### B0 · 止血（目标：让后续所有验收可判定）

#### B0-B-01 · 冻结技术文档只读快照副本

| 项 | 内容 |
|---|---|
| **目标** | 终止 F-015 的「审查期间被并发写入」，让 P1/P3/后续轮次引用同一份内容 |
| **涉及文件** | 读：`/Users/jianma/Desktop/MJCode/MJcoder-技术流程功能文档.md`；写：`/Users/jianma/Desktop/MJCode/docs/harness-r7/00-frozen/MJcoder-技术流程功能文档.frozen.md`（新建，副本） |
| **改动要点** | 复制当前磁盘版本为只读副本，在副本头部追加 6 行元信息：原始路径、sha256（`540194214702922f…`）、`wc -l`（712）、冻结时间、Git HEAD（`924909c…`）、冻结人。**不修改原文件** |
| **验收标准** | `shasum -a 256 docs/harness-r7/00-frozen/MJcoder-技术流程功能文档.frozen.md` 与 `test -f … && wc -l` 输出 712；且 `head -8` 中含 `924909c` 与 `5401942147`。此后**全团队引用副本行号** |
| **预估风险** | 低。风险是副本本身不被遵守——需在 B0-B-03 中写入团队纪律。**⚠️ 执行前置条件（必须满足，否则冻结无效）**：须先确认目标文件 **mtime 已稳定 ≥15 分钟**，且**哈希两次采样（间隔 ≥60s）完全一致**，才可冻结——否则冻的是中间态（本轮已实证该文件 7 分钟内出现 3 个版本）。这条前置条件同样适用于 README（A-09a 记录其被追加 +56 行） |
| **对应** | F-001、F-015、D-10（退路 B） |
| **依赖上游** | 无 |

#### B0-B-02 · 提交 12 个 tracked 改动并推送，收回 `docs-consistency.test.mjs`

| 项 | 内容 |
|---|---|
| **目标** | 消除 F-012 的「关键已实现只在未提交 diff 中」 |
| **涉及文件** | 12 个 tracked 文件（A-03）+ `desktop/test/docs-consistency.test.mjs`（A-04，untracked） |
| **改动要点** | 分两个提交：① 12 个 tracked 改动（MCP 默认注入、`project_path` 迁移、记忆 `conversationId` 修复等）；② 新增 `docs-consistency.test.mjs`。然后 `git push` |
| **验收标准** | `git -C /Users/jianma/Desktop/MJCode status --porcelain \| grep -c '^ M'` → **0**；`git rev-list --left-right --count origin/main...HEAD` → **0 0**；`git ls-files --error-unmatch desktop/test/docs-consistency.test.mjs` → exit 0 |
| **预估风险** | 中。README.md 当前 blob（A-05）与下发清单不一致，提交前需确认内容；建议提交前对 8 个改动 JS 再跑一次 `node --check` |
| **对应** | F-012、A-02、A-03、A-04 |
| **依赖上游** | B0-B-01（先冻结，避免提交时文档再变） |

#### B0-B-03 · 确定发布基线口径并写进文档

| 项 | 内容 |
|---|---|
| **目标** | 固定 §3.3 的结论，避免后续「220 还是 221」反复 |
| **涉及文件** | 本方案文档 §3.3；README 与技本文档后续批次同步 |
| **改动要点** | 明确发布基线 = **合并当前 diff 后**（理由见 §3.3 结论）；在文档头部写死口径声明 |
| **验收标准** | 文档中出现且仅出现一处口径声明；§5 所有期望数字均带「（HEAD 口径）/（合并 diff 口径）」标注 |
| **预估风险** | 低 |
| **对应** | §3.3、F-012 |
| **依赖上游** | B0-B-02 |

#### B0-B-04 · 把 `docs-consistency.test.mjs` 从「保障」降级为「待修」，并修成真门禁

| 项 | 内容 |
|---|---|
| **目标** | 消除 F-022（半硬门禁失效：常量断言硬 / 引用存在性与缺文档分支软，且 CI 恒跳过）。**注意：本条不是「加一个新测试」，而是「把一个骗人的测试修好」** |
| **涉及文件** | 改：`/Users/jianma/Desktop/MJCode/desktop/test/docs-consistency.test.mjs`（`:38-40` 的 fail-open 分支）；改：`/Users/jianma/Desktop/MJCode/.gitignore`（移除对技术文档的忽略，或对该文件加 `!` 例外）；新增：`docs/MJcoder-技术流程功能文档.md`（入库） |
| **改动要点** | ① **文档入 Git**（F-001 前置）→ 从 `.gitignore` 的 `*.md` 规则中为这一条加白名单例外；② **缺失即红**：`if (!fs.existsSync(DOC))` 分支从 `process.exit(0)` 改为 `process.exit(1)` 并打印「文档缺失，CI 不可判定」；③ **计数断言要能变异**：P3 的 R-5 证明「引用改名后计数 28→27 仍 22/22 全绿」——说明当前断言是「总数不变」而非「逐项对应」，需改为**双向差集**（文档引用集合 ↔ 源码符号集合，任一方向缺项即红） |
| **验收标准** | 三重对抗验证，全部必须**非零退出**：① `mv docs/MJcoder-技术流程功能文档.md /tmp/ && node test/docs-consistency.test.mjs` → **EXIT=1**（现状 EXIT=0）；② 在文档中删除 1 处代码引用 → **EXIT=1**（现状 22/22 绿）；③ 在源码中新增 1 个 `TOOL_CHANNELS` 条目但不写进文档 → **EXIT=1** |
| **预估风险** | 中。文档入库会引入「每次改代码要同步改文档」的维护成本——但这正是 D-10 想要的效果；若不接受该成本，则应选择 D-10 的退路 B（hash + 可重建脚本），届时本条降为「删掉这个假门禁」而非修好它 |
| **对应** | F-022、F-001、D-10 |
| **依赖上游** | B0-B-01（先有冻结副本，才有可比对的基准） |

**B0 出口条件**：`git status` 干净 + 分叉 `0 0` + 冻结副本存在且哈希固定 + `docs-consistency.test.mjs` 的三重对抗验证均 EXIT=1。**B0 未完成不得进入 B1**——否则 B1 的验收数字会在两个口径间摇摆。

---

### B1 · 契约闭合（目标：把「声称的约束」变成「机器判定的约束」）

#### B1-B-01 · 工具登记矩阵改为「逐工具 × 逐环节」全覆盖

| 项 | 内容 |
|---|---|
| **目标** | 消除 F-002 假闭环：让「新增工具漏审批分级 / 漏可补偿声明」必然红 |
| **涉及文件** | 改：`/Users/jianma/Desktop/MJCode/desktop/test/tool-registration-matrix.test.mjs`；读（新增断言源）：`/Users/jianma/Desktop/MJCode/desktop/main/approval.js`（`TOOL_LEVEL`、`:351` 回落、`REVERSIBILITY` `:44`/`:100`） |
| **改动要点** | ① 把 53 个模型工具（B-03）作为断言驱动集，**逐工具**检查是否同时具备：schema、通道、handler、timeout、CWD、审批级（`TOOL_LEVEL` 显式命中而非回落）、可补偿性（`REVERSIBILITY` 显式命中）、`BASE_PROMPT`、UI+i18n；② 显式断言「不得依赖 `approval.js:351` 的 `\|\| 'L2'` 回落」——即对每个工具断言 `Object.prototype.hasOwnProperty.call(TOOL_LEVEL, tool) === true`；③ 保留原有孤儿检测作为反向断言 |
| **验收标准** | `cd /Users/jianma/Desktop/MJCode/desktop && node test/tool-registration-matrix.test.mjs` → 全部 PASS 且新增用例数 ≥ 53。对抗性验证：`node -e` 临时构造一个「已登记 schema+通道但未写 `TOOL_LEVEL`」的假工具注入后跑该套件 → **必须非零退出**（此验证属 P3 对抗用例，本轮**未验证**） |
| **预估风险** | 中高。53 个工具逐项补齐审批级/可补偿性声明会有一次性的存量工作量；若存量缺口大，可能需要先做「白名单豁免 + 台账」再逐个收敛 |
| **对应** | F-002、D-06-A；约束对 §4.3 #7 |
| **依赖上游** | B0（口径固定后 53 这个数字才稳定） |

#### B1-B-02 · 三段裁剪 fail-closed：capability gate + 空交集 + allowMcp（**F-003 / F-018 / F-019 同批**）

| 项 | 内容 |
|---|---|
| **目标** | 一次修掉三条同源缺陷：F-003（capability 开关不生效）、**F-018（空交集 fail-open，P1 安全）**、**F-019（`allowMcp` 缺省 true，P1 安全）**。三者都作用于 `agent-core/index.js` 的 `allTools` 组装点（`:2402-2442`），**分开改必然互相打架** |
| **涉及文件** | 改：`/Users/jianma/Desktop/MJCode/desktop/agent-core/index.js`（`:2402-2442` 组装段、`:2416-2425` `allowMcp`、**`:2419-2429` 空交集回落（含 `:2419` 前置条件）**、`:2714` 下发）、`/Users/jianma/Desktop/MJCode/desktop/main/agentRunner.js`（透传 caps）、`/Users/jianma/Desktop/MJCode/desktop/main/orchestrator/index.js` 与 `spawn_subagent` 入口、**`buildEmployeeRuntimePreset`（角色预设构造处，需同批写显式 `allowMcp`）**；新增测试：`desktop/test/role-tool-clamp.test.mjs` |
| **改动要点** | ① **固化三段顺序（每段 fail-closed）**：`capability 门（硬）→ 角色子集（软）→ planMode filter`。② **capability**：`supportsToolCall===false` → `allTools=[]` + 切换无工具 system prompt，**并跳过所有「加回来」的回落**。③ **空交集（F-018）**：`picked.length===0` 时 `allTools=[]` + 抛/记**明确错误**，**删除 `console.warn` + 保持全量**的旧行为。④ **allowMcp（F-019）**：缺省值翻为 `false`（最小权限），同批给 51 个角色（D-04）显式写 `allowMcp: true` 以保持存量行为——**翻默认值 + 显式声明 = 存量零变化、新角色默认安全**。⑤ 编排 / `spawn_subagent` 在无工具能力时 fail-fast |
| **验收标准** | `cd /Users/jianma/Desktop/MJCode/desktop && node test/role-tool-clamp.test.mjs`，四条断言缺一不可：<br>① `caps.supportsToolCall=false` → `chatFn` 收到的 body **无 `tools` 字段**或 `tools.length===0`；<br>② `caps` 缺省/true → `tools.length === 52`（B-01，保证不回归）；<br>③ `rolePreset.toolNames=['拼错的工具名']` → `tools.length === 0` **且**抛出/记录明确错误（**现状是 53，本条就是 F-018**）；<br>④ `rolePreset` 不含 `allowMcp` 字段 → MCP 工具数 **为 0**（**现状是全量，本条就是 F-019**），含显式 `allowMcp:true` → MCP 工具数不为 0 |
| **预估风险** | **中高**。③④ 两条是**行为收窄**：任何依赖「交集为空自动全量」「MCP 默认全开」的既有用法都会改变。缓解：④ 用「翻默认值 + 51 角色显式声明」保持存量；③ 的收窄只会影响**本来就配错的角色**（它们现在的行为是错的）。须回归 `role-preset.test.mjs`（其第 3 条断言语义要同步更新为 fail-closed） |
| **对应** | **F-003、F-018、F-019**、D-04；约束对 §4.3 #2 / #3 / **#4** / **#4b** |
| **依赖上游** | B1-B-01（registry 元信息口径先定） |

#### B1-B-04 · MCP Streamable HTTP 补 `MCP-Protocol-Version` 头

| 项 | 内容 |
|---|---|
| **目标** | 消除 F-006（规范 MUST 项缺失） |
| **涉及文件** | 改：`/Users/jianma/Desktop/MJCode/desktop/main/mcpClient.js`（`:347-365` 的 `createHttpTransport`、`protocolVersion` 保存处 `:203-235`）；新增测试：`desktop/test/mcp-protocol-version.test.mjs` |
| **改动要点** | 把 initialize 阶段协商到的 `protocolVersion` 保存在 transport 闭包内，后续每个 POST 请求携带 `MCP-Protocol-Version: <协商值>`；stdio 传输不受影响。注释中标明「此处为 2026 双栈的唯一改造点」（D-01 退路要求） |
| **验收标准** | `cd /Users/jianma/Desktop/MJCode/desktop && node test/mcp-protocol-version.test.mjs`：用本地 HTTP stub 记录请求头，断言 initialize **之后**的每个请求都含 `MCP-Protocol-Version`，且值等于 stub 在 initialize 响应中返回的 `protocolVersion`。严格服务端是否仍 400，**需真机验证（本轮未验证）** |
| **预估风险** | 低。仅增加请求头；若个别旧服务端对该头敏感，需观察（**未验证**） |
| **对应** | F-006、D-01-A+ |
| **依赖上游** | 无（可与 B1 其他条目并行） |

#### B1-B-05 · MCP server 名可逆编码 + 反解同步

| 项 | 内容 |
|---|---|
| **目标** | 消除 F-005 的跨包命名契约断裂（`my__svc` 反例） |
| **涉及文件** | 改：`/Users/jianma/Desktop/MJCode/desktop/shared/mcpToolDefs.mjs`（`:16-27` 拼名）、`/Users/jianma/Desktop/MJCode/desktop/agent-core/index.js`（`:3271-3276` 反解）；新增测试：`desktop/test/mcp-name-codec.test.mjs` |
| **改动要点** | 采用**可逆编码**而非禁止字符集（禁止会破坏存量配置）：对 server 名做确定性转义（如 `__` → `-__`→ 选定一种，需保证 `encode`/`decode` 互为逆），拼名与反解**共用同一模块**（不得再两处各写一份）；入口 `ipc/mcp.js:383-392` 增加「编码后仍能唯一反解」的前置校验 |
| **验收标准** | `cd /Users/jianma/Desktop/MJCode/desktop && node test/mcp-name-codec.test.mjs`：对 `['my__svc','a__b__c','中文 服务','normal','x']` 逐一断言 `decode(encode(s)) === s`，且 `toToolDefs(s,[{name:'x'}])[0].function.name` 经引擎反解后得到 `server === s && tool === 'x'` |
| **预估风险** | 中。编码方案改变会改变既有工具名 → 影响**已保存的会话/工具白名单/角色 preset 里的 MCP 工具名**。需评估是否要保留旧名兼容；建议在编码方案确定前先列出存量配置中的 server 名集合 |
| **对应** | F-005；与 §2.2(2) 的反例一一对应 |
| **依赖上游** | 无（可与 B1 其他条目并行） |

#### B1-B-06 · MCP 工具定义长度闸 + 不可信标记

| 项 | 内容 |
|---|---|
| **目标** | 消除 F-007（第三方描述/schema 无闸直达模型上下文） |
| **涉及文件** | 改：`/Users/jianma/Desktop/MJCode/desktop/shared/mcpToolDefs.mjs`（`:16-27`）、`/Users/jianma/Desktop/MJCode/desktop/main/mcpToolCache.js`（`:22-31`）；新增测试：`desktop/test/mcp-tool-def-guard.test.mjs` |
| **改动要点** | ① `description` 硬闸（建议上限，需与 D-03 的上下文预算闸常量同源——见 §4.3 约束对 #1）；② `inputSchema` 的深度与序列化大小闸；③ 超限时截断 + 打 `__untrusted__` 标记并记审计，不静默丢弃；④ 与已有「工具**结果**」守卫 `agent-core/index.js:3345-3355` 的 `detectInjection` 保持同级别策略 |
| **验收标准** | `cd /Users/jianma/Desktop/MJCode/desktop && node test/mcp-tool-def-guard.test.mjs`：构造 `description` 长度 50 KB 且含指令注入文本的工具定义，断言输出 `description.length <= MAX_DESC_CHARS`、标记字段存在、且未抛异常中断连接 |
| **预估风险** | 中。截断会改变既有 MCP 工具对模型可见的描述，可能影响工具选择质量（**未验证**）；建议先只做「超限告警 + 记录」，跑一轮观察后再开截断 |
| **对应** | F-007、D-03（预算闸同源）、D-02 |
| **依赖上游** | 无（可与 B1 其他条目并行；但预算常量建议与 B2-B-01 一起定） |

#### B1-B-07 · 文档测试口径修正（「220 套件」→ suite + gate 双数字）

| 项 | 内容 |
|---|---|
| **目标** | 消除 F-009 的口径混淆 |
| **涉及文件** | 改：`MJcoder-技术流程功能文档.md`（当前快照 `〔§1 产品定位·目录结构段〕`、`〔§12 门禁·命令表〕`、`〔§12 门禁·命令表 typecheck 行〕`）、`README.md`（`〔README·测试套件声明段〕`，定位用语句锚点） |
| **改动要点** | 统一改为「**217/218 个 `*.test.*` + 2 smoke = 219/220 suite，另有 1 个 `eval:check` gate，合计 220/221 个检查项**」；「全部通过」标注为历史结果并附复核命令（C-09 本轮未验证） |
| **验收标准** | `rg -n "220 套件" MJcoder-技术流程功能文档.md README.md` → **零命中**；`rg -n "219 suite\|220 suite" ` → 命中且数字与 C-03 一致 |
| **预估风险** | 低 |
| **对应** | F-009、C-03/C-05/C-06、D-10 |
| **依赖上游** | B0-B-03（口径声明） |

#### B1-B-08 · README 生态数字改为生成式并修正

| 项 | 内容 |
|---|---|
| **目标** | 消除 F-010（80/50/230 三处漂移） |
| **涉及文件** | 改：`README.md`（`〔README·ecosystem 目录行〕`、`〔README·生态资产计数段〕`）；新增：`scripts/gen-ecosystem-counts.mjs` 与 `desktop/test/ecosystem-counts.test.mjs` |
| **改动要点** | ① 数字改为生成式：脚本读 `ecosystem/skills` 目录数、`mcp-connectors.json.connectors.length`、`digital-employees.json.length`（D-01/D-02/D-04）；② README 写 **100 / 77 / 51，合计 228**（D-05）；③ 明确写出「另有 WorkBuddy 原始 214 条，运行时合并去重，不计入精选口径」（D-03）；④ 新增测试断言 README 中的三个数字等于脚本现算值 |
| **验收标准** | `cd /Users/jianma/Desktop/MJCode/desktop && node test/ecosystem-counts.test.mjs` → PASS；`rg -n "80 MCP connectors\|50 digital-employee\|230" README.md` → **零命中** |
| **预估风险** | 低 |
| **对应** | F-010、D-01..D-07（基线表编号）、D-10 |
| **依赖上游** | 无 |

#### B1-B-09 · 技术文档三处可证伪事实修正

| 项 | 内容 |
|---|---|
| **目标** | 消除 F-011 |
| **涉及文件** | 改：`MJcoder-技术流程功能文档.md`（`〔§1 产品定位·server 目录行〕`、`〔§1 产品定位·设置页段〕`、`〔§8 编排·流程图常量节点〕`） |
| **改动要点** | ① `〔§1 产品定位·server 目录行〕` 改为 Node.js + Express（据 `server/package.json:2-20`）；② `〔§1 产品定位·设置页段〕` 删除「设置页仅保留版本更新、不再保留用户配置区块」，改为与 `〔§5/§9 设置与审批段〕`、`〔§9 审批段〕`、`〔§11 i18n 段〕` 一致的表述；③ `〔§8 编排·流程图常量节点〕` 改为 `MIN_TASKS=2 / MAX_TASKS=8 / MAX_DEPS=4`（D-08/D-09/D-10），并与同文件 `〔§3 执行流·相关段〕` 对齐消除自相矛盾 |
| **验收标准** | `rg -n "Spring Boot" MJcoder-技术流程功能文档.md` → 零命中；`rg -n "MIN / MAX_TASKS = 8"` → 零命中；`rg -n "仅保留版本更新"` → 零命中 |
| **预估风险** | 低 |
| **对应** | F-011、D-08..D-11 |
| **依赖上游** | B0-B-01（冻结副本先行） |

**B1 出口条件**：F-002 / F-003 / F-005 / F-006 / F-007 / F-009 / F-010 / F-011 八项均有对应测试或零命中校验；`npm test` 在**合并 diff 口径**下检查项为 221（C-05），且新增套件使其上升后文档同步更新。

---

### B2 · 能力补齐（目标：把「已落地但没说清 / 没守住」的补齐）

#### B2-B-01 · 上下文预算闸常量 + 工具发现粒度策略（D-03 第一阶段）

| 项 | 内容 |
|---|---|
| **目标** | 建立**唯一**的上下文预算闸常量，为 D-02-B（补 resources/prompts）与 D-03-C（单工具展开）提供共同边界（§4.3 约束对 #1） |
| **涉及文件** | 新增：`desktop/shared/contextBudget.mjs`；改：`desktop/agent-core/index.js`（消费该常量）；新增测试：`desktop/test/context-budget.test.mjs` |
| **改动要点** | 定义单一常量源：工具 schema 总字节上限、单工具 description 上限（与 B1-B-06 同源）、MCP server 常驻数上限；当前值按「3 个默认预热服务 + 52 静态工具」实测基线设定（D-12、B-01），**不追求一步收紧** |
| **验收标准** | `cd /Users/jianma/Desktop/MJCode/desktop && node test/context-budget.test.mjs` → PASS；`rg -n "MAX_DESC_CHARS\|description 上限" desktop/shared/mcpToolDefs.mjs desktop/shared/contextBudget.mjs` → 两处引用同一常量，无第二份硬编码 |
| **预估风险** | 中。阈值设定过紧会导致 MCP 工具被大面积截断（**未验证**）；建议先设为「观测模式」（只记日志不截断） |
| **对应** | D-03、F-007（同源）、约束对 §4.3 #1 |
| **依赖上游** | B1-B-06（长度闸先落地） |

#### B2-B-09 · MCP `clientInfo` 版本同源

| 项 | 内容 |
|---|---|
| **目标** | 消除 F-013（自报 `1.0` vs 实际 `0.6.1-beta`） |
| **涉及文件** | 改：`/Users/jianma/Desktop/MJCode/desktop/main/mcpProtocol.js`（`:46`） |
| **改动要点** | `CLIENT_INFO.version` 改为读 `desktop/package.json` 的 `version`（D-17）；保留 `name: 'mj-coder'` |
| **验收标准** | `node -e "const {CLIENT_INFO}=require('/Users/jianma/Desktop/MJCode/desktop/main/mcpProtocol.js'); console.assert(CLIENT_INFO.version===require('/Users/jianma/Desktop/MJCode/desktop/package.json').version)"` → 无断言失败 |
| **预估风险** | 低。个别服务端可能对 `clientInfo` 做字符串匹配（**未验证**） |
| **对应** | F-013、D-17/D-18/D-19 |
| **依赖上游** | 无 |

#### B2-B-10 · 正式声明 MCP tools profile + 能力协商

| 项 | 内容 |
|---|---|
| **目标** | 消除 F-014 的「概括成完整 MCP client」表述风险（D-02-A） |
| **涉及文件** | 改：`README.md`、技术文档第五章（`〔§5 MCP 全章〕`）；改：`/Users/jianma/Desktop/MJCode/desktop/main/mcpClient.js`（initialize 阶段显式声明只消费 tools capability） |
| **改动要点** | ① 文档明确写「tools profile：仅消费 tools/list + tools/call；resources/prompts 未接入；sampling/elicitation 显式拒绝（`-32601`）」；② initialize 时按声明发送 capability，便于服务端正确降级 |
| **验收标准** | `rg -n "tools profile" README.md MJcoder-技术流程功能文档.md` → 均命中；`rg -n "resources/list\|prompts/list" desktop/main` → 仍为零命中（与声明一致） |
| **预估风险** | 低 |
| **对应** | F-014、D-02-A |
| **依赖上游** | B1-B-05/B1-B-06（MCP 契约先闭合） |

#### B2-B-11 · 数字员工：改 README 措辞 + 补事件链守护（D-05-B′）

| 项 | 内容 |
|---|---|
| **目标** | 消除 F-004 重写后的两个真实缺口：对外声明滞后 + React 事件链无守护 |
| **涉及文件** | 改：`README.md`（快照 `〔README·ecosystem 目录行〕` 的 "not yet wired into the Agent runtime"）；新增测试：`desktop/test/employee-runtime-e2e.test.mjs` |
| **改动要点** | ① **消除 F-021 自相矛盾**：〔README·ecosystem 目录行〕的 「not yet wired into the Agent runtime」 必须删/改——同文件〔README·审查流程第 4 步〕已写「51 个角色 + `rolePreset` 运行时落地」，后者才是事实；改为与实现一致的描述（线程级单 runtime preset、工具子集/审批/沙箱继承、取「角色与用户设置更严格者」）；② 补 12 环守护：断言 §3.2.1 表中第 1–8 环的**事件名与 payload 字段名**不被改名（静态源码断言，不引入 React 测试框架） |
| **验收标准** | `cd /Users/jianma/Desktop/MJCode/desktop && node test/employee-runtime-e2e.test.mjs` → PASS；`rg -n "not yet wired into the Agent runtime" README.md` → 零命中（注意：README 另有 「OS-level isolation is not yet wired」 一处，**与数字员工无关，不得误删**）**端到端真机行为（UI 点「招募」后工具子集是否真生效）仍需人工或 P3 验证（本轮未验证）** |
| **预估风险** | 低（静态断言）；中（若升级为真 E2E，需引入渲染层测试框架） |
| **对应** | **F-004、F-021**、D-05-B′、§3.2.1 |
| **依赖上游** | B1-B-02（capability gate 与角色裁剪顺序先固化） |

#### B2-B-12 · 源码注释基线数字治理

| 项 | 内容 |
|---|---|
| **目标** | 消除 F-016 |
| **涉及文件** | 改：`/Users/jianma/Desktop/MJCode/desktop/agent-core/index.js`（`:2401` 注释「钉死为 41」）、`/Users/jianma/Desktop/MJCode/desktop/test/web-todo-tools.test.js`（`:43` 标题序列止于 51 却断言 52） |
| **改动要点** | ① 注释不再写死数字，改为引用「见 `test/web-todo-tools.test.js` 的条数断言」；② 测试标题序列补全到 52（`latex_compile`）；③ 可选：加一条「注释中出现 `BASE_TOOLS` + 数字时必须与断言一致」的检查 |
| **验收标准** | `rg -n "钉死为 41" desktop/agent-core/index.js` → 零命中；`cd desktop && node test/web-todo-tools.test.js` → 标题含 52 且 PASS |
| **预估风险** | 低 |
| **对应** | F-016、B-01 |
| **依赖上游** | B1-B-01（53 这个数字口径先定） |

#### B2-B-13 · 存量收敛台账

| 项 | 内容 |
|---|---|
| **目标** | 消除 F-017 的「门禁只防恶化、不防挂账」 |
| **涉及文件** | 新增：`docs/harness-r7/02-design/存量收敛台账.md`；改：`desktop/test/bridge-parity.test.mjs`（把 40% 上限改为棘轮：随清理逐步下调） |
| **改动要点** | ① 为 46 个死 bridge 方法（B-11）逐项判定「补消费 / 下架 / 保留（有外部入口）」，写进台账；② 裸 button 基线 258（`ui-conventions.test.js:26`）同样建立逐项台账；③ 两处门禁改为棘轮式（只降不升），与 lint 161（C-08）同纪律 |
| **验收标准** | 台账文件中 46 个方法**逐项有归属判定**（`grep -c` 条目数 = 46）；桥面门禁的下限常量 ≤ 40% 且带「只降不升」断言 |
| **预估风险** | 低（台账）+ 中（后续清理会触及 `preload.js` 与渲染层） |
| **对应** | F-017、B-10/B-11、C-08 |
| **依赖上游** | B1-B-01（先知道哪些 bridge 对应真实半截能力） |

#### B2-B-14 · Linux sandbox 可用性探测与失败说明强化（D-09-A）

| 项 | 内容 |
|---|---|
| **目标** | 落实 D-09 近期方案：bwrap 继续，但让「沙箱没生效」对用户可见 |
| **涉及文件** | 改：`/Users/jianma/Desktop/MJCode/desktop/main/sandboxLinux.js`（`:42-43` 的 `linuxSandboxAvailable`、`:135` 导出） |
| **改动要点** | 探测失败时给出**可执行的原因说明**（bwrap 未安装 / 内核不支持 / 权限不足）而非布尔值；沙箱不可用时明确降级提示 |
| **验收标准** | `cd /Users/jianma/Desktop/MJCode/desktop && node test/sandbox-linux-probe.test.mjs`（新增）→ 断言 `linuxSandboxAvailable()` 返回值含 `reason` 字段且非空（在非 Linux 平台断言返回 `false` + reason）。**Linux 真机行为未验证** |
| **预估风险** | 低 |
| **对应** | D-09-A、§4.4 D-09 |
| **依赖上游** | 无 |

#### B2-B-15 · 进程内回退路径补审批/沙箱钳制（F-020）

| 项 | 内容 |
|---|---|
| **目标** | 消除 F-020：主通道不可用时的回落路径绕过角色 preset 的审批/沙箱钳制 |
| **涉及文件** | 改：`/Users/jianma/Desktop/MJCode/desktop/renderer/src/lib/agent.js`（`:182` 的通道选择、`:51`/`:138` 两处 `runAgentInProcess` 相关）、`/Users/jianma/Desktop/MJCode/desktop/main/agentRunner.js`（`:364-374` 的 `stricterApproval`/`stricterSandbox` 需被复用而非复制）；新增测试：`desktop/test/agent-fallback-clamp.test.mjs` |
| **改动要点** | 把 `stricterApproval()` / `stricterSandbox()` 抽到**共享模块**，主路径与回退路径都调用同一份。回退路径若无法拿到用户当前设置，必须 **fail-closed**（取最严格档），而不是跳过钳制 |
| **验收标准** | `cd /Users/jianma/Desktop/MJCode/desktop && node test/agent-fallback-clamp.test.mjs`：构造 `mainChannelReady=false` + `rolePreset.approvalMode='always'`，断言最终 `engineParams.approvalMode === 'always'`（**现状不是**）；再断言两个路径对同一输入产出**相同**的 `approvalMode` / `sandboxPolicy` |
| **预估风险** | 中。抽取共享函数会触及主路径（回归面 = `role-preset.test.mjs`）；「无法拿到用户设置时取最严格档」可能在回退场景下带来频繁确认，需评估体验 |
| **对应** | F-020、F-004（12 环之环 9）、D-05-B′ |
| **依赖上游** | B1-B-02（钳制函数的最终语义先定，避免抽了两次） |

---

### B3 · 长期演进（本轮只做决策与排期，不要求落地）

| 条目 | 目标 | 主要涉及文件 | 验收标准（可判定） | 对应 D/F | 依赖上游 |
|---|---|---|---|---|---|
| **B3-B-01** | 声明式 `toolRegistry` 收敛（D-06-B）：一处声明生成 schema / handler 名 / timeout / 审批级 / 可补偿性 / 标签，消灭 7 处登记面 | 新增 `desktop/shared/toolRegistry.mjs`；改 `agent-core/index.js`、`main/engineProcess/registry.js`、`main/approval.js` | 新增 `tool-registry.test.mjs`：断言 53 个工具（B-03）全部由 registry 单一来源生成，且 `rg -c` 登记点从 7 处降为 1 处 | D-06-B、F-002（根治） | B1-B-01 |
| **B3-B-02** | MCP resources/prompts 只读面（D-02-B） | 改 `desktop/main/mcpClient.js`、新增 `desktop/main/ipc/mcp.js` 通道、preload、渲染层浏览 UI | `rg -n "resources/list\|prompts/get" desktop/main` → 命中；`mcp-resources.test.mjs` 断言只读面不产生任何写副作用 | D-02-B、F-014 | **B2-B-01（预算闸必须先有）**、B2-B-10 |
| **B3-B-03** | 单工具延迟加载 / `search_tools` meta-tool（D-03-C） | 改 `desktop/agent-core/index.js`、`desktop/main/agentRunner.js`；新增 `desktop/shared/toolIndex.mjs` | `tool-deferred-loading.test.mjs`：断言大 server（工具数 > 阈值）时不把全部 schema 送入首轮请求体，且通过 meta-tool 可按需取回 | D-03-C | B3-B-01（复用 registry）、B2-B-01 |
| **B3-B-04** | Trace 内部 span model + 可选 OTLP exporter（D-08-B） | 新增 `desktop/shared/trace/spans.mjs`、`desktop/main/traceExporter.js` | `trace-spans.test.mjs`：断言 span 含 `run_id`/`span_id`/`parent_id`/`tool_name`/`tokens`/`duration_ms` 六字段且 schema version 固定；exporter 默认关闭 | D-08-B | B0-B-03 |
| **B3-B-05** | Eval 分层执行（D-07-B）：PR 小样 + nightly 全量 + 基线差分 | 改 `.github/workflows/ci.yml`、新增 `desktop/eval/compare-baseline.mjs` | PR 工作流断言：仅跑 `--check`（零成本）；nightly 工作流在配置齐全时跑 15 任务（C-07）并与 `desktop/eval/results/` 中基线做成功率/轮次/token 四项差分，退化超阈值即红 | D-07-B、F-008 | **B3-B-04（trace schema 先定）**、B0-B-03 |
| **B3-B-06** | MCP 2026-07 双栈 + transport 抽象（D-01-B） | 改 `desktop/main/mcpClient.js`、`mcpProtocol.js`；新增 `desktop/main/mcpTransport/` | `mcp-dual-era.test.mjs`：断言 2025-11 与 2026-07 两种握手均可完成且 capability negotiation 结果正确 | D-01-B | B3-B-02（surface 边界先定）、B1-B-04 |
| **B3-B-07** | Linux Landlock + seccomp 主后端、bwrap fallback（D-09-B） | 新增 native 模块；改 `desktop/main/sandboxLinux.js` | 在 Linux CI runner 上断言：默认后端为 Landlock+seccomp；不可用时自动回落 bwrap 且**不静默降级**（有 reason） | D-09-B | B2-B-14 |

> **B3 排期冲突说明（§4.3 约束对 #6）**：B3-B-06 与 B3-B-07 都要 native/传输层投入，**不得与 B1/B2 并行**。本轮推荐顺序：B3-B-01 → B3-B-04 → B3-B-05 → B3-B-02 → B3-B-03 → B3-B-06 → B3-B-07。

---

## 6. 遗留问题与未知区（诚实标注）

1. **全量测试未运行**（C-09）。本轮纪律下只单独运行了 `bridge-parity.test.mjs`（4/4 通过）以取得 B-10/B-11 精确值；「219/220 suite 全部通过」在本轮**没有新证据**，文档中的「全绿」应视为历史结果。
2. **B1-B-01 的存量缺口规模未知**。53 个工具（B-03）中有多少未显式登记 `TOOL_LEVEL` / `REVERSIBILITY`，本轮**未逐项统计**——这直接决定 B1-B-01 的工作量。建议实施前先跑一次盘点。
3. **B1-B-05 的编码方案会影响存量配置**。改变 MCP 工具名会影响已保存会话、工具白名单、角色 preset 中记录的 MCP 工具名。存量 server 名集合**未盘点**，兼容策略待定。
4. **F-006 / F-007 的远端行为未验证**。前者是「规范 MUST vs 请求头静态差异」，后者是「不可信数据直达模型 schema」的静态攻击面；两者都需真机/构造恶意 server 才能证实影响量级。
5. **B1-B-06 的截断阈值对工具选择质量的影响未验证**。建议先观测后截断。
6. **B2-B-11 的端到端行为未验证**。静态断言只能保证「事件名与字段名不被改名」，不能保证 UI 点「招募」后工具子集真生效。
7. **两个文档在审查窗口内都被外部写入者改过**（F-015 / A-06a / A-09a）：技术文档出现 **3 个版本**（`217a162b…` → `5401942147…` → `175f1b3f…`），README 被**追加 +56 行**（3069 → 3125）。B0-B-01 只能冻结副本，不能阻止原文件继续变化；若原文件在 B1/B2 期间再次变更，文档类修复需要重做。
8. **`docs-consistency.test.mjs` 经 P3 判定为「半硬门禁」**（F-022）：**常量断言是硬的**（R-4 → EXIT=1），**引用存在性断言与缺文档分支是软的**（R-5 仍绿 / R-6 EXIT=0）；再叠加「CI 冷检出必走跳过分支」→ **对 CI 而言它事实上不起作用，故仍为 P1，定性不等于降级**。**但它断言的具体数字清单仍未与 B1-B-07/B1-B-08 对齐**——修改文档数字时需同步检查它，否则会引入新的假红或假绿。
9. **F-018 / F-019 的收窄幅度未量化**：51 个角色（D-04）中实际有多少未写 `allowMcp`、有多少 `toolNames` 会落到交集为空，本轮**未逐条统计**——这直接决定 B1-B-02 的回归面与用户可感知变化。
10. **F-020 的回退路径触发条件未实测**：`mainChannelReady=false` 在何种运行态下真正发生（打包环境 / 主进程崩溃 / 冷启动竞态），本轮**未验证**。
11. **本轮未采用的能力维度未评估**：多模态输入的成本模型、subagent evaluator/generator 的**行为**隔离（研究员已在简报 §5.3 标注需真机验证）、Chrome/浏览器工具链的实际可用性——均不在本方案范围。
12. **URL 可达性未复核**：§4.4 的所有来源 URL 沿用 P0 研究员 16 次 WebSearch 的取证结果，架构师与 P3 本轮均未重新联网验证。
13. **P3 报告本体未逐条复述**：§6.5 是摘录整合；若需追溯某条断言的取证命令，请直接读 `docs/harness-r7/04-test/事实核验报告.md`。

---

## 6.5 独立核验结论（P3）

> 来源：`docs/harness-r7/04-test/事实核验报告.md`（545 行，含 §9 终稿定点复核；测试工程师独立完成，**未采信 P1 结论**）。本节只做摘录与裁决整合，不重复其取证过程。

### 6.5.1 正向断言：67 条，✅ 20 / ❌ 1 / ⚠️ 2

| 结果 | 条数 | 关键项 |
|---|---:|---|
| **✅ 通过** | **20** | F-002（矩阵不读 `TOOL_LEVEL`/`REVERSIBILITY`）、F-003（`supportsToolCall` 无消费点）、F-005（`my__svc` 反例可复现）、F-006（请求头无 `MCP-Protocol-Version`）、F-007（描述/schema 无闸）、F-008（`--check` 不跑 Agent）、F-011（三处事实错）、F-012（12 dirty + 0 2）、F-013（`1.0` vs `0.6.1-beta`）、F-014（resources/prompts 零命中）、**F-018**、**F-019**、**F-020**、**F-021**、**F-022** ——**说明**：P3 报 ✅ 共 20 条（按断言计），其中**可按发现编号归位的是上述 15 条**，余下为其核验用例编号（如 `A01a` / `A05h` / `A09c`），未逐条映射到 F 编号。**F-009 / F-010 不在 ✅ 内**（见下方 ⚠️ 行）；**F-015 / F-016 / F-017 不在本表任何一桶**（见下方纪律说明） |
| **❌ 被推翻** | **1** | **简报 F-004「渲染层对 `rolePreset` 零调用」**——实为 12 环端到端闭合（§3.2.1）。**架构师的 C-3 判定正确，研究员错误** |
| **⚠️ 部分成立** | **2** | ① **`F-009`**：套件数 217→218 已漂移（P3 核验时点已非简报值）；② **`F-010`**：数字（77 / 214 / 51 / 100）**全对**，但简报给的复核命令 `JSON.parse(...).length` 实得 `undefined`——顶层是 Object，工具数在 `.connectors` 键下 |

> **两条纪律性说明（防止转述失真）**：
> - **⚠️ 桶的 2 条是 P3 的核验产出**（F-009 / F-010 的口径与命令缺陷），**不是**架构师对 C-1 的自纠。架构师的 C-1 自纠（`:294`→`:296` 位移、文档从 2 版本变 3 版本）属于 §0.1 与 §1.1 A-06a 的内容，**不占 P3 的 ⚠️ 名额**。
> - **F-015 / F-016 / F-017 不进本表任何一桶**：这三条是架构师在修订中新增的发现，**不是 P3 核验的对象**。P3 仅对 F-016 做过行号核准，不构成「P3 核验通过」。

### 6.5.2 反向用例表（**证明哪些门禁是真的、哪些是假的**）

> **重要前提**：以下变异全部作用在**源码文件**上（不是「文档门禁测试」自身），用来探明 `docs-consistency.test.mjs` 与核验断言是否真的能抓到漂移。

| 用例 | 变异动作（作用对象 = 源码） | 期望 | 实测 | 裁定 |
|---|---|---|---|---|
| **R-1** | 源码**散文 / 注释**替换（涉 481 个文件） | 仍绿 | **EXIT=0 仍全绿** | ✅ **有效**——证明核验锚在**结构**（符号/数字）而非措辞，不会因文风变更误红 |
| **R-2a** | `mcpProtocol.js` 的**协议版本字面量**改为 `2099` | 红 | **EXIT=1**（A09c / A09d 用例红） | ✅ **有效** |
| **R-2b** | **IPC 通道名**改名 | 红 | **EXIT=1**（A05h 红） | ✅ **有效** |
| **R-3a** | **导出定义名**改名 | 红 | **EXIT=1**（A01a 红） | ✅ **有效** |
| **R-3b** | 同上但**一致改名**（定义与引用同改） | 观察是否依赖符号名耦合 | 因**钉死符号名**故红；行为探针另证 `mcp__my__svc__x` 的路由缺陷**与符号名无关** | ⚠️ **说明 F-005 是行为缺陷**，不是命名风格问题 |
| **R-4** | **常量值**改动（改 `TOOL_CHANNELS` / `NOTIFY_CBS` 等计数值） | 红 | **EXIT=1** | ✅ **硬**——常量断言是真门禁 |
| **R-5** | 文档内**引用存在性**改名（引用计数 28→27） | 红 | **仍 22/22 全绿** | ❌ **软**（F-022 证据 ①） |
| **R-6** | **移除技术文档**后运行 | 红 | **EXIT=0（静默跳过）** | ❌ **fail-open**（F-022 证据 ②） |

> **结论（定性修正）**：`docs-consistency.test.mjs` 是**半硬门禁**，不是纯哑校验——
> **常量断言是硬的**（R-4 → EXIT=1），**引用存在性断言与缺文档分支是软的**（R-5 仍绿 / R-6 EXIT=0）。
> 叠加第三个事实「该文档被 `.gitignore:46` 忽略 → CI 冷检出必然走跳过分支」（F-022 证据 ③），
> 净效果是「**在 CI 上它永远不会红**」。因此本文把它从「保障」降级为 **B0-B-04 待修项**——
> **不是因为它全假，而是因为它在真实 CI 环境下恒真**。

### 6.5.3 自动化无法覆盖清单（**必须维持「未验证」，不得升级**）

| # | 无法验证的内容 | 相关发现 | 需要的验证手段 |
|---:|---|---|---|
| 1 | MCP 严格 server 是否真的返回 400 | F-006 | 真机连接一个严格实现 2025-06/11 的 HTTP server |
| 2 | 真实 provider 是否拒绝对不支持 tool calling 的模型发 `tools` | F-003 | 对真实兼容端点抓包（会消耗额度） |
| 3 | 恶意 `description` 注入的实际行为与影响量级 | F-007 | 构造恶意 MCP server 实测 |
| 4 | Electron 真机 UI（点「招募」后工具子集是否真生效） | F-004 / F-021 | 启动 Electron + 人工/P3 端到端 |
| 5 | 三平台真机沙箱（Seatbelt / bwrap / Windows） | D-09 | macOS/Linux/Windows 各一次真机 |
| 6 | 付费 eval 的能力回归（成功率/轮次/token） | F-008、D-07 | 配置 endpoint/model/key 跑 15 个任务（C-07） |

> **纪律**：本方案中 F-006 / F-007 / F-003 / F-004 / D-09 / F-008 的「未验证」标注**全部保留**。P3 的核验只证明了「代码里缺什么」，没有证明「运行时会怎样」——两者不可混同。

---

## 7. 交付说明：任务约束 vs 架构师默认假设

### 7.1 主理人下发的任务约束（非用户拍板）

> **本轮用户尚未对任何决策拍板**；§4.1 的 10 条推荐均为架构师建议，§7.3 列出需用户裁决的 3 项。本节 5 条是**主理人下发的任务约束**，不是用户决策。

1. 冻结基线：Git HEAD `924909c29330e89372282801aa051ab9220caf52`；README **不适用单值锚定**（本轮被追加 +56 行，见 §1.1 A-09a）。**技术流程文档同样不适用单值锚定**——该文件在 7 分钟内出现 3 个版本（v1 `217a162b53f1f512` 712 行 → v2 `540194214702922f` 712 行 → **v3 `175f1b3f11d58b9b` 714 行，当前**），详见 §1.1 A-06a；**全篇以 v3 + 章节锚点引用（§1.6），v1 仅作历史记录，不作为「冻结基线」**。
2. 不修改任何项目源文件，只产出方案文档。
3. 沿用 F-001 ～ F-014 编号，不得删改；新增从 F-015 起。
4. 所有数字取自基线表，禁止「约 N」；同一数字跨章节一致。
5. 未验证结论必须标注。

### 7.2 架构师的默认假设（用户可推翻）

| # | 默认假设 | 若推翻的影响 |
|---|---|---|
| H-1 | 发布基线取**合并当前 diff 后**（§3.3） | 若改为基于 HEAD 打包，MCP 默认注入、`project_path` 迁移、记忆 `conversationId` 三项修复将被退回；测试口径回到 219 suite / 220 检查项 |
| H-2 | 10 个决策的推荐方案（§4.1 总表） | 任一被推翻需重跑 §4.3 一致性自查；尤其 D-04 若改为「删开关」（方案 A），约束对 #4 的矛盾自动消失 |
| H-3 | D-02-B（补 resources/prompts）排在 D-03 之后 | 若用户要求先补 resources，必须**同时**先建上下文预算闸（B2-B-01），否则等于在没闸时往上下文加内容 |
| H-4 | MCP server 名采用**可逆编码**而非禁止字符集 | 若改为禁止 `__`，需处理存量配置迁移；成本更高但语义更干净 |
| H-5 | B1-B-06 先「观测模式」再开截断 | 若用户要求直接截断，需接受工具选择质量下降的风险（未验证） |
| H-6 | B3 顺序 B01→B04→B05→B02→B03→B06→B07 | 若资源充足可并行 B3-B-02 与 B3-B-04；但 B3-B-06/B3-B-07 仍不得与 B1/B2 并行 |
| H-7 | 新增 F-015 ～ F-022 八条，F-004 降级 P2 | 若用户坚持原 F-004 判定（渲染层零调用），则需逐环反驳 **§3.2.1 的 12 环证据链**（该链已由 P3 独立核验确认）——架构师已给出逐环可定位行号，建议先复核再定 |

### 7.3 需要用户拍板的三个决策（架构师视角）

1. **F-018 / F-019（P1·安全）本轮是否一并 fail-closed 收窄**？——这是**方向性错误**（权限比声明的更宽），不是体验问题。架构师建议 B1 就做，且 F-019 用「翻默认值 + 51 角色显式 `allowMcp: true`」保持存量行为。若用户否决，必须给出强制触发条件（§4.4 D-05 附）。
2. **D-04 + H-1**：`supportsToolCall` 是「落硬门」还是「删开关」？同时发布基线取「合并当前 diff 后」还是「基于 HEAD」？——两者共同决定 B1 的验收数字与三项已完成修复是否进制品。
3. **D-06**：工具登记门禁只做「补测试断言」（低）还是做「声明式 registry 收敛」（中，根治）？——它决定了 D-03/D-05/D-09 三个下游策略能否只写一条规则，也决定 F-019 的默认值收敛时机。

---

> **文档结束**｜产出路径：`/Users/jianma/Desktop/MJCode/docs/harness-r7/02-design/架构调整实现方案.md`
> 五大部分齐全：§1 数字基线表 / §2 十三章完整度评估 / §3 发现清单 / §4 决策链路 / §5 调整实现方案（B0–B3）+ §6 遗留问题 + §7 交付说明。
> 本文件**未修改任何项目源文件**。

---

# 附录 · 审查过程台账、主理人独立裁决与交付说明

> 本附录由主理人（team-lead）汇编，记录**过程事实**与**裁决痕迹**，不含任何成员的专业产出。
> 正文章节（§0 ～ §7）由架构师（agent-harness-architect）撰写；核验结论由测试工程师（agent-harness-tester）独立产出并经主理人裁决整合。**成员的结论一律以其落盘文件为准**，本附录只做归属与追溯。

## 附录 A · 四阶段分工与产出

| 阶段 | 成员 | 角色 | 产出文件（均为 `docs/harness-r7/` 下） | 规模 |
|---|---|---|---|---|
| **P0 研究** | agent-harness-researcher | 三源（代码 / README / 技术流程文档）交叉取证 + 主流技术检索 | `01-research/审查事实简报.md` | 523 行，发现 F-001 ～ F-014 |
| **P1 设计** | agent-harness-architect | 数字基线复核、十三章完整度、决策链路、分批实施方案 | `02-design/架构调整实现方案.md`（即本文正文 §0 ～ §7） | 968 行，发现扩至 F-022 |
| **P3 核验** | agent-harness-tester | 独立对抗性核验（不复用 P0/P1 结论） | `04-test/事实核验报告.md` | 67 条断言 + 8 条反向用例 |
| **编排 / 裁决 / 汇编** | 主理人（本会话） | SOP 编排、确认门、跨阶段一致性仲裁、终稿汇编 | 本附录 + P4 交付引导 | — |

**协作边界（事实记录）**：
- 四名成员之间**无直连通信**，全部信息流经主理人中转。
- 成员**不得修改项目源文件**。全程 `git status` 保持 **12 个 tracked M + 2 个 untracked**、`origin/main...HEAD = 0 2`，与本轮开工时逐项一致（开工时点 2026-10-20 07:14，收口时点见 §附录 D）。

## 附录 B · 主理人独立裁决的 4 条（不经成员、亲自验的）

审查中出现三方结论冲突时，主理人必须自己下判断而不是"取多数"。本轮共 4 条：

| # | 争议 | 主理人的独立取证 | 裁决 |
|---|---|---|---|
| **B-1** | 研究员判「数字员工渲染层零调用」（P1 断裂）vs 架构师判「链路已闭合」 | ① 亲自 `rg` `renderer/src` 得 6 处命中；② 用 `git show HEAD:desktop/<path>` 排除工作区改动干扰，确认 `EcosystemModal.jsx` 与 `useAgentRun.ts` 在 **HEAD 上**即有命中；③ **原样执行研究员简报里自己给出的复核命令** `rg -n "employeeRuntime\|rolePreset" desktop/main desktop/renderer/src` | **架构师对，研究员错**；后经 P3 以 12 环证据链确认。**关键取证**：该命令在 `renderer/src` 实测命中 **3 个文件**（`useAgentRun.ts:610`、`EcosystemModal.jsx:175,179`、`EmployeeFormModal.tsx:4`）——**研究员的结论与它自己给出的复核命令直接矛盾**，因此这**不是 grep 口径问题**（未留证具体成因，不推测） |
| **B-2** | F-018「角色工具交集为空 → 回落全量」是否真存在 | 亲自读 `desktop/agent-core/index.js:2419-2429`：`else { console.warn('…回落全量工具') }` 且 `allTools` 未被改写 | **成立，且应升级**：这不是措辞问题而是 **fail-open**（只读角色配错工具名 → 反而拿到全量 53 个工具），属权限方向错误 |
| **B-3** | F-016「源码注释的基线数字已腐烂」是否成立 | 亲自跑 `node --input-type=module` 取 `BASE_TOOLS.length` = **52**；读 `agent-core/index.js:2401` 注释写「钉死为 **41**」；读 `test/web-todo-tools.test.js:54` 断言 **52**（同文件 `:43` 用例标题序列还停在 51） | **成立**。这是「理由型断言免检」的典型：注释里"因为被测试钉死为 41 所以不能加"这个理由，从来没人验过 |
| **B-4** | 「+1 个动态通道」具体在哪 | 亲自 `rg 'tool:\$\{'` → `desktop/main/tools/exec.js:664` 的 `ipcMain.handle(\`tool:${toolName}\`, …)`，位于 `:663` 的 `for (const toolName of WRITE_TOOLS)` 循环内 | **成立**。C-4 的三口径（186 调用点 / 185 静态字面量 / +1 动态）关系式闭合 |

> **为什么主理人要自己验**：这几条一旦判错，下游 10 个决策里至少 3 个（D-04 / D-05 / D-06）会建立在错误前提上。成员基于不同快照各说各话时，"谁说得更自信"不是判据，**能复现的命令才是**。
>
> **B-1 暴露的失效模式值得单记**：研究员给每条发现都附了「复核命令」，格式上很像可验证——但它给出的命令实测会**推翻它自己的结论**。这说明「附了复核命令」不等于「跑过复核命令」；**一条从未被执行过的复核命令，与没有复核命令等价，甚至更危险**，因为它会替结论背书。判据：对任何带复核命令的结论，**先原样执行该命令一次**，再读结论。

## 附录 C · 审查窗口内的并发写入事实（本轮最重要的元发现）

本次审查的**输入本身在移动**——这是必须先说清楚的前提，否则正文所有"文档第 N 行"都不可信。

| 文件 | 07:14（主理人首次测量） | 07:33（P0 冻结） | 07:40 | 07:41 | 07:43 | 结论 |
|---|---:|---:|---:|---:|---:|---|
| `MJcoder-技术流程功能文档.md` | **662 行** | 712 行 / `217a162b…` | 712 行 / `54019421…` | **714 行 / `175f1b3f…`** | — | 6 分钟内 **3 个版本**；行号与行数**双双失去锚点资格** |
| `README.md` | **2914 行** | 3069 行 / `e10a57d4…` | — | — | **3125 行 / `401475ba…`** | 被追加 **+56 行**；`sha256` 与 `blob` 同步漂移 |

**附带事实：本报告自身也经历了同样的漂移。** 架构师在窗口内产出 6 个版本：
`78c95807…`(951) → `acecffb7…`(953) → `7b3f52d8…`(953) → `7fa916bb…`(968) → `a7763dd5…`(968，**交付版**)。

这意味着**「终稿」这个词在本轮被四次证伪**。因此本报告的纪律是：**任何「终稿」声明必须附现算哈希，否则等于没有**。实证：P3 最后一次核验时实测磁盘值是 `7fa916bb…`（968 行），与主理人当时通告的 `7b3f52d8…`（953 行）不符——这不是谁记错了，是**通告与磁盘之间存在时间差**。这条经验直接支撑正文 B0-B-01 的前置条件：

> 冻结只读副本**必须在所有写入者停写之后**执行，并满足「mtime 稳定 ≥15 分钟 + 两次采样哈希一致（间隔 ≥60s）」，否则冻的是中间态。

**处置**：
1. 全篇**废弃 md 行号锚点**，改用「章节标题锚点 + 快照哈希」（正文 §1.6）。
2. **代码行号锚点不受影响**——它们锚定 Git HEAD `924909c`，是唯一稳定的一类锚点。
3. 两文件均被 `.gitignore:46 (*.md)` 忽略 → **`MJcoder-技术流程功能文档.md` 根本不在版本库**。这直接导致 F-022：`docs-consistency.test.mjs` 在 CI 冷检出时**必然走"文档不存在 → 跳过 → exit 0"**分支，即该门禁在 CI 上恒绿。**这条比"文档写错"更严重——它让所有基于该文档的验收都失去了机器保障。**

## 附录 D · 交付物清单与复现方式

| 交付物 | 路径 | 规格 |
|---|---|---|
| **审查报告与调整实现方案（主交付物）** | `docs/MJCode-AgentHarness第七轮全量审查报告-2026-10-20.md` | 正文 §0 ～ §7 + 本附录 |
| P0 事实简报 | `docs/harness-r7/01-research/审查事实简报.md` | 523 行 |
| P3 独立核验报告 | `docs/harness-r7/04-test/事实核验报告.md` | 579 行；67 条断言 + 8 条反向用例 + 4 处冲突裁决 |
| **P3 断言脚本（可复现件）** | `docs/harness-r7/04-test/check.mjs` | **292 行**；67 条断言（归为 23 组）；`node docs/harness-r7/04-test/check.mjs /Users/jianma/Desktop/MJCode` → **`PASS=67 FAIL=0`**（汇编时实测） |

> **为什么归档 `check.mjs`**：该脚本原本只存在于 `/tmp`，属易失位置。若不留存，「67 条断言全部可复现」就退化成一句无法验证的声明——这与本轮 F-001 / F-022 判的是同一类问题。归档后任何人可在本机一键重跑，**结论从"成员说通过了"变成"你自己能跑出来"**。
> 该文件**不在 `desktop/test/` 下**，不参与 `run-all.mjs` 的发现式扫描，**不会影响任何现有门禁的计数**（基线表 C-01/C-03/C-05 不受其影响）。
>
> **一处已知的口径残差（诚实标注）**：正文 §6.5 与本附录正文中若干处写「P3 报告 545 行」，为撰写时值；截至汇编完成该报告已增至 **579 行**（追加了 §9.7 / §9.8 两轮复核）。本附录**未改动正文那两处**，理由是保住正文哈希 `a7763dd5…` 的可核性——**若改了，正文就不再是 P3 逐项核过的那个版本**。这处残差本身就是 F-009 / F-010 同类问题的复现（引用值随被引用对象增长而失效），故保留并标注，而不是悄悄抹平。

**复现基线**（任何人拿到本文档后，可以按此重建结论）：

```bash
git -C /Users/jianma/Desktop/MJCode rev-parse HEAD          # 应为 924909c29330e89372282801aa051ab9220caf52
git -C /Users/jianma/Desktop/MJCode status --porcelain      # 12 个 M + 2 个 ??
git -C /Users/jianma/Desktop/MJCode rev-list --left-right --count origin/main...HEAD   # 0  2
shasum -a 256 /Users/jianma/Desktop/MJCode/MJcoder-技术流程功能文档.md   # 本报告引用的是 175f1b3f…
shasum -a 256 /Users/jianma/Desktop/MJCode/README.md                    # 本报告引用的是 401475ba…
```

> ⚠️ **若上述任一值与当前磁盘不符，说明文件又被写入过**——此时正文中所有基于该文件的数字必须重新现算，不能沿用。

## 附录 E · 未确认与未验证事项（诚实标注）

1. **用户未对任何决策拍板**。正文 §4.1 的 10 条推荐、§5 的 B0～B3 批次安排，全部是架构师建议 + 主理人放行，**不是用户决策**。需用户裁决的 3 项见正文 §7.3。
2. **本轮未运行全量 `npm test` / `npm run lint` / `npm run typecheck`**。原因：工作区有 12 个未提交改动、且审查窗口内有外部写入者活动，此时全量结果不可复现（历史教训：并发期全量测试会出现"每次失败集不同、单跑又全绿"）。因此正文与附录中**任何「全部通过」都只能理解为历史结果，不是本轮状态**。
3. **6 类结论维持「未验证」**：MCP 严格 server 返回 400、真实 provider 对 `tools` 的拒绝、恶意 description 的注入行为、Electron 真机 UI、三平台真机沙箱、付费 eval 能力回归。详见正文 §6.5.3。
4. **P2 编码阶段未执行**。本轮交付物是**审查报告 + 调整方案**，未改动任何生产代码；`03-code/` 目录不存在属预期。
5. **审查输入的可变性风险**：如附录 C，两个 md 文件在窗口内被改了 4 次以上，且写入者**不是本团队**。若用户当时有并行会话在编辑这两个文件，请以其最终版本复核附录 C 的行数结论。
