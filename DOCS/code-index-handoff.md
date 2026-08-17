# Code Index — Handoff

> **Status 2026-08-17: shipped, cache format v6.** Everything below landed and is live; the
> index ships with no on/off toggle (Settings → Agent → Code index shows status + Rebuild).
> §4 (the verification flow) is the permanent tuning loop — repeat it exactly when changing
> `resolve_module`, ranking, or any query. §5 records the design decisions and why alternatives
> failed; §5.2b lists what is still not built.
>
> Format history: v2 imports · v3 write-captures + module graph + churn · v4 workspace package
> map · v5 Rust `let` bindings · v6 import aliases/side-effect imports. Mismatched caches are
> rebuilt, never migrated.

---

## 1. What this is

A structural index of the workspace: every definition, every usage, and which function each usage
sits inside. Answers "where is X defined", "who calls X", "what does this file define" — the
questions `grep` structurally cannot, because grep returns every comment, docstring and string
literal containing the word.

Measured on `quantumhub-client`: **728 files / 6.7 MB → 530 ms**, 28,974 symbols, 145,086 refs.
Cache is 4.9 MB (31% of naive JSON, thanks to string interning).

**It reads syntax, not types.** Resolution is by name. It cannot tell you what something returns and
will not catch type errors — that stays `read_lints`' job. The upside: no toolchain needed, sub-second,
and it keeps working on a file the agent has half-rewritten.

**Semantic/embedding search is dead and is not coming back** (dropped at migration v12). No
current doc advertises it; if you see a reference, it is stale — fix the doc.

---

## 2. Where the code is

| Path | Responsibility |
|---|---|
| `src-tauri/src/code_index/lang.rs` | grammar + query registry. Adding a language = a dep, a `.scm`, one arm here |
| `src-tauri/src/code_index/queries/*.scm` | tree-sitter capture queries (rust, typescript, jsx, python) |
| `src-tauri/src/code_index/extract.rs` | one file's source → definitions + references |
| `src-tauri/src/code_index/walk.rs` | which files count (gitignore, build dirs, generated output) |
| `src-tauri/src/code_index/store.rs` | in-memory index + the queries it answers |
| `src-tauri/src/code_index/persist.rs` | interned/packed cache format |
| `src-tauri/src/code_index/module_graph.rs` | directory/area dependency graph + cycles |
| `src-tauri/src/code_index/repo_map.rs` | renders the `<repo_map>` block |
| `src-tauri/src/code_index/service.rs` | one index per workspace, process-global |
| `src-tauri/src/tools/code_intel/mod.rs` | the `code` agent tool |
| `src-tauri/src/commands/code_index.rs` | `code_index_status` / `code_index_rebuild` |
| `src/apps/agent/settings/CodeIndexCard.tsx` | Settings → Agent → Code index |
| `src-tauri/probes/code-index/` | standalone CLI harness — **keep it**, it is how you measure |

Languages: Rust, TypeScript, TSX/JSX, Python. **A C# project indexes as 0 files** — see §5.2b.

---

## 3. How it is wired

### 3.1 The `code` tool
- Registered in `tools/mod.rs` (`code_intel::register`). `BUILTIN_TOOL_COUNT` is **41** today
  (37 when this doc was written; every tool added since bumps it).
- **If you add a tool, also update `tools/mod.rs::count_without_browser`** and the literal in
  `builtin_tool_count_is_correct`, or 3 tests fail.
- Ops: `definition` | `usages` | `outline` | `modules` | `refresh`. One tool with a typed op, not
  five names — every schema is re-sent on every request. `in_file` narrows both `definition` and
  `usages`; `granularity` belongs to `modules`.

### 3.2 The repo map
- `conversation/context_injection.rs::inject_repo_map`, called right after `inject_ide_context`
  in the turn loop (`conversation/mod.rs`).
- **First user message, not the latest.** At the head it sits in the provider's cached prefix and is
  billed once; on the newest message it would re-send ~5k tokens every turn.
- **Memoized** per runtime (`ConversationRuntime.repo_map: Arc<OnceLock<Option<String>>>`). If the
  text changed between turns it would invalidate that same cached prefix.
- Budget in **tokens**: `DEFAULT_BUDGET_TOKENS = 5_000`, hard cap `MAX_BUDGET_TOKENS = 10_000`.
- Persisted JSONL stays verbatim — only the request body carries it. Same contract as `<ide_context>`.

### 3.3 Staleness
- `walk::signature` = (file count, newest mtime), stored in `BuildStats.signature`, re-walked before
  every answer. Deliberately NOT hooked into the 5 file-mutating tools — that would miss the user's
  other editor and `git checkout`.
- mtime is 1-second resolution, which is the **only** reason `op: "refresh"` exists.

### 3.4 Prompt
- `agent-prompt.ts` — the line "search for the symbol with grep" was **replaced**, not supplemented.
  Leaving it would keep pointing the model at grep (see the 2026-07-30 lesson: a tool description is
  executable policy).

### 3.5 Cache
- `%LOCALAPPDATA%\AuroraIDE\code-index\<sha256-16>.json`, write-then-rename, version-gated by
  `persist::FORMAT_VERSION`. Unknown layout → rebuild, never migrate.
- Uses **sha2**, not `DefaultHasher` like `checkpoints` (std's hasher is not stable across releases).
- `CodeIndexService::with_cache_root()` exists so tests never write to real AppData. **Use it.**

---

## 4. The verification flow — repeat this exactly

This is the loop that found every real bug. Unit tests found none of them.

### 4.0 Offline, with the in-tree measurement harnesses (start here)
Two `#[ignore]`d tests are the tuning loop. Both **build from source**, so a cache written by an
older format version cannot feed them stale numbers.
```bash
cd src-tauri
AURORA_INDEX_ROOT=E:/some/repo cargo test --lib repo_map_over_a_real_workspace     -- --ignored --nocapture
AURORA_INDEX_ROOT=E:/some/repo cargo test --lib resolution_over_a_real_workspace   -- --ignored --nocapture
AURORA_INDEX_ROOT=E:/some/repo cargo test --lib module_graph_over_a_real_workspace -- --ignored --nocapture
# add AURORA_INDEX_SYMBOL=AIOrchestrator to spot-check one symbol's definitions and caller counts
```
The second prints module-resolution success and the confidence split — that is the number to watch
when changing `resolve_module` or the cascade.

### 4.1 Offline, with the probe
```bash
cd src-tauri/probes/code-index && cargo build --release
cd /e/VOID-EDITOR/Aurora-Agent-IDE
./build/release/code-index.exe build <path> --out /tmp/x.json
./build/release/code-index.exe def <Name>     --index /tmp/x.json
./build/release/code-index.exe callers <Name> --index /tmp/x.json
```
`cargo test` does **NOT** rebuild the `bin` target — run `cargo build` or you will read stale numbers
and theorise about code that never ran.

### 4.2 Blind-test on an UNFAMILIAR repo
Index it **before reading any source**, write down falsifiable predictions, *then* open the files.
This is what caught the double-counted references; three passes over Aurora had not. Good targets:
`E:\QuantumHUB-Infrustructure\agent-studio\qg-native` (Python, 13 files),
`E:\QuantumHUB-Infrustructure\apps\quantumhub-client` (Electron, 728 files).

### 4.3 Live, driving the app with qg-probe
**UIA needs `deep: true`** — without it you get 2 nodes and it looks like the WebView is opaque.
```
mcp__qg-probe__set_target   {process_name: "aurora", title_contains: "Aurora Agent"}
mcp__qg-probe__dump_tree    {deep: true, view: "content", max_nodes: 40}
mcp__qg-probe__type_into    {id: "el_29456dbae6", text: "<prompt>", submit: true}
mcp__qg-probe__wait         {seconds: 30}
```
`el_29456dbae6` is the composer edit node; it has been stable across restarts but re-dump if typing
fails. Rust changes make `tauri:dev` rebuild and **relaunch** (~60-90s, new pid) — re-`set_target`
after every rebuild.

### 4.4 Ground-truth prompts (answers independently verified)
| Prompt | Correct answer |
|---|---|
| `Where is AIOrchestrator defined?` | `src/main/services/agent-hub/ai-orchestrator.ts:326` |
| `Who calls qgProbe?` | defined `native-probe/probe-daemon.ts:401` |
| `Outline src/main/services/database.ts` | 125 KB, 629 symbols — must outline, not read |
| `Who calls handle?` | must **refuse**: 7 ambiguous definitions |
| `Do NOT call any tools… name 4 service areas under src/main/services` | tests the repo map alone |

### 4.5 Independent evidence, separate from what the agent claims
```bash
ls -la "$LOCALAPPDATA/AuroraIDE/code-index/"
node -e "const j=require('<file>'); console.log(j.root, j.files.length, j.symbols.length)"
```
A real cache is megabytes with the workspace path inside. ~450-byte files are test leftovers.

---

## 5. State of the two hard problems

### 5.0 ✅ Resolution is import-aware (was: name-only)

The index used to match by name and refuse whenever a name was ambiguous. It now **resolves**.

Queries capture the module specifier in the **same match** as the imported name (`@import.module`,
`@import.local`). This has to happen inside one pattern — tree-sitter groups captures by match and
by nothing else, so two separate patterns lose the association permanently. `extract.rs` reads the
pairing before its per-capture loop.

`store::resolve(name, from_file)` then runs a cascade, strongest first, each step firing only if it
yields something: **Import → SameFile → SameDir → Ambiguous**. `references_to(&Symbol)` uses it to
return the usages of ONE definition, and a call site is only ever matched against callable kinds
(a struct field named `reset` no longer collects the calls of a function `reset`).

Measured on quantumhub-client (728 files, 655 ms):
```
5,691 imports  →  3,358 resolved to files · 2,243 external packages · 90 unresolved
                  (all 90 are .png/.webp/package.json — correctly not code)
79,256 ambiguous-name references → 65% now resolve (import 2.7 · same-file 51.8 · same-dir 10.4)
```
On Aurora itself, 6 of 5,415 specifiers fail for a reason that is not "this is an asset". The `@/`
→ `src/` alias and Rust `super::`/`crate::` both resolve.

**Do not "improve" this into always answering.** `Ambiguous` references are excluded from a usage
list and counted separately, because a list mixing proven and guessed callers reads as proven — the
2026-07-30 lesson, which this design is built around rather than against.

Idea ported from [`greysquirr3l/coraline`](https://github.com/greysquirr3l/coraline) (cloned to
`E:\VOID-EDITOR\_research\coraline`). **It is not a dependency and should not become one:** 597
downloads, one maintainer, and it carries SQLite + ONNX embeddings — the stack dropped at migration
v12. `github/stack-graphs`, the rigorous alternative, was **archived by GitHub in September 2025**.

### 5.1 ✅ Repo-map ranking (was the top open item)

**Was:** ask *"Do NOT call any tools… which file defines AIOrchestrator"* and the model answered
"it isn't shown in the provided repository map" — while correctly naming 4 service areas, so the
map was reaching it. `ai-orchestrator.ts` ranked **219th of 594**.

**Two attempts that failed, recorded so they are not retried:**
1. *by count of exported landmarks* — the file exports exactly ONE thing (the class at the heart of
   the app), scored 1, and lost to any file exporting 20 tiny types.
2. *by inbound reference count* — puts the Tailwind `cn()` helper and shared `types.ts` on top.
   Utility noise outranks architecture; a singleton is constructed once and used via an instance.

**What works** (`ai-orchestrator.ts` rank 219 → **10**, and it is in the rendered map):
- **Exported methods count toward the score.** A class with 45 methods is architecture whether or
  not its name appears in many files. This is the single change that fixed the case.
- **Kinds are weighted** — class/struct 4, trait 3, interface/enum/function 2, type 1.
- **Fan-in is distinct FILES, log-damped** — five calls in one file is one consumer.
- **Aggregation is concave** (scores summed with 1/n decay), so a file is judged by its strongest
  symbols and a bag of twenty types cannot out-sum one central class.
- **Selection is two-pass**: `DIR_CAP = 2` per directory first (60 directories covered vs 49 for an
  uncapped sort), then a refill pass ignoring the cap so a small flat repo is not starved.
- `FOOTER_RESERVE = 128` — the block used to overshoot its own budget by its closing tag and
  omission notice (20,068 chars against 20,000). Pinned by a test at four budget sizes.

Re-verify with §4.4's last prompt — it is a clean pass/fail.

### 5.2 Built since — coupling by kind, module graph, churn, Settings panel

Three ideas taken from evaluating `symgraph` (§7 records why it is not a dependency):

- **Coupling by kind.** `@ref.write` captures (assignment targets, compound assignment, `++`/`--`)
  in all four grammars. `usages` returns a `coupling` breakdown ordered by consequence, **writes
  first** — "12 modules assign to your field" and "12 modules call you" are different problems and
  one undifferentiated total cannot separate them.
- **`code { op: "modules" }`** (`code_index/module_graph.rs`) — fan-in/fan-out per group at
  `area` | `dir` | `file`, plus cycles. Two rules that make it useful rather than noise: edges are
  DISTINCT file pairs (a barrel importing 5 names is 1 dependency), and cycles past
  `MAX_REPORTED_CYCLE = 6` are summarised by size. symgraph reported ONE cycle spanning ~70
  directories on quantumhub-client; Aurora reports 10 cycles of 2–3 directories, each actionable.
  Tarjan is iterative on purpose — file granularity could otherwise blow the stack mid tool call.
- **Churn.** `walk::churn` runs one bounded `git log` at build time and stores commits per file.
  Folded into the repo-map score as a MULTIPLIER (`1 + 0.15*ln(1+commits)`), never additive, so it
  reorders files of similar importance instead of letting a busy config file outrank a core class.
  No git ⇒ factor 1.0 ⇒ structure-only ranking, exactly as before.
- **Settings → Agent → Code index** — `commands/code_index.rs` + `settings/CodeIndexCard.tsx`.
  Status + Rebuild, **no on/off toggle** (owner's decision). `code_index_status` never builds, so
  opening Settings on a large repo costs nothing; `rebuild` is `async` because a sync Tauri command
  runs on the UI thread.

Sanity check worth repeating: run `modules` on Aurora itself and it reports `src/apps → src/kernel`,
the single documented boundary violation, caused only by `kernel/store/useSettingsStore.ts`.

### 5.2a Two `#[allow(dead_code)]` items that are UNFINISHED, not dead

Both carry the reason in their doc comment. Do not delete either as "unused":

- **`CodeIndexService::invalidate`** — intended caller is the turn loop, right after a
  file-mutating tool succeeds. Staleness is normally caught by the walk fingerprint, but mtime has
  one-second resolution, so an edit landing in the same second as the previously-newest file is
  invisible — the only reason `op: "refresh"` exists. Calling this on every successful write closes
  that window. Unwired because `conversation/` has no single "a file changed" seam to hang it on;
  adding one is the actual work.
- **`CodeIndex::unreferenced`** — dead-code detection. Cheap and already computed, but the caveats
  are large (public API used outside the workspace, dynamic dispatch, macro/string reach) so a tool
  answer must be shaped as *candidates*, not findings, or a model will delete live code on its say-so.

Deleted in the same pass because they genuinely had no consumer: `CodeIndexService::clear`,
`CodeIndex::callers` (superseded by the resolved `references_to` — keeping it invited a future
reader to use the worse answer), `RawSymbol::qualified` (an exact duplicate of `Symbol::qualified`),
and two redundant re-exports. `with_cache_root` is now `#[cfg(test)]` — it IS used, by tests, and
`cargo check --lib` cannot see them.

**`cargo check` is not enough to judge this.** Removing the `CodeIndex` re-export left the lib build
clean and broke the TEST build, caught only by running `cargo test`.

### 5.3 Monorepo fixes — found by indexing a WHOLE monorepo, not one app

Both were invisible when testing against a single app. Indexing the parent repo exposed them in
minutes, which makes "test at monorepo scale" a permanent part of §4.

- **`packages/` was excluded**, as a .NET/NuGet output name. In a pnpm/yarn workspace it is where
  every first-class library lives. Measured: **282 source files across 4 workspace members indexed
  as ZERO**, and the exclusion saved nothing — a NuGet folder holds .dll/.nupkg/.xml, none of which
  is in a language this indexer reads. `bin` removed for the same reason (Node CLI entry points).
  `obj` kept: it is output in every ecosystem. After the fix: 1,262 → **1,544 files**, +6,178
  symbols. A regression test in `walk.rs` pins all of this.
  *This was only findable because `WalkStats::skipped_dirs` reports what it excluded — do not make
  that silent.*
- **Workspace libraries imported by PACKAGE NAME resolved to nothing.** `import { X } from
  '@scope/core'` looked like an npm dependency, so every cross-package edge disappeared and the
  whole-repo module graph returned **0 edges**. `walk::workspace_packages` now reads `package.json`
  `name` fields (depth ≤ 4, skip-list respected) into a name → directory map that is stored on the
  index and persisted; `resolve_module` consults it before calling a bare specifier external.
  Subpath imports (`@scope/core/sub`) resolve too.
- `persist::FORMAT_VERSION` **3 → 4** — older caches have no package map.

Measured at monorepo scale: 1,544 files / 46,625 symbols / 246,674 refs in **~1.1 s warm**. A 5.8 s
first run was a cold OS file cache, not a regression — re-measure before chasing it. Churn's
`git log` is ~107 ms even on a large history.

### 5.2b Still not built
- **Usages-warning before edits** — attach "N callers across M files" ahead of `file_edit`.
  `references_to` now makes this exact and cheap.
- **Per-project index exclusions** in the Settings panel (status + Rebuild shipped; exclusions did
  not, and there is no backend for them yet).
- **Languages beyond Rust / TypeScript / TSX / Python.** Measured: a 20-file C# project indexes as
  **0 files**. This is now the biggest real limitation — adding one is a grammar dep, a `.scm`, and
  one arm in `Lang::from_path` (Python took ~15 minutes).

### 5.3 Known limits (by design, document rather than "fix")
- Resolution is syntactic. It reads imports, not `tsconfig` paths / `package.json` exports / Cargo's
  module tree, and returns "unsure" rather than guessing. Ambiguous references are excluded from
  usage lists and counted separately — do not merge them in, see the lesson below.
- Same-file resolution cannot separate several same-named symbols in ONE file (three `handle`
  bindings in `profile-collector.ts` each report the same 10 reads). Callable-kind filtering keeps
  this out of the `usages` answer, which refuses non-callables outright.
- 4 files in Aurora need parse-error recovery: a variable named `using` (TS 5.2 keyword) confuses
  grammar 0.23.2. Harmless.

---

## 6. Remaining next steps, in order

1. **Add C# and other languages (§5.2b).** The largest real gap: a C# project indexes as 0 files.
2. **Usages-warning before edits** — cheap now via `references_to`; see §5.2b.
3. Consider extending resolution to re-export barrels (`export * from './x'`), which currently
   break the import chain one hop early.

**House rule reaffirmed 2026-08-10:** no real project, package, or repo names in `src/` or
`src-tauri/src/` — fixtures and comments use neutral names. Keep the measurement, drop the
identity. One pre-existing leak is left for the owner to judge:
`src/apps/agent/components/theme/StreamingDotMatrix.tsx:10` credits a private project by name.

---

## 7. Tools evaluated, and why they are not dependencies

- **`greysquirr3l/coraline`** — its import → same-file → same-dir resolution cascade is the design
  §5.0 is built on, and porting it took ~200 lines. As a dependency it is wrong: 597 downloads, one
  maintainer, and it carries SQLite + ONNX embeddings, the stack dropped at migration v12.
- **`symgraph`** (`E:\VOID-EDITOR\symgraph-2026.8.1-windows-x64`) — source of the three ideas in
  §5.2. Its answers were measurably worse on the same repos: `impact ScreenReader` reported 6
  inbound edges from a file containing zero mentions of it (it matched the bare name `Set` and
  attributed an unrelated `HaloOverlay.Set`), `callers AIOrchestrator` found nothing for a class
  that is constructed in `main/index.ts`, and `diff-impact` returned "no symbols affected" for two
  real regions. It indexes the minified `index.js` bundle Aurora's line-shape check excludes, and
  its index is 22 MB against Aurora's 4.9 MB for the same repo with fewer symbols. It does cover
  many more languages, which is the one axis where it genuinely wins — see §5.2b.
- **`github/stack-graphs`** — the rigorous answer to precise name resolution. **Archived by GitHub
  in September 2025.** Do not build on it.

---

## 8. Hard-won lessons (full text in `.knowledge/lesson.md`)

- **An advisory caveat in a tool result is not a safeguard.** `usages` returned a merged caller list
  plus an `ambiguous` field; the model dropped the field and presented 27 callers of 23 unrelated
  things as one answer — worse than grep, which at least *looks* messy. Fixed by returning **no
  caller list at all** when ambiguous. If a result can be misread by dropping one field, remove that
  field's subject from the payload instead of warning beside it.
- **A refusal must not name an impossible next step.** The first version said "re-ask with a
  qualified name" for 7 module-level functions that have no container — no such name exists.
- **Blind-test on an unfamiliar repo** or you only ever confirm yourself.
- **Line shape, not bytes, detects generated code.** A 1.9 MB minified `index.js` was 88% of a build
  and 34% of its symbols while sitting *under* the 2 MB size cap.
- **`ignore` drops .gitignore outside a git repo** unless `require_git(false)`. Aurora's `grep` uses
  the same crate — worth checking there.
- **A service that writes to app data will have its tests write to app data.** All 32 tests passed
  while polluting real `%LOCALAPPDATA%`.
- **`cargo test` does not rebuild the `bin` target.**

---

## 9. State

**Shipped and live** (cache format v6 as of 2026-08-15). Live-verified in `tauri:dev` against a
real Electron client: `definition` line-exact, the repo map answers §4.4's tool-free prompt
correctly, and the model reaches for `code` unprompted. The adversarial audit (2026-08-15)
fixed aliased imports, side-effect imports/re-exports in the module graph, and Rust `let`
binding shadowing — each with regression coverage at the owning layer.

Measured, same repo (728 files): index 4.9 MB / 655 ms; 5,691 imports → 3,358 resolved to files,
2,243 external packages, 90 unresolved (all assets); 65% of ambiguous-name references now resolve;
module graph 173 directories / 529 edges / 10 small cycles.
