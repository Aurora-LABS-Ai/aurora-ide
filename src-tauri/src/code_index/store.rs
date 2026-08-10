//! The store: build a whole-workspace index, persist it, answer questions.
//!
//! Resolution is **name-based**, and that is a deliberate v0 limit rather than
//! an oversight. A real scope-aware resolver needs import graphs and type
//! inference; name matching gets the two questions that matter ("where is X
//! defined", "who touches X") at a fraction of the cost, and it reports its own
//! ambiguity instead of pretending to be exact — see `ResolutionStats`.

use super::extract::{extract, RawImport, RawRef, RawSymbol};
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

/// One `local -> module` binding, attributed to the file that wrote it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Import {
    pub file: u32,
    pub local: String,
    pub module: String,
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
    pub skipped_too_large: usize,
    /// Minified / bundled output, detected by line shape. Reported rather than
    /// silently dropped: a truncation that does not name itself reads as
    /// "we covered everything".
    pub skipped_generated: usize,
    /// Excluded dependency/build directory names actually present here.
    pub skipped_dirs: Vec<String>,
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
    /// `(file, local name) -> module specifier`.
    #[serde(skip)]
    imports_by_file: HashMap<(u32, String), String>,
    /// Forward-slashed relative path -> file id, for module resolution.
    #[serde(skip)]
    file_ids: HashMap<String, u32>,
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
        let per_file: Vec<_> = discovered
            .par_iter()
            .map_init(tree_sitter::Parser::new, |parser, d| {
                let source = std::fs::read_to_string(&d.path).ok()?;
                if walk::looks_generated(&source) {
                    return Some(Err(d.path.clone()));
                }
                let bytes = source.len() as u64;
                let facts = extract(langs.spec(d.lang), parser, &source)?;
                let rel = d
                    .path
                    .strip_prefix(&root)
                    .unwrap_or(&d.path)
                    .to_string_lossy()
                    .replace('\\', "/");
                Some(Ok((rel, d.lang, bytes, facts)))
            })
            .collect();

        let workspace_packages = walk::workspace_packages(&root);
        let mut idx = CodeIndex {
            root,
            files: Vec::new(),
            symbols: Vec::new(),
            refs: Vec::new(),
            imports: Vec::new(),
            workspace_packages,
            stats: BuildStats {
                skipped_too_large: walk_stats.skipped_too_large,
                skipped_dirs: walk_stats.skipped_dirs,
                ..Default::default()
            },
            by_name: HashMap::new(),
            refs_by_name: HashMap::new(),
            imports_by_file: HashMap::new(),
            file_ids: HashMap::new(),
        };

        for outcome in per_file.into_iter().flatten() {
            let (rel, lang, bytes, facts) = match outcome {
                Ok(v) => v,
                Err(_) => {
                    idx.stats.skipped_generated += 1;
                    continue;
                }
            };
            let file_id = idx.files.len() as u32;
            if facts.had_parse_error {
                idx.stats.files_with_parse_errors += 1;
            }
            idx.stats.bytes += bytes;
            idx.files.push(FileEntry {
                churn: churn.get(&rel).copied().unwrap_or(0),
                path: rel,
                lang: lang.name().to_string(),
                had_parse_error: facts.had_parse_error,
            });
            idx.symbols.extend(facts.symbols.into_iter().map(
                |RawSymbol {
                     name,
                     kind,
                     line,
                     col,
                     container,
                     exported,
                 }| Symbol {
                    name,
                    kind,
                    file: file_id,
                    line,
                    col,
                    container,
                    exported,
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
            idx.imports.extend(
                facts
                    .imports
                    .into_iter()
                    .map(|RawImport { local, module }| Import {
                        file: file_id,
                        local,
                        module,
                    }),
            );
        }

        idx.stats.files = idx.files.len();
        idx.stats.symbols = idx.symbols.len();
        idx.stats.refs = idx.refs.len();
        idx.rebuild_lookups();
        idx.stats.resolution = idx.compute_resolution();
        idx.stats.signature = walk::signature(&idx.root);
        idx.stats.build_ms = started.elapsed().as_millis();
        Ok(idx)
    }

    fn rebuild_lookups(&mut self) {
        self.by_name.clear();
        self.refs_by_name.clear();
        self.imports_by_file.clear();
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
            self.imports_by_file
                .insert((imp.file, imp.local.clone()), imp.module.clone());
        }
        for (i, f) in self.files.iter().enumerate() {
            self.file_ids.insert(f.path.clone(), i as u32);
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
            // The near-universal tsconfig alias. Aurora itself uses `@/* ->
            // src/*`; so does most of the ecosystem. Tried as a candidate
            // only, so a project that means something else simply misses.
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
        } else if spec.contains('.') && !spec.contains('/') {
            // Python absolute `a.b.c`.
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

        let joined = joined.trim_matches('/');
        if joined.is_empty() {
            return None;
        }

        // A specifier that already names a file wins outright.
        if let Some(&id) = self.file_ids.get(joined) {
            return Some(id);
        }
        const EXTS: &[&str] = &[
            ".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".rs", ".py",
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
        let mut hit = None;
        for suffix in EXTS.iter().chain(INDEXES) {
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
        let defs = self.definitions(name);
        if defs.len() <= 1 {
            return (defs, Confidence::Unique);
        }
        let bare = name.rsplit("::").next().unwrap_or(name);

        if let Some(module) = self.imports_by_file.get(&(from_file, bare.to_string())) {
            if let Some(target) = self.resolve_module(from_file, module) {
                let hit: Vec<&Symbol> = defs.iter().copied().filter(|s| s.file == target).collect();
                if !hit.is_empty() {
                    return (hit, Confidence::Import);
                }
            }
        }

        let same_file: Vec<&Symbol> = defs
            .iter()
            .copied()
            .filter(|s| s.file == from_file)
            .collect();
        if !same_file.is_empty() {
            return (same_file, Confidence::SameFile);
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
        for r in self.references(&target.name) {
            // A call site can only mean something callable. Without this, a
            // struct field named `reset` collects the calls of the function
            // `reset` that happens to share its file — the two are
            // indistinguishable by name and trivially distinguishable by kind.
            let call_site = matches!(r.kind.as_str(), "call" | "jsx" | "macro");
            if call_site && !is_callable(&target.kind) {
                continue;
            }

            let (mut defs, confidence) = self.resolve(&target.name, r.file);
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

    pub fn outline(&self, file_substring: &str) -> Vec<(&str, &Symbol)> {
        let mut out: Vec<(&str, &Symbol)> = self
            .symbols
            .iter()
            .filter_map(|s| {
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
        workspace_packages: Vec<(String, String)>,
        stats: BuildStats,
    ) -> Self {
        let mut idx = CodeIndex {
            root,
            files,
            symbols,
            refs,
            imports,
            workspace_packages,
            stats,
            by_name: HashMap::new(),
            refs_by_name: HashMap::new(),
            imports_by_file: HashMap::new(),
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
