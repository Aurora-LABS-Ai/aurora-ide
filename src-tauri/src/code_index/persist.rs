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

/// Bump when the packed layout or extraction semantics change. A cache written
/// by an older Aurora is discarded and rebuilt rather than reused with stale
/// facts — the rebuild is sub-second, so there is never a reason to migrate it.
///
/// v10: React components returned by imported `memo` and `forwardRef` wrappers
/// are extracted as functions. A v9 cache still labels them as variables, so it
/// must rebuild before `code usages` can resolve their JSX references.
///
/// v11: JavaScript `require()` is an import edge. A v10 cache of a CommonJS
/// project holds no import rows at all, so `modules` would keep answering
/// `dependencies: 0` from the cache long after the extractor learned to read
/// them — the rebuild is what makes the fix visible.
///
/// v12: Dart/Flutter is indexed. A v11 cache of a Flutter project holds no
/// `.dart` files at all, so every answer about one would keep coming back
/// empty from disk after the grammar was added.
pub const FORMAT_VERSION: u32 = 12;

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
    /// `[name, kind, file, line, col, container, exported, signature, docs]`
    pub symbols: Vec<[u32; 9]>,
    /// `[name, kind, file, line, col, from]`
    pub refs: Vec<[u32; 6]>,
    /// `[file, local, imported, module]`. Module specifiers repeat once per
    /// imported name, so they ride the same table as everything else. Empty
    /// name ids represent module-only dependencies.
    #[serde(default)]
    pub imports: Vec<[u32; 4]>,
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
                names.put_opt(s.signature.as_ref()),
                names.put_opt(s.documentation.as_ref()),
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
        .map(|i| {
            [
                i.file,
                names.put(&i.local),
                names.put(&i.imported),
                names.put(&i.module),
            ]
        })
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
                signature: get_opt(&p.names, r[7]),
                documentation: get_opt(&p.names, r[8]),
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
                imported: get(&p.names, r[2])?,
                module: get(&p.names, r[3])?,
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

/// Caches kept after a build, newest first.
///
/// Generous on purpose. A cache is one project, it costs a sub-second rebuild
/// to lose, and mtime records when it was BUILT rather than when it was last
/// opened — so a project you read from every day but never edit keeps an old
/// timestamp. A tight cap would collect exactly that project. Twenty-four is
/// past any plausible set of live workspaces, which leaves this rule doing the
/// one job it is for: stopping the directory growing without bound.
pub const KEEP_CACHES: usize = 24;

/// Bytes read from a cache to learn its format version.
///
/// `version` is the first field [`Packed`] declares, so it lands within the
/// first handful of bytes and the whole file never has to be parsed — the
/// largest of these is 31 MB and there can be dozens. Pinned by
/// `the_version_is_readable_without_parsing_the_whole_file`.
const VERSION_PROBE_BYTES: usize = 64;

/// The format version a cache was written with, without parsing it.
///
/// `None` when the file cannot be read or does not announce one in its head.
/// That answer is deliberately NOT "delete it": an unrecognised file in this
/// directory is something this code does not understand, and guessing wrong
/// destroys data to save bytes.
fn cached_version(path: &Path) -> Option<u32> {
    use std::io::Read;

    let mut file = std::fs::File::open(path).ok()?;
    let mut head = [0u8; VERSION_PROBE_BYTES];
    let read = file.read(&mut head).ok()?;
    // Lossy: a path stored later in the file may be cut mid-character, and the
    // version is ASCII well before that point.
    let text = String::from_utf8_lossy(&head[..read]);
    let at = text.find("\"version\":")? + "\"version\":".len();
    let digits: String = text[at..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

/// Sweep the cache directory after a build.
///
/// Nothing did this before, and nothing else ever would: caches are written per
/// project and never revisited, so a directory inspected on 2026-08-31 held 34
/// files and 190 MB, fifteen of them in formats from v4 to v9 that no build has
/// been able to read for weeks. A cache whose version is not the current one is
/// not stale data — it is unreachable data, since [`unpack`] refuses it and the
/// project rebuilds from source instead.
///
/// Two rules, in order:
///
/// 1. **Wrong format → delete.** It can never be adopted again.
/// 2. **Past [`KEEP_CACHES`] → delete the oldest.** The bound that keeps a
///    machine which opens hundreds of projects from keeping all of them.
///
/// Runs after the write, so the cache just saved is the newest and always
/// survives. Best-effort and silent throughout: a directory that cannot be
/// swept is not a reason to fail a build that already succeeded.
pub fn prune(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut live: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        match cached_version(&path) {
            Some(version) if version != FORMAT_VERSION => {
                let _ = std::fs::remove_file(&path);
            }
            Some(_) => {
                if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
                    live.push((modified, path));
                }
            }
            // Not ours, or unreadable. Left alone — see `cached_version`.
            None => {}
        }
    }

    if live.len() <= keep {
        return;
    }
    // Newest first, then drop everything past the keep count.
    live.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in live.into_iter().skip(keep) {
        let _ = std::fs::remove_file(path);
    }
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
            "pub struct Session;\nimpl Session {\n/// Appends one entry.\npub fn append(&self) { flush(); }\n}\nfn flush() {}\n",
        )
        .unwrap();
        let idx = CodeIndex::build(dir.path()).unwrap();
        (dir, idx)
    }

    /// `prune` reads the version out of the file's first bytes instead of
    /// parsing it — the biggest of these is 31 MB and a sweep touches every
    /// one. That only holds while `version` is the first field `Packed`
    /// declares, which a field reorder would silently break: the sweep would
    /// then find no version anywhere, treat every cache as unrecognised, and
    /// quietly stop reclaiming anything.
    #[test]
    fn the_version_is_readable_without_parsing_the_whole_file() {
        let (dir, idx) = fixture_index();
        let path = dir.path().join("idx.json");
        save(&idx, &path).unwrap();

        assert_eq!(
            cached_version(&path),
            Some(FORMAT_VERSION),
            "the version must sit inside the first {VERSION_PROBE_BYTES} bytes"
        );
    }

    /// A cache in an old format is not stale data, it is unreachable data:
    /// `unpack` refuses it and the project rebuilds from source. Nothing swept
    /// them, so a real machine held 34 caches and 190 MB with fifteen of them
    /// in formats from v4 to v9 (2026-08-31).
    #[test]
    fn a_cache_this_build_cannot_read_is_collected() {
        let (dir, idx) = fixture_index();
        let cache_dir = dir.path().join("cache");
        std::fs::create_dir_all(&cache_dir).unwrap();

        let current = cache_dir.join("current.json");
        save(&idx, &current).unwrap();

        // An older Aurora's cache, byte-for-byte as one is written.
        let mut old = pack(&idx);
        old.version = FORMAT_VERSION - 1;
        let stale = cache_dir.join("stale.json");
        std::fs::write(&stale, serde_json::to_vec(&old).unwrap()).unwrap();

        // Something else entirely. Deleting this would be destroying a file
        // nobody in this module understands.
        let foreign = cache_dir.join("notes.json");
        std::fs::write(&foreign, b"{\"hello\":true}").unwrap();

        prune(&cache_dir, KEEP_CACHES);

        assert!(!stale.exists(), "an unreadable format must be reclaimed");
        assert!(current.exists(), "the current cache must survive");
        assert!(foreign.exists(), "an unrecognised file must be left alone");
    }

    /// The bound itself, on caches this build CAN read. Oldest go first, and
    /// the one just written is the newest, so a build can never collect the
    /// cache it just saved.
    #[test]
    fn past_the_cap_the_oldest_caches_go_first() {
        let (dir, idx) = fixture_index();
        let cache_dir = dir.path().join("cache");
        std::fs::create_dir_all(&cache_dir).unwrap();

        // Written oldest-first, with a real pause: the sweep orders by mtime,
        // and a filesystem whose timestamps land in the same tick would make
        // the assertion below meaningless rather than wrong.
        let mut written = Vec::new();
        for n in 0..4 {
            let path = cache_dir.join(format!("cache-{n}.json"));
            save(&idx, &path).unwrap();
            written.push(path);
            std::thread::sleep(std::time::Duration::from_millis(20));
        }

        prune(&cache_dir, 2);

        assert!(!written[0].exists(), "oldest collected: {written:?}");
        assert!(!written[1].exists(), "second oldest collected: {written:?}");
        assert!(written[2].exists(), "newest two kept: {written:?}");
        assert!(written[3].exists(), "the freshest write always survives");
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
        assert_eq!(d[0].signature.as_deref(), Some("pub fn append(&self)"));
        assert_eq!(d[0].documentation.as_deref(), Some("Appends one entry."));
        // The derived lookups are rebuilt on unpack, not persisted — a load
        // that skipped that step would return empty rather than fail loudly.
        assert!(!back.references("flush").is_empty());
    }

    #[test]
    fn interning_actually_shrinks_the_payload() {
        let (_dir, idx) = fixture_index();
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

    /// Measurement harness for the cache cost of signatures and docs.
    ///
    /// `AURORA_INDEX_ROOT=<repo> cargo test --lib \
    /// metadata_cost_over_a_real_workspace -- --ignored --nocapture`
    #[test]
    #[ignore = "needs AURORA_INDEX_ROOT pointing at a real workspace"]
    fn metadata_cost_over_a_real_workspace() {
        let root = std::env::var("AURORA_INDEX_ROOT").expect("set AURORA_INDEX_ROOT");
        let idx = CodeIndex::build(Path::new(&root)).expect("index builds");
        let full = serde_json::to_vec(&pack(&idx)).unwrap().len();
        let signatures = idx
            .symbols
            .iter()
            .filter(|symbol| symbol.signature.is_some())
            .count();
        let documented = idx
            .symbols
            .iter()
            .filter(|symbol| symbol.documentation.is_some())
            .count();

        let mut without_metadata = idx;
        for symbol in &mut without_metadata.symbols {
            symbol.signature = None;
            symbol.documentation = None;
        }
        let base = serde_json::to_vec(&pack(&without_metadata)).unwrap().len();
        let added = full.saturating_sub(base);
        println!(
            "metadata: {signatures} signatures, {documented} docs, {added} added bytes; \
             packed {base} -> {full} bytes ({:.1}% growth); build {} ms",
            added as f64 * 100.0 / base.max(1) as f64,
            without_metadata.stats.build_ms,
        );
    }
}
