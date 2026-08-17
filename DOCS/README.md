# Documentation Index

Aurora technical documentation. **Validated against the working tree: 2026-08-17** (branch `split-css`).

The most current knowledge in this repo is not here — it is `.knowledge/knowledge.md`
(working memory) and `.knowledge/lesson.md` (lessons learned), both appended continuously.
When a doc below disagrees with them, they win.

## Core guides

| Doc | Purpose |
|-----|---------|
| [GETTING-STARTED.md](./GETTING-STARTED.md) | Setup, run, first provider, local models, troubleshooting |
| [01-ARCHITECTURE.md](./01-ARCHITECTURE.md) | System overview, directory map, agent path, provider paths, data locations |
| [02-CODE-STYLE-PATTERNS.md](./02-CODE-STYLE-PATTERNS.md) | Module boundaries, store/CSS/command/tool conventions, testing |
| [03-EXPANSION-GUIDE.md](./03-EXPANSION-GUIDE.md) | Adding tools, commands, providers, settings, theme tokens |
| [04-PROVIDER-KERNEL.md](./04-PROVIDER-KERNEL.md) | Provider adapters, catalog, reasoning accounting, retries |
| [05-ICON-PACKS.md](./05-ICON-PACKS.md) | Explorer icon packs and the `.aurora` bundle format |
| [06-SPEECH-INPUT.md](./06-SPEECH-INPUT.md) | Local Qwen3-ASR speech input, CUDA builds, CrispASR compat |
| [theme-dev.md](./theme-dev.md) | IDE theme token contract (`--aurora-*`) |

## Design records and future plans

| Doc | Status |
|-----|--------|
| [code-index-handoff.md](./code-index-handoff.md) | Shipped (cache format v6) — design + verification recipe for the tree-sitter index |
| [agent-plan-canvas.md](./agent-plan-canvas.md) | Shipped — Plan Canvas + todo unification design |
| [agent-window-lsp-plan.md](./agent-window-lsp-plan.md) | Partially superseded — Phase 0 shipped as shell-checker `read_lints`; headless LSP remains open |
| [desktop-control-plan.md](./desktop-control-plan.md) | Agreed, deliberately not built — resume here if taken up |

## Visual studies

Dated measurement records of competitor/own UIs (2026-08-09), kept for design reference:
[visual-studies/](./visual-studies/) — `VISUAL-STUDY-02-ANTIGRAVITY.md`,
`VISUAL-STUDY-03-AURORA.md` (Study 01 no longer exists), plus captured frames for
antigravity, aurora, and minimax-code.

## House rules for this folder

- Replace stale sections; never layer patches over an obsolete mental model.
- Every path a doc mentions must exist — validate after moves.
- Point-in-time plans carry a **Status** header; update it when reality diverges, or delete
  the doc when its subject is finished and absorbed elsewhere.
- No real project, package, or customer names — neutral fixture names only.
