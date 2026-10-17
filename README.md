# MJ Coder

> Local-first AI coding workbench · Desktop agent assistant (your data and code execution stay on your machine; inference connects to your own model service)
>
> 中文版: [README.zh-CN.md](./README.zh-CN.md)

**MJ Coder** is an open-source desktop application for pair programming with AI on your own machine. It ships a complete Agent execution engine — the model can read and write your project files, run shell commands, and call Git and MCP tools to complete coding tasks autonomously under your approval and supervision. All conversations, code, and credentials stay on your computer by default: **your data and execution are local; inference requires a connection to your own model service** (any OpenAI-compatible endpoint, including a local one such as Ollama).

## Key Features

- **🤖 Complete Agent engine** — tool-calling loop (model → tool execution → results back to model), with automatic large-task decomposition, parallel sub-agents, context compaction, and turn-budget controls
- **🛡️ Three safety gates** — a tiered approval center (dangerous commands / file writes / MCP tools at three levels; dangerous commands and MCP tools are never auto-approved) + sandbox isolation (OS-level on macOS and Linux, command-level hard blocking on Windows — see the tiering table below) + a local audit log for full traceability
- **📁 Project workspaces** — project management, file tree & previews, code diff review panel, Git worktrees for isolation, and one-click PR creation
- **⚙️ Dual-mode models** — connect any OpenAI-compatible endpoint (DeepSeek / Qwen / MiniMax / etc.), freely switch between locally defined and globally shared models; API keys stay in the main process and never reach the renderer
- **⏰ Scheduled tasks** — local scheduler; tasks run through the full Agent channel at their due time (with approval, sandbox, and timeout protection); missed runs are flagged and can be caught up on next launch
- **🧩 Plugin ecosystem** — plugin marketplace (MCP servers / skills / prompt packs with signature verification and fail-closed installation), 100 built-in official skills, MCP tool integration
- **🖥️ Computer Use** — drive desktop apps via macOS Accessibility (AX) trees; sensitive actions (payment / delete / send) always require case-by-case confirmation
- **👥 Collaborative editing** — CRDT (Yjs)-based collaboration on conversation threads, task boards, and approval flows; local-first and offline-capable
- **📊 Analytics dashboard** — conversation counts, token consumption, model usage distribution, and activity trends at a glance
- **🎨 Theming** — 5 preset themes plus custom accent colors, with light/dark mode support

## Security Model & Sandbox Tiering

All three safety gates are **fail-closed** (when a verdict is uncertain, the stricter side wins).
Rule sets are maintained as a single source of truth: dangerous command patterns live in
`desktop/main/dangerousPatterns.js`, and untrusted-content detection lives in
`desktop/shared/untrustedContent.mjs` (shared by the main-process install gate and all four
headless-engine entry points). The approval layer and the sandbox layer reference the same module,
which structurally prevents them from drifting apart.

| Gate | Mechanism | Platforms |
|---|---|---|
| Tiered approval center | L1 dangerous commands / L2 file writes / L3 MCP tools. L1 and L3 always prompt for confirmation under any approval mode and cannot be silently allowed by a "same kind in this conversation" rule | All |
| Sandbox isolation | See tiering below | Per-platform |
| Local audit log | Tool calls, plugin installs, and approval decisions are all persisted and traceable | All |

### Sandbox capability by platform

**macOS and Linux provide OS-level isolation; Windows ships command-level protection only.**
The command blacklist is no longer the primary mechanism on OS-isolated platforms — it is the
*fallback* when no OS sandbox is available. Once OS-level isolation is active the blacklist steps
aside, so legitimate in-project commands such as `rm -rf ./build` are not falsely rejected.

| Platform | Isolation level | Implementation | Ready when |
|---|---|---|---|
| macOS | **OS-level** | Seatbelt (`sandbox-exec` + generated profile): `deny default` + curated macOS platform policy, three tiers (read-only / workspace-write / full-access) restricting writes, network denied at every tier | Works out of the box (`>= 10.15`) |
| Linux | **OS-level** | bubblewrap (`bwrap`): `--ro-bind / /` makes the whole disk read-only, only the project dir is `--bind`ed writable, `--unshare-all` (net/pid/ipc/uts/cgroup), `--tmpfs /tmp`, `--die-with-parent`, `--new-session` | Install it: `apt install bubblewrap` / `dnf install bubblewrap` |
| Windows | **Command-level (default)** | Command guard + tiered approval: 30 dangerous-command patterns are blocked before execution and cannot be bypassed or exempted by approval | Works out of the box; **OS-level isolation is not yet wired on this platform** (see below) |

When the prerequisites are not met (bwrap missing, user namespaces disabled in a container, etc.),
it automatically degrades to **command-level hard blocking**: 30 dangerous-command patterns are
blocked before execution, and approval cannot bypass or exempt them. The reason is logged,
e.g. `[sandbox] 未沙箱执行（bwrap 未安装…）policy=workspace-write`.

#### Windows: OS-level isolation is not yet wired

The OS-level Windows backend code exists (`desktop/main/sandboxWindows.js`: restricted token +
dedicated local user + targeted ACL + outbound firewall), but **it is not wired into the execution
path — there is no entry point that runs the one-time admin setup, so Windows users never receive
OS-level isolation today**. What actually protects Windows users is the command-level guard plus
the tiered approval center (fail-closed: uncertain verdicts take the stricter side). Wiring the
Windows backend — including a setup entry point, `read-only` vs `workspace-write` tiering, and the
`.git` / `.mjcode` carve-out — is tracked as platform work, not shipped behavior; this README will
be updated when it lands.

#### Known limitations, honestly documented

- **Linux**: inside a container (default Docker configuration) unprivileged user namespaces may be
  disabled, in which case bwrap exists but cannot run. This project only probes for the binary's
  presence; runtime failures are caught by the exec error path and degraded.
- **All platforms**: the `full-access` tier intentionally applies neither sandbox nor command guard
  (it is explicit opt-in; the default policy is already fail-closed).
- **Windows**: OS-level isolation is not yet wired (see above) — protection is command-level only.

Design rationale and trade-offs for each backend are documented in the header comments of
`desktop/main/sandbox.js`, `sandboxLinux.js`, and `sandboxWindows.js`; cross-platform behavior is
guarded by `desktop/test/sandbox-crossplatform.test.js` (61 assertions).

## Modules

| Module | Description |
|---|---|
| `desktop/` | Electron desktop app: main process (security / sandbox / tools) + React renderer (UI) + agent-core (headless engine) |
| `server/` | Optional Node.js backend: accounts, cloud task queue, collaboration sync, analytics |
| `miniprogram/` | Optional WeChat mini-program control plane: view tasks, remote approvals (executes no code) |
| `ecosystem/` | Ecosystem assets: 100 skills, **80 MCP connectors** (curated to mainstream services that either install-and-connect or declare their credentials per the official spec; anything else goes through "Custom connector"), 50 digital-employee **role templates** (structured definitions; not yet wired into the Agent runtime — currently a reusable library of role prompts and tool-permission templates) |

> Full directory structure and responsibilities are documented under `docs/` (not published with the code).

## Tech Stack

- **Desktop**: Electron 33 · React 18 · Vite · Tailwind CSS; UI component layer is plain JavaScript (JSX), while **IPC / Agent boundary contracts are TypeScript with zod runtime validation** (progressive migration; new boundary files must be `.ts`)
- **Engine**: plain JavaScript (headless Agent engine with zero framework and zero runtime dependencies)
- **Server** (optional): Node.js · Express · PostgreSQL · Yjs
- **Testing**: Node built-in test runner, all suites green (see `desktop/test/` for the current count)

## Quick Start

```bash
# 1. Install dependencies (first time)
cd desktop && npm install
cd renderer && npm install && cd ..

# 2. Launch
npm run dev
```

No database, no server, no account required — create a local project and start chatting right away. Configure any OpenAI-compatible model (Base URL + API Key) and you are set; all data is stored locally. Inference needs that model endpoint to be reachable (a local one such as Ollama keeps everything offline).

> The server (`server/`) and mini-program (`miniprogram/`) are optional extensions; no deployment is needed for standalone offline use.

## Updates

- **macOS**: in-app update is fully supported. Releases ship **both `.dmg` (manual install) and `.zip`
  (the artifact `electron-updater` consumes on macOS)**; the app checks on launch (10s delay), then
  offers in-app **check → download (with progress) → restart to install**. Updates fail closed:
  `verifyUpdateCodeSignature` is enabled, so a failed signature/digest check refuses to install and
  points you to the manual download.
- **Windows / Linux**: releases ship NSIS / AppImage installers, and this app does **not** provide
  in-app auto-update on these platforms — download the new version manually from
  [GitHub Releases](https://github.com/jasonma1210/MJCoder/releases).
- **Rollback**: every release keeps its `.dmg` / installer on the Releases page, so downgrading is
  always a manual download away — the in-app path never removes access to older versions.

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

The 230 ecosystem assets in `ecosystem/` (100 skills / 80 MCP connectors / 50 digital-employee
role templates) are original structured definitions covered by the MIT license above; any asset
requiring third-party attribution declares it within the asset itself.

