//! MCP Configuration
//!
//! Handles loading/saving MCP server configurations to mcp.json

use super::types::{McpServerConfig, McpTransportType};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

/// MCP configuration file structure (Claude/Cursor compatible)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpConfig {
    /// MCP servers configuration
    #[serde(default)]
    pub mcp_servers: HashMap<String, McpServerEntry>,
}

/// MCP server entry in config file (Claude/Cursor format)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerEntry {
    /// Display name (optional, defaults to key name)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Command to run (for stdio)
    pub command: Option<String>,
    /// Arguments
    #[serde(default)]
    pub args: Vec<String>,
    /// Environment variables
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Explicit transport. Optional so hand-written Claude/Cursor configs
    /// keep working — when absent it is inferred in [`resolve_transport`].
    /// `"type"` is accepted as an alias because that is the key Claude Code
    /// and Cursor use (`"type": "http"`).
    #[serde(default, alias = "type", skip_serializing_if = "Option::is_none")]
    pub transport: Option<McpTransportType>,
    /// URL for the legacy HTTP+SSE transport
    pub url: Option<String>,
    /// URL for the Streamable HTTP transport. Cursor/Claude configs spell
    /// this `httpUrl`; treating it as an unknown key (the old behaviour)
    /// silently produced a stdio server with no command.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_url: Option<String>,
    /// Custom headers (for the HTTP transports)
    #[serde(default)]
    pub headers: HashMap<String, String>,
    /// Whether enabled
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Auto-start
    #[serde(default)]
    pub auto_start: bool,
    /// Auto-approve all tool calls (skip user confirmation)
    #[serde(default)]
    pub auto_approve: bool,
}

fn default_true() -> bool {
    true
}

impl McpServerEntry {
    /// Decide which transport this entry describes.
    ///
    /// An explicit `transport`/`type` always wins. Otherwise we infer, and
    /// `httpUrl` must map to [`McpTransportType::Http`] rather than `Sse`:
    /// a Streamable HTTP server answers the SSE handshake's opening `GET`
    /// with 405 Method Not Allowed, so guessing wrong is not a soft failure.
    fn resolve_transport(&self) -> McpTransportType {
        if let Some(t) = self.transport {
            return t;
        }
        if self.http_url.is_some() {
            McpTransportType::Http
        } else if self.url.is_some() {
            McpTransportType::Sse
        } else {
            McpTransportType::Stdio
        }
    }

    /// The endpoint for whichever HTTP transport this entry uses. `url` and
    /// `httpUrl` are the same field to us once the transport is known.
    fn resolve_url(&self) -> Option<String> {
        self.url.clone().or_else(|| self.http_url.clone())
    }

    /// Serialise a runtime config back to the on-disk Claude/Cursor shape.
    ///
    /// The transport is written explicitly (instead of left to inference) so
    /// a round-trip can never downgrade an `http` server to `sse`, and the
    /// endpoint lands under the key each transport conventionally uses.
    fn from_config(config: &McpServerConfig) -> Self {
        let (url, http_url) = match config.transport {
            McpTransportType::Http => (None, config.url.clone()),
            _ => (config.url.clone(), None),
        };
        Self {
            // The map KEY is the name (Cursor/Claude format), so the
            // redundant `name` field is dropped.
            name: None,
            transport: Some(config.transport),
            command: config.command.clone(),
            args: config.args.clone(),
            env: config.env.clone(),
            url,
            http_url,
            headers: config.headers.clone(),
            enabled: config.enabled,
            auto_start: config.auto_start,
            auto_approve: config.auto_approve,
        }
    }
}

impl McpConfig {
    /// Get the MCP config file path — `~/.aurora/mcp.json`.
    pub fn config_path() -> Option<PathBuf> {
        Some(crate::paths::mcp_config_file())
    }

    /// Load MCP config from file.
    ///
    /// The on-disk format is keyed by server **name** (Cursor/Claude style). If
    /// the new home-dir file is missing but a legacy `<root>/config/mcp.json`
    /// exists, it is migrated once: re-keyed from the old internal `mcp-<id>`
    /// keys to the human-readable server name and saved to the new location.
    pub fn load() -> Result<Self, String> {
        let path = crate::paths::mcp_config_file();

        if path.exists() {
            let content = std::fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read MCP config: {}", e))?;
            return serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse MCP config: {}", e));
        }

        // One-time migration from the legacy app-data location.
        let legacy = crate::paths::legacy_mcp_config_file();
        if legacy.exists() {
            if let Ok(content) = std::fs::read_to_string(&legacy) {
                if let Ok(old) = serde_json::from_str::<Self>(&content) {
                    let migrated = old.rekeyed_by_name();
                    // Best-effort write to the new path; loading still succeeds
                    // even if the write fails (e.g. read-only home).
                    let _ = migrated.save();
                    return Ok(migrated);
                }
            }
        }

        // No config anywhere → empty.
        Ok(Self::default())
    }

    /// Rebuild the map keyed by each server's display name (falling back to the
    /// existing key), dropping the now-redundant `name` field — used to migrate
    /// the legacy id-keyed file to the human-readable name-keyed format.
    fn rekeyed_by_name(&self) -> Self {
        let mut mcp_servers = HashMap::new();
        for (key, entry) in &self.mcp_servers {
            let name = entry.name.clone().unwrap_or_else(|| key.clone());
            let mut e = entry.clone();
            e.name = None;
            mcp_servers.insert(name, e);
        }
        Self { mcp_servers }
    }

    /// Save MCP config to file
    pub fn save(&self) -> Result<(), String> {
        // `paths::mcp_config_file()` ensures the `config/` parent exists.
        let path = crate::paths::mcp_config_file();

        let content = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize MCP config: {}", e))?;

        std::fs::write(&path, content).map_err(|e| format!("Failed to write MCP config: {}", e))
    }

    /// Convert to list of McpServerConfig
    pub fn to_server_configs(&self) -> Vec<McpServerConfig> {
        self.mcp_servers
            .iter()
            .map(|(id, entry)| {
                McpServerConfig {
                    id: id.clone(),
                    // Use stored name, or fall back to ID (which is the key in Claude/Cursor format)
                    name: entry.name.clone().unwrap_or_else(|| id.clone()),
                    transport: entry.resolve_transport(),
                    command: entry.command.clone(),
                    args: entry.args.clone(),
                    env: entry.env.clone(),
                    url: entry.resolve_url(),
                    headers: entry.headers.clone(),
                    enabled: entry.enabled,
                    auto_start: entry.auto_start,
                    auto_approve: entry.auto_approve,
                }
            })
            .collect()
    }

    /// Update from list of McpServerConfig
    #[allow(dead_code)]
    pub fn from_server_configs(configs: &[McpServerConfig]) -> Self {
        let mcp_servers = configs
            .iter()
            .map(|config| (config.name.clone(), McpServerEntry::from_config(config)))
            .collect();

        Self { mcp_servers }
    }

    /// Add or update a server. Keyed by the server **name** (Cursor/Claude
    /// format) — the runtime id is normalized to the name by the manager, so
    /// the file never stores an internal `mcp-<id>`.
    pub fn upsert_server(&mut self, config: &McpServerConfig) {
        self.mcp_servers
            .insert(config.name.clone(), McpServerEntry::from_config(config));
    }

    /// Remove a server
    pub fn remove_server(&mut self, id: &str) {
        self.mcp_servers.remove(id);
    }

    /// Toggle server enabled state
    pub fn toggle_server(&mut self, id: &str, enabled: bool) -> bool {
        if let Some(entry) = self.mcp_servers.get_mut(id) {
            entry.enabled = enabled;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_serialization() {
        let mut config = McpConfig::default();
        config.mcp_servers.insert(
            "test-server".to_string(),
            McpServerEntry {
                name: Some("Test Server Display Name".to_string()),
                command: Some("npx".to_string()),
                args: vec![
                    "-y".to_string(),
                    "@modelcontextprotocol/server-git".to_string(),
                ],
                env: HashMap::new(),
                transport: None,
                url: None,
                http_url: None,
                headers: HashMap::new(),
                enabled: true,
                auto_start: false,
                auto_approve: true,
            },
        );

        let json = serde_json::to_string_pretty(&config).unwrap();
        let parsed: McpConfig = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.mcp_servers.len(), 1);
        assert!(parsed.mcp_servers.contains_key("test-server"));
    }

    /// A bare `httpUrl` entry — the exact Cursor/Claude shape hosted servers
    /// document — used to deserialize into a stdio server with no command,
    /// which failed silently. It must resolve to Streamable HTTP.
    #[test]
    fn test_http_url_entry_resolves_to_http_transport() {
        let raw = r#"{
            "mcpServers": {
                "untitledui": { "httpUrl": "https://www.untitledui.com/react/api/mcp" }
            }
        }"#;
        let config: McpConfig = serde_json::from_str(raw).unwrap();
        let servers = config.to_server_configs();

        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].transport, McpTransportType::Http);
        assert_eq!(
            servers[0].url.as_deref(),
            Some("https://www.untitledui.com/react/api/mcp")
        );
    }

    /// `"type": "http"` (Claude Code's spelling) must win over inference,
    /// even when the endpoint is given as plain `url`.
    #[test]
    fn test_explicit_type_overrides_url_inference() {
        let raw = r#"{
            "mcpServers": {
                "hosted": { "type": "http", "url": "https://example.com/mcp" }
            }
        }"#;
        let config: McpConfig = serde_json::from_str(raw).unwrap();
        let servers = config.to_server_configs();

        assert_eq!(servers[0].transport, McpTransportType::Http);
        assert_eq!(servers[0].url.as_deref(), Some("https://example.com/mcp"));
    }

    /// A legacy `url`-only entry keeps its historical meaning (HTTP+SSE) so
    /// existing mcp.json files don't change transport under the user.
    #[test]
    fn test_url_only_entry_stays_sse() {
        let raw = r#"{ "mcpServers": { "legacy": { "url": "https://example.com/sse" } } }"#;
        let config: McpConfig = serde_json::from_str(raw).unwrap();
        assert_eq!(
            config.to_server_configs()[0].transport,
            McpTransportType::Sse
        );
    }

    /// Saving then reloading an http server must not downgrade it to sse.
    #[test]
    fn test_http_config_survives_round_trip() {
        let original = McpServerConfig::new_http("untitledui", "untitledui", "https://x.test/mcp");
        let saved = McpConfig::from_server_configs(std::slice::from_ref(&original));

        let json = serde_json::to_string(&saved).unwrap();
        assert!(
            json.contains("httpUrl"),
            "endpoint should persist as httpUrl"
        );

        let reloaded: McpConfig = serde_json::from_str(&json).unwrap();
        let servers = reloaded.to_server_configs();
        assert_eq!(servers[0].transport, McpTransportType::Http);
        assert_eq!(servers[0].url.as_deref(), Some("https://x.test/mcp"));
    }
}
