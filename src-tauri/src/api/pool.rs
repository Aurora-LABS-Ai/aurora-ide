//! Generic API-key pool with round-robin + failover.
//!
//! [`PooledStreamingClient`] wraps any concrete [`StreamingApiClient`]
//! adapter and drives a *pool* of API keys for a single provider. It is
//! deliberately provider-agnostic — the same request body, headers, and
//! wire shape are used on every attempt; only the API key changes. The
//! first consumer is AgentRouter (users run 5+ accounts and want the
//! load spread and a dead key skipped automatically), but nothing here
//! knows about AgentRouter: any provider whose config carries more than
//! one key in `api_keys` gets pooling for free.
//!
//! ## Two behaviours, one wrapper
//!
//! - **Round-robin (spread).** Each new turn starts on the next key in
//!   the pool (an atomic counter advanced per `stream` call). Over many
//!   turns the load is spread evenly across every account.
//! - **Failover (resilience).** If the chosen key fails *before any
//!   content streams* with an auth / rate-limit / server error, the
//!   wrapper retries the identical request with the next key, and so on
//!   until the pool is exhausted.
//!
//! ## Why failover is safe (no duplicated output)
//!
//! Every adapter checks the HTTP status **before** it forwards a single
//! [`AssistantEvent`]: a non-2xx response returns an [`ApiError`] out of
//! the status check, ahead of `bytes_stream()`. The three error variants
//! we retry on — [`ApiError::Unauthorized`] (401), [`ApiError::RateLimit`]
//! (429), and [`ApiError::Provider`] (5xx) — are *only* produced by that
//! pre-stream status check (`map_status_error`). So when we see one, we
//! know the event sink is still pristine and re-issuing the request can't
//! double up text. Errors that can occur mid-stream ([`ApiError::Network`],
//! [`ApiError::Decode`]) are **not** retried — a partial response may have
//! already reached the UI. [`ApiError::InvalidRequest`] (400) and
//! [`ApiError::Cancelled`] are never key-specific, so retrying is
//! pointless and we surface them immediately.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::agent_runtime::api_client::{ApiError, ApiRequest, StreamingApiClient, TurnUsage};
use crate::agent_runtime::events::AssistantEvent;

use super::client::{build_single_api_client, ProviderConfigSnapshot};

/// Whether a failure on one key is worth retrying on the next key. See
/// the module docs for the safety argument — every variant listed here is
/// raised at the pre-stream status check, so nothing has been emitted yet.
fn is_key_failover(err: &ApiError) -> bool {
    matches!(
        err,
        ApiError::Unauthorized(_) | ApiError::RateLimit { .. } | ApiError::Provider(_)
    )
}

/// A [`StreamingApiClient`] that owns a provider config plus a pool of API
/// keys and picks / rotates / fails-over between them per turn.
pub struct PooledStreamingClient {
    /// Base config for the provider. Its `api_key` field is overwritten
    /// per attempt; `api_keys` is cleared on the per-key clone so the
    /// inner build takes the plain single-key path (no recursion).
    base: ProviderConfigSnapshot,
    /// Ordered, de-duplicated, non-empty key pool.
    keys: Vec<String>,
    /// Advanced once per `stream` call to rotate the starting key.
    cursor: AtomicUsize,
}

impl PooledStreamingClient {
    /// Build a pool. `keys` is expected to be the already-normalised
    /// output of [`ProviderConfigSnapshot::effective_keys`] (non-empty,
    /// de-duplicated). A single-key pool is legal — it simply never
    /// fails over — but the factory only wraps when `keys.len() > 1`.
    #[must_use]
    pub fn new(base: ProviderConfigSnapshot, keys: Vec<String>) -> Self {
        Self {
            base,
            keys,
            cursor: AtomicUsize::new(0),
        }
    }

    /// Build the concrete adapter for one key, taking the single-key path.
    fn client_for_key(&self, key: &str) -> Arc<dyn StreamingApiClient> {
        let mut cfg = self.base.clone();
        cfg.api_key = key.to_string();
        cfg.api_keys = None;
        build_single_api_client(&cfg)
    }
}

#[async_trait]
impl StreamingApiClient for PooledStreamingClient {
    async fn stream(
        &self,
        request: ApiRequest<'_>,
        event_sink: mpsc::Sender<AssistantEvent>,
        cancel_token: CancellationToken,
    ) -> Result<TurnUsage, ApiError> {
        let n = self.keys.len();
        debug_assert!(n >= 1, "PooledStreamingClient must hold at least one key");

        // Per-turn round-robin: this turn starts on `start`, the next on
        // `start + 1`, wrapping. `Relaxed` is fine — we only need "a
        // different-ish key each turn", not a strict global order.
        let start = self.cursor.fetch_add(1, Ordering::Relaxed);

        let mut last_err: Option<ApiError> = None;
        for attempt in 0..n {
            if cancel_token.is_cancelled() {
                return Err(ApiError::Cancelled);
            }

            let key = &self.keys[(start.wrapping_add(attempt)) % n];
            let client = self.client_for_key(key);

            // `ApiRequest` is `Copy`, and `mpsc::Sender` is `Clone`, so
            // re-issuing the identical request on the next key is a plain
            // copy — no rebuild of the message history. The clone keeps the
            // channel open for the retry; the original `event_sink` is
            // dropped only when this function returns.
            match client
                .stream(request, event_sink.clone(), cancel_token.clone())
                .await
            {
                Ok(usage) => return Ok(usage),
                Err(err) => {
                    let can_retry = attempt + 1 < n && is_key_failover(&err);
                    if !can_retry {
                        return Err(err);
                    }
                    last_err = Some(err);
                    // Fall through to the next key.
                }
            }
        }

        // Pool exhausted — every key failed with a failover-eligible error.
        Err(last_err.unwrap_or_else(|| ApiError::Unauthorized("check API key".to_string())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_key_failover_classifies_variants() {
        assert!(is_key_failover(&ApiError::Unauthorized("no key".into())));
        assert!(is_key_failover(&ApiError::RateLimit {
            retry_after_secs: None
        }));
        assert!(is_key_failover(&ApiError::Provider("503".into())));
        // Not retried — may be mid-stream or key-agnostic.
        assert!(!is_key_failover(&ApiError::Network("reset".into())));
        assert!(!is_key_failover(&ApiError::Decode("bad json".into())));
        assert!(!is_key_failover(&ApiError::InvalidRequest("400".into())));
        assert!(!is_key_failover(&ApiError::Cancelled));
    }

    fn base_config() -> ProviderConfigSnapshot {
        ProviderConfigSnapshot {
            provider_id: "custom".into(),
            provider_type: None,
            base_url: "https://example.test/v1".into(),
            api_key: String::new(),
            api_keys: Some(vec!["k1".into(), "k2".into(), "k3".into()]),
            model: "m".into(),
            custom_headers: None,
            custom_params: None,
            default_temperature: None,
            default_max_tokens: None,
            supports_thinking: false,
            reasoning: None,
            supports_vision: false,
        }
    }

    #[test]
    fn client_for_key_takes_single_key_path() {
        let pool = PooledStreamingClient::new(base_config(), vec!["k1".into(), "k2".into()]);
        // Building an inner client must not panic and must not re-enter the
        // pool (the per-key clone clears `api_keys`).
        let _ = pool.client_for_key("k1");
    }

    #[test]
    fn cursor_advances_per_call() {
        let pool = PooledStreamingClient::new(base_config(), vec!["k1".into(), "k2".into()]);
        let a = pool.cursor.fetch_add(1, Ordering::Relaxed);
        let b = pool.cursor.fetch_add(1, Ordering::Relaxed);
        assert_ne!(a % 2, b % 2, "consecutive turns start on different keys");
    }
}
