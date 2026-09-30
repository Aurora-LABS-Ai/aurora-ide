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

#[derive(Debug, Clone, Deserialize)]
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
        /// Replacements that only matched after folding the file's typographic
        /// characters to ASCII. Empty on an ordinary exact-match edit.
        typography_repairs: Vec<TypographyRepair>,
        /// Replacements that only matched after one level of string escaping
        /// came off what the caller sent. Empty on an ordinary exact-match edit.
        escape_repairs: Vec<EscapeRepair>,
    },
    #[serde(rename = "not_found")]
    NotFound {
        failed_at: usize,
        /// What the closest text in the file is and how it differs. `None`
        /// when nothing in the file resembles `old_string` closely enough for
        /// a comparison to mean anything.
        diagnosis: Option<MatchDiagnosis>,
    },
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

/// One place where the text the caller sent and the text in the file diverge.
///
/// A zero-match edit is almost never a wild guess — it is usually the right
/// text with one character class wrong (a straightened quote, an extra
/// backslash, indentation that lost a space). The engine has the whole file in
/// hand when it fails, so it can name the difference instead of asking the
/// caller to hunt for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineDifference {
    /// 1-based line number in the file.
    pub line: usize,
    /// 1-based character column where the two texts start to diverge.
    pub column: usize,
    /// The run the caller sent, rendered for reading.
    pub sent: String,
    /// The run the file actually holds at that spot, rendered for reading.
    pub found: String,
    /// Codepoints of the sent run. Present only for short runs, where naming
    /// `U+201C` is the whole answer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sent_codes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub found_codes: Option<Vec<String>>,
    /// Set when the shape of the difference has a known cause worth naming.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// The closest text in the file to an `old_string` that matched nowhere.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchDiagnosis {
    /// 1-based inclusive line range in the file holding the closest text.
    pub start_line: usize,
    pub end_line: usize,
    pub differences: Vec<LineDifference>,
    /// True when the comparison found more differences than it listed.
    pub more_differences: bool,
    /// How many places would match if the quotes, dashes and spaces were
    /// copied from the file. Zero means typography is not the problem; two or
    /// more means it is, but the text is no longer unique.
    pub typographic_matches: usize,
}

/// A replacement that landed only because the file's typographic characters
/// were folded to ASCII before matching.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypographyRepair {
    /// 1-based position of this replacement within the call.
    pub replacement_index: usize,
    pub occurrences: usize,
    pub differences: Vec<LineDifference>,
}

/// A replacement that landed only after one level of string escaping was
/// removed from what the caller sent.
///
/// The caller's `old_string` arrived escaped twice — `\"` where the file holds
/// `"`, the two characters `\` `n` where the file holds a newline. One JSON
/// serialization pass produced the whole arguments object, so `new_string`
/// carries the same extra level and is unescaped with it; writing the escaped
/// replacement into a file matched by the unescaped pattern would put text on
/// disk that neither side asked for.
///
/// Reported in full because the assumption is larger than the typography one:
/// that repair changes which bytes MATCHED, this one also changes which bytes
/// get WRITTEN.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EscapeRepair {
    /// 1-based position of this replacement within the call.
    pub replacement_index: usize,
    pub occurrences: usize,
    /// The first line of `old_string` as it arrived, and as it was read after
    /// one escape level came off. One line is enough to recognise the shape
    /// without pasting a whole hunk back into the result.
    pub sent: String,
    pub used: String,
    /// Whether `new_string` was unescaped too. False when it held no escapes,
    /// in which case only the match was affected.
    pub new_string_unescaped: bool,
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
        PlanResult::NotFound {
            failed_at,
            diagnosis,
        } => Ok(SearchReplaceResponse::NotFound {
            failed_at,
            diagnosis,
        }),
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
            typography_repairs,
            escape_repairs,
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
                typography_repairs,
                escape_repairs,
            })
        }
    }
}

// ---------------------------------------------------------------------------
// Plan builder (pure, fully testable)
// ---------------------------------------------------------------------------

#[derive(Debug)]
enum PlanResult {
    Ok {
        new_content: String,
        line_ending_normalized: bool,
        lines_added: usize,
        lines_removed: usize,
        total_replacements: usize,
        replacement_details: Vec<ReplacementDetail>,
        typography_repairs: Vec<TypographyRepair>,
        escape_repairs: Vec<EscapeRepair>,
    },
    NotFound {
        failed_at: usize,
        diagnosis: Option<MatchDiagnosis>,
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
    let mut typography_repairs: Vec<TypographyRepair> = Vec::new();
    let mut escape_repairs: Vec<EscapeRepair> = Vec::new();
    let mut total_replacements = 0usize;

    for (index, replacement) in replacements.iter().enumerate() {
        let normalized_old = normalize_line_endings(&replacement.old_string);
        // The text actually written. It tracks `old_string`: if the pattern
        // only matched after an escape level came off, the replacement carries
        // the same extra level and comes off with it.
        let mut normalized_new = normalize_line_endings(&replacement.new_string);

        if normalized_old.len() != replacement.old_string.len()
            || normalized_new.len() != replacement.new_string.len()
        {
            line_ending_normalized = true;
        }

        if normalized_old.is_empty() {
            return PlanResult::NotFound {
                failed_at: index + 1,
                diagnosis: None,
            };
        }

        // SIMD-accelerated occurrence scan.
        let finder = memmem::Finder::new(normalized_old.as_bytes());
        let exact: Vec<usize> = finder.find_iter(normalized_original.as_bytes()).collect();

        // Byte ranges in `normalized_original` this replacement will rewrite.
        // Exact hits and typography-recovered hits both land here, so the
        // overlap check and the accounting below stay one code path.
        let ranges: Vec<(usize, usize)>;
        let occurrence_count: usize;

        if exact.is_empty() {
            // Zero exact matches. Before giving up, ask the one question the
            // engine can answer for free: does this text exist in the file with
            // the quotes, dashes and spaces the file actually uses? Models
            // straighten those constantly when they copy text out of a read,
            // and the result is a whole failed round trip over two characters.
            //
            // Every repair here is confirmed against the file — the recovered
            // range is re-folded and checked against what matched, so nothing
            // is guessed. Ambiguity is refused rather than resolved: without
            // `replace_all`, anything other than exactly one hit is an error,
            // because picking one of several would edit a place the caller
            // never chose.
            let recovered = recover_typographic(&normalized_original, &normalized_old);
            let usable = if replacement.replace_all {
                !recovered.is_empty()
            } else {
                recovered.len() == 1
            };

            if !usable {
                // Second question the engine can answer for free: did this text
                // arrive escaped one level too many? A model whose serializer
                // ran twice sends `\"` for the file's `"` and the two
                // characters `\` `n` for its newlines. The text is RIGHT — it
                // is wearing an extra coat.
                //
                // Safer than the typography net, not looser. That one folds the
                // FILE and so loses information; this one transforms only what
                // the caller sent and then demands the ordinary exact, unique
                // hit against untouched file bytes. A string that was not
                // over-escaped does not survive unescaping into a match.
                let Some(repair) =
                    recover_overescaped(&normalized_original, &normalized_old, replacement)
                else {
                    return PlanResult::NotFound {
                        failed_at: index + 1,
                        diagnosis: diagnose_no_match(
                            &normalized_original,
                            &normalized_old,
                            &recovered,
                        ),
                    };
                };

                escape_repairs.push(EscapeRepair {
                    replacement_index: index + 1,
                    occurrences: repair.ranges.len(),
                    sent: first_line(&normalized_old),
                    used: first_line(&repair.old),
                    new_string_unescaped: repair.new.is_some(),
                });
                if let Some(new_text) = repair.new {
                    normalized_new = new_text;
                }
                occurrence_count = repair.ranges.len();
                ranges = repair.ranges;
            } else {
                typography_repairs.push(TypographyRepair {
                    replacement_index: index + 1,
                    occurrences: recovered.len(),
                    differences: describe_span(
                        &normalized_original,
                        &normalized_old,
                        recovered[0],
                    ),
                });
                occurrence_count = recovered.len();
                ranges = recovered;
            }
        } else {
            if exact.len() > 1 && !replacement.replace_all {
                return PlanResult::NotUnique {
                    failed_at: index + 1,
                    occurrences: exact.len(),
                };
            }
            occurrence_count = exact.len();
            let selected: &[usize] = if replacement.replace_all {
                &exact[..]
            } else {
                &exact[..1]
            };
            ranges = selected
                .iter()
                .map(|&start| (start, start + normalized_old.len()))
                .collect();
        }

        for &(start, end) in &ranges {
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

        let replaced_count = ranges.len();

        total_replacements += replaced_count;
        replacement_details.push(ReplacementDetail {
            index: index + 1,
            occurrences: occurrence_count,
            replaced: replaced_count,
        });
    }

    // Apply ranges back-to-front so earlier offsets remain valid.
    planned_ranges.sort_by(|a, b| b.start.cmp(&a.start));

    // Kept for the line accounting below: the counts come from a diff of the
    // file before and after, not from the replacement strings.
    let before = normalized_original.clone();
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
                diagnosis: None,
            };
        }
        buffer.replace_range(range.start..range.end, &range.new_text);
    }

    // Counted the way the Review panel counts, so both ends state the same
    // numbers. The previous per-replacement arithmetic (`old.split('\n').len()`
    // removed, `new.split('\n').len()` added, per hit) was off by one in both
    // directions: deleting one line read as 1 added / 2 removed, because an
    // empty `new_string` still "has" one line and the trailing newline of the
    // matched text counted as a second one.
    let (lines_added, lines_removed) = line_change_counts(&before, &buffer);
    let new_content = restore_line_endings(&buffer, original_line_ending);

    PlanResult::Ok {
        new_content,
        line_ending_normalized,
        lines_added,
        lines_removed,
        total_replacements,
        replacement_details,
        typography_repairs,
        escape_repairs,
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

pub(crate) fn normalize_line_endings(value: &str) -> String {
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

/// Lines added and removed between two versions of a file.
///
/// The one counter behind `file_edit`, `file_write` and the Review panel, so
/// every modify tool's card header states the same −removed/+added pair. Uses
/// the same line split as the agent window's `computeDiff`: a single trailing
/// newline is not its own line. Diffing raw text with `TextDiff::from_lines`
/// would count a final line that merely gained a trailing newline as one
/// removal plus one addition.
///
/// The empty→content fast path is the common case (most `file_write` calls
/// create new files) and skips a diff whose answer is known.
pub(crate) fn line_change_counts(old_content: &str, new_content: &str) -> (usize, usize) {
    fn to_lines(text: &str) -> Vec<&str> {
        if text.is_empty() {
            return Vec::new();
        }
        let mut lines: Vec<&str> = text.split('\n').collect();
        if lines.last() == Some(&"") {
            lines.pop();
        }
        lines
    }

    let old_lines = to_lines(old_content);
    let new_lines = to_lines(new_content);
    if old_lines.is_empty() {
        return (new_lines.len(), 0);
    }
    if new_lines.is_empty() {
        return (0, old_lines.len());
    }
    let diff = similar::TextDiff::from_slices(&old_lines, &new_lines);
    let mut added = 0usize;
    let mut removed = 0usize;
    for change in diff.iter_all_changes() {
        match change.tag() {
            similar::ChangeTag::Insert => added += 1,
            similar::ChangeTag::Delete => removed += 1,
            similar::ChangeTag::Equal => {}
        }
    }
    (added, removed)
}

// ---------------------------------------------------------------------------
// Why an edit that matched nothing still has something to say
// ---------------------------------------------------------------------------
//
// A `not_found` used to end the story: "could not find the specified text".
// That is true and useless. Over 707 recorded sessions, 53 of the 83 zero-match
// failures happened on a file the agent had ALREADY read that session — so the
// text was not a guess, it was a transcription that slipped by a character or
// two. The engine holds the whole file at the moment it fails. It can say which
// character, and for the one class where the two texts are the same text, it
// can just do the edit.
//
// Two rules keep that from turning into guesswork:
//   * every recovered range is re-folded and checked against what matched, so
//     a repair is confirmed against the file rather than inferred;
//   * ambiguity is refused, never resolved — several candidates means an error,
//     because choosing one edits a place the caller did not pick.

/// How many differences a diagnosis will list before it stops.
const MAX_DIFFERENCES: usize = 6;
/// How much of a differing run to print before truncating it.
const MAX_RUN_CHARS: usize = 80;
/// Lines below this similarity to the anchor are not close enough to be worth
/// showing. Pointing at unrelated text is worse than saying nothing.
const MIN_ANCHOR_SIMILARITY: f32 = 0.5;
/// An anchor shorter than this says nothing about WHERE the text belongs.
/// `}`, `*/`, `});` and `/**` each match hundreds of lines in a real file.
const MIN_ANCHOR_CHARS: usize = 12;
/// Diagnosis walks every line of the file. Past this size the failure message
/// is not worth the scan.
const MAX_DIAGNOSABLE_LINES: usize = 200_000;

/// The ASCII a model reaches for when it retypes one of the characters a text
/// editor inserted. Folding is one-way, toward ASCII, and both sides of a
/// comparison get folded — which covers the mistake in either direction.
fn typographic_ascii(ch: char) -> Option<&'static str> {
    Some(match ch {
        '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => "'",
        '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => "\"",
        '\u{2013}' | '\u{2014}' | '\u{2212}' => "-",
        '\u{00A0}' | '\u{2007}' | '\u{2009}' | '\u{200A}' | '\u{202F}' => " ",
        '\u{2026}' => "...",
        _ => return None,
    })
}

/// A string with its typographic characters folded to ASCII, carrying the map
/// back to where each byte came from.
struct Folded {
    text: String,
    /// Byte offset in the source for each byte of `text`, plus a final entry
    /// equal to `source.len()` so an exclusive end maps cleanly.
    offsets: Vec<usize>,
    /// Whether folding changed anything. When neither side changed there is no
    /// point searching a second time.
    changed: bool,
}

fn fold_typography(source: &str) -> Folded {
    let mut text = String::with_capacity(source.len());
    let mut offsets = Vec::with_capacity(source.len() + 1);
    let mut changed = false;

    for (byte_index, ch) in source.char_indices() {
        let before = text.len();
        match typographic_ascii(ch) {
            Some(replacement) => {
                changed = true;
                text.push_str(replacement);
            }
            None => text.push(ch),
        }
        offsets.resize(text.len(), byte_index);
        debug_assert!(text.len() > before || ch == '\0');
    }
    offsets.push(source.len());

    Folded {
        text,
        offsets,
        changed,
    }
}

/// Every place in `file` that `old` matches once both are folded to ASCII,
/// as byte ranges in `file` itself.
fn recover_typographic(file: &str, old: &str) -> Vec<(usize, usize)> {
    let folded_file = fold_typography(file);
    let folded_old = fold_typography(old);

    // Nothing was folded on either side, so a second search would run the same
    // comparison that already failed.
    if !folded_file.changed && !folded_old.changed {
        return Vec::new();
    }
    if folded_old.text.is_empty() {
        return Vec::new();
    }

    memmem::Finder::new(folded_old.text.as_bytes())
        .find_iter(folded_file.text.as_bytes())
        .filter_map(|start| {
            let end = start + folded_old.text.len();
            let source_start = *folded_file.offsets.get(start)?;
            let source_end = *folded_file.offsets.get(end)?;
            if source_start >= source_end {
                return None;
            }
            if !file.is_char_boundary(source_start) || !file.is_char_boundary(source_end) {
                return None;
            }
            // The confirmation step. A match that straddled a folded character
            // (the "..." an ellipsis expands into, say) maps back to a range
            // that does not re-fold to what matched — drop it rather than edit
            // the wrong bytes.
            let slice = file.get(source_start..source_end)?;
            let matched = folded_file.text.get(start..end)?;
            if fold_typography(slice).text != matched {
                return None;
            }
            Some((source_start, source_end))
        })
        .collect()
}

/// One level of string escaping removed, or `None` when there was none to
/// remove.
///
/// Deliberately conservative. It rewrites only the six escapes a JSON or C
/// serializer emits — `\n`, `\r`, `\t`, `\"`, `\'`, `\\` — and leaves every
/// other backslash pair exactly as it arrived, both characters intact. A `\d`
/// in a regex, a `\section` in LaTeX and a `\033` escape in a shell script all
/// pass through untouched, so text that merely CONTAINS backslashes is not
/// quietly rewritten on its way to a match.
///
/// `\\` is consumed as a pair and emits one backslash, which is what stops the
/// pass from running away: `\\n` (an escaped backslash followed by `n`) becomes
/// `\n` the two characters, not a newline.
pub(crate) fn unescape_once(text: &str) -> Option<String> {
    if !text.contains('\\') {
        return None;
    }
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    let mut changed = false;

    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('n') => {
                out.push('\n');
                changed = true;
            }
            Some('r') => {
                out.push('\r');
                changed = true;
            }
            Some('t') => {
                out.push('\t');
                changed = true;
            }
            Some('"') => {
                out.push('"');
                changed = true;
            }
            Some('\'') => {
                out.push('\'');
                changed = true;
            }
            Some('\\') => {
                out.push('\\');
                changed = true;
            }
            // Not an escape any serializer produces. Keep both characters.
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }

    changed.then_some(out)
}

/// What an over-escape recovery found: the pattern that actually matched, the
/// replacement to write with it, and where it matched.
pub(crate) struct EscapeRecovery {
    /// `old_string` with one escape level removed.
    pub old: String,
    /// `new_string` with the same level removed — `None` when it held no
    /// escapes and the caller's text is written unchanged.
    pub new: Option<String>,
    /// Byte ranges in the file, exactly as an ordinary exact match produces.
    pub ranges: Vec<(usize, usize)>,
}

/// Try to match `old` against `file` after removing one level of escaping.
///
/// Returns `None` unless the unescaped text produces the same hit an ordinary
/// call would need: exactly one occurrence, or at least one under
/// `replace_all`. No folding, no fuzzy comparison — the recovered ranges are
/// plain `memmem` hits on untouched file bytes, so a range this returns is a
/// range the file genuinely contains.
fn recover_overescaped(
    file: &str,
    old: &str,
    replacement: &SearchReplaceItem,
) -> Option<EscapeRecovery> {
    let unescaped_old = normalize_line_endings(&unescape_once(old)?);
    if unescaped_old.is_empty() || unescaped_old == old {
        return None;
    }

    let hits: Vec<usize> = memmem::Finder::new(unescaped_old.as_bytes())
        .find_iter(file.as_bytes())
        .collect();
    let usable = if replacement.replace_all {
        !hits.is_empty()
    } else {
        hits.len() == 1
    };
    if !usable {
        return None;
    }

    let ranges = hits
        .into_iter()
        .map(|start| (start, start + unescaped_old.len()))
        .collect();

    // One serializer pass produced the whole arguments object, so a
    // double-escaped `old_string` means a double-escaped `new_string`. Writing
    // the escaped replacement into a span matched by the unescaped pattern is
    // the one way this repair could corrupt a file, so the replacement comes
    // off the same coat.
    let new = unescape_once(&replacement.new_string).map(|text| normalize_line_endings(&text));

    Some(EscapeRecovery {
        old: unescaped_old,
        new,
        ranges,
    })
}

/// The first line of a run, capped, for a result that has to be recognisable
/// without pasting a whole hunk back at the reader.
fn first_line(text: &str) -> String {
    let line = text.lines().next().unwrap_or("");
    let mut out: String = line.chars().take(120).collect();
    if out.chars().count() < line.chars().count() || text.lines().count() > 1 {
        out.push('…');
    }
    out
}

/// 1-based line number of the byte at `offset`.
fn line_of_offset(text: &str, offset: usize) -> usize {
    1 + memchr::memchr_iter(b'\n', &text.as_bytes()[..offset.min(text.len())]).count()
}

/// Compare the text at a known range against what the caller sent. Used for a
/// repair that already landed, so the message can say what was corrected.
fn describe_span(file: &str, sent: &str, range: (usize, usize)) -> Vec<LineDifference> {
    let (start, end) = range;
    let Some(found) = file.get(start..end) else {
        return Vec::new();
    };
    let first_line = line_of_offset(file, start);
    let found_lines: Vec<&str> = found.split('\n').collect();
    let sent_lines: Vec<&str> = sent.split('\n').collect();
    compare_lines(&found_lines, &sent_lines, first_line).0
}

/// Walk two blocks of lines in step and describe where they diverge.
///
/// Returns the differences and whether more existed than were listed.
fn compare_lines(
    found_lines: &[&str],
    sent_lines: &[&str],
    first_line: usize,
) -> (Vec<LineDifference>, bool) {
    let mut differences = Vec::new();
    let mut more = false;

    for (offset, sent_line) in sent_lines.iter().enumerate() {
        if differences.len() >= MAX_DIFFERENCES {
            more = true;
            break;
        }
        let line_number = first_line + offset;
        let Some(found_line) = found_lines.get(offset) else {
            differences.push(LineDifference {
                line: line_number,
                column: 1,
                sent: render_run(sent_line),
                found: "nothing — the file's text ends before this line".to_string(),
                sent_codes: None,
                found_codes: None,
                note: Some(
                    "old_string runs past the end of the text it matches. Send fewer lines."
                        .to_string(),
                ),
            });
            more = offset + 1 < sent_lines.len();
            break;
        };
        if found_line == sent_line {
            continue;
        }
        differences.push(diff_one_line(found_line, sent_line, line_number));
    }

    (differences, more)
}

/// Narrow two differing lines to the run that actually differs.
///
/// Trimming the shared prefix and suffix is what makes the message readable:
/// on a 200-character line where one quote is wrong, the caller sees the quote,
/// not the line.
fn diff_one_line(found_line: &str, sent_line: &str, line_number: usize) -> LineDifference {
    let found: Vec<char> = found_line.chars().collect();
    let sent: Vec<char> = sent_line.chars().collect();

    let prefix = found
        .iter()
        .zip(sent.iter())
        .take_while(|(a, b)| a == b)
        .count();
    let max_suffix = found.len().min(sent.len()) - prefix;
    let suffix = found
        .iter()
        .rev()
        .zip(sent.iter().rev())
        .take_while(|(a, b)| a == b)
        .count()
        .min(max_suffix);

    let found_run: String = found[prefix..found.len() - suffix].iter().collect();
    let sent_run: String = sent[prefix..sent.len() - suffix].iter().collect();

    LineDifference {
        line: line_number,
        column: prefix + 1,
        sent: render_run(&sent_run),
        found: render_run(&found_run),
        sent_codes: codepoints(&sent_run),
        found_codes: codepoints(&found_run),
        note: difference_note(&sent_run, &found_run),
    }
}

/// Render a run for a human to read. Whitespace is counted rather than printed,
/// because two spaces beside one space on a screen says nothing at all.
fn render_run(run: &str) -> String {
    if run.is_empty() {
        return "nothing".to_string();
    }
    if run.chars().all(|c| c == ' ' || c == '\t') {
        let spaces = run.chars().filter(|&c| c == ' ').count();
        let tabs = run.chars().filter(|&c| c == '\t').count();
        let mut parts = Vec::new();
        if spaces > 0 {
            parts.push(format!("{spaces} space{}", plural(spaces)));
        }
        if tabs > 0 {
            parts.push(format!("{tabs} tab{}", plural(tabs)));
        }
        return parts.join(" and ");
    }
    let shown: String = run.chars().take(MAX_RUN_CHARS).collect();
    if shown.chars().count() < run.chars().count() {
        format!("{shown}...")
    } else {
        shown
    }
}

fn plural(count: usize) -> &'static str {
    if count == 1 {
        ""
    } else {
        "s"
    }
}

/// Codepoints, but only for a run short enough that naming each one is the
/// answer rather than noise.
fn codepoints(run: &str) -> Option<Vec<String>> {
    let count = run.chars().count();
    if count == 0 || count > 8 {
        return None;
    }
    Some(run.chars().map(|c| format!("U+{:04X}", c as u32)).collect())
}

/// Name the cause when the shape of a difference gives it away.
fn difference_note(sent: &str, found: &str) -> Option<String> {
    if sent == found {
        return None;
    }
    if fold_typography(sent).text == fold_typography(found).text {
        return Some(
            "Same text, different characters. Copy the quotes, dashes and spaces exactly as the \
             file writes them."
                .to_string(),
        );
    }
    if sent.contains('\\') && !found.contains('\\') && sent.replace('\\', "") == found {
        return Some(
            "One escape level too many. The file's text is not escaped — send it without the \
             backslashes."
                .to_string(),
        );
    }
    if found.contains('\\') && !sent.contains('\\') && found.replace('\\', "") == sent {
        return Some(
            "The file's text IS escaped. Keep the backslashes exactly as the file has them."
                .to_string(),
        );
    }
    if !sent.is_empty() && !found.is_empty() && sent.trim().is_empty() && found.trim().is_empty() {
        return Some("Whitespace only. Match the file's indentation exactly.".to_string());
    }
    if sent.is_empty() || found.is_empty() {
        return Some("One side has text the other does not.".to_string());
    }
    None
}

/// How alike two lines are, on a 0..1 scale, measured by shared prefix and
/// suffix. Cheap, and tuned for the case that matters: two lines that are
/// nearly the same.
fn line_similarity(a: &str, b: &str) -> f32 {
    if a == b {
        return 1.0;
    }
    let ac: Vec<char> = a.chars().collect();
    let bc: Vec<char> = b.chars().collect();
    let longest = ac.len().max(bc.len());
    if longest == 0 {
        return 1.0;
    }
    let prefix = ac.iter().zip(bc.iter()).take_while(|(x, y)| x == y).count();
    let max_suffix = ac.len().min(bc.len()) - prefix;
    let suffix = ac
        .iter()
        .rev()
        .zip(bc.iter().rev())
        .take_while(|(x, y)| x == y)
        .count()
        .min(max_suffix);
    (prefix + suffix) as f32 / longest as f32
}

/// Find the closest text in the file to an `old_string` that matched nowhere,
/// and describe how it differs.
///
/// Returns `None` when nothing in the file is close enough for the comparison
/// to mean anything — a message pointing at unrelated text would send the
/// caller further from the answer, not closer.
fn diagnose_no_match(
    file: &str,
    old: &str,
    recovered: &[(usize, usize)],
) -> Option<MatchDiagnosis> {
    let typographic_matches = recovered.len();

    // When folding found candidates, the location is not a guess — it is a
    // measured byte range. Describe the first one instead of running a
    // similarity search that could only do worse.
    if let Some(&(start, end)) = recovered.first() {
        let differences = describe_span(file, old, (start, end));
        if !differences.is_empty() {
            return Some(MatchDiagnosis {
                start_line: line_of_offset(file, start),
                end_line: line_of_offset(file, end),
                more_differences: differences.len() >= MAX_DIFFERENCES,
                differences,
                typographic_matches,
            });
        }
    }

    let file_lines: Vec<&str> = file.split('\n').collect();
    if file_lines.len() > MAX_DIAGNOSABLE_LINES {
        return None;
    }
    let sent_lines: Vec<&str> = old.split('\n').collect();

    // Anchor on the LONGEST line, not the first one with something in it.
    //
    // Verified against a real failure: an `old_string` opening with `/**`
    // anchored on the first `/**` in the file and reported the differences
    // between a doc comment and a banner 900 lines from anything relevant. A
    // short line is not an anchor, it is a coincidence. The longest line
    // carries the most text to be wrong about, so it is the one that either
    // finds the right place or honestly finds nothing.
    let anchor_offset = sent_lines
        .iter()
        .enumerate()
        .max_by_key(|(_, line)| line.trim().chars().count())
        .map(|(index, _)| index)?;
    let anchor_text = sent_lines[anchor_offset].trim_end();
    if anchor_text.trim().chars().count() < MIN_ANCHOR_CHARS {
        return None;
    }
    let anchor = fold_typography(anchor_text).text;

    let mut best_index = 0usize;
    let mut best_score = 0.0f32;
    for (index, line) in file_lines.iter().enumerate() {
        let candidate = fold_typography(line.trim_end()).text;
        let score = line_similarity(&anchor, &candidate);
        if score > best_score {
            best_score = score;
            best_index = index;
            if score >= 1.0 {
                break;
            }
        }
    }

    if best_score < MIN_ANCHOR_SIMILARITY {
        return None;
    }

    // Line up the two blocks so the anchor sits on its match, then compare
    // straight down.
    let start_index = best_index.saturating_sub(anchor_offset);
    let end_index = (start_index + sent_lines.len()).min(file_lines.len());
    let window = &file_lines[start_index..end_index];
    let (differences, more_differences) = compare_lines(window, &sent_lines, start_index + 1);

    // Identical after alignment means the anchor landed somewhere the caller
    // did not mean; there is nothing honest to report.
    if differences.is_empty() {
        return None;
    }

    Some(MatchDiagnosis {
        start_line: start_index + 1,
        end_line: end_index.max(start_index + 1),
        differences,
        more_differences,
        typographic_matches,
    })
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

fn slice_file_lines_inner(
    request: SliceFileLinesRequest,
) -> Result<SliceFileLinesResponse, String> {
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
    ".git",
    ".svn",
    ".hg",
    ".bzr",
    "_darcs",
    ".fossil",
    // node / js
    "node_modules",
    ".pnpm",
    ".npm",
    ".yarn",
    ".pnp",
    "bower_components",
    "jspm_packages",
    // next / react
    ".next",
    ".docusaurus",
    ".gatsby",
    ".expo",
    ".expo-shared",
    // vue / nuxt
    ".nuxt",
    ".output",
    ".vuepress",
    ".temp",
    // angular / svelte
    ".angular",
    ".svelte-kit",
    // bundlers
    "dist",
    "build",
    "out",
    "output",
    ".parcel-cache",
    ".rollup.cache",
    ".webpack",
    ".turbo",
    ".vercel",
    ".netlify",
    ".serverless",
    ".amplify",
    ".firebase",
    ".esbuild",
    ".swc",
    "storybook-static",
    // rust / go
    "target",
    "vendor",
    "bin",
    "pkg",
    // jvm
    ".gradle",
    ".idea",
    "gradle",
    ".m2",
    ".mvn",
    "classes",
    "libs",
    "intermediates",
    "generated",
    "outputs",
    "captures",
    ".cxx",
    ".externalNativeBuild",
    "jniLibs",
    "apk",
    "aab",
    "ndk",
    "sdk",
    "android-sdk",
    "android-ndk",
    // c/c++
    "cmake-build-debug",
    "cmake-build-release",
    "cmake-build-relwithdebinfo",
    "cmake-build-minsizerel",
    "cmakefiles",
    "debug",
    "release",
    "x64",
    "x86",
    "win32",
    "arm",
    "arm64",
    ".vs",
    "ipch",
    "obj",
    // .net
    "packages",
    ".nuget",
    "testresults",
    "apppackages",
    "bundleartifacts",
    // python
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".tox",
    ".nox",
    ".eggs",
    ".venv",
    "venv",
    "env",
    "env_",
    ".env",
    ".pyenv",
    ".conda",
    "site-packages",
    "htmlcov",
    ".ipynb_checkpoints",
    // ruby
    ".bundle",
    ".gem",
    // swift / xcode
    "deriveddata",
    "pods",
    ".build",
    "carthage",
    "xcuserdata",
    "sourcepackages",
    "modulecache",
    // dart / flutter
    ".dart_tool",
    ".pub-cache",
    ".pub",
    "ephemeral",
    // elixir
    "_build",
    "deps",
    ".elixir_ls",
    // haskell
    ".stack-work",
    ".cabal-sandbox",
    // testing
    "coverage",
    ".nyc_output",
    "__snapshots__",
    ".jest",
    ".mocha",
    "test-results",
    "test-output",
    "allure-results",
    "allure-report",
    "playwright-report",
    ".playwright",
    // caches
    ".cache",
    ".tmp",
    "tmp",
    "temp",
    "logs",
    "log",
    // ides
    ".vscode",
    ".settings",
    ".project",
    ".classpath",
    ".factorypath",
    "nbproject",
    ".nb-gradle",
    ".history",
    // os
    "__macosx",
    ".spotlight-v100",
    ".trashes",
    "ehthumbs.db",
    "$recycle.bin",
    // misc
    ".docker",
    ".terraform",
    ".terragrunt-cache",
    "charts",
    "artifacts",
    "publish",
    "_site",
    // unity / unreal
    "library",
    "memorycaptures",
    "builds",
    "usersettings",
    "binaries",
    "intermediate",
    "saved",
    "deriveddatacache",
    // electron / monorepo
    ".electron",
    "release-builds",
    ".nx",
    ".rush",
    ".pnpm-store",
];

const EXCLUDED_EXTENSIONS: &[&str] = &[
    ".pyc", ".pyo", ".pyd", ".class", ".jar", ".war", ".ear", ".dll", ".exe", ".msi", ".msm",
    ".msp", ".o", ".obj", ".a", ".lib", ".so", ".dylib", ".ko", ".elf", ".pdb", ".idb", ".ilk",
    ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".tgz", ".tbz2", ".txz", ".png", ".jpg",
    ".jpeg", ".gif", ".bmp", ".ico", ".icns", ".webp", ".tiff", ".tif", ".psd", ".ai", ".raw",
    ".cr2", ".nef", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3", ".mp4", ".wav", ".ogg",
    ".webm", ".avi", ".mov", ".mkv", ".flac", ".aac", ".m4a", ".m4v", ".flv", ".wmv", ".db",
    ".sqlite", ".sqlite3", ".mdb", ".accdb", ".map", ".apk", ".aab", ".ipa", ".dex", ".unity",
    ".prefab", ".asset", ".meta", ".bin", ".dat", ".pak", ".bundle",
];

const EXCLUDED_FILES: &[&str] = &[
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "bun.lockb",
    "cargo.lock",
    "gemfile.lock",
    "composer.lock",
    "poetry.lock",
    "pipfile.lock",
    "pubspec.lock",
    "packages.lock.json",
    "paket.lock",
    "mix.lock",
    "shrinkwrap.yaml",
    ".ds_store",
    "thumbs.db",
    "desktop.ini",
    ".env",
    ".env.local",
    ".env.development",
    ".env.development.local",
    ".env.test",
    ".env.test.local",
    ".env.production",
    ".env.production.local",
    ".envrc",
];

// ---------------------------------------------------------------------------
// Public commands: agent_open_in_ide / take_pending_ide_open
// ---------------------------------------------------------------------------

/// A file the agent window asked the IDE to open while the IDE window was CLOSED.
/// The backend re-creates the main window and stashes the request here; the
/// freshly-mounted IDE drains it via [`take_pending_ide_open`] on startup. This
/// hop sidesteps any "emit before the listener is ready" race.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingIdeOpen {
    pub path: String,
    pub line: Option<u64>,
}

static PENDING_IDE_OPEN: std::sync::Mutex<Option<PendingIdeOpen>> = std::sync::Mutex::new(None);

/// Hand a file off from the agent window (which is view-only) to the MAIN IDE
/// window for editing, bringing that window to the front — RE-CREATING it if the
/// user closed it (the common case: the IDE is closed once the agent window is
/// up, and reopened on demand from here).
///
/// This runs in the backend on purpose. The previous path emitted a global JS
/// event and hoped the main window would focus *itself* — but a background
/// webview can't steal the OS foreground, and if the IDE was closed there was no
/// listener at all, so the click did nothing. From Rust we own every window: we
/// focus reliably, and when the window doesn't exist we build it and queue the
/// file for its startup drain.
#[tauri::command]
pub async fn agent_open_in_ide(
    app: tauri::AppHandle,
    path: String,
    line: Option<u64>,
) -> Result<(), String> {
    // Window lookup and creation live in `reveal_main_window` / `build_main_window`.
    use tauri::Emitter;

    // Already open → bring it forward and deliver the open request to its
    // existing `agent_open_in_ide` listener (only the main window listens).
    if reveal_main_window(&app) {
        app.emit(
            "agent_open_in_ide",
            serde_json::json!({ "path": path, "line": line }),
        )
        .map_err(|error| format!("Couldn't notify the IDE window: {error}"))?;
        return Ok(());
    }

    // Closed → queue the file, then re-create the main window. It drains the
    // queue once its frontend mounts (see `take_pending_ide_open`).
    *PENDING_IDE_OPEN
        .lock()
        .map_err(|_| "pending-open lock poisoned".to_string())? =
        Some(PendingIdeOpen { path, line });

    if let Err(error) = build_main_window(&app) {
        // Don't leave a stale entry if the window failed to build.
        if let Ok(mut guard) = PENDING_IDE_OPEN.lock() {
            *guard = None;
        }
        return Err(error);
    }

    Ok(())
}

/// Bring an existing IDE window forward. `false` when there is no such window.
///
/// `show()` matters as much as `set_focus()`: a launch that opened the agent
/// window from the saved startup preference leaves `main` HIDDEN rather than
/// closed (see `lib.rs`), and focusing a hidden window does nothing visible.
fn reveal_main_window(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;

    match app.get_webview_window("main") {
        Some(win) => {
            let _ = win.unminimize();
            let _ = win.show();
            let _ = win.set_focus();
            true
        }
        None => false,
    }
}

/// Re-create the IDE window after it has been closed.
///
/// Mirrors the main window from tauri.conf.json (custom title bar → decorations
/// off). `WebviewUrl::App("index.html")` loads the SPA root, which renders the
/// IDE (only `/agent-window` & friends are treated as secondary). Every caller
/// that can find `main` missing goes through here, so the recreated window
/// cannot drift from the configured one in only some of the paths.
fn build_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Aurora")
        .inner_size(1600.0, 1000.0)
        .min_inner_size(900.0, 600.0)
        .center()
        .decorations(false)
        .resizable(true)
        .build()
        .map(|_| ())
        .map_err(|error| format!("Couldn't open the IDE window: {error}"))
}

/// Show the IDE window, creating it if it no longer exists.
///
/// The agent window can be the ONLY surface a launch opens — via `agw` or the
/// saved startup preference — so it needs a path-free way back to the editor.
/// `agent_open_in_ide` cannot serve that: it requires a file, and a fresh agent
/// window may not have one.
///
/// `async` on purpose. A sync `#[tauri::command]` runs on the main thread, and
/// `WebviewWindowBuilder::build()` there deadlocks the Windows UI thread.
#[tauri::command]
pub async fn open_ide_window(app: tauri::AppHandle) -> Result<(), String> {
    if reveal_main_window(&app) {
        return Ok(());
    }
    build_main_window(&app)
}

/// Drained by the main window on startup: returns and clears any file the agent
/// window queued (via [`agent_open_in_ide`]) while the IDE was closed. Returns
/// `null` on a normal launch.
#[tauri::command]
pub fn take_pending_ide_open() -> Option<PendingIdeOpen> {
    PENDING_IDE_OPEN
        .lock()
        .ok()
        .and_then(|mut guard| guard.take())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Issue 3 of the 2026-09-28 harness report: deleting one line was
    /// reported as 1 added / 2 removed, adding one as 2 added / 1 removed.
    #[test]
    fn line_counts_come_from_a_diff_of_the_file_not_the_strings() {
        let file = "a\nb\nc\n";
        let counts = |old: &str, new: &str| match plan_multi_search_replace(
            file,
            &[SearchReplaceItem {
                old_string: old.to_string(),
                new_string: new.to_string(),
                replace_all: false,
            }],
        ) {
            PlanResult::Ok {
                lines_added,
                lines_removed,
                ..
            } => (lines_added, lines_removed),
            other => panic!("expected Ok, got {}", other_kind(&other)),
        };
        assert_eq!(counts("b\n", ""), (0, 1), "delete one line");
        assert_eq!(counts("b\n", "b\nb2\n"), (1, 0), "add one line");
        assert_eq!(counts("b", "B"), (1, 1), "change one line");
        assert_eq!(counts("a\nb\nc\n", "a\nc\n"), (0, 1), "a diff, not string arithmetic");
    }

    #[test]
    fn line_change_counts_ignore_a_trailing_newline_alone() {
        assert_eq!(line_change_counts("", "x\ny\n"), (2, 0));
        assert_eq!(line_change_counts("x\ny\n", ""), (0, 2));
        assert_eq!(line_change_counts("x", "x\n"), (0, 0));
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
        assert_eq!(normalize_line_endings(three_byte), "你好\n世界\n再见\nfoo");

        // 4-byte UTF-8: emoji
        let four_byte = "🎉\r\n🚀\r\n💥\rship";
        assert_eq!(normalize_line_endings(four_byte), "🎉\n🚀\n💥\nship");

        // Mixed widths in a single string — the worst case for the old
        // byte-walker (every char width changes).
        let mixed = "a\r\nä\r\n你\r\n🎉\rdone";
        assert_eq!(normalize_line_endings(mixed), "a\nä\n你\n🎉\ndone");

        // Bare CR followed immediately by a multi-byte char must not
        // confuse the lookahead.
        let cr_then_multibyte = "x\rä\r\n你\rend";
        assert_eq!(normalize_line_endings(cr_then_multibyte), "x\nä\n你\nend");
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

    // -----------------------------------------------------------------------
    // Over-escape recovery
    // -----------------------------------------------------------------------

    fn one(old: &str, new: &str) -> Vec<SearchReplaceItem> {
        vec![SearchReplaceItem {
            old_string: old.to_string(),
            new_string: new.to_string(),
            replace_all: false,
        }]
    }

    /// The failure this recovery was built for, reproduced from thread
    /// `bdc42341` (2026-09-19): the model sent `\"` where the file holds `"`,
    /// and the edit was refused with "One escape level too many" — a correct
    /// diagnosis attached to a call that then had to be made all over again.
    #[test]
    fn an_over_escaped_old_string_matches_after_one_level_comes_off() {
        let file = "const label = \"Added by our team.\"\n";
        let plan = plan_multi_search_replace(
            file,
            &one(
                "const label = \\\"Added by our team.\\\"",
                "const label = \\\"Added by the reseller.\\\"",
            ),
        );

        match plan {
            PlanResult::Ok {
                new_content,
                escape_repairs,
                ..
            } => {
                // The replacement came off the same coat: what lands on disk is
                // the unescaped text, not the backslashes the model sent.
                assert_eq!(new_content, "const label = \"Added by the reseller.\"\n");
                assert_eq!(escape_repairs.len(), 1);
                assert!(
                    escape_repairs[0].new_string_unescaped,
                    "new_string held escapes too and must be reported as unescaped"
                );
            }
            other => panic!("expected the escaped text to be recovered, got {other:?}"),
        }
    }

    /// `\n` as two characters where the file has a real newline — the other
    /// half of the same serializer bug (thread `bdc42341`, `batch-input.tsx`).
    #[test]
    fn escaped_newlines_match_real_ones() {
        let plan = plan_multi_search_replace(
            "alpha\nbeta\n",
            &one("alpha\\nbeta", "alpha\\nGAMMA"),
        );

        match plan {
            PlanResult::Ok {
                new_content,
                escape_repairs,
                ..
            } => {
                assert_eq!(new_content, "alpha\nGAMMA\n");
                assert_eq!(escape_repairs.len(), 1);
            }
            other => panic!("expected escaped newlines to recover, got {other:?}"),
        }
    }

    /// The net must not widen past its one class. Text that is simply WRONG
    /// still fails, backslashes or not — otherwise the recovery would start
    /// editing places nobody named.
    #[test]
    fn unescaping_does_not_rescue_text_that_is_merely_wrong() {
        let plan = plan_multi_search_replace(
            "const a = 1\n",
            &one("const b = \\\"2\\\"", "const c = 3"),
        );
        assert!(
            matches!(plan, PlanResult::NotFound { .. }),
            "text absent from the file must stay absent after unescaping"
        );
    }

    /// A backslash that is not a serializer escape is left alone, both
    /// characters intact. A regex `\d` or a Windows path in source must never
    /// be quietly rewritten on its way to a match.
    #[test]
    fn unescape_leaves_unknown_escapes_untouched() {
        assert_eq!(unescape_once("\\d+"), None, "`\\d` is not an escape to undo");
        assert_eq!(unescape_once("no backslashes"), None);
        assert_eq!(unescape_once("a\\\"b").as_deref(), Some("a\"b"));
        // `\\n` is an escaped backslash followed by `n`, which unescapes to the
        // two characters `\` `n` — NOT to a newline. This is what stops the
        // pass from running away over repeated applications.
        assert_eq!(unescape_once("a\\\\nb").as_deref(), Some("a\\nb"));
        // A mixed run keeps the unknown escape and undoes the known one.
        assert_eq!(unescape_once("\\d\\\"").as_deref(), Some("\\d\""));
    }

    /// Ambiguity is refused, not resolved — the same rule the typography net
    /// follows. Two unescaped hits without `replace_all` is an error, because
    /// picking one would edit a place the caller never chose.
    #[test]
    fn an_over_escaped_pattern_matching_twice_is_refused() {
        let plan = plan_multi_search_replace(
            "say \"hi\"\nsay \"hi\"\n",
            &one("say \\\"hi\\\"", "say \\\"bye\\\""),
        );
        assert!(
            matches!(plan, PlanResult::NotFound { .. }),
            "two candidate spots must refuse rather than pick one"
        );
    }

    /// An ordinary exact match must never take the escape path, or a file that
    /// legitimately contains backslashes would be rewritten without them.
    #[test]
    fn exact_matches_never_reach_the_escape_net() {
        let plan = plan_multi_search_replace(
            "const re = /\\d+/\n",
            &one("const re = /\\d+/", "const re = /\\w+/"),
        );

        match plan {
            PlanResult::Ok {
                new_content,
                escape_repairs,
                ..
            } => {
                assert_eq!(new_content, "const re = /\\w+/\n");
                assert!(
                    escape_repairs.is_empty(),
                    "an exact hit must report no escape repair"
                );
            }
            other => panic!("expected a plain exact match, got {other:?}"),
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

    // -----------------------------------------------------------------------
    // Zero-match recovery and diagnosis
    //
    // Every case below is copied from a real failure in Aurora's own session
    // logs, so a regression here is a regression against something that
    // actually cost a round trip.
    // -----------------------------------------------------------------------

    fn plan_one(file: &str, old: &str, new: &str) -> PlanResult {
        plan_multi_search_replace(
            file,
            &[SearchReplaceItem {
                old_string: old.to_string(),
                new_string: new.to_string(),
                replace_all: false,
            }],
        )
    }

    /// Thread 652b75d3, 2026-08-25. `.knowledge/knowledge.md` holds
    /// `\u{201C}Request a quote\u{201D}`; the model sent straight quotes and
    /// everything else matched character for character. Two failed edits and a
    /// shell fallback came out of two characters.
    #[test]
    fn straightened_quotes_still_edit_the_file() {
        let file =
            "- **Next work:** make \u{201C}Request a quote\u{201D} lead to a real flow.\n\n---\n";
        let plan = plan_one(
            file,
            "- **Next work:** make \"Request a quote\" lead to a real flow.\n\n---",
            "REPLACED",
        );

        let PlanResult::Ok {
            new_content,
            typography_repairs,
            total_replacements,
            ..
        } = plan
        else {
            panic!("a straightened quote must not cost a round trip");
        };
        assert_eq!(total_replacements, 1);
        assert_eq!(new_content, "REPLACED\n");
        // The repair is reported, never silent: the caller's version of the
        // text was wrong and its next edit to these lines would miss again.
        assert_eq!(typography_repairs.len(), 1);
        let differences = &typography_repairs[0].differences;
        assert_eq!(differences.len(), 1, "one line differed");
        assert!(differences[0].found.contains('\u{201C}'));
        assert!(differences[0].sent.contains('"'));
    }

    #[test]
    fn long_dashes_and_no_break_spaces_are_recovered_too() {
        let file = "## Handoff \u{2014} 2026-08-09\nrate\u{00A0}limit\n";
        let plan = plan_one(file, "## Handoff - 2026-08-09\nrate limit", "done");
        assert!(
            matches!(plan, PlanResult::Ok { .. }),
            "em dash and no-break space are the same straightening mistake"
        );
    }

    /// The other half of the rule: a repair is only applied where the file
    /// leaves no choice about which text was meant.
    #[test]
    fn an_ambiguous_repair_is_refused_not_guessed() {
        let file = "say \u{201C}hi\u{201D} here\nand say \u{201C}hi\u{201D} there\n";
        let plan = plan_one(file, "say \"hi\"", "say BYE");

        let PlanResult::NotFound { diagnosis, .. } = plan else {
            panic!("two candidates must not be resolved by picking one");
        };
        let diagnosis = diagnosis.expect("the caller is told why");
        assert_eq!(
            diagnosis.typographic_matches, 2,
            "and told that fixing the quotes alone is not enough"
        );
    }

    /// Thread 652b75d3, `storefront.ts`. The file holds `"ultra"`; the model
    /// sent `\"ultra\"`.
    ///
    /// This used to be `an_over_escaped_quote_is_named_rather_than_repaired`,
    /// asserting a `NotFound` with a good explanation attached. The reasoning
    /// was that a backslash carries meaning in code, so the engine must not
    /// touch one. That is true of the FILE's backslashes and it is still
    /// enforced — the file is never folded or rewritten here. It was never true
    /// of the caller's, which are transport, not content: this pattern is
    /// unescaped, matched exactly and uniquely against untouched file bytes, and
    /// the result says what came off.
    ///
    /// The old behaviour cost the call. Measured 2026-09-19 across five
    /// sessions: five `file_edit` failures whose entire fault was an escape
    /// level, each one a perfectly diagnosed message that still had to be sent
    /// again.
    #[test]
    fn an_over_escaped_quote_matches_after_the_escape_comes_off() {
        let file = " * printed the raw id and shipped \"ultra\" to customers as a plan name.\n";
        let plan = plan_one(
            file,
            " * printed the raw id and shipped \\\"ultra\\\" to customers as a plan name.",
            "x",
        );

        match plan {
            PlanResult::Ok {
                new_content,
                escape_repairs,
                ..
            } => {
                assert_eq!(new_content, "x\n");
                assert_eq!(escape_repairs.len(), 1, "and it says so");
                assert!(
                    !escape_repairs[0].new_string_unescaped,
                    "this new_string held no escapes, so nothing came off it"
                );
            }
            other => panic!("expected the escaped quotes to recover, got {other:?}"),
        }
    }

    /// The explanation the test above used to assert still has to exist,
    /// because recovery does not fire when the unescaped text is ambiguous —
    /// and that is exactly when the caller most needs to be told why.
    #[test]
    fn an_over_escaped_quote_that_cannot_be_resolved_still_names_the_cause() {
        let line = " * printed the raw id and shipped \"ultra\" to customers as a plan name.";
        let file = format!("{line}\n{line}\n");
        let plan = plan_one(
            &file,
            " * printed the raw id and shipped \\\"ultra\\\" to customers as a plan name.",
            "x",
        );

        let PlanResult::NotFound { diagnosis, .. } = plan else {
            panic!("two candidate spots must refuse rather than pick one");
        };
        let diagnosis = diagnosis.expect("but a diagnosable one");
        let difference = diagnosis
            .differences
            .first()
            .expect("the escape difference is reported");
        assert!(
            difference
                .note
                .as_deref()
                .unwrap_or_default()
                .contains("without the backslashes"),
            "the note says what to do, got {:?}",
            difference.note
        );
    }

    /// Trailing whitespace is the difference a caller cannot see. Counting it
    /// beats printing it.
    #[test]
    fn invisible_whitespace_is_described_in_words() {
        let file = "const a = 1;   \nconst b = 2;\n";
        let plan = plan_one(file, "const a = 1;\nconst b = 2;", "x");

        let PlanResult::NotFound { diagnosis, .. } = plan else {
            panic!("trailing spaces really do break the match");
        };
        let difference = &diagnosis.expect("diagnosed").differences[0];
        assert_eq!(difference.found, "3 spaces");
        assert_eq!(difference.sent, "nothing");
        assert_eq!(difference.line, 1);
        assert_eq!(difference.column, 13, "column points past `const a = 1;`");
    }

    #[test]
    fn the_diagnosis_names_the_line_the_closest_text_sits_on() {
        let file = "one\ntwo\nthree\nlet total = 1;\nfive\n";
        let plan = plan_one(file, "let total = 2;", "x");

        let diagnosis = match plan {
            PlanResult::NotFound { diagnosis, .. } => diagnosis.expect("diagnosed"),
            _ => panic!("no match expected"),
        };
        assert_eq!(
            diagnosis.start_line, 4,
            "1-based, and it is the file's line"
        );
        assert_eq!(diagnosis.differences[0].line, 4);
        assert_eq!(diagnosis.differences[0].sent, "2");
        assert_eq!(diagnosis.differences[0].found, "1");
        assert_eq!(
            diagnosis.differences[0].sent_codes.as_deref(),
            Some(["U+0032".to_string()].as_slice()),
            "one wrong character is named by codepoint"
        );
    }

    /// Pointing at unrelated text would send the caller further from the
    /// answer. Saying nothing is the honest option.
    #[test]
    fn text_that_resembles_nothing_gets_no_invented_diagnosis() {
        let file = "alpha\nbeta\ngamma\n";
        let plan = plan_one(file, "completely unrelated content here", "x");
        match plan {
            PlanResult::NotFound { diagnosis, .. } => {
                assert!(diagnosis.is_none(), "got {diagnosis:?}");
            }
            _ => panic!("no match expected"),
        }
    }

    /// The guard that keeps a repair honest: a folded range must re-fold to
    /// what matched, or it is not the range that matched.
    #[test]
    fn a_recovered_range_maps_back_to_the_real_bytes() {
        // The ellipsis folds to three characters, so a naive offset map would
        // hand back a range that starts or ends inside it.
        let file = "wait\u{2026}then go\n";
        let plan = plan_one(file, "wait...then go", "done");
        let PlanResult::Ok { new_content, .. } = plan else {
            panic!("an ellipsis is a straightening mistake like any other");
        };
        assert_eq!(new_content, "done\n", "the whole ellipsis was consumed");
    }

    #[test]
    fn folding_maps_every_byte_back_to_its_source() {
        let source = "a\u{201C}b\u{2026}c";
        let folded = fold_typography(source);
        assert_eq!(folded.text, "a\"b...c");
        assert!(folded.changed);
        // One offset per byte of the folded text, plus the end sentinel.
        assert_eq!(folded.offsets.len(), folded.text.len() + 1);
        assert_eq!(*folded.offsets.last().unwrap(), source.len());
        for (index, &offset) in folded.offsets.iter().enumerate() {
            assert!(
                source.is_char_boundary(offset),
                "offset {offset} for folded byte {index} splits a character"
            );
        }
    }

    /// `replace_all` waives uniqueness by design, so recovery may return every
    /// hit — there is no candidate being chosen on the caller's behalf.
    #[test]
    fn replace_all_recovers_every_occurrence() {
        let file = "\u{201C}x\u{201D} and \u{201C}x\u{201D}\n";
        let plan = plan_multi_search_replace(
            file,
            &[SearchReplaceItem {
                old_string: "\"x\"".to_string(),
                new_string: "Q".to_string(),
                replace_all: true,
            }],
        );
        let PlanResult::Ok {
            new_content,
            total_replacements,
            ..
        } = plan
        else {
            panic!("replace_all has no ambiguity to refuse");
        };
        assert_eq!(total_replacements, 2);
        assert_eq!(new_content, "Q and Q\n");
    }

    /// An exact match must never take the recovery path, and must never
    /// report a repair it did not make.
    #[test]
    fn an_exact_match_is_untouched_by_any_of_this() {
        let file = "let total = 1;\n";
        let plan = plan_one(file, "let total = 1;", "let total = 2;");
        let PlanResult::Ok {
            new_content,
            typography_repairs,
            ..
        } = plan
        else {
            panic!("exact matches still match");
        };
        assert_eq!(new_content, "let total = 2;\n");
        assert!(typography_repairs.is_empty());
    }

    /// Typography folding must not quietly rescue a genuinely wrong edit: the
    /// characters either say the same thing or they do not.
    #[test]
    fn folding_does_not_make_different_text_match() {
        let file = "let total = 1;\n";
        let plan = plan_one(file, "let total = 2;", "x");
        assert!(matches!(plan, PlanResult::NotFound { .. }));
    }

    /// Caught against the real `storefront.ts`. Anchoring on the first
    /// non-blank line meant an `old_string` starting with `/**` anchored on the
    /// file's first `/**` and reported the differences between a doc comment
    /// and a banner hundreds of lines away. The longest line is the one worth
    /// aligning on.
    #[test]
    fn the_anchor_is_the_longest_line_not_the_first_one() {
        let file = "/**\n * banner at the top\n */\nfn a() {}\n\n/**\n * the tier-to-name map lives here now\n */\nfn b() {}\n";
        let plan = plan_one(
            file,
            "/**\n * the tier-to-name map lives HERE now\n */",
            "x",
        );

        let diagnosis = match plan {
            PlanResult::NotFound { diagnosis, .. } => diagnosis.expect("diagnosed"),
            _ => panic!("no match expected"),
        };
        assert_eq!(
            diagnosis.start_line, 6,
            "aligned on the second comment, not the first `/**`"
        );
        assert_eq!(diagnosis.differences[0].line, 7);
        assert_eq!(diagnosis.differences[0].sent, "HERE");
        assert_eq!(diagnosis.differences[0].found, "here");
    }

    /// `}` on its own says nothing about where a block belongs. Reporting a
    /// match for it would be reporting a coincidence.
    #[test]
    fn a_short_anchor_produces_no_diagnosis_at_all() {
        let file = "fn a() {\n    one();\n}\nfn b() {\n    two();\n}\n";
        let plan = plan_one(file, "}\n", "x");
        match plan {
            PlanResult::NotFound { diagnosis, .. } => assert!(diagnosis.is_none()),
            // A bare "}" is present twice, so uniqueness catches it first —
            // either way nothing is guessed.
            PlanResult::NotUnique { .. } => {}
            _ => panic!("must not silently pick one of the braces"),
        }
    }
}
