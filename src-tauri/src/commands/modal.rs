//! Modal — a workspace's LLM inference endpoints, as one Aurora provider.
//!
//! ## The shape, and why
//!
//! Modal Endpoints are per-deployment servers, each with its own hostname
//! (`maya--ep-kimi-k3-server.us-west.modal.direct`). Treating each one as a
//! provider row would have meant a URL per row and a token per row. The
//! measured reality (2026-09-02) is simpler:
//!
//! - **One proxy token covers a workspace.** `modal workspace proxy-tokens
//!   create` mints a `wk-…`/`ws-…` pair scoped to the workspace, sent as
//!   `Authorization: Bearer wk-….ws-…`. The `ak-`/`as-` account tokens in
//!   `~/.modal.toml` are refused by endpoints (`proxy auth required`).
//! - **One regional gateway lists and serves every endpoint.**
//!   `https://inference.<region>.modal.direct/v1/models`, with the workspace
//!   token, returns one entry per live endpoint: its hostname as the model id,
//!   the base model, context length, modalities, features, and reasoning
//!   effort levels. A chat call with `model: <that hostname>` runs on it. The
//!   same gateway answers `/chat/completions`, `/messages` (Bearer only) and
//!   `/responses`.
//! - **Region is routing, not identity.** The eu-west gateway lists the same
//!   endpoint under an eu-west hostname, so a region change means re-fetching
//!   the model list, which the settings card does.
//!
//! So a Modal provider row is `base_url = gateway(region)`, `api_key = proxy
//! token`, and its models are whatever the gateway lists. Adding an endpoint
//! on Modal's side is "Refresh endpoints" on Aurora's.
//!
//! ## The CLI's role
//!
//! Nothing at request time. The Python CLI (`pip install modal`) is an
//! accelerator for three chores: minting a proxy token without visiting the
//! dashboard, signing in to a workspace so the token can be minted, and
//! reading spend. It is detected, never bundled, and every command here
//! degrades to "not installed" with the pip line to run. The `modal-rust-sdk`
//! crate was assessed and rejected: alpha, three releases, and no endpoint or
//! proxy-token calls.
//!
//! The CLI is run with `MODAL_PROFILE` in its environment rather than by
//! activating a profile, and `token new` is passed `--no-activate`, so Aurora
//! never changes which workspace the user's own terminal is pointed at. That
//! flag is load-bearing: `modal token new` activates by default, so without it
//! signing in from Aurora silently repoints the person's shell.
//!
//! ## Why the answers are cached on disk
//!
//! Every call here is a Python process. Measured on 2026-09-03: `--version`
//! 0.79s, `billing summary` 2.9s. The settings pane is a list you click
//! through, so probing on mount charged that to every visit and left the card
//! reassembling itself each time. The facts are now read once, written to
//! `<root>/cache/modal-cli.json`, and re-read from there — the CLI is run
//! again only when the card's refresh asks for it. Under `cache/` because
//! every byte is regeneratable by running the CLI again.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The gateway base URL for a region — what a Modal provider row stores. The
/// region list itself (`us-west` default, `us-east`, `ca-central`, `eu-west`,
/// `ap-south`) is the settings card's, in `services/providers/modal.ts`.
#[must_use]
pub fn gateway_base_url(region: &str) -> String {
    format!("https://inference.{region}.modal.direct/v1")
}

/// How long the CLI may take for a non-interactive command.
const CLI_TIMEOUT: Duration = Duration::from_secs(60);
/// How long a browser sign-in may stay open before Aurora gives up on it.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);
/// How long the gateway gets to answer `/v1/models`.
const GATEWAY_TIMEOUT: Duration = Duration::from_secs(30);

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ---------------------------------------------------------------------------
// Gateway: the endpoint list
// ---------------------------------------------------------------------------

/// One endpoint the gateway serves, shaped for a model row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModalEndpointModel {
    /// The model id to send: the endpoint's hostname.
    pub id: String,
    /// `kimi-k3` from `maya--ep-kimi-k3-server.us-west.modal.direct`.
    pub endpoint_name: String,
    pub workspace: String,
    pub region: String,
    /// `moonshotai/Kimi-K3`.
    pub base_model_id: String,
    /// `MoonshotAI: Kimi K3`.
    pub display_name: String,
    pub context_length: Option<u64>,
    pub max_output_length: Option<u64>,
    pub supports_vision: bool,
    pub supports_tools: bool,
    pub supports_reasoning: bool,
    /// Effort levels the endpoint accepts, e.g. `["low", "high", "max"]`.
    pub reasoning_levels: Vec<String>,
}

/// The parts of an endpoint hostname.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndpointHost {
    pub workspace: String,
    pub endpoint_name: String,
    pub region: String,
}

/// Parse `workspace--ep-<name>-server.<region>.modal.direct`.
///
/// Lenient about the `ep-`/`-server` decoration: an id without it still
/// yields the label between the `--` and the first dot, so a future naming
/// change degrades to a longer name rather than to no row.
#[must_use]
pub fn parse_endpoint_host(id: &str) -> Option<EndpointHost> {
    let (workspace, rest) = id.split_once("--")?;
    let mut labels = rest.split('.');
    let label = labels.next()?;
    let region = labels.next().unwrap_or_default();
    if workspace.is_empty() || label.is_empty() {
        return None;
    }
    let without_prefix = label.strip_prefix("ep-").unwrap_or(label);
    let name = without_prefix
        .strip_suffix("-server")
        .unwrap_or(without_prefix);
    Some(EndpointHost {
        workspace: workspace.to_string(),
        endpoint_name: name.to_string(),
        region: region.to_string(),
    })
}

/// Read the gateway's `/v1/models` body into rows. Entries that are not an
/// endpoint hostname are skipped rather than failing the whole list.
pub fn parse_models_json(text: &str) -> Result<Vec<ModalEndpointModel>, String> {
    let root: Value =
        serde_json::from_str(text).map_err(|e| format!("Modal answered with something other than a model list: {e}"))?;
    let Some(entries) = root.get("data").and_then(Value::as_array) else {
        return Err("Modal's model list had no `data` array.".into());
    };
    let mut out = Vec::new();
    for entry in entries {
        let Some(id) = entry.get("id").and_then(Value::as_str) else { continue };
        let Some(host) = parse_endpoint_host(id) else { continue };
        let features: Vec<&str> = entry
            .get("supported_features")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let modalities: Vec<&str> = entry
            .get("input_modalities")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let reasoning_levels: Vec<String> = entry
            .get("reasoning_options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|opt| opt.get("type").and_then(Value::as_str) == Some("effort"))
            .filter_map(|opt| opt.get("values").and_then(Value::as_array))
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
        out.push(ModalEndpointModel {
            id: id.to_string(),
            endpoint_name: host.endpoint_name,
            workspace: host.workspace,
            region: host.region,
            base_model_id: entry
                .get("base_model_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            display_name: entry
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(id)
                .to_string(),
            context_length: entry.get("context_length").and_then(Value::as_u64),
            max_output_length: entry.get("max_output_length").and_then(Value::as_u64),
            supports_vision: modalities.iter().any(|m| *m == "image"),
            supports_tools: features.iter().any(|f| *f == "tools"),
            supports_reasoning: features.iter().any(|f| *f == "reasoning") || !reasoning_levels.is_empty(),
            reasoning_levels,
        });
    }
    out.sort_by(|a, b| a.endpoint_name.cmp(&b.endpoint_name));
    Ok(out)
}

/// Turn whatever was pasted into the gateway base URL: a full curl URL, a
/// bare host, a trailing slash, or a path already ending in a wire.
#[must_use]
pub fn normalize_base_url(raw: &str) -> String {
    let mut url = raw.trim().trim_end_matches('/').to_string();
    if !url.contains("://") {
        url = format!("https://{url}");
    }
    for wire in ["/chat/completions", "/messages", "/responses", "/models"] {
        if let Some(stripped) = url.strip_suffix(wire) {
            url = stripped.to_string();
        }
    }
    if !url.ends_with("/v1") {
        url.push_str("/v1");
    }
    url
}

/// The endpoints a workspace token can reach through `base_url`'s gateway.
#[tauri::command]
pub async fn modal_workspace_models(
    base_url: String,
    token: String,
) -> Result<Vec<ModalEndpointModel>, String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("Add the workspace's proxy token first.".into());
    }
    let url = format!("{}/models", normalize_base_url(&base_url));
    let client = reqwest::Client::builder()
        .timeout(GATEWAY_TIMEOUT)
        .build()
        .map_err(|e| format!("Could not build an HTTP client: {e}"))?;
    let response = client
        .get(&url)
        .bearer_auth(&token)
        .header(reqwest::header::USER_AGENT, crate::api::provider_kernel_adapter::AURORA_USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("Could not reach {url}: {e}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(
            "Modal refused this token. It has to be a workspace proxy token (`wk-….ws-…`), not \
             the account token from `modal token new`. Create one with the button here or with \
             `modal workspace proxy-tokens create`."
                .into(),
        );
    }
    if !status.is_success() {
        return Err(format!(
            "Modal answered HTTP {status} from {url}: {}",
            body.chars().take(300).collect::<String>()
        ));
    }
    let models = parse_models_json(&body)?;
    if models.is_empty() {
        return Err(
            "This token works, but the workspace has no live endpoint in this region. Create one \
             with `modal endpoint create --model <hf-repo>` or pick the region it was deployed \
             in."
                .into(),
        );
    }
    Ok(models)
}

// ---------------------------------------------------------------------------
// The CLI: detected, never required
// ---------------------------------------------------------------------------

/// A workspace the CLI is signed in to.
///
/// `name` is the profile's key in `~/.modal.toml`; `workspace` is the Modal
/// workspace it authenticates. They are usually equal, and `modal token new
/// --profile work` is all it takes to make them differ — which is why the
/// provider row is matched on `workspace` and the CLI is invoked with `name`.
/// Only `modal profile list --json` reports both; the TOML holds the key
/// alone, so the file is a fallback that has to assume they match.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModalProfile {
    pub name: String,
    #[serde(default)]
    pub workspace: String,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModalCliStatus {
    pub installed: bool,
    /// `modal client version: 1.5.5` → `1.5.5`.
    pub version: Option<String>,
    /// How Aurora invokes it — `modal` or `python -m modal` — for the card.
    pub command: Option<String>,
    pub profiles: Vec<ModalProfile>,
    /// Where the profiles were read from, when the file exists.
    pub config_path: Option<String>,
    /// When the CLI was last actually run for this, epoch ms. `0` means the
    /// answer has never been measured on this machine.
    #[serde(default)]
    pub checked_at_ms: i64,
}

/// A freshly minted proxy token. The secret is shown by Modal exactly once,
/// at creation, so this is the only moment Aurora ever sees it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModalProxyToken {
    pub token_id: String,
    /// `wk-….ws-…` — what the provider row stores as its API key.
    pub bearer: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModalSignIn {
    /// The workspace the browser session was connected to.
    pub workspace: String,
}

/// The program and leading arguments that run the Modal CLI, or `None`.
///
/// `modal.exe` on PATH first (pip's `Scripts` shim), then `python -m modal`.
/// Both are looked up on the registry-merged PATH so a CLI installed after
/// Aurora launched is found without a restart.
///
/// A hit is remembered for the process and re-validated by one `is_file`, so
/// repeated commands do not re-walk PATH. A MISS is never remembered: finding
/// nothing costs a `python -c "import modal"` per interpreter, and caching
/// that would mean a CLI installed mid-session stays invisible until restart —
/// exactly the case the PATH lookup exists to serve.
fn cli_invocation() -> Option<(PathBuf, Vec<String>)> {
    static FOUND: OnceLock<Mutex<Option<(PathBuf, Vec<String>)>>> = OnceLock::new();
    let slot = FOUND.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = slot.lock() {
        if let Some(hit) = guard.as_ref() {
            if hit.0.is_file() {
                return Some(hit.clone());
            }
        }
    }
    let found = discover_cli()?;
    if let Ok(mut guard) = slot.lock() {
        *guard = Some(found.clone());
    }
    Some(found)
}

fn discover_cli() -> Option<(PathBuf, Vec<String>)> {
    let path = crate::shell::env::effective_path();
    let dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
    if let Some(exe) = find_on(&dirs, "modal") {
        return Some((exe, Vec::new()));
    }
    for python in ["python", "python3", "py"] {
        if let Some(exe) = find_on(&dirs, python) {
            if let Some(found) = python_has_modal(&exe) {
                return Some((found, vec!["-m".into(), "modal".into()]));
            }
        }
    }
    None
}

fn find_on(dirs: &[PathBuf], name: &str) -> Option<PathBuf> {
    let candidates: Vec<String> = if cfg!(windows) {
        vec![format!("{name}.exe"), format!("{name}.cmd"), format!("{name}.bat")]
    } else {
        vec![name.to_string()]
    };
    for dir in dirs {
        for candidate in &candidates {
            let path = dir.join(candidate);
            if let Ok(meta) = std::fs::metadata(&path) {
                if meta.is_file() && meta.len() > 0 {
                    return Some(path);
                }
            }
        }
    }
    None
}

/// Whether this interpreter can import `modal`; returns the interpreter.
fn python_has_modal(python: &PathBuf) -> Option<PathBuf> {
    let mut cmd = std::process::Command::new(python);
    cmd.args(["-c", "import modal"]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.output().ok().filter(|o| o.status.success()).map(|_| python.clone())
}

/// `~/.modal.toml`.
fn config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".modal.toml"))
}

/// The profile names in a `.modal.toml`, never their tokens.
///
/// A deliberately small reader: sections are `[name]` lines and the active
/// one carries `active = true`. Token lines are not read at all.
///
/// The file records no workspace, only the profile key, so `workspace` is set
/// to the name here. That is right often enough to be a useful fallback and
/// wrong whenever someone ran `modal token new --profile <something-else>` —
/// which is why this is the fallback and [`parse_profile_list_json`] is the
/// source when the CLI can be run.
#[must_use]
pub fn parse_profiles(toml: &str) -> Vec<ModalProfile> {
    let mut out: Vec<ModalProfile> = Vec::new();
    for line in toml.lines() {
        let line = line.trim();
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            let name = name.trim().trim_matches('"');
            if !name.is_empty() {
                out.push(ModalProfile {
                    name: name.to_string(),
                    workspace: name.to_string(),
                    active: false,
                });
            }
        } else if let Some(last) = out.last_mut() {
            if let Some((key, value)) = line.split_once('=') {
                if key.trim() == "active" && value.trim().eq_ignore_ascii_case("true") {
                    last.active = true;
                }
            }
        }
    }
    out
}

/// `modal profile list --json` → the profiles, with the workspace each one
/// actually authenticates.
///
/// Shape (1.5.5): `[{"name":"maya","workspace":"maya","active":true}, …]`.
/// A row missing `workspace` falls back to its name rather than being dropped;
/// a row missing `name` is not addressable and is skipped.
pub fn parse_profile_list_json(stdout: &str) -> Option<Vec<ModalProfile>> {
    let start = stdout.find('[')?;
    let rows: Vec<Value> = serde_json::from_str(&stdout[start..]).ok()?;
    let profiles: Vec<ModalProfile> = rows
        .iter()
        .filter_map(|row| {
            let name = row.get("name").and_then(Value::as_str)?.trim();
            if name.is_empty() {
                return None;
            }
            let workspace = row
                .get("workspace")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|w| !w.is_empty())
                .unwrap_or(name);
            Some(ModalProfile {
                name: name.to_string(),
                workspace: workspace.to_string(),
                active: row.get("active").and_then(Value::as_bool).unwrap_or(false),
            })
        })
        .collect();
    Some(profiles)
}

/// Run the CLI with a profile, capturing both streams.
async fn run_cli(
    args: &[&str],
    profile: Option<&str>,
    timeout: Duration,
) -> Result<(String, String, bool), String> {
    let Some((program, leading)) = cli_invocation() else {
        return Err(not_installed_message());
    };
    let mut cmd = tokio::process::Command::new(&program);
    cmd.args(&leading).args(args);
    cmd.env("PATH", crate::shell::env::effective_path());
    // Python 3.14 prints event-loop deprecation warnings on stderr; keep them
    // out of what a person reads.
    cmd.env("PYTHONWARNINGS", "ignore");
    if let Some(profile) = profile {
        cmd.env("MODAL_PROFILE", profile);
    }
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let child = cmd
        .spawn()
        .map_err(|e| format!("Could not start the Modal CLI ({}): {e}", program.display()))?;
    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| format!("The Modal CLI did not finish within {}s.", timeout.as_secs()))?
        .map_err(|e| format!("The Modal CLI failed to run: {e}"))?;
    Ok((
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
        output.status.success(),
    ))
}

fn not_installed_message() -> String {
    "The Modal CLI is not installed. Run `pip install modal`, then come back here.".to_string()
}

/// Longest error Aurora will quote back. Modal's boxes wrap at the terminal
/// width and can run to a paragraph; a settings row is not a log viewer.
const MAX_ERROR_CHARS: usize = 400;

/// Whether a line is Python telling us about itself rather than Modal telling
/// us what went wrong.
///
/// `PYTHONWARNINGS=ignore` is set on every invocation and does NOT suppress
/// these — measured 2026-09-03 against modal 1.5.5 on Python 3.14, which still
/// prints two `set_event_loop_policy` deprecations to stderr with the variable
/// set. This filter is what actually keeps them out of a person's way, so it
/// is a load-bearing part of the error path, not a tidy-up.
fn is_python_warning(line: &str) -> bool {
    line.contains("Warning:") && line.contains(".py:")
}

/// Reduce the CLI's output to the sentence a person can act on.
///
/// Modal reports failures two ways and Aurora used to read neither correctly.
/// Click errors are a plain `Error: …` line under a usage banner. Everything
/// routed through Modal's own reporter is a Rich box:
///
/// ```text
/// ┌─ Error ───────────────────────────────────────────────┐
/// │ Modal profile 'x' was not found in ~/.modal.toml.     │
/// │ Run `modal profile list` to see available profiles.   │
/// └───────────────────────────────────────────────────────┘
/// ```
///
/// Taking the last non-empty line — the previous behaviour — quoted the box's
/// bottom border at the user: `Modal could not report spend: └────────┘`.
/// So the borders come off, the wrapped body is rejoined into one sentence,
/// and the usage banner above a `Error:` line is dropped because the message
/// after it is the whole answer.
///
/// Both streams are read, stderr first. Click writes to stderr, but a Rich
/// console attached to stdout writes there instead, and reading only stderr
/// produced an error message that was the empty string.
fn cli_error(stdout: &str, stderr: &str, fallback: &str) -> String {
    let mut kept: Vec<String> = Vec::new();
    // Where the real message starts, once something identifies itself as the
    // error. Everything before it is banner.
    let mut error_at: Option<usize> = None;
    let mut previous_was_warning = false;

    for raw in stderr.lines().chain(stdout.lines()) {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            previous_was_warning = false;
            continue;
        }
        if is_python_warning(trimmed) {
            previous_was_warning = true;
            continue;
        }
        // A Python warning is two lines: the message, then the source line
        // that raised it, indented. Drop the second only when it is indented,
        // so a real message that happens to follow a warning survives.
        if previous_was_warning && raw.starts_with(char::is_whitespace) {
            previous_was_warning = false;
            continue;
        }
        previous_was_warning = false;

        if is_box_edge(trimmed) {
            // `┌─ Error ─┐` names the box. That is the only thing its border
            // carries, and it is what marks the start of the message.
            if trimmed.to_ascii_lowercase().contains("error") && error_at.is_none() {
                error_at = Some(kept.len());
            }
            continue;
        }
        let text = strip_box_sides(trimmed).trim().to_string();
        if text.is_empty() {
            continue;
        }
        if error_at.is_none() && text.starts_with("Error:") {
            error_at = Some(kept.len());
        }
        kept.push(text);
    }

    if let Some(at) = error_at {
        kept.drain(..at);
    }
    let mut message = kept.join(" ").trim().to_string();
    if message.chars().count() > MAX_ERROR_CHARS {
        message = message.chars().take(MAX_ERROR_CHARS).collect::<String>() + "…";
    }
    if message.is_empty() {
        fallback.to_string()
    } else {
        message
    }
}

/// A box's top or bottom rule — every character is border or padding.
fn is_box_edge(line: &str) -> bool {
    let mut first = line.chars();
    let opener = first.next().unwrap_or(' ');
    if !matches!(opener, '┌' | '└' | '╭' | '╰' | '┏' | '┗' | '+') {
        return false;
    }
    // `+---+` and `+-- Error --+` both count; a table row starting with `+`
    // and holding words would not, but Modal draws no such thing.
    line.chars()
        .last()
        .is_some_and(|c| matches!(c, '┐' | '┘' | '╮' | '╯' | '┓' | '┛' | '+' | '─' | '-' | '━'))
}

/// `│ text │` → `text`, for either the box-drawing or the ASCII fallback.
fn strip_box_sides(line: &str) -> &str {
    let inner = line
        .strip_prefix('│')
        .or_else(|| line.strip_prefix('┃'))
        .or_else(|| line.strip_prefix('|'))
        .unwrap_or(line);
    inner
        .strip_suffix('│')
        .or_else(|| inner.strip_suffix('┃'))
        .or_else(|| inner.strip_suffix('|'))
        .unwrap_or(inner)
}

/// Is the CLI here, and which workspaces has it signed in to.
///
/// Answers from `<root>/cache/modal-cli.json` unless `refresh` is true or
/// nothing has been cached yet. Opening the settings card must not cost two
/// Python process starts every time, and the card's refresh control is the one
/// place that asks for a fresh answer.
#[tauri::command]
pub async fn modal_cli_status(refresh: Option<bool>) -> ModalCliStatus {
    if refresh != Some(true) {
        if let Some(cached) = cached_status() {
            return cached;
        }
    }
    let status = probe_cli_status().await;
    store_status(&status);
    status
}

async fn probe_cli_status() -> ModalCliStatus {
    let (toml_profiles, config_path) = tokio::task::spawn_blocking(|| {
        let path = config_path();
        let profiles = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .map(|text| parse_profiles(&text))
            .unwrap_or_default();
        (
            profiles,
            path.filter(|p| p.is_file()).map(|p| p.to_string_lossy().to_string()),
        )
    })
    .await
    .unwrap_or_default();

    let invocation = tokio::task::spawn_blocking(cli_invocation).await.ok().flatten();
    let Some((program, leading)) = invocation else {
        return ModalCliStatus {
            installed: false,
            version: None,
            command: None,
            profiles: toml_profiles,
            config_path,
            checked_at_ms: now_ms(),
        };
    };
    let command = if leading.is_empty() {
        "modal".to_string()
    } else {
        format!(
            "{} -m modal",
            program.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
        )
    };
    // Two process starts, run together rather than one after the other: they
    // do not depend on each other and each costs most of a second.
    let (version, listed) = tokio::join!(
        run_cli(&["--version"], None, CLI_TIMEOUT),
        run_cli(&["profile", "list", "--json"], None, CLI_TIMEOUT),
    );
    let version = version.ok().and_then(|(stdout, _, _)| parse_version(&stdout));
    // The CLI knows which workspace each profile authenticates; the TOML only
    // knows the key. Fall back to the file when the command cannot be read, so
    // a CLI too old for `--json` still lists something.
    let profiles = listed
        .ok()
        .filter(|(_, _, ok)| *ok)
        .and_then(|(stdout, _, _)| parse_profile_list_json(&stdout))
        .filter(|rows| !rows.is_empty())
        .unwrap_or(toml_profiles);

    ModalCliStatus {
        installed: true,
        version,
        command: Some(command),
        profiles,
        config_path,
        checked_at_ms: now_ms(),
    }
}

// ---------------------------------------------------------------------------
// The workspaces: one provider row, many accounts
// ---------------------------------------------------------------------------
//
// Aurora shows ONE Modal row. Its workspace is a choice made inside the card,
// and choosing another swaps the row's token, region and endpoint list.
//
// That only works if the workspace you left is still here when you come back,
// so each one's token and model rows are kept here. Modal shows a proxy
// secret exactly once, at creation, so a switch that forgot the old token
// would not be an inconvenience — it would mean minting a new credential
// every time and leaving the old one live on the account.
//
// Under `auth/` rather than `cache/`: these are bearer tokens, and losing the
// file costs a re-mint per workspace, not a rebuild.

const WORKSPACES_VERSION: u32 = 1;

/// One workspace as it is stored — everything needed to put the provider row
/// back exactly as it was left.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRecord {
    /// `wk-….ws-…`.
    #[serde(default)]
    token: String,
    /// Which gateway this workspace was last routed through.
    #[serde(default)]
    region: String,
    /// The provider's model rows for this workspace, verbatim as the settings
    /// store holds them — labels, prices, temperatures, effort levels and all.
    /// Opaque here on purpose: this module stores them, it does not read them,
    /// so the model row's shape can change without touching this file.
    #[serde(default)]
    models: Value,
    #[serde(default)]
    updated_at_ms: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct WorkspaceFile {
    #[serde(default)]
    version: u32,
    /// The workspace the single Modal row is currently showing.
    #[serde(default)]
    active: Option<String>,
    #[serde(default)]
    workspaces: HashMap<String, WorkspaceRecord>,
}

/// A saved workspace, as the card lists it. Deliberately without the token:
/// the switcher only needs to know a workspace exists and what it holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModalSavedWorkspace {
    pub workspace: String,
    pub region: String,
    pub endpoint_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModalWorkspaceList {
    pub active: Option<String>,
    pub saved: Vec<ModalSavedWorkspace>,
}

/// Everything needed to put the provider row on this workspace.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModalWorkspaceRecord {
    pub workspace: String,
    pub token: String,
    pub region: String,
    pub models: Value,
}

fn workspaces_path() -> PathBuf {
    crate::paths::auth_dir().join("modal-workspaces.json")
}

fn workspaces() -> &'static Mutex<WorkspaceFile> {
    static FILE: OnceLock<Mutex<WorkspaceFile>> = OnceLock::new();
    FILE.get_or_init(|| Mutex::new(load_workspaces()))
}

fn load_workspaces() -> WorkspaceFile {
    let Ok(raw) = std::fs::read_to_string(workspaces_path()) else {
        return WorkspaceFile {
            version: WORKSPACES_VERSION,
            ..WorkspaceFile::default()
        };
    };
    match serde_json::from_str::<WorkspaceFile>(&raw) {
        Ok(file) if file.version == WORKSPACES_VERSION => file,
        Ok(_) | Err(_) => {
            // Starting empty here costs a re-mint per workspace, which is a
            // real cost, so it is said out loud rather than swallowed.
            crate::logging::log_warn(
                "commands.modal",
                "modal-workspaces.json could not be read — each workspace needs its token again",
            );
            WorkspaceFile {
                version: WORKSPACES_VERSION,
                ..WorkspaceFile::default()
            }
        }
    }
}

/// Write-through. Unlike the CLI cache, a failure here loses a credential the
/// user cannot get back, so it is returned rather than logged and dropped.
fn persist_workspaces(file: &WorkspaceFile) -> Result<(), String> {
    let target = workspaces_path();
    let json = serde_json::to_string_pretty(file)
        .map_err(|e| format!("Could not serialize the Modal workspaces ({e})."))?;
    std::fs::write(&target, json).map_err(|e| {
        format!(
            "Could not write {} ({e}). The token would be lost on the next switch, so it was not \
             stored — copy it somewhere safe.",
            target.display()
        )
    })
}

/// The workspaces Aurora holds a token for, and which one is showing.
#[tauri::command]
pub async fn modal_workspaces() -> ModalWorkspaceList {
    let Ok(file) = workspaces().lock() else {
        return ModalWorkspaceList {
            active: None,
            saved: Vec::new(),
        };
    };
    let mut saved: Vec<ModalSavedWorkspace> = file
        .workspaces
        .iter()
        .map(|(workspace, record)| ModalSavedWorkspace {
            workspace: workspace.clone(),
            region: record.region.clone(),
            endpoint_count: record.models.as_array().map_or(0, Vec::len),
        })
        .collect();
    saved.sort_by(|a, b| a.workspace.cmp(&b.workspace));
    ModalWorkspaceList {
        active: file.active.clone(),
        saved,
    }
}

/// Put the row on this workspace: mark it active and hand back what it holds.
#[tauri::command]
pub async fn modal_use_workspace(workspace: String) -> Result<ModalWorkspaceRecord, String> {
    let workspace = workspace.trim().to_string();
    if workspace.is_empty() {
        return Err("Name the workspace to switch to.".into());
    }
    let mut file = workspaces()
        .lock()
        .map_err(|_| "The Modal workspace store is unavailable.".to_string())?;
    let record = file
        .workspaces
        .get(&workspace)
        .cloned()
        .ok_or_else(|| format!("Aurora has no saved token for `{workspace}`."))?;
    file.active = Some(workspace.clone());
    file.version = WORKSPACES_VERSION;
    persist_workspaces(&file)?;
    Ok(ModalWorkspaceRecord {
        workspace,
        token: record.token,
        region: record.region,
        models: record.models,
    })
}

/// Remember this workspace as the row currently has it, and make it active.
///
/// Called whenever anything about the row changes — a token minted, endpoints
/// refreshed, a region switched, a price edited — and once more just before
/// switching away, so the workspace being left is stored as it actually was.
#[tauri::command]
pub async fn modal_save_workspace(
    workspace: String,
    token: String,
    region: String,
    models: Value,
) -> Result<(), String> {
    let workspace = workspace.trim().to_string();
    if workspace.is_empty() {
        return Err("A workspace needs a name before it can be saved.".into());
    }
    let mut file = workspaces()
        .lock()
        .map_err(|_| "The Modal workspace store is unavailable.".to_string())?;
    let entry = file.workspaces.entry(workspace.clone()).or_default();
    // An empty token never overwrites a saved one: a refresh that runs while
    // the field is momentarily blank must not erase the credential behind it.
    if !token.trim().is_empty() {
        entry.token = token.trim().to_string();
    }
    entry.region = region.trim().to_string();
    entry.models = models;
    entry.updated_at_ms = now_ms();
    file.active = Some(workspace);
    file.version = WORKSPACES_VERSION;
    persist_workspaces(&file)
}

/// Drop a workspace. Its token is gone from Aurora; Modal still has it, and it
/// keeps billing until deleted there.
#[tauri::command]
pub async fn modal_forget_workspace(workspace: String) -> Result<(), String> {
    let mut file = workspaces()
        .lock()
        .map_err(|_| "The Modal workspace store is unavailable.".to_string())?;
    file.workspaces.remove(workspace.trim());
    if file.active.as_deref() == Some(workspace.trim()) {
        file.active = file.workspaces.keys().next().cloned();
    }
    file.version = WORKSPACES_VERSION;
    persist_workspaces(&file)
}

// ---------------------------------------------------------------------------
// The cache: what the CLI last said, kept so it is asked once
// ---------------------------------------------------------------------------

/// Bumped when the shape below changes. An older file is discarded rather than
/// migrated — the cost of that is one CLI run, and the card re-runs it on its
/// next refresh anyway.
const CACHE_VERSION: u32 = 1;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct CliCache {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    status: Option<ModalCliStatus>,
    /// `"<profile>|<cycle>"` → the last summary read for it. Keyed by both
    /// because "this month" and "last month" are different questions and a
    /// workspace can be asked either.
    #[serde(default)]
    billing: HashMap<String, ModalBillingSummary>,
}

fn cache_path() -> PathBuf {
    crate::paths::cache_dir().join("modal-cli.json")
}

/// Process-wide copy of the file, loaded once. Two windows both reading it is
/// the normal case, and neither should re-parse per call.
fn cache() -> &'static Mutex<CliCache> {
    static CACHE: OnceLock<Mutex<CliCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(load_cache()))
}

fn load_cache() -> CliCache {
    let Ok(raw) = std::fs::read_to_string(cache_path()) else {
        return CliCache {
            version: CACHE_VERSION,
            ..CliCache::default()
        };
    };
    match serde_json::from_str::<CliCache>(&raw) {
        Ok(file) if file.version == CACHE_VERSION => file,
        _ => CliCache {
            version: CACHE_VERSION,
            ..CliCache::default()
        },
    }
}

/// Write-through. A cache that cannot be written still works for this session,
/// so a failure is logged and never returned: nobody should see a settings
/// error because a cache file is read-only.
fn persist_cache(file: &CliCache) {
    let target = cache_path();
    match serde_json::to_string_pretty(file) {
        Ok(json) => {
            if let Err(err) = std::fs::write(&target, json) {
                crate::logging::log_warn(
                    "commands.modal",
                    &format!(
                        "could not write {} ({err}) — the Modal CLI will be re-run each session",
                        target.display()
                    ),
                );
            }
        }
        Err(err) => crate::logging::log_warn(
            "commands.modal",
            &format!("could not serialize the Modal CLI cache ({err})"),
        ),
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn cached_status() -> Option<ModalCliStatus> {
    cache().lock().ok()?.status.clone()
}

fn store_status(status: &ModalCliStatus) {
    let Ok(mut file) = cache().lock() else { return };
    file.version = CACHE_VERSION;
    file.status = Some(status.clone());
    persist_cache(&file);
}

/// Forget the cached status so the next read re-runs the CLI. Called after
/// anything that changes what the CLI would say — signing in adds a profile.
fn invalidate_status() {
    let Ok(mut file) = cache().lock() else { return };
    file.status = None;
    persist_cache(&file);
}

fn billing_key(profile: &str, cycle: &str) -> String {
    format!("{profile}|{cycle}")
}

fn cached_billing(profile: &str, cycle: &str) -> Option<ModalBillingSummary> {
    cache().lock().ok()?.billing.get(&billing_key(profile, cycle)).cloned()
}

fn store_billing(profile: &str, cycle: &str, summary: &ModalBillingSummary) {
    let Ok(mut file) = cache().lock() else { return };
    file.version = CACHE_VERSION;
    file.billing.insert(billing_key(profile, cycle), summary.clone());
    persist_cache(&file);
}

/// `modal client version: 1.5.5` → `1.5.5`.
fn parse_version(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .find_map(|line| line.rsplit_once(':').map(|(_, v)| v.trim().to_string()))
        .filter(|v| !v.is_empty())
}

/// Mint a proxy token for a workspace. The secret comes back exactly once.
#[tauri::command]
pub async fn modal_cli_create_proxy_token(profile: String) -> Result<ModalProxyToken, String> {
    let profile = profile.trim().to_string();
    if profile.is_empty() {
        return Err("Pick which workspace the token is for.".into());
    }
    let (stdout, stderr, ok) = run_cli(
        &["workspace", "proxy-tokens", "create", "--json"],
        Some(&profile),
        CLI_TIMEOUT,
    )
    .await?;
    if !ok {
        return Err(format!(
            "Modal could not create a token for `{profile}`: {}",
            cli_error(&stdout, &stderr, "the CLI failed without saying why")
        ));
    }
    parse_proxy_token_json(&stdout)
}

/// The `--json` shape is a ready-made header map:
/// `{"Modal-Key": "wk-…", "Modal-Secret": "ws-…", "Authorization": "Bearer wk-….ws-…"}`.
pub fn parse_proxy_token_json(stdout: &str) -> Result<ModalProxyToken, String> {
    let start = stdout
        .find('{')
        .ok_or_else(|| "Modal returned no token. Run `modal workspace proxy-tokens create` yourself to see why.".to_string())?;
    let value: Value = serde_json::from_str(&stdout[start..])
        .map_err(|e| format!("Could not read the token Modal returned: {e}"))?;
    let key = value.get("Modal-Key").and_then(Value::as_str).unwrap_or_default().trim();
    let secret = value
        .get("Modal-Secret")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if key.is_empty() || secret.is_empty() {
        return Err("Modal's answer had no token id and secret in it.".into());
    }
    Ok(ModalProxyToken {
        token_id: key.to_string(),
        bearer: format!("{key}.{secret}"),
    })
}

/// Open the browser sign-in and wait for it. Adds (or refreshes) the profile
/// for whichever workspace the person picks in the browser.
///
/// `--no-activate` is not optional. `modal token new` activates the new
/// profile by default, so without it, signing in from Aurora's settings pane
/// silently repoints the person's own terminal at a different workspace.
/// Aurora addresses profiles by `MODAL_PROFILE` on every call and never reads
/// the active one, so it has nothing to gain from activation and a real
/// surprise to hand out.
#[tauri::command]
pub async fn modal_cli_sign_in() -> Result<ModalSignIn, String> {
    let (stdout, stderr, ok) =
        run_cli(&["token", "new", "--no-activate"], None, SIGN_IN_TIMEOUT).await?;
    let combined = format!("{stdout}\n{stderr}");
    if !ok {
        return Err(format!(
            "Sign-in did not complete: {}",
            cli_error(&stdout, &stderr, "the browser step was cancelled or timed out")
        ));
    }
    // A new profile exists now, so the cached status is out of date.
    invalidate_status();
    parse_sign_in(&combined).ok_or_else(|| {
        "Sign-in finished but Modal did not say which workspace it connected.".to_string()
    })
}

/// A workspace's spend for one billing month, as `modal billing summary
/// --json` reports it. Dollars, month to date. There is no balance or
/// remaining-credit figure anywhere in the CLI or the docs (checked
/// 2026-09-02: `billing summary|report|rates`, `workspace settings`, the
/// budgets guide), so this is spend, not headroom.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModalBillingSummary {
    /// `this month`, `last month`, or `YYYY-MM` — what was asked for.
    pub cycle: String,
    /// When the CLI last reported these numbers, epoch ms. Spend keeps moving
    /// after Aurora reads it, so the figure is only honest with its age
    /// attached.
    #[serde(default)]
    pub checked_at_ms: i64,
    pub metered_cost: f64,
    /// After plan, credits and free allowances.
    pub billed_cost: f64,
    /// The endpoints' token spend — the line that is Aurora's doing.
    pub llm_tokens_cost: f64,
    /// Endpoint compute (GPU time) beyond tokens.
    pub endpoint_cost: f64,
    /// Everything else metered (volumes, functions, …).
    pub other_cost: f64,
    /// Credits applied this cycle, as a positive number.
    pub credits_applied: f64,
}

fn money(value: Option<&Value>) -> f64 {
    value
        .and_then(|v| match v {
            Value::String(s) => s.trim().parse::<f64>().ok(),
            Value::Number(n) => n.as_f64(),
            _ => None,
        })
        .unwrap_or(0.0)
}

/// Read the summary JSON. Amounts arrive as decimal strings (`"0.16000000"`,
/// `"-0E-8"`), so every field goes through [`money`].
pub fn parse_billing_summary(stdout: &str, cycle: &str) -> Result<ModalBillingSummary, String> {
    let start = stdout
        .find('{')
        .ok_or_else(|| "Modal returned no billing summary.".to_string())?;
    let value: Value = serde_json::from_str(&stdout[start..])
        .map_err(|e| format!("Could not read the billing summary Modal returned: {e}"))?;
    let breakdown = value.get("metered_cost_breakdown");
    let llm_tokens_cost = money(breakdown.and_then(|b| b.get("llm_tokens")));
    let endpoint_cost = money(breakdown.and_then(|b| b.get("endpoint")));
    // Summed from the breakdown's own lines, not derived from the total: the
    // lines are rounded independently and do not add up to `metered_cost`
    // exactly, so a remainder would print a number Modal never reported.
    let other_cost = breakdown
        .and_then(Value::as_object)
        .map(|lines| {
            lines
                .iter()
                .filter(|(key, _)| key.as_str() != "llm_tokens" && key.as_str() != "endpoint")
                .map(|(_, amount)| money(Some(amount)))
                .sum::<f64>()
        })
        .unwrap_or(0.0);
    Ok(ModalBillingSummary {
        cycle: cycle.to_string(),
        // Stamped by the command that ran the CLI; parsing alone measures
        // nothing.
        checked_at_ms: 0,
        metered_cost: money(value.get("metered_cost")),
        billed_cost: money(value.get("billed_cost")),
        llm_tokens_cost,
        endpoint_cost,
        other_cost,
        credits_applied: money(value.get("adjustments").and_then(|a| a.get("credits"))).abs(),
    })
}

/// Month-to-date spend for a workspace, through the CLI.
///
/// The slowest thing here — 2.9s, measured — so it answers from the cache
/// unless `refresh` is true or the workspace has never been read. A cached
/// figure carries the moment it was taken, which the card shows: an hour-old
/// spend labelled as such is useful, and one presented as current is not.
#[tauri::command]
pub async fn modal_cli_billing_summary(
    profile: String,
    cycle: Option<String>,
    refresh: Option<bool>,
) -> Result<ModalBillingSummary, String> {
    let profile = profile.trim().to_string();
    if profile.is_empty() {
        return Err("Pick which workspace to read spend for.".into());
    }
    let cycle = cycle
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| "this month".to_string());
    if refresh != Some(true) {
        if let Some(hit) = cached_billing(&profile, &cycle) {
            return Ok(hit);
        }
    }
    let (stdout, stderr, ok) = run_cli(
        &["billing", "summary", "--json", "--for", &cycle],
        Some(&profile),
        CLI_TIMEOUT,
    )
    .await?;
    if !ok {
        return Err(format!(
            "Modal could not report spend for `{profile}`: {}",
            cli_error(&stdout, &stderr, "the CLI failed without saying why")
        ));
    }
    let mut summary = parse_billing_summary(&stdout, &cycle)?;
    summary.checked_at_ms = now_ms();
    store_billing(&profile, &cycle, &summary);
    Ok(summary)
}

/// `Token is connected to the maya workspace.` → `maya`.
pub fn parse_sign_in(output: &str) -> Option<ModalSignIn> {
    output.lines().find_map(|line| {
        let line = line.trim();
        let rest = line.strip_prefix("Token is connected to the ")?;
        let workspace = rest.strip_suffix(" workspace.").unwrap_or(rest).trim();
        (!workspace.is_empty()).then(|| ModalSignIn {
            workspace: workspace.to_string(),
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The live `/v1/models` answer from the maya workspace on 2026-09-02.
    const MODELS_FIXTURE: &str = r#"{"data":[{"base_model_id":"moonshotai/Kimi-K3","context_length":1048576,"created":1785263767,"id":"maya--ep-kimi-k3-server.us-west.modal.direct","input_modalities":["text","image"],"interleaved":{"field":"reasoning_content"},"max_output_length":1048576,"name":"MoonshotAI: Kimi K3","object":"model","output_modalities":["text"],"owned_by":"ac-2bR6PCbPrAs779Sy2uw6bD","reasoning_options":[{"type":"effort","values":["low","high","max"]}],"supported_features":["tools","json_mode","structured_outputs","reasoning"],"supported_sampling_parameters":["temperature","top_p","stop","max_tokens"]}],"object":"list"}"#;

    #[test]
    fn an_endpoint_hostname_splits_into_workspace_name_and_region() {
        let host = parse_endpoint_host("maya--ep-kimi-k3-server.us-west.modal.direct").unwrap();
        assert_eq!(host.workspace, "maya");
        assert_eq!(host.endpoint_name, "kimi-k3");
        assert_eq!(host.region, "us-west");

        let host = parse_endpoint_host("canyaman6879--ep-glm-5-3-server.eu-west.modal.direct").unwrap();
        assert_eq!(host.endpoint_name, "glm-5-3");
        assert_eq!(host.region, "eu-west");
    }

    #[test]
    fn a_plain_model_id_is_not_an_endpoint() {
        assert!(parse_endpoint_host("moonshotai/Kimi-K3").is_none());
        assert!(parse_endpoint_host("--x.us-west.modal.direct").is_none());
    }

    #[test]
    fn the_live_model_list_becomes_one_row_with_its_capabilities() {
        let rows = parse_models_json(MODELS_FIXTURE).unwrap();
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.id, "maya--ep-kimi-k3-server.us-west.modal.direct");
        assert_eq!(row.endpoint_name, "kimi-k3");
        assert_eq!(row.base_model_id, "moonshotai/Kimi-K3");
        assert_eq!(row.display_name, "MoonshotAI: Kimi K3");
        assert_eq!(row.context_length, Some(1_048_576));
        assert!(row.supports_vision, "image is an input modality");
        assert!(row.supports_tools);
        assert!(row.supports_reasoning);
        assert_eq!(row.reasoning_levels, vec!["low", "high", "max"]);
    }

    #[test]
    fn a_list_without_data_is_an_error_not_an_empty_provider() {
        assert!(parse_models_json(r#"{"error":"proxy auth required"}"#).is_err());
        assert!(parse_models_json("<html>").is_err());
    }

    #[test]
    fn pasted_urls_normalise_to_the_gateway_base() {
        for raw in [
            "https://inference.us-west.modal.direct/v1",
            "https://inference.us-west.modal.direct/v1/",
            "https://inference.us-west.modal.direct/v1/chat/completions",
            "https://inference.us-west.modal.direct/v1/models",
            "inference.us-west.modal.direct",
            "  https://inference.us-west.modal.direct  ",
        ] {
            assert_eq!(
                normalize_base_url(raw),
                "https://inference.us-west.modal.direct/v1",
                "{raw:?}"
            );
        }
        assert_eq!(gateway_base_url("eu-west"), "https://inference.eu-west.modal.direct/v1");
    }

    #[test]
    fn profiles_are_read_by_name_only() {
        let toml = "[canyaman6879]\ntoken_id = \"ak-1\"\ntoken_secret = \"as-1\"\n\n[maya]\ntoken_id = \"ak-2\"\ntoken_secret = \"as-2\"\nactive = true\n";
        let profiles = parse_profiles(toml);
        assert_eq!(
            profiles,
            vec![
                ModalProfile {
                    name: "canyaman6879".into(),
                    workspace: "canyaman6879".into(),
                    active: false
                },
                ModalProfile {
                    name: "maya".into(),
                    workspace: "maya".into(),
                    active: true
                },
            ]
        );
        let json = serde_json::to_string(&profiles).unwrap();
        assert!(!json.contains("ak-"), "tokens must never leave this module: {json}");
    }

    #[test]
    fn the_cli_reports_which_workspace_each_profile_authenticates() {
        // Verbatim `modal profile list --json` (1.5.5) on 2026-09-03.
        let out = r#"[
  {"name": "canyaman6879", "workspace": "canyaman6879", "active": false},
  {"name": "work", "workspace": "maya", "active": true}
]"#;
        let profiles = parse_profile_list_json(out).unwrap();
        assert_eq!(profiles.len(), 2);
        // The pair that the TOML fallback cannot see, and the reason the card
        // matches a row on `workspace` while invoking the CLI with `name`.
        assert_eq!(profiles[1].name, "work");
        assert_eq!(profiles[1].workspace, "maya");
        assert!(profiles[1].active);
        // A row with no workspace field is still addressable.
        let sparse = parse_profile_list_json(r#"[{"name": "solo"}]"#).unwrap();
        assert_eq!(sparse[0].workspace, "solo");
        assert!(parse_profile_list_json("not json").is_none());
    }

    #[test]
    fn a_boxed_cli_error_is_read_as_a_sentence_not_a_border() {
        // Verbatim stderr from `MODAL_PROFILE=doesnotexist modal billing
        // summary --json` (1.5.5, Python 3.14), warnings and all. The old
        // reader took the last non-empty line and showed people `└────┘`.
        let stderr = "C:\\…\\modal\\_utils\\async_utils.py:43: DeprecationWarning: 'asyncio.WindowsSelectorEventLoopPolicy' is deprecated\n  asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())\n┌─ Error ─────────────────────────────────────────────┐\n│ Modal profile 'doesnotexist' was not found in        │\n│ C:\\Users\\Alvan/.modal.toml.                          │\n└─────────────────────────────────────────────────────┘\n";
        let message = cli_error("", stderr, "fallback");
        assert_eq!(
            message,
            "Modal profile 'doesnotexist' was not found in C:\\Users\\Alvan/.modal.toml."
        );
        assert!(!message.contains('└'), "no border survives: {message}");
        assert!(!message.contains("DeprecationWarning"), "no warnings: {message}");
    }

    #[test]
    fn a_click_error_drops_the_usage_banner_above_it() {
        let stderr = "Usage: modal billing summary [OPTIONS]\nTry 'modal billing summary --help' for help.\n\nError: Unrecognized range: 'garbage'.\n";
        assert_eq!(
            cli_error("", stderr, "fallback"),
            "Error: Unrecognized range: 'garbage'."
        );
    }

    #[test]
    fn an_error_on_stdout_is_still_found_and_silence_falls_back() {
        // A Rich console attached to stdout writes there instead. Reading only
        // stderr produced an empty message after the colon.
        assert_eq!(
            cli_error("Error: token expired\n", "", "fallback"),
            "Error: token expired"
        );
        assert_eq!(cli_error("", "", "fallback"), "fallback");
        assert_eq!(cli_error("", "   \n\n", "fallback"), "fallback");
    }

    #[test]
    fn the_proxy_token_json_yields_a_bearer_value() {
        // Exact shape of `modal workspace proxy-tokens create --json` (1.5.5),
        // with a Python warning ahead of it the way stdout sometimes carries one.
        let out = "warning line\n{\n  \"Modal-Key\": \"wk-abc\",\n  \"Modal-Secret\": \"ws-def\",\n  \"Authorization\": \"Bearer wk-abc.ws-def\"\n}\n";
        let token = parse_proxy_token_json(out).unwrap();
        assert_eq!(token.token_id, "wk-abc");
        assert_eq!(token.bearer, "wk-abc.ws-def");
        assert!(parse_proxy_token_json("nothing here").is_err());
    }

    /// Verbatim `modal billing summary --json` for canyaman6879, 2026-09-02.
    const BILLING_FIXTURE: &str = r#"{
  "metered_cost": "1.36875269",
  "billed_cost": "0.16000000",
  "adjustments": {
    "plan_cost": "0E-8",
    "credits": "-0E-8",
    "reservation_adjustment": "-0E-8",
    "free_storage": "-1.20875269"
  },
  "metered_cost_breakdown": {
    "llm_tokens": "0.16224736",
    "endpoint": "0.00005760",
    "volumes": "1.20875269"
  }
}"#;

    #[test]
    fn the_billing_summary_separates_token_spend_from_the_rest() {
        let summary = parse_billing_summary(BILLING_FIXTURE, "this month").unwrap();
        assert_eq!(summary.cycle, "this month");
        assert!((summary.billed_cost - 0.16).abs() < 1e-9);
        assert!((summary.llm_tokens_cost - 0.16224736).abs() < 1e-9);
        assert!((summary.endpoint_cost - 0.0000576).abs() < 1e-9);
        // Volumes are "other": every breakdown line that is not an endpoint
        // line, read as reported (the lines do not sum to `metered_cost`).
        assert!((summary.other_cost - 1.20875269).abs() < 1e-9, "{summary:?}");
        assert_eq!(summary.credits_applied, 0.0);
        // A workspace with no endpoint line at all still parses.
        let no_endpoint = BILLING_FIXTURE.replace("\"endpoint\": \"0.00005760\",\n", "");
        assert_eq!(parse_billing_summary(&no_endpoint, "last month").unwrap().endpoint_cost, 0.0);
        assert!(parse_billing_summary("nope", "this month").is_err());
    }

    #[test]
    fn the_sign_in_output_names_the_workspace() {
        let out = "Web authentication finished successfully!\nToken is connected to the maya workspace.\nToken verified successfully!\n";
        assert_eq!(parse_sign_in(out).unwrap().workspace, "maya");
        assert!(parse_sign_in("nothing").is_none());
    }

    #[test]
    fn the_version_line_is_reduced_to_the_number() {
        assert_eq!(parse_version("modal client version: 1.5.5\n").as_deref(), Some("1.5.5"));
        assert!(parse_version("").is_none());
    }
}
