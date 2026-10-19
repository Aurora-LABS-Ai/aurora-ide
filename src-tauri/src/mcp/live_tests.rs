//! Real servers on this machine, through the real connection code.
//! Ignored by default; run with
//! `cargo test --lib mcp::live_tests -- --ignored --nocapture --test-threads=1`
//! and point the env vars at installed servers:
//!
//! * `AURORA_MCP_LIVE_COMMAND` — a bare npm-installed command (e.g. `nuphus-mcp`).
//! * `AURORA_MCP_LIVE_PYTHON` + `AURORA_MCP_LIVE_MODULE` — a venv python server.

use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use super::client::{self, AuroraClient, OutputTail};
use super::types::McpServerConfig;

/// Processes whose command line mentions `needle`, excluding this test.
#[cfg(windows)]
fn processes_mentioning(needle: &str) -> Vec<String> {
    let script = format!(
        "Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -like '*{needle}*' -and $_.Name -notmatch 'powershell|pwsh|cargo|aurora' }} | ForEach-Object {{ \"$($_.ProcessId) $($_.Name)\" }}"
    );
    let out = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", &script])
        .output()
        .expect("powershell");
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

async fn connect_list_stop(config: McpServerConfig, needle: &str) {
    let output = Arc::new(OutputTail::default());
    let ct = CancellationToken::new();
    let started = std::time::Instant::now();
    let service = client::connect(
        &config,
        AuroraClient {
            server_id: config.id.clone(),
            generation: 1,
        },
        output.clone(),
        ct.clone(),
    )
    .await
    .unwrap_or_else(|e| panic!("connect {}: {e}", config.id));
    let tools = service.peer().list_all_tools().await.expect("tools/list");
    println!(
        "[{}] connected in {} ms, {} tools: {}",
        config.id,
        started.elapsed().as_millis(),
        tools.len(),
        tools.iter().take(6).map(|t| t.name.to_string()).collect::<Vec<_>>().join(", ")
    );
    assert!(!tools.is_empty(), "{} listed no tools", config.id);

    #[cfg(windows)]
    {
        let running = processes_mentioning(needle);
        println!("[{}] running before stop: {running:?}", config.id);
        assert!(!running.is_empty(), "expected a live process for {needle}");
    }

    ct.cancel();
    let _ = tokio::time::timeout(Duration::from_secs(10), service.waiting()).await;
    tokio::time::sleep(Duration::from_secs(4)).await;

    #[cfg(windows)]
    {
        let left = processes_mentioning(needle);
        println!("[{}] left after stop: {left:?}", config.id);
        assert!(left.is_empty(), "processes survived the stop: {left:?}");
    }
}

#[tokio::test]
#[ignore = "needs a real npm-installed MCP server"]
async fn npm_shim_server_starts_and_its_tree_dies() {
    let Ok(command) = std::env::var("AURORA_MCP_LIVE_COMMAND") else {
        eprintln!("AURORA_MCP_LIVE_COMMAND not set; skipping");
        return;
    };
    let config = McpServerConfig::new_stdio(&command, &command, &command);
    connect_list_stop(config, &command).await;
}

/// The agent's path: the manager starts a server from `~/.aurora/mcp.json`,
/// a tool call goes out and comes back as the shape the agent reads.
/// `AURORA_MCP_LIVE_TOOL` names a harmless read-only tool on that server.
#[tokio::test]
#[ignore = "needs ~/.aurora/mcp.json with the server enabled"]
async fn manager_starts_from_config_and_calls_a_tool() {
    let (Ok(server), Ok(tool)) = (
        std::env::var("AURORA_MCP_LIVE_COMMAND"),
        std::env::var("AURORA_MCP_LIVE_TOOL"),
    ) else {
        eprintln!("AURORA_MCP_LIVE_COMMAND / _TOOL not set; skipping");
        return;
    };
    let manager = &super::manager::MCP_MANAGER;
    let global = super::config::McpConfig::load().expect("global mcp.json must parse");
    println!("global file has: {:?}", global.mcp_servers.keys().collect::<Vec<_>>());
    let listed = manager.reload();
    println!("manager has: {:?}", listed.iter().map(|s| &s.config.id).collect::<Vec<_>>());
    let state = manager.connect_server(&server).await.expect("connect");
    println!(
        "[{server}] {:?}, {} tools: {}",
        state.status,
        state.tools.len(),
        state.tools.iter().map(|t| t.name.as_str()).collect::<Vec<_>>().join(", ")
    );

    // Idempotent: a second connect must not respawn.
    let again = manager.connect_server(&server).await.expect("second connect");
    assert_eq!(again.status, super::types::McpServerStatus::Connected);

    let result = manager
        .call_tool(super::types::McpToolCallRequest {
            server_id: server.clone(),
            tool_name: tool.clone(),
            arguments: Some(serde_json::json!({})),
        })
        .await
        .expect("call");
    let text: String = result
        .content
        .unwrap_or_default()
        .iter()
        .filter_map(|c| c.text.clone())
        .collect::<Vec<_>>()
        .join("\n");
    println!("[{server}] {tool} -> success={} {}", result.success, text.chars().take(200).collect::<String>());
    assert!(result.success);

    let bad = manager
        .call_tool(super::types::McpToolCallRequest {
            server_id: server.clone(),
            tool_name: "no_such_tool_xyz".into(),
            arguments: None,
        })
        .await;
    println!("[{server}] unknown tool -> {bad:?}");
    assert!(bad.is_err() || bad.as_ref().is_ok_and(|r| !r.success && r.error.is_some()));

    manager.disconnect_server(&server).unwrap();
}

#[tokio::test]
#[ignore = "needs a real python venv MCP server"]
async fn venv_python_server_starts_and_its_tree_dies() {
    let (Ok(python), Ok(module)) = (
        std::env::var("AURORA_MCP_LIVE_PYTHON"),
        std::env::var("AURORA_MCP_LIVE_MODULE"),
    ) else {
        eprintln!("AURORA_MCP_LIVE_PYTHON / _MODULE not set; skipping");
        return;
    };
    let config = McpServerConfig::new_stdio("venv-server", "venv-server", &python)
        .with_args(vec!["-m".into(), module.clone()]);
    connect_list_stop(config, &module).await;
}
