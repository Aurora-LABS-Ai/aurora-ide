//! Several Claude accounts, one of them serving requests.
//!
//! Aurora keeps its own list at `<root>/auth/claude-code-accounts.json`. An
//! account gets there one of two ways: the Sign in button (a separate grant
//! that belongs to Aurora alone), or an import that copies what Claude Code
//! is signed into (see [`super::auth::import_from_cli`]). Claude Code's own
//! file is only ever read, and only when the user presses Import.
//!
//! One pointer, **main**: the account the next request uses. Nothing but the
//! user moves it. There is no failover here yet — Codex has one, but a Claude
//! plan reports its windows differently and nobody has measured a Claude 429
//! to key it off.
//!
//! Before this list existed, one sign-in lived at `claude-code-auth.json`.
//! [`load`] folds that file in once, so an existing sign-in survives the
//! upgrade as the main account.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::auth::StoredAuth;

/// Bumped only for a shape change the loader cannot read.
const STORE_VERSION: u32 = 1;

pub fn store_path() -> PathBuf {
    crate::paths::auth_dir().join("claude-code-accounts.json")
}

/// The single-sign-in file from before accounts existed.
fn legacy_path() -> PathBuf {
    crate::paths::auth_dir().join("claude-code-auth.json")
}

/// How an account arrived, so the card can say which ones share a sign-in
/// with Claude Code on this machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AccountSource {
    /// Aurora's own sign-in. Independent of Claude Code.
    SignIn,
    /// Copied from Claude Code's credentials. Shares that sign-in.
    ClaudeCodeImport,
}

/// One stored Claude account.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredAccount {
    /// Stable key. The Claude account uuid when known, so signing the same
    /// account in twice updates one entry instead of making two.
    pub id: String,
    pub added_at: String,
    pub source: AccountSource,
    pub auth: StoredAuth,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Store {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub main_id: Option<String>,
    #[serde(default)]
    pub accounts: Vec<StoredAccount>,
}

impl Default for Store {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            main_id: None,
            accounts: Vec::new(),
        }
    }
}

impl Store {
    pub fn get(&self, id: &str) -> Option<&StoredAccount> {
        self.accounts.iter().find(|a| a.id == id)
    }

    /// The account requests go to. Falls back to the first entry so a list
    /// with accounts in it is never "signed out" because a pointer went stale.
    pub fn main(&self) -> Option<&StoredAccount> {
        self.main_id
            .as_deref()
            .and_then(|id| self.get(id))
            .or_else(|| self.accounts.first())
    }

    /// Add an account, or replace the stored credentials of the same account.
    /// Returns its id. The first account becomes main; later ones do not, so
    /// adding a second account never silently moves where chats go.
    fn upsert(&mut self, auth: StoredAuth, source: AccountSource, now: &str) -> String {
        let existing = auth
            .account_uuid
            .as_deref()
            .and_then(|uuid| self.accounts.iter_mut().find(|a| a.id == uuid));
        let id = match existing {
            Some(entry) => {
                entry.auth = auth;
                entry.source = source;
                entry.id.clone()
            }
            None => {
                let id = auth
                    .account_uuid
                    .clone()
                    .unwrap_or_else(|| format!("local-{}", uuid::Uuid::new_v4()));
                self.accounts.push(StoredAccount {
                    id: id.clone(),
                    added_at: now.to_string(),
                    source,
                    auth,
                });
                id
            }
        };
        if self.main_id.is_none() {
            self.main_id = self.accounts.first().map(|a| a.id.clone());
        }
        id
    }

    fn remove(&mut self, id: &str) {
        self.accounts.retain(|a| a.id != id);
        if self.main_id.as_deref() == Some(id) || self.main_id.is_none() {
            self.main_id = self.accounts.first().map(|a| a.id.clone());
        }
    }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/// Every read-modify-write goes through this, so a token refresh landing
/// while the user removes an account cannot resurrect it or drop the refresh.
fn mutation_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

fn read_file() -> Result<Option<Store>, String> {
    let path = store_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("Failed to read {}: {err}", path.display())),
    };
    match serde_json::from_str::<Store>(&raw) {
        Ok(store) if store.version <= STORE_VERSION => Ok(Some(store)),
        // A file from a newer Aurora is left alone rather than truncated.
        Ok(store) => Err(format!(
            "{} was written by a newer Aurora (version {}). Update Aurora to use these accounts.",
            path.display(),
            store.version
        )),
        Err(err) => Err(format!(
            "{} is not readable ({err}). Remove it and sign in again.",
            path.display()
        )),
    }
}

/// Fold the pre-accounts single sign-in into a fresh store. Returns `None`
/// when there was nothing to fold in.
fn migrate_legacy() -> Result<Option<Store>, String> {
    let path = legacy_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("Failed to read {}: {err}", path.display())),
    };
    let auth: StoredAuth = serde_json::from_str(&raw).map_err(|err| {
        format!("{} is not readable ({err}). Sign in again.", path.display())
    })?;
    let added_at = auth
        .signed_in_at
        .clone()
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
    let mut store = Store::default();
    store.upsert(auth, AccountSource::SignIn, &added_at);
    save(&store)?;
    // Only after the new file is safely written. A failed delete leaves a
    // stale copy nobody reads, which is harmless.
    if let Err(err) = std::fs::remove_file(&path) {
        crate::logging::log_warn(
            "claude_code.accounts",
            &format!("migrated {} but could not remove it: {err}", path.display()),
        );
    }
    Ok(Some(store))
}

/// Read the store. A missing file is an empty store — the state every user
/// starts in — and an unreadable one is an error, never an empty list that a
/// later save would write over working sign-ins.
pub fn load() -> Result<Store, String> {
    if let Some(store) = read_file()? {
        return Ok(store);
    }
    let _guard = mutation_lock().lock().unwrap_or_else(|p| p.into_inner());
    // Re-check inside the lock: a parallel caller may have just migrated.
    if let Some(store) = read_file()? {
        return Ok(store);
    }
    Ok(migrate_legacy()?.unwrap_or_default())
}

/// Write-then-rename, so a crash mid-write leaves the previous file whole.
fn save(store: &Store) -> Result<(), String> {
    let path = store_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create {}: {err}", parent.display()))?;
    }
    let rendered = serde_json::to_string_pretty(store)
        .map_err(|err| format!("Failed to serialize Claude accounts: {err}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, rendered)
        .map_err(|err| format!("Failed to write {}: {err}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|err| {
        let _ = std::fs::remove_file(&tmp);
        format!("Failed to replace {}: {err}", path.display())
    })
}

fn mutate<T>(change: impl FnOnce(&mut Store) -> Result<T, String>) -> Result<T, String> {
    let mut store = load()?;
    let _guard = mutation_lock().lock().unwrap_or_else(|p| p.into_inner());
    // `load` may have migrated outside this guard; re-read under it so the
    // change applies to the latest file.
    if let Some(latest) = read_file()? {
        store = latest;
    }
    let out = change(&mut store)?;
    save(&store)?;
    Ok(out)
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

pub fn upsert(auth: StoredAuth, source: AccountSource) -> Result<String, String> {
    let now = chrono::Utc::now().to_rfc3339();
    mutate(|store| Ok(store.upsert(auth, source, &now)))
}

pub fn set_main(id: &str) -> Result<(), String> {
    mutate(|store| {
        if store.get(id).is_none() {
            return Err(format!("No stored Claude account {id}."));
        }
        store.main_id = Some(id.to_string());
        Ok(())
    })
}

pub fn remove(id: &str) -> Result<(), String> {
    mutate(|store| {
        store.remove(id);
        Ok(())
    })
}

/// Persist a refreshed token pair for one account. Keyed by id, not "main":
/// a refresh that started before the user switched accounts must land on the
/// account it was for.
pub fn write_auth_for(id: &str, auth: StoredAuth) -> Result<(), String> {
    mutate(|store| {
        let entry = store
            .accounts
            .iter_mut()
            .find(|a| a.id == id)
            .ok_or_else(|| format!("No stored Claude account {id}."))?;
        entry.auth = auth;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth(uuid: Option<&str>, token: &str) -> StoredAuth {
        StoredAuth {
            version: 1,
            access_token: token.into(),
            refresh_token: format!("r-{token}"),
            expires_at_ms: 0,
            refresh_expires_at_ms: 0,
            scopes: vec!["user:inference".into()],
            account_uuid: uuid.map(str::to_string),
            email: uuid.map(|u| format!("{u}@example.com")),
            display_name: None,
            organization_uuid: None,
            organization_type: None,
            rate_limit_tier: None,
            signed_in_at: None,
            last_refresh: None,
        }
    }

    const NOW: &str = "2026-09-25T00:00:00Z";

    #[test]
    fn the_first_account_becomes_main_and_later_ones_do_not() {
        let mut store = Store::default();
        let a = store.upsert(auth(Some("a"), "1"), AccountSource::SignIn, NOW);
        let b = store.upsert(auth(Some("b"), "2"), AccountSource::ClaudeCodeImport, NOW);
        assert_eq!(a, "a");
        assert_eq!(b, "b");
        assert_eq!(store.main().map(|m| m.id.as_str()), Some("a"));
    }

    /// Importing the account you already signed in replaces its tokens
    /// instead of listing the same person twice.
    #[test]
    fn the_same_account_updates_one_entry() {
        let mut store = Store::default();
        store.upsert(auth(Some("a"), "old"), AccountSource::SignIn, NOW);
        store.upsert(auth(Some("a"), "new"), AccountSource::ClaudeCodeImport, NOW);
        assert_eq!(store.accounts.len(), 1);
        assert_eq!(store.accounts[0].auth.access_token, "new");
        assert_eq!(store.accounts[0].source, AccountSource::ClaudeCodeImport);
    }

    #[test]
    fn an_account_without_a_uuid_still_gets_its_own_entry() {
        let mut store = Store::default();
        let x = store.upsert(auth(None, "1"), AccountSource::SignIn, NOW);
        let y = store.upsert(auth(None, "2"), AccountSource::SignIn, NOW);
        assert_ne!(x, y);
        assert_eq!(store.accounts.len(), 2);
    }

    #[test]
    fn removing_main_hands_main_to_the_next_account() {
        let mut store = Store::default();
        store.upsert(auth(Some("a"), "1"), AccountSource::SignIn, NOW);
        store.upsert(auth(Some("b"), "2"), AccountSource::SignIn, NOW);
        store.remove("a");
        assert_eq!(store.main_id.as_deref(), Some("b"));
        store.remove("b");
        assert!(store.main().is_none());
    }

    #[test]
    fn a_stale_main_pointer_falls_back_to_the_first_account() {
        let mut store = Store::default();
        store.upsert(auth(Some("a"), "1"), AccountSource::SignIn, NOW);
        store.main_id = Some("gone".into());
        assert_eq!(store.main().map(|m| m.id.as_str()), Some("a"));
    }
}
