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
//!    `src/apps/agent/services/skills/surface-doctrine.ts`), so the rules apply
//!    even on a turn where the model never calls a tool.
//! 2. This tool returns the full adapted doctrine on demand, split by topic so
//!    a copy-only task does not pay for the build half.
//!
//! ## The topics are the source skill's own routing table
//!
//! `surface-philosophy` v5 is a router: a short core plus three references
//! loaded per task. The topics here are those rows, so asking for the wrong
//! one is asking for the wrong document rather than for a slice of prose:
//!
//! | topic      | returns                       | for                          |
//! |------------|-------------------------------|------------------------------|
//! | `build`    | core + patterns               | build, restyle, implement UI |
//! | `writing`  | core + writing                | copy only                    |
//! | `audit`    | core + audit + patterns       | review, QA, ship gate        |
//! | `redesign` | core + patterns + writing     | a whole page or product      |
//! | `all`      | everything                    | rare                         |
//!
//! [`doctrine::CORE`] prepends every one of them. It is short, and it carries
//! the classification step and the authority order — without those the rest is
//! a pile of defaults with no rule for what happens when two disagree.
//!
//! The previous two-topic set (`visual` / `writing` / `both`) is still
//! accepted, mapped onto the nearest row. A thread that was mid-turn when this
//! shipped, or a model repeating an enum it saw earlier in its own history,
//! must not get an invalid-argument error for asking the old way.

#![allow(dead_code)]

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor, ToolRegistry};

pub mod doctrine;

pub const TOOL_NAMES: &[&str] = &["design_guidelines"];

/// What a caller gets when it names no topic. Building UI is the overwhelmingly
/// common reason to reach for the doctrine, and it is the topic whose absence
/// shows up in shipped pixels.
const DEFAULT_TOPIC: &str = "build";

/// The topics offered in the schema, in the order they are listed there.
const TOPICS: &[&str] = &["build", "writing", "audit", "redesign", "all"];

/// Assemble the requested reading. [`doctrine::CORE`] leads every one of them.
///
/// `visual` and `both` are the pre-v5 topic names, kept as aliases — see the
/// module docs for why an unknown-topic error would be the wrong answer there.
fn compose(topic: &str) -> Result<String, ToolError> {
    let parts: Vec<&str> = match topic {
        "build" | "visual" => vec![doctrine::CORE, doctrine::PATTERNS],
        "writing" => vec![doctrine::CORE, doctrine::WRITING],
        "audit" => vec![doctrine::CORE, doctrine::AUDIT, doctrine::PATTERNS],
        "redesign" | "both" => vec![doctrine::CORE, doctrine::PATTERNS, doctrine::WRITING],
        "all" => vec![
            doctrine::CORE,
            doctrine::PATTERNS,
            doctrine::WRITING,
            doctrine::AUDIT,
        ],
        other => {
            return Err(ToolError::InvalidInput(format!(
                "topic `{other}` is not one of [{}]",
                TOPICS.join(", ")
            )))
        }
    };

    Ok(parts.join("\n\n---\n\n"))
}

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

Every topic returns the same core first: how to classify the work, and the authority order that \
settles which rule wins. Pick the topic by the job:
- `build` (default) — building, restyling, or implementing UI. Adds layout, type, colour, states, \
assets, motion, dark surfaces, responsive, and performance.
- `writing` — copy only. Labels, buttons, help text, empty/error/success states, pricing and \
billing wording, and ethical interaction psychology.
- `audit` — reviewing, QA, or gating a release. Adds the blocker list, severity levels, the slop \
signals, and the report format.
- `redesign` — a whole page or product, where the words and the layout are decided together.
- `all` — everything. Rare; prefer the narrower topic.

This is standing guidance, not reference trivia: the result tells you what will be rejected, so \
read it before you write the code, not after."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "topic": {
                        "type": "string",
                        "enum": ["build", "writing", "audit", "redesign", "all"],
                        "description": "Which part of the doctrine to load. Defaults to build."
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
            .unwrap_or(DEFAULT_TOPIC);

        Ok(compose(topic)?)
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
            workspace_access: Default::default(),
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            thread_id: "s".into(),
            workspace_root: None,
            cancel_token: CancellationToken::new(),
            spill_dir: None,
        }
    }

    /// Marker headings, one per const, so a test can say WHICH document came
    /// back rather than asserting on a sentence that may be reworded.
    const CORE_MARK: &str = "## Authority order";
    const PATTERNS_MARK: &str = "# Building the surface";
    const WRITING_MARK: &str = "# Surface writing";
    const AUDIT_MARK: &str = "# Audit and ship gates";

    #[tokio::test]
    async fn defaults_to_the_build_topic() {
        let out = DesignGuidelinesTool
            .execute(json!({}), &ctx())
            .await
            .expect("ok");
        assert!(out.contains(CORE_MARK));
        assert!(out.contains(PATTERNS_MARK));
        assert!(
            !out.contains(AUDIT_MARK),
            "building UI must not pay for the review gates"
        );
    }

    /// The classification step and the authority order decide which rule wins
    /// when two disagree. A topic that arrives without them is a pile of
    /// defaults, so every topic carries the core.
    #[tokio::test]
    async fn every_topic_carries_the_core() {
        for topic in TOPICS {
            let out = DesignGuidelinesTool
                .execute(json!({ "topic": topic }), &ctx())
                .await
                .expect("ok");
            assert!(out.contains(CORE_MARK), "`{topic}` dropped the core");
        }
    }

    #[tokio::test]
    async fn each_topic_loads_only_what_its_job_needs() {
        let writing = DesignGuidelinesTool
            .execute(json!({"topic": "writing"}), &ctx())
            .await
            .expect("ok");
        assert!(writing.contains(WRITING_MARK));
        assert!(
            !writing.contains(PATTERNS_MARK) && !writing.contains(AUDIT_MARK),
            "a copy task must not pay for the build or audit halves"
        );

        // Reviewing means judging the build against its own rules, so the
        // audit topic is the one place two documents ship together.
        let audit = DesignGuidelinesTool
            .execute(json!({"topic": "audit"}), &ctx())
            .await
            .expect("ok");
        assert!(audit.contains(AUDIT_MARK) && audit.contains(PATTERNS_MARK));
        assert!(!audit.contains(WRITING_MARK));

        let all = DesignGuidelinesTool
            .execute(json!({"topic": "all"}), &ctx())
            .await
            .expect("ok");
        for mark in [CORE_MARK, PATTERNS_MARK, WRITING_MARK, AUDIT_MARK] {
            assert!(all.contains(mark), "`all` dropped {mark}");
        }
    }

    /// A thread that was mid-turn when the topics changed, or a model copying
    /// an enum out of its own history, must not be answered with an error.
    #[tokio::test]
    async fn the_pre_v5_topic_names_still_resolve() {
        let visual = DesignGuidelinesTool
            .execute(json!({"topic": "visual"}), &ctx())
            .await
            .expect("`visual` is the old name for `build`");
        assert!(visual.contains(PATTERNS_MARK) && !visual.contains(WRITING_MARK));

        let both = DesignGuidelinesTool
            .execute(json!({"topic": "both"}), &ctx())
            .await
            .expect("`both` is the old name for `redesign`");
        assert!(both.contains(PATTERNS_MARK) && both.contains(WRITING_MARK));
    }

    #[tokio::test]
    async fn rejects_an_unknown_topic_with_the_valid_set() {
        let err = DesignGuidelinesTool
            .execute(json!({"topic": "everything"}), &ctx())
            .await
            .expect_err("must reject");
        let message = format!("{err:?}");
        for topic in TOPICS {
            assert!(message.contains(topic), "{message} omits `{topic}`");
        }
    }

    /// The rule the source skill states three separate times, and the one an
    /// agent breaks by reflex — a focus ring is the default in most CSS
    /// frameworks. It must survive any future edit to these consts.
    #[test]
    fn the_no_outer_rings_rule_is_in_the_core_and_both_halves_that_enforce_it() {
        assert!(doctrine::CORE.contains("No outer interaction rings"));
        assert!(doctrine::PATTERNS.contains("no outer rings"));
        assert!(doctrine::AUDIT.contains("outer interaction rings"));
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
