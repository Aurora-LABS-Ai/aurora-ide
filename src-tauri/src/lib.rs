use std::sync::Mutex;
use tauri::{Emitter, Manager};

mod checkpoints;
pub mod cli;
mod commands;
mod context;
mod db;
mod file_cache;
mod mcp;
mod services;
mod undo_redo;

use cli::{CliArgs, CliOpenRequest};
use services::ThreadService;

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
            // State persistence commands
            commands::state::save_workspace_state,
            commands::state::get_workspace_state,
            commands::state::list_recent_workspaces,
            commands::state::save_editor_state,
            commands::state::get_editor_state,
            commands::state::save_explorer_state,
            commands::state::get_explorer_state,
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
            commands::settings::get_all_tool_settings,
            commands::settings::set_tool_approval,
            commands::settings::save_all_tool_settings,
            // Threads (chat history) commands
            commands::threads::thread_save,
            commands::threads::thread_create,
            commands::threads::thread_load,
            commands::threads::thread_delete,
            commands::threads::thread_list_summaries,
            commands::threads::thread_add_user_message,
            commands::threads::thread_start_response,
            commands::threads::thread_append_token,
            commands::threads::thread_append_thinking,
            commands::threads::thread_add_tool_call,
            commands::threads::thread_finalize_response,
            commands::threads::thread_update_usage,
            commands::threads::thread_get_api_history,
            commands::threads::thread_update_title,
            // Token counting commands
            commands::tokens::count_tokens,
            commands::tokens::count_chat_tokens,
            commands::tokens::count_messages_tokens,
            commands::tokens::detect_model_encoding,
            commands::tokens::estimate_tokens_quick,
            commands::tokens::truncate_to_tokens,
            // LLM HTTP proxy commands (bypasses CORS)
            commands::llm::llm_request,
            commands::llm::llm_stream_request,
            commands::llm::cancel_llm_stream,
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
            // Semantic search commands
            commands::semantic::get_all_semantic_indexes,
            commands::semantic::get_semantic_index,
            commands::semantic::get_semantic_index_by_path,
            commands::semantic::save_semantic_index,
            commands::semantic::delete_semantic_index,
            commands::semantic::update_semantic_index_status,
            commands::semantic::update_workspace_exclusions,
            commands::semantic::get_semantic_settings,
            commands::semantic::save_semantic_settings,
            commands::semantic::set_semantic_model_path,
            commands::semantic::validate_semantic_model_path,
            commands::semantic::get_semantic_model_info,
            commands::semantic::get_execution_provider_info,
            commands::semantic::get_available_gpu_features,
            commands::semantic::start_semantic_indexing,
            commands::semantic::semantic_search,
            commands::semantic::cancel_semantic_indexing,
            commands::semantic::is_semantic_indexing,
            commands::semantic::get_semantic_data_directory,
            commands::semantic::get_semantic_index_path,
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
            // Browser WebView commands
            commands::browser::create_browser_webview,
            commands::browser::get_inspector_script,
            commands::browser::browser_navigate,
            commands::browser::browser_activate_inspector,
            commands::browser::browser_deactivate_inspector,
            commands::browser::browser_clear_selection,
            commands::browser::browser_eval,
            commands::browser::close_browser_webview,
            commands::browser::browser_refresh,
            commands::browser::browser_get_url,
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
            // OpenAI Native (async-openai) commands for LM Studio, Ollama, etc.
            commands::openai_native::openai_native_stream,
            commands::openai_native::openai_native_chat,
            // CLI commands (install/uninstall aurora command)
            commands::install_aurora_cli,
            commands::is_aurora_cli_installed,
            commands::uninstall_aurora_cli,
            commands::install_aurora_context_menu,
            commands::is_aurora_context_menu_installed,
            commands::uninstall_aurora_context_menu,
            commands::aurora_websearch,
            // Context Engine commands (turn-based context management)
            context::commands::context_add_user_message,
            context::commands::context_add_assistant_response,
            context::commands::context_add_tool_call,
            context::commands::context_add_tool_result,
            context::commands::context_finalize_turn,
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

            // Store thread service for per-message persistence
            app.manage(ThreadService::new());

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
