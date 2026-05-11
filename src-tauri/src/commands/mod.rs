use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

// Windows-specific imports for hiding console window
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// Windows creation flags
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
#[cfg(target_os = "windows")]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;

use notify::{recommended_watcher, Config, Event, EventKind, RecursiveMode, Watcher};
use tauri::Emitter;

use parking_lot::RwLock;
use tokio::io::AsyncReadExt;
use tokio::process::Command as TokioCommand;

pub mod agent_v2;
pub mod agent_v2_permissions;
pub mod browser;
pub mod chat;
pub mod checkpoints;
pub mod editor_ops;
pub mod git;
pub mod local_providers;
pub mod provider_catalog;
pub mod provider_kernel;
pub mod settings;
pub mod speech;
pub mod state;
pub mod themes;
pub mod threads;
pub mod tokens;
pub mod undo_redo;

#[derive(Debug, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_file: bool,
    pub extension: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub success: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RipgrepSearchRequest {
    pub case_insensitive: Option<bool>,
    pub context_lines: Option<u32>,
    pub glob: Option<String>,
    pub is_regex: Option<bool>,
    pub max_results: Option<u32>,
    pub output_mode: Option<String>,
    pub path: String,
    pub pattern: String,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RipgrepMatch {
    pub after_context: Option<Vec<String>>,
    pub before_context: Option<Vec<String>>,
    pub content: String,
    pub file: String,
    pub line_number: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RipgrepFileCount {
    pub count: usize,
    pub file: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RipgrepSearchResponse {
    pub counts: Option<Vec<RipgrepFileCount>>,
    pub error: Option<String>,
    pub files: Option<Vec<String>>,
    pub matches: Option<Vec<RipgrepMatch>>,
    pub pattern: String,
    pub success: bool,
    pub tool: String,
    pub total_files: Option<usize>,
    pub total_matches: Option<usize>,
    pub truncated: Option<bool>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommandStreamChunk {
    pub stream: String,
    pub data: String,
    pub done: bool,
    pub exit_code: Option<i32>,
    pub success: Option<bool>,
}

const DEFAULT_RG_TIMEOUT_MS: u64 = 30_000;
const MAX_RG_TIMEOUT_MS: u64 = 300_000;
const MIN_RG_TIMEOUT_MS: u64 = 1_000;

#[derive(Debug, Clone)]
struct ActiveCommandStream {
    pid: Option<u32>,
    cancelled: bool,
}

lazy_static::lazy_static! {
    static ref ACTIVE_COMMAND_STREAMS: RwLock<HashMap<String, ActiveCommandStream>> =
        RwLock::new(HashMap::new());
}

fn is_command_stream_cancelled(request_id: &str) -> bool {
    let streams = ACTIVE_COMMAND_STREAMS.read();
    streams
        .get(request_id)
        .map(|s| s.cancelled)
        .unwrap_or(false)
}

fn cleanup_command_stream(request_id: &str) {
    let mut streams = ACTIVE_COMMAND_STREAMS.write();
    streams.remove(request_id);
}

fn try_kill_pid(pid: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        let _ = cmd.output();
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
        Ok(())
    }
}

fn build_shell_command(
    shell_profile: &str,
    command: &str,
    cwd: &Option<String>,
) -> (String, TokioCommand) {
    let (shell_exe, shell_args): (String, Vec<&str>) = match shell_profile {
        "bash" => {
            #[cfg(target_os = "windows")]
            {
                let git_bash_paths = [
                    r"C:\Program Files\Git\bin\bash.exe",
                    r"C:\Program Files (x86)\Git\bin\bash.exe",
                    r"C:\Git\bin\bash.exe",
                ];

                let bash_path = git_bash_paths
                    .iter()
                    .find(|p| std::path::Path::new(p).exists())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "bash".to_string());

                (bash_path, vec!["-c"])
            }
            #[cfg(not(target_os = "windows"))]
            {
                ("bash".to_string(), vec!["-c"])
            }
        }
        _ => {
            #[cfg(target_os = "windows")]
            {
                (
                    "pwsh".to_string(),
                    vec!["-NoProfile", "-NonInteractive", "-Command"],
                )
            }
            #[cfg(not(target_os = "windows"))]
            {
                ("sh".to_string(), vec!["-c"])
            }
        }
    };

    let mut cmd = TokioCommand::new(&shell_exe);
    for arg in &shell_args {
        cmd.arg(arg);
    }
    cmd.arg(command);

    if let Some(ref working_dir) = cwd {
        cmd.current_dir(working_dir);
    }

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);

    (shell_exe, cmd)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SystemInfo {
    pub os: String,         // e.g., "windows", "macos", "linux"
    pub os_version: String, // e.g., "10.0.26200" for Windows
    pub arch: String,       // e.g., "x86_64", "aarch64"
    pub hostname: String,
    pub shell: Option<String>, // Default shell path
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuroraWebSearchRequest {
    pub action: Option<String>,
    pub query: Option<String>,
    pub url: Option<String>,
    pub num_results: Option<u32>,
    pub region: Option<String>,
    pub safe_search: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuroraWebSearchResponse {
    pub success: bool,
    pub action: String,
    pub query: Option<String>,
    pub url: Option<String>,
    pub results: Option<serde_json::Value>,
    pub content: Option<serde_json::Value>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredDocumentValidationRequest {
    pub content: String,
    pub format: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredDocumentValidationResponse {
    pub column: Option<usize>,
    pub error: Option<String>,
    pub line: Option<usize>,
    pub valid: bool,
}

fn decode_rg_text(raw: &Value) -> String {
    raw.get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn decode_rg_path(data: &Value) -> Option<String> {
    data.get("path").map(decode_rg_text)
}

fn trim_line_endings(value: String) -> String {
    value
        .trim_end_matches('\n')
        .trim_end_matches('\r')
        .to_string()
}

fn parse_glob_patterns(glob: &Option<String>) -> Vec<String> {
    glob.as_ref()
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn offset_to_line_column(content: &str, offset: usize) -> (usize, usize) {
    let mut line = 1usize;
    let mut column = 1usize;

    for character in content[..offset.min(content.len())].chars() {
        if character == '\n' {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }

    (line, column)
}

#[tauri::command]
pub async fn validate_structured_document(
    request: StructuredDocumentValidationRequest,
) -> Result<StructuredDocumentValidationResponse, String> {
    let format = request.format.to_lowercase();

    match format.as_str() {
        "json" => match serde_json::from_str::<serde_json::Value>(&request.content) {
            Ok(_) => Ok(StructuredDocumentValidationResponse {
                column: None,
                error: None,
                line: None,
                valid: true,
            }),
            Err(error) => Ok(StructuredDocumentValidationResponse {
                column: Some(error.column()),
                error: Some(error.to_string()),
                line: Some(error.line()),
                valid: false,
            }),
        },
        "yaml" | "yml" => match serde_yaml::from_str::<serde_yaml::Value>(&request.content) {
            Ok(_) => Ok(StructuredDocumentValidationResponse {
                column: None,
                error: None,
                line: None,
                valid: true,
            }),
            Err(error) => {
                let location = error.location();
                Ok(StructuredDocumentValidationResponse {
                    column: location.as_ref().map(|value| value.column()),
                    error: Some(error.to_string()),
                    line: location.as_ref().map(|value| value.line()),
                    valid: false,
                })
            }
        },
        "toml" => match toml::from_str::<toml::Value>(&request.content) {
            Ok(_) => Ok(StructuredDocumentValidationResponse {
                column: None,
                error: None,
                line: None,
                valid: true,
            }),
            Err(error) => {
                let (line, column) = error
                    .span()
                    .map(|span| offset_to_line_column(&request.content, span.start))
                    .unwrap_or((1, 1));

                Ok(StructuredDocumentValidationResponse {
                    column: Some(column),
                    error: Some(error.to_string()),
                    line: Some(line),
                    valid: false,
                })
            }
        },
        _ => Err(format!(
            "Unsupported structured document format: {}",
            request.format
        )),
    }
}

#[tauri::command]
pub async fn ripgrep_search(
    request: RipgrepSearchRequest,
) -> Result<RipgrepSearchResponse, String> {
    use std::collections::BTreeMap;
    use std::process::Stdio;

    let RipgrepSearchRequest {
        case_insensitive,
        context_lines,
        glob,
        is_regex,
        max_results,
        output_mode,
        path,
        pattern,
        timeout_ms,
    } = request;

    let resolved_output_mode = output_mode.unwrap_or_else(|| "content".to_string());
    let resolved_context_lines = context_lines.unwrap_or(0);
    let resolved_max_results = max_results.unwrap_or(50).max(1) as usize;
    let resolved_timeout_ms = timeout_ms
        .unwrap_or(DEFAULT_RG_TIMEOUT_MS)
        .clamp(MIN_RG_TIMEOUT_MS, MAX_RG_TIMEOUT_MS);
    let timeout = std::time::Duration::from_millis(resolved_timeout_ms);

    let mut cmd = TokioCommand::new("rg");
    cmd.arg("--json")
        .arg("--line-number")
        .arg("--with-filename")
        .arg("--hidden")
        .arg("--no-messages")
        .arg("--max-count")
        .arg(resolved_max_results.to_string());

    if !is_regex.unwrap_or(true) {
        cmd.arg("--fixed-strings");
    }

    if case_insensitive.unwrap_or(false) {
        cmd.arg("--ignore-case");
    }

    if resolved_context_lines > 0 {
        cmd.arg("--context").arg(resolved_context_lines.to_string());
    }

    for pattern in parse_glob_patterns(&glob) {
        cmd.arg("--glob").arg(pattern);
    }

    cmd.arg(&pattern)
        .arg(&path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);

    let child = cmd
        .spawn()
        .map_err(|error| format!("Failed to execute rg: {}", error))?;
    let pid = child.id();

    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(result) => result.map_err(|error| format!("Failed to execute rg: {}", error))?,
        Err(_) => {
            if let Some(pid) = pid {
                let _ = try_kill_pid(pid);
            }

            return Ok(RipgrepSearchResponse {
                counts: None,
                error: Some(format!(
                    "ripgrep search timed out after {}ms",
                    timeout.as_millis()
                )),
                files: None,
                matches: None,
                pattern,
                success: false,
                tool: "grep".to_string(),
                total_files: None,
                total_matches: None,
                truncated: None,
            });
        }
    };

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout);

    let mut matches: Vec<RipgrepMatch> = Vec::new();
    let mut files_with_matches: Vec<String> = Vec::new();
    let mut counts_by_file: BTreeMap<String, usize> = BTreeMap::new();
    let mut pending_context_by_file: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut last_match_index_by_file: BTreeMap<String, usize> = BTreeMap::new();

    for line in stdout.lines() {
        if line.trim().is_empty() {
            continue;
        }

        let event: Value = serde_json::from_str(line)
            .map_err(|error| format!("Failed to parse rg output: {}", error))?;

        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();

        if event_type == "match" {
            let Some(data) = event.get("data") else {
                continue;
            };

            let Some(file_path) = decode_rg_path(data) else {
                continue;
            };

            let line_number = data.get("line_number").and_then(Value::as_u64).unwrap_or(0) as usize;

            let content =
                trim_line_endings(decode_rg_text(data.get("lines").unwrap_or(&Value::Null)));
            let pending_context = pending_context_by_file
                .remove(&file_path)
                .unwrap_or_default();

            if !pending_context.is_empty() {
                if let Some(previous_match_index) = last_match_index_by_file.get(&file_path) {
                    if let Some(previous_match) = matches.get_mut(*previous_match_index) {
                        let updated_after_context = previous_match
                            .after_context
                            .clone()
                            .unwrap_or_default()
                            .into_iter()
                            .chain(pending_context.clone().into_iter())
                            .collect::<Vec<_>>();
                        previous_match.after_context = Some(updated_after_context);
                    }
                }
            }

            counts_by_file
                .entry(file_path.clone())
                .and_modify(|count| *count += 1)
                .or_insert(1);

            if !files_with_matches.iter().any(|file| file == &file_path) {
                files_with_matches.push(file_path.clone());
            }

            let match_index = matches.len();
            matches.push(RipgrepMatch {
                after_context: None,
                before_context: if pending_context.is_empty() {
                    None
                } else {
                    Some(pending_context)
                },
                content,
                file: file_path.clone(),
                line_number,
            });
            last_match_index_by_file.insert(file_path, match_index);
        }

        if event_type == "context" {
            let Some(data) = event.get("data") else {
                continue;
            };

            let Some(file_path) = decode_rg_path(data) else {
                continue;
            };

            let context_content =
                trim_line_endings(decode_rg_text(data.get("lines").unwrap_or(&Value::Null)));

            pending_context_by_file
                .entry(file_path)
                .or_default()
                .push(context_content);
        }
    }

    for (file_path, trailing_context) in pending_context_by_file {
        if trailing_context.is_empty() {
            continue;
        }

        if let Some(last_match_index) = last_match_index_by_file.get(&file_path) {
            if let Some(last_match) = matches.get_mut(*last_match_index) {
                let updated_after_context = last_match
                    .after_context
                    .clone()
                    .unwrap_or_default()
                    .into_iter()
                    .chain(trailing_context.into_iter())
                    .collect::<Vec<_>>();
                last_match.after_context = Some(updated_after_context);
            }
        }
    }

    let total_matches = counts_by_file.values().sum::<usize>();
    let truncated = total_matches >= resolved_max_results;

    if !output.status.success() && total_matches == 0 {
        if output.status.code() == Some(1) {
            return Ok(RipgrepSearchResponse {
                counts: if resolved_output_mode == "count" {
                    Some(Vec::new())
                } else {
                    None
                },
                error: None,
                files: if resolved_output_mode == "files_with_matches" {
                    Some(Vec::new())
                } else {
                    None
                },
                matches: if resolved_output_mode == "content" {
                    Some(Vec::new())
                } else {
                    None
                },
                pattern,
                success: true,
                tool: "grep".to_string(),
                total_files: Some(0),
                total_matches: Some(0),
                truncated: Some(false),
            });
        }

        let error_message = if stderr.is_empty() {
            "ripgrep search failed".to_string()
        } else {
            stderr
        };

        return Ok(RipgrepSearchResponse {
            counts: None,
            error: Some(error_message),
            files: None,
            matches: None,
            pattern,
            success: false,
            tool: "grep".to_string(),
            total_files: None,
            total_matches: None,
            truncated: None,
        });
    }

    let total_files = counts_by_file.len();

    let counts = if resolved_output_mode == "count" {
        Some(
            counts_by_file
                .iter()
                .map(|(file, count)| RipgrepFileCount {
                    file: file.clone(),
                    count: *count,
                })
                .collect(),
        )
    } else {
        None
    };

    let files = if resolved_output_mode == "files_with_matches" {
        Some(files_with_matches)
    } else {
        None
    };

    let content_matches = if resolved_output_mode == "content" {
        Some(matches.into_iter().take(resolved_max_results).collect())
    } else {
        None
    };

    Ok(RipgrepSearchResponse {
        counts,
        error: None,
        files,
        matches: content_matches,
        pattern,
        success: true,
        tool: "grep".to_string(),
        total_files: Some(total_files),
        total_matches: Some(total_matches.min(resolved_max_results)),
        truncated: Some(truncated),
    })
}

static FS_WATCHER: OnceLock<Mutex<Option<notify::RecommendedWatcher>>> = OnceLock::new();

fn get_watcher_handle() -> &'static Mutex<Option<notify::RecommendedWatcher>> {
    FS_WATCHER.get_or_init(|| Mutex::new(None))
}

#[tauri::command]
pub async fn aurora_websearch(
    request: AuroraWebSearchRequest,
) -> Result<AuroraWebSearchResponse, String> {
    use aurora_websearch::{AuroraSearchBuilder, SafeSearch};

    let action = request.action.clone().unwrap_or_else(|| {
        if request.url.is_some() {
            "fetch".to_string()
        } else {
            "search".to_string()
        }
    });

    // Build the search client with configuration
    let mut builder = AuroraSearchBuilder::new();

    // Set limit if provided
    if let Some(num_results) = request.num_results {
        builder = builder.limit(num_results as usize);
    }

    // Set region if provided
    if let Some(ref region) = request.region {
        builder = builder.region(region.clone());
    }

    // Set safe search if provided
    if let Some(ref safe_search) = request.safe_search {
        let safe = match safe_search.to_uppercase().as_str() {
            "OFF" => SafeSearch::Off,
            "STRICT" => SafeSearch::Strict,
            _ => SafeSearch::Moderate,
        };
        builder = builder.safe_search(safe);
    }

    let aurora = builder
        .build()
        .map_err(|e| format!("Failed to create search client: {}", e))?;

    if action == "fetch" {
        let url = request
            .url
            .clone()
            .ok_or_else(|| "URL is required for fetch".to_string())?;

        let content = aurora
            .extract_content(&url)
            .await
            .map_err(|e| format!("Web fetch failed: {}", e))?;

        let content_value = serde_json::to_value(&content)
            .map_err(|e| format!("Failed to serialize fetch response: {}", e))?;

        return Ok(AuroraWebSearchResponse {
            success: true,
            action,
            query: None,
            url: request.url,
            results: None,
            content: Some(content_value),
            error: None,
        });
    }

    // Search action
    let query = request
        .query
        .clone()
        .ok_or_else(|| "Query is required for search".to_string())?;
    let limit = request.num_results.unwrap_or(10) as usize;

    let results = aurora
        .search_with_limit(&query, limit)
        .await
        .map_err(|e| format!("Web search failed: {}", e))?;

    let results_value = serde_json::to_value(&results)
        .map_err(|e| format!("Failed to serialize search response: {}", e))?;

    Ok(AuroraWebSearchResponse {
        success: true,
        action,
        query: Some(query),
        url: None,
        results: Some(results_value),
        content: None,
        error: None,
    })
}

/// Read directory contents

///
/// Args:
///   path: Directory path to read
///   include_hidden: Whether to include hidden files/folders (starting with .)
#[tauri::command]
pub async fn read_directory(
    path: String,
    include_hidden: Option<bool>,
) -> Result<Vec<FileEntry>, String> {
    let dir_path = Path::new(&path);
    let show_hidden = include_hidden.unwrap_or(true); // Default to showing hidden files

    if !dir_path.exists() {
        return Err(format!("Directory does not exist: {}", path));
    }

    if !dir_path.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let mut entries = Vec::new();

    match fs::read_dir(dir_path) {
        Ok(read_dir) => {
            for entry in read_dir.flatten() {
                let file_name = entry.file_name().to_string_lossy().to_string();
                let file_path = entry.path();
                let metadata = entry.metadata().ok();

                // Skip hidden files/folders if not showing hidden
                // Always show .aurora (our config folder)
                if !show_hidden && file_name.starts_with('.') && file_name != ".aurora" {
                    continue;
                }

                // Always skip .git folder (too many internal files)
                // But .gitignore, .gitattributes etc. are fine (they're files, not the .git folder)
                if file_name == ".git" {
                    continue;
                }

                // Skip large generated folders that slow down the explorer
                if file_name == "node_modules"
                    || file_name == "target"
                    || file_name == "dist"
                    || file_name == ".pnpm"
                {
                    continue;
                }

                let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
                let is_file = metadata.as_ref().map(|m| m.is_file()).unwrap_or(false);
                let extension = file_path
                    .extension()
                    .map(|e| e.to_string_lossy().to_string());

                entries.push(FileEntry {
                    name: file_name,
                    path: file_path.to_string_lossy().to_string(),
                    is_dir,
                    is_file,
                    extension,
                });
            }
        }
        Err(e) => return Err(format!("Failed to read directory: {}", e)),
    }

    // Sort: directories first, then files, alphabetically
    // Hidden files (starting with .) are sorted among their peers
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

/// Maximum wall-clock time we'll wait for a file read before giving up so a
/// frozen disk or network share can never make the editor "load forever".
const FILE_READ_TIMEOUT_MS: u64 = 10_000;

/// Read file content (cached for performance, bounded by a wall-clock timeout)
#[tauri::command]
pub async fn read_file_content(path: String) -> Result<String, String> {
    let read_path = path.clone();
    let join = tokio::task::spawn_blocking(move || crate::file_cache::read_file_cached(&read_path));

    match tokio::time::timeout(std::time::Duration::from_millis(FILE_READ_TIMEOUT_MS), join).await {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => Err(format!("Failed to load file: {}", e)),
        Err(_) => Err(format!(
            "File read timed out after {}ms (path: {})",
            FILE_READ_TIMEOUT_MS, path
        )),
    }
}

/// Read file content + metadata (size + mtime) in a single IPC round-trip.
/// The editor uses this so a tab can be mounted with the canonical freshness
/// stamp captured at read time, eliminating the need for a separate stat
/// call after every open. Goes through the same mtime-validated cache as
/// [`read_file_content`].
#[tauri::command]
pub async fn read_file_with_meta(path: String) -> Result<crate::file_cache::FileMeta, String> {
    let read_path = path.clone();
    let join = tokio::task::spawn_blocking(move || {
        crate::file_cache::read_file_cached_with_meta(&read_path)
    });

    match tokio::time::timeout(std::time::Duration::from_millis(FILE_READ_TIMEOUT_MS), join).await {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => Err(format!("Failed to load file: {}", e)),
        Err(_) => Err(format!(
            "File read timed out after {}ms (path: {})",
            FILE_READ_TIMEOUT_MS, path
        )),
    }
}

/// Cheap freshness probe. Returns the current disk mtime so the editor can
/// decide whether a tab's already-rendered content is still in sync without
/// re-reading the whole file. `None` is encoded as `0` so the frontend can
/// treat "missing" and "epoch" as one degenerate case.
#[tauri::command]
pub async fn stat_file_mtime(path: String) -> Result<u64, String> {
    let read_path = path.clone();
    tokio::task::spawn_blocking(move || crate::file_cache::get_file_mtime(&read_path).unwrap_or(0))
        .await
        .map_err(|e| format!("mtime task failed: {}", e))
}

/// Write file content
#[tauri::command]
pub async fn write_file_content(path: String, content: String) -> Result<(), String> {
    let file_path = Path::new(&path);

    // Create parent directories if they don't exist
    if let Some(parent) = file_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directories: {}", e))?;
        }
    }

    let result = fs::write(file_path, &content).map_err(|e| format!("Failed to write file: {}", e));

    // Invalidate cache after write (file content changed)
    crate::file_cache::get_file_cache().invalidate(&path);

    result
}

/// Execute a shell command with optional shell profile
#[tauri::command]
pub async fn execute_command(
    command: String,
    cwd: Option<String>,
    shell: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<CommandOutput, String> {
    use std::process::Stdio;
    use std::time::Duration;

    let shell_profile = shell.as_deref().unwrap_or("powershell");
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(30_000));

    let (shell_exe, mut cmd) = build_shell_command(shell_profile, &command, &cwd);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            #[cfg(target_os = "windows")]
            if shell_profile != "bash" {
                let mut fallback = TokioCommand::new("powershell");
                fallback
                    .arg("-NoProfile")
                    .arg("-NonInteractive")
                    .arg("-Command")
                    .arg(&command);
                if let Some(ref working_dir) = cwd {
                    fallback.current_dir(working_dir);
                }
                fallback.stdout(Stdio::piped());
                fallback.stderr(Stdio::piped());
                fallback.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);

                match fallback.spawn() {
                    Ok(c) => c,
                    Err(fallback_e) => {
                        return Err(format!(
                            "Failed to execute with pwsh and powershell: {}, {}",
                            e, fallback_e
                        ));
                    }
                }
            } else {
                return Err(format!(
                    "Failed to execute command with {}: {}",
                    shell_exe, e
                ));
            }

            #[cfg(not(target_os = "windows"))]
            {
                return Err(format!(
                    "Failed to execute command with {}: {}",
                    shell_exe, e
                ));
            }
        }
    };

    let pid = child.id();

    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(res) => res.map_err(|e| format!("Command execution failed: {}", e))?,
        Err(_) => {
            if let Some(pid) = pid {
                let _ = try_kill_pid(pid);
            }
            return Err(format!("Command timed out after {}ms", timeout.as_millis()));
        }
    };

    Ok(CommandOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code(),
        success: output.status.success(),
    })
}

#[tauri::command]
pub fn cancel_command_stream(request_id: String) -> Result<(), String> {
    let pid_to_kill = {
        let mut streams = ACTIVE_COMMAND_STREAMS.write();
        if let Some(stream) = streams.get_mut(&request_id) {
            stream.cancelled = true;
            stream.pid
        } else {
            None
        }
    };
    if let Some(pid) = pid_to_kill {
        let _ = try_kill_pid(pid);
    }
    Ok(())
}

// Shell stream batching constants.
//
// The original implementation emitted a Tauri IPC event for every 4 KB chunk
// it read from the child process. Long-running commands (e.g. `npm install`,
// `cargo build`) produced thousands of events per second, saturating the JS
// event loop and freezing the entire IDE — file reads, editor input, and even
// the chat panel would stall behind the backlog.
//
// We now coalesce reads server-side and emit at most ~30 Hz (or sooner if the
// pending buffer grows large). The wire format stays compatible with existing
// TS listeners (`{ stream, data, done, ... }`) — we just send fewer, larger
// chunks. This drops the IPC volume by 1-2 orders of magnitude without losing
// any output, and the agent still gets the full text via the awaited
// CommandOutput at the end.
const SHELL_STREAM_FLUSH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(33);
const SHELL_STREAM_FLUSH_BYTES: usize = 32 * 1024;
const SHELL_STREAM_READ_BUF: usize = 16 * 1024;

fn flush_shell_pending(
    app: &tauri::AppHandle,
    request_id: &str,
    stdout_pending: &mut String,
    stderr_pending: &mut String,
) {
    if !stdout_pending.is_empty() {
        let _ = app.emit(
            &format!("shell-stream-{}", request_id),
            CommandStreamChunk {
                stream: "stdout".to_string(),
                data: std::mem::take(stdout_pending),
                done: false,
                exit_code: None,
                success: None,
            },
        );
    }
    if !stderr_pending.is_empty() {
        let _ = app.emit(
            &format!("shell-stream-{}", request_id),
            CommandStreamChunk {
                stream: "stderr".to_string(),
                data: std::mem::take(stderr_pending),
                done: false,
                exit_code: None,
                success: None,
            },
        );
    }
}

#[tauri::command]
pub async fn execute_command_stream(
    app: tauri::AppHandle,
    request_id: String,
    command: String,
    cwd: Option<String>,
    shell: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<CommandOutput, String> {
    use std::process::Stdio;
    use std::time::Duration;

    {
        let mut streams = ACTIVE_COMMAND_STREAMS.write();
        streams.insert(
            request_id.clone(),
            ActiveCommandStream {
                pid: None,
                cancelled: false,
            },
        );
    }

    let shell_profile = shell.as_deref().unwrap_or("powershell");
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(30_000));
    let (shell_exe, mut cmd) = build_shell_command(shell_profile, &command, &cwd);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            cleanup_command_stream(&request_id);
            return Err(format!("Failed to spawn command with {}: {}", shell_exe, e));
        }
    };

    let pid = child.id();
    {
        let mut streams = ACTIVE_COMMAND_STREAMS.write();
        if let Some(stream) = streams.get_mut(&request_id) {
            stream.pid = pid;
        }
    }

    let mut stdout_buf = String::new();
    let mut stderr_buf = String::new();
    let mut stdout_pending = String::new();
    let mut stderr_pending = String::new();

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture stderr".to_string())?;

    let mut stdout_bytes = vec![0u8; SHELL_STREAM_READ_BUF];
    let mut stderr_bytes = vec![0u8; SHELL_STREAM_READ_BUF];

    let mut stdout_done = false;
    let mut stderr_done = false;

    let mut wait_fut = Box::pin(child.wait());
    let mut timeout_fut = Box::pin(tokio::time::sleep(timeout));
    let mut flush_fut = Box::pin(tokio::time::sleep(SHELL_STREAM_FLUSH_INTERVAL));

    loop {
        if is_command_stream_cancelled(&request_id) {
            if let Some(pid) = pid {
                let _ = try_kill_pid(pid);
            }
            break;
        }

        tokio::select! {
            _ = &mut timeout_fut => {
                if let Some(pid) = pid {
                    let _ = try_kill_pid(pid);
                }
                flush_shell_pending(&app, &request_id, &mut stdout_pending, &mut stderr_pending);
                let _ = app.emit(
                    &format!("shell-stream-error-{}", request_id),
                    format!("Command timed out after {}ms", timeout.as_millis()),
                );
                break;
            }
            _ = &mut flush_fut => {
                flush_shell_pending(&app, &request_id, &mut stdout_pending, &mut stderr_pending);
                flush_fut = Box::pin(tokio::time::sleep(SHELL_STREAM_FLUSH_INTERVAL));
            }
            read = stdout.read(&mut stdout_bytes), if !stdout_done => {
                match read {
                    Ok(0) => { stdout_done = true; }
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&stdout_bytes[..n]);
                        stdout_buf.push_str(&data);
                        stdout_pending.push_str(&data);
                        if stdout_pending.len() + stderr_pending.len() >= SHELL_STREAM_FLUSH_BYTES {
                            flush_shell_pending(&app, &request_id, &mut stdout_pending, &mut stderr_pending);
                            flush_fut = Box::pin(tokio::time::sleep(SHELL_STREAM_FLUSH_INTERVAL));
                        }
                    }
                    Err(e) => {
                        stdout_done = true;
                        flush_shell_pending(&app, &request_id, &mut stdout_pending, &mut stderr_pending);
                        let _ = app.emit(
                            &format!("shell-stream-error-{}", request_id),
                            format!("stdout read error: {}", e),
                        );
                    }
                }
            }
            read = stderr.read(&mut stderr_bytes), if !stderr_done => {
                match read {
                    Ok(0) => { stderr_done = true; }
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&stderr_bytes[..n]);
                        stderr_buf.push_str(&data);
                        stderr_pending.push_str(&data);
                        if stdout_pending.len() + stderr_pending.len() >= SHELL_STREAM_FLUSH_BYTES {
                            flush_shell_pending(&app, &request_id, &mut stdout_pending, &mut stderr_pending);
                            flush_fut = Box::pin(tokio::time::sleep(SHELL_STREAM_FLUSH_INTERVAL));
                        }
                    }
                    Err(e) => {
                        stderr_done = true;
                        flush_shell_pending(&app, &request_id, &mut stdout_pending, &mut stderr_pending);
                        let _ = app.emit(
                            &format!("shell-stream-error-{}", request_id),
                            format!("stderr read error: {}", e),
                        );
                    }
                }
            }
            status = &mut wait_fut => {
                let (exit_code, success) = match status {
                    Ok(s) => (s.code(), Some(s.success())),
                    Err(_) => (None, None),
                };

                let mut tail = Vec::new();
                if stdout.read_to_end(&mut tail).await.is_ok() && !tail.is_empty() {
                    let data = String::from_utf8_lossy(&tail);
                    stdout_buf.push_str(&data);
                    stdout_pending.push_str(&data);
                }

                tail.clear();
                if stderr.read_to_end(&mut tail).await.is_ok() && !tail.is_empty() {
                    let data = String::from_utf8_lossy(&tail);
                    stderr_buf.push_str(&data);
                    stderr_pending.push_str(&data);
                }

                // Final flush of any remaining pending output, then emit a
                // single done marker so listeners can detect completion.
                flush_shell_pending(&app, &request_id, &mut stdout_pending, &mut stderr_pending);
                let _ = app.emit(
                    &format!("shell-stream-{}", request_id),
                    CommandStreamChunk {
                        stream: "meta".to_string(),
                        data: String::new(),
                        done: true,
                        exit_code,
                        success,
                    },
                );

                cleanup_command_stream(&request_id);
                return Ok(CommandOutput {
                    stdout: stdout_buf,
                    stderr: stderr_buf,
                    exit_code,
                    success: success.unwrap_or(false),
                });
            }
        }

        if stdout_done && stderr_done && is_command_stream_cancelled(&request_id) {
            break;
        }
    }

    flush_shell_pending(&app, &request_id, &mut stdout_pending, &mut stderr_pending);
    cleanup_command_stream(&request_id);
    Ok(CommandOutput {
        stdout: stdout_buf,
        stderr: stderr_buf,
        exit_code: Some(1),
        success: false,
    })
}

/// Get system information (Cursor-style detailed info)
#[tauri::command]
pub async fn get_system_info() -> Result<SystemInfo, String> {
    let os = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();

    tokio::task::spawn_blocking(move || {
        // These helpers use blocking I/O / process execution, so run off the async runtime.
        let os_version = get_os_version();
        let shell = get_default_shell();

        SystemInfo {
            os,
            os_version,
            arch,
            hostname: hostname::get()
                .map(|h| h.to_string_lossy().to_string())
                .unwrap_or_else(|_| "unknown".to_string()),
            shell,
        }
    })
    .await
    .map_err(|e| format!("Failed to collect system info: {}", e))
}

/// Get OS version string
fn get_os_version() -> String {
    #[cfg(target_os = "windows")]
    {
        // Try to get Windows version from registry or environment
        if let Ok(output) = Command::new("cmd")
            .args(["/c", "ver"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            let version_str = String::from_utf8_lossy(&output.stdout);
            // Parse "Microsoft Windows [Version 10.0.26200.2605]"
            if let Some(start) = version_str.find("Version ") {
                if let Some(end) = version_str[start..].find(']') {
                    let ver = &version_str[start + 8..start + end];
                    // Return just major.minor.build (e.g., "10.0.26200")
                    let parts: Vec<&str> = ver.split('.').collect();
                    if parts.len() >= 3 {
                        return format!("{}.{}.{}", parts[0], parts[1], parts[2]);
                    }
                    return ver.to_string();
                }
            }
        }
        "unknown".to_string()
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = Command::new("sw_vers").arg("-productVersion").output() {
            return String::from_utf8_lossy(&output.stdout).trim().to_string();
        }
        "unknown".to_string()
    }

    #[cfg(target_os = "linux")]
    {
        // Try to read from /etc/os-release
        if let Ok(content) = std::fs::read_to_string("/etc/os-release") {
            for line in content.lines() {
                if line.starts_with("VERSION_ID=") {
                    return line
                        .trim_start_matches("VERSION_ID=")
                        .trim_matches('"')
                        .to_string();
                }
            }
        }
        // Fallback to uname
        if let Ok(output) = Command::new("uname").arg("-r").output() {
            return String::from_utf8_lossy(&output.stdout).trim().to_string();
        }
        "unknown".to_string()
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "unknown".to_string()
    }
}

/// Get default shell path
fn get_default_shell() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        // Check for PowerShell 7 first, then fall back to PowerShell 5, then cmd
        let ps7_paths = [
            r"C:\Program Files\PowerShell\7\pwsh.exe",
            r"C:\Program Files (x86)\PowerShell\7\pwsh.exe",
        ];

        for path in ps7_paths {
            if Path::new(path).exists() {
                return Some(path.to_string());
            }
        }

        // Check for Windows PowerShell
        if let Ok(system_root) = std::env::var("SystemRoot") {
            let ps5_path = format!(
                r"{}\System32\WindowsPowerShell\v1.0\powershell.exe",
                system_root
            );
            if Path::new(&ps5_path).exists() {
                return Some(ps5_path);
            }
        }

        // Fallback to cmd.exe
        Some(
            std::env::var("COMSPEC").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".to_string()),
        )
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Unix-like: check SHELL env var
        std::env::var("SHELL")
            .ok()
            .or_else(|| Some("/bin/sh".to_string()))
    }
}

/// Create a new file
#[tauri::command]
pub async fn create_file(path: String) -> Result<(), String> {
    let file_path = Path::new(&path);

    // Check if file already exists
    if file_path.exists() {
        return Err(format!("File already exists: {}", path));
    }

    // Create parent directories if they don't exist
    if let Some(parent) = file_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directories: {}", e))?;
        }
    }

    // Create empty file
    fs::File::create(file_path).map_err(|e| format!("Failed to create file: {}", e))?;

    Ok(())
}

/// Create a new folder
#[tauri::command]
pub async fn create_folder(path: String) -> Result<(), String> {
    let dir_path = Path::new(&path);

    // Check if folder already exists
    if dir_path.exists() {
        return Err(format!("Folder already exists: {}", path));
    }

    fs::create_dir_all(dir_path).map_err(|e| format!("Failed to create folder: {}", e))
}

/// Delete a file or folder
#[tauri::command]
pub async fn delete_path(path: String) -> Result<(), String> {
    let target_path = Path::new(&path);

    if !target_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    let result = if target_path.is_dir() {
        // Invalidate all cached files under this directory
        crate::file_cache::get_file_cache().invalidate_prefix(&path);
        fs::remove_dir_all(target_path).map_err(|e| format!("Failed to delete folder: {}", e))
    } else {
        // Invalidate the specific file
        crate::file_cache::get_file_cache().invalidate(&path);
        fs::remove_file(target_path).map_err(|e| format!("Failed to delete file: {}", e))
    };

    result
}

/// Rename a file or folder
#[tauri::command]
pub async fn rename_path(old_path: String, new_path: String) -> Result<(), String> {
    let old = Path::new(&old_path);
    let new = Path::new(&new_path);

    if !old.exists() {
        return Err(format!("Path does not exist: {}", old_path));
    }

    if new.exists() {
        return Err(format!("Destination already exists: {}", new_path));
    }

    // Invalidate old path from cache (it's being renamed)
    let cache = crate::file_cache::get_file_cache();
    if old.is_dir() {
        cache.invalidate_prefix(&old_path);
    } else {
        cache.invalidate(&old_path);
    }

    fs::rename(old, new).map_err(|e| format!("Failed to rename: {}", e))
}

/// Copy a file or folder to a new location
#[tauri::command]
pub async fn copy_path(source: String, destination: String) -> Result<(), String> {
    let src = Path::new(&source);
    let dest = Path::new(&destination);

    if !src.exists() {
        return Err(format!("Source does not exist: {}", source));
    }

    if dest.exists() {
        return Err(format!("Destination already exists: {}", destination));
    }

    // Create parent directories if needed
    if let Some(parent) = dest.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directories: {}", e))?;
        }
    }

    if src.is_file() {
        fs::copy(src, dest).map_err(|e| format!("Failed to copy file: {}", e))?;
    } else if src.is_dir() {
        copy_dir_recursive(src, dest)?;
    }

    Ok(())
}

/// Recursively copy a directory
fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("Failed to create directory: {}", e))?;

    for entry in fs::read_dir(src).map_err(|e| format!("Failed to read directory: {}", e))? {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)?;
        } else {
            fs::copy(&src_path, &dest_path).map_err(|e| format!("Failed to copy file: {}", e))?;
        }
    }

    Ok(())
}

/// Get the current workspace root directory
#[tauri::command]
pub async fn get_workspace_root() -> Result<String, String> {
    std::env::current_dir()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|e| format!("Failed to get current directory: {}", e))
}

#[derive(Debug, Serialize, Clone)]
pub struct FsEventPayload {
    pub paths: Vec<String>,
    pub kind: String,
}

/// Subtrees that produce constant churn but never carry user-relevant
/// content. Any path whose components contain one of these names is
/// dropped before the watcher emits an `fs-changed` event.
///
/// Keep this list tight — anything we add here will go invisible to
/// the file explorer's auto-refresh + the in-IDE git status reload.
const WATCH_IGNORED_DIR_NAMES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "build",
    "dist",
    ".next",
    ".turbo",
    ".cache",
    ".vite",
    ".parcel-cache",
    ".pnpm-store",
    ".yarn",
];

/// File suffixes that are always editor/build noise (lock files,
/// SQLite WAL/SHM, sourcemap rebuilds, …). Filtering these costs us
/// nothing because they're never opened in the editor.
const WATCH_IGNORED_FILE_SUFFIXES: &[&str] = &[
    ".lock",
    ".tmp",
    ".swp",
    ".swo",
    "~",
    ".db-wal",
    ".db-shm",
    ".sqlite-wal",
    ".sqlite-shm",
];

#[inline]
pub fn is_ignored_watch_path(path: &Path) -> bool {
    if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
        if WATCH_IGNORED_FILE_SUFFIXES
            .iter()
            .any(|suffix| file_name.ends_with(suffix))
        {
            return true;
        }
    }
    path.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .map(|name| WATCH_IGNORED_DIR_NAMES.contains(&name))
            .unwrap_or(false)
    })
}

/// Start a filesystem watcher that emits `fs-changed` events to the frontend.
#[tauri::command]
pub async fn start_fs_watcher(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err(format!("Watch path does not exist: {}", path));
    }

    // Stop existing watcher if any
    {
        let mut guard = get_watcher_handle()
            .lock()
            .map_err(|e| format!("Failed to lock watcher: {}", e))?;
        *guard = None;
    }

    let app_handle = app.clone();
    let mut watcher = recommended_watcher(move |res: Result<Event, notify::Error>| {
        if let Ok(event) = res {
            // Skip Access events outright — they fire on every read
            // (mtime/atime stat) and the frontend ignores them anyway.
            // Without this filter, running `git status` or HMR scans
            // alone produces thousands of IPC roundtrips per second.
            if matches!(event.kind, EventKind::Access(_) | EventKind::Other) {
                return;
            }

            // Drop events that touch only IGNORED subtrees (`.git/`,
            // `node_modules/`, `target/`, `build/`, `dist/`, etc).
            // Cargo, pnpm and Vite churn these directories thousands
            // of times during a dev rebuild and every modification
            // would otherwise:
            //   1. Invalidate the Rust file cache for that path
            //   2. Schedule a debounced `git_get_status` reload
            // Both are pure overhead — none of those files are user
            // content. We filter event-level (not path-level) so that
            // a single mixed event still fires for the user-content
            // paths it carries.
            let kept_paths: Vec<String> = event
                .paths
                .iter()
                .filter(|p| !is_ignored_watch_path(p))
                .map(|p| p.to_string_lossy().to_string())
                .collect();

            if kept_paths.is_empty() {
                return;
            }

            let kind_str = match event.kind {
                EventKind::Create(_) => "create",
                EventKind::Modify(_) => "modify",
                EventKind::Remove(_) => "remove",
                EventKind::Any => "any",
                EventKind::Access(_) => "access",
                EventKind::Other => "other",
            };

            let _ = app_handle.emit(
                "fs-changed",
                FsEventPayload {
                    paths: kept_paths,
                    kind: kind_str.to_string(),
                },
            );
        }
    })
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    watcher
        .configure(Config::default().with_compare_contents(false))
        .map_err(|e| format!("Failed to configure watcher: {}", e))?;

    watcher
        .watch(target, RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch path: {}", e))?;

    {
        let mut guard = get_watcher_handle()
            .lock()
            .map_err(|e| format!("Failed to lock watcher: {}", e))?;
        *guard = Some(watcher);
    }

    Ok(())
}

/// Stop the filesystem watcher
#[tauri::command]
pub async fn stop_fs_watcher() -> Result<(), String> {
    let mut guard = get_watcher_handle()
        .lock()
        .map_err(|e| format!("Failed to lock watcher: {}", e))?;
    *guard = None;
    Ok(())
}

/// Reveal a file or folder in the system file explorer
#[tauri::command]
pub async fn reveal_in_explorer(path: String) -> Result<(), String> {
    let target_path = Path::new(&path);

    if !target_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    // Determine the path to reveal (parent folder if it's a file)
    #[allow(unused_variables)]
    let reveal_path = if target_path.is_file() {
        target_path.parent().unwrap_or(target_path)
    } else {
        target_path
    };

    #[cfg(target_os = "windows")]
    {
        // On Windows, use explorer with /select to highlight the item
        let select_path = if target_path.is_file() {
            format!("/select,{}", path)
        } else {
            path.clone()
        };

        Command::new("explorer")
            .arg(&select_path)
            .spawn()
            .map_err(|e| format!("Failed to open explorer: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Try xdg-open first, then fall back to common file managers
        let result = Command::new("xdg-open")
            .arg(reveal_path.to_string_lossy().to_string())
            .spawn();

        if result.is_err() {
            // Try nautilus (GNOME)
            let _ = Command::new("nautilus").arg("--select").arg(&path).spawn();
        }
    }

    Ok(())
}

/// Open a terminal at the specified path
#[tauri::command]
pub async fn open_in_terminal(path: String) -> Result<(), String> {
    let target_path = Path::new(&path);

    // Use the path directly if it's a directory, otherwise use its parent
    let terminal_path = if target_path.is_dir() {
        target_path.to_path_buf()
    } else {
        target_path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| target_path.to_path_buf())
    };

    if !terminal_path.exists() {
        return Err(format!("Path does not exist: {}", terminal_path.display()));
    }

    #[cfg(target_os = "windows")]
    {
        // Try Windows Terminal first, then fall back to cmd
        let wt_result = Command::new("wt")
            .arg("-d")
            .arg(terminal_path.to_string_lossy().to_string())
            .spawn();

        if wt_result.is_err() {
            // Fall back to PowerShell in a new window
            Command::new("powershell")
                .arg("-NoExit")
                .arg("-Command")
                .arg(format!("cd '{}'", terminal_path.display()))
                .spawn()
                .map_err(|e| format!("Failed to open terminal: {}", e))?;
        }
    }

    #[cfg(target_os = "macos")]
    {
        // Open Terminal.app with the specified directory
        let script = format!(
            "tell application \"Terminal\" to do script \"cd '{}'\"",
            terminal_path.display()
        );
        Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .spawn()
            .map_err(|e| format!("Failed to open Terminal: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Try common terminal emulators
        let terminals = ["gnome-terminal", "konsole", "xfce4-terminal", "xterm"];
        let mut opened = false;

        for terminal in terminals {
            let result = match terminal {
                "gnome-terminal" => Command::new(terminal)
                    .arg("--working-directory")
                    .arg(terminal_path.to_string_lossy().to_string())
                    .spawn(),
                "konsole" => Command::new(terminal)
                    .arg("--workdir")
                    .arg(terminal_path.to_string_lossy().to_string())
                    .spawn(),
                _ => Command::new(terminal).current_dir(&terminal_path).spawn(),
            };

            if result.is_ok() {
                opened = true;
                break;
            }
        }

        if !opened {
            return Err("No supported terminal emulator found".to_string());
        }
    }

    Ok(())
}

// =============================================================================
// BATCH FILE OPERATIONS (Performance Optimized)
// =============================================================================

use std::collections::HashMap;

/// Read multiple files in a single IPC call (reduces overhead dramatically)
/// Returns a map of path -> content (or error message)
#[tauri::command]
pub async fn read_files_batch(paths: Vec<String>) -> HashMap<String, Result<String, String>> {
    let fallback_paths = paths.clone();
    match tokio::task::spawn_blocking(move || crate::file_cache::read_files_batch_cached(paths))
        .await
    {
        Ok(results) => results,
        Err(error) => fallback_paths
            .into_iter()
            .map(|path| (path, Err(format!("Batch file read task failed: {}", error))))
            .collect(),
    }
}

/// Invalidate a specific file or directory prefix from the cache
/// Call this after external file modifications
#[tauri::command]
pub async fn invalidate_file_cache(path: String, is_prefix: bool) -> Result<(), String> {
    let cache = crate::file_cache::get_file_cache();
    if is_prefix {
        cache.invalidate_prefix(&path);
    } else {
        cache.invalidate(&path);
    }
    Ok(())
}

/// Get cache statistics for debugging
#[tauri::command]
pub async fn get_cache_stats() -> (usize, usize) {
    crate::file_cache::get_file_cache().stats()
}

// =============================================================================
// CLI COMMANDS
// =============================================================================

/// Install the Aurora CLI to system PATH
/// This allows using `aurora .` from any terminal
#[tauri::command]
pub async fn install_aurora_cli() -> Result<String, String> {
    crate::cli::install::install_cli().map(|_| "Aurora CLI installed successfully".to_string())
}

/// Check if the Aurora CLI is installed
#[tauri::command]
pub async fn is_aurora_cli_installed() -> Result<bool, String> {
    crate::cli::install::is_cli_installed()
}

/// Uninstall the Aurora CLI from system PATH
#[tauri::command]
pub async fn uninstall_aurora_cli() -> Result<String, String> {
    crate::cli::install::uninstall_cli().map(|_| "Aurora CLI uninstalled successfully".to_string())
}

/// Install Aurora into the Windows Explorer context menu
#[tauri::command]
pub async fn install_aurora_context_menu() -> Result<String, String> {
    crate::cli::install::install_context_menu()
        .map(|_| "Aurora context menu installed successfully".to_string())
}

/// Check whether the Aurora context menu is installed
#[tauri::command]
pub async fn is_aurora_context_menu_installed() -> Result<bool, String> {
    crate::cli::install::is_context_menu_installed()
}

/// Remove Aurora from the Windows Explorer context menu
#[tauri::command]
pub async fn uninstall_aurora_context_menu() -> Result<String, String> {
    crate::cli::install::uninstall_context_menu()
        .map(|_| "Aurora context menu removed successfully".to_string())
}
