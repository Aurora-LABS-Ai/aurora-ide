mod connection;
mod error;
mod migrations;
mod models;
mod repositories;
mod schema;

pub use connection::DbConnection;
pub use error::DbResult;
pub use models::{
    AppSettings, ContextUsage, CustomTheme, EditorState, ExplorerState, IndexProgress, LLMProvider,
    Message, SearchMode, SemanticIndex, SemanticIndexStatus, SemanticSearchResult,
    SemanticSettings, ThreadState, TokenUsage, ToolSetting, WorkspaceState,
};
// Note: ToolCall is available via crate::db::models::ToolCall or crate::context::types::ToolCall
pub use repositories::{
    CheckpointRepository, EditorRepository, ExplorerRepository, SemanticRepository,
    SettingsRepository, ThemeRepository, ThreadsRepository, WorkspaceRepository,
};

use tauri::AppHandle;

/// Main database manager
pub struct Database {
    _conn: DbConnection,
}

impl Database {
    /// Initialize the database with migrations
    pub fn init(app: &AppHandle) -> DbResult<Self> {
        let conn = DbConnection::new(app)?;

        // Run migrations
        migrations::run_migrations(conn.connection())?;

        Ok(Self { _conn: conn })
    }

    /// Get a workspace repository
    pub fn workspace(&self) -> WorkspaceRepository<'_> {
        WorkspaceRepository::new(self._conn.connection())
    }

    /// Get an editor repository
    pub fn editor(&self) -> EditorRepository<'_> {
        EditorRepository::new(self._conn.connection())
    }

    /// Get an explorer repository
    pub fn explorer(&self) -> ExplorerRepository<'_> {
        ExplorerRepository::new(self._conn.connection())
    }

    /// Get a threads repository
    pub fn threads(&self) -> ThreadsRepository<'_> {
        ThreadsRepository::new(self._conn.connection())
    }

    /// Get a settings repository
    pub fn settings(&self) -> SettingsRepository<'_> {
        SettingsRepository::new(self._conn.connection())
    }

    /// Get a themes repository
    pub fn themes(&self) -> ThemeRepository<'_> {
        ThemeRepository::new(self._conn.connection())
    }

    /// Get a semantic repository
    pub fn semantic(&self) -> SemanticRepository<'_> {
        SemanticRepository::new(self._conn.connection())
    }

    /// Get a checkpoints repository
    pub fn checkpoints(&self) -> CheckpointRepository<'_> {
        CheckpointRepository::new(self._conn.connection())
    }

    /// Get the underlying connection (kept for potential future use)
    #[allow(dead_code)]
    pub fn connection(&self) -> &rusqlite::Connection {
        self._conn.connection()
    }
}

// Make Database Sync for Tauri state
unsafe impl Send for Database {}
unsafe impl Sync for Database {}
