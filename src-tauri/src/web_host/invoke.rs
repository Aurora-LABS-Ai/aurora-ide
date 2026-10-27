//! `POST /api/invoke/{cmd}`: one command call from the browser, run by
//! Tauri's own command handler.
//!
//! The request is handed to [`tauri::webview::Webview::on_message`], the same
//! entry the window's IPC protocol uses, on the IDE window's webview (any
//! other webview when that one is gone). Tauri then resolves the command,
//! checks its permissions for that webview's own local URL, injects state,
//! app handle and window, and answers through the responder below. Nothing
//! is registered twice, so a new command works in the browser the moment it
//! is in `generate_handler!`.
//!
//! Not supported from the browser: arguments that are Tauri `Channel`s (the
//! Terminal panel's stream), because the channel id would point into the
//! desktop window's page.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponse, InvokeResponseBody};
use tauri::webview::InvokeRequest;
use tauri::{Manager, Webview};

use super::WebHost;

/// The webview a browser's call runs as. The IDE window (`main`) is created at
/// startup and only hidden, so it is almost always there.
fn host_webview(app: &tauri::AppHandle) -> Option<Webview> {
    let mut webviews = app.webviews();
    webviews
        .remove("main")
        .or_else(|| webviews.into_values().next())
}

pub(super) async fn handle(
    State(host): State<Arc<WebHost>>,
    Path(command): Path<String>,
    body: Option<Json<Value>>,
) -> Response {
    let mut args = body
        .and_then(|Json(body)| body.get("args").cloned())
        .unwrap_or_else(|| json!({}));
    stamp_web_client(&command, &mut args);
    match run(&host.app, command.clone(), args).await {
        Ok(data) => reply(StatusCode::OK, json!({ "ok": true, "data": data })),
        Err(error) => {
            crate::logging::log_warn("web", &format!("`{command}` failed: {error}"));
            reply(StatusCode::OK, json!({ "ok": false, "error": error }))
        }
    }
}

async fn run(app: &tauri::AppHandle, command: String, args: Value) -> Result<Value, String> {
    let webview = host_webview(app).ok_or("Aurora has no window to run commands in")?;
    let url = webview
        .url()
        .map_err(|e| format!("could not read the window's address: {e}"))?;
    let mut headers = tauri::http::HeaderMap::new();
    headers.insert(
        tauri::http::header::CONTENT_TYPE,
        tauri::http::HeaderValue::from_static("application/json"),
    );
    let request = InvokeRequest {
        cmd: command.clone(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url,
        body: InvokeBody::Json(args),
        headers,
        invoke_key: app.invoke_key().to_string(),
    };
    let (tx, rx) = tokio::sync::oneshot::channel::<InvokeResponse>();
    let responder = Box::new(move |_webview: Webview, _cmd: String, response: InvokeResponse, _ok: CallbackFn, _err: CallbackFn| {
        let _ = tx.send(response);
    });
    // A synchronous command runs inside `on_message`; keep it off the
    // server's async workers.
    tokio::task::spawn_blocking(move || webview.on_message(request, responder))
        .await
        .map_err(|e| format!("command task failed: {e}"))?;
    match rx.await {
        Ok(InvokeResponse::Ok(InvokeResponseBody::Json(text))) => {
            serde_json::from_str(&text).map_err(|e| format!("`{command}` returned unreadable JSON: {e}"))
        }
        Ok(InvokeResponse::Ok(InvokeResponseBody::Raw(bytes))) => Ok(json!(bytes)),
        Ok(InvokeResponse::Err(error)) => Err(match error.0 {
            Value::String(message) => message,
            other => other.to_string(),
        }),
        // Tauri drops the responder without answering when it refuses the
        // call before running it (wrong key, unknown origin).
        Err(_) => Err(format!("`{command}` was refused before it ran")),
    }
}

/// A turn started from the browser says so (`AgentChatRequest::client`),
/// whatever the page put there.
fn stamp_web_client(command: &str, args: &mut Value) {
    if command != "agent_chat_v2" {
        return;
    }
    if let Some(request) = args.get_mut("request").and_then(Value::as_object_mut) {
        request.insert("client".into(), json!("web"));
    }
}

fn reply(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}
