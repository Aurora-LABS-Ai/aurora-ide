//! One file in, its definitions and references out.
//!
//! This module holds every decision about *how a capture becomes a fact*. It
//! knows nothing about the workspace, the store, or resolution — that is
//! `index.rs`. Keeping the split means the extraction rules can be tested
//! against a string of source with no filesystem involved.

use crate::lang::{Lang, LangSpec};
use serde::{Deserialize, Serialize};
use streaming_iterator::StreamingIterator;
use tree_sitter::{Node, Parser, QueryCursor};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawSymbol {
    pub name: String,
    pub kind: String,
    pub line: u32,
    pub col: u32,
    /// The type/class/module the definition sits inside, when there is one.
    pub container: Option<String>,
    pub exported: bool,
}

impl RawSymbol {
    /// `Session::append` rather than a bare `append` — the qualified form is
    /// what makes a symbol table readable when 30 types all have a `new`.
    pub fn qualified(&self) -> String {
        match &self.container {
            Some(c) => format!("{c}::{}", self.name),
            None => self.name.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawRef {
    pub name: String,
    pub kind: String,
    pub line: u32,
    pub col: u32,
    /// The callable this usage appears *inside*, qualified where possible.
    /// `None` means top-level (a module-scope call, an import, a field type).
    pub from: Option<String>,
}

#[derive(Debug, Default)]
pub struct FileFacts {
    pub symbols: Vec<RawSymbol>,
    pub refs: Vec<RawRef>,
    /// tree-sitter always returns a tree; this reports whether it had to error-
    /// recover. Tracked so the probe can prove it survives half-written code
    /// rather than silently indexing garbage.
    pub had_parse_error: bool,
}

/// Specificity ordering for two *references* captured at the same byte range.
///
/// The bare-identifier catch-all overlaps every other reference pattern by
/// design — `foo()` is matched as a call AND as an identifier read. Without
/// this, every call in the codebase is counted twice and `callers` reports
/// "2x" for a single call site (caught against qg-native, 2026-08-09).
fn ref_rank(kind: &str) -> u8 {
    match kind {
        "call" => 5,
        "jsx" | "macro" => 4,
        "import" => 3,
        "type" => 2,
        "ident" => 1,
        _ => 0,
    }
}

/// Specificity ordering for two definitions captured at the same byte range.
///
/// `const x = () => {}` legitimately matches both the arrow-function pattern
/// and the catch-all variable pattern; the reader calls that a function, so the
/// higher rank wins.
fn rank(kind: &str) -> u8 {
    match kind {
        "function" | "method" => 5,
        "class" | "struct" | "interface" | "enum" | "trait" => 4,
        "type" => 3,
        "const" | "field" | "variant" | "module" | "macro" => 2,
        "variable" => 1,
        _ => 0,
    }
}

fn text<'a>(node: Node<'_>, src: &'a [u8]) -> &'a str {
    std::str::from_utf8(&src[node.byte_range()]).unwrap_or("")
}

fn named_child_text(node: Node<'_>, field: &str, src: &[u8]) -> Option<String> {
    node.child_by_field_name(field)
        .map(|n| text(n, src).to_string())
}

/// Nearest enclosing type/class/module name, for `container`.
fn enclosing_container(node: Node<'_>, src: &[u8], lang: Lang) -> Option<String> {
    let mut cur = node.parent();
    while let Some(n) = cur {
        match n.kind() {
            // Executable bodies end member scope. Without these barriers, a
            // method-local binding walks through its function and inherits the
            // surrounding class/impl as though it were a field.
            "statement_block" if matches!(lang, Lang::TypeScript | Lang::Tsx) => return None,
            "block" if lang == Lang::Rust => return None,
            // TypeScript uses `object_type` for both an interface body and an
            // anonymous inline type. Only the former owns real members.
            "object_type"
                if matches!(lang, Lang::TypeScript | Lang::Tsx)
                    && n.parent()
                        .is_none_or(|parent| parent.kind() != "interface_declaration") =>
            {
                return None;
            }
            _ => {}
        }
        if lang.is_container_node(n.kind()) {
            // Rust `impl` blocks name their subject with `type:`, everything
            // else uses `name:`.
            if let Some(t) = named_child_text(n, "type", src) {
                return Some(t);
            }
            if let Some(t) = named_child_text(n, "name", src) {
                return Some(t);
            }
        }
        cur = n.parent();
    }
    None
}

/// The name of a callable node, qualified by its container.
///
/// Arrow functions and function expressions are anonymous — their name lives on
/// the `variable_declarator` that binds them, which is why this reaches upward
/// instead of only reading a `name:` field.
fn callable_name(node: Node<'_>, src: &[u8], lang: Lang) -> Option<String> {
    let bare = named_child_text(node, "name", src).or_else(|| {
        let parent = node.parent()?;
        if parent.kind() == "variable_declarator" {
            named_child_text(parent, "name", src)
        } else {
            None
        }
    })?;

    Some(match enclosing_container(node, src, lang) {
        Some(c) => format!("{c}::{bare}"),
        None => bare,
    })
}

/// Which callable does this usage sit inside? This is the edge direction that
/// makes the index a call graph instead of a mention list.
fn enclosing_callable(node: Node<'_>, src: &[u8], lang: Lang) -> Option<String> {
    let mut cur = node.parent();
    while let Some(n) = cur {
        if lang.is_callable_node(n.kind()) {
            if let Some(name) = callable_name(n, src, lang) {
                return Some(name);
            }
        }
        cur = n.parent();
    }
    None
}

fn is_exported(name_node: Node<'_>, src: &[u8], lang: Lang) -> bool {
    match lang {
        Lang::Rust => {
            // `pub` is a child of the declaration, i.e. the name node's parent.
            let Some(decl) = name_node.parent() else {
                return false;
            };
            let mut cursor = decl.walk();
            decl.children(&mut cursor)
                .any(|c| c.kind() == "visibility_modifier")
        }
        Lang::TypeScript | Lang::Tsx => {
            // `export const`, `export function`, `export default class` put the
            // declaration a few levels under an `export_statement`.
            //
            // The walk must stop at the first executable scope it leaves: a
            // `const` inside an exported function's body is a local, not an
            // export, and a plain hop limit cannot tell the two apart.
            //
            // `statement_block` is the only barrier, and deliberately so. The
            // enclosing function/class node is a declaration's OWN parent — a
            // barrier there would make every function report as private. Class
            // and interface bodies are not barriers either: a method on an
            // exported class is reachable by anyone holding an instance.
            let mut cur = name_node.parent();
            while let Some(n) = cur {
                match n.kind() {
                    "export_statement" => return true,
                    "statement_block" => return false,
                    _ => {}
                }
                cur = n.parent();
            }
            let _ = src;
            false
        }
        // Python has no export keyword. The leading-underscore convention is
        // the language's actual visibility signal, and `__all__` only narrows
        // `from x import *` — it does not make anything private.
        Lang::Python => !text(name_node, src).starts_with('_'),
    }
}

/// Parse one file's source and pull out its definitions and references.
///
/// `parser` is passed in so callers can reuse one per worker thread — creating
/// a parser and re-setting its language per file is measurable at repo scale.
pub fn extract(spec: &LangSpec, parser: &mut Parser, source: &str) -> Option<FileFacts> {
    parser.set_language(&spec.language).ok()?;
    let tree = parser.parse(source, None)?;
    let src = source.as_bytes();
    let lang = spec.lang;

    let mut facts = FileFacts {
        had_parse_error: tree.root_node().has_error(),
        ..Default::default()
    };

    // Definitions are collected keyed by byte range so that a node matching two
    // def patterns collapses to its most specific kind, and so that references
    // landing on a definition's own name node can be subtracted below.
    let mut defs: std::collections::HashMap<std::ops::Range<usize>, (Node, &str)> =
        std::collections::HashMap::new();
    // Keyed by byte range for the same reason as `defs`: the reference
    // patterns deliberately overlap, so the most specific kind must win.
    let mut refs: std::collections::HashMap<std::ops::Range<usize>, (Node, &str)> =
        std::collections::HashMap::new();

    let capture_names = spec.query.capture_names();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&spec.query, tree.root_node(), src);

    while let Some(m) = matches.next() {
        for cap in m.captures {
            let full = capture_names[cap.index as usize];
            let Some((role, kind)) = full.split_once('.') else {
                continue;
            };
            match role {
                "def" => {
                    let range = cap.node.byte_range();
                    match defs.get(&range) {
                        Some((_, existing)) if rank(existing) >= rank(kind) => {}
                        _ => {
                            defs.insert(range, (cap.node, kind));
                        }
                    }
                }
                "ref" => {
                    let range = cap.node.byte_range();
                    match refs.get(&range) {
                        Some((_, existing)) if ref_rank(existing) >= ref_rank(kind) => {}
                        _ => {
                            refs.insert(range, (cap.node, kind));
                        }
                    }
                }
                _ => {}
            }
        }
    }

    for (node, kind) in defs.values() {
        let pos = node.start_position();
        facts.symbols.push(RawSymbol {
            name: text(*node, src).to_string(),
            kind: (*kind).to_string(),
            line: pos.row as u32 + 1,
            col: pos.column as u32 + 1,
            container: enclosing_container(*node, src, lang),
            exported: is_exported(*node, src, lang),
        });
    }

    for (node, kind) in refs.into_values() {
        // A definition's own name is not a usage of itself. This is what lets
        // the reference patterns stay broad (a bare `(type_identifier)` catches
        // every type mention, including the `struct Foo` that declares it).
        if defs.contains_key(&node.byte_range()) {
            continue;
        }
        let pos = node.start_position();
        facts.refs.push(RawRef {
            name: text(node, src).to_string(),
            kind: kind.to_string(),
            line: pos.row as u32 + 1,
            col: pos.column as u32 + 1,
            from: enclosing_callable(node, src, lang),
        });
    }

    facts.symbols.sort_by_key(|s| (s.line, s.col));
    facts.refs.sort_by_key(|r| (r.line, r.col));
    Some(facts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lang::LangSet;

    fn facts(lang: Lang, src: &str) -> FileFacts {
        let set = LangSet::new().unwrap();
        let mut parser = Parser::new();
        extract(set.spec(lang), &mut parser, src).expect("parse")
    }

    fn sym<'a>(f: &'a FileFacts, name: &str) -> &'a RawSymbol {
        f.symbols
            .iter()
            .find(|s| s.name == name)
            .unwrap_or_else(|| panic!("no symbol {name} in {:?}", f.symbols))
    }

    #[test]
    fn rust_methods_carry_their_impl_type() {
        let f = facts(
            Lang::Rust,
            r#"
            pub struct Session { id: u32 }
            impl Session {
                pub fn append(&self) { helper(); }
                fn private(&self) {}
            }
            fn helper() {}
            "#,
        );
        assert_eq!(sym(&f, "Session").kind, "struct");
        assert_eq!(sym(&f, "append").container.as_deref(), Some("Session"));
        assert!(sym(&f, "append").exported, "pub fn must read as exported");
        assert!(!sym(&f, "private").exported);

        // The edge is attributed to the qualified caller, not the bare name.
        let call = f
            .refs
            .iter()
            .find(|r| r.name == "helper" && r.kind == "call")
            .expect("helper call");
        assert_eq!(call.from.as_deref(), Some("Session::append"));
    }

    #[test]
    fn a_definitions_own_name_is_not_a_reference_to_itself() {
        let f = facts(Lang::Rust, "struct Foo { bar: Baz }");
        // `Foo` is captured by both the struct pattern and the type catch-all.
        assert!(f.refs.iter().all(|r| r.name != "Foo"), "{:?}", f.refs);
        // ...but a genuine type usage in the same statement still lands.
        assert!(f.refs.iter().any(|r| r.name == "Baz" && r.kind == "type"));
    }

    #[test]
    fn an_arrow_const_is_a_function_not_a_variable() {
        let f = facts(Lang::TypeScript, "export const compile = (x: Src) => run(x);");
        let s = sym(&f, "compile");
        assert_eq!(s.kind, "function", "arrow const must outrank the variable pattern");
        assert!(s.exported);
        let call = f.refs.iter().find(|r| r.name == "run").unwrap();
        assert_eq!(call.from.as_deref(), Some("compile"));
    }

    #[test]
    fn a_local_inside_an_exported_function_is_not_itself_exported() {
        // Caught on the real repo: an ancestor walk with a hop limit crosses
        // the function body and marks every local in an exported function as
        // public API, which poisons any "what does this module expose" answer.
        let f = facts(
            Lang::TypeScript,
            "export function probe() { const el = make(); return el; }",
        );
        assert!(sym(&f, "probe").exported);
        assert!(!sym(&f, "el").exported, "a local is not an export");
    }

    #[test]
    fn a_method_on_an_exported_class_stays_exported() {
        // The counterpart: class/interface bodies must NOT stop the walk, or
        // every method of an exported class reads as private.
        let f = facts(
            Lang::TypeScript,
            "export class Store { save() { const tmp = 1; return tmp; } }",
        );
        assert!(sym(&f, "save").exported, "method of an exported class");
        assert!(!sym(&f, "tmp").exported, "local inside that method");
    }

    #[test]
    fn method_locals_and_inline_types_do_not_inherit_a_class_container() {
        let f = facts(
            Lang::TypeScript,
            "export interface Options { top: boolean }\nexport class Service {\n  run(filters: { archived?: boolean }): { id: string; title: string } {\n    const local = 1;\n    return { id: String(local), title: String(filters.archived) };\n  }\n}\n",
        );
        assert_eq!(sym(&f, "run").container.as_deref(), Some("Service"));
        assert_eq!(sym(&f, "top").container.as_deref(), Some("Options"));
        assert_eq!(sym(&f, "local").container, None);
        assert_eq!(sym(&f, "archived").container, None);
        assert_eq!(sym(&f, "id").container, None);
        assert_eq!(sym(&f, "title").container, None);
    }

    #[test]
    fn rust_locals_do_not_inherit_an_impl_container() {
        let f = facts(
            Lang::Rust,
            "struct Service;\nimpl Service { fn run() { const LOCAL: u8 = 1; take(LOCAL); } }\n",
        );
        assert_eq!(sym(&f, "run").container.as_deref(), Some("Service"));
        assert_eq!(sym(&f, "LOCAL").container, None);
    }

    #[test]
    fn a_value_that_is_read_but_never_called_still_counts_as_used() {
        // Caught on the real repo: with only call/type/import/jsx patterns,
        // every exported constant read `headers: HEADERS` looked unreferenced
        // and the dead-code answer was worthless.
        let f = facts(
            Lang::TypeScript,
            "const HEADERS = {};\nfn(HEADERS);\nconst o = { HEADERS };",
        );
        let reads: Vec<_> = f.refs.iter().filter(|r| r.name == "HEADERS").collect();
        assert_eq!(reads.len(), 2, "argument + shorthand property: {reads:?}");
        assert!(reads.iter().all(|r| r.kind == "ident"));
    }

    #[test]
    fn rust_const_reads_are_captured() {
        let f = facts(Lang::Rust, "const CAP: u8 = 4;\nfn go() { take(CAP); }");
        assert!(
            f.refs.iter().any(|r| r.name == "CAP" && r.kind == "ident"),
            "{:?}",
            f.refs
        );
    }

    #[test]
    fn python_methods_carry_their_class_and_underscore_means_private() {
        let f = facts(
            Lang::Python,
            "class Runner:\n    def run(self):\n        return _helper()\n\ndef _helper():\n    pass\n",
        );
        assert_eq!(sym(&f, "Runner").kind, "class");
        assert_eq!(sym(&f, "run").container.as_deref(), Some("Runner"));
        assert!(sym(&f, "run").exported);
        assert!(!sym(&f, "_helper").exported, "leading underscore is private");
        let call = f
            .refs
            .iter()
            .find(|r| r.name == "_helper" && r.kind == "call")
            .expect("_helper call");
        assert_eq!(call.from.as_deref(), Some("Runner::run"));
    }

    #[test]
    fn a_call_is_counted_once_not_once_per_matching_pattern() {
        // Caught blind-testing qg-native: `_ctl(args)` matches both the call
        // pattern and the bare-identifier catch-all, so every call site was
        // reported twice and `callers` said "2x" for a single invocation.
        let f = facts(Lang::Python, "def go():\n    return helper()\n");
        let hits: Vec<_> = f.refs.iter().filter(|r| r.name == "helper").collect();
        assert_eq!(hits.len(), 1, "one call site, one reference: {hits:?}");
        assert_eq!(hits[0].kind, "call", "the specific kind must win over ident");
    }

    #[test]
    fn plain_consts_stay_variables() {
        let f = facts(Lang::TypeScript, "const LIMIT = 4000;");
        assert_eq!(sym(&f, "LIMIT").kind, "variable");
    }

    #[test]
    fn tsx_component_usage_counts_as_a_reference() {
        // Without this a React component used only as `<Panel />` reads as dead.
        let f = facts(
            Lang::Tsx,
            "const App = () => <Panel title=\"x\"><Row /></Panel>;",
        );
        let jsx: Vec<_> = f.refs.iter().filter(|r| r.kind == "jsx").collect();
        assert!(jsx.iter().any(|r| r.name == "Panel"), "{jsx:?}");
        assert!(jsx.iter().any(|r| r.name == "Row"), "{jsx:?}");
        assert_eq!(jsx[0].from.as_deref(), Some("App"));
    }

    #[test]
    fn class_methods_carry_their_class() {
        let f = facts(
            Lang::TypeScript,
            "export class Store { save(): void { this.flush(); } }",
        );
        assert_eq!(sym(&f, "save").container.as_deref(), Some("Store"));
        let flush = f.refs.iter().find(|r| r.name == "flush").unwrap();
        assert_eq!(flush.from.as_deref(), Some("Store::save"));
    }

    #[test]
    fn half_written_code_still_yields_the_symbols_above_the_break() {
        // The whole reason to prefer a parser over a language server: the agent
        // edits files into a broken state constantly, and the index must not
        // go blind while that is true.
        let f = facts(
            Lang::Rust,
            "fn good() {}\nfn broken( {\nstruct After { x: u8 }",
        );
        assert!(f.had_parse_error, "fixture is meant to be malformed");
        assert!(f.symbols.iter().any(|s| s.name == "good"));
        assert!(
            f.symbols.iter().any(|s| s.name == "After"),
            "recovery must reach past the broken fn: {:?}",
            f.symbols
        );
    }
}
