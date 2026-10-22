# Agent Window — module guide

The conversation window. It lives at `src/apps/agent/`. It has its own `--agw-*` theme
and does not write those tokens onto the IDE's `--aurora-*` theme.

The early `agent-window/` sketch (a flat `components/`, `LeftRail.tsx` at the root,
phases F3–F7 still open) is gone. Those phases shipped. Current behavior is in
`CLAUDE.md` and `DOCS/01-ARCHITECTURE.md`.

## Layout

```
src/apps/agent/
├── index.ts          public entry
├── types.ts
├── README.md
├── adapters/         window launcher and other IDE-facing wrappers
├── components/       views, grouped by concern (shell, conversation, composer, …)
├── hooks/
├── lib/
├── services/
├── settings/
├── shared/
├── store/            Zustand, grouped by concern
├── theme/            tokens, themes, and agent-window/*.css (58 partials)
└── tools/            display and approval metadata. Rust owns the implementations
```

## Theme isolation

- Agent-window styles read `--agw-*` custom properties only, never `--aurora-*`.
- Do not write agent tokens onto `document.documentElement`. `AgentThemeProvider`
  applies them inline on the `.agw-root` wrapper, so they cascade only here.
- A new color or size is a field on `AgentThemeTokens`, set in every theme in
  `theme/themes.ts`, then consumed as `var(--agw-the-new-token)`.
- Styles are the numbered partials under `theme/agent-window/`. The number is the
  cascade order. There is no Tailwind in this window.

## Separate window

The agent window is its own native OS window, not a panel inside the IDE shell.

- `adapters/window.ts` opens the `agent-window` WebView at `/agent-window`.
- `App.tsx` renders it when `location.pathname === "/agent-window"`.
- `src-tauri/capabilities/default.json` lists `"agent-window"` so Tauri APIs work in it.
