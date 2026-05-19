//! MCP Manager — async actor-per-server.
//!
//! Every connected server gets one `tokio::spawn`ed actor task. The actor
//! owns the I/O resources (stdio child process or HTTP client) and a
//! pending-request map keyed by JSON-RPC id; callers post `OutboundRequest`s
//! over an mpsc channel and await a oneshot reply. This rewrite fixes five
//! distinct bugs in the legacy synchronous implementation:
//!
//!   * **No id correlation.** The old `call_tool_stdio` read exactly one
//!     line from stdout and assumed it was the response. MCP servers
//!     routinely emit `notifications/message`, log frames, and resource
//!     update notifications between request and response — the next
//!     tool call would then read the *real* response thinking it was its
//!     own, cascading desync until the agent gave up with
//!     "No result in response". The actor now matches `id` and routes
//!     notifications to a dedicated handler.
//!   * **Stderr never drained.** Chatty Node/npm-based servers fill the
//!     64 KB Windows pipe buffer and deadlock waiting for someone to
//!     read stderr. We now spawn a per-connection drain task that logs
//!     lines via `eprintln!` so the pipe stays unblocked.
//!   * **Blocking I/O under a parking_lot RwLock.** Old code held the
//!     write lock across `read_line` calls; we now use `tokio::process`
//!     and an `mpsc` so a slow/stuck server only blocks itself.
//!   * **No request timeout.** Each call now races a configurable
//!     deadline (60s, matching the frontend ceiling in `mcp-tools.ts`)
//!     so a hung server cannot park the agent loop forever.
//!   * **No reconnect signal.** When the child dies the actor's stdout
//!     reader hits EOF, fails every pending oneshot with a clear
//!     "process likely crashed" error, and the actor exits — subsequent
//!     calls return "not connected" instead of "broken pipe".
//!
//! The public surface (`McpManager::connect_server`, `call_tool`,
//! `disconnect_server`, …) is unchanged so `mcp/commands.rs` and the
//! frontend keep working without modification.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use eventsource_stream::Eventsource;
use futures::stream::StreamExt;
use parking_lot::RwLock;
use reqwest::Client;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use super::config::McpConfig;
use super::types::*;

/// Hard wall-clock cap on a single MCP request (initialize, tools/list,
/// tools/call, …). Matches the frontend ceiling in `mcp-tools.ts` so the
/// outer `Promise.race` and the inner Rust timeout converge on the same
/// "give up" semantics rather than racing each other.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// Per-step timeout used during the connect handshake. Tighter than the
/// per-call ceiling because if `initialize` doesn't reply in 20s the
/// server is almost certainly broken (or fighting Node startup) and the
/// user needs to know now rather than waiting a full minute.
const CONNECT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);

/// One outbound JSON-RPC message bound for the server. Callers fill in
/// `method` + `params`; the actor allocates the `id` and parks
/// `response_tx` in its pending map. `is_notification` skips the id
/// allocation and resolves the oneshot immediately after the write so
/// callers can still observe write failures.
struct OutboundRequest {
    method: String,
    params: Value,
    response_tx: oneshot::Sender<Result<Value, String>>,
    is_notification: bool,
}

/// What we keep in `McpManager::connections` for each live server.
///
/// The `_shutdown` oneshot is held purely so that dropping the handle
/// signals the actor to clean up; we never `.send(())` it explicitly
/// because the actor's `select!` arm fires on the channel-closed event
/// just as well as on a successful send.
struct ConnectionHandle {
    request_tx: mpsc::UnboundedSender<OutboundRequest>,
    _transport: McpTransportType,
    _shutdown: oneshot::Sender<()>,
    _join: JoinHandle<()>,
}

/// MCP Manager — handles server lifecycle, handshake, and tool calls.
pub struct McpManager {
    /// Server state (config + status + advertised tools/resources).
    servers: RwLock<HashMap<String, McpServerState>>,
    /// Live connection actors, keyed by server id.
    connections: RwLock<HashMap<String, ConnectionHandle>>,
}

impl McpManager {
    pub fn new() -> Self {
        Self {
            servers: RwLock::new(HashMap::new()),
            connections: RwLock::new(HashMap::new()),
        }
    }

    // -----------------------------------------------------------------
    // Config + state surface (unchanged behaviour from the old manager)
    // -----------------------------------------------------------------

    /// Load servers from the config file, preserving existing connection
    /// state for ids already known to the runtime.
    pub fn load_config(&self) -> Result<Vec<McpServerState>, String> {
        let config = McpConfig::load()?;
        let server_configs = config.to_server_configs();

        let mut servers = self.servers.write();
        for config in &server_configs {
            if let Some(existing) = servers.get_mut(&config.id) {
                existing.config = config.clone();
            } else {
                servers.insert(config.id.clone(), McpServerState::new(config.clone()));
            }
        }
        Ok(servers.values().cloned().collect())
    }

    pub fn get_servers(&self) -> Vec<McpServerState> {
        self.servers.read().values().cloned().collect()
    }

    pub fn get_server(&self, id: &str) -> Option<McpServerState> {
        self.servers.read().get(id).cloned()
    }

    pub fn add_server(&self, config: McpServerConfig) -> Result<McpServerState, String> {
        let mut mcp_config = McpConfig::load().unwrap_or_default();
        mcp_config.upsert_server(&config);
        mcp_config.save()?;

        let state = McpServerState::new(config.clone());
        self.servers.write().insert(config.id.clone(), state.clone());
        Ok(state)
    }

    pub fn remove_server(&self, id: &str) -> Result<(), String> {
        self.disconnect_server(id)?;
        let mut mcp_config = McpConfig::load().unwrap_or_default();
        mcp_config.remove_server(id);
        mcp_config.save()?;
        self.servers.write().remove(id);
        Ok(())
    }

    pub fn update_server(&self, config: McpServerConfig) -> Result<McpServerState, String> {
        let id = config.id.clone();

        // Decide *before* mutating state whether the edit invalidates
        // the live connection. The old behaviour was to disconnect on
        // every update, which made flipping a checkbox like
        // `autoApprove` or renaming a server kick the user back to
        // `disconnected` — and combined with the missing auto-start
        // hook on the frontend, that meant every cosmetic edit cost
        // an extra play-button click.
        //
        // `transport_dirty` lists the fields whose value actually
        // changes how the child process or HTTP endpoint is launched.
        // Anything not in that list (name, enabled, autoStart,
        // autoApprove) is metadata and the existing connection stays
        // valid.
        let previous = self.get_server(&id);
        let transport_dirty = match &previous {
            Some(existing) => {
                let a = &existing.config;
                let b = &config;
                a.transport != b.transport
                    || a.command != b.command
                    || a.args != b.args
                    || a.env != b.env
                    || a.url != b.url
                    || a.headers != b.headers
            }
            None => true,
        };

        if transport_dirty {
            let _ = self.disconnect_server(&id);
        }

        let mut mcp_config = McpConfig::load().unwrap_or_default();
        mcp_config.upsert_server(&config);
        mcp_config.save()?;

        // Preserve the live connection's runtime state (status, tools,
        // resources, server_info) across non-transport edits — only
        // the `config` field actually changed.
        let next_state = if transport_dirty {
            McpServerState::new(config)
        } else if let Some(mut keep) = previous {
            keep.config = config;
            keep
        } else {
            McpServerState::new(config)
        };

        self.servers.write().insert(id, next_state.clone());
        Ok(next_state)
    }

    pub fn toggle_server(&self, id: &str, enabled: bool) -> Result<McpServerState, String> {
        let mut mcp_config = McpConfig::load().unwrap_or_default();
        if !mcp_config.toggle_server(id, enabled) {
            return Err(format!("Server '{}' not found", id));
        }
        mcp_config.save()?;

        {
            let mut servers = self.servers.write();
            if let Some(state) = servers.get_mut(id) {
                state.config.enabled = enabled;
            } else {
                return Err(format!("Server '{}' not found", id));
            }
        }
        if !enabled {
            let _ = self.disconnect_server(id);
        }
        self.get_server(id)
            .ok_or_else(|| format!("Server '{}' not found", id))
    }

    // -----------------------------------------------------------------
    // Connection lifecycle
    // -----------------------------------------------------------------

    pub async fn connect_server(&self, id: &str) -> Result<McpServerState, String> {
        let config = self
            .get_server(id)
            .map(|s| s.config)
            .ok_or_else(|| format!("Server '{}' not found", id))?;

        if !config.enabled {
            return Err(format!("Server '{}' is disabled", id));
        }

        // If something was already connected under this id, tear it down
        // first so we don't leak an actor or a child process.
        let _ = self.disconnect_server(id);

        {
            let mut servers = self.servers.write();
            if let Some(state) = servers.get_mut(id) {
                state.status = McpServerStatus::Connecting;
                state.error = None;
            }
        }

        let result = match config.transport {
            McpTransportType::Stdio => self.connect_stdio(id, &config).await,
            McpTransportType::Sse => self.connect_sse(id, &config).await,
        };

        if let Err(err) = &result {
            // Surface the failure on the server state so the UI can show
            // it without a separate IPC round-trip.
            let mut servers = self.servers.write();
            if let Some(state) = servers.get_mut(id) {
                state.status = McpServerStatus::Error;
                state.error = Some(err.clone());
            }
        }
        result
    }

    pub fn disconnect_server(&self, id: &str) -> Result<(), String> {
        // Dropping the handle drops the shutdown oneshot Sender, which
        // wakes the actor's `select!` and lets it clean up gracefully.
        // The JoinHandle is also dropped — we don't `.await` it because
        // disconnect_server is sync; the actor's `Drop` impls take it
        // from here.
        self.connections.write().remove(id);

        let mut servers = self.servers.write();
        if let Some(state) = servers.get_mut(id) {
            state.status = McpServerStatus::Disconnected;
            state.error = None;
            state.tools.clear();
            state.resources.clear();
            state.server_info = None;
        }
        Ok(())
    }

    async fn connect_stdio(
        &self,
        id: &str,
        config: &McpServerConfig,
    ) -> Result<McpServerState, String> {
        let command = config
            .command
            .as_ref()
            .ok_or_else(|| "No command specified for stdio transport".to_string())?;

        let mut cmd = Command::new(command);
        cmd.args(&config.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (key, value) in &config.env {
            cmd.env(key, value);
        }
        #[cfg(windows)]
        {
            // CREATE_NO_WINDOW so the spawned `cmd.exe` / `node.exe` does
            // not flash a console on every Aurora launch.
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn MCP server '{}': {}", id, e))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to take MCP stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to take MCP stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Failed to take MCP stderr".to_string())?;

        let (request_tx, request_rx) = mpsc::unbounded_channel::<OutboundRequest>();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        let actor_id = id.to_string();
        let join = tokio::spawn(stdio_actor(
            actor_id,
            child,
            stdin,
            stdout,
            stderr,
            request_rx,
            shutdown_rx,
        ));

        let handle = ConnectionHandle {
            request_tx: request_tx.clone(),
            _transport: McpTransportType::Stdio,
            _shutdown: shutdown_tx,
            _join: join,
        };

        // Run the MCP handshake through the freshly-built actor. If any
        // step fails, drop the handle locally — that signals the actor
        // to shut down and kills the child via `kill_on_drop`.
        match handshake(&request_tx).await {
            Ok((server_info, tools, resources)) => {
                self.connections.write().insert(id.to_string(), handle);

                let mut servers = self.servers.write();
                let state = servers
                    .get_mut(id)
                    .ok_or_else(|| format!("Server '{}' not found after connection", id))?;
                state.status = McpServerStatus::Connected;
                state.error = None;
                state.tools = tools;
                state.resources = resources;
                state.server_info = server_info;
                Ok(state.clone())
            }
            Err(err) => {
                // `handle` drops here → actor shuts down → child is killed
                // by `kill_on_drop`. No leak.
                drop(handle);
                Err(err)
            }
        }
    }

    async fn connect_sse(
        &self,
        id: &str,
        config: &McpServerConfig,
    ) -> Result<McpServerState, String> {
        let url = config
            .url
            .as_ref()
            .ok_or_else(|| "No URL specified for SSE transport".to_string())?;

        let client = Client::new();
        let mut request_builder = client.get(url).header("Accept", "text/event-stream");
        for (key, value) in &config.headers {
            request_builder = request_builder.header(key, value);
        }

        let response = request_builder
            .send()
            .await
            .map_err(|e| format!("Failed to connect to SSE endpoint: {}", e))?;
        if !response.status().is_success() {
            return Err(format!(
                "SSE endpoint returned status: {}",
                response.status()
            ));
        }

        let mut stream = response.bytes_stream().eventsource();
        let (endpoint_tx, endpoint_rx) = oneshot::channel::<String>();
        let mut endpoint_tx = Some(endpoint_tx);
        let stream_id = id.to_string();
        let stream_handle = tokio::spawn(async move {
            while let Some(event) = stream.next().await {
                match event {
                    Ok(event) => {
                        if event.event == "endpoint" {
                            if let Some(tx) = endpoint_tx.take() {
                                let _ = tx.send(event.data);
                            }
                        } else if !event.event.is_empty() {
                            // Server-pushed notifications. We don't have an
                            // event channel into the agent yet; log and
                            // drop so chatty servers don't bloat memory.
                            eprintln!(
                                "[mcp:{}] sse event '{}' (ignored)",
                                stream_id, event.event
                            );
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        let post_endpoint = match tokio::time::timeout(
            CONNECT_HANDSHAKE_TIMEOUT,
            endpoint_rx,
        )
        .await
        {
            Ok(Ok(endpoint)) => {
                if endpoint.starts_with("http") {
                    endpoint
                } else {
                    let base = url.trim_end_matches('/');
                    let path = endpoint.trim_start_matches('/');
                    format!("{}/{}", base, path)
                }
            }
            Ok(Err(_)) => {
                stream_handle.abort();
                return Err("Failed to receive endpoint event".to_string());
            }
            Err(_) => {
                stream_handle.abort();
                return Err("Timed out waiting for endpoint event".to_string());
            }
        };

        let (request_tx, request_rx) = mpsc::unbounded_channel::<OutboundRequest>();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        let actor_id = id.to_string();
        let join = tokio::spawn(sse_actor(
            actor_id,
            client,
            post_endpoint,
            config.headers.clone(),
            request_rx,
            shutdown_rx,
            stream_handle,
        ));

        let handle = ConnectionHandle {
            request_tx: request_tx.clone(),
            _transport: McpTransportType::Sse,
            _shutdown: shutdown_tx,
            _join: join,
        };

        match handshake(&request_tx).await {
            Ok((server_info, tools, resources)) => {
                self.connections.write().insert(id.to_string(), handle);

                let mut servers = self.servers.write();
                let state = servers
                    .get_mut(id)
                    .ok_or_else(|| format!("Server '{}' not found after connection", id))?;
                state.status = McpServerStatus::Connected;
                state.error = None;
                state.tools = tools;
                state.resources = resources;
                state.server_info = server_info;
                Ok(state.clone())
            }
            Err(err) => {
                drop(handle);
                Err(err)
            }
        }
    }

    // -----------------------------------------------------------------
    // Tool calls
    // -----------------------------------------------------------------

    pub async fn call_tool(
        &self,
        request: McpToolCallRequest,
    ) -> Result<McpToolCallResult, String> {
        let server_id = request.server_id.clone();

        // Mirror the pre-rewrite contract: a not-yet-Connected server
        // gets an explicit "is not connected" error rather than letting
        // the lower layer fail with the more generic actor-channel-closed
        // message.
        {
            let servers = self.servers.read();
            let state = servers
                .get(&server_id)
                .ok_or_else(|| format!("Server '{}' not found", server_id))?;
            if state.status != McpServerStatus::Connected {
                return Err(format!("Server '{}' is not connected", server_id));
            }
        }

        let params = json!({
            "name": request.tool_name,
            "arguments": request.arguments.unwrap_or(json!({}))
        });

        let raw = self.send_request(&server_id, "tools/call", params).await?;
        Ok(self.cap_output(parse_tool_response(raw)))
    }

    /// Snapshot of every advertised tool across every *currently
    /// connected* server. Used by the frontend `getMcpToolDefinitions`
    /// fallback path.
    pub fn get_all_tools(&self) -> Vec<(String, McpToolInfo)> {
        let servers = self.servers.read();
        let mut all = Vec::new();
        for (id, state) in servers.iter() {
            if state.status == McpServerStatus::Connected {
                for tool in &state.tools {
                    all.push((id.clone(), tool.clone()));
                }
            }
        }
        all
    }

    // -----------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------

    /// Send one JSON-RPC request through the per-server actor and await
    /// the matching response (correlated by id, racing `REQUEST_TIMEOUT`).
    async fn send_request(
        &self,
        server_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let tx = {
            let conns = self.connections.read();
            conns
                .get(server_id)
                .map(|h| h.request_tx.clone())
                .ok_or_else(|| format!("Server '{}' is not connected", server_id))?
        };

        let (resp_tx, resp_rx) = oneshot::channel();
        tx.send(OutboundRequest {
            method: method.to_string(),
            params,
            response_tx: resp_tx,
            is_notification: false,
        })
        .map_err(|_| {
            "MCP server actor channel closed — server may have crashed, reconnect via Settings"
                .to_string()
        })?;

        match tokio::time::timeout(REQUEST_TIMEOUT, resp_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(format!(
                "MCP response channel for '{}' was dropped (actor died mid-request)",
                method
            )),
            Err(_) => Err(format!(
                "MCP request '{}' timed out after {}s",
                method,
                REQUEST_TIMEOUT.as_secs()
            )),
        }
    }

    /// Trim every text content item in a tool result to 500 lines so a
    /// runaway server doesn't trash the agent's context window.
    /// Identical semantics to the pre-rewrite `cap_output`.
    fn cap_output(&self, mut result: McpToolCallResult) -> McpToolCallResult {
        if let Some(content) = &mut result.content {
            for item in content {
                if let Some(text) = &mut item.text {
                    let lines: Vec<&str> = text.lines().collect();
                    if lines.len() > 500 {
                        let truncated = lines[..500].join("\n");
                        *text = format!(
                            "{}\n\n... [Output truncated to 500 lines to save context]",
                            truncated
                        );
                    }
                }
            }
        }
        result
    }
}

impl Default for McpManager {
    fn default() -> Self {
        Self::new()
    }
}

// =============================================================================
// Actor tasks
// =============================================================================

/// Stdio actor. Owns the child process and serialises every JSON-RPC
/// exchange with it. Three concurrent flows:
///
///   1. **Request channel** (`request_rx`) — caller-issued
///      `OutboundRequest`s. The actor allocates an id, writes the frame
///      to stdin, parks the response sender in `pending`.
///   2. **Inbound channel** (`resp_rx`) — JSON values posted by the
///      stdout reader sub-task. The actor matches them against
///      `pending` and resolves the right oneshot, or logs as a
///      notification if there is no matching id.
///   3. **Shutdown** — dropping the `ConnectionHandle` closes
///      `shutdown_rx`, which lets the `select!` exit cleanly.
async fn stdio_actor(
    server_id: String,
    mut child: Child,
    mut stdin: ChildStdin,
    stdout: ChildStdout,
    stderr: ChildStderr,
    mut request_rx: mpsc::UnboundedReceiver<OutboundRequest>,
    mut shutdown_rx: oneshot::Receiver<()>,
) {
    // ----- stderr drain ---------------------------------------------------
    // Without this, chatty MCP servers (most npx-based ones print
    // warnings on startup) fill the 64 KB Windows pipe buffer and the
    // server deadlocks waiting to write to stderr while we wait for
    // stdout — the canonical "MCP sometimes works, sometimes hangs"
    // failure mode. We just read-and-log; nothing depends on the lines.
    let stderr_id = server_id.clone();
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        loop {
            match reader.next_line().await {
                Ok(Some(line)) => eprintln!("[mcp:{}] stderr: {}", stderr_id, line),
                Ok(None) => break,
                Err(err) => {
                    eprintln!("[mcp:{}] stderr read error: {}", stderr_id, err);
                    break;
                }
            }
        }
    });

    // ----- stdout reader --------------------------------------------------
    // Hands every parsed JSON line back to the actor over an mpsc so the
    // actor can do id correlation in one place. We can't merge this into
    // the `select!` below because `tokio::io::Lines` isn't fused and the
    // back-pressure on an unbounded channel is more natural.
    let (inbound_tx, mut inbound_rx) = mpsc::unbounded_channel::<Value>();
    let reader_id = server_id.clone();
    let reader_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        loop {
            match reader.next_line().await {
                Ok(Some(line)) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<Value>(trimmed) {
                        Ok(value) => {
                            if inbound_tx.send(value).is_err() {
                                // Actor has exited; nothing left to do.
                                break;
                            }
                        }
                        Err(err) => {
                            // Some servers emit pretty-printed log lines
                            // on stdout. They're not protocol violations
                            // exactly; just log and continue.
                            eprintln!(
                                "[mcp:{}] non-JSON stdout line: {} (err: {})",
                                reader_id, trimmed, err
                            );
                        }
                    }
                }
                Ok(None) => {
                    // EOF — child closed stdout, almost certainly because
                    // it crashed or exited. The actor will translate this
                    // into a failure for every pending request.
                    break;
                }
                Err(err) => {
                    eprintln!("[mcp:{}] stdout read error: {}", reader_id, err);
                    break;
                }
            }
        }
    });

    // ----- main loop ------------------------------------------------------
    let mut next_id: i64 = 0;
    let mut pending: HashMap<i64, oneshot::Sender<Result<Value, String>>> = HashMap::new();

    loop {
        tokio::select! {
            // `biased` so shutdown wins over a fresh request when both are
            // ready — prevents a burst of requests from delaying cleanup.
            biased;
            _ = &mut shutdown_rx => {
                break;
            }
            maybe_req = request_rx.recv() => {
                let Some(req) = maybe_req else { break; };
                if req.is_notification {
                    let frame = json!({
                        "jsonrpc": "2.0",
                        "method": req.method,
                        "params": req.params,
                    });
                    match write_frame(&mut stdin, &frame).await {
                        Ok(()) => { let _ = req.response_tx.send(Ok(Value::Null)); }
                        Err(err) => { let _ = req.response_tx.send(Err(err)); }
                    }
                } else {
                    next_id += 1;
                    let id = next_id;
                    let frame = json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "method": req.method,
                        "params": req.params,
                    });
                    match write_frame(&mut stdin, &frame).await {
                        Ok(()) => { pending.insert(id, req.response_tx); }
                        Err(err) => { let _ = req.response_tx.send(Err(err)); }
                    }
                }
            }
            maybe_msg = inbound_rx.recv() => {
                match maybe_msg {
                    Some(msg) => dispatch_inbound(msg, &mut pending, &server_id),
                    None => {
                        // Reader task closed → stdout EOF → child gone.
                        // Fail every pending caller with a precise error
                        // so the UI can offer a "Reconnect" CTA instead
                        // of the generic "broken pipe".
                        for (_, sender) in pending.drain() {
                            let _ = sender.send(Err(
                                "MCP server stdout closed — process likely crashed".into()
                            ));
                        }
                        break;
                    }
                }
            }
        }
    }

    // ----- cleanup --------------------------------------------------------
    reader_task.abort();
    stderr_task.abort();
    let _ = child.start_kill();
    for (_, sender) in pending.drain() {
        let _ = sender.send(Err("MCP server actor shut down".into()));
    }
    // Reap the child to avoid a zombie on Unix; on Windows this is a no-op.
    let _ = child.wait().await;
    eprintln!("[mcp:{}] stdio actor exited", server_id);
}

/// SSE actor. Simpler than the stdio actor because the legacy MCP SSE
/// transport delivers responses on the POST reply itself, not on the
/// event stream, so we don't need an id-correlation table — the HTTP
/// request *is* the correlator. We still run every call through a single
/// actor so id allocation stays monotonic and so disconnect cleanup goes
/// through one code path.
async fn sse_actor(
    server_id: String,
    client: Client,
    post_endpoint: String,
    headers: HashMap<String, String>,
    mut request_rx: mpsc::UnboundedReceiver<OutboundRequest>,
    mut shutdown_rx: oneshot::Receiver<()>,
    stream_handle: JoinHandle<()>,
) {
    let mut next_id: i64 = 0;
    loop {
        tokio::select! {
            biased;
            _ = &mut shutdown_rx => break,
            maybe_req = request_rx.recv() => {
                let Some(req) = maybe_req else { break; };

                let frame = if req.is_notification {
                    json!({
                        "jsonrpc": "2.0",
                        "method": req.method,
                        "params": req.params,
                    })
                } else {
                    next_id += 1;
                    json!({
                        "jsonrpc": "2.0",
                        "id": next_id,
                        "method": req.method,
                        "params": req.params,
                    })
                };

                let mut builder = client.post(&post_endpoint).json(&frame);
                for (k, v) in headers.iter() {
                    builder = builder.header(k, v);
                }

                let result = async {
                    let resp = builder
                        .send()
                        .await
                        .map_err(|e| format!("HTTP send failed: {}", e))?;
                    if !resp.status().is_success() {
                        return Err(format!("HTTP {} from SSE endpoint", resp.status()));
                    }
                    if req.is_notification {
                        return Ok(Value::Null);
                    }
                    let body = resp
                        .json::<Value>()
                        .await
                        .map_err(|e| format!("Failed to parse JSON response: {}", e))?;
                    if let Some(err) = body.get("error") {
                        let message = err
                            .get("message")
                            .and_then(|v| v.as_str())
                            .unwrap_or("Unknown JSON-RPC error")
                            .to_string();
                        return Err(message);
                    }
                    Ok(body.get("result").cloned().unwrap_or(Value::Null))
                }
                .await;
                let _ = req.response_tx.send(result);
            }
        }
    }
    stream_handle.abort();
    eprintln!("[mcp:{}] sse actor exited", server_id);
}

// =============================================================================
// Helpers
// =============================================================================

async fn write_frame(stdin: &mut ChildStdin, frame: &Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(frame)
        .map_err(|e| format!("Failed to serialize JSON-RPC frame: {}", e))?;
    bytes.push(b'\n');
    stdin
        .write_all(&bytes)
        .await
        .map_err(|e| format!("Failed to write to MCP stdin: {}", e))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush MCP stdin: {}", e))?;
    Ok(())
}

/// Route one parsed JSON-RPC frame from the server to the right place:
///
///   * a `(id, result|error)` pair → look up the matching pending oneshot
///   * a `(method, no id)` frame → notification, log and ignore
///   * anything else → log as malformed
///
/// `id` is matched as `i64`; we always allocate i64 ids ourselves so this
/// is lossless. A response that arrives after its matching pending entry
/// already timed out gets logged so the operator can spot the lag.
fn dispatch_inbound(
    msg: Value,
    pending: &mut HashMap<i64, oneshot::Sender<Result<Value, String>>>,
    server_id: &str,
) {
    let id = msg.get("id").and_then(|v| v.as_i64());
    let has_result_or_error = msg.get("result").is_some() || msg.get("error").is_some();
    let has_method = msg.get("method").is_some();

    if let (Some(id), true) = (id, has_result_or_error) {
        if let Some(sender) = pending.remove(&id) {
            if let Some(error) = msg.get("error") {
                let message = error
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown JSON-RPC error")
                    .to_string();
                let _ = sender.send(Err(message));
            } else {
                let result = msg.get("result").cloned().unwrap_or(Value::Null);
                let _ = sender.send(Ok(result));
            }
        } else {
            eprintln!(
                "[mcp:{}] response for unknown id {} (already timed out?): {}",
                server_id, id, msg
            );
        }
    } else if has_method {
        let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("?");
        // Future work: forward `notifications/message` and `notifications/resources/updated`
        // to the frontend via a tauri event. For now just log so we
        // can spot servers that depend on us handling notifications.
        eprintln!("[mcp:{}] notification '{}' (ignored)", server_id, method);
    } else {
        eprintln!("[mcp:{}] malformed JSON-RPC frame: {}", server_id, msg);
    }
}

/// Run the MCP initialize → initialized → tools/list → resources/list
/// handshake through `request_tx`. Shared by stdio and SSE since the
/// JSON-RPC envelope is transport-independent.
async fn handshake(
    request_tx: &mpsc::UnboundedSender<OutboundRequest>,
) -> Result<
    (
        Option<McpServerInfo>,
        Vec<McpToolInfo>,
        Vec<McpResourceInfo>,
    ),
    String,
> {
    // initialize
    let init = send_handshake(
        request_tx,
        "initialize",
        json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "Aurora", "version": "1.0.0" }
        }),
        false,
    )
    .await
    .map_err(|e| format!("Initialize failed: {}", e))?;

    let server_info = init.get("serverInfo").map(|info| McpServerInfo {
        name: info
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown")
            .to_string(),
        version: info
            .get("version")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    });

    // initialized notification — fire and forget, but await the write so
    // we get a clear error if stdin is already broken.
    let _ = send_handshake(request_tx, "notifications/initialized", json!({}), true).await;

    // tools/list — this one being missing is a fatal handshake error
    // because every other layer in Aurora assumes the tool list is known
    // at connect time.
    let tools_result = send_handshake(request_tx, "tools/list", json!({}), false)
        .await
        .map_err(|e| format!("tools/list failed: {}", e))?;
    let tools = parse_tools(&tools_result);

    // resources/list — optional. A server that doesn't implement it
    // returns a JSON-RPC error; we swallow that so the connection still
    // counts as a success.
    let resources = match send_handshake(request_tx, "resources/list", json!({}), false).await {
        Ok(v) => parse_resources(&v),
        Err(_) => Vec::new(),
    };

    Ok((server_info, tools, resources))
}

async fn send_handshake(
    request_tx: &mpsc::UnboundedSender<OutboundRequest>,
    method: &str,
    params: Value,
    is_notification: bool,
) -> Result<Value, String> {
    let (tx, rx) = oneshot::channel();
    request_tx
        .send(OutboundRequest {
            method: method.to_string(),
            params,
            response_tx: tx,
            is_notification,
        })
        .map_err(|_| format!("Actor channel closed before '{}'", method))?;

    match tokio::time::timeout(CONNECT_HANDSHAKE_TIMEOUT, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(format!(
            "Actor died before responding to '{}' (handshake aborted)",
            method
        )),
        Err(_) => Err(format!(
            "Handshake step '{}' timed out after {}s",
            method,
            CONNECT_HANDSHAKE_TIMEOUT.as_secs()
        )),
    }
}

fn parse_tools(result: &Value) -> Vec<McpToolInfo> {
    // Tolerate the same shape variants the old code did:
    // `{ "tools": [...] }`, `[...]`, or a top-level `{ "tools": [...] }`
    // outside `result` (some non-compliant servers).
    let array = result
        .get("tools")
        .and_then(|v| v.as_array())
        .or_else(|| result.as_array());
    let mut tools = Vec::new();
    if let Some(arr) = array {
        for tool in arr {
            tools.push(McpToolInfo {
                name: tool
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string(),
                description: tool
                    .get("description")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                input_schema: tool.get("inputSchema").cloned(),
            });
        }
    }
    tools
}

fn parse_resources(result: &Value) -> Vec<McpResourceInfo> {
    let array = result
        .get("resources")
        .and_then(|v| v.as_array())
        .or_else(|| result.as_array());
    let mut resources = Vec::new();
    if let Some(arr) = array {
        for resource in arr {
            resources.push(McpResourceInfo {
                uri: resource
                    .get("uri")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                name: resource
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string(),
                description: resource
                    .get("description")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                mime_type: resource
                    .get("mimeType")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
            });
        }
    }
    resources
}

/// Convert a `tools/call` `result` payload into the public
/// `McpToolCallResult` shape. This is also the layer that produces the
/// dreaded "No result in response" error from the legacy code — now
/// rephrased to point at the actual cause (response had no `content`
/// array and was not an error).
fn parse_tool_response(result: Value) -> McpToolCallResult {
    let is_error = result.get("isError").and_then(|v| v.as_bool());

    let content = result
        .get("content")
        .and_then(|c| c.as_array())
        .map(|content_array| {
            content_array
                .iter()
                .map(|item| McpToolContent {
                    content_type: item
                        .get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("text")
                        .to_string(),
                    text: item
                        .get("text")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    data: item
                        .get("data")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    mime_type: item
                        .get("mimeType")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                })
                .collect::<Vec<_>>()
        });

    McpToolCallResult {
        success: !is_error.unwrap_or(false),
        content,
        error: None,
        is_error,
    }
}

// =============================================================================
// Global instance
// =============================================================================

lazy_static::lazy_static! {
    pub static ref MCP_MANAGER: Arc<McpManager> = Arc::new(McpManager::new());
}
