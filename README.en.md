# MJ Coder

> Local-first AI coding workbench · Desktop agent assistant (offline-capable)
>
> 中文版: [README.md](./README.md)

**MJ Coder** is an open-source desktop application for pair programming with AI on your own machine. It ships a complete Agent execution engine — the model can read and write your project files, run shell commands, and call Git and MCP tools to complete coding tasks autonomously under your approval and supervision. All conversations, code, and credentials stay on your computer by default — **offline-first, local-first**.

## Key Features

- **🤖 Complete Agent engine** — tool-calling loop (model → tool execution → results back to model), with automatic large-task decomposition, parallel sub-agents, context compaction, and turn-budget controls
- **🛡️ Three safety gates** — a tiered approval center (dangerous commands / file writes / MCP tools at three levels; dangerous commands and MCP tools are never auto-approved) + sandbox isolation (OS-level on macOS, command-level hard blocking on Windows / Linux — see the tiering table below) + a local audit log for full traceability
- **📁 Project workspaces** — project management, file tree & previews, code diff review panel, Git worktrees for isolation, and one-click PR creation
- **⚙️ Dual-mode models** — connect any OpenAI-compatible endpoint (DeepSeek / Qwen / MiniMax / etc.), freely switch between locally defined and globally shared models; API keys stay in the main process and never reach the renderer
- **⏰ Scheduled tasks** — offline local scheduler; tasks run through the full Agent channel at their due time (with approval, sandbox, and timeout protection)
- **🧩 Plugin ecosystem** — plugin marketplace (MCP servers / skills / prompt packs with signature verification and fail-closed installation), 100 built-in official skills, MCP tool integration
- **🖥️ Computer Use** — drive desktop apps via macOS Accessibility (AX) trees; sensitive actions (payment / delete / send) always require case-by-case confirmation
- **👥 Collaborative editing** — CRDT (Yjs)-based collaboration on conversation threads, task boards, and approval flows; local-first and offline-capable
- **📊 Analytics dashboard** — conversation counts, token consumption, model usage distribution, and activity trends at a glance
- **🎨 Theming** — 5 preset themes plus custom accent colors, with light/dark mode support

## Security Model & Sandbox Tiering

All three safety gates are **fail-closed** (when a verdict is uncertain, the stricter side wins).
Rule sets live in `desktop/main/dangerousPatterns.js` and `desktop/main/promptInjection.js` as the
single source of truth; the approval layer and the sandbox layer reference them from the same module,
which structurally prevents the two from drifting apart.

| Gate | Mechanism | Platforms |
|---|---|---|
| Tiered approval center | L1 dangerous commands / L2 file writes / L3 MCP tools. L1 and L3 always prompt for confirmation under any approval mode and cannot be silently allowed by a "same kind in this conversation" rule | All |
| Sandbox isolation | See tiering below | Per-platform |
| Local audit log | Tool calls, plugin installs, and approval decisions are all persisted and traceable | All |

### Sandbox capability by platform (important)

| Platform | Isolation level | Implementation |
|---|---|---|
| macOS | **OS-level** | Seatbelt (`sandbox-exec`) profile isolation, restricting filesystem access at three levels: read-only / workspace-write / full-access |
| Windows / Linux | **Command-level hard blocking** | No OS-level isolation. 30 dangerous-command patterns (including piped remote execution, `rm` long options, credential exfiltration, etc.) are hard-blocked before execution; approval cannot be bypassed or exempted |

In other words: **on Windows / Linux this project's sandbox is a "command blacklist + approval", not an OS-level container isolation.**
If you need OS-level isolation, use it on macOS only, or proceed after assessing the risk yourself.

Cross-platform OS-level sandboxing (Linux Landlock / Windows AppContainer) is on the roadmap but not yet implemented.
The relevant design trade-offs are documented at the top of `desktop/main/sandbox.js`.

## Modules

| Module | Description |
|---|---|
| `desktop/` | Electron desktop app: main process (security / sandbox / tools) + React renderer (UI) + agent-core (headless engine) |
| `server/` | Optional Node.js backend: accounts, cloud task queue, collaboration sync, analytics |
| `miniprogram/` | Optional WeChat mini-program control plane: view tasks, remote approvals (executes no code) |
| `ecosystem/` | Ecosystem assets: 100 skills, 100 MCP connectors, 50 digital-employee **role templates** (structured definitions; not yet wired into the Agent runtime — currently a reusable library of role prompts and tool-permission templates) |

> Full directory structure and responsibilities are documented under `docs/` (not published with the code).

## Tech Stack

- **Desktop**: Electron 33 · React 18 · Vite · Tailwind CSS
- **Engine**: plain JavaScript (headless Agent engine with zero framework and zero runtime dependencies)
- **Server** (optional): Node.js · Express · PostgreSQL · Yjs
- **Testing**: Node built-in test runner, 35 suites all green

## Quick Start (Offline)

```bash
# 1. Install dependencies (first time)
cd desktop && npm install
cd renderer && npm install && cd ..

# 2. Launch
npm run dev
```

No database, no server, no account required — create a local project and start chatting right away. Configure any OpenAI-compatible model (Base URL + API Key) and you are set; all data is stored locally.

> The server (`server/`) and mini-program (`miniprogram/`) are optional extensions; no deployment is needed for standalone offline use.

## Project Layout (Overview)

```
MJCoder/
├── desktop/            # Desktop app (main entry)
│   ├── main/           #   Electron main process: approvals · sandbox · tools · scheduler · plugins
│   ├── renderer/       #   React renderer: full UI
│   ├── agent-core/     #   Headless Agent engine (runs standalone as a CLI)
│   └── test/           #   Test suites (not published to GitHub)
├── server/             # Optional backend
├── miniprogram/        # Optional mini-program control plane
└── ecosystem/          # Skills / MCP / digital-employee ecosystem assets
```

## Documentation

- Architecture docs and review reports live in local `docs/` and the repository root; they are not published with the code on GitHub
- Release history is kept in the local `CHANGELOG.md`

## License

This project is licensed under the [MIT License](LICENSE). You are free to use, modify,
distribute, and use commercially.

The 250 ecosystem assets in `ecosystem/` (100 skills / 100 MCP connectors / 50 digital-employee
role templates) are original structured definitions covered by the MIT license above; any asset
requiring third-party attribution declares it within the asset itself.
