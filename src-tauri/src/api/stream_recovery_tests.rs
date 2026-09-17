//! Exercise the real wire parsers with failures at transport boundaries.

use futures_util::{stream, Stream, StreamExt};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::agent_runtime::api_client::{ApiError, TurnUsage};
use crate::agent_runtime::events::AssistantEvent;
use crate::agent_runtime::types::ContentBlock;

#[derive(Clone, Copy, Debug)]
enum Wire {
    Messages,
    Chat,
    Responses,
}

const WIRES: [Wire; 3] = [Wire::Messages, Wire::Chat, Wire::Responses];

impl Wire {
    fn text(self) -> &'static str {
        match self {
            Self::Messages => concat!(
                "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\"}}\n\n",
                "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"a complete answer\"}}\n\n"
            ),
            Self::Chat => "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"a complete answer\"}}]}\n\n",
            Self::Responses => "data: {\"type\":\"response.output_text.delta\",\"item_id\":\"m1\",\"delta\":\"a complete answer\"}\n\n",
        }
    }

    fn end(self) -> &'static str {
        match self {
            Self::Messages => "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n",
            Self::Chat => "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
            Self::Responses => "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":5,\"output_tokens\":3}}}\n\n",
        }
    }

    async fn drive<S>(
        self,
        bytes: S,
        tx: mpsc::Sender<AssistantEvent>,
        cancel: CancellationToken,
    ) -> Result<TurnUsage, ApiError>
    where
        S: Stream<Item = Result<Vec<u8>, &'static str>> + Send,
    {
        match self {
            Self::Messages => super::anthropic::drive_anthropic_stream(bytes, tx, cancel).await,
            Self::Chat => super::openai_compat::drive_openai_stream(bytes, tx, cancel).await,
            Self::Responses => super::responses::drive_responses_stream(bytes, tx, cancel).await,
        }
    }
}

#[tokio::test]
async fn a_transport_error_after_completion_keeps_the_answer() {
    for wire in WIRES {
        let (tx, mut rx) = mpsc::channel(64);
        let bytes = stream::iter([
            Ok(wire.text().as_bytes().to_vec()),
            Ok(wire.end().as_bytes().to_vec()),
            Err("connection reset after the terminal event"),
        ]);
        let turn = wire
            .drive(bytes, tx, CancellationToken::new())
            .await
            .unwrap_or_else(|err| panic!("{wire:?} discarded a completed answer: {err}"));
        assert!(turn
            .assistant_message
            .blocks
            .iter()
            .any(|block| matches!(block,
            ContentBlock::Text { text } if text == "a complete answer")));
        let mut stops = 0;
        while let Some(event) = rx.recv().await {
            if matches!(event, AssistantEvent::MessageStop { .. }) {
                stops += 1;
            }
        }
        assert_eq!(stops, 1, "{wire:?} must complete exactly once");
    }
}

#[tokio::test]
async fn clean_eof_between_content_events_is_not_completion() {
    for wire in WIRES {
        let (tx, mut rx) = mpsc::channel(64);
        let result = wire
            .drive(
                stream::iter([Ok(wire.text().as_bytes().to_vec())]),
                tx,
                CancellationToken::new(),
            )
            .await;
        assert!(
            matches!(result, Err(ApiError::Network(_))),
            "{wire:?} accepted a truncated reply: {result:?}"
        );
        while let Some(event) = rx.recv().await {
            assert!(!matches!(event, AssistantEvent::MessageStop { .. }));
        }
    }
}

#[tokio::test(start_paused = true)]
async fn completion_does_not_wait_for_the_server_to_close_the_socket() {
    for wire in WIRES {
        let (tx, _rx) = mpsc::channel(64);
        let bytes = stream::iter([Ok(format!("{}{}", wire.text(), wire.end()).into_bytes())])
            .chain(stream::pending());
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(10),
            wire.drive(bytes, tx, CancellationToken::new()),
        )
        .await;
        assert!(
            matches!(result, Ok(Ok(_))),
            "{wire:?} waited past its completion event: {result:?}"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn a_ten_millisecond_gap_between_chunks_preserves_every_byte() {
    for wire in WIRES {
        let body = format!("{}{}", wire.text(), wire.end());
        let chunks = body
            .as_bytes()
            .chunks(7)
            .map(|chunk| chunk.to_vec())
            .collect::<Vec<_>>();
        let bytes = stream::iter(chunks).then(|chunk| async move {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            Ok(chunk)
        });
        let (tx, _rx) = mpsc::channel(64);
        let turn = wire
            .drive(bytes, tx, CancellationToken::new())
            .await
            .unwrap();
        assert!(
            turn.assistant_message
                .blocks
                .iter()
                .any(|block| matches!(block,
            ContentBlock::Text { text } if text == "a complete answer")),
            "{wire:?}"
        );
    }
}

#[tokio::test]
async fn malformed_content_cannot_be_silently_skipped_before_completion() {
    for wire in WIRES {
        let (tx, _rx) = mpsc::channel(64);
        let bytes = stream::iter([Ok(format!(
            "{}data: {{broken json}}\n\n{}",
            wire.text(),
            wire.end()
        )
        .into_bytes())]);
        assert!(
            matches!(
                wire.drive(bytes, tx, CancellationToken::new()).await,
                Err(ApiError::Network(_))
            ),
            "{wire:?}"
        );
    }
}

#[tokio::test]
async fn running_usage_before_more_content_does_not_complete_chat() {
    let body = format!(
        "data: {{\"choices\":[],\"usage\":{{\"prompt_tokens\":5,\"completion_tokens\":1}}}}\n\n{}",
        Wire::Chat.text()
    );
    let (tx, _rx) = mpsc::channel(64);
    assert!(matches!(
        Wire::Chat
            .drive(
                stream::iter([Ok(body.into_bytes())]),
                tx,
                CancellationToken::new()
            )
            .await,
        Err(ApiError::Network(_))
    ));
}

#[tokio::test]
async fn a_local_http_disconnect_retries_the_same_request_and_persists_only_the_replacement() {
    use crate::agent_runtime::conversation::{ConversationRuntime, RuntimeConfig};
    use crate::agent_runtime::session::Session;
    use crate::agent_runtime::tool_executor::ToolRegistry;
    use crate::agent_runtime::types::{ConversationMessage, MessageRole};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let mut requests = Vec::new();
        for attempt in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let body_start = loop {
                let mut chunk = [0_u8; 4096];
                let count = socket.read(&mut chunk).await.unwrap();
                assert!(count > 0);
                request.extend_from_slice(&chunk[..count]);
                if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    break end + 4;
                }
            };
            let headers = String::from_utf8_lossy(&request[..body_start]);
            let content_length: usize = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().unwrap())
                })
                .unwrap();
            while request.len() < body_start + content_length {
                let mut chunk = [0_u8; 4096];
                let count = socket.read(&mut chunk).await.unwrap();
                assert!(count > 0);
                request.extend_from_slice(&chunk[..count]);
            }
            requests.push(request[body_start..body_start + content_length].to_vec());
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").await.unwrap();
            let body = if attempt == 0 {
                Wire::Messages
                    .text()
                    .replace("a complete answer", "abandoned fragment")
            } else {
                format!("{}{}", Wire::Messages.text(), Wire::Messages.end())
            };
            let trailer = if attempt == 1 { "0\r\n\r\n" } else { "" };
            socket
                .write_all(format!("{:x}\r\n{body}\r\n{trailer}", body.len()).as_bytes())
                .await
                .unwrap();
            socket.flush().await.unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            // First response loses the HTTP chunked-body terminator, producing
            // reqwest's real body-read error. The replacement closes normally.
            socket.shutdown().await.unwrap();
        }
        requests
    });
    let config = serde_json::from_value(serde_json::json!({
        "providerId": "modal", "providerType": "modal-messages", "baseUrl": base_url,
        "model": "retry-test", "apiKey": "local-fixture"
    }))
    .unwrap();
    let client = super::anthropic::AnthropicAdapter::with_http_client(
        config,
        reqwest::Client::builder().no_proxy().build().unwrap(),
    );
    let runtime = ConversationRuntime::new(
        Arc::new(client),
        Arc::new(ToolRegistry::new()),
        RuntimeConfig::default(),
    );
    let mut session = Session::new("retry-local-http");
    let directory = tempfile::tempdir().unwrap();
    let journal_path = directory.path().join("session.jsonl");
    session.attach_journal(&journal_path, 0);
    session.model = Some("modal:retry-test".into());
    let user: ConversationMessage = serde_json::from_value(serde_json::json!({
        "role": "user", "blocks": [{"type": "text", "text": "answer completely"}], "timestamp": 1
    }))
    .unwrap();
    let (tx, mut rx) = mpsc::channel(64);
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        runtime.run_turn(&mut session, user, tx, CancellationToken::new()),
    )
    .await
    .unwrap()
    .unwrap();
    let requests = server.await.unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0], requests[1],
        "retry must preserve history, model, and request configuration"
    );
    let replies = session
        .messages()
        .iter()
        .filter(|m| m.role == MessageRole::Assistant)
        .collect::<Vec<_>>();
    assert_eq!(replies.len(), 1);
    assert!(
        matches!(&replies[0].blocks[0], ContentBlock::Text { text } if text == "a complete answer")
    );
    let persisted = std::fs::read_to_string(&journal_path).unwrap();
    assert!(!persisted.contains("abandoned fragment"));
    let saved: Vec<ConversationMessage> = persisted
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        saved
            .iter()
            .filter(|message| message.role == MessageRole::Assistant)
            .count(),
        1
    );
    assert!(saved
        .iter()
        .flat_map(|message| &message.blocks)
        .any(|block| matches!(block, ContentBlock::Text { text } if text == "a complete answer")));
    let mut flow = Vec::new();
    while let Some(envelope) = rx.recv().await {
        match envelope.event {
            AssistantEvent::StreamAttemptStarted => flow.push("start"),
            AssistantEvent::PartialReplyDiscarded { .. } => flow.push("discard"),
            AssistantEvent::TextDelta { .. } => flow.push("text"),
            _ => {}
        }
    }
    assert_eq!(flow, ["start", "text", "discard", "start", "text"]);
}
