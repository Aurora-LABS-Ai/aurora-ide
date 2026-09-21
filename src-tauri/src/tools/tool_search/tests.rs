use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio_util::sync::CancellationToken;

struct Probe {
    name: &'static str,
    parameters: Value,
    calls: Arc<AtomicUsize>,
    frontend: bool,
}

#[async_trait]
impl ToolExecutor for Probe {
    fn name(&self) -> &str {
        self.name
    }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: self.name.into(),
            description: "Search documents in a connected app".into(),
            input_schema: self.parameters.clone(),
        }
    }
    fn concurrency_safe(&self) -> bool {
        true
    }
    fn uses_frontend_lifecycle(&self) -> bool {
        self.frontend
    }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(json!({"input": input, "turn": ctx.turn_id, "call": ctx.tool_call_id, "thread": ctx.thread_id}).to_string())
    }
}

fn probe(name: &'static str, schema: Value, calls: &Arc<AtomicUsize>) -> Arc<dyn ToolExecutor> {
    Arc::new(Probe {
        name,
        parameters: schema,
        calls: calls.clone(),
        frontend: false,
    })
}

fn context() -> ToolContext {
    ToolContext {
        turn_id: "turn".into(),
        tool_call_id: "provider-call-id".into(),
        thread_id: "thread".into(),
        workspace_root: None,
        workspace_access: Default::default(),
        cancel_token: CancellationToken::new(),
        spill_dir: None,
    }
}

fn schema_bytes(registry: &ToolRegistry) -> Vec<u8> {
    serde_json::to_vec(&registry.schemas()).unwrap()
}

/// Regression from the storefront conversation: the model called the guide
/// directly, treated the direct roster as complete, and skipped the guide.
#[tokio::test]
async fn a_direct_browser_guide_miss_leads_to_discovery_and_real_guide_execution() {
    let registry = ToolRegistry::new();
    install(
        &registry,
        vec![Arc::new(crate::tools::browser::BrowserGuidelinesTool)],
    );
    let before = schema_bytes(&registry);
    let error = registry
        .resolve_call("browser_guidelines", &json!({}))
        .err()
        .unwrap()
        .to_string();
    assert!(
        error.contains(r#"tool_search({"query":"select:browser_guidelines"})"#),
        "{error}"
    );
    assert!(error.contains("Available direct tools:"), "{error}");
    assert!(error.contains("call_tool"), "{error}");

    let search = registry.get("tool_search").unwrap();
    let found: Value = serde_json::from_str(
        &search
            .execute(json!({"query":"select:browser_guidelines"}), &context())
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(found["tools"][0]["name"], "browser_guidelines");
    assert!(found["tools"][0]["description"]
        .as_str()
        .unwrap()
        .contains(r#"call_tool({"name":"browser_guidelines","arguments":{}})"#));
    let invocation = registry
        .resolve_call(
            "call_tool",
            &json!({"name": found["tools"][0]["name"], "arguments": {}}),
        )
        .unwrap();
    let guide = invocation
        .executor
        .execute(invocation.input, &context())
        .await
        .unwrap();
    assert!(guide.starts_with("# Driving the Browser panel"));
    assert!(guide.contains("## Never invent a CSS selector"));
    assert!(guide.contains(r#"call_tool({"name":"browser_status","arguments":{}})"#));
    assert_eq!(
        schema_bytes(&registry),
        before,
        "recovery must not expose direct tools"
    );
}

#[tokio::test]
async fn discovery_recovery_does_not_make_an_unavailable_browser_tool_callable() {
    let registry = ToolRegistry::new();
    install(&registry, vec![]);
    let search = registry.get("tool_search").unwrap();
    let found: Value = serde_json::from_str(
        &search
            .execute(json!({"query":"select:browser_guidelines"}), &context())
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(found["not_found"], json!(["browser_guidelines"]));
    assert!(registry
        .resolve_call(
            "call_tool",
            &json!({"name":"browser_guidelines", "arguments":{}}),
        )
        .is_err());
}

/// All three from the harness rig, 2026-09-06, in the shape it reported them.
mod harness_findings {
    use super::*;

    fn outline_probe(calls: &Arc<AtomicUsize>) -> Arc<dyn ToolExecutor> {
        probe(
            "browser_page_outline",
            json!({
                "type": "object",
                "properties": {
                    "limit": {"type": "integer"},
                    "query": {"type": "string"}
                }
            }),
            calls,
        )
    }

    /// The rig's exact call: two misspelled fields, accepted, tool ran with
    /// defaults and answered a different question than the one asked.
    #[tokio::test]
    async fn a_misspelled_argument_is_refused_and_the_tool_never_runs() {
        let calls = Arc::new(AtomicUsize::new(0));
        let registry = ToolRegistry::new();
        install(&registry, vec![outline_probe(&calls)]);
        let call = registry.get("call_tool").unwrap();

        let error = call
            .execute(
                json!({"name":"browser_page_outline","arguments":{"limitt":2,"querry":"button"}}),
                &context(),
            )
            .await
            .expect_err("a typo must not run with defaults");

        let message = error.to_string();
        assert!(message.contains("limitt"), "names what was sent: {message}");
        assert!(message.contains("querry"), "names both: {message}");
        assert!(message.contains("`limit`"), "suggests the real name: {message}");
        assert!(message.contains("`query`"), "suggests both: {message}");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "the tool must not have executed"
        );
    }

    /// An extra field nobody declared, with no near name to suggest.
    #[tokio::test]
    async fn an_undeclared_argument_is_refused_without_a_bogus_suggestion() {
        let calls = Arc::new(AtomicUsize::new(0));
        let registry = ToolRegistry::new();
        install(&registry, vec![outline_probe(&calls)]);
        let call = registry.get("call_tool").unwrap();

        let message = call
            .execute(
                json!({"name":"browser_page_outline","arguments":{"includeCookies":true}}),
                &context(),
            )
            .await
            .expect_err("undeclared fields are silently ignored otherwise")
            .to_string();

        assert!(message.contains("includeCookies"), "{message}");
        assert!(
            !message.contains("did you mean"),
            "nothing is within two edits of it: {message}"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    /// Declared arguments keep working — the guard must not become a wall.
    #[tokio::test]
    async fn correct_arguments_still_run() {
        let calls = Arc::new(AtomicUsize::new(0));
        let registry = ToolRegistry::new();
        install(&registry, vec![outline_probe(&calls)]);
        let call = registry.get("call_tool").unwrap();

        call.execute(
            json!({"name":"browser_page_outline","arguments":{"limit":2,"query":"button"}}),
            &context(),
        )
        .await
        .expect("a correct call must run");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    /// `max_results` of 0, 21 and 2.5 all produced the identical sentence.
    #[tokio::test]
    async fn a_rejected_number_names_the_value_that_arrived() {
        let registry = ToolRegistry::new();
        install(&registry, vec![]);
        let search = registry.get("tool_search").unwrap();

        for (input, expected) in [
            (json!({"query":"x","max_results":0}), "0"),
            (json!({"query":"x","max_results":21}), "21"),
            (json!({"query":"x","max_results":2.5}), "2.5"),
        ] {
            let message = search
                .execute(input.clone(), &context())
                .await
                .expect_err("out of range")
                .to_string();
            assert!(
                message.contains(expected),
                "must name the value sent ({expected}): {message}"
            );
        }

        // A wrong TYPE is a different correction from a wrong range.
        let message = search
            .execute(json!({"query":"x","max_results":2.5}), &context())
            .await
            .expect_err("not an integer")
            .to_string();
        assert!(
            message.contains("whole number"),
            "2.5 is not out of range, it is not an integer: {message}"
        );
    }

    /// A cut description used to be indistinguishable from a short one.
    #[test]
    fn a_cut_description_says_it_was_cut() {
        use super::super::catalog::{preview_description, DESCRIPTION_PREVIEW_CHARS};

        let short = "a short description";
        assert_eq!(preview_description(short), short, "nothing to mark");

        let long = "x".repeat(DESCRIPTION_PREVIEW_CHARS + 500);
        let preview = preview_description(&long);
        assert!(preview.contains("preview cut at"), "{preview}");
        assert!(
            preview.contains(&(DESCRIPTION_PREVIEW_CHARS + 500).to_string()),
            "names the true length: {preview}"
        );
        assert!(
            preview.contains("definition_page.text"),
            "says where the rest is: {preview}"
        );
    }
}

#[tokio::test]
async fn discovery_and_catalog_changes_leave_the_advertised_prefix_identical() {
    let count = Arc::new(AtomicUsize::new(0));
    let empty = ToolRegistry::new();
    install(&empty, vec![]);
    let registry = ToolRegistry::new();
    install(
        &registry,
        vec![probe("mcp_docs_search", json!({"type":"object"}), &count)],
    );
    let before = schema_bytes(&registry);
    assert_eq!(before, schema_bytes(&empty));
    let result = registry
        .get("tool_search")
        .unwrap()
        .execute(json!({"query":"documents"}), &context())
        .await
        .unwrap();
    let found: Value = serde_json::from_str(&result).unwrap();
    assert_eq!(found["tools"][0]["name"], "mcp_docs_search");
    assert_eq!(found["tools"][0]["parameters"], json!({"type":"object"}));
    assert_eq!(count.load(Ordering::SeqCst), 0);
    assert!(registry.get("mcp_docs_search").is_none());
    assert_eq!(before, schema_bytes(&registry));
    // A rebuilt catalog needs no process-local reveal state, including after
    // reopening a saved conversation or reconnecting with a changed schema.
    let reopened = ToolRegistry::new();
    install(
        &reopened,
        vec![probe(
            "mcp_docs_search",
            json!({"type":"object","properties":{"q":{"type":"string"}}}),
            &count,
        )],
    );
    assert_eq!(before, schema_bytes(&reopened));
    assert!(reopened
        .resolve_call(
            "call_tool",
            &json!({"name":"mcp_docs_search","arguments":{"q":"hi"}})
        )
        .is_ok());
}

#[tokio::test]
async fn exact_selection_reports_missing_tools_and_limits_without_mutation() {
    let count = Arc::new(AtomicUsize::new(0));
    let registry = ToolRegistry::new();
    install(
        &registry,
        vec![
            probe("team_status", json!({}), &count),
            probe("mcp_docs_search", json!({}), &count),
        ],
    );
    let result = registry
        .get("tool_search")
        .unwrap()
        .execute(
            json!({"query":"select:team_status,mcp_docs_search,missing", "max_results":1}),
            &context(),
        )
        .await
        .unwrap();
    let result: Value = serde_json::from_str(&result).unwrap();
    assert_eq!(result["total_matches"], 2);
    assert_eq!(result["has_more"], true);
    assert_eq!(result["tools"].as_array().unwrap().len(), 1);
    assert_eq!(result["not_found"], json!(["missing"]));
    let required = registry
        .get("tool_search")
        .unwrap()
        .execute(json!({"query":"documents +mcp"}), &context())
        .await
        .unwrap();
    assert!(!required.contains("team_status"));
}

#[tokio::test]
async fn query_errors_and_cancellation_are_explicit() {
    let registry = ToolRegistry::new();
    install(&registry, vec![]);
    let search = registry.get("tool_search").unwrap();
    for input in [
        json!({}),
        json!({"query":" "}),
        json!({"query":"x","max_results":0}),
        json!({"query":"x","max_results":21}),
        json!({"query":"x","max_results":1.5}),
    ] {
        assert!(matches!(
            search.execute(input, &context()).await,
            Err(ToolError::InvalidInput(_))
        ));
    }
    let ctx = context();
    ctx.cancel_token.cancel();
    assert!(matches!(
        search.execute(json!({"query":"x"}), &ctx).await,
        Err(ToolError::Cancelled)
    ));
}

#[tokio::test]
async fn validates_nested_schema_before_execution_and_preserves_context() {
    let count = Arc::new(AtomicUsize::new(0));
    let registry = ToolRegistry::new();
    install(
        &registry,
        vec![probe(
            "mcp_docs_search",
            json!({
                "type":"object", "properties": {"filter":{"$ref":"#/$defs/filter"}},
                "required":["filter"], "additionalProperties":false,
                "$defs":{"filter":{"type":"object", "properties":{"kinds":{"type":"array","items":{"enum":["pdf","md"]},"minItems":1}},"required":["kinds"],"additionalProperties":false}}
            }),
            &count,
        )],
    );
    let call = registry.get("call_tool").unwrap();
    for args in [
        json!({}),
        json!({"filter":{"kinds":["exe"]}}),
        json!({"filter":{"kinds":"pdf"}}),
        json!({"filter":{"kinds":["pdf"]},"extra":true}),
    ] {
        let result = call
            .execute(
                json!({"name":"mcp_docs_search","arguments":args}),
                &context(),
            )
            .await;
        assert!(
            matches!(result, Err(ToolError::InvalidInput(_))),
            "{result:?}"
        );
    }
    assert_eq!(count.load(Ordering::SeqCst), 0);
    let args = json!({"filter":{"kinds":["pdf","md"]}});
    let result = call
        .execute(
            json!({"name":"mcp_docs_search","arguments":args}),
            &context(),
        )
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&result).unwrap(),
        json!({"input":args,"turn":"turn","call":"provider-call-id","thread":"thread"})
    );
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn rejects_recursion_unknown_tools_and_invalid_envelopes() {
    let registry = ToolRegistry::new();
    install(&registry, vec![]);
    for input in [
        json!({"name":"tool_search","arguments":{}}),
        json!({"name":"call_tool","arguments":{}}),
        json!({"name":"x"}),
        json!({"name":"x","arguments":[]}),
        json!({"name":"x","arguments":{},"extra":true}),
        json!({"name":"file_read","arguments":{}}),
    ] {
        assert!(registry.resolve_call("call_tool", &input).is_err());
    }
}

#[tokio::test]
async fn empty_arguments_work_and_resolved_metadata_comes_from_the_target() {
    let count = Arc::new(AtomicUsize::new(0));
    let registry = ToolRegistry::new();
    install(
        &registry,
        vec![Arc::new(Probe {
            name: "team_status",
            parameters: json!({"type":"object","additionalProperties":false}),
            calls: count.clone(),
            frontend: true,
        })],
    );
    let call = registry
        .resolve_call("call_tool", &json!({"name":"team_status","arguments":{}}))
        .unwrap();
    assert_eq!(call.executor.name(), "team_status");
    assert!(call.executor.concurrency_safe());
    assert!(call.executor.uses_frontend_lifecycle());
    assert_eq!(call.input, json!({}));
    let ctx = context();
    ctx.cancel_token.cancel();
    assert!(matches!(
        call.executor.execute(call.input.clone(), &ctx).await,
        Err(ToolError::Cancelled)
    ));
    assert_eq!(count.load(Ordering::SeqCst), 0);
    call.executor.execute(call.input, &context()).await.unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[test]
fn invalid_and_external_schemas_fail_closed_without_running_the_tool() {
    let count = Arc::new(AtomicUsize::new(0));
    for schema in [
        json!({"type":42}),
        json!({"$ref":"https://example.invalid/schema.json"}),
        json!({"$ref":"file:///should-not-be-opened.json"}),
    ] {
        let registry = ToolRegistry::new();
        install(&registry, vec![probe("mcp_broken", schema, &count)]);
        let error = registry
            .resolve_call("call_tool", &json!({"name":"mcp_broken","arguments":{}}))
            .err()
            .unwrap();
        assert!(
            error.to_string().contains("Cannot validate mcp_broken"),
            "{error}"
        );
    }
    assert_eq!(count.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn oversized_schemas_are_paged_losslessly_with_bounded_results() {
    let count = Arc::new(AtomicUsize::new(0));
    let schema = json!({"type":"object","properties":{"text":{"type":"string","description":"Unicode: 雪 \"quoted\"\n".repeat(5_000)}},"required":["text"]});
    let registry = ToolRegistry::new();
    install(&registry, vec![probe("mcp_large", schema.clone(), &count)]);
    let search = registry.get("tool_search").unwrap();
    let raw = search
        .execute(json!({"query":"select:mcp_large"}), &context())
        .await
        .unwrap();
    assert!(raw.len() < 48 * 1024);
    let first: Value = serde_json::from_str(&raw).unwrap();
    let mut page = first["tools"][0].clone();
    let mut assembled = String::new();
    loop {
        assembled.push_str(page["definition_page"]["text"].as_str().unwrap());
        let Some(offset) = page["definition_page"]["next_offset"].as_u64() else {
            break;
        };
        let raw = search
            .execute(
                json!({"query":"select:mcp_large","schema_offset":offset}),
                &context(),
            )
            .await
            .unwrap();
        assert!(raw.len() < 48 * 1024);
        page = serde_json::from_str(&raw).unwrap();
    }
    assert_eq!(
        serde_json::from_str::<Value>(&assembled).unwrap(),
        json!({
            "name":"mcp_large", "description":"Search documents in a connected app", "parameters":schema
        })
    );
    for input in [
        json!({"query":"large","schema_offset":4}),
        json!({"query":"select:mcp_large","schema_offset":999999999}),
    ] {
        assert!(matches!(
            search.execute(input, &context()).await,
            Err(ToolError::InvalidInput(_))
        ));
    }
}

/// `schema_offset` declares `minimum: 0`, so zero is the field's own default —
/// and a model that spelled the default out on a keyword search was refused
/// with "schema_offset requires select:one_exact_tool_name", which cost it a
/// turn and sent it looking for another way to find browser tools
/// (`reports/aurora-issues.md`, 2026-09-08). Only a NON-ZERO offset is a claim
/// about a page.
#[tokio::test]
async fn a_zero_schema_offset_is_the_default_not_a_paging_request() {
    let count = Arc::new(AtomicUsize::new(0));
    let registry = ToolRegistry::new();
    install(
        &registry,
        vec![probe(
            "browser_screenshot",
            json!({"type":"object","properties":{},"required":[]}),
            &count,
        )],
    );
    let search = registry.get("tool_search").unwrap();
    let raw = search
        .execute(
            json!({"query":"browser screenshot","max_results":10,"schema_offset":0}),
            &context(),
        )
        .await
        .expect("a keyword search carrying the field's default is a valid search");
    let parsed: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(parsed["tools"][0]["name"], json!("browser_screenshot"));
    // A non-zero offset still has to name one exact tool.
    assert!(matches!(
        search
            .execute(json!({"query":"browser screenshot","schema_offset":1}), &context())
            .await,
        Err(ToolError::InvalidInput(_))
    ));
}
