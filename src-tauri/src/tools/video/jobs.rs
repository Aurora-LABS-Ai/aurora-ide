//! Durable video tasks. Credentials never enter the job file or tool result.
use super::wire::{self, VideoRequest};
use super::{qwen, Vendor};
use crate::agent_runtime::session_store::SessionStore;
use crate::tools::image::{assets, client::ImageClient, config::ImageProviderConfig};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoJob {
    pub job_id: String,
    pub thread_id: String,
    pub provider_id: String,
    pub base_url: String,
    pub task_id: Option<String>,
    pub model: String,
    pub prompt: String,
    pub duration: u8,
    pub resolution: String,
    pub status: String,
    pub path: Option<String>,
    pub error: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default = "default_aspect")]
    pub aspect_ratio: f64,
}

fn default_aspect() -> f64 {
    16.0 / 9.0
}

fn component(value: &str) -> bool {
    let mut parts = Path::new(value).components();
    matches!(parts.next(), Some(Component::Normal(_))) && parts.next().is_none()
}
pub fn folder(store: &SessionStore, thread: &str) -> Result<PathBuf, String> {
    if !component(thread) {
        return Err("Invalid conversation id".into());
    }
    store
        .assets_dir(thread)
        .ok_or_else(|| "Video generation is available only in Aurora Chat".into())
        .map(|dir| dir.join("videos"))
}
async fn save(dir: &Path, job: &VideoJob) -> Result<(), String> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| e.to_string())?;
    let temp = dir.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    tokio::fs::write(&temp, serde_json::to_vec(job).map_err(|e| e.to_string())?)
        .await
        .map_err(|e| e.to_string())?;
    let target = dir.join(format!("{}.json", job.job_id));
    tokio::fs::rename(&temp, target)
        .await
        .map_err(|e| format!("Could not save video task: {e}"))
}
pub async fn load(dir: &Path, id: &str) -> Result<VideoJob, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "Invalid video job id")?;
    let bytes = tokio::fs::read(dir.join(format!("{id}.json")))
        .await
        .map_err(|e| format!("Could not read video task: {e}"))?;
    decode(&bytes, id)
}
pub fn decode(bytes: &[u8], id: &str) -> Result<VideoJob, String> {
    let job: VideoJob =
        serde_json::from_slice(bytes).map_err(|e| format!("Invalid video task record: {e}"))?;
    uuid::Uuid::parse_str(id).map_err(|_| "Invalid video job id")?;
    if job.job_id != id || !component(&job.thread_id) {
        return Err("Video task identity does not match its file".into());
    }
    Ok(job)
}
pub fn saved_path(dir: &Path, job: &VideoJob) -> Result<Option<PathBuf>, String> {
    let expected = dir.join(format!("{}.mp4", job.job_id));
    if job.path.is_none() && !expected.is_file() {
        return Ok(None);
    }
    let root = dir.canonicalize().map_err(|e| e.to_string())?;
    let path = expected
        .canonicalize()
        .map_err(|e| format!("Saved video is unavailable: {e}"))?;
    if !path.starts_with(root) || !path.is_file() {
        return Err("Video is outside this conversation".into());
    }
    Ok(Some(path))
}
/// The service a saved job belongs to. Read from the model it recorded, so a
/// job written before Qwen existed still resolves to MiniMax.
pub fn vendor_of(job: &VideoJob) -> Vendor {
    Vendor::of_model(&job.model).unwrap_or(Vendor::MiniMax)
}

fn endpoint(provider: &ImageProviderConfig, path: &str) -> Result<reqwest::Url, String> {
    let base = provider
        .base_url
        .trim()
        .trim_end_matches('/')
        .trim_end_matches("/v1");
    let url = reqwest::Url::parse(&format!("{base}/{path}")).map_err(|e| e.to_string())?;
    if !wire::media_url(url.as_str()) {
        return Err("Invalid video API address".into());
    }
    Ok(url)
}
async fn request(
    provider: &ImageProviderConfig,
    vendor: Vendor,
    path: &str,
    body: Option<&Value>,
    query: &[(&str, &str)],
    headers: &[(&str, &str)],
) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let url = endpoint(provider, path)?;
    let call = match body {
        Some(body) => client.post(url).json(body),
        None => client.get(url).query(query),
    };
    // Qwen's submit is only accepted as a task when `X-DashScope-Async` is on
    // it; everything else here sends none.
    let call = headers
        .iter()
        .fold(call, |call, (name, value)| call.header(*name, *value));
    let response = call
        .bearer_auth(provider.api_key())
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| format!("{} request failed: {e}", vendor.label()))?;
    let status = response.status().as_u16();
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err(format!("{} task response exceeded 2 MiB", vendor.label()));
        }
        bytes.extend_from_slice(&chunk);
    }
    let text = String::from_utf8_lossy(&bytes);
    match vendor {
        Vendor::MiniMax => wire::check_response(status, &text),
        Vendor::Qwen => qwen::check_response(status, &text),
    }
}

async fn image_source(dir: &Path, input: &str, v2: bool) -> Result<String, String> {
    if wire::media_url(input) {
        return Ok(input.to_string());
    }
    let records = assets::list(dir)?;
    let record = assets::find(&records, input)
        .ok_or("Image is not in this conversation; use generate_image op 'list'")?;
    if !component(&record.name) {
        return Err("Invalid image asset name".into());
    }
    let path = tokio::fs::canonicalize(assets::path_of(dir, record))
        .await
        .map_err(|e| e.to_string())?;
    let root = tokio::fs::canonicalize(dir)
        .await
        .map_err(|e| e.to_string())?;
    if !path.starts_with(root) {
        return Err("Image is outside this conversation".into());
    }
    let limit = if v2 { 30 } else { 20 } * 1024 * 1024;
    let size = tokio::fs::metadata(&path)
        .await
        .map_err(|e| e.to_string())?
        .len();
    if size >= limit {
        return Err("Reference image exceeds this video model's size limit".into());
    }
    let ratio = record.width as f64 / record.height.max(1) as f64;
    let min = if v2 { 256 } else { 301 };
    if record.width < min
        || record.height < min
        || !(0.4..=2.5).contains(&ratio)
        || (v2 && (record.width > 5760 || record.height > 5760))
    {
        return Err("Reference image dimensions are outside this video model's limits".into());
    }
    if !matches!(
        record.media_type.as_str(),
        "image/png" | "image/jpeg" | "image/webp"
    ) {
        return Err("Video reference images must be PNG, JPEG or WebP".into());
    }
    let bytes = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
    Ok(crate::tools::image::wire::data_url(
        &record.media_type,
        &bytes,
    ))
}

pub async fn create(
    store: &SessionStore,
    thread: &str,
    provider: &ImageProviderConfig,
    mut input: VideoRequest,
) -> Result<VideoJob, String> {
    // The model names the service, and the two rosters do not overlap. An
    // unknown name is refused here rather than submitted to whichever provider
    // happened to be ready.
    let vendor = Vendor::of_model(input.model()).ok_or_else(|| {
        format!(
            "Unknown video model '{}'; use op 'list' for supported models",
            input.model()
        )
    })?;
    match vendor {
        Vendor::MiniMax => input.validate()?,
        Vendor::Qwen => qwen::validate(&input)?,
    }
    let dir = folder(store, thread)?;
    let assets = dir.parent().ok_or("Invalid image folder")?;
    // Qwen states its reference-image ceiling in the same place MiniMax's v2
    // does, so the larger allowance applies to both.
    let v2 = input.v2() || vendor == Vendor::Qwen;
    if let Some(value) = input.first_frame.take() {
        input.first_frame = Some(image_source(assets, &value, v2).await?);
    }
    if let Some(value) = input.last_frame.take() {
        input.last_frame = Some(image_source(assets, &value, v2).await?);
    }
    for value in &mut input.reference_images {
        *value = image_source(assets, value, v2).await?;
    }
    if input
        .reference_videos
        .iter()
        .chain(input.reference_audio.iter())
        .any(|value| !wire::media_url(value))
    {
        return Err("Reference video/audio must use a public HTTP(S) URL or mm_file:// id".into());
    }
    let body = match vendor {
        Vendor::MiniMax => input.body(),
        Vendor::Qwen => qwen::body(&input),
    };
    if serde_json::to_vec(&body).map_err(|e| e.to_string())?.len() > 64 * 1024 * 1024 {
        return Err("Video request exceeds the provider's 64 MiB limit".into());
    }
    let aspect_ratio = body
        .pointer("/parameters/ratio")
        .or_else(|| body.get("ratio"))
        .and_then(Value::as_str)
        .and_then(|ratio| ratio.split_once(':'))
        .and_then(|(w, h)| Some(w.parse::<f64>().ok()? / h.parse::<f64>().ok()?))
        .unwrap_or_else(default_aspect);
    let mut job = VideoJob {
        job_id: uuid::Uuid::new_v4().to_string(),
        thread_id: thread.into(),
        provider_id: provider.id.clone(),
        base_url: provider.base_url.clone(),
        task_id: None,
        model: input.model().into(),
        prompt: input.prompt.clone(),
        duration: match vendor {
            Vendor::MiniMax => input.duration(),
            Vendor::Qwen => qwen::duration(&input),
        },
        resolution: match vendor {
            Vendor::MiniMax => input.resolution().into(),
            Vendor::Qwen => qwen::resolution(&input).into(),
        },
        status: "submitting".into(),
        path: None,
        error: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        aspect_ratio,
    };
    save(&dir, &job).await?;
    // Never retry a create: an interrupted response can still have spent quota.
    let (submit_path, submit_headers): (&str, &[(&str, &str)]) = match vendor {
        Vendor::Qwen => (qwen::SUBMIT_PATH, &[qwen::ASYNC_HEADER]),
        Vendor::MiniMax if input.v2() => ("v2/video_generation", &[]),
        Vendor::MiniMax => ("v1/video_generation", &[]),
    };
    match request(provider, vendor, submit_path, Some(&body), &[], submit_headers).await {
        Ok(value) => {
            job.task_id = match vendor {
                Vendor::Qwen => qwen::task_id(&value),
                Vendor::MiniMax => value
                    .get("task_id")
                    .and_then(Value::as_str)
                    .filter(|id| {
                        !id.is_empty()
                            && id
                                .chars()
                                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
                    })
                    .map(str::to_string),
            };
            if job.task_id.is_some() {
                job.status = "queued".into();
            } else {
                job.status = "unknown".into();
                job.error = Some(format!("{0} returned no task id. Do not resubmit automatically; check the {0} console.", vendor.label()));
            }
        }
        Err(error) => {
            job.status = "unknown".into();
            job.error = Some(format!(
                "{error}. Submission may have reached {}; do not resubmit automatically.",
                vendor.label()
            ));
        }
    }
    save(&dir,&job).await.map_err(|e| format!("{e}. Job {}, remote task {:?}. Do not generate again; keep these identifiers for recovery.",job.job_id,job.task_id))?;
    Ok(job)
}

static REFRESH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
pub async fn refresh(
    store: &SessionStore,
    thread: &str,
    provider: &ImageProviderConfig,
    id: &str,
) -> Result<VideoJob, String> {
    let _lock = REFRESH_LOCK.lock().await;
    let dir = folder(store, thread)?;
    let mut job = load(&dir, id).await?;
    if job.thread_id != thread
        || job.provider_id != provider.id
        || job.base_url != provider.base_url
    {
        return Err("Video task belongs to a different conversation or provider address".into());
    }
    if let Ok(Some(path)) = saved_path(&dir, &job) {
        let needs_recovery = job.path.is_none() || job.status != "succeeded" || job.error.is_some();
        job.path = Some(assets::display_path(&path));
        job.status = "succeeded".into();
        job.error = None;
        if needs_recovery {
            save(&dir, &job).await?;
        }
        return Ok(job);
    }
    job.path = None;
    if matches!(job.status.as_str(), "failed" | "cancelled") {
        return Ok(job);
    }
    let vendor = vendor_of(&job);
    let task = job.task_id.as_deref().ok_or_else(|| format!("This submission has no task id. Check the {} console before trying another generation.", vendor.label()))?;
    if task.is_empty()
        || !task
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid remote task id".into());
    }
    let v2 = job.model.starts_with("MiniMax-H3");
    let value = match vendor {
        Vendor::Qwen => request(provider, vendor, &qwen::query_path(task), None, &[], &[]).await?,
        Vendor::MiniMax if v2 => {
            request(
                provider,
                vendor,
                &format!("v2/query/video_generation/{task}"),
                None,
                &[],
                &[],
            )
            .await?
        }
        Vendor::MiniMax => {
            request(
                provider,
                vendor,
                "v1/query/video_generation",
                None,
                &[("task_id", task)],
                &[],
            )
            .await?
        }
    };
    let (status, output) = match vendor {
        Vendor::MiniMax => wire::state(&value, v2)?,
        Vendor::Qwen => qwen::state(&value)?,
    };
    job.status = status.into();
    job.error = None;
    if let (Some(w), Some(h)) = (
        value.get("video_width").and_then(Value::as_f64),
        value.get("video_height").and_then(Value::as_f64),
    ) {
        if w > 0.0 && h > 0.0 {
            job.aspect_ratio = w / h;
        }
    }
    if let Some((w, h)) = value
        .pointer("/task/ratio")
        .and_then(Value::as_str)
        .and_then(|r| r.split_once(':'))
    {
        if let (Ok(w), Ok(h)) = (w.parse::<f64>(), h.parse::<f64>()) {
            if w > 0.0 && h > 0.0 {
                job.aspect_ratio = w / h;
            }
        }
    }
    if status == "succeeded" {
        // Persist completion before downloading. A failed transfer is not a
        // queued generation, and a restart must keep that distinction.
        save(&dir, &job).await?;
        let downloaded = async {
        let output = output.ok_or_else(|| format!("{} marked the task complete without an output", vendor.label()))?;
        // Qwen and MiniMax's v2 both hand back a URL. Only MiniMax's v1 returns
        // a file id that needs a second call to turn into one.
        let url = if vendor == Vendor::Qwen || v2 {
            output
        } else {
            let file = request(
                provider,
                vendor,
                "v1/files/retrieve",
                None,
                &[("file_id", &output)],
                &[],
            )
            .await?;
            file.pointer("/file/download_url")
                .and_then(Value::as_str)
                .ok_or("MiniMax returned no video download URL")?
                .to_string()
        };
        if !wire::media_url(&url) || url.starts_with("mm_file:") {
            return Err(format!("{} returned an invalid download URL", vendor.label()));
        }
        let bytes = ImageClient::new().download(&url,256 * 1024 * 1024).await.map_err(|e| format!("Video was generated but could not be saved: {e}. Check status again to retry the download, not generation."))?;
        if bytes.get(4..8) != Some(b"ftyp") {
            return Err(format!("{} video download is not an MP4 file", vendor.label()));
        }
        let file = dir.join(format!("{}.mp4", job.job_id));
        let temp = dir.join(format!("{}.download", job.job_id));
        tokio::fs::write(&temp, bytes)
            .await
            .map_err(|e| e.to_string())?;
        tokio::fs::rename(temp, &file)
            .await
            .map_err(|e| e.to_string())?;
        Ok::<PathBuf, String>(file)
        }.await;
        match downloaded {
            Ok(file) => job.path = Some(assets::display_path(&file)),
            Err(error) => job.error = Some(format!("{error}. The generation is complete; checking status again retries saving the video.")),
        }
    } else if status == "failed" {
        job.error = Some(match vendor {
            Vendor::Qwen => qwen::failure(&value).unwrap_or_else(|| "Qwen could not generate this video. Check the provider console for details.".into()),
            Vendor::MiniMax => value.pointer("/task/error/message").and_then(Value::as_str).unwrap_or("MiniMax could not generate this video. Check the provider console for details.").into(),
        });
    } else if status == "unknown" {
        // Qwen answers UNKNOWN for a task it no longer holds. That is an
        // expiry, not a fault, and it must not read as "try generating again".
        job.error = Some(format!(
            "{} no longer has this task. Task ids expire 24 hours after submission.",
            vendor.label()
        ));
    }
    save(&dir, &job).await?;
    Ok(job)
}

pub fn result(job: &VideoJob) -> Value {
    json!({"success":!matches!(job.status.as_str(),"unknown"|"failed"|"cancelled"),
        // `aspectRatio` travels with every result because the card reserves the
        // video's real shape while it is queued. Without it a 9:16 generation
        // waits in a 16:9 hole and the clip shoves the transcript down when it
        // lands, which is the behaviour the placeholder exists to prevent.
        "video":{"jobId":job.job_id,"threadId":job.thread_id,"providerId":job.provider_id,"taskId":job.task_id,"model":job.model,"prompt":job.prompt,"duration":job.duration,"resolution":job.resolution,"status":job.status,"path":job.path,"error":job.error,"aspectRatio":job.aspect_ratio,"createdAt":job.created_at},
        "guidance":if job.path.is_some() {"Video saved locally. Do not claim you visually inspected its contents."} else {"Use op 'query' with this jobId to check progress. Do not start another generation just because the task is queued. The user can also use Check status on the video result."}})
}
