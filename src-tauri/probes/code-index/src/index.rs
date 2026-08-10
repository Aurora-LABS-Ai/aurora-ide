//! The store: build a whole-workspace index, persist it, answer questions.
//!
//! Resolution is **name-based**, and that is a deliberate v0 limit rather than
//! an oversight. A real scope-aware resolver needs import graphs and type
//! inference; name matching gets the two questions that matter ("where is X
//! defined", "who touches X") at a fraction of the cost, and it reports its own
//! ambiguity instead of pretending to be exact — see `ResolutionStats`.

use crate::extract::{extract, RawRef, RawSymbol};
use crate::lang::LangSet;
use crate::walk;
use anyhow::{Context, Result};
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
    pub resolution: ResolutionStats,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CodeIndex {
    pub root: PathBuf,
    pub files: Vec<FileEntry>,
    pub symbols: Vec<Symbol>,
    pub refs: Vec<Reference>,
    pub stats: BuildStats,

    /// Derived lookups. Skipped on the wire and rebuilt after load — they are
    /// pure functions of the vectors above, so persisting them would only
    /// create a second copy that can disagree.
    #[serde(skip)]
    by_name: HashMap<String, Vec<u32>>,
    #[serde(skip)]
    refs_by_name: HashMap<String, Vec<u32>>,
}

impl CodeIndex {
    pub fn build(root: &Path) -> Result<Self> {
        let started = std::time::Instant::now();
        let root = dunce::canonicalize(root)
            .unwrap_or_else(|_| root.to_path_buf());

        let (discovered, walk_stats) = walk::discover(&root);
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

        let mut idx = CodeIndex {
            root,
            files: Vec::new(),
            symbols: Vec::new(),
            refs: Vec::new(),
            stats: BuildStats {
                skipped_too_large: walk_stats.skipped_too_large,
                skipped_dirs: walk_stats.skipped_dirs,
                ..Default::default()
            },
            by_name: HashMap::new(),
            refs_by_name: HashMap::new(),
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
        }

        idx.stats.files = idx.files.len();
        idx.stats.symbols = idx.symbols.len();
        idx.stats.refs = idx.refs.len();
        idx.rebuild_lookups();
        idx.stats.resolution = idx.compute_resolution();
        idx.stats.build_ms = started.elapsed().as_millis();
        Ok(idx)
    }

    fn rebuild_lookups(&mut self) {
        self.by_name.clear();
        self.refs_by_name.clear();
        for (i, s) in self.symbols.iter().enumerate() {
            self.by_name.entry(s.name.clone()).or_default().push(i as u32);
        }
        for (i, r) in self.refs.iter().enumerate() {
            self.refs_by_name
                .entry(r.name.clone())
                .or_default()
                .push(i as u32);
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

    /// Distinct callers of `name`, each with how many times they touch it.
    /// This is the blast-radius answer.
    pub fn callers(&self, name: &str) -> Vec<(String, usize)> {
        let mut counts: HashMap<String, usize> = HashMap::new();
        for r in self.references(name) {
            let key = r
                .from
                .clone()
                .unwrap_or_else(|| format!("<top level of {}>", self.file_path(r.file)));
            *counts.entry(key).or_default() += 1;
        }
        let mut out: Vec<_> = counts.into_iter().collect();
        out.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
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
    pub fn unreferenced(&self) -> Vec<&Symbol> {
        let mut out: Vec<&Symbol> = self
            .symbols
            .iter()
            .filter(|s| !self.refs_by_name.contains_key(&s.name))
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    pub fn save(&self, path: &Path) -> Result<u64> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let json = serde_json::to_vec(self).context("serializing index")?;
        let len = json.len() as u64;
        std::fs::write(path, json).with_context(|| format!("writing {}", path.display()))?;
        Ok(len)
    }

    pub fn load(path: &Path) -> Result<Self> {
        let bytes = std::fs::read(path)
            .with_context(|| format!("reading {} (run `index` first)", path.display()))?;
        let mut idx: CodeIndex = serde_json::from_slice(&bytes).context("parsing index")?;
        idx.rebuild_lookups();
        Ok(idx)
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
        let callers = idx.callers("append");
        assert!(
            callers.iter().any(|(who, _)| who == "go"),
            "expected `go` among {callers:?}"
        );

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

    #[test]
    fn a_round_trip_through_disk_preserves_every_answer() {
        let dir = fixture();
        let idx = CodeIndex::build(dir.path()).unwrap();
        let out = dir.path().join("idx.json");
        idx.save(&out).unwrap();

        // The derived lookups are `#[serde(skip)]`, so a load that forgot to
        // rebuild them would return empty results rather than fail loudly.
        let loaded = CodeIndex::load(&out).unwrap();
        assert_eq!(loaded.definitions("append").len(), 1);
        assert_eq!(loaded.callers("append"), idx.callers("append"));
        assert_eq!(loaded.stats.symbols, idx.stats.symbols);
    }
}
