//! The project's standing rules: `.aurora/*.md`, read by the engine.
//!
//! A port of `loadProjectRules` (`context-builder.ts`) and
//! `buildAutoRulesContext` (`send/context-blocks.ts`). The block goes into the
//! static half of the system prompt (`SystemPromptInput::project_rules`).
//!
//! Lengths are counted in UTF-16 units, as JavaScript's `length` and `slice`
//! did, so a rule with characters outside the Basic Multilingual Plane is cut
//! at the same place it was.

use std::path::Path;

/// The folder under the workspace that holds the rule files.
const RULES_FOLDER: &str = ".aurora";

/// Total characters for the auto-attached rules (~2.5K tokens).
const AUTO_RULES_CHAR_BUDGET: usize = 10_000;

/// One rule file, trimmed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectRule {
    pub filename: String,
    pub content: String,
}

/// Every `.md` file directly in `<workspace>/.aurora`, listed the way the
/// window listed them (`workspace::fs::list_directory`). Unreadable files are
/// skipped; a missing folder is no rules.
#[must_use]
pub fn load_project_rules(workspace: &Path) -> Vec<ProjectRule> {
    let root = workspace.to_string_lossy();
    let sep = if root.contains('\\') { '\\' } else { '/' };
    let Ok(entries) = crate::workspace::fs::list_directory(&format!("{root}{sep}{RULES_FOLDER}"), true) else {
        return Vec::new();
    };
    entries
        .into_iter()
        .filter(|entry| entry.is_file && entry.name.ends_with(".md") && !entry.path.contains("threads"))
        .filter_map(|entry| match std::fs::read_to_string(&entry.path) {
            Ok(text) => Some(ProjectRule { filename: entry.name, content: js_trim(&text).to_string() }),
            Err(error) => {
                crate::logging::log_warn(
                    "turn_build",
                    &format!("could not read rule file {}: {error}", entry.path),
                );
                None
            }
        })
        .collect()
}

/// The `<project_rules>` block for the system prompt, leaving out the rules
/// the user attached by hand this turn (those ride in full with the message).
/// `None` when there is nothing to attach.
#[must_use]
pub fn auto_rules_block(rules: &[ProjectRule], exclude: &[String]) -> Option<String> {
    let auto: Vec<&ProjectRule> = rules
        .iter()
        .filter(|rule| !exclude.contains(&rule.filename) && !rule.content.is_empty())
        .collect();
    if auto.is_empty() {
        return None;
    }
    let mut remaining = AUTO_RULES_CHAR_BUDGET as isize;
    let mut parts = Vec::with_capacity(auto.len());
    for rule in auto {
        if remaining <= 0 {
            parts.push(format!(
                "<rule file=\"{0}\" omitted=\"true\">Omitted for context budget — read .aurora/{0} with file_read if relevant.</rule>",
                rule.filename
            ));
            continue;
        }
        let units = utf16_len(&rule.content) as isize;
        let body = if units > remaining {
            format!(
                "{}\n…[truncated — read .aurora/{} for the rest]",
                utf16_prefix(&rule.content, remaining as usize),
                rule.filename
            )
        } else {
            rule.content.clone()
        };
        remaining -= utf16_len(&body) as isize;
        parts.push(format!("<rule file=\"{}\">\n{body}\n</rule>", rule.filename));
    }
    Some(format!(
        "<project_rules description=\"Project-specific rules from .aurora/*.md files that must be followed\">\n{}\n</project_rules>",
        parts.join("\n\n")
    ))
}

/// JavaScript's `length`: UTF-16 units.
pub(super) fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The first `units` UTF-16 units of `text`, like JavaScript's `slice(0, n)`.
pub(super) fn utf16_prefix(text: &str, units: usize) -> String {
    let all: Vec<u16> = text.encode_utf16().collect();
    String::from_utf16_lossy(&all[..units.min(all.len())])
}

/// JavaScript's `trim`: Unicode white space plus the byte-order mark.
pub(super) fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(filename: &str, content: &str) -> ProjectRule {
        ProjectRule { filename: filename.into(), content: content.into() }
    }

    #[test]
    fn reads_md_files_trimmed_in_name_order_and_skips_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let rules = dir.path().join(".aurora");
        std::fs::create_dir_all(rules.join("plans")).unwrap();
        std::fs::write(rules.join("b-style.md"), "\u{feff}  Use tabs.\n\n").unwrap();
        std::fs::write(rules.join("A-tests.md"), "Run the tests.").unwrap();
        std::fs::write(rules.join("notes.txt"), "not a rule").unwrap();
        std::fs::write(rules.join("plans").join("inner.md"), "not direct").unwrap();

        assert_eq!(
            load_project_rules(dir.path()),
            vec![rule("A-tests.md", "Run the tests."), rule("b-style.md", "Use tabs.")]
        );
        assert!(load_project_rules(&dir.path().join("missing")).is_empty());
    }

    #[test]
    fn the_block_leaves_out_attached_and_empty_rules() {
        let rules = [rule("a.md", "One."), rule("b.md", "Two."), rule("c.md", "")];
        assert_eq!(
            auto_rules_block(&rules, &["b.md".into()]).unwrap(),
            "<project_rules description=\"Project-specific rules from .aurora/*.md files that must be followed\">\n<rule file=\"a.md\">\nOne.\n</rule>\n</project_rules>"
        );
        assert_eq!(auto_rules_block(&rules[2..], &[]), None);
        assert_eq!(auto_rules_block(&rules[..1], &["a.md".into()]), None);
    }

    #[test]
    fn past_the_budget_a_rule_is_cut_and_the_next_is_omitted() {
        let long = "x".repeat(AUTO_RULES_CHAR_BUDGET + 5);
        let block = auto_rules_block(&[rule("big.md", &long), rule("next.md", "Kept?")], &[]).unwrap();
        assert!(block.contains(&format!("{}\n…[truncated — read .aurora/big.md for the rest]", "x".repeat(AUTO_RULES_CHAR_BUDGET))));
        assert!(block.contains("<rule file=\"next.md\" omitted=\"true\">Omitted for context budget — read .aurora/next.md with file_read if relevant.</rule>"));
    }

    #[test]
    fn the_budget_counts_utf16_units_like_the_window() {
        // 4,999 emoji = 9,998 units; the next rule has 2 units left.
        let emoji = "😀".repeat(4_999);
        let block = auto_rules_block(&[rule("e.md", &emoji), rule("t.md", "abcdef")], &[]).unwrap();
        assert!(block.contains("<rule file=\"t.md\">\nab\n…[truncated — read .aurora/t.md for the rest]\n</rule>"));
    }
}
