// Allow dead code for CRUD methods that are part of the complete API
#![allow(dead_code)]

use rusqlite::{params, Connection, OptionalExtension};

use crate::checkpoints::Checkpoint;
use crate::db::error::DbResult;

/// Repository for checkpoint database operations
pub struct CheckpointRepository<'a> {
    conn: &'a Connection,
}

impl<'a> CheckpointRepository<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    /// Save a checkpoint to the database
    pub fn save(&self, checkpoint: &Checkpoint) -> DbResult<()> {
        self.conn.execute(
            "INSERT INTO checkpoints (id, message_id, thread_id, workspace_path, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(thread_id, message_id) DO UPDATE SET
                id = excluded.id,
                workspace_path = excluded.workspace_path,
                created_at = excluded.created_at",
            params![
                checkpoint.id,
                checkpoint.message_id,
                checkpoint.thread_id,
                checkpoint.workspace_path,
                checkpoint.created_at
            ],
        )?;

        Ok(())
    }

    /// Get a checkpoint by its ID (commit hash)
    pub fn get(&self, id: &str) -> DbResult<Option<Checkpoint>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, message_id, thread_id, workspace_path, created_at
             FROM checkpoints WHERE id = ?1",
        )?;

        let checkpoint = stmt
            .query_row([id], |row| {
                Ok(Checkpoint {
                    id: row.get(0)?,
                    message_id: row.get(1)?,
                    thread_id: row.get(2)?,
                    workspace_path: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .optional()?;

        Ok(checkpoint)
    }

    /// Get checkpoint by message ID
    pub fn get_by_message_id(&self, message_id: &str) -> DbResult<Option<Checkpoint>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, message_id, thread_id, workspace_path, created_at
             FROM checkpoints WHERE message_id = ?1",
        )?;

        let checkpoint = stmt
            .query_row([message_id], |row| {
                Ok(Checkpoint {
                    id: row.get(0)?,
                    message_id: row.get(1)?,
                    thread_id: row.get(2)?,
                    workspace_path: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .optional()?;

        Ok(checkpoint)
    }

    /// Get all checkpoints for a thread (ordered by creation time)
    pub fn list_by_thread(&self, thread_id: &str) -> DbResult<Vec<Checkpoint>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, message_id, thread_id, workspace_path, created_at
             FROM checkpoints WHERE thread_id = ?1
             ORDER BY created_at ASC",
        )?;

        let rows = stmt.query_map([thread_id], |row| {
            Ok(Checkpoint {
                id: row.get(0)?,
                message_id: row.get(1)?,
                thread_id: row.get(2)?,
                workspace_path: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?;

        let mut checkpoints = Vec::new();
        for row in rows {
            checkpoints.push(row?);
        }

        Ok(checkpoints)
    }

    /// Delete a checkpoint by ID
    pub fn delete(&self, id: &str) -> DbResult<()> {
        self.conn
            .execute("DELETE FROM checkpoints WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Delete all checkpoints for a thread
    pub fn delete_by_thread(&self, thread_id: &str) -> DbResult<()> {
        self.conn
            .execute("DELETE FROM checkpoints WHERE thread_id = ?1", [thread_id])?;
        Ok(())
    }

    /// Delete all checkpoints for a workspace
    pub fn delete_by_workspace(&self, workspace_path: &str) -> DbResult<()> {
        self.conn.execute(
            "DELETE FROM checkpoints WHERE workspace_path = ?1",
            [workspace_path],
        )?;
        Ok(())
    }

    /// Delete checkpoints after a specific message (for restore operation)
    /// This deletes all checkpoints that were created after the specified checkpoint
    pub fn delete_after_checkpoint(
        &self,
        thread_id: &str,
        checkpoint_id: &str,
    ) -> DbResult<Vec<String>> {
        // First get the checkpoint's created_at time
        let created_at: Option<String> = self
            .conn
            .query_row(
                "SELECT created_at FROM checkpoints WHERE id = ?1 AND thread_id = ?2",
                params![checkpoint_id, thread_id],
                |row| row.get(0),
            )
            .optional()?;

        if let Some(timestamp) = created_at {
            // Get the message IDs that will be deleted
            let mut stmt = self.conn.prepare(
                "SELECT message_id FROM checkpoints
                 WHERE thread_id = ?1 AND created_at > ?2",
            )?;

            let rows =
                stmt.query_map(params![thread_id, timestamp], |row| row.get::<_, String>(0))?;

            let mut deleted_message_ids = Vec::new();
            for row in rows {
                deleted_message_ids.push(row?);
            }

            // Delete checkpoints created after the specified checkpoint
            self.conn.execute(
                "DELETE FROM checkpoints
                 WHERE thread_id = ?1 AND created_at > ?2",
                params![thread_id, timestamp],
            )?;

            Ok(deleted_message_ids)
        } else {
            Ok(Vec::new())
        }
    }

    /// Delete checkpoint by message ID
    pub fn delete_by_message_id(&self, message_id: &str) -> DbResult<()> {
        self.conn.execute(
            "DELETE FROM checkpoints WHERE message_id = ?1",
            [message_id],
        )?;
        Ok(())
    }
}
