# MJ Coder

> 本地优先的 AI 编码工作台 · 桌面端智能体助手（数据与本机执行留在本机；推理连接你自己的模型服务）
>
> English: [README.md](./README.md)

**MJ Coder** 是一款开源桌面应用，让你在本机与 AI 结对编程：它拥有完整的 Agent 执行引擎——模型可以读写你的项目文件、执行 Shell 命令、调用 Git 与 MCP 工具，在你审批监督下自主完成编码任务。所有对话、代码与凭证默认只留在你的电脑上：**数据保存在本机、执行在本机；推理需连接你自己的模型服务**（任意 OpenAI 兼容接口，含本机 Ollama 等）。

## 核心特性

- **🤖 完整 Agent 引擎** — 工具调用循环（模型 → 工具执行 → 结果回传 → 模型），支持大任务自动拆分、子代理并行、上下文自动压缩与轮次预算控制
- **三道安全闸** — 分级审批中心（危险命令 / 文件写入 / MCP 工具三级，危险命令与 MCP 工具永不自动放行）+ 沙箱（macOS / Linux 为操作系统级隔离，Windows 为命令级硬拦截，见下方分档说明）+ 本地审计日志全程留痕
- **📁 项目工作区** — 项目管理、文件树与文件预览、代码 diff 审查面板、Git 隔离工作区（worktree）与一键创建 PR
- **⚙️ 双模式模型** — 对接任意 OpenAI 兼容接口（DeepSeek / Qwen / MiniMax 等），本地自定义模型与全局共享模型自由切换，API Key 保存在主进程不进渲染层
- **⏰ 定时任务** — 本机定时调度，到点由完整 Agent 通道执行（含审批、沙箱与超时保护）；错过即标记、启动可补跑
- **🧩 插件生态** — 插件市场（MCP Server / 技能 / 提示词三类包，签名校验 + fail-closed 安装）、内置 100 个官方技能、MCP 工具接入
- **🖥️ Computer Use** — macOS 辅助功能（AX）结构化驱动桌面应用，敏感操作（支付 / 删除 / 发送）逐次人工确认
- **👥 协同编辑** — 基于 CRDT（Yjs）的会话线程、任务看板与审批流协同，本地先行、离线可用
- **📊 数据看板** — 对话数、Token 消耗、模型使用分布与活跃趋势一目了然
- **🎨 个性换肤** — 5 套预设主题 + 强调色自定义，明暗模式随心切换

## 安全模型与沙箱能力分档

三道安全闸均为 **fail-closed** 设计（判定不确定时按更严格的一侧处理），且规则集单一事实来源统一维护：
危险命令模式在 `desktop/main/dangerousPatterns.js`，不可信内容检测在 `desktop/shared/untrustedContent.mjs`
（主进程安装闸门与 headless 引擎四类入口共用同一份），审批层与沙箱层同源引用，从结构上避免规则漂移。

| 闸门 | 机制 | 覆盖平台 |
|---|---|---|
| 分级审批中心 | L1 危险命令 / L2 文件写入 / L3 MCP 工具三级判定；L1 与 L3 在任何审批档位下都弹卡确认，不可经「本对话同类」规则静默放行 | 全平台 |
| 沙箱隔离 | 见下方分档 | 分平台 |
| 本地审计日志 | 工具调用、插件安装、审批决策全程落盘，可追溯 | 全平台 |

### MCP 能力边界：tools profile

MJ Coder 是**只实现 tools profile 的 MCP 客户端**——只消费 `tools/list` 与 `tools/call`。资源浏览
（`resources/list` / `resources/read`）、提示词模板、任务原语、反向采样（`sampling` / `elicitation`）
**均不支持**，在协议要求作答处以 `-32601` 显式拒绝。**上述能力不得在文档、UI 文案与市场材料里被
暗示为已实现。**

结构化输出（`tools/call` 的 `outputSchema` / `structuredContent`）**同样尚未消费**。与上段不同，
它落在 tools 规范**之内**而非 tools profile 之外，因此按**未修缺陷**跟踪，而不是声明为范围之外：
依赖它的工具仍可调用，但其返回结果的结构化形态会被丢弃。

### 沙箱能力按平台分档

三平台的能力水位**并不相同**，下表如实标注各自实际实现与就绪条件，不做跨平台对等承诺：
macOS / Linux 提供操作系统级隔离，**Windows 仅有命令级防护**。
命令黑名单不是主力，而是 OS 沙箱**不可用时的兜底**——OS 级隔离一旦生效，黑名单自动让位，避免误伤
`rm -rf ./build` 这类项目内的合理命令。

| 平台 | 隔离水位 | 实现 | 就绪条件 |
|---|---|---|---|
| macOS | **操作系统级（开箱即用）** | Seatbelt（`sandbox-exec` + 生成 profile）：`deny default` + curated 平台策略 + 按 read-only / workspace-write / full-access 三档限制文件写入，全档禁网；可写区内的 `.git`（含 gitdir）与应用配置目录**追加 deny 压为只读**；启动前做**真实可用性探测**（`sandbox-exec` 存在 ≠ 能 apply） | 开箱即用（`≥10.15`） |
| Linux | **操作系统级（需安装）** | bubblewrap（`bwrap`）：`--ro-bind / /` 全盘只读、仅项目目录 `--bind` 可写、**可写区内 `.git`（含 gitdir）与应用配置目录再 `--ro-bind` 覆盖为只读**、`--unshare-all`（含 net/pid/ipc/uts/cgroup）、`--tmpfs /tmp`、`--die-with-parent`、`--new-session` | 装 sandbox：`apt install bubblewrap` / `dnf install bubblewrap` |
| Windows | **命令级防护（默认）** | 命令守卫 + 分级审批：30 条危险命令模式执行前硬拦截，审批不能绕过或豁免 | 开箱即用；**本平台尚未提供 OS 级隔离入口**（见下） |

#### Windows：OS 级隔离未接线

Windows 的 OS 级隔离后端代码存在（`desktop/main/sandboxWindows.js`：受限专用用户 + 定向工作区
ACL + 出站防火墙），**但未接入执行链路——没有任何入口会执行一次性管理员设置，Windows 用户
当前不会获得 OS 级隔离**。实际保护 Windows 用户的是命令级守卫 + 分级审批中心（fail-closed：
判定不确定时按更严格的一侧处理）。接线工作（含设置入口、read-only 与 workspace-write 分档、
`.git` / `.mjcode` carve-out）列为平台适配项，落地后本文档同步更新；在落地前，Windows 行不以
任何形式宣称 OS 级隔离。

#### 沙箱能力的如实说明

- **Linux 当前不含 seccomp 系统调用过滤**。原实现传入的 `--seccomp 9` 依赖 fd 传递，而 `execFile` 在 exec 前会关闭全部非 stdio fd（子进程只有 0/1/2），该 fd 根本不存在，bwrap 启动即失败。现已移除该参数，隔离由 `--unshare-all`（命名空间 + 断网）与全盘只读 bind 提供；系统调用过滤列为后续增量（届时应改走 `spawn` + 显式 stdio）。
- **Windows 的 OS 级隔离后端未接线**（详见上一节）：不存在管理员设置入口，也不宣称该能力；Windows 的防护 = 命令守卫 + 分级审批。

#### 可写区内的只读 carve-out（项目目录里的「禁写区」）

workspace-write 档把**整个项目目录**设为可写，但其中有两处即使位于项目内也不允许写入：

| 受保护路径 | 为什么 |
|---|---|
| `.git`（含 worktree / submodule 解析出的 `gitdir`） | 改写 `.git/hooks/pre-commit` 后，**你下次手动 `git commit` 就会执行被注入的代码**——沙箱只约束 Agent 当前进程，约束不了你之后自己敲的命令。这是从沙箱内逃到沙箱外的既成路径，与漏洞无关 |
| 项目内存在的应用配置目录（`.mjcode`） | 改写它等于让 Agent 调整自己的治理参数 |

实现方式与 Codex 一致：Linux 侧在 `--bind` 之后对这些路径追加 `--ro-bind`（后挂载覆盖先挂载），macOS 侧在 `allow file-write*` 之后追加 `deny file-write*`（Seatbelt 后匹配优先）。
**写工具（write_file / edit_file / apply_patch）同样受该保护约束，且不接受审批放行**——否则把 shell 堵住、却被写工具绕开，保护等于不存在。唯一例外是显式选择的 `full-access` 档（该档语义即「不做隔离」）。

注意边界：`.gitignore`、`.gitmodules` 等「以 `.git` 开头的普通文件」**不在**保护范围内（保护按路径包含判定，只覆盖 `.git` 本身及其内容）。

未满足就绪条件时（未装 bwrap、容器内禁用 user namespace 等），受限档位
（`read-only` / `workspace-write`）**默认阻断执行**——不再「黑名单过滤后裸跑」，因为黑名单是提示分类器、
不是安全边界。两条显式逃生口，且都不会被记录为「已隔离」：

1. 当场弹一次非沙箱执行审批（L1）：用户显式批准**本次**执行，决策不沉淀为任何规则；批准后仍过命令守卫；
2. 开发态环境变量 `MJCODE_ALLOW_UNCONFINED_FALLBACK=1`：显式豁免单次审批（仍过命令守卫）。

`full-access` 档按设计不套沙箱、不走命令守卫——它是显式 opt-in，默认策略已被 fail-safe 兜住。

#### 已如实记录的已知局限

- **Windows**：仅有命令级防护，OS 级隔离未接线（见「Windows：OS 级隔离未接线」一节）。
- **Linux**：容器内（Docker 默认配置）可能禁用 unprivileged user namespace，此时 bwrap 存在也不可用；
  本项目只做二进制存在性静态探测，运行时失败由 exec 错误路径捕获并按上述默认阻断处理。
- **三平台共通**：`full-access` 档不提供任何隔离，也不应用可写区 carve-out（该档语义即 opt-in 全放开）。

各后端的设计依据与取舍逐条记录在 `desktop/main/sandbox.js`、`sandboxLinux.js`、`sandboxWindows.js`
顶部注释中；跨平台行为有 `desktop/test/sandbox-crossplatform.test.js` 守护。
其中 Linux/Windows 的**真机行为**需在对应平台执行才能确认，非 Linux 环境下该套件会明确打印
「本节未执行」，其 PASS 不代表该平台沙箱已验证。

## 模块构成

| 模块 | 说明 |
|---|---|
| `desktop/` | Electron 桌面应用：主进程（安全/沙箱/工具执行）+ React 渲染层（UI）+ agent-core（headless 引擎） |
| `server/` | 可选的 Node.js 服务端：账号体系、云端任务队列、协同同步、数据看板 |
| `miniprogram/` | 可选的微信小程序控制面：查看任务、远程审批（不执行任何代码） |
| `ecosystem/` | 生态资产：**100 个技能、77 个 MCP 连接器、51 个数字员工角色模板 = 228**（数字由 `desktop/scripts/gen-ecosystem-counts.mjs` 从源码现算，并由 `desktop/test/ecosystem-counts.test.mjs` 守护）。77 个连接器收敛为「装得上/可按官方规范填凭证」的主流服务，其余场景走「自定义连接器」。另有 `mcp-connectors-workbuddy.json` 的 **214 条原始导入清单**，与精选 77 条**零重叠**（两套独立命名空间，运行时不合并去重），故**不计入 228**。51 个数字员工**角色模板**已接入 Agent 运行时，形态是**线程级、单角色预设**：在生态中心「招募」后即取回该角色的运行时预设（`ecosystem:employeeRuntime`），此后每轮对话都以 `rolePreset` 携带进 `agent:run`，主进程再把审批档与沙箱策略按「角色声明与用户设置中更严格者」收紧——角色只能收紧权限、不能放宽。范围如实说明：这是**把单个角色预设接进单个会话**，**不是**多员工编排（没有调度器，也没有员工间委派） |

> 完整的目录结构与职责说明见仓库内 `docs/` 目录（不随代码发布）。

## 技术栈

- **桌面端**：Electron 33 · React 18 · Vite · Tailwind CSS；UI 组件层为 JavaScript（JSX），**IPC / Agent 边界契约为 TypeScript + zod 运行时校验**（渐进迁移中，新边界文件强制 `.ts`）
- **引擎**：原生 JavaScript（零框架、零运行时依赖的 headless Agent 引擎，独立子进程驻留改造见开发计划 T3-7）
- **服务端**（可选）：Node.js · Express · PostgreSQL · Yjs
- **测试**：Node 内置 test runner。三个数字含义不同，不可混用：**218** 个 `*.test.{js,mjs}` 文件 + **2** 个 smoke
  = **220** suite，另有 **1** 个 `eval:check` gate = `npm test` 共 **221** 个检查项。这是 **R7 基线（HEAD `e1e5fff`）
  的快照，不是常量**——每增删一个测试文件即变。最近一次全绿：2026-10-19（第六轮）；本轮未运行全量 `npm test`，
  勿据此推断当前状态。需要当前值时现算（`desktop/` 下）：`ls test/*.test.js test/*.test.mjs | wc -l` +
  `ls test/smoke-load.mjs test/render-smoke.mjs | wc -l` + `rg -c "label:" test/run-all.mjs`

## 快速开始

```bash
# 1. 安装依赖（首次）
cd desktop && npm install
cd renderer && npm install && cd ..

# 2. 启动
npm run dev
```

无需数据库、无需服务端、无需账号——启动即可在本地创建项目并开始对话。配置任意 OpenAI 兼容模型（Base URL + API Key）即可运行，全部数据保存在本机；推理需要该模型端点可达（本机 Ollama 等本地端点同样适用，可全程不联网）。

> 服务端（`server/`）、小程序（`miniprogram/`）为可选扩展，离线单机使用无需部署。

## 自动更新

- **macOS**：支持应用内更新。发布产物**同时包含 `.dmg`（手动安装）与 `.zip`（electron-updater 在 macOS 上消费的更新包）**；应用启动 10 秒后自动检查，随后可**应用内检查 → 下载（带进度）→ 重启安装**。更新 fail-closed：已开启 `verifyUpdateCodeSignature`，签名/摘要校验失败即拒绝安装并引导手动下载官方包。
- **Windows / Linux**：发布产物为 NSIS / AppImage 安装包，本应用**不提供**这两个平台的应用内自动更新——请前往 [GitHub Releases](https://github.com/jasonma1210/MJCoder/releases) 手动下载新版本。
- **回滚**：每个版本都保留在 Releases 页，降级始终是「手动下载旧版安装包」一件事；应用内更新链路不会剥夺此路径。

## 项目结构（简览）

```
MJCoder/
├── desktop/            # 桌面应用（主入口）
│   ├── main/           #   Electron 主进程：审批·沙箱·工具·调度·插件
│   ├── renderer/       #   React 渲染层：完整 UI
│   ├── agent-core/     #   headless Agent 引擎（CLI 可独立运行）
│   └── test/           #   测试套件（不随 GitHub 发布）
├── server/             # 可选服务端
├── miniprogram/        # 可选小程序控制面
└── ecosystem/          # 技能 / MCP / 数字员工生态资产
```

## 文档

- 使用与架构文档、审查报告等 Markdown 文档维护在本地 `docs/` 与根目录，不随 GitHub 代码发布
- 版本变更记录见本地 `CHANGELOG.md`

## 许可

本项目采用 [MIT 许可证](LICENSE)。你可以自由使用、修改、分发与商用本软件。

`ecosystem/` 下的 228 项生态资产（100 技能 / 77 MCP 连接器 / 51 数字员工角色模板）为本项目原创的
结构化定义，适用上述 MIT 许可；若某项资产需标注第三方许可，会在该资产内单独声明。

> 计数溯源（防止数字再漂回去）：100 = `ecosystem/skills/` 的一级子目录数；77 = `ecosystem/mcp-connectors.json`
> → `.connectors`（该文件**顶层是对象**，不是数组——直接 `JSON.parse(...).length` 会得 `undefined`）；
> 51 = `ecosystem/digital-employees.json`（顶层数组）。`ecosystem/mcp-connectors-workbuddy.json` → `.connectors`
> 是**另一份 214 条的原始导入清单**，与精选 77 条 **id 零重叠**，被刻意**排除**在 228 之外（两套独立命名空间，
> 非父子关系，运行时不合并、不去重）。可用 `node desktop/scripts/gen-ecosystem-counts.mjs` 重新生成。
