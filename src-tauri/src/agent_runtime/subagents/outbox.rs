//! Reports waiting to wake an idle parent [outbox].
//!
//! A child reporting to a BUSY parent goes into that turn's queue and the
//! runtime drains it at the next tool boundary: Rust owns it from the moment
//! it is sent. A child reporting to an IDLE parent had no such home. Rust
//! emitted a `Report` event and forgot the report; the window parked the
//! event in memory and started a turn from its copy. On 2026-10-08 four
//! reports were emitted on time, the window processed none of them for 58
//! seconds (the event channel was the bottleneck), and when they did land two
//! drains raced for the same idle moment and one report was never sent.
//!
//! Now every idle delivery is recorded here first and stays until the window
//! says a turn carrying it has opened (`claim`). The event is a wake-up call;
//! this is the record. The window's list poll reads `pending` too, so a report
//! reaches the parent within one poll even when no event arrives at all.
//!
//! In memory only: a report pending at shutdown is not re-sent on the next
//! start. The child's own transcript and its report file keep the text.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};

use dashmap::DashMap;
use serde::{Deserialize, Serialize};

use crate::agent_runtime::types::AgentReportMeta;

/// One report (or mid-run message) addressed to an idle parent, not yet
/// carried by a turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingWake {
    /// Unique for the life of the process, increasing in delivery order.
    pub id: u64,
    pub parent_thread_id: String,
    pub agent: AgentReportMeta,
    /// The one-line transcript message.
    pub summary: String,
    /// What the model reads.
    pub detail: String,
    pub queued_at_ms: i64,
}

/// Pending wakes per parent conversation, oldest first.
#[derive(Debug, Default)]
pub struct WakeOutbox {
    next_id: AtomicU64,
    by_parent: DashMap<String, VecDeque<PendingWake>>,
}

impl WakeOutbox {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a wake for `parent_thread_id`. Returns the entry with its id,
    /// which the wake event carries so the window can claim exactly this one.
    pub fn push(
        &self,
        parent_thread_id: &str,
        agent: AgentReportMeta,
        summary: String,
        detail: String,
    ) -> PendingWake {
        let wake = PendingWake {
            id: self.next_id.fetch_add(1, Ordering::SeqCst) + 1,
            parent_thread_id: parent_thread_id.to_string(),
            agent,
            summary,
            detail,
            queued_at_ms: chrono::Utc::now().timestamp_millis(),
        };
        self.by_parent
            .entry(parent_thread_id.to_string())
            .or_default()
            .push_back(wake.clone());
        wake
    }

    /// Everything still waiting for `parent_thread_id`, oldest first.
    #[must_use]
    pub fn pending(&self, parent_thread_id: &str) -> Vec<PendingWake> {
        self.by_parent
            .get(parent_thread_id)
            .map(|entry| entry.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Take one wake out, once: the window calls this after the turn that
    /// carries it has opened. `None` when it was already claimed or never
    /// existed, so a second claimant knows to stay silent.
    pub fn claim(&self, parent_thread_id: &str, id: u64) -> Option<PendingWake> {
        let mut entry = self.by_parent.get_mut(parent_thread_id)?;
        let index = entry.iter().position(|wake| wake.id == id)?;
        let taken = entry.remove(index);
        if entry.is_empty() {
            drop(entry);
            self.by_parent
                .remove_if(parent_thread_id, |_, queue| queue.is_empty());
        }
        taken
    }

    /// How many wakes wait for `parent_thread_id`.
    #[must_use]
    pub fn len(&self, parent_thread_id: &str) -> usize {
        self.by_parent
            .get(parent_thread_id)
            .map_or(0, |entry| entry.len())
    }

    #[must_use]
    pub fn is_empty(&self, parent_thread_id: &str) -> bool {
        self.len(parent_thread_id) == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(agent_id: &str) -> AgentReportMeta {
        AgentReportMeta {
            agent_id: agent_id.into(),
            name: Some(agent_id.into()),
            status: "completed".into(),
        }
    }

    #[test]
    fn wakes_are_kept_in_delivery_order_per_parent() {
        let outbox = WakeOutbox::new();
        let a = outbox.push("p1", meta("a"), "A done".into(), "a".into());
        let b = outbox.push("p1", meta("b"), "B done".into(), "b".into());
        let other = outbox.push("p2", meta("c"), "C done".into(), "c".into());
        assert!(a.id < b.id && b.id < other.id);
        let pending = outbox.pending("p1");
        assert_eq!(pending.iter().map(|w| w.id).collect::<Vec<_>>(), vec![a.id, b.id]);
        assert_eq!(outbox.pending("p2").len(), 1);
        assert!(outbox.pending("nobody").is_empty());
    }

    #[test]
    fn a_wake_is_claimed_exactly_once_and_the_rest_stay() {
        let outbox = WakeOutbox::new();
        let a = outbox.push("p1", meta("a"), "A".into(), "a".into());
        let b = outbox.push("p1", meta("b"), "B".into(), "b".into());
        let c = outbox.push("p1", meta("c"), "C".into(), "c".into());
        // Claiming the middle one leaves the others in order: the window
        // claims whichever it carried, which is not always the oldest.
        assert_eq!(outbox.claim("p1", b.id).map(|w| w.summary), Some("B".into()));
        assert!(outbox.claim("p1", b.id).is_none(), "a second claimant stays silent");
        assert_eq!(
            outbox.pending("p1").iter().map(|w| w.id).collect::<Vec<_>>(),
            vec![a.id, c.id]
        );
        assert!(outbox.claim("p2", a.id).is_none(), "ids are scoped to the parent");
        assert!(outbox.claim("p1", a.id).is_some());
        assert!(outbox.claim("p1", c.id).is_some());
        assert!(outbox.is_empty("p1"));
        assert_eq!(outbox.len("p1"), 0);
    }

    #[test]
    fn a_wake_goes_out_in_camel_case() {
        let outbox = WakeOutbox::new();
        let wake = outbox.push("p1", meta("a"), "A".into(), "a".into());
        let json = serde_json::to_value(&wake).unwrap();
        let obj = json.as_object().unwrap();
        assert_eq!(obj["parentThreadId"], "p1");
        assert_eq!(obj["agent"]["agentId"], "a");
        assert!(obj.contains_key("queuedAtMs"));
        for key in obj.keys() {
            assert!(!key.contains('_'), "snake_case key on the wire: {key}");
        }
    }
}
