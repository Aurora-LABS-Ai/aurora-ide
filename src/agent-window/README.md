# Agent Window — module guide

> The standalone, **conversation-first** agent workspace (Codex-style), built as
> an **isolated feature module** per the repo-root `global-AGENTS.md` rules. It has
> its **own theme system** and never touches the IDE's global `--aurora-*` theme.

## Module shape (matches `global-AGENTS.md` §1 + §3)

```
agent-window/
├── index.ts                 # PUBLIC ENTRY (barrel) — the only thing outsiders import
├── README.md                # this file (what it is + invariants)
├── types.ts                 # leaf layer: shared types (imports nothing in-module)
├── components/              # view only — render, never orchestrate
│   ├── AgentWindow.tsx      # root: <AgentThemeProvider><AgentShell/></AgentThemeProvider>
│   ├── AgentThemeProvider.tsx
│   ├── AgentShell.tsx       # PanelGroup: rail | conversation | dock
│   ├── LeftRail.tsx         # projects + chats
│   ├── ConversationPane.tsx # header + messages + composer
│   └── RightDock.tsx        # tabbed dock: Review/Files/Browser/Terminal/Side chat
├── store/                   # feature state (Zustand, persisted)
│   ├── useAgentThemeStore.ts
│   └── useAgentWorkspaceStore.ts
└── theme/                   # theming concern: data + style + pure helpers
    ├── tokens.ts            # tokensToCssVars() — token → --agw-* mapping
    ├── themes.ts            # built-in agent themes (data)
    └── agent-window.css     # base styles, scoped under .agw-root
```

## Dependency direction (inward only)

`components → store → theme → types`. The view layer depends on state; state on
theme data; everything on the leaf `types`. `types` imports nothing. No file
imports the barrel (`index.ts`) — that would create a cycle.

## The one hard rule: theme isolation

- Agent-window styles read **`--agw-*` custom properties ONLY** — never `--aurora-*`.
- **Never** write agent tokens onto `document.documentElement`. `AgentThemeProvider`
  applies them inline on the `.agw-root` wrapper, so they cascade only here. The
  IDE theme can't leak in; the agent theme can't leak out.
- New color/size? Add a field to `AgentThemeTokens` (in `types.ts`), set it in
  every theme in `theme/themes.ts`, then consume it as `var(--agw-the-new-token)`.

## Conventions (from global-AGENTS.md §2)

- Imports at the top of the file; no inline imports.
- One concern per file, ≤ ~400 lines. No business logic inside view files.
- Switches over `DockTab` (and any union) use an exhaustive `never` default.
- Stable public names: split files behind the same `index.ts` surface.
- Tests live next to sources (`foo.ts` + `foo.test.ts`). **Known debt:** specs are
  deferred while the repo's `vitest` runner is broken (see `.cursor/progression/lesson.md`).

## Separate window (not embedded)

The agent window is its **own native OS window**, NOT a panel inside the IDE shell.
Team is embedded inside this window as the center-column Team screen:

- `adapters/window.ts` → `openAgentWindow()` creates the `agent-window` WebView at
  route `/agent-window` (opened from the title-bar Bot button).
- `App.tsx` renders `<AgentWindow/>` when `location.pathname === "/agent-window"`.
- `components/team/TeamScreen.tsx` renders the live Team screen inside the agent
  window; there is no separate Team route.
- `src-tauri/capabilities/default.json` lists `"agent-window"` so Tauri APIs work
  in it (per-window-label permissions — a new window with no capability is inert).

## Phase roadmap

- **F1 (done):** isolated theme system + 3-zone shell skeleton.
- **F2 (done):** standalone OS window + route + title-bar launcher; default theme
  from `alvan-aurora-dark.json`; reuse real `AgentInputArea`; placeholder convo.
- **F3:** wire the composer/messages to the real send pipeline (cross-window sync).
- **F4:** Review dock backed by Monaco diff (open files *inside* Aurora).
- **F5:** left rail real threads + projects.
- **F6:** inline diff cards (stats-first) in the conversation.
- **F7:** Files / Browser / Terminal dock tabs mount real surfaces.
```
