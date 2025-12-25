use rusqlite::Connection;

use crate::db::error::DbResult;

/// Database schema version
pub const SCHEMA_VERSION: i32 = 1;

/// Initialize database schema
pub fn initialize_schema(conn: &Connection) -> DbResult<()> {
    // Set schema version
    set_schema_version(conn, SCHEMA_VERSION)?;

    // Create tables
    create_workspace_state_table(conn)?;
    create_editor_state_table(conn)?;
    create_explorer_state_table(conn)?;
    create_threads_table(conn)?;
    create_settings_table(conn)?;

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

/// Create settings table
fn create_settings_table(conn: &Connection) -> DbResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL, -- JSON value
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;

    Ok(())
}
