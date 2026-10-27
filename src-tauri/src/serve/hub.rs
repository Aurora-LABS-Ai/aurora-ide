//! Events for `aurora serve`: the engine's [`EventSink`], fanned out to the
//! browser pages that asked for each name.
//!
//! The contract is the desktop host's (`web_host/events.rs`), so the
//! frontend's `WebRuntime` cannot tell the two apart: one SSE stream per page
//! (`GET /api/events/stream`, a `ready` event carrying `{"stream": id}`), then
//! `POST /api/events/subscribe|unsubscribe` with `{"stream", "event"}`, and
//! each message is `{"event": name, "payload": …}`. The desktop host listens
//! to Tauri for each name; here the engine emits into this hub directly.

use std::collections::{HashMap, HashSet};

use parking_lot::Mutex;
use tokio::sync::mpsc;

use crate::host_events::EventSink;

#[derive(Default)]
pub struct EventHub {
    streams: Mutex<HashMap<String, Subscriber>>,
}

struct Subscriber {
    tx: mpsc::UnboundedSender<String>,
    names: HashSet<String>,
}

impl EventHub {
    /// A new stream; its messages arrive on the receiver.
    pub fn open(&self) -> (String, mpsc::UnboundedReceiver<String>) {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let (tx, rx) = mpsc::unbounded_channel();
        self.streams.lock().insert(
            id.clone(),
            Subscriber {
                tx,
                names: HashSet::new(),
            },
        );
        (id, rx)
    }

    /// `false` when the stream is not (or no longer) open.
    pub fn subscribe(&self, stream: &str, event: &str) -> bool {
        match self.streams.lock().get_mut(stream) {
            Some(subscriber) => {
                subscriber.names.insert(event.to_string());
                true
            }
            None => false,
        }
    }

    pub fn unsubscribe(&self, stream: &str, event: &str) {
        if let Some(subscriber) = self.streams.lock().get_mut(stream) {
            subscriber.names.remove(event);
        }
    }

    /// The page went away.
    pub fn close(&self, stream: &str) {
        self.streams.lock().remove(stream);
    }

    #[cfg(test)]
    pub fn open_count(&self) -> usize {
        self.streams.lock().len()
    }
}

impl EventSink for EventHub {
    fn emit_value(&self, event: &str, payload: serde_json::Value) {
        let streams = self.streams.lock();
        let mut message: Option<String> = None;
        for subscriber in streams.values() {
            if !subscriber.names.contains(event) {
                continue;
            }
            let text = message.get_or_insert_with(|| {
                serde_json::json!({ "event": event, "payload": payload }).to_string()
            });
            // A closed page's receiver is gone; its guard removes the entry.
            let _ = subscriber.tx.send(text.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_event_reaches_only_the_pages_that_subscribed_to_it() {
        let hub = EventHub::default();
        let (a, mut rx_a) = hub.open();
        let (_b, mut rx_b) = hub.open();
        assert!(hub.subscribe(&a, "agent_event"));

        hub.emit_value("agent_event", serde_json::json!({ "seq": 1 }));
        hub.emit_value("other", serde_json::json!(null));

        assert_eq!(
            rx_a.try_recv().unwrap(),
            r#"{"event":"agent_event","payload":{"seq":1}}"#
        );
        assert!(rx_a.try_recv().is_err(), "an unsubscribed name is not sent");
        assert!(rx_b.try_recv().is_err(), "a page that did not subscribe gets nothing");

        hub.unsubscribe(&a, "agent_event");
        hub.emit_value("agent_event", serde_json::json!({ "seq": 2 }));
        assert!(rx_a.try_recv().is_err());
    }

    #[test]
    fn a_closed_stream_cannot_subscribe() {
        let hub = EventHub::default();
        let (id, _rx) = hub.open();
        hub.close(&id);
        assert!(!hub.subscribe(&id, "agent_event"));
        assert_eq!(hub.open_count(), 0);
    }
}
