use super::{jobs, wire::VideoRequest};
use crate::agent_runtime::session_store::SessionStore;
use crate::tools::image::{
    client::fake_server::{serve, Canned},
    config::ImageProviderConfig,
};
use serde_json::json;

fn provider(base: &str) -> ImageProviderConfig {
    serde_json::from_value(json!({"id":"minimax","name":"MiniMax","baseUrl":base,"apiKey":"secret-test-key","apiFormat":"minimax-native","enabled":true})).unwrap()
}
fn prompt(model: Option<&str>) -> VideoRequest {
    VideoRequest {
        prompt: "A sunrise".into(),
        model: model.map(str::to_string),
        ..Default::default()
    }
}
fn mp4() -> Canned {
    Canned {
        status: 200,
        content_type: "video/mp4",
        body: b"\0\0\0\x18ftypmp42test-video".to_vec(),
    }
}

#[tokio::test]
async fn hailuo_task_is_durable_downloads_once_and_never_persists_credentials() {
    let media = serve(vec![mp4()]).await;
    let api = serve(vec![
        Canned::json(200, r#"{"task_id":"42","base_resp":{"status_code":0}}"#),
        Canned::json(
            200,
            r#"{"status":"Success","file_id":"99","video_width":720,"video_height":1280}"#,
        ),
        Canned::json(
            200,
            &json!({"file":{"download_url":format!("{}/clip.mp4",media.base_url)}}).to_string(),
        ),
    ])
    .await;
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::new_folder(temp.path().into());
    let p = provider(&api.base_url);
    let created = jobs::create(&store, "chat-one", &p, prompt(None))
        .await
        .unwrap();
    assert_eq!(created.status, "queued");
    let dir = jobs::folder(&store, "chat-one").unwrap();
    let saved = tokio::fs::read_to_string(dir.join(format!("{}.json", created.job_id)))
        .await
        .unwrap();
    assert!(!saved.contains("secret-test-key"));
    let restarted = SessionStore::new_folder(temp.path().into());
    let done = jobs::refresh(&restarted, "chat-one", &p, &created.job_id)
        .await
        .unwrap();
    assert!(std::path::Path::new(done.path.as_ref().unwrap()).is_file());
    assert_eq!(done.aspect_ratio, 720.0 / 1280.0);
    let again = jobs::refresh(&restarted, "chat-one", &p, &created.job_id)
        .await
        .unwrap();
    assert_eq!(again.path, done.path);
    let calls = api.recorded();
    assert_eq!(calls.len(), 3);
    assert_eq!(calls[0].path, "/v1/video_generation");
    assert_eq!(calls[0].json()["model"], "MiniMax-Hailuo-2.3");
    assert_eq!(
        calls[0].header("authorization"),
        Some("Bearer secret-test-key")
    );
    assert_eq!(calls[1].method, "GET");
    assert_eq!(media.recorded().len(), 1);
    assert!(media.recorded()[0].header("authorization").is_none());
    assert!(jobs::refresh(&store, "another-chat", &p, &created.job_id)
        .await
        .is_err());
    assert!(jobs::folder(&store, "../escape").is_err());
    assert!(jobs::create(
        &SessionStore::new(temp.path().into()),
        "build",
        &p,
        prompt(None)
    )
    .await
    .is_err());
    assert!(!jobs::result(&done).to_string().contains("secret-test-key"));
}

#[tokio::test]
async fn h3_download_retry_does_not_create_a_second_billed_task() {
    let media = serve(vec![Canned::json(503, "{}"), mp4()]).await;
    let completed = json!({"task":{"status":"succeeded","content":{"url":format!("{}/clip.mp4",media.base_url)}}}).to_string();
    let api = serve(vec![
        Canned::json(200, r#"{"task_id":"h3-task"}"#),
        Canned::json(200, &completed),
        Canned::json(200, &completed),
    ])
    .await;
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::new_folder(temp.path().into());
    let p = provider(&api.base_url);
    let job = jobs::create(&store, "chat", &p, prompt(Some("MiniMax-H3")))
        .await
        .unwrap();
    let interrupted = jobs::refresh(&store, "chat", &p, &job.job_id)
        .await
        .unwrap();
    assert_eq!(interrupted.status, "succeeded");
    assert!(interrupted.path.is_none());
    assert!(interrupted.error.unwrap().contains("could not be saved"));
    let persisted = jobs::load(&jobs::folder(&store, "chat").unwrap(), &job.job_id)
        .await
        .unwrap();
    assert_eq!(persisted.status, "succeeded");
    assert!(jobs::refresh(&store, "chat", &p, &job.job_id)
        .await
        .unwrap()
        .path
        .is_some());
    let calls = api.recorded();
    assert_eq!(calls[0].path, "/v2/video_generation");
    assert_eq!(calls[1].path, "/v2/query/video_generation/h3-task");
    assert_eq!(calls.iter().filter(|c| c.method == "POST").count(), 1);
}

#[tokio::test]
async fn adopts_completed_file_after_a_crash_before_the_final_record_update() {
    let api = serve(vec![Canned::json(200, r#"{"task_id":"42"}"#)]).await;
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::new_folder(temp.path().into());
    let p = provider(&api.base_url);
    let job = jobs::create(&store, "chat", &p, prompt(None))
        .await
        .unwrap();
    let dir = jobs::folder(&store, "chat").unwrap();
    tokio::fs::write(dir.join(format!("{}.mp4", job.job_id)), mp4().body)
        .await
        .unwrap();
    let recovered = jobs::refresh(&store, "chat", &p, &job.job_id)
        .await
        .unwrap();
    assert!(recovered.path.is_some());
    assert_eq!(recovered.status, "succeeded");
    assert_eq!(api.recorded().len(), 1);
}

#[tokio::test]
async fn ambiguous_submission_stays_unknown_and_corrupt_identity_is_rejected() {
    let api = serve(vec![Canned::json(200, "{}")]).await;
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::new_folder(temp.path().into());
    let p = provider(&api.base_url);
    let mut job = jobs::create(&store, "chat", &p, prompt(None))
        .await
        .unwrap();
    assert_eq!(job.status, "unknown");
    assert!(jobs::refresh(&store, "chat", &p, &job.job_id)
        .await
        .is_err());
    let id = job.job_id.clone();
    job.job_id = "../wrong".into();
    assert!(jobs::decode(&serde_json::to_vec(&job).unwrap(), &id).is_err());
    assert_eq!(api.recorded().len(), 1);
}

fn qwen_provider(base: &str) -> ImageProviderConfig {
    serde_json::from_value(json!({"id":"qwen","name":"Qwen","baseUrl":base,"apiKey":"secret-test-key","apiFormat":"qwen-dashscope","enabled":true})).unwrap()
}

#[tokio::test]
async fn wan_submits_as_a_task_and_saves_the_video_url_without_a_second_lookup() {
    let media = serve(vec![mp4()]).await;
    let api = serve(vec![
        Canned::json(
            200,
            r#"{"request_id":"r-1","output":{"task_id":"task-abc","task_status":"PENDING"}}"#,
        ),
        Canned::json(
            200,
            &json!({"request_id":"r-2","output":{"task_id":"task-abc","task_status":"SUCCEEDED",
                "video_url":format!("{}/clip.mp4",media.base_url)}})
            .to_string(),
        ),
    ])
    .await;
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::new_folder(temp.path().into());
    let p = qwen_provider(&api.base_url);

    let created = jobs::create(&store, "chat-wan", &p, prompt(Some("wan3.0-video")))
        .await
        .unwrap();
    assert_eq!(created.status, "queued");
    assert_eq!(created.task_id.as_deref(), Some("task-abc"));
    // Aurora's own default, not the provider's 1080P.
    assert_eq!(created.resolution, "720P");
    assert_eq!(created.duration, 5);

    let done = jobs::refresh(&store, "chat-wan", &p, &created.job_id)
        .await
        .unwrap();
    assert_eq!(done.status, "succeeded");
    assert!(std::path::Path::new(done.path.as_ref().unwrap()).is_file());

    let calls = api.recorded();
    // Submit, then exactly one query. A URL comes back directly, so unlike
    // MiniMax v1 there is no file-retrieval call.
    assert_eq!(calls.len(), 2);
    assert_eq!(
        calls[0].path,
        "/api/v1/services/aigc/video-generation/video-synthesis"
    );
    assert_eq!(calls[0].header("x-dashscope-async"), Some("enable"));
    assert_eq!(calls[0].header("authorization"), Some("Bearer secret-test-key"));
    assert_eq!(calls[0].json()["input"]["prompt"], "A sunrise");
    assert_eq!(calls[0].json()["parameters"]["resolution"], "720P");
    assert_eq!(calls[1].path, "/api/v1/tasks/task-abc");
    // The saved record never carries the key or a signed provider URL.
    let dir = jobs::folder(&store, "chat-wan").unwrap();
    let saved = tokio::fs::read_to_string(dir.join(format!("{}.json", created.job_id)))
        .await
        .unwrap();
    assert!(!saved.contains("secret-test-key"));
    assert!(!saved.contains("clip.mp4"));
}

#[tokio::test]
async fn an_expired_wan_task_reads_as_expiry_rather_than_failure() {
    let api = serve(vec![
        Canned::json(
            200,
            r#"{"output":{"task_id":"task-old","task_status":"PENDING"}}"#,
        ),
        Canned::json(200, r#"{"output":{"task_id":"task-old","task_status":"UNKNOWN"}}"#),
    ])
    .await;
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::new_folder(temp.path().into());
    let p = qwen_provider(&api.base_url);
    let created = jobs::create(&store, "chat-old", &p, prompt(Some("wan3.0-video")))
        .await
        .unwrap();
    let stale = jobs::refresh(&store, "chat-old", &p, &created.job_id)
        .await
        .unwrap();
    assert_eq!(stale.status, "unknown");
    assert!(stale.error.as_deref().unwrap().contains("expire"));
}

#[tokio::test]
async fn a_model_from_the_wrong_roster_is_refused_before_any_request() {
    let api = serve(vec![]).await;
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::new_folder(temp.path().into());
    // A Qwen row asked for a MiniMax model, and the reverse.
    assert!(
        jobs::create(&store, "chat-x", &qwen_provider(&api.base_url), prompt(Some("nope-9000")))
            .await
            .is_err()
    );
    assert!(super::Vendor::of_model("wan3.0-video") == Some(super::Vendor::Qwen));
    assert!(super::Vendor::of_model("MiniMax-H3") == Some(super::Vendor::MiniMax));
    assert_eq!(api.recorded().len(), 0);
}
