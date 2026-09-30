//! Which local servers the agent started, and whether they answer.
//!
//! The dock's New tab page lists "Running" servers so a dev server the agent
//! just started is one click away. It used to offer a fixed guess list of
//! common ports (5173, 3000, 8000…), which showed ports nothing was listening
//! on and missed the one that was.
//!
//! A background process records everything it prints to a log file. Dev
//! servers announce their address on start (`Local: http://localhost:5173/`),
//! so the address is read out of the tail of that log, then checked over HTTP
//! with the same probe the navigate tool uses. Nothing here guesses a port.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;

use super::reachability::{self, Reach};

/// How much of a log to read. Dev servers print their address in the first
/// few lines, but a long-running one keeps logging requests after it, so the
/// start of the file can be far from the end. The tail is read first; the
/// head is read too when the file is longer than this.
const LOG_WINDOW: u64 = 64 * 1024;

/// A process rarely serves more than a couple of addresses worth offering
/// (Vite prints `Local` and `Network`; only local ones are kept).
const MAX_URLS_PER_PROCESS: usize = 2;

/// One local address a background process announced.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalServer {
    pub process_id: String,
    /// The name the agent gave the process, when it gave one.
    pub name: Option<String>,
    pub command: String,
    /// `http://localhost:5173` — scheme, host and port, no path.
    pub url: String,
    /// Something answered at `url` just now. A 404 counts: that is a page.
    pub answering: bool,
    pub started_at_ms: u64,
}

/// The input for one process, taken from the shell ledger.
pub struct ProcessLog {
    pub process_id: String,
    pub name: Option<String>,
    pub command: String,
    pub started_at_ms: u64,
    pub output_file: Option<String>,
}

/// Remove terminal colour and cursor codes.
///
/// Vite prints the port in bold — `http://localhost:\x1b[1m5173\x1b[22m/` — so
/// without this the address is split in the middle and reads as having no
/// port at all.
pub fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        // CSI: ESC [ params final-byte. Anything else: drop ESC and the next char.
        if chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
        } else {
            chars.next();
        }
    }
    out
}

/// Every local `http(s)` address in `text`, in the order first seen, as
/// `scheme://localhost:port`.
///
/// `0.0.0.0` and `[::1]` are rewritten to `localhost`: a server bound to all
/// interfaces is reached through localhost, and `0.0.0.0` is not a place a
/// browser can go. Addresses without a port are skipped — "http://localhost"
/// in a log is usually prose, not a server announcing itself.
pub fn local_urls(text: &str) -> Vec<String> {
    const HOSTS: [&str; 4] = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"];
    let clean = strip_ansi(text);
    let mut found: Vec<String> = Vec::new();
    let mut rest = clean.as_str();
    while let Some(at) = rest.find("http") {
        let candidate = &rest[at..];
        rest = &rest[at + 4..];
        let (scheme, after) = if let Some(after) = candidate.strip_prefix("https://") {
            ("https", after)
        } else if let Some(after) = candidate.strip_prefix("http://") {
            ("http", after)
        } else {
            continue;
        };
        let Some(host) = HOSTS.iter().find(|host| after.starts_with(**host)) else {
            continue;
        };
        let Some(port_part) = after[host.len()..].strip_prefix(':') else {
            continue;
        };
        let digits: String = port_part.chars().take_while(char::is_ascii_digit).collect();
        let Ok(port) = digits.parse::<u16>() else {
            continue;
        };
        if port == 0 {
            continue;
        }
        let url = format!("{scheme}://localhost:{port}");
        if !found.contains(&url) {
            found.push(url);
        }
    }
    found
}

/// The start and the end of a log, at most `LOG_WINDOW` bytes of each.
fn read_log_window(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let mut bytes = Vec::new();
    if len <= LOG_WINDOW * 2 {
        file.read_to_end(&mut bytes)?;
    } else {
        let mut head = vec![0; LOG_WINDOW as usize];
        file.read_exact(&mut head)?;
        file.seek(SeekFrom::Start(len - LOG_WINDOW))?;
        let mut tail = Vec::new();
        file.read_to_end(&mut tail)?;
        bytes.extend_from_slice(&head);
        bytes.push(b'\n');
        bytes.extend_from_slice(&tail);
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Read each process's log, pull out its local addresses, and ask each one
/// whether anything answers. A log that cannot be read is skipped: that
/// process is simply not offered, which is the honest outcome.
pub async fn find(processes: Vec<ProcessLog>) -> Vec<LocalServer> {
    let candidates = tokio::task::spawn_blocking(move || {
        let mut out: Vec<(ProcessLog, Vec<String>)> = Vec::new();
        for process in processes {
            let Some(path) = process.output_file.as_deref() else {
                continue;
            };
            let urls = match read_log_window(Path::new(path)) {
                Ok(text) => local_urls(&text),
                Err(error) => {
                    eprintln!("[local-servers] could not read {path}: {error}");
                    continue;
                }
            };
            if !urls.is_empty() {
                out.push((process, urls));
            }
        }
        out
    })
    .await
    .unwrap_or_default();

    let mut servers = Vec::new();
    for (process, urls) in candidates {
        for url in urls.into_iter().take(MAX_URLS_PER_PROCESS) {
            let answering = matches!(reachability::probe(&url).await, Reach::Answered { .. });
            servers.push(LocalServer {
                process_id: process.process_id.clone(),
                name: process.name.clone(),
                command: process.command.clone(),
                url,
                answering,
                started_at_ms: process.started_at_ms,
            });
        }
    }
    servers
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Vite's real start banner, colour codes and all. The port is wrapped in
    /// bold, which is exactly what splits a naive match.
    #[test]
    fn vites_banner_yields_its_local_address() {
        let banner = "\u{1b}[32m\u{1b}[1mVITE\u{1b}[22m v5.4.2\u{1b}[39m  ready in 312 ms\n\n  \
                      \u{1b}[32m➜\u{1b}[39m  \u{1b}[1mLocal\u{1b}[22m:   \
                      \u{1b}[36mhttp://localhost:\u{1b}[1m5173\u{1b}[22m/\u{1b}[39m\n  \
                      \u{1b}[32m➜\u{1b}[39m  \u{1b}[1mNetwork\u{1b}[22m: use --host to expose\n";
        assert_eq!(local_urls(banner), vec!["http://localhost:5173".to_string()]);
    }

    #[test]
    fn all_interface_and_loopback_hosts_become_localhost() {
        let log = "Listening on http://0.0.0.0:8000/ and http://127.0.0.1:8000\n\
                   also https://[::1]:8443/api";
        assert_eq!(
            local_urls(log),
            vec![
                "http://localhost:8000".to_string(),
                "https://localhost:8443".to_string()
            ]
        );
    }

    #[test]
    fn remote_hosts_and_portless_addresses_are_not_servers() {
        let log = "see https://vitejs.dev/config and http://localhost for docs\n\
                   proxying to http://api.example.com:8080";
        assert!(local_urls(log).is_empty());
    }

    #[test]
    fn repeats_are_listed_once_in_first_seen_order() {
        let log = "http://localhost:3001\nhttp://localhost:3000\nGET http://localhost:3001/x 200";
        assert_eq!(
            local_urls(log),
            vec![
                "http://localhost:3001".to_string(),
                "http://localhost:3000".to_string()
            ]
        );
    }

    #[test]
    fn a_long_log_keeps_its_start_banner() {
        let dir = std::env::temp_dir().join(format!("aurora-local-servers-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("server.log");
        let mut text = String::from("  Local:   http://localhost:5173/\n");
        // Enough request lines to push the banner far out of the tail window.
        while (text.len() as u64) < LOG_WINDOW * 3 {
            text.push_str("GET /assets/index.js 200 1ms\n");
        }
        std::fs::write(&path, &text).unwrap();
        let read = read_log_window(&path).unwrap();
        assert_eq!(local_urls(&read), vec!["http://localhost:5173".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A process whose log cannot be read is left out rather than failing the
    /// whole list.
    #[tokio::test]
    async fn an_unreadable_log_is_skipped() {
        let servers = find(vec![ProcessLog {
            process_id: "p1".into(),
            name: None,
            command: "pnpm dev".into(),
            started_at_ms: 0,
            output_file: Some("Z:/definitely/not/here.log".into()),
        }])
        .await;
        assert!(servers.is_empty());
    }
}
