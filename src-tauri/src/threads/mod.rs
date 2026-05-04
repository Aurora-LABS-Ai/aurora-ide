//! Thread persistence — JSONL event log per thread.
//!
//! Aurora persists every conversation as an append-only stream of typed
//! [`events::ThreadEvent`] records on disk. The architecture is:
//!
//! ```text
//!   commands  ───→  [`store::ThreadEventLog`]  ───→  per-thread JSONL file
//!                       │           │
//!                       │           ├── refold ──→  [`projector::ProjectedThread`]
//!                       │           │                     │
//!                       │           ▼                     ▼
//!                       │   threads-index.jsonl      ContextManager view
//!                       │                                  │
//!                       └── emit  thread-event-appended  ──┘  → all windows
//! ```
//!
//! Modules:
//! - [`events`]: the on-disk event schema (forward-compatible).
//! - [`paths`]: cross-platform resolution of the agent's filesystem layout.
//! - [`writer`]: append-only, line-buffered, durable JSONL writer.
//! - [`reader`]: streaming JSONL reader, tolerant of torn-tail writes.
//! - [`index`]: append-only thread summary index with periodic compaction.
//! - [`projector`]: pure event-stream → [`projector::ProjectedThread`] folder.
//! - [`store`]: the singleton orchestrator the rest of the app talks to.

pub mod events;
pub mod index;
pub mod paths;
pub mod projector;
pub mod reader;
pub mod store;
pub mod title;
pub mod writer;

// Public re-exports — kept stable so commands/tests/future callers don't need
// to know the sub-module layout. `#[allow(unused_imports)]` because consumers
// inside `crate::threads` use the modules directly; these are an external API
// surface for `crate::commands`, `crate::context`, and (eventually) the
// frontend bridge layer.
#[allow(unused_imports)]
pub use events::{
    new_event_id, now_rfc3339_ms, CancelReason, EventToolCall, ThreadEvent, TurnOutcome,
    SCHEMA_VERSION,
};
#[allow(unused_imports)]
pub use projector::{ProjectedSettings, ProjectedThread};
#[allow(unused_imports)]
pub use store::{
    AppendedPayload, StoreError, StoreResult, ThreadEventLog, EVT_THREAD_APPENDED,
    EVT_THREAD_LIST_UPDATED,
};
