# Agent Window token system: Codex map and hardening plan

Status (2026-10-01): **Phase 1 done**, needs a `pnpm tauri:dev` look. Phases 2–3
not started. Resume from "Phase 2".

Reference material: `thirdparty/codex-ui-design/` (Codex 26.928 CSS, tokens, assets) and the
restored Codex theme engine at
`C:\Users\Alvan\Documents\PORTABLE-INSTALLS\decode-codex\restored\github\diff-view-mode\theme-colors-impl.ts`.
Aurora's current tokens: `.knowledge/design-tokens.md`, verified against `themes.ts`,
`01-root.css`, `color.ts` and `useAgentThemeStore.ts` for this doc.

## How Codex builds its theme

Codex has four layers. Only the first two matter for Aurora.

1. **Seeds.** A theme is seven fields: `surface`, `ink`, `accent`, `contrast` (0–100),
   `semanticColors { diffAdded, diffRemoved, skill }`, `fonts { ui, code }`, `opaqueWindows`.
   Every built-in theme (Linear, Notion, Vercel, Absolutely…) is just these plus a VS Code
   editor palette. Codex's defaults: dark `surface #181818 / ink #ffffff / accent #339cff /
   contrast 60`, light `#ffffff / #1a1c1f / #339cff / 45`.
2. **Derivation.** `createThemeCssVariables` computes ~45 CSS variables from the seeds, at
   runtime, with RGB mixes whose strength scales with `contrast`. Nothing below the seeds is
   hand-set.
3. **Primitive scales** (`--gray-0…1000`, `--blue-50…950`, …) for Tailwind utilities. The gray
   scale flips in dark mode (`--gray-0` is the darkest).
4. **VS Code bridge** (`--vscode-*`) so editor themes recolour the chrome.

The rules that make layer 2 work, which Aurora can adopt without adopting Codex's look:

| Role | Codex derivation (dark) | Resolved at Codex defaults |
|---|---|---|
| Main surface | `surface` seed | `#181818` |
| Sidebar (under) | `surface` mixed toward black, 16% | `#141414` |
| Panel | `surface` → `ink`, 3% + contrast×3% | `#232323` |
| Control / input | `surface` → `ink`, 6% + contrast×5% | `rgb(45,45,45)` |
| Elevated (menus) | `surface` → `ink`, 8% + contrast×8%, at 96% alpha | `rgb(54,54,54)` |
| Text primary | `ink` | `#ffffff` |
| Text secondary | `ink` at 65% + contrast×10% alpha | `rgba(255,255,255,.71)` |
| Text tertiary | `ink` at 42% + contrast×13% alpha | `rgba(255,255,255,.50)` |
| Border / heavy / light | `ink` at 6–10% / 12–18% / 3–5% alpha | `.084 / .156 / .042` |
| Secondary button + hover | `ink` at ~5% / ~8% alpha | |
| Accent text, focus | `accent` mixed 30–45% toward white | `rgb(131,195,255)` |
| Accent fill | black → `accent`, 20–28% | `#0d273f` |
| Diff fill | `diffAdded` / `diffRemoved` at 23% alpha | |

Two properties fall out of this: text and lines are **alpha over whatever surface they sit
on**, so they stay correct on any surface; and changing one seed recolours everything
consistently.

Other Codex scales worth matching in kind (values in `tokens/design-tokens.css`):

- **Radius:** `xs 4 / sm 6 / md 8 / lg 10 / xl 12 / 2xl 16 / 3xl 20 / 4xl 24`, all multiplied by
  `--corner-radius-scale`.
- **Spacing:** Tailwind `--spacing: 4px` grid, plus named role sizes (`--height-toolbar 46px`,
  `--height-titlebar 44px`, sidebar `clamp(240px, 275px, 520px)`).
- **Motion:** `--cubic-enter (0.19,1,0.22,1)`, `--cubic-exit (0.8,0,0.4,1)`,
  `--cubic-move (0.65,0,0.35,1)`; durations `basic .15s`, `relaxed .3s`.
- **Shadow:** `sm…2xl` at 8–19% black, plus a 0.5px hairline.
- **Type:** `xs 11 / sm 12 / base 14 / lg 16`, headings `18 / 20 / 24 / 28`.

## Codex → Aurora token map

| Codex | Aurora today | Note |
|---|---|---|
| `surface` seed | `canvas` / `rail` / `dock` `#161616` | Aurora's frame tier |
| `background-surface` (main) | `conversation` `#0f0f0f` | **Layering is inverted, see below** |
| `background-surface-under` | none | Aurora has no "under" tier |
| `background-control` | `composerSurface` / `surfaceElevated` `#2e2e2e` | Aurora's is brighter than Codex's `rgb(45,45,45)` |
| `background-elevated-primary` | `--agw-popover-surface` (≈`#232323`) | already derived by `color-mix` |
| `background-button-secondary(-hover)` | `hover` `#ffffff0a`, `controlMuted` `#ffffff14` | Aurora: fixed white alpha |
| `text-foreground` | `text` `#ededed` | |
| `text-foreground-secondary` | `textMuted` `#a0a0a0` | Codex ≈ `#bcbcbc` on its surface: brighter |
| `text-foreground-tertiary` | `textSubtle` `#727272` | Codex ≈ `#8b8b8b`: brighter |
| `border` / `border-heavy` | `border #222222` / `borderStrong #383838` | Aurora: opaque hex |
| `border-focus` | `ring` `#3994bc` | |
| `accent` seed | `accent` `#3994bc` | |
| `background-accent` | none | |
| `diffAdded` / `diffRemoved` | `added` / `removed` + `*Surface` | Aurora hand-sets both fill and line |
| `skill` | none | |
| `contrast` | `contrast` pref, `applyContrast()` | Aurora's moves only text + borders |
| `--corner-radius-scale` | none | Aurora has `radiusSm/Md/Lg/Pill` only |
| `--spacing` | none | "There is no spacing scale token" |
| `--cubic-*`, `--transition-duration-*` | none | |
| `--shadow-sm…2xl` | `shadowPop`, `--agw-card-lift*` | |

### The layering difference

In dark mode Codex puts the **sidebar darker** than the main area (`#141414` under
`#181818`). Aurora puts the **frame lighter** than the conversation sheet (`#161616` around
`#0f0f0f`), on purpose (`themes.ts`: "the sheet reads as a stage sunken into a bezel"). In light
mode both match (frame darker than a white sheet). This is identity, not hardcoding. It is not
in the plan below unless Alvan asks for a probe.

## What is actually hardcoded

Measured across the 51 partials on branch `feat/icon-rail`, 2026-10-01:

| Category | Literal | Via token | Verdict |
|---|---|---|---|
| font-size | 27 | 600 | Fine. Most literals are display sizes over 17px, which the rules allow |
| font-weight | 8 | 246 | Fine; clean up the 8 |
| border-radius | 28 | 306 | Mostly 2–5px nested bits with no token. Needs `xs` / `2xs` |
| Colour | ~10 real | — | 128 lines contain a literal, but most are legitimate: mask gradients (`#000` = opaque), scrims on media, shimmer highlights, and the shadow-token definitions themselves. About 10 are real misses (e.g. `02-shell.css:76 color: #ffffff`) |
| **Duration** | **404** | **0** | No motion tokens. `0.12s` ×112, plus `.15 / .18 / 160ms / .14 / .2` |
| **Easing** | **27** | **0** | Six different curves, no names |
| **z-index** | **48** | **0** | 16 distinct values, from `0` to `13600`, no layer scale |
| **Spacing** | **~1,800** | **0** | Off-grid values in heavy use: `7px` ×87, `5px` ×73, `9px` ×66, `3px` ×52 |
| Shadow | 13 | partial | Literals outside `shadowPop` / card lift |

**Theme derivation gaps** (these are behaviour, not CSS):

- Setting a custom **Accent** carries `controlAccent` with it (`mergeAgentTokens`), but not
  `accentHover` or `ring`. A user who picks red gets filled buttons that hover to Aurora blue,
  and blue focus rings, unless they also edit both.
- **Window frame** sets `canvas` / `rail` / `dock` together but leaves `surface`,
  `surfaceElevated`, `composerSurface` and `conversation` behind. A warm frame keeps neutral
  grey cards.
- **Contrast** (`applyContrast`) moves text and borders only. Codex's moves every surface and
  fill.
- Text tiers and borders are opaque hex in dark, so they are tuned to one surface.

## Phases

Each phase is shippable alone. Phases 1–2 don't change how the built-in themes look.

### Phase 1: tokens for what has none (no visual change)

Add to `01-root.css`, then replace literals partial by partial:

- **Motion:** `--agw-dur-fast: .12s`, `--agw-dur-base: .18s`, `--agw-dur-slow: .3s`;
  `--agw-ease-out`, `--agw-ease-standard`, `--agw-ease-pop`, `--agw-ease-spring` named after
  the six curves in use. `0.12s` maps exactly. The `.14 / .15 / 160ms` stragglers move to the
  nearest token. That is the only visible change, and it's under 40ms.
- **Layers:** `--agw-z-raised / sticky / dropdown / overlay / modal / toast / top`, mapped
  from the 16 current values in ascending order so stacking order is preserved.
- **Radius:** add `--agw-radius-2xs 2px`, `--agw-radius-xs 4px` for the nested 2–5px cases.
- **Shadow:** fold the 13 stray shadows into `--agw-shadow-sm / md / lg` beside `shadowPop`.
- The ~10 real colour misses → existing tokens. Font-size and weight literals that equal a
  scale value → the token.
- Guard: extend `appearance-token-coverage.test.ts` so a new raw duration, z-index or colour
  in a partial fails the test (same pattern as the focus-ring exemption list).
- Update `.knowledge/design-tokens.md` in the same change. It is also stale on two counts: it
  says 48 partials (there are 51), and `themes.ts`'s header comment says canvas `#101010` while
  the token is `#161616`.

Verify: tsc, eslint, vitest, and a `pnpm tauri:dev` pass comparing screenshots before and
after on Home, a conversation with tool cards, Settings and a popover.

**Phase 1 result.** 425 literals swapped by exact rule (durations, curves, layers, radius,
weight, gallery font sizes) plus about 40 hand fixes. The audit turned up a worse problem
than hardcoding: **ten `--agw-*` names were referenced and never defined**, so their
declarations were silently dropped. Fixed:

- `--agw-danger` (16 uses): now defined as `var(--agw-removed)`. Errors had been a fixed
  `#e5484d` in every theme, and in `31-plan.css` (no fallback) they had no red at all.
- `--agw-text-dim` ×11 → `text-muted`; `--agw-font-mono` ×5 → `font-code` (code wasn't mono);
  `--agw-surface-raised` ×7 → `hover-paint` / `state-selected` / `chip-surface` /
  `code-surface` by role. The model-catalogue rows had **no hover and no keyboard-focus
  fill** because of this one.
- `--agw-fw-normal` / `-regular` → `fw-body`; `--agw-border-subtle` / `-faint` → `border`;
  `--agw-surface-sunken` → `state-quiet`; `--agw-accent-contrast` → `on-accent`.
- `--agw-focus`: the Kenari link drew an OUTER 2px outline. Now the shared inset
  `--agw-focus-ring`, like `.agw-rv-link`.
- Status hexes (`#3fb950`, `#e5534b`, `#d9a441`) in Team, Atlas and Cursor → `added` /
  `danger` / `warning`. Gallery font sizes now follow Interface text size.

Expected visible changes, all small: error red follows the theme (dark `#f48771`, light
`#cf222e`); ~60 transitions shift by ≤40ms (two 0.3s ones by 60ms); the four 30/40/50/60
popover layers became one; mic-permission and image-preview dialogs share the confirm
dialog's shadow; the segmented thumb shares the switch knob's shadow.

Guards added to `appearance-token-coverage.test.ts`, both shown failing on the old CSS:
undefined `--agw-*` references, and raw UI durations / global z-indexes.

Left as literals, on purpose: media overlays (`#000`/`#fff` over images and video),
mask gradients, the phone status-bar mimic (`.agw-devstatus`), "mix toward black" press
recipes, 8/9/11px glyph and badge sizes, display sizes over 17px, the 1/3/5/7/10px radii
(Phase 3 decides those with spacing), and the white tick on the green skill check.
Follow-ups: `.agw-projmenu` and `.agw-idxstat-pop` are popovers but not on the popover
recipe (10px radius, own shadow); `.agw-term-pill[data-active]` has a hardcoded bluish
border `rgba(176,199,217,.16)`.

### Phase 2: derived theme (custom themes only)

Adopt Codex's derivation idea, not its values. Built-in themes keep their numbers.

- `accentHover` and `ring` follow `accent` the same way `controlAccent` does: derived
  (`accentHover` = accent mixed ~10% toward the appearance extreme) unless explicitly set.
- Window frame derives the dependent surfaces (`surface`, `surfaceElevated`,
  `composerSurface`) from the frame and the text colour, using Codex's mix ratios as a starting
  point, unless each is explicitly set.
- `applyContrast` extends to the surface steps, the way Codex's `contrast` does.
- Tests in `useAgentThemeStore.test.ts` / `color.test.ts`, each shown to fail on the old code.

### Phase 3: spacing scale (visual, needs a probe)

- `--agw-space-0_5 … --agw-space-6` on a 4px grid (2, 4, 6, 8, 10, 12, 16, 20, 24).
- Off-grid values (3, 5, 7, 9, 11) get decided per surface, not blanket-rounded: a 7px pad
  becoming 8px moves every row. Design probe first (`Documents/aurora-spacing-designs.html`),
  then migrate one surface at a time behind screenshots.
- Biggest phase by far (~1,800 literals). Multi-session.

### Not planned unless asked

- Inverting the dark layering to Codex's (sidebar darker than main).
- Switching text tiers / borders to ink alpha (Codex's model). Better in principle, but it
  changes every grey in dark mode; it belongs with a probe if Phase 2 lands well.
- Copying Codex values, fonts or icons. `thirdparty/codex-ui-design` is reference only.
