use rusqlite::{params, Connection};

use crate::db::error::{DbError, DbResult};
use crate::db::models::EditorState;

/// Repository for editor state operations
pub struct EditorRepository<'a> {
    conn: &'a Connection,
}

impl<'a> EditorRepository<'a> {
    /// Create a new editor repository
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    /// Save or update editor state for a file
    pub fn save(&self, state: &EditorState) -> DbResult<()> {
        let folded_json = state
            .folded_regions
            .as_ref()
            .map(|f| serde_json::to_string(f))
            .transpose()?;

        self.conn.execute(
            "INSERT INTO editor_state (file_path, cursor_line, cursor_col, scroll_offset, folded_regions, last_edited_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(file_path) DO UPDATE SET
                cursor_line = excluded.cursor_line,
                cursor_col = excluded.cursor_col,
                scroll_offset = excluded.scroll_offset,
                folded_regions = excluded.folded_regions,
                last_edited_at = excluded.last_edited_at",
            params![
                state.file_path,
                state.cursor_line.map(|l| l as i64),
                state.cursor_col.map(|c| c as i64),
                state.scroll_offset,
                folded_json,
                state.last_edited_at,
            ],
        )?;

        Ok(())
    }

    /// Get editor state for a file
    pub fn get(&self, file_path: &str) -> DbResult<Option<EditorState>> {
        let mut stmt = self.conn.prepare(
            "SELECT file_path, cursor_line, cursor_col, scroll_offset, folded_regions, last_edited_at
             FROM editor_state
             WHERE file_path = ?1",
        )?;

        let result = stmt.query_row([file_path], |row| {
            Ok(EditorState {
                file_path: row.get(0)?,
                cursor_line: row.get::<_, Option<i64>>(1)?.map(|l| l as u32),
                cursor_col: row.get::<_, Option<i64>>(2)?.map(|c| c as u32),
                scroll_offset: row.get(3)?,
                folded_regions: {
                    let folded_json: Option<String> = row.get(4)?;
                    folded_json
                        .map(|json| serde_json::from_str(&json))
                        .transpose()
                        .ok()
                        .flatten()
                },
                last_edited_at: row.get(5)?,
            })
        });

        match result {
            Ok(state) => Ok(Some(state)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(DbError::Sqlite(e)),
        }
    }

    /// Delete editor state for a file
    #[allow(dead_code)]
    pub fn delete(&self, file_path: &str) -> DbResult<()> {
        self.conn.execute(
            "DELETE FROM editor_state WHERE file_path = ?1",
            [file_path],
        )?;

        Ok(())
    }

    /// Delete all editor states
    #[allow(dead_code)]
    pub fn delete_all(&self) -> DbResult<()> {
        self.conn.execute("DELETE FROM editor_state", [])?;
        Ok(())
    }

    /// Get all editor states
    #[allow(dead_code)]
    pub fn get_all(&self) -> DbResult<Vec<EditorState>> {
        let mut stmt = self.conn.prepare(
            "SELECT file_path, cursor_line, cursor_col, scroll_offset, folded_regions, last_edited_at
             FROM editor_state
             ORDER BY last_edited_at DESC",
        )?;

        let states = stmt.query_map([], |row| {
            Ok(EditorState {
                file_path: row.get(0)?,
                cursor_line: row.get::<_, Option<i64>>(1)?.map(|l| l as u32),
                cursor_col: row.get::<_, Option<i64>>(2)?.map(|c| c as u32),
                scroll_offset: row.get(3)?,
                folded_regions: {
                    let folded_json: Option<String> = row.get(4)?;
                    folded_json
                        .map(|json| serde_json::from_str(&json))
                        .transpose()
                        .ok()
                        .flatten()
                },
                last_edited_at: row.get(5)?,
            })
        })?;

        states.collect::<Result<Vec<_>, _>>().map_err(DbError::Sqlite)
    }
}
