# MJCode Agent Harness 第八轮全量审查 —— 角度 C：安全、持久化与交付层

> **审查人**：agent-harness-architect（架构师）
> **团队**：mjcode-harness-r8　**阶段**：P1 设计/审查
> **HEAD 锚点**：`24acc1531f55d70d8f591f0435d48eb114fbf3d0`
> **口径声明**：默认**工作区**（`git status --short | wc -l` → 99）。凡 HEAD 与工作区不一致处两个数字都给。
> **锚点纪律**：证据用「文件路径 + 函数/常量名 + 可复核命令」，**不使用行号**。
> **主流性判据**：一律回指 `/Users/jianma/Desktop/MJCode/docs/harness-r8/01-research/主流技术基线简报.md` 的「主线 N · 判据 x.y」。
> **基线三条避坑提示已遵守**：OTel 稳定性按"未稳定、需钉 commit"处理（本角度仅涉及 span 命名，不声称对齐标准）；未混用 `AGENTS.md`/`SKILL.md`；未引用任何外部生态绝对数字。
> **本阶段未修改任何代码或既有文档**，落盘仅限本文件。

---

## §0 结论先行

**整体判断**：安全与交付层是本项目**工程纪律最扎实的一块**——审批三表经逐工具实测**零死条目、零兜底依赖**；沙箱 Linux fail-open 已收口为 fail-closed 且落到具体开关与 TTL 缓存上；门禁是"发现式 + 全量跑完 + 前置外部命令门禁"，实测 **246 项全绿、0 红**。当前的主要风险不是"门禁不绿"，而是两件事：**(a) 绿的是工作区，HEAD 落后整整 5 个数据库迁移**；**(b) 少数关键防线是"被门禁枚举守住"，而不是"本身 fail-closed"**——方向仍是 fail-open，只是今天没有东西能走到它。

**本角度最严重的 3 条**：

| # | 一句话 |
|---|---|
| **C-01** | **整个军团协同的持久化层（v8–v12 共 5 个迁移、153 行）只存在于未提交的工作区**：`HEAD` 最大迁移版本 = **7**，工作区 = **12**。基于 HEAD 打包的产物里 `teams / team_members / team_messages / sub_tasks 团队列 / memories 团队列 / task_events` 六组结构**全部不存在**。 |
| **C-02** | **`toolLevel()` 末行兜底 `|| 'L2'` 的方向仍是 fail-open**：实测未知工具返回 `L2`，而 `auto-safe` 档对 L2 **直接放行** ⇒ 任何不在 57 个模型工具枚举集内的新工具默认自动批准。今天命中数为 0，靠的是门禁枚举，**不是 fail-closed 本身**（违反基线判据 7.5）。 |
| **C-03** | **i18n 扫描脚本 `scripts/i18n-scan.mjs` / `i18n-modcheck.mjs` 存在但从未被自动触发**：前置门禁 `GATES` 只有 3 项（eval / doc-fact-check / harness-r7），不含 i18n；`test/` 下**无独立 i18n 套件**。这正是第七轮"存在却无人触发的假绿"的同类形态。 |

**一条重要正面结论（避免被误读为问题）**：审批体系**已无死条目**。第七轮担心的"表里登记 ≠ 生效"（`chrome_status` / `todo_write`）已在工作区被彻底消除——两个条目**已从 `TOOL_LEVEL` 摘除**，改由 `SPECIAL_CASED_TOOLS` 承担，注释明确说明"特判提前 return 后该条目永不被末行读到，属不可达配置"。逐工具实测：**表登记 ≠ 实际生效 = 0 条**；**无三表登记却落兜底 = 0 条**；三对交集**全空**。

---

## §1 模块现状表（角度 C 范围）

评级：**完整** = 有实现 + 有门禁 + 运行时生效一致；**部分** = 缺其一；**断裂** = 声明与运行时不一致且无守护；**缺失** = 无实现。

| 模块 | 关键文件 | 现状 | 评级 | 证据（可复核命令） |
|---|---|---|---|---|
| 审批·三表 | `desktop/main/approval.js` | `TOOL_LEVEL` 43 / `READONLY_TOOLS` 10 / `SPECIAL_CASED_TOOLS` 10；三对交集全空；逐工具比对表值 === 实际值 | **完整** | 见 §4.1 的验证脚本（`node /tmp/verify_approval.mjs`） |
| 审批·分级门禁 | `desktop/test/tool-registration-matrix.test.mjs` | 逐工具断言"不得依赖 `|| 'L2'` 兜底"+"登记即生效"+"恰居其一"；实跑 143/143 | **完整** | `node desktop/test/tool-registration-matrix.test.mjs \| tail -3` |
| 审批·兜底方向 | `approval.js` 的 `toolLevel()` 末行 | 未知工具 → `L2`；`auto-safe` 对 L2 放行 | **部分**（C-02） | 脚本输出 `未知工具兜底: L2` |
| 沙箱·档位 | `desktop/main/approvalPolicy.js` 的 `sandboxTierForCwd` | `read-only` / `workspace-write` / `full-access` 三档；档名单一出处为 `shared/rolePolicyData.json` | **完整** | `grep -n "function sandboxTierForCwd" desktop/main/approvalPolicy.js` |
| 沙箱·Linux fail-closed | 提交 `2f9ece4` | "只看平台+bwrap 存在"→"真探测 + TTL 缓存（默认 60s）"；已合入 HEAD | **完整** | `git merge-base --is-ancestor 2f9ece4 HEAD && echo YES` → YES |
| 沙箱·真机验证 | `test/sandbox-crossplatform.test.js`、`sandbox-linux-status.test.mjs`、`sandbox.test.js` | 本机（darwin）**3 个套件未真正执行**，但被汇总计入"通过" | **部分**（C-04） | 实测 log 末尾"未执行/跳过（3）"；CI 为 `ubuntu-latest` 会真跑 |
| 持久化·迁移链 | `desktop/main/db/index.js` 的 `MIGRATIONS` | `PRAGMA user_version` 版本链；迁移前快照备份（含 `-wal`/`-shm`）；WAL + `foreign_keys=ON` | **完整**（但版本分裂，见 C-01） | `grep -o "version: [0-9]*" desktop/main/db/index.js \| sort -n \| tail -1`；HEAD 同命令走 `git show HEAD:...` |
| 持久化·append-only | `task_events` 表（v12）+ `runTrace` JSONL | `task_events` 自增主键 + `(group_id,id)` 索引，只存轨迹不存正文；`runTrace` 落 `userData/traces/<runId>.jsonl` | **完整（方向对齐判据 8.1）** | `grep -n "task-activity-events" -A 12 desktop/main/db/index.js` |
| 持久化·幂等键 | — | 未发现从 `run_id`+`step_id` 派生的幂等键 | **❓ 未核 → 缺失风险** | 判据 8.4；本轮未找到实现，不敢断言"无" |
| 验证层 V | `desktop/main/verifyRun.js`、`verifyPolicy.js`、`verifier.js`、`verifierL3.js` | V-L1 全量零成本对账；L3 走风险门；无人值守 fail-closed；主通道默认档 `l3`、Worker 默认 `l1` | **完整** | 门禁中 `verifier-l3` / `verifier-rules` / `verify-l3-integration` 三套件全绿 |
| 前端接线 | `desktop/main/preload.js` | 桥接 208 个 invoke；渲染层完全未引用 **22 个（10.6%）** | **部分**（C-05，与角度 A 交界） | 见 §4.5 |
| i18n | `scripts/i18n-scan.mjs`、`i18n-modcheck.mjs` | 扫描脚本存在；**未进 GATES**；`test/` 下无独立 i18n 套件 | **断裂**（C-03） | `grep -n "GATES = \[" -A 5 desktop/test/run-all.mjs` |
| 门禁总入口 | `desktop/test/run-all.mjs` | 发现式（243 套件）+ 3 项外部前置门禁；单套件崩溃/超时不阻断后续 | **完整** | 实测 `node test/run-all.mjs` → EXIT=0 |
| CI | `.github/workflows/ci.yml` | `ubuntu-latest`；跑 lint（warning 棘轮 161）、`npm test`、typecheck、build、全量语法门禁 | **完整** | `cat .github/workflows/ci.yml` |
| 软档白名单 | `desktop/test/max-lines.test.js`、`eslint.config.mjs` | 800 行软档白名单 3 个文件；ESLint `max-lines` 豁免仅 `agent-core/index.js` 一条 | **完整（有张力）** | 见 §4.6 |

---

## §2 发现清单（C-01 ～ C-07）

> ⚠️ **编号撞名提示**：本文件 §2 的 **C-xx 是"角度 C 的发现编号"**，与 P0 基线简报 §2 自检表的 **C-01～C-69 是完全不同的一套编号**。两者重名但无关。
> 本文件内部凡引用自检表编号处，一律写作「**自检 C-nn**」加以区分；自检表填值集中在 **§6**。
> 例：主理人更正的「自检 C-01 = ✅（`MCP-Protocol-Version` 头）」是自检表条目，**与本文件发现 C-01（军团迁移未提交）无关**。该更正已在角度 A 报告 §6.1 按 ✅ 记录，本文件不再重复。

### C-01　军团协同的持久化层（v8–v12）全部只存在于未提交的工作区　**P1**

- **现状**：`desktop/main/db/index.js` 的 `MIGRATIONS` 数组在 **HEAD 口径最大版本 = 7**，**工作区口径 = 12**。v8–v12 五个迁移（`team-roster` / `team-message-bus` / `team-board-waiting` / `team-memory` / `task-activity-events`）是工作区新增的 **153 行**，全部未提交。
- **证据**：
  - `grep -o "version: [0-9]*" desktop/main/db/index.js | grep -o "[0-9]*" | sort -n | tail -1` → `12`（工作区）
  - `git show HEAD:desktop/main/db/index.js | grep -o "version: [0-9]*" | grep -o "[0-9]*" | sort -n | tail -1` → `7`（HEAD）
  - `git diff --stat HEAD -- desktop/main/db/index.js` → `1 file changed, 153 insertions(+)`
  - `git diff HEAD -- desktop/main/db/index.js | grep "^+" | grep version` → `version: 8,` … `version: 12,`
- **影响**：
  1. **基于 HEAD 打包的产物不含军团协同的整套数据结构**：`teams`、`team_members`、`team_messages`、`sub_tasks` 的 5 个团队列、`memories` 的 `team_id`/`agent_id`、`task_events` —— **六组全部缺失**。军团功能在 HEAD 口径下不可用，而工作区是"能跑"的，这就是最容易误判的地方。
  2. 与第七轮 F-012 同类，**且规模显著扩大**：第七轮是 12 个 dirty 文件，本轮是 **99 个**。
  3. v12 的 `task_events` 是本角度唯一"append-only 轨迹表"（对齐判据 8.1 方向），它同样未提交 —— 等于**最有价值的那条也没进版本**。
- **补充（正面）**：团队要求的 `task_groups.project_path` **v7 迁移已落地且已在 HEAD 内**（`grep -n "addColumn(db, 'task_groups', 'project_path'" desktop/main/db/index.js`；v7 即 HEAD 最大版本）。这一项不需再追。
- **建议**：发布前必须提交并推送；对外所有"军团协同"相关结论一律标注双口径（HEAD v7 / 工作区 v12）。中期建议把"关键能力是否在 HEAD"做成一条门禁（对比 `git diff --stat HEAD` 与功能清单）。
- **连带文件**：`desktop/main/db/index.js`（提交）；若需拆分，涉及 `main/teamStore.js`、`main/teamTools.js`、`main/ipc/teams.js`（三者同为工作区新增）
- **严重度**：**P1**（与 F-012 同级；不是代码缺陷，是发布口径缺陷，但会直接导致"发布了没有军团功能的版本"）

---

### C-02　`toolLevel()` 兜底 `|| 'L2'` 的方向仍是 fail-open　**P2**

- **现状**：`approval.js` 的 `toolLevel()` 末行为 `return TOOL_LEVEL[tool] || 'L2'`。实测 `toolLevel('__nope__', {})` → **`L2`**。而 `needsApproval` 在 `auto-safe` 档对 L2 **直接放行**。
- **问题**：任何**不在 57 个模型工具枚举集内**的工具（未来的新通道、非模型工具、拼写漂移的通道名）会**默认落到 L2**，在无人值守/auto-safe 档下自动批准。
- **证据**：
  - 验证脚本输出：`未知工具兜底: L2`、`[B] 无三表登记但实际=L2（兜底嫌疑）: 0`（对已枚举的 55 个模型工具）
  - `grep -n "return TOOL_LEVEL\[tool\] || 'L2'" desktop/main/approval.js`
- **影响**：
  1. **今天命中数为 0**——但这是"门禁枚举集覆盖了全部模型工具"的结果，不是 fail-closed 本身。防线是**外挂的**（矩阵门禁），不是**内建的**。
  2. 矩阵门禁的驱动集是"模型可见工具"（57 个）。**非模型工具的通道**不在驱动集内 → 一旦新增，无门禁覆盖，直接落 L2。
  3. 直接违反基线判据 7.5「工具/能力开关缺省为最严格侧」。
- **建议**：把兜底改为 `'L3'`（最严格）。**零风险实证**：已枚举集内无任何工具依赖兜底（实测 0 条），因此改动不改变任何现有工具的审批行为，只改变"未知工具"的处置方向——而这正是最该收紧的一类。同时在注释里写明"能走到兜底 = 不在任何表内 = 必须拦"。
- **连带文件**：`desktop/main/approval.js`、`desktop/test/tool-registration-matrix.test.mjs`（补一条"未知工具必须判 L3"的断言）
- **严重度**：**P2**（当前有门禁兜住、无实网故障；但方向错误，且是判据 7.5 的直接反例）

---

### C-03　i18n 扫描脚本存在但从未被自动触发（"存在即假绿"）　**P2**

- **现状**：`desktop/scripts/i18n-scan.mjs` 与 `i18n-modcheck.mjs` 两个脚本存在，但：
  1. **不在 `GATES` 里**——`run-all.mjs` 的 `GATES` 只有 3 项：`eval:check`、`doc-fact-check`、`harness-r7:check`；
  2. **`test/` 下无独立 i18n 套件**（`ls test/ | grep -i i18n` → 空）。
- **证据**：
  - `grep -n "GATES = \[" -A 5 desktop/test/run-all.mjs`（3 项，无 i18n）
  - `ls desktop/test/ | grep -i "i18n\|locale"` → 空
  - `node desktop/scripts/i18n-scan.mjs` → 打印用法后退出（需显式传路径，无默认扫描目标）
- **影响**：i18n key 缺失 / 硬编码文案**没有任何自动触发方**。这与第七轮 F-008/F-009"eval 存在却无人触发"是同一个失败形态——只不过 eval 那次已被 G11 收进 GATES，**i18n 这次还没有**。
- **建议**：
  1. 把 i18n 扫描加进 `GATES`（给它一个默认扫描目标，如 `desktop/renderer/src`，避免"需显式传参"这种不可自动化的形态）。
  2. 或至少补一条 `test/i18n-*.test.mjs` 套件（发现式会自动跑到）。
- **连带文件**：`desktop/test/run-all.mjs`（GATES 增项）、`desktop/scripts/i18n-scan.mjs`（加默认目标）
- **严重度**：**P2**（基线判据 9.5「eval 必须真跑进 CI」的同构要求；i18n 属同一类门禁完整性问题）

---

### C-04　门禁汇总把"未执行/跳过"计入"通过"　**P3**

- **现状**：`run-all.mjs` 的汇总公式为 `通过 = suites.length + GATES.length - failed.length`，**没有减掉 skipped**。实测本机输出：`总计 246 · 通过 246 · 失败 0`，紧接着单列"未执行/跳过（3）"。
- **证据**：
  - `grep -n "总计" desktop/test/run-all.mjs` → `总计 ${suites.length + GATES.length} · 通过 ${suites.length + GATES.length - failed.length} · 失败 ${failed.length}`
  - 实测 log 末尾同时出现"通过 246 · 失败 0"与"未执行/跳过（3）"
  - skipped 的识别靠正则 `/⚠.*(跳过|未执行)/` 扫套件输出
- **影响**：
  1. **低**：runner 自己单列了 skip 清单，不构成欺骗；且 CI 跑在 `ubuntu-latest`，3 个沙箱套件中至少 `sandbox-crossplatform` 与 `sandbox-linux-status` 会真正执行。
  2. 但汇总行"通过 246"是**失真的**：任何只看"失败 0"的消费方（含未来的 dashboard）会误读为"全平台已验证"。
  3. skip 的识别依赖套件**自愿打印** `⚠…跳过/未执行` 字样——套件若改了措辞，skip 就会静默变成 pass，且这个失效**没有守护**。
- **建议**：汇总改为四元组 `通过 / 失败 / 跳过 / 总计`；给 skip 的识别加一条自检（例如断言 skip 数 > 0 时必须有对应套件名）。是否让 skip 影响退出码属产品决策，见 **DC-03**。
- **连带文件**：`desktop/test/run-all.mjs`
- **严重度**：**P3**（已披露、CI 平台会真跑；属口径严谨性问题）

---

### C-05　22 个从未被引用的 preload 桥接：需二选一处置（与角度 A 交界）　**P2**

- **现状**：preload 桥接 208 个 `ipcRenderer.invoke`，渲染层源码中完全找不到引用的 **22 个（10.6%）**。整族死代码集中在：`collab*` 6 个（`collabOpen` / `collabDocId` / `collabPersist` / `collabEncodePush` / `collabApplyUpdate` / `collabListLocal` / `collabCloseAll`）、`teams*` 4 个（`teamsUpdate` / `teamsArchive` / `teamsSetMemberEnabled` / `teamsCreateLead`）。
- **问题**：与 C-01 叠加后形成一条更尖锐的判断——**`collab*` 整族（CRDT 协作）既无前端调用、也不在任何迁移/功能叙事里被提到**，是彻底的死子系统；而 `teams*` 那 4 个是**军团功能做了一半**（列表/创建/派活有 UI，更新/归档/启停/设组长没有）——军团本体又整个未提交（C-01）。
- **证据**：角度 A 的三段交叉脚本（注册 / 桥接 / 渲染层引用），见 §4.5；人工抽检已排除 `agentRun` / `teamsList` / `ecosystemSummary` / `marketSearch` 等别名调用误报。
- **影响**：
  1. 每个死桥接 = 一份"看起来有能力、实际无入口"的对外声明面，直接违反基线判据 10.6「声称能力与守护不变量一一对应」。
  2. `collab*` 6 个还连着主进程 handler 与可能的 CRDT 依赖，是**可观的死重**。
- **建议**：见 **DC-02**（删 vs 补 UI 的决策）。
- **连带文件**：`desktop/main/preload.js`、`desktop/main/ipc/ecosystem.js`（collab handler）、`desktop/main/ipc/teams.js`
- **严重度**：**P2**

---

### C-06　SSRF 拦截清单是纯字符串判定：团队点名的两个地址都拦住了，但 5 种写法可绕过　**P2**

- **现状**：`desktop/main/webTools.js` 的 `isPrivateHost(hostname)` 是全项目**唯一的** SSRF 判据（`nativeTools.js` 的 `http_request` 与 `mcpHttpTransport` 之外的出网都复用它，注释明示"必须保持单一实现、不允许旁路"）。
- **实测**（逐用例调用，非读代码推断）：

  | host | 是否被拦 |
  |---|---|
  | `169.254.169.254`（AWS/GCP 元数据） | **✅ true** |
  | `fd00:ec2::254`（IPv6 唯一本地） | **✅ true** |
  | `fe80::1`、`::1`、`localhost`、`127.0.0.1`、`10.x`、`192.168.x`、`172.16-31.x`、`0.x` | ✅ true |
  | `0:0:0:0:0:0:0:1`（IPv6 回环**全写式**） | ❌ **false** |
  | `::ffff:127.0.0.1`（IPv4-mapped IPv6） | ❌ **false** |
  | `2130706433`（十进制 = 127.0.0.1） | ❌ **false** |
  | `0x7f.1`（十六进制）、`0177.0.0.1`（八进制） | ❌ **false** |
  | `metadata.google.internal`、`my-internal.local` | ❌ **false** |

- **证据**：
  ```bash
  cd /Users/jianma/Desktop/MJCode/desktop && node -e "
  const { isPrivateHost } = require('./main/webTools.js');
  for (const h of ['169.254.169.254','fd00:ec2::254','0:0:0:0:0:0:0:1','::ffff:127.0.0.1','2130706433','metadata.google.internal'])
    console.log(h.padEnd(26)+isPrivateHost(h));"
  ```
- **问题**：判定是**纯词法**的（正则前缀匹配），既不做 IP 归一化（十进制/十六进制/八进制/IPv4-mapped），也**不做 DNS 解析**。绕过路径：`http://2130706433/` 或 `http://[::ffff:127.0.0.1]/` 直达本机；`http://my-internal.local/` 直达内网。
- **影响**：`web_fetch` 为 **L2**，在 `auto-safe` 档与**无人值守通道**自动放行 ⇒ 定时任务/Worker 调用 `web_fetch('http://2130706433/...')` 可打穿到本机服务（`scheduledEventServer` 只绑 127.0.0.1 且带 token，`chromeRelay` 只绑 127.0.0.1 —— 二者正是可被触达的目标）。属真实 SSRF 面，非理论风险。
- **建议**：
  1. 判定前先**归一化**：用 `net.isIP()` 判 IPv4/IPv6，非 IP 才走字符串；IPv6 统一展开后判 `::1` / `::ffff:0:0/96` / `fe80::/10` / `fc00::/7`。
  2. **补 DNS resolve-then-validate**（见 C-07）。
- **连带文件**：`desktop/main/webTools.js`（`isPrivateHost`）、`desktop/main/nativeTools.js`（复用方）
- **严重度**：**P2**（团队点名的两个地址已拦住，说明基本盘是对的；但存在可达本机/内网的确定性绕过写法，且无人值守通道可自动放行）

---

### C-07　SSRF 无 resolve-then-validate，DNS rebinding 与内网域名不可拦　**P2**

- **现状**：`isPrivateHost` 只接收**已解析出的 hostname 字符串**，项目中未见"先 resolve 再校验解析结果"的环节；实测 `metadata.google.internal`、`my-internal.local` → `false`（放行）。
- **证据**：同上实测表；`grep -n "isPrivateHost" desktop/main/webTools.js desktop/main/nativeTools.js`（仅词法判定，无 `dns.lookup` / `net.isIP` 参与）
- **影响**：基线判据 7.8 要求 URL 类工具 **resolve-then-validate**（防 DNS rebinding）。当前形态下：① 解析到内网 IP 的域名可直达内网；② 典型 DNS rebinding（首次解析公网、二次解析 127.0.0.1）无法拦截。
- **建议**：在 `httpRequest` 发起前 `dns.lookup(hostname, {all:true})`，对**全部**返回地址逐一过 `isPrivateHost`，再对校验通过的那个 IP 直连（或至少 pin 住 IP 校验）。注意这会增加一次 DNS 往返，需用 TTL 缓存控制成本（可复用沙箱探测那套 TTL 模式）。
- **连带文件**：`desktop/main/webTools.js`、`desktop/main/nativeTools.js`
- **严重度**：**P2**

---

## §3 需要决策的点（DC-01 ～ DC-04）

### DC-01　军团持久化 v8–v12 的处置

| 方案 | 代价 | 说明 |
|---|---|---|
| **A. 整体提交并推送**（推荐） | 一次提交；需确认 v8–v12 在干净库上可迁移 | 消除"HEAD 与工作区分裂"这一最大误判源；`snapshotBeforeMigrate` 已提供迁移前备份 |
| B. 拆为独立 feature 分支继续孵化，主分支先不含军团 | 需 revert 工作区的团队相关文件（涉及面大） | 若军团尚未到可发布质量，这是诚实的做法；但当前工作区 99 个 dirty 混杂，拆分成本高 |
| C. 维持现状（不提交） | 0 | 但任何"军团协同已落地"的结论在 HEAD 口径下都是假的；C-01 持续存在 |

- **推荐 A**（若军团功能已进入"要做完"的轨道）；若产品上尚未决定军团是否发，则 **B**。
- **若采纳 A，需连带改**：`desktop/main/db/index.js`（提交）并在文档中标注"军团协同自 v8 起"；CI 无需改动。

---

### DC-02　22 个死桥接：删还是补 UI

| 方案 | 代价 | 说明 |
|---|---|---|
| **A. 分类处置**（推荐）：`collab*` 6 个整族删除（桥接 + handler + 依赖）；`teams*` 4 个随军团功能补齐 UI | 中等（collab 需确认无其它消费者） | 一刀切删或一刀切补都会错：collab 是死子系统，teams 是半成品 |
| B. 全部补齐 UI | 大（要写 4 个团队管理界面 + 6 个协作界面） | 与"军团本体未提交"矛盾——先把 C-01 落了再说 |
| C. 全部删除 | 小 | 会误删军团已规划的能力（team 归档/启停/设组长是真实需求） |

- **推荐 A**。判据：先看该族是否在产品叙事里存在（`collab` 不在 → 删；`teams` 在但 UI 未完 → 留下并补）。
- **若采纳 A，需连带改**：`desktop/main/preload.js`、`desktop/main/ipc/ecosystem.js`（collab handler 与其依赖）、`desktop/main/ipc/teams.js`、渲染层（若补 UI）。

---

### DC-03　`toolLevel()` 兜底方向：改 L3 还是保持 L2

| 方案 | 代价 | 说明 |
|---|---|---|
| **A. 兜底改 `'L3'`**（推荐） | 一行 + 一条新断言 | 实测已枚举集内 0 条依赖兜底 ⇒ **行为零变化**，只收紧"未知工具"；直接满足判据 7.5 |
| B. 保持 `'L2'`，靠矩阵门禁守 | 0 | 防线是外挂的；非模型工具通道不在矩阵驱动集内，存在覆盖盲区 |
| C. 兜底改为抛错（显式要求登记） | 需改调用方错误处理 | 最严格，但"未知工具"在运行期抛错会打断整轮运行，风险高于收益 |

- **推荐 A**。这是本角度**性价比最高的一条**：一行改动、零行为变化、把一个 fail-open 方向翻成 fail-closed。
- **若采纳 A，需连带改**：`desktop/main/approval.js`、`desktop/test/tool-registration-matrix.test.mjs`（补断言）。

---

### DC-04　门禁"跳过"是否应影响退出码

| 方案 | 代价 | 说明 |
|---|---|---|
| **A. 只改呈现，不改退出码**（推荐） | 改 `run-all.mjs` 汇总一行为四元组 | 保持"失败才红"的语义；skip 单列可见。CI 在 ubuntu 上已会真跑沙箱，不需要靠退出码施压 |
| B. skip > 0 即非零退出 | 会让 CI 在本机/CI 差异下频繁变红 | 过度：有些 skip 是合理的平台差异 |
| C. skip 数超过阈值才红（棘轮） | 需维护阈值 | 可防"跳过越来越多"，但当前 3 条属正常平台差异，棘轮会误伤 |

- **推荐 A**，另加一条：**给 skip 的识别加自检**（断言 skip>0 时套件名可解析），防止措辞变化导致 skip 静默变 pass。
- **若采纳 A，需连带改**：`desktop/test/run-all.mjs`。

---

## §4 数字基线（角度 C）

### 4.1 审批三表逐工具实测（核心事实）

```bash
cd /Users/jianma/Desktop/MJCode/desktop
cat > /tmp/verify_approval.mjs <<'EOF'
import { createRequire } from 'node:module';
const require = createRequire('/Users/jianma/Desktop/MJCode/desktop/');
const a = require('/Users/jianma/Desktop/MJCode/desktop/main/approval.js');
const core = await import('/Users/jianma/Desktop/MJCode/desktop/agent-core/index.js');
const TL = a.TOOL_LEVEL, RO = a.READONLY_TOOLS, SC = a.SPECIAL_CASED_TOOLS;
console.log('TOOL_LEVEL=' + Object.keys(TL).length, 'READONLY=' + RO.size, 'SPECIAL=' + SC.size);
console.log('TL∩SC =', JSON.stringify(Object.keys(TL).filter(t=>SC.has(t))));
console.log('TL∩RO =', JSON.stringify(Object.keys(TL).filter(t=>RO.has(t))));
console.log('RO∩SC =', JSON.stringify([...RO].filter(t=>SC.has(t))));
let mismatch=[], uncovered=[];
for (const t of Object.keys(core.TOOL_HANDLER_NAMES)) {
  const actual = a.toolLevel(t, {});
  const inTL = Object.prototype.hasOwnProperty.call(TL, t);
  if (inTL && TL[t] !== actual) mismatch.push(`${t}: 表=${TL[t]} 实际=${actual}`);
  if (!inTL && !RO.has(t) && !SC.has(t) && actual === 'L2') uncovered.push(`${t}`);
}
console.log('[A] 表≠实际:', mismatch.length, mismatch.join(' | '));
console.log('[B] 落兜底:', uncovered.length, uncovered.join(' | '));
console.log('未知工具兜底:', a.toolLevel('__nope__', {}));
EOF
node /tmp/verify_approval.mjs
```

| 指标 | 数值 | 口径 |
|---|---|---|
| `TOOL_LEVEL` 条目数 | **43** | 工作区 |
| `READONLY_TOOLS` 条目数 | **10** | 工作区 |
| `SPECIAL_CASED_TOOLS` 条目数 | **10** | 工作区 |
| `TOOL_LEVEL ∩ SPECIAL_CASED` | **∅（空）** | 工作区 |
| `TOOL_LEVEL ∩ READONLY` | **∅（空）** | 工作区 |
| `READONLY ∩ SPECIAL_CASED` | **∅（空）** | 工作区 |
| **[A] 表登记 ≠ `toolLevel()` 实际生效** | **0 条** | 工作区（逐工具调用，非读数表） |
| **[B] 无三表登记却落 `L2` 兜底** | **0 条** | 工作区 |
| **未知工具兜底值** | **`L2`** | 工作区 → C-02 |
| `mcp__*` 前缀实际分级 | `L3` | 工作区 |
| 实际分级分布（63 个工具） | `null` 18 / `L2` 23 / `L3` 18 / `L1` 2 | 工作区 |

> **与"文档声称"的对齐**：矩阵测试自报 `TOOL_LEVEL=43 / SPECIAL=10 / READONLY=10`，与实测**完全一致**；矩阵自报"57 个工具全部有显式依据"、"38 个显式登记工具逐一一致" —— 与实测 [A]=0 一致。**无落差。**

### 4.2 数据库迁移链

```bash
cd /Users/jianma/Desktop/MJCode
grep -o "version: [0-9]*" desktop/main/db/index.js | grep -o "[0-9]*" | sort -n | tail -1        # 12
git show HEAD:desktop/main/db/index.js | grep -o "version: [0-9]*" | grep -o "[0-9]*" | sort -n | tail -1  # 7
git diff --stat HEAD -- desktop/main/db/index.js                                                  # 153 insertions
grep -n "project_path" desktop/main/db/index.js                                                   # v7 内
```

| 指标 | 数值 | 口径 |
|---|---|---|
| `MIGRATIONS` 条目总数 | **12** | 工作区 |
| 最大迁移版本 | **12** | 工作区 |
| 最大迁移版本 | **7** | **HEAD**（`git show HEAD:...`） |
| 仅存在于工作区的迁移 | **5 个（v8–v12，153 行）** | diff |
| `task_groups.project_path` 所在版本 | **v7** | 工作区 & HEAD（v7 = HEAD 最大版本 ⇒ **已落地**） |
| WAL | `journal_mode = WAL` + `foreign_keys = ON` | 工作区 |
| 迁移前快照 | `snapshotBeforeMigrate`（含 `-wal`/`-shm` 三件套） | 工作区 |

> **与"文档声称"的对齐**：主理人派单时写「R7 时 v63」。实测 HEAD 最大版本为 **7**、工作区 **12**。**未见 63**——推测 v63 是笔误或指另一处版本号（本轮未找到任何 63）。此项**请主理人复核**，我不代为裁定。

### 4.3 沙箱

```bash
git merge-base --is-ancestor 2f9ece4 HEAD && echo YES     # YES —— 已合入
git log --oneline -1 2f9ece4
grep -n "function sandboxTierForCwd" desktop/main/approvalPolicy.js
```

| 指标 | 数值 | 口径 |
|---|---|---|
| Linux fail-closed 提交 `2f9ece4` 是否合入 HEAD | **YES** | HEAD |
| TTL 缓存默认值 | 60s（`MJCODE_SANDBOX_PROBE_TTL_MS` 可覆盖） | 工作区 |
| 沙箱档位 | `read-only` / `workspace-write` / `full-access` | 工作区 |
| 本机实测未执行的沙箱套件 | **3** | 工作区（darwin） |

### 4.4 门禁与 CI

```bash
cd /Users/jianma/Desktop/MJCode/desktop
ls test/*.test.js test/*.test.mjs test/smoke-load.mjs test/render-smoke.mjs | wc -l   # 243
grep -n "GATES = \[" -A 5 test/run-all.mjs
node test/run-all.mjs > /tmp/r8-gates.log 2>&1; echo "EXIT=$?"
tail -6 /tmp/r8-gates.log
```

| 指标 | 数值 | 口径 |
|---|---|---|
| 发现式套件数 | **243** = `test.js` 88 + `test.mjs` 153 + smoke 2 | 工作区 |
| `GATES`（外部命令门禁） | **3** 项：`eval:check`、`doc-fact-check`、`harness-r7:check` | 工作区 |
| 汇总条目 | **246** = 243 + 3 | 工作区 |
| 实测结果 | **通过 246 · 失败 0 · EXIT=0** | 工作区 |
| 其中"未执行/跳过"被计入通过 | **3** | 工作区 |
| CI 平台 | `ubuntu-latest`；跑 lint / `npm test` / typecheck / build / 全量语法门禁 | 工作区 |
| CI 是否真跑 `run-all.mjs` | **是**（`npm test`，注释明示"与本地 npm test 同一门禁"） | 工作区 |

> **241 的来源说明**：主理人派单写「241 个测试文件」。实测 `test.js` 88 + `test.mjs` 153 = **241**（不含 2 个 smoke 套件），与该数字吻合。

### 4.5 前端接线（与角度 A 交界，此处仅给处置口径）

| 指标 | 数值 | 口径 |
|---|---|---|
| preload 桥接 invoke 方法 | **208** | 工作区 |
| 主进程注册通道 | **209**（静态 206 + `tool:${toolName}` 模板族 3） | 工作区 |
| 注册但 preload 未桥接 | **2**（`diag:preview`、`scheduled:ingestEvent`） | 工作区 |
| 桥接但渲染层完全未引用 | **22 / 208 = 10.6%** | 工作区 |
| 整族死代码 | `collab*` 6 个、`teams*` 4 个 | 工作区 |

### 4.6 软档白名单（主理人已给，此处对齐复核）

| 指标 | 数值 | 口径 |
|---|---|---|
| `BASELINE_800` 白名单 | 3 个文件：`main/computerUse.js`、`main/main.js`、`agent-core/index.js` | 工作区 |
| ESLint `max-lines` 豁免清单 | **1 条**（仅 `agent-core/index.js`） | 工作区 |
| `main.js` 实测行数 | 1980（raw） | 工作区 |
| `computerUse.js` 实测行数 | 1335（raw） | 工作区 |

> **张力点**：`main.js` 与 `computerUse.js` 进了 800 行**软档白名单**（`max-lines.test.js`），但**不在 ESLint `max-lines` 豁免清单**里。两套机制对同一事实的登记不一致 —— 若 ESLint 的 `max-lines` 规则确实启用且不豁免这两个文件，理论上应已报 error；实测 lint 在 CI 中是绿的，故推断 ESLint 侧未对该规则启用或另有配置。**本轮未验证到 ESLint 侧的实际生效状态，标 ❓ 未核**，建议交主理人确认后写入结论。

---

## §5 门禁实测结果

**跑了什么**（工作区口径，本机 darwin）：

```bash
cd /Users/jianma/Desktop/MJCode/desktop && node test/run-all.mjs > /tmp/r8-gates.log 2>&1; echo "EXIT=$?" >> /tmp/r8-gates.log
```

**结果**：`EXIT=0` —— **总计 246 · 通过 246 · 失败 0**。

**红：0 条。** 243 个测试套件 + 3 项外部前置门禁全部通过。

**绿中的保留项（3 条，必须点名，见 C-04）** —— 汇总把它们计入"通过"，但 runner 自己单列为"未执行/跳过"：

| 套件 | 本机（darwin）实际状态 |
|---|---|
| `test/sandbox-crossplatform.test.js` | 未执行（非 Linux 或 bwrap 未安装）；套件自述"PASS 不代表 Linux 沙箱已验证，需在 CI 的 ubuntu runner 上跑" |
| `test/sandbox-linux-status.test.mjs` | 仅验证 fail-closed **判定逻辑**；bwrap 真实命名空间隔离未执行 |
| `test/sandbox.test.js` | 真实沙箱探测跳过（环境限制）：`/usr/bin/sandbox-exec -p (version 1)` 命令失败 |

**这让"全绿"意味着什么**：
- ✅ 逻辑层门禁（含沙箱 fail-closed 判定逻辑）已验证。
- ⚠️ **真实沙箱隔离能力在本机未被验证**；但 CI 跑在 `ubuntu-latest`，`sandbox-crossplatform` 与 `sandbox-linux-status` 在 CI 上会真正执行 —— 因此**沙箱真机验证的指望落在 CI，建议主理人确认 CI 最近一次运行确实绿**（本轮我只跑了本机，未查 CI 历史）。
- ⚠️ 汇总公式把 skip 计入 pass（C-04），任何只看"失败 0"的消费方会高估覆盖范围。

**未跑的部分（诚实标注）**：ESLint（`npm run lint`，含 warning 棘轮 161）、renderer `typecheck` / `build`、服务端测试 —— 本轮只跑了桌面端 `run-all.mjs`，未在 CI 上复核其历史绿红。

---

## §6 主流自检表填值（角度 C 范围）

> 只填角度 C 范围内、且本轮**实测或可判定**的行；未核的一律标 ❓，不臆测。编号对应 P0 简报 §2 的 C-01～C-69（**与本文件 §2 的发现编号 C-xx 无关**）。

| 自检编号 | 检查项 | 结论 | 依据（命令 / 判据） |
|---|---|---|---|
| 自检 C-40 | 每工具有显式风险分级（≥3 档）且被审批/沙箱真实读取 | **✅** | 实测 43/10/10 三表，逐工具比对表值 === 实际值（§4.1）· 判据 7.1 |
| 自检 C-41 | 审批与沙箱正交，二者独立生效 | **✅** | `approvalPolicy.js` 的 `stricterApproval` / `stricterSandbox` 为两把独立取严钳 · 判据 7.2 |
| 自检 C-42 | 沙箱不可用 fail-closed | **✅** | 提交 `2f9ece4`：真探测 + TTL 60s 缓存；`git merge-base --is-ancestor 2f9ece4 HEAD` → YES · 判据 7.3 |
| 自检 C-43 | 能力交集为空即拒绝 | **✅** | 角色子集空交集 → `allTools = []`（HEAD 即已如此，非工作区新增）· 判据 7.4 |
| 自检 C-44 | 工具/能力开关缺省为最严格侧 | **❌** | `toolLevel()` 兜底 `\|\| 'L2'`，未知工具 → L2（实测）· 判据 7.5 → **发现 C-02** |
| 自检 C-45 | 进程内回退/旁路路径同样被钳制 | **✅** | 引擎 in-process 与 subprocess 两条路径共用同一 `engineParams` 钳制结果 · 判据 7.6 |
| 自检 C-46 | 出站默认拒绝 + allowlist，覆盖 IPv6 与 link-local | **⚠️ 部分** | 团队点名的 `169.254.169.254` / `fd00:ec2::254` **均被拦**；但 5 种写法可绕过（实测表）· 判据 7.7 → **发现 C-06** |
| 自检 C-47 | URL 类工具 resolve-then-validate | **❌** | 纯词法判定，无 DNS resolve；内网域名与 DNS rebinding 不可拦 · 判据 7.8 → **发现 C-07** |
| 自检 C-48 | 每次工具调用落结构化审计记录、不可被改写 | **❓ 未核** | `audit/auditLog.js` 存在，是否"不可被 agent 改写"未验证 · 判据 7.10 |
| 自检 C-49 | 读文件 / 联网 / 写代码 不三者同时全开（2-of-3） | **⚠️ 部分** | 默认工具集三者全开（`read_file` + `web_fetch` + `write_file`/`shell`/`code_exec` 同在 `BASE_TOOLS`）；**但有收窄机制**（角色子集 `toolNames`、capability 门、`planMode` 只读白名单）。判据 7.11 的"默认 2-of-3"严格形态在编码 agent 上不现实，主流做法是靠审批档与角色子集分层收窄，故判"部分"而非"偏离" |
| 自检 C-50 | append-only 事件链，可从任意事件点重建状态 | **⚠️ 部分** | `task_events`（v12，自增主键）与 `runTrace` JSONL 是 append-only；但 **v12 未提交**（发现 C-01），且未验证"可从任意事件点重建" · 判据 8.1 |
| 自检 C-53 | 不可逆副作用的幂等键由 `run_id`+`step_id` 派生 | **❓ 未核** | 未找到实现，未穷尽检索 · 判据 8.4 |
| 自检 C-54 | 持久化有落盘后端 | **✅** | SQLite（`better-sqlite3`）+ `journal_mode=WAL` · 判据 8.5 |
| 自检 C-55 | 检查点存储增长有上界策略 | **⚠️ 部分** | 迁移前快照 `snapshotBeforeMigrate` 会留 `.pre-v{N}.bak`（**无清理策略**）；`runTrace.evictOldTraces()` 有 LRU 淘汰。前者无上界说明 · 判据 8.6 |
| 自检 C-56 | session / harness / sandbox 可独立失败与替换 | **✅** | 见角度 A §6.1（harness 子进程 `engineExited` 收敛；角度 C 复核确认）· 判据 8.7 |
| 自检 C-59 | 离线 eval 集存在且**真跑进 CI**并在回归时阻断 | **✅** | `GATES` 含 `eval:check`；CI 跑 `npm test`（= `run-all.mjs`）· 判据 9.5 |
| 自检 C-64 | trace 携带跨层关联 id（run / workflow / conversation） | **✅** | `runId` 贯通 trace / 审批 / 子进程 / 记忆归档（`agentRunner` 全链路）· 判据 9.10 |
| 自检 C-68 | 能力扩展必须过逐项全覆盖登记门禁 | **✅**（含角度 A 的 A-03 盲区） | 矩阵 143/143；但条件注册（team_*）存在盲区，见角度 A §6.1 · 判据 10.5 |
| 自检 C-69 | 声称能力与守护不变量一一对应 | **⚠️ 部分** | 死桥接 22 个（发现 C-05）+ `toolLevel` 兜底（发现 C-02）· 判据 10.6 |

> **未填的行**（自检 C-57 / C-58 / C-60～C-63 / C-65～C-67）：属可观测与评估（OTel 属性、`gen_ai.*`、judge 校准、`pass^k`）、或治理/架构收益论证，**不在角度 C 范围内**，留白不臆测。

---

## §7 遗留问题与未知区（本轮未验证 / 不敢下结论）

1. **幂等键（判据 8.4）**：未找到从 `run_id`+`step_id` 派生的幂等键实现，但**不敢断言"无"**——未穷尽检索 `orchestrator/` 与 `workerPool.js` 的重试路径。标 ❓ 未核。
2. **"v63" 的来源**：主理人派单写「R7 时 v63」，实测 HEAD=7 / 工作区=12，**未见 63**。不代为裁定，请主理人复核。
3. **ESLint `max-lines` 对 `main.js` / `computerUse.js` 的实际生效状态**（§4.6 张力点）：未验证，标 ❓ 未核。
4. **CI 历史绿红**：本轮只跑本机，未查 GitHub Actions 历史，不作结论。
5. **i18n 硬编码文案的实际数量**：`scripts/i18n-scan.mjs` 需显式传路径参数，本轮未构造出有效调用，故**未给出硬编码条数**；只确认了"无自动触发方"（C-03）。
6. **`collab*` 是否有非渲染层消费者**：删除前需确认（DC-02），本轮未核。
7. **主流性判断**：除判据 7.5（C-02 直接反例）、9.5（C-03 同构要求）、10.6（C-05）外，本角度未引用任何"是否主流"结论；持久化两派之争（快照 vs 重放）按基线要求**未强推单一派**——MJCode 现状是快照派（迁移前快照 + `user_version`），并已具备 append-only 的 `task_events` 与 `runTrace`，属"混合"，不作偏离判定。

---

## §8 交付台账

| 项 | 值 |
|---|---|
| 审查角度 | C —— 安全、持久化与交付层 |
| HEAD 锚点 | `24acc1531f55d70d8f591f0435d48eb114fbf3d0` |
| 默认口径 | 工作区（99 项改动） |
| 发现条数 | **7**（C-01 ～ C-07）：P1 × 1（C-01）、P2 × 5（C-02/C-03/C-05/C-06/C-07）、P3 × 1（C-04） |
| 决策点数 | **4**（DC-01 ～ DC-04） |
| 门禁实测 | **246 项全绿 / 0 红 / EXIT=0**；其中 3 条本机未执行但被计入通过 |
| 自检表填值 | 角度 C 范围内 **18 行**：✅ 9 / ⚠️ 4 / ❌ 3 / ❓ 2 |
| 正面结论 | 审批三表零死条目（表≠实际 = 0，落兜底 = 0，三对交集全空）；Linux 沙箱 fail-closed 已合入 HEAD；`project_path` v7 已落地；`computer_use` 三重边界（用户开关 + 平台 + `allowedApps` 白名单）齐备 |
| 编号说明 | §2 的 C-xx = **角度 C 发现编号**；§6 的「自检 C-nn」= **P0 简报 §2 自检表编号**。两套重名但无关 |
| 改动代码 | **无**（落盘仅限本文件；未写 `.wiki-creator/`） |
