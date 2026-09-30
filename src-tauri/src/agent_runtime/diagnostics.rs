//! Small, correlated lifecycle records. Command bodies, prompts, arguments,
//! and tool output stay in the conversation, not the shared diagnostic log.
use super::tool_executor::{ToolContext, ToolError};
use serde_json::{json, Value};
use std::time::Instant;

fn write(level: &str, component: &str, message: &str) {
    // Synthetic test conversations must not enter the installed app's log.
    #[cfg(not(test))]
    match level {
        "ERROR" => crate::logging::log_error(component, message),
        "WARN" => crate::logging::log_warn(component, message),
        _ => crate::logging::log_info(component, message),
    }
    #[cfg(test)]
    let _ = (level, component, message);
}

pub(crate) fn tool_started(ctx: &ToolContext, name: &str) -> Instant {
    write(
        "INFO",
        "agent_runtime.tool",
        &json!({
            "event": "started", "thread_id": ctx.thread_id, "turn_id": ctx.turn_id,
            "call_id": ctx.tool_call_id, "tool": name, "access": ctx.workspace_access,
        })
        .to_string(),
    );
    Instant::now()
}

fn outcome_fields(outcome: &Result<String, ToolError>) -> (&'static str, Value) {
    match outcome {
        Ok(output) => {
            let value = serde_json::from_str::<Value>(output).unwrap_or(Value::Null);
            let timed_out = value.get("timedOut").and_then(Value::as_bool) == Some(true);
            let failed = value.get("success").and_then(Value::as_bool) == Some(false);
            let status = if timed_out {
                "timeout"
            } else if failed {
                "failed"
            } else {
                "completed"
            };
            let mut fields = json!({ "outcome": status, "result_bytes": output.len() });
            for key in [
                "exitCode",
                "timedOut",
                "timeoutMs",
                "leftRunning",
                "detached",
                "returned",
                "truncated",
            ] {
                if let Some(item) = value
                    .get(key)
                    .filter(|item| item.is_number() || item.is_boolean() || item.is_null())
                {
                    fields[key] = item.clone();
                }
            }
            if let Some(shell) = value.get("shell").and_then(Value::as_str).filter(|shell| {
                matches!(
                    *shell,
                    "bash" | "sh" | "zsh" | "pwsh" | "powershell" | "cmd"
                )
            }) {
                fields["shell"] = json!(shell);
            }
            (if timed_out || failed { "WARN" } else { "INFO" }, fields)
        }
        Err(error) => {
            let (level, outcome) = match error {
                ToolError::Cancelled => ("INFO", "cancelled"),
                ToolError::PermissionDenied(_) => ("INFO", "denied"),
                ToolError::PolicyViolation(_) | ToolError::PathEscape(_) => {
                    ("WARN", "policy_blocked")
                }
                ToolError::InvalidInput(_) | ToolError::MalformedInput(_) => {
                    ("WARN", "invalid_input")
                }
                ToolError::NotFound(_) => ("WARN", "not_found"),
                ToolError::Timeout { .. } => ("WARN", "timeout"),
                ToolError::Execution(_) => ("ERROR", "execution_failed"),
            };
            let mut fields = json!({"outcome": outcome});
            if let ToolError::Timeout { timeout_ms, .. } = error {
                fields["timeoutMs"] = json!(timeout_ms);
            }
            (level, fields)
        }
    }
}

pub(crate) fn tool_finished(
    ctx: &ToolContext,
    name: &str,
    started: Instant,
    outcome: &Result<String, ToolError>,
) {
    let (level, mut fields) = outcome_fields(outcome);
    fields["thread_id"] = json!(ctx.thread_id);
    fields["turn_id"] = json!(ctx.turn_id);
    fields["call_id"] = json!(ctx.tool_call_id);
    fields["tool"] = json!(name);
    fields["event"] = json!("finished");
    fields["elapsed_ms"] = json!(started.elapsed().as_millis());
    let message = fields.to_string();
    write(level, "agent_runtime.tool", &message);
}

/// Covers setup failures too, including returns before the runtime is created.
pub(crate) struct TurnTrace {
    fields: Value,
    started: Instant,
    finished: bool,
}

impl TurnTrace {
    pub(crate) fn new(
        thread: &str,
        turn: &str,
        model: &str,
        mode: &str,
        access: Option<&str>,
    ) -> Self {
        let fields = json!({"thread_id": thread, "turn_id": turn, "model": model, "mode": mode, "access": access, "event": "started"});
        write("INFO", "agent_runtime.turn", &fields.to_string());
        Self {
            fields,
            started: Instant::now(),
            finished: false,
        }
    }

    pub(crate) fn finish(&mut self, outcome: &str, iterations: Option<u32>) {
        self.finished = true;
        self.fields["event"] = json!("finished");
        self.fields["outcome"] = json!(outcome);
        self.fields["elapsed_ms"] = json!(self.started.elapsed().as_millis());
        if let Some(iterations) = iterations {
            self.fields["iterations"] = json!(iterations);
        }
        let message = self.fields.to_string();
        if matches!(outcome, "completed" | "cancelled") {
            write("INFO", "agent_runtime.turn", &message);
        } else {
            write("ERROR", "agent_runtime.turn", &message);
        }
    }
}

impl Drop for TurnTrace {
    fn drop(&mut self) {
        if !self.finished {
            self.finish("setup_failed_or_interrupted", None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structured_failures_are_not_logged_as_success_and_payloads_are_private() {
        let result = Ok(json!({"success": false, "exitCode": 2, "command": "secret-command", "stderr": "secret-output"}).to_string());
        let (level, fields) = outcome_fields(&result);
        assert_eq!(level, "WARN");
        assert_eq!(fields["outcome"], "failed");
        assert_eq!(fields["exitCode"], 2);
        assert!(!fields.to_string().contains("secret"));
        assert_eq!(outcome_fields(&Err(ToolError::Cancelled)).0, "INFO");
        assert_eq!(
            outcome_fields(&Err(ToolError::PolicyViolation("private-path".into()))).1["outcome"],
            "policy_blocked"
        );
        assert_eq!(
            outcome_fields(&Ok(json!({"success": false, "timedOut": true}).to_string())).1
                ["outcome"],
            "timeout"
        );
    }
}
