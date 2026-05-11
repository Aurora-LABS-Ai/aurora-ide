//! Phase 4 recovery recipes — turn arbitrary error strings into
//! actionable [`RecoveryHint`] values.
//!
//! When a turn fails with an [`super::error::RuntimeError`], the
//! runtime forwards the failure to the frontend through an
//! `agent_turn_error` event (see
//! [`crate::commands::agent_v2`]). Phase 2.3 settled on a flat
//! `{ turnId, error }` payload; Phase 4 extends it with an optional
//! `recoveryHint` field that the UI can use to nudge the user
//! ("invalid API key — open Settings", "rate-limited — wait 30s",
//! …).
//!
//! The classification is intentionally **conservative**:
//!
//! - We only return `Some(...)` when a substring or regex match is
//!   high-confidence (auth keywords, rate-limit markers, well-known
//!   path-escape phrases).
//! - Otherwise we return `None` and the frontend renders the raw
//!   error verbatim — the same behaviour as before Phase 4.
//!
//! All matching is case-insensitive and runs against the error's
//! `Display` output, which means it covers `ApiError`, `ToolError`,
//! `RuntimeError`, and any future error type that lands in
//! `agent_turn_error`.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// Categorical hint about *why* a turn failed and how the user can
/// most likely recover. Designed to be small enough that the
/// frontend can keep a hard-coded i18n table.
///
/// Serialised as `lowerCamelCase` strings (the variant names) so a
/// missing variant in the frontend just falls through gracefully.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryHint {
    /// Provider rejected the request because the API key is missing,
    /// invalid, or expired. Surface "Open Settings → Providers".
    AuthFailed,

    /// Provider returned a rate-limit / quota / 429 error. Surface
    /// "wait a few seconds and retry".
    RateLimited,

    /// Network / connection / DNS / timeout failure. Surface
    /// "check internet connection".
    NetworkError,

    /// Provider says the model name is wrong, deprecated, or not
    /// available on the active key. Surface "pick a different model".
    InvalidModel,

    /// A tool was asked to read/write a path outside the workspace,
    /// or a path that does not exist. Surface "verify the path".
    InvalidPath,

    /// Tool asked for a capability that the user denied (interactive
    /// permission gate) or that policy disallows. Surface "approve
    /// this tool in Settings".
    PermissionDenied,

    /// Provider returned a context-window-exceeded error. Surface
    /// "start a new chat or summarise older turns".
    ContextOverflow,

    /// User clicked stop; the runtime cancelled. Surface a quiet
    /// indicator (no error toast).
    Cancelled,
}

impl RecoveryHint {
    /// Stable lower-camelCase token used both as the serialised
    /// JSON form and as the frontend's i18n lookup key.
    #[must_use]
    pub const fn as_token(self) -> &'static str {
        match self {
            RecoveryHint::AuthFailed => "authFailed",
            RecoveryHint::RateLimited => "rateLimited",
            RecoveryHint::NetworkError => "networkError",
            RecoveryHint::InvalidModel => "invalidModel",
            RecoveryHint::InvalidPath => "invalidPath",
            RecoveryHint::PermissionDenied => "permissionDenied",
            RecoveryHint::ContextOverflow => "contextOverflow",
            RecoveryHint::Cancelled => "cancelled",
        }
    }
}

/// Map a free-form error string onto a [`RecoveryHint`].
///
/// Ordering matters: more specific patterns (`api key`, `rate limit`)
/// come before catch-alls (`network`). The first match wins.
///
/// Returns `None` when no high-confidence match is found — callers
/// should fall back to displaying the raw error.
#[must_use]
pub fn classify_error(err: &str) -> Option<RecoveryHint> {
    if err.is_empty() {
        return None;
    }
    let lower = err.to_ascii_lowercase();

    // ── Cancellation ─────────────────────────────────────────────
    // `RuntimeError::Cancelled.to_string()` == "turn was cancelled".
    if lower.contains("cancel") {
        return Some(RecoveryHint::Cancelled);
    }

    // ── Auth ─────────────────────────────────────────────────────
    if contains_any(
        &lower,
        &[
            "api key",
            "api_key",
            "apikey",
            "unauthorized",
            "401",
            "403",
            "invalid_api_key",
            "authentication",
            "auth failed",
            "missing key",
            "no api key",
            "permission to access",
            "access denied",
        ],
    ) && !lower.contains("permission denied")
    {
        return Some(RecoveryHint::AuthFailed);
    }

    // ── Rate limit / quota ──────────────────────────────────────
    if contains_any(
        &lower,
        &[
            "rate limit",
            "rate-limit",
            "ratelimit",
            "too many requests",
            "429",
            "quota",
            "rate_limited",
            "rate exceeded",
        ],
    ) {
        return Some(RecoveryHint::RateLimited);
    }

    // ── Context overflow ────────────────────────────────────────
    // Distinct from generic "limit" errors — keep this before
    // RateLimited matchers if they accidentally drift.
    if contains_any(
        &lower,
        &[
            "context length",
            "context window",
            "maximum context length",
            "max_tokens_to_sample",
            "input is too long",
            "prompt is too long",
            "exceed",
        ],
    ) && contains_any(&lower, &["context", "token", "length"])
    {
        return Some(RecoveryHint::ContextOverflow);
    }

    // ── Network ─────────────────────────────────────────────────
    if contains_any(
        &lower,
        &[
            "network",
            "connection refused",
            "connection reset",
            "connection closed",
            "timed out",
            "timeout",
            "dns",
            "socket",
            "no route to host",
            "tls",
            "certificate",
            "io error",
        ],
    ) {
        return Some(RecoveryHint::NetworkError);
    }

    // ── Invalid model ───────────────────────────────────────────
    if contains_any(
        &lower,
        &[
            "model not found",
            "invalid model",
            "no such model",
            "model_not_found",
            "unknown model",
            "model `",
            "is not a valid model",
            "deprecated model",
        ],
    ) {
        return Some(RecoveryHint::InvalidModel);
    }

    // ── Permission denied (tool/policy) ─────────────────────────
    // Specifically the runtime's own ToolError variants.
    if contains_any(
        &lower,
        &[
            "permission denied",
            "policy violation",
            "user rejected",
            "user denied",
            "approval denied",
            "blocked by policy",
        ],
    ) {
        return Some(RecoveryHint::PermissionDenied);
    }

    // ── Invalid path ────────────────────────────────────────────
    // Picks up `ToolError::PathEscape` ("path is outside the
    // workspace: …"), `NotFound` ("no such file"), and the typical
    // OS-level NotFound spelling.
    if contains_any(
        &lower,
        &[
            "path is outside the workspace",
            "outside the workspace",
            "no such file",
            "file not found",
            "path not found",
            "directory not found",
            "invalid path",
            "is not a file",
            "is not a directory",
        ],
    ) {
        return Some(RecoveryHint::InvalidPath);
    }

    None
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| haystack.contains(n))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_returns_none_for_empty_string() {
        assert!(classify_error("").is_none());
    }

    #[test]
    fn classify_returns_none_for_unrelated_text() {
        assert!(classify_error("a fluffy bunny ate the README").is_none());
    }

    #[test]
    fn classify_auth_failed_for_api_key_message() {
        assert_eq!(
            classify_error("Provider returned 401: missing API key"),
            Some(RecoveryHint::AuthFailed),
        );
        assert_eq!(
            classify_error("invalid_api_key: please check Settings"),
            Some(RecoveryHint::AuthFailed),
        );
        assert_eq!(
            classify_error("Authentication failed for provider 'glm'"),
            Some(RecoveryHint::AuthFailed),
        );
    }

    #[test]
    fn classify_rate_limited_for_429() {
        assert_eq!(
            classify_error("HTTP 429 Too Many Requests"),
            Some(RecoveryHint::RateLimited),
        );
        assert_eq!(
            classify_error("rate limit exceeded for tier 1"),
            Some(RecoveryHint::RateLimited),
        );
        assert_eq!(
            classify_error("daily quota reached, retry tomorrow"),
            Some(RecoveryHint::RateLimited),
        );
    }

    #[test]
    fn classify_network_error_for_connection_phrases() {
        assert_eq!(
            classify_error("connection refused"),
            Some(RecoveryHint::NetworkError),
        );
        assert_eq!(
            classify_error("request timed out after 30s"),
            Some(RecoveryHint::NetworkError),
        );
        assert_eq!(
            classify_error("DNS resolution failed"),
            Some(RecoveryHint::NetworkError),
        );
    }

    #[test]
    fn classify_invalid_model_for_unknown_model_message() {
        assert_eq!(
            classify_error("model not found: claude-9-supreme"),
            Some(RecoveryHint::InvalidModel),
        );
        assert_eq!(
            classify_error("provider error: 'gpt-99' is not a valid model"),
            Some(RecoveryHint::InvalidModel),
        );
    }

    #[test]
    fn classify_invalid_path_for_path_escape() {
        assert_eq!(
            classify_error("path is outside the workspace: /etc/passwd"),
            Some(RecoveryHint::InvalidPath),
        );
        assert_eq!(
            classify_error("no such file or directory"),
            Some(RecoveryHint::InvalidPath),
        );
    }

    #[test]
    fn classify_permission_denied_for_tool_policy_violation() {
        assert_eq!(
            classify_error("policy violation: shell_execute blocked by allow-list"),
            Some(RecoveryHint::PermissionDenied),
        );
        assert_eq!(
            classify_error("user rejected the approval prompt"),
            Some(RecoveryHint::PermissionDenied),
        );
    }

    #[test]
    fn classify_context_overflow_for_token_limit_phrases() {
        assert_eq!(
            classify_error("This model's maximum context length is 200000 tokens, however you provided 250000."),
            Some(RecoveryHint::ContextOverflow),
        );
        assert_eq!(
            classify_error("prompt is too long: 200001 tokens > 200000 max"),
            Some(RecoveryHint::ContextOverflow),
        );
    }

    #[test]
    fn classify_cancelled_when_user_cancelled() {
        assert_eq!(
            classify_error("turn was cancelled"),
            Some(RecoveryHint::Cancelled),
        );
        assert_eq!(
            classify_error("Cancelled"),
            Some(RecoveryHint::Cancelled),
        );
    }

    #[test]
    fn recovery_hint_serialises_as_camel_case_token() {
        let hint = RecoveryHint::RateLimited;
        let s = serde_json::to_string(&hint).expect("serialise");
        assert_eq!(s, "\"rateLimited\"");
        let round: RecoveryHint = serde_json::from_str(&s).expect("deserialise");
        assert_eq!(round, RecoveryHint::RateLimited);
    }

    #[test]
    fn recovery_hint_token_helper_matches_serialised_form() {
        for hint in [
            RecoveryHint::AuthFailed,
            RecoveryHint::RateLimited,
            RecoveryHint::NetworkError,
            RecoveryHint::InvalidModel,
            RecoveryHint::InvalidPath,
            RecoveryHint::PermissionDenied,
            RecoveryHint::ContextOverflow,
            RecoveryHint::Cancelled,
        ] {
            let s = serde_json::to_string(&hint).expect("serialise");
            let trimmed = s.trim_matches('"');
            assert_eq!(trimmed, hint.as_token(), "token mismatch for {hint:?}");
        }
    }

    #[test]
    fn classify_case_insensitive() {
        assert_eq!(
            classify_error("RATE LIMIT REACHED"),
            Some(RecoveryHint::RateLimited),
        );
        assert_eq!(
            classify_error("Permission Denied: shell_execute"),
            Some(RecoveryHint::PermissionDenied),
        );
    }

    #[test]
    fn classify_priority_auth_over_permission_when_message_overlaps() {
        // "permission to access" reads as auth-style. Keep it
        // behind the `permission denied` short-circuit so genuine
        // tool-policy denials still classify correctly.
        assert_eq!(
            classify_error("missing permission to access this resource"),
            Some(RecoveryHint::AuthFailed),
        );
        assert_eq!(
            classify_error("permission denied"),
            Some(RecoveryHint::PermissionDenied),
        );
    }
}
