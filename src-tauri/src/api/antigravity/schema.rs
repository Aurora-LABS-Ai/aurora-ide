//! Tool parameter schemas in the subset Gemini's `functionDeclarations`
//! accept.
//!
//! Gemini's `Schema` is a fixed proto, not JSON Schema: any keyword it has no
//! field for (`additionalProperties`, `$ref`, `const`, `anyOf` on most paths,
//! `x-…` extensions) fails the WHOLE request with "Unknown name …: Cannot
//! find field", and Claude models behind the same endpoint additionally
//! refuse `default` and `examples` in VALIDATED mode. MCP servers write all
//! of those routinely, so every schema is rebuilt from an allow-list.
//!
//! The steps follow 9router's `cleanJSONSchemaForAntigravity`, with one
//! difference that matters: 9router deletes forbidden keywords wherever they
//! appear as a key, which also deletes a PARAMETER named `title`, `format` or
//! `default`. This walks schema positions only (`properties.*`, `items`), so a
//! parameter's name is never mistaken for a keyword.

use serde_json::{Map, Value};

/// The keywords that survive. Everything else on a schema node is dropped.
const ALLOWED: &[&str] = &[
    "type",
    "description",
    "enum",
    "properties",
    "required",
    "items",
    "nullable",
    "minimum",
    "maximum",
    "pattern",
];

/// The cleaned `parameters` for one tool, or `None` when the tool takes no
/// arguments (Gemini wants the field absent then, not an empty object).
#[must_use]
pub fn clean_parameters(schema: &Value) -> Option<Value> {
    let mut node = schema.clone();
    clean_node(&mut node, 0);
    let has_properties = node
        .get("properties")
        .and_then(Value::as_object)
        .is_some_and(|p| !p.is_empty());
    has_properties.then_some(node)
}

/// Deep enough for any real tool; a self-referencing schema stops here.
const MAX_DEPTH: u32 = 24;

fn clean_node(node: &mut Value, depth: u32) {
    let Some(obj) = node.as_object_mut() else {
        // `true` / `{}`-like leaves: accept anything, described as a string.
        *node = serde_json::json!({ "type": "string" });
        return;
    };
    if depth > MAX_DEPTH {
        obj.clear();
        obj.insert("type".into(), Value::String("string".into()));
        return;
    }

    if let Some(constant) = obj.remove("const") {
        obj.entry("enum")
            .or_insert_with(|| Value::Array(vec![constant]));
    }
    merge_all_of(obj);
    flatten_union(obj, "anyOf");
    flatten_union(obj, "oneOf");
    flatten_type_array(obj);
    prefix_items_to_items(obj);

    if let Some(Value::Array(values)) = obj.get_mut("enum") {
        for value in values.iter_mut() {
            if !value.is_string() {
                let rendered = match &*value {
                    Value::Null => "null".to_string(),
                    other => other.to_string(),
                };
                *value = Value::String(rendered);
            }
        }
        obj.entry("type")
            .or_insert_with(|| Value::String("string".into()));
    }
    if obj.contains_key("properties") {
        obj.entry("type")
            .or_insert_with(|| Value::String("object".into()));
    }
    if obj.get("type").and_then(Value::as_str) == Some("array") && !obj.contains_key("items") {
        obj.insert("items".into(), serde_json::json!({ "type": "string" }));
    }

    obj.retain(|key, _| ALLOWED.contains(&key.as_str()));

    if let Some(Value::Object(properties)) = obj.get_mut("properties") {
        for child in properties.values_mut() {
            clean_node(child, depth + 1);
        }
    } else {
        obj.remove("properties");
    }
    if let Some(items) = obj.get_mut("items") {
        if items.is_array() {
            // Tuple form: Gemini has no tuples; the first slot stands for all.
            *items = items
                .as_array()
                .and_then(|a| a.first())
                .cloned()
                .unwrap_or(Value::Null);
        }
        clean_node(items, depth + 1);
    }

    let names: Vec<String> = obj
        .get("properties")
        .and_then(Value::as_object)
        .map(|p| p.keys().cloned().collect())
        .unwrap_or_default();
    let required: Vec<Value> = obj
        .get("required")
        .and_then(Value::as_array)
        .map(|r| {
            r.iter()
                .filter(|v| v.as_str().is_some_and(|n| names.iter().any(|p| p == n)))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    if required.is_empty() {
        obj.remove("required");
    } else {
        obj.insert("required".into(), Value::Array(required));
    }

    if obj.get("type").is_none() {
        obj.insert("type".into(), Value::String("string".into()));
    }
}

/// `allOf: [A, B]` → A's and B's properties and required lists on the node.
fn merge_all_of(obj: &mut Map<String, Value>) {
    let Some(Value::Array(parts)) = obj.remove("allOf") else {
        return;
    };
    for part in parts {
        let Value::Object(part) = part else { continue };
        if let Some(Value::Object(props)) = part.get("properties") {
            let target = obj
                .entry("properties")
                .or_insert_with(|| Value::Object(Map::new()));
            if let Some(target) = target.as_object_mut() {
                for (k, v) in props {
                    target.insert(k.clone(), v.clone());
                }
            }
        }
        if let Some(Value::Array(req)) = part.get("required") {
            let target = obj
                .entry("required")
                .or_insert_with(|| Value::Array(Vec::new()));
            if let Some(target) = target.as_array_mut() {
                for r in req {
                    if !target.contains(r) {
                        target.push(r.clone());
                    }
                }
            }
        }
        if let Some(t) = part.get("type") {
            obj.entry("type").or_insert_with(|| t.clone());
        }
    }
}

/// `anyOf`/`oneOf` → the richest non-null branch, merged onto the node. An
/// object beats an array beats a scalar, the same ranking 9router uses.
fn flatten_union(obj: &mut Map<String, Value>, key: &str) {
    let Some(Value::Array(branches)) = obj.remove(key) else {
        return;
    };
    let rank = |b: &Value| -> i32 {
        let t = b.get("type").and_then(Value::as_str);
        if t == Some("object") || b.get("properties").is_some() {
            3
        } else if t == Some("array") || b.get("items").is_some() {
            2
        } else if t.is_some_and(|t| t != "null") || b.get("enum").is_some() {
            1
        } else {
            0
        }
    };
    let best = branches
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) != Some("null"))
        .enumerate()
        .max_by_key(|(i, b)| (rank(b), -(*i as i32)))
        .map(|(_, b)| b.clone());
    if let Some(Value::Object(branch)) = best {
        for (k, v) in branch {
            // The node's own description says what the parameter is FOR;
            // the branch's says what one alternative looks like.
            if k == "description" && obj.contains_key("description") {
                continue;
            }
            obj.insert(k, v);
        }
    }
}

/// `type: ["string", "null"]` → `string`.
fn flatten_type_array(obj: &mut Map<String, Value>) {
    if let Some(Value::Array(types)) = obj.get("type") {
        let first = types
            .iter()
            .filter_map(Value::as_str)
            .find(|t| *t != "null")
            .unwrap_or("string")
            .to_string();
        obj.insert("type".into(), Value::String(first));
    }
}

fn prefix_items_to_items(obj: &mut Map<String, Value>) {
    if let Some(Value::Array(slots)) = obj.remove("prefixItems") {
        if !obj.contains_key("items") {
            if let Some(first) = slots
                .into_iter()
                .find(|s| s.get("type").and_then(Value::as_str) != Some("null"))
            {
                obj.insert("items".into(), first);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_parameter_named_like_a_keyword_survives() {
        let cleaned = clean_parameters(&json!({
            "type": "object",
            "properties": {
                "title": { "type": "string", "title": "Title", "default": "x" },
                "format": { "type": "string", "format": "uri" }
            },
            "required": ["title"]
        }))
        .expect("has parameters");
        assert_eq!(
            cleaned,
            json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "format": { "type": "string" }
                },
                "required": ["title"]
            })
        );
    }

    #[test]
    fn unions_refs_and_extensions_become_something_gemini_reads() {
        let cleaned = clean_parameters(&json!({
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "additionalProperties": false,
            "x-origin": "mcp",
            "properties": {
                "path": { "type": ["string", "null"], "description": "Where" },
                "mode": { "const": 2 },
                "limit": { "anyOf": [{ "type": "null" }, { "type": "integer", "minimum": 1 }], "description": "How many" },
                "tags": { "type": "array", "uniqueItems": true },
                "pair": { "type": "array", "prefixItems": [{ "type": "number" }, { "type": "number" }] },
                "opts": { "allOf": [
                    { "properties": { "a": { "type": "boolean" } }, "required": ["a"] },
                    { "properties": { "b": { "$ref": "#/defs/b" } } }
                ] }
            },
            "required": ["path", "missing"]
        }))
        .expect("has parameters");
        let p = &cleaned["properties"];
        assert_eq!(
            p["path"],
            json!({ "type": "string", "description": "Where" })
        );
        assert_eq!(p["mode"], json!({ "type": "string", "enum": ["2"] }));
        assert_eq!(
            p["limit"],
            json!({ "type": "integer", "minimum": 1, "description": "How many" })
        );
        assert_eq!(
            p["tags"],
            json!({ "type": "array", "items": { "type": "string" } })
        );
        assert_eq!(
            p["pair"],
            json!({ "type": "array", "items": { "type": "number" } })
        );
        assert_eq!(p["opts"]["type"], "object");
        assert_eq!(p["opts"]["required"], json!(["a"]));
        assert_eq!(p["opts"]["properties"]["b"], json!({ "type": "string" }));
        assert_eq!(
            cleaned["required"],
            json!(["path"]),
            "unknown names dropped"
        );
        assert!(cleaned.get("additionalProperties").is_none());
        assert!(cleaned.get("$schema").is_none());
        assert!(cleaned.get("x-origin").is_none());
    }

    #[test]
    fn a_tool_without_arguments_sends_no_parameters() {
        assert!(clean_parameters(&json!({ "type": "object", "properties": {} })).is_none());
        assert!(clean_parameters(&json!({ "type": "object" })).is_none());
        assert!(clean_parameters(&json!({})).is_none());
    }
}
