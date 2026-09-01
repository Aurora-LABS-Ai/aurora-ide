//! `tool_search` — tools the model can see by name and load on demand.
//!
//! ## The problem this exists for
//!
//! Every tool Aurora advertises costs its full JSON schema on EVERY request of
//! every turn, forever. The browser bucket alone is 16 schemas and ~2,800
//! tokens, and only Anthropic receives a `cache_control` marker from Aurora —
//! so on every other provider that is paid in full on turns that never open a
//! page. MCP is worse because it is unbounded: a workspace with several servers
//! connected can push the roster past a hundred tools, and the schemas for
//! tools the model will never call in this conversation are simply burned.
//!
//! ## What changes
//!
//! Deferrable tools are built exactly as before, but held OUT of the per-turn
//! registry. The model is shown their NAMES (in this tool's description, which
//! costs a few tokens each) and can load any of them by calling `tool_search`.
//! Loading registers the real executor into the live per-turn registry, and
//! because `ConversationRuntime` re-reads `ToolRegistry::schemas()` at the top
//! of every iteration of its turn loop, the tool is advertised — and callable —
//! on the very next request.
//!
//! ## Why the executor, not a copy of the schema
//!
//! The catalogue holds the same `Arc<dyn ToolExecutor>` the registry would have
//! held, which matters for two reasons. Native tools arrive already wrapped by
//! `install_permission_gate`, so a tool loaded here keeps its approval prompt.
//! And a bridge tool keeps its turn id, router and cancellation token, so an
//! MCP call still routes back to the frontend that owns it.
//!
//! ## What is never deferred
//!
//! Reading, editing, searching and running things — the tools a turn cannot
//! start without. Deferring those would trade a real round trip for a few
//! hundred tokens on every single turn, which is the wrong side of the deal.
//! See `commands::agent_v2::tool_policy::is_deferrable`.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor, ToolRegistry};

/// Names this bucket registers, in roster order.
pub const TOOL_NAMES: &[&str] = &["tool_search"];

/// Default number of tools returned for a keyword query.
const DEFAULT_MAX_RESULTS: usize = 5;

/// Hard ceiling on one call's results. A query that wants more than this is
/// really asking for the whole catalogue, and answering it would re-create the
/// cost this tool exists to avoid.
const MAX_RESULTS_CEILING: usize = 20;

/// Character budget for the name list inside the tool's own description.
///
/// The list is the only thing telling the model these tools exist, so it is
/// worth real tokens — but it rides in the cached prefix of every request, so
/// it cannot be unbounded. Past this the tail is summarised as a count and the
/// model is told to search by keyword instead.
const NAME_LIST_BUDGET: usize = 4_000;

/// One turn's deferred tools, in stable roster order.
///
/// Order matters for the same reason it matters in `ToolRegistry`: it is part
/// of the description, which is part of the cacheable prefix.
pub struct ToolSearchExecutor {
    catalog: Vec<Arc<dyn ToolExecutor>>,
    /// A CLONE of the per-turn registry. `ToolRegistry` is an `Arc<DashMap>`
    /// under the hood, so this shares the same map — registering here is what
    /// the next request will advertise.
    live: ToolRegistry,
    /// Precomputed because `schema()` is called once per loop iteration and
    /// this string never changes within a turn.
    description: String,
}

impl ToolSearchExecutor {
    #[must_use]
    pub fn new(catalog: Vec<Arc<dyn ToolExecutor>>, live: ToolRegistry) -> Self {
        let description = describe(&catalog);
        Self {
            catalog,
            live,
            description,
        }
    }

    /// Tools whose names match `query`, best first.
    fn search(&self, query: &str, limit: usize) -> Vec<Arc<dyn ToolExecutor>> {
        if let Some(list) = query.trim().strip_prefix("select:") {
            // Exact selection. No ranking and no limit — the model named these,
            // and silently dropping one it asked for would be a lie by omission.
            let wanted: Vec<String> = list
                .split(',')
                .map(|name| name.trim().to_ascii_lowercase())
                .filter(|name| !name.is_empty())
                .collect();
            return self
                .catalog
                .iter()
                .filter(|tool| {
                    wanted
                        .iter()
                        .any(|name| name == &tool.name().to_ascii_lowercase())
                })
                .cloned()
                .collect();
        }

        let terms: Vec<String> = query
            .split_whitespace()
            .map(|term| term.to_ascii_lowercase())
            .filter(|term| !term.is_empty())
            .collect();
        if terms.is_empty() {
            return Vec::new();
        }

        let mut scored: Vec<(u32, usize, Arc<dyn ToolExecutor>)> = Vec::new();
        for (position, tool) in self.catalog.iter().enumerate() {
            let name = tool.name().to_ascii_lowercase();
            let schema = tool.schema();
            let description = schema.description.to_ascii_lowercase();

            let mut score = 0_u32;
            let mut required_missed = false;
            for term in &terms {
                // `+term` means "must appear in the name" — the escape hatch for
                // a word that is common in descriptions but rare in names.
                if let Some(required) = term.strip_prefix('+') {
                    if name.contains(required) {
                        score += 4;
                    } else {
                        required_missed = true;
                    }
                    continue;
                }
                // A name hit outranks a description hit: the name is what the
                // model is choosing between, the description is corroboration.
                if name.contains(term) {
                    score += 3;
                }
                if description.contains(term) {
                    score += 1;
                }
            }
            if required_missed || score == 0 {
                continue;
            }
            scored.push((score, position, tool.clone()));
        }

        // Ties break on roster position, never on map order, so the same query
        // returns the same tools in the same order every time.
        scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        scored
            .into_iter()
            .take(limit)
            .map(|(_, _, tool)| tool)
            .collect()
    }
}

/// The description the model reads, including the full name list.
fn describe(catalog: &[Arc<dyn ToolExecutor>]) -> String {
    let mut names = String::new();
    let mut listed = 0_usize;
    for tool in catalog {
        let name = tool.name();
        if names.len() + name.len() + 2 > NAME_LIST_BUDGET {
            break;
        }
        if !names.is_empty() {
            names.push_str(", ");
        }
        names.push_str(name);
        listed += 1;
    }
    let tail = if listed < catalog.len() {
        format!(
            "\n\n…and {} more not listed here. Search by keyword to find them.",
            catalog.len() - listed
        )
    } else {
        String::new()
    };

    format!(
        "Load the full definition of a tool that is not loaded yet.

The tools below are available but NOT currently callable — you can see their names, not their \
parameters. Call `tool_search` to load the ones you need, then call them normally on your next \
message. A tool stays loaded for the rest of the conversation.

Query forms:
- `select:name_one,name_two` — load these exact tools by name.
- `screenshot page` — keyword search over names and descriptions.
- `+browser click` — require \"browser\" in the name, rank the rest by \"click\".

Load what you are about to use, not everything that looks interesting: each loaded tool costs its \
schema on every later request of this conversation.

Available on demand ({count}): {names}{tail}",
        count = catalog.len(),
        names = names,
        tail = tail,
    )
}

#[async_trait]
impl ToolExecutor for ToolSearchExecutor {
    fn name(&self) -> &str {
        "tool_search"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "tool_search".into(),
            description: self.description.clone(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "`select:name_one,name_two` for exact names, or keywords to search by."
                    },
                    "max_results": {
                        "type": "integer",
                        "description": "How many tools to load for a keyword query. Default 5."
                    }
                },
                "required": ["query"]
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let query = input
            .get("query")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                ToolError::InvalidInput(
                    "`query` is required: name the tools with `select:a,b` or describe what you \
need to do."
                        .into(),
                )
            })?;

        let limit = input
            .get("max_results")
            .and_then(Value::as_u64)
            .map_or(DEFAULT_MAX_RESULTS, |value| {
                (value as usize).clamp(1, MAX_RESULTS_CEILING)
            });

        let matched = self.search(query, limit);
        if matched.is_empty() {
            // Not an error: an empty search is a normal step, and failing the
            // call would push the model into recovery instead of another query.
            return Ok(json!({
                "success": true,
                "loaded": [],
                "note": format!(
                    "Nothing matched \"{query}\". {} tools are available on demand — \
try one broad word, or `select:` with an exact name from the list in this tool's description.",
                    self.catalog.len()
                ),
            })
            .to_string());
        }

        let mut loaded = Vec::new();
        let mut already = Vec::new();
        for tool in matched {
            let schema = tool.schema();
            if self.live.get(tool.name()).is_some() {
                already.push(schema.name.clone());
                continue;
            }
            self.live.register(tool.clone());
            loaded.push(json!({
                "name": schema.name,
                "description": schema.description,
                "parameters": schema.input_schema,
            }));
        }

        let note = if loaded.is_empty() {
            "Already loaded — call them directly.".to_string()
        } else {
            format!(
                "{} tool(s) loaded and callable from your next message. Do not call `tool_search` \
again for them.",
                loaded.len()
            )
        };

        Ok(json!({
            "success": true,
            "loaded": loaded,
            "already_loaded": already,
            "note": note,
        })
        .to_string())
    }

    /// Deliberately sequential. It mutates the roster the next request is built
    /// from, and two concurrent loads could interleave their registration order
    /// — which would change the schema order between otherwise identical turns
    /// and cost a prompt-cache hit for no reason.
    fn concurrency_safe(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_util::sync::CancellationToken;

    fn ctx() -> ToolContext {
        ToolContext {
            workspace_access: Default::default(),
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            thread_id: "s".into(),
            workspace_root: None,
            cancel_token: CancellationToken::new(),
            spill_dir: None,
        }
    }

    struct Fake {
        name: &'static str,
        description: &'static str,
    }

    #[async_trait]
    impl ToolExecutor for Fake {
        fn name(&self) -> &str {
            self.name
        }
        fn schema(&self) -> ToolSchema {
            ToolSchema {
                name: self.name.into(),
                description: self.description.into(),
                input_schema: json!({ "type": "object", "properties": {} }),
            }
        }
        async fn execute(&self, _input: Value, _ctx: &ToolContext) -> Result<String, ToolError> {
            Ok("{}".into())
        }
    }

    fn catalog() -> Vec<Arc<dyn ToolExecutor>> {
        vec![
            Arc::new(Fake {
                name: "browser_navigate",
                description: "Open a URL in the browser.",
            }),
            Arc::new(Fake {
                name: "browser_screenshot",
                description: "Capture the visible page as an image.",
            }),
            Arc::new(Fake {
                name: "mcp_drive_search_files",
                description: "Search files in a connected drive.",
            }),
        ]
    }

    fn executor() -> (ToolSearchExecutor, ToolRegistry) {
        let live = ToolRegistry::new();
        (ToolSearchExecutor::new(catalog(), live.clone()), live)
    }

    #[tokio::test]
    async fn a_keyword_query_loads_into_the_live_registry() {
        let (tool, live) = executor();
        assert_eq!(live.len(), 0, "nothing is advertised before a search");

        let out = tool
            .execute(json!({ "query": "screenshot" }), &ctx())
            .await
            .expect("searched");
        let parsed: Value = serde_json::from_str(&out).expect("json");

        assert_eq!(parsed["loaded"][0]["name"], "browser_screenshot");
        assert!(
            live.get("browser_screenshot").is_some(),
            "the point of the call is that the tool is now callable"
        );
        assert!(
            live.get("browser_navigate").is_none(),
            "a search must load what was asked for, not the whole bucket"
        );
    }

    #[tokio::test]
    async fn select_loads_exact_names_and_ignores_ranking() {
        let (tool, live) = executor();
        tool.execute(
            json!({ "query": "select:browser_navigate,mcp_drive_search_files" }),
            &ctx(),
        )
        .await
        .expect("searched");

        assert!(live.get("browser_navigate").is_some());
        assert!(live.get("mcp_drive_search_files").is_some());
        assert_eq!(live.len(), 2);
    }

    #[tokio::test]
    async fn the_full_parameter_schema_comes_back_with_the_result() {
        let (tool, _live) = executor();
        let out = tool
            .execute(json!({ "query": "select:browser_navigate" }), &ctx())
            .await
            .expect("searched");
        let parsed: Value = serde_json::from_str(&out).expect("json");
        assert_eq!(parsed["loaded"][0]["parameters"]["type"], "object");
        assert!(parsed["loaded"][0]["description"].is_string());
    }

    #[tokio::test]
    async fn loading_the_same_tool_twice_is_reported_not_repeated() {
        let (tool, live) = executor();
        tool.execute(json!({ "query": "select:browser_navigate" }), &ctx())
            .await
            .expect("first");
        let out = tool
            .execute(json!({ "query": "select:browser_navigate" }), &ctx())
            .await
            .expect("second");
        let parsed: Value = serde_json::from_str(&out).expect("json");

        assert_eq!(parsed["loaded"].as_array().expect("array").len(), 0);
        assert_eq!(parsed["already_loaded"][0], "browser_navigate");
        assert_eq!(live.len(), 1, "no duplicate registration");
    }

    #[tokio::test]
    async fn a_query_that_matches_nothing_succeeds_with_a_note() {
        let (tool, live) = executor();
        let out = tool
            .execute(json!({ "query": "kubernetes" }), &ctx())
            .await
            .expect("an empty search is not a failure");
        let parsed: Value = serde_json::from_str(&out).expect("json");

        assert_eq!(parsed["success"], true);
        assert_eq!(parsed["loaded"].as_array().expect("array").len(), 0);
        assert!(parsed["note"]
            .as_str()
            .expect("note")
            .contains("Nothing matched"));
        assert_eq!(live.len(), 0);
    }

    #[tokio::test]
    async fn a_required_term_filters_by_name() {
        let (tool, _live) = executor();
        let out = tool
            .execute(json!({ "query": "+browser search files" }), &ctx())
            .await
            .expect("searched");
        let parsed: Value = serde_json::from_str(&out).expect("json");
        let names: Vec<&str> = parsed["loaded"]
            .as_array()
            .expect("array")
            .iter()
            .map(|entry| entry["name"].as_str().expect("name"))
            .collect();
        assert!(
            names.iter().all(|name| name.starts_with("browser_")),
            "`+browser` must exclude the drive tool despite its description hits: {names:?}"
        );
    }

    #[tokio::test]
    async fn max_results_is_honoured_and_capped() {
        let (tool, _live) = executor();
        let out = tool
            .execute(json!({ "query": "browser", "max_results": 1 }), &ctx())
            .await
            .expect("searched");
        let parsed: Value = serde_json::from_str(&out).expect("json");
        assert_eq!(parsed["loaded"].as_array().expect("array").len(), 1);
    }

    #[tokio::test]
    async fn a_blank_query_is_rejected() {
        let (tool, _live) = executor();
        let err = tool
            .execute(json!({ "query": "   " }), &ctx())
            .await
            .expect_err("a search with no terms cannot be answered");
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }

    #[test]
    fn the_description_names_every_deferred_tool() {
        let (tool, _live) = executor();
        let described = tool.schema().description;
        for name in [
            "browser_navigate",
            "browser_screenshot",
            "mcp_drive_search_files",
        ] {
            assert!(
                described.contains(name),
                "{name} must be discoverable by name"
            );
        }
        assert!(described.contains("Available on demand (3)"));
    }

    #[test]
    fn an_oversized_catalogue_is_summarised_rather_than_truncated_silently() {
        let many: Vec<Arc<dyn ToolExecutor>> = (0..400)
            .map(|_| {
                Arc::new(Fake {
                    name: "mcp_a_very_long_tool_name_that_eats_the_budget",
                    description: "x",
                }) as Arc<dyn ToolExecutor>
            })
            .collect();
        let described = describe(&many);
        assert!(described.len() < NAME_LIST_BUDGET + 1_000);
        assert!(
            described.contains("more not listed here"),
            "the model must be told the list is partial"
        );
    }
}
