//! The running-agents trailer on the parent's tool results.
//!
//! The parent is told not to poll its agents. Between reports it was blind:
//! the only look it had was `get_task_output`, a whole tool call we tell it
//! not to make. Alvan's idea (2026-10-29): while agents are running, every
//! tool result the parent gets back ends with a short block naming each
//! running agent and its last two steps. The parent sees its children move
//! as a side effect of its own work, can redirect or stop one early, and
//! never has to ask.
//!
//! Model only. The block is saved as
//! [`ContentBlock::AgentActivity`](crate::agent_runtime::types::ContentBlock::AgentActivity)
//! on the Tool message, which nothing in the window draws.
//!
//! Two gates, both at the call site in the turn loop: the sub-agent switch is
//! on (the runtime is only handed the registry on a parent turn with the
//! switch on), and at least one agent of this parent is running at the
//! boundary. Fail either and the tool result is byte for byte what it is
//! today.
//!
//! Written once and never rebuilt. The old live state block was rebuilt per
//! request and broke the provider's cached prefix every time
//! (`conversation/context_injection.rs`); this one is frozen into the
//! message it rides on, so each request pays for its newest trailer only.

use std::sync::Arc;

use super::record::{TaskRecord, TaskRegistry};

/// Steps shown per running agent.
pub const STEPS_PER_AGENT: usize = 2;

/// The `<agents_running>` block for the parent `parent_thread_id`, or
/// `None` when none of its agents is running.
#[must_use]
pub fn running_agents_block(registry: &TaskRegistry, parent_thread_id: &str) -> Option<String> {
    let mut running: Vec<Arc<TaskRecord>> = registry
        .for_parent(parent_thread_id)
        .into_iter()
        .filter(|record| record.is_running())
        .collect();
    if running.is_empty() {
        return None;
    }
    // `for_parent` is newest first; the trailer reads in the order the
    // parent started them, which is the order it thinks of them in. Two
    // started in the same millisecond (one message, several spawns) fall
    // back to their ids, so the order is the same on every boundary: the
    // registry is a map, and a map's order is not.
    running.sort_by(|a, b| {
        a.started_at_ms
            .cmp(&b.started_at_ms)
            .then_with(|| a.agent_id.cmp(&b.agent_id))
    });
    let mut out = String::from("<agents_running>\n");
    for record in &running {
        out.push_str(&render_line(record));
        out.push('\n');
    }
    out.push_str("</agents_running>");
    Some(out)
}

/// `scout: ran grep "useAuth" · thought: the hook is wrapped twice`.
///
/// The handle is the parent's name for the agent, or its description when
/// it gave none. The steps are the agent's last [`STEPS_PER_AGENT`] from its
/// live stream, in order, the open thought or reply counting as one.
fn render_line(record: &TaskRecord) -> String {
    let handle = record
        .name
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(&record.description);
    // `recent` returns up to n closed entries PLUS whatever is still
    // streaming; keep the last n so the live one is one of the two.
    let recent = record.recent_activity(STEPS_PER_AGENT);
    let skip = recent.len().saturating_sub(STEPS_PER_AGENT);
    let steps: Vec<&str> = recent.iter().skip(skip).map(String::as_str).collect();
    if steps.is_empty() {
        format!("{handle}: starting")
    } else {
        format!("{handle}: {}", steps.join(" · "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::events::AssistantEvent;
    use crate::agent_runtime::subagents::host::SubagentUsage;
    use crate::agent_runtime::subagents::record::TaskStatus;
    use tokio_util::sync::CancellationToken;

    fn record(id: &str, parent: &str, name: Option<&str>, description: &str) -> Arc<TaskRecord> {
        Arc::new(TaskRecord::new(
            id,
            parent,
            "explore",
            name.map(str::to_string),
            description,
            true,
            CancellationToken::new(),
        ))
    }

    fn tool(name: &str, subject: &str) -> AssistantEvent {
        AssistantEvent::ToolUse {
            id: format!("call-{name}-{subject}"),
            name: name.into(),
            input: serde_json::json!({ "path": subject }),
        }
    }

    #[test]
    fn nothing_when_the_parent_has_no_running_agent() {
        let registry = TaskRegistry::new();
        assert_eq!(running_agents_block(&registry, "p"), None);

        let finished = record("agent_a", "p", Some("scout"), "Find the login flow");
        finished.finish(TaskStatus::Completed, Some("done".into()), None, SubagentUsage::default());
        registry.insert(finished);
        assert_eq!(running_agents_block(&registry, "p"), None, "a finished agent is not listed");
    }

    #[test]
    fn each_running_agent_gets_its_last_two_steps_in_start_order() {
        let registry = TaskRegistry::new();
        let scout = record("agent_a", "p", Some("scout"), "Find the login flow");
        scout.observe(&tool("glob", "src/**/*.ts"));
        scout.observe(&tool("grep", "useAuth"));
        scout.observe(&AssistantEvent::Thinking {
            text: "the hook is wrapped twice".into(),
            signature: None,
        });
        // A second record started later, with no name: its description is
        // its handle. One step only.
        let tests = record("agent_b", "p", None, "Run the suite");
        tests.observe(&tool("shell_execute", "pnpm test"));
        // Somebody else's agent, running, must not appear.
        let other = record("agent_c", "other-parent", Some("x"), "x");
        other.observe(&tool("grep", "nope"));
        registry.insert(scout);
        registry.insert(tests);
        registry.insert(other);

        let block = running_agents_block(&registry, "p").expect("two running agents");
        assert_eq!(
            block,
            "<agents_running>\n\
             scout: ran grep useAuth · was thinking: the hook is wrapped twice\n\
             Run the suite: ran shell_execute pnpm test\n\
             </agents_running>",
            "{block}"
        );
        assert!(!block.contains("glob"), "only the last two steps: {block}");
        assert!(!block.contains("nope"), "another parent's agent leaked in: {block}");
    }

    #[test]
    fn an_agent_with_no_step_yet_reads_starting() {
        let registry = TaskRegistry::new();
        registry.insert(record("agent_a", "p", Some("scout"), "Find the login flow"));
        assert_eq!(
            running_agents_block(&registry, "p").unwrap(),
            "<agents_running>\nscout: starting\n</agents_running>"
        );
    }
}
