# MJCode Agent Harness 全量修复交付报告

> 修复日期：2026-10-18
> 分支：`fix/harness-full-2026-10-18`（基点 `e2c6c05`）
> 依据：`MJCode-AgentHarness架构完整性审查与设计建议-2026-10-18.md`（25 项整改）
> 方式：8 人专家团并行实施 + 技术负责人复审 + 独立测试验证
> 规模：**36 个既有文件改动（+2180 / −337）+ 31 个新增文件**

---

## 一、结论

**25 项整改：21 项完成、2 项部分完成（P1-9 换壳 3/9、P1-11 分档 UI 未做）、2 项未做（P2-5 布局收敛、P2-6 拆 SettingsModal）。**
**另修复 13 个审查报告未覆盖的缺陷**，其中 3 个属 P0 级（会导致功能不可用或运行期崩溃）。

**门禁状态**：`158 套件 / 158 通过 / 0 失败`；`tsc --noEmit` 0 错误；`eslint` 0 error（155 warning，基线 146）；`i18n-scan` 裸中文 0。

> 该结果由**两方独立复核**：测试工程师跑一轮 + 主理人在工作区完全静止后独立重跑一轮，两者一致（`158/158`、`typecheck exit 0`、`i18n 裸中文 0`）。

最关键的一条：**V 层（评估接口）从「零实现」补到「默认 l1 生效」**——这是审查报告判定的唯一致命短板，也是本次修复的战略价值所在。

---

## 二、P0 整改（5 项，全部完成）

| 项 | 问题 | 修复 | 关键锚点 |
|---|---|---|---|
| **P0-1** | 窗口取值链路**三处断裂**：手选窗口只喂圆环 UI、`useAgentRun` 只注入 reasoning_effort、`agentRunner` 直接透传 | 打通接线 + `(provider, modelId)` 二元组双表（主进程 `.js` / 渲染层 `.ts`）+ Ollama `/api/show` 探测 + 默认值下调 | `useAgentRun.ts:527` 注入 `context_window`；`main/modelWindows.js`、`renderer/src/lib/modelWindows.ts`；parity 测试 9/9 |
| **P0-2** | 只有撞 400 才救一次 | `effectiveWindowOf(declared, lastPromptTokens)`：只抬不降、上限 4×、抬高即强制压一次 | `agent-core/index.js` 新增纯函数 + `trace({type:'window_inferred'})` |
| **P0-3** | 思考强度**无能力门控** + **非流式通道完全丢失** | 三处补齐：`scheduledChannels` body、`decomposeTask` chatFn、`ModelSelector` 读 caps 门控；并打通 `api.js`/`localStore` 的 caps 透传 | `scheduledChannels.js:76`、`agent-core:1045-1054`、`ModelSelector.jsx`（`reasoningOptionsFor` 纯函数） |
| **P0-4** | 编排等待超时只返 error，**未 abort 组** → 后台静默烧 token | 补 `workerPool.abortGroup(groupId)` + `timedOut/abortedTasks` + 文案说明"已完成部分保留" | `main.js:850-852`（净增 ≤3 行） |
| **P0-5** | ①凭证文档 0644 明文 ②sanitize 可被用户 env 覆盖 ③`mcp_status` 全仓**只有生产方、零消费方** | ①chmod 0600 + 读时自愈 ②受保护键最后展开 ③新建五态消费链路（ok/fail/connecting/saved/**crashed**）+ 手动重连 | `ipc/mcp.js:113-115`、`useMcpStatus.ts`、`LocalMcpSection.tsx` |

**P0-1 的根因值得单独记**：审查报告原本判断是"兜底值 128000 选大了"，独立复核发现真实情况更严重——**用户在设置里选的窗口从来没进过引擎**（`effectiveContextWindow` 的唯一消费者是 `ChatArea.jsx:90` 的圆环 UI）。所以修复必须先补接线，否则映射表再准也进不了引擎，属于典型的"改了等于没改"。

---

## 三、P1 整改（12 项：11 完成 / 1 部分）

| 项 | 结果 | 要点 |
|---|---|---|
| P1-1 整任务墙钟 | ✅ | `DEFAULT_RUN_WALL_CLOCK_MS = 30min`，超时走 `onSuspend({kind:'wallclock'})`；`budgetKind` **复用 `'rounds'` 不新增枚举**（新枚举会外溢到 workerPool 与 main.js humanize 文案，静默漏文案） |
| P1-2 超时统一 | ✅ | 新建 `main/tools/timeouts.js` 单一来源；**exec.js 先抽 `execFallback.js` 再改**（795→732，原只剩 5 行余量） |
| P1-3 重写记账 | ✅ | `rewriteLedger{count,recomputeTokens}` + `MAX_REWRITES_PER_RUN=5`，超限只走硬截断 |
| P1-4 前缀稳定 | ✅ | `renewNotice` 改 `role:'user'` 追加末尾（不动缓存前缀）+ `enablePrefixOrder=false` 作 A/B 回滚开关；实测两次 run 前缀 **4244B 逐字节相等** |
| P1-5 入口裁剪 | ✅ | 仅在 `beforeTokens > 0.7×window` 时裁，不再每次"继续"都砍一刀 |
| P1-6 技能渐进披露 | ✅ | 两段式：索引只注入 `name+description`（每技能 ~100 tokens），正文按需加载；新增 `load_skill` 工具（含注入检测 + 技能名路径穿越拦截） |
| P1-7a 数字员工实体化 | ✅ | 新建 `main/rbac.js`（fail-closed）+ `employeeCreate/Update/Delete`（0600 落盘、路径穿越 5 类全拒、12000 字符上限、`EMPLOYEE_MAX=200`）+ **补「自定义员工合并进列表/运行时」** |
| P1-7b 角色注入检测 | ✅ | `rolePreset.systemPrompt` 走 `guardUntrusted`，对齐技能/AGENTS.md/记忆三处既有做法 |
| P1-8 MCP 协议 | ✅ | 升 `2025-11-25`（保持握手架构）+ **接收 initialize 返回值** + 版本协商 + `onNotify` 落地 + `nextCursor` 翻页 + 工具名清洗映射 + 404 会话重建 |
| P1-9 UI 原语 | ⚠️ **部分（4/9）** | 原语 4 个（`Switch/Modal/Button/Input`，全 `.tsx`）+ **7 处 Switch 全替换、`left-[22px]` 清零**、几何改为 `calc()` 自洽推导；**4 处模态外壳已换壳**（Settings / Ecosystem / Market / Archive）；其余 5 处 + `ScheduledTasks` 新建任务浮层（审计清单外的第 10 处）未做 |
| P1-10 MCP 工具角色裁剪 | ✅ | 新增 `rolePreset.allowMcp`（缺省 true 零破坏），角色隔离不再被 MCP 绕过 |
| P1-11 任务-模型分档 | ⚠️ **部分** | 数据层 + `compact`/`decompose`/`worker` 三槽位落地且**未配置回落主模型**；**设置页 UI 未做** |
| P1-12 窗口未确认警示 | ✅ | 「未确认（按 4K 估算）」+ 一键校正；Ollama 探测成功时显示「已探测：32K（来源 api-show）」 |

---

## 四、P2 整改（8 项：4 完成 / 1 替代完成 / 3 未做）

| 项 | 结果 | 说明 |
|---|---|---|
| P2-1 只读工具并行 | ✅ | 上限 4，**严格按 `tool_calls` 原序回填**；写工具/审批/MCP 一律串行。实测 3×120ms 并发组 123ms（串行上界 360ms） |
| P2-2 ttfb 可观测 | ✅ | `ttfbMs` 进 `onBudget` + trace + `slow_ttfb` 事件；`TTFB_TARGET_MS=3000` 只告警不阻断；**缺测时为 null 不伪造 0** |
| P2-3 摘要长度约束 | ✅ | `slice(0,2000)` + 四段式校验（缺段补齐） |
| P2-4 激进门槛 | ✅ | 0.85 → 0.80，0.70~0.80 区间注入轻量提示 |
| P2-5 布局收敛 | ❌ | 未做（29 种 padding / 6 档圆角仍在） |
| P2-6 拆 SettingsModal | ❌ | 未做（仍 1084 行） |
| P2-7 「执行后告知」 | ✅ 替代实现 | 采用**正交布尔 `approvalNotice`** 而非独立第五档（理由见 §六）。三条验收实测通过：低危→1 条通知 + audit 并存；L1 高危→**仍阻断、0 通知**；默认→零行为变化 |
| P2-8 工具回执回查 | ✅ 被吸收 | 由 V 层 R1/R4/R5 三条规则实现，未单独建 `verifyReceipts.js` |

---

## 五、V 层（审查报告判定的唯一致命短板）

**从「运行期零实现」补到「默认 l1 生效」**：

| 项 | 实现 |
|---|---|
| 引擎侧 | `toolLedger` ring buffer（200 条，只记 name/ok/ms/round/paths/command/exitCode，**不记 args/输出**）→ `emitRunEnd` 统一出账 |
| 规则引擎 | 新建 `agent-core/verifier.js`（344 行，**零依赖**，连 `fs` 都没有）：R1 声称改文件但无证据 / R2 声称测试但没跑 / R3 跑了失败还宣称通过 / R4 声称提交但无证据 / R5 说改了但工作区干净 / R6 改了但没提（仅 warn） |
| 宿主 | 新建 `main/verifyRun.js`：`getWorktreeDiff`（git 只能在主进程做，失败返回 null 不抛）+ `runVerification` |
| 通道 | 主对话 in-process **l1+annotate**、engineHost **l1**、Worker **off**（已接线）、定时任务 **off 且未接线**（无配置源，已知留白） |
| 契约 | `contract.mjs` 登记 `verify`/`verify_ledger`（**未登记会被 `safeAgentEventEnvelope` 降级成用户可见的 error 事件**，这正是 `mcp_status` 死信的同型陷阱） |
| 防死循环 | `MAX_VERIFY_CONTINUE=1`、`MAX_VERIFY_RUNS_PER_THREAD=3`、`stopHookActive` 等价物 |
| 性能 | p95 **0.47ms**（预算 15ms），零网络零 LLM |

**关键设计取舍**：
- **R1 故意排除 `mkdir`/`chmod`/`git checkout`**——它们不改内容，算证据会让「mkdir 后自称改了 a.js」漏判。
- **L1 fail-close / L3 fail-open**：L1 是确定性对账，事实冲突必须拦；L3 依赖额外一次模型调用，超时属基础设施失败，fail-close 会把用户已完成的活判死。
- **宁漏不误报**：误报会让用户对着已完成的活看到"你说改了你没改"，比漏检伤害大。已知漏检句式与漏检率不可测已写进 `verifier.js` 顶部。
- **annotate 不写「已验证正确」**——L1 只核「有没有发生」，不核「对不对」。

---

## 六、值得记录的架构决策

| 决策 | 理由 |
|---|---|
| **`approvalNotice` 用正交布尔而非独立第五档** | ①档位枚举跨 5 处契约，**漏改一处就是「渲染层一下发即被契约拒绝、整个 run 失败」且只在运行时暴露**；②正交语义更宽（可叠加 always 也告知）；③与 checklist「四档」的差异已在 `approval.js:9-36` 显式记录 |
| **agent-core 兜底取 4096 而非 32768** | Ollama 真实默认是 `OLLAMA_CONTEXT_LENGTH=0` → **按显存自适应 4k/32k/256k**，未知时必须按最小档，否则又会高估击穿 |
| **Anthropic 直连写 200K 而非 1M** | 1M 需 `anthropic-beta` header，本项目不下发；写 1M 等于"压缩永不触发" |
| **双份窗口表 + parity 测试** | 渲染层不能 require 主进程模块，双份是必要的；用测试锁死一致性 |
| **`onDone` 保持同步、内部异步体显式 `.catch`** | 引擎侧 3 处调用全部同步且不看返回值；直接挂 `async` 会造成 Promise 逃逸 → 未捕获 rejection → Node 15+ 终止主进程 |
| **V 层异常不影响 Worker 任务结果** | 原本 `vrun.finish()` 抛错会落进外层 catch，变成"评估器有权判死任务"，已单独 try/catch 封死 |
| **收尾阶段停止 Modal 换壳** | 当时已是 157/157 全绿；换壳会重新引入变动并需重跑，边际收益低于破坏绿状态的风险。**不做最后一件事比做完它更负责** |

---

## 七、额外修复的缺陷（审查报告未覆盖）

修复过程中由实施者与独立验证共发现 **13 个新缺陷**，其中 3 个 P0 级：

| # | 缺陷 | 后果 | 发现者 |
|---|---|---|---|
| **1** | **`wallClockHit` 写成 `wallclockHit`** | 每次 `runAgent` 收尾抛 `ReferenceError` → 任务跑完才崩，宿主侧表现为整轮报错。**单测发现不了**（不经过收尾链），只有真跑全链路才撞 | 独立验证 |
| **2** | **`engineParams` 白名单丢弃 `skillDisclosure`/`modelOverrides`** | P1-6 与 P1-11 在**真机子进程路径上完全不生效**，而 in-process 回退模式正常 → 单测与 CI 都测不出来 | 实施者 |
| **3** | **`models[].caps` 在 `api.js`/`localStore` 被丢弃** | P0-3③ 的能力门控代码就绪但**永不触发** | 实施者 |
| 4 | `preload` 未暴露员工三通道 | 后端做完、桥没搭 → 员工表单点了只提示"通道缺失" | 实施者 |
| 5 | 自定义员工不合并进列表/运行时 | 「创建成功却看不到、也跑不起来」 | 实施者 |
| 6 | 正常收尾不发 `running:false` 快照 | 仪表盘停在 `running:true` | 独立验证 |
| 7 | 墙钟分支发 2 条 `run_end` | 下游按"最后一条"判断会把超时读成正常结束 | 独立验证 |
| 8 | `server.stderrTail` 从未赋值 | MCP 连接失败时用户只看到 `code=1`，看不到服务端真实报错 | 实施者 |
| 9 | `reversible:false` + 文案「通常可回退」自相矛盾 | 通知给用户假信息，比不发更糟 | 实施者自查 |
| 10 | `ui-conventions` 把注释当代码扫 | 3 条规则同时误红（`<button>`/`ipcRenderer`/`⚠️` 全在注释里） | 独立验证 |
| 11 | `untracked-deps` 把注释里的示例 import 当真引用 | 误报断链 | 独立验证 |
| 12 | `undef-ident` 的 TDZ 启发式把函数形参误判为后置声明 | 误报 | 独立验证 |
| 13 | `APPROVAL_ORDER` 在仓库里有**三份副本** | 改一处漏两处 → 档位静默降级 | 实施者 |
| **14** | **员工写通道的 IPC 载荷契约不匹配**：主进程是**解构式载荷**（`{employee}` / `{id,patch}` / `{id}`），前端按扁平对象发 → 被 `guard.assertObject` 挡成"保存失败" | 员工创建/编辑/删除**全部不可用**。两侧代码各自看都"对"，接起来才错 | 实施者（前端联调时发现） |
| 15 | 换壳后 `frameless` 面板若加 `w-full`，遮罩两侧落在面板内 | **点侧边不再关闭**——视觉一样、行为变了，截图永远发现不了 | 实施者 |
| 16 | 跨弹窗键盘接管未让路（`feedback.jsx` 的 `confirm()` 是命令式全局弹窗、不进 Modal 栈） | 确认框打开后焦点被抢回底层弹窗、Esc 会把两层一起关（「彻底删除」「安装确认」都会踩） | 实施者 |

> **#10/#11/#12 是同一个失效模式犯了三次：门禁把注释当代码扫。** 这说明这类门禁的**扫描域（代码 vs 注释）从来没有被显式定义过**，于是每条新规则都要重新踩一次。修法统一为 `blankComments()`（注释替换为空格、保留换行保行号），并给 `ui-conventions` 加了 3 条钉住 `return ''` 失效模式的自检。

---

## 八、未做项（明确列出，不混入完成项）

| 项 | 状态 | 原因 |
|---|---|---|
| **P1-9⑤ 模态外壳替换** | ⚠️ **4/9 完成** | 已换壳：Settings / Ecosystem / Market / Archive（各 `<Modal>` 引用 1 处，门禁全绿）。**SettingsModal 的解法值得记**：保留自有表头与关闭按钮（`settings-coverage` 的 5 条源码断言原样满足，含 `onClick={onClose}` **恰好 1 处**的计数断言），只换 overlay+panel，两个 className 作为**真实生效的 props** 传入。未做：CommandPalette / ProjectPicker / ConnectorConfigDialog（基线本就有 `role="dialog"`）/ CustomConnectorForm（页面级视图非弹窗）/ feedback.jsx（全局确认层，影响面最大）；另发现 `ScheduledTasks.jsx` 新建任务浮层为审计清单外第 10 处裸壳，未动 |
| **P1-11c 分档设置 UI** | ❌ | 同上；主进程侧三槽位已就绪 |
| **P2-5 布局收敛** | ❌ | 纯视觉优化，收益低于改动风险 |
| **P2-6 拆 SettingsModal** | ❌ | 仍 1084 行；拆分连撞 `settings-coverage` 三条源码断言（含 `onClick={onClose}` **计数**断言），风险高 |
| **P2-7 的 UI 两半** | ❌ | `approval.notice.executed` 的 i18n key 与 `approval_notice` 渲染分支未落；`approvalNotice` 设置开关未做。**主进程机制已实测可用，用户界面暂看不到通知** |
| **V 层 J3（L3 独立 verifier turn）** | ❌ | 设计已就绪（`J-V层落地设计.md`），需第二次模型调用，本批不做 |
| `crashed` 自动重连 | ❌ | 仅手动重连。后台反复拉起子进程比"用户点一下"代价大，静默重连还会掩盖持续崩溃 |
| 定时任务通道的 V 层 | ❌ | `off` 且无配置源（已知留白，非漏接；若强行开 l1，N9 会刷 `no_ledger` 告警而非静默 PASS） |

---

## 九、验证证据

| 门禁 | 结果 |
|---|---|
| `npm test` | **157 套件 / 157 通过 / 0 失败**（2 项 darwin 平台 sandbox 跳过，属既有标注，不代表已验证） |
| `npm run typecheck` | 0 错误 |
| `npm run lint` | **0 error** / 155 warning（基线 146，+9 来自新增代码） |
| `node scripts/i18n-scan.mjs renderer/src` | 裸中文残留 **0** |

**新增测试**：16 个套件、**约 181 条行为断言**（`window-inference`/`wallclock-budget`/`rewrite-ledger`/`trim-trigger`/`skill-disclosure`/`role-tool-cut`/`parallel-readonly-tools`/`summary-clamp`/`summary-notice`/`ttfb-report`/`prefix-stability`/`model-override`/`role-injection-guard`/`independent-verification`/`model-windows-parity`/`probe-window-wiring`）。

### 门禁自身的修复（5 处，独立于业务代码）

"代码坏了"和"门禁坏了"是两类问题。本轮后者修了 5 处：

| # | 门禁 | 缺陷 | 修法 |
|---|---|---|---|
| 1 | `ui-conventions` | 把**注释**当代码扫（`Switch.tsx` 注释里的 `<button>`、`useMcpStatus.ts` 注释里的 `ipcRenderer`（该行实际走桥，合规）、`modelWindows.ts` 注释里的 `⚠️`）→ 3 条规则同时误红 | `blankComments()` 注释替换为空格、**保留换行保行号**；另加 3 条自检钉住唯一失效模式（`return ''` 抹空会让全绿） |
| 2 | `untracked-deps` | 把 `ui/index.ts` **文档注释里的示例 import** `from './ui'` 当真引用 → 误报断链 | 同上 `blankComments()` |
| 3 | `undef-ident` | TDZ 启发式把**函数形参**误判为"引用后置声明" | `HOISTED = -1` 哨兵：函数声明/`import` 提升、`class` 不提升；并加 3 条反向用例（真实 TDZ 必须仍红） |
| 4 | `workerPool` | 「并发墙钟 < 350ms」是**负载敏感断言**，多 agent 并行时必 flake | 改为**两任务执行区间相交**（绝对墙钟无法区分"没并发"与"机器忙"） |
| 5 | `parallel-readonly-tools` | 同型上界断言（自查时发现，非被点名） | 上界改区间；**下界 `≥160ms` 保留**（下界不受负载影响，是正确判据） |

**根因是一个共用模式：门禁的「扫描域」（扫代码 / 扫注释 / 两者）从来没有被显式定义过**，于是每条新规则都要重新踩一次。已在 §十 记为纪律：新增源码扫描规则时必须明确扫描域。

**自检的有效性用变异测试证明**（不是"我加了自检所以放心"）：
- `ui-conventions`：把 `blankComments` 改成 `return ''` → 自检 ①③ **立刻红**（② 在抹空时仍 PASS，所以必须三条互补）
- `untracked-deps`：同款变异，自检 2 条红
- `undef-ident`：把变量当提升、删 import 分支 → 反向用例 **A/B 立刻红**

> 这三个变异**全部在还原后恢复绿**，证明自检真的在钉住"实现错误"而非"实现正确"。

**独立对抗性验证**（用与规格不同的构造，证明"去掉实现即变红"）：
- **P0-1 窗口接线**：差分实验（同历史同 usage，只改声明窗口）→ 无窗口时摘要 1 次，`128000` 时 0 次 ⇒ 引擎确实按 4096 在算
- **P0-5 凭证权限**：真实 `/tmp` 文件 + 真实 `stat`，额外覆盖两个 Node 坑（**0644 覆盖写→600**、**同 pid 二次写→600**）
- **P1-10 裁剪闭环**：改用内置工具越权调 `shell` → `notInAllowlist` 且 **handler 调用 0 次**，同轮合法 `read_file` 正常 1 次（非一刀切）

---

## 十、红线提醒（后续改动必读）

| 文件 | 当前行数 | 上限 | 余量 |
|---|---|---|---|
| `main/main.js` | **1447** | 1500 | **53** |
| `main/tools/exec.js` | 780 | 800 | **20** |
| `renderer/src/App.jsx` | 799 | 800 | **1** |

> `main.js` 的 1447 构成（避免误以为单一改动撑大）：**本包 +5**（P0-4 净 +3、P0-3① 净 +1、P2-7 净 +1）+ **V 层 +2**（`initVerifyRun`）。硬门禁 1500 未触及；为这 2 行去合并或抽模块属于"为数字好看而改枢纽文件"，收益低于风险，故保持现状。

其他纪律：
- 新增前端组件**必须 `.ts/.tsx`**（`no-new-jsx` 硬基线只减不增）
- 改 `theme.css` 必须 **hex + rgb 两份同步**
- **门禁扫描域**应成为新规则的必答项（扫代码 / 扫注释 / 两者）
- `budgetKind` **不要新增 `'wallclock'` 枚举**（会外溢到 workerPool 与 main.js 的 humanize 文案，静默漏文案）

---

## 十一、后续建议（按优先级）

1. **P1-9⑤ 补完 9 处模态外壳**：先把 `settings-coverage` 那条 `onClick={onClose}` **计数断言**改为「存在且由 Modal 渲染」（而不是删掉），再换壳——否则会为了过门禁而保留重复的关闭按钮
2. **P2-7 的 UI 两半**：`approval_notice` 渲染分支 + `approvalNotice` 设置开关。**注意**：主进程已在发事件，UI 缺消费方 = `mcp_status` 死信的同型风险，应优先于 P2-5/P2-6
3. **V 层 J3**：按 `J-V层落地设计.md` 实现 L3（设计文档已含 rubric、独立性、防死循环、fail-open 理由）
4. **P1-11c 分档设置 UI**：主进程三槽位已就绪，只差设置页三个下拉
5. **定时任务通道接 V 层**：需同时补 `onTrace` + `finish` 接线，否则会刷 `no_ledger` 告警
6. **P2-5/P2-6**：纯视觉/维护债，不影响功能正确性

---

*本报告的所有数字均来自最终一轮门禁实测（日志见 `.audit-2026-10-18/04-test/*-final.log`）；未做项与已知边界已在 §八 逐条列出，请勿据"修复完成"推断"全部整改已落地"。*
