use super::subagents::wait_until_done;
use super::subagents::{parent_turn, scripted_host, spawn, submits};
use super::*;
use crate::agent_runtime::subagents::host::{SpawnOutcome, SpawnRequest, SubagentHost};
use crate::agent_runtime::subagents::store::{child_store_for, AgentSidecar};

#[tokio::test]
async fn unavailable_definition_tools_fail_before_any_child_is_persisted() {
    for tool in ["mcp_missing_lookup", "nonexistent_native_tool"] {
        let dir = tempfile::tempdir().unwrap();
        let registry = Arc::new(AgentRegistry::new(
            Arc::new(MockApiFactory::from_api(Arc::new(MockApi::new(submits(
                "s1", "blocked",
            ))))),
            dir.path().into(),
        ));
        let (host, catalog) = scripted_host(Arc::new(MockEmitter::default()), registry.clone());
        std::fs::write(catalog.path().join("research.md"), format!(
            "---\nname: research\ndescription: Research\ntools: {tool}\n---\nUse the configured tool.\n"
        )).unwrap();
        let parent = parent_turn(&registry, make_request("p", "invalid-grant", "hi"));
        let outcome = host
            .spawn(&parent, spawn("Research", "research", Some("research")))
            .await;
        assert!(outcome.is_err(), "unavailable tool {tool} was accepted");
        assert!(
            AgentSidecar::list_in(&child_store_for(&parent.store, &parent.thread_id)).is_empty()
        );
        assert!(registry.subagent_tasks().is_empty());
    }
}

struct RosterSpy {
    api: Arc<MockApi>,
    seen: StdMutex<Vec<(Vec<String>, String)>>,
}

#[async_trait]
impl StreamingApiClient for RosterSpy {
    async fn stream(
        &self,
        request: ApiRequest<'_>,
        sink: mpsc::Sender<AssistantEvent>,
        cancel: CancellationToken,
    ) -> Result<TurnUsage, ApiError> {
        self.seen.lock().unwrap().push((
            request.tools.iter().map(|tool| tool.name.clone()).collect(),
            request.system_prompt.unwrap_or_default().to_string(),
        ));
        self.api.stream(request, sink, cancel).await
    }
}

#[tokio::test]
async fn explicit_and_empty_grants_match_the_actual_roster_and_prompt() {
    for names in [
        vec!["file_read".to_string(), "auroro_websearch".to_string()],
        Vec::new(),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let spy = Arc::new(RosterSpy {
            api: Arc::new(MockApi::new(submits("s1", "done"))),
            seen: StdMutex::new(Vec::new()),
        });
        let registry = Arc::new(AgentRegistry::new(
            Arc::new(FixedFactory(spy.clone())),
            dir.path().into(),
        ));
        let (host, _catalog) = scripted_host(Arc::new(MockEmitter::default()), registry.clone());
        let parent = parent_turn(&registry, make_request("p", "exact-grant", "hi"));
        let SpawnOutcome::Finished { agent_id, .. } = host
            .spawn(
                &parent,
                SpawnRequest {
                    tools: Some(names.clone()),
                    ..spawn("Task", "task", None)
                },
            )
            .await
            .unwrap()
        else {
            panic!("synchronous fixture");
        };
        let observed = spy.seen.lock().unwrap();
        let expected: std::collections::BTreeSet<_> = names
            .iter()
            .cloned()
            .chain(["message_parent".to_string(), "submit_report".to_string()])
            .collect();
        assert_eq!(
            observed[0]
                .0
                .iter()
                .cloned()
                .collect::<std::collections::BTreeSet<_>>(),
            expected
        );
        assert!(!observed[0].1.contains("`shell_execute` runs"));
        assert!(!observed[0].1.contains("`file_edit` replaces"));
        let sidecar = AgentSidecar::load(
            &child_store_for(&parent.store, &parent.thread_id),
            &agent_id,
        )
        .unwrap();
        assert_eq!(sidecar.tool_grant.as_ref(), Some(&names));
    }
}

#[tokio::test]
async fn a_read_only_role_cannot_be_granted_write_shell_or_recursive_tools() {
    let (registry, _dir) = temp_registry();
    let (host, _catalog) = scripted_host(Arc::new(MockEmitter::default()), registry.clone());
    let parent = parent_turn(&registry, make_request("p", "role-ceiling", "hi"));
    for tool in [
        "file_write",
        "shell_execute",
        "spawn_agent",
        "ask_question",
        "mcp_server_search",
    ] {
        let outcome = host
            .spawn(
                &parent,
                SpawnRequest {
                    tools: Some(vec![tool.into()]),
                    ..spawn("Task", "task", Some("explore"))
                },
            )
            .await;
        assert!(outcome.is_err(), "{tool} escaped the role ceiling");
        assert!(outcome.unwrap_err().to_string().contains(tool));
    }
    assert!(AgentSidecar::list_in(&child_store_for(&parent.store, &parent.thread_id)).is_empty());
}

#[tokio::test]
async fn a_saved_grant_survives_definition_changes_and_resume_from_disk() {
    let dir = tempfile::tempdir().unwrap();
    let spy = Arc::new(RosterSpy {
        api: Arc::new(MockApi::new(
            [submits("s1", "first"), submits("s2", "second")]
                .into_iter()
                .flatten()
                .collect(),
        )),
        seen: StdMutex::new(Vec::new()),
    });
    let registry = Arc::new(AgentRegistry::new(
        Arc::new(FixedFactory(spy.clone())),
        dir.path().into(),
    ));
    let (host, catalog) = scripted_host(Arc::new(MockEmitter::default()), registry.clone());
    let file = catalog.path().join("focused.md");
    std::fs::write(&file, "---\nname: focused\ndescription: Focused reader\ntools: file_read\nallowed-tools: file_read, grep\n---\nRead the assigned source.\n").unwrap();
    let parent = parent_turn(&registry, make_request("p", "saved-grant", "hi"));
    let SpawnOutcome::Finished { agent_id, .. } = host
        .spawn(
            &parent,
            SpawnRequest {
                tools: Some(vec!["grep".into()]),
                ..spawn("Task", "first", Some("focused"))
            },
        )
        .await
        .unwrap()
    else {
        panic!("synchronous fixture");
    };
    std::fs::write(&file, "---\nname: focused\ndescription: Focused reader\ntools: file_read, grep\nallowed-tools: file_read, grep\n---\nRead the assigned source.\n").unwrap();
    registry.subagent_tasks().evict(&agent_id);
    host.send_message(&parent, &agent_id, "second")
        .await
        .unwrap();
    let record = registry.subagent_tasks().get(&agent_id).unwrap();
    wait_until_done(&record).await;
    assert_eq!(record.snapshot().runs, 2);
    let observed = spy.seen.lock().unwrap();
    assert_eq!(observed.len(), 4);
    assert!(observed
        .iter()
        .all(|(tools, _)| tools.contains(&"grep".into()) && !tools.contains(&"file_read".into())));
    drop(observed);
    let store = child_store_for(&parent.store, &parent.thread_id);
    assert_eq!(
        AgentSidecar::load(&store, &agent_id).unwrap().tool_grant,
        Some(vec!["grep".into()])
    );
    std::fs::write(
        &file,
        "---\nname: focused\ndescription: Focused reader\ntools: file_read\n---\nRead source.\n",
    )
    .unwrap();
    assert!(host
        .send_message(&parent, &agent_id, "third")
        .await
        .is_err());
    assert!(!record.is_running());
    assert_eq!(record.snapshot().runs, 2);
}

#[tokio::test]
async fn an_older_general_agent_keeps_its_original_roster_on_first_resume() {
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
    let (host, _catalog) = scripted_host(Arc::new(MockEmitter::default()), registry.clone());
    let parent = parent_turn(&registry, make_request("p", "legacy-grant", "hi"));
    let SpawnOutcome::Finished { agent_id, .. } = host
        .spawn(&parent, spawn("Task", "first", None))
        .await
        .unwrap()
    else {
        panic!("synchronous fixture");
    };
    let store = child_store_for(&parent.store, &parent.thread_id);
    let mut sidecar = AgentSidecar::load(&store, &agent_id).unwrap();
    sidecar.tool_grant = None;
    sidecar.save(&store).unwrap();
    registry.subagent_tasks().evict(&agent_id);
    host.send_message(&parent, &agent_id, "second")
        .await
        .unwrap();
    wait_until_done(&registry.subagent_tasks().get(&agent_id).unwrap()).await;
    let grant = AgentSidecar::load(&store, &agent_id)
        .unwrap()
        .tool_grant
        .unwrap();
    assert!(!grant.contains(&"auroro_websearch".into()));
    assert!(!grant.contains(&"design_guidelines".into()));
    assert_eq!(
        grant,
        crate::agent_runtime::subagents::catalog::GENERAL_PURPOSE_TOOLS
    );
}

struct GuardedShell(Arc<std::sync::atomic::AtomicUsize>);
#[async_trait]
impl ToolExecutor for GuardedShell {
    fn name(&self) -> &str {
        "shell_execute"
    }
    fn schema(&self) -> crate::agent_runtime::api_client::ToolSchema {
        crate::agent_runtime::api_client::ToolSchema {
            name: self.name().into(),
            description: "permission fixture".into(),
            input_schema: serde_json::json!({"type":"object"}),
        }
    }
    fn requires_permission(&self) -> bool {
        true
    }
    async fn execute(&self, _: serde_json::Value, _: &ToolContext) -> Result<String, ToolError> {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok("executed".into())
    }
}

#[tokio::test]
async fn a_tool_grant_keeps_the_native_permission_gate() {
    let dir = tempfile::tempdir().unwrap();
    let mut scripts = vec![TurnScript::Reply {
        events: Vec::new(),
        result: Ok(turn_usage(
            assistant_tool_use_msg(
                "denied",
                "shell_execute",
                serde_json::json!({"command":"echo test"}),
            ),
            "tool_use",
        )),
    }];
    scripts.extend(submits("s1", "permission denied"));
    let registry = Arc::new(AgentRegistry::new(
        Arc::new(MockApiFactory::from_api(Arc::new(MockApi::new(scripts)))),
        dir.path().into(),
    ));
    let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    registry.tools().register(Arc::new(
        crate::tools::permissions::PermissionGuardedExecutor::new(
            Arc::new(GuardedShell(count.clone())),
            Arc::new(crate::tools::permissions::MockPermitter::denying()),
        ),
    ));
    let (host, _catalog) = scripted_host(Arc::new(MockEmitter::default()), registry.clone());
    let parent = parent_turn(&registry, make_request("p", "permission-grant", "hi"));
    let SpawnOutcome::Finished { agent_id, .. } = host
        .spawn(
            &parent,
            SpawnRequest {
                tools: Some(vec!["shell_execute".into()]),
                ..spawn("Task", "run the check", None)
            },
        )
        .await
        .unwrap()
    else {
        panic!("synchronous fixture");
    };
    assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 0);
    let store = child_store_for(&parent.store, &parent.thread_id);
    let session = Session::load_from_path(&agent_id, &store.session_path(&agent_id)).unwrap();
    assert!(session
        .messages()
        .iter()
        .flat_map(|m| &m.blocks)
        .any(|block| matches!(block,
            ContentBlock::ToolResult { tool_use_id, is_error: Some(true), content }
                if tool_use_id == "denied" && content.contains("denied")
        )));
}
