//! `auroro_websearch` — the agent's way onto the open web.
//!
//! `action="search"` asks a search engine. `action="fetch"` reads one page and
//! returns it as Markdown.
//!
//! ## Why this file does no trimming
//!
//! It used to. It clipped a fetched page at 64 KiB and appended a `[truncated]`
//! marker, which sounds careful and was not: 64 KiB is well above the runtime's
//! own cap on a tool result, so an average documentation page sailed through
//! this file untouched and was then compacted by the runtime — whose last
//! resort is to keep the JSON envelope and drop everything in it. The model
//! received `{"success": true}` with no page, and read that as an empty page.
//!
//! The fix is not a smaller clip. It is that [`crate::websearch::fetch`] returns
//! a **window** of the document plus the offset that reads the next one, sized
//! to fit under the cap. Nothing here needs to trim, because nothing arrives
//! too big, and a page longer than one window says so and can be read on.

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::commands::{aurora_websearch_with, AuroraWebSearchRequest};
use crate::services::browser_runtime::BrowserManager;
use crate::services::browser_search::BrowserPageSource;
use crate::websearch::{DEFAULT_MAX_CHARS, MAX_MAX_CHARS};

pub struct AuroroWebSearchTool {
    /// The search ladder's last rung, when this build has a browser.
    ///
    /// `None` in the IDE window and in tests, and the ladder says so rather
    /// than silently having one rung fewer — see
    /// [`crate::services::browser_search`].
    browser: Option<std::sync::Arc<BrowserManager>>,
}

impl AuroroWebSearchTool {
    pub fn new(browser: Option<std::sync::Arc<BrowserManager>>) -> Self {
        Self { browser }
    }
}

#[async_trait]
impl ToolExecutor for AuroroWebSearchTool {
    fn name(&self) -> &str {
        "auroro_websearch"
    }

    /// Outbound HTTP only; touches no workspace state. Parallelism here is
    /// the difference between one network round-trip and several.
    fn concurrency_safe(&self) -> bool {
        true
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "auroro_websearch".into(),
            description: format!(
                "Search the web, find research papers or images, or read one web page.\n\n\
                 action='search' with a `query` returns ranked results, each with a title, \
                 URL and the engine's summary.\n\
                 action='fetch' with a `url` returns the page as Markdown: headings, lists, \
                 tables, code blocks and links are preserved, and navigation, scripts and \
                 footers are removed. Plain text, JSON and source files are returned as they \
                 are. A GitHub file page is read as the file itself.\n\n\
                 A long page comes back one window at a time. When the result says \
                 `hasMore: true`, call again with the same URL and `offset` set to \
                 `nextOffset` to read on. Windows default to {DEFAULT_MAX_CHARS} characters \
                 and may be raised to {MAX_MAX_CHARS} with `maxChars`.\n\n\
                 source='images' searches Wikimedia Commons for existing pictures, not generated \
                 images. It returns up to 10 images with thumbnail URLs, original URLs, dimensions, \
                 source pages and attribution when provided. Region and safeSearch apply to web \
                 search only; Commons does not provide those filters. Keep the creator and license \
                 with an image, link its source page, and check that page for reuse terms. Image \
                 metadata is not visual inspection.\n\n\
                 This reads pages, it does not operate them. If a page requires a login or \
                 JavaScript, use browser tools only when available; otherwise try another source \
                 and explain what could not be read."
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["search", "fetch"],
                        "description": "Defaults to 'fetch' when a url is given, 'search' otherwise."
                    },
                    "query": { "type": "string", "description": "Required for action='search'." },
                    "url": { "type": "string", "description": "Required for action='fetch'." },
                    "source": {
                        "type": "string",
                        "enum": ["web", "scholar", "images"],
                        "default": "web",
                        "description": "Which catalogue to ask. 'web' is the open web. 'scholar' \
                                        asks arXiv, OpenAlex, Semantic Scholar and PubMed Central \
                                        together and returns papers — titles, venues, abstracts \
                                        and links you can fetch. Use it for research questions, \
                                        evidence and citations; it has nothing to say about \
                                        software documentation or current events. 'images' finds \
                                        existing pictures on Wikimedia Commons with source and license \
                                        metadata, up to 10 results. Search only."
                    },
                    "numResults": {
                        "type": "number",
                        "default": 10,
                        "description": "Results to return, 1-25. Search only."
                    },
                    "region": {
                        "type": "string",
                        "description": "Search region, e.g. 'us-en', 'uk-en', 'de-de'."
                    },
                    "safeSearch": { "type": "string", "enum": ["OFF", "MODERATE", "STRICT"] },
                    "maxChars": {
                        "type": "number",
                        "description": format!(
                            "Characters of page text to return. Default {DEFAULT_MAX_CHARS}, \
                             maximum {MAX_MAX_CHARS}. Fetch only."
                        ),
                    },
                    "offset": {
                        "type": "number",
                        "description": "Character to start reading at. Pass the previous result's \
                                        nextOffset to continue a long page. Fetch only."
                    }
                },
                "required": [],
                "additionalProperties": false,
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let action = string_arg(&input, &["action"]).map(|s| s.to_ascii_lowercase());
        let query = string_arg(&input, &["query"]);
        let url = string_arg(&input, &["url"]);

        // Resolve the action the same way the command does, so the argument
        // check below rejects the right thing.
        let resolved = action.clone().unwrap_or_else(|| {
            if url.is_some() {
                "fetch".into()
            } else {
                "search".into()
            }
        });

        // A missing required argument is the model's mistake to fix, so it
        // comes back as a readable result rather than a tool error: an error
        // ends the call, a result lets it try again with the argument.
        if resolved == "search" && query.is_none() {
            return Ok(refusal(
                "auroro_websearch: action='search' needs a `query`.",
            ));
        }
        if resolved == "fetch" && url.is_none() {
            return Ok(refusal("auroro_websearch: action='fetch' needs a `url`."));
        }

        let request = AuroraWebSearchRequest {
            action,
            query,
            url,
            num_results: number_arg(&input, &["numResults", "num_results"]),
            region: string_arg(&input, &["region"]),
            safe_search: string_arg(&input, &["safeSearch", "safe_search"]),
            source: string_arg(&input, &["source"]),
            max_chars: number_arg(&input, &["maxChars", "max_chars"]),
            offset: number_arg(&input, &["offset"]),
        };

        // Built per call rather than held: it is a thin handle over the
        // manager, and building it here keeps the tool's own state to the one
        // `Arc` it was given.
        let page_source = self.browser.clone().map(BrowserPageSource::new);
        let browser = page_source
            .as_ref()
            .map(|s| s as &dyn crate::websearch::PageSource);

        match aurora_websearch_with(request, browser).await {
            Ok(response) => serde_json::to_string(&response).map_err(|e| {
                ToolError::Execution(format!("failed to serialize the web result: {e}"))
            }),
            // A site being down is not a tool failure. Reported as a result,
            // the model can pick a different source; reported as an error it
            // only learns the call did not work.
            Err(message) => Ok(if resolved == "search" {
                search_failure(&message)
            } else {
                refusal(&message)
            }),
        }
    }
}

fn refusal(message: &str) -> String {
    serde_json::to_string(&json!({ "success": false, "error": message }))
        .unwrap_or_else(|_| r#"{"success":false,"error":"web request failed"}"#.to_string())
}

/// A search that could not return a usable result.
///
/// The hazard here is specific and worse than the failure itself: a model that
/// asked the web a question, got nothing, and answers anyway from memory —
/// with the confidence of something that just looked it up. That is the single
/// worst way this feature can fail, because it is invisible.
///
/// So the result says what to DO, not only what went wrong. `success: false`
/// alone is a fact the model can read past; an instruction is one it has to
/// act on.
fn search_failure(message: &str) -> String {
    serde_json::to_string(&json!({
        "success": false,
        "error": message,
        "guidance": "The search failed, so no usable results were returned and nothing was \
ruled out. Check the error and correct invalid arguments before retrying. Tell the user the search failed rather than answering from memory as though it had \
succeeded. Do NOT cite sources, name articles, or state current facts you cannot check. If you \
know something relevant from training, you may say so — but say plainly that you could not verify \
it just now."
    }))
    .unwrap_or_else(|_| r#"{"success":false,"error":"web search failed"}"#.to_string())
}

/// Read a string argument under any of its accepted spellings.
///
/// Models write both `numResults` and `num_results` for the same field, and
/// rejecting one of them costs a turn to learn nothing.
fn string_arg(input: &Value, names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|n| input.get(*n).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()))
        .map(str::to_string)
}

/// Read a numeric argument, accepting the string form some models emit
/// (`"maxChars": "5000"`).
fn number_arg(input: &Value, names: &[&str]) -> Option<u32> {
    names.iter().find_map(|n| {
        let raw = input.get(*n)?;
        raw.as_u64()
            .or_else(|| raw.as_f64().filter(|f| *f >= 0.0).map(|f| f as u64))
            .or_else(|| raw.as_str()?.trim().parse::<u64>().ok())
            .map(|v| v.min(u32::MAX as u64) as u32)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::tool_executor::ToolContext;
    use std::sync::Arc;
    use tokio_util::sync::CancellationToken;

    fn ctx_for() -> ToolContext {
        ToolContext {
            workspace_access: Default::default(),
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            thread_id: "s".into(),
            workspace_root: None,
            cancel_token: CancellationToken::new(),
            spill_dir: None,
        }
    }

    async fn run(input: Value) -> Value {
        let tool: Arc<dyn ToolExecutor> = Arc::new(AuroroWebSearchTool::new(None));
        let out = tool.execute(input, &ctx_for()).await.expect("ok");
        serde_json::from_str(&out).unwrap()
    }

    #[tokio::test]
    async fn a_search_without_a_query_says_which_argument_is_missing() {
        let parsed = run(json!({ "action": "search" })).await;
        assert_eq!(parsed["success"], false);
        assert!(parsed["error"].as_str().unwrap().contains("`query`"));
    }

    #[tokio::test]
    async fn a_fetch_without_a_url_says_which_argument_is_missing() {
        let parsed = run(json!({ "action": "fetch" })).await;
        assert_eq!(parsed["success"], false);
        assert!(parsed["error"].as_str().unwrap().contains("`url`"));
    }

    #[tokio::test]
    async fn blank_optional_fields_do_not_override_search_and_bad_actions_are_refused() {
        let empty = run(json!({"action":"", "url":" ", "query":" "})).await;
        assert!(empty["error"].as_str().unwrap().contains("query"));
        let invalid = run(json!({"action":"images", "query":"Webb"})).await;
        assert!(invalid["error"].as_str().unwrap().contains("unknown web action"));
        let source = run(json!({"source":"typo", "query":"Webb"})).await;
        assert!(source["error"].as_str().unwrap().contains("unknown search source"));
    }

    /// A bad URL must not reach the network, and must come back as a readable
    /// result the model can act on rather than a tool error that ends the call.
    #[tokio::test]
    async fn an_unfetchable_url_is_refused_before_any_request() {
        let parsed = run(json!({ "action": "fetch", "url": "file:///C:/secrets.txt" })).await;
        assert_eq!(parsed["success"], false);
        assert!(parsed["error"].as_str().unwrap().contains("file"));
    }

    #[test]
    fn both_spellings_of_an_argument_are_accepted() {
        assert_eq!(
            number_arg(&json!({ "num_results": 5 }), &["numResults", "num_results"]),
            Some(5)
        );
        assert_eq!(
            number_arg(&json!({ "numResults": 7 }), &["numResults", "num_results"]),
            Some(7)
        );
        assert_eq!(
            string_arg(
                &json!({ "safe_search": "OFF" }),
                &["safeSearch", "safe_search"]
            ),
            Some("OFF".into())
        );
    }

    /// Models quote numbers often enough that rejecting the string form costs
    /// a turn for nothing.
    #[test]
    fn a_quoted_number_is_read_as_a_number() {
        assert_eq!(
            number_arg(&json!({ "maxChars": "5000" }), &["maxChars"]),
            Some(5000)
        );
        assert_eq!(
            number_arg(&json!({ "offset": 12.0 }), &["offset"]),
            Some(12)
        );
        assert_eq!(number_arg(&json!({ "offset": "abc" }), &["offset"]), None);
        assert_eq!(number_arg(&json!({ "offset": -5 }), &["offset"]), None);
    }

    /// The paging contract is the tool's whole answer to the truncation bug,
    /// so the description has to teach it.
    #[test]
    fn the_description_explains_how_to_read_a_long_page() {
        let schema = AuroroWebSearchTool::new(None).schema();
        assert!(
            schema.description.contains("nextOffset"),
            "{}",
            schema.description
        );
        assert!(
            schema.description.contains("hasMore"),
            "{}",
            schema.description
        );
    }

    /// A failed SEARCH must tell the model what to do, not only that something
    /// broke. The failure this guards is a model that asked the web a
    /// question, got nothing, and answered from memory with the confidence of
    /// something freshly looked up — which is invisible to the reader.
    #[test]
    fn a_failed_search_tells_the_model_not_to_answer_as_though_it_succeeded() {
        let payload: serde_json::Value =
            serde_json::from_str(&search_failure("everything was unreachable")).unwrap();

        assert_eq!(payload["success"], false);
        assert_eq!(payload["error"], "everything was unreachable");

        let guidance = payload["guidance"].as_str().expect("guidance is present");
        assert!(guidance.contains("failed"), "it must name the failure");
        assert!(
            guidance.contains("Do NOT cite sources"),
            "the specific hazard is fabricated citations: {guidance}"
        );
        assert!(
            guidance.contains("could not verify"),
            "training knowledge is allowed, but only when labelled: {guidance}"
        );
    }

    /// A failed FETCH is a different situation — one page is down, and trying
    /// another source is the right move. It must not carry the search
    /// instruction, which would tell the model to give up on a whole question
    /// because one URL 404'd.
    #[test]
    fn a_failed_fetch_carries_no_search_guidance() {
        let payload: serde_json::Value =
            serde_json::from_str(&refusal("that page returned 404")).unwrap();
        assert_eq!(payload["success"], false);
        assert!(payload.get("guidance").is_none());
    }
}
