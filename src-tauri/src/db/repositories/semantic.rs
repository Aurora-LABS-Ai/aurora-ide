use crate::db::error::{DbError, DbResult};
use crate::db::models::{SearchMode, SemanticIndex, SemanticIndexStatus, SemanticSettings};
use rusqlite::{params, Connection};

/// Repository for semantic search operations
pub struct SemanticRepository<'a> {
    conn: &'a Connection,
}

impl<'a> SemanticRepository<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    // ============================================================
    // SEMANTIC INDEXES
    // ============================================================

    /// Get all semantic indexes
    pub fn get_all_indexes(&self) -> DbResult<Vec<SemanticIndex>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_path, workspace_name, document_count, chunk_count,
                    total_bytes, status, error_message, last_indexed_at, 
                    excluded_files, excluded_directories, created_at, updated_at
             FROM semantic_indexes
             ORDER BY updated_at DESC",
        )?;

        let indexes = stmt.query_map([], |row| {
            let status_str: String = row.get(6)?;
            let status = status_str
                .parse::<SemanticIndexStatus>()
                .unwrap_or(SemanticIndexStatus::Pending);
            let excluded_files_json: Option<String> = row.get(9)?;
            let excluded_directories_json: Option<String> = row.get(10)?;

            Ok(SemanticIndex {
                id: row.get(0)?,
                workspace_path: row.get(1)?,
                workspace_name: row.get(2)?,
                document_count: row.get(3)?,
                chunk_count: row.get(4)?,
                total_bytes: row.get(5)?,
                status,
                error_message: row.get(7)?,
                last_indexed_at: row.get(8)?,
                excluded_files: excluded_files_json
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default(),
                excluded_directories: excluded_directories_json
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default(),
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
            })
        })?;

        let mut result = Vec::new();
        for index in indexes {
            result.push(index?);
        }
        Ok(result)
    }

    /// Get a semantic index by ID
    pub fn get_index(&self, id: &str) -> DbResult<Option<SemanticIndex>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_path, workspace_name, document_count, chunk_count,
                    total_bytes, status, error_message, last_indexed_at,
                    excluded_files, excluded_directories, created_at, updated_at
             FROM semantic_indexes
             WHERE id = ?1",
        )?;

        let result = stmt.query_row(params![id], |row| {
            let status_str: String = row.get(6)?;
            let status = status_str
                .parse::<SemanticIndexStatus>()
                .unwrap_or(SemanticIndexStatus::Pending);
            let excluded_files_json: Option<String> = row.get(9)?;
            let excluded_directories_json: Option<String> = row.get(10)?;

            Ok(SemanticIndex {
                id: row.get(0)?,
                workspace_path: row.get(1)?,
                workspace_name: row.get(2)?,
                document_count: row.get(3)?,
                chunk_count: row.get(4)?,
                total_bytes: row.get(5)?,
                status,
                error_message: row.get(7)?,
                last_indexed_at: row.get(8)?,
                excluded_files: excluded_files_json
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default(),
                excluded_directories: excluded_directories_json
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default(),
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
            })
        });

        match result {
            Ok(index) => Ok(Some(index)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(DbError::Sqlite(e)),
        }
    }

    /// Get a semantic index by workspace path
    pub fn get_index_by_path(&self, workspace_path: &str) -> DbResult<Option<SemanticIndex>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_path, workspace_name, document_count, chunk_count,
                    total_bytes, status, error_message, last_indexed_at,
                    excluded_files, excluded_directories, created_at, updated_at
             FROM semantic_indexes
             WHERE workspace_path = ?1",
        )?;

        let result = stmt.query_row(params![workspace_path], |row| {
            let status_str: String = row.get(6)?;
            let status = status_str
                .parse::<SemanticIndexStatus>()
                .unwrap_or(SemanticIndexStatus::Pending);
            let excluded_files_json: Option<String> = row.get(9)?;
            let excluded_directories_json: Option<String> = row.get(10)?;

            Ok(SemanticIndex {
                id: row.get(0)?,
                workspace_path: row.get(1)?,
                workspace_name: row.get(2)?,
                document_count: row.get(3)?,
                chunk_count: row.get(4)?,
                total_bytes: row.get(5)?,
                status,
                error_message: row.get(7)?,
                last_indexed_at: row.get(8)?,
                excluded_files: excluded_files_json
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default(),
                excluded_directories: excluded_directories_json
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default(),
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
            })
        });

        match result {
            Ok(index) => Ok(Some(index)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(DbError::Sqlite(e)),
        }
    }

    /// Save or update a semantic index
    pub fn save_index(&self, index: &SemanticIndex) -> DbResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        let excluded_files_json =
            serde_json::to_string(&index.excluded_files).unwrap_or_else(|_| "[]".to_string());
        let excluded_directories_json =
            serde_json::to_string(&index.excluded_directories).unwrap_or_else(|_| "[]".to_string());

        self.conn.execute(
            "INSERT INTO semantic_indexes (
                id, workspace_path, workspace_name, document_count, chunk_count,
                total_bytes, status, error_message, last_indexed_at,
                excluded_files, excluded_directories, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            ON CONFLICT(id) DO UPDATE SET
                workspace_path = ?2, workspace_name = ?3, document_count = ?4, chunk_count = ?5,
                total_bytes = ?6, status = ?7, error_message = ?8, last_indexed_at = ?9,
                excluded_files = ?10, excluded_directories = ?11, updated_at = ?13",
            params![
                index.id,
                index.workspace_path,
                index.workspace_name,
                index.document_count,
                index.chunk_count,
                index.total_bytes,
                index.status.to_string(),
                index.error_message,
                index.last_indexed_at,
                excluded_files_json,
                excluded_directories_json,
                if index.created_at.is_empty() {
                    &now
                } else {
                    &index.created_at
                },
                now,
            ],
        )?;

        Ok(())
    }

    /// Update index status
    pub fn update_index_status(
        &self,
        id: &str,
        status: SemanticIndexStatus,
        error_message: Option<&str>,
    ) -> DbResult<()> {
        let now = chrono::Utc::now().to_rfc3339();

        self.conn.execute(
            "UPDATE semantic_indexes SET status = ?2, error_message = ?3, updated_at = ?4 WHERE id = ?1",
            params![id, status.to_string(), error_message, now],
        )?;

        Ok(())
    }

    /// Update index statistics
    pub fn update_index_stats(
        &self,
        id: &str,
        document_count: i64,
        chunk_count: i64,
        total_bytes: i64,
    ) -> DbResult<()> {
        let now = chrono::Utc::now().to_rfc3339();

        self.conn.execute(
            "UPDATE semantic_indexes SET 
                document_count = ?2, chunk_count = ?3, total_bytes = ?4, 
                last_indexed_at = ?5, updated_at = ?5 
             WHERE id = ?1",
            params![id, document_count, chunk_count, total_bytes, now],
        )?;

        Ok(())
    }

    /// Delete a semantic index
    pub fn delete_index(&self, id: &str) -> DbResult<()> {
        self.conn
            .execute("DELETE FROM semantic_indexes WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Update workspace-specific exclusions
    pub fn update_index_exclusions(
        &self,
        workspace_path: &str,
        excluded_files: &[String],
        excluded_directories: &[String],
    ) -> DbResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        let excluded_files_json =
            serde_json::to_string(excluded_files).unwrap_or_else(|_| "[]".to_string());
        let excluded_directories_json =
            serde_json::to_string(excluded_directories).unwrap_or_else(|_| "[]".to_string());

        self.conn.execute(
            "UPDATE semantic_indexes SET 
                excluded_files = ?2, excluded_directories = ?3, updated_at = ?4
             WHERE workspace_path = ?1",
            params![
                workspace_path,
                excluded_files_json,
                excluded_directories_json,
                now
            ],
        )?;

        Ok(())
    }

    // ============================================================
    // SEMANTIC SETTINGS
    // ============================================================

    /// Get semantic settings
    pub fn get_settings(&self) -> DbResult<SemanticSettings> {
        let mut stmt = self.conn.prepare(
            "SELECT model_path, enabled, auto_index, auto_reindex_interval,
                    ignored_patterns, ignored_directories, excluded_files, excluded_directories,
                    max_file_size, search_mode, lexical_weight, semantic_weight, updated_at
             FROM semantic_settings
             WHERE id = 1",
        )?;

        let result = stmt.query_row([], |row| {
            let model_path: Option<String> = row.get(0)?;
            let enabled: i32 = row.get(1)?;
            let auto_index: i32 = row.get(2)?;
            let auto_reindex_interval: Option<i64> = row.get(3)?;
            let ignored_patterns_json: Option<String> = row.get(4)?;
            let ignored_directories_json: Option<String> = row.get(5)?;
            let excluded_files_json: Option<String> = row.get(6)?;
            let excluded_directories_json: Option<String> = row.get(7)?;
            let max_file_size: i64 = row.get(8)?;
            let search_mode_str: String = row.get(9)?;
            let lexical_weight: f64 = row.get(10)?;
            let semantic_weight: f64 = row.get(11)?;
            let updated_at: String = row.get(12)?;

            // Use proper defaults when JSON is NULL or empty
            let default_settings = SemanticSettings::default();
            let ignored_patterns: Vec<String> = ignored_patterns_json
                .and_then(|s| serde_json::from_str(&s).ok())
                .filter(|v: &Vec<String>| !v.is_empty())
                .unwrap_or(default_settings.ignored_patterns.clone());
            let ignored_directories: Vec<String> = ignored_directories_json
                .and_then(|s| serde_json::from_str(&s).ok())
                .filter(|v: &Vec<String>| !v.is_empty())
                .unwrap_or(default_settings.ignored_directories.clone());
            // Excluded files/directories default to empty (user-specific)
            let excluded_files: Vec<String> = excluded_files_json
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            let excluded_directories: Vec<String> = excluded_directories_json
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            let search_mode = search_mode_str
                .parse::<SearchMode>()
                .unwrap_or(SearchMode::Hybrid);

            Ok(SemanticSettings {
                model_path,
                enabled: enabled != 0,
                auto_index: auto_index != 0,
                auto_reindex_interval,
                ignored_patterns,
                ignored_directories,
                excluded_files,
                excluded_directories,
                max_file_size,
                search_mode,
                lexical_weight,
                semantic_weight,
                updated_at,
            })
        });

        match result {
            Ok(settings) => Ok(settings),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(SemanticSettings::default()),
            Err(e) => Err(DbError::Sqlite(e)),
        }
    }

    /// Save semantic settings
    pub fn save_settings(&self, settings: &SemanticSettings) -> DbResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        let ignored_patterns_json =
            serde_json::to_string(&settings.ignored_patterns).unwrap_or_else(|_| "[]".to_string());
        let ignored_directories_json = serde_json::to_string(&settings.ignored_directories)
            .unwrap_or_else(|_| "[]".to_string());
        let excluded_files_json =
            serde_json::to_string(&settings.excluded_files).unwrap_or_else(|_| "[]".to_string());
        let excluded_directories_json = serde_json::to_string(&settings.excluded_directories)
            .unwrap_or_else(|_| "[]".to_string());

        self.conn.execute(
            "INSERT INTO semantic_settings (
                id, model_path, enabled, auto_index, auto_reindex_interval,
                ignored_patterns, ignored_directories, excluded_files, excluded_directories,
                max_file_size, search_mode, lexical_weight, semantic_weight, updated_at
            ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            ON CONFLICT(id) DO UPDATE SET
                model_path = ?1, enabled = ?2, auto_index = ?3, auto_reindex_interval = ?4,
                ignored_patterns = ?5, ignored_directories = ?6, excluded_files = ?7, excluded_directories = ?8,
                max_file_size = ?9, search_mode = ?10, lexical_weight = ?11, semantic_weight = ?12, updated_at = ?13",
            params![
                settings.model_path,
                settings.enabled as i32,
                settings.auto_index as i32,
                settings.auto_reindex_interval,
                ignored_patterns_json,
                ignored_directories_json,
                excluded_files_json,
                excluded_directories_json,
                settings.max_file_size,
                settings.search_mode.to_string(),
                settings.lexical_weight,
                settings.semantic_weight,
                now,
            ],
        )?;

        Ok(())
    }

    /// Update model path only
    pub fn set_model_path(&self, path: Option<&str>) -> DbResult<()> {
        let now = chrono::Utc::now().to_rfc3339();

        self.conn.execute(
            "UPDATE semantic_settings SET model_path = ?1, updated_at = ?2 WHERE id = 1",
            params![path, now],
        )?;

        Ok(())
    }
}
