# Aurora — AI-powered agentic code editor

<div align="center">

[![Version](https://img.shields.io/badge/version-2.0.0-blue)](https://github.com/Aurora-LABS-Ai/aurora-ide)
[![License](https://img.shields.io/badge/license-Source%20Available-8b5cf6)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-orange)](https://tauri.app)
[![React](https://img.shields.io/badge/React-18-cyan)](https://react.dev)

**Desktop IDE (Tauri + React) with a Rust agent runtime, tool execution, MCP, Git, a tree-sitter code index, and a conversation-first Agent Window.**

</div>

<br/>

<div align="center">

![Agent mode: tools and timeline in the loop](public/showcase/agent-in-loop.png)

*Agent mode — the assistant drives edit-test-refine loops while tool calls (file reads, patches, shell, MCP, browser) stream in real time beside the workspace.*

</div>

---

## Overview

**Aurora** is a desktop agentic code editor: a VS Code–style IDE (Monaco, explorer, terminal, Git) plus a dedicated **Agent Window** where you chat, review diffs, open Canvas artifacts, and watch the agent work. The Rust backend owns provider streaming, the agent turn loop, persistence, checkpoints, MCP, the code index, and most native tools. State lives in SQLite under the app data directory.

<div align="center">

![Default workspace layout](public/showcase/default-look.png)

*Main IDE — explorer, Monaco with native tabs, integrated PTY terminal, and themed panels driven by a single CSS-variable token system.*

</div>

### Two surfaces

| Surface | Route / entry | Purpose |
|---------|---------------|---------|
| **Main IDE** | Default app window | Full editor workflow: tabs, terminal, Git, settings, checkpoints |
| **Agent Window** | `/agent-window` (standalone Tauri window) | Conversation-first workspace: left rail (projects + chats), center transcript, right dock (Review, Canvas, Files, Browser, Terminal) |

The Agent Window has its own theme tokens (`--agw-*`), settings, and stores under `src/apps/agent/`. The main IDE and Agent Window hand off files through `agent_open_in_ide` when you want to edit in Monaco.

### Highlights

- **Rust agent runtime** — Turn loop, streaming, session persistence, and recovery live in `src-tauri/src/agent_runtime/`. The frontend subscribes to runtime events via `agent-runtime-client.ts` and executes bridged tools (MCP, browser, team UI, artifacts).
- **Rust provider kernel** — All LLM requests go through Rust (`aurora_provider_stream`, preset catalog, local-model detection). No per-provider TypeScript implementations.
- **Execution modes** — **Agent** (full tools), **Plan** (read-only + safe shell), **Team** (Lead mode with parallel worker agents).
- **Tools** — Native file, workspace, shell, editor, search, todo, skills, browser, artifact, and team tools; plus dynamic `mcp_{serverId}_{toolName}` tools from connected MCP servers. Per-tool approval: auto / always-ask / deny.
- **Canvas artifacts** — Agents can present versioned HTML, SVG, Markdown, or Mermaid diagrams in the right-rail Canvas (`present_artifact`, `read_artifact`).
- **Agent Team** — Optional multi-agent runs: Lead dispatches parallel workers, monitors progress, and steers via team chat while you keep talking.
- **MCP** — Stdio and SSE transports; auto-start servers; tool prefix `mcp_{serverId}_{toolName}`.
- **Code index** — tree-sitter structural index (`src-tauri/src/code_index/`): definitions, usages, outlines and a `<repo_map>` orientation block, behind the `code` tool, alongside ripgrep-backed grep.
- **Browser tools** — Native Tauri WebView windows the agent can navigate, click, evaluate, inspect, and screenshot.
- **Speech input** — Local Qwen3-ASR transcription in Rust (CPU by default; optional CUDA build).
- **Prompt refine** — Optional local llama.cpp pass to rewrite composer text before sending.
- **Project workflow** — Git panel, per-message workspace checkpoints (git CLI shadow repo), per-file undo/redo, skills catalog, detachable Agent Window.
- **Models** — Built-in presets: Fireworks, GLM, Anthropic, MiniMax, DeepSeek, OpenAI, OpenAI Responses, Kenari, LM Studio, Ollama, custom — plus frontend-integrated Codex (ChatGPT subscription), Atlas Cloud, and AgentRouter. Reasoning/thinking blocks wired where the provider supports them.

### Built-in browser inspector

The agent can open real WebView windows. Element picker, computed styles, console logs, and DOM snapshots flow back as structured tool results.

<div align="center">

![Built-in browser inspector](public/showcase/built-in-browser-inspector.png)

*Browser inspector — pick elements, read attributes and styles, evaluate JavaScript, and capture the DOM without leaving the IDE.*

</div>

---

## Tech stack

| Layer | Stack |
|--------|--------|
| **UI** | React 18.3, TypeScript 5.9, Vite 8, Tailwind, Monaco, Zustand 5, Framer Motion, Lucide, XTerm.js, Shiki, Mermaid |
| **Agent UI** | `src/apps/agent/` — isolated theme, 3-zone shell, Canvas, team screen, command center |
| **Desktop** | Tauri 2, Rust 2021, rusqlite, tokio, reqwest, rmcp (MCP), tiktoken-rs, tauri-plugin-pty |
| **AI backend** | Rust provider kernel, `agent_runtime`, context engine (legacy turn storage), Qwen3-ASR, `code_index` (tree-sitter), aurora_websearch |

---

## Quick start

**New to Aurora?** See [DOCS/GETTING-STARTED.md](DOCS/GETTING-STARTED.md) for first launch, provider setup, and local models.

### One-command setup

The setup script detects your OS/GPU and builds Rust with the right feature flags:

```bash
# macOS / Linux
./scripts/setup.sh

# Windows PowerShell
.\scripts\setup.ps1
```

### Manual development

**Prerequisites:** Node 18+, **pnpm**, Rust stable, [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
pnpm install

pnpm tauri:dev      # Full app (Tauri + Vite)
pnpm dev            # Frontend only — http://localhost:5173

pnpm build          # Frontend production build
pnpm tauri:build    # Desktop installers
pnpm test
pnpm lint
```

### GPU builds (speech acceleration)

Default builds are **CPU-only**. For NVIDIA CUDA speech acceleration:

```bash
pnpm tauri:dev:cuda
pnpm tauri:build:cuda
pnpm cuda:check     # Verify VS + CUDA toolchain on Windows
```

See [DOCS/06-SPEECH-INPUT.md](DOCS/06-SPEECH-INPUT.md) for model setup and runtime flow.

### First launch checklist

1. Open **Settings** and connect a provider (cloud API key or local LM Studio / Ollama).
2. Open a **workspace folder** so Git, explorer, and thread state bind to a project.
3. Start from the **main IDE** or open the **Agent Window** for conversation-first work.
4. Optionally enable **MCP servers** or **Team mode** in settings.

---

## Architecture (short)

```
Frontend (React/TS)          Tauri IPC          Rust backend
├─ Main IDE (MainLayout)  ←──────────────→  ├─ agent_runtime (turn loop)
├─ Agent Window (/agent-window)            ├─ api/ provider adapters + SSE
├─ Zustand stores (kernel + per-app)       ├─ MCP manager (rmcp)
├─ Agent stores (src/apps/agent/store/)    ├─ JSONL sessions + SQLite
└─ Tool bridge (TS executors)              ├─ Checkpoints, undo/redo, Git
                                           ├─ Code index, browser, speech
                                           └─ Native tools (41 registered)
```

**Provider path:** Frontend `RustProvider` → `aurora_provider_stream` → SSE parsing in Rust → events back to UI. Agent turns go through the runtime below instead.

**Agent path:** Frontend `agent-runtime-client.ts` → `agent_chat_v2` → Rust `agent_runtime/conversation/` drives turns → tool calls execute in Rust natively or bridge to the frontend (MCP, team UI, skills, ask_question).

**Persistence:** Chat sessions are JSONL under `%LOCALAPPDATA%\AuroraIDE\sessions\`; providers, themes, workspace state, artifacts metadata, and settings in SQLite (`%LOCALAPPDATA%\AuroraIDE\data\aurora.db`).

For module-level detail, start with **`CLAUDE.md`**, **`AGENTS.md`**, and **`DOCS/01-ARCHITECTURE.md`**.

---

## Tool categories

41 tools execute natively in Rust; the rest bridge to frontend executors.

| Category | Tools |
|----------|-------|
| File & search | `file_read`, `file_write`, `file_edit`, `move_path`, `delete_path`, `glob`, `grep`, `workspace_tree`, `folder_create`, `auroro_websearch` |
| Shell | `shell_execute`, `shell_spawn`, `shell_kill`, `shell_list_processes`, `shell_read_output` |
| Code intel | `code` (definition / usages / outline / modules / refresh, tree-sitter index) |
| Plan | `plan_write`, `plan_read`, `plan_step_update` |
| Todo | `todo` (batched updates, durable per-thread store) |
| Editor | `read_lints` (tsc / cargo check / Ruff runners) |
| Browser | `browser_navigate`, `browser_view`, `browser_click`, `browser_fill`, `browser_screenshot`, `browser_page_outline`, `browser_inspect_element`, `browser_a11y_tree`, … (16 total) |
| Guidelines | `design_guidelines`, `canvas_guidelines`, `browser_guidelines` |
| Diagnostics | `report_aurora_issue` |
| Transcript | `chapter` (optional chapter narration) |
| Artifacts | `present_artifact`, `read_artifact` |
| Team | `team_dispatch`, `team_status`, `team_chat`, `team_show`, … |
| Skills | `aurora_skill_search`, `aurora_skill_load` |
| Terminal | `terminal_list`, `terminal_read` (read the user's live PTY sessions) |
| MCP | `mcp_{serverId}_{toolName}` (dynamic) |
| Ask | `ask_question` |

Optional `tool_search` defers the `mcp_*` / `browser_*` / `team_*` schemas behind an on-demand lookup (Settings → Agent → Tool loading). Risk levels and approval modes: `src/apps/agent/tools/definitions/risk-levels-enhanced.ts`, enforced by the Rust permission gate.

---

## Documentation

| Doc | Purpose |
|-----|---------|
| [DOCS/GETTING-STARTED.md](DOCS/GETTING-STARTED.md) | Install, run, first provider, local models |
| [DOCS/01-ARCHITECTURE.md](DOCS/01-ARCHITECTURE.md) | System overview, module map, runtime flows |
| [DOCS/02-CODE-STYLE-PATTERNS.md](DOCS/02-CODE-STYLE-PATTERNS.md) | Patterns for boundaries, stores, IPC, and CSS |
| [DOCS/03-EXPANSION-GUIDE.md](DOCS/03-EXPANSION-GUIDE.md) | Adding tools, commands, providers, and settings |
| [DOCS/04-PROVIDER-KERNEL.md](DOCS/04-PROVIDER-KERNEL.md) | Provider adapters, catalog, and streaming design |
| [DOCS/05-ICON-PACKS.md](DOCS/05-ICON-PACKS.md) | Explorer icon packs |
| [DOCS/06-SPEECH-INPUT.md](DOCS/06-SPEECH-INPUT.md) | Local speech recognition setup |
| [DOCS/theme-dev.md](DOCS/theme-dev.md) | IDE theme tokens (`--aurora-*`) |
| [DOCS/code-index-handoff.md](DOCS/code-index-handoff.md) | Tree-sitter code index design + verification recipe |
| [DOCS/desktop-control-plan.md](DOCS/desktop-control-plan.md) | Desktop control design (agreed, not built) |
| [CLAUDE.md](CLAUDE.md) | Agent-oriented architecture reference |
| [DOCS/README.md](DOCS/README.md) | Documentation index |

---

## Project status and feedback

Aurora is built in the open by a very small team. **Please do not open issues for bugs or feature requests right now** — work proceeds on an ongoing cycle and the tracker is intentionally quiet.

If something blocks you, the source-available license allows forking for personal use. Patches that fit existing patterns (token-based theming, Zustand stores, Rust-side tool plumbing) are welcome when the tracker reopens.

---

## License

This project is **source-available** under the [Aurora Source-Available License](LICENSE): use and contribute for **personal and non-commercial** purposes. **Commercial use, enterprise deployment, sale, or paid/hosted offerings require prior written permission** from the copyright holders.

---

## Acknowledgments

Aurora is developed by **[Aurora Labs](https://github.com/Aurora-LABS-Ai)** with substantial assistance from agentic coding tools. The desktop shell stands on **[Tauri](https://tauri.app)**, **[Monaco Editor](https://github.com/microsoft/monaco-editor)**, **[React](https://react.dev)**, and the wider open-source ecosystem.

---

<div align="center">

**Aurora**

[Documentation](DOCS/)

</div>
