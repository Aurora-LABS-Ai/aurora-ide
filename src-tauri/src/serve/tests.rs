use std::sync::Arc;

use super::*;
use crate::agent_runtime::host::{AgentRegistry, ApiFactory};
use crate::tools::permissions::PermissionRouter;

struct NoApi;

impl ApiFactory for NoApi {
    fn build(
        &self,
        _config: &crate::api::ProviderConfigSnapshot,
    ) -> Result<
        Arc<dyn crate::agent_runtime::api_client::StreamingApiClient>,
        crate::agent_runtime::error::RuntimeError,
    > {
        Err(crate::agent_runtime::error::RuntimeError::InvalidState("no model".into()))
    }
}

const TOKEN: &str = "test-token";

/// A server on a free local port, and its base address.
async fn start(dist: Option<PathBuf>) -> (String, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let hub = Arc::new(EventHub::default());
    let events: crate::host_events::Events = hub.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let host = Arc::new(ServeHost {
        ctx: CommandContext {
            registry: Arc::new(AgentRegistry::new(Arc::new(NoApi), dir.path().to_path_buf())),
            permissions: Arc::new(PermissionRouter::new()),
            events,
            db: Arc::new(std::sync::Mutex::new(
                crate::db::Database::in_memory().expect("in-memory database"),
            )),
            checkpoints: Arc::new(crate::checkpoints::commands::CheckpointState::new()),
            explorer: Default::default(),
            refine: Default::default(),
        },
        hub,
        token: TOKEN.into(),
        port,
        access: access::Access::open_in(dir.path().join("web"), None),
        dist,
    });
    tokio::spawn(async move {
        let _ = axum::serve(listener, router(host)).await;
    });
    (format!("http://127.0.0.1:{port}"), dir)
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client")
}

#[tokio::test]
async fn nothing_answers_without_the_token() {
    let (base, _dir) = start(None).await;
    let api = client()
        .post(format!("{base}/api/invoke/agent_active_turns"))
        .send()
        .await
        .unwrap();
    assert_eq!(api.status(), 401);
    let page = client().get(format!("{base}/agent-window")).send().await.unwrap();
    assert_eq!(page.status(), 401);
    assert!(page.text().await.unwrap().contains("sign-in link"));
    // A cookie that is not a session gets nothing either.
    let forged = client()
        .post(format!("{base}/api/invoke/agent_active_turns"))
        .header(header::COOKIE, "aurora_session=made-up")
        .send()
        .await
        .unwrap();
    assert_eq!(forged.status(), 401);
}

#[tokio::test]
async fn a_signed_in_call_runs_the_command_registry() {
    let (base, _dir) = start(None).await;
    let reply: Value = client()
        .post(format!("{base}/api/invoke/agent_active_turns"))
        .bearer_auth(TOKEN)
        .json(&json!({ "args": {} }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(reply, json!({ "ok": true, "data": [] }));

    let unknown: Value = client()
        .post(format!("{base}/api/invoke/no_such_command"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(unknown["ok"], json!(false));
    assert!(unknown["error"].as_str().unwrap().contains("unknown command"));
}

#[tokio::test]
async fn a_foreign_host_name_is_refused_even_with_the_token() {
    let (base, _dir) = start(None).await;
    let response = client()
        .post(format!("{base}/api/invoke/agent_active_turns"))
        .bearer_auth(TOKEN)
        .header(header::HOST, "evil.example")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
}

/// The `aurora_session=…` pair a response set.
fn session_of(response: &reqwest::Response) -> String {
    let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap().to_string();
    assert!(cookie.contains("HttpOnly") && cookie.contains("Max-Age=2592000"), "{cookie}");
    cookie.split(';').next().unwrap().to_string()
}

#[tokio::test]
async fn the_sign_in_link_starts_a_session_and_drops_the_token() {
    let (base, _dir) = start(None).await;
    let response = client()
        .get(format!("{base}/agent-window?token={TOKEN}"))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_redirection());
    assert_eq!(response.headers()[header::LOCATION], "/agent-window");
    let session = session_of(&response);
    assert!(session.starts_with("aurora_session=") && !session.contains(TOKEN));

    let page = client()
        .get(format!("{base}/agent-window"))
        .header(header::COOKIE, &session)
        .send()
        .await
        .unwrap();
    // Signed in; no `--dist`, so the page says how to get an interface.
    assert_eq!(page.status(), 404);
    assert!(page.text().await.unwrap().contains("no built interface"));
}

#[tokio::test]
async fn the_password_page_signs_in_and_a_wrong_password_does_not() {
    let (base, dir) = start(None).await;
    access::set_password(&dir.path().join("web"), "open sesame").unwrap();

    let page = client().get(format!("{base}/agent-window/p/x")).send().await.unwrap();
    assert_eq!(page.status(), 401);
    let html = page.text().await.unwrap();
    assert!(html.contains("type=\"password\"") && html.contains("value=\"/agent-window/p/x\""));

    let wrong = client()
        .post(format!("{base}/login"))
        .form(&[("password", "nope"), ("next", "/agent-window")])
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), 401);
    assert!(wrong.headers().get(header::SET_COOKIE).is_none());

    let right = client()
        .post(format!("{base}/login"))
        .form(&[("password", "open sesame"), ("next", "//evil.example/steal")])
        .send()
        .await
        .unwrap();
    assert!(right.status().is_redirection());
    // Never sent to another site.
    assert_eq!(right.headers()[header::LOCATION], "/agent-window");
    let session = session_of(&right);

    let api: Value = client()
        .post(format!("{base}/api/invoke/agent_active_turns"))
        .header(header::COOKIE, &session)
        .json(&json!({ "args": {} }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(api, json!({ "ok": true, "data": [] }));

    // Signing out ends it.
    let out = client()
        .post(format!("{base}/api/logout"))
        .header(header::COOKIE, &session)
        .send()
        .await
        .unwrap();
    assert_eq!(out.status(), 204);
    let after = client()
        .post(format!("{base}/api/invoke/agent_active_turns"))
        .header(header::COOKIE, &session)
        .send()
        .await
        .unwrap();
    assert_eq!(after.status(), 401);
}

#[tokio::test]
async fn app_addresses_get_the_built_index_and_files_come_from_dist() {
    let dist = tempfile::tempdir().expect("dist");
    std::fs::write(dist.path().join("index.html"), "<html>aurora</html>").unwrap();
    std::fs::create_dir(dist.path().join("assets")).unwrap();
    std::fs::write(dist.path().join("assets").join("app.js"), "console.log(1)").unwrap();
    let (base, _dir) = start(Some(dist.path().to_path_buf())).await;

    let index = client()
        .get(format!("{base}/agent-window/p/e--repo/abc"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(index.status(), 200);
    assert_eq!(index.text().await.unwrap(), "<html>aurora</html>");

    let script = client()
        .get(format!("{base}/assets/app.js"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(
        script.headers()[header::CONTENT_TYPE],
        "text/javascript; charset=utf-8"
    );
}

#[test]
fn a_page_path_cannot_climb_out_of_dist() {
    let root = Path::new("/srv/dist");
    assert_eq!(inside(root, "assets/a.js"), Some(root.join("assets").join("a.js")));
    assert_eq!(inside(root, "../secret.txt"), None);
    assert_eq!(inside(root, "assets/../../secret.txt"), None);
}

#[test]
fn a_browser_turn_is_marked_as_coming_from_the_web() {
    let mut args = json!({ "request": { "client": "desktop" } });
    stamp_web_client("agent_chat_v2", &mut args);
    assert_eq!(args["request"]["client"], "web");
    let mut other = json!({ "request": {} });
    stamp_web_client("agent_cancel", &mut other);
    assert_eq!(other, json!({ "request": {} }));
}
