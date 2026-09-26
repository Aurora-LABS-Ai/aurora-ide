//! Lexical evidence for references. This does not infer types: it records local
//! bindings and receivers whose type is written in the source.

use super::super::lang::Lang;
use tree_sitter::Node;

#[derive(Debug)]
struct Binding {
    name: String,
    position: (u32, u32),
    start: usize,
    end: usize,
    receiver_type: Option<String>,
}

#[derive(Default)]
pub(super) struct Scopes {
    bindings: Vec<Binding>,
    namespaces: std::collections::HashSet<String>,
}

fn text<'a>(node: Node<'_>, source: &'a [u8]) -> &'a str {
    std::str::from_utf8(&source[node.byte_range()]).unwrap_or("")
}

fn callable(kind: &str) -> bool {
    matches!(
        kind,
        "function_declaration"
            | "generator_function_declaration"
            | "function_expression"
            | "arrow_function"
            | "method_definition"
            | "function_item"
            | "closure_expression"
            | "function_definition"
            | "lambda"
    )
}

fn scope(mut node: Node<'_>, function_only: bool) -> Node<'_> {
    while let Some(parent) = node.parent() {
        node = parent;
        if callable(node.kind())
            || matches!(node.kind(), "program" | "source_file" | "module")
            || (!function_only
                && matches!(
                    node.kind(),
                    "statement_block" | "block" | "for_statement" | "for_in_statement" | "class_definition"
                ))
        {
            return node;
        }
    }
    node
}

fn simple_type(node: Node<'_>, source: &[u8]) -> Option<String> {
    match node.kind() {
        "type_identifier" | "identifier" => Some(text(node, source).to_owned()),
        "type_annotation" | "reference_type" | "generic_type" | "parenthesized_type" => {
            let inner = node
                .child_by_field_name("type")
                .or_else(|| node.named_child(0))?;
            simple_type(inner, source)
        }
        _ => None,
    }
}

impl Scopes {
    pub(super) fn collect(root: Node<'_>, source: &[u8], lang: Lang) -> Self {
        if !matches!(lang, Lang::TypeScript | Lang::Tsx | Lang::Rust | Lang::Python) {
            return Self::default();
        }
        let mut result = Self::default();
        let mut stack = vec![root];
        let mut assigned = std::collections::HashSet::new();
        while let Some(node) = stack.pop() {
            if node.kind() == "namespace_import" {
                if let Some(name) = node.named_child(0) {
                    result.namespaces.insert(text(name, source).to_owned());
                }
            }
            let (pattern, owner, annotation) = match node.kind() {
                "parameters" | "lambda_parameters" if lang == Lang::Python => (Some(node), scope(node, true), None),
                "assignment" if lang == Lang::Python => (node.child_by_field_name("left"), scope(node, true), None),
                "function_definition" | "class_definition" if lang == Lang::Python => (node.child_by_field_name("name"), scope(node, false), None),
                "required_parameter" | "optional_parameter" | "parameter" => (
                    node.child_by_field_name("pattern")
                        .or_else(|| node.child_by_field_name("name")),
                    scope(node, true),
                    node.child_by_field_name("type")
                        .and_then(|ty| simple_type(ty, source)),
                ),
                "variable_declarator" | "let_declaration" => {
                    let explicit = node
                        .child_by_field_name("type")
                        .and_then(|ty| simple_type(ty, source));
                    // Only an immutable JS binding provides reliable constructor evidence.
                    let immutable = node
                        .parent()
                        .is_some_and(|p| text(p, source).trim_start().starts_with("const "));
                    let constructed = immutable
                        .then(|| node.child_by_field_name("value"))
                        .flatten()
                        .filter(|value| value.kind() == "new_expression")
                        .and_then(|value| value.child_by_field_name("constructor"))
                        .and_then(|ty| simple_type(ty, source));
                    let function_only = node
                        .parent()
                        .is_some_and(|p| text(p, source).trim_start().starts_with("var "));
                    (
                        node.child_by_field_name("name")
                            .or_else(|| node.child_by_field_name("pattern")),
                        scope(node, function_only),
                        explicit.or(constructed),
                    )
                }
                "function_declaration"
                | "generator_function_declaration"
                | "function_item"
                | "class_declaration" => {
                    (node.child_by_field_name("name"), scope(node, false), None)
                }
                "arrow_function" => (node.child_by_field_name("parameter"), node, None),
                _ => (None, root, None),
            };
            if let Some(pattern) = pattern {
                result.add_pattern(pattern, owner, annotation, source);
            }
            if matches!(
                node.kind(),
                "assignment_expression" | "augmented_assignment_expression" | "update_expression"
            ) {
                if let Some(target) = node
                    .child_by_field_name("left")
                    .or_else(|| node.child_by_field_name("argument"))
                {
                    if target.kind() == "identifier" {
                        assigned.insert(text(target, source).to_owned());
                    }
                }
            }
            let mut cursor = node.walk();
            stack.extend(node.named_children(&mut cursor));
        }
        for binding in &mut result.bindings {
            if assigned.contains(&binding.name) {
                binding.receiver_type = None;
            }
        }
        result
    }

    fn add_pattern(
        &mut self,
        pattern: Node<'_>,
        owner: Node<'_>,
        annotation: Option<String>,
        source: &[u8],
    ) {
        match pattern.kind() {
            "identifier" | "type_identifier" | "shorthand_property_identifier_pattern" => {
                let position = pattern.start_position();
                self.bindings.push(Binding {
                    name: text(pattern, source).to_owned(),
                    position: (position.row as u32 + 1, position.column as u32 + 1),
                    start: owner.start_byte(),
                    end: owner.end_byte(),
                    receiver_type: annotation,
                });
            }
            "pair_pattern" => {
                if let Some(value) = pattern.child_by_field_name("value") {
                    self.add_pattern(value, owner, None, source);
                }
            }
            "assignment_pattern" => {
                if let Some(left) = pattern.child_by_field_name("left") {
                    self.add_pattern(left, owner, None, source);
                }
            }
            "default_parameter" | "typed_default_parameter" | "typed_parameter" => {
                if let Some(name) = pattern.child_by_field_name("name").or_else(|| pattern.named_child(0)) {
                    self.add_pattern(name, owner, None, source);
                }
            }
            "object_pattern" | "array_pattern" | "tuple_pattern" | "rest_pattern"
            | "ref_pattern" | "mut_pattern" | "parameters" | "lambda_parameters" | "list_splat_pattern" | "dictionary_splat_pattern" | "pattern_list" => {
                let mut cursor = pattern.walk();
                for child in pattern.named_children(&mut cursor) {
                    self.add_pattern(child, owner, None, source);
                }
            }
            _ => {}
        }
    }

    fn lookup(&self, name: &str, byte: usize) -> Option<&Binding> {
        self.bindings
            .iter()
            .filter(|b| b.name == name && b.start <= byte && byte < b.end)
            .min_by_key(|b| (b.end - b.start, std::cmp::Reverse(b.position)))
    }

    pub(super) fn binding(&self, node: Node<'_>, source: &[u8]) -> Option<(u32, u32)> {
        if node.kind() == "type_identifier" {
            return None;
        }
        let binding_node = node
            .parent()
            .and_then(|parent| match parent.kind() {
                "member_expression" if parent.child_by_field_name("property") == Some(node) => {
                    parent.child_by_field_name("object")
                }
                "field_expression" if parent.child_by_field_name("field") == Some(node) => {
                    parent.child_by_field_name("value")
                }
                _ => None,
            })
            .unwrap_or(node);
        self.lookup(text(binding_node, source), node.start_byte())
            .map(|b| b.position)
    }

    pub(super) fn receiver(
        &self,
        node: Node<'_>,
        source: &[u8],
    ) -> (Option<String>, Option<String>, bool) {
        let Some(parent) = node.parent() else {
            return (None, None, false);
        };
        let receiver = match parent.kind() {
            "member_expression" if parent.child_by_field_name("property") == Some(node) => {
                parent.child_by_field_name("object")
            }
            "field_expression" if parent.child_by_field_name("field") == Some(node) => {
                parent.child_by_field_name("value")
            }
            "scoped_identifier" if parent.child_by_field_name("name") == Some(node) => {
                parent.child_by_field_name("path")
            }
            "attribute" if parent.child_by_field_name("attribute") == Some(node) => parent.child_by_field_name("object"),
            "selector_expression" if parent.child_by_field_name("field") == Some(node) => parent.child_by_field_name("operand"),
            "method_invocation" if parent.child_by_field_name("name") == Some(node) => parent.child_by_field_name("object"),
            "field_access" if parent.child_by_field_name("field") == Some(node) => parent.child_by_field_name("object"),
            _ => None,
        };
        let Some(receiver) = receiver else {
            return (None, None, false);
        };
        let name = text(receiver, source);
        let ty = if matches!(name, "this" | "self") {
            let mut ancestor = parent;
            let mut ty = None;
            while let Some(next) = ancestor.parent() {
                ancestor = next;
                if matches!(ancestor.kind(), "class_declaration" | "impl_item") {
                    ty = ancestor
                        .child_by_field_name("name")
                        .or_else(|| ancestor.child_by_field_name("type"))
                        .and_then(|ty| simple_type(ty, source));
                    break;
                }
            }
            ty
        } else {
            self.lookup(name, node.start_byte())
                .and_then(|b| b.receiver_type.clone())
        };
        let namespace =
            (self.namespaces.contains(name) || parent.kind() == "scoped_identifier") && self.lookup(name, node.start_byte()).is_none();
        (Some(name.to_owned()), ty, namespace)
    }
}
