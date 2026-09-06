use super::*;
use crate::tools::permissions::{MockPermitter, PermissionGuardedExecutor};
use crate::tools::timeout::{TimeoutGuardedExecutor, TimeoutPolicy};
use serde_json::json;

#[test]
fn compaction_recap_keeps_each_optional_operation_and_its_wrapper() {
    let messages = vec![
        assistant_tool_use(
            "a",
            "call_tool",
            json!({"name":"browser_navigate","arguments":{"url":"https://example.test"}}),
        ),
        assistant_tool_use(
            "b",
            "call_tool",
            json!({"name":"mcp_docs_search","arguments":{"query":"release"}}),
        ),
    ];
    let recap = tool_usage_recap(&messages).unwrap();
    assert!(recap.contains("browser_navigate"));
    assert!(recap.contains("mcp_docs_search"));
    assert_eq!(recap.matches("call_tool(").count(), 2);
}

#[tokio::test]
async fn wrapped_calls_preserve_provider_history_and_emit_target_events() {
    let input = json!({"name":"browser_navigate","arguments":{"url":"https://example.test"}});
    let api = Arc::new(MockApi::new(vec![
        TurnScript {
            events: vec![],
            result: Ok(turn_usage(
                assistant_tool_use("provider-id", "call_tool", input.clone()),
                "tool_use",
            )),
        },
        TurnScript {
            events: vec![],
            result: Ok(turn_usage(assistant_text("done"), "end_turn")),
        },
    ]));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let tools = Arc::new(ToolRegistry::new());
    crate::tools::tool_search::install(
        &tools,
        vec![Arc::new(RecordingTool {
            name: "browser_navigate",
            seen: seen.clone(),
            response: "opened".into(),
        })],
    );
    let runtime = ConversationRuntime::new(api, tools, RuntimeConfig::default());
    let mut session = Session::new("discovery-history");
    let (tx, mut rx) = mpsc::channel(64);
    runtime
        .run_turn(
            &mut session,
            user_msg("open the page"),
            tx,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(*seen.lock().unwrap(), vec![input["arguments"].clone()]);
    assert!(unanswered_tool_use_ids(&session).is_empty());
    let call = session
        .messages()
        .iter()
        .flat_map(|m| &m.blocks)
        .find(|b| matches!(b, ContentBlock::ToolUse { .. }))
        .unwrap();
    assert!(
        matches!(call, ContentBlock::ToolUse {id,name,input:stored} if id == "provider-id" && name == "call_tool" && stored == &input)
    );
    // JSONL uses the same serialized message shape; replay must not invent a
    // native tool_use for a name absent from the provider's tool definitions.
    let encoded = serde_json::to_string(session.messages()).unwrap();
    let decoded: Vec<ConversationMessage> = serde_json::from_str(&encoded).unwrap();
    assert!(decoded
        .iter()
        .flat_map(|m| &m.blocks)
        .any(|b| matches!(b, ContentBlock::ToolUse { name, .. } if name == "call_tool")));
    let mut starts = 0;
    let mut results = 0;
    while let Ok(event) = rx.try_recv() {
        match event.event {
            AssistantEvent::ToolExecutionStart {
                id,
                name,
                input: args,
            } => {
                assert_eq!(id, "provider-id");
                assert_eq!(name, "browser_navigate");
                assert_eq!(args, input["arguments"]);
                starts += 1;
            }
            AssistantEvent::ToolExecutionResult {
                id, name, is_error, ..
            } => {
                assert_eq!(id, "provider-id");
                assert_eq!(name, "browser_navigate");
                assert!(!is_error);
                results += 1;
            }
            _ => {}
        }
    }
    assert_eq!((starts, results), (1, 1));
}

#[tokio::test]
async fn wrapped_permission_gate_uses_target_arguments_and_original_id() {
    for granted in [false, true] {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let permitter = Arc::new(if granted {
            MockPermitter::granting()
        } else {
            MockPermitter::denying()
        });
        let tools = Arc::new(ToolRegistry::new());
        crate::tools::tool_search::install(
            &tools,
            vec![Arc::new(PermissionGuardedExecutor::new(
                Arc::new(RecordingTool {
                    name: "browser_navigate",
                    seen: seen.clone(),
                    response: "ok".into(),
                }),
                permitter.clone(),
            ))],
        );
        let runtime = ConversationRuntime::new(
            Arc::new(MockApi::new(vec![])),
            tools,
            RuntimeConfig::default(),
        );
        let calls = vec![PendingToolCall {
            id: "original-id".into(),
            name: "call_tool".into(),
            input: json!({"name":"browser_navigate","arguments":{"url":"https://example.test"}}),
        }];
        let (tx, _rx) = mpsc::channel(64);
        let batch = runtime
            .execute_tool_calls(
                calls,
                &Session::new("t"),
                "turn-1",
                &CancellationToken::new(),
                &tx,
                &mut 0,
            )
            .await
            .unwrap();
        assert_eq!(seen.lock().unwrap().len(), usize::from(granted));
        assert_eq!(permitter.call_count(), 1);
        let approved = permitter.last_call().unwrap();
        assert_eq!(approved.tool_name, "browser_navigate");
        assert_eq!(approved.tool_use_id, "original-id");
        assert_eq!(approved.input, json!({"url":"https://example.test"}));
        assert!(
            matches!(&batch.message.blocks[0],ContentBlock::ToolResult {is_error,..} if is_error.unwrap_or(false) == !granted)
        );
    }
}

#[tokio::test]
async fn wrapped_timeout_is_still_enforced() {
    let tools = Arc::new(ToolRegistry::new());
    crate::tools::tool_search::install(
        &tools,
        vec![Arc::new(TimeoutGuardedExecutor::new(
            Arc::new(GateTool {
                name: "mcp_slow",
                concurrent: true,
                entered: Arc::new(tokio::sync::Semaphore::new(0)),
                release: Arc::new(tokio::sync::Notify::new()),
            }),
            TimeoutPolicy::new(10, 1, 100, "Try again with a narrower request."),
        ))],
    );
    let runtime = ConversationRuntime::new(
        Arc::new(MockApi::new(vec![])),
        tools,
        RuntimeConfig::default(),
    );
    let (tx, _rx) = mpsc::channel(64);
    let calls = vec![PendingToolCall {
        id: "slow-id".into(),
        name: "call_tool".into(),
        input: json!({"name":"mcp_slow","arguments":{}}),
    }];
    let batch = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        runtime.execute_tool_calls(
            calls,
            &Session::new("t"),
            "turn-1",
            &CancellationToken::new(),
            &tx,
            &mut 0,
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        matches!(&batch.message.blocks[0],ContentBlock::ToolResult{tool_use_id,is_error:Some(true),content} if tool_use_id == "slow-id" && content.contains("was abandoned")),
        "{:?}",
        batch.message.blocks
    );
}

#[tokio::test]
async fn wrapped_concurrent_reads_overlap_and_keep_result_order() {
    let entered = Arc::new(tokio::sync::Semaphore::new(0));
    let release = Arc::new(tokio::sync::Notify::new());
    let tools = Arc::new(ToolRegistry::new());
    crate::tools::tool_search::install(
        &tools,
        vec![Arc::new(GateTool {
            name: "mcp_reader",
            concurrent: true,
            entered: entered.clone(),
            release: release.clone(),
        })],
    );
    let runtime = ConversationRuntime::new(
        Arc::new(MockApi::new(vec![])),
        tools,
        RuntimeConfig::default(),
    );
    let calls = (0..3)
        .map(|i| PendingToolCall {
            id: format!("call-{i}"),
            name: "call_tool".into(),
            input: json!({"name":"mcp_reader","arguments":{}}),
        })
        .collect();
    let waiter = tokio::spawn(async move {
        let _permit = entered.acquire_many(3).await.unwrap();
        release.notify_waiters();
    });
    let (tx, _rx) = mpsc::channel(64);
    let batch = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        runtime.execute_tool_calls(
            calls,
            &Session::new("t"),
            "turn-1",
            &CancellationToken::new(),
            &tx,
            &mut 0,
        ),
    )
    .await
    .unwrap()
    .unwrap();
    waiter.await.unwrap();
    for (i, block) in batch.message.blocks.iter().enumerate() {
        assert!(
            matches!(block,ContentBlock::ToolResult{tool_use_id,..} if tool_use_id == &format!("call-{i}"))
        );
    }
}

#[tokio::test]
async fn stopping_before_a_wrapped_call_answers_it_without_execution() {
    let api = Arc::new(CancelWhileStreamingApi {
        message: Mutex::new(Some(assistant_tool_use(
            "stopped-id",
            "call_tool",
            json!({"name":"browser_navigate","arguments":{}}),
        ))),
    });
    let tools = Arc::new(ToolRegistry::new());
    let seen = Arc::new(Mutex::new(Vec::new()));
    crate::tools::tool_search::install(
        &tools,
        vec![Arc::new(RecordingTool {
            name: "browser_navigate",
            seen: seen.clone(),
            response: "ok".into(),
        })],
    );
    let runtime = ConversationRuntime::new(api, tools, RuntimeConfig::default());
    let (tx, _rx) = mpsc::channel(64);
    let mut session = Session::new("t");
    assert!(matches!(
        runtime
            .run_turn(&mut session, user_msg("go"), tx, CancellationToken::new())
            .await,
        Err(RuntimeError::Cancelled)
    ));
    assert!(seen.lock().unwrap().is_empty());
    assert!(unanswered_tool_use_ids(&session).is_empty());
}

#[tokio::test]
async fn discovery_schema_above_generic_result_limit_reaches_history_intact() {
    let result=json!({"tools":[{"name":"mcp_large","description":"x".repeat(12_000),"parameters":{"type":"object","required":["last_field"]}}]}).to_string();
    assert_eq!(truncate_tool_content("tool_search", result.clone()), result);
}
