//! Finishing a conversation-only response preserves the child's work result.

use super::*;

impl<E: EventEmitter> ChildRun<E> {
    pub(super) fn finish_message(
        mut self,
        response_status: TaskStatus,
        said: &str,
        error: Option<&str>,
        usage: &SubagentUsage,
        turn_id: &str,
    ) -> ChildFinish {
        let previous = self
            .work_before
            .take()
            .unwrap_or_else(|| TaskSnapshot::from_sidecar(&self.sidecar));
        // The task's status, report, run count and end time are independent of this exchange.
        self.sidecar.updated_at = Utc::now().to_rfc3339();
        self.sidecar.usage.add(usage);
        self.sidecar.context_tokens = self.record.context_tokens().or(self.sidecar.context_tokens);
        if let Err(e) = self.sidecar.save(&self.store) {
            crate::logging::log_warn(
                "subagents",
                &format!(
                    "could not save {} after messaging: {e}",
                    self.record.agent_id
                ),
            );
        }
        let response = if let Some(error) = error {
            format!("Could not answer the message: {error}")
        } else if response_status == TaskStatus::Killed {
            "The message response was stopped before it finished.".into()
        } else if said.trim().is_empty() {
            "Message received. No new work was assigned.".into()
        } else {
            said.to_string()
        };
        let reported_to_parent = self.record.claim_notification()
            && deliver_to_parent(
                &self.registry,
                self.emitter.as_ref(),
                &self.record,
                "running", // Existing message cards have no task outcome.
                report::conversation_reply(
                    &self.record.agent_id,
                    self.record.name.as_deref(),
                    &self.record.agent_type,
                    &self.record.description,
                    &response,
                ),
            )
            .is_ok();
        self.record.finish_message(&previous, usage.clone());
        self.emitter.emit_subagent(&SubagentEvent::Finished {
            agent_id: self.record.agent_id.clone(),
            parent_thread_id: self.record.parent_thread_id.clone(),
            turn_id: turn_id.to_string(),
            status: previous.status,
            result: previous.result.clone().unwrap_or_default(),
            error: previous.error.clone(),
            usage: usage.clone(),
            reported_to_parent,
        });
        ChildFinish {
            status: previous.status,
            result: response,
            error: error.map(str::to_string),
            usage: usage.clone(),
        }
    }
}
