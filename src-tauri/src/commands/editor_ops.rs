//! Native editor operations.
//!
//! These commands collapse multi-step JS workflows (read → manipulate string →
//! write → diff) into single IPC calls executed entirely in Rust. The result
//! is dramatically less data crossing the Tauri bridge and an order-of-
//! magnitude speedup for large files where JavaScript string manipulation is
//! the bottleneck.
//!
//! Commands provided:
//!   * `apply_search_replace`        - find/replace one snippet, optional write
//!   * `apply_multi_search_replace`  - batch find/replace, atomic apply
//!   * `compute_unified_diff`        - native unified diff via the `similar` crate
//!   * `slice_file_lines`            - read+slice in one shot, no whole-file FE copy
//!   * `is_path_excluded`            - SIMD-flavored path/extension exclusion check
//!
//! All read paths route through `file_cache::read_file_cached` so they share
//! the same cache layer as `read_file_content`.

use memchr::memmem;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::file_cache;

const LF: char = '\n';
const CR: char = '\r';

// ---------------------------------------------------------------------------
// Public command: apply_search_replace
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchReplaceItem {
    pub old_string: String,
    #[serde(default)]
    pub new_string: String,
    #[serde(default)]
    pub replace_all: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplySearchReplaceRequest {
    pub path: String,
    pub replacement: SearchReplaceItem,
    /// When true, the new content is written back to disk in the same call.
    #[serde(default)]
    pub write: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyMultiSearchReplaceRequest {
    pub path: String,
    pub replacements: Vec<SearchReplaceItem>,
    #[serde(default)]
    pub write: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacementDetail {
    pub index: usize,
    pub occurrences: usize,
    pub replaced: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum SearchReplaceResponse {
    #[serde(rename = "ok")]
    Ok {
        original_content: String,
        new_content: String,
        line_ending_normalized: bool,
        lines_added: usize,
        lines_removed: usize,
        total_replacements: usize,
        replacement_details: Vec<ReplacementDetail>,
        wrote_to_disk: bool,
    },
    #[serde(rename = "not_found")]
    NotFound { failed_at: usize },
    #[serde(rename = "not_unique")]
    NotUnique {
        failed_at: usize,
        occurrences: usize,
    },
    #[serde(rename = "overlap")]
    Overlap {
        failed_at: usize,
        conflicting_replacement: usize,
    },
}

#[tauri::command]
pub async fn apply_search_replace(
    request: ApplySearchReplaceRequest,
) -> Result<SearchReplaceResponse, String> {
    let path = request.path.clone();
    let multi = ApplyMultiSearchReplaceRequest {
        path: request.path,
        replacements: vec![request.replacement],
        write: request.write,
    };
    apply_multi_search_replace_inner(multi)
        .await
        .map_err(|error| format!("apply_search_replace ({}): {}", path, error))
}

#[tauri::command]
pub async fn apply_multi_search_replace(
    request: ApplyMultiSearchReplaceRequest,
) -> Result<SearchReplaceResponse, String> {
    let path = request.path.clone();
    apply_multi_search_replace_inner(request)
        .await
        .map_err(|error| format!("apply_multi_search_replace ({}): {}", path, error))
}

async fn apply_multi_search_replace_inner(
    request: ApplyMultiSearchReplaceRequest,
) -> Result<SearchReplaceResponse, String> {
    // Heavy CPU/IO on a blocking pool slot. Tauri commands run on its async
    // executor — keeping work that touches the disk off the runtime keeps the
    // IPC channel responsive even under sustained agent activity.
    let join = tokio::task::spawn_blocking(move || run_multi_search_replace(request));
    join.await
        .map_err(|error| format!("native search/replace task panicked: {}", error))?
}

fn run_multi_search_replace(
    request: ApplyMultiSearchReplaceRequest,
) -> Result<SearchReplaceResponse, String> {
    let original_content = file_cache::read_file_cached(&request.path)?;
    let plan = plan_multi_search_replace(&original_content, &request.replacements);

    match plan {
        PlanResult::NotFound { failed_at } => Ok(SearchReplaceResponse::NotFound { failed_at }),
        PlanResult::NotUnique {
            failed_at,
            occurrences,
        } => Ok(SearchReplaceResponse::NotUnique {
            failed_at,
            occurrences,
        }),
        PlanResult::Overlap {
            failed_at,
            conflicting_replacement,
        } => Ok(SearchReplaceResponse::Overlap {
            failed_at,
            conflicting_replacement,
        }),
        PlanResult::Ok {
            new_content,
            line_ending_normalized,
            lines_added,
            lines_removed,
            total_replacements,
            replacement_details,
        } => {
            let mut wrote_to_disk = false;
            if request.write {
                std::fs::write(&request.path, &new_content)
                    .map_err(|error| format!("failed to write {}: {}", request.path, error))?;
                file_cache::get_file_cache().invalidate(&request.path);
                wrote_to_disk = true;
            }

            Ok(SearchReplaceResponse::Ok {
                original_content,
                new_content,
                line_ending_normalized,
                lines_added,
                lines_removed,
                total_replacements,
                replacement_details,
                wrote_to_disk,
            })
        }
    }
}

// ---------------------------------------------------------------------------
// Plan builder (pure, fully testable)
// ---------------------------------------------------------------------------

enum PlanResult {
    Ok {
        new_content: String,
        line_ending_normalized: bool,
        lines_added: usize,
        lines_removed: usize,
        total_replacements: usize,
        replacement_details: Vec<ReplacementDetail>,
    },
    NotFound {
        failed_at: usize,
    },
    NotUnique {
        failed_at: usize,
        occurrences: usize,
    },
    Overlap {
        failed_at: usize,
        conflicting_replacement: usize,
    },
}

#[derive(Debug, Clone)]
struct PlannedRange {
    start: usize,
    end: usize,
    new_text: String,
    replacement_index: usize,
}

fn plan_multi_search_replace(
    original_content: &str,
    replacements: &[SearchReplaceItem],
) -> PlanResult {
    let original_line_ending = detect_line_ending(original_content);
    let normalized_original = normalize_line_endings(original_content);
    let mut line_ending_normalized = normalized_original.len() != original_content.len();

    let mut planned_ranges: Vec<PlannedRange> = Vec::new();
    let mut replacement_details: Vec<ReplacementDetail> = Vec::with_capacity(replacements.len());
    let mut total_replacements = 0usize;
    let mut total_lines_added = 0usize;
    let mut total_lines_removed = 0usize;

    for (index, replacement) in replacements.iter().enumerate() {
        let normalized_old = normalize_line_endings(&replacement.old_string);
        let normalized_new = normalize_line_endings(&replacement.new_string);

        if normalized_old.len() != replacement.old_string.len()
            || normalized_new.len() != replacement.new_string.len()
        {
            line_ending_normalized = true;
        }

        if normalized_old.is_empty() {
            return PlanResult::NotFound {
                failed_at: index + 1,
            };
        }

        // SIMD-accelerated occurrence scan.
        let finder = memmem::Finder::new(normalized_old.as_bytes());
        let occurrences: Vec<usize> = finder
            .find_iter(normalized_original.as_bytes())
            .collect();
        let occurrence_count = occurrences.len();

        if occurrence_count == 0 {
            return PlanResult::NotFound {
                failed_at: index + 1,
            };
        }

        if occurrence_count > 1 && !replacement.replace_all {
            return PlanResult::NotUnique {
                failed_at: index + 1,
                occurrences: occurrence_count,
            };
        }

        let selected_starts: &[usize] = if replacement.replace_all {
            &occurrences[..]
        } else {
            &occurrences[..1]
        };

        for &start in selected_starts {
            let end = start + normalized_old.len();
            let candidate = PlannedRange {
                start,
                end,
                new_text: normalized_new.clone(),
                replacement_index: index + 1,
            };

            if let Some(conflict) = first_overlap(&planned_ranges, &candidate) {
                return PlanResult::Overlap {
                    failed_at: index + 1,
                    conflicting_replacement: conflict.replacement_index,
                };
            }

            planned_ranges.push(candidate);
        }

        let replaced_count = if replacement.replace_all {
            occurrence_count
        } else {
            1
        };

        total_lines_removed += line_count(&normalized_old) * replaced_count;
        total_lines_added += line_count(&normalized_new) * replaced_count;
        total_replacements += replaced_count;
        replacement_details.push(ReplacementDetail {
            index: index + 1,
            occurrences: occurrence_count,
            replaced: replaced_count,
        });
    }

    // Apply ranges back-to-front so earlier offsets remain valid.
    planned_ranges.sort_by(|a, b| b.start.cmp(&a.start));

    let mut buffer = normalized_original;
    for range in &planned_ranges {
        // Defensive: `String::replace_range` panics if `start` or `end` are
        // not on UTF-8 char boundaries. For valid UTF-8 patterns matched
        // by `memmem` against valid UTF-8 sources this is guaranteed to
        // hold (the first byte of any UTF-8 pattern is either ASCII or a
        // lead byte, which can never appear *inside* a multi-byte char in
        // the source). The runtime check here is belt-and-suspenders so a
        // future regression — or a pathological mixed-encoding file —
        // surfaces as a `NotFound` error instead of an `abort()` that
        // takes the entire IDE down.
        if !buffer.is_char_boundary(range.start) || !buffer.is_char_boundary(range.end) {
            return PlanResult::NotFound {
                failed_at: range.replacement_index,
            };
        }
        buffer.replace_range(range.start..range.end, &range.new_text);
    }

    let new_content = restore_line_endings(&buffer, original_line_ending);

    PlanResult::Ok {
        new_content,
        line_ending_normalized,
        lines_added: total_lines_added,
        lines_removed: total_lines_removed,
        total_replacements,
        replacement_details,
    }
}

fn first_overlap<'a>(
    existing: &'a [PlannedRange],
    candidate: &PlannedRange,
) -> Option<&'a PlannedRange> {
    existing
        .iter()
        .find(|range| candidate.start < range.end && candidate.end > range.start)
}

fn detect_line_ending(content: &str) -> &'static str {
    if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

fn normalize_line_endings(value: &str) -> String {
    if !value.contains(CR) {
        return value.to_string();
    }

    // Iterate by `char` rather than walking raw bytes. The previous byte-walk
    // implementation inverted the UTF-8 continuation-byte logic and ended up
    // slicing &str at non-char-boundaries — which panics. Because the
    // crate's release profile sets `panic = "abort"`, every panic *aborts the
    // entire Aurora process*, surfacing to the user as the "IDE crashed
    // out of nowhere" report whenever search_replace touched a CRLF file
    // containing any non-ASCII character (very common on Windows).
    //
    // Using the `chars()` iterator delegates UTF-8 boundary handling to the
    // standard library — correct by construction, no manual bit twiddling.
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == CR {
            out.push(LF);
            // Coalesce CRLF — emit a single LF instead of "\n\n".
            if chars.peek() == Some(&LF) {
                chars.next();
            }
        } else {
            out.push(ch);
        }
    }
    out
}

fn restore_line_endings(content: &str, line_ending: &str) -> String {
    if line_ending == "\n" {
        return content.to_string();
    }
    content.replace('\n', "\r\n")
}

fn line_count(value: &str) -> usize {
    // Match the JS implementation: `value.split('\n').length`. Empty string
    // counts as one line.
    1 + memchr::memchr_iter(b'\n', value.as_bytes()).count()
}

// ---------------------------------------------------------------------------
// Public command: compute_unified_diff
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedDiffRequest {
    pub original: String,
    pub modified: String,
    #[serde(default = "default_context_lines")]
    pub context_lines: usize,
    #[serde(default)]
    pub original_label: Option<String>,
    #[serde(default)]
    pub modified_label: Option<String>,
}

fn default_context_lines() -> usize {
    3
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedDiffResponse {
    pub diff: String,
    pub additions: usize,
    pub deletions: usize,
    pub identical: bool,
}

#[tauri::command]
pub async fn compute_unified_diff(
    request: UnifiedDiffRequest,
) -> Result<UnifiedDiffResponse, String> {
    let join = tokio::task::spawn_blocking(move || compute_unified_diff_inner(request));
    join.await
        .map_err(|error| format!("compute_unified_diff task panicked: {}", error))
}

fn compute_unified_diff_inner(request: UnifiedDiffRequest) -> UnifiedDiffResponse {
    use similar::{ChangeTag, TextDiff};

    if request.original == request.modified {
        return UnifiedDiffResponse {
            diff: String::new(),
            additions: 0,
            deletions: 0,
            identical: true,
        };
    }

    let diff = TextDiff::from_lines(&request.original, &request.modified);

    let mut additions = 0usize;
    let mut deletions = 0usize;
    for change in diff.iter_all_changes() {
        match change.tag() {
            ChangeTag::Insert => additions += 1,
            ChangeTag::Delete => deletions += 1,
            ChangeTag::Equal => {}
        }
    }

    let original_label = request.original_label.as_deref().unwrap_or("a");
    let modified_label = request.modified_label.as_deref().unwrap_or("b");

    let mut formatted = diff.unified_diff();
    formatted.context_radius(request.context_lines);
    formatted.header(original_label, modified_label);

    UnifiedDiffResponse {
        diff: formatted.to_string(),
        additions,
        deletions,
        identical: false,
    }
}

// ---------------------------------------------------------------------------
// Public command: slice_file_lines
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceFileLinesRequest {
    pub path: String,
    #[serde(default)]
    pub start_line: Option<usize>,
    #[serde(default)]
    pub end_line: Option<usize>,
    #[serde(default)]
    pub max_lines: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceFileLinesResponse {
    pub content: String,
    pub total_lines: usize,
    pub start_line: usize,
    pub end_line: usize,
    pub byte_size: usize,
    pub truncated: bool,
}

const DEFAULT_LINE_WINDOW: usize = 800;
const MAX_SINGLE_READ_LINES: usize = 4_000;

#[tauri::command]
pub async fn slice_file_lines(
    request: SliceFileLinesRequest,
) -> Result<SliceFileLinesResponse, String> {
    let join = tokio::task::spawn_blocking(move || slice_file_lines_inner(request));
    join.await
        .map_err(|error| format!("slice_file_lines task panicked: {}", error))?
}

fn slice_file_lines_inner(request: SliceFileLinesRequest) -> Result<SliceFileLinesResponse, String> {
    let content = file_cache::read_file_cached(&request.path)?;
    let byte_size = content.len();

    let total_lines = 1 + memchr::memchr_iter(b'\n', content.as_bytes()).count();

    // Resolve the requested window with the same semantics as the TS helper:
    //   - explicit start/end win, clamped to [1, total_lines]
    //   - max_lines acts as an upper bound on the window length
    //   - if neither is set, fall back to DEFAULT_LINE_WINDOW
    let max_window = request
        .max_lines
        .unwrap_or(DEFAULT_LINE_WINDOW)
        .min(MAX_SINGLE_READ_LINES);

    let mut start = request.start_line.unwrap_or(1).max(1);
    let mut end = request.end_line.unwrap_or_else(|| start + max_window - 1);

    if end < start {
        std::mem::swap(&mut start, &mut end);
    }

    if start > total_lines {
        start = total_lines;
    }
    if end > total_lines {
        end = total_lines;
    }
    if end - start + 1 > max_window {
        end = start + max_window - 1;
        if end > total_lines {
            end = total_lines;
        }
    }

    // Walk the source by newline offsets — far cheaper than `lines().collect()`
    // because we never materialize a Vec<String>.
    let bytes = content.as_bytes();
    let mut line_starts = Vec::with_capacity(total_lines + 1);
    line_starts.push(0usize);
    for offset in memchr::memchr_iter(b'\n', bytes) {
        line_starts.push(offset + 1);
    }

    let slice_start = line_starts.get(start - 1).copied().unwrap_or(0);
    let slice_end = line_starts.get(end).copied().unwrap_or(bytes.len());

    let mut sliced = content[slice_start..slice_end].to_string();
    // Trim a trailing newline so consumers do not double-up when joining.
    if sliced.ends_with('\n') {
        sliced.pop();
        if sliced.ends_with('\r') {
            sliced.pop();
        }
    }

    let truncated =
        request.start_line.is_some() || request.end_line.is_some() || end - start + 1 < total_lines;

    Ok(SliceFileLinesResponse {
        content: sliced,
        total_lines,
        start_line: start,
        end_line: end,
        byte_size,
        truncated,
    })
}

// ---------------------------------------------------------------------------
// Public command: is_path_excluded
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IsPathExcludedRequest {
    pub path: String,
    #[serde(default)]
    pub paths: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IsPathExcludedItem {
    pub path: String,
    pub excluded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IsPathExcludedResponse {
    pub results: Vec<IsPathExcludedItem>,
}

#[tauri::command]
pub async fn is_path_excluded(
    request: IsPathExcludedRequest,
) -> Result<IsPathExcludedResponse, String> {
    let join = tokio::task::spawn_blocking(move || {
        let mut paths = request.paths.unwrap_or_default();
        if !request.path.is_empty() {
            paths.insert(0, request.path);
        }

        // Even at thousands of paths this is fine on a single thread, but go
        // parallel anyway — `into_par_iter` short-circuits on small inputs.
        let results: Vec<IsPathExcludedItem> = paths
            .into_par_iter()
            .map(|path| evaluate_exclusion(path))
            .collect();

        IsPathExcludedResponse { results }
    });

    join.await
        .map_err(|error| format!("is_path_excluded task panicked: {}", error))
}

fn evaluate_exclusion(path: String) -> IsPathExcludedItem {
    let normalized = path.replace('\\', "/").to_lowercase();
    let segments: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();
    let file_name = segments.last().copied().unwrap_or("");

    for segment in &segments {
        if EXCLUDED_DIRECTORIES.iter().any(|d| d == segment) {
            return IsPathExcludedItem {
                path,
                excluded: true,
                reason: Some(format!(
                    "Reading from '{}' directory is blocked to prevent context overflow",
                    segment
                )),
            };
        }
    }

    if EXCLUDED_FILES.iter().any(|f| f == &file_name) {
        return IsPathExcludedItem {
            path,
            excluded: true,
            reason: Some(format!(
                "File '{}' is excluded (lock file or system file)",
                file_name
            )),
        };
    }

    if let Some(dot_index) = file_name.rfind('.') {
        let ext = &file_name[dot_index..];
        if EXCLUDED_EXTENSIONS.iter().any(|e| e == &ext) {
            return IsPathExcludedItem {
                path,
                excluded: true,
                reason: Some(format!(
                    "Files with extension '{}' are excluded (binary/compiled file)",
                    ext
                )),
            };
        }
    }

    IsPathExcludedItem {
        path,
        excluded: false,
        reason: None,
    }
}

// Mirror of src/tools/utils/excluded-paths.ts. Kept in sorted-ish groupings so
// it's trivially diff-able against the TS source. We use `&str` slices so the
// table is statically allocated and matched in O(N) with very tight code.
const EXCLUDED_DIRECTORIES: &[&str] = &[
    // version control
    ".git", ".svn", ".hg", ".bzr", "_darcs", ".fossil",
    // node / js
    "node_modules", ".pnpm", ".npm", ".yarn", ".pnp", "bower_components", "jspm_packages",
    // next / react
    ".next", ".docusaurus", ".gatsby", ".expo", ".expo-shared",
    // vue / nuxt
    ".nuxt", ".output", ".vuepress", ".temp",
    // angular / svelte
    ".angular", ".svelte-kit",
    // bundlers
    "dist", "build", "out", "output",
    ".parcel-cache", ".rollup.cache", ".webpack", ".turbo",
    ".vercel", ".netlify", ".serverless", ".amplify", ".firebase",
    ".esbuild", ".swc", "storybook-static",
    // rust / go
    "target", "vendor", "bin", "pkg",
    // jvm
    ".gradle", ".idea", "gradle", ".m2", ".mvn", "classes", "libs",
    "intermediates", "generated", "outputs", "captures",
    ".cxx", ".externalNativeBuild", "jniLibs", "apk", "aab",
    "ndk", "sdk", "android-sdk", "android-ndk",
    // c/c++
    "cmake-build-debug", "cmake-build-release", "cmake-build-relwithdebinfo",
    "cmake-build-minsizerel", "cmakefiles", "debug", "release",
    "x64", "x86", "win32", "arm", "arm64",
    ".vs", "ipch", "obj",
    // .net
    "packages", ".nuget", "testresults", "apppackages", "bundleartifacts",
    // python
    "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
    ".tox", ".nox", ".eggs",
    ".venv", "venv", "env", "env_", ".env", ".pyenv", ".conda",
    "site-packages", "htmlcov", ".ipynb_checkpoints",
    // ruby
    ".bundle", ".gem",
    // swift / xcode
    "deriveddata", "pods", ".build", "carthage", "xcuserdata",
    "sourcepackages", "modulecache",
    // dart / flutter
    ".dart_tool", ".pub-cache", ".pub", "ephemeral",
    // elixir
    "_build", "deps", ".elixir_ls",
    // haskell
    ".stack-work", ".cabal-sandbox",
    // testing
    "coverage", ".nyc_output", "__snapshots__", ".jest", ".mocha",
    "test-results", "test-output", "allure-results", "allure-report",
    "playwright-report", ".playwright",
    // caches
    ".cache", ".tmp", "tmp", "temp", "logs", "log",
    // ides
    ".vscode", ".settings", ".project", ".classpath", ".factorypath",
    "nbproject", ".nb-gradle", ".history",
    // os
    "__macosx", ".spotlight-v100", ".trashes", "ehthumbs.db", "$recycle.bin",
    // misc
    ".docker", ".terraform", ".terragrunt-cache", "charts",
    "artifacts", "publish", "_site",
    // unity / unreal
    "library", "memorycaptures", "builds", "usersettings",
    "binaries", "intermediate", "saved", "deriveddatacache",
    // electron / monorepo
    ".electron", "release-builds", ".nx", ".rush", ".pnpm-store",
];

const EXCLUDED_EXTENSIONS: &[&str] = &[
    ".pyc", ".pyo", ".pyd",
    ".class", ".jar", ".war", ".ear",
    ".dll", ".exe", ".msi", ".msm", ".msp",
    ".o", ".obj", ".a", ".lib", ".so", ".dylib",
    ".ko", ".elf",
    ".pdb", ".idb", ".ilk",
    ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
    ".tgz", ".tbz2", ".txz",
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".icns",
    ".webp", ".tiff", ".tif", ".psd", ".ai", ".raw", ".cr2", ".nef",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".mp3", ".mp4", ".wav", ".ogg", ".webm", ".avi", ".mov", ".mkv",
    ".flac", ".aac", ".m4a", ".m4v", ".flv", ".wmv",
    ".db", ".sqlite", ".sqlite3", ".mdb", ".accdb",
    ".map",
    ".apk", ".aab", ".ipa", ".dex",
    ".unity", ".prefab", ".asset", ".meta",
    ".bin", ".dat", ".pak", ".bundle",
];

const EXCLUDED_FILES: &[&str] = &[
    "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb",
    "cargo.lock", "gemfile.lock", "composer.lock", "poetry.lock",
    "pipfile.lock", "pubspec.lock", "packages.lock.json", "paket.lock",
    "mix.lock", "shrinkwrap.yaml",
    ".ds_store", "thumbs.db", "desktop.ini",
    ".env", ".env.local", ".env.development", ".env.development.local",
    ".env.test", ".env.test.local", ".env.production", ".env.production.local",
    ".envrc",
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_count_matches_split_n() {
        assert_eq!(line_count(""), 1);
        assert_eq!(line_count("a"), 1);
        assert_eq!(line_count("a\n"), 2);
        assert_eq!(line_count("a\nb"), 2);
        assert_eq!(line_count("a\nb\n"), 3);
    }

    #[test]
    fn normalize_line_endings_handles_mixed_input() {
        let input = "alpha\r\nbeta\rgamma\ndelta";
        let out = normalize_line_endings(input);
        assert_eq!(out, "alpha\nbeta\ngamma\ndelta");
    }

    /// Regression: the old byte-walking implementation panicked with
    /// "byte index N is not a char boundary" whenever a CRLF file
    /// contained any non-ASCII character, which on `panic = "abort"`
    /// builds aborted the whole IDE. This test exercises every common
    /// non-ASCII path: 2-byte (Latin), 3-byte (CJK), and 4-byte (emoji)
    /// UTF-8 sequences interleaved with CRLF and bare CR line endings.
    #[test]
    fn normalize_line_endings_does_not_panic_on_multibyte_utf8() {
        // 2-byte UTF-8: ä, ö, ü
        let two_byte = "ä\r\nö\r\nü\rdone";
        assert_eq!(normalize_line_endings(two_byte), "ä\nö\nü\ndone");

        // 3-byte UTF-8: CJK
        let three_byte = "你好\r\n世界\r\n再见\rfoo";
        assert_eq!(
            normalize_line_endings(three_byte),
            "你好\n世界\n再见\nfoo"
        );

        // 4-byte UTF-8: emoji
        let four_byte = "🎉\r\n🚀\r\n💥\rship";
        assert_eq!(normalize_line_endings(four_byte), "🎉\n🚀\n💥\nship");

        // Mixed widths in a single string — the worst case for the old
        // byte-walker (every char width changes).
        let mixed = "a\r\nä\r\n你\r\n🎉\rdone";
        assert_eq!(
            normalize_line_endings(mixed),
            "a\nä\n你\n🎉\ndone"
        );

        // Bare CR followed immediately by a multi-byte char must not
        // confuse the lookahead.
        let cr_then_multibyte = "x\rä\r\n你\rend";
        assert_eq!(
            normalize_line_endings(cr_then_multibyte),
            "x\nä\n你\nend"
        );
    }

    /// Regression: `apply_search_replace` on a CRLF-saved file containing
    /// non-ASCII characters used to crash the IDE. This now succeeds
    /// (or returns a structured error) — never panics.
    #[test]
    fn plan_search_replace_handles_crlf_plus_multibyte_utf8() {
        let original = "fn greet() {\r\n    let name = \"José\";\r\n    println!(\"Hello, 世界! 🎉\");\r\n}\r\n";

        let plan = plan_multi_search_replace(
            original,
            &[SearchReplaceItem {
                old_string: "\"José\"".to_string(),
                new_string: "\"Maria\"".to_string(),
                replace_all: false,
            }],
        );

        match plan {
            PlanResult::Ok {
                new_content,
                line_ending_normalized,
                ..
            } => {
                assert!(line_ending_normalized);
                assert!(new_content.contains("\"Maria\""));
                assert!(!new_content.contains("\"José\""));
                // Output preserves CRLF endings of the source.
                assert!(new_content.contains("\r\n"));
                // Multi-byte content elsewhere is untouched.
                assert!(new_content.contains("世界"));
                assert!(new_content.contains("🎉"));
            }
            other => panic!("expected Ok plan, got {:?}", other_kind(&other)),
        }
    }

    /// Same scenario via the multi-replacement variant — replace several
    /// patterns that include multi-byte chars in both `old` and `new`.
    #[test]
    fn plan_multi_search_replace_handles_crlf_plus_multibyte_utf8() {
        let original = "ä\r\nö\r\nü\r\n你好世界\r\n";

        let plan = plan_multi_search_replace(
            original,
            &[
                SearchReplaceItem {
                    old_string: "ä".to_string(),
                    new_string: "AE".to_string(),
                    replace_all: false,
                },
                SearchReplaceItem {
                    old_string: "你好世界".to_string(),
                    new_string: "Hello, World 🎉".to_string(),
                    replace_all: false,
                },
            ],
        );

        match plan {
            PlanResult::Ok { new_content, .. } => {
                assert!(new_content.contains("AE"));
                assert!(new_content.contains("Hello, World 🎉"));
                assert!(!new_content.contains("ä"));
                assert!(!new_content.contains("你好世界"));
                assert!(new_content.contains("\r\n"));
            }
            other => panic!("expected Ok plan, got {:?}", other_kind(&other)),
        }
    }

    fn other_kind(plan: &PlanResult) -> &'static str {
        match plan {
            PlanResult::Ok { .. } => "Ok",
            PlanResult::NotFound { .. } => "NotFound",
            PlanResult::NotUnique { .. } => "NotUnique",
            PlanResult::Overlap { .. } => "Overlap",
        }
    }

    #[test]
    fn plan_unique_replacement_succeeds() {
        let original = "fn foo() {\n    return 1;\n}\n";
        let plan = plan_multi_search_replace(
            original,
            &[SearchReplaceItem {
                old_string: "return 1;".to_string(),
                new_string: "return 42;".to_string(),
                replace_all: false,
            }],
        );

        match plan {
            PlanResult::Ok {
                new_content,
                total_replacements,
                ..
            } => {
                assert_eq!(total_replacements, 1);
                assert!(new_content.contains("return 42;"));
                assert!(!new_content.contains("return 1;"));
            }
            _ => panic!("expected Ok plan"),
        }
    }

    #[test]
    fn plan_reports_not_unique_when_multiple_matches() {
        let plan = plan_multi_search_replace(
            "foo\nfoo\nfoo\n",
            &[SearchReplaceItem {
                old_string: "foo".to_string(),
                new_string: "bar".to_string(),
                replace_all: false,
            }],
        );

        match plan {
            PlanResult::NotUnique {
                failed_at,
                occurrences,
            } => {
                assert_eq!(failed_at, 1);
                assert_eq!(occurrences, 3);
            }
            _ => panic!("expected NotUnique"),
        }
    }

    #[test]
    fn plan_replace_all_replaces_each_occurrence() {
        let plan = plan_multi_search_replace(
            "foo bar foo baz foo",
            &[SearchReplaceItem {
                old_string: "foo".to_string(),
                new_string: "FOO".to_string(),
                replace_all: true,
            }],
        );

        match plan {
            PlanResult::Ok {
                new_content,
                total_replacements,
                ..
            } => {
                assert_eq!(total_replacements, 3);
                assert_eq!(new_content, "FOO bar FOO baz FOO");
            }
            _ => panic!("expected Ok plan"),
        }
    }

    #[test]
    fn plan_detects_overlapping_replacements() {
        let plan = plan_multi_search_replace(
            "abcdef",
            &[
                SearchReplaceItem {
                    old_string: "abcd".to_string(),
                    new_string: "X".to_string(),
                    replace_all: false,
                },
                SearchReplaceItem {
                    old_string: "cdef".to_string(),
                    new_string: "Y".to_string(),
                    replace_all: false,
                },
            ],
        );

        match plan {
            PlanResult::Overlap {
                failed_at,
                conflicting_replacement,
            } => {
                assert_eq!(failed_at, 2);
                assert_eq!(conflicting_replacement, 1);
            }
            _ => panic!("expected Overlap"),
        }
    }

    #[test]
    fn plan_preserves_crlf_line_endings() {
        let plan = plan_multi_search_replace(
            "a\r\nb\r\nc\r\n",
            &[SearchReplaceItem {
                old_string: "b".to_string(),
                new_string: "BBB".to_string(),
                replace_all: false,
            }],
        );

        match plan {
            PlanResult::Ok {
                new_content,
                line_ending_normalized,
                ..
            } => {
                assert!(line_ending_normalized);
                assert_eq!(new_content, "a\r\nBBB\r\nc\r\n");
            }
            _ => panic!("expected Ok plan"),
        }
    }

    #[test]
    fn exclusion_check_blocks_node_modules() {
        let result = evaluate_exclusion("project/node_modules/lodash/index.js".to_string());
        assert!(result.excluded);
    }

    #[test]
    fn exclusion_check_blocks_lock_files() {
        let result = evaluate_exclusion("project/pnpm-lock.yaml".to_string());
        assert!(result.excluded);
    }

    #[test]
    fn exclusion_check_blocks_binary_extensions() {
        let result = evaluate_exclusion("img/foo.PNG".to_string());
        assert!(result.excluded);
    }

    #[test]
    fn exclusion_check_passes_normal_source_files() {
        let result = evaluate_exclusion("src/components/Foo.tsx".to_string());
        assert!(!result.excluded);
    }
}
