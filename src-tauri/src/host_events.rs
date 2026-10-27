//! Named events core code sends to whoever hosts it.
//!
//! The desktop app forwards them to its windows (`tauri::Emitter::emit`). A
//! host with no window can print them, drop them, or send them on to its own
//! clients. The event name and the JSON payload are the same in every host,
//! so the frontend listens for the same names either way.

use std::sync::Arc;

use serde::Serialize;

pub trait EventSink: Send + Sync + 'static {
    fn emit_value(&self, event: &str, payload: serde_json::Value);
}

pub type Events = Arc<dyn EventSink>;

impl dyn EventSink {
    /// Serialize `payload` and send it as `event`.
    pub fn emit<T: Serialize>(&self, event: &str, payload: T) -> Result<(), String> {
        let value = serde_json::to_value(payload)
            .map_err(|e| format!("could not serialize `{event}` payload: {e}"))?;
        self.emit_value(event, value);
        Ok(())
    }
}

#[cfg(feature = "desktop")]
impl EventSink for tauri::AppHandle {
    fn emit_value(&self, event: &str, payload: serde_json::Value) {
        if let Err(e) = tauri::Emitter::emit(self, event, payload) {
            crate::logging::log_warn("events", &format!("could not send `{event}`: {e}"));
        }
    }
}
