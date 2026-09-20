//! The Chat gallery reads conversation asset manifests, never Build sessions.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::agent_runtime::session_store::SessionStore;
use crate::commands::agent_v2::AgentRegistry;
use crate::tools::image::assets::{self, AssetRecord};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryImage {
    pub thread_id: String,
    pub thread_title: String,
    pub path: String,
    #[serde(flatten)]
    pub asset: AssetRecord,
}

#[derive(Default, Serialize)]
pub struct GalleryResult {
    pub images: Vec<GalleryImage>,
    pub videos: Vec<serde_json::Value>,
    pub warnings: Vec<String>,
}

#[tauri::command]
pub async fn chat_gallery_list(
    state: State<'_, Arc<AgentRegistry>>,
) -> Result<GalleryResult, String> {
    let store = state.chat_store().clone();
    tauri::async_runtime::spawn_blocking(move || list(&store))
        .await
        .map_err(|e| format!("Could not load the gallery: {e}"))?
}

fn list(store: &SessionStore) -> Result<GalleryResult, String> {
    let mut result = GalleryResult::default();
    if store.assets_dir("gallery").is_none() {
        return Ok(result);
    }
    // Gallery needs metadata, not conversation bodies. list_summaries also
    // scans every JSONL for previews, which is expensive on a large history.
    let chats = match std::fs::read_dir(store.dir()) {
        Ok(chats) => chats,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(result),
        Err(e) => return Err(format!("Could not read Chat conversations: {e}")),
    };
    for entry in chats {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                result.warnings.push(error.to_string());
                continue;
            }
        };
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => {}
            Ok(_) => continue,
            Err(error) => {
                result
                    .warnings
                    .push(format!("Could not inspect conversation folder: {error}"));
                continue;
            }
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        if !store.exists(&id) {
            continue;
        }
        let title = store
            .load_metadata(&id)
            .map(|meta| meta.title)
            .unwrap_or_else(|_| "Untitled chat".into());
        let Some(dir) = store.assets_dir(&id) else {
            continue;
        };
        list_videos(&dir.join("videos"), &id, &title, &mut result);
        let records = match assets::list(&dir) {
            Ok(records) => records,
            Err(error) => {
                result.warnings.push(format!("{title}: {error}"));
                continue;
            }
        };
        for mut asset in records {
            // Gallery never needs the expiring signed origin URL.
            asset.remote_url = None;
            match asset_path(&dir, &asset.name) {
                Ok(path) => result.images.push(GalleryImage {
                    thread_id: id.clone(),
                    thread_title: title.clone(),
                    path: assets::display_path(&path),
                    asset,
                }),
                Err(error) => result
                    .warnings
                    .push(format!("{} / {}: {error}", title, asset.name)),
            }
        }
    }
    result.images.sort_by(|a, b| {
        b.asset
            .created_at
            .cmp(&a.asset.created_at)
            .then_with(|| a.thread_id.cmp(&b.thread_id))
            .then_with(|| a.asset.name.cmp(&b.asset.name))
    });
    Ok(result)
}

fn list_videos(dir: &Path, thread: &str, title: &str, result: &mut GalleryResult) {
    use crate::tools::video::jobs;
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            result.warnings.push(format!("{title}: {error}"));
            return;
        }
    };
    for entry in entries {
        let loaded = (|| {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                return Ok(None);
            }
            let id = path
                .file_stem()
                .and_then(|id| id.to_str())
                .ok_or("Invalid video task name")?;
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            let mut job = jobs::decode(&bytes, id)?;
            if job.thread_id != thread {
                return Err("Video belongs to another conversation".to_string());
            }
            match jobs::saved_path(dir, &job) {
                Ok(path) => job.path = path.map(|p| assets::display_path(&p)),
                Err(error) => {
                    job.path = None;
                    job.error = Some(error);
                }
            }
            Ok(Some(serde_json::json!({
                "threadId":thread,"threadTitle":title,"name":format!("{}.mp4",job.job_id),
                "path":job.path.clone().unwrap_or_default(),"source":"generated","mediaType":"video/mp4",
                "width":job.aspect_ratio,"height":1,"prompt":job.prompt,"model":job.model,"createdAt":job.created_at,
                "video":jobs::result(&job)["video"]
            })))
        })();
        match loaded {
            Ok(Some(video)) => result.videos.push(video),
            Ok(None) => {}
            Err(error) => result.warnings.push(format!("{title}: {error}")),
        }
    }
}

fn asset_path(dir: &Path, name: &str) -> Result<PathBuf, String> {
    let mut parts = Path::new(name).components();
    if !matches!(parts.next(), Some(Component::Normal(_))) || parts.next().is_some() {
        return Err("Invalid image name".into());
    }
    let root = dir
        .canonicalize()
        .map_err(|e| format!("Could not open image folder: {e}"))?;
    let path = dir
        .join(name)
        .canonicalize()
        .map_err(|e| format!("Image file is unavailable: {e}"))?;
    if !path.starts_with(&root) || !path.is_file() {
        return Err("Image file is outside this conversation".into());
    }
    Ok(path)
}

// Decoding several large images at once can starve the rest of the app.
static PREVIEW_JOBS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

#[tauri::command]
pub async fn chat_gallery_thumbnail(
    state: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
    name: String,
) -> Result<String, String> {
    let store = state.chat_store().clone();
    let permit = PREVIEW_JOBS.acquire().await.map_err(|e| e.to_string())?;
    let result = tauri::async_runtime::spawn_blocking(move || thumbnail(&store, &thread_id, &name))
        .await
        .map_err(|e| format!("Could not prepare image preview: {e}"))?;
    drop(permit);
    result
}

fn conversation_assets(store: &SessionStore, thread_id: &str) -> Result<PathBuf, String> {
    // Validate the thread before deriving a directory from it.
    let mut parts = Path::new(thread_id).components();
    if !matches!(parts.next(), Some(Component::Normal(_))) || parts.next().is_some() {
        return Err("Invalid conversation id".into());
    }
    store
        .assets_dir(thread_id)
        .ok_or_else(|| "Gallery is available only in Aurora Chat".into())
}

fn thumbnail(store: &SessionStore, thread_id: &str, name: &str) -> Result<String, String> {
    let dir = conversation_assets(store, thread_id)?;
    if !assets::list(&dir)?.iter().any(|asset| asset.name == name) {
        return Err("This image no longer belongs to the conversation".into());
    }
    let path = asset_path(&dir, name)?;
    let previews = dir.join("gallery-previews");
    let target = previews.join(format!("{name}.png"));
    if target.is_file() {
        return Ok(assets::display_path(&target));
    }
    let mut reader = image::ImageReader::open(&path)
        .map_err(|e| format!("Could not open image: {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("Could not identify image: {e}"))?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let preview = reader
        .decode()
        .map_err(|e| format!("Could not decode image: {e}"))?
        .thumbnail(384, 768);
    std::fs::create_dir_all(&previews).map_err(|e| format!("Could not create previews: {e}"))?;
    // Unique scratch files also make concurrent opens of the same image safe.
    let temporary = previews.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    preview
        .save_with_format(&temporary, image::ImageFormat::Png)
        .map_err(|e| format!("Could not write image preview: {e}"))?;
    if let Err(error) = std::fs::rename(&temporary, &target) {
        let _ = std::fs::remove_file(&temporary);
        if !target.is_file() {
            return Err(format!("Could not save image preview: {error}"));
        }
    }
    Ok(assets::display_path(&target))
}

#[tauri::command]
pub async fn chat_gallery_copy_image(
    app: tauri::AppHandle,
    state: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
    name: String,
) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let store = state.chat_store().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = conversation_assets(&store, &thread_id)?;
        if !assets::list(&dir)?.iter().any(|asset| asset.name == name) {
            return Err("Image is not in this conversation".into());
        }
        let path = asset_path(&dir, &name)?;
        let mut reader = image::ImageReader::open(path)
            .map_err(|e| e.to_string())?
            .with_guessed_format()
            .map_err(|e| e.to_string())?;
        let mut limits = image::Limits::default();
        limits.max_alloc = Some(128 * 1024 * 1024);
        reader.limits(limits);
        let rgba = reader
            .decode()
            .map_err(|e| format!("Could not decode image: {e}"))?
            .into_rgba8();
        let (width, height) = rgba.dimensions();
        app.clipboard()
            .write_image(&tauri::image::Image::new_owned(
                rgba.into_raw(),
                width,
                height,
            ))
            .map_err(|e| format!("Could not copy image: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Copy one gallery file to where the user chose to keep it.
///
/// The copy happens here rather than through `plugin-fs` because the fs scope
/// only ever holds paths the USER picked — the dialog and the file picker add
/// those as they are chosen. A conversation's asset is not one of them: nobody
/// picks it, Aurora wrote it. `copyFile` therefore refused every save with
/// "forbidden path … not allowed on the scope for `allow-copy-file`", naming
/// the source, while the destination from the save dialog was fine.
///
/// Scoping the capability could not have fixed it either: the destination is
/// wherever the person browsed to, which no list written in advance can cover.
///
/// `source` is the absolute path the gallery row carries, and it is checked to
/// be inside this conversation's assets before anything is read — which also
/// closes a gap the frontend copy had, where any path the renderer sent would
/// have been copied.
#[tauri::command]
pub async fn chat_gallery_save_as(
    state: State<'_, Arc<AgentRegistry>>,
    thread_id: String,
    source: String,
    destination: String,
) -> Result<(), String> {
    let store = state.chat_store().clone();
    tauri::async_runtime::spawn_blocking(move || save_as(&store, &thread_id, &source, &destination))
        .await
        .map_err(|e| e.to_string())?
}

fn save_as(
    store: &SessionStore,
    thread_id: &str,
    source: &str,
    destination: &str,
) -> Result<(), String> {
    let dir = conversation_assets(store, thread_id)?;
    let root = dir
        .canonicalize()
        .map_err(|e| format!("Could not open the conversation's files: {e}"))?;
    // Videos live in `<assets>/videos/`, so this is a containment check rather
    // than a name lookup — one rule covers both kinds.
    let from = Path::new(source)
        .canonicalize()
        .map_err(|e| format!("That file is no longer there: {e}"))?;
    if !from.starts_with(&root) || !from.is_file() {
        return Err("That file does not belong to this conversation".into());
    }
    let to = Path::new(destination);
    if let Some(parent) = to.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            return Err("That folder no longer exists".into());
        }
    }
    // Saving a file over itself truncates it before the read. Compared after
    // canonicalizing, so a different spelling of the same file is still caught.
    if to.canonicalize().is_ok_and(|to| to == from) {
        return Ok(());
    }
    std::fs::copy(&from, to)
        .map(|_| ())
        .map_err(|error| format!("Could not save it to {}: {error}", to.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::image::assets::{AssetSource, NewAsset};

    /// Save As copies in Rust because `plugin-fs` cannot: its scope holds only
    /// paths the user picked, and a conversation's asset is never one of them.
    /// What Rust owes in return is the check the fs scope would have given —
    /// that the file really is this conversation's — because the renderer now
    /// names the source itself.
    #[test]
    fn save_as_copies_this_conversations_files_and_refuses_anything_else() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::new_folder(temp.path().to_path_buf());
        let dir = store.assets_dir("chat-one").unwrap();
        let videos = dir.join("videos");
        std::fs::create_dir_all(&videos).unwrap();
        let picture = dir.join("001-generated-red.png");
        std::fs::write(&picture, b"pixels").unwrap();
        let clip = videos.join("clip.mp4").to_string_lossy().to_string();
        std::fs::write(&clip, b"frames").unwrap();

        let out = temp.path().join("out");
        std::fs::create_dir_all(&out).unwrap();
        let saved = out.join("red.png");
        save_as(
            &store,
            "chat-one",
            &picture.to_string_lossy(),
            &saved.to_string_lossy(),
        )
        .unwrap();
        assert_eq!(std::fs::read(&saved).unwrap(), b"pixels");

        // Videos sit one level down and must save by the same rule.
        let saved_clip = out.join("clip.mp4");
        save_as(&store, "chat-one", &clip, &saved_clip.to_string_lossy()).unwrap();
        assert_eq!(std::fs::read(&saved_clip).unwrap(), b"frames");

        // Saving over the source truncates it before the read, so it is a
        // no-op rather than a copy — and the file survives.
        save_as(
            &store,
            "chat-one",
            &picture.to_string_lossy(),
            &picture.to_string_lossy(),
        )
        .unwrap();
        assert_eq!(std::fs::read(&picture).unwrap(), b"pixels");

        // Anything the renderer names that is not this conversation's.
        let outsider = temp.path().join("secret.txt");
        std::fs::write(&outsider, b"not yours").unwrap();
        let attempt = save_as(
            &store,
            "chat-one",
            &outsider.to_string_lossy(),
            &out.join("leak.txt").to_string_lossy(),
        );
        assert!(attempt.is_err(), "{attempt:?}");
        assert!(!out.join("leak.txt").exists());
        assert!(save_as(&store, "../other", &picture.to_string_lossy(), "x").is_err());
        assert!(save_as(
            &store,
            "chat-one",
            &dir.join("missing.png").to_string_lossy(),
            &out.join("missing.png").to_string_lossy()
        )
        .is_err());
    }

    #[test]
    fn gallery_reads_generated_and_attached_assets_and_build_has_none() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::new_folder(temp.path().to_path_buf());
        let build = SessionStore::new(temp.path().to_path_buf());
        assert!(list(&build).unwrap().images.is_empty());
        assert!(thumbnail(&build, "chat-one", "image.png").is_err());
        // See the store's production layout; metadata is optional on old chats.
        let dir = store.assets_dir("chat-one").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(temp.path().join("chat-one/conversation.jsonl"), "").unwrap();
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(960, 480)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        for source in [
            AssetSource::Generated,
            AssetSource::Edited,
            AssetSource::Attached,
        ] {
            assets::store(
                &dir,
                NewAsset {
                    source,
                    hint: "test image".into(),
                    ..Default::default()
                },
                bytes.get_ref(),
            )
            .unwrap();
        }
        let result = list(&store).unwrap();
        assert_eq!(result.images.len(), 3);
        assert!(result.warnings.is_empty());
        let preview = thumbnail(&store, "chat-one", &result.images[0].asset.name).unwrap();
        assert!(Path::new(&preview).is_file());
        assert_eq!(image::image_dimensions(&preview).unwrap(), (384, 192));
        assert_eq!(
            thumbnail(&store, "chat-one", &result.images[0].asset.name).unwrap(),
            preview
        );
        assert!(thumbnail(&store, "../other", "anything.png").is_err());
        assert!(thumbnail(&store, "chat-one", "../anything.png").is_err());
        std::fs::remove_file(&result.images[0].path).unwrap();
        let partial = list(&store).unwrap();
        assert_eq!(partial.images.len(), 2);
        assert_eq!(partial.warnings.len(), 1);
    }

    #[tokio::test]
    async fn gallery_includes_queued_saved_and_missing_videos_without_leaking_provider_config() {
        use crate::tools::video::jobs::{self, VideoJob};
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::new_folder(temp.path().into());
        let dir = jobs::folder(&store, "video-chat").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(temp.path().join("video-chat/conversation.jsonl"), "").unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let mut job: VideoJob = serde_json::from_value(serde_json::json!({
            "jobId":id,"threadId":"video-chat","providerId":"mini","baseUrl":"https://api.minimax.io",
            "taskId":"42","model":"MiniMax-Hailuo-2.3","prompt":"Sunrise","duration":6,
            "resolution":"768P","status":"queued","path":null,"error":null,"createdAt":"2026-09-14"
        })).unwrap();
        let record = dir.join(format!("{id}.json"));
        std::fs::write(&record, serde_json::to_vec(&job).unwrap()).unwrap();
        let queued = list(&store).unwrap();
        assert_eq!(queued.videos.len(), 1);
        assert_eq!(queued.videos[0]["video"]["status"], "queued");
        assert!(!queued.videos[0].to_string().contains("baseUrl"));
        let file = dir.join(format!("{id}.mp4"));
        std::fs::write(&file, b"video").unwrap();
        job.status = "succeeded".into();
        job.path = Some(assets::display_path(&file));
        std::fs::write(&record, serde_json::to_vec(&job).unwrap()).unwrap();
        assert!(!list(&store).unwrap().videos[0]["path"]
            .as_str()
            .unwrap()
            .is_empty());
        std::fs::remove_file(file).unwrap();
        let missing = list(&store).unwrap();
        assert_eq!(missing.videos[0]["path"], "");
        assert!(missing.videos[0]["video"]["error"]
            .as_str()
            .unwrap()
            .contains("unavailable"));
        assert!(list(&SessionStore::new(temp.path().into()))
            .unwrap()
            .videos
            .is_empty());
    }
}
