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

### Sandbox capability by platform

**All three platforms now have OS-level isolation**, aligned with OpenAI Codex's published design.
The command blacklist is no longer the primary mechanism — it is the *fallback* when no OS sandbox is
available. Once OS-level isolation is active the blacklist steps aside, so legitimate in-project
commands such as `rm -rf ./build` are not falsely rejected.

| Platform | Isolation level | Implementation | Ready when |
|---|---|---|---|
| macOS | **OS-level** | Seatbelt (`sandbox-exec` + generated profile): `deny default` + curated macOS platform policy, three tiers (read-only / workspace-write / full-access) restricting writes, network denied at every tier | Works out of the box (`>= 10.15`) |
| Linux | **OS-level** | bubblewrap (`bwrap`): `--ro-bind / /` makes the whole disk read-only, only the project dir is `--bind`ed writable, `--unshare-all` (net/pid/ipc/uts/cgroup), `--tmpfs /tmp`, `--die-with-parent`, `--seccomp` | Install it: `apt install bubblewrap` / `dnf install bubblewrap` |
| Windows | **OS-level** | Restricted token + dedicated local user + targeted ACL + outbound firewall: commands run as the low-privilege `MJCodeSandboxOffline` user (`schtasks /RL LIMITED`), with all outbound traffic blocked by firewall rule | **Requires a one-time admin setup** (see below) |

When the prerequisites are not met (bwrap missing, Windows setup not done, user namespaces disabled in
a container, etc.), it automatically degrades to **command-level hard blocking**: 30 dangerous-command
patterns are blocked before execution, and approval cannot bypass or exempt them. The reason is logged,
e.g. `[sandbox] 未沙箱执行（bwrap 未安装…）policy=workspace-write`.

#### One-time Windows admin setup

The Windows backend must create a dedicated low-privilege user and firewall rules, which
**requires administrator rights**. All setup commands are first produced by `windowsSandboxPlan()`
for human review, then executed one by one; any failing step triggers rollback:

```powershell
# Run as Administrator. The password is randomly generated and stored DPAPI-encrypted —
# it never appears in plaintext in the command line or logs.
net user MJCodeSandboxOffline <RANDOM_PASSWORD> /add /passwordchg:no /passwordreq:yes /active:yes
net localgroup Users MJCodeSandboxOffline /delete
netsh advfirewall firewall add rule name=MJCodeSandbox_BlockOutbound dir=out action=block user=MJCodeSandboxOffline enable=yes
```

Rollback: `netsh advfirewall firewall delete rule name=MJCodeSandbox_BlockOutbound`, then delete the user.

#### Known limitations, honestly documented

- **Windows**: writes to directories that grant write access to the *Everyone* SID cannot be blocked
  (world-writable folders). Mitigation: the workspace-write tier makes only the project directory
  writable and everything else read-only. This is the same limitation Codex acknowledges publicly.
- **Linux**: inside a container (default Docker configuration) unprivileged user namespaces may be
  disabled, in which case bwrap exists but cannot run. This project only probes for the binary's
  presence; runtime failures are caught by the exec error path and degraded.
- **All platforms**: the `full-access` tier intentionally applies neither sandbox nor command guard
  (it is explicit opt-in; the default policy is already fail-closed).

Design rationale and trade-offs for each backend are documented in the header comments of
`desktop/main/sandbox.js`, `sandboxLinux.js`, and `sandboxWindows.js`; cross-platform behavior is
guarded by `desktop/test/sandbox-crossplatform.test.js` (61 assertions).

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
