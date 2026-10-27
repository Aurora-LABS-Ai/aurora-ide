//! Events for the browser: one SSE stream per page, carrying every event
//! name that page subscribed to.
//!
//! `GET /api/events/stream` opens a stream and sends `{"stream": "<id>"}` as
//! its `ready` event. The page then `POST`s `/api/events/subscribe` with
//! `{"stream", "event"}` for each name it listens to, and the host forwards
//! every emit of that name (from any part of the backend, to any window) as
//! a message `{"event": name, "payload": …}`. Closing the page closes the
//! stream, which drops its Tauri listeners.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use futures::Stream;
use parking_lot::Mutex;
use serde::Deserialize;
use tauri::{EventId, Listener};
use tokio::sync::mpsc;

use super::WebHost;

#[derive(Default)]
pub(super) struct Streams {
    open: Mutex<HashMap<String, OpenStream>>,
}

struct OpenStream {
    tx: mpsc::UnboundedSender<String>,
    listeners: HashMap<String, EventId>,
}

/// Removes a stream and its listeners when the browser goes away.
struct StreamGuard {
    host: Arc<WebHost>,
    id: String,
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        if let Some(stream) = self.host.streams.open.lock().remove(&self.id) {
            for listener in stream.listeners.into_values() {
                self.host.app.unlisten(listener);
            }
        }
    }
}

pub(super) async fn stream(
    State(host): State<Arc<WebHost>>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let (tx, rx) = mpsc::unbounded_channel::<String>();
    host.streams.open.lock().insert(
        id.clone(),
        OpenStream {
            tx,
            listeners: HashMap::new(),
        },
    );
    let ready = Event::default()
        .event("ready")
        .data(serde_json::json!({ "stream": id }).to_string());
    let guard = StreamGuard { host, id };
    let messages = futures::stream::unfold((rx, guard), |(mut rx, guard)| async move {
        let message = rx.recv().await?;
        Some((Ok(Event::default().data(message)), (rx, guard)))
    });
    let stream = futures::StreamExt::chain(futures::stream::once(async { Ok(ready) }), messages);
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

#[derive(Deserialize)]
pub(super) struct Subscription {
    stream: String,
    event: String,
}

pub(super) async fn subscribe(
    State(host): State<Arc<WebHost>>,
    Json(request): Json<Subscription>,
) -> StatusCode {
    let mut open = host.streams.open.lock();
    let Some(stream) = open.get_mut(&request.stream) else {
        return StatusCode::NOT_FOUND;
    };
    if stream.listeners.contains_key(&request.event) {
        return StatusCode::NO_CONTENT;
    }
    let tx = stream.tx.clone();
    let name = serde_json::to_string(&request.event).unwrap_or_else(|_| "\"\"".into());
    let listener = host.app.listen_any(request.event.clone(), move |event| {
        let payload = match event.payload() {
            "" => "null",
            payload => payload,
        };
        let _ = tx.send(format!(r#"{{"event":{name},"payload":{payload}}}"#));
    });
    stream.listeners.insert(request.event, listener);
    StatusCode::NO_CONTENT
}

pub(super) async fn unsubscribe(
    State(host): State<Arc<WebHost>>,
    Json(request): Json<Subscription>,
) -> StatusCode {
    let listener = host
        .streams
        .open
        .lock()
        .get_mut(&request.stream)
        .and_then(|stream| stream.listeners.remove(&request.event));
    if let Some(listener) = listener {
        host.app.unlisten(listener);
    }
    StatusCode::NO_CONTENT
}
