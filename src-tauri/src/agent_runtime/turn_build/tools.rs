//! The tool list a client sends with a turn, built in the engine.
//!
//! Today `AgentService.buildAvailableTools` sends the five tools the window
//! runs itself (artifacts, skills, `ask_question`) and every connected MCP
//! server's tools, filtered by execution mode (`filterToolsForExecutionMode`
//! in `agent-execution-mode.ts`), by the model's vision and by deep
//! research. Native tools never travel: the Rust registry is their only
//! source. Phase 3.4 of `DOCS/rust-core-extraction.md`.
//!
//! This composes the same list from the same inputs:
//! - the window's own definitions, as files in `tools/`
//!   (`agent-tools.texts.test.ts` keeps them equal to the TypeScript);
//! - the MCP manager's server list (the window's store is a view of it);
//! - the mode rules in `host::tool_policy` plus the MCP verb rule the
//!   window applies in Plan mode.
//!
//! Proven against `golden/tools/` (written by `agent-tools.golden.test.ts`),
//! then in shadow on real turns ([`report_shadow_tools`]).

use std::sync::OnceLock;

use serde_json::{Map, Value};

use crate::agent_runtime::host::tool_policy;
use crate::agent_runtime::ipc::{AgentExecutionMode, AllowedTool};
use crate::mcp::types::{McpServerState, McpServerStatus, McpToolInfo};

/// The window's own tools, in the order `getToolsForModel()` lists them.
/// A new window-run tool needs a file here and a line in
/// `agent-tools.texts.test.ts`.
const WINDOW_TOOLS: [&str; 5] = [
    include_str!("tools/present_artifact.json"),
    include_str!("tools/read_artifact.json"),
    include_str!("tools/aurora_skill_search.json"),
    include_str!("tools/aurora_skill_load.json"),
    include_str!("tools/ask_question.json"),
];

/// Appended to `present_artifact` in deep research (`REPORT_KIND_INSTRUCTIONS`).
const REPORT_KIND: &str = include_str!("tools/report-kind.md");

/// Tools whose result only a vision model can read (`VISION_REQUIRED_TOOLS`
/// in `agent-service.ts`). None of the window's tools is one today; the rule
/// is kept so the two sides stay the same function.
const VISION_REQUIRED_TOOLS: &[&str] = &["browser_screenshot"];

/// `MCP_READ_VERBS` / `MCP_WRITE_VERBS` in `agent-execution-mode.ts`: in Plan
/// mode an MCP tool is offered only when its name opens with a read verb and
/// neither its name nor its description carries a write verb.
const MCP_READ_VERBS: &[&str] = &[
    "count", "describe", "fetch", "find", "get", "inspect", "list", "query", "read", "search",
    "select", "show",
];
const MCP_WRITE_VERBS: &[&str] = &[
    "apply", "copy", "create", "delete", "drop", "execute", "insert", "invoke", "move", "mutate",
    "patch", "remove", "rename", "run", "truncate", "update", "upsert", "write",
];

/// `MCP_ACRONYM_LABELS` in `mcp-tools.ts`: how a tool name reads as words.
const MCP_ACRONYM_LABELS: &[(&str, &str)] = &[
    ("api", "API"),
    ("aws", "AWS"),
    ("cli", "CLI"),
    ("css", "CSS"),
    ("db", "DB"),
    ("dns", "DNS"),
    ("dom", "DOM"),
    ("html", "HTML"),
    ("http", "HTTP"),
    ("https", "HTTPS"),
    ("id", "ID"),
    ("ip", "IP"),
    ("json", "JSON"),
    ("os", "OS"),
    ("pdf", "PDF"),
    ("sql", "SQL"),
    ("ui", "UI"),
    ("url", "URL"),
    ("vps", "VPS"),
];

/// What a turn says about its tool list.
#[derive(Debug, Clone, Copy)]
pub struct ToolFacts {
    pub mode: AgentExecutionMode,
    /// The model can read images (`ProviderConfigSnapshot::supports_vision`).
    pub supports_vision: bool,
    /// The Aurora Chat conversation was started in deep research.
    pub deep_research: bool,
}

/// The list the window sends: its own tools, then every running server's
/// tools in the manager's order, filtered for the mode.
#[must_use]
pub fn compose_tool_list(facts: &ToolFacts, servers: &[McpServerState]) -> Vec<AllowedTool> {
    let mut tools: Vec<AllowedTool> = window_tools()
        .iter()
        .filter(|tool| facts.supports_vision || !VISION_REQUIRED_TOOLS.contains(&tool.name.as_str()))
        .cloned()
        .map(|tool| {
            if facts.deep_research && tool.name == "present_artifact" {
                with_report_kind(tool)
            } else {
                tool
            }
        })
        .filter(|tool| allowed_in_mode(facts.mode, &tool.name, None))
        .collect();
    for server in servers {
        if server.status != McpServerStatus::Connected || !server.config.enabled {
            continue;
        }
        for info in &server.tools {
            let tool = mcp_tool(&server.config.id, &server.config.name, info);
            if allowed_in_mode(facts.mode, &tool.name, Some((&info.name, &tool.description))) {
                tools.push(tool);
            }
        }
    }
    tools
}

fn window_tools() -> &'static [AllowedTool] {
    static TOOLS: OnceLock<Vec<AllowedTool>> = OnceLock::new();
    TOOLS.get_or_init(|| WINDOW_TOOLS.iter().map(|text| window_tool(text)).collect())
}

/// One `tools/*.json` file: the `{type, function: {name, description,
/// parameters}}` shape the window sends, unwrapped the way
/// `AgentRuntimeClient.buildAllowedTools` unwraps it.
fn window_tool(text: &str) -> AllowedTool {
    let value: Value =
        serde_json::from_str(text).expect("window tool JSON (agent-tools.texts.test.ts writes it)");
    let function = &value["function"];
    let text_field = |key: &str| {
        function[key]
            .as_str()
            .unwrap_or_else(|| panic!("window tool JSON: function.{key} is a string"))
            .to_string()
    };
    AllowedTool {
        name: text_field("name"),
        description: text_field("description"),
        parameters: function.get("parameters").cloned().unwrap_or_else(|| Value::Object(Map::new())),
    }
}

/// `withReportKind`: deep research unlocks the `report` artifact kind. Left
/// alone when the schema has no kind list or already offers it.
fn with_report_kind(mut tool: AllowedTool) -> AllowedTool {
    let Some(kinds) = tool
        .parameters
        .get_mut("properties")
        .and_then(|properties| properties.get_mut("artifactKind"))
        .and_then(|kind| kind.get_mut("enum"))
        .and_then(Value::as_array_mut)
    else {
        return tool;
    };
    if kinds.iter().any(|kind| kind == "report") {
        return tool;
    }
    kinds.push(Value::from("report"));
    tool.description.push_str(REPORT_KIND);
    tool
}

/// `filterToolsForExecutionMode`, for one tool. `mcp` carries the server's
/// own tool name and the sent description for the Plan-mode verb rule.
///
/// The window's deny-list also names retired tools (`todo_write`,
/// `search_replace`, …) that cannot be in this list, so the engine's
/// `PLAN_MUTATING_TOOLS` covers it.
pub(crate) fn allowed_in_mode(mode: AgentExecutionMode, name: &str, mcp: Option<(&str, &str)>) -> bool {
    if mode.is_chat() {
        return tool_policy::is_chat_mode_tool(name);
    }
    if tool_policy::is_chat_only_tool(name) {
        return false;
    }
    match name {
        "plan_write" => return mode == AgentExecutionMode::Plan,
        "plan_step_update" => return mode != AgentExecutionMode::Plan,
        _ => {}
    }
    if mode == AgentExecutionMode::Agent {
        return true;
    }
    // Plan mode: a read-only surface.
    if tool_policy::is_plan_mutating_tool(name) {
        return false;
    }
    if name == "shell_execute" {
        return true;
    }
    if name.starts_with("mcp_") {
        return match mcp {
            Some((original, description)) => mcp_tool_allowed_in_plan(original, description),
            // The window answers this from the tool name alone when it does
            // not know the server; its first word is then `mcp`, never a
            // read verb.
            None => false,
        };
    }
    true
}

/// `isMcpToolAllowedInPlanMode`.
fn mcp_tool_allowed_in_plan(original: &str, description: &str) -> bool {
    let original = original.to_lowercase();
    let description = description.to_lowercase();
    let words: Vec<&str> = original
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect();
    let first = words.first().copied().unwrap_or("");
    if MCP_WRITE_VERBS.iter().any(|verb| {
        words.contains(verb)
            || description.contains(&format!("{verb} "))
            || description.contains(&format!("{verb}_"))
    }) {
        return false;
    }
    MCP_READ_VERBS.contains(&first)
}

/// `mcpServerPrefix`: `mcp_` + the id with every character outside
/// `[a-zA-Z0-9]` replaced + `_`. The window replaces per UTF-16 unit, so a
/// character outside the BMP becomes two underscores; same here.
#[must_use]
pub fn mcp_server_prefix(server_id: &str) -> String {
    let sanitized: String = server_id
        .encode_utf16()
        .map(|unit| match u8::try_from(unit) {
            Ok(byte) if byte.is_ascii_alphanumeric() => byte as char,
            _ => '_',
        })
        .collect();
    format!("mcp_{sanitized}_")
}

/// `formatMcpToolLabel`: `pg_execute_sql` → "Pg Execute SQL".
fn mcp_tool_label(tool_name: &str) -> String {
    tool_name
        .split('_')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let lower = part.to_lowercase();
            if let Some((_, acronym)) = MCP_ACRONYM_LABELS.iter().find(|(key, _)| *key == lower) {
                return (*acronym).to_string();
            }
            let mut chars = lower.chars();
            match chars.next() {
                // `charAt(0).toUpperCase()` works on one UTF-16 unit: a
                // character outside the BMP is left as it is.
                Some(first) if first.len_utf16() == 1 => {
                    first.to_uppercase().chain(chars).collect()
                }
                _ => lower.clone(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// JavaScript truthiness of a JSON value, for the `||` and `? :` in
/// `mcpToolToDefinition`.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `mcpToolToDefinition`.
#[must_use]
pub fn mcp_tool(server_id: &str, server_name: &str, info: &McpToolInfo) -> AllowedTool {
    let name = format!("{}{}", mcp_server_prefix(server_id), info.name);
    let description = match info.description.as_deref().filter(|d| !d.is_empty()) {
        Some(description) => format!("[MCP: {server_name}] {description}"),
        None => format!(
            "[MCP: {server_name}] Call {} from the {server_name} MCP server",
            mcp_tool_label(&info.name)
        ),
    };
    AllowedTool { name, description, parameters: mcp_parameters(info.input_schema.as_ref()) }
}

/// The input schema as the window sends it: `type`, `properties`,
/// `required`, then `$defs` / `definitions` when the server has them (pydantic
/// and zod servers point properties at them with `$ref`). Anything that is
/// not an object schema becomes the empty one.
fn mcp_parameters(schema: Option<&Value>) -> Value {
    let schema = schema
        .and_then(Value::as_object)
        .filter(|schema| schema.get("type").and_then(Value::as_str) == Some("object"));
    let field = |key: &str| schema.and_then(|s| s.get(key)).filter(|v| truthy(v)).cloned();
    let mut parameters = Map::new();
    parameters.insert("type".into(), Value::from("object"));
    parameters.insert("properties".into(), field("properties").unwrap_or_else(|| Value::Object(Map::new())));
    parameters.insert("required".into(), field("required").unwrap_or_else(|| Value::Array(Vec::new())));
    if let Some(defs) = field("$defs") {
        parameters.insert("$defs".into(), defs);
    }
    if let Some(definitions) = field("definitions") {
        parameters.insert("definitions".into(), definitions);
    }
    Value::Object(parameters)
}

/// Where a shadow-composed tool list first differs from the client's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolsDiff {
    pub client_count: usize,
    pub engine_count: usize,
    /// Index of the first tool that differs, or the shorter list's length.
    pub index: usize,
    pub client_name: Option<String>,
    pub engine_name: Option<String>,
    /// Inside that tool's JSON, when both sides have one.
    pub at: Option<super::ShadowDiff>,
}

fn tool_json(tool: &AllowedTool) -> String {
    serde_json::to_string(tool).unwrap_or_default()
}

/// Compare the two lists tool by tool, each as JSON. `None` when identical.
#[must_use]
pub fn shadow_tools_diff(client: &[AllowedTool], engine: &[AllowedTool]) -> Option<ToolsDiff> {
    let index = client
        .iter()
        .zip(engine)
        .position(|(a, b)| tool_json(a) != tool_json(b))
        .unwrap_or_else(|| client.len().min(engine.len()));
    if index == client.len() && index == engine.len() {
        return None;
    }
    let (client_tool, engine_tool) = (client.get(index), engine.get(index));
    Some(ToolsDiff {
        client_count: client.len(),
        engine_count: engine.len(),
        index,
        client_name: client_tool.map(|t| t.name.clone()),
        engine_name: engine_tool.map(|t| t.name.clone()),
        at: match (client_tool, engine_tool) {
            (Some(a), Some(b)) => super::shadow_diff(&tool_json(a), &tool_json(b)),
            _ => None,
        },
    })
}

/// Log the shadow comparison of one turn's tool list (`aurora.log`,
/// `turn_build`). Tool schemas sit in the cached half of every request.
pub fn report_shadow_tools(thread_id: &str, client: &[AllowedTool], engine: &[AllowedTool]) {
    match shadow_tools_diff(client, engine) {
        None => crate::logging::log_info(
            "turn_build",
            &format!(
                "shadow tools for {thread_id}: identical ({} tools, {} bytes)",
                client.len(),
                serde_json::to_string(client).map(|s| s.len()).unwrap_or_default()
            ),
        ),
        Some(diff) => {
            let detail = match &diff.at {
                Some(at) => format!(
                    " at byte {} of that tool\n  client: {:?}\n  engine: {:?}",
                    at.at, at.client_excerpt, at.engine_excerpt
                ),
                None => String::new(),
            };
            crate::logging::log_warn(
                "turn_build",
                &format!(
                    "shadow tools for {thread_id}: DIFFERS at #{} (client {} tools / engine {}), client {:?} / engine {:?}{detail}",
                    diff.index,
                    diff.client_count,
                    diff.engine_count,
                    diff.client_name.as_deref().unwrap_or("(none)"),
                    diff.engine_name.as_deref().unwrap_or("(none)"),
                ),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::json;

    const GOLDEN_DIR: &str =
        concat!(env!("CARGO_MANIFEST_DIR"), "/src/agent_runtime/turn_build/golden/tools");

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct GoldenCase {
        name: String,
        mode: AgentExecutionMode,
        supports_vision: bool,
        deep_research: bool,
        servers: Vec<McpServerState>,
    }

    fn cases() -> Vec<GoldenCase> {
        let raw = std::fs::read_to_string(format!("{GOLDEN_DIR}/cases.json"))
            .expect("golden cases.json (written by agent-tools.golden.test.ts)");
        serde_json::from_str(&raw).expect("cases.json parses as the engine's MCP types")
    }

    /// Back into the `{type, function}` shape the window records, printed
    /// the way `JSON.stringify(tools, null, 2)` prints it.
    fn as_sent(tools: &[AllowedTool]) -> String {
        let list: Vec<Value> = tools
            .iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.parameters,
                    }
                })
            })
            .collect();
        format!("{}\n", serde_json::to_string_pretty(&list).unwrap())
    }

    /// The engine composes, for every case the window recorded, the exact
    /// bytes the window sent.
    #[test]
    fn composes_the_same_tool_list_the_window_did() {
        let cases = cases();
        assert!(cases.len() >= 7, "only {} cases", cases.len());
        for case in cases {
            let expected = std::fs::read_to_string(format!("{GOLDEN_DIR}/{}.json", case.name))
                .unwrap_or_else(|e| panic!("golden {}: {e}", case.name));
            let facts = ToolFacts {
                mode: case.mode,
                supports_vision: case.supports_vision,
                deep_research: case.deep_research,
            };
            let composed = as_sent(&compose_tool_list(&facts, &case.servers));
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
    fn a_server_id_is_sanitised_per_utf16_unit() {
        assert_eq!(mcp_server_prefix("browser-testing"), "mcp_browser_testing_");
        assert_eq!(mcp_server_prefix("a.b c"), "mcp_a_b_c_");
        // `é` is one unit, `😀` two: three underscores, then the trailing one.
        assert_eq!(mcp_server_prefix("é😀"), "mcp_____");
    }

    #[test]
    fn a_tool_name_reads_as_words_with_acronyms_upright() {
        assert_eq!(mcp_tool_label("pg_execute_sql"), "Pg Execute SQL");
        assert_eq!(mcp_tool_label("__get__url"), "Get URL");
        assert_eq!(mcp_tool_label("fetch"), "Fetch");
    }

    #[test]
    fn a_tool_without_a_description_or_schema_gets_the_defaults() {
        let info = McpToolInfo { name: "db_info".into(), description: Some(String::new()), input_schema: None };
        let tool = mcp_tool("pg", "Postgres", &info);
        assert_eq!(tool.name, "mcp_pg_db_info");
        assert_eq!(tool.description, "[MCP: Postgres] Call DB Info from the Postgres MCP server");
        assert_eq!(tool.parameters, json!({"type": "object", "properties": {}, "required": []}));
    }

    #[test]
    fn a_schema_keeps_its_refs_and_drops_the_rest() {
        let info = McpToolInfo {
            name: "q".into(),
            description: Some("Query.".into()),
            input_schema: Some(json!({
                "type": "object",
                "title": "dropped",
                "properties": {"sql": {"$ref": "#/$defs/Sql"}},
                "$defs": {"Sql": {"type": "string"}},
                "additionalProperties": false
            })),
        };
        let tool = mcp_tool("pg", "Postgres", &info);
        assert_eq!(
            tool.parameters,
            json!({
                "type": "object",
                "properties": {"sql": {"$ref": "#/$defs/Sql"}},
                "required": [],
                "$defs": {"Sql": {"type": "string"}}
            })
        );
        // A non-object schema is the empty one.
        let info = McpToolInfo { name: "q".into(), description: None, input_schema: Some(json!({"type": "string"})) };
        assert_eq!(
            mcp_tool("pg", "P", &info).parameters,
            json!({"type": "object", "properties": {}, "required": []})
        );
    }

    #[test]
    fn plan_mode_keeps_read_verbs_and_drops_write_verbs() {
        assert!(mcp_tool_allowed_in_plan("search_issues", "[MCP: GitHub] Search issues."));
        assert!(!mcp_tool_allowed_in_plan("whoami", "[MCP: GitHub] The signed-in account."));
        // A write verb anywhere in the name, or in the description followed
        // by a space or an underscore.
        assert!(!mcp_tool_allowed_in_plan("get_and_delete", "[MCP: X] Reads."));
        assert!(!mcp_tool_allowed_in_plan("get_row", "[MCP: X] Get a row, then update it."));
        assert!(!mcp_tool_allowed_in_plan("get_row", "[MCP: X] Runs update_row."));
        assert!(mcp_tool_allowed_in_plan("get_row", "[MCP: X] Gets an updated row."));
    }

    #[test]
    fn deep_research_adds_the_report_kind_once() {
        let facts = ToolFacts { mode: AgentExecutionMode::Chat, supports_vision: true, deep_research: true };
        let tools = compose_tool_list(&facts, &[]);
        let present = tools.iter().find(|t| t.name == "present_artifact").unwrap();
        assert!(present.description.ends_with(REPORT_KIND));
        let kinds = &present.parameters["properties"]["artifactKind"]["enum"];
        assert_eq!(kinds.as_array().unwrap().last().unwrap(), "report");
        // Applying it again changes nothing.
        let again = with_report_kind(present.clone());
        assert_eq!(tool_json(&again), tool_json(present));
    }

    #[test]
    fn a_differing_list_is_reported_by_index_and_name() {
        let a = AllowedTool { name: "a".into(), description: "A".into(), parameters: json!({}) };
        let b = AllowedTool { name: "b".into(), description: "B".into(), parameters: json!({}) };
        let b2 = AllowedTool { name: "b".into(), description: "B!".into(), parameters: json!({}) };
        assert_eq!(shadow_tools_diff(&[a.clone(), b.clone()], &[a.clone(), b.clone()]), None);
        let missing = shadow_tools_diff(&[a.clone(), b.clone()], &[a.clone()]).unwrap();
        assert_eq!((missing.index, missing.client_name.as_deref(), missing.engine_name), (1, Some("b"), None));
        assert_eq!(missing.at, None);
        let changed = shadow_tools_diff(&[a.clone(), b], &[a, b2]).unwrap();
        assert_eq!(changed.index, 1);
        assert!(changed.at.is_some());
    }
}
