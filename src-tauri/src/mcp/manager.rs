//! The one owner of every MCP server's life.
//!
//! Before this rewrite the frontend decided when servers started: each
//! window's store ran its own auto-start, and a connect always tore down the
//! existing process first, so two windows booting together killed and
//! respawned each other's servers. Now:
//!
//! * Rust reads both config scopes — `~/.aurora/mcp.json` (global) and the
//!   workspace's `.mcp.json` files (project, off until turned on) — and
//!   starts auto-start servers once per app, at launch and when the workspace
//!   changes.
//! * `connect_server` is idempotent: a running server is returned as is.
//!   Only `restart_server` replaces a live process.
//! * Every state change is pushed to all windows as `mcp_servers_changed`,
//!   so the stores render Rust's state instead of guessing their own.
//! * A connection that drops is noticed (the rmcp service ends), reported
//!   with the server's last output, and — for remote servers — retried with
//!   growing delays. Local servers are not respawned in a loop.
//! * Every start, stop and failure is written to aurora.log under `mcp`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use rmcp::model::{CallToolRequest, CallToolRequestParams, ServerResult};
use rmcp::service::{Peer, PeerRequestOptions, QuitReason, ServiceError};
use rmcp::RoleClient;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;

use super::client::{self, AuroraClient, OutputTail};
use super::config::{self, McpConfig, ProjectApprovals};
use super::convert;
use super::types::*;

/// Pushed to every window with the full server list after any change.
pub const SERVERS_CHANGED_EVENT: &str = "mcp_servers_changed";

/// Seconds between reconnect attempts for a remote server that dropped.
const RECONNECT_DELAYS_SECS: [u64; 5] = [1, 2, 4, 8, 16];

/// Tool timeouts are clamped under the agent loop's own bridge ceiling
/// (`agent_runtime::bridge::BRIDGE_TIMEOUT`, 120s) so this, more specific,
/// message is the one the model sees.
pub const TOOL_TIMEOUT_RANGE_SECS: (u64, u64) = (5, 110);

/// A running connection.
struct Live {
    generation: u64,
    peer: Peer<RoleClient>,
    ct: CancellationToken,
    output: Arc<OutputTail>,
}

pub struct McpManager {
    servers: RwLock<HashMap<String, McpServerState>>,
    live: RwLock<HashMap<String, Live>>,
    workspace: RwLock<Option<String>>,
    app: RwLock<Option<AppHandle>>,
    generation: AtomicU64,
    /// One connect at a time per server, so two callers can't race a spawn.
    connect_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl McpManager {
    pub fn new() -> Self {
        Self {
            servers: RwLock::new(HashMap::new()),
            live: RwLock::new(HashMap::new()),
            workspace: RwLock::new(None),
            app: RwLock::new(None),
            generation: AtomicU64::new(0),
            connect_locks: Mutex::new(HashMap::new()),
        }
    }

    // -----------------------------------------------------------------
    // Startup, workspace, config
    // -----------------------------------------------------------------

    /// Called once from `setup`: remember where to send events, read the
    /// global config, start the global auto-start servers.
    pub fn init(&self, app: AppHandle) {
        *self.app.write() = Some(app);
        self.reload();
        self.autostart();
    }

    /// The agent window's open project. Project servers from the previous
    /// workspace stop; this one's `.mcp.json` servers load (and the approved
    /// auto-start ones start).
    pub fn set_workspace(&self, workspace: Option<String>) -> Vec<McpServerState> {
        let workspace = workspace.filter(|w| !w.trim().is_empty());
        if *self.workspace.read() == workspace {
            return self.list();
        }
        crate::logging::log_info("mcp", &format!("workspace -> {workspace:?}"));
        *self.workspace.write() = workspace;
        let list = self.reload();
        self.autostart();
        list
    }

    /// Re-read every config file and reconcile with what is running. Servers
    /// whose launch did not change keep running; changed, removed, disabled
    /// or unapproved ones stop.
    pub fn reload(&self) -> Vec<McpServerState> {
        let workspace = self.workspace.read().clone();
        let configs = read_all_configs(workspace.as_deref());
        let approvals = ProjectApprovals::load();

        let mut to_stop = Vec::new();
        {
            let mut servers = self.servers.write();
            let mut next = HashMap::new();
            for mut cfg in configs {
                // A project server is off until the user turns it on in
                // settings (Claude Code's enabled/disabled lists, minus the
                // prompt). The switch is stored outside the repo.
                if cfg.scope == McpScope::Project {
                    let on = workspace.as_deref().and_then(|w| approvals.answer(w, &cfg));
                    cfg.enabled = on == Some(true);
                }
                let state = match servers.remove(&cfg.id) {
                    Some(mut prev) if !launch_changed(&prev.config, &cfg) => {
                        prev.config = cfg;
                        prev
                    }
                    Some(prev) => {
                        to_stop.push(prev.config.id.clone());
                        McpServerState::new(cfg)
                    }
                    None => McpServerState::new(cfg),
                };
                if !state.config.enabled && state.status != McpServerStatus::Disconnected
                {
                    to_stop.push(state.config.id.clone());
                }
                next.insert(state.config.id.clone(), state);
            }
            to_stop.extend(servers.drain().map(|(id, _)| id));
            *servers = next;
        }
        for id in to_stop {
            self.stop_live(&id);
            self.mark_stopped(&id);
        }
        self.emit();
        self.list()
    }

    /// Start every enabled, approved auto-start server that isn't running.
    fn autostart(&self) {
        let ids: Vec<String> = self
            .servers
            .read()
            .values()
            .filter(|s| {
                s.config.enabled
                    && s.config.auto_start
                    && s.status == McpServerStatus::Disconnected
            })
            .map(|s| s.config.id.clone())
            .collect();
        for id in ids {
            tauri::async_runtime::spawn(async move {
                let _ = MCP_MANAGER.connect_server(&id).await;
            });
        }
    }

    pub fn list(&self) -> Vec<McpServerState> {
        let mut list: Vec<McpServerState> = self.servers.read().values().cloned().collect();
        list.sort_by(|a, b| {
            a.config
                .name
                .to_lowercase()
                .cmp(&b.config.name.to_lowercase())
        });
        list
    }

    pub fn get_server(&self, id: &str) -> Option<McpServerState> {
        self.servers.read().get(id).cloned()
    }

    // -----------------------------------------------------------------
    // Editing servers
    // -----------------------------------------------------------------

    pub fn add_server(&self, mut config: McpServerConfig) -> Result<McpServerState, String> {
        config.name = config.name.trim().to_string();
        if config.name.is_empty() {
            return Err("Give the server a name.".into());
        }
        config.id = config.name.clone();
        if self.servers.read().contains_key(&config.id) {
            return Err(format!("A server named '{}' already exists.", config.name));
        }
        self.write_to_scope(&config, None)?;
        if config.scope == McpScope::Project {
            // Added here, so it is on here.
            self.set_approval(&config, config.enabled)?;
        }
        crate::logging::log_info(
            "mcp",
            &format!("[{}] added ({:?})", config.id, config.scope),
        );
        self.reload();
        self.autostart();
        self.get_server(&config.id)
            .ok_or_else(|| format!("Server '{}' was saved but could not be read back.", config.id))
    }

    pub fn update_server(&self, mut config: McpServerConfig) -> Result<McpServerState, String> {
        let old_id = config.id.clone();
        let previous = self
            .get_server(&old_id)
            .ok_or_else(|| format!("Server '{}' not found", old_id))?;
        config.name = config.name.trim().to_string();
        if config.name.is_empty() {
            return Err("Give the server a name.".into());
        }
        config.id = config.name.clone();
        if config.id != old_id && self.servers.read().contains_key(&config.id) {
            return Err(format!("A server named '{}' already exists.", config.name));
        }
        // A project server's on/off lives outside the repo file; the file
        // keeps its own `enabled` default.
        let on = config.enabled;
        if config.scope == McpScope::Project {
            config.enabled = true;
        }
        self.write_to_scope(&config, Some(&previous.config))?;
        if config.scope == McpScope::Project {
            self.set_approval(&config, on)?;
        }
        self.reload();
        self.autostart();
        self.get_server(&config.id)
            .ok_or_else(|| format!("Server '{}' was saved but could not be read back.", config.id))
    }

    pub fn remove_server(&self, id: &str) -> Result<(), String> {
        let state = self
            .get_server(id)
            .ok_or_else(|| format!("Server '{}' not found", id))?;
        self.stop_live(id);
        remove_from_file(&state.config)?;
        crate::logging::log_info("mcp", &format!("[{id}] removed"));
        self.reload();
        Ok(())
    }

    /// Global servers flip `enabled` in their file. Project servers flip a
    /// per-project switch kept in Aurora's data folder — the `.mcp.json`
    /// belongs to the repo and other people's machines.
    pub fn toggle_server(&self, id: &str, enabled: bool) -> Result<McpServerState, String> {
        let state = self
            .get_server(id)
            .ok_or_else(|| format!("Server '{}' not found", id))?;
        match state.config.scope {
            McpScope::Global => {
                let mut file = McpConfig::load()?;
                if !file.toggle_server(id, enabled) {
                    return Err(format!("Server '{}' not found in {}", id, source_label(&state.config)));
                }
                file.save()?;
            }
            McpScope::Project => self.set_approval(&state.config, enabled)?,
        }
        self.reload();
        if enabled {
            self.autostart();
        }
        self.get_server(id)
            .ok_or_else(|| format!("Server '{}' not found", id))
    }

    fn set_approval(&self, config: &McpServerConfig, approved: bool) -> Result<(), String> {
        let workspace = self
            .workspace
            .read()
            .clone()
            .ok_or_else(|| "Open a project first; project servers belong to one.".to_string())?;
        let mut approvals = ProjectApprovals::load();
        // Fingerprint the file's view of the server, not the runtime copy
        // whose `enabled` the approval itself may have changed.
        approvals.set(&workspace, config, approved);
        approvals.save()
    }

    /// Write `config` into its scope's file; when it moved (rename or scope
    /// change) remove the old entry from the old file.
    fn write_to_scope(
        &self,
        config: &McpServerConfig,
        previous: Option<&McpServerConfig>,
    ) -> Result<(), String> {
        let target = match config.scope {
            McpScope::Global => crate::paths::mcp_config_file(),
            McpScope::Project => match (previous, &config.source) {
                // Edit in place: back into the file it came from.
                (Some(prev), _) if prev.scope == McpScope::Project && prev.source.is_some() => {
                    prev.source.clone().map(std::path::PathBuf::from).unwrap_or_default()
                }
                _ => {
                    let ws = self.workspace.read().clone().ok_or_else(|| {
                        "Open a project first; project servers are saved in its .mcp.json.".to_string()
                    })?;
                    std::path::Path::new(&ws).join(config::PROJECT_FILE_NAME)
                }
            },
        };

        if let Some(prev) = previous {
            let moved = prev.id != config.id || prev.scope != config.scope;
            if moved {
                remove_from_file(prev)?;
            }
        }

        let mut file = config::read_file(&target)?;
        file.upsert_server(config);
        config::write_file(&target, &file)
    }

    // -----------------------------------------------------------------
    // Connections
    // -----------------------------------------------------------------

    fn connect_lock(&self, id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.connect_locks
            .lock()
            .entry(id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    /// Start `id` unless it is already running.
    pub async fn connect_server(&self, id: &str) -> Result<McpServerState, String> {
        let lock = self.connect_lock(id);
        let _guard = lock.lock().await;
        let state = self
            .get_server(id)
            .ok_or_else(|| format!("Server '{}' not found", id))?;
        if state.status == McpServerStatus::Connected && self.live.read().contains_key(id) {
            return Ok(state);
        }
        self.start_locked(id, state).await
    }

    /// Stop and start again, even if it is running.
    pub async fn restart_server(&self, id: &str) -> Result<McpServerState, String> {
        let lock = self.connect_lock(id);
        let _guard = lock.lock().await;
        self.stop_live(id);
        let state = self
            .get_server(id)
            .ok_or_else(|| format!("Server '{}' not found", id))?;
        self.start_locked(id, state).await
    }

    async fn start_locked(&self, id: &str, state: McpServerState) -> Result<McpServerState, String> {
        if !state.config.enabled {
            return Err(format!("Server '{}' is turned off. Turn it on in Plugins → MCP.", id));
        }
        self.stop_live(id);
        // The last error stays up while retrying; it is replaced by the next
        // error or cleared on success. Clearing it here made the settings card
        // drop and redraw its error block on every reconnect attempt.
        self.update(id, |s| s.status = McpServerStatus::Connecting);

        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let output = Arc::new(OutputTail::default());
        let ct = CancellationToken::new();
        let started = std::time::Instant::now();

        let result = async {
            let launch = config::expanded_for_launch(&state.config)?;
            let handler = AuroraClient {
                server_id: id.to_string(),
                generation,
            };
            let service = client::connect(&launch, handler, output.clone(), ct.clone()).await?;
            let peer = service.peer().clone();
            match discover(&peer).await {
                Ok(found) => Ok((service, peer, found)),
                Err(err) => {
                    ct.cancel();
                    Err(format!("{err}{}", output.as_suffix()))
                }
            }
        }
        .await;

        match result {
            Ok((service, peer, found)) => {
                self.live.write().insert(
                    id.to_string(),
                    Live {
                        generation,
                        peer,
                        ct,
                        output: output.clone(),
                    },
                );
                let tool_count = found.tools.len();
                self.update(id, |s| {
                    s.status = McpServerStatus::Connected;
                    s.error = None;
                    s.tools = found.tools;
                    s.resources = found.resources;
                    s.server_info = found.server_info;
                    s.instructions = found.instructions;
                    s.recent_output = output.snapshot();
                });
                crate::logging::log_info(
                    "mcp",
                    &format!(
                        "[{id}] connected in {} ms, {tool_count} tools",
                        started.elapsed().as_millis()
                    ),
                );
                let watch_id = id.to_string();
                tauri::async_runtime::spawn(async move {
                    let reason = service.waiting().await;
                    MCP_MANAGER.on_closed(&watch_id, generation, reason).await;
                });
                self.get_server(id)
                    .ok_or_else(|| format!("Server '{}' not found after connecting", id))
            }
            Err(err) => {
                crate::logging::log_warn("mcp", &format!("[{id}] failed to start: {err}"));
                self.update(id, |s| {
                    s.status = McpServerStatus::Error;
                    s.error = Some(err.clone());
                    s.tools.clear();
                    s.resources.clear();
                    s.recent_output = output.snapshot();
                });
                Err(err)
            }
        }
    }

    /// The rmcp service for `generation` ended. If nobody asked for that,
    /// say so with the server's last words, and retry remote servers.
    async fn on_closed(
        &self,
        id: &str,
        generation: u64,
        reason: Result<QuitReason, tokio::task::JoinError>,
    ) {
        let output = {
            let mut live = self.live.write();
            match live.get(id) {
                Some(l) if l.generation == generation => live.remove(id).map(|l| l.output),
                // Stopped on purpose, or already replaced by a newer connection.
                _ => None,
            }
        };
        let Some(output) = output else { return };
        let Some(state) = self.get_server(id) else { return };

        let remote = state.config.transport != McpTransportType::Stdio;
        let message = if remote {
            format!("The connection to the server was lost ({reason:?}).")
        } else {
            format!("The server process stopped.{}", output.as_suffix())
        };
        crate::logging::log_warn("mcp", &format!("[{id}] closed: {message}"));
        self.update(id, |s| {
            s.status = McpServerStatus::Error;
            s.error = Some(message.clone());
            s.tools.clear();
            s.resources.clear();
            s.recent_output = output.snapshot();
        });

        if remote && state.config.enabled {
            let id = id.to_string();
            tauri::async_runtime::spawn(async move {
                for (attempt, delay) in RECONNECT_DELAYS_SECS.iter().enumerate() {
                    tokio::time::sleep(Duration::from_secs(*delay)).await;
                    match MCP_MANAGER.get_server(&id) {
                        // Still failed and nobody touched it: try again.
                        Some(s) if s.status == McpServerStatus::Error && s.config.enabled => {}
                        _ => return,
                    }
                    crate::logging::log_info(
                        "mcp",
                        &format!("[{id}] reconnect attempt {}", attempt + 1),
                    );
                    if reconnect(id.clone()).await.is_ok() {
                        return;
                    }
                }
            });
        }
    }

    /// `notifications/tools/list_changed`: fetch the new list.
    pub async fn refresh_tools(&self, id: &str, generation: u64, peer: Peer<RoleClient>) {
        let tools = match peer.list_all_tools().await {
            Ok(tools) => convert::tools(&tools),
            Err(err) => {
                crate::logging::log_warn("mcp", &format!("[{id}] tools refresh failed: {err}"));
                return;
            }
        };
        let current = self
            .live
            .read()
            .get(id)
            .is_some_and(|l| l.generation == generation);
        if current {
            crate::logging::log_info("mcp", &format!("[{id}] tool list changed: {}", tools.len()));
            self.update(id, |s| s.tools = tools);
        }
    }

    pub fn disconnect_server(&self, id: &str) -> Result<(), String> {
        self.stop_live(id);
        self.mark_stopped(id);
        self.emit();
        crate::logging::log_info("mcp", &format!("[{id}] stopped"));
        Ok(())
    }

    /// Cancel the live connection. rmcp closes the transport; for stdio the
    /// job object ends the whole process tree.
    fn stop_live(&self, id: &str) {
        if let Some(live) = self.live.write().remove(id) {
            live.ct.cancel();
        }
    }

    fn mark_stopped(&self, id: &str) {
        if let Some(s) = self.servers.write().get_mut(id) {
            s.status = McpServerStatus::Disconnected;
            s.error = None;
            s.tools.clear();
            s.resources.clear();
            s.server_info = None;
            s.instructions = None;
        }
    }

    // -----------------------------------------------------------------
    // Tool calls
    // -----------------------------------------------------------------

    pub async fn call_tool(&self, request: McpToolCallRequest) -> Result<McpToolCallResult, String> {
        let server_id = request.server_id.clone();
        let (peer, output) = {
            let live = self.live.read();
            let l = live.get(&server_id).ok_or_else(|| {
                format!(
                    "MCP server '{}' is not running. Start it from Plugins → MCP.",
                    server_id
                )
            })?;
            (l.peer.clone(), l.output.clone())
        };
        let timeout_secs = self
            .get_server(&server_id)
            .and_then(|s| s.config.tool_timeout_secs)
            .unwrap_or(DEFAULT_TOOL_TIMEOUT_SECS)
            .clamp(TOOL_TIMEOUT_RANGE_SECS.0, TOOL_TIMEOUT_RANGE_SECS.1);

        let mut params = CallToolRequestParams::new(request.tool_name.clone());
        match request.arguments {
            None | Some(Value::Null) => {}
            Some(Value::Object(map)) => params = params.with_arguments(map),
            Some(other) => {
                return Err(format!(
                    "Tool arguments must be a JSON object, got {}.",
                    json_kind(&other)
                ))
            }
        }

        let handle = peer
            .send_request_with_option(
                CallToolRequest::new(params).into(),
                PeerRequestOptions::with_timeout(Duration::from_secs(timeout_secs)),
            )
            .await
            .map_err(|e| self.describe_call_error(&server_id, &request.tool_name, e, timeout_secs, &output))?;

        match handle.await_response().await {
            Ok(ServerResult::CallToolResult(result)) => Ok(convert::call_result(&result)),
            Ok(_) => Err(format!(
                "'{}' on '{}' answered with something that is not a tool result.",
                request.tool_name, server_id
            )),
            Err(e) => Err(self.describe_call_error(&server_id, &request.tool_name, e, timeout_secs, &output)),
        }
    }

    fn describe_call_error(
        &self,
        server_id: &str,
        tool: &str,
        error: ServiceError,
        timeout_secs: u64,
        output: &OutputTail,
    ) -> String {
        match error {
            ServiceError::Timeout { .. } => format!(
                "'{tool}' on '{server_id}' did not finish within {timeout_secs}s. Aurora asked the \
                 server to cancel it; whatever it already did on its side may have happened."
            ),
            ServiceError::McpError(e) => format!("'{tool}' failed: {}", e.message),
            ServiceError::TransportClosed => format!(
                "'{server_id}' stopped while running '{tool}'.{}",
                output.as_suffix()
            ),
            other => format!("'{tool}' on '{server_id}' failed: {other}"),
        }
    }

    /// Every tool of every running server.
    pub fn get_all_tools(&self) -> Vec<(String, McpToolInfo)> {
        let servers = self.servers.read();
        servers
            .iter()
            .filter(|(_, s)| s.status == McpServerStatus::Connected)
            .flat_map(|(id, s)| s.tools.iter().map(move |t| (id.clone(), t.clone())))
            .collect()
    }

    // -----------------------------------------------------------------
    // State + events
    // -----------------------------------------------------------------

    fn update(&self, id: &str, f: impl FnOnce(&mut McpServerState)) {
        let changed = {
            let mut servers = self.servers.write();
            match servers.get_mut(id) {
                Some(s) => {
                    f(s);
                    true
                }
                None => false,
            }
        };
        if changed {
            self.emit();
        }
    }

    fn emit(&self) {
        let app = self.app.read().clone();
        if let Some(app) = app {
            if let Err(e) = app.emit(SERVERS_CHANGED_EVENT, self.list()) {
                crate::logging::log_warn("mcp", &format!("could not send server list: {e}"));
            }
        }
    }
}

impl Default for McpManager {
    fn default() -> Self {
        Self::new()
    }
}

/// `connect_server` from inside the close watcher that `connect_server`
/// itself spawns. Boxed to a named type: an `async fn` calling itself through
/// a spawned task is a cycle the compiler can't size.
fn reconnect(
    id: String,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<McpServerState, String>> + Send>> {
    Box::pin(async move { MCP_MANAGER.connect_server(&id).await })
}

struct Discovered {
    tools: Vec<McpToolInfo>,
    resources: Vec<McpResourceInfo>,
    server_info: Option<McpServerInfo>,
    instructions: Option<String>,
}

/// What the server offers, read right after the handshake.
async fn discover(peer: &Peer<RoleClient>) -> Result<Discovered, String> {
    let info = peer.peer_info();
    let capabilities = info
        .as_ref()
        .and_then(|i| serde_json::to_value(&i.capabilities).ok())
        .unwrap_or(Value::Null);
    let declares = |key: &str| capabilities.get(key).is_some_and(|v| !v.is_null());

    let tools = match peer.list_all_tools().await {
        Ok(tools) => convert::tools(&tools),
        // A server that never claimed tools may refuse the request; that is
        // an empty list, not a broken server.
        Err(_) if !declares("tools") => Vec::new(),
        Err(err) => return Err(format!("The server started but would not list its tools: {err}")),
    };
    let resources = if declares("resources") {
        peer.list_all_resources()
            .await
            .map(|r| convert::resources(&r))
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    Ok(Discovered {
        tools,
        resources,
        server_info: info.as_deref().and_then(convert::server_info),
        instructions: info.as_deref().and_then(convert::instructions),
    })
}

/// Global servers first, then each project `.mcp.json` from the outermost
/// folder in; a later definition of the same name wins (Claude Code's order).
fn read_all_configs(workspace: Option<&str>) -> Vec<McpServerConfig> {
    let mut by_name: HashMap<String, McpServerConfig> = HashMap::new();
    match McpConfig::load() {
        Ok(global) => {
            for cfg in global.to_server_configs() {
                by_name.insert(cfg.id.clone(), cfg);
            }
        }
        Err(err) => crate::logging::log_error("mcp", &format!("global config: {err}")),
    }
    if let Some(ws) = workspace {
        for path in config::project_config_files(std::path::Path::new(ws)) {
            match config::read_file(&path) {
                Ok(file) => {
                    for cfg in file.to_scoped_configs(McpScope::Project, &path) {
                        by_name.insert(cfg.id.clone(), cfg);
                    }
                }
                Err(err) => crate::logging::log_error("mcp", &err),
            }
        }
    }
    by_name.into_values().collect()
}

fn remove_from_file(config: &McpServerConfig) -> Result<(), String> {
    match config.scope {
        McpScope::Global => {
            let mut file = McpConfig::load()?;
            file.remove_server(&config.id);
            file.save()
        }
        McpScope::Project => {
            let path = config
                .source
                .clone()
                .ok_or_else(|| format!("Don't know which .mcp.json holds '{}'.", config.id))?;
            let path = std::path::PathBuf::from(path);
            let mut file = config::read_file(&path)?;
            file.remove_server(&config.id);
            config::write_file(&path, &file)
        }
    }
}

fn source_label(config: &McpServerConfig) -> String {
    config.source.clone().unwrap_or_else(|| "its config file".into())
}

/// Does this edit change what gets launched? Name, approval and display
/// flags don't; command, args, env, URL, headers and scope do.
fn launch_changed(a: &McpServerConfig, b: &McpServerConfig) -> bool {
    a.transport != b.transport
        || a.command != b.command
        || a.args != b.args
        || a.env != b.env
        || a.url != b.url
        || a.headers != b.headers
        || a.scope != b.scope
}

fn json_kind(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

lazy_static::lazy_static! {
    pub static ref MCP_MANAGER: Arc<McpManager> = Arc::new(McpManager::new());
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `.mcp.json` files are read from the workspace up to the drive root;
    /// the closest one wins a name clash, and a project server nobody turned
    /// on is listed but off.
    #[test]
    fn project_files_load_closest_wins_and_start_off() {
        let root = std::env::temp_dir().join(format!("aurora-mcp-scope-{}", std::process::id()));
        let ws = root.join("repo").join("app");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::write(
            root.join("repo").join(".mcp.json"),
            r#"{"mcpServers":{"zz-aurora-test-shared":{"command":"outer"},"zz-aurora-test-outer":{"command":"o"}}}"#,
        )
        .unwrap();
        std::fs::write(
            ws.join(".mcp.json"),
            r#"{"mcpServers":{"zz-aurora-test-shared":{"command":"inner"}}}"#,
        )
        .unwrap();

        let configs = read_all_configs(Some(ws.to_str().unwrap()));
        let shared = configs.iter().find(|c| c.id == "zz-aurora-test-shared").unwrap();
        assert_eq!(shared.command.as_deref(), Some("inner"));
        assert_eq!(shared.scope, McpScope::Project);
        assert!(configs.iter().any(|c| c.id == "zz-aurora-test-outer"));

        let manager = McpManager::new();
        *manager.workspace.write() = Some(ws.to_string_lossy().into_owned());
        let listed = manager.reload();
        let state = listed
            .iter()
            .find(|s| s.config.id == "zz-aurora-test-shared")
            .unwrap();
        assert!(!state.config.enabled, "a project server starts off until turned on");
        assert_eq!(state.status, McpServerStatus::Disconnected);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn launch_change_ignores_display_flags() {
        let a = McpServerConfig::new_stdio("x", "x", "node");
        let mut b = a.clone();
        b.auto_approve = true;
        b.auto_start = true;
        b.enabled = false;
        assert!(!launch_changed(&a, &b));
        b.args = vec!["--flag".into()];
        assert!(launch_changed(&a, &b));
    }
}
