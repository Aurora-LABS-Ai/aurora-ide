use rusqlite::Connection;

use crate::db::error::{DbError, DbResult};
use crate::db::schema::{get_schema_version, initialize_schema, SCHEMA_VERSION};

/// Run pending migrations
pub fn run_migrations(conn: &Connection) -> DbResult<()> {
    let current_version = get_schema_version(conn)?;

    // If no version, initialize schema
    if current_version == 0 {
        initialize_schema(conn)?;
        return Ok(());
    }

    // Run migrations based on current version
    match current_version {
        SCHEMA_VERSION => Ok(()), // Already up to date
        v if v < SCHEMA_VERSION => {
            // Run migrations in sequence
            for version in v..SCHEMA_VERSION {
                run_migration(conn, version + 1)?;
            }
            Ok(())
        }
        v => Err(DbError::Migration(format!(
            "Database version {} is newer than application version {}",
            v, SCHEMA_VERSION
        ))),
    }
}

/// Run a single migration
fn run_migration(conn: &Connection, target_version: i32) -> DbResult<()> {
    match target_version {
        1 => {
            // Initial schema (handled by initialize_schema)
            initialize_schema(conn)?;
            Ok(())
        }
        2 => {
            // Migration from v1 to v2: Add settings tables
            migration_v2(conn)?;
            // Update schema version
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [2])?;
            Ok(())
        }
        3 => {
            // Migration from v2 to v3: Add token/context usage to threads
            migration_v3(conn)?;
            // Update schema version
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [3])?;
            Ok(())
        }
        4 => {
            // Migration from v3 to v4: Add custom_themes table
            migration_v4(conn)?;
            // Update schema version
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [4])?;
            Ok(())
        }
        5 => {
            // Migration from v4 to v5: Add unique constraint on themes and cleanup duplicates
            migration_v5(conn)?;
            // Update schema version
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [5])?;
            Ok(())
        }
        6 => {
            // Migration from v5 to v6: Add semantic search tables
            migration_v6(conn)?;
            // Update schema version
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [6])?;
            Ok(())
        }
        7 => {
            // Migration from v6 to v7: Add excluded_files and excluded_directories columns to semantic_settings
            migration_v7(conn)?;
            // Update schema version
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [7])?;
            Ok(())
        }
        8 => {
            // Migration from v7 to v8: Add workspace-specific exclusions to semantic_indexes
            migration_v8(conn)?;
            // Update schema version
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [8])?;
            Ok(())
        }
        9 => {
            // Migration from v8 to v9: Cleanup NULL workspace_path entries
            migration_v9(conn)?;
            // Update schema version
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [9])?;
            Ok(())
        }
        10 => {
            // Migration from v9 to v10: Add checkpoints table
            migration_v10(conn)?;
            // Update schema version
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [10])?;
            Ok(())
        }
        11 => {
            // Migration from v10 to v11: Add provider nicknames and model aliases
            migration_v11(conn)?;
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [11])?;
            Ok(())
        }
        12 => {
            // Migration from v11 to v12: Drop the legacy semantic search tables.
            // Aurora no longer ships a semantic indexer; reclaim the storage and
            // make sure stale rows can never be served back to the frontend.
            migration_v12(conn)?;
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [12])?;
            Ok(())
        }
        13 => {
            // Migration from v12 to v13: Drop the legacy `threads` table.
            //
            // Conversations are now stored as append-only JSONL message
            // logs under `<app_data>/agent_v2/{thread_id}.jsonl` with a
            // metadata sidecar at `<thread_id>.meta.json` (see
            // `crate::agent_runtime::session_store::SessionStore`). No
            // data is migrated — per product direction this is a clean
            // break for the v1 release.
            migration_v13(conn)?;
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [13])?;
            Ok(())
        }
        14 => {
            // Migration from v13 to v14: Add `supports_vision` column
            // to `llm_providers` so the user can mark per-model whether
            // the model accepts image content blocks. Drives both the
            // browser_screenshot tool registration AND the API adapter's
            // multimodal tool_result encoding.
            migration_v14(conn)?;
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [14])?;
            Ok(())
        }
        15 => {
            // Migration from v14 to v15: Split per-model capabilities
            // out of `llm_providers` into a new `provider_models` table.
            // Capabilities (vision, thinking, tool-stream) are now
            // per-model rather than per-provider, since the same
            // provider can expose models with different capabilities
            // (e.g. GPT-4o vs GPT-4o-mini).
            migration_v15(conn)?;
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [15])?;
            Ok(())
        }
        16 => {
            // Migration from v15 to v16: Add per-model pricing columns
            // to `provider_models` so users can track input/cache/output
            // cost per model. Seed DeepSeek V4 prices on existing rows.
            migration_v16(conn)?;
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [16])?;
            Ok(())
        }
        17 => {
            // Migration from v16 to v17: Add a `reasoning` JSON column to
            // `provider_models`. Holds the model's reasoning capability +
            // chosen default — `{type:"effort"|"toggle"|"budget", levels?,
            // min?, max?, default?}` — auto-filled from models.dev when a
            // model is added, overridable by the user. Drives the composer's
            // reasoning-level picker (shown only when this is set).
            migration_v17(conn)?;
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [17])?;
            Ok(())
        }
        18 => {
            // Migration from v17 to v18: Add an `extra_body` JSON column to
            // `provider_models`. Holds a per-model object of extra request-body
            // fields the user adds manually (e.g. `thinking: {type: enabled}`
            // for providers we don't special-case). Merged verbatim into the
            // outgoing request body at send time.
            migration_v18(conn)?;
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [18])?;
            Ok(())
        }
        19 => {
            // Migration from v18 to v19: checkpoints are now OPT-IN per project.
            // Disable them for every existing workspace so an already-tracked
            // shadow repo stops growing — the per-message git commits were
            // ballooning %LOCALAPPDATA%\AuroraIDE\checkpoints to tens of GB. The
            // user re-enables per project from the checkpoint toggle.
            migration_v19(conn)?;
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [19])?;
            Ok(())
        }
        20 => {
            // Migration from v19 to v20: add the `api_keys` JSON-array column
            // to `llm_providers` for the multi-key pool (round-robin + failover).
            migration_v20(conn)?;
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [20])?;
            Ok(())
        }
        21 => {
            // Migration from v20 to v21: add `price_cache_write_per_mtok` to
            // `provider_models`. Cache-CREATION tokens are billed by every
            // provider that offers prompt caching, and Aurora priced them at
            // zero because no column existed — so every cached conversation
            // under-reported its real cost.
            migration_v21(conn)?;
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [21])?;
            Ok(())
        }
        22 => {
            // Migration from v21 to v22: add `temperature` to `provider_models`.
            // Temperature was a single hidden app setting nothing could edit,
            // while the Agent page told the user it was "a model setting, set it
            // on the model itself" — a control that did not exist. NULL keeps
            // the old behaviour exactly: inherit the provider default.
            migration_v22(conn)?;
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [22])?;
            Ok(())
        }
        23 => {
            // Migration from v22 to v23: add `cursor_models`, the Cursor
            // account's model catalogue. Additive — a table that did not
            // exist before, so there is nothing to back-fill and nothing an
            // older build could have written.
            migration_v23(conn)?;
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [23])?;
            Ok(())
        }
        _ => Err(DbError::Migration(format!(
            "Unknown migration version: {}",
            target_version
        ))),
    }
}

/// Migration v21: Add the nullable `price_cache_write_per_mtok` column to
/// `provider_models` — USD per 1M cache-creation tokens.
///
/// Left NULL rather than back-filled. NULL means "bill cache writes at the
/// fresh-input rate", which is what OpenAI-compatible gateways actually
/// charge; the column exists for providers that price it differently
/// (Anthropic native charges 1.25x base). Guessing a number per model here
/// would put a fabricated price in front of the user, and a wrong price is
/// worse than an explicit fallback the code documents.
///
/// Idempotent: guarded with a PRAGMA table_info sniff so re-running on a
/// hand-patched DB (or one where a fresh install already created the column)
/// is safe.
/// Migration v22: Add the nullable `temperature` column to `provider_models`.
///
/// Per-model, because that is where the setting belongs and where the UI
/// already claimed it lived. NULL means "inherit" — the provider's
/// `default_temperature`, then Aurora's own default — so an existing install
/// behaves identically until the user sets a value. Idempotent, same PRAGMA
/// sniff as its neighbours.
/// v23: the Cursor account's model catalogue.
///
/// Reuses `schema::create_cursor_models_table` rather than restating the DDL,
/// so a fresh install and an upgraded one cannot drift — the failure mode
/// there is a column that exists for new users and not for old ones, which
/// only shows up as a query error weeks later.
fn migration_v23(conn: &Connection) -> DbResult<()> {
    crate::db::schema::create_cursor_models_table(conn)
}

fn migration_v22(conn: &Connection) -> DbResult<()> {
    let existing: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(provider_models)")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
        rows.flatten().collect()
    };
    if !existing.iter().any(|c| c == "temperature") {
        conn.execute(
            "ALTER TABLE provider_models ADD COLUMN temperature REAL",
            [],
        )?;
    }
    Ok(())
}

fn migration_v21(conn: &Connection) -> DbResult<()> {
    let existing: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(provider_models)")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
        rows.flatten().collect()
    };
    if !existing.iter().any(|c| c == "price_cache_write_per_mtok") {
        conn.execute(
            "ALTER TABLE provider_models ADD COLUMN price_cache_write_per_mtok REAL",
            [],
        )?;
    }
    Ok(())
}

/// Migration v20: Add the nullable `api_keys` JSON column to `llm_providers`
/// — a JSON array of strings holding the provider's API-key pool. Idempotent:
/// guarded with a PRAGMA table_info sniff so re-running on a hand-patched DB
/// (or one where a fresh install already created the column) is safe.
fn migration_v20(conn: &Connection) -> DbResult<()> {
    let existing: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(llm_providers)")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
        rows.flatten().collect()
    };
    if !existing.iter().any(|c| c == "api_keys") {
        conn.execute("ALTER TABLE llm_providers ADD COLUMN api_keys TEXT", [])?;
    }
    Ok(())
}

/// Migration v19: flip checkpoints to opt-in. Disable for all existing
/// workspaces (the new default is off). Idempotent — a plain UPDATE that is
/// safe to re-run. Users turn checkpoints back on per project when they want
/// snapshot-per-message for that workspace.
fn migration_v19(conn: &Connection) -> DbResult<()> {
    conn.execute("UPDATE workspace_state SET checkpoint_enabled = 0", [])?;
    Ok(())
}

/// Migration v17: Add the nullable `reasoning` JSON column to
/// `provider_models`. Idempotent — guarded with a PRAGMA table_info sniff
/// so re-running on a hand-patched DB is safe.
fn migration_v17(conn: &Connection) -> DbResult<()> {
    let existing: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(provider_models)")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
        rows.flatten().collect()
    };
    if !existing.iter().any(|c| c == "reasoning") {
        conn.execute("ALTER TABLE provider_models ADD COLUMN reasoning TEXT", [])?;
    }
    Ok(())
}

/// Migration v18: Add the nullable `extra_body` JSON column to
/// `provider_models`. Idempotent — guarded with a PRAGMA table_info sniff so
/// re-running on a hand-patched DB is safe.
fn migration_v18(conn: &Connection) -> DbResult<()> {
    let existing: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(provider_models)")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
        rows.flatten().collect()
    };
    if !existing.iter().any(|c| c == "extra_body") {
        conn.execute("ALTER TABLE provider_models ADD COLUMN extra_body TEXT", [])?;
    }
    Ok(())
}

/// Migration v2: Add app_settings, llm_providers, and tool_settings tables
fn migration_v2(conn: &Connection) -> DbResult<()> {
    // Create app_settings table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;

    // Create llm_providers table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS llm_providers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            nickname TEXT,
            base_url TEXT NOT NULL,
            api_key TEXT NOT NULL DEFAULT '',
            model TEXT NOT NULL,
            context_window INTEGER NOT NULL DEFAULT 128000,
            max_output_tokens INTEGER NOT NULL DEFAULT 16384,
            supports_thinking INTEGER NOT NULL DEFAULT 0,
            supports_tool_stream INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            is_custom INTEGER NOT NULL DEFAULT 0,
            custom_models TEXT,
            model_aliases TEXT,
            custom_headers TEXT,
            custom_params TEXT,
            provider_type TEXT,
            default_temperature REAL,
            default_max_tokens INTEGER,
            requires_api_key INTEGER NOT NULL DEFAULT 1,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;

    // Create index for sorting providers
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_llm_providers_sort
         ON llm_providers (sort_order ASC)",
        [],
    )?;

    // Create tool_settings table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS tool_settings (
            tool_name TEXT PRIMARY KEY,
            approval_mode TEXT NOT NULL DEFAULT 'always_ask',
            updated_at TEXT NOT NULL
        )",
        [],
    )?;

    // Drop old settings table if exists (it was a placeholder)
    conn.execute("DROP TABLE IF EXISTS settings", [])?;

    Ok(())
}

/// Migration v3: Add token_usage and context_usage columns to threads table
fn migration_v3(conn: &Connection) -> DbResult<()> {
    // Add token_usage column to threads table
    conn.execute("ALTER TABLE threads ADD COLUMN token_usage TEXT", [])?;

    // Add context_usage column to threads table
    conn.execute("ALTER TABLE threads ADD COLUMN context_usage TEXT", [])?;

    Ok(())
}

/// Migration v4: Add custom_themes table
fn migration_v4(conn: &Connection) -> DbResult<()> {
    // Create custom_themes table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS custom_themes (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            author TEXT NOT NULL,
            version TEXT NOT NULL,
            type TEXT NOT NULL,     -- 'dark' or 'light'
            colors TEXT NOT NULL,   -- JSON object
            token_colors TEXT NOT NULL, -- JSON array
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;

    // Create index for sorting
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_custom_themes_updated_at
         ON custom_themes (updated_at DESC)",
        [],
    )?;

    Ok(())
}

/// Migration v5: Cleanup duplicate themes and add unique constraint
fn migration_v5(conn: &Connection) -> DbResult<()> {
    // Step 1: Delete all duplicate themes, keeping only the most recently updated one per name+author
    conn.execute(
        "DELETE FROM custom_themes 
         WHERE id NOT IN (
            SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (
                    PARTITION BY LOWER(TRIM(name)), LOWER(TRIM(author)) 
                    ORDER BY updated_at DESC
                ) as rn
                FROM custom_themes
            ) WHERE rn = 1
         )",
        [],
    )?;

    // Step 2: Create unique index on name+author (case insensitive)
    // This will prevent future duplicates at the database level
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_themes_name_author
         ON custom_themes (LOWER(TRIM(name)), LOWER(TRIM(author)))",
        [],
    )?;

    Ok(())
}

/// Migration v6: Add semantic search tables
fn migration_v6(conn: &Connection) -> DbResult<()> {
    // Create semantic_indexes table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS semantic_indexes (
            id TEXT PRIMARY KEY,
            workspace_path TEXT NOT NULL UNIQUE,
            workspace_name TEXT NOT NULL,
            document_count INTEGER NOT NULL DEFAULT 0,
            chunk_count INTEGER NOT NULL DEFAULT 0,
            total_bytes INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending',
            error_message TEXT,
            last_indexed_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;

    // Create index for workspace path lookup
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_semantic_indexes_workspace_path
         ON semantic_indexes (workspace_path)",
        [],
    )?;

    // Create semantic_settings table (single row)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS semantic_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            model_path TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            auto_index INTEGER NOT NULL DEFAULT 0,
            auto_reindex_interval INTEGER,
            ignored_patterns TEXT,
            ignored_directories TEXT,
            max_file_size INTEGER NOT NULL DEFAULT 1048576,
            search_mode TEXT NOT NULL DEFAULT 'hybrid',
            lexical_weight REAL NOT NULL DEFAULT 0.4,
            semantic_weight REAL NOT NULL DEFAULT 0.6,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;

    // Insert default settings row
    conn.execute(
        "INSERT OR IGNORE INTO semantic_settings (id, updated_at) VALUES (1, datetime('now'))",
        [],
    )?;

    Ok(())
}

/// Migration v7: Add excluded_files and excluded_directories columns to semantic_settings
fn migration_v7(conn: &Connection) -> DbResult<()> {
    // Add excluded_files column (specific file paths to exclude)
    conn.execute(
        "ALTER TABLE semantic_settings ADD COLUMN excluded_files TEXT DEFAULT '[]'",
        [],
    )?;

    // Add excluded_directories column (specific directory paths to exclude)
    conn.execute(
        "ALTER TABLE semantic_settings ADD COLUMN excluded_directories TEXT DEFAULT '[]'",
        [],
    )?;

    Ok(())
}

/// Migration v8: Add workspace-specific exclusions to semantic_indexes table
fn migration_v8(conn: &Connection) -> DbResult<()> {
    // Add excluded_files column to semantic_indexes (workspace-specific)
    conn.execute(
        "ALTER TABLE semantic_indexes ADD COLUMN excluded_files TEXT DEFAULT '[]'",
        [],
    )?;

    // Add excluded_directories column to semantic_indexes (workspace-specific)
    conn.execute(
        "ALTER TABLE semantic_indexes ADD COLUMN excluded_directories TEXT DEFAULT '[]'",
        [],
    )?;

    Ok(())
}

/// Migration v9: Cleanup NULL workspace_path entries in workspace_state table
/// These were incorrectly saved when no workspace was open, corrupting the "most recent" query
fn migration_v9(conn: &Connection) -> DbResult<()> {
    // Delete all workspace_state entries where workspace_path is NULL
    conn.execute(
        "DELETE FROM workspace_state WHERE workspace_path IS NULL",
        [],
    )?;

    Ok(())
}

/// Migration v10: Add checkpoints table and checkpoint_enabled to workspace_state
fn migration_v10(conn: &Connection) -> DbResult<()> {
    // Create checkpoints table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS checkpoints (
            id TEXT PRIMARY KEY,              -- Git commit hash
            message_id TEXT NOT NULL,         -- Associated message ID
            thread_id TEXT NOT NULL,          -- Thread this checkpoint belongs to
            workspace_path TEXT NOT NULL,     -- Workspace path
            created_at TEXT NOT NULL,
            UNIQUE(thread_id, message_id)
        )",
        [],
    )?;

    // Create indexes for quick lookup
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_checkpoints_thread_id
         ON checkpoints (thread_id)",
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_checkpoints_message_id
         ON checkpoints (message_id)",
        [],
    )?;

    // Add checkpoint_enabled column to workspace_state (default true = enabled)
    conn.execute(
        "ALTER TABLE workspace_state ADD COLUMN checkpoint_enabled INTEGER NOT NULL DEFAULT 1",
        [],
    )?;

    Ok(())
}

/// Migration v11: Add provider nicknames and model alias metadata
fn migration_v11(conn: &Connection) -> DbResult<()> {
    conn.execute("ALTER TABLE llm_providers ADD COLUMN nickname TEXT", [])?;

    conn.execute(
        "ALTER TABLE llm_providers ADD COLUMN model_aliases TEXT",
        [],
    )?;

    Ok(())
}

/// Migration v12: Drop legacy semantic search tables.
///
/// The semantic indexer was removed in 2026; this clears the storage and the
/// supporting indexes so a stale row can never leak back into the frontend.
fn migration_v12(conn: &Connection) -> DbResult<()> {
    conn.execute(
        "DROP INDEX IF EXISTS idx_semantic_indexes_workspace_path",
        [],
    )?;
    conn.execute("DROP TABLE IF EXISTS semantic_indexes", [])?;
    conn.execute("DROP TABLE IF EXISTS semantic_settings", [])?;
    Ok(())
}

/// Migration v13: Drop the legacy `threads` table.
///
/// Aurora's chat persistence moved to append-only JSONL message logs
/// under `<app_data>/agent_v2/` (see
/// `crate::agent_runtime::session_store::SessionStore`). The migration
/// is destructive — by product direction we are not back-filling old
/// SQLite rows into the new store. Reclaim the storage and the
/// supporting indexes.
fn migration_v13(conn: &Connection) -> DbResult<()> {
    conn.execute("DROP INDEX IF EXISTS idx_threads_created_at", [])?;
    conn.execute("DROP INDEX IF EXISTS idx_threads_updated_at", [])?;
    conn.execute("DROP TABLE IF EXISTS threads", [])?;
    Ok(())
}

/// Migration v15: Split per-model capabilities out of `llm_providers`
/// into a new `provider_models` table.
///
/// **Why**: vision/thinking/tool-stream and the context window are
/// per-model concerns. Storing them on the provider row meant
/// switching the active model didn't switch capabilities — e.g. the
/// same OpenAI provider held one `supports_vision` flag for both
/// GPT-4o and GPT-4o-mini, which is wrong.
///
/// **What it does**:
///  1. Creates `provider_models` if missing.
///  2. For every existing provider, expands its `customModels`
///     JSON array into one model row each (or just the `model`
///     column if the array is empty/null), copying `supports_vision`
///     and `supports_thinking` from the provider as the initial
///     capability values, and using `model_aliases` for the label.
///  3. Rebuilds `llm_providers` without the `supports_vision`,
///     `supports_thinking`, `custom_models`, and `model_aliases`
///     columns. SQLite needs the create-copy-drop-rename dance.
///
/// Idempotent: if `provider_models` already has rows for a provider
/// we skip the seed step for that provider; if the deprecated columns
/// are already gone we skip the rebuild.
fn migration_v15(conn: &Connection) -> DbResult<()> {
    use serde_json::Value;

    // ── Step 1: ensure provider_models exists ────────────────────────
    conn.execute(
        "CREATE TABLE IF NOT EXISTS provider_models (
            id TEXT PRIMARY KEY,
            provider_id TEXT NOT NULL,
            model_key TEXT NOT NULL,
            label TEXT,
            context_window INTEGER,
            max_output_tokens INTEGER,
            supports_vision INTEGER NOT NULL DEFAULT 0,
            supports_thinking INTEGER NOT NULL DEFAULT 0,
            supports_tool_stream INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(provider_id, model_key)
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_provider_models_provider
         ON provider_models (provider_id, sort_order ASC)",
        [],
    )?;

    // ── Step 2: detect which legacy columns we still need to read ────
    let legacy_columns: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(llm_providers)")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
        rows.flatten().collect()
    };
    let has_custom_models = legacy_columns.iter().any(|c| c == "custom_models");
    let has_model_aliases = legacy_columns.iter().any(|c| c == "model_aliases");
    let has_supports_vision = legacy_columns.iter().any(|c| c == "supports_vision");
    let has_supports_thinking = legacy_columns.iter().any(|c| c == "supports_thinking");
    let has_supports_tool_stream = legacy_columns.iter().any(|c| c == "supports_tool_stream");

    // ── Step 3: seed provider_models from existing rows ──────────────
    let now = chrono::Utc::now().to_rfc3339();
    let select_sql = format!(
        "SELECT id, model, {custom_models}, {model_aliases}, \
                {supports_vision}, {supports_thinking}, {supports_tool_stream} \
         FROM llm_providers",
        custom_models = if has_custom_models {
            "custom_models"
        } else {
            "NULL"
        },
        model_aliases = if has_model_aliases {
            "model_aliases"
        } else {
            "NULL"
        },
        supports_vision = if has_supports_vision {
            "supports_vision"
        } else {
            "0"
        },
        supports_thinking = if has_supports_thinking {
            "supports_thinking"
        } else {
            "0"
        },
        supports_tool_stream = if has_supports_tool_stream {
            "supports_tool_stream"
        } else {
            "0"
        },
    );

    struct LegacyRow {
        provider_id: String,
        primary_model: String,
        custom_models_json: Option<String>,
        model_aliases_json: Option<String>,
        supports_vision: i64,
        supports_thinking: i64,
        supports_tool_stream: i64,
    }

    let rows: Vec<LegacyRow> = {
        let mut stmt = conn.prepare(&select_sql)?;
        let iter = stmt.query_map([], |row| {
            Ok(LegacyRow {
                provider_id: row.get(0)?,
                primary_model: row.get(1)?,
                custom_models_json: row.get(2).ok(),
                model_aliases_json: row.get(3).ok(),
                supports_vision: row.get::<_, i64>(4).unwrap_or(0),
                supports_thinking: row.get::<_, i64>(5).unwrap_or(0),
                supports_tool_stream: row.get::<_, i64>(6).unwrap_or(0),
            })
        })?;
        iter.filter_map(|r| r.ok()).collect()
    };

    for row in &rows {
        // Collect model keys: customModels[] if present, else just `model`.
        let mut model_keys: Vec<String> = row
            .custom_models_json
            .as_deref()
            .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
            .unwrap_or_default()
            .into_iter()
            .filter(|s| !s.trim().is_empty())
            .collect();
        if model_keys.is_empty() && !row.primary_model.trim().is_empty() {
            model_keys.push(row.primary_model.clone());
        }
        // Dedupe while preserving order.
        let mut seen = std::collections::HashSet::new();
        model_keys.retain(|k| seen.insert(k.clone()));

        let aliases: serde_json::Map<String, Value> = row
            .model_aliases_json
            .as_deref()
            .and_then(|s| serde_json::from_str::<serde_json::Map<String, Value>>(s).ok())
            .unwrap_or_default();

        for (idx, model_key) in model_keys.iter().enumerate() {
            let row_id = format!("{}::{}", row.provider_id, model_key);
            let label = aliases
                .get(model_key)
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            // INSERT OR IGNORE so re-running the migration on a
            // partially-migrated DB is a no-op for already-seeded rows.
            conn.execute(
                "INSERT OR IGNORE INTO provider_models (
                    id, provider_id, model_key, label, context_window, max_output_tokens,
                    supports_vision, supports_thinking, supports_tool_stream,
                    enabled, sort_order, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, NULL, NULL, ?5, ?6, ?7, 1, ?8, ?9, ?9)",
                rusqlite::params![
                    row_id,
                    row.provider_id,
                    model_key,
                    label,
                    row.supports_vision,
                    row.supports_thinking,
                    row.supports_tool_stream,
                    idx as i64,
                    now,
                ],
            )?;
        }
    }

    // ── Step 4: rebuild llm_providers without deprecated columns ─────
    let needs_rebuild =
        has_custom_models || has_model_aliases || has_supports_vision || has_supports_thinking;

    if needs_rebuild {
        // SQLite < 3.35 lacks DROP COLUMN; even on newer versions the
        // create-copy-drop-rename dance is the safe, supported path.
        // Wrap in a transaction so a crash mid-rebuild doesn't strand
        // the DB with a half-renamed table.
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE llm_providers_new (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                nickname TEXT,
                base_url TEXT NOT NULL,
                api_key TEXT NOT NULL DEFAULT '',
                model TEXT NOT NULL,
                context_window INTEGER NOT NULL DEFAULT 128000,
                max_output_tokens INTEGER NOT NULL DEFAULT 16384,
                supports_tool_stream INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1,
                is_custom INTEGER NOT NULL DEFAULT 0,
                custom_headers TEXT,
                custom_params TEXT,
                provider_type TEXT,
                default_temperature REAL,
                default_max_tokens INTEGER,
                requires_api_key INTEGER NOT NULL DEFAULT 1,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             INSERT INTO llm_providers_new (
                id, name, nickname, base_url, api_key, model, context_window,
                max_output_tokens, supports_tool_stream, enabled, is_custom,
                custom_headers, custom_params, provider_type, default_temperature,
                default_max_tokens, requires_api_key, sort_order, created_at, updated_at
             )
             SELECT id, name, nickname, base_url, api_key, model, context_window,
                    max_output_tokens, supports_tool_stream, enabled, is_custom,
                    custom_headers, custom_params, provider_type, default_temperature,
                    default_max_tokens, requires_api_key, sort_order, created_at, updated_at
             FROM llm_providers;
             DROP INDEX IF EXISTS idx_llm_providers_sort;
             DROP TABLE llm_providers;
             ALTER TABLE llm_providers_new RENAME TO llm_providers;
             CREATE INDEX IF NOT EXISTS idx_llm_providers_sort
                ON llm_providers (sort_order ASC);
             COMMIT;",
        )?;
    }

    Ok(())
}

/// Migration v16: Add per-model pricing columns to `provider_models`.
///
/// Adds four nullable columns:
///   - `price_cache_hit_per_mtok REAL`   — USD per 1M cached input tokens
///   - `price_cache_miss_per_mtok REAL`  — USD per 1M fresh input tokens
///   - `price_output_per_mtok REAL`      — USD per 1M output tokens
///   - `price_currency TEXT`             — defaults to NULL = USD
///
/// After adding the columns, seeds the documented DeepSeek V4 prices
/// (per `deepseek.md`) on any existing rows so users who already had
/// DeepSeek configured don't have to re-enter them. Other providers
/// are left null; users opt in via the Model Editor.
///
/// Idempotent: column adds are guarded with a PRAGMA table_info sniff
/// so re-running the migration on a hand-patched DB is safe. The seed
/// step uses `WHERE price_cache_miss_per_mtok IS NULL` so it only
/// fills in rows that haven't been customized yet.
fn migration_v16(conn: &Connection) -> DbResult<()> {
    let existing: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(provider_models)")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
        rows.flatten().collect()
    };
    let needs = |col: &str| !existing.iter().any(|c| c == col);

    if needs("price_cache_hit_per_mtok") {
        conn.execute(
            "ALTER TABLE provider_models ADD COLUMN price_cache_hit_per_mtok REAL",
            [],
        )?;
    }
    if needs("price_cache_miss_per_mtok") {
        conn.execute(
            "ALTER TABLE provider_models ADD COLUMN price_cache_miss_per_mtok REAL",
            [],
        )?;
    }
    if needs("price_output_per_mtok") {
        conn.execute(
            "ALTER TABLE provider_models ADD COLUMN price_output_per_mtok REAL",
            [],
        )?;
    }
    if needs("price_currency") {
        conn.execute(
            "ALTER TABLE provider_models ADD COLUMN price_currency TEXT",
            [],
        )?;
    }

    // Seed DeepSeek V4 / V3 pricing (source: deepseek.md "Pricing"
    // section). These mirror the catalog defaults below, applied
    // **only** to rows that haven't been priced yet so re-running
    // the migration never clobbers user edits.
    //
    // Numbers are USD per 1M tokens. V4 Pro uses the post-discount
    // rate (75% off until DeepSeek raises it); list price is in the
    // catalog as a comment for traceability.
    let seeds: &[(&str, f64, f64, f64)] = &[
        // model_key,                cache_hit, cache_miss, output  (USD / 1M tok)
        ("deepseek-v4-pro", 0.003625, 0.435, 0.87),
        ("deepseek-v4-flash", 0.0028, 0.14, 0.28),
        // V3 family keeps its historical pricing; user can override.
        ("deepseek-chat", 0.07, 0.27, 1.10),
        ("deepseek-reasoner", 0.14, 0.55, 2.19),
    ];
    for (model_key, cache_hit, cache_miss, output) in seeds {
        conn.execute(
            "UPDATE provider_models
             SET price_cache_hit_per_mtok = ?1,
                 price_cache_miss_per_mtok = ?2,
                 price_output_per_mtok = ?3
             WHERE model_key = ?4
               AND price_cache_miss_per_mtok IS NULL",
            rusqlite::params![cache_hit, cache_miss, output, model_key],
        )?;
    }

    Ok(())
}

/// Migration v14: Add `supports_vision` column to `llm_providers`.
/// Defaults to `0` (no vision); the user opts in per-model via the
/// Vision-capable checkbox in provider settings. Used by the API
/// adapter to decide whether `<aurora_image>` markers in tool results
/// should be expanded into multimodal content blocks (Anthropic
/// `image` source / OpenAI-compat `image_url`) or stripped to a
/// placeholder.
fn migration_v14(conn: &Connection) -> DbResult<()> {
    // SQLite has no `IF NOT EXISTS` for `ALTER TABLE ADD COLUMN`, so
    // we sniff the column list first. This keeps the migration
    // idempotent for any user whose DB was hand-patched.
    let already_present: bool = {
        let mut stmt = conn.prepare("PRAGMA table_info(llm_providers)")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
        let mut found = false;
        for name in rows.flatten() {
            if name == "supports_vision" {
                found = true;
                break;
            }
        }
        found
    };
    if !already_present {
        conn.execute(
            "ALTER TABLE llm_providers ADD COLUMN supports_vision INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    Ok(())
}
