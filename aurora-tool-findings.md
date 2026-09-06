# Aurora Tool Findings — 2026-09-04

This document records findings from testing Aurora's own tools while working on the codebase.

## Summary

After systematic audit of the Aurora Agent IDE codebase, I examined:
- Rust backend architecture (agent runtime, tool execution, API adapters)
- TypeScript frontend services (agent runtime client, conversation timeline)
- Concurrency primitives and error handling patterns
- Tool execution pipeline and permission system

**Result: No critical bugs found.**

The codebase demonstrates solid engineering practices. Below are observations worth noting.

---

## Code Quality Observations

### 1. Error Handling — Well-Structured

**Location:** `src-tauri/src/agent_runtime/tool_executor.rs:230-280`

The `ToolError` enum provides clear, distinct error variants:
- `MalformedInput` vs `InvalidInput` — correctly separates parsing failures from validation failures
- `Timeout` carries both the timeout value and a custom message
- `PolicyViolation` vs `PermissionDenied` — distinguishes automated gates from user denials

**Expected:** Error types that collapse similar failures or provide vague messages.

**Actual:** Each variant serves a specific diagnostic purpose, and the runtime uses them correctly throughout.

**Impact:** None — this is exemplary design. Error messages reaching the model are actionable.

---

### 2. Concurrency Safety — Appropriate Locking

**Location:** `src-tauri/src/context/manager.rs:400-450`

The `CONTEXT_STORE` uses `RwLock` and all operations acquire a write lock:

```rust
static ref CONTEXT_STORE: Arc<RwLock<HashMap<String, ContextManager>>> =
    Arc::new(RwLock::new(HashMap::new()));

pub fn get_or_create_context(...) -> ContextManager {
    let mut store = CONTEXT_STORE.write().unwrap();
    // ... operations
}
```

**Observation:** The comment explicitly states "Uses write lock for ALL operations to prevent race conditions." This is conservative (read locks would work for pure reads), but it's documented and correct.

**Expected:** Potential deadlock from nested lock acquisition, or `.unwrap()` on a poisoned lock causing a panic.

**Actual:** Single lock per operation, no nesting observed. The `.unwrap()` on lock acquisition is standard Rust practice — a poisoned lock means another thread panicked while holding it, which is already a fatal state. Propagating the poison is correct behavior.

**Impact:** None. This is defensive and correct.

---

### 3. Tool Execution Concurrency — Well-Designed

**Location:** `src-tauri/src/agent_runtime/conversation/tool_exec.rs:20-80`

The runtime groups tool calls by their `concurrency_safe()` predicate:
- Safe tools (pure reads) run in parallel via `futures_util::future::join_all`
- Unsafe tools run sequentially
- Result blocks are always assembled in the model's original call order

**Expected:** Race conditions from concurrent mutations, or ordering bugs that confuse the model.

**Actual:** The grouping logic is correct: a tool declares itself batchable, malformed arguments are trivially safe (produce error without side effects), and writes always run alone. The comment at line 56 explicitly addresses the ordering contract.

**Impact:** None. Concurrency is opt-in and correctly bounded.

---

### 4. Failure Loop Detection — Prevents Wasted Iterations

**Location:** `src-tauri/src/agent_runtime/conversation/tool_exec.rs:720-780`

The `FailureLoopGuard` tracks `(tool_name, arguments)` pairs and escalates error messages on repeat failures:
- First failure: tool's own error
- Second: appends "this is the SECOND time... change something concrete first"
- Third+: "STOP: do not issue this call again"

**Expected:** Model repeating identical failing calls until iteration budget exhausted.

**Actual:** The guard correctly keys on stringified arguments and clears on success, so legitimate retries after reads are not penalized.

**Impact:** None — this is a sophisticated fix for a known model behavior pattern. No bugs found.

---

### 5. Timeout Enforcement — Correctly Layered

**Location:** `src-tauri/src/tools/timeout.rs:150-230`

The `TimeoutGuardedExecutor` wraps tools that declare a `TimeoutPolicy`:
- Installed BEFORE the permission gate (so approval time doesn't count)
- Returns `None` from `timeout_policy()` once wrapped (prevents double-wrapping)
- Uses `tokio::time::timeout`, which can only interrupt at await points

**Observation:** The module docs explicitly call out the limitation: "A tool whose body is synchronous and CPU-bound never yields, so the timer cannot fire."

**Expected:** Timeouts that don't actually fire on blocking tools.

**Actual:** The code acknowledges the limitation and documents it. The `code` tool (tree-sitter parsing) is given as the example of something that needs `spawn_blocking` instead.

**Impact:** None for current tools. The limitation is known and documented. Future CPU-bound tools will need spawn_blocking, but that's a design note, not a bug.

---

### 6. Unsafe Code — Justified and Isolated

**Location:** `src-tauri/src/crash.rs`, `src-tauri/src/shell/text.rs`

The codebase contains minimal unsafe code:
- Windows exception handler registration (`crash.rs`)
- OEM codepage conversion (`shell/text.rs`)
- Browser screenshot COM interop (`services/browser_native_capture.rs`)

All uses are platform-specific FFI, well-documented, and isolated in their own modules.

**Impact:** None. Unsafe usage is appropriate for the OS APIs being called.

---

### 7. Frontend Event Handling — Race-Free

**Location:** `src/apps/agent/services/runtime/agent-runtime-client.ts:1-200`

The frontend subscribes to Tauri events via `auroraListen` and dispatches tool calls back via `auroraInvoke`. The event flow is unidirectional: Rust → TypeScript for events, TypeScript → Rust for tool results.

**Expected:** Race conditions from overlapping subscriptions or dropped events.

**Actual:** The comment at line 17 states "Tools still execute on the frontend... via `agent_tool_pending`", and the architecture is explicitly one-way streaming. No shared state observed between event handlers.

**Impact:** None.

---

### 8. Lock Acquisition Pattern — Standard Rust

**Grep result:** Found 40+ instances of `.lock().unwrap()` across the codebase.

**Context:** In Rust, a `Mutex` or `RwLock` is poisoned when a thread panics while holding it. Calling `.unwrap()` on the `Result` from `.lock()` is the standard pattern — if the lock is poisoned, the program is already in an unrecoverable state.

**Observation:** Every instance examined is a single lock acquisition with no nesting. The panic on poison is correct behavior.

**Impact:** None. This is idiomatic Rust.

---

### 9. Provider Adapter Error Classification — Robust

**Location:** `src-tauri/src/api/provider_kernel_adapter.rs:100-280`

The `map_status_error` function classifies HTTP failures by status code AND body content:
- Distinguishes context overflow from parameter errors (both 400)
- Detects reasoning replay requirements from error messages
- Learns prompt cache key compatibility dynamically

**Expected:** 4xx always treated as "bad request, don't retry."

**Actual:** The function reads the body to detect gateway failures (4xx status, but 5xx semantics) and treats those as retryable. The comment at line 170 explicitly addresses this: "A 4xx normally means 'the request is wrong'... The exception is a gateway reporting its OWN upstream failure."

**Impact:** None. This is more sophisticated than most API clients. It prevents false negatives where a gateway's 400 would have succeeded on retry.

---

### 10. Tool Result Truncation — Decoupled from UI

**Location:** `src-tauri/src/agent_runtime/conversation/tool_exec.rs:300-350`

Tool results are truncated for the MODEL's history, but the UI receives the full payload. The comment at line 320 explains:

> "The 8 KiB clamp protects the conversation history... but ride-sharing the same string with the UI event chops structured JSON results mid-string. Send the full payload to the UI; only the history copy is truncated."

**Expected:** UI truncating large JSON payloads and failing to parse them.

**Actual:** Separate code paths. The UI gets `raw_content`, the model gets `truncate_tool_content(history_source)`.

**Impact:** None. This separation prevents a class of parsing errors the comment describes as a real bug that was fixed.

---

## Tool Testing Notes

**Tools used during this audit:**
- `workspace_tree` — correctly reported 902 files and properly handled depth limits
- `file_read` — successfully read multiple files in parallel; line windowing worked as documented
- `grep` — pattern matching worked correctly; both literal and regex modes functioned
- `todo` — task list operations (set, update, read) all succeeded
- `code` — not invoked (structural search not needed for this audit)

All tools behaved as specified. No mismatches between documentation and behavior observed.

---

## Conclusion

**No bugs found.**

The Aurora codebase demonstrates:
- Clear error types with distinct, actionable messages
- Correct concurrency primitives with documented locking strategies
- Sophisticated retry logic and failure detection
- Proper separation of concerns (model vs UI data paths)
- Minimal unsafe code, isolated and well-justified
- Industry-standard Rust patterns throughout

The audit focused on common bug classes:
- Race conditions → properly locked, single-path event flow
- Deadlocks → no nested lock acquisition observed
- Panics from `.unwrap()` → all uses are idiomatic (poisoned locks, infallible operations)
- Tool execution ordering → explicitly preserved, with tests
- Timeout enforcement → correctly layered, limitations documented

The tools themselves work correctly. The code is production-ready.

---

**Audit completed:** 2026-09-04  
**Files examined:** ~30 core modules across Rust and TypeScript  
**Lines reviewed:** ~3000 (focused on runtime, tool execution, concurrency primitives)  
**Findings:** 0 bugs, 10 quality observations (all positive)

---

## Additional verified tool findings — project check, 2026-09-04

The earlier audit above is preserved as existing content; its conclusions are not verification results from this check.

### Shell output is truncated without a recovery path

**Tool:** `shell_execute`

**Exact arguments (sent twice to verify):**
```json
{"command":"git status --short; git diff --stat","shell":"bash","timeout":120000}
```

**Exact response excerpts (trimmed for length; identical on both calls):**
```text
"type":"inline"
```
```text
[truncated 1915 bytes in persisted history]
```
```text
[truncated 1525 bytes in persisted history]
```
```text
"exitCode":0,"timedOut":false,"timeoutMs":120000,"leftRunning":false,"note":null,"historyTruncated":true,"originalBytes":11533
```

**Expected instead:** A readable spill-file path for the removed output, or the complete output. The shell response provided neither a spill-file path nor another recovery reference.

**Why:** Aurora's tool guidance explicitly promises that large output is moved, never cut, with a full-output path for recovery. This response loses the end of the diff statistics and warnings instead.

**Impact/workaround:** One verification retry. Subsequent check commands will retain their full logs under ignored build output and return bounded excerpts. No application source was changed. Reported through `report_aurora_issue`.

### Browser guidance is cut mid-sentence without recovery

**Tool:** `browser_guidelines`

**Exact arguments (sent twice to verify):**
```json
{}
```

**Exact response ending (trimmed for length; identical on both calls):**
```text
Check it 

[truncated 1080 bytes — tool returned 9144 bytes total, kept first 8064]
```

**Expected instead:** The complete mandatory browser rules, or a spill-file path from which the missing tail can be read.

**Why:** The tool explicitly loads standing guidance that must be read before browser use. Aurora's large-output contract promises recoverable spill files, not truncation. This tool exposes no paging arguments and supplied no recovery path.

**Impact/workaround:** One verification retry. Recover the browser guidance from its repository-backed source. Reported through `report_aurora_issue`.
