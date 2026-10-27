use super::subagents::{
    parent_turn, scripted_host, spawn, submit_reply, submits, text_reply, wait_until_done,
};
use super::*;
use crate::agent_runtime::subagents::host::{SendOutcome, SpawnOutcome, SubagentHost};
use crate::agent_runtime::subagents::messaging::ParentMessageKind;
use crate::agent_runtime::subagents::record::TaskStatus;
use crate::agent_runtime::subagents::store::{child_store_for, AgentSidecar};

struct MessagingSpy {
    api: Arc<MockApi>,
    rosters: StdMutex<Vec<Vec<String>>>,
}

#[async_trait]
impl StreamingApiClient for MessagingSpy {
    async fn stream(
        &self,
        request: ApiRequest<'_>,
        sink: mpsc::Sender<AssistantEvent>,
        cancel: CancellationToken,
    ) -> Result<TurnUsage, ApiError> {
        self.rosters
            .lock()
            .unwrap()
            .push(request.tools.iter().map(|t| t.name.clone()).collect());
        self.api.stream(request, sink, cancel).await
    }
}

#[tokio::test]
async fn thanks_gets_one_reply_and_preserves_the_work_report_live_and_after_reload() {
    for reload in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let api = Arc::new(MockApi::new(
            submits("s1", "ORIGINAL WORK")
                .into_iter()
                .chain([text_reply("Thank you. No further work needed.")])
                .collect(),
        ));
        let spy = Arc::new(MessagingSpy {
            api: api.clone(),
            rosters: StdMutex::new(Vec::new()),
        });
        let registry = Arc::new(AgentRegistry::new(
            Arc::new(FixedFactory(spy.clone())),
            dir.path().into(),
        ));
        let (host, _catalog) = scripted_host(Arc::new(MockEmitter::default()), registry.clone());
        let parent = parent_turn(&registry, make_request("p", "thanks", "hi"));
        let SpawnOutcome::Finished { agent_id, .. } = host
            .spawn(&parent, spawn("Work", "do the work", None))
            .await
            .unwrap()
        else {
            panic!("sync spawn");
        };
        let store = child_store_for(&parent.store, &parent.thread_id);
        let before = AgentSidecar::load(&store, &agent_id).unwrap();
        let before_live = registry.subagent_tasks().get(&agent_id).unwrap().snapshot();
        if reload {
            assert!(registry.subagent_tasks().evict(&agent_id));
        }
        assert!(matches!(
            host.send_message_kind(
                &parent,
                &agent_id,
                "Good job. No further work needed.",
                ParentMessageKind::Message
            )
            .await
            .unwrap(),
            SendOutcome::Messaging { .. }
        ));
        let record = registry.subagent_tasks().get(&agent_id).unwrap();
        wait_until_done(&record).await;
        assert_eq!(
            api.call_count(),
            3,
            "two original work calls, one acknowledgement, no report reminder"
        );
        assert_eq!(spy.rosters.lock().unwrap()[2], ["message_parent"]);
        let after = AgentSidecar::load(&store, &agent_id).unwrap();
        assert_eq!(after.result, before.result);
        assert_eq!(after.runs, before.runs);
        assert_eq!(after.ended_at, before.ended_at);
        assert_eq!(record.snapshot().result, before.result);
        assert_eq!(record.status(), TaskStatus::Completed);
        if !reload {
            assert_eq!(record.snapshot().ended_at_ms, before_live.ended_at_ms);
        }
        let wakes = registry.wake_outbox().pending(&parent.thread_id);
        assert_eq!(
            wakes.len(),
            1,
            "the acknowledgement still wakes an idle parent"
        );
        assert!(wakes[0]
            .detail
            .contains("Thank you. No further work needed."));
        assert!(wakes[0].detail.starts_with("<subagent_message"));
        assert!(!wakes[0].detail.contains("ORIGINAL WORK"));
        let raw = std::fs::read_to_string(store.session_path(&agent_id)).unwrap();
        assert!(!raw.contains("Asked for its report"));
    }
}

#[tokio::test]
async fn a_message_after_submission_does_not_invalidate_a_running_tasks_report() {
    let (api, gate) = MockApi::gated(vec![
        submit_reply("s1", "WORK", "WORK"),
        text_reply("done"),
        text_reply("Thanks."),
    ]);
    let api = Arc::new(api);
    let dir = tempfile::tempdir().unwrap();
    let registry = Arc::new(AgentRegistry::new(
        Arc::new(MockApiFactory::from_api(api.clone())),
        dir.path().into(),
    ));
    let (host, _catalog) = scripted_host(Arc::new(MockEmitter::default()), registry.clone());
    let parent = parent_turn(&registry, make_request("p", "mid-message", "hi"));
    let SpawnOutcome::Launched { agent_id, .. } = host
        .spawn(
            &parent,
            crate::agent_runtime::subagents::host::SpawnRequest {
                background: true,
                ..spawn("Work", "do work", None)
            },
        )
        .await
        .unwrap()
    else {
        panic!("bg spawn");
    };
    api.wait_for_calls(1).await;
    gate.add_permits(1);
    api.wait_for_calls(2).await;
    let record = registry.subagent_tasks().get(&agent_id).unwrap();
    let report = record.submitted_report();
    host.send_message_kind(&parent, &agent_id, "Good job", ParentMessageKind::Message)
        .await
        .unwrap();
    assert_eq!(record.submitted_report(), report);
    gate.add_permits(2);
    wait_until_done(&record).await;
    assert_eq!(api.call_count(), 3);
    assert_eq!(record.snapshot().result.as_deref(), Some("WORK\n\nWORK"));
    assert_eq!(registry.wake_outbox().len(&parent.thread_id), 1);
}

#[test]
fn notes_and_new_tasks_cannot_be_consumed_as_the_answer_to_a_question() {
    let (registry, _dir) = temp_registry();
    for (text, kind) in [
        ("good job", ParentMessageKind::Message),
        ("also check tests", ParentMessageKind::Task),
        ("use the current schema", ParentMessageKind::Reply),
    ] {
        registry
            .enqueue_child_message(
                "agent_x",
                text.into(),
                crate::agent_runtime::types::InjectedOrigin::User,
                Some(kind),
            )
            .unwrap();
    }
    let answers = registry.take_child_replies("agent_x");
    assert_eq!(answers.len(), 1);
    assert_eq!(answers[0].text, "use the current schema");
    let remaining = registry.take_queued_messages("agent_x");
    assert_eq!(
        remaining
            .iter()
            .map(|m| m.text.as_str())
            .collect::<Vec<_>>(),
        ["good job", "also check tests"]
    );
}

#[tokio::test]
async fn an_explicit_task_received_while_answering_restores_task_tools_and_requires_a_report() {
    let (api, gate) = MockApi::gated(
        submits("s1", "FIRST")
            .into_iter()
            .chain([
                text_reply("Thanks."),
                submit_reply("s2", "SECOND", "SECOND"),
                text_reply("done"),
            ])
            .collect(),
    );
    let api = Arc::new(api);
    let spy = Arc::new(MessagingSpy {
        api: api.clone(),
        rosters: StdMutex::new(Vec::new()),
    });
    let dir = tempfile::tempdir().unwrap();
    let registry = Arc::new(AgentRegistry::new(
        Arc::new(FixedFactory(spy.clone())),
        dir.path().into(),
    ));
    let (host, _catalog) = scripted_host(Arc::new(MockEmitter::default()), registry.clone());
    let parent = parent_turn(&registry, make_request("p", "message-to-task", "hi"));
    gate.add_permits(2);
    let SpawnOutcome::Finished { agent_id, .. } = host
        .spawn(&parent, spawn("Work", "first", None))
        .await
        .unwrap()
    else {
        panic!("sync spawn");
    };
    host.send_message_kind(&parent, &agent_id, "thanks", ParentMessageKind::Message)
        .await
        .unwrap();
    api.wait_for_calls(3).await;
    host.send_message_kind(
        &parent,
        &agent_id,
        "now verify the tests",
        ParentMessageKind::Task,
    )
    .await
    .unwrap();
    gate.add_permits(3);
    let record = registry.subagent_tasks().get(&agent_id).unwrap();
    wait_until_done(&record).await;
    assert_eq!(record.snapshot().runs, 2);
    assert_eq!(
        record.snapshot().result.as_deref(),
        Some("SECOND\n\nSECOND")
    );
    let rosters = spy.rosters.lock().unwrap();
    assert_eq!(rosters[2], ["message_parent"]);
    assert!(rosters[3].contains(&"submit_report".to_string()));
    assert!(rosters[3].contains(&"file_read".to_string()));
    let store = child_store_for(&parent.store, &parent.thread_id);
    assert_eq!(AgentSidecar::load(&store, &agent_id).unwrap().runs, 2);
    let report = registry.wake_outbox().pending(&parent.thread_id);
    assert_eq!(report.len(), 1);
    assert!(report[0].detail.contains("SECOND"));
}

#[tokio::test]
async fn a_conversation_turn_cannot_execute_native_task_tools() {
    let dir = tempfile::tempdir().unwrap();
    let forbidden_path = dir.path().join("should-not-exist.txt");
    let attempted_write = TurnScript::Reply {
        events: vec![],
        result: Ok(turn_usage(
            assistant_tool_use_msg(
                "write",
                "file_write",
                serde_json::json!({"path":forbidden_path, "content":"unexpected"}),
            ),
            "tool_use",
        )),
    };
    let api = Arc::new(MockApi::new(
        submits("s1", "ORIGINAL")
            .into_iter()
            .chain([attempted_write, text_reply("No changes made.")])
            .collect(),
    ));
    let registry = Arc::new(AgentRegistry::new(
        Arc::new(MockApiFactory::from_api(api.clone())),
        dir.path().into(),
    ));
    let (host, _catalog) = scripted_host(Arc::new(MockEmitter::default()), registry.clone());
    let parent = parent_turn(&registry, make_request("p", "no-message-edits", "hi"));
    let SpawnOutcome::Finished { agent_id, .. } = host
        .spawn(&parent, spawn("Work", "work", None))
        .await
        .unwrap()
    else {
        panic!("sync spawn");
    };
    host.send_message_kind(&parent, &agent_id, "thanks", ParentMessageKind::Message)
        .await
        .unwrap();
    wait_until_done(&registry.subagent_tasks().get(&agent_id).unwrap()).await;
    assert!(!forbidden_path.exists());
    let store = child_store_for(&parent.store, &parent.thread_id);
    let session = Session::load_from_path(&agent_id, &store.session_path(&agent_id)).unwrap();
    assert!(session.messages().iter().flat_map(|m| &m.blocks).any(|b| matches!(b, ContentBlock::ToolResult {tool_use_id, is_error:Some(true), ..} if tool_use_id == "write")));
    assert_eq!(api.call_count(), 4);
    assert_eq!(registry.wake_outbox().len(&parent.thread_id), 1);
}

#[tokio::test]
async fn a_task_update_releases_a_held_question_without_becoming_its_answer() {
    let question = TurnScript::Reply {
        events: vec![],
        result: Ok(turn_usage(
            assistant_tool_use_msg(
                "ask",
                "message_parent",
                serde_json::json!({
                    "message":"Which test should I run?", "kind":"question"
                }),
            ),
            "tool_use",
        )),
    };
    let api = Arc::new(MockApi::new(vec![
        question,
        submit_reply("s1", "NEW TASK", "NEW TASK"),
        text_reply("done"),
    ]));
    let dir = tempfile::tempdir().unwrap();
    let registry = Arc::new(AgentRegistry::new(
        Arc::new(MockApiFactory::from_api(api.clone())),
        dir.path().into(),
    ));
    let (host, _catalog) = scripted_host(Arc::new(MockEmitter::default()), registry.clone());
    let parent = parent_turn(&registry, make_request("p", "question-task-update", "hi"));
    let SpawnOutcome::Launched { agent_id, .. } = host
        .spawn(
            &parent,
            crate::agent_runtime::subagents::host::SpawnRequest {
                background: true,
                ..spawn("Work", "old assignment", None)
            },
        )
        .await
        .unwrap()
    else {
        panic!("bg spawn");
    };
    let record = registry.subagent_tasks().get(&agent_id).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while !record.is_waiting_for_reply() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    host.send_message_kind(
        &parent,
        &agent_id,
        "Stop that investigation and summarize the findings",
        ParentMessageKind::Task,
    )
    .await
    .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), wait_until_done(&record))
        .await
        .unwrap();
    let store = child_store_for(&parent.store, &parent.thread_id);
    let session = Session::load_from_path(&agent_id, &store.session_path(&agent_id)).unwrap();
    let result = session
        .messages()
        .iter()
        .flat_map(|m| &m.blocks)
        .find_map(|b| match b {
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                ..
            } if tool_use_id == "ask" => Some(content),
            _ => None,
        })
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_str(result).unwrap();
    assert_eq!(parsed["answered"], false);
    assert_eq!(parsed["taskChanged"], true);
    assert_eq!(
        record.snapshot().result.as_deref(),
        Some("NEW TASK\n\nNEW TASK")
    );
    assert_eq!(record.snapshot().runs, 1);
    assert_eq!(api.call_count(), 3);
}
