# Aurora

A desktop coding IDE with an agent that can read, edit, run, and browse — in a
separate conversation window, with a real editor beside it.

<div align="center"> 

[![Version](https://img.shields.io/badge/version-2.0.0-blue)](https://github.com/Aurora-LABS-Ai/aurora-ide)
[![License](https://img.shields.io/badge/license-Source%20Available-8b5cf6)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-orange)](https://tauri.app)

</div> 
 
<div align="center">

![Agent Window transcript with live tool cards](public/showcase/agent-in-loop.png)

*Agent Window — the turn loop, tool cards, and workspace in one place.*

</div>

## What it is

One Tauri app, two windows:

| Window | What you do there |
|--------|-------------------|
| **IDE** | Explorer, Monaco, terminal, Git, themes |
| **Agent Window** | Chat, review diffs, Canvas, files, browser, plan |

The Agent Window is the conversation surface. The IDE is the editor. They share
one workspace. Rust owns the agent turn loop, providers, native tools, sessions,
checkpoints, MCP, the tree-sitter code index, and browser WebViews. React owns
the two UIs.

**Modes:** Agent (full tools) · Plan (inspect and write a plan, no workspace
edits) · Team (a Lead can dispatch parallel workers).

**Providers:** Fireworks, GLM, Anthropic, MiniMax, DeepSeek, OpenAI, OpenAI
Responses, Kenari, LM Studio, Ollama, Codex (ChatGPT login), Atlas Cloud,
AgentRouter, or a custom OpenAI-compatible row.

Also in the box: MCP (stdio, SSE, streamable HTTP), git checkpoints per user
message, local speech (Qwen3-ASR; CPU default, CUDA optional), and a native
browser the agent can drive.

<div align="center">

![Main IDE workspace](public/showcase/default-look.png)

*IDE — explorer, Monaco, terminal, token-themed chrome.*

</div>

<div align="center">

![Agent browser inspector](public/showcase/built-in-browser-inspector.png)

*Built-in browser — the agent opens a real WebView, not an iframe.*

</div>

## Run it

**Prerequisites:** Node 18+, [pnpm](https://pnpm.io), Rust **1.92.0**
(pinned in `rust-toolchain.toml`), and the
[Tauri 2 OS prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
pnpm install
pnpm tauri:dev          # full app (first Rust build is slow)
```

```bash
# macOS / Linux
./scripts/setup.sh

# Windows PowerShell
.\scripts\setup.ps1
```

| Command | What it does |
|---------|----------------|
| `pnpm dev` | Frontend only — http://localhost:5173 |
| `pnpm test` | Vitest |
| `pnpm tauri:build` | Desktop installers |
| `pnpm tauri:dev:cuda` | Speech with NVIDIA CUDA |

Speech models download on first use. Default builds are CPU-only.

**First launch:** Settings → Providers (API key or local LM Studio / Ollama),
open a workspace folder, then chat from the Agent Window.

Full walkthrough: [DOCS/GETTING-STARTED.md](DOCS/GETTING-STARTED.md).
IDE theme tokens: [DOCS/theme-dev.md](DOCS/theme-dev.md).

## Stack

React 18 + TypeScript + Vite 8 (IDE uses Tailwind; the Agent Window is
token CSS). Tauri 2 + Rust 2021. Sessions are JSONL; settings and providers
live in SQLite under `%LOCALAPPDATA%\AuroraIDE\` (macOS/Linux: the equivalent
app-data root).

## Status

Source-available, small team. **Please do not open issues for bugs or feature
requests right now** — the tracker is intentionally quiet.

## License

[Aurora Source-Available License](LICENSE): personal and non-commercial use.
Commercial, enterprise, or hosted use needs written permission.

---

<div align="center">

[Getting started](DOCS/GETTING-STARTED.md) · [Aurora Labs](https://github.com/Aurora-LABS-Ai)

</div>
