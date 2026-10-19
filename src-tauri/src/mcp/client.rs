//! Opening one MCP connection over any transport, on top of rmcp.
//!
//! rmcp runs the protocol: the `initialize` handshake, request ids,
//! notifications, pagination, cancellation. This file decides how the bytes
//! travel (a child process in a job object, Streamable HTTP, or the legacy
//! SSE transport), keeps what the server prints, and bounds the handshake.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
#[allow(deprecated)] // Server logging is deprecated by SEP-2577 but servers still send it.
use rmcp::model::LoggingMessageNotificationParam;
use rmcp::model::{ClientCapabilities, ClientConfig, Implementation};
use rmcp::service::{NotificationContext, RunningService, ServiceExt};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess};
use rmcp::{ClientHandler, RoleClient};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio_util::sync::CancellationToken;

use super::legacy_sse::LegacySseTransport;
use super::types::{McpServerConfig, McpTransportType};

/// Claude Code's default; a server that has not finished `initialize` in 30s
/// is stuck (usually waiting on a prompt nobody can see, or a dead network).
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Lines of server output kept for error messages and the settings page.
const TAIL_LINES: usize = 20;
/// Lines per connection copied into aurora.log, so a chatty server can't
/// rotate the log away. Everything after that only lands in the tail.
const LOGGED_LINES: usize = 60;

pub type Connection = RunningService<RoleClient, AuroraClient>;

/// The last things a server printed (stderr, or stray non-protocol stdout).
#[derive(Default)]
pub struct OutputTail {
    lines: Mutex<VecDeque<String>>,
}

impl OutputTail {
    pub fn push(&self, line: String) {
        let mut lines = self.lines.lock();
        if lines.len() == TAIL_LINES {
            lines.pop_front();
        }
        lines.push_back(line);
    }

    pub fn snapshot(&self) -> Vec<String> {
        self.lines.lock().iter().cloned().collect()
    }

    /// The tail as a block to append to an error, or empty.
    pub fn as_suffix(&self) -> String {
        let lines = self.snapshot();
        if lines.is_empty() {
            String::new()
        } else {
            format!("\n\nThe server's last output:\n{}", lines.join("\n"))
        }
    }
}

/// Aurora's side of the conversation with one server.
#[derive(Clone)]
pub struct AuroraClient {
    pub server_id: String,
    /// Which connection this handler belongs to; late notifications from a
    /// connection that was already replaced are ignored by the manager.
    pub generation: u64,
}

impl ClientHandler for AuroraClient {
    fn get_info(&self) -> ClientConfig {
        ClientConfig::new(
            ClientCapabilities::default(),
            Implementation::new("Aurora", env!("CARGO_PKG_VERSION")),
        )
    }

    async fn on_tool_list_changed(&self, context: NotificationContext<RoleClient>) {
        super::manager::MCP_MANAGER
            .refresh_tools(&self.server_id, self.generation, context.peer.clone())
            .await;
    }

    #[allow(deprecated)]
    async fn on_logging_message(
        &self,
        params: LoggingMessageNotificationParam,
        _context: NotificationContext<RoleClient>,
    ) {
        let data = match &params.data {
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        crate::logging::log_info(
            "mcp",
            &format!(
                "[{}] server log ({:?}): {}",
                self.server_id,
                params.level,
                data.chars().take(500).collect::<String>()
            ),
        );
    }
}

/// Connect `config` (already `${VAR}`-expanded) and finish the handshake.
pub async fn connect(
    config: &McpServerConfig,
    handler: AuroraClient,
    output: Arc<OutputTail>,
    ct: CancellationToken,
) -> Result<Connection, String> {
    let attempt = async {
        match config.transport {
            McpTransportType::Stdio => connect_stdio(config, handler, output.clone(), ct.clone()).await,
            McpTransportType::Http => connect_http(config, handler, ct.clone()).await,
            McpTransportType::Sse => connect_sse(config, handler, ct.clone()).await,
        }
    };
    match tokio::time::timeout(CONNECT_TIMEOUT, attempt).await {
        Ok(Ok(service)) => Ok(service),
        Ok(Err(err)) => {
            ct.cancel();
            Err(format!("{err}{}", output.as_suffix()))
        }
        Err(_) => {
            ct.cancel();
            Err(format!(
                "The server did not finish starting within {}s. It may be waiting for input, \
                 downloading a package, or unable to reach the network.{}",
                CONNECT_TIMEOUT.as_secs(),
                output.as_suffix()
            ))
        }
    }
}

async fn connect_stdio(
    config: &McpServerConfig,
    handler: AuroraClient,
    output: Arc<OutputTail>,
    ct: CancellationToken,
) -> Result<Connection, String> {
    let (command, launch) = super::spawn::build_command(config)?;
    let (process, stderr) = TokioChildProcess::builder(command)
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            format!(
                "Could not start {}: {e}",
                launch
                    .prefix_args
                    .last()
                    .cloned()
                    .unwrap_or_else(|| launch.program.to_string_lossy().into_owned())
            )
        })?;
    crate::logging::log_info(
        "mcp",
        &format!(
            "[{}] started {} (pid {:?})",
            handler.server_id,
            launch.program.display(),
            process.id()
        ),
    );
    if let Some(stderr) = stderr {
        tokio::spawn(drain_stderr(handler.server_id.clone(), stderr, output));
    }
    handler
        .serve_with_ct(process, ct)
        .await
        .map_err(|e| format!("The server started but the MCP handshake failed: {e}"))
}

async fn drain_stderr(server_id: String, stderr: tokio::process::ChildStderr, output: Arc<OutputTail>) {
    let mut lines = BufReader::new(stderr).lines();
    let mut logged = 0usize;
    while let Ok(Some(line)) = lines.next_line().await {
        let line: String = line.chars().take(500).collect();
        if line.trim().is_empty() {
            continue;
        }
        if logged < LOGGED_LINES {
            crate::logging::log_info("mcp", &format!("[{server_id}] stderr: {line}"));
            logged += 1;
        }
        output.push(line);
    }
}

async fn connect_http(
    config: &McpServerConfig,
    handler: AuroraClient,
    ct: CancellationToken,
) -> Result<Connection, String> {
    let url = config
        .url
        .as_deref()
        .ok_or_else(|| "No URL is set for this server.".to_string())?;
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(url.to_string())
            .custom_headers(http_headers(&handler.server_id, &config.headers)?)
            .reinit_on_expired_session(true),
    );
    handler.serve_with_ct(transport, ct).await.map_err(|e| {
        let text = e.to_string();
        let hint = if text.contains("405") {
            " This endpoint rejects POST, so it is likely a legacy SSE server; change its transport to SSE."
        } else if text.contains("401") || text.contains("403") || text.contains("uthoriz") {
            " The server wants credentials; add them under this server's headers."
        } else {
            ""
        };
        format!("Could not connect to {url}: {text}.{hint}")
    })
}

async fn connect_sse(
    config: &McpServerConfig,
    handler: AuroraClient,
    ct: CancellationToken,
) -> Result<Connection, String> {
    let url = config
        .url
        .as_deref()
        .ok_or_else(|| "No URL is set for this server.".to_string())?;
    let transport = LegacySseTransport::connect(&handler.server_id, url, &config.headers).await?;
    handler
        .serve_with_ct(transport, ct)
        .await
        .map_err(|e| format!("Connected to {url} but the MCP handshake failed: {e}"))
}

/// Headers the transport manages itself are dropped (rmcp refuses them).
fn http_headers(
    server_id: &str,
    headers: &HashMap<String, String>,
) -> Result<HashMap<reqwest::header::HeaderName, reqwest::header::HeaderValue>, String> {
    const MANAGED: &[&str] = &["accept", "mcp-session-id", "last-event-id", "content-type"];
    let mut out = HashMap::new();
    for (name, value) in headers {
        if MANAGED.iter().any(|m| name.eq_ignore_ascii_case(m)) {
            crate::logging::log_warn(
                "mcp",
                &format!("[{server_id}] ignoring header '{name}': the transport sets it"),
            );
            continue;
        }
        let header_name = reqwest::header::HeaderName::from_bytes(name.trim().as_bytes())
            .map_err(|_| format!("'{name}' is not a valid header name."))?;
        let header_value = reqwest::header::HeaderValue::from_str(value.trim())
            .map_err(|_| format!("The value of header '{name}' has characters a header can't carry."))?;
        out.insert(header_name, header_value);
    }
    Ok(out)
}
