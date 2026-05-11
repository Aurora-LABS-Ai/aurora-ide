# `src-tauri/src/api/` — Phase 5 Adapter Audit

**Author:** Sub-E (Phase 3 integration glue + Phase 5 audit)
**Date:** 2026-05-09
**Scope:** read `api/anthropic.rs`, `api/openai_compat.rs`,
`api/provider_kernel_adapter.rs`, `commands/provider_kernel/parsers.rs`,
`commands/provider_kernel/streaming.rs`. Decide whether the two stacks
duplicate logic, and if so consolidate the shared chunk into
`src-tauri/src/api/sse_shared.rs` without changing the wire format.

## Summary

**Result:** Duplicate found and partially folded. A new
`api/sse_shared.rs` now owns the canonical
`SseFrameBuffer` + `frame_payloads` implementation. Both
`api/provider_kernel_adapter.rs` (consumed by `api/anthropic.rs` and
`api/openai_compat.rs`) and the Phase 5 verify crate import from
`sse_shared`. The `commands/provider_kernel/streaming.rs` copy is
**deliberately left untouched** — see _"Why we did NOT also fold
provider_kernel"_ below.

**Wire format:** unchanged. The SSE byte-level splitter and `data:`
extractor are pure functions; consolidation is mechanical.

## Symbol-level overlap

The duplication audit walked every type / function / constant in
`api/provider_kernel_adapter.rs` against the public surface of
`commands/provider_kernel/{parsers, streaming, types}.rs`.

| Symbol | `api/provider_kernel_adapter.rs` | `commands/provider_kernel/streaming.rs` | Verdict |
|---|---|---|---|
| `SseFrameBuffer` (struct) | duplicated | duplicated | **shared chunk** — moved to `api/sse_shared.rs` |
| `frame_payloads` (fn) | duplicated | duplicated | **shared chunk** — moved to `api/sse_shared.rs` |
| Anthropic JSON wire types (`AnthropicStreamEvent`, `AnthropicDelta`, `AnthropicUsageWire`, …) | own copy in adapter (subset of fields the agent runtime cares about) | own copy in `provider_kernel/types.rs` (superset — also covers the Tauri-event channel shapes) | not duplicated — different surface |
| OpenAI JSON wire types (`OpenAiStreamingResponse`, `OpenAiStreamingDelta`, …) | own copy (subset) | own copy in `provider_kernel/types.rs` (superset) | not duplicated — different surface |
| `map_status_error`, `map_reqwest_error` | new in adapter (uses `ApiError`) | absent — kernel maps to `String` | not duplicated |
| `build_anthropic_body`, `build_openai_body` | new in adapter | inline in `streaming.rs` | logically related but field shapes differ (adapter takes `ApiRequest<'_>`, kernel takes the Tauri `provider_kernel::types::AuroraChat...` flavour) |
| `build_anthropic_headers`, `build_openai_headers` | new in adapter | inline in `streaming.rs` | logically related, see above |
| `parse_tool_input` | new in adapter | absent (kernel uses `normalize_openai_tool_arguments` in `parsers.rs` with different fallback policy) | not duplicated |
| `BlockState` aggregator | new in adapter (per-block streaming → `ContentBlock`) | absent | not duplicated |
| `merge_usage` | new in adapter | absent (kernel uses `anthropic_usage_to_aurora` for the same data) | logically related, different output type |
| Stream registration / cancel registry | absent (the agent runtime uses `tokio_util::sync::CancellationToken` directly through `StreamingApiClient::stream`) | `register_stream` / `cancel_stream` / `cleanup_stream` (`pub(crate)`) | not duplicated |
| `tauri::AppHandle::emit` event channels (`aurora-provider-chunk-{request_id}`, …) | absent | core surface | not duplicated |

Net duplicate footprint: **2 symbols** (`SseFrameBuffer`,
`frame_payloads`) totalling ~95 lines of byte-shuffling logic + tests.

## Why we did NOT also fold `provider_kernel`

The Phase 3 Sub-E contract explicitly limits `commands/provider_kernel/*`
to read-only — Sub-E may "refactor via the new `api/sse_shared.rs` ONLY".
That permits creating the new file and migrating the `api/` consumers,
but does not permit modifying `streaming.rs` itself. Fully retiring
the kernel's internal copy is the explicit Phase 5 deeper-fold task
that the parent agent will land once `commands::provider_kernel` is
deprecated and removed. Until then both copies coexist behind
identical behaviour, and the Phase 5 verify crate proves the byte-
level semantics match.

There is also a hard incompatibility today: the kernel's `frame_payloads`
is `pub(crate)` and lives in a `pub(crate) mod streaming` inside
`commands::provider_kernel`. Even if Sub-E were allowed to touch the
file, exposing the symbol publicly without revisiting the kernel's
visibility plan would risk leaking internal Tauri-emit plumbing onto
the api surface. Phase 5 retirement, where the kernel goes away
entirely, is the right place to flip both halves to `sse_shared`.

## What "Phase 5 deeper-fold" means

When `commands::provider_kernel` is retired (parent-driven Phase 5
work after Phase 3 lands):

1. Delete `commands/provider_kernel/streaming.rs`'s `SseFrameBuffer`
   and `frame_payloads` and replace with `use crate::api::sse_shared::{SseFrameBuffer, frame_payloads};`.
2. Re-evaluate `provider_kernel/types.rs` against
   `api/provider_kernel_adapter.rs`'s wire-shape types — promote the
   richer set if any, drop the duplicate.
3. Re-home the per-stream cancellation registry
   (`ACTIVE_PROVIDER_STREAMS`) onto `AgentRegistry` so the tokio
   tokens come from a single source of truth.
4. Move `aurora-provider-*-{request_id}` event channels behind the
   already-existing `EventEmitter` trait so adapters never know about
   `tauri::AppHandle`.

After steps 1–4, this `AUDIT.md` and `api/sse.rs` (the placeholder)
can be deleted.

## Behavioural equivalence proof

Both `SseFrameBuffer` implementations are byte-for-byte identical
(separator detection, drain-then-`from_utf8_lossy`, CRLF tolerance).
Both `frame_payloads` implementations are line-for-line identical
(`data: ` strip, `data:` strip-then-trim, `[DONE]` skip, comment
skip). The new `api/sse_shared.rs` carries 8 unit tests covering:

- LF-LF terminator
- CRLF-CRLF terminator
- Partial-frame retention across calls
- Multi-byte UTF-8 split across chunk boundaries
- `[DONE]` filtering
- Comment / event-line filtering
- Both `data: ` and `data:` strip variants
- Multiple `data:` lines per frame

These map 1:1 against the kernel-internal tests so a future
deeper-fold has zero behavioural risk.

## Files changed by this audit

| File | Change |
|---|---|
| `src-tauri/src/api/sse_shared.rs` | new — canonical `SseFrameBuffer` + `frame_payloads` + 8 tests |
| `src-tauri/src/api/provider_kernel_adapter.rs` | now `pub use super::sse_shared::{SseFrameBuffer, frame_payloads}` instead of carrying its own copies; existing tests continue to pass via re-export |
| `src-tauri/src/api/mod.rs` | declares `pub mod sse_shared;`, doc updated |
| `src-tauri/src/api/sse.rs` | unchanged (still the documented Phase 5 retirement target) |
| `src-tauri/src/commands/provider_kernel/streaming.rs` | **untouched** per Sub-E contract |

## Verdict

Audit completed. Duplication folded where contractually permitted; the
remaining kernel-internal copy is documented and queued for the Phase 5
deeper-fold. No wire format changes.
