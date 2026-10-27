//! The context a client attaches to one message, built in the engine.
//!
//! Today `useAgentWindowSend` joins five blocks into `ideContext`, which the
//! runtime saves on the message as `aurora_context`: the files open in the
//! Files panel, the inspector picks in full, the rules the user attached with
//! `/`, the MCP servers they named, and `/image`. Phase 3.5 of
//! `DOCS/rust-core-extraction.md`.
//!
//! The client sends the facts ([`MessageContextFacts`], plus the attached rule
//! file names already on the request) and the engine renders the same text:
//! a port of `send/context-blocks.ts` and `buildSelectionContext`
//! (`useAgentSelectionStore.ts`). Proven against `golden/context/` (written by
//! `agent-context.golden.test.ts`), then in shadow on real turns
//! ([`report_shadow_context`]).
//!
//! String lengths and cuts follow JavaScript (UTF-16 units, `trim`,
//! `Math.round`) so the bytes match on any input, not only ASCII.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::project_rules::{js_trim, load_project_rules, utf16_len, utf16_prefix};

/// How much of a picked element's own HTML rides to the model
/// (`SELECTION_HTML_MAX_CHARS`).
const SELECTION_HTML_MAX_CHARS: usize = 2000;
/// How much of its visible text (`SELECTION_TEXT_MAX_CHARS`).
const SELECTION_TEXT_MAX_CHARS: usize = 400;
/// Attributes shown besides id and class (`SELECTION_ATTRIBUTES_MAX`).
const SELECTION_ATTRIBUTES_MAX: usize = 12;

/// What the client knows about the message that the engine does not.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MessageContextFacts {
    /// Paths open in the Files panel, in tab order (none in Aurora Chat).
    pub open_files: Vec<String>,
    /// The one being looked at, when the dock shows a file.
    pub active_file: Option<String>,
    /// The inspector picks, numbered as the user sees them.
    pub picked_elements: Vec<PickedEntry>,
    /// MCP servers named with `/`, by display name.
    pub mcp_server_names: Vec<String>,
    /// `/image` was attached.
    pub image_requested: bool,
}

/// `SelectedEntry` without its store id.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PickedEntry {
    /// 1-based, the number the user's `@element:N` refers to.
    pub index: u32,
    pub element: PickedElement,
}

/// `PickedElement` (`browser-service.ts`): the fields the block reads.
/// Others the window sends (`label`, `source`, `note`) are ignored.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PickedElement {
    pub selector: String,
    pub tag_name: String,
    pub id: Option<String>,
    pub class_name: Option<String>,
    pub text: Option<String>,
    pub outer_html: Option<String>,
    pub url: Option<String>,
    pub bounding_rect: Option<BoundingRect>,
    pub attributes: Option<Vec<NamedValue>>,
    pub path: Option<String>,
    pub styles: Option<Vec<NamedValue>>,
    pub parent: Option<String>,
    pub siblings: Option<Vec<String>>,
    pub framework: Option<String>,
    pub component: Option<String>,
    pub props: Option<Vec<NamedValue>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct BoundingRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// `PickedElementAttribute`: an attribute, a prop or a computed style.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct NamedValue {
    pub name: String,
    pub value: String,
}

/// The message's context as the window sends it: the blocks that exist, in
/// this order, a blank line between them; `None` when there is none.
/// Reads the attached rule files, so call it off the async threads.
#[must_use]
pub fn compose_message_context(
    facts: &MessageContextFacts,
    workspace: Option<&Path>,
    attached_rule_files: &[String],
) -> Option<String> {
    let blocks = [
        open_files_block(&facts.open_files, facts.active_file.as_deref()),
        selection_block(&facts.picked_elements),
        rule_block(workspace, attached_rule_files),
        mcp_block(&facts.mcp_server_names),
        image_block(facts.image_requested),
    ];
    let present: Vec<String> = blocks.into_iter().flatten().collect();
    (!present.is_empty()).then(|| present.join("\n\n"))
}

/// `buildOpenFilesContext`: names only, the shown one marked.
fn open_files_block(paths: &[String], active: Option<&str>) -> Option<String> {
    let open: Vec<&str> = paths.iter().map(|path| js_trim(path)).filter(|path| !path.is_empty()).collect();
    if open.is_empty() {
        return None;
    }
    let rows: Vec<String> = open
        .iter()
        .map(|path| format!("- {path}{}", if Some(*path) == active { "  (showing)" } else { "" }))
        .collect();
    Some(format!(
        "<open_files count=\"{}\">\nOpen in the user's Files panel right now. Filenames only — read one with file_read if you need what is in it.\n\n{}\n</open_files>",
        open.len(),
        rows.join("\n")
    ))
}

/// `buildSelectionContext`.
fn selection_block(entries: &[PickedEntry]) -> Option<String> {
    if entries.is_empty() {
        return None;
    }
    let mut lines = vec![
        "<selected_elements>".to_string(),
        "The user picked these elements in the in-app browser. A token like".into(),
        "`@element:2` in their message marks WHERE in the sentence they meant the".into(),
        "element with index=\"2\" below. First LOCATE the source file(s) in this".into(),
        "workspace that render them — search (grep) by the component name, the id,".into(),
        "the class names, or the visible text — then make the requested change in".into(),
        "that source. `size` and `styles` are what the element looks like on the".into(),
        "page right now; `siblings` is the row it sits in, the pick marked.".into(),
    ];
    lines.extend(entries.iter().map(format_selected_element));
    lines.push("</selected_elements>".into());
    Some(lines.join("\n"))
}

/// A JavaScript string is "there" when it is not empty.
fn present(value: Option<&String>) -> Option<&str> {
    value.map(String::as_str).filter(|s| !s.is_empty())
}

/// `Math.round`: half rounds up, and `-0` prints as `0`.
fn js_round(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

/// `name=value; name=value`, values with `;` or newlines flattened
/// (`pairs`: every whitespace run holding a newline becomes one space).
fn pairs(list: Option<&Vec<NamedValue>>) -> Option<String> {
    let list = list.filter(|list| !list.is_empty())?;
    Some(
        list.iter()
            .map(|pair| format!("{}={}", pair.name, flatten_newlines(&pair.value)))
            .collect::<Vec<_>>()
            .join("; "),
    )
}

/// `value.replace(/\s*\n\s*/g, " ")`.
fn flatten_newlines(value: &str) -> String {
    let is_space = |c: char| c.is_whitespace() || c == '\u{feff}';
    let mut out = String::with_capacity(value.len());
    let mut run = String::new();
    for c in value.chars() {
        if is_space(c) {
            run.push(c);
            continue;
        }
        if !run.is_empty() {
            if run.contains('\n') {
                out.push(' ');
            } else {
                out.push_str(&run);
            }
            run.clear();
        }
        out.push(c);
    }
    if !run.is_empty() {
        if run.contains('\n') {
            out.push(' ');
        } else {
            out.push_str(&run);
        }
    }
    out
}

/// `formatSelectedElement`: one pick as the lines the model reads.
fn format_selected_element(entry: &PickedEntry) -> String {
    let el = &entry.element;
    let text = js_trim(el.text.as_deref().unwrap_or(""));
    let size = el
        .bounding_rect
        .as_ref()
        .filter(|rect| rect.width > 0.0 || rect.height > 0.0)
        .map(|rect| {
            format!(
                "{}×{} at x={}, y={}",
                js_round(rect.width),
                js_round(rect.height),
                js_round(rect.x),
                js_round(rect.y)
            )
        });
    let component = match (present(el.component.as_ref()), present(el.framework.as_ref())) {
        (Some(component), Some(framework)) => Some(format!("{component} ({framework})")),
        (Some(component), None) => Some(component.to_string()),
        (None, Some(framework)) => Some(format!("none named ({framework} page)")),
        (None, None) => None,
    };
    let attributes: Option<Vec<NamedValue>> = el.attributes.as_ref().map(|list| {
        list.iter()
            .filter(|a| a.name != "id" && a.name != "class")
            .take(SELECTION_ATTRIBUTES_MAX)
            .cloned()
            .collect()
    });
    let html = present(el.outer_html.as_ref()).map(|html| {
        if utf16_len(html) > SELECTION_HTML_MAX_CHARS {
            format!("{}… [cut]", utf16_prefix(html, SELECTION_HTML_MAX_CHARS))
        } else {
            html.to_string()
        }
    });
    let props = pairs(el.props.as_ref());
    let styles = pairs(el.styles.as_ref());
    let attributes = pairs(attributes.as_ref());
    let siblings = el
        .siblings
        .as_ref()
        .filter(|list| !list.is_empty())
        .map(|list| list.iter().map(|s| format!("    {s}")).collect::<Vec<_>>().join("\n"));

    let lines: Vec<Option<String>> = vec![
        Some(format!("<element index=\"{}\">", entry.index)),
        Some(format!("  tag: <{}>", el.tag_name)),
        (!text.is_empty()).then(|| format!("  text: {}", utf16_prefix(text, SELECTION_TEXT_MAX_CHARS))),
        present(el.id.as_ref()).map(|id| format!("  id: #{id}")),
        present(el.class_name.as_ref()).map(|classes| format!("  classes: {classes}")),
        present(el.path.as_ref()).map(|path| format!("  path: {path}")),
        Some(format!("  selector: {}", el.selector)),
        present(el.url.as_ref()).map(|url| format!("  url: {url}")),
        size.map(|size| format!("  size: {size}")),
        component.map(|component| format!("  component: {component}")),
        props.map(|props| format!("  props: {props}")),
        styles.map(|styles| format!("  styles: {styles}")),
        attributes.map(|attributes| format!("  attributes: {attributes}")),
        present(el.parent.as_ref()).map(|parent| format!("  parent: {parent}")),
        siblings.map(|siblings| format!("  siblings:\n{siblings}")),
        html.map(|html| format!("  html: {html}")),
        Some("</element>".to_string()),
    ];
    lines.into_iter().flatten().collect::<Vec<_>>().join("\n")
}

/// `buildRuleContext`: the `/`-attached rules, verbatim, in the folder's
/// listing order. `None` without a project, without a selection, or when
/// none of the names is a rule file.
fn rule_block(workspace: Option<&Path>, filenames: &[String]) -> Option<String> {
    let workspace = workspace?;
    if filenames.is_empty() {
        return None;
    }
    let selected: Vec<String> = load_project_rules(workspace)
        .into_iter()
        .filter(|rule| filenames.contains(&rule.filename))
        .map(|rule| format!("<rule file=\"{}\">\n{}\n</rule>", rule.filename, rule.content))
        .collect();
    if selected.is_empty() {
        return None;
    }
    Some(format!(
        "<project_rules>\nThe user explicitly attached these project rules to this turn. Treat them as authoritative standing rules for this task.\n\n{}\n</project_rules>",
        selected.join("\n\n")
    ))
}

/// `buildMcpDirective`.
fn mcp_block(server_names: &[String]) -> Option<String> {
    if server_names.is_empty() {
        return None;
    }
    Some(format!(
        "<preferred_mcp_servers>\nThe user explicitly referenced these connected MCP server(s) for this task: {}. Prefer their tools where relevant.\n</preferred_mcp_servers>",
        server_names.join(", ")
    ))
}

/// `buildImageRequest`.
fn image_block(requested: bool) -> Option<String> {
    requested.then(|| {
        "<image_request>\nThe user attached /image: they want a picture made of this message, and that comes before any other reply. Reply in a sentence at most, then call generate_image with a prompt written out from what they said. If what they wrote is too thin to draw from (a bare noun, no subject or setting), offer one fuller prompt in one or two lines and ask before spending the call. Otherwise do not ask; make it.\n</image_request>".to_string()
    })
}

/// Log the shadow comparison of one message's context (`aurora.log`,
/// `turn_build`). The context is saved on the message and sent after the
/// user's words: the dynamic half, so a difference here never re-bills the
/// prompt cache, but it is still what the model reads.
pub fn report_shadow_context(thread_id: &str, client: Option<&str>, engine: Option<&str>) {
    let (client, engine) = (client.unwrap_or_default(), engine.unwrap_or_default());
    match super::shadow_diff(client, engine) {
        None => crate::logging::log_info(
            "turn_build",
            &format!("shadow context for {thread_id}: identical ({} bytes)", client.len()),
        ),
        Some(diff) => crate::logging::log_warn(
            "turn_build",
            &format!(
                "shadow context for {thread_id}: DIFFERS at byte {} of {} (client) / {} (engine)\n  client: {:?}\n  engine: {:?}",
                diff.at,
                client.len(),
                engine.len(),
                diff.client_excerpt,
                diff.engine_excerpt,
            ),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOLDEN_DIR: &str =
        concat!(env!("CARGO_MANIFEST_DIR"), "/src/agent_runtime/turn_build/golden/context");

    #[derive(Deserialize)]
    struct RuleFixture {
        filename: String,
        content: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct GoldenCase {
        name: String,
        facts: MessageContextFacts,
        attached_rule_files: Vec<String>,
        workspace: bool,
    }

    #[derive(Deserialize)]
    struct Golden {
        rules: Vec<RuleFixture>,
        cases: Vec<GoldenCase>,
    }

    fn golden() -> Golden {
        let raw = std::fs::read_to_string(format!("{GOLDEN_DIR}/cases.json"))
            .expect("golden cases.json (written by agent-context.golden.test.ts)");
        serde_json::from_str(&raw).expect("cases.json parses")
    }

    /// The engine renders, for every case the window recorded, the exact
    /// bytes the window sent. The rule fixture becomes a real `.aurora/`.
    #[test]
    fn composes_the_same_context_the_window_did() {
        let golden = golden();
        assert!(golden.cases.len() >= 11, "only {} cases", golden.cases.len());
        let project = tempfile::tempdir().unwrap();
        let rules = project.path().join(".aurora");
        std::fs::create_dir_all(&rules).unwrap();
        for rule in &golden.rules {
            std::fs::write(rules.join(&rule.filename), &rule.content).unwrap();
        }
        for case in golden.cases {
            let expected = std::fs::read_to_string(format!("{GOLDEN_DIR}/{}.txt", case.name))
                .unwrap_or_else(|e| panic!("golden {}: {e}", case.name));
            let composed = compose_message_context(
                &case.facts,
                case.workspace.then_some(project.path()),
                &case.attached_rule_files,
            )
            .unwrap_or_default();
            if composed != expected {
                let at = composed
                    .chars()
                    .zip(expected.chars())
                    .position(|(a, b)| a != b)
                    .unwrap_or_else(|| composed.chars().count().min(expected.chars().count()));
                let window = |s: &str| s.chars().skip(at.saturating_sub(80)).take(200).collect::<String>();
                panic!(
                    "case {}: differs at char {at}\n--- engine ---\n{}\n--- window ---\n{}",
                    case.name,
                    window(&composed),
                    window(&expected),
                );
            }
        }
    }

    #[test]
    fn newline_runs_in_a_value_become_one_space() {
        assert_eq!(flatten_newlines("16px\n  Inter"), "16px Inter");
        assert_eq!(flatten_newlines("a \n \n b"), "a b");
        assert_eq!(flatten_newlines("no  newline"), "no  newline");
        assert_eq!(flatten_newlines("\n lead and trail \n"), " lead and trail ");
    }

    #[test]
    fn rounding_is_javascripts() {
        assert_eq!(js_round(20.49), 20);
        assert_eq!(js_round(20.5), 21);
        assert_eq!(js_round(-2.5), -2);
        assert_eq!(js_round(-0.3).to_string(), "0");
    }

    #[test]
    fn the_window_sends_fields_this_port_ignores() {
        let json = r#"{"index":1,"element":{"label":"pick","selector":"p","tagName":"p","id":null,
            "className":null,"text":"Hi","outerHtml":null,"url":null,"boundingRect":null,
            "attributes":null,"source":"inspector","note":null}}"#;
        let entry: PickedEntry = serde_json::from_str(json).unwrap();
        assert_eq!(entry.element.text.as_deref(), Some("Hi"));
        assert!(selection_block(&[entry]).unwrap().contains("  text: Hi\n  selector: p\n</element>"));
    }
}
