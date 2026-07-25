//! Windows Terminal profile import.
//!
//! Windows Terminal already holds the answer to "which shells does this user
//! actually use, and what are they called" — including hand-registered ones
//! Aurora could never guess, like a Git install outside `Program Files`.
//! Reading it means the common case needs **zero** manual path entry.
//!
//! Two sources are merged:
//!
//! 1. `settings.json` — the user's own profile list. Only profiles the user
//!    authored carry a `commandline`; profiles produced by Windows Terminal's
//!    built-in *generators* (`Windows.Terminal.PowershellCore`,
//!    `Windows.Terminal.Wsl`, …) have an empty one because the executable is
//!    resolved inside Windows Terminal at runtime.
//! 2. `Fragments\**\*.json` — extension fragments dropped by installers
//!    (Git ships one, so does Nushell). These *do* carry a real commandline
//!    and are matched back onto settings profiles by GUID.
//!
//! Because generator-backed profiles have no path on disk, this import can
//! never be the only discovery source — [`super::discovery`] still probes
//! `PATH`, the registry, and well-known locations. It is a source of *names,
//! user intent, and unguessable paths*, not a complete inventory.
//!
//! Everything here is best-effort: a malformed or absent file yields an empty
//! result and never fails a scan.

use std::path::{Path, PathBuf};

use serde_json::Value;

/// A shell-capable profile lifted out of Windows Terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalProfile {
    /// The profile's display name, emoji and all — this is what the user
    /// recognises, so it becomes the Aurora profile label.
    pub name: String,
    /// Executable, still in raw form (`%PROGRAMFILES%\…` is preserved).
    pub raw_exe: String,
    /// Arguments that followed the executable in `commandline`. Aurora does
    /// **not** execute these — they describe an interactive session
    /// (`-i -l`, `/k …`) — but they are used to reject wrapper profiles.
    pub args: Vec<String>,
    /// True when this is Windows Terminal's `defaultProfile`.
    pub is_default: bool,
}

/// Read every shell-capable Windows Terminal profile on this machine.
///
/// Returns an empty vector on non-Windows hosts, when Windows Terminal is not
/// installed, or when its settings cannot be parsed.
#[must_use]
pub fn discover() -> Vec<TerminalProfile> {
    let Some(settings_path) = settings_files().into_iter().find(|p| p.is_file()) else {
        return Vec::new();
    };
    let Some(root) = read_json(&settings_path) else {
        return Vec::new();
    };

    let default_guid = root
        .get("defaultProfile")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();

    let fragments = fragment_commandlines();

    let list = root
        .get("profiles")
        .and_then(|profiles| profiles.get("list"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut out = Vec::new();
    for entry in list {
        if entry
            .get("hidden")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }
        let guid = entry
            .get("guid")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();

        // A generator-backed profile has no commandline of its own; an
        // installer fragment with the same GUID may supply one.
        let commandline = entry
            .get("commandline")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| {
                fragments
                    .iter()
                    .find(|(fragment_guid, _)| !guid.is_empty() && *fragment_guid == guid)
                    .map(|(_, commandline)| commandline.clone())
            });

        let Some(commandline) = commandline else {
            continue;
        };
        let Some((raw_exe, args)) = split_commandline(&commandline) else {
            continue;
        };

        let name = entry
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Windows Terminal profile")
            .to_string();

        out.push(TerminalProfile {
            name,
            raw_exe,
            args,
            is_default: !guid.is_empty() && guid == default_guid,
        });
    }
    out
}

/// True when a profile's arguments show it launches something *through* the
/// shell rather than being a plain shell.
///
/// Windows Terminal profiles describe interactive sessions, so wrappers are
/// common: `cmd.exe /k "…\VsDevCmd.bat"` opens a developer prompt that never
/// exits. Importing that as a plain `cmd` profile would be wrong twice over —
/// it duplicates the real `cmd.exe` entry, and `/k` would hang any agent
/// command forever if the arguments were ever honoured.
#[must_use]
pub fn is_wrapper(args: &[String]) -> bool {
    args.iter().any(|arg| {
        let lower = arg.to_ascii_lowercase();
        lower == "/k"
            || lower.ends_with(".bat")
            || lower.ends_with(".cmd")
            || lower.ends_with(".ps1")
            || lower.ends_with(".vbs")
    })
}

/// Candidate `settings.json` locations, most specific first: Store install,
/// Store preview install, then the unpackaged/portable layout.
fn settings_files() -> Vec<PathBuf> {
    let Some(local) = local_app_data() else {
        return Vec::new();
    };
    vec![
        local
            .join("Packages")
            .join("Microsoft.WindowsTerminal_8wekyb3d8bbwe")
            .join("LocalState")
            .join("settings.json"),
        local
            .join("Packages")
            .join("Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe")
            .join("LocalState")
            .join("settings.json"),
        local
            .join("Microsoft")
            .join("Windows Terminal")
            .join("settings.json"),
    ]
}

/// `(lowercase guid, commandline)` pairs from every installed fragment.
fn fragment_commandlines() -> Vec<(String, String)> {
    let mut dirs = Vec::new();
    if let Some(local) = local_app_data() {
        dirs.push(
            local
                .join("Microsoft")
                .join("Windows Terminal")
                .join("Fragments"),
        );
    }
    if let Ok(program_data) = std::env::var("ProgramData") {
        dirs.push(
            PathBuf::from(program_data)
                .join("Microsoft")
                .join("Windows Terminal")
                .join("Fragments"),
        );
    }

    let mut out = Vec::new();
    for dir in dirs {
        collect_fragments(&dir, &mut out, 0);
    }
    out
}

/// Fragments live one directory deep (`Fragments\<app>\<file>.json`); the
/// depth cap keeps a stray deep tree from turning a scan into a filesystem
/// walk.
fn collect_fragments(dir: &Path, out: &mut Vec<(String, String)>, depth: usize) {
    if depth > 2 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_fragments(&path, out, depth + 1);
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(root) = read_json(&path) else {
            continue;
        };
        let Some(profiles) = root.get("profiles").and_then(Value::as_array) else {
            continue;
        };
        for profile in profiles {
            let (Some(guid), Some(commandline)) = (
                profile.get("guid").and_then(Value::as_str),
                profile.get("commandline").and_then(Value::as_str),
            ) else {
                continue;
            };
            out.push((guid.to_ascii_lowercase(), commandline.to_string()));
        }
    }
}

fn local_app_data() -> Option<PathBuf> {
    std::env::var("LOCALAPPDATA")
        .ok()
        .map(PathBuf::from)
        .or_else(dirs::data_local_dir)
}

fn read_json(path: &Path) -> Option<Value> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw)
        .ok()
        .or_else(|| serde_json::from_str(&strip_jsonc(&raw)).ok())
}

/// Windows Terminal writes JSONC: a freshly generated `settings.json` is full
/// of `//` commentary, and hand-edited files often carry trailing commas.
/// `serde_json` rejects both, so a tolerant pass runs when strict parsing
/// fails. String literals are respected, so a `//` inside a path survives.
fn strip_jsonc(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;

    while let Some(ch) = chars.next() {
        if in_string {
            out.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => {
                in_string = true;
                out.push(ch);
            }
            '/' if chars.peek() == Some(&'/') => {
                for next in chars.by_ref() {
                    if next == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut previous = '\0';
                for next in chars.by_ref() {
                    if previous == '*' && next == '/' {
                        break;
                    }
                    previous = next;
                }
            }
            _ => out.push(ch),
        }
    }

    strip_trailing_commas(&out)
}

fn strip_trailing_commas(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_string = false;
    let mut escaped = false;

    for ch in raw.chars() {
        if in_string {
            out.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
            out.push(ch);
            continue;
        }
        if ch == '}' || ch == ']' {
            while out
                .chars()
                .next_back()
                .is_some_and(|last| last.is_whitespace())
            {
                out.pop();
            }
            if out.chars().next_back() == Some(',') {
                out.pop();
            }
        }
        out.push(ch);
    }
    out
}

/// Split a Windows `commandline` string into executable + arguments.
///
/// Follows the quoting rule that matters here: a double-quoted run is one
/// token and the quotes are stripped. Paths with spaces
/// (`"C:\Program Files\Git\bin\bash.exe" -i -l`) are the whole reason this
/// exists.
#[must_use]
pub fn split_commandline(commandline: &str) -> Option<(String, Vec<String>)> {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut has_token = false;

    for ch in commandline.chars() {
        match ch {
            '"' => {
                in_quotes = !in_quotes;
                has_token = true;
            }
            c if c.is_whitespace() && !in_quotes => {
                if has_token {
                    tokens.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            c => {
                current.push(c);
                has_token = true;
            }
        }
    }
    if has_token {
        tokens.push(current);
    }

    let mut iter = tokens.into_iter();
    let exe = iter.next()?;
    if exe.trim().is_empty() {
        return None;
    }
    Some((exe, iter.collect()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_a_quoted_executable_from_its_arguments() {
        let (exe, args) =
            split_commandline(r#""%PROGRAMFILES%\Git\bin\bash.exe" -i -l"#).expect("split");
        assert_eq!(exe, r"%PROGRAMFILES%\Git\bin\bash.exe");
        assert_eq!(args, vec!["-i".to_string(), "-l".to_string()]);
    }

    #[test]
    fn splits_an_unquoted_executable() {
        let (exe, args) = split_commandline("cmd.exe /k ver").expect("split");
        assert_eq!(exe, "cmd.exe");
        assert_eq!(args, vec!["/k".to_string(), "ver".to_string()]);
    }

    #[test]
    fn detects_batch_and_k_wrappers() {
        assert!(is_wrapper(&[
            "/k".into(),
            r"C:\VS\Common7\Tools\VsDevCmd.bat".into()
        ]));
        assert!(is_wrapper(&[r"C:\tools\setup.cmd".into()]));
        assert!(!is_wrapper(&["-i".into(), "-l".into()]));
        assert!(!is_wrapper(&[]));
    }

    #[test]
    fn parses_jsonc_with_comments_and_trailing_commas() {
        let raw = r#"
        {
            // the shell the user opens by default
            "defaultProfile": "{abc}",
            "profiles": {
                "list": [
                    { "name": "Git Bash", "commandline": "\"C:/Git/bin/bash.exe\" -i -l", },
                ],
            },
        }
        "#;
        let parsed: Value = serde_json::from_str(&strip_jsonc(raw)).expect("tolerant parse");
        assert_eq!(parsed["defaultProfile"], "{abc}");
        assert_eq!(parsed["profiles"]["list"][0]["name"], "Git Bash");
    }

    #[test]
    fn keeps_double_slashes_inside_strings() {
        let raw = r#"{ "icon": "https://example.com/a.ico" }"#;
        let parsed: Value = serde_json::from_str(&strip_jsonc(raw)).expect("parse");
        assert_eq!(parsed["icon"], "https://example.com/a.ico");
    }
}
