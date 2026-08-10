//! Compact on-disk form for a built index.
//!
//! The in-memory [`CodeIndex`](super::store::CodeIndex) stores names as owned
//! `String`s because that is what every query wants. Writing that shape
//! straight to JSON is wasteful: names repeat about 16x across a real
//! workspace, so most of the file is the same few thousand identifiers over and
//! over (measured: 22.9 MB for 6.8 MB of source).
//!
//! This module is the only place that knows about the packed form. Symbols and
//! references become fixed-width rows of `u32` indices into one shared string
//! table, which is both smaller and faster to parse than an array of objects.
//! Nothing outside `save`/`load` ever sees it.

use super::store::{BuildStats, CodeIndex, FileEntry, Import, Reference, Symbol};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Bump when the packed layout changes. A cache written by an older Aurora is
/// discarded and rebuilt rather than misread — the rebuild is sub-second, so
/// there is never a reason to attempt migration.
pub const FORMAT_VERSION: u32 = 4;

/// Sentinel for "no container" / "not inside a function". `u32::MAX` is safe:
/// a workspace with 4 billion distinct identifiers is not a real input.
const NONE: u32 = u32::MAX;

#[derive(Serialize, Deserialize)]
pub struct Packed {
    pub version: u32,
    pub root: PathBuf,
    pub files: Vec<FileEntry>,
    /// Shared vocabulary for symbol names, container names, reference names and
    /// caller names — they overlap heavily, so one table beats four.
    pub names: Vec<String>,
    pub kinds: Vec<String>,
    /// `[name, kind, file, line, col, container, exported]`
    pub symbols: Vec<[u32; 7]>,
    /// `[name, kind, file, line, col, from]`
    pub refs: Vec<[u32; 6]>,
    /// `[file, local, module]`. Module specifiers repeat once per imported
    /// name, so they ride the same table as everything else.
    #[serde(default)]
    pub imports: Vec<[u32; 3]>,
    /// Workspace package name -> directory. A handful of entries at most, so
    /// they are stored plainly rather than interned.
    #[serde(default)]
    pub workspace_packages: Vec<(String, String)>,
    pub stats: BuildStats,
}

/// Assigns a stable id per distinct string, in first-seen order.
#[derive(Default)]
struct Interner {
    ids: HashMap<String, u32>,
    list: Vec<String>,
}

impl Interner {
    fn put(&mut self, s: &str) -> u32 {
        if let Some(&id) = self.ids.get(s) {
            return id;
        }
        let id = self.list.len() as u32;
        self.list.push(s.to_string());
        self.ids.insert(s.to_string(), id);
        id
    }

    fn put_opt(&mut self, s: Option<&String>) -> u32 {
        s.map(|v| self.put(v)).unwrap_or(NONE)
    }
}

fn get(table: &[String], id: u32) -> Result<String> {
    table
        .get(id as usize)
        .cloned()
        .with_context(|| format!("string id {id} out of range"))
}

fn get_opt(table: &[String], id: u32) -> Option<String> {
    if id == NONE {
        None
    } else {
        table.get(id as usize).cloned()
    }
}

pub fn pack(idx: &CodeIndex) -> Packed {
    let mut names = Interner::default();
    let mut kinds = Interner::default();

    let symbols = idx
        .symbols
        .iter()
        .map(|s| {
            [
                names.put(&s.name),
                kinds.put(&s.kind),
                s.file,
                s.line,
                s.col,
                names.put_opt(s.container.as_ref()),
                u32::from(s.exported),
            ]
        })
        .collect();

    let refs = idx
        .refs
        .iter()
        .map(|r| {
            [
                names.put(&r.name),
                kinds.put(&r.kind),
                r.file,
                r.line,
                r.col,
                names.put_opt(r.from.as_ref()),
            ]
        })
        .collect();

    let imports = idx
        .imports
        .iter()
        .map(|i| [i.file, names.put(&i.local), names.put(&i.module)])
        .collect();

    Packed {
        version: FORMAT_VERSION,
        root: idx.root.clone(),
        files: idx.files.clone(),
        names: names.list,
        kinds: kinds.list,
        symbols,
        refs,
        imports,
        workspace_packages: idx.workspace_packages.clone(),
        stats: idx.stats.clone(),
    }
}

pub fn unpack(p: Packed) -> Result<CodeIndex> {
    if p.version != FORMAT_VERSION {
        bail!(
            "code index format v{} (this build reads v{FORMAT_VERSION})",
            p.version
        );
    }
    let symbols = p
        .symbols
        .iter()
        .map(|r| {
            Ok(Symbol {
                name: get(&p.names, r[0])?,
                kind: get(&p.kinds, r[1])?,
                file: r[2],
                line: r[3],
                col: r[4],
                container: get_opt(&p.names, r[5]),
                exported: r[6] != 0,
            })
        })
        .collect::<Result<Vec<_>>>()?;

    let refs = p
        .refs
        .iter()
        .map(|r| {
            Ok(Reference {
                name: get(&p.names, r[0])?,
                kind: get(&p.kinds, r[1])?,
                file: r[2],
                line: r[3],
                col: r[4],
                from: get_opt(&p.names, r[5]),
            })
        })
        .collect::<Result<Vec<_>>>()?;

    let imports = p
        .imports
        .iter()
        .map(|r| {
            Ok(Import {
                file: r[0],
                local: get(&p.names, r[1])?,
                module: get(&p.names, r[2])?,
            })
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(CodeIndex::from_parts(
        p.root,
        p.files,
        symbols,
        refs,
        imports,
        p.workspace_packages,
        p.stats,
    ))
}

pub fn save(idx: &CodeIndex, path: &Path) -> Result<u64> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let bytes = serde_json::to_vec(&pack(idx)).context("serializing code index")?;
    let len = bytes.len() as u64;
    // Write-then-rename so a crash mid-write cannot leave a half-file that
    // every later load has to fail on.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes).with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("replacing {}", path.display()))?;
    Ok(len)
}

pub fn load(path: &Path) -> Result<CodeIndex> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let packed: Packed = serde_json::from_slice(&bytes).context("parsing code index")?;
    unpack(packed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_index() -> (tempfile::TempDir, CodeIndex) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("a.rs"),
            "pub struct Session;\nimpl Session { pub fn append(&self) { flush(); } }\nfn flush() {}\n",
        )
        .unwrap();
        let idx = CodeIndex::build(dir.path()).unwrap();
        (dir, idx)
    }

    #[test]
    fn a_packed_round_trip_preserves_every_answer() {
        let (dir, idx) = fixture_index();
        let path = dir.path().join("idx.json");
        save(&idx, &path).unwrap();
        let back = load(&path).unwrap();

        assert_eq!(back.stats.symbols, idx.stats.symbols);
        assert_eq!(back.stats.refs, idx.stats.refs);
        // Resolved usages must survive the round trip — this is the query that
        // needs the imports table AND the rebuilt lookups, so it fails loudly
        // if either is dropped on the way to disk.
        let before = idx.definitions("append");
        let after = back.definitions("append");
        assert_eq!(
            back.references_to(after[0]).0.len(),
            idx.references_to(before[0]).0.len()
        );
        let d = back.definitions("append");
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].container.as_deref(), Some("Session"));
        // The derived lookups are rebuilt on unpack, not persisted — a load
        // that skipped that step would return empty rather than fail loudly.
        assert!(!back.references("flush").is_empty());
    }

    #[test]
    fn interning_actually_shrinks_the_payload() {
        let (dir, idx) = fixture_index();
        let packed = serde_json::to_vec(&pack(&idx)).unwrap().len();
        let naive = serde_json::to_vec(&idx).unwrap().len();
        assert!(packed < naive, "packed {packed} should beat naive {naive}");
    }

    #[test]
    fn a_cache_from_a_future_format_is_rejected_not_misread() {
        let (dir, idx) = fixture_index();
        let mut p = pack(&idx);
        p.version = FORMAT_VERSION + 1;
        let path = dir.path().join("future.json");
        std::fs::write(&path, serde_json::to_vec(&p).unwrap()).unwrap();
        assert!(load(&path).is_err(), "must refuse an unknown layout");
    }
}
