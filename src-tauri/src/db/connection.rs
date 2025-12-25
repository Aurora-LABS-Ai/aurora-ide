use std::path::PathBuf;

use rusqlite::Connection;
use tauri::Manager;

use crate::db::error::{DbError, DbResult};

/// Database connection manager
pub struct DbConnection {
    conn: Connection,
}

impl DbConnection {
    /// Create a new database connection
    ///
    /// The database file is stored in the app's data directory:
    /// - Windows: %APPDATA%\com.aurora.agent\aurora.db
    /// - macOS: ~/Library/Application Support/com.aurora.agent/aurora.db
    /// - Linux: ~/.config/com.aurora.agent/aurora.db
    pub fn new(app: &tauri::AppHandle) -> DbResult<Self> {
        let db_path = get_db_path(app)?;
        let parent_dir = db_path
            .parent()
            .ok_or_else(|| DbError::Migration("Invalid database path".to_string()))?;

        // Create parent directory if it doesn't exist
        std::fs::create_dir_all(parent_dir)?;

        let conn = Connection::open(&db_path)?;

        // Enable foreign keys and set performance optimizations
        // Using execute_batch because PRAGMA statements can return results
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA cache_size = -64000;
             PRAGMA temp_store = MEMORY;"
        )?;

        Ok(Self { conn })
    }

    /// Get the underlying SQLite connection
    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    /// Get the database path for the app
    pub fn get_db_path(app: &tauri::AppHandle) -> DbResult<PathBuf> {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| DbError::Migration(format!("Failed to get app data dir: {}", e)))?;

        Ok(data_dir.join("aurora.db"))
    }
}

/// Get the database file path
fn get_db_path(app: &tauri::AppHandle) -> DbResult<PathBuf> {
    DbConnection::get_db_path(app)
}
