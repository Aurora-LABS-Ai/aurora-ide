//! Agent runtime — an aggregate cap on ONE tool message's results.
//!
//! Every other cap in this runtime is per CALL. [`result_cap_for`] bounds
//! `file_read` at 512 KiB, `workspace_tree` at 64 KiB and everything else at
//! 8 KiB, and [`super::super::tool_spill`] moves any single oversized payload
//! to a file. Nothing bounds their SUM.
//!
//! That gap opened when reads started running concurrently. A model that asks
//! for ten files in one message is doing the right thing — it is the batch
//! shape the concurrency work exists to reward — and every one of those results
//! is individually legal at up to 512 KiB. The message they land in is one wire
//! message, and it can be 5 MB of it.
//!
//! ## Why this runs at assembly, not over history
//!
//! The obvious implementation walks the whole conversation before each request
//! and shrinks whatever is over budget. That is wrong here, and expensively so:
//! the request prefix is what providers cache, and rewriting an old result
//! moves every byte after it. Measured on this repo's own prompt, the cached
//! prefix is worth roughly 7,000 tokens a turn (see
//! `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`), and a history-walking budget would spend
//! that every time it changed its mind.
//!
//! So the decision is made ONCE, at the moment the batch is assembled, and
//! written into the message that gets persisted. An earlier turn's results are
//! never revisited, which means they are byte-stable for the life of the
//! conversation by construction rather than by bookkeeping. A verdict cannot
//! drift because nothing ever asks a second time.
//!
//! ## What the model gets back
//!
//! Not a tombstone. The oversized results are moved through the ordinary spill
//! path, so each one keeps a head and tail preview and gains the absolute path
//! of the full text — reachable with `file_read` or `grep`, which the model
//! already has. Nothing is destroyed and nothing is silently missing.

use super::*;

/// Ceiling on the combined size of one tool message's results.
///
/// Sized to match the reference implementation's per-message budget. Roughly
/// 50k tokens: large enough that an honest parallel sweep of a dozen source
/// files passes untouched, small enough that it cannot swallow a 200k window
/// on its own.
///
/// Deliberately a per-MESSAGE budget rather than a rolling one. Two turns that
/// each return 150 KiB are both fine; the failure this guards against is N
/// parallel calls in a SINGLE message compounding into something no per-call
/// cap can see.
pub(crate) const MAX_TOOL_RESULTS_PER_MESSAGE: usize = 200 * 1024;

/// What the budget did, for the log. `None` from [`enforce_message_budget`]
/// means it did nothing at all, which is the overwhelmingly common case.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct BudgetReport {
    /// Combined size of the message's results before the budget ran.
    pub(super) before: usize,
    /// Combined size after. May still exceed the limit — see `exempt`.
    pub(super) after: usize,
    /// How many results were moved to a file.
    pub(super) spilled: usize,
    /// Results that were over the limit's share but could not be moved: an
    /// exact file read (whose middle is the part an edit needs), an embedded
    /// image (whose bytes ARE the payload), one too small for a move to free
    /// anything, or a failed write. Recorded rather than hidden, because a
    /// message that stays over budget is a fact the log should carry.
    pub(super) exempt: usize,
}

/// Bring one tool message's combined result size under
/// [`MAX_TOOL_RESULTS_PER_MESSAGE`], largest result first.
///
/// `spill` is the escape hatch to disk — in production
/// [`super::super::tool_spill::spill_for_budget`] bound to this thread's
/// directory. It returns the content unchanged when it declines to move it,
/// which is how the exemptions travel: this function never needs to know what
/// an image marker looks like.
///
/// Largest-first is what keeps the round-trip cost down. Freeing 200 KiB by
/// moving one result costs the model one `file_read` if it wants the rest;
/// freeing it by moving twenty small ones costs twenty.
pub(super) fn enforce_message_budget(
    blocks: &mut [ContentBlock],
    spill: impl Fn(&str, String) -> String,
) -> Option<BudgetReport> {
    // (index, size). Errors are excluded: they are short by nature, and an
    // error string replaced by "read this file for the rest" is a worse
    // message than the error.
    let mut sized: Vec<(usize, usize)> = blocks
        .iter()
        .enumerate()
        .filter_map(|(i, block)| match block {
            ContentBlock::ToolResult {
                content,
                is_error: None | Some(false),
                ..
            } => Some((i, content.len())),
            _ => None,
        })
        .collect();

    let before: usize = sized.iter().map(|(_, size)| size).sum();
    if before <= MAX_TOOL_RESULTS_PER_MESSAGE {
        return None;
    }

    sized.sort_by(|a, b| b.1.cmp(&a.1));

    let mut remaining = before;
    let mut spilled = 0usize;
    let mut exempt = 0usize;

    for (index, size) in sized {
        if remaining <= MAX_TOOL_RESULTS_PER_MESSAGE {
            break;
        }
        let ContentBlock::ToolResult {
            tool_use_id,
            content,
            ..
        } = &mut blocks[index]
        else {
            continue;
        };

        let id = tool_use_id.clone();
        let replaced = spill(&id, std::mem::take(content));
        let after = replaced.len();
        *content = replaced;

        if after < size {
            remaining -= size - after;
            spilled += 1;
        } else {
            // Declined, or a write that failed. Either way this result is
            // staying whole and the message may finish over budget.
            exempt += 1;
        }
    }

    Some(BudgetReport {
        before,
        after: remaining,
        spilled,
        exempt,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(id: &str, size: usize) -> ContentBlock {
        ContentBlock::ToolResult {
            tool_use_id: id.to_string(),
            content: "x".repeat(size),
            is_error: None,
        }
    }

    fn failed(id: &str, size: usize) -> ContentBlock {
        ContentBlock::ToolResult {
            tool_use_id: id.to_string(),
            content: "e".repeat(size),
            is_error: Some(true),
        }
    }

    /// Stand-in for the real spill: shrinks to a fixed-size pointer.
    fn spiller(_id: &str, raw: String) -> String {
        format!("[moved to disk, {} bytes]", raw.len())
    }

    /// Stand-in for a result the spill declines to move (exact read, image).
    fn declines(_id: &str, raw: String) -> String {
        raw
    }

    fn total(blocks: &[ContentBlock]) -> usize {
        blocks
            .iter()
            .map(|b| match b {
                ContentBlock::ToolResult { content, .. } => content.len(),
                _ => 0,
            })
            .sum()
    }

    #[test]
    fn a_message_under_budget_is_left_completely_alone() {
        // The common case, and it must not cost a single byte of rewriting —
        // the message is about to become part of a cached prefix.
        let mut blocks = vec![result("a", 8 * 1024), result("b", 8 * 1024)];
        let before = blocks.clone();
        assert!(enforce_message_budget(&mut blocks, spiller).is_none());
        assert_eq!(blocks, before);
    }

    #[test]
    fn ten_legal_reads_in_one_message_are_brought_under_budget() {
        // Each of these is individually legal: `result_cap_for("file_read")`
        // allows 512 KiB. Ten of them is 500 KiB in ONE wire message, and no
        // per-call cap can see it. This is the bug the module exists for.
        let mut blocks: Vec<ContentBlock> = (0..10)
            .map(|i| result(&format!("read-{i}"), 50 * 1024))
            .collect();

        let report = enforce_message_budget(&mut blocks, spiller).expect("over budget");

        assert_eq!(report.before, 500 * 1024);
        assert!(
            total(&blocks) <= MAX_TOOL_RESULTS_PER_MESSAGE,
            "still over budget: {} bytes",
            total(&blocks)
        );
        assert_eq!(report.exempt, 0);
        // Seven of ten had to move. Six is not enough: 512,000 bytes less six
        // 51,200-byte results is 204,944, which is still 144 over the 204,800
        // ceiling. The loop stops at the first size that actually fits, not at
        // the one that nearly does.
        assert_eq!(report.spilled, 7);
        assert_eq!(
            blocks
                .iter()
                .filter(
                    |b| matches!(b, ContentBlock::ToolResult { content, .. } if content.len() == 50 * 1024)
                )
                .count(),
            3,
            "the three smallest were never touched"
        );
    }

    #[test]
    fn the_largest_result_is_moved_first() {
        // Freeing the budget by moving one big result costs the model one
        // `file_read` to recover it. Moving many small ones costs many.
        let mut blocks = vec![
            result("small", 4 * 1024),
            result("huge", 300 * 1024),
            result("medium", 8 * 1024),
        ];

        let report = enforce_message_budget(&mut blocks, spiller).expect("over budget");

        assert_eq!(report.spilled, 1, "one move was enough");
        let ContentBlock::ToolResult { content, .. } = &blocks[1] else {
            panic!("expected a result");
        };
        assert!(content.starts_with("[moved to disk"), "the huge one moved");
        // The two small ones were never touched.
        assert_eq!(total(&blocks) - content.len(), 12 * 1024);
    }

    #[test]
    fn a_result_the_spill_declines_is_counted_not_hidden() {
        // A batch of exact file reads cannot be shrunk — the middle of a file
        // is exactly what an edit needs, so the spill refuses. The message
        // finishes over budget and the report says so rather than reporting a
        // success it did not achieve.
        let mut blocks = vec![result("exact-1", 150 * 1024), result("exact-2", 150 * 1024)];

        let report = enforce_message_budget(&mut blocks, declines).expect("over budget");

        assert_eq!(report.spilled, 0);
        assert_eq!(report.exempt, 2);
        assert_eq!(report.after, report.before, "nothing was freed");
        assert_eq!(total(&blocks), 300 * 1024, "content survived intact");
    }

    #[test]
    fn failed_calls_are_never_replaced_by_a_pointer_to_a_file() {
        // "Read this file for the rest" is a worse message than the error it
        // would replace, and errors are short anyway.
        let mut blocks = vec![result("ok", 250 * 1024), failed("bad", 2 * 1024)];

        enforce_message_budget(&mut blocks, spiller).expect("over budget");

        let ContentBlock::ToolResult { content, .. } = &blocks[1] else {
            panic!("expected a result");
        };
        assert_eq!(content.len(), 2 * 1024, "the error text is untouched");
    }

    /// The stub spiller above proves the arithmetic. This proves the wiring:
    /// the real [`super::super::super::tool_spill`] path, a real directory, and
    /// a result the model can actually get back.
    #[test]
    fn the_real_spill_leaves_a_path_the_model_can_read_back() {
        let dir = std::env::temp_dir().join(format!("aurora-budget-{}", uuid::Uuid::new_v4()));
        let mut blocks: Vec<ContentBlock> = (0..6)
            .map(|i| {
                ContentBlock::ToolResult {
                    tool_use_id: format!("call-{i}"),
                    // Distinct bytes per result so a preview cannot accidentally
                    // pass by quoting a neighbour's content.
                    content: format!("shell output {i}\n").repeat(4_000),
                    is_error: None,
                }
            })
            .collect();

        let report = enforce_message_budget(&mut blocks, |id, raw| {
            crate::agent_runtime::tool_spill::spill_for_budget(&dir, id, raw)
        })
        .expect("six results well over 200 KiB");

        assert!(report.spilled > 0, "the real spill moved nothing");
        assert_eq!(report.exempt, 0);
        assert!(
            total(&blocks) <= MAX_TOOL_RESULTS_PER_MESSAGE,
            "still {} bytes",
            total(&blocks)
        );

        // Every shrunken result names a file that exists and holds the whole
        // original text. A pointer to nothing would be worse than a clamp.
        let mut checked = 0;
        for block in &blocks {
            let ContentBlock::ToolResult { content, .. } = block else {
                continue;
            };
            let Some(start) = content.find("full output: ") else {
                continue;
            };
            let path = content[start + "full output: ".len()..]
                .lines()
                .next()
                .expect("a path line")
                .trim();
            let on_disk = std::fs::read_to_string(path)
                .unwrap_or_else(|e| panic!("spilled path {path} is not readable: {e}"));
            assert!(
                on_disk.len() > content.len(),
                "the file holds the full text"
            );
            checked += 1;
        }
        assert_eq!(checked, report.spilled, "every move left a readable path");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stopping_as_soon_as_the_message_fits_leaves_the_rest_whole() {
        // Enforcement is not a sweep. Once under the limit it stops, so a
        // message that was barely over loses one result rather than all of
        // them.
        let mut blocks: Vec<ContentBlock> = (0..4)
            .map(|i| result(&format!("r-{i}"), 60 * 1024))
            .collect();

        let report = enforce_message_budget(&mut blocks, spiller).expect("over budget");

        assert_eq!(report.spilled, 1, "240 KiB - 60 KiB is under 200 KiB");
        let whole = blocks
            .iter()
            .filter(|b| matches!(b, ContentBlock::ToolResult { content, .. } if content.len() == 60 * 1024))
            .count();
        assert_eq!(whole, 3);
    }
}
