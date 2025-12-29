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
    conn.execute(
        "ALTER TABLE threads ADD COLUMN token_usage TEXT",
        [],
    )?;

    // Add context_usage column to threads table
    conn.execute(
        "ALTER TABLE threads ADD COLUMN context_usage TEXT",
        [],
    )?;

    Ok(())
}
