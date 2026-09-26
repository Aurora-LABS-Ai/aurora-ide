//! Reuse extracted syntax only. Import resolution is recomputed for the new tree.
use super::{extract::*, store::{CodeIndex, CombinatorKind}};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

/// Source text for indexing and search. A file saved in a legacy Windows code
/// page (a cp1252 em dash in a comment) is still code: invalid bytes become
/// U+FFFD instead of dropping the file. Line breaks are ASCII, so line numbers
/// stay exact. Every reader of indexed source goes through here, so the
/// content hash agrees between build and search.
pub(super) fn read_source(path: &std::path::Path) -> std::io::Result<String> {
    let bytes = std::fs::read(path)?;
    Ok(match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(error) => String::from_utf8_lossy(error.as_bytes()).into_owned(),
    })
}

pub(super) fn hash(source: &str) -> String {
    format!("{:x}", Sha256::digest(source.as_bytes()))
}

pub(super) fn previous_facts(previous: Option<&CodeIndex>) -> HashMap<String, (String, FileFacts)> {
    let Some(index) = previous else { return HashMap::new(); };
    let mut facts: Vec<FileFacts> = index.files.iter().map(|file| FileFacts {
        library_name: file.library_name.clone(), parts: file.parts.clone(), part_of: file.part_of.clone(),
        had_parse_error: file.had_parse_error, ..Default::default()
    }).collect();
    for s in &index.symbols {
        if let Some(file) = facts.get_mut(s.file as usize) {
            file.symbols.push(RawSymbol { name: s.name.clone(), kind: s.kind.clone(), line: s.line, col: s.col,
                container: s.container.clone(), exported: s.exported, signature: s.signature.clone(), documentation: s.documentation.clone() });
        }
    }
    for r in &index.refs {
        if let Some(file) = facts.get_mut(r.file as usize) {
            file.refs.push(RawRef { name: r.name.clone(), kind: r.kind.clone(), line: r.line, col: r.col,
                from: r.from.clone(), binding: r.binding, receiver: r.receiver.clone(), receiver_type: r.receiver_type.clone(), receiver_is_namespace: r.receiver_is_namespace });
        }
    }
    for i in &index.imports {
        if let Some(file) = facts.get_mut(i.file as usize) {
            file.imports.push(RawImport { local: i.local.clone(), imported: i.imported.clone(), module: i.module.clone(), directive: i.directive,
                reexport: i.reexport, combinators: i.combinators.iter().map(|c| RawImportCombinator {
                    kind: match c.kind { CombinatorKind::Show => RawCombinatorKind::Show, CombinatorKind::Hide => RawCombinatorKind::Hide },
                    names: c.names.clone(), position: c.position
                }).collect() });
        }
    }
    index.files.iter().zip(facts).filter(|(file, _)| !file.content_hash.is_empty())
        .map(|(file, facts)| (file.path.clone(), (file.content_hash.clone(), facts))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reuses_unchanged_files_and_tracks_same_size_edits_renames_and_deletions() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.ts"); let b = dir.path().join("b.ts");
        std::fs::write(&a, "export function alpha() {}\n").unwrap();
        std::fs::write(&b, "import { alpha } from './a'; alpha();\n").unwrap();
        let first = CodeIndex::build(dir.path()).unwrap();
        let packed = super::super::persist::unpack(super::super::persist::pack(&first)).unwrap();
        let same = CodeIndex::build_incremental(dir.path(), Some(&packed), &|_,_,_|{}).unwrap();
        assert_eq!(same.stats.reused_files, 2);
        std::fs::write(&a, "export function bravo() {}\n").unwrap();
        let changed = CodeIndex::build_incremental(dir.path(), Some(&same), &|_,_,_|{}).unwrap();
        assert_eq!(changed.stats.reused_files, 1);
        assert!(changed.symbols.iter().all(|s| s.name != "alpha"));
        std::fs::rename(&a, dir.path().join("renamed.ts")).unwrap();
        std::fs::remove_file(&b).unwrap();
        let last = CodeIndex::build_incremental(dir.path(), Some(&changed), &|_,_,_|{}).unwrap();
        assert_eq!(last.stats.files, 1);
        assert_eq!(last.files[0].path, "renamed.ts");
        assert!(last.refs.is_empty());
    }
}
