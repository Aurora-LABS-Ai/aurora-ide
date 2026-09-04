//! What the running Aurora publishes about itself, for another process to read.
//!
//! [`presence`](super::presence) answers "is the Aurora process alive". That is
//! all `aurora agent` needs, because a dispatched task is a file that waits.
//! Driving Aurora over MCP needs three more answers that no OS primitive can
//! give:
//!
//! - **Is the Agent Window open?** The window is what runs a task. The process
//!   can be up with only the IDE window showing, and a task dispatched into
//!   that has nobody to claim it.
//! - **Has the user allowed this?** Letting another agent send work into your
//!   editor is off until you turn it on. That switch lives in the Agent
//!   Window's settings and has to be legible from outside the process.
//! - **What is it doing right now?** A caller that can see "busy on the
//!   timeline refactor" asks a different next question than one that cannot.
//!
//! So the app writes a small file and keeps it current. The file is a hint,
//! never an authority: it can outlive the process that wrote it. Every reader
//! pairs it with the presence guard, which the kernel releases on process death
//! however that death happens — so a stale file plus a dead process reads as
//! "not running" rather than as a lie.
//!
//! ## Why not read the database instead
//!
//! The switch is a row in `app_settings`, and a second process could open the
//! same SQLite file to read it. Two reasons not to. The setting is only half
//! the answer — the window's state is not in the database at all, and adding it
//! would mean a write per thread switch to a file the app holds open. And a
//! reader that opens the app's live database to answer "may I?" has taken a
//! lock on the thing it is asking permission to disturb.

use std::fs;
use std::io::Write;

use serde::{Deserialize, Serialize};

use super::presence::aurora_is_running;
use crate::paths;

/// Format version of [`BridgeState`], bumped when a field changes meaning.
///
/// A reader that finds a version it does not know treats the file as absent
/// rather than guessing: half-understood state is how a caller ends up told
/// that a closed window is open.
pub const BRIDGE_FORMAT_VERSION: u32 = 1;

/// What the running app is, and is doing, as of the last time it said so.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeState {
    /// See [`BRIDGE_FORMAT_VERSION`].
    pub version: u32,

    /// Whether the user has allowed outside agents to drive this Aurora.
    ///
    /// Off by default and off in every state where the answer is unknown.
    /// Nothing infers it — the Agent Window publishes the user's actual switch.
    pub enabled: bool,

    /// Whether the Agent Window is open.
    ///
    /// Not "a window exists": the IDE window cannot run a dispatched task.
    pub window_open: bool,

    /// PID of the app that wrote this, for telling a stale file from a current
    /// one when two builds are installed side by side.
    pub pid: u32,

    /// The project the Agent Window is scoped to, when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,

    /// The conversation currently on screen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,

    /// Its title, so a caller can say which conversation it means in words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_title: Option<String>,

    /// `providerId:modelKey` the visible conversation is pinned to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,

    /// Whether a turn is running right now.
    ///
    /// Not a lock. Aurora queues a message sent into a running turn, so this is
    /// information a caller can act on rather than a gate on acting.
    #[serde(default)]
    pub busy: bool,

    /// RFC3339 instant this was written.
    pub updated_at: String,
}

impl BridgeState {
    /// The state of an Aurora that is up with its Agent Window closed.
    ///
    /// Written on window teardown rather than deleting the file, so a reader
    /// can tell "the window was closed" from "this Aurora predates the bridge".
    pub fn window_closed() -> Self {
        Self {
            version: BRIDGE_FORMAT_VERSION,
            enabled: false,
            window_open: false,
            pid: std::process::id(),
            workspace: None,
            thread_id: None,
            thread_title: None,
            model: None,
            busy: false,
            updated_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}

/// Why a tool call cannot be carried out — or that it can.
///
/// One type rather than a bool because every refusal has a different fix, and
/// the caller is an agent that will act on whatever it is told. "Not available"
/// makes it retry or give up; "the Agent Window is closed, open it" makes it
/// ask the user to do the one thing that would work.
#[derive(Debug, Clone)]
pub enum Readiness {
    /// Everything is in place.
    Ready(Box<BridgeState>),
    /// No Aurora process on this machine.
    NotRunning,
    /// Aurora is up, but the Agent Window is not open.
    WindowClosed,
    /// Aurora is up with its window open, and the switch is off.
    Disabled,
}

impl Readiness {
    /// Ask the two sources — the OS, then the file.
    pub fn check() -> Self {
        // The process first. It is the only answer the app cannot get wrong by
        // dying at the wrong moment, and it makes every other read meaningless
        // when it is false.
        if !aurora_is_running() {
            return Self::NotRunning;
        }
        match read() {
            // No file, or one from a build that predates the bridge. The
            // process is up but nothing has claimed a window, so the honest
            // reading is "no window", not "disabled".
            None => Self::WindowClosed,
            Some(state) if !state.window_open => Self::WindowClosed,
            Some(state) if !state.enabled => Self::Disabled,
            Some(state) => Self::Ready(Box::new(state)),
        }
    }

    /// Whether a gated tool may run.
    pub fn is_ready(&self) -> bool {
        matches!(self, Self::Ready(_))
    }

    /// The published state, when there is one to show.
    pub fn state(&self) -> Option<&BridgeState> {
        match self {
            Self::Ready(state) => Some(state),
            _ => None,
        }
    }

    /// A one-word name for the state, for a caller switching on it.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Ready(_) => "ready",
            Self::NotRunning => "not_running",
            Self::WindowClosed => "window_closed",
            Self::Disabled => "disabled",
        }
    }

    /// What to tell a caller that asked for something this state cannot do.
    ///
    /// Written for an agent reading it as its tool result: it says what is
    /// wrong, and the single action that fixes it. No apology, no alternatives
    /// that are also blocked.
    pub fn refusal(&self) -> String {
        match self {
            Self::Ready(_) => String::new(),
            Self::NotRunning => "Aurora is not running on this machine. \
                 Ask the user to start Aurora and open the Agent Window, \
                 then call aurora_agent_status again."
                .to_string(),
            Self::WindowClosed => "Aurora is running but the Agent Window is not open. \
                 The Agent Window is what runs a task, so nothing can be sent until it is. \
                 Ask the user to open it, then call aurora_agent_status again."
                .to_string(),
            Self::Disabled => "Aurora is running with the Agent Window open, but it is not \
                 accepting work from other agents. The user turns this on in the Agent \
                 Window under Settings -> Agent -> \"Let other agents send work to Aurora\". \
                 Only they can do it; it cannot be enabled from here."
                .to_string(),
        }
    }
}

/// Read the published state, or `None` when there is nothing trustworthy.
///
/// Every failure — missing file, unreadable, malformed, a version this build
/// does not speak — collapses to `None`. There is no partial answer worth
/// having here: a caller acting on half-parsed state is exactly the failure
/// this file exists to prevent.
pub fn read() -> Option<BridgeState> {
    let raw = fs::read_to_string(paths::bridge_state_file()).ok()?;
    let state: BridgeState = serde_json::from_str(&raw).ok()?;
    if state.version != BRIDGE_FORMAT_VERSION {
        return None;
    }
    Some(state)
}

/// Publish the current state, atomically.
///
/// Write-then-rename, the same discipline [`super::inbox`] uses for a request:
/// a reader polling this file must see either the previous state or the new
/// one, never the first 40 bytes of the new one. Without it a caller can read a
/// truncated file at the exact moment a turn starts and conclude Aurora is not
/// available.
pub fn publish(state: &BridgeState) -> std::io::Result<()> {
    let final_path = paths::bridge_state_file();
    let temp_path = final_path.with_extension("json.tmp");

    let json = serde_json::to_string_pretty(state)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    {
        let mut file = fs::File::create(&temp_path)?;
        file.write_all(json.as_bytes())?;
        file.flush()?;
    }
    fs::rename(&temp_path, &final_path)
}

/// Record that the Agent Window is gone.
///
/// Called on window teardown and on a clean shutdown. Failure is deliberately
/// swallowed: this runs while the app is being torn down, there is nobody left
/// to tell, and the presence guard already covers the case where the file is
/// left claiming a window that no longer exists.
pub fn clear() {
    let _ = publish(&BridgeState::window_closed());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready_state() -> BridgeState {
        BridgeState {
            version: BRIDGE_FORMAT_VERSION,
            enabled: true,
            window_open: true,
            pid: 4242,
            workspace: Some(r"E:\project".to_string()),
            thread_id: Some("01JQ8FTHREAD".to_string()),
            thread_title: Some("Timeline refactor".to_string()),
            model: Some("fireworks:glm-5.2".to_string()),
            busy: false,
            updated_at: "2026-09-01T14:22:33Z".to_string(),
        }
    }

    #[test]
    fn state_round_trips_as_camel_case() {
        // The frontend publishes this shape. A field renamed on one side and
        // not the other reads as "window closed" and silently disables every
        // tool, which is the worst possible way for a typo to show up.
        let json = serde_json::to_string(&ready_state()).expect("serialise");
        assert!(json.contains("\"windowOpen\""));
        assert!(json.contains("\"threadId\""));
        assert!(json.contains("\"updatedAt\""));
        let back: BridgeState = serde_json::from_str(&json).expect("deserialise");
        assert!(back.window_open);
        assert_eq!(back.thread_title.as_deref(), Some("Timeline refactor"));
    }

    #[test]
    fn a_window_closed_state_is_never_enabled() {
        // Teardown must not leave a file that says work is still accepted.
        let closed = BridgeState::window_closed();
        assert!(!closed.window_open);
        assert!(!closed.enabled);
        assert!(!closed.busy);
    }

    #[test]
    fn every_refusal_names_an_action() {
        // A refusal an agent cannot act on turns into a retry loop, so each one
        // has to end somewhere the caller (or the user) can actually go.
        for state in [
            Readiness::NotRunning,
            Readiness::WindowClosed,
            Readiness::Disabled,
        ] {
            let refusal = state.refusal();
            assert!(!refusal.is_empty(), "{} has no refusal text", state.label());
            assert!(
                refusal.contains("Agent Window") || refusal.contains("start Aurora"),
                "{} does not say what to do: {refusal}",
                state.label()
            );
        }
    }

    #[test]
    fn only_ready_is_ready() {
        assert!(Readiness::Ready(Box::new(ready_state())).is_ready());
        assert!(!Readiness::NotRunning.is_ready());
        assert!(!Readiness::WindowClosed.is_ready());
        assert!(!Readiness::Disabled.is_ready());
        // A refusal for a ready state would be printed nowhere, but an empty
        // string is what proves nothing downstream renders one by accident.
        assert!(Readiness::Ready(Box::new(ready_state())).refusal().is_empty());
    }

    #[test]
    fn labels_are_distinct() {
        // These are switched on by a caller, so two states sharing a label
        // would make "window closed" indistinguishable from "disabled".
        let labels = [
            Readiness::Ready(Box::new(ready_state())).label(),
            Readiness::NotRunning.label(),
            Readiness::WindowClosed.label(),
            Readiness::Disabled.label(),
        ];
        let mut unique = labels.to_vec();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), labels.len());
    }

    #[test]
    fn a_future_version_reads_as_nothing() {
        // Forward compatibility is a refusal, not a guess: a build that half
        // understands a newer file is how a closed window reads as open.
        let mut state = ready_state();
        state.version = BRIDGE_FORMAT_VERSION + 1;
        let json = serde_json::to_string(&state).expect("serialise");
        let parsed: BridgeState = serde_json::from_str(&json).expect("deserialise");
        assert_ne!(parsed.version, BRIDGE_FORMAT_VERSION);
    }
}
