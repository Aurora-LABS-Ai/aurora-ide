//! Workspace file discovery.
//!
//! Uses the `ignore` crate (ripgrep's walker — already the engine behind
//! Aurora's `grep` tool) so the index observes `.gitignore` for free. Anything
//! the user has told git to ignore is not code they want indexed.

use super::lang::Lang;
use std::path::{Path, PathBuf};

/// Files above this are almost always generated — minified bundles, lockfile-
/// adjacent blobs, vendored single-file libraries. Parsing them costs real time
/// and the symbols are noise.
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Dependency and build-output directories, by ecosystem.
///
/// `.gitignore` covers most of these in a healthy repo, but it cannot be relied
/// on: Aurora itself commits patched crates under `vendor/` (esaxx-rs,
/// candle-kernels), plenty of projects are opened before `git init`, and vendored
/// dependencies are routinely checked in. Indexing any of it puts thousands of
/// foreign symbols ahead of every answer about the user's own code.
///
/// The bias here is deliberate: these names are near-universal conventions, and
/// a skipped directory is REPORTED (see `WalkStats::skipped_dirs`) so an
/// over-exclusion is visible rather than silent.
const ALWAYS_SKIP: &[&str] = &[
    // version control / editor state
    ".git",
    ".hg",
    ".svn",
    ".idea",
    ".vs",
    // JavaScript / TypeScript
    "node_modules",
    "bower_components",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".astro",
    ".output",
    ".turbo",
    ".parcel-cache",
    ".rollup.cache",
    ".vite",
    "coverage",
    // Rust
    "target",
    // Python
    "__pycache__",
    ".venv",
    "venv",
    "site-packages",
    ".tox",
    ".nox",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    // Go / PHP / Ruby — all spell vendored dependencies "vendor"
    "vendor",
    ".bundle",
    // JVM (Gradle / Maven / sbt)
    ".gradle",
    ".mvn",
    "gradle-wrapper",
    "classes",
    // .NET — `obj` only.
    //
    // `bin` and `packages` used to be here and were WRONG. They are real .NET
    // output names, but they collide head-on with two universal SOURCE
    // conventions: a pnpm/yarn workspace keeps every first-class library under
    // `packages/`, and a Node package keeps its CLI entry point in `bin/`.
    // Measured on a real monorepo — `packages/` held 282 source files across
    // four workspace members and the index saw NONE of them. The exclusion also
    // bought nothing: a .NET `bin`/`packages` folder holds .dll/.nupkg/.xml,
    // and not one of those is in a language this indexer reads. All cost, no
    // saving. `obj` stays because it is output in every ecosystem.
    "obj",
    // Swift / Xcode
    "DerivedData",
    ".swiftpm",
    // Elixir / Erlang
    "_build",
    "deps",
    // Dart / Flutter
    ".dart_tool",
    // C / C++
    ".ccls-cache",
    ".clangd",
    // generic tool caches
    ".cache",
    ".gradle-cache",
    "__snapshots__",
];

/// Suffix/prefix conventions that cannot be matched by exact name.
const SKIP_SUFFIXES: &[&str] = &[".egg-info", ".xcodeproj", ".xcworkspace", ".framework"];
const SKIP_PREFIXES: &[&str] = &["cmake-build-"];

fn is_skipped_dir(name: &str) -> bool {
    ALWAYS_SKIP.contains(&name)
        || SKIP_SUFFIXES.iter().any(|s| name.ends_with(s))
        || SKIP_PREFIXES.iter().any(|p| name.starts_with(p))
}

/// A minified bundle is not code anyone will ask a question about, and it is
/// actively harmful to index: one 1.9 MB esbuild `index.js` in a real Electron
/// client produced 14,685 mangled symbols (`Z0`, `Jf`, `eA`…) — 34% of the
/// entire index — and drove ambiguity to 65% while costing most of the build.
///
/// Size alone cannot catch it (that file is under `MAX_FILE_BYTES`). Line
/// *shape* can: generated output packs thousands of characters per line, while
/// hand-written source of any language sits well under 100 on average.
pub const MAX_AVG_LINE_BYTES: u64 = 200;
/// A single enormous line in an otherwise normal file means embedded data — a
/// base64 blob, an inlined source map, a giant literal table.
pub const MAX_SINGLE_LINE_BYTES: usize = 50_000;

pub fn looks_generated(source: &str) -> bool {
    let lines = source.lines().count().max(1) as u64;
    if source.len() as u64 / lines > MAX_AVG_LINE_BYTES {
        return true;
    }
    source.lines().any(|l| l.len() > MAX_SINGLE_LINE_BYTES)
}

pub struct Discovered {
    pub path: PathBuf,
    pub lang: Lang,
}

/// Workspace package name -> the directory that declares it, forward-slashed
/// and relative to the root.
///
/// In a monorepo, `import { X } from '@scope/core'` is NOT an external
/// dependency — it is a sibling library in this same workspace, resolved
/// through pnpm/yarn workspaces. Without this map every cross-package edge
/// looks like an npm import and disappears: measured on a real monorepo, the
/// whole-repo dependency graph came back with **zero** edges between its four
/// packages and three apps, because each one is imported by name.
///
/// Reads `package.json` `name` fields only — cheap, and the same file the
/// package manager itself uses to make the link.
pub fn workspace_packages(root: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .require_git(false)
        .git_global(false)
        // A workspace member sits near the top; descending the whole tree to
        // find nested package.json files would cost more than it is worth.
        .max_depth(Some(4))
        .filter_entry(|e| {
            !e.file_type().is_some_and(|t| t.is_dir())
                || e.file_name().to_str().is_none_or(|n| !is_skipped_dir(n))
        })
        .build();

    for entry in walker.flatten() {
        if entry.file_name() != "package.json" {
            continue;
        }
        let Some(dir) = entry.path().parent() else {
            continue;
        };
        let Ok(text) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let Some(name) = json.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        let rel = dir
            .strip_prefix(root)
            .unwrap_or(dir)
            .to_string_lossy()
            .replace('\\', "/");
        out.push((name.to_string(), rel));
    }
    // Longest directory first so a nested package wins over its parent.
    out.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then(a.0.cmp(&b.0)));
    out
}

/// How many recent commits touched each file, keyed by forward-slashed path
/// relative to the workspace root.
///
/// A file that everything depends on AND that changes every week is a
/// different kind of risk from one that has not moved in two years, and the
/// dependency graph alone cannot tell them apart. Git already knows.
///
/// Deliberately bounded and deliberately silent on failure. `--max-count`
/// keeps this to a fraction of a second on a large history; a workspace with
/// no git, no commits, or no `git` on PATH simply gets an empty map, and every
/// caller treats "no churn data" as "no signal" rather than as an error. The
/// index must never fail to build because a repository is young.
pub fn churn(root: &Path) -> std::collections::HashMap<String, u32> {
    use std::collections::HashMap;
    let mut out: HashMap<String, u32> = HashMap::new();

    let mut cmd = std::process::Command::new("git");
    // The index builds on the first message of a session, so without this the
    // repo map opened a console window right as the user hit send.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd
        .current_dir(root)
        .args([
            "log",
            // Bounded twice over: recent history is what predicts the near
            // future, and an unbounded log on a repository like Chromium
            // would dominate the whole build.
            "--max-count=1500",
            "--since=1.year",
            "--name-only",
            "--pretty=format:",
            "--no-renames",
        ])
        .output();

    let Ok(output) = output else {
        return out;
    };
    if !output.status.success() {
        return out;
    }
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        *out.entry(line.replace('\\', "/")).or_default() += 1;
    }
    out
}

/// Cheap fingerprint of the indexable tree: how many files there are and the
/// newest modification time among them.
///
/// This is how the index stays honest without anyone remembering to invalidate
/// it. Hooking the five file-mutating tools would work until someone adds a
/// sixth, or the user edits in another editor, or a `git checkout` rewrites
/// half the tree — none of which emit a tool event. Re-walking costs a fraction
/// of a rebuild (no file is read or parsed), so it can simply be checked before
/// every answer.
pub fn signature(root: &Path) -> (usize, u64) {
    let (files, _) = discover(root);
    let newest = files
        .iter()
        .filter_map(|d| std::fs::metadata(&d.path).ok())
        .filter_map(|m| m.modified().ok())
        .filter_map(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .max()
        .unwrap_or(0);
    (files.len(), newest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bundle_is_detected_but_dense_hand_written_code_is_not() {
        // Shape taken from the real esbuild output that triggered this.
        let bundle = format!(
            "\"use strict\";{}",
            "var Z0=Object.create;var Jf=Object.defineProperty;".repeat(40)
        );
        assert!(looks_generated(&bundle), "minified bundle must be skipped");

        // A long but normal file must survive — this is the false positive that
        // would silently blind the index to someone's real work.
        let normal = "pub fn handle(&self, request: Request) -> Result<Response> {\n".repeat(400);
        assert!(
            !looks_generated(&normal),
            "hand-written code must be indexed"
        );
    }

    #[test]
    fn a_monorepo_packages_directory_is_source_and_must_be_indexed() {
        // Caught on a real monorepo: `packages` was excluded as a .NET/NuGet
        // name, so four first-class workspace libraries — 282 files — were
        // invisible to the agent while the exclusion saved nothing. `bin` is
        // the same trap for a Node CLI entry point.
        assert!(
            !is_skipped_dir("packages"),
            "a pnpm/yarn workspace keeps its libraries in packages/"
        );
        assert!(
            !is_skipped_dir("bin"),
            "node keeps its CLI entry point in bin/"
        );
        // The unambiguous ones must still go.
        for name in [
            "node_modules",
            "target",
            "dist",
            "obj",
            "__pycache__",
            ".git",
        ] {
            assert!(is_skipped_dir(name), "{name} is build/dependency output");
        }
    }

    #[test]
    fn churn_counts_commits_per_file_and_survives_a_workspace_without_git() {
        // A directory that is not a repository must cost nothing and lose
        // nothing but the signal — the index has to build regardless.
        let plain = tempfile::tempdir().unwrap();
        std::fs::write(plain.path().join("a.rs"), "fn a() {}\n").unwrap();
        assert!(
            churn(plain.path()).is_empty(),
            "no git must mean no data, not a failure"
        );

        // A real repository: two commits touch `hot.rs`, one touches `cold.rs`.
        let repo = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .current_dir(repo.path())
                .args(args)
                .output()
        };
        if git(&["init"]).is_err() {
            return; // no git on this machine; the assertion above is the contract
        }
        let _ = git(&["config", "user.email", "t@t.t"]);
        let _ = git(&["config", "user.name", "t"]);
        std::fs::write(repo.path().join("hot.rs"), "fn a() {}\n").unwrap();
        std::fs::write(repo.path().join("cold.rs"), "fn b() {}\n").unwrap();
        let _ = git(&["add", "."]);
        let _ = git(&["commit", "-m", "one"]);
        std::fs::write(repo.path().join("hot.rs"), "fn a() { c(); }\n").unwrap();
        let _ = git(&["add", "."]);
        let _ = git(&["commit", "-m", "two"]);

        let counts = churn(repo.path());
        if counts.is_empty() {
            return; // commits did not land (no identity configured in CI)
        }
        assert_eq!(counts.get("hot.rs"), Some(&2), "{counts:?}");
        assert_eq!(counts.get("cold.rs"), Some(&1), "{counts:?}");
    }

    #[test]
    fn one_huge_line_of_embedded_data_disqualifies_a_file() {
        let mut src = "const ICON = \"".to_string();
        src.push_str(&"A".repeat(MAX_SINGLE_LINE_BYTES + 1));
        src.push_str("\";\n");
        // Pad with normal lines so the *average* stays low — only the single
        // oversized line can catch this one.
        src.push_str(&"const x = 1;\n".repeat(5000));
        assert!(looks_generated(&src));
    }
}

pub struct WalkStats {
    pub skipped_too_large: usize,
    /// Which excluded directory names were actually hit in this workspace.
    /// Reported so an over-exclusion is visible — a walker that silently drops
    /// a directory called `build` that happens to hold real source would
    /// otherwise look like a complete index.
    pub skipped_dirs: Vec<String>,
    /// Extensions this workspace contains that no grammar here reads, and how
    /// many files carry each — largest first.
    ///
    /// This is the difference between a tool with a known limit and a tool that
    /// lies. A file whose extension is unmapped is not skipped-and-counted like
    /// an oversized one; it is never opened, so `outline` on it answers "no
    /// indexed file matches" and `usages` of a symbol it defines answers "not
    /// defined in this workspace". Both are confident, plausible, and false.
    /// Recording the tally here — the walker already visits every file, so it
    /// costs one map insert — lets those three answers name the real reason
    /// instead of guessing at a dependency.
    ///
    /// Collected at walk time rather than by stat-ing a path when a question
    /// arrives, because `definition` and `usages` are given a symbol and have
    /// no path to stat.
    pub unindexed_extensions: Vec<(String, usize)>,
}

/// Returns every indexable file under `root`, plus what was passed over.
pub fn discover(root: &Path) -> (Vec<Discovered>, WalkStats) {
    let mut out = Vec::new();
    let mut skipped_too_large = 0;
    // `filter_entry` takes an `Fn` shared across the walk, so the tally of what
    // was excluded has to live behind a lock rather than in a local.
    let hit: std::sync::Arc<std::sync::Mutex<std::collections::BTreeSet<String>>> =
        Default::default();
    let hit_w = hit.clone();

    let walker = ignore::WalkBuilder::new(root)
        .hidden(false) // `.claude`, `.knowledge` etc. are real source here
        .git_ignore(true)
        // Without this, `ignore` applies .gitignore rules ONLY inside a real
        // git repo — a workspace that has a .gitignore but no `.git` would
        // index everything it asked us to skip. An IDE opens plenty of those.
        .require_git(false)
        .git_global(false)
        .filter_entry(move |e| {
            // Only directories are pruned by name. A FILE called `build` or
            // `deps` is ordinary source and must not be dropped.
            if !e.file_type().is_some_and(|t| t.is_dir()) {
                return true;
            }
            match e.file_name().to_str() {
                Some(n) if is_skipped_dir(n) => {
                    hit_w.lock().unwrap().insert(n.to_string());
                    false
                }
                _ => true,
            }
        })
        .build();

    let mut unindexed: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

    for entry in walker.flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let path = entry.path();
        let Some(lang) = Lang::from_path(path) else {
            // Not a language this build reads. Counted rather than dropped —
            // see `WalkStats::unindexed_extensions` for why the difference
            // matters. Extension-less files (LICENSE, Makefile) are ignored
            // here: nothing would be gained by telling a caller the index does
            // not parse them.
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                let ext = ext.to_ascii_lowercase();
                if looks_like_source(&ext) {
                    *unindexed.entry(ext).or_insert(0) += 1;
                }
            }
            continue;
        };
        if entry.metadata().map(|m| m.len()).unwrap_or(0) > MAX_FILE_BYTES {
            skipped_too_large += 1;
            continue;
        }
        out.push(Discovered {
            path: path.to_path_buf(),
            lang,
        });
    }

    // Stable order so two runs over an unchanged tree produce identical file
    // ids — otherwise every rebuild churns the serialized index.
    out.sort_by(|a, b| a.path.cmp(&b.path));
    let skipped_dirs = hit.lock().unwrap().iter().cloned().collect();

    // Largest first, then alphabetically so two runs agree. A caller reads at
    // most the first line or two of this, and the biggest gap is the one worth
    // naming.
    let mut unindexed_extensions: Vec<(String, usize)> = unindexed.into_iter().collect();
    unindexed_extensions.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    (
        out,
        WalkStats {
            skipped_too_large,
            skipped_dirs,
            unindexed_extensions,
        },
    )
}

/// Is this extension plausibly source code, as opposed to an asset, a document
/// or a lockfile?
///
/// Deliberately an allow-list of KNOWN languages rather than a deny-list of
/// known non-code. The tally this gates is shown to whoever asked why a symbol
/// could not be found, and "your workspace also contains 412 .md and 88 .json
/// files" is noise that would make the real answer unreadable. A language
/// missing from this list simply goes unmentioned, which is exactly today's
/// behaviour — so being incomplete here costs nothing, while being over-broad
/// costs the message its meaning.
fn looks_like_source(ext: &str) -> bool {
    matches!(
        ext,
        "dart"
            | "lua"
            | "scala"
            | "sc"
            | "zig"
            | "sh"
            | "bash"
            | "zsh"
            | "fish"
            | "ps1"
            | "psm1"
            | "bat"
            | "cmd"
            | "pl"
            | "pm"
            | "r"
            | "jl"
            | "hs"
            | "ml"
            | "mli"
            | "ex"
            | "exs"
            | "erl"
            | "hrl"
            | "clj"
            | "cljs"
            | "cljc"
            | "groovy"
            | "gradle"
            | "vb"
            | "f"
            | "f90"
            | "f95"
            | "sql"
            | "vue"
            | "svelte"
            | "astro"
            | "sol"
            | "nim"
            | "cr"
            | "d"
            | "pas"
            | "asm"
            | "s"
            | "m"
            | "mm"
            | "tf"
            | "tfvars"
            | "proto"
            | "thrift"
            | "graphql"
            | "gql"
            | "elm"
            | "rkt"
            | "lisp"
            | "el"
            | "tcl"
            | "awk"
            | "coffee"
            | "hx"
            | "vhd"
            | "sv"
            | "svh"
            | "vim"
    )
}
