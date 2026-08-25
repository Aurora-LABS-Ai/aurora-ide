//! One file in, its definitions and references out.
//!
//! This module holds every decision about *how a capture becomes a fact*. It
//! knows nothing about the workspace, the store, or resolution — that is
//! `index.rs`. Keeping the split means the extraction rules can be tested
//! against a string of source with no filesystem involved.

use super::lang::{Lang, LangSpec};
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
    /// Declaration header without its body, bounded for cache and tool-result
    /// size. Returned only by an explicit `code` definition lookup.
    pub signature: Option<String>,
    /// First paragraph of the declaration's documentation, when the language
    /// has an attributable doc comment or docstring.
    pub documentation: Option<String>,
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

/// "this file binds `local` from module `module`".
///
/// The pair, not either half alone, is what makes name resolution possible: a
/// bare `Session` matches thirty definitions, `Session` imported from
/// `./session` matches one. `local == imported` is the ordinary case; an alias
/// keeps both names because references use the local spelling while definitions
/// use the imported one.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawImport {
    /// The name as it is used in THIS file (an alias when there is one).
    pub local: String,
    /// The name exported by the target module.
    pub imported: String,
    /// The module specifier exactly as written — `./session`, `crate::db`,
    /// `react`. Turning it into a file is the store's job, because only the
    /// store knows what files exist.
    pub module: String,
}

#[derive(Debug, Default)]
pub struct FileFacts {
    pub symbols: Vec<RawSymbol>,
    pub refs: Vec<RawRef>,
    pub imports: Vec<RawImport>,
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
/// "2x" for a single call site (caught blind-testing an unfamiliar Python repo, 2026-08-09).
fn ref_rank(kind: &str) -> u8 {
    match kind {
        "call" => 6,
        "jsx" | "macro" => 5,
        "import" => 4,
        // A write is also matched by the bare-identifier catch-all, and the
        // write is the more specific — and more consequential — reading.
        "write" => 3,
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

/// A TypeScript module specifier arrives as a `string` node, quotes included.
/// Rust and Python paths arrive bare and pass through untouched.
fn strip_module_quotes(raw: &str) -> &str {
    raw.trim_matches(|c| c == '"' || c == '\'' || c == '`')
}

fn named_child_text(node: Node<'_>, field: &str, src: &[u8]) -> Option<String> {
    node.child_by_field_name(field)
        .map(|n| text(n, src).to_string())
}

fn is_react_component_wrapper_binding(
    name_node: Node<'_>,
    src: &[u8],
    imports: &[RawImport],
) -> bool {
    let Some(declarator) = name_node
        .parent()
        .filter(|parent| parent.kind() == "variable_declarator")
    else {
        return false;
    };
    let Some(call) = declarator
        .child_by_field_name("value")
        .filter(|value| value.kind() == "call_expression")
    else {
        return false;
    };
    let Some(callee) = call.child_by_field_name("function") else {
        return false;
    };
    let is_wrapper = |name: &str| matches!(name, "memo" | "forwardRef");
    let namespace_from_react = |local: &str| {
        imports.iter().any(|import| {
            import.module == "react" && import.local == local && import.imported == local
        })
    };

    match callee.kind() {
        // `import { memo as keep } from "react"; const Panel = keep(Impl)`.
        "identifier" => {
            let local = text(callee, src);
            imports.iter().any(|import| {
                import.module == "react" && import.local == local && is_wrapper(&import.imported)
            })
        }
        // Default and namespace imports, including aliases:
        // `React.memo(Impl)` and `R.forwardRef(Impl)`.
        "member_expression" => {
            let Some(object) = callee.child_by_field_name("object") else {
                return false;
            };
            let Some(property) = callee.child_by_field_name("property") else {
                return false;
            };
            let wrapper = text(property, src);
            is_wrapper(wrapper) && namespace_from_react(text(object, src))
        }
        _ => false,
    }
}

/// The type named INSIDE a C++ out-of-line definition: the `Grid` of
/// `void Grid::draw() {}`.
///
/// Needed because that method is not nested in its class — it sits at namespace
/// scope, so walking up finds the enclosing `namespace` and answers `app`
/// instead of `Grid`. The qualification is the more specific truth, and it is
/// also the one that makes the in-class declaration and the out-of-line
/// definition agree about what they belong to.
fn cpp_declarator_scope(node: Node<'_>, src: &[u8]) -> Option<String> {
    let mut cur = node.child_by_field_name("declarator")?;
    loop {
        if cur.kind() == "function_declarator" {
            let inner = cur.child_by_field_name("declarator")?;
            let scope = inner.child_by_field_name("scope")?;
            return Some(text(scope, src).to_string());
        }
        cur = cur.child_by_field_name("declarator")?;
    }
}

/// The type a Go method hangs off, read from its receiver.
///
/// Go has no nesting for methods — `func (s *Session) Close()` names its owner
/// in a parameter. Without this, every method in a Go codebase reports as a
/// bare `Close`, and "who calls flush" answers with a name that could belong to
/// any of a dozen types, which is exactly the ambiguity this index exists to
/// remove.
fn go_receiver_type(node: Node<'_>, src: &[u8]) -> Option<String> {
    let recv = node.child_by_field_name("receiver")?;
    let mut cursor = recv.walk();
    let found = recv.children(&mut cursor).find_map(|p| {
        p.child_by_field_name("type")
            .and_then(|t| go_type_name(t, src))
    });
    found
}

/// Unwraps `*T` / `T[U]` down to the bare type name.
fn go_type_name(node: Node<'_>, src: &[u8]) -> Option<String> {
    match node.kind() {
        "type_identifier" => Some(text(node, src).to_string()),
        "pointer_type" | "generic_type" => {
            let mut cursor = node.walk();
            let found = node
                .children(&mut cursor)
                .find_map(|n| go_type_name(n, src));
            found
        }
        _ => None,
    }
}

/// Nearest enclosing type/class/module name, for `container`.
fn enclosing_container(node: Node<'_>, src: &[u8], lang: Lang) -> Option<String> {
    let mut cur = node.parent();
    while let Some(n) = cur {
        // Two languages write the owner into the declaration instead of
        // nesting the declaration inside it. Both are checked before the
        // ordinary walk, or it would answer with the enclosing namespace /
        // file and be confidently wrong.
        if lang == Lang::Go && n.kind() == "method_declaration" {
            if let Some(t) = go_receiver_type(n, src) {
                return Some(t);
            }
        }
        if lang == Lang::Cpp && n.kind() == "function_definition" {
            if let Some(scope) = cpp_declarator_scope(n, src) {
                return Some(scope);
            }
        }
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

/// The identifier buried inside a C/C++ declarator.
///
/// C names a function in its `declarator:` field rather than a `name:` field,
/// and wraps it in as many layers as the declaration has pointers, references
/// and qualifications: `static char *ns::make(void)` reaches the name through
/// `pointer_declarator` -> `function_declarator` -> `qualified_identifier`.
/// Without this descent `enclosing_callable` returns `None` for every C
/// function, and "who calls this" — the whole point of the index — has no
/// caller to name.
fn declarator_identifier(node: Node<'_>, src: &[u8]) -> Option<String> {
    match node.kind() {
        "identifier" | "field_identifier" | "type_identifier" => Some(text(node, src).to_string()),
        "qualified_identifier" | "destructor_name" | "template_function" => node
            .child_by_field_name("name")
            .and_then(|n| declarator_identifier(n, src))
            .or_else(|| {
                let mut cursor = node.walk();
                // Bound to a local rather than returned directly: the child
                // iterator borrows `cursor`, and as a tail expression its
                // temporary outlives the binding. Same trap as `is_exported`.
                let found = node
                    .children(&mut cursor)
                    .find_map(|c| declarator_identifier(c, src));
                found
            }),
        _ => node
            .child_by_field_name("declarator")
            .and_then(|d| declarator_identifier(d, src)),
    }
}

/// The name of a callable node, qualified by its container.
///
/// Arrow functions and function expressions are anonymous — their name lives on
/// the `variable_declarator` that binds them, which is why this reaches upward
/// instead of only reading a `name:` field.
fn callable_name(node: Node<'_>, src: &[u8], lang: Lang) -> Option<String> {
    let bare = named_child_text(node, "name", src)
        .or_else(|| {
            if matches!(lang, Lang::C | Lang::Cpp) {
                node.child_by_field_name("declarator")
                    .and_then(|d| declarator_identifier(d, src))
            } else {
                None
            }
        })
        .or_else(|| {
            let parent = node.parent()?;
            if parent.kind() == "variable_declarator" {
                named_child_text(parent, "name", src)
            } else {
                None
            }
        })?;

    // Go and C++ write a method's owner INSIDE the declaration — a receiver
    // parameter and a qualified declarator respectively — so it has to be read
    // from `node` itself. `enclosing_container` starts at the parent and would
    // walk straight past it to the enclosing file or namespace.
    if lang == Lang::Go {
        if let Some(receiver) = go_receiver_type(node, src) {
            return Some(format!("{receiver}::{bare}"));
        }
    }
    if lang == Lang::Cpp {
        if let Some(scope) = cpp_declarator_scope(node, src) {
            return Some(format!("{scope}::{bare}"));
        }
    }

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
            // Bound to a local rather than returned directly: the child
            // iterator borrows `cursor`, and as a tail expression its temporary
            // outlives the binding.
            let is_pub = decl
                .children(&mut cursor)
                .any(|c| c.kind() == "visibility_modifier");
            is_pub
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

        // C's only visibility keyword is `static`, which means the OPPOSITE of
        // what it means in most of this list: it confines a symbol to one
        // translation unit. Everything else has external linkage.
        //
        // C++ access specifiers (`private:` / `protected:`) are deliberately
        // NOT read. They are positional — a label that applies to every member
        // after it until the next one — so answering needs a scan of preceding
        // siblings, and getting it half-right would be worse than a stated
        // limit. A private member therefore reads as exported here, which
        // over-reports the public surface rather than hiding a real one.
        Lang::C | Lang::Cpp => !declares_keyword(name_node, src, &["static"], lang, 5),

        // Go puts visibility in the name itself: an initial capital is the
        // language rule, not a convention. It is the one language here where
        // this question has an exact answer.
        Lang::Go => text(name_node, src)
            .chars()
            .next()
            .is_some_and(|c| c.is_uppercase()),

        // Java and C# default to package-private / private, so the absence of
        // a keyword is a real answer rather than a missing one.
        Lang::Java | Lang::CSharp => {
            declares_keyword(name_node, src, &["public", "protected"], lang, 5)
        }

        // Public by default; the keyword narrows.
        Lang::Php => !declares_keyword(name_node, src, &["private", "protected"], lang, 5),
        Lang::Kotlin => !declares_keyword(
            name_node,
            src,
            &["private", "internal", "protected"],
            lang,
            5,
        ),
        Lang::Swift => !declares_keyword(name_node, src, &["private", "fileprivate"], lang, 5),

        // Ruby's `private` is a method call that changes the visibility of
        // everything declared after it, not a modifier on a declaration. It
        // cannot be answered from the definition's own subtree, and there is no
        // naming convention standing in for it the way there is in Python — so
        // everything reports as public, which is Ruby's own default.
        Lang::Ruby => true,
    }
}

/// Does the declaration around `name_node` carry one of `words` as a keyword?
///
/// Two bounds, and the second is the load-bearing one:
///
/// * `levels` caps how far up the walk goes at all.
/// * **The walk stops at the enclosing type.** A class's own `public` says
///   nothing about a member that declared no modifier of its own — without this
///   barrier every method of a `public class` reads as public, including the
///   ones the author deliberately left package-private. The first ancestor is
///   exempt because a type's own modifier IS the answer when the name being
///   asked about is the type.
///
/// Keywords arrive in three shapes across these grammars — an anonymous token
/// (`public`), a wrapper node holding one (`modifiers`), or a named node whose
/// TEXT is the keyword (PHP's `visibility_modifier`) — so all three are checked.
fn declares_keyword(
    name_node: Node<'_>,
    src: &[u8],
    words: &[&str],
    lang: Lang,
    levels: usize,
) -> bool {
    let mut cur = name_node.parent();
    for depth in 0..levels {
        let Some(node) = cur else { return false };
        if depth > 0 && lang.is_container_node(node.kind()) {
            return false;
        }
        if node_states_keyword(node, src, words) {
            return true;
        }
        cur = node.parent();
    }
    false
}

/// One node's own children checked for a bare keyword.
///
/// **Only modifier-shaped children are opened.** An earlier version descended
/// into every grandchild, which meant that at file scope it saw the `static` on
/// a NEIGHBOURING function and reported the whole file as internal. Anything
/// that can itself contain a declaration must stay closed, or the answer comes
/// from a sibling rather than from the declaration being asked about.
fn node_states_keyword(node: Node<'_>, src: &[u8], words: &[&str]) -> bool {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        // An anonymous keyword token: Java's `public`.
        if words.contains(&child.kind()) {
            return true;
        }
        let kind = child.kind();
        let modifier_shaped = kind.ends_with("modifier")
            || kind.ends_with("modifiers")
            || kind == "storage_class_specifier";
        if !modifier_shaped {
            continue;
        }
        // A named node whose TEXT is the keyword: PHP/Kotlin/Swift's
        // `visibility_modifier`, C#'s `modifier`, C's `storage_class_specifier`.
        if words.contains(&text(child, src).trim()) {
            return true;
        }
        // A wrapper holding them: Java's and Kotlin's `modifiers`.
        let mut inner = child.walk();
        for grand in child.children(&mut inner) {
            if words.contains(&grand.kind()) || words.contains(&text(grand, src).trim()) {
                return true;
            }
        }
    }
    false
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
    // Alias declarations match the broad identifier rule, but introducing
    // `fmt` in `import { formatTokens as fmt }` is not a read of the target.
    // Keep their ranges separately because aliases are bindings, not ordinary
    // definitions owned by this file.
    let mut import_locals: std::collections::HashSet<std::ops::Range<usize>> =
        std::collections::HashSet::new();
    // Names exported AWAY from their declaration — `export default App` /
    // `export { a, b }` at the bottom of the file. `is_exported` walks a
    // declaration's ancestors and can never see these, so they are applied to
    // the finished symbols below.
    let mut late_exports: std::collections::HashSet<&str> = std::collections::HashSet::new();

    let capture_names = spec.query.capture_names();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&spec.query, tree.root_node(), src);

    while let Some(m) = matches.next() {
        // Imports are the one fact that needs a whole MATCH rather than a
        // capture: the local name and the module it came from are two separate
        // nodes, and only their pairing carries information. Captures are
        // grouped by match and by nothing else, so the pairing has to be read
        // here, before the per-capture loop flattens them.
        let mut module: Option<&str> = None;
        let mut imported: Vec<&str> = Vec::new();
        let mut locals: Vec<&str> = Vec::new();
        for cap in m.captures {
            match capture_names[cap.index as usize] {
                "import.module" => module = Some(strip_module_quotes(text(cap.node, src))),
                "import.local" => locals.push(text(cap.node, src)),
                "ref.import" => imported.push(text(cap.node, src)),
                _ => {}
            }
        }
        if let Some(module) = module.filter(|m| !m.is_empty()) {
            match (imported.as_slice(), locals.as_slice()) {
                // An empty pair is a side-effect import or re-export. Keep the
                // module edge without inventing a local symbol binding.
                ([], []) => facts.imports.push(RawImport {
                    local: String::new(),
                    imported: String::new(),
                    module: module.to_string(),
                }),
                // The alias and the exported name were captured by the same
                // query match, so this is the only safe place to pair them.
                ([imported], [local]) => facts.imports.push(RawImport {
                    local: (*local).to_string(),
                    imported: (*imported).to_string(),
                    module: module.to_string(),
                }),
                // A non-aliased import uses the same spelling on both sides.
                (imported, []) => {
                    for imported_name in imported {
                        facts.imports.push(RawImport {
                            local: (*imported_name).to_string(),
                            imported: (*imported_name).to_string(),
                            module: module.to_string(),
                        });
                    }
                }
                // No local binding exists for a side-effect import or a
                // re-export pattern. Keep the module-only fact for the graph,
                // but do not invent a symbol binding from incomplete captures.
                _ => facts.imports.push(RawImport {
                    local: String::new(),
                    imported: String::new(),
                    module: module.to_string(),
                }),
            }
        }

        for cap in m.captures {
            let full = capture_names[cap.index as usize];
            if full == "import.local" {
                import_locals.insert(cap.node.byte_range());
                continue;
            }
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
                "export" => {
                    late_exports.insert(text(cap.node, src));
                }
                _ => {}
            }
        }
    }

    for (node, captured_kind) in defs.values() {
        let pos = node.start_position();
        let name = text(*node, src).to_string();
        let container = enclosing_container(*node, src, lang);
        // React's `memo` and `forwardRef` return callable component values, but
        // their declarations are syntactically variable declarators. Promote
        // only wrappers proven to come from the `react` import; a project-local
        // helper that happens to be named `memo` must remain an ordinary value.
        let kind = if *captured_kind == "variable"
            && matches!(lang, Lang::TypeScript | Lang::Tsx)
            && is_react_component_wrapper_binding(*node, src, &facts.imports)
        {
            "function"
        } else {
            captured_kind
        };
        let metadata = super::metadata::extract(*node, lang, kind, src);
        // Top-level only: `export { run }` exports the module-level `run`, and
        // must not brand a same-named method inside some class as public API.
        let exported = is_exported(*node, src, lang)
            || (container.is_none() && late_exports.contains(name.as_str()));
        facts.symbols.push(RawSymbol {
            name,
            kind: kind.to_string(),
            line: pos.row as u32 + 1,
            col: pos.column as u32 + 1,
            container,
            exported,
            signature: metadata.signature,
            documentation: metadata.documentation,
        });
    }

    for (node, kind) in refs.into_values() {
        // A definition's own name is not a usage of itself. This is what lets
        // the reference patterns stay broad (a bare `(type_identifier)` catches
        // every type mention, including the `struct Foo` that declares it).
        if defs.contains_key(&node.byte_range()) || import_locals.contains(&node.byte_range()) {
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
    // `super` here is `extract`, not `code_index` — the sibling module has to
    // be reached from the crate root.
    use crate::code_index::lang::LangSet;

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
    fn signatures_cover_every_language_without_copying_function_bodies() {
        let cases = [
            (
                Lang::Rust,
                "pub fn run(x: u32) -> u32 { expensive(x) }",
                "run",
                "pub fn run(x: u32) -> u32",
                "expensive",
            ),
            (
                Lang::TypeScript,
                "export function run(x: number): number { return expensive(x); }",
                "run",
                "function run(x: number): number",
                "expensive",
            ),
            (
                Lang::Tsx,
                "export const App = (p: Props) => { return <Panel />; };",
                "App",
                "App = (p: Props) =>",
                "Panel",
            ),
            (
                Lang::Python,
                "def run(x: int) -> int:\n    return expensive(x)\n",
                "run",
                "def run(x: int) -> int:",
                "expensive",
            ),
            (
                Lang::C,
                "int run(int x) { return expensive(x); }",
                "run",
                "int run(int x)",
                "expensive",
            ),
            (
                Lang::Cpp,
                "int Box::run(int x) { return expensive(x); }",
                "run",
                "int Box::run(int x)",
                "expensive",
            ),
            (
                Lang::Go,
                "package p\nfunc run(x int) int { return expensive(x) }",
                "run",
                "func run(x int) int",
                "expensive",
            ),
            (
                Lang::Java,
                "class A { int run(int x) { return expensive(x); } }",
                "run",
                "int run(int x)",
                "expensive",
            ),
            (
                Lang::CSharp,
                "class A { int Run(int x) { return Expensive(x); } }",
                "Run",
                "int Run(int x)",
                "Expensive",
            ),
            (
                Lang::Ruby,
                "def run(x)\n  expensive(x)\nend\n",
                "run",
                "def run(x)",
                "expensive",
            ),
            (
                Lang::Php,
                "<?php function run(int $x): int { return expensive($x); }",
                "run",
                "function run(int $x): int",
                "expensive",
            ),
            (
                Lang::Kotlin,
                "fun run(x: Int): Int { return expensive(x) }",
                "run",
                "fun run(x: Int): Int",
                "expensive",
            ),
            (
                Lang::Swift,
                "func run(_ x: Int) -> Int { expensive(x) }",
                "run",
                "func run(_ x: Int) -> Int",
                "expensive",
            ),
        ];

        for (lang, source, name, expected, body_text) in cases {
            let f = facts(lang, source);
            let signature = sym(&f, name)
                .signature
                .as_deref()
                .unwrap_or_else(|| panic!("{lang:?} produced no signature"));
            assert!(
                signature.contains(expected),
                "{lang:?} signature `{signature}` did not contain `{expected}`"
            );
            assert!(
                !signature.contains(body_text),
                "{lang:?} copied its body into `{signature}`"
            );
        }
    }

    #[test]
    fn documentation_is_attributed_only_from_language_doc_forms() {
        let rust = facts(
            Lang::Rust,
            "/// Opens one session.\n///\n/// More detail is intentionally omitted.\npub fn open() {}\n",
        );
        assert_eq!(
            sym(&rust, "open").documentation.as_deref(),
            Some("Opens one session.")
        );

        let ts = facts(
            Lang::TypeScript,
            "/** Formats the visible token count.\n * @param n token count\n */\nexport function format(n: number) { return n; }\n",
        );
        assert_eq!(
            sym(&ts, "format").documentation.as_deref(),
            Some("Formats the visible token count.")
        );

        let python = facts(
            Lang::Python,
            "def render():\n    \"\"\"Render the active panel.\n\n    Internal detail.\n    \"\"\"\n    return panel\n",
        );
        assert_eq!(
            sym(&python, "render").documentation.as_deref(),
            Some("Render the active panel.")
        );

        let go = facts(
            Lang::Go,
            "package p\n// Run starts one job.\nfunc Run() {}\n// implementation note, not API documentation\nfunc stop() {}\n",
        );
        assert_eq!(
            sym(&go, "Run").documentation.as_deref(),
            Some("Run starts one job.")
        );
        assert_eq!(sym(&go, "stop").documentation, None);

        let ordinary_ts = facts(
            Lang::TypeScript,
            "// implementation note\nexport function internal() {}\n",
        );
        assert_eq!(sym(&ordinary_ts, "internal").documentation, None);
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
        let f = facts(
            Lang::TypeScript,
            "export const compile = (x: Src) => run(x);",
        );
        let s = sym(&f, "compile");
        assert_eq!(
            s.kind, "function",
            "arrow const must outrank the variable pattern"
        );
        assert!(s.exported);
        let call = f.refs.iter().find(|r| r.name == "run").unwrap();
        assert_eq!(call.from.as_deref(), Some("compile"));
    }

    #[test]
    fn react_memo_and_forward_ref_bindings_are_functions() {
        let f = facts(
            Lang::Tsx,
            "import React, { memo as keep, forwardRef, useMemo } from 'react';\n\
             import * as R from 'react';\n\
             const Impl = () => null;\n\
             export const Memoized = React.memo(Impl);\n\
             export const NamespaceMemo = R.memo(Impl);\n\
             export const AliasedMemo = keep(Impl);\n\
             export const Forwarded = forwardRef((props, ref) => <div ref={ref} />);\n\
             export const TypedForwarded = React.forwardRef<HTMLDivElement, Props>((props, ref) => <div ref={ref} />);\n\
             export const Cached = useMemo(() => 1, []);\n\
             const localMemo = (value) => value;\n\
             export const LocallyWrapped = localMemo(Impl);\n",
        );

        for component in [
            "Memoized",
            "NamespaceMemo",
            "AliasedMemo",
            "Forwarded",
            "TypedForwarded",
        ] {
            assert_eq!(
                sym(&f, component).kind,
                "function",
                "React wrapper did not make {component} callable: {:?}",
                f.symbols
            );
        }
        for ordinary_value in ["Cached", "LocallyWrapped"] {
            assert_eq!(
                sym(&f, ordinary_value).kind,
                "variable",
                "non-component value {ordinary_value} was promoted: {:?}",
                f.symbols
            );
        }
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
    fn rust_let_bindings_are_definitions_not_reads() {
        let f = facts(Lang::Rust, "fn go() { let scan = 1; take(scan); }");
        assert_eq!(sym(&f, "scan").kind, "variable");
        assert_eq!(
            f.refs.iter().filter(|r| r.name == "scan").count(),
            1,
            "the binding itself must not be a usage"
        );
    }

    #[test]
    fn aliased_and_module_only_imports_keep_their_resolution_facts() {
        let f = facts(
            Lang::TypeScript,
            "import { formatTokens as fmt } from './format';\nimport './setup';\nexport * from './barrel';\n",
        );

        assert!(
            f.imports.iter().any(|i| {
                i.local == "fmt" && i.imported == "formatTokens" && i.module == "./format"
            }),
            "alias pairing was lost: {:?}",
            f.imports
        );
        assert!(
            f.imports
                .iter()
                .any(|i| i.local.is_empty() && i.imported.is_empty() && i.module == "./setup"),
            "side-effect import was lost: {:?}",
            f.imports
        );
        assert!(
            f.imports
                .iter()
                .any(|i| i.local.is_empty() && i.imported.is_empty() && i.module == "./barrel"),
            "re-export dependency was lost: {:?}",
            f.imports
        );
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
        assert!(
            !sym(&f, "_helper").exported,
            "leading underscore is private"
        );
        let call = f
            .refs
            .iter()
            .find(|r| r.name == "_helper" && r.kind == "call")
            .expect("_helper call");
        assert_eq!(call.from.as_deref(), Some("Runner::run"));
    }

    #[test]
    fn a_call_is_counted_once_not_once_per_matching_pattern() {
        // Caught blind-testing an unfamiliar repo: `helper(args)` matches both the call
        // pattern and the bare-identifier catch-all, so every call site was
        // reported twice and `callers` said "2x" for a single invocation.
        let f = facts(Lang::Python, "def go():\n    return helper()\n");
        let hits: Vec<_> = f.refs.iter().filter(|r| r.name == "helper").collect();
        assert_eq!(hits.len(), 1, "one call site, one reference: {hits:?}");
        assert_eq!(
            hits[0].kind, "call",
            "the specific kind must win over ident"
        );
    }

    #[test]
    fn a_write_from_outside_is_distinguished_from_a_read() {
        // The distinction that makes a coupling breakdown worth reading: a
        // module that CALLS you is using your interface; one that assigns to
        // your field is reaching past it. Both were previously just `ident`.
        let f = facts(
            Lang::TypeScript,
            "function go(s) { s.total = 1; s.count += 2; read(s.total); }",
        );
        let writes: Vec<_> = f.refs.iter().filter(|r| r.kind == "write").collect();
        assert!(
            writes.iter().any(|r| r.name == "total"),
            "an assignment target is a write: {:?}",
            f.refs
        );
        assert!(
            writes.iter().any(|r| r.name == "count"),
            "a compound assignment is a write too: {writes:?}"
        );
        // The read of the same field must NOT be counted as a write.
        assert_eq!(
            writes.iter().filter(|r| r.name == "total").count(),
            1,
            "reading s.total afterwards is not a second write: {writes:?}"
        );
    }

    #[test]
    fn rust_field_assignment_reads_as_a_write() {
        let f = facts(
            Lang::Rust,
            "fn go(s: &mut S) { s.total = 1; let _ = s.total; }",
        );
        assert!(
            f.refs
                .iter()
                .any(|r| r.name == "total" && r.kind == "write"),
            "{:?}",
            f.refs
        );
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

    // ---------------------------------------------------------------------
    // One extraction test per added language.
    //
    // `LangSet::new()` only proves a query COMPILES. A pattern can name real
    // node types, compile, and match nothing — which produces an index that
    // reports zero symbols for a language while looking healthy. These assert
    // the three facts every other part of the system is built on: a definition
    // is found, a call is attributed to the function it sits in, and visibility
    // is read.
    // ---------------------------------------------------------------------

    /// The call `callee` must be recorded as being made from `from`.
    fn assert_call_from(f: &FileFacts, callee: &str, from: &str) {
        let hit = f
            .refs
            .iter()
            .find(|r| r.name == callee && r.kind == "call")
            .unwrap_or_else(|| panic!("no call to {callee} in {:?}", f.refs));
        assert_eq!(
            hit.from.as_deref(),
            Some(from),
            "call to {callee} was not attributed to {from}"
        );
    }

    #[test]
    fn c_functions_structs_and_macros_are_extracted() {
        let f = facts(
            Lang::C,
            "#define CAP 8\n\
             struct Buf { int len; };\n\
             static int helper(void) { return CAP; }\n\
             int run(void) { return helper(); }\n",
        );
        assert_eq!(sym(&f, "Buf").kind, "struct");
        assert_eq!(sym(&f, "CAP").kind, "macro");
        assert_eq!(sym(&f, "len").kind, "field");
        // C names a function through its declarator, not a `name:` field —
        // this is what `declarator_identifier` exists for.
        assert_call_from(&f, "helper", "run");
        assert!(
            !sym(&f, "helper").exported,
            "`static` confines a C symbol to one translation unit"
        );
        assert!(sym(&f, "run").exported, "external linkage is the default");
    }

    #[test]
    fn cpp_classes_and_out_of_line_methods_land_on_one_symbol() {
        let f = facts(
            Lang::Cpp,
            "namespace app {\n\
             class Grid {\n\
             public:\n\
             void draw();\n\
             };\n\
             void Grid::draw() { paint(); }\n\
             }\n",
        );
        assert_eq!(sym(&f, "Grid").kind, "class");
        // The declaration inside the class and the definition below it are
        // written differently and must produce the same name, or every C++
        // class reads as declarations with no implementations.
        let draws = f.symbols.iter().filter(|s| s.name == "draw").count();
        assert_eq!(draws, 2, "both spellings of the method: {:?}", f.symbols);
        assert_call_from(&f, "paint", "Grid::draw");
    }

    #[test]
    fn a_cpp_destructor_is_not_its_own_constructor() {
        // Reported against a real JUCE codebase: `~PianoRollGrid()` was indexed
        // as `PianoRollGrid`, byte-identical to the constructor, so both came
        // back with the same caller count — the tell that one set was
        // attributed to two different functions. The `~` is the only thing
        // separating them, so the capture must take the whole `destructor_name`
        // node and never the identifier inside it.
        let f = facts(
            Lang::Cpp,
            "class Grid {\n\
             public:\n\
             Grid();\n\
             ~Grid();\n\
             };\n\
             Grid::Grid() {}\n\
             Grid::~Grid() {}\n",
        );
        let names: Vec<&str> = f.symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(
            names.contains(&"~Grid"),
            "the destructor must keep its tilde: {names:?}"
        );
        assert!(
            names.contains(&"Grid"),
            "the constructor must still be indexed: {names:?}"
        );
        // Two distinct functions, so their definition sites must not collide.
        let ctor: Vec<u32> = f
            .symbols
            .iter()
            .filter(|s| s.name == "Grid" && s.kind != "class")
            .map(|s| s.line)
            .collect();
        let dtor: Vec<u32> = f
            .symbols
            .iter()
            .filter(|s| s.name == "~Grid")
            .map(|s| s.line)
            .collect();
        assert!(!ctor.is_empty() && !dtor.is_empty(), "{:?}", f.symbols);
        assert!(
            ctor.iter().all(|l| !dtor.contains(l)),
            "constructor and destructor share a line: ctor {ctor:?} dtor {dtor:?}"
        );
    }

    #[test]
    fn a_cpp_forward_declaration_is_not_a_definition() {
        // `class LicenseManager;` written to break a header cycle was indexed
        // as a definition and competed with the real one — nine candidates for
        // one class, with the declarations credited with the callers and the
        // definition reporting zero. Forward declaration is idiomatic C++, so
        // this reached every file in the project.
        let f = facts(
            Lang::Cpp,
            "class Widget;\n\
             class Owner {\n\
             Widget* w;\n\
             };\n\
             class Widget {\n\
             int x;\n\
             };\n",
        );
        let widgets: Vec<u32> = f
            .symbols
            .iter()
            .filter(|s| s.name == "Widget" && s.kind == "class")
            .map(|s| s.line)
            .collect();
        assert_eq!(
            widgets,
            vec![5],
            "only the definition with a body counts: {:?}",
            f.symbols
        );
    }

    #[test]
    fn a_c_struct_is_defined_where_it_has_a_body() {
        // Same rule one language down, where it also stops every `struct Node*`
        // in a parameter list from registering as a definition.
        let f = facts(
            Lang::C,
            "struct Node;\n\
             void walk(struct Node *n);\n\
             struct Node { int v; };\n\
             enum Mode;\n\
             enum Mode { FAST, SLOW };\n",
        );
        let nodes: Vec<u32> = f
            .symbols
            .iter()
            .filter(|s| s.name == "Node")
            .map(|s| s.line)
            .collect();
        assert_eq!(nodes, vec![3], "{:?}", f.symbols);
        let modes: Vec<u32> = f
            .symbols
            .iter()
            .filter(|s| s.name == "Mode")
            .map(|s| s.line)
            .collect();
        assert_eq!(modes, vec![5], "{:?}", f.symbols);
    }

    #[test]
    fn go_visibility_comes_from_the_names_own_capital() {
        let f = facts(
            Lang::Go,
            "package store\n\
             type Session struct { id string }\n\
             func (s *Session) Close() { s.flush() }\n\
             func flush() {}\n",
        );
        assert_eq!(sym(&f, "Session").kind, "struct");
        assert!(
            sym(&f, "Close").exported,
            "an initial capital IS Go's export"
        );
        assert!(!sym(&f, "flush").exported);
        assert_call_from(&f, "flush", "Session::Close");
    }

    #[test]
    fn java_members_carry_their_class_and_their_modifier() {
        let f = facts(
            Lang::Java,
            "class Store {\n\
             private int size;\n\
             public void save() { flush(); }\n\
             void flush() {}\n\
             }\n",
        );
        assert_eq!(sym(&f, "Store").kind, "class");
        assert_eq!(sym(&f, "save").container.as_deref(), Some("Store"));
        assert!(sym(&f, "save").exported);
        assert!(
            !sym(&f, "flush").exported,
            "no modifier in Java means package-private, which is a real answer"
        );
        assert_call_from(&f, "flush", "Store::save");
    }

    #[test]
    fn csharp_properties_and_invocations_are_extracted() {
        let f = facts(
            Lang::CSharp,
            "namespace App {\n\
             public class Store {\n\
             public int Size { get; set; }\n\
             public void Save() { Flush(); }\n\
             void Flush() {}\n\
             }\n\
             }\n",
        );
        assert_eq!(sym(&f, "Store").kind, "class");
        assert_eq!(sym(&f, "Size").kind, "field");
        assert!(sym(&f, "Save").exported);
        assert!(!sym(&f, "Flush").exported);
        assert_call_from(&f, "Flush", "Store::Save");
    }

    #[test]
    fn ruby_classes_and_method_calls_are_extracted() {
        let f = facts(
            Lang::Ruby,
            "class Store\n\
             def save\n\
             flush\n\
             log.write\n\
             end\n\
             def flush\n\
             end\n\
             end\n",
        );
        assert_eq!(sym(&f, "Store").kind, "class");
        assert_eq!(sym(&f, "save").container.as_deref(), Some("Store"));

        // A call WITH a receiver is unambiguous syntax and reads as a call.
        assert_call_from(&f, "write", "Store::save");

        // A bare `flush` is not. Ruby lets a receiverless call and a local
        // variable read look identical, so tree-sitter reports an `identifier`
        // and only a scope analysis could tell them apart — see the header of
        // ruby.scm. It is still recorded as a reference attributed to the
        // method it sits in, so "what touches flush" is answered; only the
        // call/read distinction is lost.
        let bare = f
            .refs
            .iter()
            .find(|r| r.name == "flush")
            .unwrap_or_else(|| panic!("the reference must survive: {:?}", f.refs));
        assert_eq!(bare.kind, "ident");
        assert_eq!(bare.from.as_deref(), Some("Store::save"));
    }

    #[test]
    fn php_classes_methods_and_imports_are_extracted() {
        let f = facts(
            Lang::Php,
            "<?php\n\
             namespace App;\n\
             use Lib\\Logger;\n\
             class Store {\n\
             private $size;\n\
             public function save() { $this->flush(); }\n\
             private function flush() {}\n\
             }\n",
        );
        assert_eq!(sym(&f, "Store").kind, "class");
        assert!(sym(&f, "save").exported);
        assert!(!sym(&f, "flush").exported);
        assert_call_from(&f, "flush", "Store::save");
        assert!(
            f.imports.iter().any(|i| i.imported == "Logger"),
            "a `use` must bind its name: {:?}",
            f.imports
        );
    }

    #[test]
    fn kotlin_classes_functions_and_calls_are_extracted() {
        let f = facts(
            Lang::Kotlin,
            "package app\n\
             class Store {\n\
             fun save() { flush() }\n\
             private fun flush() {}\n\
             }\n",
        );
        assert_eq!(sym(&f, "Store").kind, "class");
        assert_eq!(sym(&f, "save").container.as_deref(), Some("Store"));
        assert!(sym(&f, "save").exported, "Kotlin is public by default");
        assert!(!sym(&f, "flush").exported);
        assert_call_from(&f, "flush", "Store::save");
    }

    #[test]
    fn swift_types_and_methods_are_extracted() {
        let f = facts(
            Lang::Swift,
            "class Store {\n\
             func save() { flush() }\n\
             private func flush() {}\n\
             }\n",
        );
        assert_eq!(sym(&f, "Store").kind, "class");
        assert_eq!(sym(&f, "save").container.as_deref(), Some("Store"));
        assert!(sym(&f, "save").exported, "Swift defaults to internal");
        assert!(!sym(&f, "flush").exported);
        assert_call_from(&f, "flush", "Store::save");
    }
}
