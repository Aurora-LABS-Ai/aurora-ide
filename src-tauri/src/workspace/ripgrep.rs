//! Ripgrep search: the sidecar `rg` run as JSON and folded into matches,
//! file lists or counts. Backs the agent's `grep` tool and the IDE's search
//! (`commands::ripgrep_search`).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::process::streams::try_kill_pid;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
#[cfg(target_os = "windows")]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RipgrepSearchRequest {
    pub case_insensitive: Option<bool>,
    pub context_lines: Option<u32>,
    pub glob: Option<String>,
    pub is_regex: Option<bool>,
    pub max_results: Option<u32>,
    pub output_mode: Option<String>,
    pub path: String,
    pub pattern: String,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RipgrepMatch {
    pub after_context: Option<Vec<String>>,
    /// Line number of the first `after_context` entry, so a reader can place
    /// the context without counting.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_context_start_line: Option<usize>,
    pub before_context: Option<Vec<String>>,
    /// Line number of the first `before_context` entry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_context_start_line: Option<usize>,
    pub content: String,
    pub file: String,
    pub line_number: usize,
}

/// Hand the context lines ripgrep printed between two matches (or before the
/// first / after the last) to the matches they belong to, BY LINE NUMBER.
///
/// ripgrep's JSON stream is `context… match context… context… match`, with
/// no marker saying which context lines trail the previous match and which
/// lead the next. The old parser pooled everything since the last match and
/// gave the whole pool to BOTH sides: with `-C1` and matches at lines 14 and
/// 24, line 23 was reported as after-context of 14 and line 15 as
/// before-context of 24 (harness run 2026-09-28, thread `5c20f9a3`). Context
/// carries no line numbers of its own in the reply, so the model could not
/// see the bleed and believed `if (!todo)` followed the first `throw`.
///
/// A line within `context_lines` after the previous match trails it; a line
/// within `context_lines` before the next match leads it. Both can be true
/// when the matches are close, and then the line belongs to both, which is
/// exactly what `rg` prints.
pub(crate) struct PendingContext {
    pub(crate) lines: Vec<(usize, String)>,
}

impl PendingContext {
    pub(crate) fn trailing(&self, previous_match_line: usize, context_lines: usize) -> Vec<(usize, String)> {
        self.lines
            .iter()
            .filter(|(line, _)| {
                *line > previous_match_line && *line <= previous_match_line + context_lines
            })
            .cloned()
            .collect()
    }

    pub(crate) fn leading(&self, next_match_line: usize, context_lines: usize) -> Vec<(usize, String)> {
        self.lines
            .iter()
            .filter(|(line, _)| {
                *line < next_match_line && *line + context_lines >= next_match_line
            })
            .cloned()
            .collect()
    }
}

pub(crate) fn append_after_context(target: &mut RipgrepMatch, lines: Vec<(usize, String)>) {
    if lines.is_empty() {
        return;
    }
    if target.after_context_start_line.is_none() {
        target.after_context_start_line = lines.first().map(|(line, _)| *line);
    }
    target
        .after_context
        .get_or_insert_with(Vec::new)
        .extend(lines.into_iter().map(|(_, text)| text));
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RipgrepFileCount {
    pub count: usize,
    pub file: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RipgrepSearchResponse {
    pub counts: Option<Vec<RipgrepFileCount>>,
    pub error: Option<String>,
    pub files: Option<Vec<String>>,
    pub matches: Option<Vec<RipgrepMatch>>,
    /// Plain-language note about the result set — what was capped, and the way
    /// out. Present on truncation and on an empty result; absent otherwise.
    pub message: Option<String>,
    pub pattern: String,
    /// How many items the response actually carries, in the unit `max_results`
    /// capped (matches for `content`, files for the other two modes).
    pub returned: Option<usize>,
    pub success: bool,
    pub tool: String,
    /// Total files with matches. Present only when the search ran to completion
    /// — a truncated search stops just past the cap and never counted them.
    pub total_files: Option<usize>,
    /// Total matches found. Present only when the search ran to completion; see
    /// `total_files`. Use `returned` for how much this response carries.
    pub total_matches: Option<usize>,
    pub truncated: Option<bool>,
}

const DEFAULT_RG_TIMEOUT_MS: u64 = 30_000;
const MAX_RG_TIMEOUT_MS: u64 = 300_000;
const MIN_RG_TIMEOUT_MS: u64 = 1_000;

fn decode_rg_text(raw: &Value) -> String {
    raw.get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Put a ripgrep-reported path back into the absolute form callers expect.
///
/// Searching runs with the search directory as the working directory (so that
/// slash-bearing globs anchor correctly), which makes ripgrep emit paths like
/// `.\src\main.rs`. Every consumer of this command — the transcript file chips,
/// "open in IDE", the review panel — needs a real path, so the relative form is
/// rejoined to the directory it was relative to. `None` (a single-file search)
/// leaves the path exactly as ripgrep reported it.
pub(crate) fn absolutize_rg_path(search_dir: Option<&PathBuf>, reported: String) -> String {
    let Some(dir) = search_dir else {
        return reported;
    };
    let trimmed = reported
        .strip_prefix("./")
        .or_else(|| reported.strip_prefix(".\\"))
        .unwrap_or(&reported);
    if trimmed.is_empty() {
        return dir.to_string_lossy().to_string();
    }
    dir.join(trimmed).to_string_lossy().to_string()
}

fn decode_rg_path(data: &Value) -> Option<String> {
    data.get("path").map(decode_rg_text)
}

fn trim_line_endings(value: String) -> String {
    value
        .trim_end_matches('\n')
        .trim_end_matches('\r')
        .to_string()
}

/// Split a comma-separated list of globs into individual `--glob` arguments.
///
/// The comma is BOTH our list separator and glob syntax, so this cannot be a
/// plain `split(',')`. It used to be, and it silently destroyed the single most
/// natural way to write a multi-extension filter: `**/*.{ts,tsx}` was cut into
/// `**/*.{ts` and `tsx}`, and ripgrep rejected the first fragment with
/// "unclosed alternate group; missing '}'". The model had written a correct
/// glob and the harness broke it before ripgrep ever saw it — so the error read
/// as the model's fault and no rephrasing could fix it.
///
/// Commas are therefore separators only at the top level: inside `{…}`
/// alternation, inside a `[…]` character class, or after a backslash escape,
/// they belong to the pattern.
///
/// Unbalanced input is passed through rather than repaired. A stray `{` means
/// the caller's glob is genuinely malformed, and ripgrep's own message names
/// the problem far better than a guess at what was meant.
pub(crate) fn parse_glob_patterns(glob: &Option<String>) -> Vec<String> {
    let Some(value) = glob.as_ref() else {
        return Vec::new();
    };

    let mut patterns: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut brace_depth: usize = 0;
    let mut in_class = false;
    let mut escaped = false;

    // Takes both buffers as arguments rather than capturing them, so it needs no
    // `mut` of its own and never fights the borrow checker mid-loop.
    let flush = |current: &mut String, patterns: &mut Vec<String>| {
        let trimmed = current.trim();
        if !trimmed.is_empty() {
            patterns.push(trimmed.to_string());
        }
        current.clear();
    };

    for character in value.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        match character {
            '\\' => {
                current.push(character);
                escaped = true;
            }
            '[' if !in_class => {
                in_class = true;
                current.push(character);
            }
            ']' if in_class => {
                in_class = false;
                current.push(character);
            }
            '{' if !in_class => {
                brace_depth += 1;
                current.push(character);
            }
            '}' if !in_class => {
                brace_depth = brace_depth.saturating_sub(1);
                current.push(character);
            }
            ',' if brace_depth == 0 && !in_class => {
                flush(&mut current, &mut patterns);
            }
            _ => current.push(character),
        }
    }
    flush(&mut current, &mut patterns);

    patterns
}

pub async fn ripgrep_search(
    request: RipgrepSearchRequest,
) -> Result<RipgrepSearchResponse, String> {
    use std::collections::BTreeMap;
    use std::process::Stdio;

    let RipgrepSearchRequest {
        case_insensitive,
        context_lines,
        glob,
        is_regex,
        max_results,
        output_mode,
        path,
        pattern,
        timeout_ms,
    } = request;

    let resolved_output_mode = output_mode.unwrap_or_else(|| "content".to_string());
    let resolved_context_lines = context_lines.unwrap_or(0);
    let resolved_max_results = max_results.unwrap_or(50).max(1) as usize;
    let resolved_timeout_ms = timeout_ms
        .unwrap_or(DEFAULT_RG_TIMEOUT_MS)
        .clamp(MIN_RG_TIMEOUT_MS, MAX_RG_TIMEOUT_MS);
    let timeout = std::time::Duration::from_millis(resolved_timeout_ms);

    // Aurora's own ripgrep, falling back to the user's. Resolving to a
    // concrete path (rather than spawning the bare name "rg") is what makes
    // search work on a machine that has never had ripgrep installed — the
    // case that used to return a bare `program not found` and take the
    // agent's content search with it.
    let Some(rg) = crate::sidecar::ripgrep() else {
        return Ok(RipgrepSearchResponse {
            counts: None,
            error: Some(crate::sidecar::ripgrep_missing_message()),
            files: None,
            matches: None,
            message: None,
            pattern,
            returned: None,
            success: false,
            tool: "grep".to_string(),
            total_files: None,
            total_matches: None,
            truncated: None,
        });
    };

    let mut cmd = crate::sidecar::ripgrep_command(rg);
    cmd.arg("--json")
        .arg("--line-number")
        .arg("--with-filename")
        .arg("--hidden")
        // A capped result must be the same "first N" on every run. Unsorted,
        // ripgrep's worker threads decide which files arrive first, and two
        // identical calls returned different file sets (dogfood F17). Sorting
        // runs single-threaded; that is the price of a stable answer.
        .arg("--sort")
        .arg("path");
    // NB: deliberately NO `--max-count`. That is ripgrep's PER-FILE limit, and
    // passing `max_results` to it meant a "200 result" search could collect 200
    // matches *from every file* — thousands of rows — while `files_with_matches`
    // and `count` were never bounded at all. The cap is enforced below, on the
    // unit the caller actually asked to limit, by stopping the read early.

    if !is_regex.unwrap_or(true) {
        cmd.arg("--fixed-strings");
    }

    if case_insensitive.unwrap_or(false) {
        cmd.arg("--ignore-case");
    }

    if resolved_context_lines > 0 {
        cmd.arg("--context").arg(resolved_context_lines.to_string());
    }

    for pattern in parse_glob_patterns(&glob) {
        cmd.arg("--glob").arg(pattern);
    }

    // Run IN the search directory with `.` as the operand, rather than passing
    // the directory as the operand.
    //
    // ripgrep anchors a slash-bearing glob (`apps/x/src/**/*.ts`) to the WORKING
    // DIRECTORY, not to the path operand. Passing an absolute root therefore made
    // every path-qualified glob match nothing at all, while bare patterns like
    // `**/*.rs` kept working — a silent empty result set from a tool that looks
    // perfectly functional. `glob.rs` already ran in the root for exactly this
    // reason; `grep` never got the same treatment.
    //
    // A `path` naming a single FILE keeps the operand form: there is no directory
    // to run in, and a glob filter over one explicit file is meaningless anyway.
    let search_dir = Path::new(&path).is_dir().then(|| PathBuf::from(&path));
    if let Some(dir) = &search_dir {
        cmd.current_dir(dir);
    }
    // The pattern rides behind `-e`, never as a bare positional: a pattern that
    // itself starts with `-` (CSS custom properties like `--color-border-…`,
    // CLI flags in docs) is otherwise parsed by ripgrep as flags and the whole
    // call dies with "unrecognized flag". `-e` composes with `--fixed-strings`.
    cmd.arg("-e")
        .arg(&pattern)
        .arg(match &search_dir {
            Some(_) => ".",
            None => path.as_str(),
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);

    let child = cmd.spawn().map_err(|error| {
        format!(
            "Failed to execute ripgrep at {} ({}): {}",
            rg.path.display(),
            rg.source.as_str(),
            error
        )
    })?;
    let mut child = child;
    let pid = child.id();

    let Some(stdout_pipe) = child.stdout.take() else {
        return Err("ripgrep produced no stdout pipe".to_string());
    };
    // Drain stderr on its own task. Reading stdout to completion while stderr
    // fills its pipe buffer would deadlock; `wait_with_output` used to handle
    // that, and streaming stdout means we now own it.
    let stderr_pipe = child.stderr.take();
    let stderr_task = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut collected = Vec::new();
        if let Some(mut pipe) = stderr_pipe {
            let _ = pipe.read_to_end(&mut collected).await;
        }
        String::from_utf8_lossy(&collected).trim().to_string()
    });

    let mut matches: Vec<RipgrepMatch> = Vec::new();
    let mut files_with_matches: Vec<String> = Vec::new();
    let mut counts_by_file: BTreeMap<String, usize> = BTreeMap::new();
    let mut pending_context_by_file: BTreeMap<String, PendingContext> = BTreeMap::new();
    let mut last_match_index_by_file: BTreeMap<String, usize> = BTreeMap::new();
    let context_window = resolved_context_lines as usize;
    // Files ripgrep has finished with — the only point at which that file's
    // match count is final, since it streams every match before the `end` event.
    let mut files_completed: usize = 0;
    let mut truncated = false;
    // Every mode reads to the end so a capped answer still knows its totals
    // (dogfood F18, F37). Past the cap nothing more is stored: matches are only
    // counted per file. A timeout after the cap filled still returns the list.
    let content_mode = resolved_output_mode != "files_with_matches" && resolved_output_mode != "count";

    // Have we now collected MORE than the caller asked for? Measured on the unit
    // the active output mode actually returns, so `max_results` means the same
    // thing whichever mode is in play. Reading one unit past the cap is what
    // makes `truncated` an observation rather than a guess: stopping exactly at
    // the cap could never distinguish "exactly N results" from "N and counting".
    let over_cap = |matches: &Vec<RipgrepMatch>, files: &Vec<String>, completed: usize| -> bool {
        match resolved_output_mode.as_str() {
            "files_with_matches" => files.len() > resolved_max_results,
            "count" => completed > resolved_max_results,
            _ => matches.len() > resolved_max_results,
        }
    };

    let scan = async {
        use tokio::io::AsyncBufReadExt;
        let mut lines = tokio::io::BufReader::new(stdout_pipe).lines();

        while let Some(line) = lines
            .next_line()
            .await
            .map_err(|error| format!("Failed to read rg output: {error}"))?
        {
            let line = line.as_str();
            if line.trim().is_empty() {
                continue;
            }

            let event: Value = serde_json::from_str(line)
                .map_err(|error| format!("Failed to parse rg output: {}", error))?;

            let event_type = event
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();

            if event_type == "end" {
                files_completed += 1;
            }

            if event_type == "match" {
                let Some(data) = event.get("data") else {
                    continue;
                };

                let Some(file_path) = decode_rg_path(data) else {
                    continue;
                };
                let file_path = absolutize_rg_path(search_dir.as_ref(), file_path);

                if !content_mode || truncated {
                    match counts_by_file.get_mut(&file_path) {
                        Some(count) => *count += 1,
                        None => {
                            counts_by_file.insert(file_path.clone(), 1);
                            files_with_matches.push(file_path);
                        }
                    }
                    if over_cap(&matches, &files_with_matches, files_completed) {
                        truncated = true;
                    }
                    continue;
                }

                let line_number =
                    data.get("line_number").and_then(Value::as_u64).unwrap_or(0) as usize;

                let content =
                    trim_line_endings(decode_rg_text(data.get("lines").unwrap_or(&Value::Null)));
                let pending_context = pending_context_by_file
                    .remove(&file_path)
                    .unwrap_or(PendingContext { lines: Vec::new() });

                if let Some(previous_match_index) = last_match_index_by_file.get(&file_path) {
                    if let Some(previous_match) = matches.get_mut(*previous_match_index) {
                        let trailing =
                            pending_context.trailing(previous_match.line_number, context_window);
                        append_after_context(previous_match, trailing);
                    }
                }
                let leading = pending_context.leading(line_number, context_window);

                counts_by_file
                    .entry(file_path.clone())
                    .and_modify(|count| *count += 1)
                    .or_insert(1);

                if !files_with_matches.iter().any(|file| file == &file_path) {
                    files_with_matches.push(file_path.clone());
                }

                let match_index = matches.len();
                matches.push(RipgrepMatch {
                    after_context: None,
                    after_context_start_line: None,
                    before_context_start_line: leading.first().map(|(line, _)| *line),
                    before_context: if leading.is_empty() {
                        None
                    } else {
                        Some(leading.into_iter().map(|(_, text)| text).collect())
                    },
                    content,
                    file: file_path.clone(),
                    line_number,
                });
                last_match_index_by_file.insert(file_path, match_index);
            }

            if event_type == "context" && content_mode && !truncated {
                let Some(data) = event.get("data") else {
                    continue;
                };

                let Some(file_path) = decode_rg_path(data) else {
                    continue;
                };
                let file_path = absolutize_rg_path(search_dir.as_ref(), file_path);

                let context_line =
                    data.get("line_number").and_then(Value::as_u64).unwrap_or(0) as usize;
                let context_content =
                    trim_line_endings(decode_rg_text(data.get("lines").unwrap_or(&Value::Null)));

                pending_context_by_file
                    .entry(file_path)
                    .or_insert_with(|| PendingContext { lines: Vec::new() })
                    .lines
                    .push((context_line, context_content));
            }

            if over_cap(&matches, &files_with_matches, files_completed) {
                truncated = true;
            }
        }
        Ok::<(), String>(())
    };

    let timed_out = match tokio::time::timeout(timeout, scan).await {
        Ok(result) => {
            result?;
            false
        }
        Err(_) => true,
    };

    // Preserve the real exit status on EOF. Killing here used to race a normal
    // exit and turn useful search failures into an unexplained killed process.
    if timed_out {
        let _ = child.start_kill();
        if let Some(pid) = pid {
            let _ = try_kill_pid(pid);
        }
    }
    let status = child.wait().await.ok();
    let stderr = stderr_task.await.unwrap_or_default();

    // A list that already filled its cap before the clock ran out is still a
    // valid capped answer; only its grand totals are unknown.
    let capped_before_timeout = timed_out && truncated;
    if timed_out && !capped_before_timeout {
        return Ok(RipgrepSearchResponse {
            counts: None,
            error: Some(format!(
                "ripgrep search timed out after {}ms — hidden files are included and build output may be in scope. Set `path` to your source folder or exclude generated/dependency folders with `glob` (for example, `!**/node_modules/**`)",
                timeout.as_millis()
            )),
            files: None,
            matches: None,
            message: None,
            pattern,
            returned: None,
            success: false,
            tool: "grep".to_string(),
            total_files: None,
            total_matches: None,
            truncated: None,
        });
    }

    // Before the trim: in count and file modes these cover the whole search.
    let scanned_total_matches = counts_by_file.values().sum::<usize>();
    let scanned_total_files = counts_by_file.len();

    // Trim the one extra unit that proved there was more to find.
    if truncated {
        match resolved_output_mode.as_str() {
            "files_with_matches" => files_with_matches.truncate(resolved_max_results),
            "count" => {
                let keep: Vec<String> = files_with_matches
                    .iter()
                    .take(resolved_max_results)
                    .cloned()
                    .collect();
                counts_by_file.retain(|file, _| keep.contains(file));
            }
            _ => matches.truncate(resolved_max_results),
        }
    }

    for (file_path, pending) in pending_context_by_file {
        if let Some(last_match_index) = last_match_index_by_file.get(&file_path) {
            if let Some(last_match) = matches.get_mut(*last_match_index) {
                let trailing = pending.trailing(last_match.line_number, context_window);
                append_after_context(last_match, trailing);
            }
        }
    }

    let total_matches = counts_by_file.values().sum::<usize>();

    // A killed process has no meaningful exit code, so only trust the status
    // when we let ripgrep run to completion.
    let exit_code = if capped_before_timeout {
        Some(0)
    } else {
        status.and_then(|status| status.code())
    };

    if exit_code != Some(0) && total_matches == 0 {
        if exit_code == Some(1) {
            return Ok(RipgrepSearchResponse {
                counts: if resolved_output_mode == "count" {
                    Some(Vec::new())
                } else {
                    None
                },
                error: None,
                files: if resolved_output_mode == "files_with_matches" {
                    Some(Vec::new())
                } else {
                    None
                },
                matches: if resolved_output_mode == "content" {
                    Some(Vec::new())
                } else {
                    None
                },
                message: Some(
                    "No matches. Check the pattern, and widen `glob` / `path` if the files you \
                     expected were filtered out."
                        .to_string(),
                ),
                pattern,
                returned: Some(0),
                success: true,
                tool: "grep".to_string(),
                total_files: Some(0),
                total_matches: Some(0),
                truncated: Some(false),
            });
        }

        let error_message = if stderr.is_empty() {
            format!("ripgrep search failed (exit code {exit_code:?}, path: {path})")
        } else {
            stderr
        };

        return Ok(RipgrepSearchResponse {
            counts: None,
            error: Some(error_message),
            files: None,
            matches: None,
            message: None,
            pattern,
            returned: None,
            success: false,
            tool: "grep".to_string(),
            total_files: None,
            total_matches: None,
            truncated: None,
        });
    }

    let total_files = counts_by_file.len();

    let counts = if resolved_output_mode == "count" {
        Some(
            counts_by_file
                .iter()
                .map(|(file, count)| RipgrepFileCount {
                    file: file.clone(),
                    count: *count,
                })
                .collect::<Vec<_>>(),
        )
    } else {
        None
    };

    let files = if resolved_output_mode == "files_with_matches" {
        Some(files_with_matches)
    } else {
        None
    };

    let content_matches = if resolved_output_mode == "content" {
        Some(matches)
    } else {
        None
    };

    // What the caller is actually holding, in the unit they capped.
    let returned = match resolved_output_mode.as_str() {
        "files_with_matches" => files.as_ref().map(Vec::len).unwrap_or(0),
        "count" => counts.as_ref().map(Vec::len).unwrap_or(0),
        _ => content_matches.as_ref().map(Vec::len).unwrap_or(0),
    };

    // Every mode reads past the cap, so the totals cover the whole search
    // unless the clock stopped it.
    let scanned_whole = !timed_out;

    // Truncation has to name itself AND the way out, or the next call is a
    // guess. A content search was stopped early, so it claims no total.
    let message = truncated.then(|| {
        let unit = match resolved_output_mode.as_str() {
            "files_with_matches" => "files",
            "count" => "files",
            _ => "matches",
        };
        let of_total = if scanned_whole {
            format!(" of {scanned_total_files} ({scanned_total_matches} matches in all)")
        } else {
            "; more exist".to_string()
        };
        format!(
            "Showing the first {returned} {unit}{of_total}. Raise `max_results`, narrow \
             `pattern`, or scope the search with `path` / `glob`. Files are in path order."
        )
    });

    let partial_error = if !stderr.trim().is_empty() {
        Some(format!(
            "Search returned partial results because ripgrep reported: {}",
            stderr.trim()
        ))
    } else if exit_code != Some(0) {
        Some(format!("Search returned partial results (ripgrep exit code {exit_code:?}, path: {path})"))
    } else {
        None
    };
    let complete = !truncated && partial_error.is_none();
    Ok(RipgrepSearchResponse {
        counts,
        error: partial_error.clone(),
        files,
        matches: content_matches,
        message,
        pattern,
        returned: Some(returned),
        success: partial_error.is_none(),
        tool: "grep".to_string(),
        // Totals are reported ONLY for a search that ran to completion.
        //
        // A truncated search stops one unit past the cap, so it has no idea what
        // the real total is — it would say "7" where 240 exist. Reporting that
        // as a total is the same failure as the old `min(total, cap)` clamp:
        // a number that looks measured and isn't. `returned` says exactly how
        // much is in hand and `truncated` says there is more; anything wanting a
        // true count must raise `max_results` or narrow the search. Count and
        // file modes are the exception: they read the whole search.
        total_files: if complete {
            Some(total_files)
        } else {
            (scanned_whole && partial_error.is_none()).then_some(scanned_total_files)
        },
        total_matches: if complete {
            Some(total_matches)
        } else {
            (scanned_whole && partial_error.is_none()).then_some(scanned_total_matches)
        },
        truncated: Some(truncated),
    })
}
