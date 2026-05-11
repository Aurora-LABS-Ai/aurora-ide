use std::sync::Mutex;
use tauri::{Emitter, Manager};

mod agent_runtime;
mod agent_safety;
mod api;
mod checkpoints;
pub mod cli;
mod commands;
mod context;
mod db;
mod explorer;
mod file_cache;
pub mod icon_pack;
mod mcp;
mod services;
// Phase 3 native tool buckets. Sub-C lands `file_workspace_search`;
// Sub-D adds `shell_editor_todo` + `permissions`; Sub-E composes
// them into `register_builtin_tools` and wires the bucket into the
// `agent_v2` `ToolRegistry`. The module is `pub` so the verify
// crates under `target/__verify_phase3_*/` can mount it via
// `#[path]` without dragging in heavy Tauri/ONNX deps.
pub mod tools;
mod undo_redo;

use cli::{CliArgs, CliOpenRequest};

// ---------------------------------------------------------------------------
// Phase 3 — production IDE event sink
// ---------------------------------------------------------------------------
//
// `ProductionIdeEventSink` plugs Sub-D's `shell_editor_todo` bucket into
// real Tauri events emitted on the main `AppHandle`. The three
// fire-and-forget editor/todo tools (`editor_open_file`,
// `read_lints`, `todo_write`) dispatch through `AppHandle::emit`; the
// `shell_spawn` background launcher hands its work off to a
// `tokio::spawn` running `commands::execute_command_stream` — the
// same loop the legacy TS executor invoked via `invoke()`.
//
// The Phase 4 permission emitter is intentionally NOT wired here —
// `agent_grant_permission` only needs the `Arc<PermissionRouter>` in
// managed state to resolve oneshots. The parent agent's final-10%
// step writes whatever shape it wants for the modal-emitting
// `Permitter` (a `TauriPermitter` over an emitter that posts the
// `"agent_permission_request"` channel) and attaches it to the
// `ToolRegistry` via `with_permitter`.
struct ProductionIdeEventSink {
    app: tauri::AppHandle,
}

impl ProductionIdeEventSink {
    fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }

    fn emit_payload<T: serde::Serialize + Clone>(
        &self,
        channel: &str,
        payload: T,
    ) -> Result<(), String> {
        self.app.emit(channel, payload).map_err(|e| e.to_string())
    }
}

#[async_trait::async_trait]
impl tools::shell_editor_todo::IdeEventSink for ProductionIdeEventSink {
    fn emit_editor_open(
        &self,
        path: &str,
        line: Option<u64>,
        column: Option<u64>,
    ) -> Result<(), String> {
        #[derive(Clone, serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Payload<'a> {
            path: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            line: Option<u64>,
            #[serde(skip_serializing_if = "Option::is_none")]
            column: Option<u64>,
        }
        self.emit_payload("agent_editor_open", Payload { path, line, column })
    }

    fn emit_read_lints(&self, paths: &[String]) -> Result<(), String> {
        #[derive(Clone, serde::Serialize)]
        struct Payload<'a> {
            paths: &'a [String],
        }
        self.emit_payload("agent_read_lints", Payload { paths })
    }

    fn emit_todo_write(&self, todos: &serde_json::Value) -> Result<(), String> {
        #[derive(Clone, serde::Serialize)]
        struct Payload<'a> {
            todos: &'a serde_json::Value,
        }
        self.emit_payload("agent_todo_write", Payload { todos })
    }

    async fn spawn_shell_stream(
        &self,
        req: tools::shell_editor_todo::ide_event_sink::ShellStreamRequest,
    ) -> Result<(), String> {
        let app = self.app.clone();
        // Mirrors the legacy TS executor: queue the streaming command
        // and return immediately. The frontend already listens on
        // `shell-stream-{request_id}` so events flow through the
        // existing emit path.
        tokio::spawn(async move {
            let _ = commands::execute_command_stream(
                app,
                req.request_id,
                req.command,
                req.cwd,
                req.shell,
                req.timeout_ms,
            )
            .await;
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Phase 2.3 — agent_v2 wiring
// ---------------------------------------------------------------------------
//
// `RealApiFactory` is the production glue between the Rust agent loop
// (`commands::agent_v2`) and the existing provider adapters in
// `crate::api`. The factory takes the `ProviderConfigSnapshot` carried
// inside every `AgentChatRequest` (frontend → Rust via the Phase 2.3
// camelCase IPC) and forwards it verbatim to `crate::api::build_api_client`.
//
// The adapter layer (`api/anthropic.rs`, `api/openai_compat.rs`) is the
// only place that interprets `api_key`, `base_url`, `custom_headers`,
// and `custom_params`. The factory is intentionally a thin shim — it
// must NOT introduce its own provider-routing logic.
struct RealApiFactory;

impl commands::agent_v2::ApiFactory for RealApiFactory {
    fn build(
        &self,
        config: &api::ProviderConfigSnapshot,
    ) -> Result<
        std::sync::Arc<dyn agent_runtime::api_client::StreamingApiClient>,
        agent_runtime::error::RuntimeError,
    > {
        Ok(api::build_api_client(config))
    }
}

/// Run Aurora with default (no CLI arguments)
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    run_with_args(CliArgs::default())
}

/// Run Aurora with CLI arguments (e.g., from `aurora .` command)
pub fn run_with_args(cli_args: CliArgs) {
    // Convert CLI args to open request
    let open_request: CliOpenRequest = (&cli_args).into();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_pty::init())
        .invoke_handler(tauri::generate_handler![
            // File system commands
            commands::read_directory,
            commands::read_file_content,
            commands::read_file_with_meta,
            commands::stat_file_mtime,
            commands::write_file_content,
            commands::execute_command,
            commands::execute_command_stream,
            commands::cancel_command_stream,
            commands::get_system_info,
            commands::create_file,
            commands::create_folder,
            commands::delete_path,
            commands::rename_path,
            commands::copy_path,
            commands::get_workspace_root,
            commands::start_fs_watcher,
            commands::stop_fs_watcher,
            commands::reveal_in_explorer,
            commands::open_in_terminal,
            // Batch file operations (performance optimized)
            commands::read_files_batch,
            commands::invalidate_file_cache,
            commands::get_cache_stats,
            // Native editor operations (no JS string ops on hot paths)
            commands::editor_ops::apply_search_replace,
            commands::editor_ops::apply_multi_search_replace,
            commands::editor_ops::compute_unified_diff,
            commands::editor_ops::slice_file_lines,
            commands::editor_ops::is_path_excluded,
            // State persistence commands
            commands::state::save_workspace_state,
            commands::state::get_workspace_state,
            commands::state::list_recent_workspaces,
            commands::state::save_editor_state,
            commands::state::get_editor_state,
            commands::state::save_explorer_state,
            commands::state::get_explorer_state,
            explorer::commands::explorer_open_workspace,
            explorer::commands::explorer_refresh,
            explorer::commands::explorer_apply_fs_changes,
            explorer::commands::explorer_toggle_folder,
            explorer::commands::explorer_expand_folder,
            explorer::commands::explorer_select_file,
            explorer::commands::explorer_reveal_file,
            explorer::commands::explorer_collapse_all,
            explorer::commands::explorer_save_state,
            explorer::commands::explorer_get_state,
            explorer::commands::explorer_clear_workspace,
            // Settings commands
            commands::settings::get_app_settings,
            commands::settings::save_app_settings,
            commands::settings::get_global_skills_path,
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::get_all_providers,
            commands::settings::get_provider,
            commands::settings::save_provider,
            commands::settings::delete_provider,
            commands::settings::has_providers,
            commands::settings::save_all_providers,
            commands::settings::list_provider_models,
            commands::settings::list_provider_models_for,
            commands::settings::upsert_provider_model,
            commands::settings::delete_provider_model,
            commands::settings::replace_provider_models,
            commands::settings::get_all_tool_settings,
            commands::settings::set_tool_approval,
            commands::settings::save_all_tool_settings,
            // Threads (chat history) commands — all backed by the
            // agent_v2 SessionStore (see commands/threads.rs).
            commands::threads::thread_save,
            commands::threads::thread_create,
            commands::threads::thread_load,
            commands::threads::thread_delete,
            commands::threads::thread_list_summaries,
            commands::threads::thread_update_usage,
            commands::threads::thread_get_api_history,
            commands::threads::thread_update_title,
            commands::threads::thread_cancel_current_turn,
            // Token counting commands
            commands::tokens::count_tokens,
            commands::tokens::count_chat_tokens,
            commands::tokens::count_messages_tokens,
            commands::tokens::detect_model_encoding,
            commands::tokens::estimate_tokens_quick,
            commands::tokens::truncate_to_tokens,
            commands::provider_catalog::commands::provider_catalog_get_presets,
            commands::local_providers::commands::local_provider_detect,
            commands::local_providers::commands::local_provider_probe_custom,
            commands::local_providers::commands::local_provider_show_ollama_model,
            commands::local_providers::commands::local_provider_get_running_models,
            commands::local_providers::commands::local_provider_load_ollama_model,
            commands::local_providers::commands::local_provider_unload_ollama_model,
            commands::local_providers::commands::local_provider_delete_ollama_model,
            commands::local_providers::commands::local_provider_pull_ollama_model,
            commands::local_providers::commands::cancel_local_provider_pull,
            commands::provider_kernel::commands::aurora_provider_chat,
            commands::provider_kernel::commands::aurora_provider_stream,
            commands::provider_kernel::commands::cancel_aurora_provider_stream,
            // Chat state sync commands (bulletproof multi-window)
            commands::chat::get_chat_state,
            commands::chat::set_chat_loading,
            commands::chat::set_current_thread,
            commands::chat::set_pending_approval,
            commands::chat::update_chat_state,
            commands::chat::clear_chat_state,
            commands::chat::broadcast_chat_event,
            // Theme commands
            commands::themes::get_custom_themes,
            commands::themes::save_custom_theme,
            commands::themes::delete_custom_theme,
            commands::themes::set_active_theme_id,
            commands::themes::get_active_theme_id,
            // Speech input commands
            commands::speech::speech_validate_config,
            commands::speech::speech_transcribe_pcm,
            // Git commands
            commands::git::git_is_repository,
            commands::git::git_get_status,
            commands::git::git_get_branches,
            commands::git::git_get_commits,
            commands::git::git_current_branch,
            commands::git::git_stage_file,
            commands::git::git_unstage_file,
            commands::git::git_stage_all,
            commands::git::git_unstage_all,
            commands::git::git_discard_changes,
            commands::git::git_commit,
            commands::git::git_checkout,
            commands::git::git_create_branch,
            commands::git::git_pull,
            commands::git::git_push,
            commands::git::git_get_diff,
            commands::git::git_get_file_versions,
            // Browser WebView commands (native window backed by
            // crate::services::browser_runtime::BrowserManager).
            commands::browser::create_browser_webview,
            commands::browser::get_inspector_script,
            commands::browser::browser_navigate,
            commands::browser::browser_activate_inspector,
            commands::browser::browser_deactivate_inspector,
            commands::browser::browser_clear_selection,
            commands::browser::browser_activate_stagewise,
            commands::browser::browser_deactivate_stagewise,
            commands::browser::browser_eval,
            commands::browser::close_browser_webview,
            commands::browser::browser_refresh,
            commands::browser::browser_get_url,
            commands::browser::browser_set_size,
            commands::browser::browser_set_position,
            commands::browser::aurora_record_picked_element,
            commands::browser::aurora_record_browser_result,
            // MCP (Model Context Protocol) commands
            mcp::commands::mcp_load_servers,
            mcp::commands::mcp_get_servers,
            mcp::commands::mcp_get_server,
            mcp::commands::mcp_add_server,
            mcp::commands::mcp_remove_server,
            mcp::commands::mcp_update_server,
            mcp::commands::mcp_toggle_server,
            mcp::commands::mcp_connect_server,
            mcp::commands::mcp_disconnect_server,
            mcp::commands::mcp_call_tool,
            mcp::commands::mcp_get_all_tools,
            mcp::commands::mcp_get_config_path,
            // CLI commands (install/uninstall aurora command)
            commands::install_aurora_cli,
            commands::is_aurora_cli_installed,
            commands::uninstall_aurora_cli,
            commands::install_aurora_context_menu,
            commands::is_aurora_context_menu_installed,
            commands::uninstall_aurora_context_menu,
            commands::aurora_websearch,
            commands::ripgrep_search,
            commands::validate_structured_document,
            // Context Engine commands (turn-based context management)
            context::commands::context_add_user_message,
            context::commands::context_add_assistant_response,
            context::commands::context_add_tool_call,
            context::commands::context_add_tool_result,
            context::commands::context_finalize_turn,
            context::commands::context_discard_current_turn,
            context::commands::context_build_messages,
            context::commands::context_build_request_messages,
            context::commands::context_get_state,
            context::commands::context_needs_summarization,
            context::commands::context_get_turn_to_summarize,
            context::commands::context_set_turn_summary,
            context::commands::context_get_summarization_prompt,
            context::commands::context_clear_thread,
            context::commands::context_init_from_thread,
            context::commands::context_get_turns,
            context::commands::context_update_settings,
            context::commands::context_estimate_request_tokens,
            // Checkpoint commands (workspace file state snapshots)
            commands::checkpoints::checkpoint_init,
            commands::checkpoints::checkpoint_ensure_initialized,
            commands::checkpoints::checkpoint_create,
            commands::checkpoints::checkpoint_restore,
            commands::checkpoints::checkpoint_list,
            commands::checkpoints::checkpoint_get_by_message,
            commands::checkpoints::checkpoint_delete_thread,
            commands::checkpoints::checkpoint_delete_workspace,
            commands::checkpoints::checkpoint_is_initialized,
            commands::checkpoints::checkpoint_get_enabled,
            commands::checkpoints::checkpoint_set_enabled,
            // Undo/Redo commands (per-file history)
            commands::undo_redo::undo_init_file,
            commands::undo_redo::undo_record_change,
            commands::undo_redo::undo_file,
            commands::undo_redo::redo_file,
            commands::undo_redo::undo_file_and_save,
            commands::undo_redo::redo_file_and_save,
            commands::undo_redo::undo_get_state,
            commands::undo_redo::undo_clear_file,
            commands::undo_redo::undo_clear_all,
            // Agent v2 — Rust-side ConversationRuntime entrypoint.
            // Phase 2.3 swaps the StubApiFactory for `RealApiFactory`,
            // which forwards each `ProviderConfigSnapshot` straight to
            // `api::build_api_client`. The new `agent_post_tool_result`
            // command lets the frontend close the loop on bridge tool
            // calls (`FrontendBridgeExecutor`).
            commands::agent_v2::agent_chat_v2,
            commands::agent_v2::agent_cancel,
            commands::agent_v2::agent_load_thread,
            commands::agent_v2::agent_post_tool_result,
            // Phase 4 permission gate — frontend modal posts the
            // user's Allow/Deny verdict here. The router lives in
            // managed state (see `setup` below).
            commands::agent_v2_permissions::agent_grant_permission,
        ])
        .setup(move |app| {
            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }

            // Initialize database
            let handle = app.handle();
            let db = db::Database::init(&handle).expect("Failed to initialize database");

            // Store database in app state (wrapped in Mutex for thread safety)
            app.manage(Mutex::new(db));

            // Store shared chat state for multi-window sync
            app.manage(commands::chat::SharedChatState::default());

            // Store Rust-owned explorer state
            app.manage(explorer::ExplorerStateHandle::default());

            // Store checkpoint state for file state snapshots
            let checkpoint_state = commands::checkpoints::CheckpointState::new();
            let app_data_dir = handle
                .path()
                .app_data_dir()
                .expect("Failed to get app data dir");
            checkpoint_state.init(app_data_dir);
            app.manage(checkpoint_state);

            // Store undo/redo state for per-file history
            app.manage(commands::undo_redo::UndoRedoState::new());

            // Rust agent runtime registry — the single owner of all
            // chat-history persistence.
            //
            // Sessions live in `<app_data>/agent_v2/{thread_id}.jsonl`
            // with a metadata sidecar at `<thread_id>.meta.json`. The
            // `SessionStore` (held inside the `AgentRegistry`) is the
            // sole source of truth for everything the chat list and
            // Thread History modal display — title, token/context
            // usage, timestamps, message history. There is no other
            // persistence layer.
            //
            // The `RealApiFactory` plugs the `api` adapters in for
            // live LLM traffic; the registry's internal `BridgeRouter`
            // powers the `agent_post_tool_result` round trip with the
            // frontend tool runner.
            let agent_v2_sessions_dir = handle
                .path()
                .app_data_dir()
                .expect("Failed to get app data dir for agent_v2 sessions")
                .join("agent_v2");
            let agent_registry = std::sync::Arc::new(commands::agent_v2::AgentRegistry::new(
                std::sync::Arc::new(RealApiFactory),
                agent_v2_sessions_dir,
            ));

            // Phase 3 — pre-populate the AgentRegistry's ToolRegistry
            // with all 22 native tools (Sub-C: file/workspace/search,
            // Sub-D: shell/editor/todo). The registry uses interior
            // mutability via DashMap, so we register through the
            // shared Arc returned by `tools()` — the AgentRegistry's
            // own view sees the same backing map.
            //
            // The production IDE event sink emits Tauri events for the
            // four event-firing tools (`editor_open_file`,
            // `read_lints`, `todo_write`) and re-enters
            // `commands::execute_command_stream` from a `tokio::spawn`
            // for `shell_spawn`, mirroring the legacy TS executor's
            // `invoke()` shape.
            let production_sink: std::sync::Arc<
                dyn tools::shell_editor_todo::IdeEventSink,
            > = std::sync::Arc::new(ProductionIdeEventSink::new(handle.clone()));

            // Build the BrowserManager BEFORE tool registration so the
            // browser bucket can hold an Arc to it. The same Arc is
            // also installed as managed Tauri state below so the IPC
            // commands in `commands::browser` see the same instance.
            let browser_manager = std::sync::Arc::new(
                crate::services::browser_runtime::BrowserManager::new(handle.clone()),
            );

            tools::register_builtin_tools(
                &agent_registry.tools(),
                production_sink,
                Some(browser_manager.clone()),
            );

            // Phase 4 — production permission gate.
            //
            // Layered design (outer → inner):
            //   SettingsAwarePermitter → TauriPermitter → modal
            //
            // 1. `SettingsAwarePermitter` consults the
            //    `tool_settings` SQLite table on every call.
            //    `auto`  → approve without asking (no event emitted).
            //    `deny`  → deny without asking (no event emitted).
            //    `always_ask` (or unset) → fall through to inner.
            // 2. `TauriPermitter` registers a oneshot in the router,
            //    fires the `"agent_permission_request"` event, and
            //    parks until the frontend posts a verdict via
            //    `agent_grant_permission`.
            // 3. `PermissionGuardedExecutor` wraps every native tool
            //    whose `requires_permission()` is `true` so the
            //    runtime's gate-free `tool.execute(...)` path
            //    transparently consults the chain — no changes to
            //    `ConversationRuntime::run_turn`.
            //
            // The DB-backed resolver re-reads on every call, so
            // toggling a setting in the UI takes effect immediately
            // on the next tool dispatch.
            let permission_router = std::sync::Arc::new(
                tools::permissions::PermissionRouter::new(),
            );
            let permission_emitter: std::sync::Arc<
                dyn tools::permissions::PermissionEmitter,
            > = std::sync::Arc::new(
                tools::permissions::TauriPermissionEmitter::new(handle.clone()),
            );
            let tauri_permitter: std::sync::Arc<
                dyn agent_runtime::tool_executor::Permitter,
            > = std::sync::Arc::new(
                tools::permissions::TauriPermitter::new(
                    permission_router.clone(),
                    permission_emitter,
                ),
            );

            // The resolver holds an `AppHandle` and pulls
            // `Mutex<Database>` from managed state on each call —
            // sharing the same SQLite connection used by the rest
            // of the app.
            let resolver: std::sync::Arc<dyn tools::permissions::SettingsResolver> =
                std::sync::Arc::new(
                    tools::permissions::DatabaseSettingsResolver::new(handle.clone()),
                );
            let settings_aware: std::sync::Arc<
                dyn agent_runtime::tool_executor::Permitter,
            > = std::sync::Arc::new(
                tools::permissions::SettingsAwarePermitter::new(
                    resolver,
                    tauri_permitter,
                ),
            );
            tools::install_permission_gate(&agent_registry.tools(), settings_aware);

            app.manage(agent_registry);
            app.manage(permission_router);

            // Native browser-window manager. Owns the lifecycle of
            // every browser-* WebviewWindow used for previews,
            // element inspection, and the agent browser tools.
            // `BrowserManager` is `Clone` and every field is shared
            // through `Arc<DashMap>`, so this clone is a second
            // *handle* over the same per-window state map the tool
            // bucket holds — `State<'_, BrowserManager>` lookups in
            // `commands::browser::*` see the windows the tools open
            // and vice-versa.
            app.manage((*browser_manager).clone());

            // If CLI provided a path, emit event to frontend to open it
            // Clone open_request since we're in a move closure
            let request = open_request.clone();
            if request.workspace_path.is_some() || request.file_path.is_some() {
                let window = app.get_webview_window("main");
                if let Some(win) = window {
                    // Emit after a short delay to ensure frontend is ready
                    let win_clone = win.clone();
                    std::thread::spawn(move || {
                        // Wait for frontend to initialize
                        std::thread::sleep(std::time::Duration::from_millis(500));
                        let _ = win_clone.emit("cli-open", &request);
                        println!("[Aurora CLI] Emitted open request: {:?}", request);
                    });
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
