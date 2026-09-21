use super::*;
use crate::agent_runtime::session::Session;
use crate::agent_runtime::types::{ContentBlock, ConversationMessage};
use std::fs;

fn fixture() -> (tempfile::TempDir, Arc<UsageLedger>) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("aurora.db");
    let conn = Connection::open(&path).unwrap();
    schema::create(&conn).unwrap();
    drop(conn);
    let ledger = Arc::new(UsageLedger::open(&path, dir.path().into()).unwrap());
    (dir, ledger)
}

fn charged(model: Option<&str>, timestamp: i64) -> ConversationMessage {
    let mut message = ConversationMessage::assistant_with_usage(
        vec![ContentBlock::Text {
            text: "reply".into(),
        }],
        TokenUsage {
            input_tokens: 100,
            output_tokens: 20,
            cache_creation_input_tokens: Some(5),
            cache_read_input_tokens: Some(80),
            estimated: Some(true),
            cost_usd: Some(0.01),
        },
        timestamp,
    );
    message.model = model.map(str::to_owned);
    message
}

fn transcript(path: &Path, messages: &[ConversationMessage]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let lines: Vec<_> = messages
        .iter()
        .map(|m| serde_json::to_string(m).unwrap())
        .collect();
    fs::write(path, format!("{}\n", lines.join("\n"))).unwrap();
}

#[test]
fn historical_import_is_idempotent_across_layouts_restart_and_deletion() {
    let (dir, ledger) = fixture();
    let legacy = dir.path().join("sessions/old.jsonl");
    let project = dir.path().join("projects/p/new/conversation.jsonl");
    let chat = dir.path().join("Chats/chat/conversation.jsonl");
    transcript(
        &legacy,
        &[
            ConversationMessage::user_text("question", 1_700_000_000_000),
            charged(Some("provider:a"), 1_700_000_001_000),
        ],
    );
    // Even expired archives must be imported without calling the retention sweep.
    fs::write(
        legacy.with_file_name("old.meta.json"),
        r#"{"title":"Old","archivedAt":"2000-01-01T00:00:00Z"}"#,
    )
    .unwrap();
    transcript(&project, &[charged(Some("provider:b"), 1_700_000_002_000)]);
    transcript(&chat, &[charged(None, 1_700_000_003_000)]);
    let before = ledger.stats().unwrap();
    assert_eq!(before.total_requests, 3);
    assert_eq!(before.lifetime_input_tokens, 315);
    assert_eq!(before.lifetime_output_tokens, 60);
    assert_eq!(before.lifetime_cache_read_tokens, 240);
    assert_eq!(before.total_threads, 3);
    assert!(legacy.exists());
    assert_eq!(before.longest_task.unwrap().duration_ms, 1000);
    assert!(before
        .requests_by_provider
        .iter()
        .any(|p| p.provider_id.is_empty() && p.requests == 1));
    assert_eq!(ledger.stats().unwrap().total_requests, 3);
    // Re-import deliberately, not merely the unchanged-file fast path.
    ledger
        .connection()
        .unwrap()
        .execute("DELETE FROM usage_imports", [])
        .unwrap();
    assert_eq!(ledger.stats().unwrap().total_requests, 3);
    fs::remove_file(&legacy).unwrap();
    fs::remove_file(&project).unwrap();
    fs::remove_file(&chat).unwrap();
    drop(ledger);
    let reopened = UsageLedger::open(&dir.path().join("aurora.db"), dir.path().into()).unwrap();
    let after = reopened.stats().unwrap();
    assert_eq!(after.total_requests, 3);
    assert_eq!(after.lifetime_input_tokens, 315);
    assert_eq!(after.total_messages, 4);
}

#[test]
fn live_calls_survive_rewind_and_copies_do_not_create_usage() {
    let (dir, ledger) = fixture();
    let log = dir.path().join("projects/p/live/conversation.jsonl");
    let mut session = Session::new("live");
    session.usage_ledger = Some(ledger.clone());
    session.append_message(ConversationMessage::user_text(
        "question",
        1_700_000_000_000,
    ));
    let mut first = charged(Some("one:model-a"), 1_700_000_001_000);
    session.record_accounting(&mut first, false);
    session.append_message(first.clone());
    let second = charged(Some("two:model-b"), 1_700_000_002_000);
    session.append_message(second);
    transcript(&log, session.messages());
    let before = ledger.stats().unwrap();
    assert_eq!(before.total_requests, 2);
    assert_eq!(before.total_messages, 3);
    assert_eq!(before.top_models.len(), 2);
    transcript(
        &dir.path().join("Chats/copy/conversation.jsonl"),
        session.messages(),
    );
    assert_eq!(ledger.stats().unwrap().total_requests, 2);
    session.truncate_before_user_message(0);
    transcript(&log, session.messages());
    assert_eq!(ledger.stats().unwrap().total_requests, 2);
    // A newly charged retry is a new request, even with identical contents/time.
    session.append_message(charged(Some("one:model-a"), 1_700_000_001_000));
    assert_eq!(ledger.stats().unwrap().total_requests, 3);
    let conn = ledger.connection().unwrap();
    let cost: f64 = conn
        .query_row("SELECT SUM(cost_usd) FROM usage_events", [], |r| r.get(0))
        .unwrap();
    assert!((cost - 0.03).abs() < 1e-9);
}

#[test]
fn completed_but_discarded_response_still_counts() {
    let (_dir, ledger) = fixture();
    let mut session = Session::new("empty");
    session.usage_ledger = Some(ledger.clone());
    let mut response = charged(Some("p:m"), 1_700_000_000_000);
    response.blocks.clear();
    session.record_accounting(&mut response, false);
    let stats = ledger.stats().unwrap();
    assert_eq!(stats.total_requests, 1);
    assert_eq!(stats.total_messages, 0);
    assert!(session.is_empty());
}

#[test]
fn changed_source_imports_only_new_usage_and_metadata_is_not_counted() {
    let (dir, ledger) = fixture();
    let path = dir.path().join("sessions/a.jsonl");
    let first = charged(Some("p:a"), 1_700_000_000_000);
    transcript(&path, &[first.clone()]);
    fs::write(
        path.with_file_name("a.meta.json"),
        r#"{"model":"wrong:last-model","tokenUsage":{"promptTokens":9999999}}"#,
    )
    .unwrap();
    assert_eq!(ledger.stats().unwrap().total_requests, 1);
    transcript(&path, &[first, charged(Some("p:b"), 1_700_000_001_000)]);
    let stats = ledger.stats().unwrap();
    assert_eq!(stats.total_requests, 2);
    assert_eq!(stats.lifetime_input_tokens, 210);
    assert!(stats.top_models.iter().all(|m| m.name.starts_with("p:")));
}

#[test]
fn malformed_import_rolls_back_and_retries_after_repair() {
    let (dir, ledger) = fixture();
    let path = dir.path().join("sessions/broken.jsonl");
    let message = charged(Some("p:m"), 1_700_000_000_000);
    transcript(&path, &[message.clone()]);
    use std::io::Write;
    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"{broken\n")
        .unwrap();
    assert!(ledger.reconcile().is_err());
    let conn = ledger.connection().unwrap();
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM usage_events", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM usage_imports", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    drop(conn);
    transcript(&path, &[message]);
    assert_eq!(ledger.stats().unwrap().total_requests, 1);
}

#[test]
fn legacy_copies_are_deduplicated_but_identical_occurrences_are_preserved() {
    let (dir, ledger) = fixture();
    let message = charged(None, 1_700_000_000_000);
    transcript(
        &dir.path().join("sessions/original.jsonl"),
        &[message.clone(), message.clone()],
    );
    transcript(
        &dir.path().join("projects/p/copy/conversation.jsonl"),
        &[message.clone(), message],
    );
    assert_eq!(ledger.stats().unwrap().total_requests, 2);
}

#[test]
fn copying_a_legacy_conversation_through_the_real_store_keeps_its_usage_identity() {
    let (dir, ledger) = fixture();
    let store = crate::agent_runtime::session_store::SessionStore::new_project(
        dir.path().join("projects/p"),
    );
    store
        .ensure_thread("source", Some("Original".into()), Some("C:/project".into()))
        .unwrap();
    let mut raw = serde_json::to_value(charged(Some("p:m"), 1_700_000_000_000)).unwrap();
    raw["attached_selected_elements"] = serde_json::Value::Null;
    raw["event_id"] = serde_json::Value::Null;
    fs::write(store.session_path("source"), format!("{raw}\n")).unwrap();
    assert_eq!(ledger.stats().unwrap().total_requests, 1);
    store.duplicate("source", "copy", "Copy".into()).unwrap();
    assert_eq!(ledger.stats().unwrap().total_requests, 1);
}

#[test]
fn deletion_and_retention_preserve_usage_before_the_first_background_import() {
    let (dir, ledger) = fixture();
    let store =
        crate::agent_runtime::session_store::SessionStore::new_folder(dir.path().join("Chats"))
            .with_usage_ledger(Some(ledger.clone()));
    for (id, timestamp) in [
        ("deleted", 1_700_000_000_000),
        ("expired", 1_700_000_000_001),
    ] {
        store.ensure_thread(id, None, None).unwrap();
        transcript(&store.session_path(id), &[charged(Some("p:m"), timestamp)]);
    }
    let mut meta: serde_json::Value =
        serde_json::from_slice(&fs::read(store.meta_path("expired")).unwrap()).unwrap();
    meta["archivedAt"] = serde_json::json!("2020-01-01T00:00:00Z");
    fs::write(
        store.meta_path("expired"),
        serde_json::to_vec(&meta).unwrap(),
    )
    .unwrap();
    store.delete("deleted").unwrap();
    assert!(store.list_summaries().unwrap().is_empty());
    assert!(!store.session_path("expired").exists());
    assert_eq!(ledger.stats().unwrap().total_requests, 2);
}

#[test]
fn failed_preservation_leaves_the_transcript_available_for_repair() {
    let (dir, ledger) = fixture();
    let store =
        crate::agent_runtime::session_store::SessionStore::new_folder(dir.path().join("Chats"))
            .with_usage_ledger(Some(ledger));
    store.ensure_thread("damaged", None, None).unwrap();
    fs::write(store.session_path("damaged"), b"{broken\n").unwrap();
    assert!(store.delete("damaged").is_err());
    assert!(store.session_path("damaged").exists());
}

/// Explicit read-only source audit: the accounting database is always temporary.
#[test]
#[ignore = "requires AURORA_USAGE_VERIFY_ROOT; reads retained history into an isolated database"]
fn verify_retained_usage_in_isolated_database() {
    let source =
        PathBuf::from(std::env::var_os("AURORA_USAGE_VERIFY_ROOT").expect("explicit source root"));
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("usage-verification.db");
    schema::create(&Connection::open(&database).unwrap()).unwrap();
    let ledger = UsageLedger::open(&database, source.clone()).unwrap();
    let start = std::time::Instant::now();
    let first = ledger.stats().unwrap();
    let initial_ms = start.elapsed().as_millis();
    let start = std::time::Instant::now();
    let warm = ledger.stats().unwrap();
    println!("Isolated history import: threads={}, requests={}, input={}, output={}, cache_read={}, initial_ms={}, warm_ms={}",
        first.total_threads,first.total_requests,first.lifetime_input_tokens,first.lifetime_output_tokens,
        first.lifetime_cache_read_tokens,initial_ms,start.elapsed().as_millis());
    let conn = ledger.connection().unwrap();
    let audit:(i64,i64,i64,i64)=conn.query_row(
        "SELECT SUM(usage_count),SUM(input_tokens),SUM(output_tokens),SUM(cache_read_tokens) FROM usage_imports",[],
        |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
    println!(
        "Raw source audit before deduplication: requests={}, input={}, output={}, cache_read={}",
        audit.0, audit.1, audit.2, audit.3
    );
    assert_eq!(warm.total_requests, first.total_requests);
    assert_eq!(
        first
            .requests_by_provider
            .iter()
            .map(|p| p.requests)
            .sum::<u32>(),
        first.total_requests
    );
    conn.execute("DELETE FROM usage_imports", []).unwrap();
    drop(conn);
    let again = ledger.stats().unwrap();
    assert_eq!(again.total_requests, first.total_requests);
    assert_eq!(again.lifetime_input_tokens, first.lifetime_input_tokens);
    assert_eq!(again.lifetime_output_tokens, first.lifetime_output_tokens);
    drop(ledger);
    let reopened = UsageLedger::open(&database, source)
        .unwrap()
        .stats()
        .unwrap();
    assert_eq!(reopened.total_requests, first.total_requests);
}
