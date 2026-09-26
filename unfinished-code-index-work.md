# Code index — 2026-08-31 session handoff

Historical handoff. The former failing Dart test now passes in the code-index suite. Current project-owned local builds, source search, storage and verification are documented in `DOCS/code-index-project-builds.md` (2026-09-22). The state and limitations below describe the August session, not the current implementation.

Everything changed today, what is verified, and the **one thing that is broken right now**.

Nothing is committed. All changes are in the working tree.

---

## STOP HERE FIRST — there is a failing test

```
cargo test --lib a_dart_class_and_its_constructor
```

**`tools::code_intel::tests::a_dart_class_and_its_constructor_are_two_named_declarations` FAILS.**

I added that test to pin behaviour I assumed was benign, and it caught a real bug instead. I was
mid-diagnosis when the session ended.

### The bug

A Dart class is reported as **contained by itself**. Looking up `Post` returns two definitions and
**both are qualified `Post::Post`**:

```
the class: ["Post::Post", "Post::Post"]
```

Expected: `["Post", "Post::Post"]` — the class, and its constructor qualified by the class.

### Diagnosis so far

`extract.rs::enclosing_container` (line ~226) starts at `node.parent()` and walks up looking for
`lang.is_container_node(kind)`.

For a Dart `class Post { … }`, the class NAME's direct parent **is** the `class_declaration`, and I
listed `class_declaration` in `Lang::Dart`'s `is_container_node` arm (`lang.rs`, ~line 258). So the
class's own name matches its own container and gets `container: Some("Post")`.

The constructor is correct — it genuinely sits inside the class.

### What I had not yet checked

**Why other languages do not hit this.** Swift also lists `class_declaration` in
`is_container_node`, so either it has the same bug and nobody noticed, or something upstream
subtracts a declaration's own name. Check `enclosing_container`'s callers in `extract.rs` (the
`for (node, captured_kind) in defs.values()` loop, ~line 700) before changing the walk — the fix
belongs wherever the existing languages already solve it, not in a Dart special case.

### Likely fix shapes (pick after checking the above)

1. In `enclosing_container`, skip a container node whose own `name:` field **is** the node we
   started from. Most general, fixes every language at once.
2. Start the walk at `node.parent().parent()` when the parent is a container whose name is this
   node. Narrower, same effect.
3. Drop `class_declaration` from Dart's `is_container_node` — **wrong**, it would orphan every
   method.

Prefer (1). Add the assertion to a Rust/Swift fixture too, so the general fix is pinned for every
language rather than just Dart.

### Blast radius if left broken

Dart classes answer `code definition` with a doubled, mis-qualified name. `code outline` and
qualified lookups (`Post::archive`) are probably also affected for Dart. Everything else measured
today still holds — see the numbers below, which were taken with this bug present.

---

## What shipped today and IS verified

Three separate pieces of work, all in the code index. Full write-ups are in
`.knowledge/knowledge.md` (three entries dated 2026-08-31).

### 1. CommonJS `require()` is an import edge

Reported by the agent itself via `report_aurora_issue` from an Electron workspace: `code
{op:"modules"}` answered `dependencies: 0` across eight directories that plainly require each
other.

- `queries/typescript.scm` — four `require()` patterns, gated with `#eq?`.
- **`ruby.scm`'s claim that predicates are not evaluated was FALSE** — `cursor.matches` is given
  the source as a text provider, so tree-sitter 0.26 applies `#eq?`. Comment corrected there.
- Pinned by a test asserting `console.log('./session')` does **not** become a module edge.

### 2. The cache directory is swept

Nothing had ever deleted a cache file: 34 files, 190 MB, fifteen in formats v4–v9 that no build
could read.

- `persist.rs::prune(dir, keep)` runs after each successful build. Wrong format → deleted. Past
  `KEEP_CACHES = 24` → oldest go. An unrecognised file is **left alone**.
- Version is read from the first 64 bytes, not by parsing (largest cache is 31 MB). A test pins
  that `version` stays `Packed`'s first field.

### 3. Dart / Flutter support (the 14th language)

- `tree-sitter-dart = "0.2"` in `Cargo.toml`.
- `queries/dart.scm` (new). Definitions derived from the grammar's own `queries/tags.scm`, so every
  node name is real. mixin/extension → `trait`, typedef → `type`, enum value → `variant`.
- `lang.rs` — `Lang::Dart` variant plus every match arm.
- `extract.rs` — `dart_body_name` / `dart_signature_name`, and the underscore visibility rule.
- `metadata.rs` — Dart `declaration_node` arm.
- `walk.rs` — `workspace_packages` now also reads `pubspec.yaml` `name:` via `pubspec_name`, and
  folds in the `lib/` Dart's own resolution rule requires.
- `store.rs` — `package:` and `.dart` branches in `resolve_module`, `.dart` in `EXTS`.

**Four things Dart does differently, each of which was a real bug first:**

- Signature and body are **siblings**, so the callable node is `function_body` and the name has to
  be walked back to the preceding signature.
- Visibility is a **leading underscore**, library-scoped. No keyword exists.
- `package:<own pubspec name>/…` is a **self-import** and must resolve; `package:flutter/…` must
  **miss**.
- A sibling is written **bare** (`'home_screen.dart'`, no `./`).

### 4. The resolution cascade gained an arm (helps every language)

A Dart import binds **no names** — it makes a whole library visible. The import arm needed a named
binding, so it fired on **0.0%** of ambiguous names.

`store.rs` now keeps `imported_files: HashMap<u32, Vec<u32>>` (`file -> files it imports`, resolved
once in `rebuild_lookups`). Used when nothing else resolved, ranked below same-file and above
same-dir, and **only when exactly one** imported file defines the name.

| workspace | import arm | still ambiguous |
|---|---|---|
| Flutter app, before | 0.0% | 50.3% |
| Flutter app, after | **26.4%** | **24.3%** |
| Aurora itself, after | 10.2% | 38.9% |

Not Dart-specific: it also picks up TypeScript barrels, side-effect imports, and the CommonJS rows
from item 1.

### Cache format

**v10 → v11** (require edges) → **v12** (Dart). Every cache on disk is orphaned; the first rebuild
after this ships collects all of them via the new prune.

`CLAUDE.md` updated: 14 languages, format v12.

---

## Measured on the real Flutter app

`E:/PayNu-Social/paynu_app` (72 `.dart` files):

```
98 files, 1166 symbols, 14771 refs, 381 imports, 489 ms
modules: 189 resolved, 192 external packages, 0 UNRESOLVED
2567 ambiguous-name references:
  import 677 (26.4%), same-file 1233 (48.0%), same-dir 34 (1.3%), still ambiguous 623 (24.3%)
```

**Zero unresolved module specifiers.** Note 98 files against 72 `.dart` — the rest are the
Kotlin/Swift/Java under `android/` and `ios/`, which were already indexed.

Re-run it with:

```sh
cd src-tauri
AURORA_INDEX_ROOT="E:/PayNu-Social/paynu_app" \
  cargo test --lib resolution_over_a_real_workspace -- --ignored --nocapture
```

Add `AURORA_INDEX_SYMBOL=TimelineService` to probe one symbol. **That probe is how the container
bug was found** — it reported `2 definition(s)` for every class.

---

## Test state

`cargo test --lib` → **1,769 passed** as of the last full run, **before** I added the failing
`a_dart_class_and_its_constructor_are_two_named_declarations`. So the current state is
**1,769 passing + 1 failing**.

`cargo fmt --all -- --check` was clean on every touched file at that point. The code_intel edit
that added the failing test has not been formatted — run `rustfmt` on it.

Note: an earlier backgrounded `cargo test` held the test binary and caused a
`rust-lld: permission denied` link error. If you see that, stop stray background cargo runs first.

---

## Files touched (all uncommitted)

```
src-tauri/Cargo.toml                              tree-sitter-dart
src-tauri/src/code_index/queries/dart.scm         NEW
src-tauri/src/code_index/queries/typescript.scm   require() patterns
src-tauri/src/code_index/queries/ruby.scm         corrected a false comment
src-tauri/src/code_index/lang.rs                  Lang::Dart everywhere
src-tauri/src/code_index/extract.rs               dart_body_name, underscore visibility, tests
src-tauri/src/code_index/metadata.rs              Dart declaration_node
src-tauri/src/code_index/walk.rs                  pubspec_name, pubspec in workspace_packages
src-tauri/src/code_index/store.rs                 imported_files, package:/.dart resolution, tests
src-tauri/src/code_index/persist.rs               prune(), v12
src-tauri/src/tools/code_intel/mod.rs             lua fixture, FAILING dart test
CLAUDE.md                                         14 languages, v12
.knowledge/knowledge.md                           three entries
```

---

## Also unverified (not broken, just not proven)

- **No live `tauri:dev` turn** has exercised Dart through the `code` tool. Everything above is
  tests plus the offline harness.
- The **`show` / `hide` combinators** on Dart imports are not captured as named bindings. The module
  edge is captured, so the graph is right; only per-name import resolution misses them.
- `part` / `part of` directives are captured as module edges but their "one library across several
  files" semantics are not modelled.
