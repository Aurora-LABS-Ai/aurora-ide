# Visual Study 01 — MiniMax Code

**Probed:** 2026-08-09 · **Build:** MiniMax Code (Electron/WebView, `app://./archon`) · **Model shown:** MiniMax-M3
**Method:** live window probe via `qg-probe` (UIA tree) + raw framebuffer capture (`CopyFromScreen`) + per-pixel sampling.
**Reference frames:** `DOCS/visual-studies/minimax-code/01..11*.png`

> **Measurement note.** The display runs at **150%**. Captures are raw physical pixels; every value below is
> divided by 1.5 and stated in **CSS px**, rounded, ±1. Colors are exact (sampled, not eyeballed).
> Anything marked *approx* was read off a zoom crop rather than an edge scan.

This is the first in a series. Same section order should be used for every app we study so the studies
are directly comparable — see [§10 Template](#10-template-for-the-next-app).

---

## 1. The one-sentence read

MiniMax Code is **a document that happens to be an agent**, not a dashboard that happens to hold a chat.
Its premium signal comes from *subtraction*: a 6-value greyscale, exactly one accent hue, no shadows
anywhere, no cards in the transcript, and type set at reading-measure with editorial rules between sections.

---

## 2. Palette — measured, exact

The entire application runs on **nine greys**. That is the headline finding.

| Token (measured) | Role |
|---|---|
| `#0B0B0B` / `#0E0E0E` | modal scrim — over sidebar / over canvas (two values because it's alpha over two grounds) |
| `#161616` | 9px soft shadow band under the composer card — the *only* shadow in the app |
| `#171717` | **recessed** surface — sidebar, command-palette panel, composer project tray, code viewer |
| `#1B1B1B` | composer outer tray |
| `#1C1C1C` | canvas / app ground / file-tree column |
| `#202020` | **selected** fill — sidebar pill, palette highlighted row, active icon button |
| `#212121` | hairline on dark trays |
| `#262626` | **raised input** surface — composer input, user message bubble |
| `#272727` – `#2C2C2C` | hairlines: palette border, list dividers, rail divider, tree row selected |
| `#2F2F2F` | active tab pill, outlined-card border |
| `#353535` | composer inner-card border (the brightest hairline in the app) |
| `#949494` | **disabled** send-button fill (still a solid light fill) |
| `#EDEDED` | primary text, stop-button fill |
| `#0077D9` | **the accent.** One hue. Used on exactly one thing at rest: the `Thinking` toggle |

Two things worth stealing outright:

- **The sidebar is *darker* than the canvas** (`#171717` < `#1C1C1C`). The inverse of the usual
  "panel floats above ground". Nav recedes; work is elevated. It costs nothing and it reads expensive.
- **One selected-state token (`#202020`) is reused everywhere** — sidebar, palette, icon buttons.
  Selection always looks the same, so it never has to be re-learned.

Saturated color appears in exactly three places in the whole product: the accent, the **file-type icons**
in the tree/tool rows, and the real full-color **Cursor app icon** in the IDE chip. Everything else is grey.

---

## 3. Type

| Element | Size | Line-height | Weight / color |
|---|---|---|---|
| Assistant prose | ~15px | 24px (≈1.6) | 400, `#EDEDED` |
| Heading inside an answer | ~18px | — | 600, `#EDEDED` |
| Tool step label + payload | ~14px | — | 400, dim grey |
| Activity group header | ~13px | — | 400, dim grey |
| Sidebar nav label | ~14px | — | 400, `#EDEDED` |
| Sidebar section header | ~13px | — | 400, heavily dimmed |

- **Emphasis is weight-only.** Bold spans inside prose stay `#EDEDED` — no color change, ever.
- **The heading scale is nearly flat** (18 vs 15). Hierarchy comes from the rule above the heading
  and the whitespace around it, not from size jumps.
- Sentence case throughout. **No uppercase-tracked labels anywhere**, including section headers.
- Code and commands are true monospace with *almost no syntax color* — near-monochrome.

---

## 4. Geometry & spacing

| Measurement | CSS px |
|---|---|
| Sidebar width | 241 (+1px `#292929` right border) |
| Sidebar row height | 32 |
| Sidebar active pill | inset 9 from panel edge, 223 wide, radius ~10 *approx* |
| Composer outer tray | 182 tall, radius ~16 *approx*, 1px `#212121` |
| Composer inner card | 129 tall, 7px inset inside the tray, 1px `#353535`, radius ~14 *approx* |
| Composer project row | 40 tall, on `#171717` |
| Background grid | **20px pitch**, 1px `#292929` lines |
| Command palette | ~677 wide, radius ~10 *approx*, 1px `#272727`, top edge at ~22% of window height |
| Reading measure (transcript) | ~745 |

**No drop shadows.** Verified by edge scan: the command palette goes `#0E0E0E` scrim → 1px `#272727`
border → `#171717` panel, with zero gradient. Depth is carried by **scrim + backdrop blur + one hairline**.
The single exception is the 9px `#161616` band under the composer card.

---

## 5. Surface-by-surface

### 5.1 Home / empty state — `01-home.png`

- Near-black canvas carrying a **20px graph-paper grid** that fades out downward via a gradient mask.
- Dead-centre: wordmark glyph, one sentence (*"MiniMax Code makes your work easier."*), the composer,
  and a recommendations card. Nothing else. No stats, no recent-activity grid, no marketing.
- **The grid appears on the home screen only.** Verified: a full column scan of the task view found
  zero non-`#1C1C1C` pixels. Texture marks the *entry* state; the *work* surface is flat.

### 5.2 Composer — `02-composer.png`

A **two-layer stack**, not a single box:

```
┌ outer tray  #1B1B1B, 1px #212121, r≈16 ───────────────┐
│  ┌ input card  #262626, 1px #353535, r≈14 ──────────┐ │
│  │  placeholder …                        (129 tall) │ │
│  │  [+] [⛉ Smart Authorize ⌄]   [◑ Thinking] │ M3 ⌄ [↑] │
│  └───────────────────────────────────────────────────┘ │
│  [📁 Aurora-Agent-IDE ⌄]                     (40 tall) │
└────────────────────────────────────────────────────────┘
```

- The **project context lives *under* the input, inside the same container.** The composer sits *on* its
  workspace. That single structural choice communicates scope better than any label would.
- The empty input reserves **~129px** — roughly four lines of unearned height. The composer is the hero
  and is confident enough to take the space.
- Control-row hierarchy inside one row: left cluster dim (`+`, Smart Authorize), right cluster bright
  (model name), accent on one item (Thinking). Three tiers, no borders, no separators except one hairline `|`.
- **Send is a filled light squircle even when disabled** (`#949494`) — never a ghosted outline.
  Running state swaps the same slot to a `#EDEDED` stop button. The primary action never moves or vanishes.
- **It degrades responsively** — with the Work Area rail open, `Smart Authorize` drops its label to an
  icon and `Thinking` loses its text, but the model name and send survive. Verified in `10-work-area-rail.png`.

### 5.3 Sidebar — `03-sidebar.png`

- **Two tiers separated by space alone, with zero rules or dividers in the entire panel.**
  Tier 1: six icon+label actions, bright. Tier 2: section headers (Scheduled / Projects / Agent Team /
  Archived), label-only, no icon, heavily dimmed — a deliberate quiet zone.
- Active row = inset filled pill. No left accent bar, no border, no accent color. Fill only.
- Agent team members carry **illustrated character avatars** (Coder / Verifier / General), not initials
  or generic glyphs. It's the one playful note in an otherwise severe UI and it does a lot of work —
  the agents read as *entities*, not as config rows.
- Account row pinned to the bottom with a colored circular avatar.

### 5.4 Command palette — `05-command-palette.png`

- **The entire app behind is genuinely blurred and scrimmed to `#0B0B0B`/`#0E0E0E`.** Real backdrop blur,
  not an opacity veil. This is the single most "expensive-feeling" moment in the product.
- Panel reuses the recessed token `#171717` — no new surface color invented for the modal.
- Highlighted row = **full-bleed fill, zero radius**, edge-to-edge. Contrast this with the sidebar's
  *inset pill*. Two selection idioms, correctly split: persistent nav gets a pill, transient list gets a bar.
- Shortcut hints are **plain right-aligned dim text — no keycap boxes**. Rows have no icons at all.
- Section labels (`Recommended`, `Navigation`) are sentence case, dim, aligned to the row text.

### 5.5 Transcript — `07-transcript.png`, `08-tool-group-expanded.png`

This is the most important surface and the biggest departure from convention.

- **Only the user gets a bubble** — a small right-aligned `#262626` pill. The assistant has **no bubble,
  no avatar, no name label, no container.** It is prose on the canvas.
- **Reasoning is a footnote.** `Thought 1 time(s) ›` — dim, body-size, one line, chevron to expand.
  Not a card, not a shimmer, not a panel.
- **Tool calls are single lines with no container at all.** Icon in a 1px rounded-square, label
  (`Terminal` / `Read File`), payload (the command, or a colored filetype icon + filename), `›` to expand.
  No fill, no border, no badge, no status chip, no diff stat.
- **Three-level progressive disclosure**, and the summary is written in *natural language counts*:

  ```
  Thought 1 time(s), Viewed 2 file(s), Ran 1 command(s)  ⌄     ← turn-level aggregate
    ▸ Terminal   cd "E:\…"; graphify query "what is the ove…   ← step list, connected by a
    ▸ Read File  📘 AGENTS.md                                     short vertical hairline
    ▸ Read File  📘 CLAUDE.md
    ▸ Thinking process
  ```

  Not badges. Not chips. A sentence.
- **Answers are typeset as documents**: a full-measure hairline rule sits *above* every heading inside a
  reply, with generous space around it. Inline code renders as subtle monospace chips. Lists indent properly.
- Live status is one dim line with a small accent glyph (`Targeting…`), in the flow — not a banner.
- Disclaimer (*"MiniMax Agent is AI and can make mistakes"*) sits below the composer, tiny, centered, dim.

### 5.6 Task header — `09-task-header.png`

- No divider under the header. It floats.
- **IDE chip is a split control in one rounded container**: real Cursor icon + label + hairline `|` +
  chevron. Click opens; chevron changes IDE.
- Icon buttons (globe / folder / panel) are 1.5px outlines with no fill at rest; the active one takes the
  same `#202020` selected token as everything else.
- Right rail card (`Progress` / *"Track progress on longer tasks."*) is an **outlined card with no fill** —
  a designed empty state with real copy, not a blank panel.

### 5.7 Work Area rail — `10-work-area-rail.png`, `11-rail-header.png`

A full file viewer inside the agent: tab bar → breadcrumb → code viewer + file tree, ~46% of the window.

- Tab chip carries the **real colored VCS/file icon** and sets the filename in *italic* — the VS Code
  preview-tab convention, honored.
- Breadcrumb dims the parent and brightens the leaf.
- Code surface is **recessed (`#171717`)** while the file tree stays at canvas level (`#1C1C1C`) —
  the same "recede the navigation, elevate the content" inversion as the sidebar.
- File tree is the one densely colorful region in the product (filetype icons), and it earns it —
  color is doing identification work, not decoration.
- Opening the rail **narrows the conversation column and the composer with it** — the composer is bound
  to the conversation, not to the window.

---

## 6. The distinct moves — what actually makes it read premium

These are the transferable rules, ordered by how much they contribute:

1. **Nine greys, one accent hue.** No second accent, no semantic color at rest, no gradient fills.
2. **No shadows.** Depth = scrim + real backdrop blur + one hairline. Verified by edge scan.
3. **The transcript has no cards.** Every step is a line. Containers are reserved for *input*, never for *output*.
4. **Progress is narrated, not badged** — "Thought 2 time(s), Viewed 1 file(s), Ran 4 command(s)".
5. **Answers are typeset**: reading measure ~745px, 1.6 line-height, hairline rules above headings,
   weight-only emphasis.
6. **Recede the chrome, elevate the content.** Sidebar and code viewer are darker than the canvas.
7. **One selected-state token, reused everywhere** — but *two* selection shapes, split by context
   (inset pill for persistent nav, full-bleed bar for transient lists).
8. **The primary action never ghosts.** Send stays a solid light fill when disabled and swaps in place to stop.
9. **Texture marks the empty state only.** The 20px grid exists on home and nowhere else.
10. **Space does the grouping.** The sidebar has zero dividers; the transcript separates blocks with ~40px gaps.

---

## 7. Where it is weak — do *not* copy these

- **Reasoning is under-served.** `Thought 1 time(s)` is grammatically awkward and gives no preview of
  *what* was thought. Aurora's collapsed-reasoning treatment is already better.
- **Tool rows carry no outcome.** No exit status, no duration, no diff stat, no error color. You cannot
  tell a failed command from a successful one without expanding it. This is a real information loss,
  and it is the one place where their minimalism costs the user something.
- **Truncated commands with no tooltip** — a long command is `…`-clipped mid-path with no hover reveal.
- **Section headers in the sidebar are dimmed to near-invisibility** and are also the only affordance for
  expanding those groups. Contrast is below a comfortable threshold.
- **The recommendation tab set silently reshuffles** between sessions (Office/Product/Content/VibeCoding →
  Design/Finance/Product/Content). A control that changes its own options between visits is not learnable.
- **Empty-state copy is generic** — "MiniMax Code makes your work easier" says nothing.

---

## 8. Aurora delta — verified against the source

> ✅ **Read from code**, not from a probe of Aurora's running window: `src/apps/agent/theme/themes.ts`,
> `theme/agent-window.css` (13,034 lines), `components/tools/ToolCallCard.tsx`.
> Rendered appearance still unverified — a probe pass on Aurora is the remaining gap.

**My first hypothesis was wrong and is corrected here.** I assumed Aurora wrapped tool output in heavy
cards. It does not: `.agw-tool-head` is `background: transparent`, `border: none`, with a hover-only fill,
and `.agw-tool-body` is explicitly *"indented under the row with a quiet left rail (no box)"*. Structurally
Aurora's tool row is **already the MiniMax model.**

| Dimension | MiniMax Code | Aurora (verified in source) |
|---|---|---|
| Tool row container | borderless line | **borderless line** — same |
| Distinct surface/border greys | 9 | **9** — same count |
| Radius scale | ~4 values | 4 role-named tokens; 228/295 declarations use them |
| Drop shadows | zero | ~15–20 real ones + a `shadowPop` token (of 111 `box-shadow` decls, 53 are focus rings, 16 inset, 11 tokenized) |
| Accent | `#0077D9` saturated | `#3994bc` **desaturated teal** |
| Surface order | nav `#171717` **darker** than canvas `#1C1C1C` | **inverted** — rail/canvas `#161616` lighter, conversation `#0f0f0f` recessed |
| Prose | 15px / 1.6 (24px) | 15px / 1.75 (26px) — airier |
| Metadata inside a row | plain text + one colored filetype icon | **boxed 10px atoms** — see below |
| Semantic color | none | `added` / `removed` / `warning` / `info` |

### The one real divergence

Aurora's rows are flat, but **their contents are boxed.** A single `shell_execute` row can carry a status
dot, a `.agw-shell-badge` (1px border + `chip-surface` fill + its own colored dot, set in **10px mono**),
several `.agw-tool-chip` file chips (1px border + fill + icon, capped at 220px), a `+N/−N` stat, and a
duration. MiniMax renders the same information as ~14px plain text with a single colored filetype icon
and no border anywhere.

That is the difference worth acting on, and it is not "too much data" — it is **structure applied at a size
too small to read as structure.** A 1px border around 10px text is the classic busy/cheap signal; the
information survives perfectly well as plain colored text.

Ranked experiments, cheapest first:

1. **Debox the micro-atoms.** Drop the border+fill from `.agw-shell-badge` and `.agw-tool-chip`; keep the
   icon, the color, and the text. Raise them off 10px. Nothing is lost — `.agw-chip-stat` already proves
   the pattern (plain text, semantic color, no box).
2. **Question the inverted surface order.** Aurora deliberately sinks the conversation into a lighter frame
   (documented as *"a stage sunken into a bezel"*, sampled from Codex). MiniMax does the opposite and the
   chrome stops competing with the work. Worth an A/B, not a blind flip — this one is a real design fork,
   not a defect.
3. **Test a saturated accent.** `#3994bc` on `#161616` is a low-chroma teal; on near-black, desaturated
   accents read faded rather than calm. MiniMax gets a lot of confidence out of one vivid hue used once.

Explicitly **not** recommended: removing diff stats, shell identity, or status color. Those are Aurora's
genuine advantage — MiniMax cannot distinguish a failed command from a successful one without expanding it.

---

## 9. Reproducing the probe

```powershell
# 1. locate + focus the window
#    mcp__qg-probe__list_windows → set_target(process_name) → focus_window  (also dumps the UIA tree)

# 2. raw capture at physical resolution
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap($w,$h)
[System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($x,$y,0,0,(New-Object System.Drawing.Size($w,$h)))

# 3. exact color: $bmp.GetPixel($x,$y)
# 4. exact geometry: run-length scan a row/column and read the boundaries
# 5. zoom crops with InterpolationMode = NearestNeighbor (never bicubic — it invents edge colors)
```

Two traps worth remembering:

- **ClearType subpixel rendering poisons text-color samples** — sampling a glyph edge returns warm/cold
  fringes (`#EDCFA3`, `#473126`). Sample the middle of a thick stroke, or take the extremum over a box.
- **A DPI-unaware PowerShell reports 96 DPI while capturing real physical pixels.** Get the true scale
  from a known ruler (window caption glyph height) before converting anything.

---

## 10. Template for the next app

Keep sections 1–7 identical so studies stack. Minimum bar for each one:

- [ ] §2 palette sampled with `GetPixel`, **not** estimated — including scrim, selected, hairline, disabled
- [ ] §3 type from measured glyph bands + line pitch, converted to CSS px
- [ ] §4 at least four run-length edge scans (nav width, row height, primary card, modal)
- [ ] §5 five surfaces minimum: empty state · composer · nav · overlay/modal · transcript with tools expanded
- [ ] §6 exactly the transferable rules, ranked
- [ ] §7 the weaknesses — a study with no criticism was not a study
- [ ] frames saved to `DOCS/visual-studies/<app>/`

Next up per the plan: further apps in the series, then a probe pass on Aurora's own agent window so the
§8 column stops being a hypothesis.
