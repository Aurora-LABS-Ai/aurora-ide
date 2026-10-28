//! Subscription and account providers: sign-in state, accounts, plan usage
//! and model lists for Claude Code, Codex, Cursor, Antigravity, Command Code,
//! OpenCode Go and Modal, plus the balance/quota reads of DeepSeek, kenari and
//! MiniMax. The bodies are each provider's `commands` module under
//! [`crate::api`], which the window registers directly (Cursor through
//! `commands/cursor.rs`, for its database).
//!
//! Not here: the three browser sign-ins that open a page on this machine
//! (`codex_auth_login`, `antigravity_auth_login`, `commandcode_auth_login`,
//! see `WINDOW_ONLY`). Claude Code's sign-in is a pasted code, so it is.

use serde_json::Value;

use super::{arg, done, CommandContext, CommandError};
use crate::api::{
    antigravity::commands as antigravity, claude_code::commands as claude_code,
    codex::commands as codex, commandcode::commands as commandcode, cursor::commands as cursor,
    deepseek_balance, kenari::commands as kenari, minimax::commands as minimax, modal, opencode,
};

pub const COMMANDS: &[&str] = &[
    "claude_code_auth_status",
    "claude_code_auth_begin",
    "claude_code_auth_complete",
    "claude_code_auth_cancel",
    "claude_code_auth_logout",
    "claude_code_usage_get",
    "claude_code_accounts_list",
    "claude_code_account_set_main",
    "claude_code_account_remove",
    "claude_code_account_import_cli",
    "codex_auth_status",
    "codex_auth_cancel_login",
    "codex_auth_logout",
    "codex_usage_get",
    "codex_accounts_list",
    "codex_account_set_main",
    "codex_account_remove",
    "codex_account_clear_limit",
    "codex_account_import_cli",
    "cursor_auth_status",
    "cursor_usage_get",
    "cursor_auth_connect",
    "cursor_auth_sign_out",
    "cursor_models_list",
    "cursor_models_list_enabled",
    "cursor_models_refresh",
    "cursor_model_set_enabled",
    "cursor_models_set_enabled_bulk",
    "cursor_state_db_path",
    "antigravity_auth_status",
    "antigravity_auth_cancel_login",
    "antigravity_auth_logout",
    "antigravity_accounts_list",
    "antigravity_quota_get",
    "antigravity_models_list",
    "antigravity_account_set_main",
    "antigravity_account_remove",
    "antigravity_account_import_ide",
    "commandcode_auth_status",
    "commandcode_auth_cancel_login",
    "commandcode_auth_logout",
    "commandcode_auth_store_key",
    "commandcode_usage_get",
    "commandcode_list_models",
    "opencode_local_key",
    "opencode_auth_path",
    "opencode_models",
    "opencode_usage",
    "modal_workspace_models",
    "modal_cli_status",
    "modal_workspaces",
    "modal_use_workspace",
    "modal_save_workspace",
    "modal_forget_workspace",
    "modal_cli_create_proxy_token",
    "modal_cli_sign_in",
    "modal_cli_billing_summary",
    "deepseek_balance_get",
    "kenari_usage",
    "minimax_usage_get",
];

/// Run `name` if it is one of these; `None` hands it on.
pub(super) async fn dispatch(
    ctx: &CommandContext,
    name: &str,
    args: &Value,
) -> Option<Result<Value, CommandError>> {
    let n = name;
    macro_rules! get {
        ($key:literal) => {
            match arg(n, args, $key) {
                Ok(v) => v,
                Err(e) => return Some(Err(e)),
            }
        };
    }
    let db = ctx.db.clone();
    Some(match name {
        // Claude Code
        "claude_code_auth_status" => done(claude_code::claude_code_auth_status().await),
        "claude_code_auth_begin" => done(claude_code::claude_code_auth_begin().await),
        "claude_code_auth_complete" => {
            done(claude_code::claude_code_auth_complete(get!("input")).await)
        }
        "claude_code_auth_cancel" => done(claude_code::claude_code_auth_cancel().await),
        "claude_code_auth_logout" => done(claude_code::claude_code_auth_logout().await),
        "claude_code_usage_get" => done(claude_code::claude_code_usage_get(get!("force")).await),
        "claude_code_accounts_list" => done(claude_code::claude_code_accounts_list().await),
        "claude_code_account_set_main" => {
            done(claude_code::claude_code_account_set_main(get!("id")).await)
        }
        "claude_code_account_remove" => done(claude_code::claude_code_account_remove(get!("id")).await),
        "claude_code_account_import_cli" => done(claude_code::claude_code_account_import_cli().await),

        // Codex
        "codex_auth_status" => done(codex::codex_auth_status().await),
        "codex_auth_cancel_login" => done(codex::codex_auth_cancel_login().await),
        "codex_auth_logout" => done(codex::codex_auth_logout().await),
        "codex_usage_get" => done(codex::codex_usage_get().await),
        "codex_accounts_list" => done(codex::codex_accounts_list().await),
        "codex_account_set_main" => done(codex::codex_account_set_main(get!("accountId")).await),
        "codex_account_remove" => done(codex::codex_account_remove(get!("accountId")).await),
        "codex_account_clear_limit" => {
            done(codex::codex_account_clear_limit(get!("accountId")).await)
        }
        "codex_account_import_cli" => done(codex::codex_account_import_cli().await),

        // Cursor
        "cursor_auth_status" => done(cursor::auth_status().await),
        "cursor_usage_get" => done(cursor::usage_get().await),
        "cursor_auth_connect" => done(cursor::auth_connect().await),
        "cursor_auth_sign_out" => done(cursor::auth_sign_out(db).await),
        "cursor_models_list" => done(cursor::models_list(db).await),
        "cursor_models_list_enabled" => done(cursor::models_list_enabled(db).await),
        "cursor_models_refresh" => done(cursor::models_refresh(db).await),
        "cursor_model_set_enabled" => {
            let model_id: String = get!("modelId");
            let enabled: bool = get!("enabled");
            done(cursor::model_set_enabled(db, model_id, enabled).await)
        }
        "cursor_models_set_enabled_bulk" => {
            let model_ids: Vec<String> = get!("modelIds");
            let enabled: bool = get!("enabled");
            done(cursor::models_set_enabled_bulk(db, model_ids, enabled).await)
        }
        "cursor_state_db_path" => done(cursor::state_db_path().await),

        // Antigravity
        "antigravity_auth_status" => done(antigravity::antigravity_auth_status().await),
        "antigravity_auth_cancel_login" => done(antigravity::antigravity_auth_cancel_login().await),
        "antigravity_auth_logout" => done(antigravity::antigravity_auth_logout().await),
        "antigravity_accounts_list" => done(antigravity::antigravity_accounts_list().await),
        "antigravity_quota_get" => done(antigravity::antigravity_quota_get().await),
        "antigravity_models_list" => done(antigravity::antigravity_models_list().await),
        "antigravity_account_set_main" => {
            done(antigravity::antigravity_account_set_main(get!("id")).await)
        }
        "antigravity_account_remove" => done(antigravity::antigravity_account_remove(get!("id")).await),
        "antigravity_account_import_ide" => done(antigravity::antigravity_account_import_ide().await),

        // Command Code
        "commandcode_auth_status" => done(commandcode::commandcode_auth_status().await),
        "commandcode_auth_cancel_login" => done(commandcode::commandcode_auth_cancel_login().await),
        "commandcode_auth_logout" => done(commandcode::commandcode_auth_logout().await),
        "commandcode_auth_store_key" => {
            done(commandcode::commandcode_auth_store_key(get!("apiKey")).await)
        }
        "commandcode_usage_get" => done(commandcode::commandcode_usage_get(get!("apiKey")).await),
        "commandcode_list_models" => {
            done(commandcode::commandcode_list_models(get!("apiKey")).await)
        }

        // OpenCode Go
        "opencode_local_key" => done(opencode::opencode_local_key().await),
        "opencode_auth_path" => done(opencode::opencode_auth_path().await),
        "opencode_models" => done(opencode::opencode_models().await),
        "opencode_usage" => done(opencode::opencode_usage(get!("apiKey")).await),

        // Modal
        "modal_workspace_models" => {
            let base_url: String = get!("baseUrl");
            let token: String = get!("token");
            done(modal::modal_workspace_models(base_url, token).await)
        }
        "modal_cli_status" => done(Ok(modal::modal_cli_status(get!("refresh")).await)),
        "modal_workspaces" => done(Ok(modal::modal_workspaces().await)),
        "modal_use_workspace" => done(modal::modal_use_workspace(get!("workspace")).await),
        "modal_save_workspace" => {
            let workspace: String = get!("workspace");
            let token: String = get!("token");
            let region: String = get!("region");
            let models: Value = get!("models");
            done(modal::modal_save_workspace(workspace, token, region, models).await)
        }
        "modal_forget_workspace" => done(modal::modal_forget_workspace(get!("workspace")).await),
        "modal_cli_create_proxy_token" => {
            done(modal::modal_cli_create_proxy_token(get!("profile")).await)
        }
        "modal_cli_sign_in" => done(modal::modal_cli_sign_in().await),
        "modal_cli_billing_summary" => {
            let profile: String = get!("profile");
            let cycle: Option<String> = get!("cycle");
            let refresh: Option<bool> = get!("refresh");
            done(modal::modal_cli_billing_summary(profile, cycle, refresh).await)
        }

        // Balance and quota reads
        "deepseek_balance_get" => {
            let api_key: String = get!("apiKey");
            let base_url: Option<String> = get!("baseUrl");
            done(deepseek_balance::deepseek_balance_get(api_key, base_url).await)
        }
        "kenari_usage" => done(kenari::kenari_usage(get!("apiKey")).await),
        "minimax_usage_get" => done(minimax::minimax_usage_get(get!("apiKey")).await),
        _ => return None,
    })
}
