# Aurora Rust Agent Migration — Master Plan

**Status:** approved scope; implementation in progress
**Goal:** retire Aurora's TypeScript agent loop and tool layer, move all hot-path orchestration into Rust, modeled on `E:\VOID-EDITOR\claw-code\rust`.
**Strategy:** in-place replacement, no compatibility shim. Rollback via git/checkpoints.
**Source of truth for design:** synthesis of 5 scout reports (Phase 1–5).

---

## 1. Why we're doing this

The TS agent layer at `src/services/agent-service.ts` is the fragile center of the IDE:

- Tool execution races between TS, Tauri IPC, and Rust file I/O on every iteration.
- Cancellation is best-effort because it relies on JS event loop cooperation.
- Tool schemas, executors, and approval state are split across TS/Rust with no single source of truth.
- The hand-rolled SSE parser in `provider_kernel/streaming.rs` has **three confirmed bugs** (frame splitting, UTF-8 chunk boundaries, dropped `signature_delta`).
- The recently fixed `normalize_line_endings` UTF-8 panic is symptomatic — Rust panics in tool code take down the whole IDE because of `panic = "abort"`.

`claw-code/rust` solves all of these with a clean, trait-based, single-process agent runtime. We adopt its shape, keep Aurora-specific features (MCP, checkpoints, semantic search, multi-window), and delete the TS scaffolding underneath.

---

## 2. Current state — verified facts

These were spot-checked by the parent agent before this plan was written; do not re-verify before implementing.

| Claim | Verified |
|---|---|
| `provider_kernel/streaming.rs:59` splits on `'\n'` (line) instead of `"\n\n"` (SSE frame) | ✓ |
| `provider_kernel/streaming.rs:56` calls `from_utf8_lossy` on raw chunks before buffering | ✓ |
| Cancellation polls a `RwLock<HashMap<String,bool>>` once per chunk loop iteration | ✓ |
| `signature_delta` is never parsed anywhere in `provider_kernel/` (breaks Anthropic multi-turn thinking) | ✓ |
| `commands/openai_native.rs` has **zero** frontend callers (registered in `lib.rs:202-203`, but no `auroraInvoke('openai_native_*')` exists in `src/`) | ✓ |
| TS provider classes (`OpenAIProvider`, `AnthropicProvider`) were already deleted in an earlier phase; `src/services/providers/index.ts` instantiates only `RustProvider` | ✓ |
| Aurora chat history is JSONL on disk (`%APPDATA%/.../threads/*.jsonl`), **not** SQLite — schema v13 dropped the threads table | ✓ |
| `claw-code/rust/crates/runtime/src/bash_validation.rs` is ~30KB, 5-stage pipeline | ✓ |

---

## 3. Target architecture

```
┌─────────────────────────────────────────────────────────┐
│  Frontend (React/TS) — UI ONLY, no agent logic         │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐        │
│  │ChatPanel   │  │AgentMode   │  │PendingChg  │        │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘        │
│        │ agent_chat_v2 │ agent_cancel  │ approve/deny  │
└────────┼───────────────┼───────────────┼──────────────-┘
         │               │               │
         ▼ Tauri IPC ────▼───────────────▼
┌─────────────────────────────────────────────────────────┐
│  Rust backend                                           │
│                                                         │
│  agent_runtime/   ◄── Phase 1 + 2 (NEW MODULE)         │
│   ├── types.rs        (ContentBlock, ConversationMsg)  │
│   ├── session.rs      (Session + JSONL persistence)    │
│   ├── events.rs       (AssistantEvent enum)            │
│   ├── conversation.rs (ConversationRuntime — agent loop)│
│   ├── ipc.rs          (Tauri command handlers)         │
│   └── tools/          (ToolExecutor trait + registry)  │
│                                                         │
│  agent_safety/    ◄── Phase 3 (NEW MODULE)             │
│   ├── bash_validation.rs (5-stage shell sandbox)       │
│   └── paths.rs           (workspace boundary, symlink) │
│                                                         │
│  api/             ◄── Phase 5 (NEW, replaces           │
│   ├── client.rs        provider_kernel)                │
│   ├── sse.rs                                           │
│   ├── anthropic.rs                                     │
│   └── openai_compat.rs                                 │
│                                                         │
│  Existing — kept as-is:                                │
│   - mcp/, checkpoints/, undo_redo/, db/                │
│   - context engine (extended for new types)            │
│   - semantic search, git, terminal, browser            │
└─────────────────────────────────────────────────────────┘
```

---

## 4. Phased rollout

| Phase | Scope | Risk | Depends on |
|---|---|---|---|
| **1** | Foundation: types, session, events, IPC contract types | low (pure new code) | — |
| **2** | `ConversationRuntime` agent loop + `agent_chat_v2` command | high (replaces hot path) | 1 |
| **3** | Tool executors port (24 tools) + bash sandbox + path safety | high (cross-cuts everything) | 1 |
| **4** | Async permission prompter + hooks system + recovery | medium | 1, 2 |
| **5** | Provider restructure into `api/` + fix 3 SSE bugs + delete `openai_native` | medium | — (independent) |
| **cleanup** | Delete TS agent layer (`agent-service.ts`, `agent-prompt.ts`, `tool-converter.ts`, executors/) | low | 2, 3, 4, 5 |

Phases **1, 3-subset, 5** are file-disjoint and can run **in parallel right now**. The first parallel batch is the subject of this plan.

---

## 5. First parallel batch — 3 implementers

Each implementer:

1. Writes **only** to its assigned directories.
2. Does **not** modify `src-tauri/src/lib.rs` — reports what should be registered, parent agent integrates afterward.
3. Verifies its own work with `cargo check --lib --no-default-features --features cpu-only` and any unit tests it adds.
4. Returns a structured report: files written, public surface, registration TODO list, test results, deviations from brief.

**Model for all three: `claude-opus-4-7-thinking-xhigh`** (per established preference).

---

### 5.1 Implementer A — Foundation types (`agent_runtime/`)

**Write zone:** `src-tauri/src/agent_runtime/` (new directory; create everything)
**Read zone:** `E:\VOID-EDITOR\claw-code\rust\crates\runtime\src\{session.rs, conversation.rs}`, `src-tauri/src/services/thread_service.rs`, `src-tauri/src/context/types.rs`, `src/types/index.ts`

**Deliverables (new files):**

```
src-tauri/src/agent_runtime/
├── mod.rs           — re-exports + module wiring
├── types.rs         — MessageRole, ContentBlock, ConversationMessage, TokenUsage
├── session.rs       — Session struct, append/load/iterate (no I/O yet — pure model)
├── events.rs        — AssistantEvent enum, TurnCompletion summary
├── ipc.rs           — Tauri-facing request/response DTOs (no #[command] yet)
└── error.rs         — RuntimeError enum + thiserror impls
```

**Type contract (must match exactly):**

```rust
// types.rs
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum MessageRole { System, User, Assistant, Tool }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text { text: String },
    Thinking {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    ToolResult {
        tool_use_id: String,
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TokenUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_creation_input_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_input_tokens: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationMessage {
    pub role: MessageRole,
    pub blocks: Vec<ContentBlock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
    pub timestamp: i64,  // unix millis
}

// events.rs — events streamed to the frontend during a turn
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AssistantEvent {
    Thinking { text: String, signature: Option<String> },
    TextDelta { delta: String },
    ToolUse { id: String, name: String, input: serde_json::Value },
    Usage(TokenUsage),
    MessageStop { stop_reason: String },
    Error { message: String, recoverable: bool },
}

// ipc.rs — wire types only (no #[tauri::command] in this phase)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentChatRequest {
    pub turn_id: String,        // ULID
    pub thread_id: String,
    pub user_message: String,
    pub provider_id: String,
    pub model: String,
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentEventEnvelope {
    pub turn_id: String,
    pub seq: u64,                // monotonic per turn
    pub event: AssistantEvent,
}
```

**Required tests (in `#[cfg(test)] mod tests` per file):**

- `ContentBlock` round-trips through `serde_json::to_value` then back, for each variant.
- `Thinking` variant with `signature: Some(_)` must round-trip without losing the signature.
- `ToolResult` with `is_error: None` must serialize **without** the `is_error` field present (verify with `to_string` containing/not-containing).
- `ConversationMessage` with no usage must omit the `usage` field on the wire.
- `AssistantEvent::ToolUse` JSON shape must include `"type": "tool_use"`, `"id"`, `"name"`, `"input"` keys (string assertion).

**Must NOT:**
- Touch `lib.rs` (parent will add `pub mod agent_runtime;`).
- Add Tauri commands (`#[tauri::command]`). Wire types only.
- Touch any existing file outside `agent_runtime/`.
- Implement `Session` persistence yet — just the in-memory struct + `append_message`, `messages()`, `clear()` methods.

**Verification before reporting done:**

```powershell
cd E:\VOID-EDITOR\Aurora-Agent-IDE\src-tauri
cargo check --lib --no-default-features --features cpu-only
# expect: clean build (only ignore the new module's "unused" warnings)
```

**Report format:** see § 7.

---

### 5.2 Implementer B — Provider hardening (`provider_kernel/` surgical fixes + scaffold `api/`)

**Write zone (modify):**
- `src-tauri/src/commands/provider_kernel/streaming.rs` — fix 3 bugs in place
- `src-tauri/src/commands/provider_kernel/parsers.rs` — add `signature_delta` parsing
- `src-tauri/src/commands/provider_kernel/types.rs` — extend `AnthropicStreamEvent` for `signature_delta`

**Write zone (create):**
- `src-tauri/src/api/` (new directory; scaffolding only — empty trait stubs, no full impl)

**Write zone (delete):**
- `src-tauri/src/commands/openai_native.rs` (entire file — verified zero callers)

**Read zone:**
- `E:\VOID-EDITOR\claw-code\rust\crates\api\src\{sse.rs, client.rs, anthropic.rs, openai_compat.rs}`
- existing `provider_kernel/` (full module)
- `src-tauri/src/lib.rs:200-205` (so you can list what registrations to remove)

**Three bugs to fix in place:**

#### Bug 1 — SSE frame parser

**Current (broken):** lines 38-65 of `streaming.rs`

```rust
let text = String::from_utf8_lossy(&chunk);    // bug 1a — UTF-8 corruption at chunk boundary
buffer.push_str(&text);
while let Some(newline_pos) = buffer.find('\n') {  // bug 1b — splits on line, not frame
    let line = buffer[..newline_pos].to_string();
    ...
}
```

**Required fix:**

1. Maintain a `Vec<u8>` byte buffer instead of a `String`. Append raw `chunk` bytes.
2. After each append, scan the byte buffer for `b"\n\n"` (frame terminator) and split off complete frames.
3. For each complete frame, attempt `std::str::from_utf8(&frame)` — on `Err` (mid-character split, but frames terminate on `\n\n` which is always ASCII so this should not happen for valid SSE), drop the frame and emit a soft warning.
4. Within a UTF-8-clean frame, iterate **lines** with `frame.split('\n')`, ignore lines that don't start with `data:`, parse each remaining `data:` payload separately. (SSE allows multiple `data:` lines per frame; current code already de-facto handles them because it line-splits, but we must keep that behavior after switching to frame-split.)
5. Add a regression test for: chunk arrives split mid-`data:` line, then completes; multi-byte UTF-8 char split across two chunks; multi-`data:` frame.

#### Bug 2 — Cancellation via `CancellationToken`

**Current (broken):** `RwLock<HashMap<String, bool>>` polled at line 43 once per chunk; cancel can take seconds under slow connections.

**Required fix:**

1. Add `tokio_util` to `src-tauri/Cargo.toml` if not already present (it isn't — verify).
2. Replace `ACTIVE_PROVIDER_STREAMS: RwLock<HashMap<String, bool>>` with `RwLock<HashMap<String, CancellationToken>>`.
3. `register_stream` returns the `CancellationToken` (cloned).
4. `cancel_stream(id)` calls `token.cancel()`.
5. In the chunk loop, wrap the `stream.next()` call in `tokio::select!`:
   ```rust
   tokio::select! {
       biased;
       _ = cancel_token.cancelled() => return Err("Request cancelled".to_string()),
       chunk_result = stream.next() => { ... }
   }
   ```
6. Apply the same pattern to `stream_anthropic` (currently at `streaming.rs` further down — same bug).
7. Drop `is_stream_cancelled` and the polling-style call sites.

#### Bug 3 — `signature_delta` parsing (Anthropic multi-turn thinking)

**Current (broken):** `parsers.rs` parses Anthropic deltas and accumulates `text` for `thinking` blocks but silently drops `signature_delta` events. Multi-turn requests fail with 400 because Anthropic requires the original signature echoed back.

**Required fix:**

1. In `provider_kernel/types.rs`, extend `AnthropicStreamEvent` (or whichever struct represents `content_block_delta`) to include a `signature_delta` variant.
2. In `parsers.rs`, when encountering a `signature_delta`, accumulate it into the active thinking block's `signature` field (string concatenation across deltas).
3. Emit the accumulated signature on the per-block `aurora-provider-thinking-signature-{request_id}` Tauri event so the frontend can store it for the next turn (frontend persistence is a follow-up — for now just emitting is enough; verify the event reaches the FE via console.log in dev mode).
4. Add a unit test that feeds a known-good Anthropic SSE stream containing `signature_delta` events and asserts the accumulated signature matches the expected value.

**Reference fixture:** copy a real Anthropic thinking-stream capture from `claw-code/rust/crates/api/tests/fixtures/` if any exist; otherwise hand-craft one in a `#[cfg(test)] const STREAM: &str = ...` constant.

#### Delete `openai_native.rs`

1. Delete the file.
2. Remove lines 202-203 of `src-tauri/src/lib.rs`:
   ```rust
   commands::openai_native::openai_native_stream,
   commands::openai_native::openai_native_chat,
   ```
3. Remove the `pub mod openai_native;` line in `src-tauri/src/commands/mod.rs`.
4. Run `cargo check` to confirm nothing breaks.

#### Scaffold `src-tauri/src/api/`

Create this skeleton (empty trait stubs only — no full implementations yet; that's a later phase):

```
src-tauri/src/api/
├── mod.rs          — pub mod client; pub mod sse; ...
├── client.rs       — `pub trait ApiClient { async fn stream(...) -> ... }` (signature only, no impl)
├── sse.rs          — empty placeholder (claw-code's IncrementalSseParser port lives here next phase)
├── anthropic.rs    — empty (impl lives here next phase)
└── openai_compat.rs — empty (impl lives here next phase)
```

**Required tests:**

- Frame splitter: 1 test for clean frames, 1 for split-mid-frame, 1 for multi-`data:` frame.
- UTF-8 chunk boundary: 1 test where a 4-byte emoji is split across two chunks.
- Cancellation: 1 test that calls `cancel_stream` mid-stream and verifies the loop returns within a single iteration (use `tokio::time::timeout` to bound).
- `signature_delta` accumulation: 1 test as described.

**Must NOT:**
- Wire `api/` to anything yet — it's just empty scaffolding.
- Modify `lib.rs` for the new `api` module (parent will add `pub mod api;`).
- Touch any other existing module (mcp, context, db, etc.).

**Verification before reporting done:**

```powershell
cd E:\VOID-EDITOR\Aurora-Agent-IDE\src-tauri
cargo check --lib --no-default-features --features cpu-only
cargo test --lib --no-default-features --features cpu-only -p aurora_agent --lib commands::provider_kernel
```

If the `cargo test` invocation hits the same `STATUS_ENTRYPOINT_NOT_FOUND` issue we fixed earlier (DLL linkage), fall back to a standalone verification crate in `src-tauri/target/__verify_streaming/` like we did for `normalize_line_endings`. Report which path you took.

**Report format:** see § 7.

---

### 5.3 Implementer C — Safety primitives (`agent_safety/`)

**Write zone:** `src-tauri/src/agent_safety/` (new directory; create everything)
**Read zone:** `E:\VOID-EDITOR\claw-code\rust\crates\runtime\src\{bash_validation.rs, file_ops.rs}`

**Deliverables (new files):**

```
src-tauri/src/agent_safety/
├── mod.rs              — re-exports + module wiring
├── bash_validation.rs  — port of claw-code's bash_validation.rs (~30KB, 5-stage pipeline)
└── paths.rs            — workspace boundary + symlink check
```

**Port `bash_validation.rs`:**

1. Open `E:\VOID-EDITOR\claw-code\rust\crates\runtime\src\bash_validation.rs`. Read it end to end.
2. Copy the file verbatim into `src-tauri/src/agent_safety/bash_validation.rs`.
3. Adjust:
   - Crate-relative imports (e.g. `crate::error::ToolError` → use `super::error` or define a local `BashValidationError` if it's not yet wired).
   - Remove any `claw-code`-specific dependencies. The whole module should be **dependency-free** except `regex`, `lazy_static`, and stdlib.
   - Keep `pub fn validate_command(input: &str, mode: ExecutionMode) -> Result<(), BashValidationError>` as the single public entry point.
4. Port the unit tests from claw-code as-is. They should all pass.

**Implement `paths.rs`:**

```rust
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum PathSafetyError {
    #[error("path escapes workspace: {0}")]
    OutsideWorkspace(PathBuf),
    #[error("symlink target leaves workspace: {0} -> {1}")]
    EscapingSymlink(PathBuf, PathBuf),
    #[error("io error during canonicalization: {0}")]
    Io(#[from] std::io::Error),
}

/// Resolve `path` against `workspace_root`, canonicalize both, ensure
/// the resolved path is contained within the workspace. Follows symlinks
/// once and re-checks containment.
///
/// On Windows we use the `dunce` crate to strip UNC prefixes for
/// human-readable paths, but containment is checked on the canonicalized
/// (UNC-prefixed) form for correctness.
pub fn resolve_within_workspace(
    path: &Path,
    workspace_root: &Path,
) -> Result<PathBuf, PathSafetyError> {
    // 1. canonicalize workspace_root once
    // 2. join + canonicalize path
    // 3. starts_with check on canonical forms
    // 4. read_link if symlink, re-canonicalize, re-check
    // 5. return canonicalized resolved path
    ...
}

pub fn is_within_workspace(path: &Path, workspace_root: &Path) -> bool {
    resolve_within_workspace(path, workspace_root).is_ok()
}
```

**Required tests:**

- `paths::resolve_within_workspace` — happy path: relative path resolves inside workspace.
- `paths::resolve_within_workspace` — rejects `..` traversal that escapes workspace.
- `paths::resolve_within_workspace` — rejects symlink whose target is outside workspace (use `tempfile` + manual symlink creation; **skip on Windows** if symlink creation fails due to lack of admin/dev-mode — note in test).
- `paths::resolve_within_workspace` — accepts symlink whose target is inside workspace.
- `bash_validation::validate_command` — copy claw-code's tests verbatim (they cover ~40 destructive patterns).

**Add to `src-tauri/Cargo.toml`** (if not already present — verify first by reading the file):

```toml
dunce = "1"
# regex, lazy_static, thiserror should already be there
```

**Must NOT:**
- Wire `agent_safety` to any existing tool yet — that's Phase 3 proper.
- Modify `lib.rs` (parent will add `pub mod agent_safety;`).
- Touch any existing module.

**Verification before reporting done:**

```powershell
cd E:\VOID-EDITOR\Aurora-Agent-IDE\src-tauri
cargo check --lib --no-default-features --features cpu-only
cargo test --lib --no-default-features --features cpu-only -p aurora_agent --lib agent_safety
```

If `cargo test` hits the DLL linkage problem, fall back to a standalone verification crate (same pattern as `normalize_line_endings`) and report which path you took.

**Report format:** see § 7.

---

## 6. File-collision matrix

| File | Implementer A | Implementer B | Implementer C | Conflict? |
|---|---|---|---|---|
| `src-tauri/src/agent_runtime/**` | **WRITE** | — | — | none |
| `src-tauri/src/agent_safety/**` | — | — | **WRITE** | none |
| `src-tauri/src/api/**` | — | **WRITE** (scaffold only) | — | none |
| `src-tauri/src/commands/provider_kernel/**` | — | **WRITE** (3 bugs) | — | none |
| `src-tauri/src/commands/openai_native.rs` | — | **DELETE** | — | none |
| `src-tauri/src/commands/mod.rs` | — | **WRITE** (1-line removal) | — | none |
| `src-tauri/src/lib.rs` | reports addition | **WRITE** (2-line removal) | reports addition | **B only** — A/C report, parent integrates |
| `src-tauri/Cargo.toml` | — | **WRITE** (add `tokio_util`) | **WRITE** (add `dunce`) | **B + C** ⚠ |

**Cargo.toml conflict mitigation:** B adds `tokio_util = "0.7"` to `[dependencies]`. C adds `dunce = "1"` to the same table. Both append at the end of `[dependencies]`. To prevent merge conflicts:

- B writes its `tokio_util` line **immediately after** the existing `tokio = ...` line.
- C writes its `dunce` line **immediately after** the existing `regex = ...` line (or wherever the alphabetical position dictates — but consistently use anchor lines so the patches don't overlap).

Both implementers must include their full diff in the report so the parent can resolve any leftover conflict.

---

## 7. Required report format (each implementer)

Return a single block with these exact sections (markdown):

```markdown
## Files written
- list of paths, one per line, with absolute paths

## Files deleted
- (empty if none)

## Public surface
- top-level pub items (types, traits, functions) with one-line docs each

## Required parent integration
- exact lines to add to `src-tauri/src/lib.rs` (with surrounding context for StrReplace)
- exact lines to add to `src-tauri/Cargo.toml` (with surrounding context)
- any other manual integration step the parent must perform before the next phase

## Verification
- exact command run
- exit code
- relevant snippet of output (errors, test counts, warnings)

## Deviations from brief
- anything you did differently and why
- (empty if none)

## Open questions for parent
- blocking unknowns
- (empty if none)
```

---

## 8. Open design questions — defaults applied

These were raised by the scouts. The parent agent applies the following **defaults** for this batch; revisit during Phase 2/3/5 implementation:

| Question | Default | Rationale |
|---|---|---|
| Should non-streaming `chat()` survive the migration? | **No.** All providers route through the streaming path. Frontend never calls non-streaming. | Simplifies the trait surface; keeps one code path. |
| OAuth scope (Anthropic / Google / etc.)? | **Out of scope** for this entire migration. API key auth only. | Adding OAuth is a feature, not a migration concern. Defer. |
| Prompt-cache porting? | **Defer to a later phase.** Aurora's context builder doesn't yet emit `cache_control` markers. Telemetry-only for now via `AuroraUsage.cache_read_tokens`. | Porting `prompt_cache.rs` (~25KB) without a producer is dead weight. |

---

## 9. Verification gates

Before merging the first parallel batch, the parent agent must:

1. Run `cargo check --lib --no-default-features --features cpu-only` — must be clean (warnings about unused `agent_runtime` items are OK).
2. Run `cargo test --lib --no-default-features --features cpu-only` for the new modules — must pass.
3. Run `pnpm tauri:dev` and confirm the IDE still launches and basic chat (with the existing TS path, untouched by this batch) still works.
4. Confirm `openai_native` deletion didn't break anything by sending a chat request through every provider type (anthropic, openai, glm, deepseek).

---

## 10. Rollback strategy

- All three implementers' work lives behind new module names (`agent_runtime`, `agent_safety`, `api`) and surgical patches in `provider_kernel`. None of this affects the running TS agent path.
- If Implementer B's SSE fixes regress streaming, `git revert` the streaming.rs commit only — the new modules from A and C survive untouched.
- If A or C produces broken modules, the parent simply doesn't add the `pub mod` line in `lib.rs` — the modules sit on disk inert and can be deleted.

---

## 11. After this batch

Phase 2 (the actual `ConversationRuntime` agent loop in Rust) is the next implementation step and **must** run sequentially after this batch lands, because it depends on Phase 1 types and Phase 5's clean SSE path. Phase 3 tool executors and Phase 4 permissions/hooks come after Phase 2. Final cleanup (deleting `agent-service.ts` and friends) lands last.

---

*End of master plan.*
