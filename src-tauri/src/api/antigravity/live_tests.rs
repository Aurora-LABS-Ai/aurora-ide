//! Live checks against the real Antigravity backend. Ignored by default:
//! they need Antigravity IDE signed in on this machine and spend a few
//! requests of that account's quota.
//!
//! ```text
//! cargo test --lib antigravity::live_tests -- --ignored --nocapture
//! ```
//!
//! The IDE's sign-in is read the same way Import reads it, but nothing is
//! saved: Aurora's account list is never touched. What runs is Aurora's own
//! request builder and stream reader, with Aurora's real native tool list, so
//! a schema Gemini refuses or a signature it rejects fails here first.

use std::sync::Arc;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::agent_runtime::api_client::{ApiRequest, ReasoningRequest, ToolChoice, TurnUsage};
use crate::agent_runtime::tool_executor::ToolRegistry;
use crate::agent_runtime::types::{ContentBlock, ConversationMessage, MessageRole};

use super::adapter::stream_url;
use super::auth::{
    fetch_userinfo, ide_state_db, read_ide_token_value, refresh_grant,
    refresh_token_from_ide_value, resolve_project,
};
use super::stream::drive_antigravity_stream;
use super::user_agent;
use super::wire::{build_request_body, WireContext};

/// An 8×8 solid red PNG. A 1×1 pixel is too small: Claude reported "no
/// picture" for one that did arrive.
const RED_SQUARE: &str = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";

async fn session() -> (String, String) {
    let path = ide_state_db().expect("state db path");
    let value = read_ide_token_value(&path).expect("IDE signed in");
    let refresh = refresh_token_from_ide_value(&value).expect("refresh token");
    let tokens = refresh_grant(&refresh).await.expect("refresh");
    let project = resolve_project(&tokens.access_token)
        .await
        .expect("project")
        .project_id
        .expect("project id");
    (tokens.access_token, project)
}

async fn call(
    token: &str,
    project: &str,
    model: &str,
    messages: &[ConversationMessage],
    tools: &[crate::agent_runtime::api_client::ToolSchema],
    thinking: bool,
) -> TurnUsage {
    let request = ApiRequest {
        model,
        system_prompt: Some(
            "You are Aurora, a coding agent. Follow the user's tool instructions exactly.",
        ),
        messages,
        tools,
        tool_choice: ToolChoice::Auto,
        temperature: None,
        max_output_tokens: 16_000,
        reasoning: ReasoningRequest {
            enabled: thinking,
            ..ReasoningRequest::disabled()
        },
        tool_bridge: None,
        session_key: Some("aurora-live-test"),
    };
    let body = build_request_body(
        &request,
        &WireContext {
            model,
            project_id: project,
            supports_vision: true,
            supports_thinking: true,
            default_temperature: None,
        },
    );
    let started = std::time::Instant::now();
    let response = reqwest::Client::new()
        .post(stream_url())
        .bearer_auth(token)
        .header(reqwest::header::USER_AGENT, user_agent())
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .json(&body)
        .send()
        .await
        .expect("send");
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        panic!("{model}: HTTP {status}: {text}");
    }
    let (tx, mut rx) = mpsc::channel(1024);
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let stream = futures_util::StreamExt::map(response.bytes_stream(), |c| {
        c.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
    });
    let turn = drive_antigravity_stream(stream, tx, CancellationToken::new(), tools)
        .await
        .unwrap_or_else(|e| panic!("{model}: stream failed: {e}"));
    let _ = drain.await;
    let kinds: Vec<String> = turn
        .assistant_message
        .blocks
        .iter()
        .map(|b| match b {
            ContentBlock::Text { text } => {
                format!("text({})", text.chars().take(80).collect::<String>())
            }
            ContentBlock::Thinking {
                text, signature, ..
            } => {
                format!(
                    "thinking({} chars, signed: {})",
                    text.len(),
                    signature.is_some()
                )
            }
            ContentBlock::ToolUse { name, input, .. } => format!("tool({name} {input})"),
            other => format!("{other:?}"),
        })
        .collect();
    println!(
        "{model}: {:?} in {:.1}s, stop {}, usage in {} out {}\n  {}",
        status,
        started.elapsed().as_secs_f32(),
        turn.stop_reason,
        turn.usage.input_tokens,
        turn.usage.output_tokens,
        kinds.join("\n  ")
    );
    turn
}

async fn tool_loop(model: &str, thinking: bool) {
    let (token, project) = session().await;
    let registry = ToolRegistry::new();
    crate::tools::register_builtin_tools(
        &registry,
        Arc::new(crate::tools::shell_editor_todo::NoopIdeEventSink),
        None,
    );
    let tools = registry.schemas();
    println!("{} native tools declared", tools.len());

    let mut messages = vec![ConversationMessage::user_text(
        "Call the file_read tool on README.md. After you see the result, reply with the first word of the file and the colour of the picture that came back with it.",
        0,
    )];
    let first = call(&token, &project, model, &messages, &tools, thinking).await;
    assert_eq!(first.stop_reason, "tool_use", "{model} should call a tool");
    let call_id = first
        .assistant_message
        .blocks
        .iter()
        .find_map(|b| match b {
            ContentBlock::ToolUse { id, name, .. } if name == "file_read" => Some(id.clone()),
            _ => None,
        })
        .expect("a file_read call");

    messages.push(first.assistant_message);
    messages.push(ConversationMessage {
        role: MessageRole::Tool,
        blocks: vec![ContentBlock::ToolResult {
            tool_use_id: call_id,
            content: format!(
                "1\tAurora is an agentic code editor.\n<aurora_image media_type=\"image/png\">{RED_SQUARE}</aurora_image>"
            ),
            is_error: None,
        }],
        ..ConversationMessage::user_text("", 0)
    });
    let second = call(&token, &project, model, &messages, &tools, thinking).await;
    let answer: String = second
        .assistant_message
        .blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert!(answer.contains("Aurora"), "{model} answered: {answer}");
    assert!(
        answer.to_lowercase().contains("red"),
        "{model} did not see the picture: {answer}"
    );
}

/// What Import reads about the account, short of saving it.
#[tokio::test]
#[ignore = "live: needs Antigravity IDE signed in"]
async fn import_reads_who_the_account_is_and_its_plan() {
    let (token, _) = session().await;
    let info = fetch_userinfo(&token).await.expect("userinfo");
    let id = info
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let email = info
        .get("email")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    assert!(!id.is_empty(), "Google account id missing");
    assert!(email.contains('@'), "email missing");
    let plan = resolve_project(&token).await.expect("project");
    println!(
        "account id {} chars, email present, tier {:?} / {:?}",
        id.len(),
        plan.tier_id,
        plan.tier_name
    );
}

/// The quota the card and ring read, for the MAIN account stored in Aurora
/// (refreshing its token is the only write, the same one any chat makes).
#[tokio::test]
#[ignore = "live: needs an Antigravity account signed in to Aurora"]
async fn the_main_account_quota_lists_its_groups_and_windows() {
    let q = super::quota::fetch_quota().await.expect("quota");
    println!("plan {:?}", q.plan);
    for g in &q.groups {
        for b in &g.buckets {
            println!("  {:<24} {:<8} {:>6.1}% left  resets {:?}", g.name, b.window, b.remaining_percent, b.resets_at);
        }
    }
    assert!(!q.groups.is_empty());
}

/// The MAIN account's list as the picker gets it. Gemini 4 Argon is listed
/// only to the desktop app's user agent (2026-10-16, Google AI Pro); an `ide`
/// agent drops it and this fails.
#[tokio::test]
#[ignore = "live: needs a paid Antigravity account signed in to Aurora"]
async fn the_main_account_is_offered_gemini_4_argon() {
    let cat = super::models::fetch_catalogue().await.expect("catalogue");
    let ids: Vec<&str> = cat.models.iter().map(|m| m.id.as_str()).collect();
    println!("{ids:?}");
    assert!(ids.iter().any(|id| id.starts_with("gemini-4-argon")), "{ids:?}");
}

/// The model list the card and picker read.
#[tokio::test]
#[ignore = "live: needs Antigravity IDE signed in"]
async fn the_account_lists_its_picker_models_with_quota() {
    let (access_token, project_id) = session().await;
    let access = super::auth::AntigravityAccess {
        account_id: "live".into(),
        access_token,
        project_id,
    };
    let cat = super::models::fetch_with(&access).await.expect("catalogue");
    for m in &cat.models {
        println!(
            "{:<28} {:<32} ctx {:?} out {:?} img {} think {} left {:?}% {}",
            m.id,
            m.label,
            m.context_window,
            m.max_output_tokens,
            m.supports_images,
            m.supports_thinking,
            m.remaining_percent.map(|p| p.round()),
            m.notice_title.as_deref().unwrap_or("")
        );
    }
    assert!(cat.models.len() >= 5, "only {} models", cat.models.len());
    assert!(cat.models.iter().all(|m| !m.id.starts_with("chat_") && !m.id.starts_with("tab_")));
    assert!(cat.models.iter().any(|m| m.id.contains("claude")));
}

#[tokio::test]
#[ignore = "live: needs Antigravity IDE signed in, spends quota"]
async fn gemini_tool_loop_with_aurora_tools() {
    tool_loop("gemini-3.8-flash-medium", false).await;
}

#[tokio::test]
#[ignore = "live: needs Antigravity IDE signed in, spends quota"]
async fn gemini_pro_tool_loop_with_thinking() {
    tool_loop("gemini-3.1-pro-low", true).await;
}

#[tokio::test]
#[ignore = "live: needs Antigravity IDE signed in, spends quota"]
async fn claude_tool_loop_with_thinking() {
    tool_loop("claude-sonnet-4-6", true).await;
}
