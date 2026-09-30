//! Nearest-name matching for tool-call recovery.
//!
//! When the model calls a tool that isn't registered, the only thing the
//! runtime used to hand back was `tool not found: browser_eval`. That is a
//! dead end: the model's sole recovery move is another guess, and guessing
//! again is how a turn burns five iterations on a name.
//!
//! A wrong name is nearly always one of three things:
//!
//! - a **near-miss** — `file_reed`, `shell_exec`, `grep_search`;
//! - a **tool from another harness** the model has seen in training
//!   (`str_replace_editor`, `bash`, `read_file`);
//! - a tool Aurora **used to have** and removed (`browser_eval`,
//!   `browser_get_dom`).
//!
//! All three are recoverable in one step IF the error names the real
//! roster. [`suggest`] finds the closest registered name; the caller pairs
//! it with the full list so even a miss leaves the model able to correct
//! itself on the very next block instead of iterating.

/// Levenshtein edit distance between two ASCII-lowercased names.
///
/// Two rolling rows rather than a full matrix — tool names are short and
/// this runs on every unknown-tool error, which is a path we want to stay
/// free enough that nobody is ever tempted to skip it.
fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }

    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut curr = vec![0usize; b.len() + 1];

    for (i, ca) in a.iter().enumerate() {
        curr[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let substitution = prev[j] + usize::from(ca != cb);
            let insertion = curr[j] + 1;
            let deletion = prev[j + 1] + 1;
            curr[j + 1] = substitution.min(insertion).min(deletion);
        }
        std::mem::swap(&mut prev, &mut curr);
    }

    prev[b.len()]
}

/// How far a candidate may sit from `name` and still be offered.
///
/// Scales with length so short names stay strict (`grep` must not suggest
/// `sleep`) while long ones tolerate a dropped word — `browser_get_console`
/// should still reach `browser_get_console_logs`.
fn tolerance(name: &str) -> usize {
    match name.chars().count() {
        0..=4 => 1,
        5..=8 => 2,
        n => (n / 3).min(8),
    }
}

/// Names Aurora retired, mapped to what replaced them.
///
/// Edit distance cannot bridge a rename — `todo_write` is six edits from
/// `todo`, well past any sane tolerance, and loosening the tolerance far
/// enough to catch it would start producing confident wrong answers for
/// everything else. These are the renames worth naming explicitly, and the
/// bar for adding one is that a model is LIKELY to reach for the old name:
/// `TodoWrite` in particular is in essentially every agent model's training
/// data, so the first turn of every conversation would otherwise be a
/// guaranteed miss.
///
/// A row only fires when its target is actually registered, so this table
/// can never resurrect a name that is itself gone.
const RETIRED_NAMES: &[(&str, &str)] = &[
    // The checklist's own history: three names, then one `todo` with a typed
    // `op`, now the reference's three again. A model reaching for any of the
    // dead spellings is answered with the one that does that job.
    ("todo_write", "TaskCreate"),
    ("todowrite", "TaskCreate"),
    ("todo", "TaskCreate"),
    ("todos", "TaskCreate"),
    ("todo_update", "TaskUpdate"),
    ("todo_read", "TaskList"),
    // `TaskGet` reads one task in the reference. Aurora has no per-task read —
    // the list is short enough that reading all of it is the same answer.
    ("taskget", "TaskList"),
];

/// Best registered name for a name the model got wrong, if one is close
/// enough to be worth suggesting.
///
/// A known retirement ([`RETIRED_NAMES`]) is answered first and exactly.
/// Otherwise matching is case-insensitive edit distance, with ties breaking
/// toward the candidate sharing the longest prefix — which is what separates
/// `browser_click` from `browser_fill` when the model wrote `browser_clik`.
///
/// Returns `None` rather than a bad guess — a wrong "did you mean" is worse
/// than none, because the model will spend an iteration taking it.
pub fn suggest<'a, I>(name: &str, candidates: I) -> Option<&'a str>
where
    I: IntoIterator<Item = &'a str>,
{
    let needle = name.to_ascii_lowercase();
    let limit = tolerance(&needle);
    let retired = RETIRED_NAMES
        .iter()
        .find(|(old, _)| *old == needle)
        .map(|(_, new)| *new);

    let mut best: Option<(usize, usize, &'a str)> = None;
    for candidate in candidates {
        // An exact retirement beats any fuzzy score, but only once we have
        // seen the replacement in the live roster.
        if retired == Some(candidate) {
            return Some(candidate);
        }
        let distance = edit_distance(&needle, &candidate.to_ascii_lowercase());
        if distance > limit {
            continue;
        }
        let shared = shared_prefix_len(&needle, &candidate.to_ascii_lowercase());
        // Lower distance wins; equal distance goes to the longer shared prefix.
        let better = match best {
            None => true,
            Some((best_distance, best_shared, _)) => {
                distance < best_distance || (distance == best_distance && shared > best_shared)
            }
        };
        if better {
            best = Some((distance, shared, candidate));
        }
    }

    best.map(|(_, _, candidate)| candidate)
}

fn shared_prefix_len(a: &str, b: &str) -> usize {
    a.chars().zip(b.chars()).take_while(|(x, y)| x == y).count()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROSTER: &[&str] = &[
        "file_read",
        "file_write",
        "file_edit",
        "grep",
        "workspace_tree",
        "shell_execute",
        "shell_spawn",
        "TaskCreate",
        "TaskUpdate",
        "TaskList",
        "browser_navigate",
        "browser_click",
        "browser_fill",
        "browser_screenshot",
        "browser_inspect_element",
        "browser_get_console_logs",
        "browser_page_outline",
    ];

    fn suggest_in_roster(name: &str) -> Option<&'static str> {
        suggest(name, ROSTER.iter().copied())
    }

    #[test]
    fn edit_distance_basics() {
        assert_eq!(edit_distance("", ""), 0);
        assert_eq!(edit_distance("abc", "abc"), 0);
        assert_eq!(edit_distance("", "abc"), 3);
        assert_eq!(edit_distance("abc", ""), 3);
        assert_eq!(edit_distance("kitten", "sitting"), 3);
    }

    #[test]
    fn catches_typos() {
        assert_eq!(suggest_in_roster("file_reed"), Some("file_read"));
        assert_eq!(suggest_in_roster("browser_clik"), Some("browser_click"));
        assert_eq!(suggest_in_roster("TaskCreat"), Some("TaskCreate"));
    }

    #[test]
    fn is_case_insensitive() {
        assert_eq!(suggest_in_roster("File_Read"), Some("file_read"));
    }

    #[test]
    fn retired_todo_names_resolve_to_the_task_tool_that_does_that_job() {
        // `TodoWrite` is in every agent model's training data and is nowhere
        // near `TaskCreate` by edit distance, so without the retirement table
        // the first turn of a conversation is a guaranteed dead end.
        for old in ["todo_write", "TodoWrite", "todo", "todos"] {
            assert_eq!(suggest_in_roster(old), Some("TaskCreate"), "{old}");
        }
        assert_eq!(suggest_in_roster("todo_update"), Some("TaskUpdate"));
        for old in ["todo_read", "TaskGet"] {
            assert_eq!(suggest_in_roster(old), Some("TaskList"), "{old}");
        }
    }

    #[test]
    fn a_retirement_never_names_a_tool_that_is_also_gone() {
        // The table maps onto the LIVE roster, so a roster without `todo`
        // must not answer `todo_write` with it.
        assert_eq!(suggest("todo_write", ["file_read", "grep"]), None);
    }

    #[test]
    fn catches_truncated_long_names() {
        assert_eq!(
            suggest_in_roster("browser_get_console"),
            Some("browser_get_console_logs")
        );
    }

    #[test]
    fn prefix_breaks_ties_between_equally_distant_names() {
        // `browser_clic` is one edit from `browser_click` and two from
        // `browser_fill`'s length — the close one must win.
        assert_eq!(suggest_in_roster("browser_clic"), Some("browser_click"));
    }

    #[test]
    fn refuses_to_guess_when_nothing_is_close() {
        // A tool from another harness with no Aurora analogue. Better to say
        // nothing than to send the model to `grep`.
        assert_eq!(suggest_in_roster("str_replace_editor"), None);
        assert_eq!(suggest_in_roster("send_email"), None);
    }

    #[test]
    fn short_names_stay_strict() {
        // 4 chars, tolerance 1: `grep` must not be offered for `sleep`.
        assert_eq!(suggest("sleep", ROSTER.iter().copied()), None);
    }

    #[test]
    fn empty_roster_yields_no_suggestion() {
        assert_eq!(suggest("file_read", std::iter::empty()), None);
    }
}
