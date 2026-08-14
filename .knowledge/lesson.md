# Lessons Learned

Append 2-4 lines per mistake / broken assumption / project-specific warning.

## 2026-08-13 (3rd) — How long a request took to FAIL tells you what failed
- I diagnosed a provider HTTP 500 as our request shape (5 screenshots ≈ 4.7 MB per turn, three
  consecutive `user` messages) and was wrong on both counts: replayed against the live endpoint,
  4.73 MB returned 200 in 2.0s and every message shape returned 200. The log said each attempt
  burned **~11 seconds** before the 500 — a shape rejection is instant, so the gateway had accepted
  the request and its own upstream failed. Six failures across 3.5 minutes, then it recovered.
- Read the failure LATENCY before theorising about the payload. And "a new session works" can mean
  "the outage passed", not "the old session is malformed".

## 2026-08-13 (2nd) — Raising an element to put something behind it buries that element's siblings
- To make the composer picker read as being behind the input I gave `.agw-composer-surface`
  `z-index: 1`. That put the input box above every sibling with `z-index: auto` — including the
  rail's popovers, so "Background processes" opened behind the composer. `.agw-crail-chips` is
  TRANSFORMED, which makes the whole chip cluster a stacking context at the default level, so its
  `z-index: 50` popover never competed with the box at all.
- Rule: to change relative depth, move the ONE element that should be lower (`z-index: -1` on the
  picker), never raise the shared one. Raising is a change against every sibling at once.
- Corollary worth remembering: `transform`, `filter`, `backdrop-filter` and `will-change` all create
  stacking contexts, so a child's z-index can be trapped by a parent that looks purely cosmetic.

## 2026-08-13 — Images are charged per TILE, so resolution below the step buys nothing
- Measured on the live provider: 1400×1521 and 1024×1113 of the same capture both cost 1280 prompt
  tokens; 768 cost 914; 512 cost 562. And JPEG q85 costs exactly what PNG costs at the same size,
  at a fifth of the bytes. So the lever for payload is ENCODING, not resolution — dropping
  resolution inside a tile step loses detail for free.
- The floor is legibility, not tokens: at 512 the model did not say "I can't read that", it answered
  with invented labels ("Chorus", "Delay", tempo "128"). A screenshot too small doesn't lose
  information, it manufactures it.
- For scale: 1,000 chars of prose ≈ 230 tokens; one 1400px screenshot ≈ 1,000. An image is cheap for
  what it carries, but it is not 50 tokens.

## 2026-08-13 — A unit test must never write to the user's real data file
- The first `report_aurora_issue` tests called `execute()`, which appends to
  `%LOCALAPPDATA%\AuroraIDE\reports\aurora-issues.md` — so `cargo test` planted fake bug reports in
  the surface the feature exists to show, where they read as real ones.
- Fix: the append takes a path (`append_entry(path, thread, report)`); tests pass a temp file, and
  `execute()` is tested only for the validation paths that never touch disk.

## 2026-08-13 — `min-width` + `max-width` on a popover is a range, not a measure
- Any floating panel sized that way is sized by its longest string, so it changes width whenever the
  content changes — and this window's panels hold agent-written text, which changes constantly. If a
  panel is something you keep open while working, give it ONE width and make the text wrap or clamp.
- Same class of bug as the sticky-user one below: a container that never actually committed to a size.

## 2026-08-13 — A state variant only reaches its own DOM children
- When a preference re-shapes a container (sticky-user pins the card, widens it to full column, caps
  it at 34vh), anything that LOOKS like part of that container must actually be INSIDE it. The
  attached-image row was a sibling that merely copied the card's measure, so every one of those
  three transforms skipped it and it read as a stray panel. Symptom to recognise: an element that
  duplicates its neighbour's `max-width`/alignment is usually a child in the wrong place.
- Second half of the same trap: a conditional that gates the container on the WRONG content.
  `hasBubble` counted text and chips but not images, so an image-only question rendered no card —
  and the copy chip, absolutely positioned against the card, fell onto the image instead.

## 2026-08-12 (5th) — An async function's "already done it" guard must claim the slot BEFORE its first await
- `attachSession` returned early if `runtime.get(session.id)` existed, but wrote that entry at the
  END, after `await getShellSpawnConfig(...)`. Any second call during that await saw an empty slot
  and built a SECOND xterm into the same container. React 18 double-mounts effects in dev, so this
  fired constantly: two `.xterm` trees in one `.agw-term-surface`
  (`xterm-dom-renderer-owner-5` and `-6`), two cursors — one at the top of the pane, one at the
  bottom — and the keyboard bound to whichever instance held the live PTY. Typing landed in the
  invisible one, so the terminal read as frozen. Fix: `runtime.set` immediately after `term.open`,
  before any await; `pty` is filled in later. The entry EXISTING is the lock.
- pwsh appearing to work while bash/zsh/cmd did not was luck about which of the two instances got
  focus. It sent me hunting for differences between shells for three rounds. **When one symptom has
  a per-case pass/fail pattern, check for a race before theorising about the cases.**
- The user reported "it renders twice, the typing indicator shows at the bottom too" FOUR times and
  I treated it as a rendering artifact each time, because I had already decided the cause was fonts,
  then HMR. He finally sent two `document.querySelector` paths that named both instances. A user
  describing the DOM is reporting a fact; a screenshot I interpret is a guess. Take the fact.

## 2026-08-12 (4th) — "Make it work like X" is about the BEHAVIOUR, not about copying X's layout
- Asked to make Aurora's todo match Claude Code's, I drew the full checklist into the transcript
  card. Aurora already HAS the checklist — the header indicator's dropdown, live, one hover away —
  so the inline copy said the same thing twice, and the owner's reply was "then what's the point of
  our top task tracker dropdown?". Reverted within the session.
- The parts that actually needed matching were invisible ones: batched status updates and the
  `<aurora_task_reminder>` context injection. The visible part Claude Code has and Aurora lacked was
  ANNOUNCEMENT — so the fix was to make the existing dropdown flash open for 3.5s on a change, not
  to add a second surface. Before adding a surface, ask what the existing one is already for.
- knowledge.md recorded "Header TaskIndicator is its only home" and TaskIndicator.tsx's module doc
  lists the three previous places the checklist was evicted from. I read neither before building.
  Check whether a decision already exists before re-litigating it with code.

## 2026-08-12 (3rd) — A popover width held in JS is a latent overflow, because every size token scales
- `RailMenu` pinned `width: 228px` inline while `.agw-rail-menu-item` was `white-space: nowrap` with no
  `text-overflow`, so "Open in integrated terminal" painted THROUGH both rounded edges. Unbounded nowrap
  text does not clip — it escapes the panel. The row was also `--agw-fs-body` (16px, the PROSE default)
  where a menu row is a list row (`--agw-fs-ui`), which is what pushed it over the width.
- The general rule: every `--agw-fs-*` multiplies by `--agw-ui-text-scale`, so ANY fixed px width on a
  text container is only correct at scale 1.0 with today's labels. Size popovers with
  `width: max-content` + `min/max-width`, and let the component MEASURE (`offsetWidth`, in a layout
  effect) rather than re-deriving geometry CSS already owns. Use `offsetWidth`, not
  `getBoundingClientRect()` — the `agw-pop-in` entrance applies `scale(0.98)` and skews a live rect.
- The correct in-repo precedent was already there: `.agw-chip-overflow-name`
  (`flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis`). Check the popover family before
  inventing; the other four (`crail-pop`, `addmenu`, `taskpop`, `model-menu`) were all already sound.

## 2026-08-12 (2nd) — CSS-rewriting scripts: comments must be atomic tokens, and prove a no-op roundtrip first
- A dead-rule prune script split selector lists on commas without skipping `/* */` spans; a comma
  INSIDE a comment sheared it, leaving 6 files with unbalanced `/*`. Same script also missed
  `@supports` (only recursed `@media`), silently keeping a dead selector alive inside it.
- Fix pattern that worked: tokenize comments as standalone nodes so rule preludes can never
  contain them, recurse every conditional at-rule, and before the real run assert the script
  reproduces every file byte-identical with an empty kill-list. Also: `sed -i` on a JS file ate
  `\b` in a regex (`\b` → `b`) — edit scripts with the editor, not sed.
- Dead-CSS scans against TSX lie without cleanup: doc comments mention `agw-` and `--agw-*`
  (false-alive via prefix), `var(--agw-fs-md)` embeds `agw-fs-md` (token noise). Strip var refs
  and comment lines first; verify each candidate repo-wide with a `(?![A-Za-z0-9_-])` boundary.

## 2026-08-12 — vitest's default worker pool is broken on this machine; use `--pool=vmThreads`
- Every test file — including a fresh `expect(1).toBe(1)` probe — failed with "No test suite found"
  under the default `forks` pool AND under `threads` (vitest 4.0.16, Node v22.22.3, Windows).
  `--pool=vmThreads` runs everything green (535 tests). Reproduced on a pristine HEAD tree, so it
  is the environment, not any code change; `pnpm install` was already in sync and did not fix it.
- Do not read "No test suite found" as a broken test file before running the trivial-probe check;
  an hour of bisecting your own diff finds nothing because the diff is innocent.

## 2026-08-11 — A precondition that cannot observe every legitimate path will refuse correct work
- `file_edit` required a prior `file_read` of every target. The agent found its exact line with
  `grep`, batched 3 edits, and lost the whole batch to one file it had never opened — while looking
  at that file's matched text in the search result. The tracker only sees `file_read`/`file_write`;
  it cannot see search hits, `code` output, an earlier diff, or the user pasting the text.
- The test to apply: **what does the gate protect that the operation does not already protect?**
  Exact-match + uniqueness + atomic batch means a guessed edit writes nothing. The gate added
  nothing there — it only blocked the cases that would have succeeded. It DOES protect
  `replace_all`, which waives uniqueness; that one stays. Everything else moved to being the
  DIAGNOSIS for a failed match, where "you never read this file" is finally the actionable cause.
- Related: when a refusal is common, ask whether it is protecting the user from an unanswerable
  question or from a limitation you could remove — same shape as the 2026-08-09 `usages` entry.

## 2026-08-11 — A card that renders a refusal as a green check is worse than no card
- `toolStatus` classified failure by a leading `[error]`/`[rejected]` sentinel only, so every Rust
  tool that reports `{"success": false}` — read refusals, failed exact-text matches, non-zero shell
  exits — displayed a ✓, counted as "done" in the group header, AND dumped its raw JSON into the
  body (nothing claimed the shape, so it hit `parseToolResult`'s last-resort pretty-printer).
  The owner read a declined batch as a successful edit. Months of failed shell commands looked fine.
- Two rules. A status inferred from a text sentinel must be re-checked whenever results gain a
  structured shape — the sentinel was true when results were strings. And check the TOP LEVEL only:
  a per-file `success:false` inside a 10-file read is a partial result, and marking the call failed
  would misreport the 9 that worked.
- Corollary: a failed card that shows its error only in a closed dropdown is barely better. State
  the reason on the row.

## 2026-08-10 — An explicit `@filename` is the scope, not a nearby document with a similar topic
- The user pointed to `@CODE-INDEX-OUTLINE-FINDING.md`; I opened `DOCS/code-index-handoff.md` instead
  and fixed an unrelated unfinished item. The change was valid but unauthorized and had to be reverted.
- Resolve and read the exact attached filename before choosing work from broader project notes. A
  topic match is not a substitute for the artifact the user named.

## 2026-08-10 — Never put the user's real project names in Aurora's own source
- I wrote a test fixture in `code_index/store.rs` using the owner's private package name and one of
  its classes as the sample data, plus half a dozen comments naming his private repos and files.
  Aurora is a shipped, source-available product; that leaks his project identity into code he
  distributes, and reads to any future maintainer as though those were real dependencies.
- Rule: fixtures and comments use neutral names (`@acme/core`, `Client`, "a real 594-file Electron
  app"). **Keep the measurement, drop the identity** — "282 files across 4 workspace members were
  invisible" is the durable fact; which repo it was is not. Real names belong in `.knowledge/` and
  `DOCS/`, which are working notes, never in `src/` or `src-tauri/src/`.
- Grep before finishing any session that involved testing against a private repo.

## 2026-08-10 — An exclusion list is a bet, and a name can mean opposite things in two ecosystems
- `packages/` was skipped as a .NET/NuGet output name. In a pnpm/yarn workspace it is where ALL the
  source lives. Result on a real monorepo: 282 files across 4 first-class libraries indexed as zero,
  while the exclusion saved nothing — a NuGet folder contains .dll/.nupkg, none of which is in any
  language the indexer reads. All cost, no benefit. `bin` is the same trap (Node CLI entry points).
- Before adding a directory name to a skip list, ask what it means in EVERY ecosystem, and price
  both sides: what does excluding it save, and what does it destroy if the other meaning applies?
- The thing that made this findable was reporting skipped directories in the build stats instead of
  dropping them silently. A silent exclusion would have looked like a complete index forever.
- Second monorepo bug from the same test: cross-package imports use the PACKAGE NAME, not a relative
  path, so every one looked external and the whole-repo dependency graph came back with zero edges.
  A "bare specifier means npm dependency" rule is only true outside a workspace.

## 2026-08-10 — Read a competitor's source for its DECISIONS; verify its ANSWERS before copying
- Evaluated `symgraph` (a shipped code-intelligence CLI) against Aurora's index on the same repos.
  Three of its ideas were better than anything Aurora had and were ported: coupling broken down by
  KIND, a directory dependency graph, and git churn as a ranking signal. Its ANSWERS were worse.
- The finding that mattered: `impact ScreenReader` claimed 6 inbound edges from `ControlSession.cs`,
  a file containing **zero** mentions of ScreenReader. It had matched the bare method name `Set`
  and attributed calls to an unrelated `HaloOverlay.Set`. A FALSE dependency is the dangerous
  direction to be wrong in — it sends you to "fix" code that was never affected. Aurora's
  import → same-file → same-dir cascade gets that case right (both files sit in `src/`).
- It also merged 8 callers of two different `Set` methods into one list with no warning — the exact
  failure documented in these notes on 2026-08-09, shipped as a feature.
- Method that made all this findable: establish ground truth with `grep` FIRST, independently of
  both tools, then compare. I nearly reported "it does not index `export const` symbols" — checking
  showed the symbol WAS indexed and only the lookup was broken. Different bug, different fix.
- Do not evaluate a crate as a dependency and as a source of ideas in the same breath. symgraph is
  a 22 MB SQLite index with an MCP server attached; Aurora indexes the same repo in 4.9 MB with
  more symbols. Take the design, leave the package.

## 2026-08-10 — A schema option offered at the top level is offered to EVERY op
- Added `in_file` to the `code` tool and wired it into `usages` only, documenting it as "For
  `usages`:". The very first live turn, the model sent it to `definition` three times — reasonably,
  since the schema lists it as a sibling of `op` and `name`. `definition` ignored it, returned all
  3 homonyms of `hasCapability`, and the model then told the user it had "resolved the ambiguity by
  restricting the search to ai-orchestrator.ts". **The filter never ran and the model narrated it
  anyway.** Silently ignoring a parameter is worse than rejecting it: it manufactures a false
  claim in the transcript rather than an error anyone can see.
- In a one-tool-many-ops schema, every property is visible to every op. Either implement the option
  everywhere it plausibly applies, or reject it explicitly for the ops that do not take it. Prose in
  the description is a hint, not a gate — the same lesson as the `file_read` `oneOf` case.
- Corollary that made this findable at all: read the SESSION JSONL, not the rendered transcript.
  The UI showed the model's confident prose; only the persisted `tool_use` inputs and `tool_result`
  payloads showed `in_file` going in and `found: 3` coming back. `%LOCALAPPDATA%\AuroraIDE\
  sessions\<id>.jsonl`, found by `grep -l "<symbol>" *.jsonl`.
- Note the repo map is correctly ABSENT from the JSONL — it rides the request body only. Do not
  "fix" that; see the caching rationale in knowledge.md.

## 2026-08-09 (later) — A refusal can be a missing feature wearing a safety jacket
- `usages` refused on ambiguity, and the refusal was CORRECT given name-only matching — it is in
  these notes as a win. It was also hiding the real gap: the index was throwing away the one fact
  that resolves names. The queries captured `@ref.import` (the imported NAME) and discarded the
  module it came from, so `Session` imported from `./session` was stored identically to any other
  `Session`. Adding the pair turned 65% of ambiguous references into resolved ones.
- Rule: when a tool refuses honestly and often, check whether the refusal is protecting the user
  from a limitation you could remove, rather than from an unanswerable question. "We cannot know"
  deserves the same audit as "we got it wrong".
- The mechanism worth remembering: tree-sitter captures are grouped **by match and by nothing
  else**. Two facts that only mean something together (a name and its module) must be captured by
  ONE pattern; as two separate patterns the association is unrecoverable. Aurora's extractor looped
  per-capture and so could never have expressed this, whatever the queries said.
- Also: an `import` is not a usage. Counting it made every TypeScript caller count one too high per
  importing file and put a useless `<top level of …>` row against each. Report it as its own number.
- And a budget must cover the whole artifact: the repo map reserved nothing for its closing tag and
  omission notice, so it shipped 20,068 chars against a 20,000 budget. Caught only by printing the
  real length — every unit test used a budget loose enough to hide it.

## 2026-08-09 — Evaluate a crate as a DEPENDENCY separately from its ideas
- `coraline` (suggested for the code index) was the right thing to read and the wrong thing to
  depend on: 597 downloads, one maintainer, and it brings SQLite + ONNX vector embeddings — the
  exact stack this project deliberately deleted at migration v12. Its resolution cascade
  (import hint → same file → same dir → refuse) was excellent and took ~200 lines to port.
- `github/stack-graphs`, the "proper" precise-resolution answer, was **archived by GitHub in
  September 2025**. Check whether a foundational crate is still alive before designing on it.
- Rule: read competitors' source for their DECISIONS, not their packages. A 16k-line application
  crate that owns a database and a model runtime is not a library primitive, however good its ideas.

## 2026-08-09 — An advisory caveat in a tool result is not a safeguard; the model drops it
- `code`'s `usages` returned a merged caller list PLUS an `ambiguous` field naming 23 rival
  definitions. Live against quantumhub-client the model dropped the field and presented 27 callers
  of 23 unrelated things as one confident answer — strictly worse than grep, which at least LOOKS
  messy. Fix was structural: when a name resolves to >1 callable, return NO caller list at all, only
  the candidates. The model then relayed it perfectly, because there was nothing left to drop.
- If a result can be misread by dropping one field, remove the field's subject from the payload
  instead of adding a warning next to it.
- Second bug from the same test: the refusal said "re-ask with a qualified name", but those 7 were
  module-level functions in 7 files with NO container, so no such name exists. A refusal that names
  an impossible next step is worse than the ambiguity — it looks actionable. Now branches on whether
  any candidate has a container (`qualifiable`).
- Also: `usages` now filters to callable kinds. `handle` had 23 definitions of which 16 were struct
  FIELDS — "who calls a field" is a category error the old version happily answered.

## 2026-08-09 — A service that writes to app data will have its TESTS write to app data
- `CodeIndexService`'s cache path came from `paths::code_index_dir()` with no override, so every
  `cargo test` run wrote a dozen tempdir-fixture caches into the user's REAL
  `%LOCALAPPDATA%\AuroraIDE\code-index\`. All 32 tests passed the whole time — the damage was
  outside everything they asserted on, and it was only found by listing the directory by hand while
  looking for something else.
- Rule: any service that touches a user directory needs a constructor that says WHERE, and its tests
  must use it. Green tests are not evidence of hermetic tests. When adding one, verify by clearing
  the real directory, running the suite, and confirming it is still empty.

## 2026-08-09 — Blind-test an analyzer on an unfamiliar repo, or you only ever confirm yourself
- Indexing `qg-native` BEFORE reading a line of it, writing down falsifiable predictions, and only
  then opening the source found a bug that three passes over Aurora had not: every reference was
  counted TWICE. `_ctl(args)` matches both the `@ref.call` pattern and the `@ref.ident` catch-all,
  and refs were de-duplicated only against DEFS, never against each other — so `callers` reported
  "2x" for a single call site. On a familiar repo the doubled numbers looked plausible; against
  grep's hard count of 24 `_cmd_*` functions it was instantly wrong.
- Rule for overlapping capture sets: if patterns can match the same node, they need a specificity
  rank AND range-keyed de-dup on BOTH sides (defs and refs), not just one.
- Also: a 1.9 MB minified `index.js` was 88% of an entire index build and 34% of its symbols, while
  sitting UNDER the 2 MB size cap. Bytes are the wrong axis for "is this generated" — LINE SHAPE is
  the right one (avg > 200 B/line). A size threshold tuned for "too big to parse" says nothing about
  "not worth parsing".

## 2026-08-09 — `ignore` silently drops .gitignore outside a git repo, and `cargo test` won't rebuild a bin
- `ignore::WalkBuilder::git_ignore(true)` applies NOTHING unless the directory is a real git repo —
  `require_git` defaults to true. A workspace with a `.gitignore` but no `.git` (an IDE opens plenty)
  indexes everything it was told to skip. Set `.require_git(false)`. Aurora's `grep` uses the same
  crate, so check it there too before assuming the tool respects ignores.
- `cargo test --release` does NOT refresh the `bin` target's exe. I edited queries, saw 18 tests pass,
  ran the binary, and read numbers from the PREVIOUS build — then started theorising about why the
  edit "had no effect". When a code change appears to do nothing, verify the artifact you executed
  was rebuilt (`cargo build`, check mtime) before forming any hypothesis about the code.
- An ancestor walk with a HOP LIMIT cannot express a scope rule. `is_exported` walked up 4 levels for
  an `export_statement` and so marked every local inside an exported function as public API. The fix
  is a barrier node (`statement_block`), not a bigger number — but the barrier must not include the
  declaration's own parent, or every function reports as private. Both directions need a test.

## 2026-08-09 — A contenteditable=false span at the caret is not inert
- The composer's ghost text inserted a `contentEditable=false` span AT the caret via
  `Range.insertNode` — which splits the text node (empty-node residue) and leaves Chromium free
  to normalize the caret to the FAR side of the span: typed chars appended after the grey ghost,
  and Backspace deleted the whole span as a unit (native rule) leaving the hook's refs pointing
  at a detached node. The assist looked haunted; every individual piece was "correct".
- Rule: native editing must NEVER execute against a DOM containing the ghost — drop it in
  keydown before any mutating/moving key, insert split-free (`Text.after()`), re-pin the caret
  explicitly, and clean residue on removal. Also: `execCommand` loops fire one input event EACH
  (re-entering your own pipeline: double-learn, killed refine-undo) — replace ranges atomically
  and flag programmatic edits so input handlers can tell them from the user.

## 2026-08-08 — A size-based transform ahead of a type-aware one eats the type
- `tool_spill` (12 KB threshold, head+tail elision) ran BEFORE `truncate_tool_content`'s
  aurora_image leanify branch. Every screenshot is >12 KB by design, so the spill cut the marker
  mid-base64 and the vision pipeline downstream never fired — the model got "253577 of 261769 bytes
  hidden" instead of seeing the page. The downscale/leanify/adapter chain was all correct and all
  unreachable. When stages transform the same payload, every EARLIER stage needs the same type
  exemptions as the later ones, or the special case only exists below the point where it was destroyed.
- Same session: `grep` passed the pattern as a bare positional, so any pattern starting with `-`
  (CSS custom properties) was parsed by ripgrep as flags. Third harness-mutates-input bug in this
  tool (comma-split globs, path-operand globs, now flag-eating patterns) — when wrapping a CLI,
  every value that can start with `-` must go behind `-e`/`--`.

## The Rust test suite never ran on Windows — FIXED (2026-07-25)
- `cargo test` died with exit `0xc0000139` STATUS_ENTRYPOINT_NOT_FOUND before `main`. This was written off in
  these notes as an environment limitation for months. It was not. **Root cause:** `tauri_build::build()`
  embeds an app manifest into BINARY targets only; a test executable is a separate target and got none, so the
  loader bound System32's `comctl32.dll` **v5.82** instead of the side-by-side **v6** assembly — and v5.82 does
  not export `TaskDialogIndirect`, which the dialog stack (rfd / tauri-plugin-dialog) statically imports.
- Fix is a `#[cfg(all(windows, test))]` `.drectve` linker directive in `lib.rs` emitting
  `/MANIFESTDEPENDENCY:"…Microsoft.Windows.Common-Controls version='6.0.0.0'…"`. `build.rs` CANNOT do this:
  `cargo:rustc-link-arg-tests` applies only to `tests/` integration targets and errors with "does not have a
  test target" — unit tests compile into the lib target. Do NOT add `/MANIFEST:EMBED` to the directive:
  `rust-lld` rejects `/MANIFEST:` inside `.drectve`. The linker writes a side-by-side `.manifest` instead,
  which the loader honours identically.
- Diagnosis method worth reusing: `dumpbin /imports` the failing exe, then check every imported symbol against
  the resolving DLL's `dumpbin /exports`. Beware false positives on forwarded exports. PATH shadowing was the
  obvious suspect (an old `VCRUNTIME140.dll` from `C:\SDKs\emulator` does sit ahead of System32) and was NOT
  the cause — verify before acting on it.
- **Consequence:** 703 unit tests had never executed once. 15 were already failing. A green `cargo check` says
  nothing about a suite that cannot launch — and `BUILTIN_TOOL_COUNT` had silently drifted 21→22 behind exactly
  this blind spot. Run the suite, don't just build it.

## A test that cannot RUN is worse than a test that does not exist (2026-07-25)
- 703 Rust unit tests had never executed once on this machine. 15 were failing and **5 of those were real
  product bugs** that had been shipping for months: context trimming that never fired at 3 user turns, a JSON
  compactor that produced invalid JSON for `workspace_tree`, a clamp that exceeded its own cap, a `TeamPhase`
  variant assigned nowhere, and a role classifier that relabelled real builders. `cargo check` was green the
  whole time. **Green compile ≠ green suite.** If the suite cannot launch, treat that as a P0 — not an
  environment quirk to note and route around.
- When a test and the implementation disagree, decide which is stale by finding the *sibling* test. The 4
  scope_guard failures encoded a superseded rule; the one test written FOR the new rule
  (`unassigned_path_is_allowed_as_open_ground`) passed and settled it. Likewise
  `register_builtin_tools_is_idempotent` asserted 16 where its own sibling asserted 15.
- Do not assert on a `display()`/`Debug` rendering when you mean to assert on a value. `{:?}` on a Windows
  path escapes the separators, so `contains("src\\app.js")` can never match. Compare `Path`s — that is
  separator-agnostic — or assert on the structured field directly.

## Portaling escapes the clipping container AND the ancestor's containment check (2026-07-25)
- The budget popover was portaled to `.agw-root` to escape `.agw-model-menu`'s `overflow: hidden`. That fixed
  clipping and immediately broke dismissal: the menu's outside-click test is `rootRef.contains(target)`, and
  the portaled panel is not a DOM descendant, so pressing the slider closed the whole picker. **Fixing the
  visual containment created a logical containment bug.**
- Convention now in place: a portaled popover owned by a menu sets `data-agw-portal-child`, and every
  outside-click handler skips `target.closest("[data-agw-portal-child]")`. Apply this to any future portaled
  popover rather than adding a one-off class check.
- `useSettingsStore.updateModel` writes to SQLite on EVERY call. Never wire it directly to a continuous
  control (range/drag): keep a local draft and commit on `pointerup`/`keyup`/`blur`. Same rule for any store
  action with a persistence side effect.

## Never substitute a default for a value that failed to arrive (2026-07-25)
- `parse_tool_input` turned unparseable tool arguments into `{}`, so an executor reported "`path` is required"
  to a model that had sent `path`. The model then looks incompetent — retrying, rephrasing, switching tools —
  while the harness is the thing at fault. This single line was the main cause of "even Opus calls the wrong
  tools in Aurora". A fallback that is indistinguishable from real data destroys the error message that would
  have explained the failure.
- Keep the failure representable end to end: encoding it as `Value::String(raw)` needed no new type, no serde
  migration, and no magic key, because every tool schema is `type:object` so a non-object is unambiguously
  broken. But sanitize at the WIRE boundary (`tool_input_for_wire`) — providers reject a non-object
  `tool_use.input` and would fail every subsequent turn, not just the malformed one.
- Distinguish "arguments never arrived" from "arguments failed validation" in the message. They demand
  different corrections from the model, and an EOF parse error additionally means "you were truncated — send
  less", which the model cannot infer any other way.
- A `DashMap`-backed tool registry ships schemas in random order every request. Tool order is part of the
  cacheable prefix (and nudges tool selection), so registration order must be stable and re-registration must
  preserve position. Aurora sends ZERO `cache_control` today — that is still open.

## A settings field nothing consumes is worse than a missing one (2026-07-25)
- Providers → "Min budget / Max budget" had shipped for budget-type reasoning models, but no surface let the
  user pick a VALUE inside that range and no adapter could receive one. The page looked complete and configured
  nothing. Before adding a control, trace the field to the outgoing request body — `ModelReasoning.type`
  ("effort" | "toggle" | "budget") is a union whose branches must ALL be handled at every layer, and the send
  path's `// toggle / budget` else-branch silently collapsed budget into a boolean for months.
- `reasoning.default` is polymorphic: a TIER STRING for effort models, a TOKEN NUMBER for budget models. The
  Reasoning type switcher carried it across unchanged, so effort→budget produced `default:"medium"` and
  budget→effort sent `reasoning_effort:"8000"`. Coerce by type at every write site.
- Anthropic's `1024 ≤ budget < max_tokens` is a CLAMP, not a validation error to surface: a user who set 32k
  against a 64k cap and later lowers Max output must keep working, not start getting 400s.
- Popovers spawned from inside `.agw-model-menu` MUST be portaled to `.agw-root` — that menu is
  `overflow: hidden`, so an absolutely-positioned child panel is clipped. Same rule as `RailMenu`.
- Log-scale any token slider. Linear travel over 1k–64k spends the first 10% of the track on the range where
  every meaningful choice lives and the other 90% on values nobody can tell apart.

## Tool `parameters` schemas must stay in the strict-provider-safe subset (2026-07-24)
- xAI/grok (and OpenAI strict mode) REJECT `oneOf`/`anyOf`/`allOf` in a function's `parameters` with HTTP 400.
  Aurora's `file_read` used a top-level `oneOf` and it's sent every turn, so every grok request 400'd
  ("Upstream error: 400") while a plain curl worked. `additionalProperties:false` and union `"type":[...]` are FINE.
- When encoding "exactly one of A/B" in a tool schema, carry it in descriptions + runtime `execute()` validation,
  NOT `oneOf`. Bisect provider 400s by replaying the exact outgoing body field-by-field against the endpoint;
  enable the outgoing-body trace with env `AURORA_DEBUG_API=1` (api/openai_compat.rs).

## MCP "405 Method Not Allowed" means the wrong TRANSPORT, not a bad URL (2026-07-23)
- MCP has two HTTP transports and they are not interchangeable. Legacy HTTP+SSE (2024-11-05) opens with a
  GET and waits for an `endpoint` event; Streamable HTTP (2025-03-26+) POSTs JSON-RPC at the single URL.
  A Streamable HTTP server is REQUIRED by spec to answer a bare GET with 405, so "405 on connect" is a
  transport mismatch — do not go hunting through URLs, headers, or auth.
- Config keys encode the transport: `url` ⇒ legacy SSE, `httpUrl` (or `"type": "http"`) ⇒ Streamable HTTP.
  Inferring transport from "is a URL present" silently mislabels every hosted server.
- Silently ignoring an unknown config key is worse than rejecting it: a `httpUrl`-only paste used to become
  a stdio server with no command — enabled, listed, and permanently dead with no error anywhere.
- When adding a transport, remember each MCP settings surface has TWO forms (add + edit) with duplicated
  gating, and `mcp.json` round-trips through `from_config`/`to_server_configs` — write transport explicitly
  or a save silently downgrades it back to the inferred value.

## Agent Window feature ideation must create desire, not process (2026-07-20)
- The Why Graph recommendation over-indexed on provenance, verification, and engineering trust; the user did not
  love it. For “next big thing” ideation, prioritize a visibly transformative interaction or capability first.
- Do not disguise workflow infrastructure as a flagship product idea. Lead with something users would immediately
  want to open, touch, and show someone else; reliability machinery can support it underneath.
- A second recommendation still centered hidden worktree/checkpoint machinery. The user explicitly redirected the
  brief to new visual features; describe the visible surface and interaction first, not backend value.

## Pointer capture retargets `click` — and jsdom doesn't model it (2026-07-19)
- `setPointerCapture` on pointerdown makes Chromium dispatch the eventual `click` at the CAPTURE element, not the
  child under the cursor — child onClick handlers silently die. jsdom does no such retargeting, so component tests
  stay green while the real UI is broken. Capture lazily (only once a drag threshold is crossed), never on press.
- Symptom shape to remember: "clicking X does nothing, but only when the container overflows" → the overflow
  condition gated the capture path. Test the invariant (capture NOT taken on a plain press), not just the click.

## "App broke with zero app changes" → check the WebView2 runtime date FIRST (2026-07-13)
- The Evergreen WebView2 runtime auto-updates silently (`C:\Program Files (x86)\Microsoft\EdgeWebView\Application\<ver>` —
  check the folder's CreationTime). A renderer crash (STATUS_BREAKPOINT sad page) that "started yesterday" matched the
  runtime install time to the hour; app code was innocent. Don't rip out recently-shipped CSS/JS on timing correlation
  alone — the runtime updates on its own clock too.
- Renderer crashes leave minidumps in `%LOCALAPPDATA%\com.aurora.agent\EBWebView\Crashpad\reports` (NOT in Windows
  Event Log — WER never sees Crashpad crashes). `cdb -z <dmp> -c ".ecxr; k 40; q"` with
  `_NT_SYMBOL_PATH=srv*<cache>*https://msdl.microsoft.com/download/symbols` symbolicates msedge.dll (~600MB PDB
  download, takes ~15 min). The dump's UTF-16 strings also carry the page URL → tells you WHICH window/route crashed.
- STATUS_BREAKPOINT = a deliberate Chromium CHECK/int3, not a JS error; page content should never be able to cause it.
  The app-side answer is `ICoreWebView2::add_ProcessFailed` + rate-limited `Reload()` (services/webview_recovery.rs),
  not chasing phantom bugs in app code. WebView2 event handlers live on the browser-side COM object and SURVIVE page
  reloads — installers called per-boot must be idempotent or they stack.

## PowerShell source scans (2026-07-10)
- Bash brace expansion (`path/{a,b}.rs`) is not valid PowerShell command syntax. Pass each path
  explicitly (or build a PowerShell array) when using `rg` from this Windows workspace.
- PowerShell does not use backslash to escape quotes in a double-quoted regex argument. Prefer a
  single-quoted `rg` pattern when it contains TypeScript string literals.

## Agent-window markdown tables (2026-07-04)
- Streamdown (agent-window `AgentMarkdown`) wraps every table in a FULL-WIDTH bordered container
  (`data-streamdown="table-wrapper"` → `w-full … rounded-xl border`). Our `.agw-md table` had
  `display:block`, which shrinks the `<table>` to its content width → the wrapper's right side stays
  empty+bordered = a "phantom extra column/row". Fix: `.agw-md table { display:table; width:100% }`
  (+ `overflow-wrap:anywhere` on cells) so columns fill the box. Don't use `display:block` on a table
  that sits inside a full-width wrapper.
- `controls={{ table:false }}` DOES remove Streamdown's copy/download bar (verified in dist), so that
  was never the empty-strip cause — the block display was.

## Agent Team "max size" counts the Lead (2026-07-04)
- `team-agent-tools.runDispatch` computed `icCap = maxTeamSize - 1` and Rust `convene`/`run_*` also do
  `ic_cap = cap - 1` (the Lead occupies one slot of `max_size`). So a user setting of "3" only ever
  staffed 2 ICs — confusing ("2 capped"). The Lead also never saw the cap (only last-dispatch runtime
  echo), so it couldn't answer "how many ICs now?". Lesson: the team-size number historically INCLUDES
  the Lead; if the UI implies "workers", translate at the dispatch boundary (pass workers+1 to Rust)
  and inject the live cap into the Lead's context — never assume the model can read settings.

## Project warnings (verified 2026-07-01)
- Rust changes need a `pnpm tauri:dev` restart — NO hot reload for the Tauri backend.
- Rust unit tests can't launch the default test binary in some envs
  (`STATUS_ENTRYPOINT_NOT_FOUND` — missing ONNX/native DLL on PATH). Standalone verify crates under
  `target/__verify_*` mount modules via `#[path]` + the `verify_only` feature to test in isolation.
- Native tool count is pinned in 3+ places (`tools/mod.rs::BUILTIN_TOOL_COUNT`, bucket `TOOL_NAMES`,
  count tests). Adding/removing a native tool means updating all of them or tests fail.
- `read_lints` today is a STUB (docs correctly say so, but its own tool description LIES that it returns
  real errors). Treat tool self-descriptions with suspicion; verify against the executor body.
- Big repo: `cargo check` / `tsc -b` on the whole project are SLOW. A shell-checker `read_lints` must scope
  to the file's crate/package + cache + cap output, or it will stall the agent turn.
- WebView2 media permission: `window.with_webview(...)` registers `add_PermissionRequested` on the MAIN-THREAD
  event loop ASYNCHRONOUSLY, so a "lazy" install from JS/React can land AFTER the first `getUserMedia` → the
  request auto-denies with NO prompt AND WebView2 caches the deny. Fix = install at window BUILD time (create
  the window in Rust via `WebviewWindowBuilder` + `install_permission_handler` right after `.build()`), never
  rely on installing it later. A JS-created window (`new WebviewWindow`) can't get this guarantee.
- Passing a Windows path through a Tauri `WebviewUrl::App("route?ws=<val>")` query needs percent-encoding
  (`\`→%5C, `:`→%3A, space→%20); the window decodes it with `URLSearchParams.get()`. No leading slash on the
  `WebviewUrl::App` route (use `agent-window`, not `/agent-window`) — matches the working CLI path.
- CRITICAL (cost me a full app freeze): a SYNC `#[tauri::command] pub fn` runs on the MAIN thread (Tauri v2
  docs). NEVER call `WebviewWindowBuilder::build()` (or any blocking-until-the-event-loop op) from a sync
  command — it deadlocks the UI (white window, X won't close, whole app frozen). If you must build a window in
  Rust from a command, use `#[tauri::command(async)]` so it runs off-main-thread. `with_webview()` is DIFFERENT:
  it only dispatches a closure to the WebView UI thread and returns immediately, so calling it from a sync
  command is safe (that's why `install_agent_media_permission_handler` never froze). The `setup()` hook CAN
  build windows synchronously because the event loop isn't blocked in a command there. Prefer JS
  `new WebviewWindow` for on-demand window creation — it's non-blocking via the event-loop proxy.

## "Broken interface" after many rapid hot edits = HMR desync, NOT a source bug (2026-07-04)
- Symptom: after ~8 quick edits across agent-window CSS + a HOOK (`useAgentAutoScroll` gained
  `useLayoutEffect` + refs), the running window showed unstyled rail (icons stacked, broken squares) and
  unclamped/giant tool `<img>` icons — while the composer stayed styled. Looked like a total CSS break.
- Reality: source was 100% clean — `postcss.parse()` on the CSS = zero errors, `tsc -b`/eslint green,
  `public/material-icons/*.svg` present. It was Vite HMR / React Fast-Refresh DESYNC: changing a hook's
  shape mid-session can't hot-swap cleanly, leaving components against stale styles/state.
- Lesson: before assuming "my last edit broke the UI", VERIFY the source (`node -e "require('postcss').parse(fs.readFileSync(css))"` + `tsc -b`). If source is clean, it's HMR — HARD RELOAD the window (Ctrl+R /
  reopen). Don't thrash the files chasing a phantom. Editing hooks/large CSS live is the usual trigger.

## Agent window has TWO workspace-path sources of truth (2026-07-04)
- The agent window shares the IDE bundle (`App.tsx`, route `/agent-window`). Its scoped path lives in
  `useAgentChatStore.projectRoot` (from `?ws=`, drives UI + per-turn pin), MIRRORED into
  `useWorkspaceStore.rootPath` via `bindRuntimeWorkspace`. Any IDE-only boot hook that writes `rootPath`
  (`useWorkspaceBootstrap`, `useCliOpen`) MUST be gated out of the agent window (`pathname === "/agent-window"`)
  or it repoints rootPath to the IDE's last folder AFTER the scoped bind — UI shows A, tools run against B.
- Lesson: when a hook is IDE-only, gate it at the EFFECT (early return), not just at one call site — there were
  two call-site twins (`restoreWorkspace` gated, `useWorkspaceBootstrap` not) and they drifted. Also: consumers
  reading a global store bypass per-turn pins; prefer the pinned `workspacePath` (ctx) over `rootPath` in tools.

## Tauri 2 capabilities are LOCAL-only unless `remote.urls` is set (2026-07-09)
- The agent/preview browser webviews load EXTERNAL/localhost URLs. In Tauri 2 a capability applies only to the
  app's own origin unless it declares `"remote": { "urls": [...] }`. Without it, an external page's
  `__TAURI_INTERNALS__.invoke(...)` is REJECTED — so every page→Rust callback (`aurora_record_browser_result`
  for screenshot/DOM/click/fill/scroll/console, `aurora_record_picked_element` for the inspector) silently
  dies / times out at 30s. `withGlobalTauri:true` does NOT grant this; it only exposes the API object. Symptom:
  one-way evals (navigate/refresh/history.back) work, anything needing a RESULT hangs. Fix lives in
  `capabilities/browser.json`.
- Corollary lesson: `browser_screenshot` returning the WRONG/previous page had NOTHING to do with capture
  targeting — it was (a) the 8 KiB model-history clamp chopping the base64 so the model saw text not an image,
  and (b) `CapturePreview` returning a stale frame from a hidden (non-compositing) webview. Always check the
  MODEL's actual received content (post-truncation, post-adapter-split), not just the UI card, when an agent
  "describes the wrong thing".

## `cargo test --lib` for the aurora crate fails to LAUNCH (STATUS_ENTRYPOINT_NOT_FOUND)
The lib-test binary links the full native stack (onnxruntime/candle/tauri) and won't start in a bare shell —
exit `0xc0000139`, even after putting `build/debug` + `src-tauri/runtime/onnxruntime` on PATH (a dependent DLL
export is missing/mismatched for the test exe specifically; the real app bundles the DLLs correctly). It is NOT
a test-logic failure — the crate compiles. To unit-test a self-contained module (e.g. `typing_assist`) without
that linkage, compile the real source files into a tiny standalone crate via `#[path = "…/module.rs"]` inside a
wrapper `mod` (so `super::` still resolves) with only the module's light deps (parking_lot/serde). This gave a
clean 199ms runtime verification of the typing-assist engine.

## Rust formatting in a dirty worktree (2026-07-11)
- Direct `rustfmt` defaults to Rust 2015 when invoked on loose files; this crate requires `--edition 2021`.
- Prefer `rustfmt --edition 2021 <touched files>` here. A crate-wide `cargo fmt --check` currently reports many
  unrelated pre-existing formatting differences, so it is not a useful completion gate for a focused change.

## The owner's Windows asks for REDUCED MOTION — never gate a feature on it (2026-08-14)
- Measured: `SystemParametersInfo(SPI_GETCLIENTAREAANIMATION)` returns **false** on this machine, so
  WebView2 matches `@media (prefers-reduced-motion: reduce)` permanently. Any rule behind that query
  is DEAD CODE in the owner's own window — and worse, it silently disables whatever it guards.
- It cost a round trip on the live tool marks: the reduce branch hid the scan copy and zeroed every
  part animation, so the new feature shipped invisible while the label shimmer beside it (which has
  no such guard) kept running. Reported as "the text shimmers but the icon doesn't animate".
- Rule: the agent window animates its transcript UNCONDITIONALLY (08-transcript-flow.css records
  why). Motion belongs behind **Appearance → Reduce motion** (`.agw-root[data-reduce-motion]`) —
  an explicit choice about this window — not behind the OS query. One element obeying the OS while
  its neighbours ignore it does not read as restraint, it reads as broken.
- Diagnostic worth reusing: a still screenshot cannot prove motion is absent. Confirm the running
  build first (dev server on 5173 serving the rule, process start time after the build), THEN check
  the OS accessibility flags before suspecting the CSS.

## Tool-call icons must stay naked (2026-07-11)
- "Give the icons life" did not authorize colored tiles. The semantic-color wrapper made dense tool rows heavier
  and visually noisy. Keep tool glyphs unwrapped and neutral unless the user approves a concrete replacement design.

## CSS patches need selector context (2026-07-11)
- A minimal patch for generic `opacity`/`background` declarations matched earlier unrelated rules. The focused token
  test caught it. For repeated CSS declarations, include the selector in every patch hunk and verify the exact block.
# 2026-07-12 — Reuse the command module's test emitter
- New `agent_v2` registry tests initially referenced a private `RecordingEmitter` from another module and failed test compilation.
- Reuse the local `MockEmitter`, which already implements the command's event and bridge contracts; compile test targets before broader verification.

# 2026-07-12 — Do not run workspace-wide rustfmt here
- `cargo fmt --all` reformatted unrelated Rust files; a first scripted restore then consumed truncated shell output and shortened several files.
- Restore clean files from HEAD in bounded chunks via `apply_patch`; format only touched files and never treat tool-rendered output as an unbounded file transport.

## Tool JSON order and persisted rich results (2026-07-16)
- Source order inside `json!` is not preserved by default `serde_json`; the live schema reached KAT as `content,path`, so
  frontend partial parsing alone could never reveal the filename early. Verify the provider-facing serialized schema,
  not the Rust literal, when UI depends on streamed argument order.
- Never persist a rich JSON tool result with a blind byte slice. It produces invalid JSON on reload and forces a raw-text
  fallback. Compact large payload fields inside the parsed value so the saved envelope stays structurally valid.

## pnpm script probing (2026-07-17)
- `pnpm dev -- --help` forwards a literal `--` to Vite in this project, so it starts instead of printing help and exiting.
- Do not use that form to probe a long-running script; inspect `package.json` directly and validate the independent production command instead.

## Pointer capture tests in jsdom (2026-07-17)
- jsdom does not define `setPointerCapture`, `hasPointerCapture`, or `releasePointerCapture`, so `vi.spyOn` fails before a component test mounts.
- Define those methods as configurable test-environment shims and remove them during cleanup; this models WebView2 without weakening production code.

## Sparkle icons are banned in Aurora (2026-07-19)
- The user considers sparkle/star glyphs "AI slop" — the `sparkle` AgentIcon was removed from the SET entirely and
  replaced by the bespoke `refine` nib glyph. Never reintroduce sparkles for AI-adjacent features; design a
  semantic bespoke mark in the AgentIcon style instead (24-box stroke primitives, like `facet`).

## Prompt-engineering a 0.5B local model (2026-07-19, smoke-tested)
- ALWAYS smoke-test prompts against the real GGUF before shipping (paths in knowledge.md). Patterns proved:
  few-shot examples are mandatory for format adherence BUT the model will parrot a concrete example verbatim when
  asked for multiple outputs — split multi-output tasks into one call per item. Explicit `--temp` matters (0.2-0.4);
  default sampling drifts. Always sanitize outputs (label leaks like "Title:", list markers) and validate/filter —
  design features so 0 usable outputs degrades to current behavior.

## Canvas is a surface, not an AI action (2026-07-17)
- Do not reuse the prompt-refinement sparkle for Canvas; it reads as generic AI decoration and ignores the Agent Window's semantic icon set.
- Canvas opens the right rail, so reuse the bespoke `panel-right` glyph and the app's flat hover treatment. Avoid hover translation on dense transcript controls because it can collide with clipped message bounds.

## Agent mutation tools need workflow-level preflight (2026-07-17)
- Sequentially applying exact-text patches can misdiagnose overlap as a missing later match. Resolve every range against the unchanged base, reject intersecting ranges with both indices, and only materialize after the whole plan passes.
- For immutable artifacts, format validation must happen before persistence. Use the backend's real patch engine to preview, validate the materialized Mermaid source, then commit with the same base tag so a race becomes a stale-version error instead of a broken snapshot.

## Combined tool forms must encode their boundary (2026-07-18)
- Optional `path` plus optional `paths` without non-empty or mutual-exclusion constraints encourages models to emit empty placeholder arrays that accidentally select the wrong executor branch.
- Put the rule in the provider-facing schema and prompt, then validate again at execution: recover only an unambiguous empty placeholder and reject genuinely conflicting forms with corrective errors.

## Terminal signals need one callback owner (2026-07-18)
- A streamed error event, terminal event, and rejected IPC result can all describe one failed turn; guarding only promise settlement does not prevent duplicate UI side effects.
- Put user notification inside the same idempotent settle function and treat the other signals as transport/recovery data, then test the full multi-signal sequence with one request id.

## Check free space before linking Aurora's Rust test target (2026-07-18)
- The CPU-only Rust test target can create hundreds of megabytes of loose codegen objects before archiving; starting it with less than 1 GB free can fill drive E and fail with OS error 112.
- Check available space first and prefer `cargo check` when the user owns runtime verification; if linking is necessary, ensure several gigabytes are free before starting.

## Shared multi-file UI must be result-driven (2026-07-18)
- The earlier horizontal-selector work was applied only to read-tool names, leaving edit results on their separate stacked renderer and hidden Review click path.
- When several tools share one visible interaction contract, derive selection from the parsed multi-file result shape and test every result family; do not stop after one tool-specific branch looks correct.

## Identify the loaded Aurora build before judging HMR (2026-07-18)
- A screenshot can be newer than a source fix while still showing old UI when the active process is the installed LocalAppData binary and no workspace Vite server is running.
- Check the exact Aurora process command line and dev-port listener before treating a post-edit screenshot as evidence that the current source renderer failed.

## MCP server ids can be prefixes of each other (2026-07-19)
- Tool names are `mcp_{sanitizedServerId}_{toolName}`; sanitization maps "-" to "_", so "browser" is a prefix of "browser-testing" and first-match parsing routes calls to the wrong server with a misleading "not connected" error.
- Any name scheme that concatenates ids with the same separator the ids may contain needs longest/advertised-match resolution, never first-match; and note the display-name cache can look right while routing is wrong.

## 2026-07-21 — Inline-vs-block code detection by className is fragile
- AgentMarkdown detected fenced code by `language-*` class; unlabeled fences (very common from models) were silently styled as INLINE code chips. The bug was invisible for months because the chip background happened to equal the code-block background — a later chip retint exposed it as gray bands behind every line.
- Lesson: never distinguish inline vs block markdown code by language class; use structural context (inside <pre> or not). When two tokens share a color by coincidence, a latent styling bug can hide behind it — changing one token can "cause" a bug that was always there.

## 2026-07-21 — One visual concept spread across several tokens needs linked controls
- The two-layer frame is painted by three tokens (canvas/rail/dock). The Appearance "Background" quick control set only canvas, so one click fractured the frame into two tones (user-visible seam band). When a design tier spans multiple tokens, the primary control must move them together; per-token pickers are for deliberate divergence only.

## 2026-07-21 — Ghost/watermark text: shadows bleed through transparent gradient fills
- A `drop-shadow` behind text painted at 5-16% alpha shows THROUGH the glyphs and turns them into dark
  silhouettes (measured lum 24 where 50 was expected). Ground "standing" letters with a floor shadow
  pseudo-element UNDER the baseline instead of a filter behind the fill.
- Size watermarks in `cqi` (container query units), never `vw`: the conversation pane is narrower than
  the window (rails/dock), so vw sizing overflows and clips the last glyph when the pane shrinks.
- Harness trap that cost two iterations: moving gradient styles to a `> span` selector without adding
  the span to the test page — the text fell back to default black and every subsequent "fix" chased a
  phantom. Verify selectors match the DOM before judging renders; sample real pixel luminance, don't
  eyeball.

## 2026-07-22 — Probe-first for UI/design changes (user workflow)
- The user expects a VISUAL DESIGN PROBE before implementing any non-trivial UI/design change: a self-contained HTML file with several live-rendered variants (numbered cards, real tokens, real sizes, live hover, a recommendation), saved to `C:\Users\Alvan\Documents\` for them to open and pick from. Example they pointed to: `aurora-tool-icon-designs-v2.html`. I skipped this on the composer send-button work and iterated live instead, which burned many rounds and frustrated them.
- Format that works: `:root` with approximated `--agw-*` dark tokens; a `.grid` of `.card`s each with `.num` + `h3` (+ `Recommended`/`Current` pill) + `.desc` + a `.stage` rendering the actual control at real size across its states; footer with my pick + one-line rationale per variant. Inline SVG glyphs directly (NOT `<use href>` — external class CSS incl. `filter` glows can't pierce a `<use>` shadow tree).
- Apply relevant lessons BEFORE related work: check `.knowledge` at task start. New send-button probe: `C:\Users\Alvan\Documents\aurora-send-button-designs.html`.
- **"probe" in the user's vocabulary means THIS html file, not the qg-probe MCP.** 2026-08-10: asked to
  "create probe first like before", I drove qg-probe against the live window instead and had to be
  corrected. qg-probe inspects what already ships; the design probe is how a change gets chosen
  BEFORE it ships. When the ask is about how something should look, it is always the html one.
  Model-selector probe: `C:\Users\Alvan\Documents\aurora-model-selector-designs.html`.
- Worth keeping from that same task: bug fixes and design choices are separable. Shipping the three
  selector BUGS (wrong tooltip target, label collapsing to a raw id, `split(":").pop()`) without a
  probe was fine; the provider-on-trigger question is the part that needed one.

## 2026-07-22 — Resolve skill roots from the advertised catalog
- I incorrectly looked for the required `surface` skills under the repository `.codex` folder even though the active catalog mapped them to `C:\Users\Alvan\.agents\skills`; both reads failed.
- Expand the listed skill root exactly before reading, and do not infer that a global skill is repository-local. Also reject project-overview metadata when its named product does not match the active repository.

## 2026-07-22 — Split multi-file patches around exact fixtures
- A combined process-tracking patch failed atomically because one `ShellStreamRequest` test fixture did not match the abbreviated source slice used to build the patch.
- Inspect exact constructor locations and patch owning files in small groups; verify each group before building the next dependent edit.

## 2026-07-22 — Keep PowerShell search patterns literal-safe
- A combined consistency command failed at parse time because one double-quoted `rg` regex contained an unescaped quote and closing group.
- Prefer single-quoted PowerShell patterns or split complex searches into separate commands so validation actually runs.

## 2026-07-22 — Scope whitespace checks in the CRLF-heavy worktree
- A repository-wide `git diff --check` emitted millions of line-ending-only warnings because much of this dirty worktree is already converted from LF to CRLF.
- Use task-path filters with `--ignore-space-at-eol`; never normalize or rewrite unrelated user-owned files to make the global check quiet.

## 2026-07-22 — Re-read nested JSX ternaries immediately after patching
- While adding the failed-header null branch, I left an extra closing parenthesis in the nested JSX conditional; a direct source read caught it before tests.
- After editing multi-branch JSX expressions, inspect the exact rendered conditional before moving on, then add a behavior-level regression test.

## 2026-07-22 — Correlate background servers by PID ancestry, not HTTP reachability
- I initially accepted the harness conclusion that a `200` after failed list/kill proved the latest `shell_spawn` process was alive. The persisted transcript showed stale-port contamination, and a clean process-tree probe exposed the deeper cause: Git's `bin\\bash.exe` launcher exits after handing work to `usr\\bin\\bash.exe`.
- On Windows, prefer Git's real `usr\\bin\\bash.exe`; verify wrapper PID → listener ancestry and begin lifecycle tests with a confirmed free port. A reachable port alone does not identify which spawn owns it.
- One ancestry probe also failed at PowerShell parse time because a `for` loop was piped directly. Collect loop output into an array before piping so setup and cleanup commands actually execute.

## 2026-07-22 — Do not use pnpm exec in an npm-only fixture without guarding installs
- Running pnpm-based syntax validation in the npm harness created `node_modules` and `pnpm-lock.yaml`. Keep permitted pnpm validation inside Aurora, or use an already-installed binary without allowing a package-manager install in external fixtures.
- Recursive deletion was policy-blocked, so the two generated artifacts were moved recoverably to `C:\msys64\tmp\aurora-harness-validation-cleanup-20260722`; the harness workspace was restored without touching its report changes.

## 2026-07-23 — A log that just stops is an invitation to hallucinate
- Aurora mirrored background output to a file but wrote nothing when the run ended. Truncated output is indistinguishable from a crash, so any reader has to guess — and a guess presented as fact is a hallucination the architecture caused, not the model.
- Every path out of a streaming loop is a termination and must write a terminator naming itself, including the ones that feel like non-events (spawn failure, stdout capture failure). Same for the `done` event: a cancel is as much an ending as an exit, and skipping it leaves the UI spinning.

## 2026-07-23 — Do not enqueue to a thread with no live turn
- The stop button enqueued "the user stopped this process" unconditionally. `enqueueMessage` drains at a tool-result boundary, so with no turn running the note sat in the pill and was injected into a later, unrelated turn — the agent then acted on it with no context. `useAgentTeamNotifier.ts:225` already documented the correct rule (`chat.liveTurns[threadId]`) and it was ignored.
- Prefer recording the fact where it will be read on purpose (the log file) over pushing it into the conversation. Interrupt only when someone is actually listening.
- I also described this injection path in prose as if I had traced it. Do not narrate a mechanism's behaviour from its name; open the caller and read where the value lands.

## 2026-07-25 — A React event prop is not always a real listener
- `onWheel` + `preventDefault()` looked correct and type-checked, but React attaches `wheel` at the root as passive, so the call was a no-op that only surfaced as a console warning. The same latent bug existed in two other components nobody had reported, because the symptom (the page also scrolls) reads as sloppiness rather than a defect.
- When a handler must cancel a default, check how the framework registered the listener — for `wheel`, `touchstart`, `touchmove` and `scroll` in React, bind natively with `{ passive: false }`. A silent no-op is worse than an error: it fails in the direction of "feels janky".

## 2026-07-25 — A byte cap tuned for status blobs silently destroyed the tool it was applied to
- `MAX_TOOL_RESULT_LENGTH` (8 KiB) was a sane default for grep/websearch and catastrophic for `workspace_tree`: every call fell into `compact_json_arrays`, which halves the largest array repeatedly and left 47 of 3,066 nodes — with `src/` and `src-tauri/` deleted and only a top-level `historyTruncated: true` to show for it.
- Two lessons. (1) A shared clamp needs a per-tool answer whenever the tools deliver different KINDS of thing; `file_read` already had one and nothing generalised the idea. (2) A node budget is not a byte budget — the first rebuild fit 1,200 nodes and still produced 221 KB, so it would have been shredded identically. Measure the serialized payload, not the item count.
- Corollary that keeps paying off: truncation must name itself AND the recovery step. Claude Code's own Glob says "Showing 100 of 172 … Narrow the pattern" — that one sentence is the difference between the next call being a narrowing and it being a guess.

## 2026-07-25 — `#[warn(dead_code)]` on a pub fn can mean "unfinished", not "unused"
- `ShellKind::interactive_args` was flagged dead. It was not redundant — it was the contract for wiring the PTY terminal to the shell registry, and that wiring had never been done, so the terminal still hardcoded `C:\Program Files\Git\bin\bash.exe` while the module docs claimed it no longer did. Deleting it would have cemented the bug.
- Check what a "dead" symbol was FOR before removing it. Three of six warnings here were genuine deletions, one was an unfinished feature, and one (`env::overlay_map`) was a test helper that cargo check cannot see — I deleted it, broke `cargo test`, and restored it as `#[cfg(test)]`. Run the TEST build before concluding anything is unused.

## 2026-07-25 — A frontend cache of state the backend owns will drift, and the drift is invisible
- The background-process dock kept its own copy of what was running, keyed by thread, built from tool results. Rust already had the authoritative ledger. The copy could not be right: switching project hid a live dev server and took its stop button with it, and a window reload erased the copy while the processes ran on.
- The tell was in the store's own doc comment — "kept per thread so a background turn's dev server never appears in another chat's dock". That was a deliberate scoping decision applied to the wrong kind of fact. A *conversation artifact* (a finished run's log) is per-thread; a *running process* is per-machine. Scope by what the thing IS, not by where it was created.
- Whenever the UI mirrors backend state, add a reconcile path before shipping. Events alone are not enough: `shell-process-ended` is fire-and-forget, so anything that misses it (a reload mid-flight) leaves a permanently wrong row with no way to correct itself.

## 2026-07-29 — "The stream ended" was a token budget, and I confidently blamed the network first
- The user reported an xhigh-reasoning turn dying after ~1 min. I read the SSE drivers, found that all
  three treat EOF as a successful turn (`None => break` then `finish_reason.unwrap_or("stop")`), and
  presented that as the answer. It is a real bug — but it was NOT this bug. The actual cause only
  became visible when the user pasted the reasoning transcript: 29,048 chars ≈ 7.2k tokens against an
  8192 output cap where `xhigh` claimed 90% of it. The arithmetic was decisive and I had never done it.
- The lesson is about ordering, not about being wrong. I had the cap (`default_max_output_tokens: 8192`)
  and the tier share (`Some("xhigh") => 90`) open in front of me BEFORE I answered, and I read them as
  configuration rather than as a budget to add up. When a symptom is "it stopped early", price the
  budget first — it is cheap, arithmetic, and falsifiable — before reaching for the more interesting
  distributed-systems explanation. A plausible mechanism found by reading code is a hypothesis; a
  number that matches the observed output to within 2% is evidence.
- Corollary that actually mattered more: ASK FOR THE ARTIFACT. One paste of the truncated transcript
  settled in seconds what code-reading had been circling. It also showed the cut landed mid-identifier
  (`usePrefersReduced`), which is what ruled out a clean provider stop.

## 2026-07-29 — An event switch with one silent `break` hid a warning the backend was already sending
- Rust correctly detected the truncation and emitted `AssistantEvent::Error{recoverable:true}` telling
  the user the reply was cut off and to raise Max output. `agent-runtime-client.ts` had
  `case "error": break;` — the ONLY arm in a switch of ~15 with no callback, sitting directly above a
  `default:` that logs unknown events with `console.warn`. So an event the team explicitly modelled was
  treated worse than one nobody anticipated.
- Two things to carry forward. (1) In an exhaustive event dispatcher, a bare `break` is a claim that
  the event is intentionally ignorable; if that is true it deserves a comment saying why, and if it is
  not true it is a dropped feature. Grep for arms with no callback whenever a backend signal
  "doesn't show up". (2) The fix is not just to forward it — `onError` appended the text into
  `m.content`, which makes the AGENT appear to announce its own truncation. Runtime speech and model
  speech need different renderers, or the product loses the ability to say anything in its own voice.

## 2026-07-29 — Clamping two invariants independently satisfies one and breaks the other
- Fixing the budget, I wrote `answer.saturating_add(budget).min(CEILING).max(budget + 1)`: the `.min`
  enforced "max_tokens <= 64k", the `.max` enforced "budget < max_tokens". With a 32k answer budget on
  `xhigh` the desired budget was 96k, so the floor re-raised the total to 96,001 — back over the
  ceiling the previous call had just enforced. The test I wrote for the ceiling caught it immediately.
- When two constraints reference each other, resolve them in ONE function that returns the whole
  consistent answer (`-> Option<(budget, max_tokens)>`), not as a chain of independent clamps. And
  decide explicitly which side absorbs the loss — here reasoning shrinks and the answer allowance
  stays whole, because starving the reply was the original bug.
- Worth noting the loop test (`for answer in [...] { for effort in [...] }`) asserting both invariants
  at every size found nothing further, but it is the test that makes this class of bug non-recurring.
  Point assertions would have kept passing at the sizes I happened to pick.

## 2026-07-29 — I diagnosed the right symptom through the wrong code path, twice, before reading the data
- Sequence: (1) blamed EOF-as-success in the SSE drivers; (2) the user pasted the transcript, I did the
  token arithmetic and blamed the Anthropic `xhigh` 90% thinking carve-out; (3) the user pushed back
  — "that model has no budget slider, only effort tiers, so where are those tokens coming from?" — and
  reading the actual session + provider row showed the provider was `provider_type: "openai"`, so the
  Anthropic code I had been reasoning about was never executed at all.
- The real cause was one line of precedence in `toLlmConfig`:
  `defaultMaxTokens: provider.defaultMaxTokens ?? provider.maxOutputTokens` combined with consumers
  reading `defaultMaxTokens ?? maxOutputTokens`. A stale provider-level 8192 therefore beat the
  per-model 128000 that the resolver had just computed correctly. Nothing about reasoning, streaming,
  or Anthropic was involved in the cap itself.
- Lesson: when a bug report names a MODEL, resolve the whole config chain from the stored row before
  reasoning about any adapter. `provider_type` decides which thousand lines of code even run, and I
  read `claude-opus-5` and assumed "Anthropic adapter" — through a third-party OpenAI-compatible
  gateway it is not. One `.meta.json` + one DB query would have told me at the start.
- Second lesson: a defaulting chain where two fields can both supply the same value needs an explicit
  precedence comment, because `a ?? b` at the producer and `a ?? c` at the consumer silently makes `b`
  outrank `c`. The bug is invisible at both sites and only exists in their combination.
- Third: the user's domain instinct beat my code reading. "No slider, only effort tiers" was a precise
  observation about the model's `reasoning` config that directly contradicted my theory. Treat that
  kind of pushback as evidence to chase, not as something to explain away.

## 2026-07-29 — A tool schema that can't express its own contract will be "violated" by correct models
- User: "Opus 5 / Kimi K3 are very intelligent, they can't make this mistake" about `file_read` failing
  ~1% of calls with `paths: [1 item]` + `start_line`/`end_line` → "only work with single-file `path`".
  They were right, and the framing was the useful part: a frontier model producing the same malformed
  call repeatedly is evidence about the INTERFACE, not the model.
- Two compounding causes. (1) `file_read` declares `path`, `paths`, `start_line`, `end_line`,
  `max_lines` as independent optional siblings, because the real `path` xor `paths` rule needs a
  top-level `oneOf` and strict validators (xAI/grok) HTTP-400 on `oneOf`/`anyOf`/`allOf` in function
  params. So `{paths:["x"], start_line:1}` is **schema-valid** and the runtime rejected it anyway. The
  model obeyed the contract it was given; the prose description carried a rule the schema denied.
  (2) The rule was over-broad: a ONE-element `paths` names exactly one file, so a line window has
  precisely one referent — there was nothing ambiguous to reject.
- Fix: coerce a single-element `paths` + line window into the single-file form and serve the read; keep
  the error only for 2+ files, and reword it to name the recovery that PRESERVES intent ("re-issue with
  `path`…") instead of "omit them", which told the model to throw away what it wanted.
- Generalisable rule: when a schema cannot encode a constraint, the runtime must be as permissive as
  the schema is, and resolve every unambiguous input instead of failing it. Prose in a description is a
  hint, not a validator. Audit any tool whose docs say "exactly one of" — that phrase marks a contract
  the schema probably isn't enforcing.

## 2026-07-30 — When the model "misbehaves", read the text we hand it before touching the tools
An agent inside Aurora filed 7 complaints about its own environment. **Three were caused by Aurora's own
prompt and tool-description text instructing the behaviour being complained about**, not by missing features:
- `shell_list_processes` literally said "read that file with file_read to see what a running process has
  printed". Its 15-call polling loop was obedience, not incompetence.
- `getMcpToolsSummary()` injected a whole second tool inventory in display-name form and then told the model a
  prefixed callable name existed without printing one. It reached for the useless inventory because we made it
  the prominent one.
- `agent-prompt.ts` said to prefer friendly MCP names — meant for prose, read as naming policy for calls.
Rule: before adding a tool or a flag to fix agent behaviour, `grep` the prompt and every tool `description`
for what we already told it. A tool description is executable policy; the model follows it exactly.

## Same session — an agent's self-report is a hypothesis, not a bug report
5 of 7 asks were real, but 2 diagnoses were wrong in ways that would have driven the wrong fix:
- "There is no formula I can derive [for MCP callables]" — the exact callable was in the tool schema the whole
  time. The symptom was real; the stated cause was not.
- It asked for `auto_lint: true` on every edit, not knowing `read_lints` runs `tsc -b` / `cargo check` /
  `compileall` over the WHOLE project. Building it as asked would make a 5-file refactor 5 full builds.
Verify every claim against the code, including the ones that sound authoritative — and re-check the harness
layer it names. I also asserted `getMcpToolsSummary` was legacy-IDE-only; the agent window reaches it through
`AgentService` too, so the report was right and I was wrong.

## Same session — derive counts in tests, never hardcode them
`tools/mod.rs` had `assert_eq!(reg.len(), 22)` in two tests plus a module doc claiming "10 + 6 = 16 … total
24" against a real 30. The prose had drifted three separate times because `builtin_tool_count_is_correct`
guards the constant and never the comment. Adding one tool broke both literals. Now derived from the bucket
`TOOL_NAMES` arrays, with the single intentional-change tripwire left in `BUILTIN_TOOL_COUNT`. If a test
asserts a total that a sibling array already knows, compute it.

## 2026-07-31 — "One system" was the bug, not the fix
- A plan and a todo list were unified so there would be "exactly one answer to where am I". The
  unification was the defect: a plan is COARSE and per-project (phases the user approved), a todo
  list is FINE and per-thread (the steps of the phase being executed). They are different
  granularities of different things, so suppressing one to serve the other produced a checklist that
  could never move in a planned project, and a `todo_update` tool the prompt told the model to prefer
  while the runtime refused to run it.
- The tell was in the user's own words — "plan could be three phase; in phase one he will create a
  todo for five steps". When a user describes a workflow that the architecture forbids, the
  architecture is wrong. Do not defend a unification because it sounds principled; check whether the
  two things being unified are the same KIND of thing.
- Second lesson, and the reason this shipped broken for so long: the panel was a frontend
  reconstruction of state Rust already owned, built by parsing tool-call ARGUMENTS of one tool. Every
  other tool that changed the list was invisible to it. This is the same class as the background
  process dock (2026-07-25) and it recurred within a week. **A frontend copy of backend state will
  drift, and parsing arguments is strictly worse than reading results** — arguments only tell you
  what was asked for, never what happened, and they only cover the one tool you happened to watch.
- Third: an event nobody can route is an event nobody can use. `emit_todo_write` carried `{todos}`
  with no thread id because the sink is app-global, so a window running several conversations could
  not apply it and simply ignored it. When adding an event, ask "what does the receiver need to know
  WHERE this belongs" before "what data does it carry".
- Fourth: the transcript printed the tool's model-facing `message` verbatim ("Marked t2 as completed.
  Nothing in progress; next up is t3."). A result string is read by BOTH the model and the user, so
  it must name things the way a person needs (task titles) and the renderer must not fall back to
  dumping it. Grep for other tools whose `message` reaches `tool-result.ts`'s 60-char passthrough.
- Fifth, caught by a test I nearly overrode: the composer-rail chip counted `completed + cancelled`
  and the panel counted `completed`. I "unified" them onto the panel's number and broke the rail's
  test, whose NAME stated the intent ("counts a cancelled todo as closed, not outstanding"). The rail
  was right — the panel's own `allDone` already treated cancelled as terminal, so it rendered
  "Tasks complete 2/3". When a test disagrees, read its name for the intent before changing it.

## 2026-08-01 — "Sometimes shows" was one deterministic bug, not flakiness

- An owner-reported intermittent UI symptom ("not showing and sometimes show") turned out to be two
  DIFFERENT code paths producing the same widget: the optimistic live message (always wrong, ~0ms
  span) and the reloaded-from-disk message (always right). Nothing was flaky. When a symptom reads as
  intermittent, first ask whether two sources feed the same render — the "sometimes" is usually which
  source you happened to be looking at.
- A derived-value guard can hide its own input bug: `turnWorkedMs` returns `null` for `span <= 0`,
  which is correct defensively but meant a broken timestamp failed SILENTLY as an absent element
  rather than as a visible "0s". Guards that map bad input to "render nothing" make upstream bugs
  invisible.
- Do not take an agent's self-diagnosis at face value. Of its two tool complaints, one was exactly
  right (`browser_click` / `:has-text()`) and one had the right symptom with the wrong mechanism
  (the console buffer is already 500 entries with uncaught-error capture; the page reload wipes it,
  it is not "consumed"). Verify against the source before acting on either.

## 2026-08-01 — Consolidating tools: the rename is the risk, not the schema

- Folding three tools into one was mechanical. The real hazard was that every model has `TodoWrite`
  baked into its training data, and edit-distance suggestion CANNOT bridge a rename — `todo_write` is
  six edits from `todo`. Without an explicit retirement table the first turn of every conversation
  would have burned an iteration on an unknown-tool dead end. When you rename a tool, ask what the
  model will call INSTEAD and make that name resolve.
- A `nativeRustOwned` TS tool definition is filtered before the request, but `build_per_turn_tool_
  registry` DOES register a bridge executor for every `AllowedTool` the frontend sends. So a stale TS
  name is only harmless while that flag is set — check the flag, do not assume the frontend defs are
  inert.
- Consolidating by name silently changes name-based gates. `todo_read` was allowed in Plan mode and
  `todo_write`/`todo_update` were not; one tool makes that distinction inexpressible. Decide the new
  answer deliberately (here: withhold entirely) rather than discovering it from whichever list the
  merged name happens to land in.
- A portaled hover popover needs a close GRACE PERIOD, not just enter/leave handlers on both
  elements. The gap between trigger and card belongs to neither, so mouse-leave fires before
  mouse-enter and the card dies mid-reach. Same trap as any hover menu with an offset.
- React derives `onMouseEnter`/`onMouseLeave` from DELEGATED `mouseover`/`mouseout`. A raw-DOM test
  dispatching `mouseenter` never reaches the handler and looks like a component bug. Dispatch
  bubbling `mouseover`/`mouseout` with a `relatedTarget`.
- Do not assert DOM removal on anything inside `AnimatePresence` — the element stays mounted for its
  exit tween, so the assertion tests framer-motion's clock. Assert the state the component controls
  (`aria-expanded`), which is also what a screen reader observes.

## 2026-08-01 (later) — A field named `session_id` that is not the session's conversation

- `Session` has BOTH `session_id` (fresh UUID per load) and `thread_id` (the conversation). Every
  tool-layer consumer of `ctx.session_id` actually wanted the thread; the name made the wrong one
  look right, and three separate features (todo sidecar + event, plan run claims, background log
  cleanup) silently keyed off an id that changed on every restart. When two ids of the same shape
  coexist, the field name is the whole defence — rename rather than reassign, so the next reader
  cannot repeat it.
- Making a tool render NOTHING removed the only evidence that it ran. The broken event path above
  had been live for a session and was invisible precisely because I had just silenced the tool's
  transcript row. Silence and failure look identical; if a tool is silent, its effect must be
  verifiable somewhere the user can actually see.
- `tsc --noEmit -p tsconfig.json` and `tsc -b` are NOT the same check here — the project-references
  build caught a bad field in a test file the flat run passed. Run `pnpm build` before claiming
  typecheck is clean.

## 2026-08-02 — A `scroll` event is not user intent, and a self-scrolling hook will cancel itself
- Two owner-reported agent-window bugs had ONE cause. `useAgentAutoScroll`'s scroll listener treated
  every `scroll` event as "the reader deliberately left the bottom" — cancelling the follow loop and
  dropping the entry anchor. But the hook is the most prolific scroller in the window: the follow lerp
  assigns `scrollTop` once per frame and the entry anchor assigns it on every re-pin. **It was
  reacting to itself.**
  * "Jump to latest" moved ~25% per click: frame 1 of the lerp scrolled → that fired `scroll` → still
    >140px from the bottom → `cancelFollow()` killed the rAF loop one frame in. The animation
    strangled itself, so the button looked like it advanced "lil by lil".
  * Opening a thread landed above the newest message: the anchor's own re-pin scroll set
    `initialAnchorRef = false`, and the 800ms fixed window expired while messages were still loading
    async and markdown/Shiki/images were still growing the transcript. After that, growth only
    followed `if (isStreaming)` — false for a restored thread — so the reader was stranded.
- RULE: if a component both scrolls programmatically and listens for scrolling, `scroll` can only be
  used to OBSERVE position. Reader intent must come from INPUT events — `wheel`, `touchstart`, a
  `pointerdown` whose `offsetX > clientWidth` (scrollbar gutter only, so clicking a tool card doesn't
  stop a stream from following), and navigation keys. Same family as the passive-`wheel` lesson from
  2026-07-25: the framework/browser event you reach for first often isn't reporting what you assume.
- RULE: an "entry window" for async-growing content must be a QUIET PERIOD (restarted on every
  growth), never a fixed delay from mount. A fixed 800ms expires mid-layout on exactly the long
  conversations that need it most. Keep a hard cap too, or a view that never stops growing pins the
  reader forever.
- Also: an explicit "go to the bottom" should SNAP past a few screens rather than glide. A lerp across
  50 screens is not continuity, it is a wait — and the reader asked to BE at the bottom, not to travel
  there. Extracted as a pure `shouldSnapToBottom(distance, viewportHeight)` so the threshold is
  testable without a layout engine (jsdom models none of scrollHeight/ResizeObserver/rAF).
- Trap while fixing: adding `setShowJump(false)` inside `jumpToBottom` tripped
  `react-hooks/set-state-in-effect`, because that function is called from an effect as well as from
  the button. A helper invoked from both effects and handlers must stay setState-free — the scroll
  event already reconciles it.

## 2026-08-02 — The harness corrupted a valid glob, then the model looked wrong for sending it
- SYMPTOM (owner pasted a live tool result): `grep` failed with
  `rg: error parsing glob '**/*.{ts': unclosed alternate group; missing '}'`. Note the glob in the
  message is TRUNCATED — the model had sent `**/*.{ts,tsx}`, which is correct.
- CAUSE: `commands/mod.rs::parse_glob_patterns` was `value.split(',')`. The comma is BOTH Aurora's
  list separator and glob alternation syntax, so `**/*.{ts,tsx}` was cut into `**/*.{ts` and `tsx}`
  before ripgrep ever saw it. Reproduced exactly against the bundled `rg`: the fragment emits the
  owner's error verbatim, the whole glob returns files.
- This is the same family as the 2026-07-30 finding ("read the text we hand it before touching the
  tools") but the mirror image of it: there the prompt TOLD the model to misbehave; here the harness
  silently MUTATED correct input. Both end with a competent model looking incompetent. **When a tool
  rejects a value, check whether the value in the error is the value the model actually sent** — a
  truncated echo in an error message is the tell.
- RULE: never `split(sep)` a value when `sep` is also syntax inside that value. Splitting must be
  depth-aware — top-level commas only, skipping `{…}` alternation, `[…]` classes, and `\` escapes.
  Malformed input is forwarded verbatim rather than repaired: ripgrep names the real problem better
  than a guess at intent.
- Contributing gap: the `glob` property in grep's schema had NO `description` at all, so nothing told
  the model that comma-separated multiples were even supported — or that braces were expected to work.
  An undocumented parameter invites exactly the input the parser mishandles. Now documents braces,
  comma lists, and `!` negation.
- The sibling `glob` TOOL was never affected — it passes its pattern straight to `--glob` with no
  splitting. Only the ripgrep-backed `grep` had the bug.

## 2026-08-02 (same session) — The glob fix alone would have made the bug WORSE, not better
- Owner ran `grep` with `glob: apps/quantumhub-client/src/**/*.{ts,tsx}` and `path:
  E:\QuantumHUB-Infrustructure` and got ZERO results. Reproduced against the real repo: the correct
  search returns **35 files**. Two independent bugs were stacked.
- BUG 1 was the comma split (fixed earlier this session). BUG 2: `grep` passed the search root as
  ripgrep's PATH OPERAND. **ripgrep anchors a slash-bearing glob to the WORKING DIRECTORY, not to the
  path operand**, so any path-qualified glob (`apps/x/src/**/*.ts`) matched nothing against an
  absolute root, while bare `**/*.rs` kept working.
- THE POINT WORTH REMEMBERING: had I shipped only the comma fix, the loud
  `unclosed alternate group` error would have become a SILENT EMPTY RESULT — the same wrong answer
  with the evidence removed. When fixing a tool that errored, re-run the ORIGINAL failing call end to
  end afterwards; a fix that merely stops the error can be a regression.
- `glob.rs` had ALREADY solved bug 2 and its comment names it exactly — "passing an absolute root made
  every such pattern silently match nothing while bare patterns like `**/*.rs` kept working — the
  worst shape of bug, since the tool looks functional" — and applies `cmd.current_dir(&search_root)`.
  `grep` never got the same treatment. **When one tool's comment documents a ripgrep footgun, grep the
  other ripgrep call sites for it the same day**; sibling tools sharing a binary share its traps.
- Fix mirrors glob.rs: run with `current_dir(search_dir)` and `.` as the operand when `path` is a
  directory (a single FILE keeps the operand form — there is no directory to run in and a glob over
  one explicit file is meaningless). Because that makes ripgrep emit `.\src\x.ts`, results are
  rejoined onto the search dir by `absolutize_rg_path` so the absolute-path output contract that file
  chips / open-in-IDE / the review panel depend on is unchanged.

## 2026-08-02 — A dropdown sized from its trigger lets one arbitrary item size the whole list
- The new project switcher set its menu width to `Math.max(triggerRect.width, 260)`. The trigger is as
  wide as the CURRENT project's name + path, so the menu's width was decided by whichever project you
  happened to be in: a long name gave a sprawling menu, a short one gave a cramped menu that scrolled
  SIDEWAYS and cut every other name mid-word (`AURORA-MELODY-INFRUSTRUCT`). Owner caught it in two
  screenshots.
- RULE: a menu is its own object and sizes to its own content budget. Derive a popover's width from
  its trigger only when it is a true dropdown of that field (a select), never when it lists peers the
  trigger is only one of.
- A horizontal scrollbar inside a dropdown always means the row layout failed — nobody scrolls a menu
  sideways, so the end of every label is simply hidden. `overflow-x: hidden` on the list, and make the
  rows truncate.
- Useful flex idiom for "name + secondary detail" rows: give the SECONDARY element `flex: 1 1 0`. A
  zero flex-basis means it claims only leftover space, so it can never push the primary element out of
  the row — it shrinks to nothing before the name loses a character. The primary gets
  `flex: 0 1 auto; min-width: 0` so it still truncates in the extreme case rather than overflowing.
- Check before adding defensive CSS: `AgentIcon` already sets `flexShrink: 0` inline, so the
  `flex: none` rules I added for its glyphs were dead, and one of them
  (`span:first-of-type:not([class])`) was guesswork about markup I had not read.

## 2026-08-02 — `will-change: transform` + `transform: scale()` rasterizes vector content once

Mermaid diagrams in the Canvas were unreadable when zoomed: a diagram that auto-fit at ~10% stayed
legible-ish, but zooming to 180% produced a blurry smear where no amount of further zoom helped.

Cause: `.agw-diagram-artwork` had `will-change: transform` (wanted, for smooth panning) and applied
zoom via `transform: translate3d(...) scale(...)`. `will-change` promotes the element to its own
compositor layer; Chromium then rasterizes that layer ONCE and lets the GPU stretch the bitmap for
later transforms — precisely what `will-change` is telling it to do. So the SVG was rasterized at fit
scale and every zoom step enlarged that bitmap instead of re-rendering the vector. Zooming was the
thing destroying the image.

RULE: never express zoom of vector/text content as `transform: scale()` on a promoted layer. Apply
zoom to the element's LAYOUT SIZE (width/height) and keep the transform for translation only — the
layer's size change forces a re-raster, so the SVG re-renders sharp at every level. The substitution
is exact when `transform-origin: 0 0`, because a scaled layer and a grown box occupy the same
rectangle; that is what let the fit/pin-point-zoom maths stay untouched (`diagramArtworkBox`, tested).

Wider tell: "content is blurry only after zooming / only on one surface" is almost never a rendering
bug in the content — look for a composited ancestor being scaled.

## 2026-08-04 — A Tauri event listener can be silently filtered out by its target KIND
- `getCurrentWindow().onDragDropEvent(...)` never fired in the agent window, so dragging a file from
  Windows Explorer into the composer did nothing — with no error anywhere. The events were arriving in
  that very webview the whole time. `Window.listen` subscribes with `{kind:'Window', label}`, and
  `manager/mod.rs::filter_target` only feeds a Window-kind listener from `Window`/`AnyLabel` emits — a
  `Webview`/`WebviewWindow`-kind emit is dropped by `event/listener.rs::emit_js_filter`. Label matching
  is NOT sufficient; the kind must match too.
- FIX: subscribe with `listen(name, handler, { target: label })`. A STRING target maps to
  `{kind:'AnyLabel'}` (event.js:72), the only kind `filter_target` matches for every emit variant
  carrying that label — and unlike `{kind:'Any'}` it stays scoped to this window, so a drop on the IDE
  window can't insert files into the agent composer.
- METHOD worth reusing: when a Tauri event "never arrives", register a second `{kind:'Any'}` listener
  for the same event name. It short-circuits the target check (listener.rs:310), so if the probe fires
  and the real listener doesn't, the problem is target filtering — not the OS, the config, or the
  runtime. That one probe replaced a long chain of plausible theories (elevation/UIPI, dragDropEnabled,
  capabilities, DPI) that were all wrong.
- Do not diagnose a UI symptom against the wrong binary: three `aurora.exe` were running (two installed
  from LocalAppData, one dev). Check `Get-CimInstance Win32_Process` command lines FIRST, and confirm
  the dev server is serving the edited module (`curl http://localhost:5173/src/...`) before trusting
  "still broken". Reading the app's own DevTools console via UIA (qg-probe `dump_tree` + the console
  filter box) beats asking for a paste.

## Tauri drag-drop events only reach Webview/WebviewWindow-kind listeners (2026-08-04)
- OS file drops onto the agent window produced no events for `getCurrentWindow().onDragDropEvent`
  (`{kind:'Window'}`) NOR for a string listen target (`{kind:'AnyLabel'}`) — yet a `{kind:'Any'}` probe saw
  everything. Root cause: on Windows the drag lands on the WEBVIEW, so tauri 2.9.5 emits from
  `manager/webview.rs::on_webview_event` → `emit_to_webview`, whose filter is
  `Webview{label} | WebviewWindow{label} => label == window_label, _ => false`. Window/AnyLabel are in the
  `_ => false` arm; `Any` bypasses via `match_any_or_filter`.
- Do NOT reason from `manager/window.rs`'s drag emit (AnyLabel, broad matrix) — that path is not the one used
  for a webview window. When source and runtime disagree, register every target kind at once in the live
  window and see which fires; that 5-minute experiment settled what two sessions of source-reading got wrong.
- Fix: `listen(ev, h, { target: { kind: 'WebviewWindow', label } })` in `useAgentExternalDrop.ts` (or
  `getCurrentWebview().onDragDropEvent`). One line; everything else in the drop chain was already correct.

## 2026-08-04 — A structural marker set as heavier prose is invisible in a transcript
- Chapters first shipped as 15px/600 text over a rule. The owner's verdict: "feel like same as bold
  bullet header". Correct — a reply is FULL of `**bold**` lines and markdown headings the model wrote
  itself, so anything that differs only in weight and one size step cannot be told apart at a glance,
  and a section marker you have to read to recognise has already failed.
- Fix: change type ROLE, not type amount — uppercase at `--agw-fs-label`, medium weight, tracking, plus
  `agw-timeline-rule` (the window's existing named-boundary idiom). Full `--agw-text`, not the subtle
  grey the other labels use, because this one is what the eye should land on when skimming.
- I made it worse first: the spine variant zeroed the chapter's `border-top` and `margin-top` to avoid a
  crossbar, which removed the ONLY structural signals it had and left literally a bold line of text.
  When an opt-in treatment strips another feature's ornament, check what is left carrying its meaning.
- Also: the break above a chapter lives in `padding-top`, not `margin-top`. A child's top margin
  collapses out of the row wrapper and adds to the flex gap, which cut the spine's line at every
  chapter. Padding keeps the space inside the row so the line runs through it.
- Centring the title between two rules was tried on request and rejected immediately — every other line
  in a turn starts at the same left edge, and breaking that column defeats vertical scanning.

## 2026-08-04 — One timeline marker per ROW is wrong when a row holds N tool calls
- The spine drew its marker on `.agw-row`, but a tools row is EVERY call between two pieces of text. Ten
  calls therefore shared one dot pinned at the top of the group, so the thread read as if it had stalled
  up there while the work was visibly moving down the list ("marker still above 10 tools").
- Fix: `ToolGroup` wraps each call in `.agw-tool-step` and the marker hangs on that. The wrapper is
  necessary because `ToolCallCard` returns FIVE different roots (standard card, canvas launch, plan
  launch, plan step, checklist beat) — matching on those class names would have silently skipped a sixth.
- Exception that is not a bug: a grouped run (≥6) keeps the single row marker. Its cards sit in a
  `max-height` scroller, where an absolutely positioned marker at negative `left` is clipped by the
  scroll box and drifts as it scrolls.

## 2026-08-04 — "The same preference gates both" is only true on the surface that forwards it
- The chapter feature gated its prompt instruction on a GLOBAL store read inside
  `composeAgentSystemPrompt`, while the tool roster was gated on a per-request flag only
  `useAgentWindowSend` forwarded. The IDE chat composes the same prompt but never set the flag, so
  with Chapters on, every IDE turn was instructed to call a tool Rust withheld. When one preference
  must switch a prompt section AND a tool roster, thread ONE value through the caller's config to
  both — a store read inside a shared helper silently applies the union of every surface's settings.
- The spine's "live marker" shimmer targeted `.agw-tool-card[data-status="running"]::after`, a
  pseudo-element with no `content` anywhere — CSS on a content-less pseudo-element paints nothing and
  fails silently. The marker lives on `.agw-tool-step::after`; select it via
  `:has(.agw-tool-card[data-status="running"])`. When styling a pseudo-element you didn't create,
  first grep for the rule that gives it `content`.

## 2026-08-04 — Sticky UI inside the rail: two traps hit back to back
- `position: sticky` silently does nothing inside the rail's `Collapse` wrapper — framer-motion's
  height tween needs `overflow: hidden`, and any non-visible-overflow ancestor becomes the sticky
  containing block. A rail element that must pin to the scroller's edge has to live OUTSIDE the
  Collapse, gated by the same `projectsOpen` condition the Collapse encodes.
- Any pinned/floating element filled with `--agw-rail-paint` (or `--agw-dock-paint`) is 45%
  see-through when Translucent sidebar is on — content scrolling beneath reads straight through the
  label. The fix is the window's existing glass idiom: add the element to the
  `[data-translucent] … backdrop-filter: blur(16px) saturate(1.3)` selector list, not an opaque
  one-off colour that would break the user's chosen frame.

## 2026-08-05 — Canvas: three ways the same surface lied to someone
- `mermaid.parse` is NOT the renderer's contract: sources it accepts still die in LAYOUT ("Setting
  RELAY as parent of RELAY would create a cycle"). Write-time validation that only parses returned
  `success:true` for diagrams the Canvas then error-carded — the model was told it worked and the
  user saw it broken. Validate with the same phase the display runs (`mermaid.render`), and return
  the renderer's exact message in the rejection. A validator weaker than the renderer is a liar.
- A "X outranks Y by default" rule held in a COMPONENT'S mount-time useState buried every new
  artifact in a planned project: `present_artifact` ran before CanvasPanel mounted, so the panel
  woke up defaulting to the plan with the new diagram invisible behind it. Priority state that
  events must flip belongs in the store next to those events (`canvasSource`), never in local state
  a mount re-defaults.
- Fit-to-view is an OVERVIEW policy, not an OPENING policy: fitting a 4000px architecture diagram
  into a dock column lands at ~25% and every label is illegible ("had to zoom 300+"). Open at
  max(fit, readable floor 0.65) anchored top-centre; keep full fit on the explicit Fit button.
  Extracted pure (`initialDiagramViewport`) because jsdom can't layout.

## 2026-08-05 — The provider "API type" dropdown was decorative
- `ProviderKind::detect` keyed on `provider_id`, but that field carries the provider ROW id — a
  preset slug for built-ins, a generated **UUID** for user-added providers. So every custom provider
  matched no arm and fell to `OpenAICompat`, silently running Chat Completions no matter which API
  type was selected. It survived because built-in rows (`deepseek`, `codex`, `openai-responses`)
  have id == type, so the only broken cases were the ones nobody had unit-tested.
- Three more decisions keyed on the same wrong field and were equally broken for custom providers:
  `supports_prompt_caching`, `should_request_stream_usage`, `reasoning_field_for`. Fix was a distinct
  `provider_type` on `ProviderConfigSnapshot` + `effective_provider_type()` (falls back to
  `provider_id`, which is why built-ins kept working). **Row identity is not provider family — a
  field that means "which one" must never be reused to answer "what kind".**
- The console log printed `providerType` while the request used `providerId`. The log confirmed the
  belief it should have falsified; that is why this lasted. Log the value the code branched on.
- Symptom to recognise: HTTP 200, `choices: []`, immediate `[DONE]`, tokens billed, blank UI. A
  wrong-but-live endpoint (here `api.a6api.com/chat/completions`, no `/v1`) answers instead of 404ing.
  Aurora treated an empty stream as success — it now reports it as a failure.

## 2026-08-05 — Screenshots were being thrown away by half the providers
- Aurora put `browser_screenshot` images INSIDE the `role:"tool"` message on the OpenAI-compat
  path (`openai_tool_result_content`), mirroring the Anthropic adapter — where images inside
  `tool_result` genuinely are the native, correct shape. On Chat Completions that placement is
  **provider-dependent and fails silently**: HTTP 200, no error, the image just never enters the
  prompt. Measured with one screenshot: a6api dropped it for BOTH `claude-opus-5` and
  `gpt-5.6-luna` (model answered `NO_IMAGE`; prompt_tokens 7,311 vs 244,502 for the same image in
  a user message), while a vLLM-family endpoint (MODAL/kimi-k3) accepted it and reported
  `image_tokens: 437`. The agent looked like it was using screenshots while actually reasoning
  from `browser_page_outline`.
- METHOD that settled it: `prompt_tokens` is the honest witness. An 849 KB base64 image is ~240k
  tokens — if the count doesn't jump, the image was discarded no matter what the model says. Don't
  ask the model whether it saw the image; read the token count.
- I twice asserted "OpenAI-compat cannot carry images in a tool message" as an absolute before
  testing. It is false — lenient servers accept it. The true statement is narrower: only the
  user-message placement works EVERYWHERE, and the providers that reject it say nothing. Fix is
  unconditional (no provider sniffing): images are split out of tool results and ride in a
  following `role:"user"` message, tool entry keeps the text + a hand-off note.
- `responses.rs` already did this correctly (trailing user item) — only the Chat Completions
  adapter had the bug. Anthropic is untouched and must stay that way.

## 2026-08-06 — The canvas SDK's first Table API was wrong, not the model's usage
The agent wrote `columns={[{ key, header, align: "right", disableSort }]}` and put `<code>`,
`<Badge>` and a bar `<div>` in cells. The SDK demanded `{ key, label, numeric }` and typed cells as
`string | number`. Result: every heading blank, every cell `[object Object]`.

**The API was the outlier.** `header`/`align` is what every table library uses, and components in
cells is the obvious want — a path needs `<code>`, a category needs a badge, a share needs a bar.
Fixed by accepting `header` (with `label` as synonym), taking `ReactNode` cells, and **inferring**
numeric/sortable from the data instead of asking for flags that can be wrong.

Two rules this cost us:
1. When designing an API a model will call, match the convention it has already seen ten thousand
   times. Novel-but-tidy loses to conventional-but-boring every single time.
2. Without semantic typechecking, a wrong prop name renders BLANK rather than failing. Any required
   prop must therefore throw with the exact fix (`columns[0] has no heading. Give it header: "…"`),
   and any value that would stringify to `[object Object]` must throw instead of rendering.

Also: `r#"…"#` in Rust cannot hold a TSX example containing `"#` (a `header: "#"` column). Use `r##`.

## 2026-08-06 — Moving 400 files: what a codemod cannot see, and how a rename corrupts itself
Restructuring `src/` into `apps/ + kernel/`. `tsc` stayed green through failures that only the
test suite caught, twice leaving the tree in a state that looked finished and was not.

**Three things import-rewriting misses entirely.** They are not imports, so no `from "…"` regex
touches them and TypeScript never sees them:
1. `vi.mock("…")` path strings. A stale mock does **not** error — it silently stops applying, the
   real module runs, and the failure surfaces somewhere unrelated. 9 broke across two moves.
   Fixed by making mock paths `@/…` absolute so they stop being position-dependent.
2. Hardcoded filesystem paths — `readFileSync` on `src/apps/agent/components/…/MessageBubble.tsx`
   in `appearance-token-coverage.test.ts`. Broke **three separate times**; it is the one category
   neither a codemod nor a resolver-based repair pass can reach.
3. Doc comments naming paths (23 files still pointed at the old `src/types/theme.ts`), plus
   `scripts/add-theme-notice.js`, which *stamps* that header and would re-introduce them.

**Bare side-effect imports are invisible to naive dependency scans.** `import 'x'` has no `from`,
so a reachability script matching only `from '…'` / `import('…')` reports live files as dead.
`lib/monaco-setup.ts` was nearly deleted this way; two editor components depend on it for Monaco
registration. Any "is this dead?" check must include `^import '…'`. Related: ripgrep patterns
anchored with `$` silently fail on this repo's CRLF files — anchor with `\s*$`.

**A failed move plus a successful rewrite is worse than either alone.** `git mv <dir> <dir>` fails
with "Permission denied" when the destination already exists — and because the mover discarded
git's output and never checked status, the import rewrite ran anyway, leaving every import
pointing at paths nothing had moved to. Then a filesystem move into an existing directory
**nests** rather than merges (`apps/agent/store/store/`). Verify a move actually landed before
rewriting anything that depends on it.

**Sequential string replacement over overlapping keys corrupts already-correct paths.** Grouping
`skills.ts` under `services/skills/` meant the prefix `@/apps/agent/services/skills` then matched
*inside* the freshly-correct `…/services/skills/prompt-assets`, yielding
`skills/skills/prompt-assets`. Use one single-pass regex with a lookup callback, so a rewritten
span can never be rewritten again.

**A shared god-store poisons ownership analysis.** An import-graph classifier reported 8 services
as shared by both products; they were reachable only *through* `useSettingsStore`, which both
windows import. Only `git` and `database` were genuinely shared. The boundary lint rule — not the
graph — is what exposed it. Treat "reachable from both roots" as a hypothesis, then check who
imports it directly.

**Cleanup deleted a live test.** A recursive force-delete of a folder that looked empty took
`theme-system-integration.test.ts` with it (recovered via `git checkout`). List a directory's
files recursively before deleting it, however empty it appears.

**PowerShell footguns hit during this work.** `-replace` is case-insensitive, so renaming
`ModelOption` also renamed `modelOptions` — use `-creplace` for identifiers. `-Include` silently
matches nothing unless the path ends in a wildcard (`dir\*`). Multi-line `-replace` patterns are
regex, so a literal `import {` matches nothing.

## 2026-08-06 — A capture-phase `scroll` listener on `window` hears every scroller in the app
- Right-clicking a chat row in the left rail during a streaming turn opened the context menu and
  dismissed it instantly. `RailMenu` closes on `scroll` bound with `capture: true` on `window`
  (necessary — `scroll` does not bubble), and `useAgentAutoScroll`'s follow loop assigns
  `scrollTop` on the TRANSCRIPT once per animation frame while a turn streams. ~60 dismissals a
  second, from a scroller in a completely different panel.
- Third instance of the 2026-08-02 rule (`a scroll event is not user intent`) and the first where
  the listener belonged to an unrelated component. RULE: a close-on-scroll handler must decide
  against the thing it is anchored to — `RailMenuState` now carries the row (`anchor`) and closes
  only when `event.target.contains(anchor)`. `contains` also covers `document` for page scroll.
- The anchor is read as `event.currentTarget` inside the handler and held in a REF, not a dep: the
  owning panel re-renders constantly during a turn, and an `onClose` identity in the effect deps
  re-subscribes the listeners on every one of those renders.

## 2026-08-06 — A per-block duration has to be measured per DELTA, not at finalization
- Adding "Thought · 4m 14s" to the reasoning block: the obvious Rust implementation is
  `now - started` inside `BlockState::into_content_block`. It is wrong here because EVERY block in
  a turn is finalized together at stream end (one `into_content_block` call site,
  `provider_kernel_adapter.rs`), so a 3-second reasoning pass followed by two minutes of tool
  streaming would report two minutes. Stamp `ended_at_ms` on each delta instead.
- Three adapters (`anthropic`, `openai_compat`, `responses`) append thinking text, and a bare
  `text.push_str` on the variant compiles fine while silently freezing the clock. Gave `BlockState`
  a `push_thinking()` that appends AND stamps, plus `new_thinking()` — the append sites can no
  longer forget. Same reason the tool count is derived rather than repeated.
- The reload path is a SECOND source for the same widget: `commands/threads.rs` rebuilds the block
  from `ContentBlock::Thinking`, which had no timestamps — so shipping only the frontend clock gives
  a number while streaming and a blank after reopening the chat. `duration_ms` is `Option` +
  `serde(default)`: pre-existing sessions render NO number, never a zero. "measured as instant"
  (`<1s`) and "never measured" (absent) are different facts and the block renders them differently.

## 2026-08-06 — Workspace containment is skipped entirely when no workspace is bound
- `resolve_path` / `resolve_path_for_create` (`tools/file_workspace_search/mod.rs`) take
  `Option<&Path>` and their `None` arm is `Ok(raw.to_path_buf())` — no containment check at all.
  So `ToolContext.workspace_root: None` is not "deny everything", it is "allow everything",
  including `file_write` / `delete_path` / `move_path`, regardless of the "Read outside workspace"
  setting being off. `openAgentWindow(rootPath || null)` omits `?ws=` when the IDE has no folder
  open, which is the reachable route to that state.
- `session.workspace_root` is assigned only `if session.workspace_root.is_none()` (`agent_v2.rs`
  ~579/747) — pinned on the first turn and never refreshed, while the request carries the
  authoritative root every turn. The `model` field two lines below documents this exact bug class
  and was fixed; `workspace_root` was not.
- The "Read outside workspace" escape is honoured by `file_read`, `multi_file_read` and
  `workspace_tree` only. `grep` and `glob` go through `resolve_path`, which has no `allow_outside`
  parameter — so with the setting ON the agent can list and read an outside directory but cannot
  search it. Team members (`member_actor.rs`) hardcode `allow_outside_workspace: false`.

## 2026-08-06 — "Turn cost" was one API request out of twenty, and four other cost bugs behind it
Owner spotted it from an implausible number: `$0.0173` of output on a turn where the model
reasoned for fifteen minutes. Backing the rates out of the card (`$0.0220 / 4.4K` → $5/Mtok,
`$0.1257 / 251.3K` → $0.50/Mtok) put the output at ~690 tokens — a closing summary, not a turn.
The arithmetic was right; it was applied to the wrong SCOPE.
- `AssistantEvent::Usage` fires once per API request, and a turn makes one per tool iteration.
  Both writers OVERWROTE (`useAgentContextStore.setUsage`, `agent-service.ts latestUsage = usage`).
  Rust had summed it correctly the whole time (`conversation.rs sum_usage`, tested), shipped it on
  `agent_turn_complete`, the client mapped it — and `await agent.chat(...)` discarded the return.
  **A correct value that reaches the frontend and is never read is indistinguishable from a
  missing feature.** Grep for discarded return values when a number looks scoped wrong.
- Four more, each a *silent understatement* rather than a visible error: cache-WRITE tokens were
  priced at zero because no column existed for them; no-usage providers persisted ZEROS (the live
  `~estimate` was never written back), so a reopened chat totalled an exact-looking `$0.00`;
  compaction's summarization call — which sends the entire head of the conversation and is often
  the largest single request in a thread — discarded `turn.usage` entirely; and there was no
  per-message model, so a thread that switched models could not be priced at all.
- RULE for money: sum MONEY per model, never tokens. Price is a property of the model and a chat
  can move between them mid-task, so one multiply at the end misprices every request that ran
  under a different one. `group_usage_by_model` + `priceUsage` keep the groups apart.
- RULE: a missing price is not a zero price, and an estimate is not a measurement. Unpriced
  requests are excluded from the total and disclosed by count; estimated ones force a `~`. Both
  used to fold in silently, which is the failure mode that loses trust — a total that is quietly
  short looks exactly like a total that is right.
- `getModelFor` falls back to the ACTIVE model on a miss. Correct for "where will this send",
  catastrophic for pricing history: it would price an unattributed request at today's rates and
  present it as measured. Cost needs an EXACT lookup; a miss must stay a miss.
- Key it on the presence of usage, not the role. Counting only `Assistant` messages hid the
  compaction charge, which lives on a `System` message. Anything that cost money records usage.

## 2026-08-06 — Cost precedence: the provider's own number beats any rate card
- models.dev publishes `cost.cache_write` (1,172 models — every Anthropic one; opus-5 is `6.25`
  against `input: 5`, exactly the 1.25x Anthropic documents). Aurora's `RawModel.cost` typed only
  `{input, output, cache_read}` and dropped it, which is WHY cache creation was priced at zero.
  When a catalog field looks missing, check the catalog before adding a manual field — the type
  we wrote was the limit, not the data.
- Routers in the OpenRouter family return `usage.cost` in USD on the final chunk.
  `OpenAiUsageData` never parsed it. That figure OUTRANKS anything we multiply out: it already
  includes gateway markup, BYOK rates, promos and account discounts, none of which a published
  list price knows. Precedence is now reported > configured > catalog.
- The trap when mixing sources: a group must be entirely reported or entirely computed. Groups
  are keyed on `(model, cost_usd.is_some())` in Rust and mirrored in the live accumulator — if
  one group held both, its reported dollars would sit beside tokens that also get priced, and any
  consumer either double-counts or silently drops half.
- `cost: 0` is a CLAIM ("this request was free"), not an absence. Filtering it out as falsy sends
  the request back to catalog pricing and invents a charge the provider says it did not make.
  Only `null`/absent may fall through. Same shape as the cache-price fallback: `?? base` must not
  swallow an explicit `0`.

## 2026-08-06 — Read the transcripts, not the error message: `paths` as a JSON-encoded string
- Owner: "is that our path bug or model calling bug?" over
  `paths: ["alvanworld-engine/src/modules/chats/st` + "`paths` must be a non-empty array". The
  path in the error was TRUNCATED, which is the same tell as the grep comma-split bug — the value
  in the message is not the value that was sent.
- Settled by scanning all 470 session JSONLs rather than reasoning about it: 3,534 `file_read`
  calls, of which **8 sent `paths` as a JSON-ENCODED STRING** (`"[\"a.ts\", \"b.ts\"]"`), across
  5 different conversations and projects — ~1.5% of batch reads. One `input` was two whole JSON
  objects concatenated. `%LOCALAPPDATA%\AuroraIDE\sessions\*.jsonl` persists every tool call's
  input verbatim; USE IT before theorising about a tool-call bug.
- The agent's own words in the transcript were the confirmation: "the paths array approach isn't
  working with the tool, so I'll switch to reading individual paths instead." A capable model
  routing AROUND a tool is evidence about the interface, and the workaround cost N-1 extra round
  trips per batch. Same rule as 2026-07-29: resolve every unambiguous input instead of failing it.
- Trap while fixing: `file_read` delegates the batch to `multi_file_read::read_many(input, ..)`,
  which RE-READS `paths` off the input it is handed. Coercing only the local variable left the
  original string in `input`, so the fix looked applied and changed nothing — the test caught it.
  When normalising input, hand the normalised value to every downstream consumer, not just the
  local branch.
- Separate real harness bug found in the same scan: `openai_compat` keyed tool-call accumulation
  on `tool_calls[].index` alone. A gateway that restarts the index per call glued the second
  call's arguments onto the first (`{"path":"a"}{"path":"b"}` — invalid JSON, BOTH calls lost).
  A changed non-empty `id` at a known index now starts a new block; id-less argument deltas still
  accumulate onto their index.

## 2026-08-06 — `<1s` is a hedge over a number you actually measured
- The reasoning line showed a column of `<1s` markers. It was defensible while durations were
  whole seconds ("never claim work took no time"), but a reasoning block emits MANY short
  segments, and repeating an identical bound tells the reader less than the tenths would — and
  the value is measured, so there is nothing to hedge.
- Now `0.4s` under a second, with `<0.1s` reserved for the one case that genuinely cannot be
  attributed (first and last token in the same tick). Rule: bound a number only when you could
  not measure it; if you measured it, state it.

## 2026-08-07 — Browser QA tools: the script version reports success and verifies nothing
- An agent inside Aurora asked for viewport/media emulation, keyboard, hover and an a11y tree, and
  suggested Aurora provision Playwright's Chromium. All six capability gaps were real (verified
  against the registered roster, which is `click fill navigate scroll screenshot page_outline
  inspect_element get_console_logs` — note CLAUDE.md still lists `browser_eval`/`browser_get_dom`,
  which no longer exist). The Playwright ask was wrong: ~150MB of a second engine, separately
  versioned, to do what the embedded one already can.
- THE POINT: the obvious implementation of every one of these is script injection, and it produces
  FALSE PASSES. `dispatchEvent(new MouseEvent("mouseover"))` fires page handlers but never paints
  CSS `:hover`; `dispatchEvent(new KeyboardEvent("keydown",{key:"Tab"}))` does not move focus at
  all. A keyboard audit built that way walks zero stops and reports success. A tool that certifies
  work it never did is strictly worse than a missing tool.
- The real channel was ALREADY in the codebase: `services/browser_native_capture.rs` reaches
  `ICoreWebView2` through `with_webview` → `controller()` → `CoreWebView2()` for screenshots, and
  the same object exposes `CallDevToolsProtocolMethod` — the Chrome DevTools Protocol. Both the
  method and its completion handler ship in `webview2-com 0.38`, already a dependency. Before
  concluding a capability needs new infrastructure, check what the existing native escape hatch
  can already reach.
- `webview2-com`'s `#[completed_callback]` macro already converts the returned `PCWSTR` into an
  owned `String` — the closure signature is `(Result<(),Error>, String)`, not `PCWSTR`. Do not
  hand-roll the wide-string copy.
- Emulation overrides live on the BROWSER, not the page, so they survive navigation. A 390px
  viewport set for a responsive check would silently apply to the next site and leave the user's
  panel stuck at phone width with nothing on screen explaining it. `navigate` now clears them
  fire-and-forget, and every emulation tool takes an explicit `reset`.

## 2026-08-07 — `console.error(new Error(...))` was recording `{}`
- The browser's injected console capture stringified with `JSON.stringify`, and an Error's own
  properties are NON-ENUMERABLE, so `JSON.stringify(new Error("boom"))` is `"{}"`. The single most
  common way to log a failure recorded an empty object and threw away the message AND the stack —
  the one line anyone actually needs. DOM nodes had the same problem, and a circular object threw
  and fell back to `[object Object]`.
- Second bug in the same block: `wrap()` trimmed the buffer to MAX but the `error` and
  `unhandledrejection` listeners pushed WITHOUT trimming. A page stuck in an error loop grew the
  array without bound — a memory leak in the user's page caused by our debugging aid. One shared
  `record()` now owns the trim, so a future writer cannot forget it.
- Also: uncaught errors recorded `e.message` with no `filename:lineno:colno`, which is barely more
  useful than silence. VERIFY METHOD worth reusing: extract the `r#"…"#` init script out of the
  Rust source with a regex, `node --check` it (a syntax error there silently breaks every page),
  then run the real extracted script in a `vm` sandbox against the specific failure cases. That
  caught all of this without launching the app.

## 2026-08-07 — A perf measurement that doesn't validate its own output measures nothing
- Benchmarking `AgentMarkdown` per streamed frame gave a suspiciously flat 0.1-0.2 ms across a 46x
  size range. It was `renderToStaticMarkup`, and Streamdown renders CLIENT-side only, so every
  size produced the same **73 html chars** — an empty wrapper div. The timing was real and
  measured nothing.
- The tell was the flatness, not the speed. RULE: a perf probe must assert its own work happened
  (output size scales with input) before its numbers are quotable. Shipping a "fix" off that
  measurement would have been guessing with extra steps.
- Real markdown-per-frame cost needs a browser profile; jsdom/SSR cannot see it. Not measured, not
  claimed.

## 2026-08-07 — `useSmoothReveal` advanced per FRAME, so a slow machine revealed text slowly
- The reveal closed a flat `remaining * 0.2` per animation frame. That silently ties reveal SPEED
  to frame RATE: at 30fps text appeared at half the speed of 60fps. The coupling runs the wrong
  way — a fast model (measured 217 tok/s on Agnes) is exactly when frames drop, so the harder the
  UI worked the further the text fell behind, which reads as the app being unable to keep up.
- Fixed by expressing the same 20%-per-16.7ms curve as exponential decay over ELAPSED time:
  `1 - (1 - 0.2)^(dt / 16.7)`. Frame-rate independence is now pinned by a test that walks the
  reveal to completion at 30/60/120fps and asserts the wall-clock agrees within 25%.
- Two guards the time-based form needs and the frame-based one didn't: clamp `dt` (a backgrounded
  tab or GC pause leaves a multi-second hole, and scaling by it dumps the whole backlog in one
  frame — the exact lurch the hook exists to prevent), and reject a non-finite `dt`, because
  `Math.min`/`Math.max` PROPAGATE NaN and a NaN advance freezes the reveal permanently.

## 2026-08-07 — Closing the agent window left a hidden `main` keeping the process alive
- Symptom: quit the agent window, Aurora keeps running with nothing on screen; only Task Manager
  ends it. Cause: launching straight into the agent window (`launch_prefs::LaunchSurface::Agent`)
  runs `main_win.hide()` rather than `.close()` — deliberately, because `agent_open_in_ide` needs
  `main` alive as its sole listener. Tauri keeps the process alive while ANY window exists, so a
  hidden one is an invisible anchor. `tauri.conf.json` also ships `main` with `visible: false`,
  and there was NO `on_window_event` handler anywhere in the app.
- RULE: a hidden window is a live IPC target, never a way for a person to quit. Exit when the last
  window the user can SEE goes away, not the last window that exists. Now an `on_window_event`
  `Destroyed` handler exits when no remaining webview reports `is_visible()`. Minimizing is safe —
  on Windows a minimized window still reports visible — and an un-queryable window counts as not
  visible, since an error is not a reason to keep a headless process running.

## 2026-08-07 — A 400 that names a byte offset is useless if you never print the request
- Provider rejected a turn with `did not match any variant of untagged enum ResponseInput at line
  1 column 39956`. `responses.rs` had no request tracing at all (only `openai_compat.rs` had
  `AURORA_DEBUG_API`), so the one piece of information the server gave — the exact offset — could
  not be used. Undiagnosable by construction.
- Fix is better than a debug flag: PARSE the offset out of the rejection and quote that slice of
  what we actually sent, in the surfaced error. A window (±220 bytes), never the whole body — one
  screenshot makes the request megabytes of base64 and dumping it buries the answer. Must be
  char-boundary safe: the offset is a byte count and naive slicing panics mid-codepoint.
- Likely cause, and fixed alongside: message items were emitted as `{role, content}` with no
  `type`. OpenAI INFERS `type: "message"`, so this was invisible against the reference API — but
  the Responses shape is now reimplemented by gateways whose strict untagged-union deserializer
  matches on the discriminator and rejects the whole request without it. Stating `type` explicitly
  is spec-valid everywhere and costs one field. GENERAL RULE: when a wire format has an optional
  discriminator, send it — "the reference implementation infers it" is not portability.

## 2026-08-07 — Make the rejection name the ITEM, not the bytes
- The byte-window diagnostic paid for itself on its first run: the 400 came back with
  `…-Webapp-Engine\README.md","fullPath":"E:\…`, which identified the region as a file-tool
  result inside a `function_call_output`. Quoting what we SENT at the offset the server named
  turned an opaque 400 into a located one in a single round trip.
- A window still isn't the answer, though — it shows bytes, not the item. `describe_rejected_item`
  now walks the serialized `input` array (string-aware: braces and quotes inside a tool result's
  JSON payload are DATA, and this app's payloads are full of escaped Windows backslashes), finds
  the element spanning the offset, and reports `item N of M`, its `type`/`role`, and each field's
  NAME and SIZE. Values are never echoed: a tool result can carry whole file contents.
- Boundary detail that matters: serde's `#[serde(untagged)]` buffers the whole value before giving
  up, so the reported offset usually sits at the END of the offending item. The lookup is
  `start <= column <= end`, and there is a test pinning it at an exact boundary.
- TEST-FIXTURE TRAP, again: writing the Rust test through a `<<'EOF'` heredoc collapsed `\` to
  `\`, so the fixture's JSON was invalid and the test failed against CORRECT code. I nearly
  "fixed" a working walker. Two rules: build escaped fixtures with `json!(...).to_string()` rather
  than typing them, and when a test fails, check the fixture reached disk intact before touching
  the implementation. This shell mangles backslashes in heredocs — use the Write/Edit tools for
  any content containing them.

## 2026-08-07 — `app.exit()` tears down out of order; close the windows instead
- After adding the "quit when no visible window remains" handler, shutdown started logging
  `Failed to unregister class Chrome_WidgetWin_0. Error = 1412` (ERROR_CLASS_HAS_WINDOWS).
  Chromium unregisters its window class on the way out and cannot while HWNDs of that class are
  still alive — which is exactly what `app.exit(0)` guarantees when other webviews still exist.
- The log line is cosmetic; the ordering it reveals is not. `exit` also SKIPS every window's close
  handler, and `main`'s is where the IDE persists explorer state, open tabs and the current thread
  (`useWindowClose`). So the abrupt exit silently dropped that save.
- Fix: close the remaining windows and let Tauri exit on its own once the last one is gone. Their
  handlers run, the webviews destroy in order, and the class unregisters cleanly. Re-entry is safe
  because the handler fires again per close, finds nothing visible and nothing left to close.
- RULE: prefer ending an app by closing its windows over calling exit. `exit` is a process-level
  hammer that skips application-level teardown, and the first symptom is usually a confusing
  platform error at shutdown rather than the lost work underneath it.

## 2026-08-07 — A card sized by one arbitrary string, again
- The cost card rendered "13 requests not priced" and the model name as the two halves of a
  `space-between` flex row with NO gap. With a user-added provider the "model name" is
  `<uuid>:agnes-2.5-flash`, so the two spans touched — reading as one corrupted string — and the
  raw UUID stretched the card across the window.
- Three separate faults, all mine, all the same root: **content was allowed to size the
  container.** `.agw-ctx-card` had `min-width` and no `max-width`; `.agw-ctx-line` had no `gap`
  and no truncation. Identical to the 2026-08-02 project-switcher bug — a popover is its own
  object and sizes to its OWN budget, never to whichever value lands in it. Check for a max-width
  and a gap on ANY row that renders a value the app does not control.
- Never print a provider ROW id at a person. It is a readable slug for built-ins and a generated
  UUID for user-added providers, so the raw `providerId:modelKey` is meaningless half the time.
  `modelLabel()` strips it (first colon only — a model key can contain one).
- `$0` beside "13 requests not counted" contradicts itself: one says the work was free, the other
  says it was never measured. When nothing could be priced there is NO figure — render a dash. And
  a limitation must name its recovery: the note now says which model has no price and where to set
  it, instead of stating a fact the user cannot act on.

## 2026-08-07 — Request counts: the per-message `model` made an approximation exact
- `usage_stats.rs` carried the comment "per-message attribution isn't stored, so this is a
  thread-granularity approximation" — true when written, FALSE since `ConversationMessage.model`
  landed with the cost work. The same field that fixed mid-chat model-switch pricing also turns
  the profile's model stats from an estimate into a count. When you add a field, grep for the
  comments that apologise for not having it.
- "Requests" counts every message carrying `usage`, which deliberately includes the calls made to
  process tool RESULTS and the compaction summariser — each is a real call against a rate limit
  and a bill. That is why the number is far larger than the turn count, and why it is the number
  worth showing.
- Derived from the JSONL on demand rather than written to a new DB table. The transcript is
  already the durable record; a second copy is the drift this project has been bitten by twice
  (background-process dock, todo panel). Persistence was the ask; a table was not.
- Counts are rendered with `toLocaleString`, NOT the `1.2K` token formatter. A request count is
  reconcilable against a provider dashboard and rounding 1,247 to "1.2K" destroys that. Tokens are
  estimates at that scale; requests are not.
- Two shapes reused from earlier today: strip the provider ROW id before showing a model (it is a
  UUID for user-added providers), and give any flex cell holding arbitrary user text
  `min-width: 0` so it truncates instead of pushing the number out of the row.

## 2026-08-07 — One tally, two surfaces
- Request counts now appear in the Profile page (all chats) and the Project panel (one workspace).
  Both go through a shared `RequestTally` in `usage_stats.rs` rather than each counting for itself.
  The two numbers sit next to each other in the product, so a second implementation would drift the
  first time either was touched and the disagreement would be the user's problem to notice.
- `project_stats.rs` already imported `DayUsage`/`ModelUsage`/`ToolUsage` from `usage_stats.rs`, so
  the seam existed — worth checking for an established sharing pattern before inventing one.
- Provider-name resolution is duplicated in both views on purpose: it needs the frontend settings
  store (Rust only knows the row id), and the fallback copy differs per surface. What must not
  duplicate is the COUNTING.

## 2026-08-07 — A marker detected by substring is a marker any document can forge
- `<aurora_image …>` was detected everywhere with `contains("<aurora_image ")`, then "header = up to
  the next `>`, body = up to the next `</aurora_image>`". `.knowledge/knowledge.md` DOCUMENTS that
  pipeline, so `file_read` on it produced an image part whose payload was 2,847 chars of markdown →
  `HTTP 400 … 'input[15].content[0].image_url' … invalid base64-encoded value` (codex:gpt-5.5,
  thread `8ef99c78`). Eight files in this repo still carry both tokens — the agent could not read
  its own screenshot pipeline without killing the turn.
- Detection now lives in `src-tauri/src/api/aurora_image.rs` (mirrored by `findImageMarker` in
  `src/apps/agent/lib/render/image-markers.ts`) and requires structure: attributes-only header, an
  `image/*` `media_type`, a close tag, and a body that is valid base64 or blank (lean). Invalid
  candidates are SKIPPED, not fatal, so a real marker after quoted prose still ships. Consumers may
  now treat the body as valid base64 without rechecking — that guarantee is the point of the module.
- Same substring test had also short-circuited `truncate_tool_content` into the leanify branch, so
  any quoting result skipped the size cap; and the UI labelled a plain file read "Captured
  screenshot". One loose predicate, three surfaces — self-describing formats need a validating
  parser, not a `contains`.

## 2026-08-07 — Stopping a turn mid-tool-call corrupted the thread permanently
- Repro: model emits tool calls → user hits Stop before results → next prompt → provider 400,
  forever. `run_turn` appends the assistant message (with `tool_use`) at `conversation.rs:516`,
  cancellation returned `Err(Cancelled)` before any `tool_result`, and `agent_v2.rs` persists the
  session on the error path too. Every later turn rebuilt the same malformed request. Anthropic:
  "tool_use ids were found without tool_result blocks"; OpenAI: "must be followed by tool messages".
- Fixed in two layers, and both are needed. SOURCE: cancel-before-dispatch, cancel-mid-batch and
  the undispatched tail each get real `tool_result` blocks (`STOPPED_BEFORE_RUN` / `STOPPED_MID_RUN`),
  and `execute_tool_calls` now returns `ToolBatchOutcome { message, cancelled }` instead of
  early-returning — finished work in the batch is kept. NET: `tool_pairing::repair_tool_pairing`
  runs on the final message view (after compaction AND trim, so it catches cuts they introduce) and
  on the compaction request. That one repairs threads ALREADY broken on disk — without it the
  user's existing threads stay dead.
- Pairing must be checked by INDEX, not by id-set membership: a `tool_result` that precedes its
  `tool_use` passes a set check and still 400s.
- Same turn: a `length` stop that lands while the model is emitting tool calls no longer executes
  them. Arguments that parse may be silently incomplete and the calls after the cut are missing
  entirely, so the batch is not the batch the model asked for. It now fails with `TRUNCATED_CALL`,
  emits the truncation notice (which previously fired only on the no-tool-call path), and ends the
  turn — retrying just re-truncates.

## 2026-08-08 — "The chip is broken" was really "the path isn't streamed yet"

Symptom: Write File cards showed no file chip while streaming; blamed on the card. The whole
event chain (adapter deltas → forwarder → agent_event → upsertToolCall → streamed-arg scanner)
was correct. Session JSONL showed the model emits `content` before `path` in most `file_write`
calls despite schema descriptions demanding path-first — the filename literally isn't in the
buffer until the end. Lesson: before debugging a "renderer ignores data" report, check the
persisted args/results to confirm the data existed at that moment; emission ORDER inside one
tool call is part of the contract and models (especially proxied ones) do not reliably honor
prose ordering instructions.

## 2026-08-08 — 92k of phantom context: reasoning signatures counted as prompt text

Symptom: `/compact` reported 431k → 272k on a chat the provider then measured at 180k, and the
ring "dropped" from 272k to 180k after one message. Read as three separate bugs (model switch,
compaction math, ring math); it was one.

`estimate_message_tokens` ran tiktoken over `Thinking.signature`. On the Responses API that field
holds a JSON-wrapped `encrypted_content` blob — in the reported session, **190,392 chars in the
post-compaction tail alone, 22.7% of the entire transcript**. Those blobs are replayed only by
Responses/Codex; every other provider strips reasoning entirely (`reasoning_field_for` → `None`).
The chat had run GPT-5.x and then switched to an OpenAI-compat model, so 100% of it was phantom.
Measured on the real JSONL: messages-only estimate 267,725 → 133,923 after the fix, and
133,923 + system + tool schemas ≈ the provider's 180,235.

Two lessons:
1. Anything stored in the transcript but *conditionally* sent must be priced by the provider view,
   not by its on-disk size. Persisted ≠ sent.
2. The projection was ALSO missing tool schemas, an under-count of the opposite sign. Two errors
   pointing opposite ways masked each other at some sizes and compounded at others — which is why
   the number looked "roughly plausible" for months. When an estimate is wrong, check both signs.

## 2026-08-08 — OpenClaude custom-anthropic profile drops 1M context overrides
- User profile file `.openclaude-profile.json` had CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS=1M, but the active plural provider profile (`custom-anthropic` in ~/.openclaude.json) only applies ANTHROPIC_BASE_URL/MODEL/auth. On apply it clears managed env keys including CONTEXT_WINDOWS, so runtime falls back to OPENAI_FALLBACK_CONTEXT_WINDOW=128000. That 128k looks like "context" but the profile description also says "128K max output" — easy to confuse. Fix: put `modelLimits` for the model in settings.json (survives profile apply); optionally also set CONTEXT_WINDOWS in settings.env when no plural profile wipe occurs.

## 2026-08-08 (later) — Don't re-derive what the provider already measured

Fixing the reasoning-signature phantom made Aurora's from-scratch estimator accurate. It was still
the wrong architecture. `openclaude`'s `tokenCountWithEstimation` anchors on the last measured API
usage and estimates only the delta since — so unmodelled quirks cost you the last few messages, not
the whole conversation. Aurora now does the same. Two corollaries that were separately wrong here:

- Context size must include `cache_creation_input_tokens`. It is disjoint from both `input_tokens`
  and `cache_read_input_tokens`; omitting it understates a cache-writing turn by most of its prompt.
- It must include `output_tokens`. "Cost vs context" is the wrong axis — the completion is re-sent
  as input next request, so excluding it makes the window look emptier than it is, precisely at the
  compaction boundary where that matters.

Separately: any expensive recovery action that does NOT clear the condition that triggered it needs
a failure ceiling. Compaction retried every turn on failure, each attempt re-sending the whole
history. `openclaude` carries the same breaker (`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES`) with a note
that 1,279 sessions hit 50+ consecutive failures, wasting ~250K API calls/day.

## 2026-08-08 (3rd) — Reasoning must never reach the summarizer

Adding a per-conversation compaction model exposed it: the summarization request sets
`thinking_enabled: false`, but `message_blocks_to_anthropic_content` emits `thinking` blocks
unconditionally, and a `signature` is issued by one provider and meaningless to another. So
summarizing a chat that carried reasoning history on a DIFFERENT provider would 400 on every
attempt — and with the new circuit breaker, silently pause auto-compaction after three.

`strip_reasoning` now runs on the head before `repair_tool_pairing` (strip first: it can drop whole
messages, and the repair must see the shape actually sent). Justified three ways even same-provider:
reasoning is not the record of what happened, it was 22.7% of one real transcript, and it does not
travel. Messages emptied by the strip are dropped — providers reject empty content; nothing carrying
a tool call can be emptied, so pairing is safe.

Related wording fix: the compaction prompt said "you are about to lose YOUR memory" and the resume
block said "the note YOU wrote to yourself". Both are false when a different model summarizes.
Reframed to "you are writing the memory of this conversation" / "the record of that work" — same
stakes, true either way.

## 2026-08-08 (4th) — "The provider returned an empty reply" was Aurora dropping the reply

Reported 5x in one day on `claude-opus-5` via an Anthropic-type provider. Proof from the session
JSONL: two threads with an assistant message of `blocks: []` and `output_tokens` of 1 and 4. The
provider produced content and billed for it; Aurora persisted nothing.

Cause: `anthropic.rs` `content_block_start` matched only `text` / `thinking` / `tool_use`, with
`_ => None`. **`redacted_thinking`** — a normal, intermittent block Anthropic returns when its
safety systems encrypt a reasoning passage — fell through and was discarded. Because the block was
never inserted, every `content_block_delta` and `content_block_stop` at that index also bailed
(`blocks.get(&index)` misses), so an entire response could vanish. The message shown to the user
was the runtime's honest backstop describing what it saw — an empty message — which is why it read
like a model failure.

Three fixes, each independently worth it:
1. `redacted_thinking` is mapped, and round-trips via `encode_redacted_thinking` in the signature
   slot (same trick as `openai-responses` encrypted items). It MUST go back as
   `{"type":"redacted_thinking","data":…}`; re-sending it as a `thinking` block with our JSON
   wrapper in `signature` is a signature Anthropic cannot verify → 400 on the whole request.
2. Unknown block types now `eprintln!` the type name instead of vanishing. This bug had to be
   reconstructed from disk because it was invisible from inside the app.
3. A blockless assistant message is no longer appended to the session, and the turn re-issues the
   request **once**. Persisting it was a second bug: it serializes to Anthropic as an assistant
   turn with empty content, which the API rejects — one dropped response left a landmine that
   would break every later turn in that thread.

General rule: a `_ => None` arm in a wire-protocol decoder is a silent data-loss bug waiting to
happen. Providers add block types; the decoder must say what it didn't understand.

## 2026-08-08 (5th) — Aurora's Anthropic adapter was written for pre-4.7 Claude

`build_anthropic_body` emitted `{"type":"enabled","budget_tokens":N}` and always inserted
`temperature`. Both are **hard 400s on Claude 4.7 and later** (Opus 4.7/4.8/5, Sonnet 5, Fable 5) —
`budget_tokens` was removed and so were `temperature`/`top_p`/`top_k`. Every request to a current
Claude model through an Anthropic-typed provider was malformed.

`anthropic_surface_for(model)` (in `provider_kernel_adapter.rs`) now picks the shape per model:
adaptive + `output_config.effort` on 4.6+, the legacy budget form otherwise. Three things worth
keeping straight:
- **`thinking.display` defaults to `"omitted"` on 4.7+** — thinking blocks still stream, with empty
  text. Aurora renders those blocks, so without `display: "summarized"` the UI shows an empty
  reasoning card and a long pause. On 4.6 the default was `"summarized"`.
- **Omitting `thinking` means different things per generation**: Opus 5 / Sonnet 5 / Fable 5 reason
  by default; Opus 4.8 / 4.7 do not.
- **`{"type":"disabled"}` is not universal**: Fable 5 rejects it at any effort (omit instead), and
  Opus 5 accepts it only at effort ≤ `high`.

**Unknown models deliberately get the LEGACY shape.** A provider typed "anthropic" is usually a
gateway speaking the Messages API without being Anthropic, and `budget_tokens` is what those
implement. Guessing adaptive would break every gateway; guessing legacy costs one 400 on an
unrecognized new Claude.

Related UI lesson: the API-type picker rewrote the wire body while the form stayed identical, so a
reasoning setting could be configured, saved, and never sent. The picker now states the contract
(which field carries reasoning, the depth control, whether sampling survives).

## 2026-08-08 — A newline is not speech: whitespace text blocks split every tool run
- SYMPTOM: a model reading 5 files rendered 5 separate single-call rows, never reaching
  `TOOL_GROUP_MIN`, so grouping looked broken and lowering the threshold was a no-op.
- CAUSE: models emit a bare `"\n"` / `"\n\n"` text block BETWEEN batched tool calls in ONE
  assistant message (verified in session JSONL — 5 `file_read` calls, 4 newline-only blocks).
  Each became a `content` event and `buildRows` flushed the run on ANY non-tool event. The run
  length was therefore always 1. Fix: skip a whitespace-only content event WITHOUT flushing,
  same treatment as `isSilentToolCall`.
- The prior handoff diagnosed this as "coalescing doesn't work across iterations" and planned a
  fix there. Wrong layer: the model WAS batching inside one message. Reading the raw session
  JSONL block sequence settled in one command what screenshot-reading had mis-framed twice —
  when transcript rendering looks wrong, dump the message's block kinds before theorising.
- Corollary: `Read File [a][b][c][d] · Read 4 files` is ONE call with `paths[]` (`parsed.multiFile`),
  not several calls merged. There is no cross-call coalescing in the agent window; a run of
  separate calls renders as N cards inside one `ToolGroup`.

## 2026-08-08 — Canvas font detection lies in a sandboxed renderer; GDI names are not CSS names
- `canvas.measureText` reported INSTALLED system fonts as missing on first read — seen live as
  `Segoe UI → Segoe UI Variable Text`, two stock Windows faces, one "appearing" seconds later with
  nothing loading in between. Chromium's renderer is sandboxed and resolves families through the
  browser process (`DWriteFontProxy`); a first reference can return before that lands, so the canvas
  measures the fallback. Fix: measure through real DOM layout (`getBoundingClientRect`, not
  `offsetWidth` — sub-pixel differences matter) and reference each family once to WARM the lookup
  before the measurement that counts.
- `document.fonts.check()` is useless for "is this family present": Chromium returns `true` for
  names it has never heard of, because the fallback satisfies the query. It answers "can I paint
  text". Keep it only as a "did this webfont finish loading" signal.
- `(New-Object System.Drawing.Text.InstalledFontCollection).Families.Name` lists **GDI** names, which
  split one family into per-weight families ("Gotham Book" / "Gotham Black"). Chromium matches
  **DirectWrite** names, where both are family "Gotham" + a weight. So a font can be genuinely
  installed, visible in that list, and still unmatchable from CSS under the name shown.

## Console windows flashing on Windows — every spawn needs CREATE_NO_WINDOW (2026-08-10)

Reported as "running diagnostics opens 10–15 terminal windows in 2 seconds", plus a single flash
when the repo map builds on the first message. Both were spawns missing
`creation_flags(CREATE_NO_WINDOW)` — the one thing every OTHER spawn in this codebase already had.

- `tools/shell_editor_todo/read_lints.rs` → `run_checker`, the `CheckCommand::Program` arm. Its
  sibling `CheckCommand::Shell` arm was always fine because it routes through `execute_command`,
  which sets the flag. What made it a *burst*: `select_checks` falls to `vanilla_javascript_checks`
  when the workspace has **no root `tsconfig.json`**, and that emits ONE `node --check` spec per
  `.js` file, up to 100. Aurora itself has a root tsconfig and never hit it; the repo being
  diagnosed did not.
- `code_index/walk.rs` → `churn()`, the `git log` behind the repo map. Builds on the first message
  of a session, so the window popped exactly as the user hit send.

Warning for future spawns: `tokio::process::Command` exposes `creation_flags` directly on Windows,
but `std::process::Command` needs `use std::os::windows::process::CommandExt`. Legitimately
un-flagged sites, do not "fix" them: `reveal_in_explorer` and `open_in_terminal` (the window IS the
feature), and the `kill`/`uname`/`sw_vers` non-Windows branches.

To re-audit, list every `Command::new` and check the following ~80 lines for `creation_flags`.

## 2026-08-10 — The agent window had no memory of its own workspace

Reported as "why does it open the IDE's workspace, I haven't opened the IDE in a week".

`lib.rs` (agent-only launch) resolved the project as `--ws` → `workspace_state.get_most_recent()`.
That table is written by the **IDE**, so an icon launch always reopened wherever the IDE was last
pointed. `useAgentChatStore.setProject` rebound the runtime and refreshed the lists but persisted
nothing, so the agent window could never influence the answer. Stop opening the IDE and the row
freezes: the window is stranded on an abandoned project with no fix that survives a restart.

Fix: `agent_last_workspace` in `app_settings`, written by the store as the project is used, and
inserted into the resolution order ahead of `workspace_state` (which stays as the first-run
fallback). Both launch paths read it — Rust `lib.rs` and JS `adapters/window.ts`.

Generalise: **two products share one database.** Before reading a table for agent-window state, ask
which surface WRITES it. `workspace_state`, `editor_state` and `explorer_state` are IDE-owned;
anything the agent window needs to remember belongs in its own `app_settings` key, the way
`agent_window_bounds` already did. An empty string there means "no project", not a path — the
launcher filters it rather than treating it as one.

## 2026-08-12 — `cargo test` writes into the PRODUCTION log, so aurora.log lies

Reading `%LOCALAPPDATA%\AuroraIDE\logs\aurora.log` to find the most common error: 104 of 147 ERROR
lines were **unit-test fixtures**, not failures. `boom`, `no key`, `slow down`, `bad` — each exactly
13 times, one per test run. Sorting by frequency puts "upstream HTTP 503" on top; it is a string
from `provider_kernel_adapter.rs`'s `map_status_error` test.

Two causes, both still open: `logging.rs`'s own `write_entry_appends_to_log_file` asserts against
the real `log_file()`, and the api tests call `log_error` with fixture payloads on the way through.
Anyone diagnosing from this file must first strip fixtures or the ranking is fiction.

Also live in that file, and worth knowing before you count anything:
- **One failure writes four lines** — `api.http` → `agent_runtime.turn` → `ui.console` ×2 (the agent
  window and `AgentRuntimeClient` both `console.error` the same rejection). Counting lines
  quadruple-counts incidents.
- **Cancelling a turn is logged as an ERROR.** Rust gets this right (`conversation.rs` skips
  `ApiError::Cancelled`), but `agent-runtime-client.ts` `console.error`s every rejection including
  "request was cancelled", and the console mirror forwards it. Pressing Stop looks like a crash.
