use super::subagents::{parent_turn, scripted_host, spawn, submits, text_reply, wait_until_done};
use super::*;
use crate::agent_runtime::subagents::host::SendOutcome;
use crate::agent_runtime::subagents::host::{SpawnOutcome, SpawnRequest, SubagentHost};
use crate::agent_runtime::subagents::record::StopBy;
use crate::agent_runtime::subagents::store::{child_store_for, AgentSidecar};

#[tokio::test]
async fn a_failed_resume_keeps_the_agent_terminal_until_setup_succeeds() {
    let dir = tempfile::tempdir().unwrap();
    let registry = Arc::new(AgentRegistry::new(
        Arc::new(MockApiFactory::from_api(Arc::new(MockApi::new(submits(
            "s1", "first",
        ))))),
        dir.path().into(),
    ));
    let (host, _catalog) = scripted_host(Arc::new(MockEmitter::default()), registry.clone());
    let parent = parent_turn(&registry, make_request("p", "resume-write-failure", "hi"));
    let SpawnOutcome::Finished { agent_id, .. } = host
        .spawn(&parent, spawn("Task", "task", None))
        .await
        .unwrap()
    else {
        panic!("synchronous fixture");
    };
    let store = child_store_for(&parent.store, &parent.thread_id);
    std::fs::create_dir_all(AgentSidecar::path_in(&store, &agent_id).with_extension("json.tmp"))
        .unwrap();
    assert!(host.send_message(&parent, &agent_id, "more").await.is_err());
    assert!(!registry
        .subagent_tasks()
        .get(&agent_id)
        .unwrap()
        .is_running());
    assert_eq!(
        registry
            .subagent_tasks()
            .get(&agent_id)
            .unwrap()
            .snapshot()
            .runs,
        1
    );
}

#[tokio::test]
async fn deleting_a_parent_stops_children_before_removing_their_store() {
    let (api, gate) = MockApi::gated(submits("s1", "finished"));
    let api = Arc::new(api);
    let dir = tempfile::tempdir().unwrap();
    let registry = Arc::new(AgentRegistry::new(
        Arc::new(MockApiFactory::from_api(api.clone())),
        dir.path().into(),
    ));
    let (host, _catalog) = scripted_host(Arc::new(MockEmitter::default()), registry.clone());
    let parent = parent_turn(&registry, make_request("p", "deleted-parent", "hi"));
    let SpawnOutcome::Launched { agent_id, .. } = host
        .spawn(
            &parent,
            SpawnRequest {
                background: true,
                ..spawn("Task", "task", None)
            },
        )
        .await
        .unwrap()
    else {
        panic!("background launch");
    };
    api.wait_for_calls(1).await;
    let record = registry.subagent_tasks().get(&agent_id).unwrap();
    super::super::delete_conversation(registry.clone(), parent.thread_id.clone())
        .await
        .unwrap();
    gate.add_permits(2);
    wait_until_done(&record).await;
    assert!(
        !parent.store.thread_dir(&parent.thread_id).exists(),
        "a child must not recreate a deleted parent"
    );
    assert!(registry.subagent_tasks().get(&agent_id).is_none());
    assert!(registry.wake_outbox().pending(&parent.thread_id).is_empty());
    assert!(host
        .spawn(&parent, spawn("Again", "task", None))
        .await
        .is_err());
    assert!(!parent.store.thread_dir(&parent.thread_id).exists());
}

#[tokio::test(start_paused = true)]
async fn a_delete_timeout_preserves_storage_and_allows_retry() {
    let (registry, _dir) = temp_registry();
    let parent = parent_turn(&registry, make_request("p", "delete-timeout", "hi"));
    registry.mark_turn_active(&parent.thread_id, "unresponsive-turn");
    registry.register_in_flight("unresponsive-turn".into(), CancellationToken::new());
    assert!(
        super::super::delete_conversation(registry.clone(), parent.thread_id.clone())
            .await
            .is_err()
    );
    assert!(registry.ensure_thread_live(&parent.thread_id).is_ok());
    assert!(parent.store.thread_dir(&parent.thread_id).exists());
    registry.clear_turn_active(&parent.thread_id, "unresponsive-turn");
    tokio::time::resume();
    super::super::delete_conversation(registry.clone(), parent.thread_id.clone())
        .await
        .unwrap();
    assert!(!parent.store.thread_dir(&parent.thread_id).exists());
    assert!(registry.ensure_thread_live(&parent.thread_id).is_err());
}

#[tokio::test]
async fn simultaneous_followups_start_only_one_resumed_run() {
    let (api, gate) = MockApi::gated(submits("s1", "first"));
    let api = Arc::new(api);
    let dir = tempfile::tempdir().unwrap();
    let registry = Arc::new(AgentRegistry::new(
        Arc::new(MockApiFactory::from_api(api)),
        dir.path().into(),
    ));
    let (host, _catalog) = scripted_host(Arc::new(MockEmitter::default()), registry.clone());
    let parent = parent_turn(&registry, make_request("p", "resume-once", "hi"));
    gate.add_permits(2);
    let SpawnOutcome::Finished { agent_id, .. } = host
        .spawn(&parent, spawn("Task", "task", None))
        .await
        .unwrap()
    else {
        panic!("synchronous fixture");
    };
    let (first, second) = tokio::join!(
        host.send_message(&parent, &agent_id, "first followup"),
        host.send_message(&parent, &agent_id, "second followup"),
    );
    let outcomes = [first.unwrap(), second.unwrap()];
    assert_eq!(
        outcomes
            .iter()
            .filter(|o| matches!(o, SendOutcome::Resumed { .. }))
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|o| matches!(o, SendOutcome::Queued { .. }))
            .count(),
        1
    );
    let record = registry.subagent_tasks().get(&agent_id).unwrap();
    assert_eq!(record.snapshot().runs, 2);
    record.kill(StopBy::User);
    wait_until_done(&record).await;
}

#[tokio::test]
async fn deleting_a_parent_waits_for_manual_compaction_writes() {
    let (api, gate) = MockApi::gated(vec![text_reply("A compact summary of the completed work.")]);
    let api = Arc::new(api);
    let dir = tempfile::tempdir().unwrap();
    let registry = Arc::new(AgentRegistry::new(
        Arc::new(MockApiFactory::from_api(api.clone())),
        dir.path().into(),
    ));
    let mut request = make_request("compact-delete", "compacting-parent", "hi");
    request.context_window = Some(128000);
    let parent = parent_turn(&registry, request.clone());
    let session = registry
        .load_session_from_store(&parent.thread_id, &parent.store)
        .unwrap();
    {
        let mut session = session.lock().await;
        for _ in 0..24 {
            session.append_message(ConversationMessage::user_text(
                "old context ".repeat(6000),
                1,
            ));
            session.append_message(assistant_text_msg("answer"));
        }
    }
    let driver = TurnDriver::new(registry.clone(), Arc::new(MockEmitter::default()));
    let compacting = tokio::spawn(async move { driver.compact_thread(request).await });
    api.wait_for_calls(1).await;
    super::super::delete_conversation(registry.clone(), parent.thread_id.clone())
        .await
        .unwrap();
    gate.add_permits(1);
    compacting.await.unwrap().unwrap();
    assert!(!parent.store.thread_dir(&parent.thread_id).exists());
}
