//! Live checks against a real provider. Ignored by default; they need a key
//! and a real conversation file, both passed in the environment so neither is
//! ever written into the repository:
//!
//! ```text
//! SUGGEST_LIVE_KEY=…  SUGGEST_LIVE_BASE_URL=https://api.minimax.io/anthropic/v1 \
//! SUGGEST_LIVE_TYPE=minimax SUGGEST_LIVE_MODEL=MiniMax-M3 \
//! SUGGEST_LIVE_CONVERSATION=…/conversation.jsonl \
//! cargo test --lib reply_suggest::live_tests -- --ignored --nocapture
//! ```

use super::*;
use crate::agent_runtime::session::Session;

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} must be set for this live test"))
}

/// `SUGGEST_LIVE_CHAT=1` runs the conversation as an Aurora Chat one.
fn is_chat() -> bool {
    std::env::var("SUGGEST_LIVE_CHAT").is_ok_and(|v| v == "1")
}

fn config() -> (ProviderConfigSnapshot, String) {
    let model = env("SUGGEST_LIVE_MODEL");
    let config: ProviderConfigSnapshot = serde_json::from_value(json!({
        "providerId": env("SUGGEST_LIVE_TYPE"),
        "providerType": env("SUGGEST_LIVE_TYPE"),
        "baseUrl": env("SUGGEST_LIVE_BASE_URL"),
        "apiKey": env("SUGGEST_LIVE_KEY"),
        "model": model,
        // As a configured thinking model is in the app. Without it the
        // adapters never send a thinking request, whatever the run asks for.
        "supportsThinking": true,
    }))
    .expect("a provider config");
    (config, model)
}

/// A real conversation through a real model: suggestions come back through the
/// tool, every part of the run is logged, and a second run, after an outcome
/// was recorded, reads that outcome as an example.
#[tokio::test]
#[ignore = "needs a provider key and a conversation file"]
async fn a_real_conversation_gets_suggestions_through_the_tool_and_is_logged() {
    let (config, model) = config();
    let path = std::path::PathBuf::from(env("SUGGEST_LIVE_CONVERSATION"));
    let session = Session::load_from_path("live".to_string(), &path).expect("the conversation loads");
    let messages = session.messages().to_vec();

    let dir = tempfile::tempdir().unwrap();
    let thread_dir = dir.path().join("live");

    let first = run_cloud(
        &config,
        &model,
        RunContext {
            run_id: "live-1",
            thread_id: "live",
            thread_dir: &thread_dir,
            project_dir: dir.path(),
            messages: &messages,
            think: false,
            chat: is_chat(),
        },
    )
    .await;
    log::write_run(&thread_dir, &first.record).unwrap();
    report("first run", &first);
    assert!(first.record.error.is_none(), "run failed: {:?}", first.record.error);
    assert!(!first.suggestions.is_empty());

    // The developer ignores the chips and types their own: the next run must
    // see that as an example.
    log::write_outcome(
        &thread_dir,
        dir.path(),
        "live",
        log::OutcomeInput {
            run_id: "live-1".into(),
            shown: first.suggestions.clone(),
            action: "typed".into(),
            tapped_index: None,
            sent_text: "go ahead and fix everything you found, don't ask me".into(),
        },
    )
    .unwrap();

    let second = run_cloud(
        &config,
        &model,
        RunContext {
            run_id: "live-2",
            thread_id: "live",
            thread_dir: &thread_dir,
            project_dir: dir.path(),
            messages: &messages,
            think: false,
            chat: is_chat(),
        },
    )
    .await;
    log::write_run(&thread_dir, &second.record).unwrap();
    report("second run (after one ignored set)", &second);
    assert!(second.record.input.contains("<past_suggestions>"));
    assert_eq!(second.record.brief.as_ref().unwrap().past_outcomes, 1);

    let logged = std::fs::read_to_string(thread_dir.join(log::RUN_LOG)).unwrap();
    assert_eq!(logged.lines().count(), 3, "two runs and one outcome");
}

/// The same conversation with thinking requested and not, to see what
/// thinking buys and what it costs.
#[tokio::test]
#[ignore = "needs a provider key and a conversation file"]
async fn thinking_on_and_off_on_the_same_conversation() {
    let (config, model) = config();
    let path = std::path::PathBuf::from(env("SUGGEST_LIVE_CONVERSATION"));
    let session = Session::load_from_path("live".to_string(), &path).expect("the conversation loads");
    let messages = session.messages().to_vec();
    let dir = tempfile::tempdir().unwrap();
    let thread_dir = dir.path().join("live");

    for think in [false, true] {
        let run = run_cloud(
            &config,
            &model,
            RunContext {
                run_id: if think { "think-on" } else { "think-off" },
                thread_id: "live",
                thread_dir: &thread_dir,
                project_dir: dir.path(),
                messages: &messages,
                think,
                chat: is_chat(),
            },
        )
        .await;
        report(if think { "thinking ON" } else { "thinking OFF" }, &run);
        assert!(run.record.thinking_requested == think);
    }
}

fn report(label: &str, run: &CloudRun) {
    let r = &run.record;
    println!("\n=== {label} ===");
    println!("model {} · {} ms · via {} · stop {:?}", r.model, r.latency_ms, r.answered_via, r.stop_reason);
    println!("input {} chars · brief {:?}", r.input_chars, r.brief);
    println!("usage {}", r.usage.as_ref().map_or_else(|| "-".into(), Value::to_string));
    if !r.thinking.is_empty() {
        let t: String = r.thinking.chars().take(600).collect();
        println!("thinking ({} chars): {t}…", r.thinking.chars().count());
    }
    if !r.raw_text.is_empty() {
        println!("text: {}", r.raw_text);
    }
    println!("tool input: {}", r.tool_input.as_ref().map_or_else(|| "-".into(), Value::to_string));
    for (i, s) in run.suggestions.iter().enumerate() {
        println!("  {}. {s}", i + 1);
    }
    if let Some(err) = &r.error {
        println!("error: {err}");
    }
}
