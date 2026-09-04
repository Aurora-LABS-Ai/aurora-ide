# Chat mode — design record

Aurora gains a second mode beside the one that writes software.

**Aurora Build** works on a project. **Aurora Chat** is a conversation: no files,
no shell, no workspace. It researches online, remembers things across
conversations, and presents on a canvas.

Modelled on the Codex desktop app's product switcher at the top of the left
rail, not on a chip in the composer.

> **This file is the DECISIONS. For what is built and what is left, read
> [`implementation-progress.md`](./implementation-progress.md) — start there.**
>
> As of 2026-09-04: Phases 0, 1 and 2 are built and green, Phase 3 all but one
> deliberately-skipped piece, Phase 4 untouched, Phase 5 partly. Do not re-open
> anything settled below.

**Status: design complete.** Five rounds of decisions,
recorded below. Where a question went unanswered and was delegated, the entry
says *Claude's call, delegated* so it is clear later who decided what.

---

## 1. The window

### The switcher

Top of the left rail, same position and shape as Codex's. Two entries, each a
name and a line:

- **Aurora Chat** — ask, research, and think
- **Aurora Build** — build end-to-end full stack applications

Neither is called "Agent". The mode that writes software is **Build**.

Flipping it does not convert the conversation on screen, because a
conversation's mode is its address on disk.

**Each side remembers where it was.** Flip to Chat and you return to the
conversation you left. With one qualifier: **if the last conversation on that
side is older than two hours, you land on the empty state instead.**

A new chat is an empty state, the same shape Build mode's empty state has.

### The left rail

**The rail stays. Projects go.** In chat mode it lists chats only: no Projects
section, no project switcher, no folder picker. Conversation titles appear in it
exactly as they do in Build mode.

**Grouped and filterable by date.** This matters and is not decoration. A chat
list is browsed by "when was that", and a flat list stops working around forty
entries.

The rail also carries the **Memory** entry, the same shape as the Team entry
(`LeftRail.tsx:195` gates on `teamEnabled` and opens a dock tab).

### The right dock

**It exists, with two tabs: Canvas and Memory.** Closed by default, opening
itself the first time the model presents something.

**Opening an old conversation shows its artifacts as a list.** A chat that
produced six reports and diagrams does not dump them on you. The dock shows what
that conversation made, and clicking one opens it in its own tab.

Build mode's Review / Files / Browser / Terminal tabs do not exist here.

---

## 2. Storage

The folder is the truth. The database is an index built from it, and can be
rebuilt by walking the folders. A corrupt or deleted database costs a rebuild,
never history.

```
%LOCALAPPDATA%/AuroraIDE/
  sessions/                 <- Build mode threads, untouched
  Chats/
    chats.db                <- derived index, rebuildable
    <conversation-id>/
      conversation.jsonl    <- canonical message history
      meta.json
      rich.jsonl
      artifacts.json
      assets/               <- this conversation's images
```

**`assets/` belongs to one conversation and is created with it.** It is not a
shared folder across chats. Switching to a conversation brings its images with
it.

**A missing asset says so.** A plain "file not found" state, in the conversation
and in the canvas both. Not a broken-image icon, not silence.

### `chats.db`

Dedicated to chat mode. Three tables, roughly:

- `chats` — the rail list, so it loads without opening a single JSONL
- `messages` + an FTS5 table over the text
- `facts` + its own FTS5 table, each fact pointing at the chat it came from

**FTS5 is already available.** `libsqlite3-sys` 0.36.0 compiles the bundled
SQLite with `-DSQLITE_ENABLE_FTS5` unconditionally (`build.rs:133`). No new
dependency, no feature flag.

### Titles

**Reuse `agent_runtime/title.rs`**, the auto-titler Build threads already use.
Same job, no reason for a second one.

### Archiving and deletion

**Two steps, reusing what exists.** Archive already works end to end:
`toggleArchive` in the chat store, `archived_at` on the sidecar, an "Archived"
view in the rail, and a **15-day retention purge** in Rust
(`ARCHIVE_RETENTION_DAYS`, `session_store.rs:184`).

1. **Archive** moves the chat out of the rail tree into the Archived section.
2. **Delete**, from there, removes **the entire conversation folder**: the
   JSONL, the sidecars, the assets, and its rows in `chats.db`. Nothing orphaned.

Deletion asks first. It is the one destructive action in a mode that otherwise
cannot destroy anything.

**Facts survive the deletion of the chat that taught them.** *Claude's call,
delegated.* A fact is about you, not about the conversation that happened to
produce it.

---

## 3. Tools

Chat mode **names what it has**. It does not subtract from the Build roster.
Anything not on this list is refused, including tools that register later.

| Tool | State |
|---|---|
| `auroro_websearch` | exists |
| `present_artifact` / `read_artifact` | exists |
| `recall` — one tool, typed. See below | new |
| `remember` — write a fact | new |
| `generate_image` | new, see §7 |
| `ask_question` | exists |
| `mcp_*` | exists, deferred |

No native file tools. No shell. No workspace. No browser tools, except as a
search fallback Aurora itself drives, never the model.

**The enforcement point is `is_tool_available_this_turn`**
(`commands/agent_v2/tool_policy.rs:246`). It is the authoritative gate. The
TypeScript copy in `agent-execution-mode.ts` governs only what the frontend
advertises, and **the two have drifted before**, which is how `plan_write`
stayed callable in Agent mode. Both must be edited.

### `recall`

One tool, one typed `op`, four operations. Same shape as `todo`, and for the
same reason: three names for one piece of state makes the model choose before it
can act.

It escalates. Cheap by default, deeper only when the cheap answer did not
resolve the question. The conversations are all on disk in full, so the deep
operations have real material to reach into.

| `op` | Takes | Returns |
|---|---|---|
| `search` (default) | a query | ranked snippets across every chat, each with its conversation id, title and date |
| `facts` | a query | matching remembered facts |
| `read` | a conversation id | that conversation's messages, paged |
| `section` | a conversation id plus a query or line range | the exact passage, not a snippet of it |

The intended path: `search` returns a conversation id and enough text to judge,
and stops there when that answers it. When it does not, the id it already holds
lets it call `read` or `section` for exact lines.

**Reach: chats only.** `recall` does not index `sessions/`. A chat cannot search
your Build-mode coding threads. Clean wall.

**It does see the conversation it is running in**, with those results marked as
"this conversation". *Claude's call, delegated.* The useful case is a compacted
chat trying to recover something that left its context, and hiding the current
conversation would break exactly that.

### MCP

**MCP calls run directly. No approval prompt, ever.** Alvan's call: connecting a
server is the user handing the agent a key deliberately, and asking again on
every call is theatre.

So the promise is not "Aurora cannot touch your machine here". It is:

> **Aurora itself cannot touch your machine in chat mode. What it can reach is
> what you connected.**

That is true, and it stays true as the native tool count grows.

**MCP tools are deferred behind `tool_search`, not listed up front.** The
machinery exists: `is_deferrable` already covers `mcp_*` (`tool_policy.rs:29`),
and `revealed_for_thread` replays what a conversation has loaded so a tool stays
callable across later user messages.

This solves the mid-conversation problem cleanly. A server connected halfway
through is reachable, because the model finds it by searching rather than by
reading a list written at the start. Nothing goes stale, and no
connected-servers block sits in the payload invalidating the cache whenever the
set changes.

Unlike Build mode, where deferral is a preference (`defer_tools`, default off),
**in chat mode it is forced on for MCP**.

### Skills

**Reachable only by naming one with `/` in the composer.** Nothing preloaded,
nothing to configure, no skills roster in the prompt.

*Claude's call, delegated.* Build mode already surfaces skills through `/`
directives, so this is an existing gesture rather than a new control, and chat
mode's prompt does not grow a section it pays for on every request. Deferring
skills behind `tool_search` the way MCP is would also work, but chat mode is one
where the user steers directly, so the model hunting for skills on its own is
the wrong default.

---

## 4. The payload

The same two-tier structure Build mode uses, which is what keeps the prompt
cache hitting.

1. **System prompt.** Chat mode's own, short, byte-stable for the life of the
   conversation. Nothing dynamic in it.
2. **An XML block riding in the first user message**, carrying the instructions
   and five memory facts. Memoized per thread and never rebuilt, exactly as
   `<repo_map>` works today (`conversation/context_injection.rs:68`).
3. **Everything learned later lands at the tail**, as tool results.

**A recalled fact arrives as a tool result. It never rewrites the first
message's XML.** This is the whole reason the cache holds.

There is no connected-servers block, because MCP is found by searching. There is
no workspace block, because there is no workspace.

**Chat mode is cache-driven by design, so cost stays low.**

### The system prompt

**Its own, not a section appended to the coding one.**
`BASE_AGENT_SYSTEM_PROMPT` opens with "You are Aurora Agent, an advanced AI
coding agent", describes a dock of Review / Files / Browser / Terminal, and
spends most of its length on editing rules, lint runs and shell discipline. In
chat mode every one of those is false. A "now ignore the above" section does not
undo it, it makes the model hold two identities and pays for both on every
request.

**It is deliberately short.** What it must establish:

- The model is inside the Aurora Agent application.
- The application has another mode that does real work on the user's machine,
  and the user knows this.
- When asked for something needing files, shell, or a workspace, the model says
  so and points at Build mode. It does not pretend it cannot be done, and it
  does not pretend it can do it.

Shared with the Build prompt: communication style, the markdown rules, the MCP
display-name rule. Nothing about files, edits, lints or the workspace is sent.

### Compaction

**Reuse Build mode's, unchanged.** Threshold, summarising pass, and the 40k tail
floored at a quarter of the window.

It should rarely fire. A chat with no file reads and no tool output barely
grows. **Deep research is the exception**, because a fetched page is thousands
of tokens of prose with nothing to trim.

One change: what the summariser is told to keep. Build mode's keeps decisions
and file state. A research chat needs it to keep **sources and findings**.

---

## 5. Memory

**Facts are written by the model calling `remember`.** No automatic extraction
after each turn. The call is visible in the transcript, so you watch it happen
and can undo it, and it costs nothing on turns where nothing was learned.

**Facts are global across chats.** A fact learned Tuesday is known Friday, in a
different conversation. That is the point of it.

**Five ride in the first-message XML: pinned first, then most recent until five
is reached.** Everything else the model reaches with `recall`. Without pinning,
the fact you care most about is buried the moment the model learns three things
about something else.

**The Memory page** opens from the rail as a dock tab. It lists everything
Aurora remembered, and you can **pin, edit, delete**. Memory you cannot inspect
is memory you cannot trust.

---

## 6. Models

The provider settings page is unchanged. Everything on it stays as it is.

**What is new: the provider page knows which mode you are in.** In chat mode it
grows a checkbox per model, and you may tick up to **ten**. Those ten become the
models **available** in the chat composer's selector. You then pick one to work
with, per conversation.

- **Build mode** has one selected model, chosen in the composer.
- **Chat mode** has a pool of up to ten available models, curated on the
  provider page, and you choose among that pool in the composer.

Ticking a model makes it *available*, not *selected*.

> Round 1 proposed reusing the single `provider_models.enabled` flag for both
> modes. **Overruled by Alvan.** Chat mode gets its own shortlist, because
> curating a chat pool must not remove a model from Build mode.

**You can change model mid-conversation.** Already works, nothing new needed:
`setThreadModel` writes the pin to the thread sidecar and the composer's picker
calls it (`ModelSelector.tsx:809`).

**A conversation whose model leaves the shortlist falls to the next available
one automatically.** It is not thrown away and it does not break.

**Multimodal already works the way it should.** `provider_models.supports_vision`
records which models can see, and the composer already refuses images when the
selected model cannot. The checkbox simply shows which models are vision models
and which are not. No filtering of the list.

---

## 7. Research and presentation

### Web search

**No paid API. No keys. Ever.** If DuckDuckGo rate-limits, the answer is a
better free approach, not a billed one. Driving a real browser is acceptable if
that is what it takes.

Current engine: `websearch/engines.rs` scrapes `lite.duckduckgo.com` with an
`html.duckduckgo.com` fallback. No key, no quota, no contract.

**Extend the engine ladder first, browser second.** More free engines in
`engines.rs` is the same code shape, just more entries, and it fixes rate
limiting properly because being throttled by one engine no longer stops the
search. Keep the browser as the last rung, and run it off-screen so it never
steals focus.

### Deep research

**A toggle in the composer**, alongside the settings it already carries.

When on, a section is injected into the system prompt: the user has turned on
deep research, there is time, be accurate, open many sites and research
properly, present on the canvas, or answer directly if the result does not need
one.

**It is not a separate engine.** No sub-loop, no fan-out runtime, no separate
progress UI. A prompt mode plus a toggle.

**A conversation started in deep research stays in deep research.** It cannot be
turned back into a normal chat. Same rule as the mode itself.

### The canvas

**Extend the existing canvas SDK** (`src/canvas-sdk/index.tsx`, 711 lines).

It already carries ~25 components: `Canvas`, `Section`, `List`, `Row`, `Stat`,
`Stats`, `Table`, `Badge`, `Note`, `Text`, `Code`, `Bar`, `BarChart`,
`Sparkline`, `Facts`, `Fact`, `Columns`, `Divider`, `Detail`, `Tabs`,
`Timeline`, `Event`, `useHostTheme`. `Canvas` and `BarChart` both take a
`source` prop, so citation was designed in from the start.

**Add three:** `Image` (research without pictures is a poor showing, and it
gives `generate_image` somewhere to land), `Cite` (a numbered source link, since
`source` is currently a bare unclickable string), and `Quote` (a pulled passage
with attribution).

The model can already write arbitrary JSX with inline styles inside a canvas,
since only the *imports* are restricted. It improvises what the SDK lacks, and a
fourth component gets added after watching it improvise the same thing three
times.

### The `report` kind

**Deep research unlocks one output kind a normal chat does not have.** A normal
chat produces `mermaid` and `react`. Deep research adds:

**`report`** — a long-form sectioned document. A contents strip, numbered
citations that link out, quoted passages with attribution.

*Claude's call, delegated.* One kind, not three. A React canvas is built for a
dashboard you look at, not a document you read down: no paging, no contents.
`report` is the shape deep research actually produces. A slide deck is the
obvious second candidate and should wait until it has been wanted twice.

### Export

**Save as PDF and as Markdown**, from the canvas in the dock, on the open
artifact.

Note the wrinkle, since chat mode has no file access: **you** pick the
destination through the OS save dialog, Aurora writes there, and the model is
never involved. The mode's no-filesystem rule is about the model, not about you.

---

## 8. `generate_image` — the a6api probe (2026-09-04)

Tested live against `https://api.a6api.com` with a real key. All measured, none
read from docs.

**It works, and the edit endpoint is real.** A generated aurora image, then an
edit adding the word AURORA to that same image: the edit preserved the mountain,
the ribbons and the stars exactly and only added the letterforms. A true edit,
not a regeneration from a similar prompt.

**Three deviations from the OpenAI shape an adapter must handle:**

1. **`/images/edits` rejects multipart/form-data.** OpenAI's own shape
   (`-F image=@file.png`) returns HTTP 400. It wants a **JSON body with `image`
   as a URL**. The single biggest difference, and not guessable.
2. **Errors arrive with HTTP 200.** `/models/gpt-image-2` returned
   `{"error":{"code":"model_not_found"}}` under a **200** status. The status
   code is not a success signal; the body must be parsed every time.
3. **`/models/{id}` is unreliable.** It reported `gpt-image-2` does not exist
   while `/models` was listing it. Use the list, never the lookup.

**Discovery:** `/models` returns 87 models, each carrying
`supported_endpoint_types`. Image models are tagged
`["image-generation","openai"]`, so the image list is discoverable rather than
hardcoded. Present today: `gpt-image-1`, `gpt-image-1.5`, `gpt-image-2`,
`google-imagen-4`, `gemini-3.1-flash-image`, `gemini-3-pro-image-preview`,
`nano-banana`, `nano-banana-2`, `nano-banana-pro`, the `grok-imagine-image`
family.

**Timing and cost, measured:** generation 36s, edit 41s. Generation billed 37
input + 1056 image-output tokens. The edit billed 2485 input, of which 2465 were
image tokens for reading the source, plus the same 1056 output. **An edit costs
roughly 3.2x a generation.**

**The returned URL has no stated lifetime.** No `Cache-Control`, no `Expires`,
no signature, no token. The host is `img.pinest.xyz`, a different domain from
the API, behind Cloudflare with `cf-cache-status: DYNAMIC`. The path is
date-bucketed (`/amg/images/2026/09/04/`), which is the storage layout you build
when you intend to prune by date.

**This is the evidence for the `assets/` rule.** Nothing about that URL promises
to exist tomorrow, so a generated file is downloaded into the conversation's
`assets/` folder immediately and referenced locally. Never the provider's URL.

**The key used for the probe was pasted into a conversation. Treat it as spent
and mint a fresh one for the app.**

### Image providers are configurable, not hardcoded

a6api is the first one tested, **not the only one supported**. Provider settings
gains an **Add image provider** action, the same way LLM providers work today.

This is not optional polish. The probe found that a6api deviates from OpenAI's
own image API in three ways, so any second provider will deviate differently.
The wire shape has to be a per-provider property or the second one to be added
breaks the first.

**Mirrors the existing shape:** `llm_providers` + `provider_models`, where
`provider_type` is the wire format per model (schema v24). Image providers get
the same two-table treatment with an API-format field of their own.

**Fields a provider row needs:**

| Field | Why |
|---|---|
| Name, base URL, API key | as any provider |
| **API format** | `openai-images` uses multipart for edits; `a6api` uses a JSON body with `image` as a URL. Measured, not assumed |
| Generation path | defaults per format (`/images/generations`) |
| Edit path | defaults per format (`/images/edits`); **empty means this provider cannot edit** |
| Response shape | `url` vs `b64_json`. a6api returns `url` |
| Model list | discovered or hand-added, see below |

**Fields a model row needs:**

| Field | Why |
|---|---|
| Model id, label | as any model |
| **Can edit** | **not every image model can edit.** Generation and editing are separate capabilities and must be recorded per model, or the tool offers an edit that returns 400 |
| Supported sizes, default size | `1024x1024` is not universal |
| Price per image | optional, unset renders as "not applicable" rather than a measured $0.00 |

**Discovery where the provider allows it.** a6api's `/models` tags image models
`["image-generation","openai"]` in `supported_endpoint_types`, so its list can be
pulled rather than typed. A provider without that endpoint gets hand-added rows.

### How an image gets generated

**The selected model always wins.** That is the rule the two paths follow.

**Path A: the selected model IS an image model.** No slash command needed. Type
a prompt, send, get an image. The composer knows what it is pointed at.

**Path B: the selected model is a chat model and you type `/image <prompt>`.**
This does **not** bypass to an image model. It goes to the selected model, with
an extra instruction in the user message XML: the user has prioritised image
generation, reply briefly and run it, or if the prompt looks weak, offer a
refined one first.

> Round 6 proposed that `/image` bypass the model entirely and call the API
> direct. **Overruled by Alvan.** The selected model is the priority, always, and
> `/image` is a signal to it rather than a way around it. It also means the model
> can catch a bad prompt before 40 seconds are spent on it.

### Editing

**The conversation's assets are a pool the model can reach.** It knows what
images this conversation holds, whether they came from research, from
generation, or from you pasting them in.

You point at one in words: *"the first image I sent you, tell me what is on it,
I think we need to edit it."* A vision model can then actually look at it. **A
non-vision model cannot see it but can still edit it**, because the edit tool
works on the asset by reference, not by the model having seen the pixels.

**You can also attach an asset from the composer directly**, the same gesture as
attaching anything else, so the reference is unambiguous rather than described.

**Assets are normalised with consistent naming on the way in**, whichever door
they came through, so the tool is never guessing which file was meant.

### Image providers in settings

**The section appears in Aurora Chat mode only**, never in Build mode.

The provider tab already has **Built-in** and **Custom** sections. It gains a
third, expandable: **Image providers**. And **Add provider** first asks which
kind you are adding, so the two never get mixed up.

An image provider is configured with base URL, API key, model name, **and a Test
button** that proves the thing works before you rely on it.

**Per model, a toggle: this model can also edit.** Generation and editing are
separate capabilities. The composer reads it, so it knows whether an edit is
even offered, and the `generate_image` tool is handed the list of available
image models so the agent can use whichever one you tell it to.

### Deferred idea: configuring a provider by pasting a curl

Alvan floated it and flagged it himself as possibly wild: paste a curl example
and a key into an Aurora Chat conversation and let Aurora work out the provider
config and add it.

**Good idea, not now.** It needs the model to make an arbitrary POST with
arbitrary headers, and `auroro_websearch`'s `fetch` only does GETs. Adding a
general request tool is a real widening of what chat mode can reach, and it
deserves its own decision rather than riding in on this one. Recorded so it is
not lost.

---

## 9. Failure states

*Claude's call, delegated.* Three that will happen. **None of them ends a turn.**

**No model configured at all.** The empty state says so and links to provider
settings, rather than presenting a composer that cannot send.

**Every search engine in the ladder failed.** The tool returns a plain "every
engine failed" result and the model says so in its answer. This is the failure
that matters most, because the alternative is a model that quietly invents
sources rather than admitting it reached none.

**An MCP server dies mid-answer.** The call returns the error, the model reports
it, the turn carries on.

---

## 10. Bugs to fix as part of this

### Canvas text cannot be selected or copied

**Cause found.** `.agw-diagram-stage` sets `user-select: none`
(`15-dock-canvas.css:289`) because it is a pan surface: `cursor: grab`,
`touch-action: none`. Dragging pans the canvas instead of selecting text. The
source view at line 365 re-enables `user-select: text`, which is why only that
one works.

`src/canvas-sdk/canvas.css` sets no selection rules at all, so a React canvas
inherits the stage's `none`.

This is a real design tension rather than an oversight: the same drag gesture
means "pan" on empty space and "select" on text. The fix has to separate them,
by starting a pan only from the background or a modifier and leaving content
selectable.

A report you cannot copy a paragraph out of is not finished, so this is in
scope, not a nice-to-have.

### No workspace means no file boundary

Not chat mode's problem, but found while mapping this and owed regardless.

When `ToolContext.workspace_root` is `None`, both `resolve_path_with_access`
(`file_workspace_search/mod.rs:214`) and `resolve_path_for_read_with_spill`
(line 279) return the raw path **unchecked**. A conversation with no project
open therefore has no file boundary at all, and the `workspaceAccess` setting is
skipped rather than applied.

`shell_execute` handles this correctly and refuses to run with no workspace and
no `cwd`, with a test pinning it. The file tools do not. Today's least-guarded
state is "no folder open".

Chat mode registers no file tools so it is not exposed. It is still wrong.

---

## 11. What already exists (verified in the codebase)

| Thing | Where | Note |
|---|---|---|
| Per-turn tool gate | `commands/agent_v2/tool_policy.rs:246` | authoritative; the TS copy governs only what the frontend advertises, and they have drifted |
| Tool registration | `tools/mod.rs:143` | 41 native tools, fixed order because it rides the cached prompt prefix |
| Tool deferral | `tool_policy.rs:29` | `is_deferrable` already covers `mcp_*`; `revealed_for_thread` replays loads |
| First-message injection | `conversation/context_injection.rs:68` | `<repo_map>` memoized per thread, anchored to the head |
| Web search + fetch | `websearch/engines.rs`, `tools/file_workspace_search/auroro_websearch.rs` | DuckDuckGo lite with an html fallback; fetch returns Markdown, paged |
| Versioned artifacts | `tools/definitions/artifact-tools.ts` | `mermaid` rendered and `react` compiled before save; bad output rejected at write time |
| Canvas SDK | `src/canvas-sdk/index.tsx` | consumed as TEXT by `vite-canvas-plugin.ts`; **do not move** |
| Rail feature entry | `LeftRail.tsx:195` | the Team entry, the pattern Memory copies |
| Archive | `useAgentChatStore.toggleArchive`, `session_store.rs:184` | full lifecycle plus a 15-day retention purge |
| Per-conversation model | `ModelSelector.tsx:809`, `thread-model.ts` | `setThreadModel` writes the pin; mid-conversation switching works |
| Titles | `agent_runtime/title.rs` | reused as-is |
| FTS5 | `libsqlite3-sys-0.36.0/build.rs:133` | already compiled in |
| Workspace boundary | `agent_safety/paths.rs:70` | canonicalize both sides, containment, symlink recheck, `dunce` on Windows |

---

## 12. Implementation phases

Each phase is usable on its own.

**Phase 1 — the mode.** The enum on both sides of the IPC, the switcher, the
`Chats/` store with the folder layout, the rail without projects, date grouping,
the empty state, the new system prompt, archive and delete. At the end of this
phase you can open a chat and talk to a model with no tools at all.

**Phase 2 — memory.** `chats.db` with FTS5, `recall` with its four operations,
`remember`, the Memory dock tab with pin / edit / delete, five-fact injection.

**Phase 3 — research.** The engine ladder, the deep research toggle, its prompt
section, the compaction summariser instruction.

**Phase 4 — presentation.** The dock's Canvas tab and artifact list, the three
SDK components, the `report` kind, PDF and Markdown export, and the
text-selection fix.

**Phase 5 — models and images.** The per-model checkbox with the ten cap,
shortlist fallback behaviour, then `generate_image` against a6api with the three
deviations handled.

### The image placeholder — settled and built

**Alvan supplied the animation**, so there was nothing to choose: it is the
`.box` contents of `public/image-placeholder-loop.html`, verbatim. A WebGL
"silk" shader (speed 19, scale 1.1, noise 2.7, rotation 2.33) under two vignette
layers. The halo and caption in that file sit outside the box and are **not**
part of it.

Design probe: `C:\Users\Alvan\Documents\aurora-image-placeholder-designs.html`.
Decisions from it:

- **Direct generation gets card 01: no frame at all.** The placeholder occupies
  exactly the space the image will, at the requested aspect, so the picture
  arrives as a crossfade rather than a layout jump. You typed the prompt, so
  there is nothing to label.
- **Model-called generation gets card 05: the ordinary tool card.** It is a tool
  call and belongs in the family that already exists.
- **Card 04 (frame + cancel) is out.** Direct has no frame, and the a6api probe
  handed back no cancel handle — an X that abandons the response while the
  generation still bills is worse than no X.
- **The shader follows `--agw-accent`, softened.** The rule:
  **hue from the accent, saturation and lightness from `#7298bb`.** Following
  the accent outright was too harsh — measured, Aurora Dark's `#3994bc` is both
  more saturated and darker than the colour the shader was drawn against, and at
  full strength the placeholder reads as themed UI rather than as a picture
  loading. Change your accent and the silk follows it, in the reference's feel.

**Model-called images do not live in the transcript.** They go to the Canvas,
and the tool card carries the same expand/collapse every other tool card has —
`CanvasLaunchCard` and `ImageResult` are the two existing pieces this composes,
so nothing new is invented.

**Built:** `components/theme/SilkPlaceholder.tsx` (the component, sibling of
`StreamingDotMatrix`), `components/theme/silk-color.ts` (the colour rule, its
own module so the component file exports only a component), and
`theme/agent-window/41-silk-placeholder.css`. 11 tests on the colour rule.

Lessons applied while building it, from `.knowledge/lesson.md`: no `var()` in an
`animation` shorthand (longhands throughout), the fade ends at a visible value
and does not loop, the real `prefers-reduced-motion` query lives in the product
while the probe seeds motion from `matchMedia` instead, and the WebGL context is
explicitly released on unmount so a transcript with several generations cannot
blow the browser's context cap and blank a placeholder that is still running.

### Phase 1 status — the mechanism is in, the pixels are not

**Done and green.** 2,143 Rust tests, 944 frontend tests, `tsc --noEmit` and
ESLint clean.

Rust:

- `AgentExecutionMode::Chat`, with `is_chat()` and `has_workspace()` so call
  sites read as what they ask (`agent_runtime/ipc.rs`).
- `paths::chats_dir()` → `<root>/Chats/`.
- `StoreLayout::{Flat, Folder}` on `SessionStore` (`session_store.rs`).
  `new_folder()`, layout-aware paths, listing, `delete`, plus `assets_dir()`
  and `ensure_dir_for()`. Everything else — journaling, metadata, archiving,
  retention, artifacts, loading — is shared between the two layouts.
- `tool_results_dir_in` takes the layout; `ConversationRuntime` carries
  `store_layout`; `with_store(store)` sets both from one place.
- `AgentRegistry` holds a second store: `chat_store`, `store_for(mode)`,
  `session_path_in`, `load_or_create_session_in`, `with_chat_dir`.
- `TurnDriver` routes every path by mode.
- `AgentChatRequest::scoped_to_mode()` strips a workspace from a chat turn once,
  at the boundary, rather than guarding eleven read sites.
- `CHAT_MODE_TOOLS` + `is_chat_mode_tool`, answered FIRST in
  `is_tool_available_this_turn`, and MCP deferral forced on in chat mode.

Frontend:

- `"chat"` on `AgentExecutionMode`, kept out of the composer's cycle.
- `CHAT_MODE_TOOLS` mirror + `isChatModeTool`, answered first in both
  `isToolAllowedForExecutionMode` and `filterToolsForExecutionMode`.
- `CHAT_MODE_SYSTEM_PROMPT` — the whole prompt, written from scratch.
- The runtime-context block tells the model it is in Chat and points machine
  work at Build.

**Two bugs the tests caught while building this**, both now fixed: the folder
layout needed its conversation directory created before any store-side write
(the flat layout never did, since the root already existed), and a sanity floor
written as `refused > 30` was a guess — it is now an equation against the
registry, so giving chat mode a second native tool fails loudly instead of
sliding under a threshold.

*(That paragraph described Phase 0 at the time it was written. Everything since
is tracked in `implementation-progress.md`, which is the live record.)*

### Stop rule

**Stop and ask before building a NEW visual component.** Following a pattern
that already exists is fine and expected — that is how the switcher, the rail,
the empty state and the Memory page were all built without a probe. What needs
Alvan is a surface or an animation with no precedent in the app.

The one already supplied: the image-generation waiting state, which measured
**36 seconds** and is far too long for a spinner. He wrote the animation himself
(`public/image-placeholder-loop.html`) and it is built as
`components/theme/SilkPlaceholder.tsx`.

Build the mechanism; stop at pixels nobody has chosen yet.

---

## Open

- The image-generation waiting animation, and any other new visual component.
  Alvan supplies the design.
