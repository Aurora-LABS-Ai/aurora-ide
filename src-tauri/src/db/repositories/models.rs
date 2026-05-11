use rusqlite::{params, Connection};

use crate::db::error::{DbError, DbResult};
use crate::db::models::ProviderModel;

/// Repository for the v15 `provider_models` table.
pub struct ModelsRepository<'a> {
    conn: &'a Connection,
}

impl<'a> ModelsRepository<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    /// All models, ordered by provider then sort_order — used by the
    /// frontend store to materialize the per-provider model list in
    /// one round-trip.
    pub fn list_all(&self) -> DbResult<Vec<ProviderModel>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, provider_id, model_key, label, context_window, max_output_tokens,
                    supports_vision, supports_thinking, supports_tool_stream, enabled,
                    sort_order, created_at, updated_at
             FROM provider_models
             ORDER BY provider_id ASC, sort_order ASC, model_key ASC",
        )?;
        let rows = stmt.query_map([], row_to_model)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Models for a single provider.
    pub fn list_by_provider(&self, provider_id: &str) -> DbResult<Vec<ProviderModel>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, provider_id, model_key, label, context_window, max_output_tokens,
                    supports_vision, supports_thinking, supports_tool_stream, enabled,
                    sort_order, created_at, updated_at
             FROM provider_models
             WHERE provider_id = ?1
             ORDER BY sort_order ASC, model_key ASC",
        )?;
        let rows = stmt.query_map(params![provider_id], row_to_model)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Look up a single model by `provider_id` + `model_key`. Returns
    /// `None` if the row doesn't exist (the caller should then fall
    /// back to the provider's defaults).
    #[allow(dead_code)]
    pub fn get(&self, provider_id: &str, model_key: &str) -> DbResult<Option<ProviderModel>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, provider_id, model_key, label, context_window, max_output_tokens,
                    supports_vision, supports_thinking, supports_tool_stream, enabled,
                    sort_order, created_at, updated_at
             FROM provider_models
             WHERE provider_id = ?1 AND model_key = ?2",
        )?;
        let result = stmt.query_row(params![provider_id, model_key], row_to_model);
        match result {
            Ok(model) => Ok(Some(model)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(DbError::Sqlite(e)),
        }
    }

    /// Insert or update a model. The composite primary key is
    /// `{provider_id}::{model_key}`; the caller may pass an empty
    /// `id` and we'll synthesize it.
    pub fn upsert(&self, model: &ProviderModel) -> DbResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        let id = if model.id.trim().is_empty() {
            format!("{}::{}", model.provider_id, model.model_key)
        } else {
            model.id.clone()
        };
        let created_at = if model.created_at.trim().is_empty() {
            now.clone()
        } else {
            model.created_at.clone()
        };

        self.conn.execute(
            "INSERT INTO provider_models (
                id, provider_id, model_key, label, context_window, max_output_tokens,
                supports_vision, supports_thinking, supports_tool_stream, enabled,
                sort_order, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(id) DO UPDATE SET
                model_key = ?3, label = ?4, context_window = ?5, max_output_tokens = ?6,
                supports_vision = ?7, supports_thinking = ?8, supports_tool_stream = ?9,
                enabled = ?10, sort_order = ?11, updated_at = ?13",
            params![
                id,
                model.provider_id,
                model.model_key,
                model.label,
                model.context_window,
                model.max_output_tokens,
                model.supports_vision as i32,
                model.supports_thinking as i32,
                model.supports_tool_stream as i32,
                model.enabled as i32,
                model.sort_order,
                created_at,
                now,
            ],
        )?;
        Ok(())
    }

    /// Delete a single model by composite primary key.
    pub fn delete(&self, provider_id: &str, model_key: &str) -> DbResult<()> {
        self.conn.execute(
            "DELETE FROM provider_models WHERE provider_id = ?1 AND model_key = ?2",
            params![provider_id, model_key],
        )?;
        Ok(())
    }

    /// Delete every model under a provider — called when the user
    /// deletes the provider itself, in case the FK ON DELETE CASCADE
    /// isn't enforced (older SQLite builds need `PRAGMA foreign_keys=ON`).
    #[allow(dead_code)]
    pub fn delete_by_provider(&self, provider_id: &str) -> DbResult<()> {
        self.conn.execute(
            "DELETE FROM provider_models WHERE provider_id = ?1",
            params![provider_id],
        )?;
        Ok(())
    }

    /// Bulk replace — used by the frontend when saving the full
    /// model list for a provider in one go (e.g. accepting a Discover
    /// Local Servers result, or importing from the Fireworks catalog).
    pub fn replace_for_provider(
        &self,
        provider_id: &str,
        models: &[ProviderModel],
    ) -> DbResult<()> {
        let tx_active = self
            .conn
            .execute("BEGIN", [])
            .map(|_| true)
            .unwrap_or(false);
        let result = (|| {
            self.conn.execute(
                "DELETE FROM provider_models WHERE provider_id = ?1",
                params![provider_id],
            )?;
            for (idx, m) in models.iter().enumerate() {
                let mut row = m.clone();
                row.provider_id = provider_id.to_string();
                row.sort_order = idx as i32;
                self.upsert(&row)?;
            }
            Ok::<_, DbError>(())
        })();
        if tx_active {
            match &result {
                Ok(_) => {
                    let _ = self.conn.execute("COMMIT", []);
                }
                Err(_) => {
                    let _ = self.conn.execute("ROLLBACK", []);
                }
            }
        }
        result
    }
}

fn row_to_model(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProviderModel> {
    Ok(ProviderModel {
        id: row.get(0)?,
        provider_id: row.get(1)?,
        model_key: row.get(2)?,
        label: row.get(3)?,
        context_window: row.get(4)?,
        max_output_tokens: row.get(5)?,
        supports_vision: row.get::<_, i32>(6)? != 0,
        supports_thinking: row.get::<_, i32>(7)? != 0,
        supports_tool_stream: row.get::<_, i32>(8)? != 0,
        enabled: row.get::<_, i32>(9)? != 0,
        sort_order: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}
