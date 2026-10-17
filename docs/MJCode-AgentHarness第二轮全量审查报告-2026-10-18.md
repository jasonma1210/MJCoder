# MJCode Agent Harness 第二轮全量审查报告

> 审查日期：2026-10-18
> 对象：分支 `fix/harness-full-2026-10-18`（HEAD `faadf9b`，基点 `e2c6c05`，81 文件 +8286/−390）
> 方式：五路并行只读审计（引擎 / 主进程 / 渲染层 / 契约+V层 / 测试与门禁）+ 主理人对全部 P1 的独立读码复核
> 方法差异：第一轮审「规格符合性」，本轮审「修复真实落地性 + 修复引入的新问题 + 测试与门禁自身质量」
> 门禁快照：`npm test` 158/158（多方一致）、`typecheck` 0、`lint` 0 error/155 warning、`i18n` 裸中文 0

---

## 一、结论

**第一轮交付的 41 项修复中，40 项经代码级核验真实落地**（含全部 P0 与 V 层六规则），仅 1 项「实际不生效」：**P0-5④ 的 MCP 崩溃五态，消费端被陈旧连接列表遮蔽，主路径失效**（见 P1-2）。

本轮新发现 **4 条 P1、12 条 P2、约 15 条 P3**。全部 P1 均经主理人独立读码复核证实，非子代理单方陈述。无 P0。

三条最值得警惕的结论：
1. **`budgetDecision` 二次反推窗口**——本轮修复**自己引入**的回归：两处代码都注释着「入口统一做一次窗口校准」，结果校准了两次，4× 封顶被绕成事实上的 ~8.7×（P1-1）
2. **P0-5④「修了但不生效」**——五态链路每一环单看都对（hook 有、事件有、UI 分支有），但 `connected.some()` 的短路顺序让崩溃标记永远被「已连接」遮蔽（P1-2）。这与第一轮 P0-1「每段都有代码、中间少一次注入」是同构问题
3. **契约校验器的输出形状与真实载荷分叉**——`validateAgentRunPayload` 返回的 `r.data` 会被内层 zod strip 掉 `context_window`，今天无害，任何人改为消费 `r.data` 就复现 P0-1① 事故（P1-4，地雷级）

---

## 二、上轮修复落地验证（汇总）

五路验证表合计 59 项核验，代表性结果：

| 层 | 验证结果 | 关键锚点 |
|---|---|---|
| 引擎（11 项） | **全 ✅** | 窗口消费 `index.js:838-853/:2127`；`effectiveWindowOf` 只抬不降+4×（`:639-646`）；rewriteLedger 与超限硬截断（`:517/:2150-2154`）；renewNotice 末尾追加+回滚开关（`:2008-2014/:1572`）；ring buffer 200/首20+末180（`verifier.js:37-40`，截断数学经实测模拟）；`verify_ledger` 4 站点恰好一条（`:2077/:2083/:2235/:2654`）；`wallClockHit` 无大小写问题；`load_skill` 穿越拦截 `:2500`；`verifier.js` 零依赖（grep=0） |
| 主进程（15 项） | **14 ✅ 1 部分** | 凭证 0600+chmod 自愈（`durableWrite.js:84-96`、`mcpAuth.js:70`）；sanitize 受保护键最后展开（`ipc/mcp.js:132-139`）；MCP 协议六项全落地（协商 `mcpClient.js:194-217`、翻页 :260-271、清洗 :93-121、404 重建 :282-293）；`APPROVAL_ORDER` 全仓唯一（`approvalPolicy.js:16`）；员工三通道顺序+三层路径防御（`ecosystem.js:82-100`）；`agentRunner:192-193` 各恰好 1 次。部分项：`server.stderrTail` 字段是死的（症状经读取端 `stderrTailOf()` 已修，字段本身未删） |
| 渲染层（21 项） | **19 ✅ 2 部分** | Modal 焦点陷阱七要素全绿（`Modal.tsx:59-61/:157-166/:167-201/:212-213`）；4 处换壳各恰好 1 处 `<Modal`；i18n zh/en **零单侧缺失**（296/296、28/28）；员工载荷逐字对齐解构式契约；probedNumCtxOf 只认 `api-show`；caps 缺失不伪造（`!("caps" in m)`）。部分项：桥调用为方法级中转（字面形态仍在，门禁可扫）；`--sem-knob-rgb` 为死 token |
| 契约+V层（12 项） | **10 ✅ 2 部分** | 10 类事件（`contract.mjs:118-130`，名称集合断言锁死）；envelope 降级不静默（`:199-208`）；R1–R6 语义逐条核（R5 diff=null→SKIP 单条 verdict 仍 PASS `:375-395`；R6 永不改 verdict）；N9 双层告警（`verifier.js:283`+`verifyRun.js:131-139`）；verdicts JSONL 零文本；annotation 无「已验证正确」措辞。部分项：`verification` 等 4 字段靠 passthrough 放行未显式登记 |
| 测试门禁 | **自检齐全** | ui-conventions/untracked-deps/undef-ident 三类自检+反向用例全部在位且有变异实测背书；`independent-verification` 22 条是真反向验证（差分实验、真实 stat、handler 计数） |

---

## 三、P1 新发现（4 条，全部经主理人复核证实）

### P1-1 `budgetDecision` 二次反推窗口，突破 4× 上限（本分支新引入的回归）
- **锚点**：`agent-core/index.js:2127`（先反推一次，抬到 ≤4×declared）→ `:2138` 把**已抬高的 ctxWindow 连同 lastPromptTokens** 传入 `budgetDecision` → `:653` 内部**再反推一次** `effectiveWindowOf(ctxWindow, lastPromptTokens)`。
- **实测**：`declared=32768, seen=200000` → runAgent 层 131072（正确 4×），budgetDecision 内部 win≈285715（≈8.7×declared），`0.7×285715≈200000`，`ctxHot=false`，gate=`'ok'`。
- **危害链**：窗口严重低估（>3.8×）时，压力闸失敏；「抬高后强制压一次」（`:2143`）只能救第一轮（`windowCompactDone` 后不再触发）；压缩救援耗尽后应挂起 `suspend-context` 的场景继续发超窗请求 → 400 → `contextRescued` 已用尽 → **run 直接抛错终止而非挂起**。
- **讽刺点**：`:2128` 与 `:652` 两处注释**都**写着「入口统一做一次窗口校准」——两处各自正确，合起来错误。
- **修法**：`budgetDecision` 删除内部反推（信任调用方已校准值），或 runAgent 传原始 `declaredWindow` 让它单点反推。`test/context-econ.test.mjs:323-334` 的用例全部不带 `lastPromptTokens`，此路径**零测试覆盖**。

### P1-2 P0-5④ crashed 五态在主路径失效（上轮「修了但不生效」）
- **锚点**：`LocalMcpSection.tsx:117` `if (connected.some(...)) return 'ok'` 短路在 `mcpStatus.resolve` **之前**；`:57` `useEffect(() => { load(); }, [load, refreshSignal])` —— `mcp_status` 崩溃事件**不触发 load()**，`connected` 恒为陈旧快照。
- **后果**：MCP 进程崩溃广播后，行状态恒「已连接」，红色徽标与重连按钮**永不出现**，除非用户手动点刷新。这正是 `useMcpStatus.ts:6` 注释里要修的原始场景。
- **修法**：`statusOf` 把 crashed 判断提到 connected 短路之前（重连成功已有显式 `clearCrashed`，resolve 里的 ok 优先分支实为冗余且有害）；或监听 mcp_status 触发 `load()`。

### P1-3 ConnectorConfigDialog 无 Esc/不入栈，叠在生态中心上时按 Esc 丢整份表单草稿
- **锚点**：`ConnectorConfigDialog.tsx` 仅 `:190 role="dialog"`，**无 onKeyDown/Escape/aria-modal/focus 管理**；渲染在 EcosystemModal 面板**内部**（`EcosystemModal.jsx:506`）→ `Modal.tsx:196` `root.contains(target)` 恒真、foreign 让路永不触发 → `Modal.tsx:160-165` 视自己为栈顶，Esc 直接关掉**整个生态中心**。
- **后果**：用户填到一半的连接器变量/Key 全丢。Tab 焦点环也会把两层可聚焦元素混成一个环。
- **修法**：换用 `ui/Modal` 入栈；或至少开箱 `panel.focus()` + 自挂 Esc。

### P1-4 契约内层 schema strip 掉 `context_window`——校验器输出与引擎输入形状分叉（地雷级）
- **锚点**：`contract.mjs:147-152` `model: z.object({ provider: z.object({id}), model: z.object({model_id}) })` 内层**无 passthrough**；`validateAgentRunPayload` 返回 `{ok:true, data: r.data}`（`:211-215`）。
- **现状无害**：`agentRunner.js:109` 只看 `v.ok`，继续用原始 payload。
- **危害**：任何人改为消费 `r.data`，`context_window`（`useAgentRun.ts:527` 放在 `model.model` 内）即静默消失 → 引擎回落 4096 → **精确复现 P0-1①「128K 模型按 4K 频繁压缩」**。
- **修法**：内层加 `.passthrough()`，或把 `context_window/reasoning_effort` 显式登记进 schema，并加一条「`r.data.model.model.context_window` 与原载荷相等」的测试。

---

## 四、P2 新发现（12 条）

| # | 发现 | 锚点 | 影响 |
|---|---|---|---|
| P2-1 | **`resumeContext` 裸拼 system（≤6000 字符，零守卫）**——第五个不可信注入入口 | `index.js:1725-1726`；对照 rolePreset/技能/AGENTS.md/记忆全有守卫（`:1615/:1652/:1691/:1709`） | 工具结果注入→模型自述→断点 summary→渲染层 `useAgentRun.ts:373` 原样回拼→下轮以 system 权威口吻注入 |
| P2-2 | 墙钟挂起被渲染层误报为「token 预算触顶」 | 引擎 `onSuspend({kind:'wallclock'})`（`index.js:1971`）→ 渲染层只处理 `engine-exit/timeout/else`（`useAgentRun.ts:359-373`） | 与引擎刻意区分的「总时长预算」文案直接矛盾；补 `'wallclock'` case 即修 |
| P2-3 | summary 模式 + `customTools` 时 `load_skill` 提示了却调不了（桌面主路径不触发） | `index.js:1758-1760`（仅 `!customTools` 才追加工具）vs `:1644-1657`（提示只看 disclosureMode） | 未来 CLI/eval 宿主必踩；提示条件与工具注册条件需同源 |
| P2-4（既有） | gate='compact' 当轮丢弃已计费的模型响应 | `index.js:2137` 判定在 `:2211/:2240` 消费之前，`:2159` continue | 本轮新增的强制压会在基线不会触发的场景复现此浪费 |
| P2-5 | MCP 404 重建无互斥；并发 connect 返回空工具 | `mcpClient.js:282-293`（N 个 404 → N 次并发 initialize）；`:552-563`（缓存分支握手在途返回 `toolCount:0`） | 偶发调用失败/空列表，自愈概率高但真实存在 |
| P2-6 | `verification/skillDisclosure/modelOverrides/rolePreset.skillNames` 未显式登记，靠 passthrough | `contract.mjs:141-176`；且渲染层 grep 无一处发送 `verification` → **UI 调档能力实际不存在**（死配置面） | 契约防漂移在这些字段上失效 |
| P2-7 | **R4 不认 shell `git commit`** → 强模型用 shell 提交后自述「已提交」会被误报 BLOCK | `verifier.js:365` 只认 `git_commit` 工具；WRITE_SHELL_RE（`:51-62`）无 git commit | 与「宁漏不误报」取向冲突——这是 V 层最坏形态（用户无法自证的误报） |
| P2-8 | **verifier.js/verifyRun.js 零直接单测** | test/ 全目录 grep `reconcile\|no_ledger\|WRITE_SHELL_RE` 零命中 | 六规则语义全靠评审保证；本报告能有意义恰因无门禁 |
| P2-9 | **approvalNotice 零行为测试**——导出了 `buildExecutionNotice/notifyExecuted` 纯函数并注释「便于单测」，但四条不发分支/可补偿性表/文案契约全部无用例 | test/ grep `notifyExecuted\|approvalNotice` 零命中 | 本轮唯一「导出了可测函数却没测」的修复项，且属**无标注的未验证** |
| P2-10 | bridge-parity 别名盲区：`const mj = window.mjcode` 后调 `mj.agentRun` 扫不到 | `lib/agent.js:53-54/:181`、`TerminalPanel.tsx:63-64`、`TodoPanel.jsx:31-35` | 53 个「死方法」中 `agentRun/onAgentEvent/shell` 为**假阳性**（核心链路真实在用），扫描失效不报警 |
| P2-11 | ipc-write-guard 是清单制非全覆盖制：168 条 handle 中 101 条未归类，其中 `memory:promote`/`worktree:promote`/`worktree:sync`/`collab:persist` **连守卫都没有** | `test/ipc-write-guard-coverage.test.mjs:54-56` | 抽查确认有守卫但不在清单的（回归无门禁看守）+ 完全无守卫的两类 |
| P2-12 | 6 个浮层组件零行为测试（CommandPalette/ConnectorConfigDialog/CustomConnectorForm/ProjectPicker/feedback/ScheduledTasks 新建表单） | test/ 零命中或仅文件名级 | P1-3 这类键盘事故恰是行为测试该抓的 |

---

## 五、P3 精选（8 条，全量见审计底稿）

1. **墙钟 30min 有两个互不知情的出处**：per-task（`dag.js:50` 钳制 30min）与 per-invocation 组等待（`invoke.js:8`）——串行 DAG ≥3 层会先撞组墙钟，强停仍在各自预算内的任务；两组数字无「实现侧<看门狗」式不变式
2. **ledger 截断后序号 `i` 恒为 199**（`index.js:1813`），205 次调用后尾部 6 条重复——仅影响 trace 可读性（normalizeLedger 已丢弃该字段）
3. `traces/*.jsonl` 的 ledger.command 若内联凭证（如 `curl -H "Authorization: Bearer …"`）会**明文落盘**；诊断包导出的脱敏过滤器是否覆盖该字段未验证
4. `mcp-oauth.json` 缺读时权限自愈（`mcpAuth.js:52-64` 只处理损坏副本），存量 0644 永不纠正
5. exec.js 残留 5 处硬编码超时字面量（`:461/:573/:585/:633/:694`）——与 timeouts.js 单点化纪律不符（是否违反「实现侧<看门狗」未对账）
6. 子代理 `parentContext`（父 convo 末 6 条 tool 结果原文）未过注入扫描（`index.js:2335-2341`），且子代理**不继承 onTrace** → V 层台账看不到子代理执行轨迹
7. EmployeeFormModal 更新路径恒等覆写 `display_name`（`EmployeeFormModal.tsx:121-126`），原有别名静默丢失；description/approval_policy 等字段表单不可见（盲区而非丢失）
8. `--sem-knob-rgb`/`-ring-rgb` 是无人消费的死 token（5 套主题 × 2 个）；HISTORY 抑制分支是 no-op（`verifier.js:155` 两条路径同值）；`UNKNOWN` 是死枚举（`contract.mjs:100`）——三处「看起来有语义、实际无行为」的误导点

---

## 六、测试与门禁质量评估

**好的一面**（显著高于平均水线）：
- 16 个新套件绝大多数锁**外部可观察行为**（事件序列、payload、真实文件 stat、落盘重读），多个做了对照实验（差分组/对照组）证明「拒绝来自被测机制」
- `independent-verification` 22 条是真反向验证：窗口差分实验不依赖任何实现常量（兜底 4096 ⇒ 触发压缩、声明 128000 ⇒ 零压缩），「去掉实现即红」成立
- 4 处门禁自检 + 变异实测背书在位（ui-conventions 三类自检、untracked-deps 反证法、undef-ident HOISTED 哨兵 + 真 TDZ 反向用例）
- 全部墙钟判据已改区间相交/下界——**除一条**（见下）

**待修的哑点**：
- `parallel-readonly-tools:102-103` 残留一条 `toolPhaseMs < 360` **硬断言**（注释自称「参考值，非判据」，实际仍是 check()）——重载机器假红
- `skill-disclosure:27` `BASE_TOOLS.length === 41` 魔法数——新增合法内置工具即假红
- `summary-clamp:20-22` 四段标记字面量与导入常量互为镜像——本批最典型的自证结构（四段具体内容无独立判据）
- run-all 装载器无「发现数下限」守卫（发现逻辑退化成 0 套件只会全绿）；3 个非 `.test.` 套件（`mcp-real-verify.mjs` 等）排除未留痕

---

## 七、修复优先级建议

| 优先级 | 项 | 工作量 |
|---|---|---|
| **P1 立即** | P1-1 删 `budgetDecision` 内部反推（约 3 行）+ 补带 `lastPromptTokens` 的用例 | 小 |
| **P1 立即** | P1-2 crashed 判断提到 connected 短路之前（约 3 行）+ 补崩溃事件触发用例 | 小 |
| **P1 本周** | P1-3 ConnectorConfigDialog 入栈或自挂 Esc；P1-4 契约内层 passthrough/显式登记 + 形状相等测试 | 小-中 |
| **P2 本周** | P2-1 resumeContext 过守卫（对齐记忆的做法）；P2-2 渲染层补 wallclock case；P2-7 R4 认 shell git commit（或文档化该已知误报）；P2-9/8 补 approvalNotice 与 V 层单测 | 中 |
| **P2 排期** | P2-5 MCP 并发互斥（in-flight handshake 去重）；P2-10 bridge-parity 别名扫描；P2-11 未归类 101 条建取舍账、4 条无守卫通道补守卫 | 中 |
| **P3 择机** | §五 全部 + §六 哑点 | 零散 |

---

## 八、方法论备注

1. 本轮所有 P1 均由主理人**独立读码复核**后才定性——五路子代理中有一条（A1-P1-1）实测数据与代码推演完全吻合，另一条（A3-F1）的短路顺序在 `sed` 输出中一目了然；无一冤案，也无一漏报的 P1 被降级。
2. 审计期间门禁由多方独立重跑（A2 报 158/158、A3 跑三个 UI 门禁、主理人后台跑四项），结论一致。
3. 已知未验证面（诚实清单）：Linux 沙箱真机、Windows chmod 语义、MCP 并发竞态真机复现、子进程 onTrace 桥接端到端、Vite HMR 泄漏实跑、原生 select 展开期间的 Esc 路由。
4. **教训一句**：本轮两条最重要发现（P1-1、P1-2）都属于「每一环单看都对」——前者是两处各自正确的注释化决策叠加成错，后者是上轮修复的每一环都存在但顺序差一步。**跨环节的组合行为，只有逐跳实测才能验证，任何一环的局部绿都不构成系统绿。**
