use rusqlite::Connection;

use crate::db::error::{DbError, DbResult};
use crate::db::models::ExplorerState;

/// Repository for file explorer state operations
pub struct ExplorerRepository<'a> {
    conn: &'a Connection,
}

impl<'a> ExplorerRepository<'a> {
    /// Create a new explorer repository
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    /// Save or update explorer state for a workspace
    pub fn save(&self, state: &ExplorerState) -> DbResult<()> {
        let folders_json = serde_json::to_string(&state.expanded_folders)?;

        self.conn.execute(
            "INSERT INTO explorer_state (workspace_path, expanded_folders, selected_file)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(workspace_path) DO UPDATE SET
                expanded_folders = excluded.expanded_folders,
                selected_file = excluded.selected_file",
            [
                Some(state.workspace_path.as_str()),
                Some(folders_json.as_str()),
                state.selected_file.as_deref(),
            ],
        )?;

        Ok(())
    }

    /// Get explorer state for a workspace
    pub fn get(&self, workspace_path: &str) -> DbResult<Option<ExplorerState>> {
        let mut stmt = self.conn.prepare(
            "SELECT workspace_path, expanded_folders, selected_file
             FROM explorer_state
             WHERE workspace_path = ?1",
        )?;

        let result = stmt.query_row([workspace_path], |row| {
            Ok(ExplorerState {
                workspace_path: row.get(0)?,
                expanded_folders: {
                    let folders_json: String = row.get(1)?;
                    serde_json::from_str(&folders_json).unwrap_or_default()
                },
                selected_file: row.get(2)?,
            })
        });

        match result {
            Ok(state) => Ok(Some(state)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(DbError::Sqlite(e)),
        }
    }

    /// Delete explorer state for a workspace
    #[allow(dead_code)]
    pub fn delete(&self, workspace_path: &str) -> DbResult<()> {
        self.conn.execute(
            "DELETE FROM explorer_state WHERE workspace_path = ?1",
            [workspace_path],
        )?;

        Ok(())
    }

    /// Delete all explorer states
    #[allow(dead_code)]
    pub fn delete_all(&self) -> DbResult<()> {
        self.conn.execute("DELETE FROM explorer_state", [])?;
        Ok(())
    }

    /// Get all explorer states
    #[allow(dead_code)]
    pub fn get_all(&self) -> DbResult<Vec<ExplorerState>> {
        let mut stmt = self.conn.prepare(
            "SELECT workspace_path, expanded_folders, selected_file
             FROM explorer_state",
        )?;

        let states = stmt.query_map([], |row| {
            Ok(ExplorerState {
                workspace_path: row.get(0)?,
                expanded_folders: {
                    let folders_json: String = row.get(1)?;
                    serde_json::from_str(&folders_json).unwrap_or_default()
                },
                selected_file: row.get(0)?,
            })
        })?;

        states
            .collect::<Result<Vec<_>, _>>()
            .map_err(DbError::Sqlite)
    }
}
