//! `shell_notify` — the agent decides whether a background process's ending
//! should wake it.
//!
//! A background process (a `shell_spawn`, or a command the person moved to the
//! background) can end long after the agent's turn. Whether that ending is
//! worth a turn of its own is the agent's call, not a clock's: an agent that
//! said "I'll open the installer when the build finishes" needs to be woken
//! however long the build takes, while one that only started a dev server for
//! the person does not.
//!
//! - `wake: true` — wake the agent when it ends, however long that takes.
//! - `wake: false` — do not wake it; the ending rides in with the person's
//!   next message in that conversation.
//! - never called — the window wakes the agent only when the process ends
//!   within a few minutes of the agent's last turn, and otherwise lets the
//!   ending ride in with the next message.
//!
//! The choice lives on the process's ledger row (`process::streams`) and goes
//! out with `shell-process-ended`; the window acts on it.

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};

pub struct ShellNotifyTool;

fn identifier(input: &Value, key: &str) -> Option<String> {
    let value = input.get(key)?;
    let raw = value
        .as_str()
        .map(str::to_string)
        .or_else(|| value.as_u64().map(|n| n.to_string()))?;
    let trimmed = raw.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// `wake` as a boolean, accepting the string forms gateways sometimes send.
fn wake(input: &Value) -> Option<bool> {
    match input.get("wake")? {
        Value::Bool(wake) => Some(*wake),
        Value::String(text) => match text.trim().to_ascii_lowercase().as_str() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

#[async_trait]
impl ToolExecutor for ShellNotifyTool {
    fn name(&self) -> &str {
        "shell_notify"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "shell_notify".into(),
            description: "Decide whether a running background process (from shell_spawn, or a \
                          command the user moved to the background) should wake you when it ends.\n\
                          - wake: true — Aurora starts a turn for you when it ends, however long \
                          that takes. Use it when you have something to do with the result, \
                          especially when you told the user you would act once it finishes \
                          (\"I'll open the installer when the build is done\").\n\
                          - wake: false — you are not woken; you learn how it ended with the \
                          user's next message. Use it for things the user is watching \
                          themselves, like a dev server they asked for.\n\
                          If you never call this, you are woken only when it ends within a few \
                          minutes of your last turn."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "processId": {"type": "string", "description": "The process id from shell_spawn, or from the moved-to-background result"},
                    "wake": {"type": "boolean", "description": "true: wake me when it ends. false: do not wake me."}
                },
                "required": ["processId", "wake"]
            }),
        }
    }

    fn requires_permission(&self) -> bool {
        false
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let process = identifier(&input, "processId")
            .ok_or_else(|| ToolError::InvalidInput("shell_notify requires `processId`".into()))?;
        let wake = wake(&input).ok_or_else(|| {
            ToolError::InvalidInput("shell_notify requires `wake`: true or false".into())
        })?;
        let (process_id, name) = crate::process::streams::set_process_wake(&process, wake)
            .map_err(ToolError::InvalidInput)?;
        let message = if wake {
            format!(
                "Aurora will start a turn for you when \"{name}\" ({process_id}) ends, however \
                 long that takes. You can end your turn now; do not poll it."
            )
        } else {
            format!(
                "You will not be woken when \"{name}\" ({process_id}) ends. You will learn how it \
                 ended with the user's next message."
            )
        };
        Ok(json!({
            "success": true,
            "processId": process_id,
            "wake": wake,
            "message": message,
        })
        .to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_util::sync::CancellationToken;

    fn ctx() -> ToolContext {
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

    #[tokio::test]
    async fn records_the_choice_on_the_running_process() {
        crate::process::streams::register_command_stream(
            "req-notify".into(),
            "bg-notify".into(),
            Some("Installer build".into()),
            "pnpm desktop:dist".into(),
            None,
            None,
        );
        let out = ShellNotifyTool
            .execute(json!({"processId": "bg-notify", "wake": true}), &ctx())
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["wake"], json!(true));
        assert!(parsed["message"].as_str().unwrap().contains("Installer build"));
        let row = crate::process::streams::list_command_streams()
            .into_iter()
            .find(|stream| stream.process_id == "bg-notify")
            .expect("still running");
        assert_eq!(row.wake, Some(true));

        ShellNotifyTool
            .execute(json!({"processId": "bg-notify", "wake": "false"}), &ctx())
            .await
            .expect("a string boolean is accepted");
        let row = crate::process::streams::list_command_streams()
            .into_iter()
            .find(|stream| stream.process_id == "bg-notify")
            .expect("still running");
        assert_eq!(row.wake, Some(false));
    }

    #[tokio::test]
    async fn an_unknown_process_or_a_missing_choice_is_refused() {
        let unknown = ShellNotifyTool
            .execute(json!({"processId": "bg-never", "wake": true}), &ctx())
            .await
            .expect_err("no such process");
        assert!(matches!(unknown, ToolError::InvalidInput(_)));
        let missing = ShellNotifyTool
            .execute(json!({"processId": "bg-never"}), &ctx())
            .await
            .expect_err("no choice");
        assert!(matches!(missing, ToolError::InvalidInput(_)));
    }
}
