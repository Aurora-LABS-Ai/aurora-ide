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

use super::store::{
    BuildStats, CodeIndex, CombinatorKind, FileEntry, Import, ImportCombinator, LibraryPart,
    Reference, Symbol,
};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Bump when the packed layout or extraction semantics change. A cache written
/// by an older Aurora is discarded and rebuilt rather than reused with stale
/// facts. The previous cache stays on disk until a replacement is complete.
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
///
/// v13: ordered Dart import combinators, re-export identity, and Dart library
/// part membership are persisted. A v12 cache can misattribute hidden names,
/// stop at barrel files, and treat a multi-file library as separate modules.
///
/// v14: a Go member's `container` is its type's NAME. A v13 cache stores the
/// type's whole SOURCE there — `struct { … }::db`, once per field — so an
/// already-indexed Go workspace would keep serving pages of repeated struct
/// bodies from disk however the extractor now behaves. The rebuild is the fix
/// becoming visible.
/// v15–v17: content and configuration fingerprints, receiver/local binding
/// evidence, per-file content hashes, and Dart directives. These landed
/// together while the local index was being rebuilt, so the three numbers
/// describe one change rather than three shipped formats. A v14 cache holds
/// neither the evidence that resolution now needs nor the hashes that let an
/// unchanged file skip re-parsing.
///
/// v18: TypeScript members whose names are not bare identifiers — `'@removed'`,
/// `'@odata.nextLink'`, `#hits` — are extracted. A v17 cache of a file that
/// declares them holds no rows for those members at all, so `outline`,
/// `definition` and `search` would keep answering from disk as though the
/// declarations did not exist. Because an unchanged file reuses its stored
/// extraction facts, editing the file is not enough to recover them; the
/// format bump is what forces the re-parse that makes the fix visible.
pub const FORMAT_VERSION: u32 = 18;

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
    /// `[name, kind, file, line, col, from, binding_line, binding_col, receiver, receiver_type, receiver_is_namespace]`
    pub refs: Vec<[u32; 11]>,
    /// Import/re-export facts. Module specifiers and combinator names ride the
    /// shared table; empty local/imported ids represent module-only edges.
    #[serde(default)]
    pub imports: Vec<PackedImport>,
    /// `[library, part]` Dart library membership.
    #[serde(default)]
    pub library_parts: Vec<[u32; 2]>,
    /// Workspace package name -> directory. A handful of entries at most, so
    /// they are stored plainly rather than interned.
    #[serde(default)]
    pub workspace_packages: Vec<(String, String)>,
    pub stats: BuildStats,
}

#[derive(Serialize, Deserialize)]
pub struct PackedImport {
    /// `[file, local, imported, module, directive, reexport]`.
    pub row: [u32; 6],
    pub combinators: Vec<PackedCombinator>,
}

#[derive(Serialize, Deserialize)]
pub struct PackedCombinator {
    /// `0 = show`, `1 = hide`.
    pub kind: u32,
    pub position: u32,
    pub names: Vec<u32>,
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
                r.binding.map(|value| value.0).unwrap_or(NONE),
                r.binding.map(|value| value.1).unwrap_or(NONE),
                names.put_opt(r.receiver.as_ref()),
                names.put_opt(r.receiver_type.as_ref()),
                u32::from(r.receiver_is_namespace),
            ]
        })
        .collect();

    let imports = idx
        .imports
        .iter()
        .map(|import| {
            let combinators = import
                .combinators
                .iter()
                .map(|combinator| PackedCombinator {
                    kind: match combinator.kind {
                        CombinatorKind::Show => 0,
                        CombinatorKind::Hide => 1,
                    },
                    position: combinator.position,
                    names: combinator
                        .names
                        .iter()
                        .map(|name| names.put(name))
                        .collect(),
                })
                .collect();
            PackedImport {
                row: [
                    import.file,
                    names.put(&import.local),
                    names.put(&import.imported),
                    names.put(&import.module),
                    import.directive,
                    u32::from(import.reexport),
                ],
                combinators,
            }
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
        library_parts: idx
            .library_parts
            .iter()
            .map(|relation| [relation.library, relation.part])
            .collect(),
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
                binding: (r[6] != NONE && r[7] != NONE).then_some((r[6], r[7])),
                receiver: get_opt(&p.names, r[8]),
                receiver_type: get_opt(&p.names, r[9]),
                receiver_is_namespace: r[10] != 0,
            })
        })
        .collect::<Result<Vec<_>>>()?;

    let imports = p
        .imports
        .iter()
        .map(|packed| {
            let row = packed.row;
            let combinators = packed
                .combinators
                .iter()
                .map(|combinator| {
                    let kind = match combinator.kind {
                        0 => CombinatorKind::Show,
                        1 => CombinatorKind::Hide,
                        other => bail!("unknown import combinator kind {other}"),
                    };
                    let names = combinator
                        .names
                        .iter()
                        .map(|id| get(&p.names, *id))
                        .collect::<Result<Vec<_>>>()?;
                    Ok(ImportCombinator {
                        kind,
                        names,
                        position: combinator.position,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(Import {
                file: row[0],
                local: get(&p.names, row[1])?,
                imported: get(&p.names, row[2])?,
                module: get(&p.names, row[3])?,
                directive: row[4],
                reexport: row[5] != 0,
                combinators,
            })
        })
        .collect::<Result<Vec<_>>>()?;

    let library_parts = p
        .library_parts
        .iter()
        .map(|row| LibraryPart {
            library: row[0],
            part: row[1],
        })
        .collect();

    Ok(CodeIndex::from_parts(
        p.root,
        p.files,
        symbols,
        refs,
        imports,
        library_parts,
        p.workspace_packages,
        p.stats,
    ))
}

pub fn save(idx: &CodeIndex, path: &Path) -> Result<u64> {
    let bytes = serde_json::to_vec(&pack(idx)).context("serializing code index")?;
    let len = bytes.len() as u64;
    atomic_write(path, &bytes)?;
    Ok(len)
}

/// Publish a complete file in one rename. A failed write never removes the
/// previous file, and separate writers cannot share a temporary pathname.
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let parent = path
        .parent()
        .context("index file has no parent directory")?;
    std::fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
    let tmp = parent.join(format!(".index-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .with_context(|| format!("creating {}", tmp.display()))?;
        file.write_all(bytes)
            .context("writing index temporary file")?;
        file.sync_all().context("syncing index temporary file")?;
        drop(file);
        std::fs::rename(&tmp, path).with_context(|| format!("replacing {}", path.display()))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// The format a cache file claims, read from its head without parsing it.
///
/// `version` is [`Packed`]'s first field, so it is the first thing in the
/// serialized object — pinned by `the_version_is_the_first_thing_written`,
/// because this is worthless if it ever moves. Reading it costs a few bytes
/// where deserializing the whole document to reach the same number costs a
/// scan of every row (a real cache is hundreds of KB, the largest measured is
/// 31 MB).
fn claimed_version(head: &[u8]) -> Option<u32> {
    let text = std::str::from_utf8(head).ok()?;
    let rest = text.split_once("\"version\"")?.1;
    let digits: String = rest
        .trim_start()
        .strip_prefix(':')?
        .trim_start()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

pub fn load(path: &Path) -> Result<CodeIndex> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    // The format is checked BEFORE the rows are deserialized, and this is not
    // belt-and-braces over the check in `unpack`: a bump that changes a row's
    // WIDTH makes `Packed` itself unreadable, so `unpack` is never reached and
    // its version message never runs. Measured on a real v14 cache read by a
    // v18 build: `invalid length 6, expected an array of length 11`, which
    // names neither the format nor the fix. The stale-cache path is the one
    // path a user meets, so it is the one that has to explain itself.
    if let Some(version) = claimed_version(&bytes[..bytes.len().min(64)]) {
        if version != FORMAT_VERSION {
            bail!("code index format v{version} (this build reads v{FORMAT_VERSION})");
        }
    }
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

    #[test]
    fn receiver_and_binding_evidence_survives_persistence() {
        let (dir, mut index) = fixture_index();
        let reference = index.refs.first_mut().unwrap();
        reference.binding = Some((17, 3));
        reference.receiver = Some("service".to_string());
        reference.receiver_type = Some("Session".to_string());
        reference.receiver_is_namespace = true;
        let path = dir.path().join("structural.json");
        save(&index, &path).unwrap();
        let read = load(&path).unwrap();
        assert_eq!(read.refs[0].binding, Some((17, 3)));
        assert_eq!(read.refs[0].receiver.as_deref(), Some("service"));
        assert_eq!(read.refs[0].receiver_type.as_deref(), Some("Session"));
        assert!(read.refs[0].receiver_is_namespace);
    }

    #[test]
    fn simultaneous_writes_publish_complete_files_and_leave_no_temporary_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("build.json");
        let barrier = std::sync::Barrier::new(4);
        std::thread::scope(|scope| {
            let jobs: Vec<_> = (0..4)
                .map(|n| {
                    let path = &path;
                    let barrier = &barrier;
                    scope.spawn(move || {
                        let bytes = vec![b'0' + n; 256 * 1024];
                        barrier.wait();
                        atomic_write(path, &bytes).unwrap();
                    })
                })
                .collect();
            for job in jobs {
                job.join().unwrap();
            }
        });
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(bytes.len(), 256 * 1024);
        assert!(bytes.iter().all(|byte| *byte == bytes[0]));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn rejected_publish_does_not_remove_the_existing_destination() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("structural.json");
        std::fs::create_dir(&destination).unwrap();
        std::fs::write(destination.join("keep"), "previous data").unwrap();
        assert!(atomic_write(&destination, b"new data").is_err());
        assert_eq!(
            std::fs::read_to_string(destination.join("keep")).unwrap(),
            "previous data"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
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
    fn dart_namespace_and_part_semantics_survive_the_cache() {
        let dir = tempfile::tempdir().unwrap();
        for (path, source) in [
            (
                "lib/library.dart",
                "library cached.parts;\npart 'model.dart';\n",
            ),
            (
                "lib/model.dart",
                "part of cached.parts;\nclass Post {}\nclass Hidden {}\n",
            ),
            ("other/model.dart", "class Post {}\nclass Hidden {}\n"),
            (
                "app/use.dart",
                "import '../lib/library.dart' show Post, Hidden hide Hidden;\nPost? post;\nHidden? hidden;\n",
            ),
        ] {
            let file = dir.path().join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, source).unwrap();
        }
        let before = CodeIndex::build(dir.path()).unwrap();
        let cache = dir.path().join("index.json");
        save(&before, &cache).unwrap();
        let after = load(&cache).unwrap();

        assert_eq!(after.library_parts, before.library_parts);
        assert_eq!(after.imports.len(), before.imports.len());
        let caller = after
            .files
            .iter()
            .position(|file| file.path == "app/use.dart")
            .unwrap() as u32;
        let (posts, confidence) = after.resolve("Post", caller);
        assert_eq!(confidence, super::super::store::Confidence::Import);
        assert_eq!(posts.len(), 1, "{posts:?}");
        assert_eq!(after.file_path(posts[0].file), "lib/model.dart");

        let (_, hidden_confidence) = after.resolve("Hidden", caller);
        assert_eq!(
            hidden_confidence,
            super::super::store::Confidence::Ambiguous,
            "the cached hide combinator must still refuse a guess"
        );
    }

    #[test]
    fn a_named_reexport_alias_survives_the_cache() {
        let dir = tempfile::tempdir().unwrap();
        for (path, source) in [
            ("model.ts", "export class Post {}\nexport class Hidden {}\n"),
            (
                "public.ts",
                "export { Post as PublicPost } from './model';\n",
            ),
            (
                "app.ts",
                "import { PublicPost } from './public';\nconst post: PublicPost | null = null;\n",
            ),
        ] {
            std::fs::write(dir.path().join(path), source).unwrap();
        }
        let before = CodeIndex::build(dir.path()).unwrap();
        let cache = dir.path().join("index.json");
        save(&before, &cache).unwrap();
        let after = load(&cache).unwrap();
        let caller = after
            .files
            .iter()
            .position(|file| file.path == "app.ts")
            .unwrap() as u32;

        let (public, confidence) = after.resolve("PublicPost", caller);
        assert_eq!(confidence, super::super::store::Confidence::Import);
        assert_eq!(public.len(), 1, "{public:?}");
        assert_eq!(public[0].name, "Post");
        assert_eq!(after.file_path(public[0].file), "model.ts");

        let (hidden, _) = after.resolve("Hidden", caller);
        assert!(
            hidden.is_empty(),
            "the cached named export must stay restricted: {hidden:?}"
        );
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

    /// `claimed_version` reads the head of the file instead of the document,
    /// which only works while `version` is written first.
    #[test]
    fn the_version_is_the_first_thing_written() {
        let (_dir, idx) = fixture_index();
        let bytes = serde_json::to_vec(&pack(&idx)).unwrap();
        assert!(
            bytes.starts_with(format!("{{\"version\":{FORMAT_VERSION}").as_bytes()),
            "version must stay Packed's first field: {}",
            String::from_utf8_lossy(&bytes[..40.min(bytes.len())])
        );
        assert_eq!(
            claimed_version(&bytes[..64.min(bytes.len())]),
            Some(FORMAT_VERSION)
        );
    }

    /// An older format whose ROW WIDTHS differ cannot reach the check inside
    /// `unpack`, because `Packed` itself fails to deserialize first. Measured
    /// on the owner's real v14 cache read by a v18 build: `invalid length 6,
    /// expected an array of length 11` — a message that names neither the
    /// format nor the one thing that fixes it.
    #[test]
    fn an_old_format_with_narrower_rows_names_the_format_not_the_row() {
        let (dir, idx) = fixture_index();
        let mut document = serde_json::to_value(pack(&idx)).unwrap();
        document["version"] = serde_json::json!(FORMAT_VERSION - 1);
        // The v14 shape: `[name, kind, file, line, col, from]`, before receiver
        // and binding evidence widened it.
        for row in document["refs"].as_array_mut().unwrap() {
            let narrow: Vec<_> = row.as_array().unwrap().iter().take(6).cloned().collect();
            *row = serde_json::Value::Array(narrow);
        }
        let path = dir.path().join("old.json");
        std::fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();

        let message = format!("{:#}", load(&path).unwrap_err());
        assert!(
            message.contains(&format!("format v{}", FORMAT_VERSION - 1)),
            "must name the format it found: {message}"
        );
        assert!(
            !message.contains("invalid length"),
            "must not surface a row-shape error: {message}"
        );
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
