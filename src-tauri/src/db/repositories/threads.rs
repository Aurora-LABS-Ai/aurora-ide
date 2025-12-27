use rusqlite::{params, Connection, OptionalExtension};
use serde_json;

use crate::db::error::DbResult;
use crate::db::models::{Message, ThreadState};

/// Repository for thread/chat history.
pub struct ThreadsRepository<'a> {
    conn: &'a Connection,
}

impl<'a> ThreadsRepository<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    pub fn save(&self, thread: &ThreadState) -> DbResult<()> {
        let messages_json = serde_json::to_string(&thread.messages)
            .map_err(crate::db::error::DbError::Serialization)?;

        self.conn.execute(
            "INSERT INTO threads (id, title, summary, messages, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                summary = excluded.summary,
                messages = excluded.messages,
                updated_at = excluded.updated_at",
            params![
                thread.id,
                thread.title,
                thread.summary,
                messages_json,
                thread.created_at,
                thread.updated_at
            ],
        )?;

        Ok(())
    }

    pub fn get(&self, id: &str) -> DbResult<Option<ThreadState>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, summary, messages, created_at, updated_at
             FROM threads WHERE id = ?1",
        )?;

        let thread = stmt
            .query_row([id], |row| {
                let messages_json: String = row.get(3)?;
                let messages: Vec<Message> = serde_json::from_str(&messages_json)
                    .map_err(|e| rusqlite::Error::FromSqlConversionFailure(
                        messages_json.len(),
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    ))?;

                Ok(ThreadState {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    summary: row.get(2)?,
                    messages,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })
            .optional()?;

        Ok(thread)
    }

    pub fn list(&self) -> DbResult<Vec<ThreadState>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, summary, messages, created_at, updated_at
             FROM threads ORDER BY updated_at DESC",
        )?;

        let rows = stmt.query_map([], |row| {
            let messages_json: String = row.get(3)?;
            let messages: Vec<Message> = serde_json::from_str(&messages_json)
                .map_err(|e| rusqlite::Error::FromSqlConversionFailure(
                    messages_json.len(),
                    rusqlite::types::Type::Text,
                    Box::new(e),
                ))?;

            Ok(ThreadState {
                id: row.get(0)?,
                title: row.get(1)?,
                summary: row.get(2)?,
                messages,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?;

        let mut threads = Vec::new();
        for row in rows {
            threads.push(row?);
        }
        Ok(threads)
    }

    pub fn delete(&self, id: &str) -> DbResult<()> {
        self.conn
            .execute("DELETE FROM threads WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn connection(&self) -> &Connection {
        self.conn
    }
}
