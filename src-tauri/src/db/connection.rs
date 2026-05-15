use std::path::PathBuf;

use rusqlite::Connection;

use crate::db::error::DbResult;
use crate::paths;

/// Database connection manager
pub struct DbConnection {
    conn: Connection,
}

impl DbConnection {
    /// Create a new database connection.
    ///
    /// The database file lives under the single AuroraIDE root:
    ///   `<AuroraIDE>/data/aurora.db`
    /// (see `crate::paths` for the per-platform root resolution).
    pub fn new(_app: &tauri::AppHandle) -> DbResult<Self> {
        let db_path = get_db_path(_app)?;
        // `paths::data_dir()` already ensures the parent exists, but be
        // defensive — a stale `<root>/data/` deletion shouldn't crash boot.
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let conn = Connection::open(&db_path)?;

        // Enable foreign keys and set performance optimizations
        // Using execute_batch because PRAGMA statements can return results
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA cache_size = -64000;
             PRAGMA temp_store = MEMORY;",
        )?;

        Ok(Self { conn })
    }

    /// Get the underlying SQLite connection
    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    /// Get the database path for the app.
    ///
    /// The `_app` handle is unused — the AuroraIDE root is resolved
    /// from the OS, not from Tauri's bundle-identifier-scoped paths.
    /// Kept on the signature so callers don't need to change.
    pub fn get_db_path(_app: &tauri::AppHandle) -> DbResult<PathBuf> {
        Ok(paths::db_file())
    }
}

fn get_db_path(app: &tauri::AppHandle) -> DbResult<PathBuf> {
    DbConnection::get_db_path(app)
}
