//! MCP Manager
//!
//! Manages MCP server connections and tool execution
//!
//! Note: This is a simplified implementation that spawns processes
//! and communicates via JSON-RPC over stdio. For full rmcp integration,
//! additional async runtime setup would be needed.

use super::config::McpConfig;
use super::types::*;
use eventsource_stream::Eventsource;
use futures::stream::StreamExt;
use parking_lot::RwLock;
use reqwest::Client;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Arc;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Holds the MCP server process and its I/O handles
struct McpProcess {
    /// The child process
    child: Child,
    /// Stdin for sending requests
    stdin: ChildStdin,
    /// Buffered reader for stdout
    reader: BufReader<ChildStdout>,
    /// Request ID counter
    request_id: u64,
}

/// Holds the MCP SSE connection info
struct McpSseConnection {
    /// The POST endpoint for sending messages
    post_endpoint: String,
    /// Request ID counter
    request_id: u64,
    /// Abort handle for the background listener task
    abort_handle: tokio::task::AbortHandle,
}

/// MCP Manager - handles server lifecycle and tool calls
pub struct McpManager {
    /// Server states
    servers: RwLock<HashMap<String, McpServerState>>,
    /// Running processes with I/O handles (for stdio transport)
    processes: RwLock<HashMap<String, McpProcess>>,
    /// Active SSE connections
    sse_connections: RwLock<HashMap<String, McpSseConnection>>,
}

impl McpManager {
    pub fn new() -> Self {
        Self {
            servers: RwLock::new(HashMap::new()),
            processes: RwLock::new(HashMap::new()),
            sse_connections: RwLock::new(HashMap::new()),
        }
    }

    /// Load servers from config file (preserves existing connection states)
    pub fn load_config(&self) -> Result<Vec<McpServerState>, String> {
        let config = McpConfig::load()?;
        let server_configs = config.to_server_configs();

        let mut servers = self.servers.write();

        for config in &server_configs {
            // Only add if not already in memory (preserves connection state)
            if !servers.contains_key(&config.id) {
                servers.insert(config.id.clone(), McpServerState::new(config.clone()));
            } else {
                // Update config but preserve status, tools, etc.
                if let Some(existing) = servers.get_mut(&config.id) {
                    existing.config = config.clone();
                }
            }
        }

        Ok(servers.values().cloned().collect())
    }

    /// Get all server states
    pub fn get_servers(&self) -> Vec<McpServerState> {
        self.servers.read().values().cloned().collect()
    }

    /// Get a specific server state
    pub fn get_server(&self, id: &str) -> Option<McpServerState> {
        self.servers.read().get(id).cloned()
    }

    /// Add a new server
    pub fn add_server(&self, config: McpServerConfig) -> Result<McpServerState, String> {
        // Save to config file
        let mut mcp_config = McpConfig::load().unwrap_or_default();
        mcp_config.upsert_server(&config);
        mcp_config.save()?;

        // Add to runtime state
        let state = McpServerState::new(config.clone());
        self.servers
            .write()
            .insert(config.id.clone(), state.clone());

        Ok(state)
    }

    /// Remove a server
    pub fn remove_server(&self, id: &str) -> Result<(), String> {
        // Disconnect first
        self.disconnect_server(id)?;

        // Remove from config file
        let mut mcp_config = McpConfig::load().unwrap_or_default();
        mcp_config.remove_server(id);
        mcp_config.save()?;

        // Remove from runtime state
        self.servers.write().remove(id);

        Ok(())
    }

    /// Update server config
    pub fn update_server(&self, config: McpServerConfig) -> Result<McpServerState, String> {
        let id = config.id.clone();

        // Disconnect if connected
        let _ = self.disconnect_server(&id);

        // Update config file
        let mut mcp_config = McpConfig::load().unwrap_or_default();
        mcp_config.upsert_server(&config);
        mcp_config.save()?;

        // Update runtime state
        let state = McpServerState::new(config);
        self.servers.write().insert(id, state.clone());

        Ok(state)
    }

    /// Toggle server enabled state
    pub fn toggle_server(&self, id: &str, enabled: bool) -> Result<McpServerState, String> {
        // Update config file
        let mut mcp_config = McpConfig::load().unwrap_or_default();
        if !mcp_config.toggle_server(id, enabled) {
            return Err(format!("Server '{}' not found", id));
        }
        mcp_config.save()?;

        // Update runtime state
        let mut servers = self.servers.write();
        if let Some(state) = servers.get_mut(id) {
            state.config.enabled = enabled;
            if !enabled {
                // Disconnect if disabling
                drop(servers);
                let _ = self.disconnect_server(id);
                return self
                    .get_server(id)
                    .ok_or_else(|| format!("Server '{}' not found", id));
            }
            Ok(state.clone())
        } else {
            Err(format!("Server '{}' not found", id))
        }
    }

    /// Connect to a server
    pub async fn connect_server(&self, id: &str) -> Result<McpServerState, String> {
        let config = {
            let servers = self.servers.read();
            servers
                .get(id)
                .map(|s| s.config.clone())
                .ok_or_else(|| format!("Server '{}' not found", id))?
        };

        if !config.enabled {
            return Err(format!("Server '{}' is disabled", id));
        }

        // Update status to connecting
        {
            let mut servers = self.servers.write();
            if let Some(state) = servers.get_mut(id) {
                state.status = McpServerStatus::Connecting;
                state.error = None;
            }
        }

        match config.transport {
            McpTransportType::Stdio => self.connect_stdio(id, &config),
            McpTransportType::Sse => self.connect_sse(id, &config).await,
        }
    }

    /// Connect via stdio (spawn process)
    fn connect_stdio(&self, id: &str, config: &McpServerConfig) -> Result<McpServerState, String> {
        let command = config
            .command
            .as_ref()
            .ok_or_else(|| "No command specified for stdio transport".to_string())?;

        // Build command
        let mut cmd = Command::new(command);
        cmd.args(&config.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Set environment variables
        for (key, value) in &config.env {
            cmd.env(key, value);
        }

        // On Windows, hide the console window for spawned processes
        #[cfg(windows)]
        {
            // CREATE_NO_WINDOW = 0x08000000
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        // Spawn process
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn MCP server: {}", e))?;

        let mut tools = Vec::new();
        let mut resources = Vec::new();
        let mut server_info = None;

        // Get stdin and stdout handles
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to get stdin handle".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to get stdout handle".to_string())?;
        let mut reader = BufReader::new(stdout);

        // Helper function to send request and read response
        let send_request = |stdin: &mut std::process::ChildStdin,
                            reader: &mut BufReader<std::process::ChildStdout>,
                            request: serde_json::Value|
         -> Result<serde_json::Value, String> {
            let request_str = serde_json::to_string(&request)
                .map_err(|e| format!("Failed to serialize request: {}", e))?;
            writeln!(stdin, "{}", request_str)
                .map_err(|e| format!("Failed to write to MCP server: {}", e))?;
            stdin
                .flush()
                .map_err(|e| format!("Failed to flush stdin: {}", e))?;

            let mut last_error: Option<String> = None;
            for _ in 0..10 {
                let mut line = String::new();
                let bytes = reader
                    .read_line(&mut line)
                    .map_err(|e| format!("Failed to read from MCP server: {}", e))?;

                if bytes == 0 {
                    break;
                }

                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                match serde_json::from_str(trimmed) {
                    Ok(value) => return Ok(value),
                    Err(err) => {
                        last_error = Some(format!(
                            "Failed to parse response: {} (line: {})",
                            err, trimmed
                        ));
                        continue;
                    }
                }
            }

            Err(last_error.unwrap_or_else(|| "Failed to parse response: empty output".to_string()))
        };

        // 1. Send initialize request
        let init_request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": "Aurora",
                    "version": "1.0.0"
                }
            }
        });

        let init_response = send_request(&mut stdin, &mut reader, init_request)?;

        // Parse server info from initialize response
        if let Some(result) = init_response.get("result") {
            if let Some(info) = result.get("serverInfo") {
                server_info = Some(McpServerInfo {
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
            }
        }

        // 2. Send initialized notification
        let initialized_notification = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        });
        let notif_str = serde_json::to_string(&initialized_notification)
            .map_err(|e| format!("Failed to serialize notification: {}", e))?;
        writeln!(stdin, "{}", notif_str)
            .map_err(|e| format!("Failed to write notification: {}", e))?;
        stdin
            .flush()
            .map_err(|e| format!("Failed to flush stdin: {}", e))?;

        // 3. Send tools/list request
        let tools_request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {}
        });

        let tools_response = send_request(&mut stdin, &mut reader, tools_request)?;

        // Parse tools from response
        let tools_value = tools_response
            .get("result")
            .and_then(|result| {
                if let Some(array) = result.get("tools") {
                    Some(array)
                } else if result.is_array() {
                    Some(result)
                } else {
                    None
                }
            })
            .or_else(|| tools_response.get("tools"));

        if let Some(tools_array) = tools_value.and_then(|t| t.as_array()) {
            for tool in tools_array {
                let name = tool
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let description = tool
                    .get("description")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let input_schema = tool.get("inputSchema").cloned();

                tools.push(McpToolInfo {
                    name,
                    description,
                    input_schema,
                });
            }
        }

        // 4. Try to list resources (optional, some servers don't support this)
        let resources_request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "resources/list",
            "params": {}
        });

        if let Ok(resources_response) = send_request(&mut stdin, &mut reader, resources_request) {
            if let Some(result) = resources_response.get("result") {
                if let Some(resources_array) = result.get("resources").and_then(|r| r.as_array()) {
                    for resource in resources_array {
                        let uri = resource
                            .get("uri")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let name = resource
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown")
                            .to_string();
                        let description = resource
                            .get("description")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        let mime_type = resource
                            .get("mimeType")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());

                        resources.push(McpResourceInfo {
                            uri,
                            name,
                            description,
                            mime_type,
                        });
                    }
                }
            }
        }

        // Store process with I/O handles for future tool calls
        let mcp_process = McpProcess {
            child,
            stdin,
            reader,
            request_id: 4, // We used 1, 2, 3 for init, tools/list, resources/list
        };
        self.processes.write().insert(id.to_string(), mcp_process);

        // Update server state
        let mut servers = self.servers.write();
        if let Some(state) = servers.get_mut(id) {
            state.status = McpServerStatus::Connected;
            state.error = None;
            state.tools = tools;
            state.resources = resources;
            state.server_info = server_info;
            Ok(state.clone())
        } else {
            Err(format!("Server '{}' not found after connection", id))
        }
    }

    /// Connect via SSE
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

        // Add custom headers
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

        // Channel to receive the POST endpoint
        let (endpoint_tx, endpoint_rx) = tokio::sync::oneshot::channel();
        let mut endpoint_tx = Some(endpoint_tx);

        // Spawn listener task
        let handle = tokio::spawn(async move {
            while let Some(event) = stream.next().await {
                match event {
                    Ok(event) => {
                        if event.event == "endpoint" {
                            if let Some(tx) = endpoint_tx.take() {
                                let _ = tx.send(event.data);
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // Wait for endpoint
        let post_endpoint =
            match tokio::time::timeout(std::time::Duration::from_secs(10), endpoint_rx).await {
                Ok(Ok(endpoint)) => {
                    // If endpoint is relative, resolve against base URL
                    if endpoint.starts_with("http") {
                        endpoint
                    } else {
                        let base = url.trim_end_matches('/');
                        let path = endpoint.trim_start_matches('/');
                        format!("{}/{}", base, path)
                    }
                }
                Ok(Err(_)) => {
                    handle.abort();
                    return Err("Failed to receive endpoint event".to_string());
                }
                Err(_) => {
                    handle.abort();
                    return Err("Timed out waiting for endpoint event".to_string());
                }
            };

        // Initialize handshake
        let init_request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": "Aurora",
                    "version": "1.0.0"
                }
            }
        });

        let init_response = client
            .post(&post_endpoint)
            .json(&init_request)
            .send()
            .await
            .map_err(|e| format!("Failed to send initialize request: {}", e))?
            .json::<serde_json::Value>()
            .await
            .map_err(|e| format!("Failed to parse initialize response: {}", e))?;

        let mut server_info = None;
        if let Some(result) = init_response.get("result") {
            if let Some(info) = result.get("serverInfo") {
                server_info = Some(McpServerInfo {
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
            }
        }

        // Send initialized notification
        let initialized_notification = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        });
        client
            .post(&post_endpoint)
            .json(&initialized_notification)
            .send()
            .await
            .map_err(|e| format!("Failed to send initialized notification: {}", e))?;

        // List tools
        let tools_request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {}
        });

        let tools_response = client
            .post(&post_endpoint)
            .json(&tools_request)
            .send()
            .await
            .map_err(|e| format!("Failed to send tools/list request: {}", e))?
            .json::<serde_json::Value>()
            .await
            .map_err(|e| format!("Failed to parse tools/list response: {}", e))?;

        let mut tools = Vec::new();
        let tools_value = tools_response
            .get("result")
            .and_then(|result| {
                if let Some(array) = result.get("tools") {
                    Some(array)
                } else if result.is_array() {
                    Some(result)
                } else {
                    None
                }
            })
            .or_else(|| tools_response.get("tools"));

        if let Some(tools_array) = tools_value.and_then(|t| t.as_array()) {
            for tool in tools_array {
                let name = tool
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let description = tool
                    .get("description")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let input_schema = tool.get("inputSchema").cloned();

                tools.push(McpToolInfo {
                    name,
                    description,
                    input_schema,
                });
            }
        }

        // List resources
        let resources_request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "resources/list",
            "params": {}
        });

        let mut resources = Vec::new();
        if let Ok(resources_response) = client
            .post(&post_endpoint)
            .json(&resources_request)
            .send()
            .await
        {
            if let Ok(json) = resources_response.json::<serde_json::Value>().await {
                if let Some(result) = json.get("result") {
                    if let Some(resources_array) =
                        result.get("resources").and_then(|r| r.as_array())
                    {
                        for resource in resources_array {
                            let uri = resource
                                .get("uri")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let name = resource
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("unknown")
                                .to_string();
                            let description = resource
                                .get("description")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            let mime_type = resource
                                .get("mimeType")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());

                            resources.push(McpResourceInfo {
                                uri,
                                name,
                                description,
                                mime_type,
                            });
                        }
                    }
                }
            }
        }

        // Store connection
        let connection = McpSseConnection {
            post_endpoint,
            request_id: 4,
            abort_handle: handle.abort_handle(),
        };
        self.sse_connections
            .write()
            .insert(id.to_string(), connection);

        // Update state
        let mut servers = self.servers.write();
        if let Some(state) = servers.get_mut(id) {
            state.status = McpServerStatus::Connected;
            state.error = None;
            state.tools = tools;
            state.resources = resources;
            state.server_info = server_info;
            Ok(state.clone())
        } else {
            Err(format!("Server '{}' not found after connection", id))
        }
    }

    /// Disconnect from a server
    pub fn disconnect_server(&self, id: &str) -> Result<(), String> {
        // Kill process if running
        if let Some(mut process) = self.processes.write().remove(id) {
            let _ = process.child.kill();
        }

        // Abort SSE connection if active
        if let Some(conn) = self.sse_connections.write().remove(id) {
            conn.abort_handle.abort();
        }

        // Update state
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

    /// Call a tool on a server
    pub async fn call_tool(
        &self,
        request: McpToolCallRequest,
    ) -> Result<McpToolCallResult, String> {
        let server_id = &request.server_id;

        // Check server is connected and get transport
        let transport = {
            let servers = self.servers.read();
            let state = servers
                .get(server_id)
                .ok_or_else(|| format!("Server '{}' not found", server_id))?;

            if state.status != McpServerStatus::Connected {
                return Err(format!("Server '{}' is not connected", server_id));
            }
            state.config.transport.clone()
        };

        let result = match transport {
            McpTransportType::Stdio => self.call_tool_stdio(request),
            McpTransportType::Sse => self.call_tool_sse(request).await,
        }?;

        Ok(self.cap_output(result))
    }

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

    fn call_tool_stdio(&self, request: McpToolCallRequest) -> Result<McpToolCallResult, String> {
        let server_id = &request.server_id;
        // Get process
        let mut processes = self.processes.write();
        let process = processes
            .get_mut(server_id)
            .ok_or_else(|| format!("No process for server '{}'", server_id))?;

        // Increment request ID
        process.request_id += 1;
        let req_id = process.request_id;

        // Build tool call request
        let tool_request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": req_id,
            "method": "tools/call",
            "params": {
                "name": request.tool_name,
                "arguments": request.arguments.unwrap_or(serde_json::json!({}))
            }
        });

        // Write to stdin
        let request_str = serde_json::to_string(&tool_request)
            .map_err(|e| format!("Failed to serialize tool request: {}", e))?;
        writeln!(process.stdin, "{}", request_str)
            .map_err(|e| format!("Failed to write to MCP server: {}", e))?;
        process
            .stdin
            .flush()
            .map_err(|e| format!("Failed to flush stdin: {}", e))?;

        // Read response from stdout
        let mut line = String::new();
        process
            .reader
            .read_line(&mut line)
            .map_err(|e| format!("Failed to read from MCP server: {}", e))?;

        // Parse response
        let response: serde_json::Value = serde_json::from_str(&line)
            .map_err(|e| format!("Failed to parse tool response: {}", e))?;

        self.parse_tool_response(response)
    }

    async fn call_tool_sse(
        &self,
        request: McpToolCallRequest,
    ) -> Result<McpToolCallResult, String> {
        let server_id = &request.server_id;

        let (post_endpoint, req_id) = {
            let mut connections = self.sse_connections.write();
            let conn = connections
                .get_mut(server_id)
                .ok_or_else(|| format!("No SSE connection for server '{}'", server_id))?;
            conn.request_id += 1;
            (conn.post_endpoint.clone(), conn.request_id)
        };

        let tool_request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": req_id,
            "method": "tools/call",
            "params": {
                "name": request.tool_name,
                "arguments": request.arguments.unwrap_or(serde_json::json!({}))
            }
        });

        let client = Client::new();
        let response = client
            .post(&post_endpoint)
            .json(&tool_request)
            .send()
            .await
            .map_err(|e| format!("Failed to send tool call request: {}", e))?;

        if !response.status().is_success() {
            return Err(format!("Tool call returned status: {}", response.status()));
        }

        let response_json = response
            .json::<serde_json::Value>()
            .await
            .map_err(|e| format!("Failed to parse tool response: {}", e))?;

        self.parse_tool_response(response_json)
    }

    fn parse_tool_response(
        &self,
        response: serde_json::Value,
    ) -> Result<McpToolCallResult, String> {
        // Check for error
        if let Some(error) = response.get("error") {
            let message = error
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("Unknown error")
                .to_string();
            return Ok(McpToolCallResult {
                success: false,
                content: None,
                error: Some(message),
                is_error: Some(true),
            });
        }

        // Parse result
        if let Some(result) = response.get("result") {
            let is_error = result.get("isError").and_then(|v| v.as_bool());

            // Parse content array
            let content =
                if let Some(content_array) = result.get("content").and_then(|c| c.as_array()) {
                    let items: Vec<McpToolContent> = content_array
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
                        .collect();
                    Some(items)
                } else {
                    None
                };

            return Ok(McpToolCallResult {
                success: !is_error.unwrap_or(false),
                content,
                error: None,
                is_error,
            });
        }

        // No result found
        Ok(McpToolCallResult {
            success: false,
            content: None,
            error: Some("No result in response".to_string()),
            is_error: Some(true),
        })
    }

    /// Get all tools from all connected servers
    pub fn get_all_tools(&self) -> Vec<(String, McpToolInfo)> {
        let servers = self.servers.read();
        let mut all_tools = Vec::new();

        for (server_id, state) in servers.iter() {
            if state.status == McpServerStatus::Connected {
                for tool in &state.tools {
                    all_tools.push((server_id.clone(), tool.clone()));
                }
            }
        }

        all_tools
    }
}

impl Default for McpManager {
    fn default() -> Self {
        Self::new()
    }
}

// Global MCP manager instance
lazy_static::lazy_static! {
    pub static ref MCP_MANAGER: Arc<McpManager> = Arc::new(McpManager::new());
}
