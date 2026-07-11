//! MCP Configuration
//!
//! Handles loading/saving MCP server configurations to mcp.json

use super::types::McpServerConfig;
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
    /// URL (for SSE)
    pub url: Option<String>,
    /// Custom headers (for SSE)
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
                let transport = if entry.url.is_some() {
                    super::types::McpTransportType::Sse
                } else {
                    super::types::McpTransportType::Stdio
                };

                McpServerConfig {
                    id: id.clone(),
                    // Use stored name, or fall back to ID (which is the key in Claude/Cursor format)
                    name: entry.name.clone().unwrap_or_else(|| id.clone()),
                    transport,
                    command: entry.command.clone(),
                    args: entry.args.clone(),
                    env: entry.env.clone(),
                    url: entry.url.clone(),
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
            .map(|config| {
                let entry = McpServerEntry {
                    // The map KEY is the name (Cursor/Claude format), so the
                    // redundant `name` field is dropped.
                    name: None,
                    command: config.command.clone(),
                    args: config.args.clone(),
                    env: config.env.clone(),
                    url: config.url.clone(),
                    headers: config.headers.clone(),
                    enabled: config.enabled,
                    auto_start: config.auto_start,
                    auto_approve: config.auto_approve,
                };
                (config.name.clone(), entry)
            })
            .collect();

        Self { mcp_servers }
    }

    /// Add or update a server. Keyed by the server **name** (Cursor/Claude
    /// format) — the runtime id is normalized to the name by the manager, so
    /// the file never stores an internal `mcp-<id>`.
    pub fn upsert_server(&mut self, config: &McpServerConfig) {
        let entry = McpServerEntry {
            name: None,
            command: config.command.clone(),
            args: config.args.clone(),
            env: config.env.clone(),
            url: config.url.clone(),
            headers: config.headers.clone(),
            enabled: config.enabled,
            auto_start: config.auto_start,
            auto_approve: config.auto_approve,
        };
        self.mcp_servers.insert(config.name.clone(), entry);
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
                url: None,
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
}
