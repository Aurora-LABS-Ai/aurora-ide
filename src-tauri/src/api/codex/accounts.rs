//! Several ChatGPT accounts, one of them serving requests.
//!
//! Codex CLI's `auth.json` holds exactly one account, and it is *its* file:
//! signing a second account in overwrites the first, and signing out deletes
//! the credentials the CLI is using. Neither is acceptable for someone holding
//! four accounts to pool their included limits and credits.
//!
//! So Aurora keeps its own list at `<root>/auth/codex-accounts.json` and treats
//! `~/.codex/auth.json` as an *import source* only. Each entry stores the raw
//! auth.json-shaped value verbatim, which is what lets every existing helper in
//! [`super::auth`] — `access_from_value`, `apply_token_response`, `jwt_claims`
//! — work on it without a single change.
//!
//! Two pointers, not one, and the distinction is the whole design:
//!
//! - **main** is the user's choice. Nothing but the user moves it.
//! - **active** is what the next request will actually use. Failover moves it
//!   when main is exhausted, and it snaps back the moment main recovers.
//!
//! Collapsing those into one field would mean a rate limit silently rewrites a
//! setting the user made deliberately, and they would have no way to tell that
//! had happened.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Bumped only for a shape change the loader cannot read. A file from the
/// future is left alone rather than truncated — see [`load`].
const STORE_VERSION: u32 = 1;

/// How long an account stays skipped after it reports its limit reached, when
/// the response gave no reset time of its own. Short enough that a brief 429
/// does not park an account for the evening, long enough that a turn does not
/// hammer the same exhausted account on every tool call.
const DEFAULT_COOLDOWN_MS: i64 = 15 * 60 * 1000;

pub fn store_path() -> PathBuf {
    crate::paths::auth_dir().join("codex-accounts.json")
}

/// One signed-in ChatGPT account.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredAccount {
    /// Stable identity, from `tokens.account_id` or the id-token claims. Two
    /// sign-ins to the same account update one entry instead of making two.
    pub account_id: String,
    /// Display only, refreshed from the id token on every write — a plan
    /// upgrade should not need a re-sign-in to show up.
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub plan_type: Option<String>,
    pub added_at: String,
    /// The raw `auth.json`-shaped value, kept verbatim.
    pub auth: Value,
    /// Set when this account reported its limit reached; it is skipped for
    /// failover until then. `None` means available.
    #[serde(default)]
    pub exhausted_until_ms: Option<i64>,
}

impl StoredAccount {
    pub fn is_exhausted(&self, now_ms: i64) -> bool {
        self.exhausted_until_ms.is_some_and(|until| until > now_ms)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Store {
    #[serde(default)]
    pub version: u32,
    /// The user's choice. Only [`set_main`] moves it.
    #[serde(default)]
    pub main_account_id: Option<String>,
    /// Where failover has landed. Advisory: [`active_id`] ignores it whenever
    /// main is usable again.
    #[serde(default)]
    pub active_account_id: Option<String>,
    #[serde(default)]
    pub accounts: Vec<StoredAccount>,
}

impl Default for Store {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            main_account_id: None,
            active_account_id: None,
            accounts: Vec::new(),
        }
    }
}

impl Store {
    pub fn get(&self, account_id: &str) -> Option<&StoredAccount> {
        self.accounts.iter().find(|a| a.account_id == account_id)
    }

    /// Which account the next request should use.
    ///
    /// Main wins whenever it can serve, so a failover is always temporary —
    /// the user's setting reasserts itself the moment the window resets,
    /// without them having to notice or act.
    pub fn active_id(&self, now_ms: i64) -> Option<String> {
        let main_usable = self
            .main_account_id
            .as_deref()
            .and_then(|id| self.get(id))
            .is_some_and(|a| !a.is_exhausted(now_ms));
        if main_usable {
            return self.main_account_id.clone();
        }
        if let Some(active) = self
            .active_account_id
            .as_deref()
            .and_then(|id| self.get(id))
            .filter(|a| !a.is_exhausted(now_ms))
        {
            return Some(active.account_id.clone());
        }
        // Everything the user picked is spent. Any account that can still
        // serve beats failing the turn; a list where all are exhausted falls
        // back to main so the error names the account the user expects.
        self.accounts
            .iter()
            .find(|a| !a.is_exhausted(now_ms))
            .map(|a| a.account_id.clone())
            .or_else(|| self.main_account_id.clone())
            .or_else(|| self.accounts.first().map(|a| a.account_id.clone()))
    }

    pub fn active(&self, now_ms: i64) -> Option<&StoredAccount> {
        let id = self.active_id(now_ms)?;
        self.get(&id)
    }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/// Read the store. A missing file is an empty store, not an error — that is
/// the state every user starts in.
///
/// A file written by a NEWER Aurora is returned as empty rather than parsed
/// optimistically. The alternative is reading half of it and then saving that
/// half back over four working sign-ins.
pub fn load() -> Store {
    let path = store_path();
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Store::default();
    };
    match serde_json::from_str::<Store>(&raw) {
        Ok(store) if store.version <= STORE_VERSION => store,
        Ok(store) => {
            crate::logging::log_warn(
                "codex.accounts",
                &format!(
                    "{} is version {} and this build understands {STORE_VERSION} — \
                     leaving it untouched and starting empty",
                    path.display(),
                    store.version
                ),
            );
            Store::default()
        }
        Err(err) => {
            crate::logging::log_warn(
                "codex.accounts",
                &format!("{} is not readable ({err}) — starting empty", path.display()),
            );
            Store::default()
        }
    }
}

/// Write-then-rename, the same durability the code index uses: a crash mid-save
/// leaves the previous file intact rather than a truncated one, and a truncated
/// file here costs four browser sign-ins to rebuild.
pub fn save(store: &Store) -> Result<(), String> {
    let path = store_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create {}: {err}", parent.display()))?;
    }
    let rendered = serde_json::to_string_pretty(store)
        .map_err(|err| format!("Failed to serialize Codex accounts: {err}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, rendered)
        .map_err(|err| format!("Failed to write {}: {err}", tmp.display()))?;
    std::fs::rename(&tmp, &path)
        .map_err(|err| format!("Failed to replace {}: {err}", path.display()))
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/// Add an account, or refresh the one already stored under the same id.
///
/// Returns its `account_id`. The first account added becomes main — a list of
/// one with nothing selected is a state the UI would have to explain for no
/// reason.
pub fn upsert(auth: Value) -> Result<String, String> {
    let account_id = super::auth::identity_of(&auth)
        .ok_or("Those credentials carry no account id — sign in again.")?;
    let (email, plan_type) = super::auth::display_of(&auth);

    let mut store = load();
    let now = chrono::Utc::now().to_rfc3339();
    match store
        .accounts
        .iter_mut()
        .find(|a| a.account_id == account_id)
    {
        Some(existing) => {
            existing.auth = auth;
            existing.email = email;
            existing.plan_type = plan_type;
            // A fresh sign-in is the account telling us it can serve again.
            existing.exhausted_until_ms = None;
        }
        None => store.accounts.push(StoredAccount {
            account_id: account_id.clone(),
            email,
            plan_type,
            added_at: now,
            auth,
            exhausted_until_ms: None,
        }),
    }
    if store.main_account_id.is_none() {
        store.main_account_id = Some(account_id.clone());
    }
    save(&store)?;
    Ok(account_id)
}

pub fn set_main(account_id: &str) -> Result<(), String> {
    let mut store = load();
    if store.get(account_id).is_none() {
        return Err(format!("No stored Codex account {account_id}."));
    }
    store.main_account_id = Some(account_id.to_string());
    // Choosing a main is an explicit instruction to use it, so it also clears
    // whatever failover had chosen — otherwise the next request would keep
    // running on the old account and the setting would look ignored.
    store.active_account_id = Some(account_id.to_string());
    save(&store)
}

pub fn remove(account_id: &str) -> Result<(), String> {
    let mut store = load();
    store.accounts.retain(|a| a.account_id != account_id);
    if store.main_account_id.as_deref() == Some(account_id) {
        store.main_account_id = store.accounts.first().map(|a| a.account_id.clone());
    }
    if store.active_account_id.as_deref() == Some(account_id) {
        store.active_account_id = store.main_account_id.clone();
    }
    save(&store)
}

/// Persist a refreshed token pair for one account.
///
/// Keyed by id rather than "the active one": a refresh started before a
/// failover must land on the account it was actually for.
pub fn write_auth_for(account_id: &str, auth: Value) -> Result<(), String> {
    let mut store = load();
    let (email, plan_type) = super::auth::display_of(&auth);
    let Some(entry) = store
        .accounts
        .iter_mut()
        .find(|a| a.account_id == account_id)
    else {
        return Err(format!("No stored Codex account {account_id}."));
    };
    entry.auth = auth;
    if email.is_some() {
        entry.email = email;
    }
    if plan_type.is_some() {
        entry.plan_type = plan_type;
    }
    save(&store)
}

/// Record that this account has hit its limit, and hand back the account the
/// next attempt should use — `None` when there is nothing left to fall back to.
///
/// `reset_in_seconds` is the provider's own reset time when it gave one; a
/// guess is only used when it did not.
pub fn note_exhausted(account_id: &str, reset_in_seconds: Option<i64>) -> Option<StoredAccount> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let until = now_ms
        + reset_in_seconds
            .filter(|s| *s > 0)
            .map(|s| s.saturating_mul(1000))
            .unwrap_or(DEFAULT_COOLDOWN_MS);

    let mut store = load();
    if let Some(entry) = store
        .accounts
        .iter_mut()
        .find(|a| a.account_id == account_id)
    {
        entry.exhausted_until_ms = Some(until);
    }
    let next_id = store.active_id(now_ms)?;
    if next_id == account_id {
        // Nothing else can serve — do not claim a switch that did not happen.
        let _ = save(&store);
        return None;
    }
    store.active_account_id = Some(next_id.clone());
    let _ = save(&store);
    store.get(&next_id).cloned()
}

/// Clear the exhausted mark on one account (a manual refresh from the card).
pub fn clear_exhausted(account_id: &str) -> Result<(), String> {
    let mut store = load();
    if let Some(entry) = store
        .accounts
        .iter_mut()
        .find(|a| a.account_id == account_id)
    {
        entry.exhausted_until_ms = None;
    }
    save(&store)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn account(id: &str, exhausted_until: Option<i64>) -> StoredAccount {
        StoredAccount {
            account_id: id.to_string(),
            email: Some(format!("{id}@example.com")),
            plan_type: Some("free".into()),
            added_at: "2026-08-30T00:00:00Z".into(),
            auth: json!({}),
            exhausted_until_ms: exhausted_until,
        }
    }

    const NOW: i64 = 1_000_000;

    /// The user's choice is a setting, not a suggestion: while main can serve,
    /// nothing else is considered no matter where failover last landed.
    #[test]
    fn main_wins_while_it_can_serve() {
        let store = Store {
            main_account_id: Some("a".into()),
            active_account_id: Some("b".into()),
            accounts: vec![account("a", None), account("b", None)],
            ..Store::default()
        };
        assert_eq!(store.active_id(NOW).as_deref(), Some("a"));
    }

    /// …and the moment it cannot, the turn continues on another account
    /// instead of failing.
    #[test]
    fn an_exhausted_main_falls_through_to_a_usable_account() {
        let store = Store {
            main_account_id: Some("a".into()),
            active_account_id: None,
            accounts: vec![account("a", Some(NOW + 60_000)), account("b", None)],
            ..Store::default()
        };
        assert_eq!(store.active_id(NOW).as_deref(), Some("b"));
    }

    /// The reason main and active are separate fields. A rate limit must not
    /// rewrite a deliberate setting — once the window resets, the user is back
    /// on the account they chose without touching anything.
    #[test]
    fn main_reasserts_itself_once_its_window_resets() {
        let store = Store {
            main_account_id: Some("a".into()),
            active_account_id: Some("b".into()),
            accounts: vec![account("a", Some(NOW - 1)), account("b", None)],
            ..Store::default()
        };
        assert_eq!(
            store.active_id(NOW).as_deref(),
            Some("a"),
            "an expired cooldown is not a cooldown"
        );
    }

    /// With everything spent, the error the user reads should name the account
    /// they set, not whichever one happened to be tried last.
    #[test]
    fn all_exhausted_still_resolves_to_main() {
        let store = Store {
            main_account_id: Some("a".into()),
            active_account_id: Some("b".into()),
            accounts: vec![
                account("a", Some(NOW + 60_000)),
                account("b", Some(NOW + 60_000)),
            ],
            ..Store::default()
        };
        assert_eq!(store.active_id(NOW).as_deref(), Some("a"));
    }

    #[test]
    fn an_empty_store_has_no_active_account() {
        assert_eq!(Store::default().active_id(NOW), None);
    }
}
