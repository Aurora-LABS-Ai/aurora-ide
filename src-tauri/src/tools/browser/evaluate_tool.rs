//! `browser_evaluate` — run script in the page and get the answer back.
//!
//! Removed once as "a foot-gun", restored because the model without it did
//! worse things: fetched HTML with shell scripts to read a value it could
//! have asked the page for, guessed at component state it could have read
//! from a store, and had no way to test a selector expression before
//! committing a click to it.
//!
//! Three things make it answer rather than merely run:
//!
//! * **Exceptions come back with a location.** Through the DevTools channel
//!   a throw carries the browser's `exceptionDetails`, so the result says
//!   `ReferenceError: foo is not defined (line 3, column 12)`, not just the
//!   message.
//! * **Any value is serialised.** A DOM node becomes its tag, id, classes,
//!   text and clipped outerHTML; a NodeList becomes an array; a Map, a Set, a
//!   Date, an Error, a function all have a readable shape. `returnByValue` on
//!   its own turns a node into `{}`.
//! * **Statements work too.** `document.title` is an expression; `const rows
//!   = ...; return rows.length` is a function body. The expression form is
//!   tried first; a syntax error retries as a body, so the model does not have
//!   to know which one it wrote.
//!
//! Permission-gated like every other acting tool: script can do anything the
//! page can.

use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::services::browser_runtime::BrowserManager;

use super::{ensure_agent_browser, unwrap_browser_result, AGENT_BROWSER_LABEL};

/// How much of a serialised result reaches the model. Past this the string is
/// cut and the cut is named, so a huge `document.body.outerHTML` comes back
/// as "the first 24,000 characters" rather than as nothing.
const MAX_RESULT_CHARS: usize = 24_000;

const DEFAULT_TIMEOUT_MS: u64 = 15_000;
const MAX_TIMEOUT_MS: u64 = 60_000;

/// The serialiser, defined inside the evaluated script so it needs nothing
/// injected into the page beforehand. Bounded in depth, width and string
/// length; circular references are named rather than thrown on.
const SERIALIZE_JS: &str = r#"
  const __clip = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n) + '…[+' + (s.length - n) + ' chars]' : s; };
  const __describeNode = (n) => {
    if (n.nodeType === 9) return '[document]';
    if (n.nodeType === 3) return { text: __clip(n.nodeValue, 500) };
    if (n.nodeType !== 1) return '[node ' + n.nodeName + ']';
    let d = n.tagName.toLowerCase();
    if (n.id) d += '#' + n.id;
    if (typeof n.className === 'string' && n.className.trim()) d += '.' + n.className.trim().split(/\s+/).slice(0, 3).join('.');
    const out = { element: d };
    const t = (n.innerText !== undefined ? n.innerText : n.textContent) || '';
    if (t.trim()) out.text = __clip(t.replace(/\s+/g, ' ').trim(), 300);
    if (typeof n.value === 'string' && n.value) out.value = __clip(n.value, 300);
    out.outerHTML = __clip(n.outerHTML || '', 800);
    return out;
  };
  const __seen = new WeakSet();
  const __ser = (v, depth) => {
    if (v === undefined) return null;
    if (v === null) return null;
    const t = typeof v;
    if (t === 'string') return __clip(v, 5000);
    if (t === 'number' || t === 'boolean') return v;
    if (t === 'bigint' || t === 'symbol') return String(v);
    if (t === 'function') return '[function ' + (v.name || 'anonymous') + ']';
    if (v === window) return '[window]';
    if (v instanceof Error) return { error: (v.name || 'Error') + ': ' + (v.message || ''), stack: __clip((v.stack || '').split('\n').slice(0, 4).join(' | '), 600) };
    if (typeof Node !== 'undefined' && v instanceof Node) return __describeNode(v);
    if (v instanceof Date) return isNaN(v) ? 'Invalid Date' : v.toISOString();
    if (v instanceof RegExp) return String(v);
    if (depth > 6) return '[depth]';
    if (__seen.has(v)) return '[circular]';
    __seen.add(v);
    const isList = Array.isArray(v) || (typeof NodeList !== 'undefined' && v instanceof NodeList) || (typeof HTMLCollection !== 'undefined' && v instanceof HTMLCollection) || v instanceof Set;
    if (isList) {
      const arr = Array.from(v);
      const out = arr.slice(0, 200).map((x) => __ser(x, depth + 1));
      if (arr.length > 200) out.push('[+' + (arr.length - 200) + ' more]');
      return out;
    }
    if (v instanceof Map) { const o = {}; let i = 0; for (const [k, val] of v) { if (i++ >= 200) { o['…'] = '[+' + (v.size - 200) + ' more]'; break; } o[String(k)] = __ser(val, depth + 1); } return o; }
    if (v instanceof ArrayBuffer) return '[ArrayBuffer ' + v.byteLength + ' bytes]';
    if (ArrayBuffer.isView(v)) return '[' + v.constructor.name + ' length ' + v.length + ']';
    if (t === 'object') {
      const o = {}; let i = 0;
      for (const k of Object.keys(v)) { if (i++ >= 200) { o['…'] = '[+' + (Object.keys(v).length - 200) + ' more keys]'; break; } try { o[k] = __ser(v[k], depth + 1); } catch (e) { o[k] = '[unreadable]'; } }
      return o;
    }
    return String(v);
  };
"#;

/// Wrap the user's script as an EXPRESSION whose value is serialised.
fn expression_form(source: &str) -> String {
    format!(
        "(async () => {{{ser}\n  const __v = await (async () => ({src}\n))();\n  return __ser(__v, 0);\n}})()",
        ser = SERIALIZE_JS,
        src = source
    )
}

/// Wrap the user's script as a FUNCTION BODY (statements, `return`).
fn body_form(source: &str) -> String {
    format!(
        "(async () => {{{ser}\n  const __v = await (async () => {{{src}\n}})();\n  return __ser(__v, 0);\n}})()",
        ser = SERIALIZE_JS,
        src = source
    )
}

/// Only the console entries stamped at or after `page_started_at_ms`. An
/// entry without a readable `ts`, or no page clock at all, is kept: losing a
/// log the script wrote is worse than showing one from just before it.
fn logged_since(entries: Vec<Value>, page_started_at_ms: Option<f64>) -> Vec<Value> {
    let Some(start) = page_started_at_ms else {
        return entries;
    };
    entries
        .into_iter()
        .filter(|entry| entry.get("ts").and_then(Value::as_f64).is_none_or(|ts| ts >= start))
        .collect()
}

fn is_syntax_error(message: &str) -> bool {
    message.starts_with("SyntaxError") || message.contains("SyntaxError:")
}

/// Cut a serialised result to size, saying so.
fn bound_result(value: Value) -> (Value, Option<String>) {
    let text = value.to_string();
    if text.chars().count() <= MAX_RESULT_CHARS {
        return (value, None);
    }
    let kept: String = text.chars().take(MAX_RESULT_CHARS).collect();
    (
        Value::String(kept),
        Some(format!(
            "The result was {} characters; only the first {MAX_RESULT_CHARS} are shown, as raw \
             JSON text. Narrow the expression — pick the fields you need, slice the list, or \
             return a count.",
            text.chars().count()
        )),
    )
}

pub struct BrowserEvaluateTool {
    manager: Arc<BrowserManager>,
}
impl BrowserEvaluateTool {
    pub fn new(manager: Arc<BrowserManager>) -> Self {
        Self { manager }
    }

    /// Run one wrapped script through whichever channel exists.
    async fn run(&self, wrapped: &str, timeout_ms: u64) -> Result<Value, String> {
        if self.manager.devtools_available() {
            return self
                .manager
                .devtools_evaluate(AGENT_BROWSER_LABEL, wrapped, timeout_ms)
                .await;
        }
        let result = self
            .manager
            .eval_with_result(AGENT_BROWSER_LABEL, wrapped)
            .await?;
        unwrap_browser_result(result).map_err(|e| e.to_string())
    }
}

#[async_trait]
impl ToolExecutor for BrowserEvaluateTool {
    fn name(&self) -> &str {
        "browser_evaluate"
    }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "browser_evaluate".into(),
            description: "Run JavaScript in the page shown in the Browser panel and get the \
                result back as JSON. Write an expression (`document.title`, \
                `[...document.querySelectorAll('tr')].map(r => r.innerText)`) or a function \
                body with `return` (`const s = window.__store; return s.getState().user`). \
                Promises are awaited. DOM nodes come back as tag/id/class, text and clipped \
                outerHTML; a thrown error comes back with its message and line. Console output \
                the script produced is included. Use it to read application state, call a page \
                function, test a selector, or measure something the other tools do not expose. \
                For clicking and typing prefer browser_click / browser_fill, which go through \
                real input and report what changed."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "expression": {
                        "type": "string",
                        "description": "The JavaScript to run: an expression, or statements ending in `return`."
                    },
                    "timeout_ms": {
                        "type": "number",
                        "description": "How long the script may run, in milliseconds. Default 15000, maximum 60000."
                    }
                },
                "required": ["expression"]
            }),
        }
    }
    fn requires_permission(&self) -> bool {
        true
    }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        ensure_agent_browser(&self.manager, None).await?;
        let source = input
            .get("expression")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| ToolError::InvalidInput("`expression` must be a non-empty string".into()))?;
        let timeout_ms = input
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(100, MAX_TIMEOUT_MS);

        // The page's own clock, read before the script starts. Console
        // entries are stamped with it, and it is the only way to keep a log
        // from the PREVIOUS call out of this one: the fetch below asks for
        // "the last elapsed + 50 ms", and two scripts sent in one message run
        // back to back inside that slack, so the second used to report the
        // first one's `console.log` as its own (harness run 2026-09-28,
        // thread `5c20f9a3`). Best-effort: without it the slack stands.
        let page_started_at_ms = self
            .manager
            .eval_with_result(AGENT_BROWSER_LABEL, "Date.now()")
            .await
            .ok()
            .filter(|r| r.ok)
            .and_then(|r| r.value)
            .and_then(|v| v.as_f64());

        let started = Instant::now();
        let mut form = "expression";
        let outcome = match self.run(&expression_form(source), timeout_ms).await {
            Err(message) if is_syntax_error(&message) => {
                form = "body";
                self.run(&body_form(source), timeout_ms).await
            }
            other => other,
        };
        let elapsed = started.elapsed().as_millis() as u64;

        // Whatever the script logged while it ran, so a `console.log` inside
        // it is not lost. Best-effort: the bridge may be absent.
        let console = self
            .manager
            .get_console_logs(AGENT_BROWSER_LABEL, None, Some(elapsed + 50))
            .await
            .ok()
            .filter(|r| r.ok)
            .and_then(|r| r.value)
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();
        let console = logged_since(console, page_started_at_ms);

        match outcome {
            Ok(value) => {
                let (value, truncated) = bound_result(value);
                let mut out = json!({
                    "value": value,
                    "form": form,
                    "elapsed_ms": elapsed,
                });
                if !console.is_empty() {
                    out["console"] = json!(console);
                }
                if let Some(note) = truncated {
                    out["truncated"] = json!(note);
                }
                if form == "body" && out["value"].is_null() {
                    out["note"] = json!(
                        "The script ran as a function body and returned nothing. Add `return \
                         <value>` at the end to get a result back."
                    );
                }
                Ok(out.to_string())
            }
            Err(message) => {
                let mut detail = format!("the script threw: {message}");
                if !console.is_empty() {
                    detail.push_str(&format!(
                        " Console while it ran: {}",
                        json!(console)
                    ));
                }
                Err(ToolError::Execution(detail))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_expression_and_a_body_are_wrapped_differently() {
        let expr = expression_form("document.title");
        assert!(expr.contains("(async () => (document.title\n))()"));
        let body = body_form("const a = 1; return a");
        assert!(body.contains("(async () => {const a = 1; return a\n})()"));
        // Both end by serialising, so a node never comes back as `{}`.
        assert!(expr.contains("return __ser(__v, 0)"));
        assert!(body.contains("return __ser(__v, 0)"));
    }

    #[test]
    fn a_trailing_line_comment_cannot_swallow_the_closing_paren() {
        // `document.title // check` would otherwise comment out the `))()`.
        let expr = expression_form("document.title // check");
        assert!(expr.contains("// check\n))()"));
    }

    #[test]
    fn only_a_syntax_error_triggers_the_body_retry() {
        assert!(is_syntax_error("SyntaxError: Unexpected token 'return'"));
        assert!(is_syntax_error("Uncaught SyntaxError: Illegal return statement"));
        assert!(!is_syntax_error("ReferenceError: foo is not defined"));
        assert!(!is_syntax_error("the browser is not available"));
    }

    #[test]
    fn an_oversized_result_is_cut_and_the_cut_is_named() {
        let big = Value::String("x".repeat(MAX_RESULT_CHARS + 500));
        let (value, note) = bound_result(big);
        let note = note.expect("cut is reported");
        assert!(note.contains("first 24000"), "{note}");
        // The JSON text of a string includes its quotes; the kept slice is
        // the raw text, so it starts with one.
        assert!(value.as_str().unwrap().starts_with('"'));
        assert_eq!(value.as_str().unwrap().chars().count(), MAX_RESULT_CHARS);

        let small = json!({ "a": 1 });
        let (kept, note) = bound_result(small.clone());
        assert_eq!(kept, small);
        assert!(note.is_none());
    }

    #[test]
    fn the_serializer_bounds_every_axis() {
        // Depth, list width, key count and string length are each capped, so
        // `window` or a React fibre tree cannot produce an unbounded result.
        assert!(SERIALIZE_JS.contains("depth > 6"));
        assert!(SERIALIZE_JS.contains("slice(0, 200)"));
        assert!(SERIALIZE_JS.contains("__clip(v, 5000)"));
        assert!(SERIALIZE_JS.contains("'[circular]'"));
        assert!(SERIALIZE_JS.contains("instanceof Node"));
    }
}
