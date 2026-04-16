use rusqlite::{params, Connection, OptionalExtension};
use serde_json;

use crate::db::error::DbResult;
use crate::db::models::{ContextUsage, Message, ThreadState, TokenUsage};

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

        let token_usage_json = thread
            .token_usage
            .as_ref()
            .map(|u| serde_json::to_string(u).ok())
            .flatten();

        let context_usage_json = thread
            .context_usage
            .as_ref()
            .map(|u| serde_json::to_string(u).ok())
            .flatten();

        self.conn.execute(
            "INSERT INTO threads (id, title, summary, messages, token_usage, context_usage, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                summary = excluded.summary,
                messages = excluded.messages,
                token_usage = excluded.token_usage,
                context_usage = excluded.context_usage,
                updated_at = excluded.updated_at",
            params![
                thread.id,
                thread.title,
                thread.summary,
                messages_json,
                token_usage_json,
                context_usage_json,
                thread.created_at,
                thread.updated_at
            ],
        )?;

        Ok(())
    }

    pub fn get(&self, id: &str) -> DbResult<Option<ThreadState>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, summary, messages, token_usage, context_usage, created_at, updated_at
             FROM threads WHERE id = ?1",
        )?;

        let thread = stmt
            .query_row([id], |row| {
                let messages_json: String = row.get(3)?;
                let messages: Vec<Message> = serde_json::from_str(&messages_json).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        messages_json.len(),
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?;

                let token_usage_json: Option<String> = row.get(4)?;
                let token_usage: Option<TokenUsage> =
                    token_usage_json.and_then(|s| serde_json::from_str(&s).ok());

                let context_usage_json: Option<String> = row.get(5)?;
                let context_usage: Option<ContextUsage> =
                    context_usage_json.and_then(|s| serde_json::from_str(&s).ok());

                Ok(ThreadState {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    summary: row.get(2)?,
                    messages,
                    token_usage,
                    context_usage,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })
            .optional()?;

        Ok(thread)
    }

    pub fn list(&self) -> DbResult<Vec<ThreadState>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, summary, messages, token_usage, context_usage, created_at, updated_at
             FROM threads ORDER BY updated_at DESC",
        )?;

        let rows = stmt.query_map([], |row| {
            let messages_json: String = row.get(3)?;
            let messages: Vec<Message> = serde_json::from_str(&messages_json).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    messages_json.len(),
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?;

            let token_usage_json: Option<String> = row.get(4)?;
            let token_usage: Option<TokenUsage> =
                token_usage_json.and_then(|s| serde_json::from_str(&s).ok());

            let context_usage_json: Option<String> = row.get(5)?;
            let context_usage: Option<ContextUsage> =
                context_usage_json.and_then(|s| serde_json::from_str(&s).ok());

            Ok(ThreadState {
                id: row.get(0)?,
                title: row.get(1)?,
                summary: row.get(2)?,
                messages,
                token_usage,
                context_usage,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
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

    #[allow(dead_code)]
    pub fn connection(&self) -> &Connection {
        self.conn
    }
}
