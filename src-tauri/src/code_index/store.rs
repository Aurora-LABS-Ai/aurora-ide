//! The store: build a whole-workspace index, persist it, answer questions.
//!
//! Resolution is **name-based**, and that is a deliberate v0 limit rather than
//! an oversight. A real scope-aware resolver needs import graphs and type
//! inference; name matching gets the two questions that matter ("where is X
//! defined", "who touches X") at a fraction of the cost, and it reports its own
//! ambiguity instead of pretending to be exact — see `ResolutionStats`.

use super::extract::{extract, RawCombinatorKind, RawImport, RawPartOf, RawRef, RawSymbol};
use super::lang::LangSet;
use super::walk;
use anyhow::Result;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    /// Relative to the index root, forward-slashed, so an index stays valid if
    /// the workspace is moved and reads the same on every platform.
    pub path: String,
    pub lang: String,
    pub had_parse_error: bool,
    /// Commits touching this file in the recent window (see [`walk::churn`]).
    /// `0` means either "never changed" or "no git history available" — the two
    /// are not distinguished, because both mean the same thing to a ranking:
    /// no signal.
    #[serde(default)]
    pub churn: u32,
    /// Legacy named Dart library declared by this file, when present. Modern
    /// Dart uses URI-based `part of`, but named parts remain valid syntax and
    /// need a unique owner to share library scope correctly.
    #[serde(default)]
    pub library_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Symbol {
    pub name: String,
    pub kind: String,
    pub file: u32,
    pub line: u32,
    pub col: u32,
    pub container: Option<String>,
    pub exported: bool,
    /// Bounded declaration header. Kept out of broad index answers and write
    /// results; `code` returns it only for an explicit definition lookup.
    pub signature: Option<String>,
    /// Bounded first paragraph of an attributable doc comment or docstring.
    pub documentation: Option<String>,
}

impl Symbol {
    pub fn qualified(&self) -> String {
        match &self.container {
            Some(c) => format!("{c}::{}", self.name),
            None => self.name.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reference {
    pub name: String,
    pub kind: String,
    pub file: u32,
    pub line: u32,
    pub col: u32,
    pub from: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CombinatorKind {
    Show,
    Hide,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportCombinator {
    pub kind: CombinatorKind,
    pub names: Vec<String>,
    pub position: u32,
}

impl ImportCombinator {
    fn permits_all(combinators: &[Self], name: &str) -> bool {
        let mut visible = true;
        let mut ordered: Vec<&Self> = combinators.iter().collect();
        ordered.sort_by_key(|combinator| combinator.position);
        for combinator in ordered {
            let contains = combinator.names.iter().any(|candidate| candidate == name);
            visible = match combinator.kind {
                CombinatorKind::Show => visible && contains,
                CombinatorKind::Hide => visible && !contains,
            };
        }
        visible
    }
}

/// One `local -> imported -> module` binding, attributed to the file that
/// wrote it. Empty names represent a module-only dependency such as a
/// side-effect import or a re-export.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Import {
    pub file: u32,
    pub local: String,
    pub imported: String,
    pub module: String,
    pub directive: u32,
    pub reexport: bool,
    pub combinators: Vec<ImportCombinator>,
}

/// A Dart primary file and one file declared as its `part`. Parts share one
/// namespace, import scope, and underscore-private boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LibraryPart {
    pub library: u32,
    pub part: u32,
}

/// How a reference was tied to a definition, worst case first.
///
/// Reported rather than hidden: a caller that cannot tell an import-proven edge
/// from a same-name guess will present both with equal confidence, which is the
/// failure mode that made the old `usages` worse than grep.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Confidence {
    /// Several definitions share the name and nothing narrowed them.
    Ambiguous,
    /// Only definitions in the same directory carry the name.
    SameDir,
    /// The definition is in the referencing file itself.
    SameFile,
    /// The referencing file imports this name from the module that defines it.
    Import,
    /// Exactly one definition of the name exists in the whole workspace.
    Unique,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ResolutionStats {
    /// The reference matched exactly one definition — a trustworthy edge.
    pub unique: usize,
    /// Several definitions share the name (every `new`, `render`, `execute`).
    /// Reported rather than guessed at.
    pub ambiguous: usize,
    /// No definition in this workspace: a stdlib call, a dependency, or a
    /// builtin. Expected to be large and not a defect.
    pub external: usize,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct BuildStats {
    pub files: usize,
    pub files_with_parse_errors: usize,
    /// Files in an indexed language that could not be read or whose parser
    /// unwound. The count is complete; the path sample is bounded below.
    #[serde(default)]
    pub files_failed: usize,
    #[serde(default)]
    pub failed_files: Vec<String>,
    pub skipped_too_large: usize,
    /// Minified / bundled output, detected by line shape. Reported rather than
    /// silently dropped: a truncation that does not name itself reads as
    /// "we covered everything".
    pub skipped_generated: usize,
    /// Excluded dependency/build directory names actually present here.
    pub skipped_dirs: Vec<String>,
    /// Source extensions this workspace holds that no grammar here reads, and
    /// how many files carry each — largest first. See
    /// [`walk::WalkStats::unindexed_extensions`](super::walk::WalkStats) for
    /// why an unreadable file is counted rather than silently passed over.
    #[serde(default)]
    pub unindexed_extensions: Vec<(String, usize)>,
    pub bytes: u64,
    pub symbols: usize,
    pub refs: usize,
    pub build_ms: u128,
    /// Fingerprint of the tree this index was built from: (file count, newest
    /// mtime). Compared against a fresh `walk::signature` before answering, so
    /// an index can detect that it is out of date by itself.
    #[serde(default)]
    pub signature: (usize, u64),
    pub resolution: ResolutionStats,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CodeIndex {
    pub root: PathBuf,
    pub files: Vec<FileEntry>,
    pub symbols: Vec<Symbol>,
    pub refs: Vec<Reference>,
    #[serde(default)]
    pub imports: Vec<Import>,
    #[serde(default)]
    pub library_parts: Vec<LibraryPart>,
    /// Workspace package name -> its directory (see [`walk::workspace_packages`]).
    #[serde(default)]
    pub workspace_packages: Vec<(String, String)>,
    pub stats: BuildStats,

    /// Derived lookups. Skipped on the wire and rebuilt after load — they are
    /// pure functions of the vectors above, so persisting them would only
    /// create a second copy that can disagree.
    #[serde(skip)]
    by_name: HashMap<String, Vec<u32>>,
    #[serde(skip)]
    refs_by_name: HashMap<String, Vec<u32>>,
    /// `(file, local name) -> (imported name, module specifier, directive)`.
    #[serde(skip)]
    imports_by_file: HashMap<(u32, String), (String, String, u32)>,
    /// Direct, resolved import directives keyed by the file that wrote them.
    /// Name visibility is evaluated later because Dart combinators narrow it
    /// per name and re-export barrels can extend it transitively.
    #[serde(skip)]
    imported_modules: HashMap<u32, Vec<VisibleModule>>,
    /// Resolved re-export directives, separate from local imports. A barrel's
    /// exports are visible to its consumers without becoming local bindings in
    /// the barrel itself.
    #[serde(skip)]
    reexported_modules: HashMap<u32, Vec<VisibleModule>>,
    /// Every file id in a Dart library maps to the complete membership list,
    /// primary file included. Files absent here are one-file libraries.
    #[serde(skip)]
    library_members: HashMap<u32, Vec<u32>>,
    /// Forward-slashed relative path -> file id, for module resolution.
    #[serde(skip)]
    file_ids: HashMap<String, u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct VisibleModule {
    target: u32,
    directive: u32,
    combinators: Vec<ImportCombinator>,
    /// `(name exposed by this directive, name in the target module)`. Empty
    /// means a whole-module export such as Dart `export 'x.dart'` or
    /// TypeScript `export * from './x'`.
    bindings: Vec<(String, String)>,
}

enum FileBuildOutcome {
    Indexed(String, super::lang::Lang, u64, super::extract::FileFacts),
    Generated,
    Failed(String),
}

fn parse_without_taking_down_the_build<T>(f: impl FnOnce() -> Option<T>) -> Option<T> {
    // A grammar is native code. Catch Rust unwinds so one pathological file
    // becomes a coverage gap instead of aborting the whole parallel build.
    // Native access violations/segfaults cannot be caught here; that requires
    // a subprocess boundary, which this in-process index does not claim.
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f))
        .ok()
        .flatten()
}

/// Join a relative specifier onto a directory, collapsing `.` and `..`.
fn join_rel(dir: &str, rest: &str) -> String {
    let mut parts: Vec<&str> = dir.split('/').filter(|p| !p.is_empty()).collect();
    for seg in rest.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

/// Kinds a call site can actually be naming.
fn is_callable(kind: &str) -> bool {
    matches!(
        kind,
        "function"
            | "method"
            | "class"
            | "struct"
            | "trait"
            | "interface"
            | "enum"
            | "type"
            | "macro"
    )
}

/// `crate::code_index::store` -> `code_index/store`. The leading `crate`/`self`
/// is dropped because the crate root is not the index root.
fn rust_tail(spec: &str) -> String {
    spec.split("::")
        .filter(|s| !matches!(*s, "crate" | "self" | ""))
        .collect::<Vec<_>>()
        .join("/")
}

impl CodeIndex {
    pub fn build(root: &Path) -> Result<Self> {
        let started = std::time::Instant::now();
        let root = dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());

        let (discovered, walk_stats) = walk::discover(&root);
        // One `git log` for the whole workspace, before parsing starts. It is
        // a single bounded subprocess and returns an empty map on any failure,
        // so a workspace without git costs nothing and loses nothing but the
        // volatility signal.
        let churn = walk::churn(&root);
        let langs = LangSet::new()?;

        // One parser per rayon worker: creating one per file is measurable at
        // repo scale, and `Parser` is Send but not Sync so it cannot simply be
        // shared. The compiled queries inside `LangSet` are shared by reference.
        let per_file: Vec<FileBuildOutcome> = discovered
            .par_iter()
            .map_init(tree_sitter::Parser::new, |parser, d| {
                let rel = d
                    .path
                    .strip_prefix(&root)
                    .unwrap_or(&d.path)
                    .to_string_lossy()
                    .replace('\\', "/");
                let source = match std::fs::read_to_string(&d.path) {
                    Ok(source) => source,
                    Err(_) => return FileBuildOutcome::Failed(rel),
                };
                if walk::looks_generated(&source) {
                    return FileBuildOutcome::Generated;
                }
                let bytes = source.len() as u64;
                let Some(facts) = parse_without_taking_down_the_build(|| {
                    extract(langs.spec(d.lang), parser, &source)
                }) else {
                    return FileBuildOutcome::Failed(rel);
                };
                FileBuildOutcome::Indexed(rel, d.lang, bytes, facts)
            })
            .collect();

        let workspace_packages = walk::workspace_packages(&root);
        let mut idx = CodeIndex {
            root,
            files: Vec::new(),
            symbols: Vec::new(),
            refs: Vec::new(),
            imports: Vec::new(),
            library_parts: Vec::new(),
            workspace_packages,
            stats: BuildStats {
                skipped_too_large: walk_stats.skipped_too_large,
                skipped_dirs: walk_stats.skipped_dirs,
                unindexed_extensions: walk_stats.unindexed_extensions,
                ..Default::default()
            },
            by_name: HashMap::new(),
            refs_by_name: HashMap::new(),
            imports_by_file: HashMap::new(),
            imported_modules: HashMap::new(),
            reexported_modules: HashMap::new(),
            library_members: HashMap::new(),
            file_ids: HashMap::new(),
        };

        let mut pending_parts: Vec<(u32, Vec<String>, Option<RawPartOf>)> = Vec::new();

        for outcome in per_file {
            let (rel, lang, bytes, facts) = match outcome {
                FileBuildOutcome::Indexed(rel, lang, bytes, facts) => (rel, lang, bytes, facts),
                FileBuildOutcome::Generated => {
                    idx.stats.skipped_generated += 1;
                    continue;
                }
                FileBuildOutcome::Failed(path) => {
                    idx.stats.files_failed += 1;
                    // A handful of concrete paths makes the failure actionable
                    // without letting a bad generated tree bloat every cache.
                    if idx.stats.failed_files.len() < 20 {
                        idx.stats.failed_files.push(path);
                    }
                    continue;
                }
            };
            let file_id = idx.files.len() as u32;
            if facts.had_parse_error {
                idx.stats.files_with_parse_errors += 1;
            }
            idx.stats.bytes += bytes;
            let library_name = facts.library_name.clone();
            pending_parts.push((file_id, facts.parts.clone(), facts.part_of.clone()));
            idx.files.push(FileEntry {
                churn: churn.get(&rel).copied().unwrap_or(0),
                path: rel,
                lang: lang.name().to_string(),
                had_parse_error: facts.had_parse_error,
                library_name,
            });
            idx.symbols.extend(facts.symbols.into_iter().map(
                |RawSymbol {
                     name,
                     kind,
                     line,
                     col,
                     container,
                     exported,
                     signature,
                     documentation,
                 }| Symbol {
                    name,
                    kind,
                    file: file_id,
                    line,
                    col,
                    container,
                    exported,
                    signature,
                    documentation,
                },
            ));
            idx.refs.extend(facts.refs.into_iter().map(
                |RawRef {
                     name,
                     kind,
                     line,
                     col,
                     from,
                 }| Reference {
                    name,
                    kind,
                    file: file_id,
                    line,
                    col,
                    from,
                },
            ));
            idx.imports.extend(facts.imports.into_iter().map(
                |RawImport {
                     local,
                     imported,
                     module,
                     directive,
                     reexport,
                     combinators,
                 }| {
                    Import {
                        file: file_id,
                        local,
                        imported,
                        module,
                        directive,
                        reexport,
                        combinators: combinators
                            .into_iter()
                            .map(|combinator| ImportCombinator {
                                kind: match combinator.kind {
                                    RawCombinatorKind::Show => CombinatorKind::Show,
                                    RawCombinatorKind::Hide => CombinatorKind::Hide,
                                },
                                names: combinator.names,
                                position: combinator.position,
                            })
                            .collect(),
                    }
                },
            ));
        }

        idx.stats.files = idx.files.len();
        idx.stats.symbols = idx.symbols.len();
        idx.stats.refs = idx.refs.len();
        idx.resolve_library_parts(&pending_parts);
        idx.rebuild_lookups();
        idx.stats.resolution = idx.compute_resolution();
        idx.stats.signature = walk::signature(&idx.root);
        idx.stats.build_ms = started.elapsed().as_millis();
        Ok(idx)
    }

    fn resolve_library_parts(&mut self, pending: &[(u32, Vec<String>, Option<RawPartOf>)]) {
        // `resolve_module` needs this map, while the full lookup rebuild runs
        // only after part relations are known. Seed just the path map here.
        self.file_ids.clear();
        for (i, file) in self.files.iter().enumerate() {
            self.file_ids.insert(file.path.clone(), i as u32);
        }

        let mut named_libraries: HashMap<&str, Vec<u32>> = HashMap::new();
        for (file, entry) in self.files.iter().enumerate() {
            if let Some(name) = entry.library_name.as_deref() {
                named_libraries.entry(name).or_default().push(file as u32);
            }
        }

        let mut relations = std::collections::BTreeSet::new();
        for (file, parts, part_of) in pending {
            for specifier in parts {
                if let Some(part) = self.resolve_module(*file, specifier) {
                    if part != *file {
                        relations.insert((*file, part));
                    }
                }
            }
            let library = match part_of {
                Some(RawPartOf::Uri(specifier)) => self.resolve_module(*file, specifier),
                Some(RawPartOf::LibraryName(name)) => named_libraries
                    .get(name.as_str())
                    .filter(|files| files.len() == 1)
                    .map(|files| files[0]),
                None => None,
            };
            if let Some(library) = library.filter(|library| library != file) {
                relations.insert((library, *file));
            }
        }
        self.library_parts = relations
            .into_iter()
            .map(|(library, part)| LibraryPart { library, part })
            .collect();
    }

    fn rebuild_lookups(&mut self) {
        self.by_name.clear();
        self.refs_by_name.clear();
        self.imports_by_file.clear();
        self.imported_modules.clear();
        self.reexported_modules.clear();
        self.library_members.clear();
        self.file_ids.clear();
        for (i, s) in self.symbols.iter().enumerate() {
            self.by_name
                .entry(s.name.clone())
                .or_default()
                .push(i as u32);
        }
        for (i, r) in self.refs.iter().enumerate() {
            self.refs_by_name
                .entry(r.name.clone())
                .or_default()
                .push(i as u32);
        }
        for imp in &self.imports {
            if imp.reexport || imp.local.is_empty() {
                continue;
            }
            self.imports_by_file.insert(
                (imp.file, imp.local.clone()),
                (imp.imported.clone(), imp.module.clone(), imp.directive),
            );
        }
        for (i, f) in self.files.iter().enumerate() {
            self.file_ids.insert(f.path.clone(), i as u32);
        }

        // Connected components, not just direct pairs. A primary file may list
        // many parts, and a malformed/in-progress tree may reveal the same
        // membership from only the `part of` side. Either way every member
        // must receive the complete library scope.
        let mut adjacency: HashMap<u32, Vec<u32>> = HashMap::new();
        for relation in &self.library_parts {
            adjacency
                .entry(relation.library)
                .or_default()
                .push(relation.part);
            adjacency
                .entry(relation.part)
                .or_default()
                .push(relation.library);
        }
        let mut visited = std::collections::HashSet::new();
        for start in adjacency.keys().copied().collect::<Vec<_>>() {
            if !visited.insert(start) {
                continue;
            }
            let mut stack = vec![start];
            let mut members = Vec::new();
            while let Some(file) = stack.pop() {
                members.push(file);
                for neighbour in adjacency.get(&file).into_iter().flatten().copied() {
                    if visited.insert(neighbour) {
                        stack.push(neighbour);
                    }
                }
            }
            members.sort_unstable();
            members.dedup();
            for file in &members {
                self.library_members.insert(*file, members.clone());
            }
        }

        // Query patterns overlap on purpose, so merge rows belonging to one
        // source directive before deriving visibility. Two distinct imports of
        // the same module retain separate directives and their separate
        // combinator chains.
        let mut directives: HashMap<(u32, u32, bool), VisibleModule> = HashMap::new();
        for imp in &self.imports {
            if let Some(target) = self.resolve_module(imp.file, &imp.module) {
                let visible = directives
                    .entry((imp.file, imp.directive, imp.reexport))
                    .or_insert_with(|| VisibleModule {
                        target,
                        directive: imp.directive,
                        combinators: Vec::new(),
                        bindings: Vec::new(),
                    });
                if visible.target != target {
                    continue;
                }
                for combinator in &imp.combinators {
                    if !visible.combinators.contains(combinator) {
                        visible.combinators.push(combinator.clone());
                    }
                }
                if imp.reexport && !imp.local.is_empty() && !imp.imported.is_empty() {
                    let binding = (imp.local.clone(), imp.imported.clone());
                    if !visible.bindings.contains(&binding) {
                        visible.bindings.push(binding);
                    }
                }
            }
        }
        for ((file, _, reexport), mut visible) in directives {
            visible
                .combinators
                .sort_by_key(|combinator| combinator.position);
            let map = if reexport {
                &mut self.reexported_modules
            } else {
                &mut self.imported_modules
            };
            map.entry(file).or_default().push(visible);
        }
    }

    fn compute_resolution(&self) -> ResolutionStats {
        let mut st = ResolutionStats::default();
        for r in &self.refs {
            match self.by_name.get(&r.name).map(|v| v.len()).unwrap_or(0) {
                0 => st.external += 1,
                1 => st.unique += 1,
                _ => st.ambiguous += 1,
            }
        }
        st
    }

    pub fn file_path(&self, id: u32) -> &str {
        self.files
            .get(id as usize)
            .map(|f| f.path.as_str())
            .unwrap_or("<unknown>")
    }

    /// Definitions of `name`. Matches the bare name and the `Container::name`
    /// form, so `Session::append` and `append` both find the method.
    pub fn definitions(&self, name: &str) -> Vec<&Symbol> {
        if let Some((container, bare)) = name.split_once("::") {
            return self
                .by_name
                .get(bare)
                .map(|ids| {
                    ids.iter()
                        .map(|&i| &self.symbols[i as usize])
                        .filter(|s| s.container.as_deref() == Some(container))
                        .collect()
                })
                .unwrap_or_default();
        }
        self.by_name
            .get(name)
            .map(|ids| ids.iter().map(|&i| &self.symbols[i as usize]).collect())
            .unwrap_or_default()
    }

    /// Which file a module specifier written in `from` points at.
    ///
    /// Deliberately syntactic. A real module resolver reads `tsconfig` paths,
    /// `package.json` exports, Cargo's module tree and Python's `sys.path`;
    /// this reproduces the conventions those almost always encode, and returns
    /// `None` the moment it is unsure. A wrong answer here would silently
    /// mis-attribute callers, so every rule below is one that cannot be
    /// coincidence — and `None` costs nothing, because the caller falls back to
    /// the same-file / same-dir cascade.
    pub fn resolve_module(&self, from: u32, spec: &str) -> Option<u32> {
        let from_path = self.files.get(from as usize)?.path.as_str();
        let from_dir = from_path.rsplit_once('/').map_or("", |(d, _)| d);

        let joined = if let Some(rest) = spec.strip_prefix("./") {
            join_rel(from_dir, rest)
        } else if spec.starts_with("../") {
            join_rel(from_dir, spec)
        } else if let Some(rest) = spec.strip_prefix("@/") {
            // The near-universal tsconfig alias, tried as `src/*` first
            // because that is Aurora's own layout and a common one. It is a
            // GUESS, and the root-relative form is tried too — see the second
            // attempt at the end of this function.
            format!("src/{rest}")
        } else if spec.starts_with("crate::") || spec.starts_with("self::") {
            // Rust: crate-root-relative. The crate root is not necessarily the
            // index root (Aurora's own is `src-tauri/src`), so this is matched
            // by suffix below rather than anchored.
            rust_tail(spec)
        } else if let Some(rest) = spec.strip_prefix("super::") {
            // `super::store` from `code_index/repo_map.rs` is `code_index::
            // store` — a sibling file, for every ordinary Rust layout.
            join_rel(from_dir, &rest.replace("::", "/"))
        } else if spec.starts_with('.') {
            // Python `from .x import Y` / `from ..x import Y`. Each leading dot
            // past the first walks one directory up.
            let ups = spec.chars().take_while(|c| *c == '.').count();
            let rest = spec[ups..].replace('.', "/");
            let mut dir = from_dir.to_string();
            for _ in 1..ups {
                dir = dir
                    .rsplit_once('/')
                    .map_or(String::new(), |(d, _)| d.to_string());
            }
            join_rel(&dir, &rest)
        } else if spec.contains("::") {
            rust_tail(spec)
        } else if matches!(
            super::lang::Lang::from_path(std::path::Path::new(from_path)),
            Some(super::lang::Lang::C) | Some(super::lang::Lang::Cpp)
        ) {
            // A C/C++ `#include` is already a path, extension and all. It must
            // NOT go through the dotted-name branch below: the dot in
            // `config.h` separates an extension, not a package, and splitting
            // on it yields `config/h`. `<stdio.h>` lands here too and simply
            // fails to resolve, which is the right answer for a system header.
            spec.to_string()
        } else if spec.contains('\\') {
            // PHP namespaces separate with a backslash: `App\Models\User`.
            spec.replace('\\', "/")
        } else if let Some(rest) = spec.strip_prefix("package:") {
            // Dart. `package:<name>/<path>` is this workspace's own code only
            // when `<name>` is a package it declares — Flutter apps import
            // themselves this way alongside relative paths, and the two forms
            // reach the same files. A pub dependency
            // (`package:flutter/material.dart`) names no local package and
            // must MISS: resolving it by path would let it collide with an
            // unrelated local file that happens to share the name.
            self.workspace_package_path(rest)?
        } else if spec.ends_with(".dart") {
            // A Dart specifier is a path carrying its own extension, and a
            // sibling is written bare — `'home_screen.dart'`, no `./`. Without
            // this it reaches the dotted-package branch below, which reads the
            // extension as a directory and looks for `home_screen/dart`.
            join_rel(from_dir, spec)
        } else if spec.contains('.') && !spec.contains('/') {
            // Python absolute `a.b.c` — and the same shape carries Java,
            // Kotlin and C# imports (`com.acme.Widget`, `System.Text`), which
            // map onto directories the same way.
            spec.replace('.', "/")
        } else if let Some(inside) = self.workspace_package_path(spec) {
            // A bare specifier that names a package IN this workspace. In a
            // monorepo this is the common case for cross-library imports and
            // treating it as external erases every edge between packages.
            inside
        } else {
            // A genuinely external package (`react`, `serde`).
            return None;
        };

        if let Some(id) = self.resolve_joined(joined.trim_matches('/')) {
            return Some(id);
        }

        // `@/*` does not always mean `src/*`.
        //
        // The other half of the ecosystem maps it at the project ROOT —
        // `"paths": { "@/*": ["./*"] }`, which is what `create-next-app`
        // writes when there is no `src/` directory. Guessing `src/` for those
        // drops EVERY edge in the project, and the failure is silent and total:
        // `code op:modules` answers `dependencies: 0` across every directory,
        // which reads as "this code is not wired together" rather than as a
        // miss. Reported from a live run on a Next.js workspace on 2026-09-04,
        // where `outline` and `usages` worked — they resolve symbols by name
        // and never come through here — so only the module graph was wrong.
        //
        // Tried second, so a project that genuinely keeps its sources under
        // `src/` is unaffected: that lookup already returned above.
        if let Some(rest) = spec.strip_prefix("@/") {
            return self.resolve_joined(rest.trim_matches('/'));
        }
        None
    }

    /// Match one already-resolved path stem against the indexed files.
    ///
    /// Split out so a specifier can offer more than one candidate stem — an
    /// alias whose meaning depends on a `tsconfig` this index does not read.
    fn resolve_joined(&self, joined: &str) -> Option<u32> {
        if joined.is_empty() {
            return None;
        }

        // A specifier that already names a file wins outright.
        if let Some(&id) = self.file_ids.get(joined) {
            return Some(id);
        }
        // Every extension a specifier may have left off. Kept in step with
        // `Lang::from_path` by `every_indexed_extension_can_close_a_specifier`.
        const EXTS: &[&str] = &[
            ".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".rs", ".py",
            ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".go", ".java", ".cs", ".rb", ".php",
            ".kt", ".swift", ".dart",
        ];
        const INDEXES: &[&str] = &[
            "/index.ts",
            "/index.tsx",
            "/index.js",
            "/index.jsx",
            "/mod.rs",
            "/__init__.py",
        ];
        for suffix in EXTS.iter().chain(INDEXES) {
            if let Some(&id) = self.file_ids.get(&format!("{joined}{suffix}")) {
                return Some(id);
            }
        }

        // Nothing matched from the root. Rust and aliased specifiers are
        // relative to a crate/source root this index may not start at, so fall
        // back to a unique path SUFFIX match — unique being the whole point: two
        // candidates mean the specifier did not identify a file.
        // The empty suffix leads: a specifier that already carries its own
        // extension — every C/C++ `#include` — must be matched as written. With
        // only the extension-appending forms, `#include "net/socket.h"` looks
        // for `net/socket.h.c` and finds nothing, which is the silent-miss
        // shape this whole cascade exists to avoid.
        let mut hit = None;
        for suffix in std::iter::once(&"").chain(EXTS.iter()).chain(INDEXES) {
            let tail = format!("/{joined}{suffix}");
            for (path, &id) in &self.file_ids {
                if path.ends_with(&tail) {
                    if hit.is_some_and(|h| h != id) {
                        return None;
                    }
                    hit = Some(id);
                }
            }
        }
        hit
    }

    /// A bare specifier that names a package in this workspace, mapped to a
    /// path under that package's directory.
    ///
    /// Handles the subpath form too (`@scope/pkg/client` -> the package dir
    /// plus `client`), because a workspace library is imported both ways.
    fn workspace_package_path(&self, spec: &str) -> Option<String> {
        for (name, dir) in &self.workspace_packages {
            if spec == name {
                // The package's entry point. `src/` first: `dist/` is build
                // output and is not indexed, so pointing at `main` would
                // resolve to a file that does not exist here.
                return Some(format!("{dir}/src/index"));
            }
            if let Some(rest) = spec.strip_prefix(&format!("{name}/")) {
                return Some(format!("{dir}/{rest}"));
            }
        }
        None
    }

    fn library_files(&self, file: u32) -> Vec<u32> {
        self.library_members
            .get(&file)
            .cloned()
            .unwrap_or_else(|| vec![file])
    }

    fn directive_permits(&self, file: u32, directive: u32, name: &str) -> bool {
        self.imported_modules
            .get(&file)
            .into_iter()
            .flatten()
            .find(|visible| visible.directive == directive)
            .is_none_or(|visible| ImportCombinator::permits_all(&visible.combinators, name))
    }

    fn collect_exported_definitions<'a>(
        &'a self,
        target: u32,
        name: &str,
        visited: &mut std::collections::HashSet<(u32, String)>,
        out: &mut Vec<&'a Symbol>,
    ) {
        for member in self.library_files(target) {
            if !visited.insert((member, name.to_string())) {
                continue;
            }
            out.extend(
                self.definitions(name)
                    .into_iter()
                    .filter(|symbol| symbol.exported && symbol.file == member),
            );
            for reexport in self.reexported_modules.get(&member).into_iter().flatten() {
                if reexport.bindings.is_empty() {
                    if ImportCombinator::permits_all(&reexport.combinators, name) {
                        self.collect_exported_definitions(reexport.target, name, visited, out);
                    }
                } else {
                    for (_, imported) in reexport
                        .bindings
                        .iter()
                        .filter(|(exposed, _)| exposed == name)
                    {
                        self.collect_exported_definitions(reexport.target, imported, visited, out);
                    }
                }
            }
        }
    }

    fn collect_reachable_export_files(
        &self,
        target: u32,
        visited: &mut std::collections::HashSet<u32>,
        files: &mut std::collections::HashSet<u32>,
    ) {
        for member in self.library_files(target) {
            if !visited.insert(member) {
                continue;
            }
            files.insert(member);
            for reexport in self.reexported_modules.get(&member).into_iter().flatten() {
                self.collect_reachable_export_files(reexport.target, visited, files);
            }
        }
    }

    /// Public definitions named `name` exposed by `target`, including every
    /// Dart part and transitive re-export barrel. Re-export cycles terminate at
    /// the visited-file set instead of turning a symbol lookup into recursion.
    fn exported_definitions_from(&self, target: u32, name: &str) -> Vec<&Symbol> {
        let mut out = Vec::new();
        self.collect_exported_definitions(
            target,
            name,
            &mut std::collections::HashSet::new(),
            &mut out,
        );
        out.sort_by_key(|symbol| (symbol.file, symbol.line, symbol.col));
        out.dedup_by_key(|symbol| (symbol.file, symbol.line, symbol.col));
        out
    }

    fn imported_definitions(&self, from_file: u32, name: &str) -> Vec<&Symbol> {
        let mut out = Vec::new();
        for member in self.library_files(from_file) {
            for import in self.imported_modules.get(&member).into_iter().flatten() {
                if ImportCombinator::permits_all(&import.combinators, name) {
                    out.extend(self.exported_definitions_from(import.target, name));
                }
            }
        }
        out.sort_by_key(|symbol| (symbol.file, symbol.line, symbol.col));
        out.dedup_by_key(|symbol| (symbol.file, symbol.line, symbol.col));
        out
    }

    /// True when the file explicitly imports the library that owns `target`,
    /// but the target is absent from the resulting namespace. This is stronger
    /// evidence than the global unique-name fallback: `hide Post` and a private
    /// `_Post` must not be "resolved" merely because no other workspace file
    /// happens to declare that spelling.
    fn import_scope_excludes(&self, from_file: u32, target: &Symbol) -> bool {
        if self
            .imported_definitions(from_file, &target.name)
            .iter()
            .any(|candidate| {
                candidate.file == target.file
                    && candidate.line == target.line
                    && candidate.col == target.col
            })
        {
            return false;
        }

        for member in self.library_files(from_file) {
            for import in self.imported_modules.get(&member).into_iter().flatten() {
                let mut reachable = std::collections::HashSet::new();
                self.collect_reachable_export_files(
                    import.target,
                    &mut std::collections::HashSet::new(),
                    &mut reachable,
                );
                if reachable.contains(&target.file) {
                    return true;
                }
            }
        }
        false
    }

    fn import_exposes_target(&self, import: &Import, target: &Symbol) -> bool {
        let Some(module) = self.resolve_module(import.file, &import.module) else {
            return false;
        };
        ImportCombinator::permits_all(&import.combinators, &import.imported)
            && self
                .exported_definitions_from(module, &import.imported)
                .iter()
                .any(|candidate| {
                    candidate.file == target.file
                        && candidate.line == target.line
                        && candidate.col == target.col
                })
    }

    /// Which definitions does `name`, written inside `from_file`, actually
    /// mean — and how sure are we?
    ///
    /// This is the cascade that turns a name-matching index into a resolving
    /// one. Ordered strongest-first, and each step only fires when it produces
    /// a non-empty answer:
    ///
    /// 1. **The import.** If the file says where the name came from, that is
    ///    not a heuristic, it is the language's own answer.
    /// 2. **The same file.** A local definition shadows every distant one.
    /// 3. **The same directory.** Sibling modules are the next most likely.
    /// 4. **Everything.** Reported as `Ambiguous`, so a caller can refuse.
    ///
    /// Ported from the cascade in `greysquirr3l/coraline`'s resolver, which is
    /// the same shape and reached the same conclusion about refusing rather
    /// than guessing on call edges.
    pub fn resolve(&self, name: &str, from_file: u32) -> (Vec<&Symbol>, Confidence) {
        let bare = name.rsplit("::").next().unwrap_or(name);

        // References use the local spelling. Resolve the imported spelling
        // before looking at same-file or unique-name candidates, otherwise
        // `formatTokens as fmtTokens` becomes an external `fmtTokens` lookup.
        if let Some((imported, module, directive)) =
            self.imports_by_file.get(&(from_file, bare.to_string()))
        {
            if self.directive_permits(from_file, *directive, imported) {
                let hit = self
                    .resolve_module(from_file, module)
                    .map_or_else(Vec::new, |target| {
                        self.exported_definitions_from(target, imported)
                    });
                if !hit.is_empty() {
                    return (hit, Confidence::Import);
                }
            }
        }

        let defs = self.definitions(name);
        let local_library = self.library_files(from_file);
        let same_file: Vec<&Symbol> = defs
            .iter()
            .copied()
            .filter(|s| local_library.contains(&s.file))
            .collect();
        if !same_file.is_empty() {
            return (same_file, Confidence::SameFile);
        }

        if defs.len() <= 1 {
            if defs
                .first()
                .is_some_and(|target| self.import_scope_excludes(from_file, target))
            {
                return (Vec::new(), Confidence::Unique);
            }
            return (defs, Confidence::Unique);
        }

        // The file's imports, answering with an exported namespace rather than
        // a named binding. Ranked below same-library because a local definition
        // shadows an imported one, and above same-dir because an actual import
        // beats a sibling the file never named.
        //
        // Exactly ONE imported file may define the name. Two is a real
        // ambiguity, and resolving it by picking either would be the guess this
        // whole cascade exists to refuse.
        let hit = self.imported_definitions(from_file, name);
        let distinct: std::collections::HashSet<u32> = hit.iter().map(|s| s.file).collect();
        if distinct.len() == 1 {
            return (hit, Confidence::Import);
        }

        let dir = self
            .files
            .get(from_file as usize)
            .map(|f| f.path.rsplit_once('/').map_or("", |(d, _)| d));
        if let Some(dir) = dir {
            let same_dir: Vec<&Symbol> = defs
                .iter()
                .copied()
                .filter(|s| {
                    self.file_path(s.file)
                        .rsplit_once('/')
                        .map_or("", |(d, _)| d)
                        == dir
                        // A local binding in a sibling file is not visible from
                        // this file. Import resolution handles explicit
                        // cross-file bindings; the same-dir fallback must not
                        // let a local variable steal a global name.
                        && !matches!(
                            s.kind.as_str(),
                            "variable" | "const" | "field" | "variant"
                        )
                })
                .collect();
            if !same_dir.is_empty() {
                return (same_dir, Confidence::SameDir);
            }
        }

        (defs, Confidence::Ambiguous)
    }

    /// Usages of one SPECIFIC definition, resolved rather than name-matched.
    ///
    /// This is what the ambiguity refusal was standing in for. Asking "who
    /// calls `handle`" is unanswerable when seven files define it; asking who
    /// calls *the* `handle` at `src/a.rs:12` is answerable, and this answers
    /// it by resolving every reference and keeping the ones that land here.
    ///
    /// References that resolve only as `Ambiguous` are excluded, not included
    /// with a caveat: a list mixing proven and guessed callers reads as proven.
    /// They are counted separately so the caller can say how many it set aside.
    pub fn references_to(&self, target: &Symbol) -> (Vec<&Reference>, usize) {
        let mut hits = Vec::new();
        let mut unresolved = 0usize;
        let mut candidate_refs = self.references(&target.name);
        for imp in &self.imports {
            if imp.reexport
                || imp.local.is_empty()
                || (imp.local == imp.imported && imp.imported == target.name)
                || !self.import_exposes_target(imp, target)
            {
                continue;
            }
            candidate_refs.extend(
                self.references(&imp.local)
                    .into_iter()
                    .filter(|r| r.file == imp.file),
            );
        }

        for r in candidate_refs {
            // An import reference names the exported spelling even when the
            // local binding is aliased. Resolve it from the import table rather
            // than treating the import line as a normal local reference.
            if r.kind == "import" {
                if self.imports.iter().any(|imp| {
                    imp.file == r.file
                        && imp.imported == r.name
                        && self.directive_permits(imp.file, imp.directive, &imp.imported)
                        && self.import_exposes_target(imp, target)
                }) {
                    hits.push(r);
                }
                continue;
            }

            // A call site can only mean something callable. Without this, a
            // struct field named `reset` collects the calls of the function
            // `reset` that happens to share its file — the two are
            // indistinguishable by name and trivially distinguishable by kind.
            let call_site = matches!(r.kind.as_str(), "call" | "jsx" | "macro");
            if call_site && !is_callable(&target.kind) {
                continue;
            }

            let (mut defs, confidence) = self.resolve(&r.name, r.file);
            if call_site {
                defs.retain(|s| is_callable(&s.kind));
            }
            if defs.len() > 1 && confidence == Confidence::Ambiguous {
                unresolved += 1;
                continue;
            }
            if defs
                .iter()
                .any(|s| s.file == target.file && s.line == target.line)
            {
                hits.push(r);
            }
        }
        (hits, unresolved)
    }

    /// Every usage of `name`, in file order.
    pub fn references(&self, name: &str) -> Vec<&Reference> {
        let bare = name.rsplit("::").next().unwrap_or(name);
        let mut out: Vec<&Reference> = self
            .refs_by_name
            .get(bare)
            .map(|ids| ids.iter().map(|&i| &self.refs[i as usize]).collect())
            .unwrap_or_default();
        out.sort_by_key(|r| (r.file, r.line));
        out
    }

    /// One sentence naming what this workspace holds that the index cannot
    /// read, or `None` when it reads everything.
    ///
    /// Exists so a miss can state a REASON instead of guessing one. "No
    /// definition of `X` in this workspace, it may come from a dependency" is
    /// confident, plausible, and wrong whenever `X` lives in a language nothing
    /// here parses — and an agent that believes it concludes there are no
    /// callers and ships the break. Naming the gap turns that into a correct
    /// answer with a next step.
    ///
    /// Capped at the two largest extensions: this rides inside a tool result
    /// the model reads, and a list of nine is a paragraph nobody acts on.
    pub fn coverage_gap(&self) -> Option<String> {
        let gaps = &self.stats.unindexed_extensions;
        let mut reasons = Vec::new();
        if !gaps.is_empty() {
            let named: Vec<String> = gaps
                .iter()
                .take(2)
                .map(|(ext, n)| format!("{n} .{ext}"))
                .collect();
            let more = gaps.len().saturating_sub(2);
            let tail = if more > 0 {
                format!(" (and {more} other unreadable file type(s))")
            } else {
                String::new()
            };
            reasons.push(format!(
                "This workspace also holds {} file(s){tail} that this index cannot read — {}",
                named.join(" and "),
                super::lang::Lang::UNINDEXED_HINT
            ));
        }
        if self.stats.files_failed > 0 {
            let example = self
                .stats
                .failed_files
                .first()
                .map(|path| format!("; first failure: `{path}`"))
                .unwrap_or_default();
            reasons.push(format!(
                "{} supported-language file(s) failed to read or parse{example}",
                self.stats.files_failed
            ));
        }
        if self.stats.files_with_parse_errors > 0 {
            reasons.push(format!(
                "{} file(s) contain syntax errors and were indexed through parser recovery",
                self.stats.files_with_parse_errors
            ));
        }
        (!reasons.is_empty()).then(|| reasons.join(". "))
    }

    /// Is any indexed file's path matched by this spec?
    ///
    /// Separates the two things an empty [`Self::outline`] can mean. "This file
    /// is indexed and holds no structural symbols" is an ANSWER. "I have never
    /// heard of this file" is a request that could not be served, and the
    /// difference decides whether `code` reports success — see `op_outline`.
    pub fn indexes_file(&self, file_substring: &str) -> bool {
        self.files
            .iter()
            .any(|f| f.path.contains(file_substring))
    }

    pub fn outline(&self, file_substring: &str) -> Vec<(&str, &Symbol)> {
        let mut out: Vec<(&str, &Symbol)> = self
            .symbols
            .iter()
            .filter_map(|s| {
                // Variables stay indexed for definition/reference resolution,
                // but they describe bindings rather than a file's structural
                // surface. A container-less field is an anonymous inline type
                // member, not a class/interface member.
                if s.kind == "variable" || (s.kind == "field" && s.container.is_none()) {
                    return None;
                }
                let p = self.file_path(s.file);
                p.contains(file_substring).then_some((p, s))
            })
            .collect();
        out.sort_by_key(|(p, s)| (*p, s.line));
        out
    }

    /// Definitions with zero references anywhere in the workspace.
    ///
    /// This is a *candidate* list, not a verdict: a public API consumed
    /// outside the workspace, a trait impl called through dynamic dispatch, and
    /// anything reached by macro or string name will all appear here.
    ///
    /// **Deliberately not exposed as a `code` op yet, and that is why the
    /// compiler calls it unused.** The capability is real and cheap — the index
    /// already holds everything it needs — but the caveats above are large
    /// enough that a tool answer would need to be structured as candidates
    /// rather than findings, or a model would delete live code on its say-so.
    /// Keep or wire it; do not delete it as dead.
    #[allow(dead_code)]
    pub fn unreferenced(&self) -> Vec<&Symbol> {
        let mut out: Vec<&Symbol> = self
            .symbols
            .iter()
            .filter(|s| !self.refs_by_name.contains_key(&s.name))
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    /// Rebuild an index from already-extracted parts. Used by
    /// [`super::persist::unpack`] so a cached index takes the same derived
    /// lookups as a freshly built one — there is exactly one place that knows
    /// how to make a `CodeIndex` usable.
    pub fn from_parts(
        root: PathBuf,
        files: Vec<FileEntry>,
        symbols: Vec<Symbol>,
        refs: Vec<Reference>,
        imports: Vec<Import>,
        library_parts: Vec<LibraryPart>,
        workspace_packages: Vec<(String, String)>,
        stats: BuildStats,
    ) -> Self {
        let mut idx = CodeIndex {
            root,
            files,
            symbols,
            refs,
            imports,
            library_parts,
            workspace_packages,
            stats,
            by_name: HashMap::new(),
            refs_by_name: HashMap::new(),
            imports_by_file: HashMap::new(),
            imported_modules: HashMap::new(),
            reexported_modules: HashMap::new(),
            library_members: HashMap::new(),
            file_ids: HashMap::new(),
        };
        idx.rebuild_lookups();
        idx
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(
            root.join("src/session.rs"),
            "pub struct Session;\nimpl Session {\n  pub fn append(&self) { flush(); }\n}\nfn flush() {}\nfn orphan() {}\n",
        )
        .unwrap();
        std::fs::write(
            root.join("src/caller.rs"),
            "use crate::session::Session;\nfn go(s: &Session) { s.append(); }\n",
        )
        .unwrap();
        // Gitignored files must not reach the index.
        std::fs::write(root.join(".gitignore"), "generated.ts\n").unwrap();
        std::fs::write(root.join("generated.ts"), "export function ghost() {}\n").unwrap();
        dir
    }

    #[test]
    fn late_export_forms_mark_top_level_symbols_exported() {
        // `export default App` / `export { helper }` at the BOTTOM of the file
        // — the standard React shape — leave the declarations outside any
        // export_statement, so the ancestor walk alone reported them private.
        // Measured live: an app's root component read exported=false, and the
        // edit-impact note said nothing about the one file everything renders.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("app.tsx"),
            "function App() { return null }\n\
             function helper() {}\n\
             function local_only() {}\n\
             class Store { run() {} }\n\
             export default App\n\
             export { helper }\n",
        )
        .unwrap();
        // A re-export must NOT brand a local symbol: `run` here is someone
        // else's export, and this file's `Store.run` method stays private.
        std::fs::write(
            dir.path().join("barrel.ts"),
            "export { run } from \"./elsewhere\";\n",
        )
        .unwrap();
        let idx = CodeIndex::build(dir.path()).unwrap();

        let exported = |name: &str| {
            idx.definitions(name)
                .first()
                .unwrap_or_else(|| panic!("{name} must be indexed"))
                .exported
        };
        assert!(exported("App"), "export default App marks the function");
        assert!(exported("helper"), "export {{ helper }} marks the function");
        assert!(!exported("local_only"), "unexported stays private");
        assert!(
            !exported("run"),
            "a re-export names another module's symbol, not the class method here"
        );
    }

    #[test]
    fn builds_and_answers_the_three_questions() {
        let dir = fixture();
        let idx = CodeIndex::build(dir.path()).unwrap();

        // where is it defined
        let defs = idx.definitions("append");
        assert_eq!(defs.len(), 1, "{defs:?}");
        assert_eq!(defs[0].container.as_deref(), Some("Session"));

        // who touches it, and from inside what
        let (hits, _) = idx.references_to(defs[0]);
        let callers: Vec<&str> = hits.iter().filter_map(|r| r.from.as_deref()).collect();
        assert!(callers.contains(&"go"), "expected `go` among {callers:?}");

        // what is unused
        let dead: Vec<_> = idx.unreferenced().iter().map(|s| s.name.clone()).collect();
        assert!(dead.contains(&"orphan".to_string()), "{dead:?}");
        assert!(!dead.contains(&"flush".to_string()), "flush is called");
    }

    #[test]
    fn gitignored_files_are_not_indexed() {
        let dir = fixture();
        let idx = CodeIndex::build(dir.path()).unwrap();
        assert!(
            idx.definitions("ghost").is_empty(),
            "gitignored file leaked into the index"
        );
    }

    #[test]
    fn an_unreadable_supported_file_is_reported_as_a_coverage_gap() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("good.rs"), "pub fn visible() {}\n").unwrap();
        std::fs::write(dir.path().join("broken.rs"), [0xff, 0xfe, 0xfd]).unwrap();

        let idx = CodeIndex::build(dir.path()).unwrap();
        assert_eq!(idx.stats.files_failed, 1);
        assert_eq!(idx.stats.failed_files, ["broken.rs"]);
        assert_eq!(idx.definitions("visible").len(), 1);
        let gap = idx.coverage_gap().expect("the partial build must say so");
        assert!(gap.contains("1 supported-language file"), "{gap}");
        assert!(gap.contains("broken.rs"), "{gap}");
    }

    #[test]
    fn a_parser_unwind_is_isolated_from_the_caller() {
        let result: Option<()> = parse_without_taking_down_the_build(|| {
            panic!("synthetic grammar failure");
        });
        assert!(result.is_none());
    }

    /// Build an index from an in-memory file list.
    fn index_of(files: &[(&str, &str)]) -> (tempfile::TempDir, CodeIndex) {
        let dir = tempfile::tempdir().unwrap();
        for (name, body) in files {
            let p = dir.path().join(name);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }
        let idx = CodeIndex::build(dir.path()).unwrap();
        (dir, idx)
    }

    fn file_id(idx: &CodeIndex, path: &str) -> u32 {
        idx.files
            .iter()
            .position(|f| f.path == path)
            .unwrap_or_else(|| panic!("no file {path} in {:?}", idx.files)) as u32
    }

    #[test]
    fn outline_keeps_structural_members_and_hides_binding_noise() {
        let (_dir, idx) = index_of(&[(
            "src/service.ts",
            "export interface Options { top: boolean }\nexport class Service {\n  run(filters: { archived?: boolean }): { id: string; title: string } {\n    const local = 1;\n    return { id: String(local), title: String(filters.archived) };\n  }\n}\n",
        )]);
        let rows = idx.outline("src/service.ts");
        assert!(rows
            .iter()
            .any(|(_, s)| s.name == "Service" && s.kind == "class"));
        assert!(rows
            .iter()
            .any(|(_, s)| s.name == "run" && s.container.as_deref() == Some("Service")));
        assert!(rows
            .iter()
            .any(|(_, s)| s.name == "top" && s.container.as_deref() == Some("Options")));
        for noisy in ["local", "archived", "id", "title"] {
            assert!(
                !rows.iter().any(|(_, s)| s.name == noisy),
                "{noisy} leaked into outline"
            );
        }
        assert_eq!(
            idx.definitions("local").len(),
            1,
            "locals stay indexed for lookup"
        );
        assert_eq!(
            idx.definitions("archived").len(),
            1,
            "inline fields stay indexed for lookup"
        );
    }

    #[test]
    fn an_import_picks_the_right_definition_out_of_several_identical_names() {
        // The case name-matching cannot do: three `Client` classes, and the
        // consumer's own import statement says which one it means.
        let (_d, idx) = index_of(&[
            ("src/a/client.ts", "export class Client { go() {} }\n"),
            ("src/b/client.ts", "export class Client { go() {} }\n"),
            ("src/c/client.ts", "export class Client { go() {} }\n"),
            (
                "src/app/use.ts",
                "import { Client } from '../b/client';\nexport function boot() { return new Client(); }\n",
            ),
        ]);
        assert_eq!(idx.definitions("Client").len(), 3, "fixture is ambiguous");

        let from = file_id(&idx, "src/app/use.ts");
        let (defs, confidence) = idx.resolve("Client", from);
        assert_eq!(confidence, Confidence::Import);
        assert_eq!(defs.len(), 1, "the import names exactly one: {defs:?}");
        assert_eq!(idx.file_path(defs[0].file), "src/b/client.ts");
    }

    #[test]
    fn a_local_definition_shadows_a_distant_one_of_the_same_name() {
        let (_d, idx) = index_of(&[
            ("src/far/helper.ts", "export function helper() {}\n"),
            (
                "src/near/thing.ts",
                "function helper() {}\nexport function go() { helper(); }\n",
            ),
        ]);
        let from = file_id(&idx, "src/near/thing.ts");
        let (defs, confidence) = idx.resolve("helper", from);
        assert_eq!(confidence, Confidence::SameFile);
        assert_eq!(idx.file_path(defs[0].file), "src/near/thing.ts");
    }

    #[test]
    fn usages_of_one_specific_definition_exclude_its_homonyms() {
        // The question the old ambiguity refusal could not answer. Two `save`
        // functions in different modules; each consumer imports one of them,
        // and "who calls THIS save" must return only its own callers.
        let (_d, idx) = index_of(&[
            ("src/db/save.ts", "export function save() {}\n"),
            ("src/fs/save.ts", "export function save() {}\n"),
            (
                "src/x/usesDb.ts",
                "import { save } from '../db/save';\nexport function a() { save(); }\n",
            ),
            (
                "src/y/usesFs.ts",
                "import { save } from '../fs/save';\nexport function b() { save(); }\n",
            ),
        ]);
        let db_save = idx
            .definitions("save")
            .into_iter()
            .find(|s| idx.file_path(s.file) == "src/db/save.ts")
            .expect("the db save");

        let (hits, unresolved) = idx.references_to(db_save);
        let callers: Vec<_> = hits.iter().filter_map(|r| r.from.clone()).collect();
        assert!(
            callers.contains(&"a".to_string()),
            "the importing caller must be attributed: {callers:?}"
        );
        assert!(
            !callers.contains(&"b".to_string()),
            "the other module's caller must NOT be: {callers:?}"
        );
        assert_eq!(unresolved, 0, "both call sites were import-resolved");
    }

    #[test]
    fn aliased_imports_resolve_to_the_exported_definition_and_its_caller() {
        let (_d, idx) = index_of(&[
            ("src/a/format.ts", "export function formatTokens() {}\n"),
            ("src/b/format.ts", "export function formatTokens() {}\n"),
            (
                "src/app/use.ts",
                "import { formatTokens as fmt } from '../a/format';\nexport function go() { return fmt(1); }\n",
            ),
        ]);
        let target = idx
            .definitions("formatTokens")
            .into_iter()
            .find(|s| idx.file_path(s.file) == "src/a/format.ts")
            .expect("the selected formatTokens definition");
        let (hits, unresolved) = idx.references_to(target);
        assert_eq!(unresolved, 0, "the alias is import-resolved");
        assert_eq!(
            hits.iter().filter(|r| r.kind == "call").count(),
            1,
            "{hits:?}"
        );
        assert!(
            hits.iter().any(|r| r.from.as_deref() == Some("go")),
            "the aliased call must retain its caller: {hits:?}"
        );
    }

    /// Flutter writes the same file three ways — relative, bare sibling, and
    /// `package:<own name>/…` — and a real app mixes all three. Each one that
    /// misses is a dependency edge silently gone.
    #[test]
    fn dart_specifiers_resolve_in_every_form_a_flutter_app_writes() {
        let (_d, idx) = index_of(&[
            (
                "pubspec.yaml",
                "name: paynu_app\ndescription: \"An app.\"\n",
            ),
            ("lib/domain/models/post.dart", "class Post {}\n"),
            ("lib/ui/utils/camera_filters.dart", "class Filters {}\n"),
            ("lib/screens/home_screen.dart", "class HomeScreen {}\n"),
            (
                "lib/screens/create_post_screen.dart",
                "import '../domain/models/post.dart';\n\
                 import 'package:paynu_app/ui/utils/camera_filters.dart';\n\
                 export 'home_screen.dart';\n\
                 import 'package:flutter/material.dart';\n",
            ),
        ]);

        let from = file_id(&idx, "lib/screens/create_post_screen.dart");
        assert_eq!(
            idx.resolve_module(from, "../domain/models/post.dart"),
            Some(file_id(&idx, "lib/domain/models/post.dart")),
            "a relative Dart import"
        );
        assert_eq!(
            idx.resolve_module(from, "package:paynu_app/ui/utils/camera_filters.dart"),
            Some(file_id(&idx, "lib/ui/utils/camera_filters.dart")),
            "the app importing itself by its own pubspec name, through lib/"
        );
        assert_eq!(
            idx.resolve_module(from, "home_screen.dart"),
            Some(file_id(&idx, "lib/screens/home_screen.dart")),
            "a bare sibling, which Dart writes without a ./ prefix"
        );
        assert_eq!(
            idx.resolve_module(from, "package:flutter/material.dart"),
            None,
            "a pub dependency is not a file in this workspace"
        );
    }

    #[test]
    fn dart_show_hide_combinators_narrow_resolution_in_source_order() {
        let (_dir, idx) = index_of(&[
            ("lib/a/models.dart", "class Post {}\nclass User {}\n"),
            ("lib/b/models.dart", "class Post {}\nclass User {}\n"),
            (
                "lib/app/use.dart",
                "import '../a/models.dart' show Post, User hide User;\nPost? post;\nUser? user;\n",
            ),
        ]);
        let from = file_id(&idx, "lib/app/use.dart");

        let (posts, post_confidence) = idx.resolve("Post", from);
        assert_eq!(post_confidence, Confidence::Import);
        assert_eq!(posts.len(), 1, "{posts:?}");
        assert_eq!(idx.file_path(posts[0].file), "lib/a/models.dart");

        let (users, user_confidence) = idx.resolve("User", from);
        assert_eq!(user_confidence, Confidence::Ambiguous);
        assert_eq!(users.len(), 2, "hide must not pick either User: {users:?}");
    }

    #[test]
    fn an_explicitly_hidden_or_private_unique_name_does_not_use_the_global_fallback() {
        let (_dir, idx) = index_of(&[
            (
                "lib/models.dart",
                "class Post {}\nclass _LibraryPrivate {}\n",
            ),
            (
                "app/use.dart",
                "import '../lib/models.dart' hide Post;\nPost? post;\n_LibraryPrivate? hidden;\n",
            ),
        ]);
        let from = file_id(&idx, "app/use.dart");

        let (post, _) = idx.resolve("Post", from);
        assert!(
            post.is_empty(),
            "hide is stronger than global uniqueness: {post:?}"
        );
        let (private, _) = idx.resolve("_LibraryPrivate", from);
        assert!(
            private.is_empty(),
            "a Dart private name is not exported from its library: {private:?}"
        );
    }

    #[test]
    fn imports_follow_reexports_to_the_defining_file() {
        let (_dir, idx) = index_of(&[
            (
                "src/core/model.ts",
                "export class Post { archive() {} }\nexport class Hidden {}\n",
            ),
            (
                "src/core/index.ts",
                "export { Post } from './model';\n",
            ),
            (
                "src/app/use.ts",
                "import { Post } from '../core/index';\nexport function usePost(p: Post) { p.archive(); }\n",
            ),
        ]);
        let from = file_id(&idx, "src/app/use.ts");
        let (defs, confidence) = idx.resolve("Post", from);
        assert_eq!(confidence, Confidence::Import);
        assert_eq!(
            defs.len(),
            1,
            "the barrel resolves to one definition: {defs:?}"
        );
        assert_eq!(idx.file_path(defs[0].file), "src/core/model.ts");

        let target = idx.definitions("Post")[0];
        let (references, unresolved) = idx.references_to(target);
        assert_eq!(unresolved, 0);
        assert!(
            references
                .iter()
                .any(|reference| idx.file_path(reference.file) == "src/app/use.ts"),
            "the consumer survives the barrel: {references:?}"
        );

        let (hidden, _) = idx.resolve("Hidden", from);
        assert!(
            hidden.is_empty(),
            "a named re-export must not leak another target export: {hidden:?}"
        );
    }

    #[test]
    fn an_aliased_reexport_resolves_and_reports_its_consumers() {
        let (_dir, idx) = index_of(&[
            ("src/model.ts", "export class Post {}\n"),
            (
                "src/public.ts",
                "export { Post as PublicPost } from './model';\n",
            ),
            (
                "src/app.ts",
                "import { PublicPost } from './public';\nexport function use(post: PublicPost) {}\n",
            ),
        ]);
        let from = file_id(&idx, "src/app.ts");
        let (definitions, confidence) = idx.resolve("PublicPost", from);
        assert_eq!(confidence, Confidence::Import);
        assert_eq!(definitions.len(), 1, "{definitions:?}");
        assert_eq!(definitions[0].name, "Post");
        assert_eq!(idx.file_path(definitions[0].file), "src/model.ts");

        let post = idx.definitions("Post")[0];
        let (references, unresolved) = idx.references_to(post);
        assert_eq!(unresolved, 0);
        assert!(
            references
                .iter()
                .any(|reference| idx.file_path(reference.file) == "src/app.ts"),
            "the consumer's aliased spelling must reach the original: {references:?}"
        );
    }

    #[test]
    fn dart_parts_share_library_scope_imports_and_exports() {
        let (_dir, idx) = index_of(&[
            (
                "lib/timeline.dart",
                "library timeline.models;\nimport 'external.dart' show External;\npart 'post.dart';\npart 'user.dart';\nclass Timeline {}\n",
            ),
            (
                "lib/post.dart",
                "part of 'timeline.dart';\nclass Post { User? friend; External? external; }\n",
            ),
            (
                "lib/user.dart",
                "part of timeline.models;\nclass User {}\nclass _Hidden {}\n",
            ),
            ("lib/external.dart", "class External {}\n"),
            ("other/user.dart", "class User {}\n"),
            ("other/post.dart", "class Post {}\n"),
            ("other/external.dart", "class External {}\n"),
            (
                "app/use.dart",
                "import '../lib/timeline.dart';\nPost? post;\n",
            ),
        ]);

        let post_file = file_id(&idx, "lib/post.dart");
        let (users, user_confidence) = idx.resolve("User", post_file);
        assert_eq!(user_confidence, Confidence::SameFile);
        assert_eq!(users.len(), 1, "parts are one library scope: {users:?}");
        assert_eq!(idx.file_path(users[0].file), "lib/user.dart");

        let (external, external_confidence) = idx.resolve("External", post_file);
        assert_eq!(external_confidence, Confidence::Import);
        assert_eq!(
            external.len(),
            1,
            "parts inherit the library import: {external:?}"
        );
        assert_eq!(idx.file_path(external[0].file), "lib/external.dart");

        let client = file_id(&idx, "app/use.dart");
        let (posts, post_confidence) = idx.resolve("Post", client);
        assert_eq!(post_confidence, Confidence::Import);
        assert_eq!(
            posts.len(),
            1,
            "an import exposes definitions from parts: {posts:?}"
        );
        assert_eq!(idx.file_path(posts[0].file), "lib/post.dart");

        let (private_inside, inside_confidence) = idx.resolve("_Hidden", post_file);
        assert_eq!(inside_confidence, Confidence::SameFile);
        assert_eq!(
            private_inside.len(),
            1,
            "parts share privacy: {private_inside:?}"
        );
        let (private_outside, _) = idx.resolve("_Hidden", client);
        assert!(
            private_outside.is_empty(),
            "underscore-private definitions must not escape the library: {private_outside:?}"
        );

        assert_eq!(idx.library_parts.len(), 2, "{:?}", idx.library_parts);
    }

    #[test]
    fn module_specifiers_resolve_across_the_forms_each_language_writes() {
        let (_d, idx) = index_of(&[
            ("src/core/session.ts", "export class Session {}\n"),
            ("src/core/index.ts", "export const marker = 1;\n"),
            (
                "src/app/main.ts",
                "import { Session } from '../core/session';\n",
            ),
            ("pkg/mod/thing.py", "class Thing:\n    pass\n"),
            ("pkg/app.py", "from mod.thing import Thing\n"),
            ("src-tauri/src/code_index/store.rs", "pub struct Store;\n"),
            (
                "src-tauri/src/code_index/repo_map.rs",
                "use super::store::Store;\n",
            ),
        ]);

        let main = file_id(&idx, "src/app/main.ts");
        assert_eq!(
            idx.resolve_module(main, "../core/session"),
            Some(file_id(&idx, "src/core/session.ts")),
            "a relative TS specifier"
        );
        assert_eq!(
            idx.resolve_module(main, "../core"),
            Some(file_id(&idx, "src/core/index.ts")),
            "a directory resolves through index.ts"
        );
        assert_eq!(
            idx.resolve_module(main, "react"),
            None,
            "a package is not a file"
        );

        let repo_map = file_id(&idx, "src-tauri/src/code_index/repo_map.rs");
        assert_eq!(
            idx.resolve_module(repo_map, "super::store"),
            Some(file_id(&idx, "src-tauri/src/code_index/store.rs")),
            "Rust `super::` names a sibling module file"
        );

        let app = file_id(&idx, "pkg/app.py");
        assert_eq!(
            idx.resolve_module(app, "mod.thing"),
            Some(file_id(&idx, "pkg/mod/thing.py")),
            "a dotted Python module, matched by path suffix"
        );
    }

    #[test]
    fn a_c_include_is_a_path_and_a_python_module_is_still_dotted() {
        // These two collide and the collision is silent. A C `#include
        // "config.h"` contains a dot, so the dotted-name branch would split it
        // into `config/h` and resolve nothing; a Python `from a.b.c import x`
        // ends in `.c`, so an extension test would read it as a C file. The
        // branch keys on the IMPORTING file's language, which is the one fact
        // that separates them.
        let (_d, idx) = index_of(&[
            ("src/net/socket.h", "int open_socket(void);\n"),
            ("src/net/socket.c", "#include \"net/socket.h\"\n"),
            ("pkg/a/b/c.py", "value = 1\n"),
            ("pkg/app.py", "from a.b.c import value\n"),
        ]);

        let socket_c = file_id(&idx, "src/net/socket.c");
        assert_eq!(
            idx.resolve_module(socket_c, "net/socket.h"),
            Some(file_id(&idx, "src/net/socket.h")),
            "a C include names a path, extension and all"
        );
        assert_eq!(
            idx.resolve_module(socket_c, "stdio.h"),
            None,
            "a system header is not in this workspace, and None is the right answer"
        );

        let app = file_id(&idx, "pkg/app.py");
        assert_eq!(
            idx.resolve_module(app, "a.b.c"),
            Some(file_id(&idx, "pkg/a/b/c.py")),
            "a Python module ending in `.c` is still a module, not a C file"
        );
    }

    #[test]
    fn every_indexed_extension_can_close_a_specifier() {
        // `EXTS` in `resolve_module` is a second roster of file types, written
        // by hand. When a language is added to `Lang::from_path` and not here,
        // every import of it silently resolves to nothing — no error, just a
        // dependency graph missing one language.
        const EXTS_IN_RESOLVER: &[&str] = &[
            "ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs", "rs", "py", "c", "h", "cpp",
            "cc", "cxx", "hpp", "hh", "go", "java", "cs", "rb", "php", "kt", "swift", "dart",
        ];
        for ext in [
            "rs", "ts", "tsx", "py", "c", "cpp", "go", "java", "cs", "rb", "php", "kt", "swift",
            "dart",
        ] {
            assert!(
                super::super::lang::Lang::from_extension(ext).is_some(),
                ".{ext} must still be an indexed language"
            );
            assert!(
                EXTS_IN_RESOLVER.contains(&ext),
                ".{ext} is indexed but `resolve_module` cannot close a specifier with it"
            );
        }
    }

    #[test]
    fn a_workspace_library_imported_by_package_name_resolves_to_its_source() {
        // In a monorepo, apps import sibling libraries by PACKAGE NAME rather
        // than by relative path. Treating every bare specifier as external
        // erases all of those edges, so a whole-repo dependency graph comes
        // back empty however many packages the workspace actually has.
        let dir = tempfile::tempdir().unwrap();
        for (p, body) in [
            ("packages/core/package.json", "{\"name\":\"@acme/core\"}"),
            (
                "packages/core/src/index.ts",
                "export class Client { connect() {} }\n",
            ),
            (
                "apps/web/src/use.ts",
                "import { Client } from '@acme/core';\nexport const c = new Client();\n",
            ),
            // A genuinely external package must still resolve to nothing.
            (
                "apps/web/src/ext.ts",
                "import { useState } from 'react';\nexport const s = useState;\n",
            ),
        ] {
            let f = dir.path().join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, body).unwrap();
        }
        let idx = CodeIndex::build(dir.path()).unwrap();

        assert!(
            idx.workspace_packages
                .iter()
                .any(|(n, d)| n == "@acme/core" && d == "packages/core"),
            "the package.json name must be mapped: {:?}",
            idx.workspace_packages
        );

        let user = file_id(&idx, "apps/web/src/use.ts");
        assert_eq!(
            idx.resolve_module(user, "@acme/core"),
            Some(file_id(&idx, "packages/core/src/index.ts")),
            "a workspace library is a file in this repo, not an npm dependency"
        );
        let ext = file_id(&idx, "apps/web/src/ext.ts");
        assert_eq!(
            idx.resolve_module(ext, "react"),
            None,
            "a real npm package must still resolve to nothing"
        );
    }

    #[test]
    fn an_ambiguous_reference_is_reported_as_such_rather_than_guessed() {
        // Nothing imports it, nothing is local, nothing is a sibling: the
        // honest answer is "several", and the caller decides what to do.
        let (_d, idx) = index_of(&[
            ("src/a/x.ts", "export function run() {}\n"),
            ("src/b/x.ts", "export function run() {}\n"),
            ("src/c/caller.ts", "export function go() { run(); }\n"),
        ]);
        let from = file_id(&idx, "src/c/caller.ts");
        let (defs, confidence) = idx.resolve("run", from);
        assert_eq!(confidence, Confidence::Ambiguous);
        assert_eq!(defs.len(), 2);
    }

    /// Measurement harness for the resolution cascade, not a CI test. Point it
    /// at a real workspace and read how far imports actually get:
    ///
    /// ```text
    /// AURORA_INDEX_ROOT=E:/some/repo [AURORA_INDEX_SYMBOL=Name] \
    ///   cargo test --lib resolution_over_a_real_workspace -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "needs AURORA_INDEX_ROOT pointing at a real workspace"]
    fn resolution_over_a_real_workspace() {
        let root = std::env::var("AURORA_INDEX_ROOT").expect("set AURORA_INDEX_ROOT");
        let idx = CodeIndex::build(Path::new(&root)).unwrap();
        println!(
            "{} files, {} symbols, {} refs, {} imports, {} ms",
            idx.stats.files,
            idx.stats.symbols,
            idx.stats.refs,
            idx.imports.len(),
            idx.stats.build_ms
        );

        // How many import specifiers become a file at all? A low number here
        // means `resolve_module` is the bottleneck, not the cascade.
        let mut resolved_mod = 0usize;
        let mut external = 0usize;
        let mut failed: Vec<&str> = Vec::new();
        for imp in &idx.imports {
            match idx.resolve_module(imp.file, &imp.module) {
                Some(_) => resolved_mod += 1,
                // A bare or scoped package name (`react`, `@tauri-apps/api`)
                // is correctly not a file. `@/` is the source alias and IS
                // expected to resolve, so it stays in the failure bucket.
                None if !imp.module.starts_with('.')
                    && !imp.module.starts_with("@/")
                    && !imp.module.contains("::") =>
                {
                    external += 1
                }
                None => failed.push(&imp.module),
            }
        }
        println!(
            "modules: {resolved_mod} resolved, {external} external packages, {} UNRESOLVED",
            failed.len()
        );
        failed.sort_unstable();
        failed.dedup();
        println!(
            "  unresolved samples: {:?}",
            &failed[..failed.len().min(15)]
        );

        // Only NON-unique names exercise the cascade; a name with one
        // definition was never in doubt.
        let mut tally = [0usize; 5];
        let mut sampled = 0usize;
        for r in &idx.refs {
            if self::CodeIndex::definitions(&idx, &r.name).len() < 2 {
                continue;
            }
            sampled += 1;
            let (_, c) = idx.resolve(&r.name, r.file);
            tally[match c {
                Confidence::Ambiguous => 0,
                Confidence::SameDir => 1,
                Confidence::SameFile => 2,
                Confidence::Import => 3,
                Confidence::Unique => 4,
            }] += 1;
        }
        let pct = |n: usize| {
            if sampled == 0 {
                0.0
            } else {
                n as f64 * 100.0 / sampled as f64
            }
        };
        println!(
            "{sampled} ambiguous-name references: import {} ({:.1}%), same-file {} ({:.1}%), \
             same-dir {} ({:.1}%), still ambiguous {} ({:.1}%)",
            tally[3],
            pct(tally[3]),
            tally[2],
            pct(tally[2]),
            tally[1],
            pct(tally[1]),
            tally[0],
            pct(tally[0]),
        );

        // Spot-check one symbol end to end — the ground-truth answers in
        // `DOCS/code-index-handoff.md` §4.4 are checked this way.
        if let Ok(symbol) = std::env::var("AURORA_INDEX_SYMBOL") {
            let defs = idx.definitions(&symbol);
            println!("\n`{symbol}`: {} definition(s)", defs.len());
            for d in defs.iter().take(10) {
                let (hits, unresolved) = idx.references_to(d);
                let uses = hits.iter().filter(|r| r.kind != "import").count();
                println!(
                    "  {}:{} {} — {uses} use(s), {} import(s), {unresolved} unattributed",
                    idx.file_path(d.file),
                    d.line,
                    d.kind,
                    hits.len() - uses,
                );
            }
        }
    }

    /// C++ health check over a real workspace, for the three defects reported
    /// against the first C/C++ release: destructors indexed under the
    /// constructor's name, forward declarations indexed as definitions, and
    /// classes with more candidates than they have real definitions.
    ///
    /// Ignored and env-driven for the same reason as the harness above — it
    /// needs a real C++ tree, and no repository name belongs in this source.
    ///
    /// `AURORA_INDEX_ROOT=<repo> cargo test --lib cpp_health_over_a_real_workspace
    ///   -- --ignored --nocapture`
    #[test]
    #[ignore = "needs AURORA_INDEX_ROOT pointing at a real C++ workspace"]
    fn cpp_health_over_a_real_workspace() {
        let root = std::env::var("AURORA_INDEX_ROOT").expect("set AURORA_INDEX_ROOT");
        let idx = CodeIndex::build(Path::new(&root)).unwrap();

        let cpp_files = idx
            .files
            .iter()
            .filter(|f| f.lang == "cpp" || f.lang == "c")
            .count();
        println!(
            "{} files ({cpp_files} C/C++), {} symbols, {} ms",
            idx.stats.files, idx.stats.symbols, idx.stats.build_ms
        );

        // 1. Destructors keep their tilde. Without it `~Foo` is byte-identical
        //    to the constructor `Foo`, and every caller of one is attributed to
        //    both.
        let destructors = idx
            .symbols
            .iter()
            .filter(|s| s.name.starts_with('~'))
            .count();
        println!("destructors indexed with `~`: {destructors}");

        // 2. A class is defined once. Forward declarations (`class Foo;`) used
        //    to land here too, so this counts names with more class/struct
        //    definitions than any codebase plausibly has.
        let mut by_name: HashMap<&str, usize> = HashMap::new();
        for s in &idx.symbols {
            if matches!(s.kind.as_str(), "class" | "struct") {
                *by_name.entry(s.name.as_str()).or_default() += 1;
            }
        }
        let mut worst: Vec<(&str, usize)> = by_name.into_iter().filter(|(_, n)| *n > 1).collect();
        worst.sort_by(|a, b| b.1.cmp(&a.1));
        println!(
            "class/struct names with >1 definition: {} (worst: {:?})",
            worst.len(),
            &worst[..worst.len().min(8)]
        );

        // 3. How much of the remaining ambiguity is a header declaration and
        //    its .cpp definition counted as two rival definitions of one
        //    function? Measured rather than argued: for every C/C++ name that
        //    returns more than one candidate, ask whether the candidates
        //    collapse to a single entity once identical qualified names are
        //    merged.
        let mut ambiguous = 0usize;
        let mut collapses = 0usize;
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for s in &idx.symbols {
            if !seen.insert(s.name.as_str()) {
                continue;
            }
            let defs = idx.definitions(&s.name);
            let cpp_only = defs.iter().all(|d| {
                let lang = &idx.files[d.file as usize].lang;
                lang == "cpp" || lang == "c"
            });
            if defs.len() < 2 || !cpp_only {
                continue;
            }
            ambiguous += 1;
            let mut quals: Vec<String> = defs.iter().map(|d| d.qualified()).collect();
            quals.sort_unstable();
            quals.dedup();
            if quals.len() == 1 {
                collapses += 1;
            }
        }
        println!(
            "C/C++ ambiguous names: {ambiguous}; would collapse to one entity if a header \
             declaration and its definition were merged: {collapses} ({:.0}%)",
            if ambiguous == 0 {
                0.0
            } else {
                collapses as f64 * 100.0 / ambiguous as f64
            }
        );

        // 4. Whatever symbol is under suspicion, end to end.
        if let Ok(symbol) = std::env::var("AURORA_INDEX_SYMBOL") {
            let defs = idx.definitions(&symbol);
            println!("\n`{symbol}`: {} definition(s)", defs.len());
            for d in defs.iter().take(12) {
                let (hits, _) = idx.references_to(d);
                let uses = hits.iter().filter(|r| r.kind != "import").count();
                println!(
                    "  {}:{} {} — {uses} use(s)",
                    idx.file_path(d.file),
                    d.line,
                    d.kind
                );
            }
        }
    }

    #[test]
    fn qualified_lookup_disambiguates_a_shared_method_name() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("a.rs"),
            "struct A;\nimpl A { fn run(&self) {} }\nstruct B;\nimpl B { fn run(&self) {} }\n",
        )
        .unwrap();
        let idx = CodeIndex::build(dir.path()).unwrap();
        assert_eq!(idx.definitions("run").len(), 2, "bare name is ambiguous");
        assert_eq!(idx.definitions("A::run").len(), 1, "qualified name is not");
    }
}
