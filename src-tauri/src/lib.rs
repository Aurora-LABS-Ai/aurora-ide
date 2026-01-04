use std::sync::Mutex;
use tauri::Manager;

mod commands;
mod db;
mod file_cache;
mod mcp;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            commands::state::save_editor_state,
            commands::state::get_editor_state,
            commands::state::save_explorer_state,
            commands::state::get_explorer_state,
            // Settings commands
            commands::settings::get_app_settings,
            commands::settings::save_app_settings,
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
            commands::threads::save_thread,
            commands::threads::get_thread,
            commands::threads::list_threads,
            commands::threads::delete_thread,
            // LLM HTTP proxy commands (bypasses CORS)
            commands::llm::llm_request,
            commands::llm::llm_stream_request,
            // Chat state sync commands (bulletproof multi-window)
            commands::chat::get_chat_state,
            commands::chat::set_chat_loading,
            commands::chat::set_current_thread,
            commands::chat::set_pending_approval,
            commands::chat::update_chat_state,
            commands::chat::update_chat_state,
            commands::chat::clear_chat_state,
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
        ])
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }

            // Initialize database
            let handle = app.handle();
            let db = db::Database::init(&handle)
                .expect("Failed to initialize database");

            // Store database in app state (wrapped in Mutex for thread safety)
            app.manage(Mutex::new(db));

            // Store shared chat state for multi-window sync
            app.manage(commands::chat::SharedChatState::default());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
