# Agent Window — Shimmer Inventory (ground truth)

Every animated "shimmer" in the agent window, so the planned **Appearance setting** has a
complete surface to control. Two families: the shared text sweep (`.agw-shimmer`) and the
standalone per-element animations. All live in `src/agent-window/theme/agent-window.css`
unless a component is named.

Last verified: 2026-07-11.

---

## Family A — shared text sweep `.agw-shimmer`

One rule drives all of these. Editing `.agw-shimmer` changes every entry here at once
(except duration, which the compaction label overrides).

**Current tuned state** (`agent-window.css` ~2020):
- Gradient: `text-subtle 0% / 28% → text 50% → text-subtle 72% / 100%` (symmetric).
- `background-size: 200% 100%`, tiling (NO `background-repeat: no-repeat`).
- Keyframe `agw-shimmer`: `200% 0 → 0% 0` (decreasing position = **left → right**; one full
  200% period = seamless single sweep, no pop).
- `animation: agw-shimmer 2.5s linear infinite`.

| # | Where (user-facing) | Applied at | When active |
|---|---------------------|-----------|-------------|
| 1 | **AURORA / assistant author label** | `components/MessageBubble.tsx:323` | while the turn streams |
| 2 | **"Thinking…" reasoning label** | `components/AgentThinkingBlock.tsx:48` | while reasoning is generating |
| 3 | **Tool "Running…" label** | `components/ToolCallCard.tsx:369` | while a tool call runs |
| 4 | **Team member name** | `components/team/TeamScreen.tsx:61` | while that member is live |
| 5 | **Compaction chip label** | CSS `.agw-compaction-running .agw-compaction-chip > span` (~2094) | while compaction runs — **reuses the `agw-shimmer` keyframe but overrides duration to `30s`** |

---

## Family B — standalone shimmer/sweep animations

Each has its own keyframe + params; tuning one does NOT affect the others.

| # | Where (user-facing) | Selector | Keyframe / speed | Notes |
|---|---------------------|----------|------------------|-------|
| 6 | **Model selector chip — NAME** | `.agw-model-trigger[data-streaming] .agw-model-trigger-name` (~386) | `agw-model-name-shimmer` — `2.4s linear` | text sweep, `background-size:300% 100%`, `100% 0 → 0 0` |
| 7 | **Model selector chip — ICON shine** | `.agw-model-trigger[data-streaming] .agw-model-trigger-shine` (~357) | `agw-model-icon-shimmer` — `1.9s ease-in-out` | diagonal shine masked to the mode glyph |
| 8 | **Pre-response message skeleton bars** | `.agw-skeleton span` (~3253) | `agw-skeleton-sweep` — `1.6s linear` | the placeholder bars; recently dimmed (opacity 0.30, text-subtle based) |
| 9 | **Team chat skeleton lines** | `.agw-team-skel-line` (~1245) | `agw-skel-shimmer` — `1.4s ease` | surface→surface-elevated loading bars |
| 10 | **Atlas skeleton** | `.agw-atlas-skeleton` (~8477) | `agw-atlas-shimmer` — `1.4s ease` | same surface loading-bar style as #9 |
| 11 | **Speech recording visualizer** | mic bar (~1422) | `agw-mic-sweep` (~1464) | "aurora" light bar sweeping while recording |

---

## Appearance-setting notes

- **Reduced motion**: `@media (prefers-reduced-motion)` already neutralizes the model-chip
  shimmer (CSS ~402). A global toggle should cover Families A + B consistently.
- **One knob for the text sweep**: Family A is already unified on `.agw-shimmer`, so a single
  "streaming label shimmer speed/intensity" control maps cleanly onto it — remember the
  compaction override (#5) sets its own `30s`.
- **Color** is theme-driven: sweeps interpolate `--agw-text` ↔ `--agw-text-subtle`; skeletons
  use `--agw-surface` ↔ `--agw-surface-elevated`. No hardcoded whites.
- **Speed is just the `animation` duration** on each entry — safe to expose per-family.
