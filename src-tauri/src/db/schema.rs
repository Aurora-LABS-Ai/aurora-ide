use rusqlite::Connection;

use crate::db::error::DbResult;

/// Database schema version
pub const SCHEMA_VERSION: i32 = 15;

/// Initialize database schema
pub fn initialize_schema(conn: &Connection) -> DbResult<()> {
    // Set schema version
    set_schema_version(conn, SCHEMA_VERSION)?;

    // Create tables. The `threads` table is intentionally absent — chat
    // history now lives as JSONL message logs (plus a tiny metadata
    // sidecar) under `<app_data>/agent_v2/`. See
    // `crate::agent_runtime::session_store::SessionStore`.
    create_workspace_state_table(conn)?;
    create_editor_state_table(conn)?;
    create_explorer_state_table(conn)?;
    create_app_settings_table(conn)?;
    create_llm_providers_table(conn)?;
    create_provider_models_table(conn)?;
    create_tool_settings_table(conn)?;
    create_custom_themes_table(conn)?;
    create_checkpoints_table(conn)?;

    Ok(())
}

/// Get current schema version
pub fn get_schema_version(conn: &Connection) -> DbResult<i32> {
    // First check if schema_version table exists
    let table_exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version')",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);

    if !table_exists {
        return Ok(0);
    }

    match conn.query_row("SELECT version FROM schema_version LIMIT 1", [], |row| {
        row.get(0)
    }) {
        Ok(version) => Ok(version),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(0),
        Err(e) => Err(crate::db::error::DbError::Sqlite(e)),
    }
}

/// Set schema version
fn set_schema_version(conn: &Connection, version: i32) -> DbResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY
        )",
        [],
    )?;

    conn.execute("DELETE FROM schema_version", [])?;
    conn.execute(
        "INSERT INTO schema_version (version) VALUES (?1)",
        [version],
    )?;

    Ok(())
}

// ============================================================
// TABLE DEFINITIONS
// ============================================================

/// Create workspace_state table
fn create_workspace_state_table(conn: &Connection) -> DbResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS workspace_state (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            workspace_path TEXT,
            open_tabs TEXT NOT NULL, -- JSON array of TabState
            panel_sizes TEXT,        -- JSON of PanelSizes
            last_opened_at TEXT NOT NULL,
            checkpoint_enabled INTEGER NOT NULL DEFAULT 1, -- 1 = enabled (default), 0 = disabled
            UNIQUE(workspace_path)
        )",
        [],
    )?;

    // Create index for quick lookup
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_workspace_path
         ON workspace_state (workspace_path)",
        [],
    )?;

    Ok(())
}

/// Create editor_state table
fn create_editor_state_table(conn: &Connection) -> DbResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS editor_state (
            file_path TEXT PRIMARY KEY,
            cursor_line INTEGER,
            cursor_col INTEGER,
            scroll_offset REAL,
            folded_regions TEXT,      -- JSON array of FoldedRegion
            last_edited_at TEXT NOT NULL
        )",
        [],
    )?;

    Ok(())
}

/// Create explorer_state table
fn create_explorer_state_table(conn: &Connection) -> DbResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS explorer_state (
            workspace_path TEXT PRIMARY KEY,
            expanded_folders TEXT NOT NULL, -- JSON array of folder paths
            selected_file TEXT
        )",
        [],
    )?;

    Ok(())
}

/// Create app_settings table (key-value store for general settings)
fn create_app_settings_table(conn: &Connection) -> DbResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;

    Ok(())
}

/// Create llm_providers table (LLM provider configurations)
///
/// As of schema v15 the table holds **transport + auth + defaults
/// only**. Per-model capabilities (vision, thinking, tool-stream) and
/// per-model context/output overrides live in `provider_models` (see
/// [`create_provider_models_table`]). The legacy columns
/// `supports_thinking`, `supports_vision`, `custom_models`, and
/// `model_aliases` are no longer read; the v15 migration moves their
/// data into `provider_models`. We keep `model` as the **selected**
/// model id for backward-compat reads — the source of truth for which
/// model is active is still `app_settings.selectedModel`.
fn create_llm_providers_table(conn: &Connection) -> DbResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS llm_providers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            nickname TEXT,
            base_url TEXT NOT NULL,
            api_key TEXT NOT NULL DEFAULT '',
            model TEXT NOT NULL,
            context_window INTEGER NOT NULL DEFAULT 128000,
            max_output_tokens INTEGER NOT NULL DEFAULT 16384,
            supports_tool_stream INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            is_custom INTEGER NOT NULL DEFAULT 0,
            custom_headers TEXT,          -- JSON object
            custom_params TEXT,           -- JSON object
            provider_type TEXT,           -- 'openai' | 'deepseek' | 'glm' | 'anthropic' | 'custom'
            default_temperature REAL,
            default_max_tokens INTEGER,
            requires_api_key INTEGER NOT NULL DEFAULT 1,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;

    // Create index for sorting
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_llm_providers_sort
         ON llm_providers (sort_order ASC)",
        [],
    )?;

    Ok(())
}

/// Create provider_models table (per-model capability profile under a provider).
///
/// One row per model exposed by a provider. Capabilities (vision,
/// thinking, tool-stream) are always per-model — the same OpenAI key
/// can address GPT-4o-mini (no vision) and GPT-4o (vision) and they
/// must not share a single flag. Context window and max-output are
/// nullable: NULL means "inherit the provider's default", a non-null
/// value overrides it.
fn create_provider_models_table(conn: &Connection) -> DbResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS provider_models (
            id TEXT PRIMARY KEY,                     -- '{providerId}::{modelKey}'
            provider_id TEXT NOT NULL,               -- FK -> llm_providers.id
            model_key TEXT NOT NULL,                 -- the API model identifier
            label TEXT,                              -- display name override (alias)
            context_window INTEGER,                  -- NULL → inherit from provider
            max_output_tokens INTEGER,               -- NULL → inherit from provider
            supports_vision INTEGER NOT NULL DEFAULT 0,
            supports_thinking INTEGER NOT NULL DEFAULT 0,
            supports_tool_stream INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(provider_id, model_key),
            FOREIGN KEY (provider_id) REFERENCES llm_providers(id) ON DELETE CASCADE
        )",
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_provider_models_provider
         ON provider_models (provider_id, sort_order ASC)",
        [],
    )?;

    Ok(())
}

/// Create tool_settings table (per-tool approval settings)
fn create_tool_settings_table(conn: &Connection) -> DbResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS tool_settings (
            tool_name TEXT PRIMARY KEY,
            approval_mode TEXT NOT NULL DEFAULT 'always_ask', -- 'auto' | 'always_ask' | 'deny'
            updated_at TEXT NOT NULL
        )",
        [],
    )?;

    Ok(())
}

/// Create custom_themes table
fn create_custom_themes_table(conn: &Connection) -> DbResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS custom_themes (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            author TEXT NOT NULL,
            version TEXT NOT NULL,
            type TEXT NOT NULL,     -- 'dark' or 'light'
            colors TEXT NOT NULL,   -- JSON object
            token_colors TEXT NOT NULL, -- JSON array
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(name COLLATE NOCASE, author COLLATE NOCASE)
        )",
        [],
    )?;

    // Create index for sorting
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_custom_themes_updated_at
         ON custom_themes (updated_at DESC)",
        [],
    )?;

    // Create unique index for name+author (case insensitive)
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_themes_name_author
         ON custom_themes (name COLLATE NOCASE, author COLLATE NOCASE)",
        [],
    )?;

    Ok(())
}

/// Create checkpoints table (tracks file state checkpoints per message)
fn create_checkpoints_table(conn: &Connection) -> DbResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS checkpoints (
            id TEXT PRIMARY KEY,              -- Git commit hash
            message_id TEXT NOT NULL,         -- Associated message ID
            thread_id TEXT NOT NULL,          -- Thread this checkpoint belongs to
            workspace_path TEXT NOT NULL,     -- Workspace path
            created_at TEXT NOT NULL,
            UNIQUE(thread_id, message_id)
        )",
        [],
    )?;

    // Create indexes for quick lookup
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_checkpoints_thread_id
         ON checkpoints (thread_id)",
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_checkpoints_message_id
         ON checkpoints (message_id)",
        [],
    )?;

    Ok(())
}
