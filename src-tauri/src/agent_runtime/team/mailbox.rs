//! `TeamComms` — real agent-to-agent messaging for one dispatched run.
//!
//! The old build runner *faked* every conversation: an `ask_owner` call
//! spawned a fresh model that role-played the teammate, and an `@lead`
//! question was answered by a fresh-context stand-in. This module replaces
//! that theater with actual delivery:
//!
//! - Every member actor registers a **mailbox** here. A message to a member
//!   lands in its mailbox and is injected into its *real* running
//!   conversation at the next tool-result boundary.
//! - `ask()` carries a reply ticket. The addressed member answers with its
//!   `reply` tool, which resolves the asker's pending future — the asker
//!   gets the *real* teammate's answer or an honest timeout, never an
//!   impersonation.
//! - `ask_lead()` parks the question on the **lead inbox**. The frontend
//!   delivers it to the actual chat Lead (the agent-window conversation);
//!   the Lead's `team_reply` resolves it. The member waits in
//!   `waiting_input` and resumes on the answer or on an honest timeout.
//!
//! Everything here is in-memory and scoped to one run: durable records
//! still flow through the [`super::bus::TeamBus`] channel; this is the
//! wiring that makes those visible messages actually *arrive* somewhere.

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};

use super::types::{AgentStatus, MemberRunState};
use super::workspace::now_rfc3339;

/// How long an `ask()` to a peer waits for the addressed member's `reply`
/// before returning an honest "no answer". Peers are usually mid-build; a
/// couple of minutes covers a long tool call without stranding the asker.
pub const PEER_REPLY_TIMEOUT: Duration = Duration::from_secs(150);

/// How long a member waits on the real Lead before it is told to continue
/// on its own judgment. The Lead is a live chat conversation — the user may
/// be away — so a run must never hang on an unanswered question forever.
pub const LEAD_REPLY_TIMEOUT: Duration = Duration::from_secs(240);

/// One message delivered into a member's mailbox.
#[derive(Debug)]
pub struct MemberMessage {
    /// Sender id: a member agent id, `"lead"`, or `"system"`.
    pub from: String,
    /// The message body, ready to inject verbatim.
    pub text: String,
    /// When present, the sender is waiting on `reply(question_id, …)`.
    pub question_id: Option<String>,
}

/// Why a delivery or ask failed. Stringified into tool results so the
/// asking model always learns the *reason*, never a silent nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommsError {
    /// The addressed member isn't (or is no longer) reachable.
    Unreachable(String),
    /// The addressed party never answered inside the window.
    Timeout(String),
}

impl std::fmt::Display for CommsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreachable(who) => write!(
                f,
                "{who} is not reachable (already finished or never started)"
            ),
            Self::Timeout(who) => write!(f, "{who} did not answer in time"),
        }
    }
}

/// A question the team routed to the real Lead, waiting in the lead inbox.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeadQuestion {
    /// Stable id the Lead's `team_reply` targets.
    pub id: String,
    /// The dispatch run this belongs to.
    pub run_id: Option<String>,
    /// Asking member's agent id.
    pub from: String,
    /// Asking member's role (for a readable prompt).
    pub role: String,
    pub question: String,
    pub asked_at: String,
}

/// Shared communication hub for one dispatched run.
///
/// Held as `Arc<TeamComms>` by the dispatcher (keyed by project) so both the
/// member actors *and* the IPC surface (`team_reply`, `team_message`,
/// `team_lead_inbox`) reach the same live wiring.
#[derive(Default)]
pub struct TeamComms {
    /// agent id → live mailbox sender.
    members: Mutex<HashMap<String, mpsc::UnboundedSender<MemberMessage>>>,
    /// question id → pending reply future (peer asks AND lead asks).
    pending: Mutex<HashMap<String, oneshot::Sender<String>>>,
    /// Questions currently waiting on the real Lead, in ask order.
    lead_inbox: Mutex<Vec<LeadQuestion>>,
    /// Monotonic source for question ids.
    next_q: AtomicU64,
    /// Serializes every read-modify-write of the on-disk brain documents
    /// (`team.json`, `scope-map.json`, board, channel). Member actors run on
    /// separate tokio tasks now — the old "one task, interleave only at
    /// `.await`" atomicity argument no longer holds, so brain mutations take
    /// this lock instead. Plain reads stay lock-free.
    brain: tokio::sync::Mutex<()>,
    /// Live per-member run states in roster order — who is working, waiting
    /// on the Lead, done. Actors keep this current; `team_status` reads it.
    states: Mutex<Vec<MemberRunState>>,
}

impl TeamComms {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn lock<'a, T>(m: &'a Mutex<T>) -> std::sync::MutexGuard<'a, T> {
        m.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn next_question_id(&self, prefix: &str) -> String {
        format!("{prefix}-{}", self.next_q.fetch_add(1, Ordering::Relaxed))
    }

    /// Take the brain write-lock for the duration of one read-modify-write
    /// over the on-disk brain. Every mutation site (actor tools, dispatch
    /// bookkeeping, the Lead's grant/reply commands) goes through this.
    pub async fn lock_brain(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.brain.lock().await
    }

    // ── membership ───────────────────────────────────────────────────

    /// Register a member's mailbox; returns the receiving end its actor
    /// pump drains. Registering twice replaces the old mailbox.
    pub fn register(&self, agent_id: &str) -> mpsc::UnboundedReceiver<MemberMessage> {
        let (tx, rx) = mpsc::unbounded_channel();
        Self::lock(&self.members).insert(agent_id.to_string(), tx);
        rx
    }

    /// Drop a member's mailbox (its actor reached a terminal state).
    /// Later messages to it fail fast as [`CommsError::Unreachable`].
    pub fn unregister(&self, agent_id: &str) {
        Self::lock(&self.members).remove(agent_id);
    }

    /// Ids of currently-reachable members.
    #[must_use]
    pub fn reachable(&self) -> Vec<String> {
        Self::lock(&self.members).keys().cloned().collect()
    }

    // ── fire-and-forget delivery ─────────────────────────────────────

    /// Deliver a plain message into one member's mailbox.
    pub fn send_to(&self, to: &str, from: &str, text: &str) -> Result<(), CommsError> {
        let members = Self::lock(&self.members);
        let Some(tx) = members.get(to) else {
            return Err(CommsError::Unreachable(to.to_string()));
        };
        tx.send(MemberMessage {
            from: from.to_string(),
            text: text.to_string(),
            question_id: None,
        })
        .map_err(|_| CommsError::Unreachable(to.to_string()))
    }

    /// Deliver a message to every reachable member except `from`.
    /// Returns the ids actually reached.
    pub fn broadcast(&self, from: &str, text: &str) -> Vec<String> {
        let members = Self::lock(&self.members);
        let mut reached = Vec::new();
        for (id, tx) in members.iter() {
            if id == from {
                continue;
            }
            let ok = tx
                .send(MemberMessage {
                    from: from.to_string(),
                    text: text.to_string(),
                    question_id: None,
                })
                .is_ok();
            if ok {
                reached.push(id.clone());
            }
        }
        reached
    }

    // ── ask a peer and await the real answer ─────────────────────────

    /// Route a question into `to`'s mailbox and wait for its `reply`.
    ///
    /// The returned future resolves with the addressed member's actual
    /// answer, or errs with an honest timeout/unreachable — never a
    /// role-played guess.
    pub async fn ask(
        &self,
        from: &str,
        to: &str,
        question: &str,
        timeout: Duration,
    ) -> Result<String, CommsError> {
        let qid = self.next_question_id("q");
        let (tx, rx) = oneshot::channel::<String>();
        Self::lock(&self.pending).insert(qid.clone(), tx);

        let delivery = {
            let members = Self::lock(&self.members);
            members.get(to).cloned()
        };
        let Some(mailbox) = delivery else {
            Self::lock(&self.pending).remove(&qid);
            return Err(CommsError::Unreachable(to.to_string()));
        };
        let sent = mailbox.send(MemberMessage {
            from: from.to_string(),
            text: question.to_string(),
            question_id: Some(qid.clone()),
        });
        if sent.is_err() {
            Self::lock(&self.pending).remove(&qid);
            return Err(CommsError::Unreachable(to.to_string()));
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(answer)) => Ok(answer),
            // Sender dropped without answering (member ended) or timed out.
            Ok(Err(_)) => {
                Self::lock(&self.pending).remove(&qid);
                Err(CommsError::Unreachable(to.to_string()))
            }
            Err(_) => {
                Self::lock(&self.pending).remove(&qid);
                Err(CommsError::Timeout(to.to_string()))
            }
        }
    }

    /// Resolve a pending question with the addressed member's real answer.
    /// Returns false when the ticket is unknown or already resolved (the
    /// asker may have timed out — the answer still lives in the channel log).
    pub fn resolve(&self, question_id: &str, answer: &str) -> bool {
        let Some(tx) = Self::lock(&self.pending).remove(question_id) else {
            return false;
        };
        tx.send(answer.to_string()).is_ok()
    }

    // ── ask the real Lead ────────────────────────────────────────────

    /// Park a question for the actual chat Lead and wait for `team_reply`.
    ///
    /// The question is exposed on the lead inbox for the frontend notifier
    /// to deliver into the Lead's live conversation. Resolves with the
    /// Lead's structured reply, or errs after `timeout` so an absent user
    /// can never hang the run.
    pub async fn ask_lead(
        &self,
        from: &str,
        role: &str,
        run_id: Option<String>,
        question: &str,
        timeout: Duration,
    ) -> Result<String, CommsError> {
        let qid = self.next_question_id("lead-q");
        let (tx, rx) = oneshot::channel::<String>();
        Self::lock(&self.pending).insert(qid.clone(), tx);
        Self::lock(&self.lead_inbox).push(LeadQuestion {
            id: qid.clone(),
            run_id,
            from: from.to_string(),
            role: role.to_string(),
            question: question.to_string(),
            asked_at: now_rfc3339(),
        });

        let outcome = match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(answer)) => Ok(answer),
            Ok(Err(_)) => Err(CommsError::Unreachable("lead".to_string())),
            Err(_) => Err(CommsError::Timeout("the Lead".to_string())),
        };
        // Whatever happened, the ticket is settled — clear both sides.
        Self::lock(&self.pending).remove(&qid);
        Self::lock(&self.lead_inbox).retain(|q| q.id != qid);
        outcome
    }

    /// Questions currently waiting on the Lead, in ask order.
    #[must_use]
    pub fn lead_pending(&self) -> Vec<LeadQuestion> {
        Self::lock(&self.lead_inbox).clone()
    }

    /// The Lead answered a parked question. Returns false for an unknown
    /// or already-settled ticket.
    pub fn lead_reply(&self, question_id: &str, answer: &str) -> bool {
        self.resolve(question_id, answer)
    }

    // ── live member run states ───────────────────────────────────────

    /// Upsert one member's live state (roster order = first-seen order).
    pub fn set_member_state(&self, id: &str, role: &str, status: AgentStatus) {
        let mut states = Self::lock(&self.states);
        match states.iter_mut().find(|s| s.id == id) {
            Some(s) => s.status = status,
            None => states.push(MemberRunState {
                id: id.to_string(),
                role: role.to_string(),
                status,
                changed_count: 0,
            }),
        }
    }

    /// One more accepted file change for a member.
    pub fn bump_changed(&self, id: &str) {
        let mut states = Self::lock(&self.states);
        if let Some(s) = states.iter_mut().find(|s| s.id == id) {
            s.changed_count += 1;
        }
    }

    /// Snapshot of every member's live state.
    #[must_use]
    pub fn member_states(&self) -> Vec<MemberRunState> {
        Self::lock(&self.states).clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn send_to_reaches_a_registered_mailbox() {
        let comms = TeamComms::new();
        let mut rx = comms.register("nina");
        comms
            .send_to("nina", "lead", "focus on the API surface")
            .unwrap();
        let msg = rx.recv().await.expect("delivered");
        assert_eq!(msg.from, "lead");
        assert_eq!(msg.text, "focus on the API surface");
        assert!(msg.question_id.is_none());
    }

    #[tokio::test]
    async fn send_to_unregistered_member_is_an_honest_error() {
        let comms = TeamComms::new();
        let err = comms.send_to("ghost", "lead", "hi").unwrap_err();
        assert!(matches!(err, CommsError::Unreachable(_)));
        assert!(err.to_string().contains("ghost"));
    }

    #[tokio::test]
    async fn ask_resolves_with_the_real_reply() {
        let comms = std::sync::Arc::new(TeamComms::new());
        let mut rx = comms.register("marco");

        let asker = {
            let comms = comms.clone();
            tokio::spawn(async move {
                comms
                    .ask(
                        "priya",
                        "marco",
                        "what's the pagination cursor type?",
                        Duration::from_secs(5),
                    )
                    .await
            })
        };

        let q = rx
            .recv()
            .await
            .expect("question arrives in marco's mailbox");
        assert_eq!(q.from, "priya");
        let qid = q.question_id.expect("carries a reply ticket");
        assert!(comms.resolve(&qid, "an opaque base64 string, see types.ts"));

        let answer = asker.await.unwrap().expect("asker gets the real answer");
        assert_eq!(answer, "an opaque base64 string, see types.ts");
    }

    #[tokio::test]
    async fn ask_times_out_honestly_when_never_answered() {
        let comms = TeamComms::new();
        let _rx = comms.register("silent");
        let err = comms
            .ask("a", "silent", "anyone home?", Duration::from_millis(30))
            .await
            .unwrap_err();
        assert!(matches!(err, CommsError::Timeout(_)));
        // The stale ticket is gone — a late resolve is a no-op, not a panic.
        assert!(!comms.resolve("q-0", "too late"));
    }

    #[tokio::test]
    async fn ask_unreachable_member_fails_fast() {
        let comms = TeamComms::new();
        let err = comms
            .ask("a", "nobody", "?", Duration::from_secs(5))
            .await
            .unwrap_err();
        assert!(matches!(err, CommsError::Unreachable(_)));
    }

    #[tokio::test]
    async fn lead_ask_shows_in_inbox_and_resolves_on_reply() {
        let comms = std::sync::Arc::new(TeamComms::new());
        let asker = {
            let comms = comms.clone();
            tokio::spawn(async move {
                comms
                    .ask_lead(
                        "lena",
                        "migration-owner",
                        Some("run-1".into()),
                        "may I touch prod config?",
                        Duration::from_secs(5),
                    )
                    .await
            })
        };

        // Poll until the ask lands on the inbox (the asker task must run first).
        let q = loop {
            let pending = comms.lead_pending();
            if let Some(q) = pending.first().cloned() {
                break q;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        };
        assert_eq!(q.from, "lena");
        assert_eq!(q.run_id.as_deref(), Some("run-1"));

        assert!(comms.lead_reply(&q.id, "No — staging only. I granted you config/staging/."));
        let answer = asker.await.unwrap().expect("lead answer arrives");
        assert!(answer.contains("staging only"));
        // Settled ticket left the inbox.
        assert!(comms.lead_pending().is_empty());
    }

    #[tokio::test]
    async fn lead_ask_times_out_and_clears_its_inbox_entry() {
        let comms = TeamComms::new();
        let err = comms
            .ask_lead("sam", "profiler", None, "?", Duration::from_millis(30))
            .await
            .unwrap_err();
        assert!(matches!(err, CommsError::Timeout(_)));
        assert!(comms.lead_pending().is_empty());
    }

    #[tokio::test]
    async fn broadcast_skips_sender_and_reports_reach() {
        let comms = TeamComms::new();
        let mut rx_a = comms.register("a");
        let _rx_b = comms.register("b");
        let mut reached = comms.broadcast("b", "heads up");
        reached.sort();
        assert_eq!(reached, vec!["a".to_string()]);
        assert_eq!(rx_a.recv().await.unwrap().text, "heads up");
    }

    #[tokio::test]
    async fn unregister_makes_member_unreachable() {
        let comms = TeamComms::new();
        let _rx = comms.register("temp");
        comms.unregister("temp");
        assert!(comms.send_to("temp", "lead", "hi").is_err());
        assert!(comms.reachable().is_empty());
    }
}
