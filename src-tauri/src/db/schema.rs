use rusqlite::Connection;

use crate::db::error::DbResult;

/// Database schema version
pub const SCHEMA_VERSION: i32 = 9;

/// Initialize database schema
pub fn initialize_schema(conn: &Connection) -> DbResult<()> {
    // Set schema version
    set_schema_version(conn, SCHEMA_VERSION)?;

    // Create tables
    create_workspace_state_table(conn)?;
    create_editor_state_table(conn)?;
    create_explorer_state_table(conn)?;
    create_threads_table(conn)?;
    create_app_settings_table(conn)?;
    create_llm_providers_table(conn)?;
    create_tool_settings_table(conn)?;
    create_custom_themes_table(conn)?;
    create_semantic_indexes_table(conn)?;
    create_semantic_settings_table(conn)?;

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

    match conn.query_row(
        "SELECT version FROM schema_version LIMIT 1",
        [],
        |row| row.get(0),
    ) {
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
    conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [version])?;

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

/// Create threads table
fn create_threads_table(conn: &Connection) -> DbResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS threads (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            summary TEXT,
            messages TEXT NOT NULL,    -- JSON array of Message
            token_usage TEXT,          -- JSON: {promptTokens, completionTokens, totalTokens}
            context_usage TEXT,        -- JSON: {usedTokens, contextWindow, percentage}
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;

    // Create indexes for sorting
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_threads_created_at
         ON threads (created_at DESC)",
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_threads_updated_at
         ON threads (updated_at DESC)",
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
fn create_llm_providers_table(conn: &Connection) -> DbResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS llm_providers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            base_url TEXT NOT NULL,
            api_key TEXT NOT NULL DEFAULT '',
            model TEXT NOT NULL,
            context_window INTEGER NOT NULL DEFAULT 128000,
            max_output_tokens INTEGER NOT NULL DEFAULT 16384,
            supports_thinking INTEGER NOT NULL DEFAULT 0,
            supports_tool_stream INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            is_custom INTEGER NOT NULL DEFAULT 0,
            custom_models TEXT,           -- JSON array of model names
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

/// Create semantic_indexes table (tracks indexed workspaces)
fn create_semantic_indexes_table(conn: &Connection) -> DbResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS semantic_indexes (
            id TEXT PRIMARY KEY,
            workspace_path TEXT NOT NULL UNIQUE,
            workspace_name TEXT NOT NULL,
            document_count INTEGER NOT NULL DEFAULT 0,
            chunk_count INTEGER NOT NULL DEFAULT 0,
            total_bytes INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'indexing' | 'ready' | 'error'
            error_message TEXT,
            last_indexed_at TEXT,
            excluded_files TEXT DEFAULT '[]',       -- JSON array of specific file paths to exclude (workspace-specific)
            excluded_directories TEXT DEFAULT '[]', -- JSON array of specific directory paths to exclude (workspace-specific)
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;

    // Create index for workspace path lookup
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_semantic_indexes_workspace_path
         ON semantic_indexes (workspace_path)",
        [],
    )?;

    Ok(())
}

/// Create semantic_settings table (global semantic search settings)
fn create_semantic_settings_table(conn: &Connection) -> DbResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS semantic_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1), -- Single row table
            model_path TEXT,                       -- Path to ONNX model directory
            enabled INTEGER NOT NULL DEFAULT 1,
            auto_index INTEGER NOT NULL DEFAULT 0, -- Auto-index on workspace open
            auto_reindex_interval INTEGER,         -- Auto-reindex interval in minutes (null = disabled)
            ignored_patterns TEXT,                 -- JSON array of glob patterns
            ignored_directories TEXT,              -- JSON array of directory names (matched anywhere)
            excluded_files TEXT,                   -- JSON array of specific file paths to exclude
            excluded_directories TEXT,             -- JSON array of specific directory paths to exclude
            max_file_size INTEGER NOT NULL DEFAULT 1048576, -- Max file size in bytes (1MB default)
            search_mode TEXT NOT NULL DEFAULT 'hybrid', -- 'lexical' | 'semantic' | 'hybrid'
            lexical_weight REAL NOT NULL DEFAULT 0.4,
            semantic_weight REAL NOT NULL DEFAULT 0.6,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;

    // Insert default settings row if not exists - with proper ignore lists
    let default_patterns = r#"["*.min.js","*.min.css","*.map","*.lock","package-lock.json","pnpm-lock.yaml","yarn.lock","Cargo.lock","*.exe","*.dll","*.so","*.dylib","*.wasm","*.png","*.jpg","*.jpeg","*.gif","*.ico","*.svg","*.webp","*.mp3","*.mp4","*.avi","*.mov","*.woff","*.woff2","*.ttf","*.eot","*.otf","*.zip","*.tar","*.gz","*.rar","*.7z","*.pdf","*.db","*.sqlite","*.sqlite3"]"#;
    let default_dirs = r#"["node_modules",".npm",".pnpm",".yarn",".git",".svn",".hg","dist","build","out","output",".output","target","__pycache__",".venv","venv",".env",".pytest_cache",".mypy_cache",".tox",".gradle",".m2","bin","obj","packages",".next",".nuxt",".svelte-kit",".vercel",".netlify",".idea",".vscode",".vs",".cursor",".cache",".parcel-cache",".turbo","coverage",".nyc_output","logs","vendor",".aurora"]"#;
    
    conn.execute(
        "INSERT OR IGNORE INTO semantic_settings (id, ignored_patterns, ignored_directories, excluded_files, excluded_directories, updated_at) 
         VALUES (1, ?1, ?2, '[]', '[]', datetime('now'))",
        [default_patterns, default_dirs],
    )?;

    Ok(())
}
