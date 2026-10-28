//! Who may use `aurora serve` beyond the printed link: a password the owner
//! sets ON the machine, and the 30-day sessions it signs a browser into.
//!
//! Like code-server's `config.yaml`, the password lives in a file the owner
//! controls, `<root>/web/config.json`, but only as an argon2id hash, written by
//! `aurora serve password`. `AURORA_PASSWORD` in the environment (a systemd
//! unit, say) is the other way to set one, and wins when both exist.
//!
//! A session is a random id in an HttpOnly cookie; the engine keeps only its
//! SHA-256 in `<root>/web/sessions.json`, so the browser stays signed in across
//! restarts and nothing on disk can be replayed as a cookie. Setting or
//! clearing the password empties that file: every browser signs in again.
//! Both files are re-read when they change on disk, so `aurora serve password`
//! takes effect on a running server.
//!
//! Five wrong passwords within a minute lock the form until the oldest of them
//! is a minute old. The server only ever listens on 127.0.0.1 (`serve::run`),
//! so every attempt comes from this machine or an SSH tunnel into it.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::http::{header, HeaderMap};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::auth::constant_time_eq;

/// The cookie a signed-in browser holds.
pub const SESSION_COOKIE: &str = "aurora_session";
/// How long a browser stays signed in without signing in again.
pub const SESSION_DAYS: u64 = 30;
const SESSION_SECS: u64 = SESSION_DAYS * 24 * 60 * 60;
const MAX_FAILURES: usize = 5;
const FAILURE_WINDOW: Duration = Duration::from_secs(60);

const CONFIG_FILE: &str = "config.json";
const SESSIONS_FILE: &str = "sessions.json";

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    password_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredSession {
    /// SHA-256 of the cookie value, hex.
    hash: String,
    /// Unix seconds.
    expires: u64,
}

/// Why a password was not accepted.
#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    /// No password is set on this machine.
    NoPassword,
    Wrong,
    /// Too many wrong tries; try again in this many seconds.
    TooMany { wait_secs: u64 },
}

pub struct Access {
    dir: PathBuf,
    env_password: Option<String>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    config: Config,
    config_stamp: Option<(SystemTime, u64)>,
    sessions: Vec<StoredSession>,
    sessions_stamp: Option<(SystemTime, u64)>,
    failures: VecDeque<Instant>,
}

impl Access {
    /// This machine's access, from `<root>/web` and `AURORA_PASSWORD`.
    pub fn open() -> Self {
        let env_password = std::env::var("AURORA_PASSWORD")
            .ok()
            .filter(|password| !password.is_empty());
        Self::open_in(crate::paths::root().join("web"), env_password)
    }

    pub fn open_in(dir: PathBuf, env_password: Option<String>) -> Self {
        Self {
            dir,
            env_password,
            state: Mutex::new(State::default()),
        }
    }

    /// Whether anyone can sign in with a password here.
    pub fn password_set(&self) -> bool {
        self.env_password.is_some() || self.with_state(|state| state.config.password_hash.is_some())
    }

    /// Check a typed password, counting it against the limit when wrong.
    pub fn check_password(&self, attempt: &str) -> Result<(), Refused> {
        let now = Instant::now();
        let hash = self.with_state(|state| {
            while state
                .failures
                .front()
                .is_some_and(|at| now.duration_since(*at) >= FAILURE_WINDOW)
            {
                state.failures.pop_front();
            }
            if state.failures.len() >= MAX_FAILURES {
                let oldest = state.failures.front().copied().unwrap_or(now);
                let wait = FAILURE_WINDOW.saturating_sub(now.duration_since(oldest));
                return Err(Refused::TooMany {
                    wait_secs: wait.as_secs().max(1),
                });
            }
            Ok(state.config.password_hash.clone())
        })?;

        let accepted = match (&self.env_password, &hash) {
            (Some(env), _) => constant_time_eq(attempt.as_bytes(), env.as_bytes()),
            (None, Some(hash)) => PasswordHash::new(hash)
                .map(|parsed| Argon2::default().verify_password(attempt.as_bytes(), &parsed).is_ok())
                .unwrap_or_else(|error| {
                    crate::logging::log_error("serve", &format!("the stored password hash is unreadable: {error}"));
                    false
                }),
            (None, None) => return Err(Refused::NoPassword),
        };
        if accepted {
            self.with_state(|state| state.failures.clear());
            Ok(())
        } else {
            self.with_state(|state| state.failures.push_back(now));
            crate::logging::log_warn("serve", "a sign-in with a wrong password was refused");
            Err(Refused::Wrong)
        }
    }

    /// A new 30-day session; the returned id is the cookie value.
    pub fn new_session(&self) -> Result<String, String> {
        let id = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        let hash = digest(&id);
        let sessions = self.with_state(|state| {
            let now = unix_now();
            state.sessions.retain(|session| session.expires > now);
            state.sessions.push(StoredSession {
                hash,
                expires: now + SESSION_SECS,
            });
            state.sessions.clone()
        });
        self.write_sessions(&sessions)?;
        Ok(id)
    }

    pub fn session_valid(&self, id: &str) -> bool {
        let hash = digest(id);
        let now = unix_now();
        self.with_state(|state| {
            state
                .sessions
                .iter()
                .any(|session| session.expires > now && constant_time_eq(session.hash.as_bytes(), hash.as_bytes()))
        })
    }

    pub fn end_session(&self, id: &str) {
        let hash = digest(id);
        let sessions = self.with_state(|state| {
            state.sessions.retain(|session| session.hash != hash);
            state.sessions.clone()
        });
        if let Err(error) = self.write_sessions(&sessions) {
            crate::logging::log_warn("serve", &format!("could not save the sign-out: {error}"));
        }
    }

    /// Run `f` on the state after re-reading whichever file changed on disk.
    fn with_state<T>(&self, f: impl FnOnce(&mut State) -> T) -> T {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        let config_path = self.dir.join(CONFIG_FILE);
        let stamp = modified(&config_path);
        if stamp != state.config_stamp {
            state.config = read_json(&config_path).unwrap_or_default();
            state.config_stamp = stamp;
        }
        let sessions_path = self.dir.join(SESSIONS_FILE);
        let stamp = modified(&sessions_path);
        if stamp != state.sessions_stamp {
            state.sessions = read_json(&sessions_path).unwrap_or_default();
            state.sessions_stamp = stamp;
        }
        f(&mut state)
    }

    fn write_sessions(&self, sessions: &[StoredSession]) -> Result<(), String> {
        write_private(&self.dir.join(SESSIONS_FILE), sessions)?;
        // Our own write is not a change to re-read.
        let stamp = modified(&self.dir.join(SESSIONS_FILE));
        self.with_state(|state| state.sessions_stamp = stamp);
        Ok(())
    }
}

/// Store `password` as this machine's (argon2id), and sign every browser out.
pub fn set_password(dir: &Path, password: &str) -> Result<(), String> {
    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| format!("could not hash the password: {e}"))?
        .to_string();
    let mut config: Config = read_json(&dir.join(CONFIG_FILE)).unwrap_or_default();
    config.password_hash = Some(hash);
    write_private(&dir.join(CONFIG_FILE), &config)?;
    write_private(&dir.join(SESSIONS_FILE), &Vec::<StoredSession>::new())
}

/// Remove the password (the printed link is then the only way in), and sign
/// every browser out.
pub fn clear_password(dir: &Path) -> Result<(), String> {
    let mut config: Config = read_json(&dir.join(CONFIG_FILE)).unwrap_or_default();
    config.password_hash = None;
    write_private(&dir.join(CONFIG_FILE), &config)?;
    write_private(&dir.join(SESSIONS_FILE), &Vec::<StoredSession>::new())
}

/// The `Set-Cookie` for a new session.
pub fn session_cookie(id: &str) -> String {
    format!("{SESSION_COOKIE}={id}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_SECS}")
}

/// The `Set-Cookie` that removes it.
pub fn cleared_cookie() -> String {
    format!("{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0")
}

/// The session id a request carries, if any.
pub fn session_from(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, value)| *name == SESSION_COOKIE && !value.is_empty())
        .map(|(_, value)| value.to_string())
}

fn digest(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// When the file last changed, with its size: a coarse clock can give two
/// writes in one tick the same time, and the size usually tells them apart.
fn modified(path: &Path) -> Option<(SystemTime, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str(&text) {
        Ok(value) => Some(value),
        Err(error) => {
            crate::logging::log_error("serve", &format!("{} is unreadable: {error}", path.display()));
            None
        }
    }
}

/// Write JSON readable by this user only (the hash and the sessions are the
/// keys to the machine), through a temp file so a crash never leaves half a file.
fn write_private<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<(), String> {
    let dir = path.parent().ok_or("no folder for the access file")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text).map_err(|e| format!("could not write {}: {e}", temp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("could not protect {}: {e}", temp.display()))?;
    }
    std::fs::rename(&temp, path).map_err(|e| format!("could not save {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn access(dir: &Path) -> Access {
        Access::open_in(dir.to_path_buf(), None)
    }

    #[test]
    fn no_password_means_no_password_sign_in() {
        let dir = tempfile::tempdir().unwrap();
        let access = access(dir.path());
        assert!(!access.password_set());
        assert_eq!(access.check_password("anything"), Err(Refused::NoPassword));
    }

    #[test]
    fn the_stored_password_is_a_hash_and_only_it_signs_in() {
        let dir = tempfile::tempdir().unwrap();
        set_password(dir.path(), "correct horse").unwrap();
        let stored = std::fs::read_to_string(dir.path().join(CONFIG_FILE)).unwrap();
        assert!(stored.contains("$argon2id$") && !stored.contains("correct horse"));

        let access = access(dir.path());
        assert!(access.password_set());
        assert_eq!(access.check_password("correct horse"), Ok(()));
        assert_eq!(access.check_password("wrong"), Err(Refused::Wrong));
    }

    #[test]
    fn five_wrong_tries_lock_the_form_even_for_the_right_password() {
        let dir = tempfile::tempdir().unwrap();
        set_password(dir.path(), "pw").unwrap();
        let access = access(dir.path());
        for _ in 0..MAX_FAILURES {
            assert_eq!(access.check_password("nope"), Err(Refused::Wrong));
        }
        assert!(matches!(access.check_password("pw"), Err(Refused::TooMany { .. })));
    }

    #[test]
    fn a_session_survives_a_restart_and_a_new_password_ends_it() {
        let dir = tempfile::tempdir().unwrap();
        set_password(dir.path(), "pw").unwrap();
        let id = access(dir.path()).new_session().unwrap();
        // A restart is a fresh `Access` on the same folder.
        let restarted = access(dir.path());
        assert!(restarted.session_valid(&id));
        assert!(!restarted.session_valid("someone-elses-cookie"));
        // Only the hash is on disk.
        let on_disk = std::fs::read_to_string(dir.path().join(SESSIONS_FILE)).unwrap();
        assert!(!on_disk.contains(&id));

        // Changing the password on a running server signs this browser out.
        set_password(dir.path(), "new").unwrap();
        assert!(!restarted.session_valid(&id));
    }

    #[test]
    fn signing_out_ends_only_that_session() {
        let dir = tempfile::tempdir().unwrap();
        let access = access(dir.path());
        let a = access.new_session().unwrap();
        let b = access.new_session().unwrap();
        access.end_session(&a);
        assert!(!access.session_valid(&a));
        assert!(access.session_valid(&b));
    }

    #[test]
    fn the_environment_password_wins() {
        let dir = tempfile::tempdir().unwrap();
        set_password(dir.path(), "file").unwrap();
        let access = Access::open_in(dir.path().to_path_buf(), Some("env".into()));
        assert_eq!(access.check_password("env"), Ok(()));
        assert_eq!(access.check_password("file"), Err(Refused::Wrong));
    }

    #[test]
    fn the_cookie_is_found_among_others_and_lasts_thirty_days() {
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, "a=1; aurora_session=abc; b=2".parse().unwrap());
        assert_eq!(session_from(&headers).as_deref(), Some("abc"));
        assert!(session_cookie("abc").contains("Max-Age=2592000") && session_cookie("abc").contains("HttpOnly"));
    }
}
