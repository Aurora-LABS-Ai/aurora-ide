//! Language registry: file extension -> grammar + compiled query.
//!
//! Everything the indexer knows about a language is declared here, so adding
//! one is a grammar dep, a `.scm` file, and an arm in each `match` below.
//!
//! The queries are `include_str!`'d rather than read from disk: this crate is
//! meant to be absorbed into the Tauri binary, where there is no source tree to
//! read from at runtime.
//!
//! **Coverage is a promise the tool makes.** A file whose extension is not
//! mapped here is not skipped-and-counted — it is never seen at all, so
//! `outline` on it answers "no indexed file matches" and `usages` of a symbol
//! defined in it answers "not defined in this workspace". Both are confident
//! and both are false. [`Lang::UNINDEXED_HINT`] and the walker's rejected-
//! extension tally exist so that gap can be stated rather than guessed at; if
//! you add a grammar here, nothing else needs to change for it to be reported.

use anyhow::{Context, Result};
use tree_sitter::{Language, Query};

const RUST_SCM: &str = include_str!("queries/rust.scm");
const TS_SCM: &str = include_str!("queries/typescript.scm");
const JSX_SCM: &str = include_str!("queries/jsx.scm");
const PY_SCM: &str = include_str!("queries/python.scm");
const C_SCM: &str = include_str!("queries/c.scm");
const CPP_SCM: &str = include_str!("queries/cpp.scm");
const GO_SCM: &str = include_str!("queries/go.scm");
const JAVA_SCM: &str = include_str!("queries/java.scm");
const CSHARP_SCM: &str = include_str!("queries/csharp.scm");
const RUBY_SCM: &str = include_str!("queries/ruby.scm");
const PHP_SCM: &str = include_str!("queries/php.scm");
const KOTLIN_SCM: &str = include_str!("queries/kotlin.scm");
const SWIFT_SCM: &str = include_str!("queries/swift.scm");
const DART_SCM: &str = include_str!("queries/dart.scm");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Lang {
    Rust,
    TypeScript,
    Tsx,
    Python,
    C,
    Cpp,
    Go,
    Java,
    CSharp,
    Ruby,
    Php,
    Kotlin,
    Swift,
    Dart,
}

impl Lang {
    /// Every language this build can parse, in a stable order. Used to compile
    /// the whole query set at startup and to state coverage to a caller.
    pub const ALL: [Lang; 14] = [
        Lang::Rust,
        Lang::TypeScript,
        Lang::Tsx,
        Lang::Python,
        Lang::C,
        Lang::Cpp,
        Lang::Go,
        Lang::Java,
        Lang::CSharp,
        Lang::Ruby,
        Lang::Php,
        Lang::Kotlin,
        Lang::Swift,
        Lang::Dart,
    ];

    /// What to tell a caller who asked about a file this index cannot read.
    /// Kept beside the roster so the two can never disagree about what is
    /// covered.
    pub const UNINDEXED_HINT: &'static str =
        "this index reads Rust, TypeScript/JavaScript, Python, C, C++, Go, Java, C#, Ruby, PHP, \
         Kotlin, Swift and Dart — use `grep` or `file_read` for anything else";

    /// Maps an extension to a grammar. `.js`/`.jsx` deliberately ride the
    /// TypeScript grammars — it is a superset, and a JS file parsed by the TS
    /// grammar yields the same symbols rather than needing a fourth dep.
    ///
    /// `.h` rides the C++ grammar for the same reason, and it is the arm that
    /// matters most: a header is the one file a C project's callers actually
    /// read, and it is ambiguous by construction — the extension says nothing
    /// about which of the two languages wrote it. C++ is the superset, so a C
    /// header parses correctly under it while the reverse loses every class.
    pub fn from_path(path: &std::path::Path) -> Option<Self> {
        Self::from_extension(path.extension()?.to_str()?)
    }

    /// The extension arm on its own, so the walker can report which extensions
    /// it rejected without constructing a path for each one.
    pub fn from_extension(ext: &str) -> Option<Self> {
        match ext {
            "rs" => Some(Lang::Rust),
            "ts" | "mts" | "cts" | "js" | "mjs" | "cjs" => Some(Lang::TypeScript),
            "tsx" | "jsx" => Some(Lang::Tsx),
            "py" | "pyi" => Some(Lang::Python),
            "c" => Some(Lang::C),
            "cpp" | "cc" | "cxx" | "c++" | "h" | "hpp" | "hh" | "hxx" | "inl" => Some(Lang::Cpp),
            "go" => Some(Lang::Go),
            "java" => Some(Lang::Java),
            "cs" => Some(Lang::CSharp),
            "rb" | "rake" | "gemspec" => Some(Lang::Ruby),
            "php" | "phtml" => Some(Lang::Php),
            "kt" | "kts" => Some(Lang::Kotlin),
            "swift" => Some(Lang::Swift),
            "dart" => Some(Lang::Dart),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Lang::Rust => "rust",
            Lang::TypeScript => "typescript",
            Lang::Tsx => "tsx",
            Lang::Python => "python",
            Lang::C => "c",
            Lang::Cpp => "cpp",
            Lang::Go => "go",
            Lang::Java => "java",
            Lang::CSharp => "csharp",
            Lang::Ruby => "ruby",
            Lang::Php => "php",
            Lang::Kotlin => "kotlin",
            Lang::Swift => "swift",
            Lang::Dart => "dart",
        }
    }

    /// Position in [`Lang::ALL`], for array-indexed lookup in [`LangSet`].
    fn slot(self) -> usize {
        match self {
            Lang::Rust => 0,
            Lang::TypeScript => 1,
            Lang::Tsx => 2,
            Lang::Python => 3,
            Lang::C => 4,
            Lang::Cpp => 5,
            Lang::Go => 6,
            Lang::Java => 7,
            Lang::CSharp => 8,
            Lang::Ruby => 9,
            Lang::Php => 10,
            Lang::Kotlin => 11,
            Lang::Swift => 12,
            Lang::Dart => 13,
        }
    }

    fn language(self) -> Language {
        match self {
            Lang::Rust => tree_sitter_rust::LANGUAGE.into(),
            Lang::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Lang::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Lang::Python => tree_sitter_python::LANGUAGE.into(),
            Lang::C => tree_sitter_c::LANGUAGE.into(),
            Lang::Cpp => tree_sitter_cpp::LANGUAGE.into(),
            Lang::Go => tree_sitter_go::LANGUAGE.into(),
            Lang::Java => tree_sitter_java::LANGUAGE.into(),
            Lang::CSharp => tree_sitter_c_sharp::LANGUAGE.into(),
            Lang::Ruby => tree_sitter_ruby::LANGUAGE.into(),
            // `LANGUAGE_PHP` parses a whole file including its HTML sections;
            // `LANGUAGE_PHP_ONLY` assumes the file is already inside `<?php`.
            // Real projects mix both, and a `.phtml` template is mostly HTML,
            // so the full grammar is the only one that reads every file.
            Lang::Php => tree_sitter_php::LANGUAGE_PHP.into(),
            Lang::Kotlin => tree_sitter_kotlin_ng::LANGUAGE.into(),
            Lang::Swift => tree_sitter_swift::LANGUAGE.into(),
            Lang::Dart => tree_sitter_dart::LANGUAGE.into(),
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
            Lang::C => C_SCM.to_string(),
            // C++ is a superset of C at the grammar level too, so the C
            // patterns compile against it unchanged and the C++ file adds only
            // what C has no syntax for (classes, namespaces, templates).
            Lang::Cpp => format!("{C_SCM}\n{CPP_SCM}"),
            Lang::Go => GO_SCM.to_string(),
            Lang::Java => JAVA_SCM.to_string(),
            Lang::CSharp => CSHARP_SCM.to_string(),
            Lang::Ruby => RUBY_SCM.to_string(),
            Lang::Php => PHP_SCM.to_string(),
            Lang::Kotlin => KOTLIN_SCM.to_string(),
            Lang::Swift => SWIFT_SCM.to_string(),
            Lang::Dart => DART_SCM.to_string(),
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
                    | "object_type"
            ),
            Lang::Python => matches!(kind, "class_definition"),
            Lang::C => matches!(
                kind,
                "struct_specifier" | "union_specifier" | "enum_specifier"
            ),
            Lang::Cpp => matches!(
                kind,
                "struct_specifier"
                    | "union_specifier"
                    | "enum_specifier"
                    | "class_specifier"
                    | "namespace_definition"
            ),
            // Go has no nesting for methods — a method names its receiver
            // instead. `type_spec` is what owns a struct's fields, which is
            // the attribution that does exist.
            Lang::Go => matches!(kind, "type_spec"),
            Lang::Java => matches!(
                kind,
                "class_declaration"
                    | "interface_declaration"
                    | "enum_declaration"
                    | "record_declaration"
                    | "annotation_type_declaration"
            ),
            Lang::CSharp => matches!(
                kind,
                "class_declaration"
                    | "interface_declaration"
                    | "struct_declaration"
                    | "enum_declaration"
                    | "record_declaration"
                    | "namespace_declaration"
            ),
            Lang::Ruby => matches!(kind, "class" | "module" | "singleton_class"),
            Lang::Php => matches!(
                kind,
                "class_declaration"
                    | "interface_declaration"
                    | "trait_declaration"
                    | "enum_declaration"
                    | "namespace_definition"
            ),
            Lang::Kotlin => matches!(kind, "class_declaration" | "object_declaration"),
            // tree-sitter-swift spells `struct`, `enum` and `actor` as
            // `class_declaration` too — one node kind covers all four.
            Lang::Swift => matches!(kind, "class_declaration" | "protocol_declaration"),
            // A Dart extension owns its methods the same way a class does, so
            // `context.paddingOf(...)` is attributed to the extension that
            // declares it rather than floating at file scope.
            Lang::Dart => matches!(
                kind,
                "class_declaration"
                    | "mixin_declaration"
                    | "extension_declaration"
                    | "extension_type_declaration"
                    | "enum_declaration"
            ),
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
            Lang::C => matches!(kind, "function_definition"),
            Lang::Cpp => matches!(kind, "function_definition" | "lambda_expression"),
            Lang::Go => matches!(
                kind,
                "function_declaration" | "method_declaration" | "func_literal"
            ),
            Lang::Java => matches!(
                kind,
                "method_declaration" | "constructor_declaration" | "lambda_expression"
            ),
            Lang::CSharp => matches!(
                kind,
                "method_declaration"
                    | "constructor_declaration"
                    | "local_function_statement"
                    | "lambda_expression"
            ),
            Lang::Ruby => matches!(kind, "method" | "singleton_method" | "do_block" | "block"),
            Lang::Php => matches!(
                kind,
                "function_definition"
                    | "method_declaration"
                    | "anonymous_function"
                    | "arrow_function"
            ),
            Lang::Kotlin => matches!(kind, "function_declaration" | "anonymous_function"),
            Lang::Swift => matches!(
                kind,
                "function_declaration" | "init_declaration" | "deinit_declaration"
            ),
            // Dart declares a member's signature and its body as SIBLINGS, so
            // the node a reference actually sits inside is the body, not the
            // declaration. Naming the declarations here instead would attribute
            // every call in a method to nothing.
            Lang::Dart => matches!(
                kind,
                "function_body" | "function_expression_body" | "function_expression"
            ),
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
///
/// An array indexed by [`Lang::slot`] rather than a field per language: at four
/// languages the named fields read fine, at thirteen they are a second roster
/// that can silently disagree with [`Lang::ALL`].
pub struct LangSet {
    specs: Vec<LangSpec>,
}

impl LangSet {
    pub fn new() -> Result<Self> {
        let mut specs = Vec::with_capacity(Lang::ALL.len());
        for lang in Lang::ALL {
            specs.push(LangSpec::new(lang)?);
        }
        Ok(Self { specs })
    }

    pub fn spec(&self, lang: Lang) -> &LangSpec {
        &self.specs[lang.slot()]
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
    fn every_language_is_reachable_through_the_set() {
        // `slot()` is a hand-written index and a wrong arm would hand one
        // language another's grammar — which parses, and yields nonsense.
        let set = LangSet::new().unwrap();
        for lang in Lang::ALL {
            assert_eq!(
                set.spec(lang).lang,
                lang,
                "{} got another grammar",
                lang.name()
            );
        }
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
        assert_eq!(Lang::from_path(Path::new("a/b.c")), Some(Lang::C));
        assert_eq!(Lang::from_path(Path::new("a/b.cpp")), Some(Lang::Cpp));
        assert_eq!(Lang::from_path(Path::new("a/b.go")), Some(Lang::Go));
        assert_eq!(Lang::from_path(Path::new("a/b.java")), Some(Lang::Java));
        assert_eq!(Lang::from_path(Path::new("a/b.cs")), Some(Lang::CSharp));
        assert_eq!(Lang::from_path(Path::new("a/b.rb")), Some(Lang::Ruby));
        assert_eq!(Lang::from_path(Path::new("a/b.php")), Some(Lang::Php));
        assert_eq!(Lang::from_path(Path::new("a/b.kt")), Some(Lang::Kotlin));
        assert_eq!(Lang::from_path(Path::new("a/b.swift")), Some(Lang::Swift));
        assert_eq!(Lang::from_path(Path::new("a/b.md")), None);
        assert_eq!(Lang::from_path(Path::new("noext")), None);
    }

    #[test]
    fn a_header_is_read_as_cpp_because_the_extension_cannot_say_which() {
        // `.h` is written by both languages and the C grammar drops every
        // class in a C++ header. The superset is the only arm that cannot
        // silently lose symbols.
        assert_eq!(Lang::from_path(Path::new("inc/api.h")), Some(Lang::Cpp));
        assert_eq!(Lang::from_path(Path::new("inc/api.hpp")), Some(Lang::Cpp));
    }

    #[test]
    fn the_coverage_hint_names_every_language_in_the_roster() {
        // The hint is what a caller is told when their file is not indexed. A
        // roster it does not match is a promise the tool cannot keep.
        let hint = Lang::UNINDEXED_HINT.to_lowercase();
        for lang in Lang::ALL {
            let needle = match lang {
                Lang::TypeScript | Lang::Tsx => "typescript",
                Lang::CSharp => "c#",
                Lang::Cpp => "c++",
                other => other.name(),
            };
            assert!(
                hint.contains(needle),
                "{} is indexed but the coverage hint does not mention it",
                lang.name()
            );
        }
    }
}
