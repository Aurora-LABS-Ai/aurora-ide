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
        // Future migrations go here
        // 2 => migration_v2(conn)?,
        // 3 => migration_v3(conn)?,
        _ => Err(DbError::Migration(format!(
            "Unknown migration version: {}",
            target_version
        ))),
    }
}
