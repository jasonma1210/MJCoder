# MJ Coder

> 本地优先的 AI 编码工作台 · 桌面端智能体助手（离线可用）
>
> English: [README.en.md](./README.en.md)

**MJ Coder** 是一款开源桌面应用，让你在本机与 AI 结对编程：它拥有完整的 Agent 执行引擎——模型可以读写你的项目文件、执行 Shell 命令、调用 Git 与 MCP 工具，在你审批监督下自主完成编码任务。所有对话、代码与凭证默认只留在你的电脑上，**离线为主、本地优先**。

## 核心特性

- **🤖 完整 Agent 引擎** — 工具调用循环（模型 → 工具执行 → 结果回传 → 模型），支持大任务自动拆分、子代理并行、上下文自动压缩与轮次预算控制
- **三道安全闸** — 分级审批中心（危险命令 / 文件写入 / MCP 工具三级，危险命令与 MCP 工具永不自动放行）+ 沙箱（macOS 为操作系统级隔离，Windows / Linux 为命令级硬拦截，见下方分档说明）+ 本地审计日志全程留痕
- **📁 项目工作区** — 项目管理、文件树与文件预览、代码 diff 审查面板、Git 隔离工作区（worktree）与一键创建 PR
- **⚙️ 双模式模型** — 对接任意 OpenAI 兼容接口（DeepSeek / Qwen / MiniMax 等），本地自定义模型与全局共享模型自由切换，API Key 保存在主进程不进渲染层
- **⏰ 定时任务** — 离线可用的本地定时调度，到点由完整 Agent 通道执行（含审批、沙箱与超时保护）
- **🧩 插件生态** — 插件市场（MCP Server / 技能 / 提示词三类包，签名校验 + fail-closed 安装）、内置 100 个官方技能、MCP 工具接入
- **🖥️ Computer Use** — macOS 辅助功能（AX）结构化驱动桌面应用，敏感操作（支付 / 删除 / 发送）逐次人工确认
- **👥 协同编辑** — 基于 CRDT（Yjs）的会话线程、任务看板与审批流协同，本地先行、离线可用
- **📊 数据看板** — 对话数、Token 消耗、模型使用分布与活跃趋势一目了然
- **🎨 个性换肤** — 5 套预设主题 + 强调色自定义，明暗模式随心切换

## 安全模型与沙箱能力分档

三道安全闸均为 **fail-closed** 设计（判定不确定时按更严格的一侧处理），且规则集由
`desktop/main/dangerousPatterns.js` 与 `desktop/main/promptInjection.js` 作为唯一事实来源统一维护，
审批层与沙箱层同源引用，从结构上避免两侧规则漂移。

| 闸门 | 机制 | 覆盖平台 |
|---|---|---|
| 分级审批中心 | L1 危险命令 / L2 文件写入 / L3 MCP 工具三级判定；L1 与 L3 在任何审批档位下都弹卡确认，不可经「本对话同类」规则静默放行 | 全平台 |
| 沙箱隔离 | 见下方分档 | 分平台 |
| 本地审计日志 | 工具调用、插件安装、审批决策全程落盘，可追溯 | 全平台 |

### 沙箱能力按平台分档（重要）

| 平台 | 隔离级别 | 实现 |
|---|---|---|
| macOS | **操作系统级** | Seatbelt（`sandbox-exec`）profile 隔离，按 read-only / workspace-write / full-access 三档限制文件系统访问 |
| Windows / Linux | **命令级硬拦截** | 无 OS 级隔离。通过 30 条危险命令模式（含管道远程执行、`rm` 长选项、凭证外泄等）在执行前硬拦截；审批不可绕过、不可豁免 |

也就是说：**在 Windows / Linux 上，本项目的沙箱是「命令黑名单 + 审批」，不是操作系统级容器隔离。**
如果你需要 OS 级隔离，请仅在 macOS 上使用，或在自行评估风险后使用。

跨平台 OS 级沙箱（Linux Landlock / Windows AppContainer）在路线图上，尚未实现。
相关设计取舍记录在 `desktop/main/sandbox.js` 顶部注释中。

## 模块构成

| 模块 | 说明 |
|---|---|
| `desktop/` | Electron 桌面应用：主进程（安全/沙箱/工具执行）+ React 渲染层（UI）+ agent-core（headless 引擎） |
| `server/` | 可选的 Node.js 服务端：账号体系、云端任务队列、协同同步、数据看板 |
| `miniprogram/` | 可选的微信小程序控制面：查看任务、远程审批（不执行任何代码） |
| `ecosystem/` | 生态资产：100 个技能、100 个 MCP 连接器、50 个数字员工**角色模板**（结构化定义，当前未接入 Agent 运行时，仅作为可复用的角色提示词与工具权限模板库） |

> 完整的目录结构与职责说明见仓库内 `docs/` 目录（不随代码发布）。

## 技术栈

- **桌面端**：Electron 33 · React 18 · Vite · Tailwind CSS
- **引擎**：原生 JavaScript（零框架、零运行时依赖的 headless Agent 引擎）
- **服务端**（可选）：Node.js · Express · PostgreSQL · Yjs
- **测试**：Node 内置 test runner，52 套测试全绿

## 快速开始（离线）

```bash
# 1. 安装依赖（首次）
cd desktop && npm install
cd renderer && npm install && cd ..

# 2. 启动
npm run dev
```

无需数据库、无需服务端、无需账号——启动即可在本地创建项目并开始对话。配置任意 OpenAI 兼容模型（Base URL + API Key）即可运行，全部数据保存在本机。

> 服务端（`server/`）、小程序（`miniprogram/`）为可选扩展，离线单机使用无需部署。

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

`ecosystem/` 下的 250 项生态资产（100 技能 / 100 MCP 连接器 / 50 数字员工角色模板）为本项目原创的
结构化定义，适用上述 MIT 许可；若某项资产需标注第三方许可，会在该资产内单独声明。
