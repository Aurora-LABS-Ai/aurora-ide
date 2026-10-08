//! `list_models` — the models a sub-agent could run on.
//!
//! Aurora can have hundreds of models configured across providers. The
//! parent cannot see Settings, so without this it would guess a model name
//! and get a provider error, or quietly run every child on a model that is
//! wrong for the job. The list is grouped by provider and marks the model
//! the parent itself is on.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::subagents::host::{ModelChoice, ParentTurn, SubagentHost};
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};

use super::optional_str;

pub struct ListModelsTool {
    host: Arc<dyn SubagentHost>,
    parent: Arc<ParentTurn>,
}

impl ListModelsTool {
    #[must_use]
    pub fn new(host: Arc<dyn SubagentHost>, parent: Arc<ParentTurn>) -> Self {
        Self { host, parent }
    }
}

/// Render the list the way a person scans it: provider, then models.
pub(crate) fn render(models: &[ModelChoice], filter: Option<&str>) -> String {
    let needle = filter.map(str::to_ascii_lowercase);
    let mut shown: Vec<&ModelChoice> = models
        .iter()
        .filter(|m| {
            needle.as_deref().is_none_or(|n| {
                m.pin.to_ascii_lowercase().contains(n)
                    || m.provider.to_ascii_lowercase().contains(n)
                    || m.model.to_ascii_lowercase().contains(n)
                    || m.label
                        .as_deref()
                        .is_some_and(|l| l.to_ascii_lowercase().contains(n))
            })
        })
        .collect();
    if shown.is_empty() {
        return match filter {
            Some(f) => format!("No configured model matches {f:?}."),
            None => "No providers are configured in Aurora yet.".to_string(),
        };
    }
    shown.sort_by(|a, b| a.provider.cmp(&b.provider).then_with(|| a.model.cmp(&b.model)));
    let mut lines = Vec::new();
    let mut provider = String::new();
    for m in shown {
        if m.provider != provider {
            provider = m.provider.clone();
            lines.push(format!("\n{provider}"));
        }
        let mut detail = Vec::new();
        if let Some(label) = m.label.as_deref().filter(|l| *l != m.model) {
            detail.push(label.to_string());
        }
        if let Some(window) = m.context_window {
            detail.push(format!("{}k context", window / 1000));
        }
        if let Some(price) = m.price_output_per_mtok {
            detail.push(format!("${price:.2}/M out"));
        }
        if m.current {
            detail.push("this conversation's model".to_string());
        }
        lines.push(format!(
            "  {}{}",
            m.pin,
            if detail.is_empty() {
                String::new()
            } else {
                format!("  ({})", detail.join(", "))
            }
        ));
    }
    lines.push(
        "\nPass the exact `providerId:modelKey` as `model` to spawn_agent. When the choice \
         matters to the user (cost, speed, a model they prefer), ask them with ask_question \
         instead of deciding alone."
            .to_string(),
    );
    lines.join("\n").trim_start().to_string()
}

#[async_trait]
impl ToolExecutor for ListModelsTool {
    fn name(&self) -> &str {
        "list_models"
    }

    fn concurrency_safe(&self) -> bool {
        true
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "list_models".into(),
            description: "List the models the user has configured in Aurora, grouped by provider, \
                          with context window and price where known. Use it to pick a `model` for \
                          spawn_agent — a cheap fast model for exploration, a strong one for a \
                          hard change — or to show the user their options and ask. Optional \
                          `query` filters by provider or model name."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Substring to filter by: a provider name, a model name, or part of either."
                    }
                }
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let models = self
            .host
            .models(&self.parent)
            .map_err(|e| ToolError::Execution(e.to_string()))?;
        Ok(render(&models, optional_str(&input, "query").as_deref()))
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{context, parent_turn, ScriptedHost};
    use super::*;

    fn choice(provider: &str, model: &str, current: bool) -> ModelChoice {
        ModelChoice {
            pin: format!("{provider}:{model}"),
            provider: provider.into(),
            model: model.into(),
            label: None,
            context_window: Some(200_000),
            price_output_per_mtok: Some(15.0),
            current,
        }
    }

    #[tokio::test]
    async fn lists_grouped_by_provider_and_marks_the_current_model() {
        let host = Arc::new(ScriptedHost::default());
        *host.models.lock().unwrap() = vec![
            choice("fireworks", "glm-5.2", false),
            choice("anthropic", "claude-opus-5-5", true),
            choice("anthropic", "claude-sonnet-5-5", false),
        ];
        let parent = parent_turn();
        let tool = ListModelsTool::new(host, parent.clone());
        let out = tool.execute(json!({}), &context(&parent)).await.unwrap();
        let anthropic = out.find("anthropic").unwrap();
        let fireworks = out.find("fireworks").unwrap();
        assert!(anthropic < fireworks, "providers sort by name:\n{out}");
        assert!(out.contains("anthropic:claude-opus-5-5  (200k context, $15.00/M out, this conversation's model)"), "{out}");
        assert!(out.contains("spawn_agent"));
    }

    #[tokio::test]
    async fn a_query_filters_and_a_miss_says_so() {
        let host = Arc::new(ScriptedHost::default());
        *host.models.lock().unwrap() = vec![
            choice("fireworks", "glm-5.2", false),
            choice("anthropic", "claude-opus-5-5", true),
        ];
        let parent = parent_turn();
        let tool = ListModelsTool::new(host, parent.clone());
        let out = tool
            .execute(json!({ "query": "glm" }), &context(&parent))
            .await
            .unwrap();
        assert!(out.contains("fireworks:glm-5.2"));
        assert!(!out.contains("anthropic"));
        let miss = tool
            .execute(json!({ "query": "nothing-here" }), &context(&parent))
            .await
            .unwrap();
        assert!(miss.contains("No configured model matches"));
    }
}
