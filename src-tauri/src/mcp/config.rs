//! MCP Configuration
//!
//! Handles loading/saving MCP server configurations to mcp.json

use super::types::{McpScope, McpServerConfig, McpTransportType};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

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
    /// Written as `type`, Claude Code's key, so a `.mcp.json` Aurora saves
    /// still reads correctly in Claude Code; `transport` is still accepted.
    #[serde(
        default,
        rename = "type",
        alias = "transport",
        skip_serializing_if = "Option::is_none"
    )]
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
    #[serde(default = "default_true", skip_serializing_if = "is_true")]
    pub enabled: bool,
    /// Auto-start
    #[serde(default, skip_serializing_if = "is_false")]
    pub auto_start: bool,
    /// Auto-approve all tool calls (skip user confirmation)
    #[serde(default, skip_serializing_if = "is_false")]
    pub auto_approve: bool,
    /// Per-server tool-call ceiling in seconds (Aurora extension; other
    /// clients ignore the key).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_timeout_secs: Option<u64>,
}

fn default_true() -> bool {
    true
}

fn is_true(v: &bool) -> bool {
    *v
}

fn is_false(v: &bool) -> bool {
    !*v
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
        // `type` is always written, so `url` is unambiguous for both HTTP
        // transports; `httpUrl` (Gemini's spelling) is only read, never written.
        let (url, http_url) = (config.url.clone(), None);
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
            tool_timeout_secs: config.tool_timeout_secs,
        }
    }

    fn to_config(&self, key: &str, scope: McpScope, source: &Path) -> McpServerConfig {
        McpServerConfig {
            scope,
            source: Some(source.to_string_lossy().into_owned()),
            tool_timeout_secs: self.tool_timeout_secs,
            id: key.to_string(),
            // Use stored name, or fall back to the key (Claude/Cursor format).
            name: self.name.clone().unwrap_or_else(|| key.to_string()),
            transport: self.resolve_transport(),
            command: self.command.clone(),
            args: self.args.clone(),
            env: self.env.clone(),
            url: self.resolve_url(),
            headers: self.headers.clone(),
            enabled: self.enabled,
            // A project file is shared through the repo; it decides what the
            // server IS, never that Aurora may start it unasked. Turning it on
            // in settings does, and from then it starts with the project.
            auto_start: match scope {
                McpScope::Global => self.auto_start,
                McpScope::Project => true,
            },
            auto_approve: self.auto_approve,
        }
    }
}

/// Expand `${VAR}` and `${VAR:-default}` the way Claude Code does, so a
/// shared `.mcp.json` can say `"API_KEY": "${API_KEY}"` without committing the
/// key. Unknown variables are left as written and returned so the caller can
/// say which one is missing.
pub fn expand_env_vars(value: &str) -> (String, Vec<String>) {
    let mut out = String::with_capacity(value.len());
    let mut missing = Vec::new();
    let mut rest = value;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[start..]);
            rest = "";
            break;
        };
        let inner = &after[..end];
        let (name, default) = match inner.split_once(":-") {
            Some((n, d)) => (n, Some(d)),
            None => (inner, None),
        };
        match (std::env::var(name).ok(), default) {
            (Some(v), _) => out.push_str(&v),
            (None, Some(d)) => out.push_str(d),
            (None, None) => {
                missing.push(name.to_string());
                out.push_str(&rest[start..start + 2 + end + 1]);
            }
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    (out, missing)
}

/// The config with every `${VAR}` expanded, for launching only. The stored
/// config keeps the placeholders so saving never writes a secret to disk.
pub fn expanded_for_launch(config: &McpServerConfig) -> Result<McpServerConfig, String> {
    let mut missing = Vec::new();
    let mut expand = |s: &str| {
        let (v, m) = expand_env_vars(s);
        missing.extend(m);
        v
    };
    let mut out = config.clone();
    out.command = config.command.as_deref().map(&mut expand);
    out.args = config.args.iter().map(|a| expand(a)).collect();
    out.url = config.url.as_deref().map(&mut expand);
    out.env = config
        .env
        .iter()
        .map(|(k, v)| (k.clone(), expand(v)))
        .collect();
    out.headers = config
        .headers
        .iter()
        .map(|(k, v)| (k.clone(), expand(v)))
        .collect();
    if missing.is_empty() {
        Ok(out)
    } else {
        missing.sort();
        missing.dedup();
        Err(format!(
            "This server's config uses environment variables that are not set: {}. \
             Set them, or write the value into the config.",
            missing.join(", ")
        ))
    }
}

/// `.mcp.json` files that apply to `workspace`, outermost first, so a file
/// closer to the workspace overrides one further up (Claude Code's order).
pub fn project_config_files(workspace: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<&Path> = workspace.ancestors().collect();
    dirs.reverse();
    dirs.into_iter()
        .map(|d| d.join(PROJECT_FILE_NAME))
        .filter(|p| p.is_file())
        .collect()
}

pub const PROJECT_FILE_NAME: &str = ".mcp.json";

/// Read one config file. A missing file is empty; a broken one is an error
/// naming the file, so the settings page can say which file to fix.
pub fn read_file(path: &Path) -> Result<McpConfig, String> {
    match std::fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content)
            .map_err(|e| format!("{} is not valid MCP config: {}", path.display(), e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(McpConfig::default()),
        Err(e) => Err(format!("Could not read {}: {}", path.display(), e)),
    }
}

/// Write one config file, keeping every key Aurora does not know about.
/// Project files are shared with other tools (Claude Code, Cursor), so a save
/// must not drop their settings.
pub fn write_file(path: &Path, config: &McpConfig) -> Result<(), String> {
    let mut doc: serde_json::Value = std::fs::read_to_string(path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    let servers = serde_json::to_value(&config.mcp_servers)
        .map_err(|e| format!("Failed to serialize MCP config: {}", e))?;
    doc["mcpServers"] = servers;
    let content = serde_json::to_string_pretty(&doc)
        .map_err(|e| format!("Failed to serialize MCP config: {}", e))?;
    std::fs::write(path, content).map_err(|e| format!("Could not write {}: {}", path.display(), e))
}

/// Which project servers the user turned on, per workspace (Claude Code's
/// `enabledMcpjsonServers` / `disabledMcpjsonServers`). Kept in Aurora's own
/// data folder — never in the repo — and tied to what the server runs, so a
/// pulled `.mcp.json` that changes a server's command turns it back off.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ProjectApprovals {
    #[serde(default)]
    pub workspaces: HashMap<String, HashMap<String, ApprovalRecord>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRecord {
    pub approved: bool,
    /// Fingerprint of command/args/url/env keys at the time of the answer.
    pub fingerprint: String,
}

impl ProjectApprovals {
    pub fn load() -> Self {
        std::fs::read_to_string(crate::paths::mcp_project_approvals_file())
            .ok()
            .and_then(|c| serde_json::from_str(&c).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> Result<(), String> {
        let content = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize approvals: {}", e))?;
        std::fs::write(crate::paths::mcp_project_approvals_file(), content)
            .map_err(|e| format!("Failed to save MCP approvals: {}", e))
    }

    /// `Some(true|false)` once answered for this exact launch; `None` asks.
    pub fn answer(&self, workspace: &str, config: &McpServerConfig) -> Option<bool> {
        let record = self.workspaces.get(&workspace_key(workspace))?.get(&config.name)?;
        (record.fingerprint == fingerprint(config)).then_some(record.approved)
    }

    pub fn set(&mut self, workspace: &str, config: &McpServerConfig, approved: bool) {
        self.workspaces
            .entry(workspace_key(workspace))
            .or_default()
            .insert(
                config.name.clone(),
                ApprovalRecord {
                    approved,
                    fingerprint: fingerprint(config),
                },
            );
    }
}

fn workspace_key(workspace: &str) -> String {
    let trimmed = workspace.trim_end_matches(['\\', '/']);
    if cfg!(windows) {
        trimmed.replace('/', "\\").to_lowercase()
    } else {
        trimmed.to_string()
    }
}

/// What a server would run or reach. Env VALUES are left out on purpose so a
/// rotated key doesn't re-ask; env NAMES are in, since adding one can change
/// what a program does.
pub fn fingerprint(config: &McpServerConfig) -> String {
    use sha2::{Digest, Sha256};
    let mut env_keys: Vec<&String> = config.env.keys().collect();
    env_keys.sort();
    let material = serde_json::json!({
        "transport": config.transport,
        "command": config.command,
        "args": config.args,
        "url": config.url,
        "env": env_keys,
    });
    let digest = Sha256::digest(material.to_string().as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
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

    /// Save the global config (`~/.aurora/mcp.json`), keeping unknown keys.
    pub fn save(&self) -> Result<(), String> {
        write_file(&crate::paths::mcp_config_file(), self)
    }

    /// The global file's servers.
    pub fn to_server_configs(&self) -> Vec<McpServerConfig> {
        let source = crate::paths::mcp_config_file();
        self.to_scoped_configs(McpScope::Global, &source)
    }

    /// This file's servers, tagged with where they came from.
    pub fn to_scoped_configs(&self, scope: McpScope, source: &Path) -> Vec<McpServerConfig> {
        self.mcp_servers
            .iter()
            .map(|(key, entry)| entry.to_config(key, scope, source))
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
                tool_timeout_secs: None,
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
            json.contains(r#""type":"http""#) && json.contains(r#""url":"https://x.test/mcp""#),
            "should persist in Claude Code's shape: {json}"
        );

        let reloaded: McpConfig = serde_json::from_str(&json).unwrap();
        let servers = reloaded.to_server_configs();
        assert_eq!(servers[0].transport, McpTransportType::Http);
        assert_eq!(servers[0].url.as_deref(), Some("https://x.test/mcp"));
    }

    #[test]
    fn env_vars_expand_with_defaults_and_report_missing() {
        std::env::set_var("AURORA_MCP_TEST_KEY", "k-123");
        let (v, missing) = expand_env_vars("Bearer ${AURORA_MCP_TEST_KEY}");
        assert_eq!(v, "Bearer k-123");
        assert!(missing.is_empty());

        let (v, missing) = expand_env_vars("${AURORA_MCP_NOPE:-fallback}/x");
        assert_eq!(v, "fallback/x");
        assert!(missing.is_empty());

        let (v, missing) = expand_env_vars("a ${AURORA_MCP_NOPE} b");
        assert_eq!(v, "a ${AURORA_MCP_NOPE} b");
        assert_eq!(missing, vec!["AURORA_MCP_NOPE".to_string()]);

        let (v, _) = expand_env_vars("no vars, ${unterminated");
        assert_eq!(v, "no vars, ${unterminated");
    }

    #[test]
    fn approval_is_tied_to_what_the_server_runs() {
        let mut cfg = McpServerConfig::new_stdio("x", "x", "node");
        cfg.args = vec!["server.js".into()];
        let mut approvals = ProjectApprovals::default();
        approvals.set("E:\\Repo\\", &cfg, true);
        assert_eq!(approvals.answer("e:/repo", &cfg), Some(true));

        cfg.args = vec!["evil.js".into()];
        assert_eq!(approvals.answer("e:/repo", &cfg), None, "changed command must turn it off");
    }

    #[test]
    fn project_server_saves_keep_other_tools_keys() {
        let dir = std::env::temp_dir().join(format!("aurora-mcp-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(PROJECT_FILE_NAME);
        std::fs::write(&path, r#"{"mcpServers":{},"somethingElse":{"keep":1}}"#).unwrap();

        let mut cfg = read_file(&path).unwrap();
        cfg.upsert_server(&McpServerConfig::new_stdio("a", "a", "uvx"));
        write_file(&path, &cfg).unwrap();

        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["somethingElse"]["keep"], 1);
        assert_eq!(raw["mcpServers"]["a"]["command"], "uvx");
    }
}
