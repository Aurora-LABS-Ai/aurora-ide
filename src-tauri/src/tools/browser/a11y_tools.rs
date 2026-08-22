//! Accessibility-tree inspection for the Browser panel.
//!
//! The accessibility tree is computed by the browser engine from the DOM,
//! ARIA, and layout together. It is NOT readable from the page: an element's
//! accessible name can come from `aria-label`, `aria-labelledby`, a `<label>`,
//! its own text, a `title`, or a placeholder, and the precedence between them
//! is the engine's. Reading attributes in script reconstructs a guess.
//!
//! This is what turns "keyboard navigation verified" from a claim into
//! evidence: it reports what a screen reader would actually announce, which
//! control is actually focusable, and which interactive elements have no
//! accessible name at all.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::services::browser_runtime::BrowserManager;

use super::{ensure_agent_browser, AGENT_BROWSER_LABEL};

/// Cap on nodes returned in one call.
///
/// A real page yields thousands of nodes; the full tree would blow the
/// tool-result budget and bury the handful of rows an audit needs. When the
/// cap bites, the result says so AND names the recovery — a truncation that
/// does not announce itself reads as "this is everything".
const MAX_NODES: usize = 300;

/// Roles that carry no information for an audit. `generic`/`none` are the
/// engine's word for "a div"; there are hundreds per page.
fn is_noise(role: &str) -> bool {
    matches!(
        role,
        "generic" | "none" | "presentation" | "InlineTextBox" | "StaticText"
    )
}

/// Roles a user can operate. An interactive node with no accessible name is
/// the single most common real accessibility defect, so these are flagged.
fn is_interactive(role: &str) -> bool {
    matches!(
        role,
        "button"
            | "link"
            | "textbox"
            | "checkbox"
            | "radio"
            | "combobox"
            | "listbox"
            | "menuitem"
            | "menuitemcheckbox"
            | "menuitemradio"
            | "slider"
            | "spinbutton"
            | "switch"
            | "tab"
            | "searchbox"
    )
}

/// Pull `{ value: { value: X } }` out of a CDP AX property.
fn ax_value(node: &Value, key: &str) -> Option<String> {
    node.get(key)
        .and_then(|v| v.get("value"))
        .and_then(|v| match v {
            Value::String(s) => Some(s.clone()),
            Value::Bool(b) => Some(b.to_string()),
            Value::Number(n) => Some(n.to_string()),
            _ => None,
        })
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Named property from the node's `properties` array.
fn ax_property(node: &Value, name: &str) -> Option<Value> {
    node.get("properties")?
        .as_array()?
        .iter()
        .find(|p| p.get("name").and_then(Value::as_str) == Some(name))
        .and_then(|p| p.get("value"))
        .and_then(|v| v.get("value"))
        .cloned()
}

/// Flatten CDP's `Accessibility.getFullAXTree` into audit-shaped rows.
///
/// Returns `(rows, total_meaningful, unnamed_interactive)`.
pub(crate) fn flatten_ax_tree(nodes: &[Value], limit: usize) -> (Vec<Value>, usize, usize) {
    let mut rows = Vec::new();
    let mut total = 0usize;
    let mut unnamed = 0usize;

    for node in nodes {
        // An ignored node is hidden from assistive tech entirely — reporting
        // it as part of the tree would be actively misleading.
        if node.get("ignored").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let Some(role) = ax_value(node, "role") else {
            continue;
        };
        if is_noise(&role) {
            continue;
        }
        total += 1;

        let name = ax_value(node, "name");
        let interactive = is_interactive(&role);
        let missing_name = interactive && name.is_none();
        if missing_name {
            unnamed += 1;
        }
        if rows.len() >= limit {
            continue;
        }

        let mut row = json!({ "role": role });
        if let Some(name) = name {
            row["name"] = json!(name.chars().take(80).collect::<String>());
        }
        if let Some(description) = ax_value(node, "description") {
            row["description"] = json!(description.chars().take(80).collect::<String>());
        }
        if let Some(value) = ax_value(node, "value") {
            row["value"] = json!(value.chars().take(40).collect::<String>());
        }
        for (cdp, out) in [
            ("focusable", "focusable"),
            ("focused", "focused"),
            ("disabled", "disabled"),
            ("checked", "checked"),
            ("expanded", "expanded"),
            ("required", "required"),
            ("invalid", "invalid"),
            ("level", "level"),
        ] {
            if let Some(value) = ax_property(node, cdp) {
                // `false` on a boolean state is the default and adds nothing;
                // dropping it keeps the rows readable.
                if value != Value::Bool(false) {
                    row[out] = value;
                }
            }
        }
        if missing_name {
            row["problem"] = json!("interactive element with no accessible name");
        }
        rows.push(row);
    }

    (rows, total, unnamed)
}

pub struct BrowserAccessibilityTreeTool {
    manager: Arc<BrowserManager>,
}
impl BrowserAccessibilityTreeTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self {
        Self { manager }
    }
}

#[async_trait]
impl ToolExecutor for BrowserAccessibilityTreeTool {
    fn name(&self) -> &str {
        "browser_a11y_tree"
    }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_a11y_tree".into(),
            description: "Read what a screen reader would announce for the page in the Browser \
                panel: every meaningful element's role, accessible name, focusable/disabled/\
                checked/expanded state, and heading levels. This is the engine's own computed \
                tree, not attributes read off the DOM, so it reflects the real name-resolution \
                rules. Interactive elements with NO accessible name are flagged — that is the \
                most common real accessibility defect. Use it to back up accessibility claims \
                with evidence instead of asserting them. Windows only."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "interactiveOnly": {
                        "type": "boolean",
                        "description": "Return only elements a user can operate (buttons, links, inputs, tabs...). Best first look at a large page."
                    },
                    "role": {
                        "type": "string",
                        "description": "Return only this ARIA role, e.g. \"heading\" to audit document structure or \"button\" to check every button has a name."
                    }
                },
                "required": []
            }),
        }
    }
    fn requires_permission(&self) -> bool {
        true
    }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        ensure_agent_browser(&self.manager, None).await?;

        // The Accessibility domain is LAZY: with it disabled, the engine
        // serves whatever partial AX tree it happens to have materialized, and
        // two reads of one static page can disagree — measured live as 2 named
        // interactive elements where an earlier read of the same page returned
        // 11 (aurora-tool-findings.md, 2026-08-22). Enabling forces a full
        // tree build before the read. Idempotent, so it rides every call.
        self.manager
            .call_devtools(AGENT_BROWSER_LABEL, "Accessibility.enable", Value::Null)
            .await
            .map_err(|e| {
                ToolError::Execution(format!(
                    "could not enable the accessibility domain, so the tree would be \
                     unreliable: {e}"
                ))
            })?;

        let response = self
            .manager
            .call_devtools(
                AGENT_BROWSER_LABEL,
                "Accessibility.getFullAXTree",
                Value::Null,
            )
            .await
            .map_err(ToolError::Execution)?;

        let nodes = response
            .get("nodes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if nodes.is_empty() {
            return Err(ToolError::Execution(
                "the browser returned an empty accessibility tree. Make sure a page is loaded \
                 (browser_navigate) before inspecting it."
                    .into(),
            ));
        }

        let (mut rows, total, unnamed) = flatten_ax_tree(&nodes, MAX_NODES);

        let interactive_only = input
            .get("interactiveOnly")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let role_filter = input.get("role").and_then(Value::as_str);
        if interactive_only || role_filter.is_some() {
            rows.retain(|row| {
                let role = row.get("role").and_then(Value::as_str).unwrap_or("");
                let by_role = role_filter.is_none_or(|want| role == want);
                let by_interactive = !interactive_only || is_interactive(role);
                by_role && by_interactive
            });
        }

        let mut out = json!({
            "elements": rows,
            "totalMeaningfulElements": total,
            "interactiveWithoutName": unnamed,
        });
        if total > MAX_NODES {
            out["truncated"] = json!(format!(
                "Showing {MAX_NODES} of {total} elements. Narrow with interactiveOnly: true or a \
                 role filter to see the rest."
            ));
        }
        Ok(out.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(role: &str, name: Option<&str>, ignored: bool) -> Value {
        let mut n = json!({
            "role": { "type": "role", "value": role },
            "ignored": ignored,
        });
        if let Some(name) = name {
            n["name"] = json!({ "type": "computedString", "value": name });
        }
        n
    }

    #[test]
    fn ignored_nodes_are_dropped() {
        // An ignored node is invisible to assistive tech; listing it would
        // claim coverage the user does not have.
        let nodes = vec![
            node("button", Some("Save"), true),
            node("link", Some("Home"), false),
        ];
        let (rows, total, _) = flatten_ax_tree(&nodes, 100);
        assert_eq!(total, 1);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["role"], "link");
    }

    #[test]
    fn structural_noise_is_dropped() {
        let nodes = vec![
            node("generic", None, false),
            node("none", None, false),
            node("StaticText", Some("hello"), false),
            node("heading", Some("Pricing"), false),
        ];
        let (rows, total, _) = flatten_ax_tree(&nodes, 100);
        assert_eq!(total, 1, "only the heading is meaningful");
        assert_eq!(rows[0]["name"], "Pricing");
    }

    #[test]
    fn an_interactive_element_with_no_name_is_flagged() {
        // The most common real accessibility defect, and invisible in a
        // screenshot — an icon button that announces nothing.
        let nodes = vec![
            node("button", None, false),
            node("button", Some("Close"), false),
        ];
        let (rows, _, unnamed) = flatten_ax_tree(&nodes, 100);
        assert_eq!(unnamed, 1);
        assert_eq!(
            rows[0]["problem"],
            "interactive element with no accessible name"
        );
        assert!(rows[1].get("problem").is_none());
    }

    #[test]
    fn a_non_interactive_element_without_a_name_is_not_flagged() {
        // A nameless region is not automatically a defect the way a nameless
        // button is.
        let nodes = vec![node("paragraph", None, false)];
        let (_, _, unnamed) = flatten_ax_tree(&nodes, 100);
        assert_eq!(unnamed, 0);
    }

    #[test]
    fn truncation_still_counts_everything() {
        // The cap limits what is RETURNED, never what is COUNTED — otherwise
        // "3 unnamed buttons" would silently mean "3 in the first 300".
        let nodes: Vec<Value> = (0..50).map(|_| node("button", None, false)).collect();
        let (rows, total, unnamed) = flatten_ax_tree(&nodes, 10);
        assert_eq!(rows.len(), 10, "rows are capped");
        assert_eq!(total, 50, "the count is not");
        assert_eq!(unnamed, 50, "nor is the defect count");
    }

    #[test]
    fn default_false_states_are_omitted() {
        let mut n = node("checkbox", Some("Remember me"), false);
        n["properties"] = json!([
            { "name": "focusable", "value": { "type": "boolean", "value": true } },
            { "name": "disabled", "value": { "type": "boolean", "value": false } },
        ]);
        let (rows, _, _) = flatten_ax_tree(&[n], 100);
        assert_eq!(rows[0]["focusable"], true);
        assert!(
            rows[0].get("disabled").is_none(),
            "a false default is noise, not information"
        );
    }
}
