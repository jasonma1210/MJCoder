# 更新日志

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式。
版本号规范：`主版本.次版本.修订号`（语义化版本），配套 git tag `v主.次.修订`（如 `v1.0.0`）。
desktop / server / renderer 三个 package.json 的 version 必须保持一致，发版时同步提升。

## [未发布]

### 变更（M5/T5-5 团队记忆模块：scope=team + per-agent 私有 + 提名制晋升，2026-10-20）
- **数据层（迁移 v11，`main/db/index.js`）**：`memories` 表新增 `team_id` / `agent_id` 两列 + `idx_memories_team` 索引；`_ensureScopeColumns` 惰性列补齐同步登记，**不新建存储**
- **归属判定（单一事实来源）**：团队共享 = `scope='team' AND team_id=X AND agent_id IS NULL`；成员私有 = `scope='team' AND team_id=X AND agent_id=Y`；可见范围 = 团队共享 ∪ 自身私有，跨团队严格隔离
- **`main/memory/index.js` 团队感知**：`SCOPES` 由三作用域扩为**四作用域** `['session','team','project','global']`；`LAYER_QUOTA` 新增 `team: 3`；`resolveScope` 增 `team` 分支（**缺 `teamId` 一律拒绝**，回落 project，避免团队记忆挂空键）；去重键随 scope 分化（team 含 `team_id` + `agent_id`）；新增 `MAX_TEAM_MEMORIES = 200` 与 `_enforceTeamCap`，纳入 `_enforceCap` 统一淘汰口径（空间闸 / 全局闸 / 团队闸共用一套实现）
- **半衰期**：`scorer.HALF_LIFE_DAYS_BY_SCOPE` 增 `team: 30`（**与 project 同档**），`halfLifeDaysFor` 与 `decayJob` 经同一函数取值，无第二套规则
- **提名制晋升（U5 定案）**：`PROMOTE_TEAM_MIN_HITS = 3`；新增 `listTeamPromotionCandidates`（命中≥3 且 `is_valid=1` 且**未被归档团队**的条目进候选；含团队专有名（团队名 / Lead 名）的条目由宿主注入 `excludeNames` 直接排除，本模块不认识军团实体）+ `promoteTeamMemoryToProject`（**一键确认后**才写 L2，团队→项目默认不自动晋升，防止团队专有约定污染跨项目上下文）
- **`main/teamStore.js`**：新增 `findTeamByRun`（由 `runId` 反查团队 + 成员身份），供运行期召回与沉淀定位
- **运行期集成（`main/agentRunner.js` / `main/workerPool.js`）**：worker 子任务 prompt 装配时按「团队共享 ∪ 自身私有」注入团队层召回；子任务结论沉淀团队记忆走宿主侧 `autoCapture` 开关，**归档团队不写入**
- **IPC / 桥（`main/ipc/localData.js`、`main/preload.js`）**：`memory:list` 支持 `scope` / `teamId` / `agentId` 过滤；新增 `memory:teamPromotionCandidates` 与 `memory:confirmTeamPromotion` 两通道 + `memoryTeamPromotionCandidates` / `memoryConfirmTeamPromotion` 两桥（写入走既有 `ipc-write-guard` 清单登记）；`resetScope` 白名单纳入 `'team'`
- **UI / i18n（`renderer/src/components/MemorySection.tsx`）**：记忆面板补 team 域筛选与「待晋升候选」区块（含「提升为项目记忆」按钮，一键确认），`teams.json` / `settings.json` 双语 key 双向一致
- **模块拆分守 800 行阈值**：`main/memory/index.js` 因本轮膨胀越过 raw 800 行门禁，按「先拆再合入」抽出 `main/memory/recall.js`（召回族）与 `main/memory/team.js`（团队记忆族）；子模块经依赖注入工厂（`createRecallMethods(deps)` / `createTeamMethods(deps)`）装配到 `MemoryManager.prototype`，**不 require 主模块**，避免循环依赖；index.js 由 953 降至 **767** raw 行
- **回归门禁口径同步（被裁决的契约变更，非漂移）**：`docs/harness-r7/04-test/check.mjs` 的 A18c `LAYER_QUOTA` 改四作用域；A17e/A17f/A17g 由**时点等位**改**只增不减的下界不变量**（≥203 / ≥221 / ≥205，理由与 A17d 同：IPC 与桥方法绝对数随里程碑递增，等位会逼后人手改常量），并在文件头「契约变更台账」留痕
- **权威数字同步**：`docs/MJCode-技术设计文档-2026-10-17.md` 套件 237→**238**、主进程通道 208→**210**、preload 桥 219→**221**、主进程 JS 模块 141→**143**、`main.js` raw 1820→**1863**；`docs/harness-r7/legacy-ledger.json` + `存量收敛台账.md` 重生成——死 bridge **48/219 → 50/221**（`teamsArchive` 因移除归档 UI、`teamsCreateLead` 因派活简化而失去调用方），裸 `<button>` **258 不变**；`test/docs-consistency.test.mjs` 的 `REFERENCE_COUNT_BASELINE` 28→**29**（文档新增 `memory-team.test.mjs` 引用）
- **守护测试**：新增 `test/memory-team.test.mjs`（**10/10**）——resolveScope 的 team 约束、`HALF_LIFE_DAYS_BY_SCOPE.team=30`、迁移 v11 两列与索引、共享/私有可见范围、去重键分化、团队容量闸 200、提名候选（阈值 + 团队专有名反例 + 归档排除）、`promoteTeamMemoryToProject`、`listScope`/`resetScope` 的 team 分支、`findTeamByRun`
- **验证**：`typecheck` 0 error、`lint` **160 warning / 0 error**（棘轮 161 内）、`npm test` **241/241 通过 0 失败**、`doc-fact-check` 一致、`harness-r7:check` **76 PASS / 0 FAIL**、`legacy-ledger` 20/20、`max-lines` 3/3、渲染层 `vite build` 成功

### 变更（M5 军团界面形态五条修正：必填 / 工作目录下拉 / 标签化招募 / 去归档 / 派活简化，2026-10-20）
- **新建团队必填 + 弹窗内联报错**：`TeamsPage.tsx` 的 `submitCreate()` 拆出两条精确校验（`name` / `description` 空白即拒），错误写入新增的 `createErr` state 并由弹窗内 `<InlineAlert type="error">` 就地渲染；`Field` 增 `required` prop 渲染必填星号。此前校验只写页面级 `error`、被 Modal 遮住 ⇒ 真机表现为「点创建没反应」
- **「工作目录（可选）」改下拉**：新增 `projects` state + `window.mjcode.localProjects()` effect（过滤无 path 项）；`<select>` 首项＝`projectGlobalOption`（留空＝全局团队），其余＝本机最近项目。顺序直接采用主进程 `localStore.listProjects()` 的 `lastOpenedAt` 倒序（渲染层不再排序，避免第二份排序实现漂移）；已删除项目被物理移除、天然不入候选
- **加成员弹窗标签化（需求③）**：`MemberModal` 增 `roster` + `maxMembers`（由 `teams:get` 下发，渲染层不硬编码上限）；招募/自定义落库后**不关窗**，成员以标签就地累积；统筹头像 `bg-danger-bg text-danger`（红）、其余成员 `bg-success-bg text-success`（绿）；「设为统筹」只出现在非统筹标签上（全局唯一由 `setLead` 保证）；成员上限 `MAX_MEMBERS_PER_TEAM` **8 → 20**（`main/teamStore.js`）；「新建员工」保存后 `loadEmployees()` + 自动 `recruit(payload.id)` ⇒ 新建员工自动成标签
- **招募失败同样改为弹窗内联错误**：`MemberModal` 移除 `onError` prop、改用本地 `err` state（同「被 Modal 遮住」根因），调用处同步删除 `onError={setError}`
- **移除归档 UI 入口（需求④）**：`TeamsPage.tsx` 删除 `setTeamArchived()`、`showArchived` 开关与卡片归档/取消归档按钮，`load()` 不再传 `includeArchived`。**后端语义全部保留**：`archived_at` 列、`teams:archive` IPC、`setTeamArchived`、`dispatchGate` 的 `TEAM_ARCHIVED` 分支与既有单测不动
- **派活面板简化（需求⑤）**：`TeamDispatchPanel.tsx` 整体重写为「选团队」单职责（props 收敛为 `onClose / activeTeamId / onSelectTeam`，列表项显示名称 + 描述 + 成员数，缺统筹项带 `bg-warn-bg text-warn` 警示；删除 本次任务目标 / 协作模式 / 预算上限 / 参与成员 四块表单与「一键创建 Lead」入口）；`PlusMenu.jsx` 改为透传 `activeTeamId` / `onSelectTeam`；`Composer.tsx` 新增**团队名徽标**（`IconUsers` + 可点 × 取消）与 `teamErr` 错误条；`ChatArea.jsx` 新增 `activeTeam` / `teamErr` / `teamBusy` state 与 `sendOrDispatch()`——**发送即自动派活**（调 `teams:dispatch`，`LEAD_MISSING` 时回写徽标警示），成功后回显「已派活，N 个任务已进入看板」
- **后端配合**：`main/ipc/teams.js` 的 `teams:list` / `teams:get` 增下发 `maxMembers: MAX_MEMBERS_PER_TEAM`；`teams:dispatch` 删除 `MISSING_MODE` / `MISSING_BUDGET` 强校验，改为缺省回落（模式回落 `team.defaultMode`、预算回落 `team.budget || {}` 经 `normalizeBudget`）
- **文件拆分守阈值**：新增 `renderer/src/components/TeamMemberModal.tsx`（`MemberModal` default 导出 + `Field` / `initial` 命名导出；私有 `CAP_KEYS` / `APPROVAL_LABEL` / `SANDBOX_LABEL`），把约 300 行从 `TeamsPage.tsx`（原 ~880 行、触发 max-lines）抽出，该页降至 527 行
- **i18n 双语**：`teams.json` 增 `projectGlobalOption` / `nameRequired` / `descRequired` / `dispatchPickHint` / `dispatched` / `needLeadFirst` / `noDescription` / `rosterTitle` / `rosterCount` / `rosterEmpty` / `rosterFull` / `membersFull` / `done`（zh-CN 与 en-US 双向一致）；`composer.json` 增 `teamTip` / `removeTeam`
- **权威数字同步**：`legacy-ledger.json` 与 `docs/harness-r7/存量收敛台账.md` 重生成——死 bridge **48/219 → 50/219**（`teams:archive`、`teams:createLead` 失去渲染层引用），裸 `<button>` **258 不变**
- **验证**：`typecheck` 0 error、`lint` **159 warning**（棘轮 161 内）、`npm test` **240/240 通过 0 失败**（`untracked-deps` 在 `git add` 新文件后转绿）、`doc-fact-check` 一致、`harness-r7:check` **76 PASS / 0 FAIL**、`legacy-ledger` 20/20、`max-lines` 3/3、`layout-tokens` 2/2、渲染层 `vite build` 成功

### 变更（M5 军团前置修正 + AI 自动创建员工，2026-10-20）
- **军团去项目强制绑定（用户反馈修正）**：`teamStore.createTeam` 删除「归属项目必填」校验（`projectPath` 降级为可选「工作目录」）；`listTeams({ includeArchived })` 去掉 `project_path` 过滤，军团**全局可见**——任意对话 `+` → 军团均能列出全部未归档团队。`ipc/teams.js` 的 `teams:create` 校验放宽为 `projectPath: { max:1024, optional:true, allowEmpty:true }`、`teams:list` 不再透传 `projectPath`；`teams:dispatch` 取 `team.projectPath || payload.projectPath` 做工作目录回落（全局团队靠当前会话项目兜底），`Composer.tsx → PlusMenu.jsx → TeamDispatchPanel.tsx` 逐级透传 `projectPath`
- **AI 自动创建员工**：`ipc/teams.js` 新增 `EMPLOYEE_DRAFT_SYSTEM` 提示词与 `teams:draftEmployee` handler（复用与编排/定时任务同源的 `chatOnce`/`resolveModel`/`extractJson`，返回 `{id,name,system_prompt,tools}`；`tools` 按 `ROLE_TOOL_ALIASES` 白名单过滤）；`preload.js` 新增 `teamsDraftEmployee` 桥；`EmployeeFormModal.tsx`（`!isEdit` 时）顶部新增「AI 自动创建」面板（描述输入 + 生成草稿按钮 + 错误提示），回填 name / id（置 `idTouched` 防被 `slugify(中文名)=''` 覆盖）/ system_prompt / tools
- **数字员工列表右上角「新建员工」**：`TeamsPage.tsx` 招募弹窗（`MemberModal` 的 `recruit` 模式）经 `titleNode` 在标题右侧渲染「新建员工」按钮，内嵌 `EmployeeFormModal`（`onSaved` 后重载员工列表）；员工列表加载抽为 `loadEmployees`（useCallback）+ 按 mode 触发的 effect
- **军团卡片交互补齐**：`TeamsPage.tsx` 移除 `project` prop 与项目过滤；`archiveTeam` 重构为统一入口 `setTeamArchived(team, archived)`，归档卡片新增「取消归档」按钮（`variant="secondary" size="xs"`）+ 成功提示；卡片副标题按 `team.projectPath` 条件渲染；新建表单不再预填项目
- **i18n 双语**：`teams.json` 删 `noProject`、改写 `subtitle`/`projectLabel`/`projectHint`，新增 `projectPlaceholder`/`newEmployee`/`unarchive`/`unarchiveTitle`/`unarchiveMessage`/`unarchiveFailed`/`unarchivedNotice`；`settings.json` 新增 `employeeAiLabel`/`employeeAiPlaceholder`/`employeeAiHint`/`employeeAiBtn`/`employeeAiBusy`/`employeeAiDescRequired`/`employeeAiFailed`
- **守护测试**：`test/team-store.test.js` 反转「缺归属项目被拒」→「项目留空可建（全局团队）」，项目过滤断言改为全局可见断言，归档段补「取消归档后重新可见」并复位归档态
- **权威数字同步**：`docs/MJCode-技术设计文档-2026-10-17.md` 通道 207→**208**、桥方法 218→**219**；`docs/harness-r7/04-test/check.mjs` 的 A17f `218`→`219`、A17g `202`→`203`；`legacy-ledger.json` 重生成 + 台账文档死桥 48/218→**48/219**
- **验证**：`typecheck` 0 error、`lint` 159 warning（棘轮 161 内）、`npm test` **240/240 通过 0 失败**、`doc-fact-check` 一致、`harness-r7:check` 76 PASS/0 FAIL、`legacy-ledger` 20/20、渲染层 `vite build` 成功

### 新增（生态中心统一入口重构 T7：通用 OAuth 2.1 引擎，2026-10-16）
- **`main/mcpAuth.js`（核心引擎，electron 无关可测）**：`McpAuthManager({storeFile, credentialCrypto, openAuthWindow, fetchImpl, log})` 实现三级回落授权——①标准发现：未认证探测 MCP 端点，401 `WWW-Authenticate resource_metadata`（缺省 `/.well-known/oauth-protected-resource`）→ `authorization_servers` → AS 元数据（RFC 8414，openid-configuration 兜底）→ DCR 动态注册（RFC 7591，`token_endpoint_auth_method=none` 公共客户端）；②目录 `oauth_preset`（authorization_endpoint/token_endpoint/client_id，公共客户端 + PKCE S256）；③两者皆不可用如实返回中文错误（永不臆造端点、永不捆绑厂商机密）。loopback 回调（RFC 8252 §7.3：127.0.0.1 随机端口 `/callback`）、state 随机校验、120s 超时、授权完成即关窗；令牌经 CredentialCrypto 加密落 `userData/mcp-oauth.json`（0600），过期自动 refresh 续期，重启免授权
- **`main/mcpClient.js` 接线**：`createHttpTransport`/`connectMcpServer` 增可选 `auth={getHeader, refresh}` 钩子——发送前注入 Bearer；401 强制续期重试一次，仍失败抛 `mcpAuthRequired` 标记错误；`mcpRpc` 重包装不丢标记；`connectMcpServer` 失败返回 `needsAuth:true`
- **`main/ipc/mcp.js`**：懒建 `McpAuthManager`（凭证加密就绪才可用）；授权窗口用独立沙箱化 `BrowserWindow`（900×700、无 preload）；http 连接自动挂 OAuth 钩子（令牌全程主进程闭环，渲染层不经手）；新 IPC `mcp:authorize`（只回状态与级别，绝不回传令牌）+ `mcp:authStatus`，authorize 结果入审计日志；`initMcpIpc` 增 `getCredentialCrypto` 依赖（`main.js` 注入）
- **`main/preload.js`**：MCP 桥区增 `mcpAuthorize`/`mcpAuthStatus` 两通道
- **`ConnectorConfigDialog.tsx` oauth×remote 分支改造**：挂载查 `mcpAuthStatus`——已授权显示「已授权」态 + 测试连接按钮；未授权「打开浏览器完成授权」按钮 → `mcpAuthorize`（透传 `oauth_preset`）→ 成功自动试连；失败如实显示主进程中文错误；authorizing 期间禁用按钮；`ConnectorEntry` 接口增 `oauth_preset` 字段
- **i18n `ecosystem.json` 双语**：删 `oauthPending`（T7 交付即死键），增 `oauthAuthorize`/`oauthAuthorizeHint`/`oauthAuthorized`/`authorizing`/`oauthFailed` 五键
- **`eslint.config.mjs`**：main 块 globals 补 `URLSearchParams`（Node 17+ 全局，此前无消费方未声明）；新增 `test/**/*.mjs`/`eval/**/*.mjs` 的 `sourceType: 'module'` 覆盖块（.mjs 按 Node 规范恒为 ESM，此前被第一块 commonjs 解析即报 error，因 test/ 不在门禁扫描范围而未暴露）；test/ 放宽块补 `no-script-url`/`no-regex-spaces` off（安全夹具字符串与源码匹配正则为刻意写法）并声明 `global` 全局；修复后 `npx eslint test/` 0 error、门禁口径 0 error/137 warning、全量 87/87
- **测试**：新增 `test/mcp-auth.test.mjs`（21 项，全真实 http mock）——发现链+DCR+PKCE 全流程、加密落盘 roundtrip（文件无明文令牌）、过期自动续期、Bearer 注入握手、401 续期重试序列、needsAuth 标记、mcpRpc 标记透传、preset 二级回落、三级如实披露（无发现/无 DCR 两分支）、免授权服务挂钩子匿名直连不回退（deepwiki 真机场景）、参数校验；假授权窗口 fetch 跟随 302 等价浏览器行为
- **验证**：lint 0 error/137 warning（基线内）、typecheck 0 error、vite build 通过、全量 87 套件 87 通过 0 失败（含 mcp-auth 21/21）；`npm run dev` 真机启动冒烟通过（主进程稳定运行无崩溃，已持久化 http/stdio 服务自动重连正常）；至此生态中心统一入口重构计划 T1-T7 全部交付

### 变更（生态中心统一入口重构 T4-T5：「+」菜单启用模型，2026-10-16）
- **T4 员工 tab 去下载化回归**：招募链路（`ecosystemEmployeeRuntime` → `mjcode:recruit-expert` → App 开新会话注入角色）不依赖任何下载登记，既有断言全绿
- **「+」菜单改启用模型（T5，`PlusMenu.jsx`）**：连接器面板只列「目录 ∩ 启用清单」（关闭项不可见不可搜），打开时按 `connectorValuesForLocal` 回填已存 values、点击即直连，就地表单提交时 `saveConnectorValueLocal` 持久化；技能面板 = 磁盘技能 ∩ 全局启用集（`enabledSkills` 经 ChatArea→Composer→PlusMenu 透传）；员工面板改目录全量（`ecosystemEmployees` IPC）；删除 `MCP_PRESETS` 内置三预设（目录已含 mcp-playwright/mcp-fetch/mcp-filesystem 且 `recommended:true` 默认启用）
- **技能单选**：`toggleSkill` 改替换式（`skillIds` 字段保留数组兼容旧存档，读时以首个为选中态，再点首个=清空）；ChatArea `mjcode:enable-skill` 监听同步改替换式写入；`useAgentRun` 消费逻辑不动
- **三面板懒加载**：新增 `useLazyList` hook（IntersectionObserver 底部哨兵，每页 15，关键词/面板切换重置），避免长目录全量渲染卡顿
- **manual 连接器引导改跳生态中心**：「前往设置」→「前往生态中心」（新 `mjcode:open-ecosystem` 事件，App 监听打开 `EcosystemModal`；设置页 MCP tab 已在 T3 删除，旧指引指向不存在的位置）
- **删除 `lib/ecosystemLocal.js`**：下载清单 API 整体下线（旧连接器清单已在 T1 迁移并入启用清单），`no-new-jsx.test.js` 豁免项同步移除；`EcosystemModal` 招募不再调用 `downloadEmployee`
- **i18n `plusMenu.json` 双语**：删 7 键（preset×3、downloaded、downloadedPending、authPending、openSettings）、增 4 键（needsConfig/needsAuth/openEcosystem/noConnectors）、改写 5 键（noExperts/noSkills/skillsFooter/manualHint/connectorsFooter，去「下载/设置页」语义）
- **验证**：lint 0 error/138 warning（基线内）、typecheck 0 error、vite build 通过、全量 86 套件 86 通过 0 失败；undef-ident TDZ 门禁对 `useLazyList` 参数名与组件后置 `const` 同名误报，参数更名 `pageKey` 消除

### 变更（生态中心统一入口重构 T1-T3 + MCP 授权二维分流，2026-10-16）
- **入口收敛（T1-T3）**：新增 `lib/ecosystemEnabled.ts` 启用清单/values/旧下载清单迁移纯函数；生态中心连接器 tab「下载」→启用开关 + `ConnectorConfigDialog` 就地配置弹窗 + `LocalMcpSection` 本机服务区（承接已连管理/手动添加/JSON 编辑）；技能 tab「下载」→启用开关（开=未物化则 `installEcosystemSkill` 物化并并入 enabledSkills，关=仅摘启用态保留磁盘文件，非破坏可逆）+ `LocalSkillsSection` 本地技能区（内置/文件技能开关自设置页迁入）；连接/断开/保存派发 `mjcode:mcp-tools-dirty` 事件，App 监听重建工具集（替代已删的设置页回调链，`mergeMcpTools` 随之删除）
- **设置页 skills/mcp 两个 tab 整体删除**：`SettingsModal.jsx` 移除 NAV 两项、McpTab 函数体、MCP_PRESETS/BUILTIN_SKILLS 常量与全部关联 state/handler（1445→996 行），生态中心成为唯一管理入口；内嵌 `EcosystemModal` 透传 `enabledSkills/onSkillsChange`
- **MCP 授权二维分流（专家修订，用户确认后落地）**：按目录 104 条实测分布，`auth_mode` 单轨制存在结构性死路（paste_key×manual 22 条无处注入、oauth×manual 12 条无 URL 无从发现、oauth×npm/docker 3 条由服务自身授权）。`ConnectorConfigDialog` 路由改为 `auth_mode × install.type` 组合分流：仅 oauth×remote（25 条）显示「T7 浏览器授权」如实状态；oauth×npm/docker/uvx 提示服务自行完成授权；oauth/paste_key×manual 只给文档指引不出现输入框；paste_key×stdio 并入变量表单。T7 通用 OAuth 2.1 引擎方案同步修订为**三级发现回落**（401 规范发现+DCR → 目录 `oauth_preset` 公共客户端 PKCE → 如实披露），令牌主进程闭环加密落盘、永不进渲染进程
- **settings.json 死键清理**：双语各删 94 键（310→216），含本轮 McpTab/技能区下线键与历史会话遗留（账户/审计/诊断/旧更新文案）；`skillXxx` 系列保留（LocalSkillsSection 仍消费）；新增 `ecosystem.dialog.oauthSelfAuth` 双语键
- **验证**：lint 0 error/138 warning（基线内）、typecheck 0 error、vite build 通过、全量 86 套件 86 通过 0 失败

### 修复（测试基线与 better-sqlite3 解耦，2026-10-16）
- **测试不再依赖 better-sqlite3 / Xcode CLT**：4 个 DB 型套件（taskStore/memory/orchestrator/workerPool）此前硬依赖 `openDb()`（better-sqlite3 原生模块），在未编译好原生模块或缺 Xcode CLT 的机器上一跑即 `ERR_DLOPEN_FAILED` 崩溃。改为走 `openDbAsync(dir, { driver: 'sqljs' })`——`main/db/index.js` 的 `openDbAsync` 新增 `driver` 覆写入参（显式指定驱动，测试用 `'sqljs'` 强制零原生），业务层仅用 `prepare/get/all/run`、`transaction`、`exec`、`pragma`，sql.js 适配层全覆盖，两驱动等价
- **taskStore 测试持久化语义对齐**：sql.js 为防抖落盘（非 WAL 即时），重开读回前加 `db.flush()` 主动落盘；orchestrator 的 `store` 因被 IIFE 外 makeDeps 闭包引用改为模块级 `let` + IIFE 内 await 初始化
- **验证**：全量基线 **85 套件 85 通过 0 失败**（此前 4 失败全绿，无 CLT/rebuild 依赖）；taskStore 24/24、orchestrator 7/7、memory 7/7、workerPool 21/21；typecheck 0 error、lint 0 error/140 warning（基线内）。`npm rebuild better-sqlite3` 与 Xcode CLT 从此与测试、打包均无关

### 新增（MCP 连接器「下载即连」+ 就地引导配置，2026-10-15）
- **根因修复——下载≠配置**：此前生态中心下载连接器只写 localStorage 清单，「+」菜单永远停在「已下载 · 待配置」且无任何入口；而目录数据 `ecosystem/mcp-connectors.json` 本就携带完整启动信息（install.type/transport/env_vars/auth_type），信息从未被消费。新增 `renderer/src/lib/ecosystemConnectorLaunch.ts` 纯函数启动计划：npm→`npx -y pkg`、uvx→`uvx pkg`、docker→`docker args`、remote→`http url(+headers)`，`${VAR}` 占位符与必填 env_vars 由表单收集回填
- **「+」菜单连接器面板交互化**（`PlusMenu.jsx`）：点击行按启动计划四态分流——`ready` 直接经 `mcp:connect` 连接（成功即持久化、重启自动重连）；`needs-config` 展开就地表单（逐变量输入框 + 官方文档链接，填齐即连）；`needs-auth`（remote+oauth/api_key/token）引导粘贴 Authorization 令牌、可留空匿名直连；`manual` 给出「前往设置 → MCP 服务」跳转 + 官方文档指引。旧注释「目录数据无启动信息」系过时误判，已纠正
- **目录新增 4 个连接器**（接入方式均经官方文档核实）：飞书 `@larksuiteoapi/lark-mcp`（npm，AppID/AppSecret 占位符引导）、腾讯 ima（manual + IMA_CLIENT_ID/IMA_API_KEY 必填 env 引导，社区 server 需本机部署）、腾讯 Ardot 云端（remote https://ardot.tencent.com/mcp，oauth 引导）与 Ardot 本地（remote http://127.0.0.1:50501，需客户端打开设计稿，匿名直连）；Notion 目录原有条目（remote oauth + local npm）自动受益
- **完整 OAuth 弹窗登录（BrowserWindow + loopback 回调 + token 持久化注入 headers）为下一步架构方案**，本轮先落地「官网授权后粘贴令牌」的引导式授权

### 测试（MCP 连接器启动计划）
- 新增 `test/connector-launch.test.mjs`（18 项）：四态计划全分支 + 占位符回填 + env 注入 + 真实目录四新连接器可识别断言；发现式 runner 自动纳入基线
- 修复门禁真报：`PlusMenu.jsx` 局部 `const open` 遮蔽 props `open` 触发 TDZ 门禁——更名 `cfgOpen`（`undef-ident.test.js` 13/13）
- 全量 85 套件：81 绿 + 4 套已知 better-sqlite3 DLOPEN 环境失败；lint 0 error/140 warning、typecheck、vite build 通过

### 修复（测试门禁假绿 + 离线 CSP 噪声，2026-10-15）
- **测试门禁 `&&` 串联盲区（假绿）**：`npm test` 原为 83 套件 `&&` 手动串联，任一套件**崩溃**（如 better-sqlite3 ABI 不匹配的 ERR_DLOPEN_FAILED 顶层抛错）即中断整条链，其后套件静默不执行而 CI 照样绿——实测 orchestrator.test.js 崩溃后其后 41 套件（含全部 M3/M4 新能力）从未被跑。新增 `test/run-all.mjs` 发现式 runner：自动发现 `test/*.test.{js,mjs}` + 2 个 smoke 套件（新增套件免注册即入基线），单套件崩溃/超时（180s）只记录不阻断，全量跑完后末尾汇总「失败清单 + 崩溃/超时清单」并以非零退出码收口；`package.json` test 脚本改为 `node test/run-all.mjs`。顺带发现 `role-preset.test.mjs` 此前**从未注册**进手动链（漏注册），现被自动发现纳入（5/5 绿）。`browser-process.test.mjs` 的「测试链必须注册本套件」断言随语义改为「test 指向 run-all + 本套件位于 test/ 可被发现」
- **离线模式 CSP 噪声**：App 启动恒 `localMode(true)`，但 `api.globalProviders()` 仍裸 `fetch localhost:3001` → 被 `index.html` CSP connect-src 拦截，每次启动打印无意义报错。`renderer/src/lib/api.js` globalProviders 离线态直接静默返回 `[]`（零 fetch）；在线态照常拉取、失败 `console.warn` 后回空数组（与 providers() 同款降级，不阻断界面）。`providerStorage.test.mjs` 新增 2 项防回归断言（离线零 fetch / 在线能力未误砍）+ fetch 桩记录
- **验证**：全量基线 84 套件 80 通过（原 43 即断）；4 个失败（memory/orchestrator/taskStore/workerPool）确认同为 better-sqlite3 `NODE_MODULE_VERSION 127 vs 147` 环境问题（`npm rebuild better-sqlite3` 可修），与本次改动无关且被 runner 明确暴露不再掩盖；真机（vite + playwright）确认 CSP connect-src 报错归零（仅余无关的 frame-ancestors meta 警告）；providerStorage 11/11、build-config 13/13、browser-process 17/17、typecheck 0 error、lint 0 error/140 warning（基线内）

### 变更（生态中心「招募」重设计 + 头部裁切修复，2026-10-15）
- **数字员工卡改「详情 + 招募」**：删除「用此角色开会话」与「下载/已下载」双按钮（目录数据本就存本机，下载按钮语义多余），合并为单个实心主按钮「招募」（zh:招募 / en:Recruit）；`handleUseRole`/`handleDownloadEmployee` 删除，`handleRecruit` 取角色预设后派发 `mjcode:recruit-expert` 事件
- **招募即开新会话注入角色**：App 监听 `mjcode:recruit-expert` → 新建会话（setActiveThread(null)）+ 关闭设置/生态页 → 待 ChatArea 切会话 effect 落定后（setTimeout 宏任务，顺序不可颠倒否则被「切会话清空 extras」覆盖）派发 `mjcode:enable-expert` → 角色 chip 出现在输入框上方，首条消息建线程后 expert 随每轮 agent:run 注入并持久化到新线程
- **ChatArea extras 恢复时序修复**：新建会话（thread null→id）且该线程无 localStorage 存档时跳过恢复，保住招募注入的 expert；曾访问线程必有存档，判定精确不误伤正常切换
- **头部各行裁切修复**：embedded 容器 `max-h-[72vh]` flex-col 下，顶栏/tab 栏/搜索行/分类行缺 `shrink-0` 被压缩裁切（「横向分类被遮挡」真因），四行统一加 `shrink-0`
- **死代码清理**：`ecosystemLocal.js` 删除无消费方的 `isEmployeeDownloaded`；语言包删 `useRole`/`downloadedEmployee`，`useRoleFailed` 更名 `recruitFailed`；连接器/技能 tab 下载能力保留不动

### 变更（i18n 全量补齐 + 移除登录系统，2026-10-15）
- **生态中心（Ecosystem）布局疏朗化**：卡片内边距 p-3→p-5、网格间距 gap-3→gap-4、描述文案 `line-clamp-2` 限两行（全文进「查看详情」展开区）、标签/按钮行间距统一加大、操作按钮 `shrink-0 whitespace-nowrap` 修复「Chat as this role」竖排换行、顶栏/搜索/分类栏左右留白 px-5→px-6——仅调排布样式，组件与功能零删减
- **移除登录系统**：应用启动直进主页面，删除 LoginPage 与 token 门控；设置页「账户与更新」tab 整体移除（用户配置/退出登录/设备绑定内容页下线），`locales/*/login.json` 随消费方删除
- **版本更新入口迁移**：账户页移除后，检查更新/手动下载兜底链接/重启安装能力不丢——拆出 `renderer/src/components/UpdateSection.tsx`（新 TS 组件，符合 no-new-jsx 门禁）挂到设置页「通用」tab 末尾；`release-update.test.js` 设置页断言随实现改指新文件
- **i18n UI 文案全量补齐**（设置/审批/运行时/生态/协作等域，zh-CN+en-US 双语）：
  - 新增语言包模块：`search.json`（8 个搜索提供方 label/note/extra 字段占位）、`runtime.json`（38 键：IPC/Agent/错误可读化/压缩/工作树等运行时提示）、`approval.json` 补齐审批卡 13 键（按 git 原文恢复：危险命令/文件写入/MCP 工具标题、第 1/N 条、允许一次等按钮、键盘快捷键提示）
  - 顶层常量防「冻结翻译」：`constants/approval.js` 档位、`lib/modelConfig.js` 推理/上下文选项改渲染期函数（`getPermissionOptions`/`getReasoningOptions` 等），label map 改存 key 消费点翻译（`lib/market.js`、`TeamSpace.jsx` 看板列名、`MarketModal.jsx`）
  - 纯 Node 测试宿主兼容：`lib/agent.js`/`lib/api.js` 被 Node 测试静态导入无法引 TS i18n——`i18n/index.ts` 模块加载时置位 `globalThis.__MJ_T__`，消费方经该运行时通道取翻译（未置位回落返回 key）；`providerStorage.test.mjs` 按同款规则注入 zh-CN 翻译函数保持断言语义
  - console 诊断信息中文一律改英文（开发者面向，不进 UI 语言包）；prompt 注入文案（数字员工模板/断点恢复/继续指令匹配等）逐行 `i18n-literal` 豁免——改动会影响模型行为
- **i18n 门禁扩面**：`test/i18n.test.mjs` 扫描目标从 components+App+main 扩展到 `renderer/src` 全量（排除 i18n 基础设施目录），裸中文 113 行 → 0
- **max-lines 豁免清单收缩**：SettingsModal.jsx 移除账户页后降至 1445 行（<1500），按「只减不增」规则移出 eslint 豁免清单，`test/max-lines.test.js` 期望集合同步

### 测试（i18n 补齐验证）
- `thread-composer.test.js` 两条断言随 i18n 实现更名（改匹配渲染期函数名 + zh-CN 语言包内容双重校验）
- 全量 83 套件：79 绿 + 4 套已知 better-sqlite3 DLOPEN 环境失败；lint 0 error/140 warning、typecheck、vite build 通过；i18n 门禁 5/5


### 新增（M4 里程碑：通用桌面 Agent 能力扩展，2026-10-15）
- **T4-1 Browser Use**：`main/browserProcess/{host,childEntry,registry}.js`——Playwright 下沉独立 utilityProcess（T3-6 驻留模式，崩溃透明重启→browserDegraded 降级）；`main/browserTools.js`——navigate/click/fill/select/screenshot/extract 六工具 + 审批双闸（navigate/screenshot/extract 走 L3 可规则豁免；click/fill/select 恒逐次确认——页面点击可能触发支付/登录/发送真实副作用，规则不可静默放行）；截图落盘 `userData/browser-shots/` 经 `mjpreview://` 回轨迹卡证据图；每对话一个浏览器会话（30 分钟闲置回收）
- **T4-2 Chrome 接管**：`main/chromeRelay/server.js`（仅监听 127.0.0.1 的 WebSocket 中继）+ `chrome-extension/`（CDP 操作用户真实浏览器）+ `main/chromeTools.js` 七工具；chrome_connect 恒逐次授权卡——拒绝/超时即断开、授权不沉淀；click/fill 恒逐次（登录态页面风险高于 T4-1 沙箱浏览器）
- **T4-3 Visualize 工作流（角色模板接入运行时）**：`agent-core/index.js` rolePreset 接线——数字员工 `{systemPrompt, toolNames}` 拼进 system 提示并对 BASE_TOOLS 取白名单交集（空交集回落全量），`ecosystem/digital-employees.json` de-visualize 角色为首个样板；「角色模板=系统提示+工具子集+审批档」机制落地
- **T4-4 Deep Research 工作流**：`agent-core/index.js` deep_research 技能提示——澄清→计划→广度→深度→调和五阶段，基于 orchestrate_task 子任务树全程可见，报告落 `research/<slug>-report.md`（执行摘要/关键发现带出处/分歧与不确定性/编号引用列表）
- **T4-5 LaTeX 编译插件**：latex_compile / latex-doctor 技能模板接入运行时——Tectonic 首选（单命令、按需拉包）、系统 TeX Live（latexmk/xelatex）探测、中文文档强制 xelatex；工具链缺失时给可行动安装指引（brew install tectonic / MacTeX），禁止未见编译成功输出即宣称完成；PDF 产物进预览 tab
- **T4-6 Record-and-Replay**：`main/cuaRecorder.js`——AX 事件录制（sanitizeStep 丢弃 ref/depth、截图独立计数落盘）+ 回放三级节点匹配（role+name→path→位置就近≤40px）+ fail-closed 录制校验（版本/序号连续/参数完整）+ 敏感步骤复用 needsCUAConfirmation 逐次确认；数据仅存 `userData/recordings/`，删除级联清截图；`main.js` cua:replay/recordings:list/delete IPC；`renderer/src/components/RecordReplayPanel.tsx` 设置页面板（录制表单/回放审批档/事件时间线）
- **T4-7 Code Mode**：`main/codeProcess/{host,childEntry,registry}.js`——每对话一个持久 vm 上下文子进程（cell 语义：顶层声明跨 exec 保留；vm 超时掐停死循环但不杀进程=状态仍在；**有意不做透明重启**——状态丢失必须如实透出 codeDegraded）；`main/codeTools.js`——code_exec 工具（会话 Map + 30 分钟闲置回收 + restart 显式清状态 + saveImage 产物经 `mjpreview://` 回图片卡 + 大 stdout 走 T3-1 bigPayload 自动卸载）；`approval.js` isDangerousCode 双档——危险代码（child_process/exec/spawn/内嵌危险命令）判 L1 恒逐次不可豁免，普通代码 L3 可豁免、规则粒度=代码前缀（防短代码批准后长代码静默放行）；agent-core 三表 + main.js createToolHandlers + ToolTrace code_exec 卡全链路接线

### 变更（M4）
- browser/chrome/code 工具仅主会话注入（Worker/定时任务无审批通道语义，不允许触碰浏览器/执行代码）
- `web-todo-tools.test.js` 工具计数断言随能力演进 39→40；`package.json` test 链补注册 cua-recorder（修复 M4 期间套件未注册问题）与 code-mode 两套件

### 测试（M4）
- 新增 `browser-process.test.mjs`、`chrome-relay.test.mjs`、`role-preset.test.mjs`、`cua-recorder.test.mjs`(14)、`code-mode.test.mjs`(20)；真实 fork 子进程跑全 RPC 协议（exec 往返/cell 跨调用状态/saveImage 落盘/降级链不透明重启）+ 审批编排（fake 会话注入面）+ L1/L3 双档 + 接线静态断言
- 全量 83 套件：79 绿 + 4 套已知 better-sqlite3 DLOPEN 环境失败（memory/orchestrator/taskStore/workerPool，与改动无关）

### 修复（M4 真机验收发现的 T3-2 回归，2026-10-15）
- **i18n 真机全界面显示原始 key**：`renderer/src/i18n/index.ts` 曾用 `typeof import.meta.glob === 'function'` 做 Vite/Node 宿主判定——Vite 只在编译期替换 glob **调用点**，typeof 表达式原样留在产物中，而浏览器运行时 `import.meta.glob` 恒 undefined，真实应用误走空语言包分支（构建产物残留 4 处 typeof 判定可证）。改为「直接调用 + try/catch 兜底」（Vite 宿主替换后恒成功；非 Vite 宿主调用抛 TypeError 落 `globalThis.__MJ_I18N_PACKS__` 注入分支），PACKS 以「glob 是否拿到模块」判定宿主。单测恰因走 esbuild 注入分支而测不到此路径，属门禁盲区
- 门禁补强：`test/i18n.test.mjs` 新增第 5 项断言——剥注释后禁止 `typeof import.meta.glob` 反模式回流，并强制 glob 收集保持「调用 + try/catch」形态；修复后产物 typeof 残留 0、中文字符串确认已内联进主 chunk

### 新增（M3 里程碑：体验打磨 + 引擎驻留隔离，2026-10-15）
- **T3-1 大消息 IPC 可靠传输**：`main/bigPayload.js`——工具结果超 256KB 的顶层字段落盘 `userData/bigpayload/`，IPC 只传句柄 `{__bigStr/__bigJson, id, bytes}`，渲染层 `lib/bigPayload.ts` 按需分页拉取（128KB/页）+ ToolTrace 句柄分流虚拟滚动；句柄 TTL 30 分钟、run 结束即删、启动清残留、写失败降级原样透传（宁退旧行为不丢事件）。`main/previewScheme.js`——注册流式协议 `mjpreview://p/<token>`，≤24MB 媒体预览不再 base64 进 IPC 消息体，字节走 Chromium 网络栈；token 一次性随机、URL 不含路径、TTL 10 分钟
- **T3-7 agent-core 引擎独立子进程驻留**：`main/engineProcess/{host,childEntry,transport,registry}.js`——每个 run 一个 Electron `utilityProcess`（`--max-old-space-size=2048`），引擎经 childEntry 在子进程内跑 `runAgent`，工具调用经 RPC 回调主进程实现（依赖方向反转，零重写）；引擎崩溃/OOM 只杀子进程，主会话收到 `engineExited` 断点事件可「继续」恢复；utilityProcess 不可用时自动回退 in-process 路径（测试通道 + 生产降级链）；agentRunner 双路径接线
- **T3-6 Computer Use 高风险能力子进程化**：`main/cuaProcess/{host,childEntry,registry}.js`——cua 会话独立 utilityProcess（512MB 独立限额），osascript 调用 30s 超时视为失控即杀即重建；透明重启上限 1 次（原生调用无状态，重试安全），超限抛 `cuaDegraded` 走 error 事件降级提示，主会话不崩；修复重启竞态（旧子进程 exit 晚到误清新进程引用的身份守卫）
- **T3-2 i18n（仅 zh-CN + en-US）**：`renderer/src/i18n/index.ts` 零依赖轻量实现——`import.meta.glob` eager 收集语言包（按模块拆分 31 个 JSON×2）、`LanguageProvider` + `useI18n()` hook + `tGlobal()` 命令式通道、localStorage 持久化 + setState 热切换免重启、缺失回落 zh-CN、`{var}` 插值；30+ 组件全部文案抽取（约 1100 行裸中文进包）；设置页语言下拉；门禁 `test/i18n.test.mjs`（零裸中文扫描/zh-en key 双向一致/引用 key 存在/切换接线）+ `scripts/i18n-scan.mjs`（状态机剥注释 + `i18n-literal` 豁免）+ `scripts/i18n-modcheck.mjs`（单模块 key 与参数一致性）

### 变更（M3）
- 非 hook/顶层常量文案改存 key 渲染期求值（`MODE_OPTIONS`→`getModeOptions()`、MCP 连接态/更新态改状态码、Onboarding 测试结果显示结构改 `{ok,text}`、AgentDock 去中文字符串判断）；console 日志统一英文不进语言包
- 11 个受影响测试适配 i18n（render-smoke/message-meta/subtask-tree 改 globalThis 语言包注入 + wrapper entry 渲染模式；8 个静态断言测试两段式改「zh 包值 + key 引用」断言，契约语义不变）
- `renderer/src/env.d.ts` 补 vite/client 类型引用；`main.jsx` 挂 `LanguageProvider`（Provider>ErrorBoundary>App）

### 测试（M3）
- 新增 4 个测试文件 34 项断言：`big-payload.test.mjs`(15：卸载阈值/句柄生命周期/分页/降级透传/渲染消费链)、`engine-process.test.mjs`(8：全协议真实子进程/崩溃断点/降级回退/主进程接线)、`cua-process.test.mjs`(7：超时重建/透明重启/降级/通道登记)、`i18n.test.mjs`(4：门禁)；全部注册进 npm test 链

### 新增（M2 里程碑：工程可维护性 + 发布信任，2026-10-15）
- **T2-1 main.js 按域拆分（只搬移不改行为）**：3040 行 God File 降至 1101 行（≤1200 验收）——拆出 `ipc/{localData,ecosystem,plugins,project,mcp}.js`、`tools/exec.js`（shell/读写/预览/git 全工具层）、`lifecycle/window.js`、`updater/index.js`、`audit/auditLog.js`；模块经 `initXxx(deps)` 注入接线（沿用 orchestrator/memory 既有模式）
- **T2-2 ChatArea.jsx 组件拆分**：1809 行降至 442 行（≤600 验收）——拆出 `Composer.tsx`（输入区）、`MessageStream.tsx`（消息流域：窗口切片/智能滚底 useMessageWindow/轮次重放/本轮概览）、`WelcomePage.tsx`（欢迎页）、`hooks/useAgentRun.ts`（发送/中止/引导/排队/压缩全流程）、`lib/runRegistry.ts`、`lib/chatHelpers.ts`；欢迎页与对话页共享 composerProps 接线
- **T2-3 God File 门禁**：eslint `max-lines` error >1500（存量两个 >1500 文件进豁免清单）+ `test/max-lines.test.js` 800 行基线清单只减不增；顺带补注册 M1 遗漏的 subagent-events/subtask-tree 两套件进 test 链
- **T2-5 本地崩溃/异常聚合**：`main/diagnostics.js`——主进程 uncaughtException/unhandledRejection 结构化 JSONL（`userData/diagnostics/crash-YYYYMMDD.jsonl`，含 stack + 活跃 runId + trace 尾部）；渲染层 window error/unhandledrejection 经 preload `diagReport` 转发同一文件；Electron crashReporter 本地 dump（uploadToServer:false）；写失败绝不二次抛出
- **T2-6 诊断包一键导出**：设置 → 账户与更新 →「问题诊断」→ 导出 zip（审计/崩溃/trace/主进程日志/脱敏配置）；`zipStore.js` 零依赖 store-method ZIP；`diagExport.js` 递归剔除 api_key/keyEncrypted/env/headers/authorization——会话与消息正文不进包；测试用假密钥全包 grep 断言零泄漏
- **T2-7 更新失败可诊断文案**：`classifyUpdateError` 五类归因（断网/包校验失败/更新源缺失/安装前置失败/未知），error 事件与手动检查返回均附 kind+hint，设置页展示；校验失败绝不静默并指向手动下载官方包；《docs/签名公证更新演练Runbook.md》沉淀 macOS 公证配置片段、Windows 签名方案（Azure Trusted Signing/EV）、0.x→0.x+1 真机演练步骤与异常场景清单
- **T2-4 .bak 清理与防再入**：删除 `main.js.deprecated.bak`、`ApprovalDialog.jsx.deprecated.bak`；.gitignore 收紧 `*.bak`/`*.deprecated*`；CI verify 首步 git ls-files 检查（绕过 .gitignore 的 force-add 也会被拒）

### 变更（M2）
- 渲染层新文件按 T0-3 门禁全部 `.tsx/.ts`（存量代码原样搬移期以 @ts-nocheck 过渡，文件头注明后续补类型）；`contract.d.mts` 修复非法 `interface {} | {}` 声明（新 .ts import 链拉入 tsc 才暴露）
- 大量测试静态断言随实现重定向（degrade/release-update/settings-coverage/thread-composer/project-switch/plan-worktree-context/run-footer-restore/plugin-bypass-hardening），契约语义不变、断言随实现走

### 测试（M2）
- 新增 4 个测试文件 22 项断言：`max-lines.test.js`(3)、`diagnostics.test.mjs`(7)、`diag-export.test.mjs`(6)、`updater-errors.test.mjs`(6)；全部注册进 npm test 链

### 新增（M1 里程碑：过程可信度，2026-10-15）
- **T1-1 工具轨迹语义化渲染**：新增 `components/tools/ToolTrace.tsx`——12 类工具按型渲染卡片（edit_file/apply_patch 内联迷你 diff、shell 折叠输出+退出码徽标、read_file/list_dir/glob 路径 chip、web_search 来源链接、git_* 状态徽标、spawn_subagent 预算/结论），失败原因恒显、无需展开；废除参数 JSON.stringify 裸截断
- **T1-2 轨迹按轮次分组**：对话按「第 N 轮」分组渲染（RoundBlock），当前轮默认展开、历史轮折叠为一行摘要；同轮多工具调用经 `ToolTraceGroup` 并列，兼容窗口切片（effStart 回退）不切断 tool_calls 与结果配对
- **T1-3 子代理事件透出**：`spawn_subagent`（引擎侧 spawn/progress/done/failed + tokens/结论/耗时）与 `orchestrate_task`（编排侧逐任务状态 diff 轮询上报）统一经 IPC 契约 `subagent` 事件到渲染层；契约登记表扩至 8 类事件
- **T1-4 子任务树/DAG 可视化**：右栏新增「子任务」tab——`SubtaskTree.tsx` 按 dependsOn 分层建 DAG（上游在上、同层并行）、节点状态色（待运行/运行中/完成/失败）、tokens 角标、点击就地展开结论摘要（非模态）；spawn 事件透出 dependsOn 依赖边；事件按会话分桶存储，后台会话切回仍可见
- **T1-5 本轮概览与思考流打磨**：RunFooter 升级为 live/summary 双态「本轮概览」卡（运行中实时展示耗时/本轮 tokens 消耗/上下文用量/模型，每秒刷新）；思考流改 Markdown 渐进渲染并移除「（N 字，点击折叠）」文案；统一加载态（spinner + 文案）
- **T1-6 验收清单**：新增《MJCode-M1手工验收清单-2026-10-15.md》（六批次 18 项，均带操作/期望/代码依据）

### 变更（M1）
- 编排 diff 逻辑抽为 `invoke.js` 导出的纯函数 `diffGroupEvents`（可单测：状态机映射 + 幂等去重 + 首帧终态补发）；`waitGroupSettled` 支持 `pollIntervalMs` 注入
- `workerPool` 任务结果新增 `tokensUsed` 字段（子任务节点角标数据源），并以 onMessage 累计 usage
- 渲染层 Tailwind content 扫描补 `ts/tsx`（修复 .tsx 新文件类名不进产物的问题）；测试管线 esbuild loader 补 `.tsx`

### 测试（M1）
- 新增 2 个测试文件 25 项断言：`subagent-events.test.mjs`(19：引擎事件序列/预算 failed/轮询时序/diff 状态机)、`subtask-tree.test.mjs`(6：空态/分层/合并/单代理归并/DAG 顺序)；`ipc-contract.test.mjs` 扩至 29 项（+5 subagent 用例）；`message-meta.test.mjs` 扩至 9 项（+RunFooter live 双态）；`run-footer-restore`/`project-switch` 断言更新至 T1 新实现（契约语义不变）

### 新增（M0 里程碑：工程诚实性 + 卡死防线，2026-10-15）
- **T0-4 wall-clock 看门狗**：引擎单轮模型调用（默认 120s，含重试链）与每个工具执行（默认 120s；shell 10min、web 60s、子代理/编排按自身预算放宽）新增超时硬顶——半开连接/僵死子进程不再让「跑到一半卡住」；工具超时计入重复失败熔断，模型超时如实终止并带明确原因（`agent-core` 导出 `withTimeout`/`TOOL_TIMEOUT_OVERRIDES`，超时均可配置）
- **T0-5 本地结构化运行 trace**：引擎透出 `run_start/model/model_error/tool/run_end` 事件（含逐轮耗时与用量），主进程落 `userData/traces/<runId>.jsonl`（不上报，文件级 LRU 保留 50 次运行）；run_end 双出口闭合（正常收尾/熔断/异常终止均有尾事件）
- **T0-2 IPC/Agent 边界契约**：新增 `shared-ipc/contract.mjs`（zod，主渲染单一事实来源）——agent:run 启动载荷 fail-closed 校验（缺 messages/扁平 model 直接拒绝并给出期望形状）、agent:event 七类事件逐型校验；主进程发送前非法载荷降级为同 runId 的 error 事件（绝不静默丢弃），渲染层接收前二次校验
- **T0-3 渐进 TS 门禁**：desktop 根新增 `npm run typecheck`（renderer tsc --noEmit，当前 0 error，CI 既有门禁）；新增 `no-new-jsx` 基线测试——渲染层 37 个 .jsx + 13 个 .js 冻结，新文件强制 `.ts/.tsx`，存量只减不增

### 变更（M0）
- **T0-1 README 技术栈如实表述**：中英双语 README 明确「UI 组件层 JavaScript(JSX)、IPC/Agent 边界契约 TypeScript + zod」，移除与实际不符的表述与过期测试套数

### 测试
- 新增 4 个测试文件共 49 项断言：`agent-watchdog.test.mjs`(18)、`runTrace.test.js`(5)、`ipc-contract.test.mjs`(22)、`no-new-jsx.test.js`(4)；`agentRunner.test.js` 扩至 23 项（+契约拒绝/事件降级用例）；既有引擎回归 87/40/10/23/18 全绿不受影响

### 计划中（V1.1+）
- Ask 模式（闲聊与写操作分离，常驻工具过滤）
- `/init` 生成 AGENTS.md + 全局个人指令层（`~/.mjcode/AGENTS.md`）
- 内置 web 搜索工具（默认启用 fetch MCP 预设）
- 服务端归档 API（统一本地/在线删除语义）
- 结构化日志（JSON + trace_id）与本地用量报表
- MCP HTTP/SSE transport、自身作为 MCP server 暴露

## [1.0.0] - 2026-10-13

首个开源发布版本。本地优先 AI 编码工作台：Agent 主链路（工具循环 + 审批分级 + 沙箱隔离）、
定时任务 Agent 化、GitHub PR 最小闭环、跨平台安全兜底与完整发布基建。

### 安全与稳定性
- 模型调用重试：429/5xx/网络类错误指数退避重试（最多 3 次），瞬时故障不再摧毁整轮任务
- 沙箱 fail-safe：未显式指定策略时默认 read-only；无项目目录时强制只读并明示
- 本地审计：未登录服务端时 shell/写文件/MCP/审批放行全部落盘 `userData/audit-log.jsonl`（10MB 滚动）
- 跨平台兜底：非 macOS 无 OS 级沙箱时硬拦截危险命令（rm -rf / sudo / git push / 管道执行远程脚本等），审批不可绕过；设置页明示「非 OS 级隔离」
- 审批规则收紧：L1 危险命令不接受「始终允许」豁免；规则匹配改前缀白名单，废除正则子串（防 `pnpm test && rm -rf /` 夹带）
- 定时任务执行通道升级为完整 Agent（工具循环 + auto-safe 审批 + 沙箱 + 墙钟超时 + 并发互斥）
- 本地数据韧性：local-data.json 损坏先 .bak 恢复、按日副本保留 7 天、schemaVersion 迁移链，不再静默重置丢数据
- MCP 配置出口剥离 env，用户配置的密钥不跨 IPC 进入渲染层

### Agent 引擎
- 上下文治理：压缩切点对齐完整轮边界（修复长会话 400）、双档阈值（70% 摘要 / 85% 激进裁剪并告知模型）、真实 usage 驱动估算
- 工具结果截断带标记（「已截断，共 X 字符」），对象结果逐字段裁剪保持 JSON 完整可解析
- 轮次预算 token 化：单段轮次 + 总轮次硬顶（120）双闸；token 预算超限先自动压缩续跑；续期指令旁路注入不污染会话历史
- 大任务自动拆分 + 分步确认；finish_reason=length 断点续跑

### 产品闭环
- 待审批状态闭环：审批挂起侧栏徽标可点，直达审批卡
- 401 登出闭环：token 失效自动回退登录页；设置页提供「退出登录」
- 切会话即时清空消息，消除旧会话串显与快速切换竞态
- 隔离工作区（worktree）收口：合并回主目录 / 提升为分支 / 清理工作区
- GitHub 最小闭环：diff 审查面板一键创建 PR（依赖本机 gh CLI 登录态）
- 在线模式隐藏未实现的归档入口，统一文案

### 发布基建
- publish 配置指向真实仓库 + channel latest；三平台 artifactName 含版本
- CI：tag 触发三平台 matrix 打包，签名以 secrets 条件启用（未配置自动跳过），制品名含 commit
- 更新链路：启动延迟 10s 自动检查（保持手动下载）；检查失败附手动下载链接；支持 MJ_UPDATE_CHANNEL=beta 灰度通道
- 测试门禁 29 个套件全绿；renderer typecheck 0 错误

[未发布]: https://github.com/jasonma1210/MJCode/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/jasonma1210/MJCode/releases/tag/v1.0.0
