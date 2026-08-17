# Visual Study 02 — Google Antigravity

**Probed:** 2026-08-09 · **Window:** "Refining S2 Studio Backend" (Electron) · **Model shown:** Claude Opus 4.6 (Thinking)
**Method:** `qg-probe` UIA tree + click-through of live controls + framebuffer capture + per-pixel sampling.
**Reference frames:** `antigravity/01..05*.png (same folder)`
**Surfaces exercised by clicking:** activity disclosure (`Worked for …`), per-turn `Review`, auxiliary-pane `Overview`.

> **Measurement note.** Display at **150%**; captures are physical px, all values below divided by 1.5 and
> stated in **CSS px**, ±1. Colors sampled exactly. See Study 01 §9 for the probe recipe and its two traps.

---

## 1. The one-sentence read

Antigravity is **an agent with a project manager attached**: the transcript itself is the calmest of the
three apps studied, and everything heavy — diffs, files touched, artifacts, subagents, background tasks —
is evacuated into an auxiliary pane that can be scoped to a single turn.

---

## 2. Palette — measured

| Token (measured) | Role |
|---|---|
| `#101010` | **conversation sheet — recessed**, the darkest surface |
| `#161616` | sidebar / frame chrome |
| `#1C1C1C` | user message card, composer fill |
| `#2C321E` | diff **added** row tint (desaturated olive) |
| maroon ≈ `#3A1E1E` | diff **removed** row tint |
| `#D7BA7D` | **inline code / filename accent — warm amber** (the VS Code Dark+ string hue) |
| green / red | `+N` / `−N` diff stats |
| amber | `MCP Error` state in the composer |
| blue | the `Open IDE` mark |

**The finding that matters most for us:** Antigravity's surface order is
`chrome #161616 lighter` → `conversation #101010 recessed`.

Aurora is `rail/canvas #161616` → `conversation #0f0f0f`. That is **the same decision, within one
step of the same values.** MiniMax (Study 01) does the opposite. Two of three ship the recessed
conversation — see §7.

Unlike MiniMax's single accent, Antigravity runs a **warm amber for code identity** plus semantic
green/red plus a status amber. It is more colorful, and it does not read cheap, because every one of
those colors is doing identification work.

---

## 3. Type

| Element | Size | Line-height |
|---|---|---|
| Assistant prose | ~15px | **23px (≈1.55)** |
| Inline code / filename chips | ~13px mono | — |
| Activity step row | ~14px | — |

Emphasis is weight-only within prose. Bold lead-ins on list items (`**Example Texts accordion** — …`)
carry the structure. Same restraint as MiniMax.

For comparison across the series: **MiniMax 15/24 (1.6) · Antigravity 15/23 (1.55) · Aurora 15/26.25 (1.75)**.
Aurora is the airiest of the three by a clear margin.

---

## 4. Surface-by-surface

### 4.0 Empty state — `06-empty-state.png`

**It is the exact inverse of MiniMax's, and it is the most confident screen in any of the three apps.**

There is no headline, no wordmark, no logo, no greeting, no suggestion chips, no recent files, no
texture. The **entire header bar disappears** — no breadcrumb, no `Open IDE`, no aux-pane toggle. What
remains, at ~38% down the canvas, is one object:

```
  [📁 alvan-tts-webui 2 ⌄]                    ← project chip, OUTSIDE and above the card
┌──────────────────────────────────────────┐  ← 1px #252525, r≈12
│  Ask anything, @ to mention, / for actions│
│  [+] [Claude Opus 4.6 (Thinking) ⌄] [⚠ MCP Error]        [🎤] │   #1C1C1C, 80px
├──────────────────────────────────────────┤
│  [🖥 Local ⌄]                              │   #252525, 35px — environment tray
└──────────────────────────────────────────┘
                 640px wide
```

Measured: card **640 × 80px**, tray **35px**, border `#252525`, amber `#EAB308` (Tailwind yellow-500).

Three things worth taking:

- **The composer is a two-tier stack with a context tray attached below it** — structurally the *same
  idea as MiniMax*, which attaches the project row under its input. Two of three converge on this.
  Antigravity inverts the tone though: its tray (`#252525`) is **lighter** than the input (`#1C1C1C`),
  where MiniMax's tray (`#171717`) is **darker** than its input (`#262626`). The border value is simply
  promoted to a fill — one token doing two jobs.
- **`Select Environment` (`🖥 Local ⌄`) exists only in the empty state.** Once a turn has run it is gone,
  replaced in the live composer by the `Worktree` chip. Environment is a *pre-flight* decision; worktree
  is a *running-state fact*. Different questions, so different controls — not one control with two modes.
- **The project chip sits outside the card, above it.** MiniMax puts the project *inside* the container.
  Antigravity's reads as "this is what I'm pointed at"; MiniMax's reads as "this is part of the message".

The cost of this restraint is real: a first-time user is given **zero** discovery. MiniMax's suggestion
tabs at least name what the product can do. Antigravity assumes you already know — defensible for a
daily driver, weak for onboarding.

### 4.1 Transcript — `01-chat.png`, `02-response-diffbar.png`

- **Only the user is contained** — a full-measure, left-aligned rounded card (`#1C1C1C`, r≈12).
  Assistant responses are bare prose on the sheet. (MiniMax reaches the same conclusion with a *small
  right-aligned pill*; Antigravity uses a *full-width block*. Both agree the assistant gets no container.)
- **Timestamps exist in the accessibility tree but are not painted at rest** — they appear with the
  hover action row.
- **Per-message action row**: copy · 👍 · 👎 on responses; copy · **↺ revert** on user messages.
  That revert is per-message rollback, sitting directly on the message that caused the change.
- One awkward detail: the hover action row **overlaps the last line of the user card** behind a gradient
  fade, so live text is partially masked by controls.

#### The user bubble is STICKY — the best idea in the transcript — `10-user-bubble-sticky.png`, `11-sticky-swap.png`

Verified by scrolling a live two-turn conversation up and down. **The user's message pins to the top of
the scroll viewport and the agent's response scrolls underneath it.** Content passing beneath dissolves
into a gradient fade at the bubble's lower edge. Scroll far enough and the pinned bubble **swaps** to the
adjacent turn's message.

The effect: **you can never lose the question while reading the answer.** On a long response — and agent
responses are long — the instruction that produced it is always on screen, one glance away. Nothing in
MiniMax or Aurora does this; both let the prompt scroll away and leave you re-deriving what was asked.

This also explains an artefact I had misread: in every earlier capture the user bubble sat at the same
y-position regardless of scroll. That was not coincidence, it was the pin.

#### …and it is undermined by a broken clamp — `09-user-bubble-clamp.png`

Long user messages are clamped to **5 lines**, and the 6th is **cut through the middle of its glyphs** by
a mask fading to the card fill — `of the codebase before I change anything.` renders as a half-height
smear. Measured on a 515-character message.

- The cut is mid-glyph, not at a line boundary — a `max-height` + mask, **not** `-webkit-line-clamp`,
  which would end cleanly.
- ⚠️ **CORRECTION (verified by clicking it).** An earlier draft of this section said "there is no expand
  control." **That is wrong.** Clicking the bubble expands it — 5 clamped lines → the full 7, with the
  timestamp, Copy and Revert appearing inline. The control exists; it is **the whole bubble, unlabelled**.
  No chevron, no "show more", no visible affordance, and the card's bottom padding continues normally
  below the smear so it still looks *finished*. So the defect is discoverability, not absence.
- **Aurora's equivalent is better and should not be changed to match.** Aurora clamps the user bubble at
  6 lines (`--agw-msg-user-line-height × 6`) and exposes a real `<button>` with
  `aria-label="Show full message"` that appears only when there is something to expand — labelled,
  keyboard-reachable, and it ends at a line boundary instead of slicing a glyph in half.
- Worse in combination: the clamp fade sits directly above the sticky scroll fade, so you get a
  half-faded line of user text touching a half-faded line of assistant text. **Two different truncations
  meeting**, which reads as a rendering bug rather than either intention.

A great mechanic (sticky) wrecked by a careless one (mask-clamp with no affordance). Take the first, not
the second.

### 4.2 Activity disclosure — `03-activity-steps.png`

Collapsed, a turn shows one dim line: **`Worked for 57s ⌄`**. Duration only — even terser than
MiniMax's "Thought 2 time(s), Viewed 1 file(s), Ran 4 command(s)".

Expanded, the steps are **sentences, not tool calls**:

```
Explored 1 file  ›
Edited  🐍 tts_tab.py  +29 −81
```

A second, richer sample captured live (`12-step-vocabulary.png`) shows the full verb set:

```
Worked for 13s  ⌄
  Explored 4 files, 2 folders  ›          ← counted group header
  Analyzed  e:\VOID-EDITOR\Aurora-Agent-IDE      ← folder, clickable
  Analyzed  package.json#L1-92                   ← FILE + EXACT LINE RANGE, clickable
  Analyzed  README.md#L1-227
  Analyzed  CLAUDE.md#L1-354
  Analyzed  HANDOFF.md#L1-180
  Analyzed  e:\VOID-EDITOR\Aurora-Agent-IDE\graphify-out
  Thought for 1s  ›
```

Two things I under-recorded on the first pass: **the line range actually read is part of the step label**
(`package.json#L1-92`), and **every file/folder in a step is a clickable button**. Reasoning is its own
step (`Thought for 1s`) inline in the sequence rather than a separate treatment. Verbs seen so far:
`Explored` · `Analyzed` · `Edited` · `Thought for`.

The grammar is fixed and it is the single most transferable thing in this app:

> **dim verb · colored filetype icon · bright object · colored stats — and no container.**

No borders. No fills. No status dots. No monospace badges. The *tool* is never named — `Edited` and
`Explored` are outcomes, not `file_write` and `grep`.

### 4.3 Auxiliary pane → Review — `04-review-pane.png`

Opened from the `Review` button that closes every response that changed files.

- Response footer bar (the one bordered container in a response): `2 files changed  +29 −13  ›` on the
  left, `[⧉ Review]` on the right.
- The pane header reads **`Review Changes` · `For turn ✕` · "why rest of 2 tab showing…"** — the diff is
  **scoped to the turn you clicked from, and it names that turn using the user's own words**, with a
  dismissible chip to widen back to the whole session. This is the best idea in the app.
- Diff body: **dual line-number gutters** (old | new), full-bleed row tints, syntax highlighting inside
  the diff, and GitHub-style context expansion — `+422 more lines` with stacked `+10` / `+10` controls.

### 4.4 Auxiliary pane → Overview — `05-overview-pane.png`

A live session dashboard, and the structural idea Aurora does not have:

```
Subagents        (0)  ›
Files Changed    (5)  ⌄
   🐍 tts_tab.py     ui/tabs
   🐍 gradio_app.py  ui
   </> index.html    ui/custom_frontend
   {} style.css      ui/custom_frontend
   JS script.js      ui/custom_frontend
Artifacts        (6)  ⌄
   Media (Apr 26 5:31 AM) · Media (Apr 26 5:30 AM)
   Scratchpad C0yeb91a.md.resolved · Scratchpad C0yeb91a.md · Scratchpad
   See all (6)
Background Tasks (0)  ›
```

- Section header = dim label + **count in a rounded pill** + chevron.
- Rows reuse the transcript's grammar exactly: colored icon + bright name + dim path. No boxes.
- **Zero-count sections stay visible.** `Subagents 0` and `Background Tasks 0` are not hidden — the
  session's capability surface is always legible, which teaches the product's model of itself.

### 4.5 Composer (live conversation)

`Ask anything, @ to mention, / for actions` · `+` · **`Worktree`** chip · model
(`Claude Opus 4.6 (Thinking) ^`) · **`⚠ MCP Error`** · 🎤

- **No send button** — Enter sends; the mic occupies that slot.
- **Git worktree is a first-class composer control**, not a setting.
- **MCP health is surfaced in the composer chrome**, in amber, permanently. Integration failure is
  treated as something you must see before you type, not something buried in a settings page.
- The composer **changes its controls by state**: the empty state carries `Select Environment`, the live
  conversation carries `Worktree`, and the project chip drops away once the breadcrumb can show it. The
  composer is not one component with everything on it — it is the same shell with a state-appropriate
  control set. See §4.0.

### 4.5b Send → running → done, observed live — `07-completed-turn.png`, `08-answer-top.png`

Sent a real read-only turn (`check the project and let me know what it is…`, Gemini 3.6 Flash, on
`Aurora-Agent-IDE`). What the state machine actually does:

- **The Send button does not exist until the box has text.** Empty composer → mic only, no send
  affordance anywhere. Type → `Send message` appears; clear the box → it vanishes again. Verified by
  clearing and retyping. **This is the exact opposite of MiniMax**, which keeps a solid light-filled
  send button on screen permanently and merely disables it (`#949494`).
- **Running:** the response slot shows `Working` plus an animated `…` — that is the entire live
  indicator. No spinner, no progress bar, no streaming tool rows.
- **`Send message` → `Cancel (Ctrl+D)`.** Note the word: *Cancel*, not *Stop*, and it **advertises its
  shortcut in the label**. MiniMax swaps the same slot to a stop glyph with no text.
- **The header bar materialises on send.** In the empty state there is no breadcrumb, no `Open IDE`, no
  `Toggle Auxiliary Pane`; all three appear the moment a conversation exists.
- **`Select Environment` → `Worktree`** in the composer, confirming §4.0 live.
- **The sidebar entry appears instantly**, titled with the raw message text and aged `now`; the
  generated title arrives later.
- **Timestamps are relative to today** — this turn reads `7:59 AM`, the four-month-old ones read
  `5:29 AM, 4/26/2026`.

The important structural finding:

> **`Worked for 13s` appeared even though nothing was edited — the activity summary is unconditional.
> The `N files changed +A −B [Review]` footer did NOT appear — the change footer is conditional.**

So a response has two independent closers: an activity summary that is always present, and a change
footer that exists only when the turn touched files. A read-only turn therefore costs the transcript
exactly one dim line.

One more grammar sighting: file references inside prose get **colored filetype icons inline** —
`📘 README.md — Feature overview & setup instructions`. Same dim-verb/bright-object/colored-icon rule
as the activity steps and the Overview pane. Three surfaces, one rule.

### 4.6 Sidebar

Projects → conversations nested under them, each with a branch glyph and a relative age (`4mo`, `3mo`);
selected conversation is a filled pill; one entry carries a blue activity dot. `New Conversation` is an
**outlined** full-width button (not filled). `Settings` pinned bottom-left. No dividers anywhere.

---

## 5. The distinct moves

1. **Turn-scoped review.** `Review Changes · For turn: "<the user's own sentence>" ✕`. Diff filtered to
   one instruction, labelled in the user's language, one click to widen.
2. **Steps are outcomes, not tools.** `Edited tts_tab.py +29 −81`, never `file_write`.
3. **One row grammar everywhere** — dim verb · colored icon · bright object · colored stat · no container.
   The transcript and the Overview pane are typographically the same thing.
4. **The heavy stuff lives in a pane, not the conversation.** The transcript never has to carry a diff.
5. **Counts as pills, empties kept.** `Subagents (0)` stays on screen.
6. **Rollback sits on the message that caused it** (↺ per user message).
7. **Health in the composer.** MCP failure is amber, permanent, next to where you type.
8. **Response footer is the only bordered container in a response.** Everything else is bare.
9. **An empty state that is actually empty** — composer only, header bar removed, no headline or
   suggestions. And a **two-tier composer with a context tray attached below**, which MiniMax also does.
10. **Controls change with state, not with modes.** `Select Environment` before the first turn,
    `Worktree` after it — never both, never one control pretending to be two.
11. **The send button is born from input** and dies with it — no permanently-parked disabled control.
12. **Two independent response closers**: the activity summary is unconditional, the change footer is
    conditional on files having been touched. A read-only turn costs one dim line and nothing else.
13. **`Cancel (Ctrl+D)`** — the stop control is a word, not a glyph, and it teaches its own shortcut.
14. **The user message is sticky-pinned** to the top of the viewport while its response scrolls beneath
    it, swapping per turn. You can never lose the question while reading the answer. *Best idea in the
    transcript, and unique among the three apps.*
15. **Steps carry the exact line range read** (`README.md#L1-227`) and every path in a step is clickable.

---

## 6. Where it is weak — do *not* copy

- **Hover actions overlap live text** on user cards behind a gradient fade. Genuinely bad.
- **The 5-line user-message clamp cuts mid-glyph and hides its own control.** Mask-based rather than
  `line-clamp`, so the 6th line is sliced through the middle of its letters, and the only way to expand
  is to click the bubble — which nothing on screen tells you. It also collides with the sticky scroll
  fade, stacking two fades into what looks like a render bug. Copy the sticky pin; do not copy this.
  Aurora's labelled chevron + line-boundary clamp is the better half of this pair. See §4.1.
- **`Worked for 57s` says nothing about what happened.** Duration alone is a weaker collapsed summary
  than MiniMax's counts — you cannot tell a 57s read from a 57s refactor.
- **No visible outcome on steps.** Like MiniMax, a failed step is not distinguishable from a successful
  one until you expand it. Aurora is still ahead here.
- **The left gutter is dead space** at this window width — the conversation is centered on a narrow
  measure with a wide empty band beside it and the aux pane closed.
- **Two "Review" affordances** (response footer button and pane tab) with the same name and different
  scopes.
- **The empty state offers zero discovery.** No suggestions, no capability hints, no recent work. Fine
  for a daily driver, poor for a first run — MiniMax at least names what it can do.

---

## 7. Cross-study: what two apps agreeing tells us

| Dimension | MiniMax | Antigravity | Aurora | Verdict |
|---|---|---|---|---|
| Assistant gets a container | no | no | no | **settled — all three agree** |
| Conversation surface vs chrome | chrome recedes | **chrome lighter, convo recessed** | **chrome lighter, convo recessed** | Aurora is with Antigravity; **MiniMax is the outlier** |
| Tool step container | none | none | none (`.agw-tool-head` transparent) | **settled** |
| Step metadata | plain text | plain text + colored icon | **1px-bordered 10px chips** | **Aurora is the outlier** |
| Collapsed turn summary | counts | duration | spine/chapters | no consensus |
| Prose line-height | 1.6 | 1.55 | **1.75** | Aurora is the airiest |
| Diff surface | none | turn-scoped pane | transcript-derived panel | Antigravity leads |
| Session dashboard | none | **Overview pane** | none | Antigravity alone |
| Rollback | none | per-message ↺ | none in agent window | Antigravity alone |
| Empty state | wordmark + headline + 20 suggestions + grid texture | **composer only, header removed** | to probe | opposite poles; Antigravity is the more premium read |
| Composer shape | input card + **project tray below** | input card + **environment tray below** | single card | **two of three attach a context tray** |
| Send affordance | always present, solid fill even when disabled (`#949494`) | **does not exist until there is text** | to probe | opposite philosophies |
| Stop control | glyph only | **`Cancel (Ctrl+D)`** — word + shortcut | to probe | Antigravity teaches; MiniMax assumes |
| Read-only turn cost | counts line | **one dim `Worked for 13s` line, no footer** | tool cards regardless | Antigravity cheapest |
| User message while reading the answer | scrolls away | **sticky-pinned, swaps per turn** | scrolls away | **Antigravity alone — steal this** |
| Long user message | clamped, expands | clamped mid-glyph; expand = click the bubble, **unlabelled** | 6-line clamp + **labelled chevron**, cuts at a line boundary | **Aurora's is the best of the three** |
| Step detail | command text | **file + exact line range, clickable** | file chips + diff stat | Antigravity most precise |

**Study 01's recommendation #2 is now retracted.** I suggested A/B-ing Aurora's recessed conversation
against MiniMax's inverted order. Antigravity — Google's flagship agentic IDE — ships almost exactly
Aurora's values (`#161616` chrome / `#101010` sheet vs Aurora's `#161616` / `#0f0f0f`). Two of three
agree with Aurora. **Leave the surface order alone.**

**Study 01's recommendation #1 is now strongly reinforced.** Aurora is the only one of the three that
boxes its step metadata. Both competitors render the same information as plain text with a colored icon.

---

## 8. What Aurora should take from this

Ranked, and deliberately short:

1. **Debox the step metadata** (unchanged from Study 01, now confirmed twice over). `.agw-shell-badge`
   and `.agw-tool-chip` lose their border and fill; keep the icon, the color, the text; come off 10px.
   Adopt Antigravity's grammar — dim verb · colored icon · bright object · colored stat.
2. **An Overview pane.** Aurora already computes everything it needs and throws it away — `.knowledge`
   records that per-turn cost is derived then discarded and that no turn digest exists, while
   `review.ts::collectFileChanges` already walks tool results for files touched, and artifacts are
   already stored per thread. Files Changed · Artifacts · Background Tasks · Cost is assembly, not new
   plumbing. Keep zero-count sections visible.
3. **Scope the Review panel to a turn**, with a dismissible `For turn: "<user's words>"` chip.
   Aurora's `ReviewPanel` is whole-session and transcript-derived; turn scoping is the cheaper half of
   fixing it and is the single most-copyable idea in this app.
4. **Put MCP health in the composer.** Aurora has an MCP manager and no ambient failure signal.
5. **Consider the attached context tray.** Both competitors build the composer as *input card + a tray
   below it carrying the run context* — MiniMax the project, Antigravity the environment. Aurora's is a
   single card, and its project/workspace identity lives elsewhere. Worth a probe of Aurora's composer
   before deciding, but two of three converging is a signal, not a coincidence.
6. **Let the composer's controls follow state.** Antigravity shows `Select Environment` only before the
   first turn and `Worktree` only after. Aurora's composer carries the same control set throughout.
7. **Sticky-pin the user message.** Promoted to the top of this list on merit — it is pure CSS
   (`position: sticky` on the user row inside the transcript scroller, plus a mask-image fade on the
   content beneath), it costs no new data, and it fixes a real daily annoyance: losing the question
   while reading a long answer. Aurora's `.agw-row[data-row]` wrapper already gives the hook. If Aurora
   clamps long user messages too, give the clamp a real **expand control** — that is exactly the part
   Antigravity got wrong.

Not recommended: copying `Worked for 57s` (duration-only is weaker than what Aurora's spine/chapters
already convey), or the hover-overlaps-text pattern.

---

## 9. Next

Study 03 candidate to be chosen by the owner. The remaining gap across the whole series is unchanged:
**Aurora's own agent window has still never been probed visually** — every Aurora value in §7 is read
from source. That probe should happen before any of §8 is implemented, so the before/after is real.
