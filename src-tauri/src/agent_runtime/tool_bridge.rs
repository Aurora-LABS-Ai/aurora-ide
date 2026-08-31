//! Running tools *while* a provider stream is still open.
//!
//! Every provider Aurora talks to except one works the same way: the request
//! ends, the reply carries `tool_use` blocks, Aurora runs them, and the next
//! request carries the results. One round trip per batch, and the runtime's
//! turn loop is built around exactly that rhythm.
//!
//! Cursor's `agent.v1.AgentService/Run` is not that. It is a bidirectional
//! stream: when the model wants a tool it sends `mcp_args` and then **waits on
//! the open connection** for an `McpResult`. Ending the stream to run the tool
//! means re-opening one and re-uploading the entire conversation — measured at
//! one request per tool call and ~15× the token bill of every other provider
//! on the same work.
//!
//! This is the seam that lets such an adapter stay on the line. The adapter
//! holds a [`ToolBridge`]; the runtime services it concurrently with the
//! stream it is driving. Crucially the runtime answers by calling the **same**
//! `execute_tool_calls` every other provider goes through, so the permission
//! gate, read-only concurrency, output caps, tool cards, session spill and the
//! repeat-failure guard are the ones already in place rather than a second
//! implementation that would drift.
//!
//! The adapter also hands over the assistant message segment that produced the
//! calls. The runtime writes that to the session *before* running anything, so
//! the transcript keeps its invariant — every `tool_use` block is followed by
//! its results — and the per-message journal keeps working through a turn that
//! now spans one long connection instead of several short ones.

use tokio::sync::{mpsc, oneshot};

use super::types::ConversationMessage;

/// One tool the model asked for mid-stream.
#[derive(Debug, Clone)]
pub struct BridgeToolCall {
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
}

/// What running one call produced, as the adapter needs to write it back onto
/// the wire.
#[derive(Debug, Clone)]
pub struct BridgeToolResult {
    pub id: String,
    pub content: String,
    pub is_error: bool,
}

/// One adapter request: persist this assistant segment, run these calls, hand
/// the results back.
pub struct BridgeRequest {
    /// The assistant message that carries the `tool_use` blocks for `calls`.
    ///
    /// Sent rather than reconstructed because only the adapter knows where one
    /// segment ends: on a bidirectional wire the model keeps talking after a
    /// tool answers, and the text either side of a call belongs to different
    /// messages.
    pub assistant: ConversationMessage,
    pub calls: Vec<BridgeToolCall>,
    pub reply: oneshot::Sender<BridgeReply>,
}

/// The runtime's answer to one [`BridgeRequest`].
#[derive(Debug, Clone)]
pub struct BridgeReply {
    /// One entry per call, in the order the calls were given.
    pub results: Vec<BridgeToolResult>,
    /// The user pressed Stop. Results that already landed are real and are
    /// still included; the adapter should finish the wire exchange and end the
    /// turn rather than asking for more.
    pub cancelled: bool,
}

/// The handle an adapter holds to reach the runtime's tool executor.
///
/// Cloneable so an adapter can move it into whichever task owns its stream.
#[derive(Clone)]
pub struct ToolBridge(mpsc::Sender<BridgeRequest>);

impl std::fmt::Debug for ToolBridge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ToolBridge")
    }
}

impl ToolBridge {
    #[must_use]
    pub fn new(sender: mpsc::Sender<BridgeRequest>) -> Self {
        Self(sender)
    }

    /// Run one batch and wait for its results.
    ///
    /// `None` means the runtime is no longer listening — the turn was
    /// cancelled, or the loop moved on. Callers must treat that as "stop asking
    /// and end the turn", never as "retry": the far end is holding a stream
    /// open waiting for an answer that is not coming, and hanging on it is the
    /// one failure the user cannot interrupt.
    pub async fn run(
        &self,
        assistant: ConversationMessage,
        calls: Vec<BridgeToolCall>,
    ) -> Option<BridgeReply> {
        let (reply, wait) = oneshot::channel();
        self.0
            .send(BridgeRequest {
                assistant,
                calls,
                reply,
            })
            .await
            .ok()?;
        wait.await.ok()
    }
}
