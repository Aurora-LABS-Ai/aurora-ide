use super::subagents::{
    parent_turn, scripted_host, spawn, submit_reply, submits, submitted_text, text_reply,
    wait_until_done,
};
use super::*;
use crate::agent_runtime::subagents::host::{
    SendOutcome, SpawnOutcome, SpawnRequest, SubagentHost,
};
use crate::agent_runtime::subagents::store::child_store_for;
use crate::agent_runtime::subagents::SubagentEvent;

#[tokio::test]
async fn a_late_followup_requires_a_report_covering_the_new_work() {
    let (api, gate) = MockApi::gated(vec![
        submit_reply("s1", "FIRST", "FIRST"),
        text_reply("first done"),
        text_reply("second work done"),
        submit_reply("s2", "SECOND", "SECOND"),
        text_reply("second done"),
    ]);
    let api = Arc::new(api);
    let dir = tempfile::tempdir().unwrap();
    let registry = Arc::new(AgentRegistry::new(
        Arc::new(MockApiFactory::from_api(api.clone())),
        dir.path().into(),
    ));
    let (host, _catalog) = scripted_host(Arc::new(MockEmitter::default()), registry.clone());
    let parent = parent_turn(&registry, make_request("p", "late-submitted", "hi"));
    let SpawnOutcome::Launched { agent_id, .. } = host
        .spawn(
            &parent,
            SpawnRequest {
                background: true,
                ..spawn("Task", "first task", None)
            },
        )
        .await
        .unwrap()
    else {
        panic!("background launch");
    };
    api.wait_for_calls(1).await;
    gate.add_permits(1);
    api.wait_for_calls(2).await;
    host.send_message(&parent, &agent_id, "second task")
        .await
        .unwrap();
    gate.add_permits(5);
    let record = registry.subagent_tasks().get(&agent_id).unwrap();
    wait_until_done(&record).await;
    assert_eq!(record.snapshot().result, Some(submitted_text("SECOND")));
    assert_eq!(
        api.call_count(),
        5,
        "the new task must require a fresh submission"
    );
}

#[tokio::test]
async fn a_report_cannot_cover_parent_work_that_is_still_queued() {
    let (api, gate) = MockApi::gated(vec![
        submit_reply("old", "OUTDATED", "OUTDATED"),
        submit_reply("fresh", "CURRENT", "CURRENT"),
        text_reply("done"),
    ]);
    let api = Arc::new(api);
    let dir = tempfile::tempdir().unwrap();
    let registry = Arc::new(AgentRegistry::new(
        Arc::new(MockApiFactory::from_api(api.clone())),
        dir.path().into(),
    ));
    let (host, _catalog) = scripted_host(Arc::new(MockEmitter::default()), registry.clone());
    let parent = parent_turn(&registry, make_request("p", "pending-instruction", "hi"));
    let SpawnOutcome::Launched { agent_id, .. } = host
        .spawn(
            &parent,
            SpawnRequest {
                background: true,
                ..spawn("Task", "first task", None)
            },
        )
        .await
        .unwrap()
    else {
        panic!("background launch");
    };
    api.wait_for_calls(1).await;
    host.send_message(&parent, &agent_id, "also verify the tests")
        .await
        .unwrap();
    gate.add_permits(3);
    let record = registry.subagent_tasks().get(&agent_id).unwrap();
    wait_until_done(&record).await;
    assert_eq!(record.snapshot().result, Some(submitted_text("CURRENT")));
    let store = child_store_for(&parent.store, &parent.thread_id);
    let session = Session::load_from_path(&agent_id, &store.session_path(&agent_id)).unwrap();
    assert!(session
        .messages()
        .iter()
        .flat_map(|m| &m.blocks)
        .any(|block| matches!(block,
            ContentBlock::ToolResult { tool_use_id, is_error: Some(true), content }
                if tool_use_id == "old" && content.contains("new instructions")
        )));
}

struct BoundaryEmitter {
    on_report: StdMutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl EventEmitter for BoundaryEmitter {
    fn emit_event(&self, _: &AgentEventEnvelope) {}
    fn emit_turn_complete(&self, _: &str, _: &TurnCompletion) {}
    fn emit_turn_error(&self, _: &str, _: &str, _: Option<RecoveryHint>) {}
    fn emit_tool_pending(&self, _: &ToolBridgeRequest) {}
    fn emit_subagent(&self, event: &SubagentEvent) {
        if matches!(event, SubagentEvent::Report { .. }) {
            let callback = self.on_report.lock().unwrap().take();
            if let Some(callback) = callback {
                callback();
            }
        }
    }
}

#[tokio::test]
async fn a_finishing_run_serializes_message_acceptance_then_resumes() {
    use futures::FutureExt;
    use std::sync::atomic::{AtomicBool, Ordering};

    let dir = tempfile::tempdir().unwrap();
    let api = Arc::new(MockApi::new(
        [submits("s1", "first"), submits("s2", "second")]
            .into_iter()
            .flatten()
            .collect(),
    ));
    let registry = Arc::new(AgentRegistry::new(
        Arc::new(MockApiFactory::from_api(api)),
        dir.path().into(),
    ));
    let emitter = Arc::new(BoundaryEmitter {
        on_report: StdMutex::new(None),
    });
    let catalog = tempfile::tempdir().unwrap();
    let host = Arc::new(
        AgentV2SubagentHost::new(registry.clone(), emitter.clone())
            .with_catalog_dir(catalog.path().into()),
    );
    let parent = Arc::new(parent_turn(
        &registry,
        make_request("p", "finish-message", "hi"),
    ));
    let accepted = Arc::new(AtomicBool::new(false));
    let observed = accepted.clone();
    let callback_host = host.clone();
    let callback_parent = parent.clone();
    *emitter.on_report.lock().unwrap() = Some(Box::new(move || {
        observed.store(
            callback_host
                .send_message(&callback_parent, "worker", "late work")
                .now_or_never()
                .is_some(),
            Ordering::SeqCst,
        );
    }));
    let SpawnOutcome::Launched { agent_id, .. } = host
        .spawn(
            &parent,
            SpawnRequest {
                background: true,
                name: Some("worker".into()),
                ..spawn("Task", "task", None)
            },
        )
        .await
        .unwrap()
    else {
        panic!("background launch");
    };
    let record = registry.subagent_tasks().get(&agent_id).unwrap();
    wait_until_done(&record).await;
    assert!(
        !accepted.load(Ordering::SeqCst),
        "acceptance must wait until finishing commits"
    );
    assert!(registry.take_queued_messages(&agent_id).is_empty());
    assert!(matches!(
        host.send_message(&parent, "worker", "late work")
            .await
            .unwrap(),
        SendOutcome::Resumed { .. }
    ));
    wait_until_done(&record).await;
    assert_eq!(record.snapshot().result, Some(submitted_text("second")));
}
