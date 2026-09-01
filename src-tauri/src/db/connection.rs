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
        Self::open_headless()
    }

    /// Open the same database with no Tauri app in the process.
    ///
    /// This is what the `aurora` CLI uses: `aurora models` has to read the
    /// provider catalogue from a terminal, where no `AppHandle` exists and
    /// building one would mean starting a window to answer a list query.
    ///
    /// [`Self::new`] delegates here rather than the two paths each opening
    /// their own connection — the PRAGMAs below are the contract the whole
    /// app runs under (WAL above all, since the CLI reads this file while the
    /// running app is writing it), and a second copy of them is a second
    /// place for them to drift.
    pub fn open_headless() -> DbResult<Self> {
        let db_path = paths::db_file();
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

}
