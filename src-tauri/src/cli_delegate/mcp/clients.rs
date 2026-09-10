//! Who is connected to `aurora mcp` right now.
//!
//! The settings page could tell you how to connect an outside agent and could
//! not tell you whether one ever had. That is the wrong way round for a switch
//! that hands another program the keys to your editor: the useful question is
//! not "how do I connect" but "what is connected".
//!
//! ## Why a directory of files
//!
//! Every MCP connection is its OWN process. The other agent spawns
//! `aurora mcp`, talks to it over that process's stdio, and the running Aurora
//! is not in that conversation at all — it learns nothing, because nothing
//! tells it. [`super::super::bridge`] is the app publishing outward; there was
//! no inward channel.
//!
//! So each server process announces itself in a file of its own. One file each,
//! rather than a shared list, because two agents connecting in the same
//! millisecond would otherwise race to rewrite the same document, and the loser
//! would vanish.
//!
//! ## Why a heartbeat rather than a pid check
//!
//! [`super::super::presence`] argues against pid files and it is right: a pid
//! answers "is *some* process alive", and the OS recycles numbers. A killed
//! `aurora mcp` never runs its cleanup, so something has to decide the file is
//! stale.
//!
//! A heartbeat decides it without asking the OS anything. The server touches
//! its own file every [`HEARTBEAT_SECS`]; a file older than [`STALE_AFTER_SECS`]
//! is three missed beats and is treated as gone. That is also correct for a
//! connection sitting idle for hours, which a "last request" timestamp would
//! wrongly declare dead.
//!
//! The count is a display, not a permission. Nothing is gated on it, so being
//! briefly wrong after a crash costs a stale row for under a minute and no
//! more.

use std::fs;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::paths;

/// Bumped when a field changes meaning. A reader that finds a version it does
/// not know skips the row rather than guessing.
pub const CLIENT_FORMAT_VERSION: u32 = 1;

/// How often a connected server re-stamps its file.
pub const HEARTBEAT_SECS: u64 = 20;

/// Past this, a file is three missed beats old and its process is presumed
/// gone. Generous on purpose: a laptop that slept mid-connection should drop
/// the row, not a server that was briefly descheduled.
pub const STALE_AFTER_SECS: u64 = 60;

/// One agent connected to this machine's Aurora.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpClientSession {
    pub version: u32,
    /// Unique per connection, not per process: one agent may reconnect.
    pub session_id: String,
    pub pid: u32,
    /// What the client called itself in `initialize`, e.g. "claude-code".
    /// `None` when it sent no `clientInfo`, which the spec permits.
    pub client_name: Option<String>,
    pub client_version: Option<String>,
    pub connected_at_ms: i64,
    /// Last heartbeat. Freshness, not activity — an idle connection keeps
    /// stamping this.
    pub last_seen_ms: i64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn session_path(session_id: &str) -> std::path::PathBuf {
    paths::mcp_clients_dir().join(format!("{session_id}.json"))
}

/// Write one session file atomically, so a reader mid-write sees the old file
/// or the new one and never half of either.
fn write_session(session: &McpClientSession) -> std::io::Result<()> {
    let final_path = session_path(&session.session_id);
    let temp_path = final_path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(session)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    {
        let mut file = fs::File::create(&temp_path)?;
        file.write_all(json.as_bytes())?;
        file.flush()?;
    }
    fs::rename(&temp_path, &final_path)
}

/// A registered connection. Dropping it removes the file, so a clean exit
/// leaves nothing behind and the count is right immediately rather than after
/// a timeout.
pub struct SessionHandle {
    session_id: String,
    stop: Arc<AtomicBool>,
}

impl Drop for SessionHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = fs::remove_file(session_path(&self.session_id));
    }
}

/// Announce this connection and start its heartbeat.
///
/// Returns `None` when the file cannot be written. That is deliberately not an
/// error the caller has to handle: an unwritable state directory must not stop
/// an agent from driving Aurora, it only costs the count.
pub fn register(client_name: Option<String>, client_version: Option<String>) -> Option<SessionHandle> {
    let pid = std::process::id();
    let started = now_ms();
    // Pid plus start time: unique across reconnects by the same process, and
    // readable in a directory listing when something needs debugging.
    let session_id = format!("{pid}-{started}");

    let session = McpClientSession {
        version: CLIENT_FORMAT_VERSION,
        session_id: session_id.clone(),
        pid,
        client_name,
        client_version,
        connected_at_ms: started,
        last_seen_ms: started,
    };
    write_session(&session).ok()?;

    let stop = Arc::new(AtomicBool::new(false));
    let beat_stop = Arc::clone(&stop);
    // A detached thread rather than a timer on the request loop: the loop
    // blocks on stdin, so an idle connection would stop stamping and be read
    // as dead exactly when it is most alive.
    std::thread::spawn(move || {
        let mut session = session;
        while !beat_stop.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_secs(HEARTBEAT_SECS));
            if beat_stop.load(Ordering::Relaxed) {
                break;
            }
            session.last_seen_ms = now_ms();
            let _ = write_session(&session);
        }
    });

    Some(SessionHandle { session_id, stop })
}

/// Every connection that is currently alive, newest first.
///
/// Prunes what it finds stale as it goes, so a crashed client's file does not
/// accumulate. A prune failure is ignored: the row is already excluded from
/// the answer, and a directory Aurora cannot write to is not this function's
/// problem to report.
pub fn list_live() -> Vec<McpClientSession> {
    let cutoff = now_ms() - (STALE_AFTER_SECS as i64) * 1000;
    let Ok(entries) = fs::read_dir(paths::mcp_clients_dir()) else {
        return Vec::new();
    };

    let mut live: Vec<McpClientSession> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(session) = serde_json::from_str::<McpClientSession>(&raw) else {
            // Unreadable or a shape this build does not know. Left alone rather
            // than deleted: a newer Aurora's file is not this one's to remove.
            continue;
        };
        if session.version != CLIENT_FORMAT_VERSION {
            continue;
        }
        if session.last_seen_ms < cutoff {
            let _ = fs::remove_file(&path);
            continue;
        }
        live.push(session);
    }

    live.sort_by(|a, b| b.connected_at_ms.cmp(&a.connected_at_ms));
    live
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, last_seen_ms: i64) -> McpClientSession {
        McpClientSession {
            version: CLIENT_FORMAT_VERSION,
            session_id: id.into(),
            pid: 1234,
            client_name: Some("claude-code".into()),
            client_version: Some("1.0.0".into()),
            connected_at_ms: last_seen_ms,
            last_seen_ms,
        }
    }

    /// Serialising and reading back is the whole contract between two
    /// processes that never speak.
    #[test]
    fn a_session_round_trips_through_its_file_shape() {
        let original = session("1-2", 42);
        let raw = serde_json::to_string(&original).expect("serialize");
        let back: McpClientSession = serde_json::from_str(&raw).expect("parse");
        assert_eq!(back.session_id, "1-2");
        assert_eq!(back.client_name.as_deref(), Some("claude-code"));
        assert_eq!(back.pid, 1234);
        // camelCase on the wire — the frontend reads these keys directly.
        assert!(raw.contains("\"sessionId\""), "{raw}");
        assert!(raw.contains("\"clientName\""), "{raw}");
        assert!(raw.contains("\"lastSeenMs\""), "{raw}");
    }

    /// `clientInfo` is optional in the MCP spec, so a client that sends none
    /// must still be counted rather than dropped.
    #[test]
    fn a_client_that_names_itself_nothing_is_still_a_client() {
        let raw = r#"{"version":1,"sessionId":"9-9","pid":9,"connectedAtMs":1,"lastSeenMs":1}"#;
        let parsed: McpClientSession = serde_json::from_str(raw).expect("parse");
        assert!(parsed.client_name.is_none());
        assert_eq!(parsed.session_id, "9-9");
    }

    /// Three missed beats is the line. A generous window on purpose: a briefly
    /// descheduled server must not vanish from the count.
    #[test]
    fn the_stale_window_is_several_heartbeats_wide() {
        assert!(
            STALE_AFTER_SECS >= HEARTBEAT_SECS * 3,
            "a single slow beat must not drop a live connection"
        );
    }

    /// Dropping the handle is what makes a clean disconnect immediate rather
    /// than something the reader waits out.
    #[test]
    fn dropping_the_handle_removes_the_file() {
        let handle = register(Some("test-agent".into()), None).expect("registered");
        let path = session_path(&handle.session_id);
        assert!(path.exists(), "register must write its file");
        let id = handle.session_id.clone();
        drop(handle);
        assert!(!session_path(&id).exists(), "drop must clean up");
    }

    #[test]
    fn a_live_registration_is_listed_and_a_stale_file_is_pruned() {
        let handle = register(Some("live-agent".into()), None).expect("registered");
        let listed = list_live();
        assert!(
            listed.iter().any(|s| s.session_id == handle.session_id),
            "a just-registered client must be listed"
        );

        // A file whose heartbeat stopped long ago is gone, and removed.
        let stale = session("stale-0", now_ms() - (STALE_AFTER_SECS as i64 + 60) * 1000);
        write_session(&stale).expect("write");
        let after = list_live();
        assert!(!after.iter().any(|s| s.session_id == "stale-0"));
        assert!(!session_path("stale-0").exists(), "stale files are pruned");

        drop(handle);
    }
}
