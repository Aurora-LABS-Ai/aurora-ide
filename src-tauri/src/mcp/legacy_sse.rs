//! The legacy HTTP+SSE transport (MCP 2024-11-05) as an rmcp [`Transport`].
//!
//! rmcp ships stdio and Streamable HTTP only; older hosted servers still speak
//! this one: `GET` the URL, read an `endpoint` event naming where to POST, then
//! POST every frame there. **Replies arrive on the event stream**, not in the
//! POST response — the previous client parsed the POST body as the reply,
//! which only worked against servers that bent the spec. Both are accepted
//! here: stream `message` events and any JSON a POST happens to return go to
//! the same inbound queue, and the rmcp service correlates ids.

use std::collections::HashMap;
use std::time::Duration;

use eventsource_stream::Eventsource;
use futures::StreamExt;
use reqwest::Client;
use rmcp::service::{RxJsonRpcMessage, TxJsonRpcMessage};
use rmcp::transport::Transport;
use rmcp::RoleClient;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

const ENDPOINT_TIMEOUT: Duration = Duration::from_secs(20);
const INBOUND_CAPACITY: usize = 256;

pub struct LegacySseTransport {
    client: Client,
    post_url: String,
    headers: HashMap<String, String>,
    inbound: mpsc::Receiver<RxJsonRpcMessage<RoleClient>>,
    /// Weak, so the stream reader holds the only strong sender: when the
    /// stream ends, `receive()` returns `None` and the service closes.
    inbound_tx: mpsc::WeakSender<RxJsonRpcMessage<RoleClient>>,
    reader: JoinHandle<()>,
}

impl LegacySseTransport {
    /// Open the event stream and wait for the server to name its POST URL.
    pub async fn connect(
        server_id: &str,
        url: &str,
        headers: &HashMap<String, String>,
    ) -> Result<Self, String> {
        let client = Client::new();
        let mut request = client.get(url).header("Accept", "text/event-stream");
        for (k, v) in headers {
            request = request.header(k, v);
        }
        let response = request
            .send()
            .await
            .map_err(|e| format!("Could not reach {url}: {e}"))?;
        if !response.status().is_success() {
            // 405 is a Streamable HTTP server: the spec lets it reject GET.
            let hint = if response.status() == reqwest::StatusCode::METHOD_NOT_ALLOWED {
                " This server speaks Streamable HTTP; change its transport to HTTP."
            } else if matches!(response.status().as_u16(), 401 | 403) {
                " The server rejected the credentials; check this server's headers."
            } else {
                ""
            };
            return Err(format!("{url} answered {}.{hint}", response.status()));
        }

        let (inbound_tx, inbound) = mpsc::channel(INBOUND_CAPACITY);
        let (endpoint_tx, endpoint_rx) = oneshot::channel::<String>();
        let inbound_weak = inbound_tx.downgrade();
        let reader = tokio::spawn(read_events(
            server_id.to_string(),
            response,
            endpoint_tx,
            inbound_tx,
        ));

        let endpoint = match tokio::time::timeout(ENDPOINT_TIMEOUT, endpoint_rx).await {
            Ok(Ok(endpoint)) => endpoint,
            Ok(Err(_)) => {
                reader.abort();
                return Err("The event stream closed before the server named its endpoint.".into());
            }
            Err(_) => {
                reader.abort();
                return Err(format!(
                    "The server sent no endpoint event within {}s. If it is a Streamable HTTP server, change its transport to HTTP.",
                    ENDPOINT_TIMEOUT.as_secs()
                ));
            }
        };

        Ok(Self {
            client,
            post_url: join_endpoint(url, &endpoint),
            headers: headers.clone(),
            inbound,
            inbound_tx: inbound_weak,
            reader,
        })
    }
}

/// The `endpoint` event may be absolute or relative to the stream URL's origin.
fn join_endpoint(stream_url: &str, endpoint: &str) -> String {
    if endpoint.starts_with("http://") || endpoint.starts_with("https://") {
        return endpoint.to_string();
    }
    match reqwest::Url::parse(stream_url).and_then(|base| base.join(endpoint)) {
        Ok(joined) => joined.to_string(),
        Err(_) => format!(
            "{}/{}",
            stream_url.trim_end_matches('/'),
            endpoint.trim_start_matches('/')
        ),
    }
}

async fn read_events(
    server_id: String,
    response: reqwest::Response,
    endpoint_tx: oneshot::Sender<String>,
    inbound_tx: mpsc::Sender<RxJsonRpcMessage<RoleClient>>,
) {
    let mut endpoint_tx = Some(endpoint_tx);
    let mut stream = response.bytes_stream().eventsource();
    while let Some(event) = stream.next().await {
        let event = match event {
            Ok(event) => event,
            Err(err) => {
                crate::logging::log_warn(
                    "mcp",
                    &format!("[{server_id}] event stream error: {err}"),
                );
                break;
            }
        };
        match event.event.as_str() {
            "endpoint" => {
                if let Some(tx) = endpoint_tx.take() {
                    let _ = tx.send(event.data);
                }
            }
            "" | "message" => {
                if event.data.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<RxJsonRpcMessage<RoleClient>>(&event.data) {
                    Ok(message) => {
                        if inbound_tx.send(message).await.is_err() {
                            break;
                        }
                    }
                    Err(err) => crate::logging::log_warn(
                        "mcp",
                        &format!("[{server_id}] unreadable message on event stream: {err}"),
                    ),
                }
            }
            _ => {}
        }
    }
    // Dropping `inbound_tx` here ends `receive()`, which closes the service.
}

impl Transport<RoleClient> for LegacySseTransport {
    type Error = std::io::Error;

    fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleClient>,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send + 'static {
        let mut request = self.client.post(&self.post_url).json(&item);
        for (k, v) in &self.headers {
            request = request.header(k, v);
        }
        let inbound_tx = self.inbound_tx.clone();
        async move {
            let response = request
                .send()
                .await
                .map_err(|e| std::io::Error::other(format!("POST failed: {e}")))?;
            let status = response.status();
            if !status.is_success() {
                let body = response.text().await.unwrap_or_default();
                let snippet: String = body.trim().chars().take(300).collect();
                return Err(std::io::Error::other(format!(
                    "server answered {status}{}{snippet}",
                    if snippet.is_empty() { "" } else { ": " }
                )));
            }
            // Compliant servers answer 202 with no body. Some reply inline;
            // route that reply the same way a stream message would go.
            if let Ok(text) = response.text().await {
                if let (Ok(message), Some(tx)) = (
                    serde_json::from_str::<RxJsonRpcMessage<RoleClient>>(&text),
                    inbound_tx.upgrade(),
                ) {
                    let _ = tx.send(message).await;
                }
            }
            Ok(())
        }
    }

    fn receive(
        &mut self,
    ) -> impl std::future::Future<Output = Option<RxJsonRpcMessage<RoleClient>>> + Send {
        self.inbound.recv()
    }

    fn close(&mut self) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send {
        self.reader.abort();
        std::future::ready(Ok(()))
    }
}

impl Drop for LegacySseTransport {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::join_endpoint;

    #[test]
    fn relative_endpoint_joins_the_stream_origin() {
        assert_eq!(
            join_endpoint("https://x.test/sse", "/messages?sessionId=1"),
            "https://x.test/messages?sessionId=1"
        );
        assert_eq!(
            join_endpoint("https://x.test/sse", "https://y.test/m"),
            "https://y.test/m"
        );
    }
}
