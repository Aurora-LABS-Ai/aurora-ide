# Getting Started

Aurora is a desktop AI coding IDE. The current app uses a Rust-owned provider pipeline, so provider setup, local-model detection, and streaming behavior are more consistent than the older frontend-owned model path.

## 1. Prerequisites

| Tool | Version |
|------|---------|
| Node.js | 18+ |
| pnpm | 8+ |
| Rust | stable |
| Tauri prerequisites | installed for your OS |

## 2. Install and Run

```bash
pnpm install
pnpm tauri:dev
```

Useful commands:

```bash
pnpm dev
pnpm test
pnpm build
pnpm tauri:build
```

## 3. First Launch

### Connect a provider

Aurora ships with built-in provider presets loaded from Rust:

- Fireworks
- GLM
- Anthropic
- MiniMax
- DeepSeek
- OpenAI
- LM Studio
- Ollama

Open Settings and pick one of those presets or configure a custom provider row.

### Open a workspace

Choose a folder so Aurora can:

- build project context
- show explorer and editor state
- track Git status
- persist thread state

### Start a chat

The first request builds:

- system prompt
- MCP summary
- project rules
- optional project layout
- skill catalog references
- context-engine message history

Then the provider request is sent through the Rust provider kernel.

## 4. Local Models

Aurora now detects local providers through Rust, not browser fetches.

### LM Studio

- default endpoint: `http://localhost:1234/v1`
- detected through `local_provider_detect`

### Ollama

- default endpoint: `http://localhost:11434/v1`
- supports detect, pull, load, unload, delete, and running-model queries

Typical Ollama setup:

```bash
ollama pull llama3.1
```

Then open Settings and let Aurora detect it.

## 5. Development Notes

The active provider pipeline is:

- frontend `RustProvider`
- Rust `aurora_provider_stream` / `aurora_provider_chat`

If you are debugging provider behavior, do not look for old TS provider implementations. They are gone.

Use these files instead:

- `src/services/providers/rust-provider.ts`
- `src/services/providers/rust-message-mapper.ts`
- `src-tauri/src/commands/provider_kernel/`

## 6. Common Problems

| Problem | Meaning | What to check |
|---------|---------|---------------|
| No models configured | No provider row selected or hydrated | Settings store and provider config |
| Invalid API key | Cloud provider rejected auth | Provider key and base URL |
| Local provider not detected | LM Studio/Ollama not reachable | Local server process and port |
| Stream cancelled | Request was manually stopped or torn down | Frontend cancel flow or backend stream cancellation |
| Build passes but tests fail | Behavior regression in service/store layer | Run `pnpm test` and inspect failing seam |

## 7. Validation Commands

For normal frontend work:

```bash
pnpm test
pnpm build
```

For backend/provider work:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

## 8. Where To Read Next

- [01-ARCHITECTURE.md](./01-ARCHITECTURE.md)
- [03-EXPANSION-GUIDE.md](./03-EXPANSION-GUIDE.md)
- [04-PROVIDER-KERNEL.md](./04-PROVIDER-KERNEL.md)

