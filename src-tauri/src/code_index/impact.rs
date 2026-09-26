//! Edit-impact — what the rest of the workspace holds onto in a just-edited
//! file.
//!
//! The agent's most expensive class of mistake is editing a definition and
//! never checking its call sites: the edit succeeds, the tool result says so,
//! and the break surfaces two turns later in `read_lints` — or ships. The
//! index already knows every cross-file reference, so a successful
//! `file_edit`/`file_write` can carry one sentence naming the symbols other
//! files depend on, at the exact moment the model decides what to do next.
//! This is the "usages-warning before edits" item the handoff doc lists as
//! cheap-but-unbuilt, delivered as a result field rather than a new tool so
//! it costs zero schema tokens.
//!
//! Two rules keep it honest and cheap:
//!
//! - **Never build or walk.** The note reads whatever index is already warm in
//!   memory ([`service::CodeIndexService::peek`]) and says nothing otherwise.
//!   An edit must not pay for indexing; the pre-edit state is also exactly the
//!   right data — impact is about the callers that existed when the edit
//!   landed.
//! - **Silence over guesses.** A file the index has never seen (new file,
//!   unindexed language) gets no note. References that resolve only as
//!   ambiguous are already excluded by [`store::CodeIndex::references_to`],
//!   for the reason recorded there: a list mixing proven and guessed callers
//!   reads as proven.

use super::store::CodeIndex;
use std::collections::HashMap;
use std::path::Path;

/// A file defining more symbols than this gets no note. At that scale the
/// note would either name a meaningless fraction or cost real time — and such
/// files (generated bundles, giant test fixtures) are precisely the ones whose
/// symbols nobody edits one at a time.
const MAX_SYMBOLS_EXAMINED: usize = 300;

/// Symbols named individually; the rest collapse into a "+N more" count.
const MAX_NAMED: usize = 3;

/// Lowercased, forward-slashed form of a path for comparison. The index stores
/// workspace-relative forward-slashed paths; the tools hand us absolute OS
/// paths whose casing Windows does not guarantee.
fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/").to_lowercase()
}

/// One symbol's cross-file footprint, in the `usages` op's own accounting.
#[derive(Clone, Copy)]
struct Impact {
    /// Non-import references in other files — call/use sites to re-check.
    uses: usize,
    /// Distinct files those uses sit in.
    files: usize,
    /// Files that import the symbol but show no attributable use — still
    /// dependents (the op's `importedByFiles`), never folded into `uses`.
    imported_by: usize,
}

impl Impact {
    /// Ordering key: total dependent files first, then use count.
    fn rank(&self) -> (usize, usize) {
        (self.files + self.imported_by, self.uses)
    }
}

impl std::fmt::Display for Impact {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = |n: usize| if n == 1 { "" } else { "s" };
        if self.uses == 0 {
            return write!(
                f,
                "imported by {} file{}",
                self.imported_by,
                s(self.imported_by)
            );
        }
        write!(
            f,
            "{} use{} in {} file{}",
            self.uses,
            s(self.uses),
            self.files,
            s(self.files)
        )?;
        if self.imported_by > 0 {
            write!(
                f,
                ", imported by {} more file{}",
                self.imported_by,
                s(self.imported_by)
            )?;
        }
        Ok(())
    }
}

/// The impact note for `edited_abs`, or `None` when there is nothing worth
/// saying: no warm index, an unknown file, or no cross-file references.
pub fn edit_impact_note(workspace_root: &Path, edited_abs: &str) -> Option<String> {
    let idx = super::service::service().peek(workspace_root)?;
    note_for_file(&idx, workspace_root, Path::new(edited_abs))
}

/// The pure computation, separated so tests can feed a locally built index
/// instead of going through the process-global service (whose default cache
/// directory is the user's real AppData — see the 2026-08-09 lesson).
pub fn note_for_file(idx: &CodeIndex, workspace_root: &Path, edited_abs: &Path) -> Option<String> {
    let root = norm(workspace_root);
    let full = norm(edited_abs);
    let rel = full
        .strip_prefix(root.trim_end_matches('/'))?
        .trim_start_matches('/');
    let file_id = idx
        .files
        .iter()
        .position(|f| f.path.to_lowercase() == rel)? as u32;

    // Exported symbols only. A non-exported local CAN still collect cross-file
    // references through name resolution — measured on this repository: a
    // component-local `add` was credited with every `Set.add()` in three other
    // files, because it was the only DEFINITION of the name and syntax-only
    // resolution cannot see receivers. Another file cannot legitimately use a
    // local, so `exported` is the filter that keeps every true entry and drops
    // that whole false class.
    // No kind filter beyond that: an exported `variable` is a real API surface
    // in TS (`export const useX = create(...)` — hooks and configs), and its
    // cross-file IMPORT references still resolve even though call-site
    // references skip non-callable targets.
    let symbols: Vec<_> = idx
        .symbols
        .iter()
        .filter(|s| s.file == file_id && s.exported)
        .collect();
    if symbols.is_empty() || symbols.len() > MAX_SYMBOLS_EXAMINED {
        return None;
    }

    // Aggregated per NAME: two same-named definitions in one file (an impl
    // block and its trait, overloads) resolve to the same reference set, and
    // naming the symbol twice would read as double the impact.
    //
    // The accounting is the `usages` op's, exactly — the first harness run
    // filed a defect because this note said "5 references" where the op said
    // 3, and it was right to: the two surfaces described one symbol with two
    // numbers. USES are non-import references (an import line is not a call
    // site to re-check); files whose ONLY evidence is their import are still
    // real dependents (a hook consumed as `useX(...)` has unattributable call
    // sites), so they are reported the way the op reports them — as a
    // separate imported-by count, never folded into the use count.
    let mut per_name: HashMap<&str, Impact> = HashMap::new();
    for symbol in symbols {
        let (refs, _unresolved) = idx.references_to(symbol);
        let mut use_files: Vec<u32> = Vec::new();
        let mut import_files: Vec<u32> = Vec::new();
        let mut uses = 0usize;
        for r in refs {
            if r.file == file_id {
                continue;
            }
            if r.kind == "import" {
                import_files.push(r.file);
            } else {
                uses += 1;
                use_files.push(r.file);
            }
        }
        use_files.sort_unstable();
        use_files.dedup();
        import_files.sort_unstable();
        import_files.dedup();
        let import_only = import_files
            .iter()
            .filter(|f| !use_files.contains(f))
            .count();
        if uses == 0 && import_only == 0 {
            continue;
        }
        let candidate = Impact {
            uses,
            files: use_files.len(),
            imported_by: import_only,
        };
        let entry = per_name.entry(symbol.name.as_str()).or_insert(candidate);
        if candidate.rank() > entry.rank() {
            *entry = candidate;
        }
    }
    if per_name.is_empty() {
        return None;
    }

    let mut ranked: Vec<(&str, Impact)> = per_name.into_iter().collect();
    ranked.sort_by(|a, b| b.1.rank().cmp(&a.1.rank()).then(a.0.cmp(b.0)));

    let named: Vec<String> = ranked
        .iter()
        .take(MAX_NAMED)
        .map(|(name, im)| format!("{name} ({im})"))
        .collect();
    let more = ranked.len().saturating_sub(MAX_NAMED);
    let tail = if more > 0 {
        format!(
            " and {more} more symbol{}",
            if more == 1 { "" } else { "s" }
        )
    } else {
        String::new()
    };

    Some(format!(
        "Other files use what this file defines (as last indexed): {}{tail}. \
         If a signature or behavior changed, re-check those call sites \
         (code op:\"usages\" lists them).",
        named.join(", "),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build(dir: &Path) -> CodeIndex {
        CodeIndex::build(dir).expect("index builds")
    }

    #[test]
    fn names_the_symbols_other_files_depend_on() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("core.rs"),
            "pub fn core_helper() {}\npub fn local_only() {}\nfn private_use() { local_only(); }\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("caller.rs"),
            "use crate::core::core_helper;\npub fn go() { core_helper(); core_helper(); }\n",
        )
        .unwrap();
        let idx = build(dir.path());

        let note = note_for_file(&idx, dir.path(), &dir.path().join("core.rs"))
            .expect("core.rs has an outside caller");
        assert!(
            note.contains("core_helper"),
            "note must name the symbol: {note}"
        );
        assert!(note.contains("1 file"), "one consuming file: {note}");
        assert!(
            !note.contains("local_only"),
            "a symbol used only inside its own file is not impact: {note}"
        );
    }

    #[test]
    fn edit_impact_never_carries_signature_or_documentation_text() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("core.rs"),
            "/// A deliberately recognizable documentation sentence.\npub fn process(value: usize) -> usize { value + 1 }\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("caller.rs"),
            "use crate::core::process;\npub fn call_it() { let _ = process(1); }\n",
        )
        .unwrap();
        let idx = build(dir.path());

        let note = note_for_file(&idx, dir.path(), &dir.path().join("core.rs"))
            .expect("the exported function has one caller");
        assert!(note.contains("process (1 use in 1 file)"), "{note}");
        assert!(!note.contains("pub fn"), "signature leaked into: {note}");
        assert!(
            !note.contains("recognizable documentation"),
            "documentation leaked into: {note}"
        );
        assert!(
            note.contains("code op:\"usages\""),
            "the compact note must point to the detailed lookup: {note}"
        );
    }

    #[test]
    fn an_import_statement_is_not_counted_as_a_use() {
        // The first harness run's FAIL: a TS file importing `formatPrice` and
        // calling it 3 times was reported as "5 references" because the two
        // import lines counted too — while `code op:"usages"` said 3. The note
        // and the op must share ONE accounting: call/use sites only.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("core.ts"),
            "export function formatPrice(cents: number): string { return `${cents}`; }\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("checkout.ts"),
            "import { formatPrice } from \"./core\";\nconst a = formatPrice(1);\nconst b = formatPrice(2);\n",
        )
        .unwrap();
        let idx = build(dir.path());

        let note = note_for_file(&idx, dir.path(), &dir.path().join("core.ts"))
            .expect("core.ts has outside users");
        assert!(
            note.contains("formatPrice (2 uses in 1 file)"),
            "the import line must not inflate the count: {note}"
        );
    }

    #[test]
    fn a_file_that_only_imports_still_counts_as_a_dependent() {
        // The other direction of the same accounting: a hook consumed as
        // `useX(...)` has call sites resolution cannot attribute to a
        // variable-kind target, so its consumers' only visible evidence is
        // their import. Dropping them hid 31 of useSettingsStore's 44
        // dependent files on the real repo. They ride as "imported by",
        // exactly the op's `importedByFiles`, never folded into the uses.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("core.ts"),
            "export const useStore = makeStore();\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("panel.ts"),
            "import { useStore } from \"./core\";\nconst v = useStore((s: any) => s.v);\n",
        )
        .unwrap();
        let idx = build(dir.path());

        let note = note_for_file(&idx, dir.path(), &dir.path().join("core.ts"))
            .expect("an imported symbol is impact");
        assert!(
            note.contains("useStore") && note.contains("imported by 1 file"),
            "import-only dependents must be reported, separately: {note}"
        );
        assert!(
            !note.contains("uses in"),
            "an unattributable call must not be presented as a counted use: {note}"
        );
    }

    #[test]
    fn a_non_exported_local_is_never_credited_with_other_files_method_calls() {
        // The false positive the real-workspace run caught: `fn add` (not pub)
        // was the only definition of the name, so `set.add(...)` calls in other
        // files resolved to it. The note must stay silent about locals.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("core.rs"), "fn add() {}\n").unwrap();
        std::fs::write(
            dir.path().join("caller.rs"),
            "pub fn go(items: &mut Vec<u32>) { items.add(1); }\n",
        )
        .unwrap();
        let idx = build(dir.path());
        assert!(
            note_for_file(&idx, dir.path(), &dir.path().join("core.rs")).is_none(),
            "a non-exported symbol must not be reported as cross-file impact"
        );
    }

    #[test]
    fn a_file_nothing_else_uses_gets_no_note() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("core.rs"), "pub fn core_helper() {}\n").unwrap();
        std::fs::write(
            dir.path().join("caller.rs"),
            "use crate::core::core_helper;\npub fn go() { core_helper(); }\n",
        )
        .unwrap();
        let idx = build(dir.path());
        assert!(
            note_for_file(&idx, dir.path(), &dir.path().join("caller.rs")).is_none(),
            "caller.rs defines nothing another file references"
        );
    }

    #[test]
    fn a_file_the_index_never_saw_gets_no_note() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("core.rs"), "pub fn core_helper() {}\n").unwrap();
        let idx = build(dir.path());
        assert!(note_for_file(&idx, dir.path(), &dir.path().join("brand_new.rs")).is_none());
        assert!(
            note_for_file(
                &idx,
                Path::new("E:/somewhere/else"),
                &dir.path().join("core.rs")
            )
            .is_none(),
            "a file outside the indexed root cannot be answered for"
        );
    }

    /// Measurement harness, not a CI test — same pattern as
    /// `repo_map_over_a_real_workspace`. Prints the impact note (and how long
    /// it took) for one or more real files, so wording and cost are judged
    /// against a real repository rather than a fixture:
    ///
    /// ```text
    /// AURORA_INDEX_ROOT=E:/some/repo AURORA_IMPACT_FILE=src/lib.rs,src/other.rs \
    ///   cargo test --lib impact_over_a_real_workspace -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "needs AURORA_INDEX_ROOT and AURORA_IMPACT_FILE pointing at a real workspace"]
    fn impact_over_a_real_workspace() {
        let root = std::env::var("AURORA_INDEX_ROOT").expect("set AURORA_INDEX_ROOT");
        let files = std::env::var("AURORA_IMPACT_FILE").expect("set AURORA_IMPACT_FILE");
        let root = Path::new(&root);
        let idx = CodeIndex::build(root).unwrap();
        for rel in files.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            let abs = root.join(rel);
            let started = std::time::Instant::now();
            let note = note_for_file(&idx, root, &abs);
            let took = started.elapsed();
            println!("== {rel} ({took:?}) ==");
            println!("{}", note.unwrap_or_else(|| "(no note)".into()));
            // A "(no note)" is only diagnosable with the raw facts: what the
            // extractor recorded for this file, exported flags included.
            if let Some(id) = idx
                .files
                .iter()
                .position(|f| f.path.eq_ignore_ascii_case(rel))
            {
                for s in idx.symbols.iter().filter(|s| s.file == id as u32) {
                    println!(
                        "   symbol {} kind={} exported={} line={}",
                        s.name, s.kind, s.exported, s.line
                    );
                }
            }
            println!();
        }
    }

    #[test]
    fn windows_casing_and_separators_do_not_hide_the_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("core.rs"), "pub fn core_helper() {}\n").unwrap();
        std::fs::write(
            dir.path().join("caller.rs"),
            "use crate::core::core_helper;\npub fn go() { core_helper(); }\n",
        )
        .unwrap();
        let idx = build(dir.path());

        // The tools hand over OS-native absolute paths; on Windows those use
        // backslashes and arbitrary drive casing.
        let native = dir.path().join("core.rs").to_string_lossy().to_uppercase();
        let note = note_for_file(&idx, dir.path(), Path::new(&native));
        assert!(
            note.is_some(),
            "case/separator differences must not lose the match"
        );
    }
}
