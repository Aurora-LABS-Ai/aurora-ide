# Getting Started

Aurora is a desktop AI coding IDE (Tauri 2 + React + Rust). The Rust backend owns the agent
loop, providers, and tools; the frontend owns the two surfaces — the IDE and the Agent Window.

## 1. Prerequisites

| Tool | Version |
|------|---------|
| Node.js | 20.19+ (Vite 8 requirement; CI builds on 22) |
| pnpm | 9+ |
| Rust | stable (toolchain pinned to 1.92.0 via the root `rust-toolchain.toml`) |
| Tauri prerequisites | installed for your OS ([Windows](https://v2.tauri.app/start/prerequisites/): WebView2 + MSVC build tools) |

## 2. Install and Run

```bash
pnpm install
pnpm tauri:dev      # full app (Rust build takes a while the first time)
```

Useful commands:

```bash
pnpm dev            # frontend only — http://localhost:5273
pnpm test           # Vitest
pnpm build          # frontend production build
pnpm tauri:build    # desktop installers
```

Dictation runs out of process. Point Settings, speech at a CrispASR runtime
folder holding `crispasr.exe` to transcribe on stop, or at `audiocpp_cli.exe`
plus a Confucius4-R2T2 GGUF to see words while you speak.

## 3. First Launch

### Connect a provider

Built-in presets (Rust catalog): Fireworks, GLM, Anthropic, MiniMax, DeepSeek, OpenAI,
OpenAI Responses, Kenari, LM Studio, Ollama — plus frontend-integrated Codex (ChatGPT login),
Atlas Cloud, and AgentRouter. Open Settings → Providers in the Agent Window and pick a preset
or configure a custom row.

### Open a workspace

Choose a folder so Aurora can build project context, show the explorer, track Git, and bind
thread state to the project.

### Start a chat

The agent window composer assembles the system prompt, MCP summary, project rules, the
tree-sitter `<repo_map>`, and skill references, then hands the turn to the Rust runtime
(`agent_chat_v2`). Watch tool calls stream beside the transcript; approve risky ones when asked.

## 4. Local Models

LM Studio (`http://localhost:1234/v1`) and Ollama (`http://localhost:11434/v1`) are detected
through Rust (`local_provider_detect`); Ollama models can be pulled/loaded/unloaded from
Settings. Typical setup:

```bash
ollama pull llama3.1
```

Then open Settings → Providers and let Aurora detect it.

## 5. Where Things Live

- Data root (Windows): `%LOCALAPPDATA%\AuroraIDE\` — `sessions\` (JSONL chat history),
  `data\aurora.db` (SQLite settings/providers/themes), `logs\` (`aurora.log`,
  `aurora-crash.log`), `code-index\`, `checkpoints\`.
- MCP config: `~/.aurora/mcp.json`.
- Frontend: `src/apps/{agent,ide}`, `src/kernel`, `src/bridge`. Backend: `src-tauri/src/`
  (`agent_runtime/`, `api/`, `commands/`, `tools/`, `code_index/`, …).

## 6. Common Problems

| Problem | Meaning | What to check |
|---------|---------|---------------|
| No models configured | No provider row selected/hydrated | Settings → Providers |
| Invalid API key | Cloud provider rejected auth | Provider key and base URL |
| Local provider not detected | LM Studio/Ollama not reachable | Local server process and port |
| Stream cancelled | Request was manually stopped | Expected on Stop; suppressed in UI |
| Rust change "not live" | Dev binary predates the change | Restart `pnpm tauri:dev` (no hot reload for Rust) |
| Boot freeze / blank screen | Renderer exception or blocking command | `%LOCALAPPDATA%\AuroraIDE\logs\aurora.log` |

## 7. Validation Commands

Frontend work:

```bash
pnpm test && pnpm build
```

Backend work (from `src-tauri/`):

```bash
cargo check --lib --tests    # fast gate (~1s warm)
cargo test --lib             # logic tests
# cargo clippy is ~8 min on this crate — only for code-quality changes
```

## 8. Where To Read Next

- [theme-dev.md](./theme-dev.md) — IDE theme token contract (`--aurora-*`)
- Root `README.md` — stack, tools, license
