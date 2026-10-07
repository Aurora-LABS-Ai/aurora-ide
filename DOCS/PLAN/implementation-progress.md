# Aurora Chat — implementation progress

Working checklist for the build described in [`chat-mode-design.md`](./chat-mode-design.md).
**That file is the decisions. This file is the state.**

**Rule:** a step is ticked only when it is written, compiling, and covered by a
test that would fail without it. A phase is marked done only when every step
under it is ticked and the full suite is green.

Last updated: 2026-09-04.

---

## Start here (new session)

**What this is.** Aurora is gaining a second product beside the one that writes
software. **Aurora Build** works on a project. **Aurora Chat** is a
conversation: no files, no shell, no workspace. It researches online, remembers
things across conversations, and presents on a canvas. A switcher at the top of
the left rail moves between them.

**Read `chat-mode-design.md` first.** Five rounds of decisions are settled in
it, each with the reasoning. **Do not re-open them.** Where it says *Claude's
call, delegated*, Alvan explicitly handed that one over; where it says
*Overruled by Alvan*, the first answer was wrong and the second is the decision.

**Where to pick up:** Phases 0–4 are done. Phase 3 kept one piece that was
deliberately not built (see its section). **Phase 5 is what remains** — its
model shortlist and image-provider settings are in; the picture generator
itself is not, and part of it needs a key from Alvan.

**But not next.** [`turn-shape-and-todo.md`](./turn-shape-and-todo.md) is the
work in front of this one: `todo` costs a full round trip every time it closes a
task, and six separate mechanisms exist to manage that one fact. It is core
correctness and it is measurably costing model performance, so it goes first.
This plan resumes after it.

Read **"Alongside the plan"** near the bottom before you start. Two things
happened outside the phases that change how you should work: some of this was
built by Aurora itself through the CLI delegate, and a defect in how every
request is assembled was found by reading a session's reasoning rather than by
any test.

### Before you write anything

1. **The work is uncommitted.** Everything below is in the working tree, not in
   a commit. `git status` will show a large diff that includes changes from
   before this work as well. Do not "clean up" anything you did not write.
2. **Run tests to a FILE, never through `grep | head`.** A cold `cargo test`
   rebuild takes minutes and a `head` closes the pipe, so the terminal shows
   nothing and it looks hung. It cost six minutes once.
   ```bash
   cd src-tauri && timeout 400 cargo test --lib > /tmp/r.log 2>&1; tail -5 /tmp/r.log
   npx tsc --noEmit -p tsconfig.app.json
   npx vitest run > /tmp/v.log 2>&1; tail -5 /tmp/v.log
   ```
3. **Read `.knowledge/lesson.md` before any UI work.** Two entries matter most:
   "probe" in Alvan's vocabulary means a **self-contained HTML design file** in
   `C:\Users\Alvan\Documents\`, not the qg-probe MCP; and animation work has a
   list of six specific failures that all ship broken the first time.
   **Alvan's machine has Windows animations ON** — that entry was corrected on
   2026-09-04 after being wrong and unverified for a year.
4. **Probe an endpoint before writing an adapter for it.** Every external claim
   in this document was measured, not read from documentation.
5. **Read the model's own reasoning when something feels off.** The session
   JSONL under `%LOCALAPPDATA%\AuroraIDE\sessions\` holds the thinking blocks,
   and the worst defect found this week was visible only there — no test could
   fail on it, nothing was slow, and the model handled it correctly every time
   while wasting the opening of every turn. Grep the thinking for the model
   talking about Aurora instead of about the work.
6. **Check a claim about the tools with something that is not the tools.** Two
   wrong conclusions this week came from measuring the harness with the
   harness. When two measurements disagree, suspect the instrument, and reach
   for the one that cannot lie — count bytes, not grep lines.

### How to work with Alvan

- **Plain language.** No jargon, no internal names as explanations. He has said
  so more than once.
- **Do not stop to ask** unless a wrong guess would be expensive. He asked
  explicitly for fewer questions and more finished work.
- **Stop before inventing a NEW visual component.** Following an existing
  pattern is fine and expected; a new animation or a surface with no precedent
  is his to design. He supplied the image placeholder animation himself.

---

## Status at a glance

| Phase | What it delivers | State |
|---|---|---|
| **0** | Foundation — the mode, the store, the tool gate | ✅ **Done** |
| **1** | The window — switcher, rail, empty state, prompt wiring | ✅ **Done** |
| **2** | Memory — `chats.db`, `recall`, `remember`, the Memory panel | ✅ **Done** |
| **3** | Research — engine ladder, deep-research toggle | 🟨 Deep research done; no 2nd engine exists |
| **4** | Presentation — Canvas tab, SDK components, `report`, export | ✅ **Done** |
| **5** | Models and images — shortlist UI, image providers, `generate_image` | 🟨 Partly (placeholder built) |

**Green as of the last run:** 2,237 Rust tests, 1,056 frontend tests,
`tsc --noEmit` clean, ESLint clean on every touched file.

**Where the work stands right now.** Phase 4 is finished. Phase 5 has its model
shortlist and its image-provider settings; what is left there is the picture
generator itself and the two pieces named at the end of that section. Two
things happened alongside the plan and are recorded below it: the file-boundary
bug was closed **by Aurora**, dispatched through the CLI delegate, and a real
defect in how Aurora builds every request was found by reading a session's
reasoning.

### The first live turn — 2026-09-04

**The plumbing held.** One chat message went end to end. The conversation landed
at `%LOCALAPPDATA%\AuroraIDE\Chats\<id>\` with `conversation.jsonl`, `meta.json`
and `assets/`; `chats.db` appeared beside it; the title was generated; the rail
grouped it under Today.

**Three things were wrong, and all three are fixed.** None had a test, because
each sat where two correct pieces meet.

1. **Chat mode had never used its own system prompt.** The model answered "ready
   to help with your coding work in `E:\…`". `composeAgentSystemPrompt` decided
   "did the caller override the default?" by comparing `basePrompt?.trim()`
   against the untrimmed `BASE_AGENT_SYSTEM_PROMPT` — and that constant ends in a
   newline, so `AgentService`'s untouched default read as a deliberate override
   on every turn. Both sides trimmed now; four tests on the COMPOSED prompt.
2. **A chat turn was handed the window's project.** `enterSurface` keeps
   `projectRoot` so Build resumes where you left it; the send path then built
   `<workspace_root>` from it and told the model it was working inside that
   directory. New `effectiveProjectRoot(mode, root)` beside
   `effectiveExecutionMode`, applied at both send sites and in `EmptyState`.
3. **The Memory page painted a blue ring on click.** `--agw-ring` is the
   keyboard focus ring and belongs only in a `:focus-visible` box-shadow; the
   window's convention for a text field is a neutral `--agw-border-strong`
   border, stated at `.agw-set-input:focus`. Both memory fields follow it now.

**Also added:** Aurora Chat's four starter rows
(`services/threads/chat-starter-prompts.ts`) — Phase 1 dropped starters because
every Build one is built from a workspace, which left the composer alone with
empty space under it.

**Still never run:** `recall` and `remember` have not been called by a model, the
Memory page has not rendered a real fact, and the five-fact injection has not
appeared in a real request. **Next live check:** ask a chat to remember
something, then open Memory and confirm the fact is there and marked as injected.

**Still true:** the corrected chat turn itself has not been watched. The fixes
are on disk and green, not yet seen on screen.

---

## ✅ Phase 0 — Foundation

The mode exists, enforces its own tool roster, and writes to its own store.
Nothing is visible yet: there is no way to reach chat mode from the UI. This
phase is what Phase 1 mounts on.

### Rust — modified

| File | What changed |
|---|---|
| `src-tauri/src/agent_runtime/ipc.rs` | `AgentExecutionMode::Chat` variant; `is_chat()` and `has_workspace()` so call sites read as what they ask; `AgentChatRequest::scoped_to_mode()`, which strips a workspace from a chat turn once at the boundary instead of guarding eleven read sites |
| `src-tauri/src/paths.rs` | `chats_dir()` → `<root>/Chats/`, with the folder layout documented |
| `src-tauri/src/agent_runtime/session_store.rs` | `StoreLayout::{Flat, Folder}`; `new_folder()`, `layout()`, `thread_dir()`, `assets_dir()`, `ensure_dir_for()`; layout-aware `session_path` / `meta_path` / `rich_path` / `artifacts_path` / `tool_results_dir`; folder branch in `list_summaries_filtered`; `push_summary()` extracted so both scans share retention + project filtering; folder branch in `delete()`; `tool_results_dir_in()` now takes the layout |
| `src-tauri/src/agent_runtime/conversation/mod.rs` | `store_layout` field; `with_store(&SessionStore)` builder that sets directory and layout together; layout threaded into both spill paths |
| `src-tauri/src/agent_runtime/conversation/tool_exec.rs` | Layout passed when deriving the spill directory for `ToolContext` |
| `src-tauri/src/commands/agent_v2/registry.rs` | `chat_store` field; `with_chat_dir()`; `chat_store()`; `store_for(mode)`; `session_path_in()`; `load_or_create_session_in()` |
| `src-tauri/src/commands/agent_v2/tool_policy.rs` | `CHAT_MODE_TOOLS` + `is_chat_mode_tool()`; chat answered **first** in `is_tool_available_this_turn`; MCP deferral forced on and workspace suppressed in `build_per_turn_tool_registry` |
| `src-tauri/src/commands/agent_v2/turn_driver.rs` | Every store path routed by `request.execution_mode`; `scoped_to_mode()` applied at both entry points |
| `src-tauri/src/lib.rs` | `.with_chat_dir(paths::chats_dir())` on the production registry; layout passed to `tool_results_dir_in` |

### Frontend — modified

| File | What changed |
|---|---|
| `src/apps/agent/services/runtime/agent-execution-mode.ts` | `"chat"` on the type; `CHAT_MODE_TOOLS` + `isChatModeTool` mirroring Rust; `CHAT_MODE_SYSTEM_PROMPT` (the whole prompt, not a section); chat answered first in both tool filters; `normalizeAgentExecutionMode` handles it; kept **out** of `cycleAgentExecutionMode`; runtime-context block names Chat and points machine work at Build |
| `src/apps/agent/services/runtime/agent-runtime-client.ts` | Local `"agent" \| "plan"` union replaced with the shared type |
| `src/apps/agent/store/conversation/useAgentChatStore.ts` | `liveModes` and `beginTurn` widened to the shared type |
| `src/kernel/types/database.ts` | `agentExecutionMode` accepts `'chat'` |

### Tests added

- `src-tauri/src/agent_runtime/session_store.rs` — 5: folder paths, flat has no assets, the two layouts are separate stores, listing ignores loose files and half-made directories, delete removes the folder and its assets, delete of a missing conversation is not an error.
- `src-tauri/src/commands/agent_v2/tests.rs` — 7: the sweep that refuses every native tool chat mode does not name, files and shell by name, its own seven offered, MCP by prefix, exact-match (no prefix admission), project switches cannot widen it, and the project modes left alone.
- `src/apps/agent/services/runtime/agent-execution-mode.test.ts` — 9 mirroring the Rust set.

### Bugs found by those tests

- The folder layout needed its conversation directory created before any
  store-side write. The flat layout never did, because the store root already
  existed. Fixed with `ensure_dir_for()` at all four write sites.
- A sanity floor written as `refused > 30` was a guess. Replaced with an
  equation against the registry, so giving chat mode a second native tool fails
  loudly rather than sliding under a threshold nobody revisits.

---

## ✅ Phase 1 — The window

At the end of this phase you can open a chat, pick a model, and talk to it with
no tools at all. That is a usable product on its own.

**No design probe was made.** Every piece here reuses a pattern that already
exists and was already approved — the project switcher's menu chrome class for
class, the rail itself, agent mode's empty state — so there was nothing to
choose, only to follow. The exception, if one is wanted, is the day-group header
style, which is new.

### Done

| File | What |
|---|---|
| `src/apps/agent/components/shell/SurfaceSwitcher.tsx` | **Created.** The product switcher. Trigger pill at the top of the rail; menu portals into `.agw-root` and reuses `.agw-projmenu` class for class, minus the filter field (two rows, not dozens — same reasoning `ComposerPlusMenu` records for its four) |
| `src/apps/agent/lib/thread/chat-day-groups.ts` | **Created.** Today / Yesterday / Previous 7 days / Previous 30 days / Older / Undated, bucketed against **local midnight** rather than a rolling 24 hours |
| `src/apps/agent/lib/thread/chat-day-groups.test.ts` | **Created.** 10 tests |
| `src/apps/agent/theme/agent-window/42-surface-switcher.css` | **Created.** Trigger, two-line menu rows, day-group headers |
| `src/kernel/store/useSettingsStore.ts` | `auroraSurface` + `setAuroraSurface`, persisted and loaded. `setAgentExecutionMode("chat")` redirects to the surface rather than corrupting the Build mode |
| `src/apps/agent/services/runtime/agent-execution-mode.ts` | `AuroraSurface`, `AURORA_SURFACES`, `normalizeAuroraSurface`, `effectiveExecutionMode` |
| `src/apps/agent/services/runtime/agent-prompt.ts` | Chat mode swaps the base prompt and drops the design doctrine, the skills roster and the browser pointer. A caller's own custom prompt still wins |
| `src/apps/agent/hooks/conversation/useAgentWindowSend.ts` | Both mode-resolution sites go through `effectiveExecutionMode` |
| `src/apps/agent/components/shell/LeftRail.tsx` | Mounts the switcher; hides Projects and the add-project button in chat mode; renders the date-grouped list instead |
| `src/apps/agent/components/conversation/EmptyState.tsx` | Drops the project row and the workspace starters in chat mode; placeholder becomes "Ask anything" |
| `src/kernel/types/database.ts` | `auroraSurface` on the settings row |
| `src/apps/agent/lib/thread/surface-resume.ts` | **Created.** Remembers where each side was left; the two-hour rule |
| `src/apps/agent/lib/thread/surface-resume.test.ts` | **Created.** 14 tests |
| `src-tauri/src/commands/threads.rs` | `store_for_thread` (looked up from disk) and `store_for_surface`; `thread_create` and `thread_list_summaries` take a `surface`; 4 tests |
| `src/apps/agent/services/threads/thread-service.ts` | `createThread` and `listThreads` pass the surface |
| `src/apps/agent/store/conversation/useAgentChatStore.ts` | `enterSurface`; lists and creates against the current surface; a chat is created with no workspace |
| `src/apps/agent/components/composer/ModelSelector.tsx` | Agent/Plan toggle absent in chat mode |

- [x] Product switcher at the top of the left rail
- [x] Left rail in chat mode: chats only, no Projects, no project switcher, no
      add-project button
- [x] Rail grouped by date (the existing search box already filters it)
- [x] Chat empty state
- [x] `CHAT_MODE_SYSTEM_PROMPT` wired in as the base prompt for chat turns
- [x] New chats are created in `Chats/`, with no workspace
- [x] The rail lists the right store's conversations on each side
- [x] Switching reloads the rail and resumes where that side was left, subject
      to the **two-hour rule**
- [x] Composer hides the Agent/Plan toggle in chat mode

**Design decisions worth knowing:**

- **The surface is stored separately from `agentExecutionMode`.** One combined
  field was tried first and is wrong twice over: a trip through Chat would
  forget the Build mode you left, and the composer's Agent↔Plan cycle would
  silently move the window to another product with another store.
- **Pinned chats are excluded from the day groups**, because they already have
  their own section — listing one twice makes the rail look busier than it is.
- **Controls that cannot act in chat mode are absent, not disabled.** A disabled
  add-project button is a question the user has to answer.

**One more decision worth knowing:** Rust looks up **which store owns a
conversation from disk**, by id, rather than taking a parameter on all fifteen
thread commands. A parameter is something every caller has to remember, and the
one that forgets does not fail loudly — it reads, renames, or deletes in the
wrong store. Only creating and listing are told explicitly, because neither has
an existing conversation to look up.

### Also done (finished after the list above was first written)

- [x] `assets/` created with the conversation, in `ensure_thread`. Eager, not on
      first write: the writer that would forget is the image generator, which
      finds out 36 seconds in with a picture in hand
- [x] Titles reuse `agent_runtime/title.rs` — no new code, the shared store path
      already does it
- [x] Archive → Archived → delete for chats. All three already worked once the
      commands routed by store; nothing new was needed
- [x] Delete asks first, and says a chat's **images** go with it while its
      **facts are kept** — both true, both worth knowing before clicking
- [x] Facts survive the deletion of the chat that taught them
      (`a_fact_survives_the_deletion_of_its_chat`)
- [x] **Seen running.** Alvan opened it: switcher, project-less rail, empty
      state and "Ask anything" all correct on screen

**One thing fixed from that run:** the composer footer said "AI can make
mistakes. Review generated code." Chat mode writes no code, so it now reads
"Check anything that matters."

---

## ✅ Phase 2 — Memory

### Done

| File | What |
|---|---|
| `src-tauri/src/chat_memory/schema.rs` | **Created.** `chats`, `messages` + FTS5, `facts` + FTS5. Index maintained by triggers, not by the write path |
| `src-tauri/src/chat_memory/mod.rs` | **Created.** Opening, the corrupt/version-mismatch replacement path, the process-wide service |
| `src-tauri/src/chat_memory/facts.rs` | **Created.** `remember`, pin, edit, delete, search, the five-fact injection block |
| `src-tauri/src/chat_memory/search.rs` | **Created.** Turning what a person typed into something FTS5 accepts |
| `src-tauri/src/chat_memory/index.rs` | **Created.** Indexing one chat, and `rebuild_from_folders` |
| `src-tauri/src/chat_memory/query.rs` | **Created.** The four reads `recall` is built on |
| `src-tauri/src/tools/memory/mod.rs` | **Created.** The `recall` and `remember` tools |
| `src-tauri/src/tools/mod.rs` | Bucket registered; `BUILTIN_TOOL_COUNT` 41 → 43 |
| `src-tauri/src/agent_runtime/conversation/context_injection.rs` | `memory_block()`, memoized per conversation like `<repo_map>` |
| `src-tauri/src/commands/agent_v2/turn_driver.rs` | Re-indexes a chat after each turn; `execution_mode_is_chat` on the config |
| `src-tauri/src/commands/threads.rs` | Deleting a chat drops it from the index, and leaves its facts alone |

- [x] `chats.db` schema, with FTS5 **proven by running it**, not by reading a
      build script
- [x] The database is derived: `rebuild_from_folders`, and a corrupt or
      version-mismatched file is replaced rather than fatal
- [x] `recall` — one typed `op`: `search` (default), `facts`, `read`, `section`
- [x] `recall` returns ranked snippets carrying the conversation id and the
      message position, which is the handle for going deeper
- [x] `recall` reaches chats only — never `sessions/`
- [x] `remember`
- [x] Five facts injected into the first message, pinned first
- [x] Recalled facts arrive as tool results at the tail, never rewriting the
      first message

**Three things worth knowing:**

- **Every search query is made inert before it reaches SQLite.** FTS5's `MATCH`
  is a query language, so `what about C++ vs. Rust?` is a syntax error rather
  than a search. Each word is quoted as a literal and ANDed. Ten awkward but
  reasonable questions are run through real SQLite in a test.
- **Remembering the same fact twice updates it instead of adding a copy.**
  Models restate what they know, and without this one fact ends up with four
  spellings crowding out the other four injection slots.
- **A fact outlives the conversation that taught it.** `source_chat_id` is
  deliberately not a foreign key, and there is a test whose only job is to stop
  someone "fixing" that.

**Bug the tests caught:** `recall op: "read"` guessed "a full page means there
is more", which is wrong exactly when a conversation's length is a multiple of
the page size. It advertised a page that did not exist. Now it reads one row
past the page and answers exactly.

### The Memory page — also done

| File | What |
|---|---|
| `src-tauri/src/commands/chat_memory.rs` | **Created.** Eight commands, every one `async` + `spawn_blocking` because a sync command runs on the UI thread in Tauri v2 |
| `src/apps/agent/store/conversation/useAgentMemoryStore.ts` | **Created.** View state, optimistic writes with rollback |
| `src/apps/agent/store/conversation/useAgentMemoryStore.test.ts` | **Created.** 14 tests |
| `src/apps/agent/components/panels/MemoryPanel.tsx` | **Created.** The page |
| `src/apps/agent/theme/agent-window/43-memory.css` | **Created.** |
| `src/apps/agent/types.ts` | `memory` dock tab kind + label |
| `src/apps/agent/components/shell/RightDock.tsx` | Renders the panel |
| `src/apps/agent/components/shell/LeftRail.tsx` | Memory entry |

- [x] Memory entry in the left rail, opening as a dock tab
- [x] Memory page: pin, edit, delete, add by hand
- [x] Tauri commands behind that page

**The page shows the facts in the order the MODEL receives them**, and marks the
first five. That line — between what Aurora is told at the start of every chat
and what it has to go looking for — is the single most useful thing on the page,
so nothing re-sorts or groups around it.

**Pinning re-sorts locally to match the server.** Without that the row stays put
and the pin looks like it did nothing until the page is reopened.

**A "Rebuild search" button, with counts beside it.** The index is derived, so
it is repairable by hand, and the counts are what make the button mean anything:
"Rebuild" with no number next to it has an effect you cannot see.

**Lint caught a real bug, not a style point.** The per-row editor seeded a
controlled draft from an effect. That is both the lint error and the actual
hazard — an effect writing state on every render of a list that re-sorts under
you when a row is pinned. The editor is uncontrolled now, keyed on `updatedAt`.

---

## 🟨 Phase 3 — Research

- [x] Deep-research control in the composer
- [x] Deep-research prompt section, in the STATIC half so it stays cached
- [x] A conversation started in deep research stays in deep research — the flag
      is on the thread sidecar, set once at creation, with no setter to change it
- [x] Compaction reused, with its own summariser prompt for chat that preserves
      **sources, findings and dead ends** instead of file paths and code
- [x] Search that fully fails carries an instruction, not just `success: false`

### What was built

| File | What |
|---|---|
| `src-tauri/src/agent_runtime/session_store.rs` | `deep_research` on the metadata and the summary; `mark_deep_research` (write-once) and `is_deep_research`; carried through `duplicate` |
| `src-tauri/src/agent_runtime/conversation/compaction.rs` | `CHAT_COMPACTION_SYSTEM_PROMPT` — its own prompt, selected by mode |
| `src-tauri/src/commands/threads.rs` | `thread_create` takes `deep_research`; `deep_research` on the wire summary |
| `src-tauri/src/tools/file_workspace_search/auroro_websearch.rs` | `search_failure()` — a failed search tells the model what to do |
| `src/apps/agent/services/runtime/agent-execution-mode.ts` | `DEEP_RESEARCH_PROMPT` |
| `src/apps/agent/services/runtime/agent-prompt.ts` | Injects it for chat conversations that carry the flag |
| `src/kernel/store/useSettingsStore.ts` | `deepResearchNext` — a seed for the next chat, never the state of one |
| `src/apps/agent/components/composer/ModelSelector.tsx` | A button on a fresh chat, a locked label on an open one |

**The composer control does two different jobs**, and looks it. On a fresh chat
it is a button deciding what the next conversation will be. On an open one it is
a static label reporting what this conversation already is, because that cannot
change. A live-looking switch on a conversation that cannot change would be a
lie the user can watch not working.

**The summariser needed its own prompt, not a tweak.** The coding one asks for
file paths, function signatures and code snippets. A research conversation has
none of those, and a summariser told to preserve them pads the note with the
nearest thing it can find while dropping the sources. The chat version asks for
findings-with-sources, what was ruled out, and where sources disagreed.

**A failed search now carries an instruction.** `success: false` alone is a fact
the model can read past; the hazard is answering from memory with the confidence
of something freshly looked up, which is invisible to the reader. The result now
says not to cite sources it could not reach, and that training knowledge is
allowed only when labelled as unverified.

### Done later — 2026-09-05

- [x] **The browser is the ladder's third rung.** `services/browser_search.rs`
      behind the `PageSource` trait in `websearch/mod.rs`. This is the answer
      the four probed engines could not be: a challenge page is testing for a
      browser, so the way past it is to be one. Its own off-screen webview
      (`browser-search`), never the right-rail panel, and serialized behind a
      mutex because the search tool is `concurrency_safe` and there is one
      webview. **Never run in a live app** — see `.knowledge/knowledge.md`.
- [x] **Four scholarly catalogues, native Rust** (`websearch/scholar.rs`):
      arXiv, OpenAlex, Semantic Scholar, PubMed Central, free and keyless,
      asked concurrently and merged round-robin. Reached with `source:
      "scholar"`, which is a **choice, not a rung** — they answer a different
      question from the open web and must never be a fallback for it. Verified
      live; Semantic Scholar rate-limits unauthenticated callers and the merge
      survives it.

### Left

- [ ] **A second free general web engine.** Still nothing usable: Mojeek serves
      a captcha, `search.inetol.net` / `opnxng.com` / `priv.au` return **429**,
      `searxng.site` returns **403**, and Marginalia's public API does not
      resolve. **Adding an engine that captchas would make the ladder longer
      and no more reliable.** Less pressing now that the browser rung exists,
      which is the thing that actually adds a capability rather than a retry.
      A user-configured SearXNG instance is the one shape worth revisiting —
      the public ones fail, a private one would not.

---

## ✅ Phase 4 — Presentation

- [x] Canvas tab in chat mode's dock — `CHAT_DOCK_TABS` in `types.ts` is the
      roster (Canvas + Memory), read by both doors onto those tabs: the dock's
      `+` menu and the command palette
- [x] Opening an old conversation lists its artifacts; clicking one opens it in
      its own tab
- [x] Canvas SDK additions: `Image`, `Cite`, `Quote`
- [x] `report` artifact kind — sectioned long-form, contents strip, numbered
      citations that link out, quoted passages with attribution. Deep-research
      conversations only
- [x] Export a report as **PDF** and as **Markdown**, from the open artifact
- [x] Canvas text selection fixed

### What was built

| File | What |
|---|---|
| `src/canvas-sdk/index.tsx` | `Image`, `Cite`, `Quote`, plus `openFromSandbox` — the frame runs on `sandbox="allow-scripts"`, so an `<a target="_blank">` inside it is silently inert and the href goes to the host instead |
| `src/canvas-sdk/canvas.css` | Their styles, including the named-absence state for an image whose file is gone |
| `src-tauri/src/tools/canvas/guide.rs` | The three taught in `canvas_guidelines`. A Rust test and a TS test pin the two lists against each other, and both had to be updated |
| `src/apps/agent/adapters/open-external.ts` | **Created.** One place that hands a URL to the real browser, refusing anything that is not `http(s)` — a canvas href is model output, and `file:` reaching the OS opener is a way out of the sandbox |
| `src/apps/agent/components/canvas/CanvasReact.tsx` | Listens for `open-url` on the channel it already used for crash reports |
| `src/apps/agent/services/artifacts/report-document.ts` | **Created.** What Canvas reads out of a report: `##` headings → contents, `[^key]` markers + definitions → numbered sources, definitions lifted out of the body. 11 tests |
| `src/apps/agent/components/canvas/CanvasReport.tsx` | **Created.** The reader: contents strip, prose through the shared Markdown renderer, source list. One delegated click handler for every link, because none of them work on their own in a webview |
| `src/apps/agent/services/artifacts/report-export.ts` | **Created.** Markdown through the OS save dialog; PDF through the webview's own print, on a light print stylesheet. 8 tests |
| `src/apps/agent/components/canvas/CanvasPanel.tsx` | Canvas is now the INDEX; `artifactId` renders one artifact in its own tab. Report branch, Save-as controls |
| `src/apps/agent/store/workspace/useAgentWorkspaceStore.ts` | `openArtifactTab`; `artifact` tab kind on `DockTabKind` |
| `src/apps/agent/services/tools/aurora-tools.ts` | A present opens the artifact's OWN tab, not the index |
| `src/apps/agent/components/canvas/CanvasDiagram.tsx` | A left-drag starting on a diagram label selects it instead of panning |

**Three decisions worth knowing:**

- **Canvas became the index, and each artifact opens in its own tab.** A
  dropdown is a worse browser than a list once a conversation has produced six
  things, and two reports are often wanted side by side — which one Canvas
  surface cannot do however good its selector is. Presenting still lands you on
  the new artifact directly, so the live path got better rather than longer.
- **A report is Markdown, not a new format.** It exports as Markdown with no
  conversion, the model already writes it well, and everything the panel adds is
  derived from the source on every read — so a report revised by a patch cannot
  end up with a contents strip describing the version before it. Citations are
  numbered **in the order the reader meets them**, not the order they were
  defined.
- **Aurora writes no PDF of its own.** The alternative is a PDF library and a
  second layout engine to keep in step with this one; the webview under the app
  already lays the document out and can print it, and "Save as PDF" is a
  destination in that dialog. What the preview shows is what the panel rendered.

**The selection fix was one gesture, not one CSS rule.** The pan stage turns
selection off because dragging pans it. Splitting by what is UNDER the pointer —
background pans, a label selects — needs no modifier to learn, because that is
what both gestures already mean everywhere else. Middle-drag still pans from
anywhere, so nothing became unreachable.

---

## 🟨 Phase 5 — Models and images

### Done

| File | What |
|---|---|
| `src/apps/agent/components/theme/SilkPlaceholder.tsx` | **Created.** The placeholder: Alvan's WebGL silk shader verbatim under two vignette layers, sized to the arriving image's aspect. Releases its WebGL context on unmount |
| `src/apps/agent/components/theme/silk-color.ts` | **Created.** The colour rule — hue from `--agw-accent`, saturation and lightness from `#7298bb`. S and L derived from the constant, never transcribed |
| `src/apps/agent/components/theme/silk-color.test.ts` | **Created.** 11 tests |
| `src/apps/agent/theme/agent-window/41-silk-placeholder.css` | **Created.** Longhand animation properties, fade rests visible, real reduced-motion query |
| `src/apps/agent/theme/agent-window.css` | Manifest import for 41 |

Design probe: `C:\Users\Alvan\Documents\aurora-image-placeholder-designs.html`
(sample image beside it as `aurora-probe-sample.png`).

### Also done (2026-09-04)

- [x] Per-model **Chat** tick on the provider page, chat mode only, **max ten**.
      Its own list (`chatModelShortlist`), never a reuse of the enabled flag —
      curating a short pool to chat with must not shorten Build's roster. At the
      cap the remaining ticks disable and say why. An EMPTY shortlist offers
      everything: nothing ticked means "not curated yet", not "no models"
- [x] A conversation whose model leaves the shortlist falls to the next
      available one — `applyChatShortlist` in `lib/thread/thread-model.ts`,
      applied inside `resolveThreadModel` so the pill and the turn cannot show
      two different models. Empty shortlist, or one whose every entry is gone,
      changes nothing: a pinned model that still exists beats falling back to
      none
- [x] **Deep research shows on the composer pill**, not only inside the menu —
      the open book in accent, in the same slot Plan mode uses on the Build
      side. The two can never collide (Plan is a way of working on a project)
- [x] Image providers: their own expandable section in the provider tab, chat
      mode only (`settings/ImageProvidersSection.tsx`), with the store slice and
      the shape behind it (`services/providers/image-providers.ts`, 11 tests)
- [x] Image provider fields: name, base URL, API key, **API format**, generation
      path, edit path, response shape. Each path field shows the URL it
      resolves to. An explicitly EMPTY edit path means "cannot edit" and does
      not fall through to the format's default — `editUrl()` returns `null`,
      which the model row reads to disable its own can-edit switch
- [x] Image model fields: id, label, **can edit**, sizes, default size, price
      (unset renders as nothing, never a measured $0.00)

**They live in app settings, not two SQLite tables of their own.** A deviation
from the design record's "mirrors `llm_providers` + `provider_models`", which was
about the two-level shape and the per-provider wire format — both kept. A
handful of rows read at startup and written on edit, never joined against
anything, do not need a migration, a repository and a command surface.

### Left

- [ ] **Add provider** asks which kind first. Today the image section has its
      own Add button, which works but means two doors
- [ ] **Test button** on an image provider. Deliberately absent rather than
      present-and-inert: it needs a Rust command to make the request (a webview
      `fetch` is a CORS wall), and a button that does nothing is the exact thing
      this codebase refuses elsewhere
- [ ] Model discovery where the provider allows it — a6api tags image models
      `["image-generation","openai"]` in `supported_endpoint_types`
- [ ] `generate_image` tool, handling a6api's three measured deviations:
      **edits take JSON with `image` as a URL, not multipart**; **errors arrive
      with HTTP 200**; **`/models/{id}` is unreliable, use the list**
- [ ] Download every generated image into the conversation's `assets/`
      immediately and reference the local copy — the returned URL has no stated
      lifetime
- [ ] Missing asset renders a plain "file not found" state, in the conversation
      and in the canvas
- [ ] Normalise asset names on the way in, whichever door they came through
- [ ] Attach an existing conversation asset from the composer
- [ ] **Direct render (card 01):** bare, no frame, image aspect reserved,
      crossfade on arrival
- [ ] **Model-called render (card 05):** ordinary tool card with expand/collapse;
      the image goes to the **Canvas**, not the transcript. Composes
      `CanvasLaunchCard` and `ImageResult`
- [ ] `/image <prompt>` with a chat model selected goes to **that model** with an
      extra instruction, never around it
- [ ] An image model selected sends **only the current message** — no history —
      and the composer says so
- [ ] Titles and compaction fall back to the chat default model when the
      conversation is pinned to an image model

---

## Owed regardless of this work

- [x] **No workspace means no file boundary.** Closed 2026-09-04 — by Aurora,
      dispatched through the MCP delegate, and verified here (2,228 Rust tests,
      0 failures). With no workspace the access setting now DECIDES instead of
      being skipped: off refuses with a message naming the path and both ways
      out, on allows verbatim as before, and the spill-directory check still
      runs first so the model can read its own oversized output. There was a
      **third** resolver with the same hole — `resolve_path_for_create`, behind
      `file_write`, `folder_create` and `move_path`'s destination — which
      Aurora found and closed.
- [x] **The same hole in `grep`, `glob` and `workspace_tree`.** Closed the same
      day, also by Aurora. Different predicates by design: `grep` and `glob` use
      `searches_outside()` (Full only), because with a workspace open those two
      already refuse outside paths under Read — granting Read here would have
      made *no folder open* wider than *folder open*, so opening a project would
      narrow the tool. `workspace_tree` uses `reads_outside()` (Read or Full),
      because its with-workspace arm goes through the read resolver and Read is
      documented as letting it take an absolute path anywhere. All refuse
      through the one shared message, so the model cannot tell which tool said
      no from the wording.

---

## Alongside the plan — two things worth reading before you continue

### Aurora did some of this work itself, through the CLI delegate

The file-boundary bug and its follow-up were **dispatched to Aurora** and
verified here. It ran on `modal:…glm-5-3`, ten and thirteen minutes, and the
result was good: it found a third resolver the design record had not named, it
chose different access predicates for `grep`/`glob` than for `workspace_tree`
and explained why from the code rather than from the names, and it said clearly
when it had widened scope and where to undo it.

**What to copy about how it was given.** Bounded work, a correct sibling in the
codebase to copy from (`shell_execute`'s existing no-workspace guard and its
test), and a done condition a test can answer. The surfaces two writers would
have collided on — the provider settings page, the composer — were kept here.

**What to watch for.** Its two wrong conclusions were both claims about things
OUTSIDE what it changed, each backed by evidence that looked solid and came
from the thing being measured. Check anything a delegated agent says about the
tools themselves; the code inside the boundary held up every time.

Full account, including a false bug report it filed and what caused it, in
`.knowledge/knowledge.md` and `.knowledge/lesson.md`, same date.

### Every tool-loop request showed the model a message that looked like the user

Found by **reading a session's reasoning**, not by a test — no test could see
it, nothing failed, nothing was slow.

> **Superseded the same evening.** The state block is gone altogether; see
> `turn-shape-and-todo.md` for the shape that replaced it. What follows is the
> morning's account, kept because the measurement in it still stands.

The volatile state block (`<aurora_runtime_state>`: open files, live checklist)
was pushed as its own **user-role message** at the end of the API view. On a
continuation request there is no new user text, so the model received a message
from the user containing nothing from the user. Five turns out of five in one
conversation opened with it working that out — *"The user's message is just the
aurora_runtime_state block — no new user text"* — before doing any work.

**Both vendored references avoid exactly this**, and checking them is what
settled it:

- `thirdparty/claude-code-cli` runs a final pass, `smooshSystemReminderSiblings`
  (`src/utils/messages.ts:1835`), whose only job is to fold reminder text INTO
  the last `tool_result` of the same message. Real user input is the one thing
  it leaves alone, "because a Human: boundary before actual user input is
  semantically correct" — with an A/B run cited.
- `thirdparty/opencode` appends its reminder to the tool's own output string
  (`packages/opencode/src/tool/read.ts:356`).

**Proved it was the shape, not the model.** The same GLM 5.3 endpoint in the
same directory, run through OpenCode, opens its reasoning on the task and never
on the envelope. (OpenCode's sessions are SQLite at
`~/.local/share/opencode/opencode.db`, tables `session` / `message` / `part`.)

**Fixed, and it costs nothing.** The state rides inside the last tool result
and is **frozen there when that message is built** (`execute_tool_calls_seq`),
right beside the aggregate-budget verdict that already followed the same rule —
written into the message that gets persisted, so it is byte-stable for the rest
of the conversation. A tool result's content is a plain string on both wire
formats, so no per-provider branch. When a request does not end in a tool
result the standalone message is still used, which is exactly when the user HAS
just spoken.

**The first attempt was worse and it is worth knowing why.** It folded the
state in at request-assembly time and stripped it from older results as newer
ones took it. That works, but every tool result then changes exactly once, so
the cache breakpoint had to move a message earlier and one tool result was
re-billed per iteration. Alvan caught it: history grows and older parts are
frozen, so the state never needed stripping — it can stay where it landed.
Freezing removes the trade entirely.

**Consequence to know:** the history holds several state blocks, one beside
each batch of tool results, with older checklists in them. The system prompt
now says the most recent one is the current one — the same way the newest
message in any conversation is — rather than claiming the block is live, which
stopped being true the moment it was frozen.

## Waiting on Alvan

- **A fresh a6api key.** The provider is chosen and probed live, but the key
  used for probing was pasted into a conversation and should be treated as
  spent. `generate_image` cannot ship without a new one.
- **Any NEW visual component.** Following an existing pattern is fine; a
  surface or animation with no precedent is his to design. He supplied the image
  placeholder animation himself (`public/image-placeholder-loop.html`).

Nothing else is blocked. Phase 4 and the rest of Phase 5 can proceed.

---

## Where Phase 4 starts

The pieces it composes already exist — read them before writing:

| Thing | Where | Why it matters |
|---|---|---|
| Dock tabs | `types.ts` `DockTabKind` / `DOCK_TAB_LABELS`; rendered in `components/shell/RightDock.tsx` | `canvas` and `memory` are already kinds; `memory` was added by Phase 2 and is the pattern to copy |
| Artifact → Canvas | `CanvasLaunchCard` inside `components/tools/ToolCallCard.tsx` | A tool card that opens the Canvas tab and selects an artifact. Exactly the shape a model-called image needs |
| One image in a card | `components/tool-views/ImageResult.tsx` | Renders from disk via `convertFileSrc`, thumbnail → modal. Mounts only inside an expanded card |
| Canvas SDK | `src/canvas-sdk/index.tsx` | ~25 components already. `Canvas` and `BarChart` take a `source` prop, so citation was designed in. **Consumed as TEXT by `vite-canvas-plugin.ts` — do not move the file** |
| Artifact kinds | `tools/definitions/artifact-tools.ts` | `mermaid` renders and `react` compiles before saving; bad output is rejected at write time. `report` joins them |
| The placeholder | `components/theme/SilkPlaceholder.tsx` | Built and tested. Phase 5's render paths mount it |
