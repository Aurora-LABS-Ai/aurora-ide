//! Durable accounting tables. These are never cleared with conversation history.

pub fn create(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS usage_events (
            event_id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL,
            timestamp_ms INTEGER NOT NULL,
            role TEXT NOT NULL,
            visible_message INTEGER NOT NULL,
            provider_id TEXT NOT NULL,
            model TEXT NOT NULL,
            has_usage INTEGER NOT NULL,
            input_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL,
            cache_write_tokens INTEGER NOT NULL,
            cache_read_tokens INTEGER NOT NULL,
            estimated INTEGER NOT NULL,
            cost_usd REAL,
            tools_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS usage_events_thread_time
            ON usage_events(thread_id, timestamp_ms);
        CREATE INDEX IF NOT EXISTS usage_events_provider_model
            ON usage_events(provider_id, model);
        CREATE TABLE IF NOT EXISTS usage_threads (
            thread_id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            workspace_root TEXT,
            surface TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS usage_imports (
            source_path TEXT PRIMARY KEY,
            fingerprint TEXT NOT NULL,
            message_count INTEGER NOT NULL,
            usage_count INTEGER NOT NULL,
            input_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL,
            cache_read_tokens INTEGER NOT NULL
        );",
    )
}
