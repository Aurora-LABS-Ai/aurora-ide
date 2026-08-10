//! Language registry: file extension -> grammar + compiled query.
//!
//! Everything the indexer knows about a language is declared here, so adding
//! one is a grammar dep, a `.scm` file, and an arm in `Lang::from_path`.
//!
//! The queries are `include_str!`'d rather than read from disk: this crate is
//! meant to be absorbed into the Tauri binary, where there is no source tree to
//! read from at runtime.

use anyhow::{Context, Result};
use tree_sitter::{Language, Query};

const RUST_SCM: &str = include_str!("queries/rust.scm");
const TS_SCM: &str = include_str!("queries/typescript.scm");
const JSX_SCM: &str = include_str!("queries/jsx.scm");
const PY_SCM: &str = include_str!("queries/python.scm");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Lang {
    Rust,
    TypeScript,
    Tsx,
    Python,
}

impl Lang {
    /// Maps an extension to a grammar. `.js`/`.jsx` deliberately ride the
    /// TypeScript grammars — it is a superset, and a JS file parsed by the TS
    /// grammar yields the same symbols rather than needing a fourth dep.
    pub fn from_path(path: &std::path::Path) -> Option<Self> {
        match path.extension()?.to_str()? {
            "rs" => Some(Lang::Rust),
            "ts" | "mts" | "cts" | "js" | "mjs" | "cjs" => Some(Lang::TypeScript),
            "tsx" | "jsx" => Some(Lang::Tsx),
            "py" | "pyi" => Some(Lang::Python),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Lang::Rust => "rust",
            Lang::TypeScript => "typescript",
            Lang::Tsx => "tsx",
            Lang::Python => "python",
        }
    }

    fn language(self) -> Language {
        match self {
            Lang::Rust => tree_sitter_rust::LANGUAGE.into(),
            Lang::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Lang::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Lang::Python => tree_sitter_python::LANGUAGE.into(),
        }
    }

    fn query_source(self) -> String {
        match self {
            Lang::Rust => RUST_SCM.to_string(),
            Lang::TypeScript => TS_SCM.to_string(),
            // The TSX grammar is the TS grammar plus JSX nodes. Patterns naming
            // a node type the grammar does not have are a hard query error, so
            // the JSX patterns can only be appended for this one variant.
            Lang::Tsx => format!("{TS_SCM}\n{JSX_SCM}"),
            Lang::Python => PY_SCM.to_string(),
        }
    }

    /// Node kinds that own a scope for `container` attribution ("this method
    /// belongs to `Session`").
    pub fn is_container_node(self, kind: &str) -> bool {
        match self {
            Lang::Rust => matches!(kind, "impl_item" | "trait_item" | "mod_item"),
            Lang::TypeScript | Lang::Tsx => matches!(
                kind,
                "class_declaration"
                    | "abstract_class_declaration"
                    | "interface_declaration"
                    | "module"
            ),
            Lang::Python => matches!(kind, "class_definition"),
        }
    }

    /// Node kinds that are a callable body — used to attribute a reference to
    /// the function it appears *inside*, which is what turns a pile of mentions
    /// into caller -> callee edges.
    pub fn is_callable_node(self, kind: &str) -> bool {
        match self {
            Lang::Rust => matches!(kind, "function_item" | "macro_definition"),
            Lang::TypeScript | Lang::Tsx => matches!(
                kind,
                "function_declaration"
                    | "generator_function_declaration"
                    | "method_definition"
                    | "arrow_function"
                    | "function_expression"
            ),
            Lang::Python => matches!(kind, "function_definition" | "lambda"),
        }
    }
}

/// A grammar plus its compiled query. `Query::new` is expensive (it compiles
/// the pattern set), so one of these is built per language for the whole run
/// and shared across the rayon workers.
pub struct LangSpec {
    pub lang: Lang,
    pub language: Language,
    pub query: Query,
}

impl LangSpec {
    pub fn new(lang: Lang) -> Result<Self> {
        let language = lang.language();
        let query = Query::new(&language, &lang.query_source())
            .with_context(|| format!("compiling the {} query", lang.name()))?;
        Ok(Self {
            lang,
            language,
            query,
        })
    }
}

/// All supported languages, built once.
pub struct LangSet {
    rust: LangSpec,
    ts: LangSpec,
    tsx: LangSpec,
    py: LangSpec,
}

impl LangSet {
    pub fn new() -> Result<Self> {
        Ok(Self {
            rust: LangSpec::new(Lang::Rust)?,
            ts: LangSpec::new(Lang::TypeScript)?,
            tsx: LangSpec::new(Lang::Tsx)?,
            py: LangSpec::new(Lang::Python)?,
        })
    }

    pub fn spec(&self, lang: Lang) -> &LangSpec {
        match lang {
            Lang::Rust => &self.rust,
            Lang::TypeScript => &self.ts,
            Lang::Tsx => &self.tsx,
            Lang::Python => &self.py,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn every_query_compiles_against_its_grammar() {
        // The whole indexer is dead if a pattern names a node type the grammar
        // does not have, and a `.scm` typo is otherwise silent until runtime.
        LangSet::new().expect("all queries must compile");
    }

    #[test]
    fn jsx_patterns_are_tsx_only() {
        // Guards the append-at-load-time trick in `query_source`: if the plain
        // TS grammar ever gained JSX nodes this test would stop meaning
        // anything, and if TSX lost them the LangSet test above would fail.
        let ts = Lang::TypeScript.language();
        assert!(
            Query::new(&ts, JSX_SCM).is_err(),
            "plain TS grammar unexpectedly accepts JSX patterns"
        );
    }

    #[test]
    fn extensions_map_to_the_expected_grammar() {
        assert_eq!(Lang::from_path(Path::new("a/b.rs")), Some(Lang::Rust));
        assert_eq!(Lang::from_path(Path::new("a/b.ts")), Some(Lang::TypeScript));
        assert_eq!(Lang::from_path(Path::new("a/b.tsx")), Some(Lang::Tsx));
        assert_eq!(Lang::from_path(Path::new("a/b.jsx")), Some(Lang::Tsx));
        assert_eq!(Lang::from_path(Path::new("a/b.py")), Some(Lang::Python));
        assert_eq!(Lang::from_path(Path::new("a/b.md")), None);
        assert_eq!(Lang::from_path(Path::new("noext")), None);
    }
}
