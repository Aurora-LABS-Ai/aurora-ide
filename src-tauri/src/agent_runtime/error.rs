//! Runtime error type for the agent runtime.
//!
//! Phase 1 keeps this small and focused: only the variants needed by
//! the in-memory [`super::session::Session`] and JSON
//! (de)serialization. Phase 2 will extend this with API/tool/
//! permission/cancellation variants once the conversation runtime,
//! tool executors, and permission prompter land.
//!
//! All variants implement `std::error::Error` via `thiserror`, and
//! IO/serde error types are absorbed via `#[from]` so call sites can
//! use `?` without manual wrapping.

#![allow(dead_code)]

use thiserror::Error;

use super::api_client::ApiError;
use super::tool_executor::ToolError;

/// Errors raised by the agent runtime layer.
#[derive(Debug, Error)]
pub enum RuntimeError {
    /// An internal invariant of the session/state machine was
    /// violated. Typically a programmer error rather than a user-
    /// facing condition.
    #[error("invalid state: {0}")]
    InvalidState(String),

    /// Persistence error. Surfaces from the JSONL session log
    /// (`Session::load_from_path`, `Session::append_to_path`) and any
    /// future disk-backed runtime helpers.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// JSON (de)serialization failed. Used when projecting the
    /// JSONL session log onto the in-memory model and when validating
    /// IPC payloads at the boundary.
    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),

    /// The whole turn was cancelled — the user clicked stop, or a
    /// parent task dropped its cancel token. Distinct from
    /// [`ApiError::Cancelled`] (which only refers to one HTTP
    /// request) and [`ToolError::Cancelled`] (one tool call).
    #[error("turn was cancelled")]
    Cancelled,

    /// A tool reported an error during execution. Wraps the inner
    /// `ToolError` so the runtime can both display a `is_error: true`
    /// `ToolResult` block to the model **and** propagate the failure
    /// up to the caller for telemetry.
    #[error(transparent)]
    Tool(#[from] ToolError),

    /// The provider streaming call failed. The runtime emits an
    /// `AssistantEvent::Error` with `recoverable = inner.is_recoverable()`
    /// before returning this variant.
    #[error(transparent)]
    Api(#[from] ApiError),
}

impl RuntimeError {
    /// Whether the failure was caused by a cancel signal — used by
    /// the agent loop to decide between "emit error event" and
    /// "swallow the cancel quietly because the user asked for it".
    #[must_use]
    pub fn is_cancellation(&self) -> bool {
        matches!(
            self,
            RuntimeError::Cancelled
                | RuntimeError::Api(ApiError::Cancelled)
                | RuntimeError::Tool(ToolError::Cancelled)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_state_renders_reason() {
        let err = RuntimeError::InvalidState("missing turn_id".into());
        assert_eq!(err.to_string(), "invalid state: missing turn_id");
    }

    #[test]
    fn io_error_converts_via_from() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "no such file");
        let runtime_err: RuntimeError = io_err.into();
        match runtime_err {
            RuntimeError::Io(_) => {}
            other => panic!("expected Io variant, got {other:?}"),
        }
    }

    #[test]
    fn serde_error_converts_via_from() {
        let serde_err: serde_json::Error =
            serde_json::from_str::<serde_json::Value>("not-json").unwrap_err();
        let runtime_err: RuntimeError = serde_err.into();
        match runtime_err {
            RuntimeError::Serde(_) => {}
            other => panic!("expected Serde variant, got {other:?}"),
        }
    }

    #[test]
    fn runtime_error_is_send_sync_static() {
        fn assert_bounds<T: Send + Sync + 'static>() {}
        assert_bounds::<RuntimeError>();
    }

    #[test]
    fn cancelled_variant_is_cancellation() {
        assert!(RuntimeError::Cancelled.is_cancellation());
    }

    #[test]
    fn tool_cancelled_is_cancellation() {
        let err: RuntimeError = ToolError::Cancelled.into();
        assert!(err.is_cancellation());
    }

    #[test]
    fn api_cancelled_is_cancellation() {
        let err: RuntimeError = ApiError::Cancelled.into();
        assert!(err.is_cancellation());
    }

    #[test]
    fn other_errors_are_not_cancellation() {
        assert!(!RuntimeError::InvalidState("x".into()).is_cancellation());
        let api_err: RuntimeError = ApiError::Network("conn reset".into()).into();
        assert!(!api_err.is_cancellation());
        let tool_err: RuntimeError = ToolError::Execution("boom".into()).into();
        assert!(!tool_err.is_cancellation());
    }

    #[test]
    fn tool_error_converts_via_from() {
        let tool_err = ToolError::Execution("boom".into());
        let runtime_err: RuntimeError = tool_err.into();
        match runtime_err {
            RuntimeError::Tool(_) => {}
            other => panic!("expected Tool variant, got {other:?}"),
        }
    }

    #[test]
    fn api_error_converts_via_from() {
        let api_err = ApiError::RateLimit;
        let runtime_err: RuntimeError = api_err.into();
        match runtime_err {
            RuntimeError::Api(_) => {}
            other => panic!("expected Api variant, got {other:?}"),
        }
    }
}
