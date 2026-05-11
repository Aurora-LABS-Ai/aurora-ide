use rusqlite::Connection;

use crate::db::error::{DbError, DbResult};
use crate::db::schema::{get_schema_version, initialize_schema, SCHEMA_VERSION};

/// Run pending migrations
pub fn run_migrations(conn: &Connection) -> DbResult<()> {
    let current_version = get_schema_version(conn)?;

    // If no version, initialize schema
    if current_version == 0 {
        initialize_schema(conn)?;
        return Ok(());
    }

    // Run migrations based on current version
    match current_version {
        SCHEMA_VERSION => Ok(()), // Already up to date
        v if v < SCHEMA_VERSION => {
            // Run migrations in sequence
            for version in v..SCHEMA_VERSION {
                run_migration(conn, version + 1)?;
            }
            Ok(())
        }
        v => Err(DbError::Migration(format!(
            "Database version {} is newer than application version {}",
            v, SCHEMA_VERSION
        ))),
    }
}

/// Run a single migration
fn run_migration(conn: &Connection, target_version: i32) -> DbResult<()> {
    match target_version {
        1 => {
            // Initial schema (handled by initialize_schema)
            initialize_schema(conn)?;
            Ok(())
        }
        2 => {
            // Migration from v1 to v2: Add settings tables
            migration_v2(conn)?;
            // Update schema version
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [2])?;
            Ok(())
        }
        3 => {
            // Migration from v2 to v3: Add token/context usage to threads
            migration_v3(conn)?;
            // Update schema version
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [3])?;
            Ok(())
        }
        4 => {
            // Migration from v3 to v4: Add custom_themes table
            migration_v4(conn)?;
            // Update schema version
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [4])?;
            Ok(())
        }
        5 => {
            // Migration from v4 to v5: Add unique constraint on themes and cleanup duplicates
            migration_v5(conn)?;
            // Update schema version
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [5])?;
            Ok(())
        }
        6 => {
            // Migration from v5 to v6: Add semantic search tables
            migration_v6(conn)?;
            // Update schema version
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [6])?;
            Ok(())
        }
        7 => {
            // Migration from v6 to v7: Add excluded_files and excluded_directories columns to semantic_settings
            migration_v7(conn)?;
            // Update schema version
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [7])?;
            Ok(())
        }
        8 => {
            // Migration from v7 to v8: Add workspace-specific exclusions to semantic_indexes
            migration_v8(conn)?;
            // Update schema version
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [8])?;
            Ok(())
        }
        9 => {
            // Migration from v8 to v9: Cleanup NULL workspace_path entries
            migration_v9(conn)?;
            // Update schema version
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [9])?;
            Ok(())
        }
        10 => {
            // Migration from v9 to v10: Add checkpoints table
            migration_v10(conn)?;
            // Update schema version
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [10])?;
            Ok(())
        }
        11 => {
            // Migration from v10 to v11: Add provider nicknames and model aliases
            migration_v11(conn)?;
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [11])?;
            Ok(())
        }
        12 => {
            // Migration from v11 to v12: Drop the legacy semantic search tables.
            // Aurora no longer ships a semantic indexer; reclaim the storage and
            // make sure stale rows can never be served back to the frontend.
            migration_v12(conn)?;
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [12])?;
            Ok(())
        }
        13 => {
            // Migration from v12 to v13: Drop the legacy `threads` table.
            //
            // Conversations are now stored as append-only JSONL message
            // logs under `<app_data>/agent_v2/{thread_id}.jsonl` with a
            // metadata sidecar at `<thread_id>.meta.json` (see
            // `crate::agent_runtime::session_store::SessionStore`). No
            // data is migrated — per product direction this is a clean
            // break for the v1 release.
            migration_v13(conn)?;
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [13])?;
            Ok(())
        }
        _ => Err(DbError::Migration(format!(
            "Unknown migration version: {}",
            target_version
        ))),
    }
}

/// Migration v2: Add app_settings, llm_providers, and tool_settings tables
fn migration_v2(conn: &Connection) -> DbResult<()> {
    // Create app_settings table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;

    // Create llm_providers table
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
            supports_thinking INTEGER NOT NULL DEFAULT 0,
            supports_tool_stream INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            is_custom INTEGER NOT NULL DEFAULT 0,
            custom_models TEXT,
            model_aliases TEXT,
            custom_headers TEXT,
            custom_params TEXT,
            provider_type TEXT,
            default_temperature REAL,
            default_max_tokens INTEGER,
            requires_api_key INTEGER NOT NULL DEFAULT 1,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;

    // Create index for sorting providers
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_llm_providers_sort
         ON llm_providers (sort_order ASC)",
        [],
    )?;

    // Create tool_settings table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS tool_settings (
            tool_name TEXT PRIMARY KEY,
            approval_mode TEXT NOT NULL DEFAULT 'always_ask',
            updated_at TEXT NOT NULL
        )",
        [],
    )?;

    // Drop old settings table if exists (it was a placeholder)
    conn.execute("DROP TABLE IF EXISTS settings", [])?;

    Ok(())
}

/// Migration v3: Add token_usage and context_usage columns to threads table
fn migration_v3(conn: &Connection) -> DbResult<()> {
    // Add token_usage column to threads table
    conn.execute("ALTER TABLE threads ADD COLUMN token_usage TEXT", [])?;

    // Add context_usage column to threads table
    conn.execute("ALTER TABLE threads ADD COLUMN context_usage TEXT", [])?;

    Ok(())
}

/// Migration v4: Add custom_themes table
fn migration_v4(conn: &Connection) -> DbResult<()> {
    // Create custom_themes table
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
            updated_at TEXT NOT NULL
        )",
        [],
    )?;

    // Create index for sorting
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_custom_themes_updated_at
         ON custom_themes (updated_at DESC)",
        [],
    )?;

    Ok(())
}

/// Migration v5: Cleanup duplicate themes and add unique constraint
fn migration_v5(conn: &Connection) -> DbResult<()> {
    // Step 1: Delete all duplicate themes, keeping only the most recently updated one per name+author
    conn.execute(
        "DELETE FROM custom_themes 
         WHERE id NOT IN (
            SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (
                    PARTITION BY LOWER(TRIM(name)), LOWER(TRIM(author)) 
                    ORDER BY updated_at DESC
                ) as rn
                FROM custom_themes
            ) WHERE rn = 1
         )",
        [],
    )?;

    // Step 2: Create unique index on name+author (case insensitive)
    // This will prevent future duplicates at the database level
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_themes_name_author
         ON custom_themes (LOWER(TRIM(name)), LOWER(TRIM(author)))",
        [],
    )?;

    Ok(())
}

/// Migration v6: Add semantic search tables
fn migration_v6(conn: &Connection) -> DbResult<()> {
    // Create semantic_indexes table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS semantic_indexes (
            id TEXT PRIMARY KEY,
            workspace_path TEXT NOT NULL UNIQUE,
            workspace_name TEXT NOT NULL,
            document_count INTEGER NOT NULL DEFAULT 0,
            chunk_count INTEGER NOT NULL DEFAULT 0,
            total_bytes INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending',
            error_message TEXT,
            last_indexed_at TEXT,
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

    // Create semantic_settings table (single row)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS semantic_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            model_path TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            auto_index INTEGER NOT NULL DEFAULT 0,
            auto_reindex_interval INTEGER,
            ignored_patterns TEXT,
            ignored_directories TEXT,
            max_file_size INTEGER NOT NULL DEFAULT 1048576,
            search_mode TEXT NOT NULL DEFAULT 'hybrid',
            lexical_weight REAL NOT NULL DEFAULT 0.4,
            semantic_weight REAL NOT NULL DEFAULT 0.6,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;

    // Insert default settings row
    conn.execute(
        "INSERT OR IGNORE INTO semantic_settings (id, updated_at) VALUES (1, datetime('now'))",
        [],
    )?;

    Ok(())
}

/// Migration v7: Add excluded_files and excluded_directories columns to semantic_settings
fn migration_v7(conn: &Connection) -> DbResult<()> {
    // Add excluded_files column (specific file paths to exclude)
    conn.execute(
        "ALTER TABLE semantic_settings ADD COLUMN excluded_files TEXT DEFAULT '[]'",
        [],
    )?;

    // Add excluded_directories column (specific directory paths to exclude)
    conn.execute(
        "ALTER TABLE semantic_settings ADD COLUMN excluded_directories TEXT DEFAULT '[]'",
        [],
    )?;

    Ok(())
}

/// Migration v8: Add workspace-specific exclusions to semantic_indexes table
fn migration_v8(conn: &Connection) -> DbResult<()> {
    // Add excluded_files column to semantic_indexes (workspace-specific)
    conn.execute(
        "ALTER TABLE semantic_indexes ADD COLUMN excluded_files TEXT DEFAULT '[]'",
        [],
    )?;

    // Add excluded_directories column to semantic_indexes (workspace-specific)
    conn.execute(
        "ALTER TABLE semantic_indexes ADD COLUMN excluded_directories TEXT DEFAULT '[]'",
        [],
    )?;

    Ok(())
}

/// Migration v9: Cleanup NULL workspace_path entries in workspace_state table
/// These were incorrectly saved when no workspace was open, corrupting the "most recent" query
fn migration_v9(conn: &Connection) -> DbResult<()> {
    // Delete all workspace_state entries where workspace_path is NULL
    conn.execute(
        "DELETE FROM workspace_state WHERE workspace_path IS NULL",
        [],
    )?;

    Ok(())
}

/// Migration v10: Add checkpoints table and checkpoint_enabled to workspace_state
fn migration_v10(conn: &Connection) -> DbResult<()> {
    // Create checkpoints table
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

    // Add checkpoint_enabled column to workspace_state (default true = enabled)
    conn.execute(
        "ALTER TABLE workspace_state ADD COLUMN checkpoint_enabled INTEGER NOT NULL DEFAULT 1",
        [],
    )?;

    Ok(())
}

/// Migration v11: Add provider nicknames and model alias metadata
fn migration_v11(conn: &Connection) -> DbResult<()> {
    conn.execute("ALTER TABLE llm_providers ADD COLUMN nickname TEXT", [])?;

    conn.execute(
        "ALTER TABLE llm_providers ADD COLUMN model_aliases TEXT",
        [],
    )?;

    Ok(())
}

/// Migration v12: Drop legacy semantic search tables.
///
/// The semantic indexer was removed in 2026; this clears the storage and the
/// supporting indexes so a stale row can never leak back into the frontend.
fn migration_v12(conn: &Connection) -> DbResult<()> {
    conn.execute(
        "DROP INDEX IF EXISTS idx_semantic_indexes_workspace_path",
        [],
    )?;
    conn.execute("DROP TABLE IF EXISTS semantic_indexes", [])?;
    conn.execute("DROP TABLE IF EXISTS semantic_settings", [])?;
    Ok(())
}

/// Migration v13: Drop the legacy `threads` table.
///
/// Aurora's chat persistence moved to append-only JSONL message logs
/// under `<app_data>/agent_v2/` (see
/// `crate::agent_runtime::session_store::SessionStore`). The migration
/// is destructive — by product direction we are not back-filling old
/// SQLite rows into the new store. Reclaim the storage and the
/// supporting indexes.
fn migration_v13(conn: &Connection) -> DbResult<()> {
    conn.execute("DROP INDEX IF EXISTS idx_threads_created_at", [])?;
    conn.execute("DROP INDEX IF EXISTS idx_threads_updated_at", [])?;
    conn.execute("DROP TABLE IF EXISTS threads", [])?;
    Ok(())
}
