//! How a client finds the running engine: `<root>/web/engine.json`, written
//! by `aurora serve` once it listens and removed when it stops.
//!
//! One engine per machine, any number of clients (`DOCS/rust-core-extraction.md`,
//! "One engine process"). A client reads the note, checks the port answers,
//! and connects; it never starts a second server beside it. The note carries
//! the sign-in token, so it lives in Aurora's own data folder like the token
//! file always has.
//!
//! A note left by a server that crashed is stale: [`find`] treats a port that
//! does not answer as no engine and removes the file.

use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// How long a client waits for the engine's port before calling it gone.
const PROBE_TIMEOUT: Duration = Duration::from_millis(300);

/// What a running engine tells its clients.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineNote {
    pub pid: u32,
    /// On 127.0.0.1.
    pub port: u16,
    pub token: String,
    pub version: String,
    pub started_at: String,
}

impl EngineNote {
    /// `http://127.0.0.1:<port>/agent-window`, without the token.
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/agent-window", self.port)
    }

    /// The same address with the token: opening it signs a browser in.
    pub fn sign_in_url(&self) -> String {
        format!("{}?token={}", self.url(), self.token)
    }
}

fn note_path() -> PathBuf {
    crate::paths::root().join("web").join("engine.json")
}

/// Removes the note when the engine stops, if it is still this process's.
#[must_use = "the note is removed when this guard drops"]
pub struct Announced {
    path: PathBuf,
    pid: u32,
}

impl Drop for Announced {
    fn drop(&mut self) {
        if read_at(&self.path).is_some_and(|note| note.pid == self.pid) {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Tell clients this process is the engine, listening on `port`.
pub fn announce(port: u16, token: &str) -> std::io::Result<Announced> {
    announce_at(note_path(), port, token)
}

fn announce_at(path: PathBuf, port: u16, token: &str) -> std::io::Result<Announced> {
    let note = EngineNote {
        pid: std::process::id(),
        port,
        token: token.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        started_at: chrono::Utc::now().to_rfc3339(),
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // Written whole, then renamed into place: a client never reads half a note.
    let partial = path.with_extension("json.partial");
    let body = serde_json::to_vec_pretty(&note).map_err(std::io::Error::other)?;
    std::fs::write(&partial, body)?;
    std::fs::rename(&partial, &path)?;
    Ok(Announced {
        path,
        pid: note.pid,
    })
}

/// The running engine, if there is one: the note exists and its port answers.
pub fn find() -> Option<EngineNote> {
    find_at(&note_path())
}

fn find_at(path: &PathBuf) -> Option<EngineNote> {
    let note = read_at(path)?;
    let addr = SocketAddr::from(([127, 0, 0, 1], note.port));
    if TcpStream::connect_timeout(&addr, PROBE_TIMEOUT).is_ok() {
        return Some(note);
    }
    crate::logging::log_info(
        "serve",
        &format!(
            "removing a stale engine note (pid {}, port {} does not answer)",
            note.pid, note.port
        ),
    );
    let _ = std::fs::remove_file(path);
    None
}

fn read_at(path: &PathBuf) -> Option<EngineNote> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_listening_engine_is_found_and_its_note_goes_when_it_stops() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("engine.json");
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();

        let announced = announce_at(path.clone(), port, "secret").expect("announce");
        let found = find_at(&path).expect("the engine answers");
        assert_eq!(found.port, port);
        assert_eq!(found.pid, std::process::id());
        assert_eq!(
            found.sign_in_url(),
            format!("http://127.0.0.1:{port}/agent-window?token=secret")
        );

        drop(announced);
        assert!(!path.exists(), "the note outlived the engine");
    }

    #[test]
    fn a_note_whose_port_is_dead_is_no_engine_and_is_cleared() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("engine.json");
        // Bind and drop: the port was real a moment ago and answers nothing now.
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
            listener.local_addr().expect("addr").port()
        };
        let announced = announce_at(path.clone(), port, "secret").expect("announce");
        std::mem::forget(announced); // a crashed server never removes its note

        assert_eq!(find_at(&path), None);
        assert!(!path.exists(), "a stale note was left behind");
    }
}
