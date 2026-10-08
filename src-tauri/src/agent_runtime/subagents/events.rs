//! What the window is told about sub-agents.
//!
//! A child's own stream — text, thinking, tool cards — rides the ordinary
//! `agent_event` channel under the child's turn id, exactly like the parent's.
//! What the window cannot learn from that stream is the lifecycle: that a
//! child exists, who started it, which turn id to follow, and when and how it
//! ended. That is this payload, on its own channel, so the Agents panel can
//! keep its list without parsing anybody's transcript.

use serde::Serialize;

use super::host::SubagentUsage;
use super::record::TaskStatus;

/// Wire channel for [`SubagentEvent`].
pub const SUBAGENT_EVENT_CHANNEL: &str = "agent_subagent";

/// `rename_all` on the enum renames the VARIANTS (`type: "started"`); the
/// fields inside a struct variant need their own `rename_all`, or they go out
/// as `agent_id` while the window reads `agentId`. That exact mistake made
/// every event arrive with `agentId: undefined` on the first live run — the
/// window dropped all of them, and an idle parent was never woken. The test
/// below pins the wire shape.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum SubagentEvent {
    /// A child started running. Also sent on resume, with `resumed: true`.
    #[serde(rename_all = "camelCase")]
    Started {
        agent_id: String,
        parent_thread_id: String,
        /// The parent turn that started it, when one did. A resume triggered
        /// from the window has none.
        #[serde(skip_serializing_if = "Option::is_none")]
        parent_turn_id: Option<String>,
        /// Follow this id on `agent_event` to watch the child live.
        turn_id: String,
        agent_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        description: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        background: bool,
        resumed: bool,
        output_file: String,
    },
    /// A child's run ended, one way or another.
    #[serde(rename_all = "camelCase")]
    Finished {
        agent_id: String,
        parent_thread_id: String,
        turn_id: String,
        status: TaskStatus,
        /// The final message or best partial answer; may be empty.
        result: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        usage: SubagentUsage,
        /// Whether the parent will hear about this through its own
        /// conversation (the completion report). `false` when the parent
        /// already has the answer from a synchronous spawn.
        reported_to_parent: bool,
    },
    /// A message was queued for, or delivered to, a running child.
    #[serde(rename_all = "camelCase")]
    Message {
        agent_id: String,
        parent_thread_id: String,
        text: String,
        delivered: bool,
    },
    /// A background child's report is ready and the parent conversation is
    /// IDLE, so nothing in Rust can hand it to the model: the window must
    /// start a turn on `parent_thread_id` with `userMessageOrigin:
    /// "subagent"`, `summary` as the one-line message, `detail` as what the
    /// model reads, and `agent` as the block's identity. When the parent was
    /// running, the report was queued into that turn instead and this event
    /// is not sent — `Finished.reported_to_parent` says which happened.
    #[serde(rename_all = "camelCase")]
    Report {
        agent_id: String,
        parent_thread_id: String,
        agent: crate::agent_runtime::types::AgentReportMeta,
        summary: String,
        detail: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The window reads `agentId` / `parentThreadId` / `turnId`. Pinned,
    /// because the first live run shipped `agent_id` and the window silently
    /// dropped every event (see the enum's doc comment).
    #[test]
    fn every_variant_goes_out_in_camel_case_with_its_type_tag() {
        let events = [
            SubagentEvent::Started {
                agent_id: "agent_1".into(),
                parent_thread_id: "thread-1".into(),
                parent_turn_id: Some("turn-1".into()),
                turn_id: "sub_1".into(),
                agent_type: "explore".into(),
                name: Some("scout".into()),
                description: "Find things".into(),
                model: None,
                background: true,
                resumed: false,
                output_file: "p".into(),
            },
            SubagentEvent::Finished {
                agent_id: "agent_1".into(),
                parent_thread_id: "thread-1".into(),
                turn_id: "sub_1".into(),
                status: TaskStatus::Completed,
                result: "done".into(),
                error: None,
                usage: SubagentUsage::default(),
                reported_to_parent: true,
            },
            SubagentEvent::Message {
                agent_id: "agent_1".into(),
                parent_thread_id: "thread-1".into(),
                text: "more".into(),
                delivered: true,
            },
            SubagentEvent::Report {
                agent_id: "agent_1".into(),
                parent_thread_id: "thread-1".into(),
                agent: crate::agent_runtime::types::AgentReportMeta {
                    agent_id: "agent_1".into(),
                    name: Some("scout".into()),
                    status: "completed".into(),
                },
                summary: "Finished".into(),
                detail: "d".into(),
            },
        ];
        for (event, tag) in events.iter().zip(["started", "finished", "message", "report"]) {
            let json = serde_json::to_value(event).unwrap();
            let obj = json.as_object().unwrap();
            assert_eq!(obj["type"], tag);
            assert_eq!(obj["agentId"], "agent_1", "{tag}: {json}");
            assert_eq!(obj["parentThreadId"], "thread-1", "{tag}: {json}");
            for key in obj.keys() {
                assert!(!key.contains('_'), "{tag} leaks a snake_case key {key}: {json}");
            }
        }
        let finished = serde_json::to_value(&events[1]).unwrap();
        assert_eq!(finished["reportedToParent"], true);
        assert_eq!(finished["turnId"], "sub_1");
        let started = serde_json::to_value(&events[0]).unwrap();
        assert_eq!(started["parentTurnId"], "turn-1");
        assert_eq!(started["outputFile"], "p");
    }
}
