# Getting Started with Aurora IDE

Aurora is an AI-powered agentic code editor. This guide gets you from zero to your first AI-assisted interaction in under 5 minutes.

---

## Quick Start (Pre-built Binary)

If a release is available for your platform, download the installer from the [Releases](https://github.com/Aurora-LABS-Ai/aurora-ide/releases) page:

| Platform | Installer |
|----------|-----------|
| **Windows** | `.msi` or `.exe` |
| **macOS** | `.dmg` |
| **Linux** | `.AppImage` or `.deb` |

Double-click to install, then skip to [First Launch](#first-launch).

---

## Building from Source

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| **Node.js** | 18+ | [nodejs.org](https://nodejs.org) |
| **pnpm** | 8+ | `npm install -g pnpm` |
| **Rust** | stable | [rustup.rs](https://rustup.rs) |
| **Tauri prerequisites** | — | [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) |

### One-Command Setup

The setup script detects your OS and GPU, then builds automatically:

**macOS / Linux:**
```bash
git clone https://github.com/Aurora-LABS-Ai/aurora-ide.git
cd aurora-ide
chmod +x scripts/setup.sh
./scripts/setup.sh
```

**Windows (PowerShell):**
```powershell
git clone https://github.com/Aurora-LABS-Ai/aurora-ide.git
cd aurora-ide
.\scripts\setup.ps1
```

### Manual Build

If you prefer manual control:

```bash
pnpm install
pnpm tauri:dev        # Development mode (hot reload)
pnpm tauri:build      # Production installer
```

### GPU Acceleration (Optional)

Semantic search supports GPU acceleration. The default build is CPU-only for maximum compatibility.

| Your GPU | Build Command |
|----------|--------------|
| **None / Unknown** | `pnpm tauri:dev` (CPU-only, default) |
| **NVIDIA (CUDA)** | `cd src-tauri && cargo build --no-default-features --features cuda` |
| **Windows (DirectML)** | `cd src-tauri && cargo build --no-default-features --features directml` |
| **macOS (CoreML)** | `cd src-tauri && cargo build --no-default-features --features coreml` |

---

## First Launch

### Step 1: Connect an AI Provider

When Aurora opens for the first time, you'll see the onboarding wizard.

1. On the **Setup** step, paste your **Fireworks AI** API key directly in the input field
2. Click **Connect** to verify it works
3. Don't have a key? Click "Get a Fireworks API key" to sign up (free tier available)

**Alternative providers:** Click "All Providers" to configure Anthropic, OpenAI, DeepSeek, GLM, or a local model (Ollama/LM Studio).

### Step 2: Open a Workspace

Click **Open Folder** and select a project directory. Aurora will index the workspace for file exploration, Git status, and AI context.

### Step 3: Send Your First Message

The welcome screen shows suggested prompts based on your workspace:

- **"Explain the architecture of this project"** — Great first interaction
- **"Find potential issues"** — Discover bugs and anti-patterns
- **"Write unit tests"** — Generate tests for critical code

Click any prompt or type your own. Aurora's agent can edit files, run commands, search code, and more.

---

## Troubleshooting

### Build Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `CUDA not found` | NVIDIA toolkit missing | Use `--features cpu-only` (default) or install CUDA toolkit |
| `aurora-semantic` build fails | GPU feature mismatch | Run `./scripts/setup.sh` which auto-detects your GPU |
| `pnpm: command not found` | pnpm not installed | `npm install -g pnpm` |
| `rustc: command not found` | Rust not installed | Visit [rustup.rs](https://rustup.rs) |
| Tauri build fails on Linux | Missing system libraries | See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) |

### First Chat Errors

| Error | Cause | Fix |
|-------|-------|-----|
| "No models configured" | No API key set | Open Settings and add an API key |
| "Invalid API Key" (401) | Wrong or expired key | Check your key at your provider's dashboard |
| "Rate Limit Reached" (429) | Too many requests | Wait and retry; check your plan limits |
| "Connection Failed" | Network or provider down | Check internet; for local models, ensure they're running |

### Local Models (Ollama)

If you want to use AI without a cloud API key:

1. Install [Ollama](https://ollama.com)
2. Run: `ollama pull llama3.1`
3. Aurora auto-detects Ollama on `localhost:11434` during setup
4. No API key required

---

## What's Next?

- **Agent Mode** (`Esc` to toggle) — Full-screen chat with file changes panel
- **Keyboard shortcuts** — `Ctrl+P` quick open, `Ctrl+K` focus chat, `Ctrl+J` toggle terminal
- **MCP Servers** — Connect external tools via Settings > MCP
- **Semantic Search** — Enable in Settings > Semantic Search for AI-powered code search
- **Themes** — Browse and import VS Code themes in Settings > Appearance

See the [full documentation](./01-ARCHITECTURE.md) for architecture details.
