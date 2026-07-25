//! Scope write-guard (ground truth §8 "Scope ownership", §16 Phase 3).
//!
//! The scope partition (`scope-map.json`) gives **exactly one** agent
//! ownership of any given folder. The write-guard is the *enforcement* of
//! that partition: before an IC's file write lands, the build runner asks
//! this module "may `<agent>` write `<path>`?" and refuses anything outside
//! the agent's owned scope (§8 "secondary defense").
//!
//! This module is deliberately **pure path logic** — no disk, no model, no
//! bus. It takes a [`ScopeMap`] snapshot + an agent id + a target path and
//! returns a [`ScopeDecision`]. That keeps it exhaustively unit-testable and
//! lets every caller (the build runner, a Tauri command for the UI, future
//! `agent_safety` integration) share one source of truth for the rule.
//!
//! ## The rule
//!
//! - The **Lead** ([`LEAD_AGENT_ID`]) may write anywhere — it is the
//!   ratifier / owner of last resort (§7).
//! - An **IC** may write a path only if one of *its* `owned_paths` covers it
//!   (folder-level: the owned path equals the target or is an ancestor dir).
//! - A path owned by a **peer** is a boundary: denied, with the owning agent
//!   surfaced so the caller can raise a boundary question or request a
//!   published contract instead of editing across the line (§8).
//! - A path owned by **nobody** (unassigned) is **allowed** for an IC. The
//!   partition's only real job is to stop two agents clobbering *each other*;
//!   unowned territory (a parent dir of an owned file, a sibling the Lead
//!   didn't enumerate, a shared `lib/api.ts` left off the map) has no such
//!   risk. Denying it used to fail whole runs even though every real
//!   deliverable was written — the IC just needed to `mkdir` the parent of a
//!   file it owned. Only a **peer's** scope is off-limits.
//! - `..` traversal and empty paths are rejected outright.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

use super::orchestrator::LEAD_AGENT_ID;
use super::types::ScopeMap;

/// Outcome of a guarded write check. IPC-friendly (`camelCase`) so it can be
/// returned straight to the frontend team view.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeDecision {
    /// Whether the write is permitted.
    pub allowed: bool,
    /// The normalized repo-relative path the decision was made on (or the
    /// original input when it couldn't be normalized).
    pub path: String,
    /// Human-readable explanation — always set, for both allow and deny, so
    /// the channel/UI can show *why*.
    pub reason: String,
    /// When denied because a **peer** owns the path, the owning agent id —
    /// so the caller can address a boundary question to the right owner.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocking_owner: Option<String>,
}

/// Normalize a path to a clean, comparable repo-relative form:
/// `\` → `/`, drop `.` and empty segments, strip leading `/` and `./`, trim
/// the trailing `/`. Returns `None` when the path escapes the repo (any `..`
/// component) or is empty once normalized — both are hard rejects.
#[must_use]
pub fn normalize_repo_rel(path: &str) -> Option<String> {
    let unified = path.replace('\\', "/");
    let mut parts: Vec<&str> = Vec::new();
    for seg in unified.split('/') {
        match seg {
            "" | "." => continue,
            ".." => return None, // refuse traversal outright
            s => parts.push(s),
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

/// Does the glob-ish `pattern` segment match the literal `segment`? Supports
/// `*` as "any run of characters" within the segment (e.g. `Stats.*` matches
/// `Stats.css` and `Stats.tsx`; `*.test.ts` matches `foo.test.ts`).
fn segment_matches(pattern: &str, segment: &str) -> bool {
    if !pattern.contains('*') {
        return pattern == segment;
    }
    let p: Vec<char> = pattern.chars().collect();
    let s: Vec<char> = segment.chars().collect();
    fn rec(p: &[char], s: &[char]) -> bool {
        match p.first() {
            None => s.is_empty(),
            Some('*') => rec(&p[1..], s) || (!s.is_empty() && rec(p, &s[1..])),
            Some(c) => s.first() == Some(c) && rec(&p[1..], &s[1..]),
        }
    }
    rec(&p, &s)
}

/// Segment-wise match of an owned-path pattern against a target path.
/// `**` matches any number of segments (including zero); `*` matches within
/// one segment. A pattern exhausted before the target keeps **prefix
/// semantics**: the owned path covers itself and everything below it
/// (`src/api` covers `src/api/routes.rs`; `src/api/*` covers
/// `src/api/x/y.rs` too).
fn segments_cover(pattern: &[&str], target: &[&str]) -> bool {
    match (pattern.first(), target.first()) {
        // Pattern consumed → the target is the owned path itself or inside it.
        (None, _) => true,
        // `**` absorbs any number of leading target segments.
        (Some(&"**"), _) => {
            segments_cover(&pattern[1..], target)
                || (!target.is_empty() && segments_cover(pattern, &target[1..]))
        }
        (Some(p), Some(t)) => segment_matches(p, t) && segments_cover(&pattern[1..], &target[1..]),
        // Pattern has segments left but the target ended → not covered.
        (Some(_), None) => false,
    }
}

/// Is `target` covered by the owned `prefix`? The owned path may be a plain
/// folder/file prefix (`src/api/`), or carry glob wildcards: `*` within a
/// segment (`src/components/Hero.*`) and `**` across segments
/// (`packages/core/**`). Plain prefixes cover themselves and all descendants.
/// Both sides are normalized first; a prefix that can't normalize matches
/// nothing. The Lead routinely assigns glob scopes (e.g. `Stats.*` to mean
/// "Stats.tsx + Stats.css"), so the guard MUST honor them — treating them as
/// literals silently rejects every write (the "everything rejected" bug).
fn path_covers(prefix: &str, target: &str) -> bool {
    let (Some(p), Some(t)) = (normalize_repo_rel(prefix), normalize_repo_rel(target)) else {
        return false;
    };
    let pattern: Vec<&str> = p.split('/').collect();
    let target_segs: Vec<&str> = t.split('/').collect();
    segments_cover(&pattern, &target_segs)
}

/// Decide whether `agent_id` may write `target`, given the current
/// ownership partition. See the module docs for the rule.
#[must_use]
pub fn evaluate_write(scope: &ScopeMap, agent_id: &str, target: &str) -> ScopeDecision {
    let norm = match normalize_repo_rel(target) {
        Some(v) => v,
        None => {
            return ScopeDecision {
                allowed: false,
                path: target.to_string(),
                reason: format!(
                    "'{target}' is not a valid repo-relative path \
                     (absolute paths and '..' traversal are not allowed)"
                ),
                blocking_owner: None,
            };
        }
    };

    // The Lead ratifies and owns the repo as a whole — it may write anywhere.
    if agent_id == LEAD_AGENT_ID {
        return ScopeDecision {
            allowed: true,
            path: norm,
            reason: "the lead may write anywhere in the repo".into(),
            blocking_owner: None,
        };
    }

    // Does the acting agent own a prefix that covers the target?
    if let Some(mine) = scope.assignments.iter().find(|a| a.agent_id == agent_id) {
        if mine.owned_paths.iter().any(|p| path_covers(p, &norm)) {
            return ScopeDecision {
                allowed: true,
                path: norm,
                reason: "within the agent's owned scope".into(),
                blocking_owner: None,
            };
        }
    }

    // Owned by a peer → a boundary. Deny and name the owner so the caller can
    // ask them (or request a published contract) instead of crossing the line.
    if let Some(owner) = scope
        .assignments
        .iter()
        .find(|a| a.agent_id != agent_id && a.owned_paths.iter().any(|p| path_covers(p, &norm)))
    {
        return ScopeDecision {
            allowed: false,
            reason: format!(
                "'{norm}' is owned by '{}' — raise a boundary question or request a \
                 published contract instead of editing it",
                owner.agent_id
            ),
            blocking_owner: Some(owner.agent_id.clone()),
            path: norm,
        };
    }

    // Owned by nobody. Allowed: no peer can be clobbered, and the IC routinely
    // needs unowned territory — the parent dir of a file it owns, a sibling the
    // Lead didn't list, a shared util. The partition only forbids reaching into
    // a *peer's* scope (handled above), not building on open ground.
    ScopeDecision {
        allowed: true,
        reason: format!("'{norm}' is unassigned (no peer owns it) — open ground, allowed"),
        blocking_owner: None,
        path: norm,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::team::types::ScopeAssignment;

    fn scope(assignments: Vec<(&str, Vec<&str>)>) -> ScopeMap {
        ScopeMap {
            assignments: assignments
                .into_iter()
                .map(|(id, paths)| ScopeAssignment {
                    agent_id: id.to_string(),
                    owned_paths: paths.into_iter().map(String::from).collect(),
                    owned_contracts: Vec::new(),
                })
                .collect(),
            updated_at: "t".into(),
        }
    }

    #[test]
    fn normalize_strips_slashes_dots_and_backslashes() {
        assert_eq!(normalize_repo_rel("./src/api/").as_deref(), Some("src/api"));
        assert_eq!(normalize_repo_rel("/src//api").as_deref(), Some("src/api"));
        assert_eq!(
            normalize_repo_rel("src\\api\\mod.rs").as_deref(),
            Some("src/api/mod.rs")
        );
    }

    #[test]
    fn normalize_rejects_traversal_and_empty() {
        assert_eq!(normalize_repo_rel("../etc/passwd"), None);
        assert_eq!(normalize_repo_rel("src/../../x"), None);
        assert_eq!(normalize_repo_rel(""), None);
        assert_eq!(normalize_repo_rel("/"), None);
    }

    #[test]
    fn owner_may_write_inside_scope() {
        let s = scope(vec![("ic-a", vec!["src/api/"])]);
        let d = evaluate_write(&s, "ic-a", "src/api/routes.rs");
        assert!(d.allowed, "{}", d.reason);
        assert_eq!(d.path, "src/api/routes.rs");
        // The owned dir itself is writable too.
        assert!(evaluate_write(&s, "ic-a", "src/api").allowed);
    }

    #[test]
    fn prefix_match_respects_path_boundaries() {
        // "src/app" must NOT cover "src/application/..." — only true
        // descendants. Asserted on the matcher, because under the current
        // rule an unowned path is allowed regardless (see
        // `unassigned_path_is_allowed_as_open_ground`), so a bare
        // `evaluate_write` cannot distinguish "covered" from "open ground".
        assert!(!path_covers("src/app", "src/application/main.rs"));
        assert!(path_covers("src/app", "src/app/main.rs"));

        // Policy view: the boundary only bites when a PEER owns the far side.
        let s = scope(vec![
            ("ic-a", vec!["src/app"]),
            ("ic-b", vec!["src/application"]),
        ]);
        let d = evaluate_write(&s, "ic-a", "src/application/main.rs");
        assert!(!d.allowed);
        assert_eq!(d.blocking_owner.as_deref(), Some("ic-b"));
        assert!(evaluate_write(&s, "ic-a", "src/app/main.rs").allowed);
    }

    #[test]
    fn peer_owned_path_is_denied_with_owner() {
        let s = scope(vec![("ic-a", vec!["src/api/"]), ("ic-b", vec!["src/ui/"])]);
        let d = evaluate_write(&s, "ic-a", "src/ui/button.tsx");
        assert!(!d.allowed);
        assert_eq!(d.blocking_owner.as_deref(), Some("ic-b"));
    }

    #[test]
    fn unassigned_path_is_allowed_as_open_ground() {
        // No peer owns `docs/` or the parent dir of an owned file, so an IC may
        // write there — denying it used to fail whole runs over a `mkdir`.
        let s = scope(vec![("ic-a", vec!["src/api/"])]);
        let d = evaluate_write(&s, "ic-a", "docs/readme.md");
        assert!(d.allowed, "{}", d.reason);
        assert!(d.blocking_owner.is_none());
        // But a peer's scope is still off-limits.
        let s2 = scope(vec![("ic-a", vec!["src/api/"]), ("ic-b", vec!["docs/"])]);
        assert!(!evaluate_write(&s2, "ic-a", "docs/readme.md").allowed);
    }

    #[test]
    fn lead_may_write_anywhere() {
        let s = scope(vec![("ic-a", vec!["src/api/"])]);
        assert!(evaluate_write(&s, LEAD_AGENT_ID, "src/api/x.rs").allowed);
        assert!(evaluate_write(&s, LEAD_AGENT_ID, "anything/else.rs").allowed);
    }

    #[test]
    fn traversal_target_is_rejected() {
        let s = scope(vec![("ic-a", vec!["src/"])]);
        let d = evaluate_write(&s, "ic-a", "src/../../../etc/passwd");
        assert!(!d.allowed);
        assert!(d.reason.contains("not a valid repo-relative path"));
    }

    #[test]
    fn glob_suffix_on_owned_path_is_treated_as_dir() {
        let s = scope(vec![("ic-a", vec!["packages/core/**"])]);
        assert!(evaluate_write(&s, "ic-a", "packages/core/src/index.ts").allowed);

        // `packages/core/**` must not reach a sibling package.
        assert!(!path_covers("packages/core/**", "packages/other/index.ts"));
        let s2 = scope(vec![
            ("ic-a", vec!["packages/core/**"]),
            ("ic-b", vec!["packages/other/**"]),
        ]);
        assert!(!evaluate_write(&s2, "ic-a", "packages/other/index.ts").allowed);
    }

    #[test]
    fn filename_glob_matches_extension_variants() {
        // The real-world bug: the Lead assigns "src/components/Stats.*" and
        // the IC writes "src/components/Stats.css" — that MUST be allowed.
        let s = scope(vec![(
            "ic-a",
            vec!["src/components/Stats.*", "src/components/Tech.*"],
        )]);
        assert!(evaluate_write(&s, "ic-a", "src/components/Stats.css").allowed);
        assert!(evaluate_write(&s, "ic-a", "src/components/Stats.tsx").allowed);
        assert!(evaluate_write(&s, "ic-a", "src/components/Tech.css").allowed);
        // Other components are not COVERED by the glob (they are merely
        // open ground until a peer claims them — see the s2 case below).
        assert!(!path_covers(
            "src/components/Stats.*",
            "src/components/Hero.css"
        ));
        // A peer owning the glob blocks others with the owner named.
        let s2 = scope(vec![
            ("ic-a", vec!["src/components/Stats.*"]),
            ("ic-b", vec!["src/components/Hero.*"]),
        ]);
        let d = evaluate_write(&s2, "ic-a", "src/components/Hero.css");
        assert!(!d.allowed);
        assert_eq!(d.blocking_owner.as_deref(), Some("ic-b"));
    }

    #[test]
    fn mid_path_globs_and_double_star_work() {
        let s = scope(vec![("ic-a", vec!["src/*/styles", "lib/**/test.ts"])]);
        assert!(evaluate_write(&s, "ic-a", "src/app/styles/main.css").allowed);
        assert!(evaluate_write(&s, "ic-a", "lib/a/b/test.ts").allowed);
        assert!(evaluate_write(&s, "ic-a", "lib/test.ts").allowed);

        // `src/*/styles` matches one segment, then requires `styles` —
        // `src/app/other/...` is outside the glob (open ground, not owned).
        assert!(!path_covers("src/*/styles", "src/app/other/main.css"));
        let s2 = scope(vec![
            ("ic-a", vec!["src/*/styles"]),
            ("ic-b", vec!["src/app/other"]),
        ]);
        assert!(!evaluate_write(&s2, "ic-a", "src/app/other/main.css").allowed);
    }

    #[test]
    fn segment_glob_unit() {
        assert!(segment_matches("Stats.*", "Stats.css"));
        assert!(segment_matches("*.test.ts", "foo.test.ts"));
        assert!(segment_matches("*", "anything"));
        assert!(!segment_matches("Stats.*", "Stat.css"));
        assert!(!segment_matches("Stats.*", "Stats"));
    }
}
