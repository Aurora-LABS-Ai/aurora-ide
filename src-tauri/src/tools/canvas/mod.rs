//! `canvas_guidelines` — how to author a live canvas, delivered on demand.
//!
//! Same shape and same reasoning as [`crate::tools::design`]: standing
//! guidance, compiled into the binary, never listed in `aurora_skill_search`,
//! never toggleable. It is a separate tool rather than a `topic` on
//! `design_guidelines` because the trigger is different — `design_guidelines`
//! fires for any user-facing surface, this one fires only when the model is
//! about to write or revise a `react` artifact.
//!
//! The system prompt carries two lines pointing here and nothing else. The
//! whole guide costs tokens only on turns that actually build a canvas, which
//! is the entire reason it is a tool and not prompt text.

#![allow(dead_code)]

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor, ToolRegistry};

pub mod guide;

const REPLY_LAYOUT_GUIDE: &str =
    include_str!("../../../../src/apps/agent/lib/reply-layout/guide.md");
const REPORT_GUIDE: &str = include_str!("../../../../src/canvas-sdk/reporting/GUIDE.md");
const REPORT_EXAMPLE: &str =
    include_str!("../../../../src/canvas-sdk/reporting/examples/royalties.json");

/// The report guide WITH the example its last sentence promises. The guide
/// file ends on "The following complete example reproduces…" and the example
/// is a separate JSON file, so every topic that carries the guide must carry
/// the example too. On 2026-10-29 an agent reported `topic: "canvas"` ending
/// on that sentence with nothing after it; only `reports` appended it.
fn report_guide_with_example() -> String {
    format!("{REPORT_GUIDE}\n\n```aurora-report\n{REPORT_EXAMPLE}\n```")
}

fn canvas_guide() -> String {
    format!("{}\n\n{}", guide::CANVAS_GUIDE, report_guide_with_example())
}

fn guide_for(input: &Value) -> Result<String, ToolError> {
    match input.get("topic") {
        None | Some(Value::Null) => Ok(canvas_guide()),
        Some(Value::String(topic)) => match topic.as_str() {
            "canvas" => Ok(canvas_guide()),
            "reply-layout" => Ok(REPLY_LAYOUT_GUIDE.to_string()),
            "reports" => Ok(report_guide_with_example()),
            _ => Err(ToolError::InvalidInput(
                "topic must be canvas, reply-layout or reports".into(),
            )),
        },
        Some(_) => Err(ToolError::InvalidInput("topic must be a string".into())),
    }
}

pub const TOOL_NAMES: &[&str] = &["canvas_guidelines"];

pub struct CanvasGuidelinesTool;

#[async_trait]
impl ToolExecutor for CanvasGuidelinesTool {
    fn name(&self) -> &str {
        "canvas_guidelines"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "canvas_guidelines".into(),
            description: "Load on-demand authoring rules for reply layouts, interactive reports or a live canvas — a `react` artifact that \
Aurora compiles and RUNS beside the conversation, so it can have working controls instead of \
being a picture of an interface.

Call this BEFORE the first `present_artifact` call with `kind: \"react\"` in a conversation, and \
before revising one if you no longer have these rules in context. It covers when a canvas is the \
right answer at all, the module and export contract the compiler enforces, how to theme against \
Aurora's tokens, and what gets rejected.

Choose topic: reply-layout for native reply blocks, reports for the declarative report contract and connected reporting components, canvas for custom React artifacts. Omit topic for the canvas guide.
You do not need it for `mermaid`, `markdown`, `html`, or `svg` artifacts."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": { "topic": { "type": "string", "enum": ["canvas", "reply-layout", "reports"], "description": "Authoring guide to load; defaults to canvas." } }
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        guide_for(&input)
    }
}

pub fn register(reg: &mut ToolRegistry) {
    reg.register(Arc::new(CanvasGuidelinesTool));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The guide's last sentence promises a complete example; a topic that
    /// ends on that sentence has cut it (reported by an agent, 2026-10-29).
    #[test]
    fn every_topic_carrying_the_report_guide_carries_its_example() {
        let promise = "reproduces the supplied royalty totals";
        for input in [json!({}), json!({"topic":"canvas"}), json!({"topic":"reports"})] {
            let text = guide_for(&input).unwrap();
            let at = text.find(promise).unwrap_or_else(|| panic!("{input}: no promise"));
            assert!(
                text[at..].contains("```aurora-report") && text[at..].contains("Soundrop"),
                "{input}: the example promised at the end of the guide is missing"
            );
            assert!(text.trim_end().ends_with("```"), "{input}: must end on the example");
        }
    }

    #[test]
    fn guides_are_selected_and_invalid_topics_are_explicit() {
        assert!(guide_for(&json!({})).unwrap().contains("export default"));
        assert!(guide_for(&json!({"topic":"reply-layout"}))
            .unwrap()
            .contains("aurora-report"));
        assert!(guide_for(&json!({"topic":"reports"}))
            .unwrap()
            .contains("Soundrop"));
        assert!(guide_for(&json!({"topic":"reports"}))
            .unwrap()
            .contains("stacked-column"));
        assert!(guide_for(&json!({"topic":"unknown"})).is_err());
        assert!(guide_for(&json!({"topic":42})).is_err());
        for component in [
            "Report",
            "Chart",
            "DataTable",
            "Metric",
            "MetricGrid",
            "SearchField",
            "SelectField",
            "MultiSelect",
            "RangeField",
            "Toggle",
        ] {
            assert!(
                REPORT_GUIDE.contains(component),
                "undocumented SDK component: {component}"
            );
        }
    }

    #[test]
    fn registers_under_its_advertised_name() {
        let mut reg = ToolRegistry::default();
        register(&mut reg);
        let tool = reg.get("canvas_guidelines").expect("registered");
        assert_eq!(tool.schema().name, "canvas_guidelines");
        assert_eq!(TOOL_NAMES.len(), 1);
    }

    #[test]
    fn the_guide_states_the_contract_the_compiler_actually_enforces() {
        // These three are compile-time rejections in `services/canvas-react.ts`.
        // If the guide stops naming them, the model learns the rule by failing.
        assert!(guide::CANVAS_GUIDE.contains("export default"));
        assert!(guide::CANVAS_GUIDE.contains("aurora/canvas"));
        assert!(guide::CANVAS_GUIDE.contains("fetch"));
    }

    #[test]
    fn the_guide_names_every_component_the_sdk_exports() {
        // Drift here is silent and expensive: a component the guide never
        // mentions is a component the model never uses, and the fallback is
        // hand-rolled markup — the exact thing the SDK exists to prevent.
        // Mirrors the public surface of `src/canvas-sdk/index.tsx`, which
        // `canvas-sdk.test.ts` pins from the other side.
        for name in [
            "Canvas",
            "Section",
            "List",
            "Row",
            "Stats",
            "Stat",
            "Table",
            "BarChart",
            "Bar",
            "Sparkline",
            "Facts",
            "Fact",
            "Timeline",
            "Event",
            "Tabs",
            "Detail",
            "Columns",
            "Divider",
            "Badge",
            "Note",
            "Text",
            "Code",
            "Stepper",
            "NumberField",
            "Choice",
            "Picker",
            "useHostTheme",
        ] {
            assert!(
                guide::CANVAS_GUIDE.contains(name),
                "canvas_guidelines never mentions `{name}`"
            );
        }
    }

    /// The kind-choice rule is the one line here that also lives in the system
    /// prompt, because it decides something before this tool is ever called.
    /// `agent-prompt.test.ts` pins the other copy; if the wording drifts, one
    /// of the two fails rather than both silently disagreeing.
    #[test]
    fn the_kind_choice_rule_is_stated_up_front() {
        assert!(guide::CANVAS_GUIDE.contains("Pick the kind by what the reader will do with it"));
        assert!(guide::CANVAS_GUIDE.contains("`react` is the default for data"));
        assert!(!guide::CANVAS_GUIDE.contains("cheapest"));
    }

    #[test]
    fn the_guide_refuses_the_shape_that_produced_the_wall_of_cards() {
        assert!(
            guide::CANVAS_GUIDE.contains("there is no `Card` component")
                || guide::CANVAS_GUIDE.contains("no `Card` component")
        );
    }
}
