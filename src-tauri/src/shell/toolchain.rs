//! Which command-line tools this machine has — presence, never versions.
//!
//! The agent asked for `python`, got `command not found`, and spent three
//! round-trips (a `which`, a PowerShell probe, then `py`) working out that the
//! tool existed under another name. "Python isn't installed" was one wrong
//! turn away. A short list of what IS here lets the model pick `pnpm` over
//! `npm` and `python` over `py` before its first command, and stops it
//! concluding that a missing name means a missing tool.
//!
//! Presence only, by design. Reporting a version means running every tool,
//! and some take hundreds of milliseconds or hang without a console; the
//! model runs `node --version` when a version matters, which is what a person
//! does. Presence is a directory listing and costs milliseconds.
//!
//! Looked up against the PATH the agent's shells actually run with — the
//! merged one from [`super::env`], plus Git's userland when a POSIX shell is
//! registered — so `curl` and `ssh` from Git count and a tool Explorer's stale
//! PATH hides does not vanish from the list.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::env;

/// Names worth reporting. Well-known developer tools, the way models type
/// them. A name missing here is simply not reported, so the block says so.
pub const WELL_KNOWN: &[&str] = &[
    // Runtimes and compilers
    "node", "bun", "deno", "python", "python3", "py", "ruby", "php", "java", "javac", "kotlin",
    "kotlinc", "dotnet", "go", "cargo", "rustc", "rustup", "gcc", "g++", "clang", "clang++",
    "cl", "swift", "dart", "flutter", "zig", "perl", "lua", "julia", "Rscript", "elixir", "erl",
    // Package and build managers
    "npm", "pnpm", "yarn", "npx", "corepack", "volta", "nvm", "pip", "pipx", "uv", "poetry",
    "conda", "gem", "bundle", "composer", "mvn", "gradle", "cmake", "make", "ninja", "msbuild",
    "vcpkg", "choco", "scoop", "winget", "brew", "apt", "nix",
    // Source control, containers, cloud
    "git", "gh", "glab", "svn", "hg", "docker", "podman", "kubectl", "helm", "minikube",
    "terraform", "pulumi", "aws", "az", "gcloud", "wrangler", "vercel", "netlify", "firebase",
    "supabase", "fly", "heroku", "ngrok", "cloudflared", "ssh", "scp", "rsync",
    // Everyday utilities and databases
    "rg", "fd", "jq", "yq", "curl", "wget", "tar", "zip", "unzip", "7z", "ffmpeg", "magick",
    "psql", "mysql", "sqlite3", "redis-cli", "mongosh", "protoc", "adb", "code", "cursor", "tsc",
    "eslint", "prettier", "vite", "esbuild", "wasm-pack",
];

/// One tool that was actually found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundTool {
    pub name: String,
    /// Where it resolved, for the settings page. Never sent to the model.
    pub path: String,
}

/// The directories the agent's shells search, in order.
#[must_use]
pub fn search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(profile) = super::snapshot().default_profile() {
        if profile.kind.is_posix() {
            if let Some(root) = env::msys_root(Path::new(&profile.resolved_exe())) {
                dirs.extend(env::msys_path_dirs(&root));
            }
        }
    }
    dirs.extend(std::env::split_paths(&env::effective_path()));
    dirs
}

/// Every well-known tool present on this machine, sorted by name.
#[must_use]
pub fn inventory() -> Vec<FoundTool> {
    inventory_in(&search_dirs(), WELL_KNOWN)
}

/// [`inventory`] over explicit directories and names — the testable core.
#[must_use]
pub fn inventory_in(dirs: &[PathBuf], names: &[&str]) -> Vec<FoundTool> {
    let index = PathIndex::scan(dirs);
    let mut found: Vec<FoundTool> = names
        .iter()
        .filter_map(|name| {
            index.lookup(name).map(|path| FoundTool {
                name: (*name).to_string(),
                path: path.to_string_lossy().to_string(),
            })
        })
        .collect();
    found.sort_by(|a, b| a.name.cmp(&b.name));
    found.dedup_by(|a, b| a.name == b.name);
    found
}

/// The `<machine_tools>` block for the first user message, or `None` when
/// nothing was found. Names only, sorted, so the bytes are identical on every
/// request of a conversation and sit inside the provider's cached prefix.
#[must_use]
pub fn context_block(found: &[FoundTool]) -> Option<String> {
    if found.is_empty() {
        return None;
    }
    let names = found
        .iter()
        .map(|tool| tool.name.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    Some(format!(
        "<machine_tools>\n\
         Command-line tools present on this machine, found on the PATH your shell commands run \
         with when this conversation started: {names}.\n\
         This is presence only, checked once at the start of the conversation. Run `<tool> \
         --version` when the version matters. It covers well-known names, not everything \
         installed, so try a tool before concluding it is missing.\n\
         </machine_tools>"
    ))
}

/// One directory listing per PATH entry, then hash lookups — instead of one
/// filesystem probe per (name × extension × directory), which on a 100-entry
/// PATH is tens of thousands of stat calls.
struct PathIndex {
    /// Lowercased file name → (full path, size). First directory wins, the
    /// same rule the OS loader applies.
    files: HashMap<String, (PathBuf, u64)>,
}

impl PathIndex {
    fn scan(dirs: &[PathBuf]) -> Self {
        let mut files = HashMap::new();
        let mut seen_dirs = std::collections::HashSet::new();
        for dir in dirs {
            let key = dir.to_string_lossy().replace('/', "\\").to_lowercase();
            if dir.as_os_str().is_empty() || !seen_dirs.insert(key) {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let Ok(meta) = entry.metadata() else { continue };
                if !meta.is_file() || !is_executable(&meta) {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_lowercase();
                files
                    .entry(name)
                    .or_insert_with(|| (entry.path(), meta.len()));
            }
        }
        Self { files }
    }

    fn lookup(&self, name: &str) -> Option<&Path> {
        let lower = name.to_lowercase();
        for candidate in candidate_file_names(&lower) {
            if let Some((path, len)) = self.files.get(&candidate) {
                if *len == 0 && !zero_byte_alias_is_real(path) {
                    continue;
                }
                return Some(path);
            }
        }
        None
    }
}

/// The file names a bare command may resolve to. Windows applies `PATHEXT`;
/// the shells Aurora runs cover `.exe`, `.cmd` (npm, pnpm, and every other
/// package-manager shim), `.bat`, and `.com`.
fn candidate_file_names(lower: &str) -> Vec<String> {
    if cfg!(windows) {
        ["exe", "cmd", "bat", "com"]
            .iter()
            .map(|ext| format!("{lower}.{ext}"))
            .collect()
    } else {
        vec![lower.to_string()]
    }
}

#[cfg(windows)]
fn is_executable(_meta: &std::fs::Metadata) -> bool {
    true
}

#[cfg(not(windows))]
fn is_executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

/// A zero-byte executable is a Windows Store *app execution alias*, and two
/// kinds look identical from the outside. A real one belongs to an installed
/// package, which keeps a second copy of the alias under its own package
/// folder (`WindowsApps\<Package_family>\wt.exe`). The `python.exe` that
/// Windows ships on a machine with NO Python is also a zero-byte alias, owned
/// by the App Installer package, and running it opens the Store. Only the
/// first kind counts as present.
///
/// Measured layout on 2026-09-02: `Microsoft.DesktopAppInstaller_…` holds
/// `python.exe`, `python3.exe` (the Store redirects) AND `winget.exe` (a real
/// program that package genuinely owns); `PythonSoftwareFoundation.…` holds
/// the real `python.exe`. So the App Installer folder is disqualifying only
/// for the names it redirects.
fn zero_byte_alias_is_real(alias: &Path) -> bool {
    let Some(dir) = alias.parent() else {
        return false;
    };
    let Some(name) = alias.file_name() else {
        return false;
    };
    if !dir
        .file_name()
        .is_some_and(|d| d.to_string_lossy().eq_ignore_ascii_case("WindowsApps"))
    {
        // Not a Store alias at all — an empty file somewhere else is just
        // not a program.
        return false;
    }
    let lower_name = name.to_string_lossy().to_lowercase();
    let is_store_redirect_name = matches!(
        lower_name.as_str(),
        "python.exe" | "python3.exe" | "pythonw.exe"
    );
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let package = entry.file_name().to_string_lossy().to_string();
        let redirect_stub =
            is_store_redirect_name && package.starts_with("Microsoft.DesktopAppInstaller");
        entry.path().is_dir() && !redirect_stub && entry.path().join(name).is_file()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exe_name(base: &str) -> String {
        format!("{base}{}", std::env::consts::EXE_SUFFIX)
    }

    fn place(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    #[test]
    fn finds_tools_it_placed_and_ignores_the_rest() {
        let tmp = tempfile::tempdir().unwrap();
        place(tmp.path(), &exe_name("node"), b"x");
        place(tmp.path(), "README.txt", b"x");
        let found = inventory_in(&[tmp.path().to_path_buf()], &["node", "pnpm", "python"]);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].name, "node");
        assert!(found[0].path.ends_with(&exe_name("node")));
    }

    #[cfg(windows)]
    #[test]
    fn package_manager_shims_count_on_windows() {
        // `pnpm` and `npm` are `.cmd` files, not `.exe`; a lookup that only
        // knew `.exe` would report every package manager as absent.
        let tmp = tempfile::tempdir().unwrap();
        place(tmp.path(), "pnpm.cmd", b"@echo off");
        let found = inventory_in(&[tmp.path().to_path_buf()], &["pnpm"]);
        assert_eq!(found.len(), 1, "{found:?}");
    }

    #[test]
    fn the_first_directory_wins_like_the_loader() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let wanted = place(first.path(), &exe_name("git"), b"x");
        place(second.path(), &exe_name("git"), b"x");
        let found = inventory_in(
            &[first.path().to_path_buf(), second.path().to_path_buf()],
            &["git"],
        );
        assert_eq!(found[0].path, wanted.to_string_lossy());
    }

    #[test]
    fn an_empty_file_outside_windowsapps_is_not_a_program() {
        let tmp = tempfile::tempdir().unwrap();
        place(tmp.path(), &exe_name("python"), b"");
        let found = inventory_in(&[tmp.path().to_path_buf()], &["python"]);
        assert!(found.is_empty(), "{found:?}");
    }

    #[test]
    fn a_store_alias_counts_only_when_a_package_backs_it() {
        // Mirror the real layout: `WindowsApps\python.exe` (0 bytes) with the
        // App Installer's stub folder — and then with a real package folder.
        let tmp = tempfile::tempdir().unwrap();
        let apps = tmp.path().join("WindowsApps");
        std::fs::create_dir_all(apps.join("Microsoft.DesktopAppInstaller_8wekyb3d8bbwe")).unwrap();
        let alias = exe_name("python");
        place(&apps, &alias, b"");
        place(
            &apps.join("Microsoft.DesktopAppInstaller_8wekyb3d8bbwe"),
            &alias,
            b"",
        );
        assert!(
            inventory_in(&[apps.clone()], &["python"]).is_empty(),
            "the Store stub must not read as an installed Python"
        );

        let package = apps.join("PythonSoftwareFoundation.Python.3.14_qbz5n2kfra8p0");
        std::fs::create_dir_all(&package).unwrap();
        place(&package, &alias, b"");
        assert_eq!(
            inventory_in(&[apps.clone()], &["python"]).len(),
            1,
            "an installed Store package makes the alias real"
        );

        // `winget` is owned by the App Installer package for real; only the
        // python names in that folder are redirects.
        let winget = exe_name("winget");
        place(&apps, &winget, b"");
        place(
            &apps.join("Microsoft.DesktopAppInstaller_8wekyb3d8bbwe"),
            &winget,
            b"",
        );
        assert_eq!(
            inventory_in(&[apps], &["winget"]).len(),
            1,
            "winget under App Installer is the genuine article"
        );
    }

    #[test]
    fn missing_directories_are_skipped_not_fatal() {
        let found = inventory_in(&[PathBuf::from("/definitely/not/here")], &["git"]);
        assert!(found.is_empty());
    }

    #[test]
    fn the_block_lists_names_only_and_sorted() {
        let found = vec![
            FoundTool {
                name: "pnpm".into(),
                path: r"C:\x\pnpm.cmd".into(),
            },
            FoundTool {
                name: "node".into(),
                path: r"C:\x\node.exe".into(),
            },
        ];
        // `inventory_in` sorts; `context_block` renders what it is given.
        let block = context_block(&found).expect("two tools make a block");
        assert!(block.starts_with("<machine_tools>"));
        assert!(block.ends_with("</machine_tools>"));
        assert!(block.contains("pnpm, node"));
        assert!(!block.contains(r"C:\x"), "paths are settings-page data, not prompt tokens");
        assert!(block.contains("--version"), "must say how to learn a version");
    }

    #[test]
    fn an_empty_inventory_yields_no_block() {
        assert!(context_block(&[]).is_none());
    }

    /// Diagnostic, not a check: `cargo test --lib -- toolchain --ignored
    /// --nocapture` prints what THIS machine would tell the agent.
    #[test]
    #[ignore]
    fn print_inventory_for_this_machine() {
        let started = std::time::Instant::now();
        let found = inventory();
        eprintln!("{} tools in {:?}", found.len(), started.elapsed());
        for tool in &found {
            eprintln!("  {:<12} {}", tool.name, tool.path);
        }
        eprintln!("{}", context_block(&found).unwrap_or_default());
    }

    #[test]
    fn inventory_is_sorted_and_deduplicated() {
        let tmp = tempfile::tempdir().unwrap();
        for name in ["zig", "go", "node"] {
            place(tmp.path(), &exe_name(name), b"x");
        }
        let found = inventory_in(&[tmp.path().to_path_buf()], &["zig", "node", "go", "node"]);
        let names: Vec<&str> = found.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["go", "node", "zig"]);
    }
}
