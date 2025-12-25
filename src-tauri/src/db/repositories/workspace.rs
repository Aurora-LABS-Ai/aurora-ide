use rusqlite::Connection;

use crate::db::error::{DbError, DbResult};
use crate::db::models::WorkspaceState;

/// Repository for workspace state operations
pub struct WorkspaceRepository<'a> {
    conn: &'a Connection,
}

impl<'a> WorkspaceRepository<'a> {
    /// Create a new workspace repository
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    /// Save or update workspace state
    pub fn save(&self, state: &WorkspaceState) -> DbResult<()> {
        let tabs_json = serde_json::to_string(&state.open_tabs)?;
        let panels_json = state
            .panel_sizes
            .as_ref()
            .map(|p| serde_json::to_string(p))
            .transpose()?;

        self.conn.execute(
            "INSERT INTO workspace_state (workspace_path, open_tabs, panel_sizes, last_opened_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(workspace_path) DO UPDATE SET
                open_tabs = excluded.open_tabs,
                panel_sizes = excluded.panel_sizes,
                last_opened_at = excluded.last_opened_at",
            [
                state.workspace_path.as_deref(),
                Some(tabs_json.as_str()),
                panels_json.as_deref(),
                Some(state.last_opened_at.as_str()),
            ],
        )?;

        Ok(())
    }

    /// Get workspace state by path
    pub fn get_by_path(&self, workspace_path: &str) -> DbResult<Option<WorkspaceState>> {
        let mut stmt = self.conn.prepare(
            "SELECT workspace_path, open_tabs, panel_sizes, last_opened_at
             FROM workspace_state
             WHERE workspace_path = ?1",
        )?;

        let result = stmt.query_row([workspace_path], |row| {
            Ok(WorkspaceState {
                workspace_path: row.get(0)?,
                open_tabs: {
                    let tabs_json: String = row.get(1)?;
                    serde_json::from_str(&tabs_json).unwrap_or_default()
                },
                panel_sizes: {
                    let panels_json: Option<String> = row.get(2)?;
                    panels_json
                        .map(|json| serde_json::from_str(&json))
                        .transpose()
                        .ok()
                        .flatten()
                },
                last_opened_at: row.get(3)?,
            })
        });

        match result {
            Ok(state) => Ok(Some(state)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(DbError::Sqlite(e)),
        }
    }

    /// Get the most recently opened workspace
    pub fn get_most_recent(&self) -> DbResult<Option<WorkspaceState>> {
        let mut stmt = self.conn.prepare(
            "SELECT workspace_path, open_tabs, panel_sizes, last_opened_at
             FROM workspace_state
             ORDER BY last_opened_at DESC
             LIMIT 1",
        )?;

        let result = stmt.query_row([], |row| {
            Ok(WorkspaceState {
                workspace_path: row.get(0)?,
                open_tabs: {
                    let tabs_json: String = row.get(1)?;
                    serde_json::from_str(&tabs_json).unwrap_or_default()
                },
                panel_sizes: {
                    let panels_json: Option<String> = row.get(2)?;
                    panels_json
                        .map(|json| serde_json::from_str(&json))
                        .transpose()
                        .ok()
                        .flatten()
                },
                last_opened_at: row.get(3)?,
            })
        });

        match result {
            Ok(state) => Ok(Some(state)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(DbError::Sqlite(e)),
        }
    }

    /// Delete workspace state
    pub fn delete(&self, workspace_path: &str) -> DbResult<()> {
        self.conn.execute(
            "DELETE FROM workspace_state WHERE workspace_path = ?1",
            [workspace_path],
        )?;

        Ok(())
    }

    /// Get all workspaces
    pub fn get_all(&self) -> DbResult<Vec<WorkspaceState>> {
        let mut stmt = self.conn.prepare(
            "SELECT workspace_path, open_tabs, panel_sizes, last_opened_at
             FROM workspace_state
             ORDER BY last_opened_at DESC",
        )?;

        let states = stmt.query_map([], |row| {
            Ok(WorkspaceState {
                workspace_path: row.get(0)?,
                open_tabs: {
                    let tabs_json: String = row.get(1)?;
                    serde_json::from_str(&tabs_json).unwrap_or_default()
                },
                panel_sizes: {
                    let panels_json: Option<String> = row.get(2)?;
                    panels_json
                        .map(|json| serde_json::from_str(&json))
                        .transpose()
                        .ok()
                        .flatten()
                },
                last_opened_at: row.get(3)?,
            })
        })?;

        states.collect::<Result<Vec<_>, _>>().map_err(DbError::Sqlite)
    }
}
