mod connection;
mod error;
mod migrations;
mod models;
mod repositories;
mod schema;

pub use connection::DbConnection;
// `DbError` rides along with `DbResult`: the alias already puts it in every
// public signature, so leaving it unnameable meant a caller could receive the
// error but not write its type in their own `#[from]`.
pub use error::{DbError, DbResult};
pub use models::{
    AppSettings, ContextUsage, CustomTheme, EditorState, ExplorerState, LLMProvider, Message,
    ProviderModel, ThreadState, TokenUsage, ToolCall, ToolSetting, WorkspaceState,
};
pub use repositories::{
    CheckpointRepository, CursorModel, CursorModelsRepository, EditorRepository,
    ExplorerRepository, ModelsRepository, SettingsRepository, ThemeRepository, WorkspaceRepository,
};

/// Where core code finds the shared connection. Runs `f` with it and
/// returns `false` when there is none (not opened yet, or lock poisoned).
///
/// The desktop app keeps the connection in Tauri's managed state; a host
/// with no window owns a `Mutex<Database>` itself. Code that reads settings
/// or provider rows per call takes an `Arc<dyn DatabaseAccess>` so it works
/// under either.
pub trait DatabaseAccess: Send + Sync + 'static {
    fn with_db(&self, f: &mut dyn FnMut(&Database)) -> bool;
}

impl DatabaseAccess for std::sync::Mutex<Database> {
    fn with_db(&self, f: &mut dyn FnMut(&Database)) -> bool {
        match self.lock() {
            Ok(db) => {
                f(&db);
                true
            }
            Err(_) => false,
        }
    }
}

#[cfg(feature = "desktop")]
impl DatabaseAccess for tauri::AppHandle {
    fn with_db(&self, f: &mut dyn FnMut(&Database)) -> bool {
        use tauri::Manager;
        match self.try_state::<std::sync::Mutex<Database>>() {
            Some(state) => state.with_db(f),
            None => false,
        }
    }
}

/// Main database manager
pub struct Database {
    _conn: DbConnection,
}

impl Database {
    /// Initialize the database with migrations. Only the process that owns
    /// the schema calls this: the desktop app, or a headless host standing in
    /// for it.
    pub fn init() -> DbResult<Self> {
        let conn = DbConnection::new()?;

        // Run migrations
        migrations::run_migrations(conn.connection())?;

        Ok(Self { _conn: conn })
    }

    /// Open the database from a process with no Tauri app — the `aurora` CLI.
    ///
    /// **Migrations are deliberately not run here.** The app owns the schema:
    /// it migrates on startup, under its own single-writer assumption. A CLI
    /// invocation is short, concurrent with a possibly-running app, and may be
    /// an *older* build than the one that last opened the file — letting it
    /// migrate would mean a stray `aurora models` could rewrite the schema
    /// under a live window, or downgrade it.
    ///
    /// The cost is that a CLI command run before Aurora has ever started sees
    /// a database with no tables. That is a real state and the callers treat
    /// it as one: [`crate::cli_delegate::catalog`] reports "no providers
    /// configured yet" rather than failing with a SQL error.
    pub fn open_headless() -> DbResult<Self> {
        Ok(Self {
            _conn: DbConnection::open_headless()?,
        })
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

    /// Get a settings repository
    pub fn settings(&self) -> SettingsRepository<'_> {
        SettingsRepository::new(self._conn.connection())
    }

    /// Get a provider-models repository (v15+)
    pub fn models(&self) -> ModelsRepository<'_> {
        ModelsRepository::new(self._conn.connection())
    }

    /// The Cursor account's model catalogue.
    ///
    /// Separate from [`Self::models`] because these rows are not the user's to
    /// create or edit — see `repositories::cursor_models`.
    pub fn cursor_models(&self) -> CursorModelsRepository<'_> {
        CursorModelsRepository::new(self._conn.connection())
    }

    /// Get a themes repository
    pub fn themes(&self) -> ThemeRepository<'_> {
        ThemeRepository::new(self._conn.connection())
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
