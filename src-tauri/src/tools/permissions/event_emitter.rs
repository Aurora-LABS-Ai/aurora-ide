//! Production [`PermissionEmitter`]: sends `"agent_permission_request"`
//! through the host's [`crate::host_events::EventSink`].
//!
//! The desktop app passes its `AppHandle` (the windows get the event); a host
//! with no window passes whatever forwards events to its own clients.
//!
//! Compiled out of the verify crate via the `verify_only` feature so
//! the standalone test rig stays free of the host layer.

#![cfg(not(feature = "verify_only"))]

use crate::host_events::Events;
use crate::tools::permissions::prompter::{
    PermissionEmitter, PermissionRequestPayload, PERMISSION_REQUEST_EVENT,
};

/// The matching frontend listener is set up in
/// `src/apps/agent/services/runtime/agent-runtime-client.ts`.
pub struct EventPermissionEmitter {
    events: Events,
}

impl EventPermissionEmitter {
    #[must_use]
    pub fn new(events: Events) -> Self {
        Self { events }
    }
}

impl PermissionEmitter for EventPermissionEmitter {
    fn emit_permission_request(&self, payload: &PermissionRequestPayload) {
        // Best-effort emit. If no client is listening (shutdown, window
        // closed), nobody can approve anyway and the request will
        // eventually be cancelled by the conversation runtime.
        if let Err(err) = self.events.emit(PERMISSION_REQUEST_EVENT, payload) {
            crate::logging::log_warn("permissions", &err);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::host_events::EventSink;

    #[derive(Default)]
    struct Recorded(Mutex<Vec<(String, serde_json::Value)>>);

    impl EventSink for Recorded {
        fn emit_value(&self, event: &str, payload: serde_json::Value) {
            self.0.lock().unwrap().push((event.to_string(), payload));
        }
    }

    #[test]
    fn a_permission_request_goes_out_under_its_event_name_in_camel_case() {
        let sink = Arc::new(Recorded::default());
        let emitter = EventPermissionEmitter::new(sink.clone());
        emitter.emit_permission_request(&PermissionRequestPayload {
            turn_id: "t1".into(),
            tool_use_id: "toolu_1".into(),
            tool_name: "shell_execute".into(),
            input: serde_json::json!({ "command": "ls" }),
        });

        let seen = sink.0.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0, "agent_permission_request");
        assert_eq!(
            seen[0].1,
            serde_json::json!({
                "turnId": "t1",
                "toolUseId": "toolu_1",
                "toolName": "shell_execute",
                "input": { "command": "ls" },
            })
        );
    }
}
