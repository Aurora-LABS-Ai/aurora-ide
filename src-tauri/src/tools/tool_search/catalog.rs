//! Searchable metadata and already-guarded executors, owned by one turn.
use super::validation::ValidatedExecutor;
use crate::agent_runtime::tool_executor::{ToolError, ToolExecutor};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;

pub(super) struct ToolCatalog {
    tools: BTreeMap<String, Arc<ValidatedExecutor>>,
}

impl ToolCatalog {
    pub fn new(tools: Vec<Arc<dyn ToolExecutor>>) -> Self {
        Self {
            tools: tools
                .into_iter()
                .filter(|tool| !super::TOOL_NAMES.contains(&tool.name()))
                .map(|tool| {
                    (
                        tool.name().to_owned(),
                        Arc::new(ValidatedExecutor::new(tool)),
                    )
                })
                .collect(),
        }
    }
    pub fn get(&self, name: &str, input: &Value) -> Result<Arc<dyn ToolExecutor>, ToolError> {
        let tool = self.tools.get(name)
            .ok_or_else(|| ToolError::NotFound(format!("{name}. It is not in this turn's optional-tool catalog. Use tool_search to find an available tool. Core tools must be called directly.")))?;
        tool.validate(input)?;
        Ok(tool.clone())
    }
    pub fn search(
        &self,
        query: &str,
        limit: usize,
        schema_offset: Option<usize>,
    ) -> Result<Value, ToolError> {
        // Large third-party schemas are paged as JSON text, never silently
        // shortened by the runtime's generic result clamp.
        if let Some(offset) = schema_offset {
            let name = query
                .strip_prefix("select:")
                .filter(|name| !name.contains(','))
                .ok_or_else(|| {
                    ToolError::InvalidInput(
                        "schema_offset requires select:one_exact_tool_name.".into(),
                    )
                })?;
            let tool = self
                .tools
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name.trim()))
                .map(|(_, tool)| tool)
                .ok_or_else(|| ToolError::NotFound(name.into()))?;
            let length = definition_text(tool.definition()).chars().count();
            if offset >= length {
                return Err(ToolError::InvalidInput(format!("schema_offset {offset} is outside this schema ({length} characters). Search this exact tool again to restart paging.")));
            }
            return Ok(schema_page(tool.definition(), offset));
        }
        let exact = query.strip_prefix("select:").map(|list| {
            list.split(',')
                .map(|s| s.trim().to_ascii_lowercase())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        });
        let terms = query
            .to_ascii_lowercase()
            .split_whitespace()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let mut matches = Vec::new();
        for (name, tool) in &self.tools {
            let lower_name = name.to_ascii_lowercase();
            let score = if let Some(names) = &exact {
                if names.contains(&lower_name) {
                    1
                } else {
                    0
                }
            } else {
                let description = tool.definition().description.to_ascii_lowercase();
                let mut score = 0;
                for term in &terms {
                    if let Some(required) = term.strip_prefix('+') {
                        if !lower_name.contains(required) {
                            score = 0;
                            break;
                        }
                        score += 4;
                    } else {
                        score += u32::from(lower_name.contains(term)) * 3;
                        score += u32::from(description.contains(term));
                    }
                }
                score
            };
            if score > 0 {
                matches.push((score, name, tool));
            }
        }
        matches.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(b.1)));
        let total = matches.len();
        let mut bytes = 0;
        let mut tools = Vec::new();
        for (_, _, tool) in matches.into_iter().take(limit) {
            let schema = tool.definition();
            let mut result = json!({"name": schema.name, "description": schema.description, "parameters": schema.input_schema});
            if result.to_string().len() > 40 * 1024 {
                result = schema_page(schema, 0);
            }
            let size = result.to_string().len();
            if !tools.is_empty() && bytes + size > 48 * 1024 {
                break;
            }
            bytes += size;
            tools.push(result);
        }
        let returned = tools.len();
        let missing = exact
            .unwrap_or_default()
            .into_iter()
            .filter(|name| !self.tools.keys().any(|key| key.eq_ignore_ascii_case(name)))
            .collect::<Vec<_>>();
        Ok(
            json!({"tools": tools, "total_matches": total, "has_more": total > returned, "not_found": missing,
                "note": if total == 0 { "No matching optional tools are available this turn. Try a broader task keyword or connect the required MCP server." } else { "Use call_tool with a returned name and an arguments object matching its parameters. Direct tool definitions are unchanged." }
            }),
        )
    }
}

fn schema_page(schema: &crate::agent_runtime::api_client::ToolSchema, offset: usize) -> Value {
    let text = definition_text(schema);
    let total = text.chars().count();
    // At most 24 KiB after JSON escaping, including pathological Unicode.
    let page: String = text.chars().skip(offset).take(4_000).collect();
    let end = offset.saturating_add(page.chars().count());
    json!({"name":schema.name, "description":schema.description.chars().take(1_000).collect::<String>(),
        "definition_page":{"text":page,"offset":offset,"total_chars":total,"next_offset":if end < total {Some(end)} else {None}},
        "note":"This schema is paged. Read every definition_page before invoking it; concatenate the text as JSON to recover the full description and parameters. Call tool_search with the query below and schema_offset equal to next_offset for the next page.",
        "query":format!("select:{}",schema.name)})
}

fn definition_text(schema: &crate::agent_runtime::api_client::ToolSchema) -> String {
    json!({"name":schema.name,"description":schema.description,"parameters":schema.input_schema})
        .to_string()
}
