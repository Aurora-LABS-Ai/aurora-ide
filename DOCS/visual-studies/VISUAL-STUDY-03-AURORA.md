# Visual Study 03 — Aurora Agent (ourselves)

**Probed:** 2026-08-09 · **Build:** dev server (`http://localhost:5173/agent-window`), **not** the packaged exe
**Workspace under test:** `spotify-multi-profile-chrome` · **Model:** Agnes 2.5 Flash
**Method:** `qg-probe` UIA (`deep`) + real send + scroll + framebuffer capture + per-pixel sampling.

> This closes the gap flagged in Studies 01 and 02, where every Aurora value was read from source.
> Everything below is **measured from the running app**.

---

## 0. Two corrections to my own earlier claims

- **Aurora is not inaccessible.** A default `dump_tree` returns 2 nodes because it stops at the WebView2
  boundary; `deep: true` returns the full 120-node tree. Probe artifact, not a defect.
- **The typing-assist ghost does not leak into the sent message.** The composer's a11y `value` reads
  `…what it does.this→` (ghost + accept affordance included), which looked like a send-path bug. It is
  not: the delivered user message was exactly the typed text. `.knowledge`'s claim that the ghost is a
  pure rendering artifact is confirmed live.

---

## 1. The one-sentence read

Aurora's transcript **says more per step than either competitor** — and then buries the answer under
seven rows of scaffolding that say almost nothing.

---

## 2. Palette — measured live

| Measured | Role |
|---|---|
| `#0F0F0F` | conversation sheet — **recessed** |
| `#171717` | rail / frame chrome |
| `#202020` | composer fill |
| `#232323` | rail right border, 1px |
| `#343434` | composer border, 1px |
| `#131313` | the empty-state wordmark, on `#0F0F0F` — **ΔR = 4** |

Surface order confirmed live: **chrome lighter, conversation recessed.** Identical in kind to
Antigravity (`#161616` / `#101010`), opposite to MiniMax. **Study 01's advice to reconsider this is
retracted for good — Aurora is right and has independent company.**

Note the composer reads `#202020`, not the `#2e2e2e` in `themes.ts` — this profile is running a
customised or non-default theme, so treat these as *this build's* values.

---

## 3. The empty state

`aurora` wordmark, project chip, composer, disclaimer, four suggestions.

**Right:**
- The **project chip sits above and outside the composer** with a dim parent path — Antigravity's exact
  pattern, plus information Antigravity doesn't give.
- Suggestions are **project-specific** ("Explain how spotify-multi-profile-chrome is organized"), which
  beats MiniMax's generic category tabs and Antigravity's nothing-at-all.
- The rail shows a **chat count per project** (41, 12, 54, …) — neither competitor does.

**Wrong:**
- The **giant `aurora` watermark** is the largest element on screen at `#131313` on `#0F0F0F` —
  **4 levels of red above the background**. It is simultaneously enormous and nearly invisible, which
  reads as a rendering artifact rather than a mark. Neither competitor puts a watermark on the canvas;
  MiniMax uses a small glyph + one sentence, Antigravity uses nothing.
- The composer cluster sits at ~48% with a **large dead band below it** (roughly the bottom quarter of
  the canvas is empty). Antigravity anchors at ~38%; the weight sits better.
- **Two adjacent near-identical glyphs** in the control row: `Refine prompt` (✦) and
  `Start speech input` (🎤) render as the same small vertical-stroke shape at this size. They are
  different actions and they look alike.
- The control row is one lonely `+` at far left, then ~1100px of nothing, then four controls jammed
  right. `Agnes 2.5 Flash` is the **brightest text in the composer** — the model selector out-shouts
  the input placeholder.
- Composer is a **single card, 109px** — no attached context tray. Both competitors attach one
  (MiniMax the project, Antigravity the environment).

---

## 4. The transcript — where the real problem is

Aurora's per-step content is **the best of the three**:

```
Inspect Workspace  [directory]  36 files      0.8s
Find Files                      10210 files   0.8s
Find Files                      No matches    0.8s
Read File  [package.json]       Read 20 lines
Read File  [engine.js]          Read 50 lines
Read File  [knowledge.md]       Read 199 lines
```

Tool · target · **outcome** · duration. MiniMax gives tool + target. Antigravity gives verb + target +
line range. **Only Aurora tells you what came back** (`No matches`, `36 files`, `Read 199 lines`), and
only Aurora reports per-call duration. Group headers carry `3 calls · 3 done · 2.5s` — a
call/success/duration triple neither competitor has.

### And here is the defect

Collapsed, one turn renders as **seven separate rows before a single word of the answer**:

```
AURORA
├ ›  Thought ————————— <0.1s ————————————————————
├ ›  ≋ 3 calls · 3 done · 2.5s
├ ›  Thought ————————— 0.1s —————————————————————
├ ›  ≋ 4 calls · 4 done
├ ›  Thought ————————— 0.1s —————————————————————
├ ›  ≋ 4 calls · 4 done
├ ›  Thought ————————— 0.1s —————————————————————
└  Alvan Private Profile Manager — an Electron desktop app for…
```

Four of those rows say **`Thought 0.1s`**. Two say **`4 calls · 4 done`** — the same string twice,
indistinguishable. Each `Thought` row also draws a **long horizontal rule to the right edge**, so three
of them read as `<hr>` section breaks slicing the response into meaningless bands. The spine adds a
vertical hairline and seven markers on top.

Compare the same moment in the other two:

| | rows before the answer |
|---|---|
| Antigravity | **1** — `Worked for 13s ⌄` |
| MiniMax | **1** — `Thought 2 time(s), Viewed 1 file(s), Ran 4 command(s) ⌄` |
| **Aurora** | **7** |

**This is the "not premium" feeling, and it is not a token problem.** Aurora renders the turn's
*scaffolding* at the same visual weight and in greater quantity than the turn's *content*. The eye
walks seven dim, half-repeating rows before reaching the sentence it came for.

Aurora already computes the aggregate — `Worked 14s · Copy · Retry` sits at the **bottom** of the
response. Antigravity puts the identical information at the **top**, where you look first.

**But do not read this as "Aurora should collapse to one row."** Aurora's interleaving — model prose
between tool batches — is a capability the other two lack, and it is deliberately persisted. The
problem is that a row labelled `Thought 0.1s` advertises a *duration* for content you cannot see, and
two rows labelled `4 calls · 4 done` are indistinguishable. Fix the labels, keep the rows. See §6.1.

### Other transcript findings

- **No sticky user message.** The prompt scrolls away; at the bottom of a long answer the question is
  gone. Antigravity pins it. This is Aurora's clearest borrowable win.
- **The header duplicates the title**: `Project Overview React application for building responsive w`
  on the left *and* `✓ Project Overview React ap… finished` as a chip on the right — the same string
  twice in one row, both truncated, the left one cut mid-word with no ellipsis.
- That auto-title is also **wrong** — the project is an Electron/Camoufox profile manager, not a React
  responsive app.
- **Markdown tables break words mid-word** (`Sidec/ar`, `Relea/se`) because the first column is not
  min-content aware. Neither competitor rendered a table; Aurora does, and the column sizing is wrong.
- Headings inside answers have **no rule above them** — both competitors use a full-measure hairline.
- The user bubble's `Copy` sits outside and below the bubble, always visible, consuming another row.

---

## 5. Cross-study verdict

| Dimension | MiniMax | Antigravity | **Aurora** |
|---|---|---|---|
| Step content | tool + target | verb + target + line range | **tool + target + outcome + duration** ✅ |
| Group header | counts | duration | **calls · done · duration** ✅ |
| Rows before the answer | 1 | 1 | **7** ❌ |
| Aggregate placement | top | top | **bottom** ❌ |
| Sticky user message | no | **yes** | no ❌ |
| Session dashboard | no | **yes** | no ❌ |
| Turn-scoped review | no | **yes** | no ❌ |
| Empty-state guidance | generic ×20 | none | **project-specific ×4** ✅ |
| Per-project chat counts | no | no | **yes** ✅ |
| Surface order | inverted | recessed | **recessed** ✅ |

Aurora wins on **information**. It loses on **compression**.

---

## 6. What to do — ranked

1. **Label every scaffold row by its content, not its duration.** ⚠️ *This replaces an earlier
   recommendation — see the retraction box below.*

   The defect is **not** the number of rows. It is that the rows are labelled with **metadata about
   something you cannot see**:

   | today | should be |
   |---|---|
   | `Thought 0.1s` | `Thought · "graphify-out is populated — reading the docs next"` (duration moves right, dim) |
   | `4 calls · 4 done` | `Read 4 files · package.json, engine.js, index.html, sidecar.py` |
   | `4 calls · 4 done` | `Searched 2 patterns · 10210 files, no matches` |

   Seven rows that each say something different are a **narrative**. Seven rows that say
   `Thought 0.1s` four times and `4 calls · 4 done` twice are noise — and it is the *sameness*, not the
   *count*, that makes them noise. First line of the thinking block becomes the row label; the group
   header names what the batch did instead of counting it.

   This is also strictly better than either competitor. Both solve the noise problem by **hiding**
   (`Worked for 13s`, one lump). Aurora can solve it by **labelling** — nothing gets hidden, the model
   keeps its voice between tool batches, and the rows become worth reading.

> ### ✅ Verified live: **Chapters already solve this**, and better than either rival
>
> Ran a 5-phase deep analysis with `transcriptChapters` on and the model told to use the chapter tool.
> A **40-second, 5-chapter, multi-file** turn collapses to **eight lines** (`06-chapters-all-collapsed.png`):
>
> ```
> AURORA
> ›  Thought                    0.5s
>    ● Planned  5 tasks                                   0/5
> ›  ANALYZING ELECTRON GUI SHELL ──────────────────
> ›  ANALYZING CORE ENGINE AND PERSISTENCE ─────────
> ›  ANALYZING PYTHON SIDECAR AND CAMOUFOX LAUNCH PATH ──
> ›  ANALYZING PACKAGING AND PORTABLE RELEASE ──────
> ›  IDENTIFYING RISKIEST PARTS OF THE CODEBASE ────
> Worked 40s · Copy · Retry
> ```
>
> A chapter owns every row until the next one — thoughts, tool groups, file reads, prose — and folds
> them all behind its title. The previous chapter auto-collapses the moment a new one starts.
>
> **This beats Antigravity's `Worked for 13s`**: same compression, but you can see *what the five phases
> were* without expanding anything, and every line is **the model's own words**. Nothing is silenced —
> the narration became the navigation. This is the design the other two apps don't have.

> ### ⚠️ Retracted: "collapse the scaffold into one aggregate row"
>
> An earlier draft of this section recommended replacing the seven rows with a single
> `Worked 14s · 11 calls ⌄` at the top, and dropping `Thought` rows below a duration threshold.
> **The owner rejected it, correctly.** That change would silence the model's narration between file
> analyses — exactly the interleaving Aurora deliberately built and persists (`.knowledge` 2026-08-04:
> the assistant `timeline` is rebuilt from `msg.blocks`, "which already carry the true interleaving").
> Copying Antigravity's single collapsed row would have thrown away the more capable design in order to
> imitate the less capable one. The count of rows was a symptom; the labelling is the disease.
2. **Make Chapters the default, not an opt-in.** This is now the top recommendation in the whole series.
   The feature is finished, it is better than what MiniMax and Antigravity ship, and it is **off by
   default and effectively unfindable**:
   - The Preferences copy says *"Both are off to start"* — the single best thing in Aurora's transcript
     ships disabled.
   - **The settings search is broken for it.** Typing `chapter` renders *"No settings match 'chapter'."*
     **while the Transcript section with a row labelled `Chapters` is rendered directly below it.** The
     empty-state and the unfiltered content are on screen simultaneously — the filter computes a miss
     and then never filters. Verified live; the row exists in `PreferencesSettings.tsx` with that exact
     label.
   - ✅ **DONE 2026-08-09.** The model only chaptered when **explicitly told to** in the prompt; with
     the pref on but no instruction, the turn produced none. `CHAPTER_INSTRUCTIONS` went 2 lines → 7:
     a countable trigger (>1 area or >~3 tool calls), "default not optional", call-BEFORE-the-first-
     tool-call, no duplicate markdown heading, and an explicit opt-out. tsc 0 · 455 tests · eslint
     clean. **Not yet re-verified in a live turn** — the next unprompted multi-step run is the test.
3. **Fix the stale task counter.** The inline row reads `Planned 5 tasks — 0/5` on a finished turn while
   the header chip reads `Tasks complete — 5 of 5`. Two counters for one fact, disagreeing, on screen at
   the same time. Verified live in `06-chapters-all-collapsed.png`.
4. **Kill the horizontal rules on `Thought` rows.** They read as section breaks and chop the response
   into meaningless bands. (Chapter rules are fine — those *are* section breaks.)
3. **Sticky-pin the user message** (`position: sticky` on the user row in the transcript scroller +
   a mask fade beneath). Straight from Antigravity, pure CSS, fixes losing the question on long answers.
4. **De-duplicate the header title** — one copy, not a full one on the left and a truncated chip on the
   right. Fix the mid-word truncation while there.
5. **Debox the micro-atoms** (carried from Studies 01–02): `.agw-shell-badge` / `.agw-tool-chip` lose
   border + fill, keep icon/colour/text, come off 10px.
6. **Empty state:** shrink or delete the watermark, raise the composer, and separate the ✦ / 🎤 glyphs.
7. Longer-term, from Study 02: an **Overview pane** and **turn-scoped Review**.

### Agreed next steps (owner, 2026-08-09)

- **The one thing to take from Antigravity is the sticky user bubble** — and only that. The user
  message pins to the top of the transcript scroller, the response scrolls beneath it behind a mask
  fade, and it swaps per turn, so the question is never lost on a long answer. Pure CSS;
  `.agw-row[data-row]` is the hook that already exists. Do **not** also take their clamp — it cuts
  mid-glyph with no expand control (§4.1).
- **The task / plan system gets a ground-up redesign** — stripped back and rebuilt for correctness,
  not patched. Deliberately deferred; not started. The `Planned 5 tasks — 0/5` vs header `5/5`
  disagreement in §6.3 is a symptom of that system, so fix it *there*, not with a spot patch.

**Do not** copy MiniMax's or Antigravity's step format. Aurora's carries strictly more information than
both, and `No matches` / `36 files` / `Read 199 lines` is the single most useful thing in any of the
three transcripts. The problem was never what Aurora says — it is how many times it clears its throat
before saying it.
