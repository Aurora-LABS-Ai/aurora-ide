//! Tool names from other harnesses, run as the Aurora tool that does the job.
//!
//! Some models reach for the names they were trained on. Measured across every
//! saved conversation on 2026-10-25: `deepseek-flash` called `write`, `read`
//! and `bash` (Claude Code's `Write`/`Read`/`Bash`, lowercased) while its
//! arguments were already Aurora's (`path`, `content`, `command`). Each miss
//! cost a whole round trip for a call whose meaning was never in doubt. It
//! also once sent a call packed inside another:
//! `write {"tool_name": "file_write", "tool_input": {…}}`.
//!
//! Both are now run as the tool they name, and the result says so in one
//! line, so the next call uses the real name. Nothing else changes: the alias
//! resolves to the REGISTERED executor, which already carries the permission
//! gate and timeout guard, and the read-before-change rule lives inside the
//! file tools themselves.
//!
//! A row fires only when its target is registered in this session — an alias
//! can never call a tool the mode withheld.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

use super::api_client::ToolSchema;
use super::tool_executor::{ToolContext, ToolError, ToolExecutor, ToolInvocation, ToolRegistry};

/// Foreign name → Aurora tool. Lowercase; matched case-insensitively.
///
/// The bar for a row: a model is LIKELY to send it, and the target accepts the
/// arguments that name implies. `bash` → `shell_execute` fits (`command`);
/// `glob`/`grep` need no row because Aurora already uses those names.
const FOREIGN_NAMES: &[(&str, &str)] = &[
    ("write", "file_write"),
    ("write_file", "file_write"),
    ("read", "file_read"),
    ("read_file", "file_read"),
    ("edit", "file_edit"),
    ("edit_file", "file_edit"),
    ("multiedit", "file_edit"),
    ("bash", "shell_execute"),
];

/// Resolve a name the registry does not know, if it is a foreign name or a
/// packed call. `None` means "really unknown" and the caller reports it.
pub(crate) fn resolve(
    registry: &ToolRegistry,
    name: &str,
    input: &Value,
) -> Option<ToolInvocation> {
    // A call packed inside another: the outer name is noise, the inner one
    // is what the model meant.
    if let (Some(inner), Some(inner_input)) = (
        input.get("tool_name").and_then(Value::as_str),
        input.get("tool_input").filter(|v| v.is_object()),
    ) {
        let target = registry.get(inner)?;
        let note = format!(
            "Ran as `{inner}`: this call was sent as `{name}` with the real call packed inside \
             (`tool_name` + `tool_input`). Call `{inner}` directly with those arguments next time."
        );
        return Some(invocation(target, inner_input.clone(), note));
    }

    let wanted = name.to_ascii_lowercase();
    let (_, target_name) = FOREIGN_NAMES.iter().find(|(foreign, _)| *foreign == wanted)?;
    let target = registry.get(target_name)?;
    let mut input = input.clone();
    let mut renamed = "";
    // Claude Code's file tools say `file_path`; Aurora's say `path`.
    if let Some(object) = input.as_object_mut() {
        if !object.contains_key("path") {
            if let Some(path) = object.remove("file_path") {
                object.insert("path".into(), path);
                renamed = " (`file_path` read as `path`)";
            }
        }
    }
    let note = format!(
        "Ran as `{target_name}`{renamed}: `{name}` is not an Aurora tool name. Use \
         `{target_name}` next time."
    );
    Some(invocation(target, input, note))
}

/// The same, for a name sent through `call_tool {"name", "arguments"}`.
///
/// Seen in the first live test (dogfood, 2026-10-25): asked to call `write`,
/// the model routed it through `call_tool`, whose catalog holds only optional
/// tools, so all three alias calls failed there instead of running.
pub(crate) fn resolve_forwarded(registry: &ToolRegistry, input: &Value) -> Option<ToolInvocation> {
    let name = input.get("name").and_then(Value::as_str)?;
    let arguments = input.get("arguments").filter(|v| v.is_object())?;
    resolve(registry, name, arguments)
}

fn invocation(target: Arc<dyn ToolExecutor>, input: Value, note: String) -> ToolInvocation {
    ToolInvocation {
        executor: Arc::new(Noted { inner: target, note }),
        input,
    }
}

/// The real executor, plus one line on its result. Everything else forwards,
/// so the call is the target tool in every respect: name, schema, approval,
/// concurrency, timeout.
struct Noted {
    inner: Arc<dyn ToolExecutor>,
    note: String,
}

#[async_trait]
impl ToolExecutor for Noted {
    fn name(&self) -> &str {
        self.inner.name()
    }

    fn schema(&self) -> ToolSchema {
        self.inner.schema()
    }

    async fn execute(&self, input: Value, context: &ToolContext) -> Result<String, ToolError> {
        let output = self.inner.execute(input, context).await?;
        Ok(with_note(&output, &self.note))
    }

    fn requires_permission(&self) -> bool {
        self.inner.requires_permission()
    }

    fn concurrency_safe(&self) -> bool {
        self.inner.concurrency_safe()
    }

    fn uses_frontend_lifecycle(&self) -> bool {
        self.inner.uses_frontend_lifecycle()
    }

    fn timeout_policy(&self) -> Option<crate::tools::timeout::TimeoutPolicy> {
        self.inner.timeout_policy()
    }
}

/// Put `note` on a result: a `note` field on a JSON object (ahead of any note
/// the tool wrote itself), or a trailing line on plain text.
fn with_note(output: &str, note: &str) -> String {
    if let Ok(Value::Object(mut object)) = serde_json::from_str::<Value>(output) {
        let combined = match object.get("note").and_then(Value::as_str) {
            Some(existing) => format!("{note} {existing}"),
            None => note.to_string(),
        };
        object.insert("note".into(), Value::String(combined));
        return Value::Object(object).to_string();
    }
    format!("{output}\n\nNote: {note}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Echo(&'static str);

    #[async_trait]
    impl ToolExecutor for Echo {
        fn name(&self) -> &str {
            self.0
        }
        fn schema(&self) -> ToolSchema {
            ToolSchema {
                name: self.0.into(),
                description: String::new(),
                input_schema: json!({}),
            }
        }
        async fn execute(&self, input: Value, _: &ToolContext) -> Result<String, ToolError> {
            Ok(json!({ "success": true, "got": input }).to_string())
        }
        fn requires_permission(&self) -> bool {
            true
        }
    }

    fn registry() -> ToolRegistry {
        let reg = ToolRegistry::new();
        reg.register(Arc::new(Echo("file_write")));
        reg.register(Arc::new(Echo("file_read")));
        reg
    }

    fn ctx() -> ToolContext {
        ToolContext {
            workspace_access: Default::default(),
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            thread_id: "s".into(),
            workspace_root: None,
            cancel_token: tokio_util::sync::CancellationToken::new(),
            spill_dir: None,
        }
    }

    /// The 09-27 shape: `write` with Aurora's own arguments runs as
    /// `file_write`, keeps its approval requirement, and says what it did.
    #[tokio::test]
    async fn a_foreign_name_runs_as_the_aurora_tool_with_a_note() {
        let reg = registry();
        let call = reg
            .resolve_call("write", &json!({ "path": "a.md", "content": "x" }))
            .expect("resolved");
        assert_eq!(call.executor.name(), "file_write");
        assert!(call.executor.requires_permission());
        let out: Value =
            serde_json::from_str(&call.executor.execute(call.input, &ctx()).await.unwrap()).unwrap();
        assert_eq!(out["got"]["path"], "a.md");
        assert!(out["note"].as_str().unwrap().contains("Ran as `file_write`"), "{out}");
    }

    /// Claude Code's argument name comes along with its tool name.
    #[tokio::test]
    async fn file_path_is_read_as_path() {
        let call = registry()
            .resolve_call("Read", &json!({ "file_path": "b.md" }))
            .expect("resolved");
        assert_eq!(call.executor.name(), "file_read");
        assert_eq!(call.input["path"], "b.md");
        assert!(call.input.get("file_path").is_none());
    }

    /// The 2026-10-25 DeepSeek call, verbatim in shape.
    #[tokio::test]
    async fn a_packed_call_runs_the_tool_inside_it() {
        let reg = registry();
        let call = reg
            .resolve_call(
                "write",
                &json!({
                    "tool_use_id": "call_cloud_composer",
                    "tool_name": "file_write",
                    "tool_input": { "path": "c.tsx", "content": "y" }
                }),
            )
            .expect("resolved");
        assert_eq!(call.executor.name(), "file_write");
        assert_eq!(call.input, json!({ "path": "c.tsx", "content": "y" }));
        let out = call.executor.execute(call.input, &ctx()).await.unwrap();
        assert!(out.contains("packed inside"), "{out}");
    }

    /// The first live test's shape: the model sent the foreign name through
    /// `call_tool`, plain and packed. Both run.
    #[test]
    fn a_foreign_name_through_call_tool_runs() {
        let reg = registry();
        crate::tools::tool_search::install(&reg, Vec::new());
        let plain = reg
            .resolve_call(
                "call_tool",
                &json!({ "name": "write", "arguments": { "path": "a.md", "content": "x" } }),
            )
            .expect("resolved through call_tool");
        assert_eq!(plain.executor.name(), "file_write");
        let packed = reg
            .resolve_call(
                "call_tool",
                &json!({
                    "name": "write",
                    "arguments": { "tool_name": "file_write", "tool_input": { "path": "p.md", "content": "y" } }
                }),
            )
            .expect("packed through call_tool");
        assert_eq!(packed.input["path"], "p.md");
        assert!(reg
            .resolve_call("call_tool", &json!({ "name": "nope", "arguments": {} }))
            .is_err());
    }

    /// An alias never reaches a tool this session does not have, and a name
    /// that is neither alias nor packed call stays an unknown-tool error.
    #[test]
    fn unregistered_targets_and_real_unknowns_stay_errors() {
        let reg = registry();
        assert!(reg.resolve_call("bash", &json!({ "command": "ls" })).is_err());
        assert!(reg.resolve_call("browser_eval", &json!({})).is_err());
        assert!(reg
            .resolve_call("x", &json!({ "tool_name": "nope", "tool_input": {} }))
            .is_err());
    }

    #[test]
    fn a_plain_text_result_gets_a_trailing_note() {
        assert_eq!(with_note("done", "Ran as `x`."), "done\n\nNote: Ran as `x`.");
        let merged: Value =
            serde_json::from_str(&with_note(r#"{"note":"path repaired"}"#, "Ran as `x`.")).unwrap();
        assert_eq!(merged["note"], "Ran as `x`. path repaired");
    }
}
