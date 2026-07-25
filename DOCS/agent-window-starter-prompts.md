# Agent Window — Dynamic Starter Prompts

Status: **plan, not implemented**. Written 2026-07-21.

Replaces the four hardcoded `SUGGESTIONS` in `src/agent-window/components/EmptyState.tsx`
with a per-project pool that is generated on demand, persisted, and cycled on open.

---

## 1. Core rule

**The model is never called on window open.** It runs only when the user clicks
refresh (plus one optional auto-seed, see §6). Every open reads from a saved
pool. This is what keeps the empty state instant and free.

---

## 2. Storage

Per **project**, not per thread — `{thread_id}.meta.json` is thread-scoped and is
the wrong home for these.

```
~/.aurora/projects/<slug>/
  starters.jsonl        append-only pool, one starter per line
  starters.state.json   rotation cursor + last fingerprint
```

`~/.aurora/projects/` already exists (`paths::team_projects_dir()`), so there is
no new path plumbing. JSONL matches the convention already used for conversations
and rich results, and append-only writes are crash-safe — a torn write costs one
line, not the pool.

### `starters.jsonl` — one object per line

```json
{
  "id": "s_9f2c",
  "category": "explain",
  "label": "Tour the agent runtime",
  "prompt": "Walk me through how agent_runtime drives a turn.",
  "source": "local",
  "grounded": true,
  "refs": ["src-tauri/src/agent_runtime/conversation.rs"],
  "createdAt": "2026-07-21T18:03:11Z",
  "fingerprint": { "branch": "main", "head": "020c845", "threads": 12 }
}
```

- `category` — one of `explain | fix | build | test | review`. Maps to an
  `AgentIconName` **on our side**. The model never names an icon.
- `source` — `local | cloud | derived | static`. Lets the UI and any future
  cleanup distinguish model output from template output.
- `grounded` — true when `refs` were validated against the file index.
- `refs` — file paths the prompt mentions, already validated.
- `fingerprint` — project state when generated; drives staleness (§7).

### `starters.state.json`

```json
{ "cursor": 8, "lastFingerprint": { "branch": "main", "head": "020c845", "threads": 12 } }
```

Tiny and rewritten on open. Losing it only resets rotation.

---

## 3. Composition of a shown row

A shown row is always **4 starters**, assembled at render time — never a raw
slice of the pool. This is what guarantees the project-relevance floor even when
the pool is empty or the model was never configured.

| Slot | Source | Fallback if unavailable |
|---|---|---|
| 1–2 | pool (`source: local\|cloud`), next 2 at `cursor` | derived (§5) |
| 3 | derived — open tab / recent thread / branch | static |
| 4 | static evergreen | — |

Floor: **≥ 50% project-grounded**, comfortably above the 20% requirement, and it
degrades to derived → static instead of ever rendering an empty row.

`cursor` advances by 2 on each open and wraps. That is the "cycle by cycle"
behaviour: reopening the project shows the next pair, not the same pair.

---

## 4. Generation flow (refresh click)

1. Read mode from Preferences (§8). If `off`, refresh is hidden entirely.
2. Build context (all already available, no new storage):
   - recent thread **titles** for this `workspace_root`, newest first
     (`SessionStore::list_summaries_filtered`)
   - currently open tabs (`workspace_state`) + selected file (`explorer_state`)
   - git branch + last ~5 commit subjects (`git_get_commits`)
   - README head + `package.json` / `Cargo.toml` name & scripts
   - top-level directory names
3. Call the model — a **5th task** in `src-tauri/src/prompt_refine/mod.rs`,
   cloned from `suggest_replies` (it already returns `Vec<String>` with quality
   filters): `STARTER_SYSTEM` + `suggest_starters()` + `prompt_refine_starters`
   command + `runStarterPrompts()` in `adapters/prompt-refine.ts`.
4. **Validate** every path-looking token against `loadFileIndex()`. Drop any
   starter referencing a path that does not exist. One dead starter discredits
   the whole row — this is the single most important guard.
5. Dedup against the existing pool by normalised prompt hash.
6. Append survivors. Cap the pool at **40**; evict oldest beyond that.
7. Reset `cursor` to 0 so the user immediately sees what they just generated.

Failure at any step = keep the existing pool and show derived/static. Same
fire-and-forget, never-block posture as `generateSuggestionsFrom`.

---

## 5. The no-model path (`derived`)

Required so the feature is useful before any model is configured. Pure templates
over signals we already read — no LLM:

| Signal | Starter |
|---|---|
| open tab | `Explain <file>` |
| recent thread title | `Continue: <title>` |
| git branch (non-default) | `What's left on <branch>?` |
| `package.json` scripts | `Run <script> and fix what fails` |
| checkpoint-bearing thread | `Review the changes from <title>` |

These are genuinely project-specific without costing anything, and they are what
slot 3 falls back to.

---

## 6. Auto-seed

- **local** mode — on the first ever open of a project (empty pool), generate
  once in the background. It is an on-device model; there is no cost, and the
  first impression should not be four generic prompts.
- **cloud / chat model** — never auto-seed. Explicit refresh only, because it
  spends the user's tokens.

---

## 7. Staleness

Compare current fingerprint to `lastFingerprint`. On drift (branch changed, HEAD
moved, thread count grew) put a **dot on the refresh icon**. Do not auto-regenerate
— that would violate §1 and surprise cloud users.

---

## 8. Preferences

New section in `PreferencesSettings.tsx`, mirroring the existing **Chat titles**
tri-mode exactly (`AgwSegmented`, same shape):

- **Off** — static four only, refresh hidden
- **Local** — llama.cpp, shares the Prompt refine config
- **Chat model** — the currently selected provider model

Reusing that pattern means no new config surface: local mode inherits
`llamaDir` / `modelPath` / `device` from Prompt refine.

---

## 9. Files touched

```
src-tauri/src/prompt_refine/mod.rs        STARTER_SYSTEM, suggest_starters()
src-tauri/src/commands/prompt_refine.rs   prompt_refine_starters
src-tauri/src/starters/mod.rs             NEW — pool read/append/cap, state file
src/agent-window/adapters/prompt-refine.ts  runStarterPrompts()
src/agent-window/adapters/starters.ts     NEW — pool IO + composition (§3)
src/agent-window/store/useAgentStarterStore.ts  NEW — row, cursor, refreshing
src/agent-window/components/EmptyState.tsx  consume store, add refresh button
src/agent-window/settings/PreferencesSettings.tsx  tri-mode section
```

---

## 10. Open questions

1. Pool cap of 40 — arbitrary. Enough for ~10 refreshes without repeats.
2. Should archived threads feed context? Leaning no — archived means done.
3. Should the refresh button also appear once a conversation exists, or only in
   the empty state? Leaning empty state only.
