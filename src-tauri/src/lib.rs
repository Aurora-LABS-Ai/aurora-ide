// The headless core (no `desktop` feature) compiles with no window and, until
// the HTTP command registry of Phase 6.2 exists, with nothing calling most
// of what the IPC commands called. Those items are not dead, they are
// waiting for their caller; the desktop build still reports real dead code.
#![cfg_attr(not(feature = "desktop"), allow(dead_code, unused_imports))]

#[cfg(feature = "desktop")]
use std::sync::Mutex;
#[cfg(feature = "desktop")]
use tauri::{Emitter, Manager};

/// Linker directive that gives **test binaries only** a Windows application
/// manifest declaring Common-Controls v6.
///
/// `tauri_build::build()` embeds a manifest into binary targets, but a
/// `cargo test` executable is a separate target and got none. Without one,
/// the loader binds the System32 `comctl32.dll` (v5.82) instead of the
/// side-by-side v6 assembly — and v5.82 does not export
/// `TaskDialogIndirect`, which the dialog stack statically imports. Every
/// test binary therefore died at load with STATUS_ENTRYPOINT_NOT_FOUND
/// (0xc0000139) before reaching `main`, so the entire Rust suite was
/// unrunnable on Windows while the app itself worked fine. The failure
/// looked like a broken toolchain, which is why it went unfixed long enough
/// for real drift to accumulate behind it (see `BUILTIN_TOOL_COUNT`).
///
/// `.drectve` is how MSVC object files pass switches to the linker — the
/// equivalent of `#pragma comment(linker, ...)` in C++. `#[cfg(test)]`
/// scopes it to the test build of this crate, so the app's own
/// Tauri-generated manifest is untouched. `build.rs` cannot do this:
/// `cargo:rustc-link-arg-tests` applies only to `tests/` integration
/// targets, and unit tests compile into the lib target.
///
/// Only `/MANIFESTDEPENDENCY:` is listed — `rust-lld` rejects `/MANIFEST:`
/// inside `.drectve`. The linker therefore writes a side-by-side
/// `<test-exe>.manifest` next to the binary rather than embedding it, which
/// the loader honours identically.
#[cfg(all(windows, test))]
#[used]
#[unsafe(link_section = ".drectve")]
static TEST_BINARY_MANIFEST: [u8; 167] = *b" /MANIFESTDEPENDENCY:\"type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'\"";

mod agent_runtime;
mod agent_safety;
mod api;
mod checkpoints;
pub mod cli;
pub mod console;
pub mod cli_delegate;
/// Aurora Chat's searchable index over its own conversations, plus the facts
/// it was asked to remember. Derived from `paths::chats_dir()` and rebuildable
/// from it — see the module docs for why that matters.
mod chat_memory;
mod code_index;
#[cfg(feature = "desktop")]
mod commands;
mod crash;
mod db;
mod explorer;
mod file_cache;
/// The commands any host serves, by name (the window's IPC and HTTP). The
/// desktop's own browser host still runs commands through the window's
/// webview, so `dispatch` waits for `aurora serve` (Phase 6.1) as its caller.
#[cfg_attr(feature = "desktop", allow(dead_code))]
mod host_commands;
/// Named events core code sends to its host (the windows, or a headless host).
mod host_events;
pub mod icon_pack;
#[cfg(feature = "desktop")]
mod launch_prefs;
mod logging;
mod mcp;
mod paths;
mod plans;
/// Job objects and process trees for everything Aurora starts.
mod process;
mod pty_sessions;
mod services;
mod shell;
/// Helper executables Aurora ships next to its own binary (currently ripgrep,
/// which backs the agent's `grep` tool).
mod sidecar;
// Phase 3 native tool buckets. Sub-C lands `file_workspace_search`;
// Sub-D adds `shell_editor_todo` + `permissions`; Sub-E composes
// them into `register_builtin_tools` and wires the bucket into the
// `agent_v2` `ToolRegistry`. The module is `pub` so the verify
// crates under `target/__verify_phase3_*/` can mount it via
// `#[path]` without dragging in heavy Tauri/ONNX deps.
mod prompt_refine;
/// Reply suggestions from a cloud model: the conversation brief, the
/// `suggest_replies` tool, and the per-conversation suggestion log.
mod reply_suggest;
/// Background tasks for core code, with or without the Tauri runtime.
mod rt;
/// Live dictation: a warm `audiocpp_cli` child that transcribes while you talk.
/// The batch path stays in `commands::speech`.
#[cfg(feature = "desktop")]
mod speech_stream;
pub mod tools;
mod typing_assist;
mod undo_redo;
mod usage_ledger;
mod websearch;
/// The interface in a browser: an HTTP host inside the desktop app.
#[cfg(feature = "desktop")]
mod web_host;
/// Workspace file work shared by the tools and the IPC commands.
mod workspace;

#[cfg(feature = "desktop")]
use cli::{CliArgs, CliOpenRequest};

/// Run Aurora with default (no CLI arguments)
#[cfg(feature = "desktop")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    run_with_args(CliArgs::default())
}

/// Run Aurora with CLI arguments (e.g., from `aurora .` command)
#[cfg(feature = "desktop")]
pub fn run_with_args(cli_args: CliArgs) {
    // File logging + panic hook first: anything that fails from here on —
    // including startup itself — must leave a trace on disk in the packaged
    // exe, where stderr goes nowhere.
    logging::init();
    // …and the nets for the failures a panic hook never sees. A stack overflow
    // or an access violation terminates the process without unwinding, so
    // before this the log simply stopped mid-session and the only evidence was
    // an exception code in the Windows event log.
    crash::install();

    // The agent runs on tokio workers, and that is where the 2026-08-17
    // overflow happened. Reporting a stack overflow needs stack for the handler
    // to run on, and a reservation made on the main thread says nothing about a
    // worker — so every worker gets one as it starts. Tauri would otherwise
    // build this runtime itself with the same shape (multi-thread, all drivers
    // enabled); the only addition is the hook.
    match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .on_thread_start(crash::reserve_handler_stack)
        .build()
    {
        Ok(runtime) => {
            tauri::async_runtime::set(runtime.handle().clone());
            // Deliberately leaked: it must outlive every task Tauri spawns on
            // it, which is the life of the process. Dropping it here would
            // block on shutdown and then tear down the runtime we just set.
            std::mem::forget(runtime);
        }
        Err(error) => logging::log_error(
            "crash.install",
            &format!(
                "could not install the stack-guaranteed async runtime ({error}); \
                 Tauri's default is used instead and a worker stack overflow may \
                 go unreported"
            ),
        ),
    }

    // Convert CLI args to open request
    let open_request: CliOpenRequest = (&cli_args).into();

    // A launch with NO arguments at all — the Start-menu / desktop icon, or
    // `run()`. Only this shape consults the saved launch preference: `aurora
    // <path>`, the Explorer context menu, and file associations all carry an
    // explicit "open this here" intent that the view-only agent window cannot
    // serve, so they always get the IDE.
    let bare_launch = cli_args.path.is_none()
        && !cli_args.agent
        && cli_args.command.is_none()
        && cli_args.diff.is_none();
    // The user chose the agent window as their startup surface.
    let prefers_agent = bare_launch && launch_prefs::read() == launch_prefs::LaunchSurface::Agent;

    // `agw` / `aurora --agent`, or the saved preference: open ONLY the agent
    // window (no IDE). Captured here so the `move` setup closure can act on it.
    let agent_mode = cli_args.agent || prefers_agent;
    // The directory `agw` was run from. Passed to the window as `?ws=` so its
    // chats are scoped to that project — without it every chat started from the
    // CLI is created with a null workspace root and never appears in the left
    // rail, which groups chats into a per-project tree.
    //
    // Only the CLI path resolves it here. An icon launch has no meaningful
    // working directory (Explorer hands the process System32), so its root is
    // resolved from the most recently opened workspace once the DB is up —
    // see the agent-window build block in `setup`.
    let agent_workspace = if cli_args.agent {
        cli_args.agent_workspace_root()
    } else {
        None
    };

    tauri::Builder::default()
        .on_webview_event(services::composer_drop::on_webview_event)
        // Quit when the last window the user can actually SEE goes away.
        //
        // Tauri keeps the process alive while any window exists, and Aurora
        // deliberately keeps hidden ones: launching straight into the agent
        // window HIDES `main` rather than closing it, because `agent_open_in_ide`
        // needs it alive as the sole listener (see the agent-window build block
        // in `setup`). A standalone browser preview can be hidden too.
        //
        // That combination stranded the app: close the agent window and a
        // hidden `main` kept the process running with nothing on screen and no
        // way to reach it — the user's only exit was Task Manager. A hidden
        // window is a live IPC target, never a way for a person to quit.
        //
        // Minimizing is safe: on Windows a minimized window still reports
        // visible, so this only fires when every remaining window is genuinely
        // hidden.
        .on_window_event(|window, event| {
            if !matches!(event, tauri::WindowEvent::Destroyed) {
                return;
            }

            // The Agent Window is what runs work sent from outside, so its
            // going away has to be published — another process reading a stale
            // "window open" would dispatch a task nobody can claim and wait out
            // its timeout.
            //
            // Done here rather than only in the frontend's own teardown because
            // a crashed webview never gets to run that. This handler fires
            // either way.
            if window.label() == "agent-window" {
                cli_delegate::bridge::clear();
            }

            let app = window.app_handle();
            let remaining: Vec<_> = app.webview_windows().into_values().collect();
            // An un-queryable window cannot be shown to the user either, so a
            // failure here counts as "not visible" rather than keeping a
            // headless process alive on the strength of an error.
            if remaining.iter().any(|w| w.is_visible().unwrap_or(false)) {
                return;
            }
            // The app is going away: stop every background sub-agent so its
            // run ends through the normal path — its transcript is already
            // journaled, and `agent.json` records `killed` rather than a
            // `running` nobody is running.
            if let Some(registry) =
                app.try_state::<std::sync::Arc<commands::agent_v2::AgentRegistry>>()
            {
                let stopped = registry.subagent_tasks().kill_all();
                if stopped > 0 {
                    logging::log_info(
                        "subagents",
                        &format!("stopped {stopped} background sub-agent(s) on exit"),
                    );
                }
            }
            // CLOSE the leftovers rather than calling `app.exit`. Two reasons,
            // both learned the hard way:
            //
            // 1. `exit` tears the process down while those windows still have
            //    live HWNDs, and Chromium then fails to unregister its window
            //    class on the way out — `Failed to unregister class
            //    Chrome_WidgetWin_0. Error = 1412` (ERROR_CLASS_HAS_WINDOWS).
            //    Harmless in itself, but it is the visible symptom of tearing
            //    down out of order.
            // 2. `exit` skips every window's close handler, and `main`'s is
            //    where the IDE persists explorer state, open tabs and the
            //    current thread (`useWindowClose`). Killing the process
            //    silently drops that save.
            //
            // Closing each window runs its handlers, lets the webviews destroy
            // themselves in order, and leaves Tauri to exit on its own once the
            // last one is gone. Re-entry is safe: this fires again for each
            // close, finds nothing visible and nothing left to close.
            for leftover in remaining {
                let _ = leftover.close();
            }
        })
        // Local files for the browser panel. A `file://` page cannot reach
        // Aurora's IPC (the capability grant matches http/https origins only),
        // so every browser tool against it times out; serving the same file
        // through this scheme lands it on `http://aurora-page.localhost/…`,
        // which the existing grant covers. See `services::local_page`.
        .register_uri_scheme_protocol(services::local_page::SCHEME, |_ctx, request| {
            services::local_page::respond(&request)
        })
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
            commands::detach_command_stream,
            commands::get_system_info,
            // System fonts (Settings → Appearance → Typography)
            commands::fonts::system_font_families,
            commands::icon_themes::list_installed_icon_themes,
            commands::icon_themes::read_icon_theme_assets,
            // Shell registry (Settings → Tools → Shell)
            commands::shell_profiles::shell_profiles_get,
            commands::shell_profiles::shell_profiles_scan,
            commands::shell_profiles::shell_profiles_add,
            commands::shell_profiles::shell_profiles_remove,
            commands::shell_profiles::shell_profiles_set_enabled,
            commands::shell_profiles::shell_profiles_verify,
            commands::shell_profiles::shell_interactive_config,
            commands::shell_profiles::shell_tools_inventory,
            commands::shell_background_processes,
            commands::create_file,
            commands::create_folder,
            commands::list_filesystem_roots,
            commands::web_host::web_host_status,
            commands::web_host::web_host_start,
            commands::web_host::web_host_stop,
            commands::delete_path,
            commands::rename_path,
            commands::copy_path,
            commands::get_workspace_root,
            commands::start_fs_watcher,
            commands::stop_fs_watcher,
            commands::reveal_in_explorer,
            commands::open_in_terminal,
            // Diagnostics (Settings → Diagnostics): read aurora.log back, and
            // let the web layer write its own failures into it.
            commands::diagnostics::logs_recent,
            commands::diagnostics::logs_report,
            commands::diagnostics::logs_clear,
            // Faults the AGENT reported about Aurora, via `report_aurora_issue`.
            commands::diagnostics::aurora_issues_read,
            commands::diagnostics::aurora_issues_clear,
            // Batch file operations (performance optimized)
            commands::read_files_batch,
            commands::invalidate_file_cache,
            commands::get_cache_stats,
            commands::terminal_pty::terminal_pty_open,
            commands::terminal_pty::terminal_pty_attach,
            commands::terminal_pty::terminal_pty_attach_events,
            commands::terminal_pty::terminal_pty_open_events,
            commands::terminal_pty::terminal_pty_write,
            commands::terminal_pty::terminal_pty_resize,
            commands::terminal_pty::terminal_pty_kill,
            commands::terminal_pty::terminal_pty_running,
            // Native editor operations (no JS string ops on hot paths)
            commands::editor_ops::apply_search_replace,
            commands::editor_ops::apply_multi_search_replace,
            commands::editor_ops::compute_unified_diff,
            commands::editor_ops::slice_file_lines,
            commands::editor_ops::is_path_excluded,
            commands::editor_ops::agent_open_in_ide,
            commands::editor_ops::take_pending_ide_open,
            // State persistence commands
            commands::state::save_workspace_state,
            commands::state::get_workspace_state,
            commands::state::list_recent_workspaces,
            commands::state::save_editor_state,
            commands::state::get_editor_state,
            commands::state::save_explorer_state,
            commands::state::get_explorer_state,
            explorer::commands::explorer_open_workspace,
            explorer::file_list::explorer_list_files,
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
            commands::settings::save_app_settings_entries,
            commands::settings::get_global_skills_path,
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::provider_test::provider_test_model,
            commands::image_providers::image_provider_test,
            commands::image_providers::image_provider_discover_models,
            commands::image_direct::image_direct_generate,
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
            commands::threads::thread_duplicate,
            commands::threads::thread_folder,
            commands::threads::thread_move_to_project,
            commands::threads::thread_copy_markdown,
            commands::threads::thread_load,
            commands::threads::thread_usage_breakdown,
            commands::threads::thread_delete,
            commands::threads::thread_list_summaries,
            commands::threads::thread_update_usage,
            commands::usage_stats::usage_stats_get,
            commands::threads::thread_get_api_history,
            commands::threads::thread_update_title,
            commands::title_maker::generate_thread_title,
            commands::title_maker::generate_thread_title_cloud,
            commands::threads::thread_set_pinned,
            // Aurora Chat's memory page.
            commands::chat_memory::chat_memory_list_facts,
            commands::chat_gallery::chat_gallery_list,
            commands::chat_gallery::chat_gallery_copy_image,
            commands::chat_gallery::chat_gallery_save_as,
            commands::chat_gallery::chat_gallery_read_image,
            commands::chat_gallery::chat_gallery_set_hidden,
            commands::chat_gallery::chat_gallery_delete,
            commands::chat_video::chat_video_refresh,
            commands::chat_video::video_model_catalog,
            commands::chat_gallery::chat_gallery_thumbnail,
            commands::chat_memory::chat_memory_add_fact,
            commands::chat_memory::chat_memory_update_fact,
            commands::chat_memory::chat_memory_set_fact_pinned,
            commands::chat_memory::chat_memory_forget_fact,
            commands::chat_memory::chat_memory_search_facts,
            commands::chat_memory::chat_memory_stats,
            commands::chat_memory::chat_memory_rebuild_index,
            commands::threads::thread_set_archived,
            commands::threads::thread_set_model,
            commands::threads::thread_set_execution_mode,
            commands::threads::thread_cancel_current_turn,
            commands::project_stats::project_stats_get,
            commands::conversation_stats::conversation_stats_get,
            commands::code_index::code_index_status,
            commands::code_index::code_index_probe,
            commands::code_index::code_index_rebuild,
            commands::code_index::code_index_build_status,
            commands::code_index::code_index_save_settings,
            commands::code_index::code_index_start_build,
            commands::code_index::code_index_cancel_build,
            commands::code_index::code_index_list_storage,
            commands::code_index::code_index_delete_storage,
            commands::plans::plan_get_active,
            commands::plans::plan_get,
            commands::plans::plan_list,
            commands::plans::plan_set_step_status,
            commands::plans::plan_save_body,
            commands::plans::plan_set_status,
            commands::todos::todo_list_for_thread,
            commands::artifacts::thread_artifact_list,
            commands::artifacts::thread_artifact_preview_patch,
            commands::artifacts::thread_artifact_upsert,
            commands::artifacts::thread_artifact_select,
            // Token counting commands
            commands::tokens::count_tokens,
            commands::tokens::count_chat_tokens,
            commands::tokens::count_messages_tokens,
            commands::tokens::detect_model_encoding,
            commands::tokens::estimate_tokens_quick,
            commands::tokens::truncate_to_tokens,
            commands::provider_catalog::commands::provider_catalog_get_presets,
            commands::provider_models::provider_list_models,
            // Codex (ChatGPT subscription) provider
            commands::codex::codex_auth_status,
            commands::codex::codex_auth_login,
            commands::codex::codex_auth_cancel_login,
            commands::codex::codex_auth_logout,
            commands::codex::codex_usage_get,
            commands::codex::codex_accounts_list,
            commands::codex::codex_account_set_main,
            commands::codex::codex_account_remove,
            commands::codex::codex_account_clear_limit,
            commands::codex::codex_account_import_cli,
            // Claude Code (claude.ai subscription) provider
            commands::claude_code::claude_code_auth_status,
            commands::claude_code::claude_code_auth_begin,
            commands::claude_code::claude_code_auth_complete,
            commands::claude_code::claude_code_auth_cancel,
            commands::claude_code::claude_code_auth_logout,
            commands::claude_code::claude_code_usage_get,
            commands::claude_code::claude_code_accounts_list,
            commands::claude_code::claude_code_account_set_main,
            commands::claude_code::claude_code_account_remove,
            commands::claude_code::claude_code_account_import_cli,
            // Antigravity (Google account) provider
            commands::antigravity::antigravity_auth_status,
            commands::antigravity::antigravity_auth_login,
            commands::antigravity::antigravity_auth_cancel_login,
            commands::antigravity::antigravity_auth_logout,
            commands::antigravity::antigravity_accounts_list,
            commands::antigravity::antigravity_account_set_main,
            commands::antigravity::antigravity_account_remove,
            commands::antigravity::antigravity_account_import_ide,
            commands::antigravity::antigravity_models_list,
            commands::antigravity::antigravity_quota_get,
            commands::commandcode::commandcode_auth_status,
            commands::commandcode::commandcode_auth_login,
            commands::commandcode::commandcode_auth_cancel_login,
            commands::commandcode::commandcode_auth_logout,
            commands::commandcode::commandcode_auth_store_key,
            commands::commandcode::commandcode_usage_get,
            commands::commandcode::commandcode_list_models,
            // Cursor (subscription) provider
            commands::cursor::cursor_auth_status,
            commands::cursor::cursor_usage_get,
            commands::cursor::cursor_auth_connect,
            commands::cursor::cursor_auth_sign_out,
            commands::cursor::cursor_state_db_path,
            commands::cursor::cursor_models_list,
            commands::cursor::cursor_models_list_enabled,
            commands::cursor::cursor_models_refresh,
            commands::cursor::cursor_model_set_enabled,
            commands::cursor::cursor_models_set_enabled_bulk,
            commands::opencode::opencode_local_key,
            commands::opencode::opencode_auth_path,
            commands::opencode::opencode_models,
            commands::opencode::opencode_usage,
            commands::ark::ark_connect,
            commands::ark::ark_disconnect,
            commands::ark::ark_session_status,
            commands::ark::ark_usage,
            commands::kenari::kenari_usage,
            commands::deepseek::deepseek_balance_get,
            commands::minimax::minimax_usage_get,
            commands::modal::modal_workspace_models,
            commands::modal::modal_cli_status,
            commands::modal::modal_cli_create_proxy_token,
            commands::modal::modal_cli_sign_in,
            commands::modal::modal_cli_billing_summary,
            commands::modal::modal_workspaces,
            commands::modal::modal_use_workspace,
            commands::modal::modal_save_workspace,
            commands::modal::modal_forget_workspace,
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
            commands::speech::install_agent_media_permission_handler,
            commands::speech_stream::speech_stream_validate,
            commands::speech_stream::speech_stream_arm,
            commands::speech_stream::speech_stream_write,
            commands::speech_stream::speech_stream_stop,
            commands::speech_stream::speech_stream_cancel,
            commands::speech_stream::speech_stream_shutdown,
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
            commands::browser::list_browser_windows,
            commands::browser::browser_refresh,
            commands::browser::browser_get_url,
            commands::browser::browser_page_title,
            commands::browser::browser_local_servers,
            commands::browser::browser_set_device,
            commands::browser::browser_set_zoom,
            commands::browser::browser_set_corner_radius,
            commands::browser::browser_capture_screenshot,
            commands::browser::browser_eval_value,
            commands::browser::browser_set_size,
            commands::browser::browser_set_position,
            commands::browser::browser_set_bounds,
            commands::browser::browser_set_visible,
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
            mcp::commands::mcp_set_workspace,
            mcp::commands::mcp_restart_server,
            mcp::commands::mcp_check_command,
            // CLI commands (install/uninstall aurora command)
            commands::install_aurora_cli,
            commands::is_aurora_cli_installed,
            commands::uninstall_aurora_cli,
            commands::install_aurora_context_menu,
            commands::is_aurora_context_menu_installed,
            commands::uninstall_aurora_context_menu,
            commands::cli_take_pending_open_request,
            // `aurora agent` — the Agent Window's side of running a task
            // dispatched from a terminal.
            cli_delegate::commands::cli_task_bind,
            cli_delegate::commands::cli_task_fail,
            cli_delegate::commands::cli_task_pending,
            cli_delegate::commands::cli_task_claim,
            cli_delegate::commands::aurora_bridge_publish,
            cli_delegate::commands::aurora_bridge_clear,
            cli_delegate::commands::aurora_mcp_client_config,
            cli_delegate::commands::aurora_mcp_clients,
            commands::aurora_websearch,
            commands::ripgrep_search,
            commands::validate_structured_document,
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
            // The registry's `ApiAdapters` forward each
            // `ProviderConfigSnapshot` straight to
            // `api::build_api_client`. The new `agent_post_tool_result`
            // command lets the frontend close the loop on bridge tool
            // calls (`FrontendBridgeExecutor`).
            commands::agent_v2::agent_chat_v2,
            commands::agent_v2::agent_compact_thread,
            commands::agent_v2::agent_cancel,
            commands::agent_v2::agent_active_turns,
            commands::agent_v2::agent_load_thread,
            commands::agent_v2::agent_rewind_to_user_message,
            commands::agent_v2::agent_post_tool_result,
            commands::agent_v2::agent_enqueue_message,
            commands::agent_v2::agent_cancel_queued_message,
            // Sub-agents: the Agents panel's list, a child's transcript, and
            // its stop button. Spawning is a tool call, not a command.
            commands::agent_v2::agent_subagent_list,
            commands::agent_v2::agent_subagent_load,
            commands::agent_v2::agent_subagent_kill,
            // Reports waiting to wake an idle parent, and the window's claim
            // once a turn carries one (`agent_runtime::subagents::outbox`).
            commands::agent_v2::agent_subagent_pending,
            commands::agent_v2::agent_subagent_claim,
            // Which agent cards a conversation keeps pinned beside the icon
            // rail (`agent_runtime::subagents::rail_state`).
            commands::agent_v2::agent_subagent_rail_get,
            commands::agent_v2::agent_subagent_rail_set,
            // What the reader set in a conversation's answer boxes
            // (`agent_runtime::answer_boxes`).
            commands::agent_v2::agent_answer_boxes_get,
            commands::agent_v2::agent_answer_box_set,
            commands::agent_v2::agent_work_cards_get,
            commands::agent_v2::agent_work_card_set,
            commands::threads::subagent_thread_load,
            // Phase 4 permission gate — frontend modal posts the
            // user's Allow/Deny verdict here. The router lives in
            // managed state (see `setup` below).
            commands::agent_v2_permissions::agent_grant_permission,
            // Composer typing assistance (autocorrect · completion · next-word)
            commands::typing_assist::typing_assist_ensure_ready,
            commands::typing_assist::typing_assist_query,
            commands::typing_assist::typing_assist_correct,
            commands::typing_assist::typing_assist_learn,
            commands::typing_assist::typing_assist_undo_correct,
            commands::typing_assist::typing_assist_flush,
            // Composer prompt refinement (local llama.cpp GGUF or configured provider)
            commands::prompt_refine::prompt_refine_validate,
            commands::prompt_refine::prompt_refine_run,
            commands::prompt_refine::prompt_refine_cloud,
            commands::prompt_refine::prompt_refine_title,
            commands::settings::get_launch_surface,
            commands::settings::set_launch_surface,
            commands::editor_ops::open_ide_window,
            commands::prompt_refine::prompt_refine_dictation,
            commands::prompt_refine::prompt_refine_suggest,
            commands::prompt_refine::reply_suggest_cloud,
            commands::prompt_refine::reply_suggest_outcome,
            commands::prompt_refine::prompt_refine_cancel,
        ])
        // The IDE window is created INVISIBLE (`"visible": false` in
        // tauri.conf.json) and revealed here, once its page has actually
        // loaded — and only when this launch wants the IDE at all. This is
        // what makes an agent-surface launch open ONLY the agent window:
        // before, the auto-created IDE window painted first and was hidden
        // mid-setup, so every agent launch flashed the IDE. It also upgrades
        // normal IDE launches: the window appears with content, not as a
        // blank shell that fills in later.
        .on_page_load(move |webview, payload| {
            if agent_mode {
                return;
            }
            if webview.label() != "main" {
                return;
            }
            if payload.event() != tauri::webview::PageLoadEvent::Finished {
                return;
            }
            let window = webview.window();
            // Re-fires on every reload (Ctrl+R) — showing a visible window is
            // a no-op, so no guard is needed.
            let _ = window.show();
            let _ = window.set_focus();
        })
        .setup(move |app| {
            // Terminal sessions announce agent-opened tabs and their endings.
            // The interface in a browser (`AURORA_WEB=1`); off otherwise.
            web_host::start_if_enabled(app.handle());

            let pty_handle = app.handle().clone();
            pty_sessions::install(std::sync::Arc::new(move |notice| {
                let _ = pty_handle.emit(notice.event_name(), notice.payload());
            }));

            // Devtools stay available in every build (the `devtools`
            // Cargo feature is on for the `tauri` crate), but we no
            // longer auto-open them. The WebView's native shortcut
            // works in both dev and release:
            //   Windows: F12
            //   macOS:   Cmd+Option+I
            //   Linux:   Ctrl+Shift+I

            // IDE launch: the main window stays invisible until its page
            // loads (see `on_page_load` above). If that moment never comes —
            // dev server down, frontend crash during boot — the user must not
            // be left with a running process and no window, so a fallback
            // reveals the (possibly blank) window after a grace period. The
            // blank window is recoverable (F12, reload); an invisible one is
            // not.
            if !agent_mode {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(10));
                    if let Some(main_win) = handle.get_webview_window("main") {
                        if !main_win.is_visible().unwrap_or(true) {
                            let _ = main_win.show();
                        }
                    }
                });
            }

            // Initialize database.
            //
            // A failure here is recoverable in principle (we could disable
            // any feature that touches the DB and run as a stateless editor),
            // but the IDE in its current form depends on the DB for
            // settings, threads, custom themes, MCP config, etc., so we
            // log a clear diagnostic and emit it to the frontend before
            // bailing — instead of the previous `.expect()` which hard-
            // crashed the process and produced a useless dialog.
            let handle = app.handle();
            let db = match db::Database::init() {
                Ok(db) => db,
                Err(err) => {
                    let resolved = paths::db_file();
                    let message = format!(
                        "Aurora IDE failed to initialize its database at {}.\n\n\
                         Error: {}\n\n\
                         The application cannot start without a working SQLite store. \
                         Common causes: the AuroraIDE data folder is read-only, on a \
                         network drive that doesn't allow SQLite WAL, or the parent \
                         path is missing write permissions for the current user.",
                        resolved.display(),
                        err,
                    );
                    logging::log_error("db.init", &message);
                    // Try to surface this in the main window before exit. The
                    // window boots invisible now, so it must be shown first or
                    // the message would go to a window nobody can see.
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.emit("aurora_fatal_init_error", &message);
                    }
                    return Err(Box::<dyn std::error::Error>::from(message));
                }
            };

            // Store database in app state (wrapped in Mutex for thread safety)
            app.manage(Mutex::new(db));

            // Native browser-window manager. Owns the lifecycle of every
            // browser-* WebviewWindow used for previews, element inspection,
            // and the agent browser tools. Built before the engine so the
            // browser bucket can hold an Arc to it.
            let browser_manager = std::sync::Arc::new(
                crate::services::browser_runtime::BrowserManager::new(handle.clone()),
            );

            // The engine: usage ledger, shell registry, MCP servers, the
            // agent registry (the single owner of all chat-history
            // persistence), the native tools and the permission gate. The
            // same start-up a host with no window runs; the app hands it the
            // managed database (read per call through the handle), its
            // windows as the event sink, and the browser.
            let engine = agent_runtime::host::start_engine(agent_runtime::host::EngineHost {
                db: std::sync::Arc::new(handle.clone()),
                events: std::sync::Arc::new(handle.clone()),
                browser: Some(browser_manager.clone()),
            })?;

            // Store shared chat state for multi-window sync
            app.manage(commands::chat::SharedChatState::default());

            // Store Rust-owned explorer state
            app.manage(explorer::ExplorerStateHandle::default());

            // Store checkpoint state for file state snapshots
            let checkpoint_state = commands::checkpoints::CheckpointState::new();
            checkpoint_state.init(paths::checkpoints_dir());
            app.manage(checkpoint_state);

            // Store undo/redo state for per-file history
            app.manage(commands::undo_redo::UndoRedoState::new());

            // Composer typing-assist engine (lazily built on first activation).
            app.manage(std::sync::Arc::new(
                typing_assist::TypingAssistState::default(),
            ));

            // Composer prompt-refine (drives the user's llama-completion.exe).
            app.manage(std::sync::Arc::new(prompt_refine::RefineState::default()));

            // The commands reach the engine through managed state.
            app.manage(engine.registry);
            app.manage(engine.permission_router);

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

            // CLI / context-menu open: stash the request in app state so
            // the frontend's workspace-bootstrap effect can pull it
            // synchronously on mount. The previous "sleep 500ms then
            // emit cli-open" design lost the event whenever the JS
            // bundle hadn't finished hydrating in time — Tauri events
            // are NOT buffered, so a listener registered after `.emit`
            // never sees it, and the "restore last workspace" path
            // silently won the race.
            //
            // We also still emit the `cli-open` event for the live case
            // (e.g. a future single-instance handoff where Aurora is
            // already running and the user invokes `aurora .` again).
            // The frontend bootstrap consumes the state slot exactly
            // once; live events only fire after mount, so there's no
            // double-application.
            let request = open_request.clone();
            let pending = commands::PendingCliOpenState(Mutex::new(
                if request.workspace_path.is_some() || request.file_path.is_some() {
                    Some(request.clone())
                } else {
                    None
                },
            ));
            app.manage(pending);

            if request.workspace_path.is_some() || request.file_path.is_some() {
                if let Some(win) = app.get_webview_window("main") {
                    // Best-effort live event for any listener already
                    // registered (e.g. when this proves useful for a
                    // future single-instance flow). Cold-start no
                    // longer depends on this firing in time.
                    let _ = win.emit("cli-open", &request);
                }
            }

            // Auto-grant the WebView's native microphone permission so
            // Aurora's own IDE-styled "Allow microphone access" modal
            // is the only prompt the user ever sees. Without this the
            // WebView2 (Windows) shows its own browser-style
            // "localhost:5173 wants to Use your microphones" toast on
            // top of our gate, which looks broken — see the speech
            // input modal in `src/components/chat/SpeechInputButton.tsx`
            // for the user-facing half of this contract.
            if let Some(win) = app.get_webview_window("main") {
                if let Err(err) = services::webview_permissions::install_permission_handler(&win) {
                    logging::log_error(
                        "webview.permissions",
                        &format!("failed to install webview permission handler: {err}"),
                    );
                }
                if let Err(err) = services::webview_recovery::install_crash_recovery_handler(&win) {
                    logging::log_error(
                        "webview.recovery",
                        &format!("failed to install webview crash recovery: {err}"),
                    );
                }
            }

            // Agent-only launch: build the agent window (route `/agent-window`,
            // scoped to the directory the command was run in via `?ws=`) and
            // close the auto-created IDE window so the agent window is all that
            // shows. If building it fails, re-show the IDE so the launch isn't a
            // black hole.
            if agent_mode {
                use tauri::{WebviewUrl, WebviewWindowBuilder};

                // An icon launch has no usable working directory, so its project
                // has to be remembered. This matters more than it looks: the
                // window creates every chat with its `projectRoot` as the chat's
                // `workspaceRoot`, and the left rail is a per-project tree keyed
                // on that value — a null root produces a chat that persists
                // correctly but renders nowhere.
                //
                // Resolution order, and the order is the fix:
                //   1. `--ws` / the launch directory, when there is one.
                //   2. `agent_last_workspace` — what THIS window was last used
                //      on, written by `useAgentChatStore` as you switch project.
                //   3. `workspace_state` — the IDE's table, first run only.
                //
                // Step 2 did not exist. The agent window had no memory of its
                // own, so every icon launch fell through to the IDE's most
                // recent workspace; stop opening the IDE and that row freezes,
                // stranding the agent window on a project abandoned weeks ago
                // with no way to change it that survives a restart.
                //
                // Nothing recorded anywhere (fresh install) → open unscoped,
                // which the home screen handles as its no-workspace state.
                let resolved_workspace = agent_workspace.clone().or_else(|| {
                    if !prefers_agent {
                        return None;
                    }
                    let db = app.state::<Mutex<db::Database>>();
                    let guard = db.lock().ok()?;
                    let remembered = guard
                        .settings()
                        .get_setting("agent_last_workspace")
                        .ok()
                        .flatten()
                        .map(|setting| setting.value)
                        // An empty string is how the window records "no project
                        // open"; treat it as unset rather than as a path.
                        .filter(|value| !value.trim().is_empty());
                    if let Some(value) = remembered {
                        return Some(std::path::PathBuf::from(value));
                    }
                    guard
                        .workspace()
                        .get_most_recent()
                        .ok()
                        .flatten()
                        .and_then(|state| state.workspace_path)
                        .map(std::path::PathBuf::from)
                });

                // Same shape the JS launcher produces (`agentWindowUrl` in
                // agent-window/adapters/window.ts) so both paths bind the window
                // identically. No root resolvable (e.g. the CWD was deleted out
                // from under the process) → open unscoped rather than fail.
                let agent_route = match resolved_workspace.as_ref() {
                    Some(root) => format!(
                        "agent-window?ws={}",
                        cli::encode_query_component(&root.to_string_lossy())
                    ),
                    None => "agent-window".to_string(),
                };

                // Reopen at the size the user last set. The agent window
                // persists `{width, height, maximized}` (logical px) to
                // `app_settings.agent_window_bounds` on every resize (see
                // `useAgentWindowBounds`); both launch paths — this one and
                // the JS `openAgentWindow` — read it back, clamped to the
                // window minimum. Missing / corrupt state → the defaults.
                let (mut width, mut height, mut maximized) = (1200.0_f64, 800.0_f64, false);
                let saved_bounds = app
                    .state::<Mutex<db::Database>>()
                    .lock()
                    .ok()
                    .and_then(|db| db.settings().get_setting("agent_window_bounds").ok())
                    .flatten()
                    .map(|setting| setting.value);
                if let Some(raw) = saved_bounds {
                    if let Ok(bounds) = serde_json::from_str::<serde_json::Value>(&raw) {
                        if let Some(w) = bounds.get("width").and_then(|v| v.as_f64()) {
                            width = w.max(820.0);
                        }
                        if let Some(h) = bounds.get("height").and_then(|v| v.as_f64()) {
                            height = h.max(560.0);
                        }
                        maximized = bounds
                            .get("maximized")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                    }
                }

                // Open under the name of the product it will show.
                //
                // `AgentTitlebar` titles the window from the live setting once
                // React is up, and this is the same answer one step earlier —
                // read from the same `app_settings` rows as the bounds above,
                // so the taskbar button and Alt-Tab are right from the first
                // frame instead of saying "Aurora Agent" until the frontend
                // boots. The stored value is JSON, written by
                // `save_app_settings`.
                //
                // The JS launcher (`adapters/window.ts`) deliberately does NOT
                // do this: it lives on the IDE side of the module boundary, and
                // importing the surface names would pull the agent's prompt
                // module into the IDE chunk. A window opened from the IDE is
                // brand new and its titlebar corrects it on mount.
                let agent_title = app
                    .state::<Mutex<db::Database>>()
                    .lock()
                    .ok()
                    .and_then(|db| db.settings().get_setting("auroraSurface").ok())
                    .flatten()
                    .and_then(|setting| serde_json::from_str::<String>(&setting.value).ok())
                    .filter(|surface| surface == "chat")
                    .map(|_| "Aurora Chat")
                    .unwrap_or("Aurora Build");

                match WebviewWindowBuilder::new(
                    app.handle(),
                    "agent-window",
                    WebviewUrl::App(agent_route.into()),
                )
                .title(agent_title)
                .inner_size(width, height)
                .min_inner_size(820.0, 560.0)
                .center()
                .resizable(true)
                // Frameless — the frontend renders its own themed titlebar
                // (AgentTitlebar); keep in sync with the JS `openAgentWindow`.
                .decorations(false)
                .maximized(maximized)
                .build()
                {
                    Ok(agent_win) => {
                        if let Err(err) =
                            services::webview_permissions::install_permission_handler(&agent_win)
                        {
                            logging::log_error(
                                "webview.permissions",
                                &format!(
                                    "failed to install webview permission handler (agent): {err}"
                                ),
                            );
                        }
                        if let Err(err) =
                            services::webview_recovery::install_crash_recovery_handler(&agent_win)
                        {
                            logging::log_error(
                                "webview.recovery",
                                &format!("failed to install webview crash recovery (agent): {err}"),
                            );
                        }
                        if let Some(main_win) = app.get_webview_window("main") {
                            // `agw` asked for the agent window and nothing else,
                            // so the IDE is torn down. A PREFERENCE launch is
                            // different: it is the user's only entry point, and
                            // closing `main` would strip the way back — the
                            // `agent_open_in_ide` command only works while the
                            // main window exists (it is the sole listener). Keep
                            // it hidden and ready to show instead, so choosing
                            // the agent surface is never a one-way door.
                            if prefers_agent {
                                let _ = main_win.hide();
                            } else {
                                let _ = main_win.close();
                            }
                        }
                    }
                    Err(err) => {
                        logging::log_error(
                            "agent_window",
                            &format!("failed to open agent window: {err}"),
                        );
                        if let Some(main_win) = app.get_webview_window("main") {
                            let _ = main_win.show();
                        }
                    }
                }
            }

            // ── `aurora agent` — presence, and the task inbox ────────────
            //
            // Two pieces, both cheap and both kept alive for the process's
            // lifetime by handing them to Tauri's managed state.
            //
            // The presence guard is how a CLI in another terminal knows an
            // Aurora is already up — without it every `aurora agent` would
            // launch a second copy on top of a healthy one.
            //
            // The watcher claims dispatched tasks. It sweeps once at startup
            // as well as watching, because the common case is a task written
            // *before* this process existed: `aurora agent` writes the request
            // and then launches us, so no filesystem event will ever fire for
            // the very task that caused the launch.
            // Keep `aurora` on PATH pointing at THIS build. An upgrade that
            // lands in a different directory leaves the shim aimed at a binary
            // that may no longer exist — and when it does exist, the CLI
            // silently runs the old one. Only ever re-points a shim the user
            // already installed; it never creates one.
            cli::install::refresh_cli_shim();

            // Start from "no window". The bridge file survives a restart, and a
            // previous run's "the Agent Window is open" would otherwise be true
            // again the moment this process takes the presence guard — telling
            // another agent to send work to a window that has not been opened
            // yet. The Agent Window republishes as it mounts, so this costs
            // nothing when one is on the way.
            cli_delegate::bridge::clear();

            app.manage(commands::CliPresence(cli_delegate::presence::hold()));
            app.manage(commands::CliTaskWatcher(std::sync::Mutex::new(
                cli_delegate::watcher::install(handle.clone()),
            )));

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
