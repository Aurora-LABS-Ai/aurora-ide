//! `design_guidelines` — the one built-in doctrine, delivered as a tool.
//!
//! It is deliberately **not** a skill. Skills are a user-managed catalogue:
//! listable, searchable, toggleable, deletable. This is a standing instruction
//! about how user-facing work must be done, so it is compiled into the binary,
//! never appears in `aurora_skill_search`, and cannot be switched off.
//!
//! Delivery is two-part, mirroring how the source doctrine is organised:
//!
//! 1. A short non-negotiable core ships in every system prompt (built in
//!    `src/services/agent-prompt.ts`), so the rules apply even on a turn where
//!    the model never calls a tool.
//! 2. This tool returns the full adapted doctrine on demand, split by topic so
//!    a copy-only task does not pay for the visual half.

#![allow(dead_code)]

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor, ToolRegistry};

pub mod doctrine;

pub const TOOL_NAMES: &[&str] = &["design_guidelines"];

pub struct DesignGuidelinesTool;

#[async_trait]
impl ToolExecutor for DesignGuidelinesTool {
    fn name(&self) -> &str {
        "design_guidelines"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "design_guidelines".into(),
            description: "Load Aurora's design and interface-writing doctrine. \
Call this BEFORE creating, editing, reviewing, or auditing any user-facing surface — a page, \
panel, component, form, empty/loading/error state, label, button, or piece of copy.

Use `visual` for layout, hierarchy, spacing, colour, dark mode, motion, states, accessibility, and \
the anti-slop checklist. Use `writing` for labels, buttons, help text, empty/error/success states, \
and ethical interaction psychology. Use `both` (the default) when a surface needs words and visuals \
together, which is most of the time.

This is standing guidance, not reference trivia: the result tells you what will be rejected, so \
read it before you write the code, not after."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "topic": {
                        "type": "string",
                        "enum": ["visual", "writing", "both"],
                        "description": "Which half of the doctrine to load. Defaults to both."
                    }
                }
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let topic = input
            .get("topic")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("both");

        let body = match topic {
            "visual" => doctrine::VISUAL.to_string(),
            "writing" => doctrine::WRITING.to_string(),
            "both" => format!("{}\n\n---\n\n{}", doctrine::VISUAL, doctrine::WRITING),
            other => {
                return Err(ToolError::InvalidInput(format!(
                    "topic `{other}` is not one of [visual, writing, both]"
                )))
            }
        };

        Ok(body)
    }
}

pub fn register(reg: &mut ToolRegistry) {
    reg.register(Arc::new(DesignGuidelinesTool));
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_util::sync::CancellationToken;

    fn ctx() -> ToolContext {
        ToolContext {
            allow_outside_workspace: false,
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            thread_id: "s".into(),
            workspace_root: None,
            cancel_token: CancellationToken::new(),
        }
    }

    #[tokio::test]
    async fn defaults_to_both_halves() {
        let out = DesignGuidelinesTool
            .execute(json!({}), &ctx())
            .await
            .expect("ok");
        assert!(out.contains("Visual and interaction doctrine"));
        assert!(out.contains("Surface writing and psychology"));
    }

    #[tokio::test]
    async fn each_topic_returns_only_its_half() {
        let visual = DesignGuidelinesTool
            .execute(json!({"topic": "visual"}), &ctx())
            .await
            .expect("ok");
        assert!(visual.contains("Visual and interaction doctrine"));
        assert!(
            !visual.contains("Surface writing and psychology"),
            "a visual request must not pay for the copy half"
        );

        let writing = DesignGuidelinesTool
            .execute(json!({"topic": "writing"}), &ctx())
            .await
            .expect("ok");
        assert!(writing.contains("Surface writing and psychology"));
        assert!(!writing.contains("Visual and interaction doctrine"));
    }

    #[tokio::test]
    async fn rejects_an_unknown_topic_with_the_valid_set() {
        let err = DesignGuidelinesTool
            .execute(json!({"topic": "everything"}), &ctx())
            .await
            .expect_err("must reject");
        let message = format!("{err:?}");
        assert!(
            message.contains("visual") && message.contains("writing"),
            "{message}"
        );
    }

    #[test]
    fn registers_under_its_documented_name() {
        let mut reg = ToolRegistry::new();
        register(&mut reg);
        assert_eq!(reg.len(), TOOL_NAMES.len());
        let tool = reg.get("design_guidelines").expect("registered");
        assert_eq!(tool.schema().name, "design_guidelines");
        assert!(
            !tool.requires_permission(),
            "reading guidance is not a risk"
        );
    }
}
