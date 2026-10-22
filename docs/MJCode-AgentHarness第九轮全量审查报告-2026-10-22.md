# MJCode 第九轮全量审查报告 · 2026-10-22

> **本轮定位**：第八轮（37 条，已全部销账）之后的**增量审查**。对象不是重审旧账，
> 而是三批从未被任何一轮覆盖的新代码：① DS Bots 项目空间落地（T6 系列，10-22 上午）；
> ② 第 28~36 轮团队层真机修复（10-21）；③ HEAD 之后 4 个提交（Electron 45 / CI / 军团修复）。
>
> **审查方式**：主理人亲自取证（数据层接缝、调度接线、测试盲区、静态门禁现算）
> \+ 三角色并行审查（A 执行与能力层 / B 编排与认知层 / C 安全与交付层；D 测试与文档层
> 因 429 失败，其范围由主理人补跑覆盖）。**所有成员结论均经主理人亲自复读代码复核后才上账**，
> 复核中修正 1 条定级（C-01 由 P1 降 P2）。
>
> **取证时点**：2026-10-22 11:00–12:30 GMT+8。**工作区全程存在活跃写入**
> （`orchestrator/invoke.js`、双语 `teams.json`、`team-stream.test.mjs` 等在 11:04 前 30 分钟内被改；
> 工作区由 07:15 的 54 文件 / +3283 增至 11:00 的 106 文件 / +9928）。
> 因此**本轮未跑全量终局门禁**，所有「当前状态」结论均带读取时点；
> §2 是时点内单独运行的静态/单套件门禁读数，**不存在「总计 N / 通过 N」的本轮汇总**。

---

## 0. 执行摘要（结论先行）

**一句话：DS Bots 落地的工程质量（注释密度、fail-closed 方向、事务与补偿、测试具体度）显著高于团队层首版；但抓出 5 条 P1，且全部是「同一旧病的新发作」——最重的一条意味着 DS Bots 的核心场景（多成员围绕工件协作）在 Worker 侧根本不可用。**

5 条 P1：

| # | 一句话 | 病灶类型 |
| --- | --- | --- |
| **N-01** | 项目级「压缩策略」是端到端装饰品：Worker 侧 `getCompactPolicy` 无注入点、主通道 payload 无发送方、渲染层只写 meta | 配了不生效（同第八轮 B-01） |
| **N-02** | 工件乐观锁 CAS 是工件级粒度，多成员并行写**不同章节**必冲突；设计、实现、测试三方同流假设「单写入序列」 | 场景假设与卖点矛盾 |
| **N-03** | 「断点续跑」开关关闭 ⇒ 项目完全无法派发：`resumeMinTokens = totalLimit + 1` 被 `beforeDispatch`/`state` 复用为派发门限；且缺陷形态**已被两条测试固化为预期**（修复会被自己的测试拦下） | 一个字段两种语义 + 测试固化缺陷 |
| **N-04** | `artifact_patch_section` 的「始终允许」规则永不生效：`approvalTarget` 无该工具分支 ⇒ 空 pattern ⇒ `matchPattern` 恒 false | 登记了以为生效（同 TOOL_LEVEL 死条目） |
| **N-05** | Worker 通道未注入 `artifactContext`：artifact 工具 handler 注册了、审批降级做了，唯独引擎侧 schema/prompt 没给 ⇒ **成员看不到工件工具** | 同一能力多处装配点只配一次（同 D-805/B-01） |

**结构性观察**：5 条 P1 里 4 条是「接线只配一半」，1 条是「验证器照不到的地方一致地错」。
门禁全绿、375 条新断言全绿，与 5 条 P1 并存——**本轮最值得记的一句话：绿的门禁证明的是「已想到的被守住」，证明不了「没想到的存在」**。

另：**reviewer-d（测试与文档层）因 429 频率限制失败**（13m54s），其范围由主理人补跑覆盖（§4.1）。

---

## 1. 审查范围与口径

### 1.1 审查对象

| 批次 | 内容 | 规模 | 既往覆盖 |
| --- | --- | --- | --- |
| S1 | DS Bots 项目空间落地 | 约 20 个新文件 + `db/index.js` 迁移 v14 + 渲染层 3 新组件 + 9 个 i18n 包 + 12 个新测试 | **从未** |
| S2 | 第 28~36 轮团队层真机修复 | 主进程 10+ 文件 + 渲染层 8 文件 + 测试 12 文件 | **从未** |
| S3 | HEAD 之后 4 个提交 | Electron 45 / CI sql.js / CI 结论 / 军团修复 | **从未** |

基线：HEAD `ec5618a`（2026-10-21 17:51）。第八轮基线 `9de20ca`，其间 24 个提交
（第八轮自身收口 16 个已销账，不重审）。

### 1.2 本轮冻结的判据集合

1. **接线闭合**：字段跨 ≥3 层必须每个装配点都接上；「配了不读」按缺陷计。
2. **场景一致性**：实现的并发/串行假设必须与产品卖点一致（DS Bots 卖点 = 多成员并行）。
3. **fail-closed 方向**：兜底不得落在「允许」侧；已声明的 fail-open 须显式记录。
4. **测试真断言**：守护必须能在「实现被改坏」时变红；测试顺应实现缺陷的按盲区计。
5. **门禁现算**：报数字前实际运行对应门禁或复算脚本，附算式。
6. **来源标签**：`[新代码]` / `[存量]` / `[判据移动]` / `[环境]`。

---

## 2. 现算门禁面（时点 2026-10-22 11:15–12:00）

| 门禁 | 读数 | 备注 |
| --- | --- | --- |
| `bridge-parity` | 7/7，桥面 **240** / 引用 **187** / 死 **53** | 未提交台账写 229/49 ⇒ 漂移，见 N-22 |
| `ui-conventions` | 13/13，裸 `<button>` **255/255**（117 文件 / 69 TSX） | README 会话总结写 256 ⇒ 差 1，见 N-22 |
| `i18n` / `i18n-keys` | 7/7 / 2/2 | `projectSpace.json` 双语各 **108** key 零差异 |
| `max-lines` | 3/3，>800 基线 3 个 | 新文件最大 `artifactStore.js` raw 549 |
| `docs-consistency` | 23/23，测试引用 51 = 基线 51 | `TOOL_CHANNELS` **61** 条与文档一致 |
| `tool-registration-matrix` | **162/162** | 含 artifact_* 四工具双向断言 |
| `untracked-deps` / `no-new-jsx` | 7/7 / 4/4 | 新文件全部入库、新组件全 .tsx |
| eslint（14 个新主进程文件） | **0 error / 0 warning** | — |
| 12 个新测试套件 | **375 条断言 / 0 失败** | 清单见 §4.1 |

> **「绿」的边界**：以上均为静态或单套件读数。全量 `run-all` 未跑（并发编辑期纪律）。
> 另注意 `project-e2e` / `artifact-tools` 虽全绿，但**没有一条断言覆盖 N-02/N-03 的场景**（见各条）。

---

## 3. 发现清单

### P1 · 5 条（全部经主理人复读代码坐实）

#### N-01 · 项目级「压缩策略」是端到端装饰品 `[新代码]`（成员 A-04 / B-03）

- **三段全断**：① Worker 侧 `workerPool.js` runOpts 的
  `compactPolicy: typeof deps.getCompactPolicy === 'function' ? deps.getCompactPolicy() : null`
  ——`getCompactPolicy` 在 `desktop/main/` 全目录**无任何注入点**（`initWorkerPool` 的 deps 里没有）⇒ 恒 null；
  ② 主对话侧 `agentRunner.js` 读 `payload.compactPolicy`，但**没有任何发送方**给它赋值
  （渲染层只把值存进 `project_spaces.meta_json`，无代码读回 run payload）；
  ③ 表单值经 `normalizeSpec` 的 `clampInt(payload.compactPolicy, [50,85], 70)` 落 meta 后无人消费。
- **唯一有测试的是第 ③ 段的夹紧值**——即「存储正确」被断言，「行为生效」没有。
- **后果**：用户配的 50–85% 完全不影响引擎；引擎恒用 `DEFAULT_COMPACT_POLICY`（0.7）。
- **修复**：`main.js` 注入 `getCompactPolicy: (group) => 按 thread_id 反查 meta`；主通道 payload 补发送方；
  守护按「数点位数」：主会话与 Worker 两条链路各一条端到端断言读引擎实收值。
- **置信度**：确定。

#### N-02 · 工件乐观锁 CAS 是工件级粒度，多成员并行写不同章节必冲突 `[新代码]`

- **事实**：`artifactStore.patchSection` 的冲突判据是 `base !== art.currentVersion`（工件级），
  章节自身版本只用于冲突时展示 diff。两成员基于同一 `currentVersion` 分写 `s1`/`s2`：
  先写者推进工件版本，后写者**必然** `VERSION_CONFLICT`。
- **三方同流**：设计稿 §9.2 明文「校验 `base_version === current_version`」（工件级）；实现忠实于设计；
  `project-e2e.test.js` 写 `s2` 时用 `p1.version`（先写者返回的新版本）⇒ **测试主动顺应了串行形态**。
  `artifact-tools.test.js` 的冲突用例也只测「同 base 重写**同一章节**」。
- **后果**：PRD 四人并行（产品写「目标」、后端写「接口」、设计写「界面」）稳定产生冲突
  ⇒ 模型自我修正重试 ⇒ 烧 token。冲突带 diff 所以不丢数据，但「正常并行被设计成冲突」。
- **修复**：CAS 改章节级（`base === 当前章节 version`，首写允许任意非空 base）；同步改设计稿与两处测试，
  新增「同 base 并行写两个章节均成功」守护。
- **置信度**：确定（读 `patchSection` 全文 + 设计稿 §9.2 + 两处测试调用）。

#### N-03 · 关闭「断点续跑」= 项目完全无法派发（字段语义跨模块撞车）`[新代码]`（成员 A-01）

- **事实**：`projectSpaceInit.normalizeSpec` 写
  `const resumeMinTokens = resumeEnabled ? 100_000 : totalLimit + 1`（注释自述意图：
  「使 resumeDecision 恒不成立」）；但同一字段被 `quotaLedger.beforeDispatch`
  （`const min = Math.max(b.resumeMinTokens, MIN_AVAILABLE); if (avail < min) return { allow:false }`）
  与 `state()`（同表达式判 suspended）**复用为派发门限**。
- **推演**：`resumeEnabled=false` ⇒ `resumeMinTokens = totalLimit + 1`；
  全新项目 `avail = totalLimit < totalLimit + 1` ⇒ **每个任务一入队即 quota_suspend、组永不收尾、
  徽标 0% 用量也显「暂停」**。开关在表单默认开、用户可关，路径可达。
- **测试盲区（双重，比缺陷本身更值得记）**：① **没有任何测试覆盖「关续跑后仍可派发」**——
  全 test 目录对 `resumeEnabled|resumeMinTokens|resume_min_tokens` 共 5 文件 10 处，唯一构造该开关的
  用例（`project-space.test.js`）只断言桶字段值等于 `3_000_001`，对 `gate.blocked`/`beginRun` 的
  派发行为零断言；② **缺陷形态被测试固化为预期**——同文件断言
  「关闭续跑后 resumeMinTokens = totalLimit + 1」，且文件头注释宣称这是设计。
  ⇒ **任何正确修复都会先被这条断言拦下，红的理由恰是测试在守护缺陷**（「顺应缺陷」的活标本）。
  另：`quota-gate.test.js` 场景 2/3 用「`resumeMinTokens(100000) > totalLimit(50000)`」这个
  不可能配置来模拟打满 ⇒ 修复时若给该字段加 `≤totalLimit` 夹紧（显然的修复方向），场景 2/3 翻红，
  红因是**手法依赖缺陷形态**（正确手法见 `project-e2e.test.js`：记真实消耗 190000）。
- **修复**：续跑开关只作用于 `resumeDecision`（独立 `auto_resume` 字段），不得抬高
  `beforeDispatch`/`state` 的派发门限；**同步重写上述两条断言**（否则修复被自己的测试拦下）；
  补「关续跑仍可派发」的行为守护；场景 2/3 改用真实消耗构造。
- **置信度**：确定。

#### N-04 · `artifact_patch_section` 的「始终允许」规则永不生效 `[新代码]`（成员 C-04）

- **事实**：`approval.js` 的 `approvalTarget(tool, args)` 有一长串分支
  （shell / install_plugin / browser_* / chrome_* / code_exec / clipboard / http_request / sqlite /
  sandbox_code_run / cua_action / computer_use / mcp__* / git_*），**没有 `artifact_patch_section` 分支**
  ⇒ 走末行 fallback `String(args.path || args.patch?.slice(0,80) || args.message || '')`，
  而该工具的 args 是 `artifactId/sectionKey/content/baseVersion` ⇒ **target 恒为空串**。
  又 `matchPattern` 对空 pattern 恒 false（`if (!p || p === '*') return false`）
  ⇒ 用户点「始终允许」后落库的规则**永不匹配**，后续仍逐次弹卡。
  `isRememberable` 不含该工具（`NON_REMEMBERABLE` 只有 4 个）⇒ UI **会显示**「始终允许」。
- **这正是 `approval.js` 自己在注释里定义并批评过的形态**（「表里的值永远不会被读到 →
  只制造『登记了以为生效』的错觉」）——第八轮清理了 `TOOL_LEVEL` 的死条目，
  但 `approvalTarget` 的工具分支遗漏是**同类病的新发作**：新增工具只登记了分级表。
- **方向安全性**：fail-closed（不会静默放行），所以不是安全问题；
  但「UI 显示规则存在却无效」是产品层面的失信。
- **修复**：`approvalTarget` 补 `artifact_patch_section` 分支（建议粒度 = `artifactId + ':' + sectionKey`）；
  加守护「每个 rememberable 工具的 approvalTarget 必须非空」。
- **置信度**：确定。

#### N-05 · Worker 通道未注入 `artifactContext`，成员看不到工件工具 `[新代码]`（成员 B-04）

- **事实**：`artifactContext` 在 `workerPool.js` **零命中**。注入点只有主对话通道
  （`agentRunner.js` 读 `payload.artifactContext`）与 `main.js` 的两处（`resolveArtifactContext(conversationId)`
  与 orchestrator 路径）。而 `agent-core` 的两处消费都要求 `artifactContext && !customTools`：
  引擎 schema 追加（`if (artifactContext && !customTools)` 处）与 base prompt 的 `ARTIFACT_PROMPT_SECTION`。
- **接了一半的直接证据**：`main.js` 的 `initWorkerPool` **确实注入了 `createArtifactToolHandlers`**
  （含 auto-safe 审批降级 + fail-closed deny，T6-6 注释齐全）⇒ handler 侧通了；
  但 runOpts 没有 `artifactContext` 键 ⇒ 引擎不追加 schema、不加提示段
  ⇒ **模型看不到这四个工具**（handler 注册了，模型不知道它们存在）。
- **后果**：DS Bots 的核心场景「多成员围绕同一工件协作」在 Worker 侧**完全不可用**——
  只有主对话能用工件。这比 N-02 更根本：N-02 是「能协作但会撞」，N-05 是「根本不知道能协作」。
- **修复**：workerPool runOpts 补 `artifactContext`（按 group.thread_id 反查项目，与主通道同源）；
  守护按「数点位数」：主通道与 Worker 通道各断言引擎实收的 tools 含 artifact_* 四工具。
- **置信度**：确定。

### P2 · 12 条

| # | 一句话 | 证据锚点 | 成员 |
| --- | --- | --- | --- |
| N-06 | 对话型旁路按 `MAX_TASKS=8` 静默截断：≥9 人「每人报数」只有前 8 人发言、组仍落 `done`（假 done 新形态） | `buildChatTasks` 无上限 + `normalizePresetTasks` `slice(0, MAX_TASKS)` | B-01 |
| N-07 | `buildTeamContext` 要求「任务数不得少于成员数」（可达 20）vs `validateDag`「≤8」⇒ >8 人团队在两条规则间必触雷 | 同文件同函数内自相矛盾，注释自称「不引入 LLM 重规划」 | B-02 |
| N-08 | 交互通道（项目主对话）不过配额闸也不记账：`quota_consumptions` 唯一写入方是 workerPool 的 `qrun`，agentRunner 零接线 ⇒ 桶少算真实支出 | agentRunner grep quota 0 命中（正样本 main.js 有） | A-02 |
| N-09 | 交互通道未接 T6-11：压缩摘要不落 `project_runs.summary_json`、四项装配不生效 ⇒ 纯交互项目跨天「上次摘要」恒空 | `saveRunSummary`/`collectProjectContext` 唯一调用点都在 `buildTaskPrompt`（Worker） | A-03 |
| N-10 | 90% 限流规则未落地：注释自称「调用方可拒绝 full_rewrite」，但 `full_rewrite` 全仓 0 代码命中；设计 §8.2 伪代码 `allow:false` vs 代码 `allow:true`——口径已静默放宽 | `beforeDispatch` 注释 + 设计稿 §8.2/§8.3 | A-05 |
| N-11 | 「用户手动追加额度」整条缺失：`quota_grant_events` 表 / `manual_grant` / 提额 IPC 均 0 命中；`updateBucket` 有白名单无暴露面 | 设计 §8.5/§2.1 列为 v1 必达 | A-06 |
| N-12 | 最后一轮 assistant 消息不过 `onMessage` ⇒ 组预算与项目配额系统性少计（最终轮 prompt_tokens 最大） | agent-core 只在 persistMessage 两处调 onMessage，缺助手分支 | B-05 |
| N-13 | `onUsage` 的 `qrun.note(n)` 无容错：`note→flush→recordRound` 直接写库，agent-core 侧不兜回调异常 ⇒ DB 失败冒泡成任务 failed（finally 的 settle 有 try/catch，note 侧没有） | workerPool onUsage 单行 | A-11 |
| N-14 | `chatOnly` 旁路旁路了技能索引化修复 ⇒ 成员技能全文进 system（12 技能 ≈ 127KB） | teamTrace 埋点自证；第八轮「技能索引化」的成果被旁路 | B-08 |
| N-15 | `TOOL_FAIL_STOP=6` 零测试覆盖：直接改变任务成败判据的行为闸门无任何断言（连「连续失败 N 次后收尾」都没有）。正样本自检：同文件导出的 `AGENT_HARD_ROUND_CAP` 有 `=== 120` 断言、`resolveCompactPolicy` 有夹紧行为断言 ⇒ test 目录可被 grep 到 agent-core 导出常量，零命中即真未覆盖 | test 全目录 0 命中 | B-09/T-04 |
| N-16 | 调试日志键名脱敏窄于姊妹模块 + deny-list 档约束面宽于 allowlist：① teamDebugLog 缺 `env`/`headers` 整体剔除（diagExport 有）；② denylist 是 `(allow default)`+黑名单，放开全盘 file-read 与 process-exec，且 `/tmp` 三目录在写白名单（macOS `/tmp` 全局可写、subpath 不解析 symlink） | 两模块注释互称「同口径」但键名集不同；探测只证明能跑 echo、不断言 deny 生效 | C-01/C-02（C-01 由 P1 降级，见 §4.3） |
| N-17 | `artifacts:versions` 无归属校验（index/section 有）+ `resolveArtifact` 对未知 artifactId 静默回落主工件（无越权但语义不诚实） | ipc/artifacts.js 与 artifactTools.js | C-03/A-13 |

### P3 · 清单式（18 条，不逐条展开）

| 成员 | 条目 |
| --- | --- |
| B-06 | 墙钟耗尽与 `quota_suspend` 并存时组永不收尾（可达性待验：需 setTimeout 恰在 suspend 之后触发） |
| A-07 | `project_runs.quota_state` 只写不读（读取方仅测试）；设计口径 `ok/throttled/suspended` vs 代码 `ok/warn/throttle/suspended` |
| A-08 | `breaker_state` 事件与 i18n `projectSpace.statusMemberSuspended` 无任何组件消费（死事件 + 死文案） |
| A-09 | 归档版本行查询不过滤：`_resolveAt`/`listVersions`/`getIndex` 三条 SQL 均无 `archived=0`，设计 §9.4 未落地 |
| A-10 | `quotaLedger.tick` 与 `resetReservations` 是生产死码（唯一调用方是测试），设计 §8.2 的 tick 落点被绕过 |
| A-12 | `orchestrator/invoke.js` `diffGroupEvents` 不投影 quota_suspend ⇒ 子代理进度树丢失暂停事件 |
| A-14 | `attachAssets` 的 thread UNIQUE 冲突未翻译成 `THREAD_TAKEN`（createProject 有翻译，两处不收敛） |
| A-16 | `getDiff` 对同一对版本算两遍 LCS（`diff` 与 `truncated` 各一次） |
| A-17 | 70% warn 一次性告警事件未实现（`state()` 算得出 warn，`markState` 从不广播） |
| A-18 | `tickAll` 内 `markState(g, projectOf(g), 'ok')` 二次反查若为 null 会 TypeError 中断本轮恢复（待验） |
| A-19 | 审批分级编号文稿错位：设计 §14「L1」vs 代码 L2（仓库口径 L2=可逆写入，符合意图，文稿编号相反） |
| B-10 | `onCompacted` 的 `droppedMessages`/`keptTailTokens` 被 workerPool/agentRunner 丢弃，宿主与调试日志无法还原压缩量 |
| B-11 | `resumeContext` 断点恢复不含项目四项（objective/summary/todo/index）⇒ 跨天恢复后目标锚定降级 |
| B-12 | `budgetInfoOf` 只映射 `skipped`，`quota_suspend` 任务的 token 不进预算展示 ⇒ 暂停越多「已用」越失真 |
| B-13 | `maxRounds` 默认 20 与 `tokenBudget` 回落 200000 两处默认值不同源，改一处忘另一处 |
| B-14 | `team_wait` 断点不记 token ⇒ 等待前后 token 断链，quota 账本出现无消耗空洞 |
| C-05 | `exportBundle` 注释承诺「内存环一并打包」但代码只打包落盘文件（无行为影响） |
| C-06 | 4 个 projects 写/读桥渲染层零调用却已在死方法台账标「决策过」——需补书面决策理由 |
| C-07 | `ci.yml` 注释陈旧（electron-builder 实际输出 zip/tar.7z/AppImage，注释写 dmg） |
| C-08 | `TeamDebugPanel` 有 1 个裸 `<input type=checkbox>`（255/255 内，但提前记账） |
| C-09 | `workspace.js` 含裸 NUL 字节（git 按二进制索引 ⇒ diff/review 工具不可见其变更） |
| N-20 | `project_runs` 无删除路径（`deleteProject` 不级联；`project_artifacts.project_id` 等无外键）⇒ 孤儿行 |
| N-21 | `roundsOf(taskId)` 全历史无 run 过滤：waiting 唤醒重派下同一 taskId 跨两段 run 累计 rounds，第二段 settle 补差被第一段吞掉（方向保守：多记账早熔断） |
| N-22 | **文档过期而非台账漂移**（本轮自我纠正）：`legacy-ledger.json` 工作区版实际已是 240/187/53，与我现算**逐字段一致**（`legacy-ledger.test.mjs` 20/20 PASS，含防恒绿三连自检）——我据旧快照误判为「漂移」，特此更正。真实问题是两处文档过期：① README 会话总结的「256」是 2026-10-21 中间态快照（链条 258→256→255 在门禁注释与台账 md 均有记录）；② `存量收纳台账.md` 第 4 节「下一轮目标」停留在 T5-10 口径，未纳入 DS Bots 的 projects 组 4 条 pending，且 2.1 的「待 T6-10 侧面板接 projectsGet 后下降」预测已被 T6-10 自述推翻（侧面板走 artifacts:* 新域，未接 projectsGet） | `legacy-ledger.test.mjs` 20/20 + `check.mjs` 76/76 + 台账 md 变更记录 |
| N-23 | 800 行软档拉锯：`workerPool.js` 919→798→791→799、`ipc/teams.js` 826→763→795→790 反复横跳 |
| N-24 | `TOOL_CHANNELS` 已从记忆中的 56 条增至 **61 条**（文档与源码一致，是我方记忆过期） |
| N-25 | `quotaGate.projectOf` 对 DB 异常 fail-open（已声明决策：判定失败 → 放行）；建议看板对「配额闸不可用」给可见提示 |

---

## 4. 成员审查状态与正面结论

### 4.1 成员状态（诚实交代）

| 成员 | 角度 | 状态 |
| --- | --- | --- |
| reviewer-a | 执行与能力层 + **补办 D 角度的 #7/#9** | **完成**（1 P1 / 5 P2 / 15 P3 + 7 项正面结论；#7 产出 T-01~T-07，其中 T-01「缺陷被测试固化」为本次最重要补充；#9 产出 L-01~L-06，含对我派工单数字的一处校正） |
| reviewer-b | 编排与认知层 | **报告已交付**（4 P1 / 4 P2 / 5 P3 + 6 项正面结论）；交付后因 429 在一次后续动作中失败，**报告内容有效** |
| reviewer-c | 安全与交付层 | **完成**（2 P1 / 3 P2 / 5 P3 + 6 项正面确认；其中 C-01 经复核降级） |
| reviewer-d | 测试与文档层 | **失败：429 频率限制**（13m54s 中断，未产出任何内容）。不重派（429 期内重派同样失败），其范围由主理人补跑覆盖 + reviewer-a 接办 #7/#9 补上 |

**D 角度覆盖**（reviewer-d 429 失败后由两路补上）：主理人补跑 12 个新测试套件
**375 条断言 / 0 失败**（project-e2e 29 / quota-gate 23 / artifact-store 60 / artifact-tools 36 /
quota-ledger 34 / project-space 41 / project-store 37 / project-space-schema 26 / project-context 23 /
task-quota-suspend 31 / member-breaker 24 / team-debug-log 11），断言形态抽验为**具体**
（字符闸截断长度相等、版本连续不跳号、conflict 三字段、终检无 failed）；
reviewer-a 接办 #7 后实跑 11 个 S2 套件（team-lead-dispatch 41 / team-dispatch-plan 29 /
team-stream 86 / workerPool 28 / group-budget 21 / sandbox 24 / dag 17 / bridge-parity 7 /
ui-conventions 13 / legacy-ledger 20 / check.mjs 76 全绿）并逐条做变异思维判定。

**本轮测试层的最大发现不是「绿」，是三条「认真地看着错误方向」**：
- N-02：`project-e2e` 写 s2 用 `p1.version`，**主动顺应串行形态**；全文无任何并行 patchSection 场景。
- N-03：`project-space.test.js` 把「关闭续跑后 resumeMinTokens = totalLimit + 1」**固化为预期断言**
  ⇒ 正确修复会被自己的测试拦下；`quota-gate` 场景 2/3 用「恢复下限 > 总额度」这个不可能配置
  模拟打满 ⇒ 加夹紧就翻红。**测试不仅没守护正确行为，还在主动抵抗修复。**
- N-15：`TOOL_FAIL_STOP=6` 这个改变成败判据的闸门零覆盖（正样本自检证明扫描有效）。

### 4.2 已覆盖未发现问题的面（正面结论，三角色合计）

1. **v14 迁移**：7 张表字段与设计 §4 逐项一致；两条 quota 索引与查询形态匹配；
   `IF NOT EXISTS` + 事务 + user_version 幂等路径与既有链一致。
2. **quota_suspend 状态机 14 处接线齐备**：TERMINAL 不含、`isGroupSettled` 计入（假终态防线成立）、
   `skipDependentsOf` 不从其级联、abort 两路径覆盖、teamStream 进度键与 TeamBoard 独立列/i18n/AgentDock 齐备。
3. **fail-closed 边界**：bucket 缺失 / total_limit=0 / NaN / 负数均落 suspended 侧；时钟回拨有 `effectiveNow` 单调锚定。
4. **预留生命周期**：grant→settle/release 在 finally 与装配期 catch 双路径闭环（含 waiting defer），未找到泄漏分支。
5. **工件层**：单事务三表 + 体积三闸（16k/64KB/2MB）+ 越权防护 + 回执不含正文 + artifact_ref 宿主统一写。
6. **假 done 主路径闭合**：关键/非关键失败均落 group failed、强制关闭 skipped 计入、
   空名册收敛为 failed、探活撤员重派经 store 仲裁不双写。
7. **DAG 契约**：fan-in ≤7 由 MAX_TASKS=8 自然给出；环/自依赖/悬空三类校验在位；MAX_TASKS 有测试钉住。
8. **双轨预算不冲突**：groupBudget 与 quotaLedger 各有明确定位与 clamp，`tokenBudget=min(组剩余, 授予额)` 正确。
9. **压缩策略夹紧非 fail-open**：`resolveCompactPolicy` 非法值回落默认且引擎侧消费路径正确（问题只在宿主注入，见 N-01）。
10. **调试面板无可利用面**：OpenDir/Export 不接收渲染层路径（IPC handler 无路径入参）；carve-out 与 allowlist 同集、
    protectedPaths 顺序正确；execFallback fail-closed 已读证。
11. **artifact 写操作审批 fail-closed**：无审批通道即拒 `APPROVAL_UNAVAILABLE`（Worker 侧 auto-safe + deny）。
12. **Electron 45 兼容**：sandbox 开、contextIsolation 开、nodeIntegration 关、protocol 注册兼容、
    双驱动金丝雀未 import 原生模块、`LSMinimumSystemVersion=13.0` 在四处（README/electron-builder/entitlements/plist）声明一致。

### 4.3 复核修正记录（成员结论 → 上账定级）

- **C-01 由 P1 降为 P2（并入 N-16）**：成员判「值形态窄于姊妹模块」，复核发现
  `teamDebugLog` 与 `diagExport` 的 `SECRET_SCAN_RE` **逐字节相同**（同为 sk-/Bearer/ghp_/AKIA 四种），
  值形态不是独有缺陷；真实差异是**键名集合**窄于 diagExport（缺 `env`/`headers` 整体剔除），
  且实际漏网需要「键名无敏感词 + 值无四种已知前缀」的小概率组合。
  「同口径」注释只声明了 `SECRET_SCAN_RE` 同口径（这一点属实），并未声明键名集合同口径 ⇒ 注释未撒谎，但覆盖面差异真实存在。
- **N-21 升级证据**：成员补充 waiting 唤醒路径（`waiting→queued→running→beginRun` 重新 grant）下
  同一 taskId 跨两段 run 累计 rounds ⇒ 不是「taskId 复用」的边缘场景，而是**正常等待唤醒就会触发**。
- **N-05 精化**：成员报「artifactContext 未下发」，主理人复读发现 `initWorkerPool` **已注入**
  `createArtifactToolHandlers`（含审批降级）⇒ 定性从「完全没接」修正为「handler 侧通了、引擎侧没给」，
  这反而是更典型的「多处装配点只配一次」。
- **N-22 自我纠正（我据旧快照报错，成员现算校正）**：我在派工与报告初稿写「未提交台账 229/49 与现算 240/53 漂移」，
  reviewer-a 现算发现工作区 JSON 实际已是 **240/187/53 且与现算逐字段一致**（`legacy-ledger.test.mjs` 20/20），
  229/49 是台账 md 变更记录里的 2026-10-21 历史行 ⇒ **「漂移」不成立，真实问题是两处文档过期**。
  教训同源：引用数字必须现算，不能引用「上次看到的快照」——包括引用我自己几小时前写的派工单。

### 4.4 未覆盖范围（本轮诚实边界）

- `orchestrator/invoke.js` 在 11:04 前 30 分钟内被改，其**改动内容本身**未纳入判据。
- 渲染层 `ArtifactPanel.tsx` / `ProjectCreateModal.tsx` 交互细节（键盘/焦点/加载态/错误分支）只抽读提交路径。
- 全量 `run-all` 未跑 ⇒ 不存在本轮「总计/通过/失败」汇总读数。
- `ipc/projects.js` / `teamStore.js` / `workspace.js` / `agent-core/index.js` 未做全文件审查（只读了与配额/工件/暂停态接线相关函数）。
- sql.js 驱动的实际运行行为（事务语义、错误消息形态对 UNIQUE 翻译的影响）未实测。

---

## 5. 与第八轮的对照

| 类别 | 条数 | 说明 |
| --- | --- | --- |
| 第八轮已销账项的**回归** | 0 | 抽查 D-808（成员运行时配置）、B-02（组预算）、C-04（汇总口径）未发现回退 |
| 全新代码首次审查 | P1×5 + P2×12 + P3×18 | 全部带来源标签 |
| 「同一旧病新发作」 | **5** | N-01/N-05（接线只配一半，同 D-805/B-01）、N-04（登记了以为生效，同 TOOL_LEVEL 死条目）、N-14（修复被旁路）、N-03（一个字段两种语义） |
| 判据移动 / 文档过期 | 3 | N-22（README 旧快照 + 存量台账 T5-10 口径过期；JSON 台账本身已同步，我据旧快照误判为漂移并自我纠正）、N-24 通道数 56→61、N-23 行数拉锯 |

**收敛判据（按第八轮定下的纪律，不看发现总数）**：本轮新代码首审缺陷率
= P1+P2 共 17 条 / 3 个批次——低于团队层首轮（第八轮 B 角度 20 条中过半是接线类），
且**工程质量指标（事务、补偿、fail-closed、测试具体度）全面向好**。
真正需要警惕的不是数量，是**类型集中度**：5 条 P1 里 4 条是「只配一半」，
说明这个团队的失效模式已经从「写错」转成「接漏」——而接漏正是门禁（绿着的那些）最照不到的地方。

---

## 6. 建议处置次序

1. **先落库再修**：106 文件在途 + 设计文档在库外（N-03 快照轮记录的同根因第五次），
   任何修复都叠加在流动的沙地上。按本仓纪律（门禁跨切面 ⇒ 只能整体提交），
   先整体提交 + 设计文档移入 `docs/`。
2. **N-05 优先修**（DS Bots 核心场景在 Worker 侧不可用，一行注入 + 两条守护），
   其次 N-03（关开关即全项目瘫痪，字段拆分 + 一条守护）、N-04（用户可见失信，一个分支 + 一条守护）。
3. **N-02 先改设计再改码**：CAS 粒度是设计明文规定的，直接改码会造成「代码与设计稿打架」；
   正确次序是设计稿 §9.2 先改，实现与测试跟随。
4. **N-03 修复前必须先重写测试**：`project-space.test.js` 已把「关闭续跑后 resumeMinTokens = totalLimit + 1」
   固化为断言，`quota-gate.test.js` 场景 2/3 依赖「恢复下限 > 总额度」这个不可能配置构造 suspended 态。
   **不先动这两条，任何正确修复都会被自己的测试拦下**（红的原因是测试在守护缺陷）——
   这是本轮唯一一条「修复次序错误会导致修不下去」的项。
5. **N-01 与 N-08/N-09 合并做**：三条都是「交互通道 / Worker 通道的注入缺失」，
   一次性把 `main.js` 的注入点（getCompactPolicy / artifactContext / 交互侧 quota+summary）补齐，
   并统一按「数点位数」补守护。
6. **N-06/N-07 一起修**：两条是同一处自相矛盾（成员数 vs MAX_TASKS）的两个面向，
   修法都是把「成员参与要求」从数字要求改成结构要求。
7. **N-12/N-13/N-15 随下一批带走**：记账口径、容错、行为闸门测试，无用户强感知但都会变成暗债。
8. **N-22 文档过期随提交带走**：README 会话快照注明时点、存量台账.md 第 4 节补 projects 组排期。

---

## 7. 产品定位与功能边界专题审查（主理人追加，2026-10-22）

> 审查缘起（主理人原话）：「首先作为一个 agent harness 的产品，具备绝大多数 agent 产品的能力以及和
> codex（非云端版本）看齐的能力，同时融入了三层记忆系统（workbuddy 记忆）、自动编排任务，以及
> MJ bot（参考 DS bot 插件）的能力。其中帮我审查这些新增加的功能是否逻辑正确以及功能实现正确，
> 另外也要保证自动编排下的执行任务和 MJ bot 的能力区分开——**现在这个感觉有点太像了**。」

### 7.1 结论先行

1. **「太像」的感知是真实的，但错位在入口与呈现层，不在能力层。**
   两条链路在**能力层已实质分离**（§7.2 边界表）：自动编排的 Worker 是无归属、无人格、无团队工具的
   「公共执行体」；军团成员有人格、per-bot 模型/技能/治理、`team_*` 五件协同工具、团队层记忆
   （共享 ∪ 私有）、预算三键与探活撤员。**但入口层与呈现层没有分离**：两者都是「对话输入目标 →
   拆多任务 → 并行 → 汇总」，共用同一个发送按钮与右栏任务面板——用户看到的就是「太像」。
2. **产品定位成立，且三处超出 Codex 非云端版**：三层/四层记忆（Codex 无记忆，只有 AGENTS.md）、
   编制化军团（人格 + 团队记忆 + 预算治理，Codex 多 Agent 只有分解+通信+冲突解决）、
   项目空间工件协同（配额账本 + 工件 CAS，Codex 无对应物）。主体能力（沙箱/审批/AGENTS.md/MCP/
   Skills/子代理/非交互/hooks/多模态）**已看齐**（§7.5 对账表）。
3. **本专题新增 4 条发现（X-1～X-4）**：X-1（P1）入口未分流是「太像」的直接根因；
   X-2（P2）Worker 通用 systemPrompt 使「未配人格的成员」与「公共 Worker」同形；
   X-3（P2）任务面板对军团 run 零视觉标记；X-4（P2）对账出的两个真实缺口
   （prompt 生命周期 hook、自身不作为 MCP server 暴露）。

### 7.2 三条产品线的定位与边界

| 维度 | 单会话 Agent（交互） | 自动编排（大目标拆解） | MJ 军团（数字员工团队） |
| --- | --- | --- | --- |
| 产品语义 | 对话式协作，边说边做 | 无人值守任务流水线 | 有编制的数字员工协同 |
| 触发 | 默认发送 | `mj_auto_decompose` 开关 + `tasks:autoRun` / `orchestrate_task` | 选团队后发送 → `teams:dispatch`（`ipc/teams.js:541`） |
| 拆解 | 不拆（或 `planStep` 分步旁路） | LLM 拆 2~8 子任务 DAG，失败自动重规划 1 次 | 同左（共用 `orchestrator.planGoal`）+ `planWaves` 批次计划 + 编制快照 |
| 执行体 | 主会话 agent（人在环） | 公共 Worker（无人格、无归属） | 军团成员（`agent:{memberId}` 持久会话） |
| 人格 | rolePreset（专家预设） | **无** | 成员 `systemPrompt` → 引擎 `sysSections.role`（注入检测后） |
| 记忆注入 | session/project/global | 同左（`buildTaskPrompt` 传 `scopes`，D-806 修复） | 同左 **+ team 层**（`recallTeamMemories`，共享 ∪ 私有） |
| 工具面 | 全量 | 全量（**N-05：artifactContext 未注入**） | 全量 + `team_*` 五件 + `rolePreset.toolNames` 交集裁剪 |
| 治理 | 交互审批 | auto-safe 地板 + 组预算快照 | per-bot 取更严 + 预算三键 + 探活撤员 |
| 呈现 | 对话流 | TaskSummaryPanel + SubtaskTree + AgentDock | TeamBoard + TeamRunStream + TeamSpace |

**架构事实**（`MEMORY.md` 已记载，本轮复读确认）：两条编排链路**共用**
`orchestrator.planGoal → workerPool.runGroup` DAG 底座，`ipc/teams.js:539` 注释自认
「与 autoOrchestrate 同型」。这是**上下层关系而非重复建设**——军团是「给流水线装上编制」，
不应拆成两套引擎。区分度必须做在**入口、执行体配置、呈现**三层，而不是底座。

### 7.3 「太像」的结构性根因（四层溯源）

| 层 | 现状（代码位置） | 问题 |
| --- | --- | --- |
| 入口层 | `ChatArea.jsx:451-458`：`if (!activeTeam || opts) { send(...); return; }` —— 选团队与不选团队**走同一个 `onSend`**，只差一个 activeTeam 快照 chip | 发送按钮不区分「派活」与「自动编排」，用户动作无差异感 |
| 执行体层 | `workerPool.js:421-425`：Worker 首条 system 是**同一句通用串**（「你是 MJ Coder 的并行任务 Worker……」），军团人格靠 `applyMemberRuntimeConfig` 事后补 `rolePreset` | 未配人格的成员与公共 Worker 在 system 首条**同形**；「这个人是谁」在第一句话里看不出来 |
| 呈现层 | `TaskSummaryPanel.tsx:66-68` 只按 `thread_id / cwd` 过滤 group，**不区分军团 run 与普通 group**；AgentDock 同理 | 右栏任务列表里，军团任务与自动编排任务长得一模一样 |
| 产物层 | 两者都落 `task_groups`（run_id = groupId 是「run 属于哪个团队」的唯一事实来源，`ipc/teams.js:651` 注释） | 数据模型是干净的（不新增 group 列是有意设计），但**呈现层没有把 team 归属讲出来** |

**已正确分离的边界**（防止「修复把对的也改坏」）：
`ChatArea.jsx:451` 注释明确「`opts.planStep` 三参调用 → 仍走普通 send（分步是既有编排，不走军团）」——
分步编排与军团的边界代码已存在且正确；`autoOrchestrate`（`orchestrator/index.js:241`）
签名无 teamId，纯自动编排路径不携带任何编制语义。这两条是本专题的**正面结论**。

### 7.4 区分方案（按层，标注成本）

1. **入口层（X-1，P1）**：Composer 的 activeTeam chip 从「可选提示」升级为**模式开关**——
   选中团队后发送按钮语义变为「派活」（可改文案/图标），并允许一键切回普通模式；
   与 `opts.planStep` 的旁路逻辑合并成一个显式的 `sendOrDispatch` 分流点（顺带闭掉快照 R-5 的归属口径问题）。
2. **执行体层（X-2，P2）**：`workerPool.js` 的通用 systemPrompt 后补一句条件段——
   有名册归属时追加「你是团队成员「{name}」」；零回归判据 = 非军团路径字节不变。
3. **呈现层（X-3，P2）**：TaskSummaryPanel / AgentDock 的 group 行增加「军团」徽标，
   数据来源用现成的 `teamStore.findTeamByRun(group_id)`（与 `buildTaskPrompt` 团队记忆反查同一条通道）。
4. **概念层（随下一批文档）**：三份文档统一名词——「单会话 Agent / 任务编排 / 数字军团」，
   技术设计文档 §3/S4 与军团设计文档 v1.5 各加一节「与另两条线的关系」，禁止「自动编排」与「军团派活」混称。

### 7.5 与 Codex 非云端版（CLI 开源版）能力对账

口径：Codex CLI（Rust 重写后，本地执行 + 沙箱 + 审批，**不含** ChatGPT 云端容器 / Web / IDE 云同步）：

| # | 能力 | Codex CLI | MJCode | 判定 |
| --- | --- | --- | --- | --- |
| 1 | 本地优先执行 | ✅ | ✅（Electron 桌面） | 看齐 |
| 2 | 交互 + 非交互双形态 | TUI + `codex exec` | GUI + `tasks:execute` + ScheduledTasks | 看齐（形态不同） |
| 3 | 审批分档 + OS 原生沙箱 | 三/四档 + Seatbelt / Landlock+seccomp | `approvalMode` + V04 沙箱（macOS denylist / Windows icacls / Linux bwrap+seccomp） | 看齐，MJCode 多「auto-safe 地板 + 组快照」 |
| 4 | AGENTS.md | 三级合并（全局/仓库/cwd） | 单文件 + **提示注入检测**（Codex 无） | 看齐且超（合并策略是差距，见下） |
| 5 | MCP | `mcp_servers` 配置 | 61 通道 + 协议版本双栈协商 | 看齐（R-10：最高支持 `2025-11-25`，落后一档） |
| 6 | Skills | `.codex/skills` | 内置技能 + 索引按需加载 | 看齐 |
| 7 | 子代理并行 | ✅ | `spawn_subagent` + SubtaskTree 事件透出 | 看齐 |
| 8 | 多 Agent 编排 | 分解 + agent 间通信 + 冲突解决 | autoOrchestrate + 军团（编制/人格/团队记忆/预算） | **看齐且超** |
| 9 | Hooks | user-prompt 等生命周期 | `toolHooks` pre/postToolUse | **部分**：缺 prompt 生命周期 hook（X-4） |
| 10 | 多模态输入 | 截图/图示 | 引擎 `image_url` 数据部件（`agent-core:1281-1294`） | 看齐 |
| 11 | 完成通知 | `--notify` | `notify` 工具（模型可调用，本地系统通知） | 看齐且超 |
| 12 | 团队共享配置 profile | ✅ | 团队级预算/治理档 | 部分（无导出/导入 profile 机制） |
| 13 | 自身作为 MCP server | `codex mcp` | 无（MJCode 是 MCP **消费方**） | **缺口**（X-4） |
| 14 | 记忆系统 | 无（仅 AGENTS.md + 会话历史） | session/project/global + **team** 四层，半衰期 + 提名制晋升 | **超出** |
| 15 | 项目空间/工件协同 | 无 | DS Bots 项目空间（配额账本 + 工件 CAS + 单 Bot 熔断） | **超出** |
| 16 | IDE 扩展面 | VS Code/Cursor/Windsurf 扩展 | 自身即桌面应用（另有 Tauri 端） | 形态差异，不计缺口 |

**对账结论**：16 项中 11 项看齐或超出、3 项部分、2 项真实缺口（X-4）。
「与 Codex 非云端版看齐」的产品目标**基本达成**；两个缺口都不阻塞发布，但应排进路线图。

### 7.6 本专题新增发现（X 系列）与处置状态

| # | 级别 | 发现 | 证据 | 处置 |
| --- | --- | --- | --- | --- |
| **X-1** | **P1** | 入口未分流：「选团队发送」与「自动编排发送」共用同一发送按钮，「太像」的直接根因 | `ChatArea.jsx:451-458`、`Composer.tsx:204-208` | **已修复**（10-22 当轮）：Composer 常驻派活目标条（团队名 + 成员数 + 预算 + 退出）+ 发送按钮语义切「派活」（文案 + 图标 + placeholder）；顺带闭 R-5（两处挂起发送汇入唯一分流点） |
| **X-2** | P2 | Worker 通用 systemPrompt：未配人格的成员与公共 Worker 在首条 system 同形 | `workerPool.js:421-425` | **已修复**：拆出 `main/workerIdentity.js`（800 行软档纪律「先拆再合入」），有名册归属时追加成员身份段；零回归判据 = 非军团路径字节不变（测试逐字锁死两条原文） |
| **X-3** | P2 | 任务面板对军团 run 零视觉标记（数据模型干净，呈现没讲出来） | `TaskSummaryPanel.tsx:66-68`、`AgentDock` | **已修复（TaskSummaryPanel）**：group 行加「军团」徽标，归属走既有 `teamsListThreadRuns` 桥面（零新 IPC）。**AgentDock 暂缓**：其模块级 shared-state 设计做按 thread 的团队反查需 N 次调用，且坞是瞬态面；已在快照 R-15 记明 |
| **X-4** | P2 | 对账缺口：无 prompt 生命周期 hook；自身不作为 MCP server 暴露 | `toolHooks.js` 只有 pre/postToolUse | 排路线图，不阻塞发布（快照 R-17） |

**修复落地清单（10-22 当轮，全部叠加在未提交工作区上）**：

| 文件 | 变更 | 行数纪律 |
| --- | --- | --- |
| `main/workerIdentity.js` | **新增**：成员身份段（`resolveOwnerMember` / `buildWorkerSystemPrompt` / `memberIdentitySuffix`） | 新文件 72 行 |
| `main/workerPool.js` | 改调拆分出的两个函数，删除 8 行内联字面量 | 798 → 798（净 0） |
| `renderer/src/hooks/useAgentRun.ts` | 接力点经 `relayRef?.current \|\| send` 分流；`relayRef` 追加在既有解构行尾 | 799 → 799（净 0） |
| `renderer/src/components/ChatArea.jsx` | `relayRef: sendOrDispatchRef` 注入 + latest-ref；pendingRun 改走 `sendOrDispatch` | 672 → 685 |
| `renderer/src/components/Composer.tsx` | 派活目标条 + 按钮语义切换 + placeholder 切换；`activeTeam` 退出徽标行判定 | 720 → 758 |
| `renderer/src/components/TaskSummaryPanel.tsx` | `teamsListThreadRuns` 归属查询 + 军团徽标 | 127 → 152 |
| i18n `composer.json` / `rightPane.json` | 双语各 +8 / +2 key | — |
| `test/worker-identity.test.mjs` | **新增** 13 断言（零回归字节判据 + 行为 + 接线） | — |
| `test/team-dispatch-entry.test.mjs` | **新增** 10 断言（四层分流 + i18n 双语行为断言） | — |
| `test/queued-message.test.mjs` | 接力断言升级为 `relayRef` 分流口径 | — |

**验证状态**：三个新/改套件全绿（worker-identity 13/13 · team-dispatch-entry 10/10 · queued-message 11/11）；
**全量 `npm test`：总计 280 · 通过 277 · 失败 0 · 跳过 3**（3 条为 Linux/macOS 沙箱平台跳过，本机 darwin 不执行）；
静态门禁复跑全绿（docs-consistency 23/23 · max-lines 3/3 · i18n 7/7 · ui-conventions 13/13 ·
doc-fact-check ✓ · layout-tokens 2/2 · untracked-deps ✓）；`tsc --noEmit` 0 错误；eslint 0 error。
**变异验证**（每个新断言点至少一条「预期为红」）：M1 抽掉身份段 → worker-identity 3 红；
M2 pendingRun 改回 `send` → 入口套件 ② 红；M3 接力改回 `send` → 入口套件 ③ + queued-message 双红；
全部恢复后复绿。

**修复过程中撞到并闭环的 5 条存量门禁红**（全部有据可查，非悄悄放过）：
① `doc-fact-check` 数字漂移（suites 273→275、mainJsModules 177→178）——我新增 2 测试 + 1 模块所致，
   已同步技术设计文档第 8 行基线表与第 82 行主进程模块 provenance（含新模块说明）；
② `layout-tokens` 间距半档——我的目标条 `py-1.5`、徽标 `px-1.5/py-0.5` 违反 P2-1 收敛决议（1.5→2 / 0.5→1），已取整；
   **同批发现存量一处**：`PlusMenu.jsx:552` 的 `py-1.5` 是在途改动引入的（HEAD 无此串），同决议一并修复；
③ `queue-tasks` / `thread-composer` 的两条「接力/挂起发送」源码形态断言命中我的新调用形式
   （`send` → `sendOrDispatch` / `relayRef?.current || send`）——**行为契约未变**（正常收尾才接力、
   挂起项就绪且空闲才发送），按意图放宽调用形式；过程中我自己还写错一次正则
   （`send\(OrDispatch\)?` 把分组括号写成字面量、thread-composer 的 `(?:` 未闭合），均已修正并复跑；
④ `untracked-deps`：新运行时依赖 `main/workerIdentity.js` 未入库（干净 clone 会断链）——按门禁修法
   `git add`（仅入索引，提交决策留给「先落库」整体批次）。

---

## 附录 · 复算命令

```bash
# 基线
git log -1 --format='%h %ad %s' --date=iso
git diff HEAD --shortstat

# 门禁现算（静态，安全于并发期跑）
cd desktop
node test/bridge-parity.test.mjs      # 桥面/引用/死方法
node test/ui-conventions.test.js      # 裸 button 基线
node test/i18n.test.mjs               # 双语 key
node test/max-lines.test.js           # 800/1500 两把尺
node test/docs-consistency.test.mjs   # 文档契约（TOOL_CHANNELS / 半衰期 / 51 引用）
node test/tool-registration-matrix.test.mjs   # 审批表与 handler 双向

# 新测试套件（单跑，不写业务库）
node test/project-e2e.test.js && node test/quota-gate.test.js

# 设计文档是否入库（每次交付 md 后必查）
git check-ignore -v "<文档路径>"; echo "exit=$?"
```

> ⚠ **macOS grep 陷阱（本轮踩到两次）**：BSD grep 的 BRE 里 `\|` **不是「或」**，
> `grep -n "a\|b" file` 会静默匹配字面量并返回空——「查不到」与「查法错」不可分辨。
> 判定「不存在」一律用 ripgrep 或先做正样本自检。
>
> ⚠ **本轮的元教训**：6 个静态门禁全绿 + 375 条新断言全绿，与 5 条 P1 并存。
> 绿证明的是「已想到的被守住」，证明不了「没想到的存在」——
> N-02（测试顺应缺陷）、N-03（只验字段值不验行为）、N-15（行为闸门零覆盖）
> 三条都是「测试很认真，但认真地看着错误的方向」。
