//! Plans: reading a workspace's plans and changing a step or a plan's status
//! from the Plan Canvas. The bodies are [`crate::plans::commands`], which the
//! window registers directly. They read and write files, so they run off the
//! async threads, as the window's `(async)` commands do.

use serde_json::Value;

use super::{arg, done, CommandContext, CommandError};
use crate::plans::commands as plans;
use crate::plans::commands::{PlanBodyRequest, PlanStatusRequest, PlanStepStatusRequest};

pub const COMMANDS: &[&str] = &[
    "plan_get_active",
    "plan_get",
    "plan_list",
    "plan_set_step_status",
    "plan_save_body",
    "plan_set_status",
];

/// Run `name` if it is one of these; `None` hands it on.
pub(super) async fn dispatch(
    _ctx: &CommandContext,
    name: &str,
    args: &Value,
) -> Option<Result<Value, CommandError>> {
    let n = name;
    macro_rules! get {
        ($key:literal) => {
            match arg(n, args, $key) {
                Ok(v) => v,
                Err(e) => return Some(Err(e)),
            }
        };
    }
    Some(match name {
        "plan_get_active" => {
            let root: String = get!("workspaceRoot");
            done(blocking(move || plans::plan_get_active(root)).await)
        }
        "plan_get" => {
            let root: String = get!("workspaceRoot");
            let plan_id: String = get!("planId");
            done(blocking(move || plans::plan_get(root, plan_id)).await)
        }
        "plan_list" => {
            let root: String = get!("workspaceRoot");
            done(blocking(move || plans::plan_list(root)).await)
        }
        "plan_set_step_status" => {
            let request: PlanStepStatusRequest = get!("request");
            done(blocking(move || plans::plan_set_step_status(request)).await)
        }
        "plan_save_body" => {
            let request: PlanBodyRequest = get!("request");
            done(blocking(move || plans::plan_save_body(request)).await)
        }
        "plan_set_status" => {
            let request: PlanStatusRequest = get!("request");
            done(blocking(move || plans::plan_set_status(request)).await)
        }
        _ => return None,
    })
}

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("the plan task stopped: {e}"))?
}
