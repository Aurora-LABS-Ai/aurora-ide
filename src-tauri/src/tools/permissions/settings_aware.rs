//! Settings-aware permitter — short-circuits the prompter when the
//! user has explicitly chosen `auto` or `deny` for a tool in
//! Settings → Tools, otherwise delegates to the inner permitter
//! (production: [`super::TauriPermitter`]) so the inline modal
//! still pops up for `always_ask`.
//!
//! Mirrors the legacy TS `AgentToolRunner::resolveApproval` policy:
//!
//! | Setting            | Behaviour                                    |
//! |--------------------|----------------------------------------------|
//! | `auto`             | Approve without asking (no event emitted).   |
//! | `deny`             | Deny without asking (no event emitted).      |
//! | `always_ask` (or unset) | Delegate to inner permitter (modal).    |
//!
//! The check is per-call so toggling a setting in the UI takes effect
//! immediately on the next tool dispatch — no agent restart required.

#![cfg(not(feature = "verify_only"))]

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use tauri::{AppHandle, Manager};
use tokio_util::sync::CancellationToken;

use crate::agent_runtime::tool_executor::{Permitter, ToolError};
use crate::db::Database;

/// Resolver trait so the permitter can be unit-tested without a live
/// SQLite connection. Production wires
/// [`DatabaseSettingsResolver`]; tests use a closure-backed mock.
pub trait SettingsResolver: Send + Sync + 'static {
    /// Returns one of `"auto"`, `"always_ask"`, `"deny"`, or `None`
    /// if the tool has no explicit setting (treated as
    /// `always_ask`).
    fn approval_mode(&self, tool_name: &str) -> Option<String>;

    /// Global "auto-approve every tool" override. When `true`, the
    /// permitter short-circuits to `Ok(true)` for every tool — the
    /// per-tool [`Self::approval_mode`] is not consulted at all. This
    /// matches the legacy TS behaviour: the **Settings → Tools →
    /// Auto-approve all tools** switch is a master kill for the
    /// approval modal. Defaults to `false`.
    fn auto_approve_all(&self) -> bool {
        false
    }
}

/// `AppHandle`-backed resolver — production wiring.
///
/// Pulls the managed `Mutex<Database>` from Tauri state on every
/// call so the same SQLite connection used by the rest of the app
/// (settings UI, etc.) is what the permitter sees. Re-reading per
/// call means a setting change in the UI takes effect on the next
/// tool dispatch with no agent restart.
pub struct DatabaseSettingsResolver {
    app: AppHandle,
}

impl DatabaseSettingsResolver {
    #[must_use]
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl SettingsResolver for DatabaseSettingsResolver {
    fn approval_mode(&self, tool_name: &str) -> Option<String> {
        let state = self.app.try_state::<Mutex<Database>>()?;
        let db = state.lock().ok()?;
        match db.settings().get_tool_setting(tool_name) {
            Ok(Some(setting)) => Some(setting.approval_mode),
            Ok(None) => None,
            Err(err) => {
                eprintln!(
                    "[SettingsAwarePermitter] DB lookup for {tool_name} failed: {err}"
                );
                None
            }
        }
    }

    /// Reads the `autoApproveTools` row out of `app_settings`. The
    /// frontend persists this as a JSON-encoded boolean string
    /// (`"true"` / `"false"`) — same wire shape the rest of the
    /// app-settings table uses (`get_app_settings` does the same
    /// `serde_json::from_str` round-trip). On any failure path
    /// (missing row, malformed JSON, lock poisoned, DB error) we
    /// conservatively return `false` so the modal still pops up.
    fn auto_approve_all(&self) -> bool {
        let Some(state) = self.app.try_state::<Mutex<Database>>() else {
            return false;
        };
        let Ok(db) = state.lock() else { return false };
        match db.settings().get_setting("autoApproveTools") {
            Ok(Some(setting)) => serde_json::from_str(&setting.value).unwrap_or(false),
            Ok(None) => false,
            Err(err) => {
                eprintln!("[SettingsAwarePermitter] auto-approve lookup failed: {err}");
                false
            }
        }
    }
}

/// Outer permitter that consults [`SettingsResolver`] before falling
/// through to `inner`. Production wires `inner = TauriPermitter`.
pub struct SettingsAwarePermitter {
    resolver: Arc<dyn SettingsResolver>,
    inner: Arc<dyn Permitter>,
}

impl SettingsAwarePermitter {
    #[must_use]
    pub fn new(resolver: Arc<dyn SettingsResolver>, inner: Arc<dyn Permitter>) -> Self {
        Self { resolver, inner }
    }
}

#[async_trait]
impl Permitter for SettingsAwarePermitter {
    async fn request(
        &self,
        turn_id: &str,
        tool_use_id: &str,
        tool_name: &str,
        input: &serde_json::Value,
        cancel: CancellationToken,
    ) -> Result<bool, ToolError> {
        // Cheap pre-check before consulting the DB.
        if cancel.is_cancelled() {
            return Err(ToolError::Cancelled);
        }

        // Master kill: the Settings → Tools → "Auto-approve all tools"
        // switch overrides every per-tool setting. The legacy TS
        // behaviour ignored the per-tool table when this was on, and
        // the UI explicitly tells the user that ("Per-tool settings
        // below are ignored when this is on."). Mirror that here so a
        // user who turned the global switch off can trust that they
        // will be prompted again — and a user who turned it on can
        // trust that the agent will run uninterrupted.
        if self.resolver.auto_approve_all() {
            eprintln!(
                "[permitter] {tool_name} auto-approved (global Auto-approve all tools is ON)"
            );
            return Ok(true);
        }

        match self.resolver.approval_mode(tool_name).as_deref() {
            Some("auto") => {
                eprintln!("[permitter] {tool_name} auto-approved (per-tool: auto)");
                Ok(true)
            }
            Some("deny") => {
                eprintln!("[permitter] {tool_name} denied (per-tool: deny)");
                Ok(false)
            }
            // "always_ask" or unrecognised mode or missing → delegate
            // to inner so the modal pops up.
            other => {
                eprintln!(
                    "[permitter] {tool_name} → delegating to inner permitter (mode={other:?})"
                );
                self.inner
                    .request(turn_id, tool_use_id, tool_name, input, cancel)
                    .await
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::permissions::prompter::MockPermitter;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct StaticResolver {
        mode: Option<&'static str>,
        auto_approve_all: bool,
        calls: AtomicUsize,
        auto_approve_calls: AtomicUsize,
    }

    impl SettingsResolver for StaticResolver {
        fn approval_mode(&self, _tool_name: &str) -> Option<String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.mode.map(str::to_string)
        }

        fn auto_approve_all(&self) -> bool {
            self.auto_approve_calls.fetch_add(1, Ordering::SeqCst);
            self.auto_approve_all
        }
    }

    fn mock_chain(
        mode: Option<&'static str>,
        permitter: MockPermitter,
    ) -> (SettingsAwarePermitter, Arc<MockPermitter>, Arc<StaticResolver>) {
        mock_chain_with_global(mode, false, permitter)
    }

    fn mock_chain_with_global(
        mode: Option<&'static str>,
        auto_approve_all: bool,
        permitter: MockPermitter,
    ) -> (SettingsAwarePermitter, Arc<MockPermitter>, Arc<StaticResolver>) {
        let resolver = Arc::new(StaticResolver {
            mode,
            auto_approve_all,
            calls: AtomicUsize::new(0),
            auto_approve_calls: AtomicUsize::new(0),
        });
        let permitter_arc = Arc::new(permitter);
        let inner: Arc<dyn Permitter> = permitter_arc.clone();
        let outer = SettingsAwarePermitter::new(resolver.clone(), inner);
        (outer, permitter_arc, resolver)
    }

    #[tokio::test]
    async fn auto_short_circuits_to_true_without_consulting_inner() {
        let (outer, inner, resolver) = mock_chain(Some("auto"), MockPermitter::denying());
        let granted = outer
            .request(
                "t",
                "tu",
                "shell_execute",
                &serde_json::json!({}),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(granted);
        assert_eq!(inner.call_count(), 0, "inner permitter never invoked");
        assert_eq!(resolver.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn deny_short_circuits_to_false_without_consulting_inner() {
        let (outer, inner, _) = mock_chain(Some("deny"), MockPermitter::granting());
        let granted = outer
            .request(
                "t",
                "tu",
                "shell_execute",
                &serde_json::json!({}),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(!granted);
        assert_eq!(inner.call_count(), 0);
    }

    #[tokio::test]
    async fn always_ask_delegates_to_inner() {
        let (outer, inner, _) = mock_chain(Some("always_ask"), MockPermitter::denying());
        let granted = outer
            .request(
                "t",
                "tu",
                "shell_execute",
                &serde_json::json!({}),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(!granted);
        assert_eq!(inner.call_count(), 1, "inner permitter invoked exactly once");
    }

    #[tokio::test]
    async fn no_setting_defaults_to_always_ask() {
        let (outer, inner, _) = mock_chain(None, MockPermitter::granting());
        let granted = outer
            .request(
                "t",
                "tu",
                "shell_execute",
                &serde_json::json!({}),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(granted);
        assert_eq!(inner.call_count(), 1);
    }

    #[tokio::test]
    async fn pre_cancel_short_circuits_before_db_lookup() {
        let (outer, inner, resolver) = mock_chain(Some("auto"), MockPermitter::granting());
        let cancel = CancellationToken::new();
        cancel.cancel();
        let err = outer
            .request(
                "t",
                "tu",
                "shell_execute",
                &serde_json::json!({}),
                cancel,
            )
            .await
            .expect_err("must cancel");
        assert!(matches!(err, ToolError::Cancelled));
        assert_eq!(resolver.calls.load(Ordering::SeqCst), 0);
        assert_eq!(inner.call_count(), 0);
    }

    #[tokio::test]
    async fn unknown_mode_falls_through_to_inner() {
        let (outer, inner, _) = mock_chain(Some("garbage"), MockPermitter::granting());
        let granted = outer
            .request(
                "t",
                "tu",
                "shell_execute",
                &serde_json::json!({}),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(granted);
        assert_eq!(inner.call_count(), 1);
    }

    /// Global "Auto-approve all tools" wins over a per-tool `deny`
    /// — the UI tells users this explicitly, so we mirror it.
    #[tokio::test]
    async fn auto_approve_all_overrides_per_tool_deny() {
        let (outer, inner, resolver) =
            mock_chain_with_global(Some("deny"), true, MockPermitter::denying());
        let granted = outer
            .request(
                "t",
                "tu",
                "file_write",
                &serde_json::json!({}),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(granted, "global auto-approve must beat per-tool deny");
        assert_eq!(inner.call_count(), 0, "inner permitter never invoked");
        assert_eq!(
            resolver.calls.load(Ordering::SeqCst),
            0,
            "per-tool table never consulted when global is on"
        );
        assert_eq!(resolver.auto_approve_calls.load(Ordering::SeqCst), 1);
    }

    /// When global auto-approve is off, the per-tool table runs the
    /// show — including denying a tool that has no explicit setting
    /// because the user denied it through the modal.
    #[tokio::test]
    async fn global_off_falls_through_to_per_tool_and_modal() {
        let (outer, inner, resolver) =
            mock_chain_with_global(None, false, MockPermitter::denying());
        let granted = outer
            .request(
                "t",
                "tu",
                "file_write",
                &serde_json::json!({}),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(!granted);
        assert_eq!(inner.call_count(), 1, "modal (inner permitter) ran");
        assert_eq!(resolver.calls.load(Ordering::SeqCst), 1);
        assert_eq!(resolver.auto_approve_calls.load(Ordering::SeqCst), 1);
    }
}
