//! Bounded declaration metadata for explicit code-definition lookups.
//!
//! Signatures and documentation are persisted with the structural index, but
//! they are deliberately not part of outlines or write-tool impact notes. That
//! keeps routine tool results compact while letting an explicit `code`
//! definition request answer without another file read.

use super::lang::Lang;
use tree_sitter::Node;

const MAX_SIGNATURE_CHARS: usize = 320;
const MAX_DOCUMENTATION_CHARS: usize = 400;

pub(super) struct SymbolMetadata {
    pub signature: Option<String>,
    pub documentation: Option<String>,
}

pub(super) fn extract(name: Node<'_>, lang: Lang, symbol_kind: &str, src: &[u8]) -> SymbolMetadata {
    let Some(declaration) = declaration_node(name, lang) else {
        return SymbolMetadata {
            signature: None,
            documentation: None,
        };
    };

    SymbolMetadata {
        signature: symbol_signature(declaration, lang, symbol_kind, src),
        documentation: if lang == Lang::Python {
            python_documentation(declaration, src)
        } else {
            leading_documentation(declaration, text(name, src), lang, src)
        },
    }
}

fn text<'a>(node: Node<'_>, src: &'a [u8]) -> &'a str {
    std::str::from_utf8(&src[node.byte_range()]).unwrap_or("")
}

/// The syntax node that owns one captured definition name.
///
/// Queries deliberately capture the smallest useful node, the name, because
/// references are de-duplicated by that exact byte range. Metadata needs the
/// opposite view: the declaration around that name. Keeping this mapping here
/// avoids adding a second capture contract to every language query.
fn declaration_node<'tree>(name: Node<'tree>, lang: Lang) -> Option<Node<'tree>> {
    let is_declaration = |kind: &str| match lang {
        Lang::Rust => matches!(
            kind,
            "function_item"
                | "function_signature_item"
                | "struct_item"
                | "union_item"
                | "enum_item"
                | "trait_item"
                | "mod_item"
                | "type_item"
                | "const_item"
                | "static_item"
                | "macro_definition"
                | "enum_variant"
                | "field_declaration"
                | "let_declaration"
        ),
        Lang::TypeScript | Lang::Tsx => matches!(
            kind,
            "function_declaration"
                | "generator_function_declaration"
                | "class_declaration"
                | "abstract_class_declaration"
                | "interface_declaration"
                | "type_alias_declaration"
                | "enum_declaration"
                | "module"
                | "method_definition"
                | "abstract_method_signature"
                | "public_field_definition"
                | "property_signature"
                | "variable_declarator"
        ),
        Lang::Python => matches!(
            kind,
            "function_definition" | "class_definition" | "assignment"
        ),
        Lang::C => matches!(
            kind,
            "function_definition"
                | "declaration"
                | "struct_specifier"
                | "union_specifier"
                | "enum_specifier"
                | "enumerator"
                | "type_definition"
                | "field_declaration"
                | "preproc_def"
                | "preproc_function_def"
        ),
        Lang::Cpp => matches!(
            kind,
            "function_definition"
                | "declaration"
                | "field_declaration"
                | "struct_specifier"
                | "union_specifier"
                | "enum_specifier"
                | "enumerator"
                | "type_definition"
                | "preproc_def"
                | "preproc_function_def"
                | "class_specifier"
                | "namespace_definition"
                | "alias_declaration"
                | "concept_definition"
        ),
        Lang::Go => matches!(
            kind,
            "function_declaration"
                | "method_declaration"
                | "type_spec"
                | "const_spec"
                | "var_spec"
                | "field_declaration"
                | "method_elem"
        ),
        Lang::Java => matches!(
            kind,
            "class_declaration"
                | "record_declaration"
                | "interface_declaration"
                | "annotation_type_declaration"
                | "enum_declaration"
                | "enum_constant"
                | "method_declaration"
                | "constructor_declaration"
                | "field_declaration"
                | "local_variable_declaration"
        ),
        Lang::CSharp => matches!(
            kind,
            "class_declaration"
                | "record_declaration"
                | "struct_declaration"
                | "interface_declaration"
                | "enum_declaration"
                | "enum_member_declaration"
                | "delegate_declaration"
                | "method_declaration"
                | "constructor_declaration"
                | "local_function_statement"
                | "property_declaration"
                | "event_declaration"
                | "field_declaration"
                | "namespace_declaration"
        ),
        Lang::Ruby => matches!(
            kind,
            "method" | "singleton_method" | "alias" | "class" | "module" | "assignment"
        ),
        Lang::Php => matches!(
            kind,
            "namespace_definition"
                | "class_declaration"
                | "interface_declaration"
                | "trait_declaration"
                | "enum_declaration"
                | "enum_case"
                | "function_definition"
                | "method_declaration"
                | "property_declaration"
                | "const_element"
        ),
        Lang::Kotlin => matches!(
            kind,
            "class_declaration"
                | "object_declaration"
                | "function_declaration"
                | "property_declaration"
                | "class_parameter"
        ),
        Lang::Swift => matches!(
            kind,
            "class_declaration"
                | "protocol_declaration"
                | "typealias_declaration"
                | "function_declaration"
                | "protocol_function_declaration"
                | "property_declaration"
                | "enum_entry"
        ),
    };

    let mut current = name.parent();
    while let Some(node) = current {
        if is_declaration(node.kind()) {
            return Some(node);
        }
        current = node.parent();
    }
    None
}

fn bounded_text(mut value: String, max_chars: usize) -> String {
    let Some((cut, _)) = value.char_indices().nth(max_chars) else {
        return value;
    };
    if max_chars <= 3 {
        return "...".chars().take(max_chars).collect();
    }
    value.truncate(cut);
    for _ in 0..3 {
        value.pop();
    }
    value.push_str("...");
    value
}

fn normalized_words(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn kotlin_body_start(node: Node<'_>) -> Option<usize> {
    let mut cursor = node.walk();
    let start = node
        .named_children(&mut cursor)
        .find(|child| {
            matches!(
                child.kind(),
                "function_body" | "class_body" | "enum_class_body"
            )
        })
        .map(|child| child.start_byte());
    start
}

/// Start of the executable/type body or initializer that must not enter a
/// signature. This is syntax-aware, so object-shaped return types do not get
/// mistaken for a function body by a textual search for `{`.
fn signature_end(declaration: Node<'_>, lang: Lang, symbol_kind: &str) -> usize {
    if let Some(body) = declaration.child_by_field_name("body") {
        return body.start_byte();
    }
    if lang == Lang::Kotlin {
        if let Some(start) = kotlin_body_start(declaration) {
            return start;
        }
    }

    // `const App = () => {}` owns its body one level below the declarator.
    if let Some(value) = declaration.child_by_field_name("value") {
        if symbol_kind == "function" {
            if let Some(body) = value.child_by_field_name("body") {
                return body.start_byte();
            }
        } else if matches!(symbol_kind, "variable" | "field" | "const") {
            return value.start_byte();
        }
    }
    if matches!(symbol_kind, "variable" | "field" | "const") {
        if let Some(right) = declaration.child_by_field_name("right") {
            return right.start_byte();
        }
    }
    declaration.end_byte()
}

fn symbol_signature(declaration: Node<'_>, lang: Lang, kind: &str, src: &[u8]) -> Option<String> {
    let end = signature_end(declaration, lang, kind).min(declaration.end_byte());
    let raw = std::str::from_utf8(&src[declaration.start_byte()..end]).ok()?;
    let signature = normalized_words(raw)
        .trim_end_matches(|c: char| c.is_whitespace() || matches!(c, '{' | '='))
        .to_string();
    (!signature.is_empty()).then(|| bounded_text(signature, MAX_SIGNATURE_CHARS))
}

fn comment_anchor(mut declaration: Node<'_>) -> Node<'_> {
    while let Some(parent) = declaration.parent() {
        if matches!(parent.kind(), "export_statement" | "decorated_definition") {
            declaration = parent;
        } else {
            break;
        }
    }
    declaration
}

fn is_attribute_node(kind: &str) -> bool {
    matches!(
        kind,
        "attribute_item" | "attribute" | "decorator" | "annotation" | "marker_annotation"
    )
}

fn is_comment_node(kind: &str) -> bool {
    kind.contains("comment")
}

fn first_doc_paragraph(raw: &str) -> String {
    let mut lines = Vec::new();
    let mut started = false;
    for source_line in raw.lines() {
        let mut line = source_line.trim();
        for prefix in ["/**", "/*!", "///", "//!", "//", "#"] {
            if let Some(rest) = line.strip_prefix(prefix) {
                line = rest.trim_start();
                break;
            }
        }
        line = line.strip_suffix("*/").unwrap_or(line).trim_end();
        if let Some(rest) = line.strip_prefix('*') {
            line = rest.trim_start();
        }
        if line.is_empty() {
            if started {
                break;
            }
            continue;
        }
        if started && line.starts_with('@') {
            break;
        }
        started = true;
        lines.push(line);
    }
    normalized_words(&lines.join(" "))
}

fn strip_python_docstring(raw: &str) -> Option<&str> {
    let raw = raw.trim();
    for quote in ["\"\"\"", "'''"] {
        if let Some(start) = raw.find(quote) {
            let content = &raw[start + quote.len()..];
            let end = content.rfind(quote)?;
            return Some(&content[..end]);
        }
    }
    for quote in ['\"', '\''] {
        if raw.starts_with(quote) && raw.ends_with(quote) && raw.len() >= 2 {
            return Some(&raw[1..raw.len() - 1]);
        }
    }
    None
}

fn python_documentation(declaration: Node<'_>, src: &[u8]) -> Option<String> {
    let body = declaration.child_by_field_name("body")?;
    let first = body.named_child(0)?;
    if first.kind() != "expression_statement" {
        return None;
    }
    let raw = text(first, src);
    let documentation = first_doc_paragraph(strip_python_docstring(raw)?);
    (!documentation.is_empty()).then(|| bounded_text(documentation, MAX_DOCUMENTATION_CHARS))
}

fn leading_documentation(
    declaration: Node<'_>,
    name: &str,
    lang: Lang,
    src: &[u8],
) -> Option<String> {
    let mut before = comment_anchor(declaration);
    let mut comments = Vec::new();
    loop {
        let Some(previous) = before.prev_named_sibling() else {
            break;
        };
        if previous.end_position().row + 1 < before.start_position().row {
            break;
        }
        if is_attribute_node(previous.kind()) {
            before = previous;
            continue;
        }
        if !is_comment_node(previous.kind()) {
            break;
        }
        comments.push(text(previous, src));
        before = previous;
    }
    comments.reverse();
    let raw = comments.join("\n");
    let trimmed = raw.trim_start();
    let recognized = if matches!(lang, Lang::Go | Lang::Ruby) {
        trimmed.starts_with(if lang == Lang::Ruby { '#' } else { '/' })
    } else {
        trimmed.starts_with("/**")
            || trimmed.starts_with("/*!")
            || trimmed.starts_with("///")
            || trimmed.starts_with("//!")
    };
    if !recognized {
        return None;
    }
    let documentation = first_doc_paragraph(&raw);
    if lang == Lang::Go && !documentation.starts_with(name) {
        // Go deliberately uses ordinary `//` comments for documentation. Its
        // naming convention is the only reliable separator from an adjacent
        // implementation note or disabled code.
        return None;
    }
    (!documentation.is_empty()).then(|| bounded_text(documentation, MAX_DOCUMENTATION_CHARS))
}

#[cfg(test)]
mod tests {
    use super::bounded_text;

    #[test]
    fn the_ellipsis_stays_inside_the_character_ceiling() {
        let within_limit = "é".repeat(12);
        assert_eq!(bounded_text(within_limit.clone(), 12), within_limit);

        let bounded = bounded_text("é".repeat(20), 12);
        assert_eq!(bounded.chars().count(), 12);
        assert!(bounded.ends_with("..."));
        assert_eq!(bounded_text("abcdef".into(), 2), "..");
    }
}
