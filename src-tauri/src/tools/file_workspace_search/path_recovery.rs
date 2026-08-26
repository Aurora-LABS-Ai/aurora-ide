//! Recovering a readable file from a path the model got slightly wrong.
//!
//! A failed read costs a whole round trip: the model gets an OS error, has to
//! work out what it meant, and calls again. Two of those failures are worth
//! catching, because in both cases Aurora can already see the answer.
//!
//! **Stray quoting.** A model emitting `"app/Shop.tsx\"` leaves a double quote
//! inside the path. Windows rejects the whole filename for it (`os error 123`)
//! and the read fails on a file that is sitting right there. Stripping the
//! quote costs nothing and needs no search.
//!
//! **Right name, wrong folder.** `components/Shop.tsx` when the file is at
//! `app/(shop)/Shop.tsx`. One `rg --files` pass answers it.
//!
//! The rule that keeps this safe: **a repair is only ever offered after the
//! file has actually been opened.** Nothing here guesses. A candidate that
//! does not exist is not a candidate, so a "correction" can never point at a
//! file that is not there.
//!
//! And when several files share the name, nothing is read. Returning one file
//! at random with a confident note is worse than the error was — the model
//! would build on the wrong source and never know. It gets the list instead,
//! which is one round trip, same as today, but the next call is right.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::process::Command as TokioCommand;

use crate::agent_runtime::tool_executor::ToolContext;

/// Keep ripgrep from flashing a console window on Windows.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// How many same-named files are worth listing. Past this the list stops being
/// an answer and starts being another search, and the model is better served
/// by `glob` with a pattern it chooses.
const MAX_CANDIDATES: usize = 8;

/// A name search runs on a path the caller already got wrong, so it is pure
/// overhead on the failure path and must not stall the turn.
const TIMEOUT_MS: u64 = 5_000;

/// What could be salvaged from a path that did not open.
pub(crate) enum Recovery {
    /// One readable file, already confirmed to exist.
    Corrected {
        /// Absolute path to open.
        full: PathBuf,
        /// What to report back as `path` — workspace-relative where possible,
        /// so the tool card names the file that was actually read.
        display: String,
        /// Plain-language note explaining the change, addressed to the model.
        note: String,
    },
    /// Several files carry that name. Nothing was read.
    Ambiguous {
        note: String,
        candidates: Vec<String>,
    },
    /// Nothing to offer — the caller reports its original error unchanged.
    None,
}

/// Strip the punctuation a model wraps around a path when it is really
/// emitting a string literal: surrounding quotes, a stray one on either end,
/// a trailing comma from a list it was mid-way through writing.
///
/// Only ever applied to a path that already failed, and the result is only
/// used if it opens, so over-stripping cannot cost anything. On Windows the
/// characters removed here cannot legally appear in a filename at all.
pub(crate) fn strip_quoting(raw: &str) -> String {
    let mut s = raw.trim();
    // Matched wrapping pairs first, so `'"path"'` unwraps both layers.
    loop {
        let unwrapped = ["\"", "'", "`"].iter().find_map(|q| {
            s.strip_prefix(*q)
                .and_then(|rest| rest.strip_suffix(*q))
                .filter(|inner| !inner.is_empty())
        });
        match unwrapped {
            Some(inner) => s = inner.trim(),
            None => break,
        }
    }
    // Then anything left dangling on one side only — the common case, where
    // the model closed a quote it never opened.
    s.trim_matches(|c| matches!(c, '"' | '\'' | '`' | ',' | ' '))
        .to_string()
}

/// Escape the characters ripgrep's glob syntax would otherwise interpret.
///
/// A one-character class is the portable escape: `[[]` matches a literal `[`.
/// Backslash escaping is not an option here — on Windows it is the path
/// separator. This matters more than it sounds: `[id].tsx` and `[...slug].tsx`
/// are ordinary filenames in any Next.js app, and unescaped they would match
/// one character from the set `i`, `d` instead.
fn escape_glob(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        match ch {
            '*' | '?' | '[' | ']' | '{' | '}' => {
                out.push('[');
                out.push(ch);
                out.push(']');
            }
            _ => out.push(ch),
        }
    }
    out
}

/// Lowercased path segments. Case-folded because the workspaces this runs in
/// are Windows ones, where `App/Page.tsx` and `app/page.tsx` are one file.
fn segments(path: &str) -> Vec<String> {
    path.replace('\\', "/")
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .map(str::to_lowercase)
        .collect()
}

/// How close a candidate is to the path that was asked for, as
/// `(matching trailing segments, requested folder names found anywhere)`.
///
/// The folder part of a wrong path is not noise — it is the caller's belief
/// about where the file lives, and it is usually half right. Asking for
/// `components/Shop.tsx` when the file is at `app/ui/components/Shop.tsx`
/// names the folder exactly; ignoring that and returning whatever sorts first
/// throws away the one piece of information the caller supplied.
///
/// Trailing matches are always at least 1, since every candidate shares the
/// filename. Anything above that is real signal.
fn closeness(candidate: &str, requested: &[String]) -> (usize, usize) {
    let cand = segments(candidate);
    let trailing = cand
        .iter()
        .rev()
        .zip(requested.iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    // Every requested segment but the filename is a folder guess.
    let hints = requested
        .iter()
        .rev()
        .skip(1)
        .filter(|want| cand.iter().any(|seg| seg == *want))
        .count();
    (trailing, hints)
}

/// Sort in place, closest first. Ties break toward the shallower path and then
/// alphabetically, so the same request always produces the same list.
fn rank(candidates: &mut [String], requested: &[String]) {
    candidates.sort_by(|a, b| {
        let (a_trail, a_hits) = closeness(a, requested);
        let (b_trail, b_hits) = closeness(b, requested);
        (b_trail, b_hits, segments(a).len(), a)
            .partial_cmp(&(a_trail, a_hits, segments(b).len(), b))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
}

/// Which folders the matches live in, most crowded first.
///
/// Grouped two segments deep rather than by immediate parent: eighty files
/// named `page.tsx` in a Next.js app have eighty *different* parents, so that
/// grouping would just be the list again under another name. Two levels is
/// where the shape shows — `app/(client)` against `app/(admin)`.
fn folder_spread(paths: &[String]) -> Vec<(String, usize)> {
    let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for path in paths {
        let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        let depth = parts.len().saturating_sub(1).min(2);
        let key = if depth == 0 {
            "the workspace root".to_string()
        } else {
            format!("{}/", parts[..depth].join("/"))
        };
        *counts.entry(key).or_default() += 1;
    }
    let mut spread: Vec<(String, usize)> = counts.into_iter().collect();
    // Count first, then name, so the sentence is stable run to run.
    spread.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    spread
}

/// Render the spread as the tail of a sentence: "`app/(client)/` (34), … and
/// 3 other folders".
fn describe_spread(spread: &[(String, usize)]) -> String {
    const NAMED: usize = 3;
    let named = spread
        .iter()
        .take(NAMED)
        .map(|(folder, count)| format!("`{folder}` ({count})"))
        .collect::<Vec<_>>()
        .join(", ");
    match spread.len().saturating_sub(NAMED) {
        0 => named,
        1 => format!("{named}, and 1 other folder"),
        rest => format!("{named}, and {rest} other folders"),
    }
}

/// Path relative to the workspace root, with forward slashes, falling back to
/// the absolute path when it lies outside.
fn display_path(full: &Path, root: Option<&Path>) -> String {
    root.and_then(|r| full.strip_prefix(r).ok())
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|| full.to_string_lossy().to_string())
}

/// Try to turn a path that did not open into one that does.
///
/// `raw` is what the caller wrote; `resolved` is that path after the usual
/// workspace resolution, which has already been found unreadable (or could not
/// be resolved at all, in which case pass `None`).
pub(crate) async fn recover(raw: &str, resolved: Option<&Path>, ctx: &ToolContext) -> Recovery {
    let root = ctx.workspace_root.as_deref();

    // 1. Quoting. Costs one `stat` and catches the case that needs no search.
    let cleaned = strip_quoting(raw);
    if cleaned != raw && !cleaned.is_empty() {
        if let Ok(candidate) = super::resolve_path_for_read_with_spill(
            &cleaned,
            root,
            ctx.allow_outside_workspace,
            ctx.spill_dir.as_deref(),
        ) {
            if candidate.is_file() && Some(candidate.as_path()) != resolved {
                let display = display_path(&candidate, root);
                return Recovery::Corrected {
                    note: format!(
                        "Your path had stray quote characters. Aurora removed them and read \
                         `{display}`."
                    ),
                    full: candidate,
                    display,
                };
            }
        }
    }

    // 2. Right name, wrong folder. Needs a workspace to search and a name to
    //    search for; a bare directory-looking path gives us neither.
    let Some(root) = root else {
        return Recovery::None;
    };
    let name = match Path::new(&cleaned).file_name() {
        Some(n) => n.to_string_lossy().to_string(),
        None => return Recovery::None,
    };
    if name.is_empty() {
        return Recovery::None;
    }

    let mut matches = find_by_name(&name, root, ctx).await;
    matches.sort();
    matches.dedup();
    let requested = segments(&cleaned);
    rank(&mut matches, &requested);

    match matches.len() {
        0 => Recovery::None,
        1 => {
            let display = matches.into_iter().next().unwrap_or_default();
            let full = root.join(&display);
            // The search said it exists; confirm before claiming it. A file
            // deleted between the two steps must not become a false promise.
            if !full.is_file() {
                return Recovery::None;
            }
            Recovery::Corrected {
                note: format!(
                    "`{raw}` does not exist. Aurora read `{display}` instead, the only file with \
                     that name. Use that path from now on."
                ),
                full,
                display,
            }
        }
        // The paths go in `candidates` and nowhere else. Spelling them out in
        // the message too sent the same eighty-character list twice in one
        // tool result, which is exactly the context a failed read should not
        // be spending.
        n if n <= MAX_CANDIDATES => Recovery::Ambiguous {
            note: format!(
                "`{raw}` does not exist. {n} files share that name — see `candidates`. Nothing \
                 was read; call file_read again with one of them."
            ),
            candidates: matches,
        },
        n => {
            // Ranked first, so "the closest" is a claim the order backs up.
            let closest = matches
                .first()
                .map(|c| closeness(c, &requested))
                .unwrap_or((0, 0));
            // Every candidate shares the filename, so one trailing match is
            // the floor and means nothing. Above it, the caller's folder guess
            // actually pointed somewhere.
            let hinted = closest.0 > 1 || closest.1 > 0;

            if hinted {
                Recovery::Ambiguous {
                    note: format!(
                        "`{raw}` does not exist, and {n} files share that name. `candidates` \
                         holds the {MAX_CANDIDATES} closest to the path you asked for. Nothing \
                         was read; call file_read again with one of them."
                    ),
                    candidates: matches.into_iter().take(MAX_CANDIDATES).collect(),
                }
            } else {
                // No folder to go on, so any slice of the list is arbitrary
                // and listing eight of eighty would dress a guess up as an
                // answer. The shape is smaller AND more use: it tells the
                // caller which folder to ask about next.
                let spread = describe_spread(&folder_spread(&matches));
                Recovery::Ambiguous {
                    note: format!(
                        "`{raw}` does not exist, and {n} files share that name — too many to \
                         choose from. They are under {spread}. Give a longer path, or use glob."
                    ),
                    candidates: Vec::new(),
                }
            }
        }
    }
}

/// Workspace-relative paths of every file with this exact name.
///
/// Uses the bundled ripgrep for the same reason `glob` does: it already
/// implements .gitignore semantics and symlink-loop handling, and it means
/// this agrees with what `glob` and `grep` would say the workspace contains.
async fn find_by_name(name: &str, root: &Path, ctx: &ToolContext) -> Vec<String> {
    let Some(rg) = crate::sidecar::ripgrep() else {
        return Vec::new();
    };

    let mut cmd = TokioCommand::new(&rg.path);
    cmd.current_dir(root)
        .arg("--files")
        .arg("--null")
        .arg("--no-messages")
        .arg("--glob")
        .arg(format!("**/{}", escape_glob(name)))
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // Both exits below — the timeout and the cancel — drop this future
        // while ripgrep is still running. Without this the process outlives
        // the drop still holding the write end of that stdout pipe, and
        // anything downstream waiting for end-of-output waits forever at no
        // CPU. This search is pure overhead on a path that already failed;
        // it must never be the reason something hangs.
        .kill_on_drop(true);

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let Ok(child) = cmd.spawn() else {
        return Vec::new();
    };

    let output = tokio::select! {
        biased;
        () = ctx.cancel_token.cancelled() => return Vec::new(),
        result = tokio::time::timeout(
            std::time::Duration::from_millis(TIMEOUT_MS),
            child.wait_with_output(),
        ) => match result {
            Ok(Ok(output)) => output,
            _ => return Vec::new(),
        },
    };

    String::from_utf8_lossy(&output.stdout)
        .split('\0')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|p| p.replace('\\', "/"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_trailing_quote_is_the_case_this_exists_for() {
        // Observed live: the model wrote the path as a string literal and let
        // the closing quote into it. Windows rejects the whole name for it.
        assert_eq!(strip_quoting("app/shop/Shop.tsx\""), "app/shop/Shop.tsx");
    }

    #[test]
    fn wrapping_quotes_of_every_flavour_come_off() {
        for quoted in ["\"src/a.ts\"", "'src/a.ts'", "`src/a.ts`", "  src/a.ts  "] {
            assert_eq!(strip_quoting(quoted), "src/a.ts", "failed on {quoted}");
        }
    }

    #[test]
    fn nested_quoting_unwraps_all_the_way() {
        assert_eq!(strip_quoting("'\"src/a.ts\"'"), "src/a.ts");
    }

    #[test]
    fn a_trailing_comma_from_a_half_written_list_comes_off() {
        assert_eq!(strip_quoting("src/a.ts,"), "src/a.ts");
    }

    #[test]
    fn a_clean_path_is_returned_untouched() {
        for path in ["src/a.ts", "C:/proj/src/a.ts", "app/[id]/page.tsx"] {
            assert_eq!(strip_quoting(path), path);
        }
    }

    /// A path made of nothing but punctuation strips to nothing, which is the
    /// honest answer. `recover` treats an empty result as no repair and falls
    /// through to the caller's own error — resolving the empty string would
    /// hand back the workspace root as if it were a file.
    #[test]
    fn a_path_made_only_of_quotes_strips_to_nothing() {
        assert_eq!(strip_quoting("\"\""), "");
        assert_eq!(strip_quoting("  '' "), "");
    }

    /// Next.js route segments are bracketed, and those brackets are literal
    /// filename characters. Unescaped, `[id].tsx` is a character class that
    /// matches `i.tsx` and `d.tsx` — and never the file that was asked for.
    #[test]
    fn route_segment_brackets_are_matched_literally() {
        assert_eq!(escape_glob("[id].tsx"), "[[]id[]].tsx");
        assert_eq!(escape_glob("[...slug].tsx"), "[[]...slug[]].tsx");
    }

    #[test]
    fn an_ordinary_name_needs_no_escaping() {
        assert_eq!(escape_glob("Shop.tsx"), "Shop.tsx");
    }

    #[test]
    fn glob_wildcards_in_a_filename_are_escaped_too() {
        assert_eq!(escape_glob("weird*name?.ts"), "weird[*]name[?].ts");
    }

    #[test]
    fn display_path_is_workspace_relative_with_forward_slashes() {
        let root = Path::new("C:/proj");
        assert_eq!(
            display_path(Path::new("C:/proj/src/a.ts"), Some(root)),
            "src/a.ts"
        );
    }

    #[test]
    fn a_path_outside_the_workspace_is_shown_in_full() {
        let root = Path::new("C:/proj");
        let outside = Path::new("D:/other/a.ts");
        assert_eq!(display_path(outside, Some(root)), "D:/other/a.ts");
    }

    // ── Ranking ─────────────────────────────────────────────────

    fn ranked(paths: &[&str], requested: &str) -> Vec<String> {
        let mut list: Vec<String> = paths.iter().map(|s| s.to_string()).collect();
        rank(&mut list, &segments(requested));
        list
    }

    /// The folder in a wrong path is the caller's guess about where the file
    /// is, and it is usually half right. Returning whatever sorted first threw
    /// that away — `app/(client)/about/page.tsx` came back for every request.
    #[test]
    fn the_folder_the_caller_named_pulls_its_matches_to_the_front() {
        let order = ranked(
            &[
                "app/admin/store.ts",
                "app/ui/components/store.ts",
                "lib/store.ts",
            ],
            "components/store.ts",
        );
        assert_eq!(order[0], "app/ui/components/store.ts", "got {order:?}");
    }

    #[test]
    fn a_longer_run_of_matching_folders_beats_a_single_one() {
        let order = ranked(
            &["other/ui/Shop.tsx", "app/ui/Shop.tsx", "ui/Shop.tsx"],
            "app/ui/Shop.tsx",
        );
        assert_eq!(order[0], "app/ui/Shop.tsx", "got {order:?}");
    }

    /// Windows workspaces, where `App/` and `app/` are the same folder.
    #[test]
    fn folder_matching_ignores_case() {
        let order = ranked(&["lib/a.ts", "Components/a.ts"], "components/a.ts");
        assert_eq!(order[0], "Components/a.ts", "got {order:?}");
    }

    /// With no folder to go on every candidate scores the same, so the order
    /// must still be stable — shallowest first, then alphabetical — or the
    /// same question gives a different answer each time it is asked.
    #[test]
    fn a_bare_filename_ranks_shallowest_first_and_stays_stable() {
        let order = ranked(&["a/b/c/page.tsx", "z/page.tsx", "a/page.tsx"], "page.tsx");
        assert_eq!(order, vec!["a/page.tsx", "z/page.tsx", "a/b/c/page.tsx"]);
    }

    // ── Folder spread ───────────────────────────────────────────

    /// Eighty `page.tsx` files have eighty different parents, so grouping by
    /// immediate parent would just be the list again. Two levels is where the
    /// shape shows.
    #[test]
    fn matches_are_grouped_two_folders_deep() {
        let paths: Vec<String> = [
            "app/(client)/about/page.tsx",
            "app/(client)/cart/page.tsx",
            "app/(client)/blog/page.tsx",
            "app/(admin)/orders/page.tsx",
            "app/api/health/page.tsx",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();

        let spread = folder_spread(&paths);
        assert_eq!(spread[0], ("app/(client)/".to_string(), 3), "got {spread:?}");
        assert_eq!(spread.len(), 3);
    }

    #[test]
    fn the_spread_sentence_names_three_folders_and_counts_the_rest() {
        let spread = vec![
            ("app/(client)/".to_string(), 34),
            ("app/(admin)/".to_string(), 21),
            ("app/api/".to_string(), 14),
            ("lib/x/".to_string(), 6),
            ("lib/y/".to_string(), 3),
        ];
        assert_eq!(
            describe_spread(&spread),
            "`app/(client)/` (34), `app/(admin)/` (21), `app/api/` (14), and 2 other folders"
        );
    }

    #[test]
    fn three_folders_or_fewer_are_all_named_with_no_tail() {
        let spread = vec![("src/a/".to_string(), 2), ("src/b/".to_string(), 1)];
        assert_eq!(describe_spread(&spread), "`src/a/` (2), `src/b/` (1)");
    }

    #[test]
    fn one_leftover_folder_is_singular() {
        let spread = vec![
            ("a/1/".to_string(), 4),
            ("a/2/".to_string(), 3),
            ("a/3/".to_string(), 2),
            ("a/4/".to_string(), 1),
        ];
        assert!(describe_spread(&spread).ends_with("and 1 other folder"));
    }

    #[test]
    fn a_file_at_the_workspace_root_is_named_as_such() {
        let spread = folder_spread(&["mod.rs".to_string()]);
        assert_eq!(spread[0].0, "the workspace root");
    }
}
