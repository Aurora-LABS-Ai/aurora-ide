//! Workspace file discovery.
//!
//! Uses the `ignore` crate (ripgrep's walker — already the engine behind
//! Aurora's `grep` tool) so the index observes `.gitignore` for free. Anything
//! the user has told git to ignore is not code they want indexed.

use crate::lang::Lang;
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
    ".git", ".hg", ".svn", ".idea", ".vs",
    // JavaScript / TypeScript
    "node_modules", "bower_components", "dist", "build", "out",
    ".next", ".nuxt", ".svelte-kit", ".astro", ".output",
    ".turbo", ".parcel-cache", ".rollup.cache", ".vite", "coverage",
    // Rust
    "target",
    // Python
    "__pycache__", ".venv", "venv", "site-packages",
    ".tox", ".nox", ".mypy_cache", ".pytest_cache", ".ruff_cache",
    // Go / PHP / Ruby — all spell vendored dependencies "vendor"
    "vendor", ".bundle",
    // JVM (Gradle / Maven / sbt)
    ".gradle", ".mvn", "gradle-wrapper", "classes",
    // .NET
    "bin", "obj", "packages",
    // Swift / Xcode
    "DerivedData", ".swiftpm",
    // Elixir / Erlang
    "_build", "deps",
    // Dart / Flutter
    ".dart_tool",
    // C / C++
    ".ccls-cache", ".clangd",
    // generic tool caches
    ".cache", ".gradle-cache", "__snapshots__",
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
/// actively harmful to index: one 1.9 MB esbuild `index.js` in the QuantumHub
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
        assert!(!looks_generated(&normal), "hand-written code must be indexed");
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

    for entry in walker.flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let path = entry.path();
        let Some(lang) = Lang::from_path(path) else {
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
    (
        out,
        WalkStats {
            skipped_too_large,
            skipped_dirs,
        },
    )
}
