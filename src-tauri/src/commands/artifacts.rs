//! Durable, thread-owned Artifact Canvas persistence.
//!
//! Every conversation gets at most one `<thread>.artifacts.json` sidecar next
//! to its transcript. Artifact ids are stable; every presentation appends an
//! immutable backend-numbered version (`v1`, `v2`, …). The selected artifact
//! and version live in the same sidecar so reopening a conversation restores
//! exactly what the user last viewed.

use std::fs;
use std::io::{self, Write};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tauri::State;

use super::agent_v2::AgentRegistry;
use crate::agent_runtime::session_store::SessionStore;

const MAX_ARTIFACT_ID_LEN: usize = 64;
const MAX_TITLE_LEN: usize = 120;
const MAX_CONTENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_MERMAID_CONTENT_BYTES: usize = 256 * 1024;
/// A canvas is ONE component file, and every byte of it is compiled before it
/// can be saved. The ceiling keeps that gate fast and pushes genuinely large
/// payloads toward several focused canvases.
const MAX_REACT_CONTENT_BYTES: usize = 512 * 1024;
const MAX_PATCHES: usize = 128;

/// Serialises read-modify-write cycles. Artifact calls are rare and small, so a
/// single process-wide lock is simpler and safer than allowing lost versions.
static ARTIFACT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactKind {
    Html,
    Svg,
    Markdown,
    Mermaid,
    /// A live canvas: one React component file, compiled and run beside the
    /// conversation instead of displayed as text.
    React,
    /// A long-form research document: Markdown, plus the conventions a report
    /// needs — headings that become a contents strip, `[^n]` footnotes that
    /// become numbered sources you can open, block quotations with attribution.
    ///
    /// Stored as Markdown and readable as Markdown; the kind is what tells the
    /// panel to give it a contents strip and a source list rather than
    /// rendering it as an ordinary document.
    Report,
    /// One picture the conversation owns — generated, edited, or attached —
    /// living in its `assets/` folder.
    ///
    /// The content is a small JSON record, not the pixels: the asset's file
    /// name, its absolute path, its dimensions, and where it came from (see
    /// `tools::image::assets::ImageArtifactContent`). Written by Rust's
    /// `generate_image`, never by the model, so it has no engine gate and the
    /// panel renders it from disk. A file that has gone missing is a named
    /// absence in the panel, not a broken image.
    Image,
}

impl ArtifactKind {
    /// Kinds whose source is put through a real engine — Mermaid's renderer,
    /// the TypeScript compiler — before it may be persisted.
    ///
    /// The check itself can only run in the window (both engines are browser
    /// libraries), so Rust cannot perform it. What Rust *can* do is refuse to
    /// store a payload that does not claim to have passed, which turns a silent
    /// bypass into a compile error at the call site. Mermaid was previously
    /// guarded on one frontend path only: any other caller of
    /// `thread_artifact_upsert` persisted broken diagrams.
    fn requires_validation(self) -> bool {
        matches!(self, ArtifactKind::Mermaid | ArtifactKind::React)
    }

    fn label(self) -> &'static str {
        match self {
            ArtifactKind::Html => "HTML",
            ArtifactKind::Svg => "SVG",
            ArtifactKind::Markdown => "Markdown",
            ArtifactKind::Mermaid => "Mermaid",
            ArtifactKind::React => "Canvas",
            ArtifactKind::Report => "Report",
            ArtifactKind::Image => "Image",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactVersion {
    pub tag: String,
    pub content: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRecord {
    pub id: String,
    pub title: String,
    pub kind: ArtifactKind,
    pub versions: Vec<ArtifactVersion>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadArtifactBundle {
    pub thread_id: String,
    pub selected_artifact_id: Option<String>,
    pub selected_version_tag: Option<String>,
    pub artifacts: Vec<ArtifactRecord>,
}

impl ThreadArtifactBundle {
    fn empty(thread_id: &str) -> Self {
        Self {
            thread_id: thread_id.to_string(),
            selected_artifact_id: None,
            selected_version_tag: None,
            artifacts: Vec::new(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactTextPatch {
    pub find: String,
    pub replace: String,
    #[serde(default)]
    pub all: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactUpsertRequest {
    pub thread_id: String,
    pub artifact_id: String,
    pub title: String,
    pub kind: ArtifactKind,
    pub content: Option<String>,
    pub base_version_tag: Option<String>,
    #[serde(default)]
    pub patches: Vec<ArtifactTextPatch>,
    /// Set by the caller that actually ran the engine gate for this kind. See
    /// [`ArtifactKind::requires_validation`].
    #[serde(default)]
    pub validated: bool,
}

enum ArtifactUpdate {
    Full(String),
    Patch {
        base_version_tag: String,
        patches: Vec<ArtifactTextPatch>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactSelectRequest {
    pub thread_id: String,
    pub artifact_id: String,
    pub version_tag: String,
}

fn lock_artifacts() -> Result<MutexGuard<'static, ()>, String> {
    ARTIFACT_LOCK
        .lock()
        .map_err(|_| "Artifact storage lock was poisoned".to_string())
}

fn validate_key(value: &str, label: &str, max_len: usize) -> Result<(), String> {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return Err(format!("{label} is required"));
    };
    if !first.is_ascii_alphanumeric()
        || !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        || value.len() > max_len
    {
        return Err(format!(
            "{label} must start with a letter or number and contain at most {max_len} letters, numbers, dots, dashes, or underscores"
        ));
    }
    Ok(())
}

/// `enforce_gate` is false for patch PREVIEW: preview is the step that produces
/// the text the engine gate then judges, so demanding the gate there would be
/// circular.
fn validate_upsert(request: &ArtifactUpsertRequest, enforce_gate: bool) -> Result<(), String> {
    validate_key(&request.thread_id, "threadId", 128)?;
    validate_key(&request.artifact_id, "artifactId", MAX_ARTIFACT_ID_LEN)?;
    let title = request.title.trim();
    if title.is_empty() || title.chars().count() > MAX_TITLE_LEN {
        return Err(format!(
            "title must contain 1 to {MAX_TITLE_LEN} characters"
        ));
    }
    match (
        request.content.as_deref(),
        request.base_version_tag.as_deref(),
        request.patches.as_slice(),
    ) {
        (Some(content), None, []) => validate_kind_content(request.kind, content)?,
        (None, Some(base_version_tag), patches) if !patches.is_empty() => {
            validate_key(base_version_tag, "baseVersionTag", 32)?;
            if patches.len() > MAX_PATCHES {
                return Err(format!(
                    "patches cannot contain more than {MAX_PATCHES} operations"
                ));
            }
            let mut payload_bytes = 0usize;
            for (index, patch) in patches.iter().enumerate() {
                if patch.find.is_empty() {
                    return Err(format!("patches[{index}].find is required"));
                }
                payload_bytes = payload_bytes
                    .saturating_add(patch.find.len())
                    .saturating_add(patch.replace.len());
            }
            if payload_bytes > MAX_CONTENT_BYTES {
                return Err(format!(
                    "patch payload exceeds the {} MiB artifact limit",
                    MAX_CONTENT_BYTES / 1024 / 1024
                ));
            }
        }
        _ => {
            return Err(
                "provide either content, or baseVersionTag with one or more patches, but not both"
                    .to_string(),
            )
        }
    }
    // Last, deliberately: a malformed or oversized payload should be reported
    // as what it is. The gate says only "nobody ran the engine", which is the
    // less specific answer whenever the input was never valid to begin with.
    if enforce_gate && request.kind.requires_validation() && !request.validated {
        return Err(format!(
            "{} artifacts must pass their engine check before being saved; the caller did not run it",
            request.kind.label()
        ));
    }
    Ok(())
}

fn validate_content(content: &str) -> Result<(), String> {
    if content.trim().is_empty() {
        return Err("content is required".to_string());
    }
    if content.len() > MAX_CONTENT_BYTES {
        return Err(format!(
            "content exceeds the {} MiB artifact limit",
            MAX_CONTENT_BYTES / 1024 / 1024
        ));
    }
    Ok(())
}

fn validate_kind_content(kind: ArtifactKind, content: &str) -> Result<(), String> {
    validate_content(content)?;
    match kind {
        ArtifactKind::Mermaid if content.len() > MAX_MERMAID_CONTENT_BYTES => Err(format!(
            "Mermaid content exceeds the {} KiB diagram limit; split the architecture into smaller artifacts",
            MAX_MERMAID_CONTENT_BYTES / 1024
        )),
        ArtifactKind::React if content.len() > MAX_REACT_CONTENT_BYTES => Err(format!(
            "Canvas source exceeds the {} KiB single-component limit; split it into several focused canvases",
            MAX_REACT_CONTENT_BYTES / 1024
        )),
        // The record names a file; a record that does not is a panel with
        // nothing to open and no way to say which file is missing.
        ArtifactKind::Image => {
            let parsed: serde_json::Value = serde_json::from_str(content)
                .map_err(|error| format!("image artifact content must be JSON: {error}"))?;
            let names_asset = parsed
                .get("asset")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|asset| !asset.trim().is_empty());
            if names_asset {
                Ok(())
            } else {
                Err("image artifact content must name its `asset` file".to_string())
            }
        }
        _ => Ok(()),
    }
}

fn apply_patches(base: &str, patches: &[ArtifactTextPatch]) -> Result<String, String> {
    struct PlannedPatch<'a> {
        patch_index: usize,
        start: usize,
        end: usize,
        replace: &'a str,
    }

    let mut planned = Vec::<PlannedPatch<'_>>::new();
    for (index, patch) in patches.iter().enumerate() {
        if patch.find == patch.replace {
            return Err(format!(
                "patches[{index}] does not change its matched text; remove that patch"
            ));
        }
        let matches = base
            .match_indices(&patch.find)
            .map(|(start, _)| (start, start + patch.find.len()))
            .collect::<Vec<_>>();
        if matches.is_empty() {
            return Err(format!(
                "patches[{index}].find does not match the unchanged base version. Patch finds do not chain through earlier replacements; read the latest source and combine dependent edits into one replacement"
            ));
        }
        if !patch.all && matches.len() != 1 {
            return Err(format!(
                "patches[{index}].find matches {} locations; include more surrounding text or set all to true",
                matches.len()
            ));
        }
        let selected_matches = if patch.all { matches.len() } else { 1 };
        for (start, end) in matches.into_iter().take(selected_matches) {
            if let Some(conflict) = planned
                .iter()
                .find(|candidate| start < candidate.end && candidate.start < end)
            {
                return Err(format!(
                    "patches[{index}] overlaps with patches[{}]; matched regions in the same artifact version must not overlap",
                    conflict.patch_index
                ));
            }
            planned.push(PlannedPatch {
                patch_index: index,
                start,
                end,
                replace: &patch.replace,
            });
        }
    }

    planned.sort_unstable_by_key(|patch| patch.start);
    let mut content = String::with_capacity(base.len());
    let mut cursor = 0usize;
    for patch in planned {
        content.push_str(&base[cursor..patch.start]);
        content.push_str(patch.replace);
        cursor = patch.end;
    }
    content.push_str(&base[cursor..]);
    if content == base {
        return Err("patches did not change the artifact".to_string());
    }
    validate_content(&content)?;
    Ok(content)
}

/// Read a conversation's bundle from a test in another module. Test-only so the
/// unlocked reader stays private everywhere the lock matters.
#[cfg(test)]
pub(crate) fn load_bundle_for_test(store: &SessionStore, thread_id: &str) -> ThreadArtifactBundle {
    load_bundle_unlocked(store, thread_id).expect("artifact bundle loads")
}

fn load_bundle_unlocked(
    store: &SessionStore,
    thread_id: &str,
) -> Result<ThreadArtifactBundle, String> {
    validate_key(thread_id, "threadId", 128)?;
    let primary = store.artifacts_path(thread_id);
    let backup = store.artifacts_backup_path(thread_id);
    let path = if primary.exists() {
        primary
    } else if backup.exists() {
        backup
    } else {
        return Ok(ThreadArtifactBundle::empty(thread_id));
    };
    let bytes =
        fs::read(&path).map_err(|error| format!("Failed to read Artifact Canvas data: {error}"))?;
    let bundle: ThreadArtifactBundle = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Artifact Canvas data is invalid: {error}"))?;
    if bundle.thread_id != thread_id {
        return Err("Artifact Canvas data belongs to a different conversation".to_string());
    }
    Ok(bundle)
}

/// Write the bundle at `store.artifacts_path(thread_id)` through a staged
/// temp file and a backup of the previous bundle, so a crash mid-write leaves
/// either the old bundle or the new one, never a torn file.
///
/// The temp and backup paths come from the STORE, not from the target's file
/// name. An earlier version re-derived them by stripping `.artifacts.json` off
/// the file name and constructing a flat store around the parent directory —
/// which only ever holds under [`StoreLayout::Flat`]. Under the folder layout
/// Aurora Chat uses the file is plain `artifacts.json`, the strip failed, and
/// every `present_artifact` in a chat died with "invalid file name". Phase 4
/// shipped that and was never watched running; `generate_image`'s tests were.
///
/// [`StoreLayout::Flat`]: crate::agent_runtime::session_store::StoreLayout::Flat
fn replace_file(store: &SessionStore, thread_id: &str, bytes: &[u8]) -> Result<(), String> {
    let path = store.artifacts_path(thread_id);
    let parent = path
        .parent()
        .ok_or_else(|| "Artifact storage path has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create Artifact Canvas storage: {error}"))?;

    let temp = store.artifacts_temp_path(thread_id);
    let backup = store.artifacts_backup_path(thread_id);
    {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temp)
            .map_err(|error| format!("Failed to stage Artifact Canvas data: {error}"))?;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("Failed to flush Artifact Canvas data: {error}"))?;
    }

    if path.exists() {
        match fs::remove_file(&backup) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Failed to prepare artifact backup: {error}")),
        }
        fs::rename(&path, &backup)
            .map_err(|error| format!("Failed to back up Artifact Canvas data: {error}"))?;
    }

    if let Err(error) = fs::rename(&temp, &path) {
        if backup.exists() {
            let _ = fs::rename(&backup, &path);
        }
        return Err(format!("Failed to commit Artifact Canvas data: {error}"));
    }
    if backup.exists() {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

fn save_bundle(store: &SessionStore, bundle: &ThreadArtifactBundle) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(bundle)
        .map_err(|error| format!("Failed to encode Artifact Canvas data: {error}"))?;
    replace_file(store, &bundle.thread_id, &bytes)
}

/// Copy a conversation's optional Canvas bundle while holding the same lock as
/// every other artifact read-modify-write operation. Empty conversations do not
/// gain an unnecessary sidecar.
pub(crate) fn duplicate_thread_artifacts(
    store: &SessionStore,
    source_thread_id: &str,
    new_thread_id: &str,
) -> Result<(), String> {
    let _guard = lock_artifacts()?;
    if !store.artifacts_path(source_thread_id).exists()
        && !store.artifacts_backup_path(source_thread_id).exists()
    {
        return Ok(());
    }

    validate_key(new_thread_id, "threadId", 128)?;
    let mut bundle = load_bundle_unlocked(store, source_thread_id)?;
    bundle.thread_id = new_thread_id.to_string();
    save_bundle(store, &bundle)
}

/// Create or version an artifact. `pub(crate)` for the one in-process writer
/// besides the command — `generate_image`, which lands every picture it makes
/// in the Canvas as an [`ArtifactKind::Image`].
pub(crate) fn upsert(
    store: &SessionStore,
    request: ArtifactUpsertRequest,
) -> Result<ThreadArtifactBundle, String> {
    validate_upsert(&request, true)?;
    let ArtifactUpsertRequest {
        thread_id,
        artifact_id,
        title,
        kind,
        content,
        base_version_tag,
        patches,
        ..
    } = request;
    let update = match (content, base_version_tag) {
        (Some(content), None) => ArtifactUpdate::Full(content),
        (None, Some(base_version_tag)) => ArtifactUpdate::Patch {
            base_version_tag,
            patches,
        },
        _ => return Err("artifact update is invalid".to_string()),
    };

    if !store.exists(&thread_id) {
        return Err("Cannot present an artifact before its conversation is saved".to_string());
    }

    let _guard = lock_artifacts()?;
    let mut bundle = load_bundle_unlocked(store, &thread_id)?;
    let tag;
    if let Some(record) = bundle
        .artifacts
        .iter_mut()
        .find(|artifact| artifact.id == artifact_id)
    {
        if record.kind != kind {
            return Err(format!(
                "Artifact '{}' is already {:?}; use a new artifactId to change its format",
                artifact_id, record.kind
            ));
        }
        let next_content = match update {
            ArtifactUpdate::Full(content) => {
                if record
                    .versions
                    .last()
                    .is_some_and(|latest| latest.content == content)
                {
                    return Err(
                        "content is identical to the latest artifact version; no new version was saved"
                            .to_string(),
                    );
                }
                content
            }
            ArtifactUpdate::Patch {
                base_version_tag,
                patches,
            } => {
                let latest = record
                    .versions
                    .last()
                    .ok_or_else(|| format!("Artifact '{artifact_id}' has no saved versions"))?;
                if latest.tag != base_version_tag {
                    return Err(format!(
                        "baseVersionTag '{base_version_tag}' is stale; latest version is '{}'",
                        latest.tag
                    ));
                }
                apply_patches(&latest.content, &patches)?
            }
        };
        validate_kind_content(kind, &next_content)?;
        record.title = title.trim().to_string();
        tag = format!("v{}", record.versions.len() + 1);
        record.versions.push(ArtifactVersion {
            tag: tag.clone(),
            content: next_content,
            created_at: chrono::Utc::now().to_rfc3339(),
        });
    } else {
        let ArtifactUpdate::Full(content) = update else {
            return Err(format!(
                "Artifact '{artifact_id}' does not exist; create v1 with content before applying patches"
            ));
        };
        tag = "v1".to_string();
        bundle.artifacts.push(ArtifactRecord {
            id: artifact_id.clone(),
            title: title.trim().to_string(),
            kind,
            versions: vec![ArtifactVersion {
                tag: tag.clone(),
                content,
                created_at: chrono::Utc::now().to_rfc3339(),
            }],
        });
    }
    bundle.selected_artifact_id = Some(artifact_id);
    bundle.selected_version_tag = Some(tag);
    save_bundle(store, &bundle)?;
    Ok(bundle)
}

fn preview_patch(store: &SessionStore, request: ArtifactUpsertRequest) -> Result<String, String> {
    validate_upsert(&request, false)?;
    let ArtifactUpsertRequest {
        thread_id,
        artifact_id,
        kind,
        content,
        base_version_tag,
        patches,
        ..
    } = request;
    if content.is_some() {
        return Err("patch preview requires baseVersionTag with one or more patches".to_string());
    }
    if !store.exists(&thread_id) {
        return Err("Cannot preview an artifact before its conversation is saved".to_string());
    }

    let base_version_tag =
        base_version_tag.ok_or_else(|| "patch preview requires baseVersionTag".to_string())?;
    let _guard = lock_artifacts()?;
    let bundle = load_bundle_unlocked(store, &thread_id)?;
    let record = bundle
        .artifacts
        .iter()
        .find(|artifact| artifact.id == artifact_id)
        .ok_or_else(|| {
            format!(
                "Artifact '{artifact_id}' does not exist; create v1 with content before applying patches"
            )
        })?;
    if record.kind != kind {
        return Err(format!(
            "Artifact '{}' is already {:?}; use a new artifactId to change its format",
            artifact_id, record.kind
        ));
    }
    let latest = record
        .versions
        .last()
        .ok_or_else(|| format!("Artifact '{artifact_id}' has no saved versions"))?;
    if latest.tag != base_version_tag {
        return Err(format!(
            "baseVersionTag '{base_version_tag}' is stale; latest version is '{}'",
            latest.tag
        ));
    }
    let content = apply_patches(&latest.content, &patches)?;
    validate_kind_content(kind, &content)?;
    Ok(content)
}

fn select(
    store: &SessionStore,
    request: ArtifactSelectRequest,
) -> Result<ThreadArtifactBundle, String> {
    validate_key(&request.thread_id, "threadId", 128)?;
    validate_key(&request.artifact_id, "artifactId", MAX_ARTIFACT_ID_LEN)?;
    let _guard = lock_artifacts()?;
    let mut bundle = load_bundle_unlocked(store, &request.thread_id)?;
    let artifact = bundle
        .artifacts
        .iter()
        .find(|artifact| artifact.id == request.artifact_id)
        .ok_or_else(|| format!("Artifact '{}' does not exist", request.artifact_id))?;
    if !artifact
        .versions
        .iter()
        .any(|version| version.tag == request.version_tag)
    {
        return Err(format!(
            "Version '{}' does not exist for artifact '{}'",
            request.version_tag, request.artifact_id
        ));
    }
    bundle.selected_artifact_id = Some(request.artifact_id);
    bundle.selected_version_tag = Some(request.version_tag);
    save_bundle(store, &bundle)?;
    Ok(bundle)
}

// Every command below routes by the conversation's OWN store. An Aurora Chat
// conversation lives under `Chats/`, and reading its bundle from the Build
// store finds nothing — worse, `upsert` refuses with "conversation not saved"
// for a chat that is saved, just elsewhere. Phase 4 shipped this against
// `registry.store()` and was never watched running.

#[tauri::command]
pub fn thread_artifact_list(
    thread_id: String,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<ThreadArtifactBundle, String> {
    let _guard = lock_artifacts()?;
    load_bundle_unlocked(registry.store_for_thread(&thread_id), &thread_id)
}

#[tauri::command]
pub fn thread_artifact_upsert(
    request: ArtifactUpsertRequest,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<ThreadArtifactBundle, String> {
    upsert(registry.store_for_thread(&request.thread_id), request)
}

#[tauri::command]
pub fn thread_artifact_preview_patch(
    request: ArtifactUpsertRequest,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<String, String> {
    preview_patch(registry.store_for_thread(&request.thread_id), request)
}

#[tauri::command]
pub fn thread_artifact_select(
    request: ArtifactSelectRequest,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<ThreadArtifactBundle, String> {
    select(registry.store_for_thread(&request.thread_id), request)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(content: &str) -> ArtifactUpsertRequest {
        ArtifactUpsertRequest {
            thread_id: "thread-1".to_string(),
            artifact_id: "launch-plan".to_string(),
            title: "Launch plan".to_string(),
            kind: ArtifactKind::Html,
            content: Some(content.to_string()),
            base_version_tag: None,
            patches: Vec::new(),
            validated: false,
        }
    }

    fn patch_request(base_version_tag: &str, find: &str, replace: &str) -> ArtifactUpsertRequest {
        ArtifactUpsertRequest {
            thread_id: "thread-1".to_string(),
            artifact_id: "launch-plan".to_string(),
            title: "Launch plan".to_string(),
            kind: ArtifactKind::Html,
            content: None,
            base_version_tag: Some(base_version_tag.to_string()),
            patches: vec![ArtifactTextPatch {
                find: find.to_string(),
                replace: replace.to_string(),
                all: false,
            }],
            validated: false,
        }
    }

    #[test]
    fn compiled_kinds_cannot_be_saved_without_passing_their_engine_gate() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::new(directory.path().to_path_buf());
        store.ensure_thread("thread-1", None, None).unwrap();

        let mut ungated = request("export default function () { return null }");
        ungated.kind = ArtifactKind::React;
        let error = upsert(&store, ungated).unwrap_err();
        assert!(error.contains("engine check"), "{error}");
        // Nothing was written: a rejected gate must not create v1.
        assert!(load_bundle_unlocked(&store, "thread-1")
            .unwrap()
            .artifacts
            .is_empty());

        let mut gated = request("export default function () { return null }");
        gated.kind = ArtifactKind::React;
        gated.validated = true;
        let saved = upsert(&store, gated).unwrap();
        assert_eq!(saved.selected_version_tag.as_deref(), Some("v1"));

        // HTML/SVG/Markdown are displayed as-authored, so they keep working
        // without a gate. Separate id: the kind of an existing artifact is
        // immutable, so reusing this one would fail for that reason instead.
        let mut plain = request("<h1>Plain</h1>");
        plain.artifact_id = "plain-note".to_string();
        assert!(upsert(&store, plain).is_ok());
    }

    #[test]
    fn canvas_source_is_bounded_to_one_component_file() {
        let mut oversized = request(&"x".repeat(MAX_REACT_CONTENT_BYTES + 1));
        oversized.kind = ArtifactKind::React;
        oversized.validated = true;
        let error = validate_upsert(&oversized, true).unwrap_err();
        assert!(error.contains("single-component limit"), "{error}");
    }

    #[test]
    fn versions_are_immutable_and_selection_round_trips() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::new(directory.path().to_path_buf());
        store.ensure_thread("thread-1", None, None).unwrap();

        let first = upsert(&store, request("<h1>First</h1>")).unwrap();
        assert_eq!(first.selected_version_tag.as_deref(), Some("v1"));
        let second = upsert(&store, request("<h1>Second</h1>")).unwrap();
        assert_eq!(second.selected_version_tag.as_deref(), Some("v2"));
        assert_eq!(second.artifacts[0].versions[0].content, "<h1>First</h1>");

        let selected = select(
            &store,
            ArtifactSelectRequest {
                thread_id: "thread-1".to_string(),
                artifact_id: "launch-plan".to_string(),
                version_tag: "v1".to_string(),
            },
        )
        .unwrap();
        assert_eq!(selected.selected_version_tag.as_deref(), Some("v1"));
        let reloaded = load_bundle_unlocked(&store, "thread-1").unwrap();
        assert_eq!(reloaded.selected_version_tag.as_deref(), Some("v1"));
    }

    /// Aurora Chat keeps each conversation in its own folder, where the bundle
    /// is plain `artifacts.json`. The writer used to re-derive its temp and
    /// backup paths from the file name and refused that one, so no chat could
    /// ever hold an artifact. Every write — first, second, and a reselect —
    /// has to land, and the staging files have to be gone afterwards.
    #[test]
    fn a_folder_store_conversation_can_hold_artifacts() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::new_folder(directory.path().join("Chats"));
        store.ensure_thread("thread-1", None, None).unwrap();

        upsert(&store, request("<h1>First</h1>")).unwrap();
        let second = upsert(&store, request("<h1>Second</h1>")).unwrap();
        assert_eq!(second.selected_version_tag.as_deref(), Some("v2"));

        let path = store.artifacts_path("thread-1");
        assert_eq!(path, directory.path().join("Chats/thread-1/artifacts.json"));
        assert!(path.exists());
        assert!(!store.artifacts_temp_path("thread-1").exists());
        assert!(!store.artifacts_backup_path("thread-1").exists());

        let image = ArtifactUpsertRequest {
            artifact_id: "image-001-generated-aurora".to_string(),
            title: "Aurora".to_string(),
            kind: ArtifactKind::Image,
            content: Some(r#"{"asset":"001-generated-aurora.png","path":"x"}"#.to_string()),
            ..request("")
        };
        let bundle = upsert(&store, image).unwrap();
        assert_eq!(bundle.artifacts.len(), 2);
        assert_eq!(bundle.selected_artifact_id.as_deref(), Some("image-001-generated-aurora"));
    }

    #[test]
    fn duplicate_thread_artifacts_rehomes_the_bundle() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::new(directory.path().to_path_buf());
        store.ensure_thread("thread-1", None, None).unwrap();
        store.ensure_thread("thread-2", None, None).unwrap();
        upsert(&store, request("<h1>First</h1>")).unwrap();

        duplicate_thread_artifacts(&store, "thread-1", "thread-2").unwrap();

        let copied = load_bundle_unlocked(&store, "thread-2").unwrap();
        assert_eq!(copied.thread_id, "thread-2");
        assert_eq!(copied.artifacts.len(), 1);
        assert_eq!(copied.artifacts[0].versions[0].content, "<h1>First</h1>");
    }

    #[test]
    fn rejects_format_changes_for_a_stable_artifact_id() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::new(directory.path().to_path_buf());
        store.ensure_thread("thread-1", None, None).unwrap();
        upsert(&store, request("<h1>First</h1>")).unwrap();

        let mut changed = request("# Markdown");
        changed.kind = ArtifactKind::Markdown;
        assert!(upsert(&store, changed)
            .unwrap_err()
            .contains("use a new artifactId"));
    }

    #[test]
    fn patch_revision_materializes_a_complete_immutable_version() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::new(directory.path().to_path_buf());
        store.ensure_thread("thread-1", None, None).unwrap();
        upsert(
            &store,
            request("<style>:root { --accent: #7c3aed; }</style><main>Launch</main>"),
        )
        .unwrap();

        let revised = upsert(
            &store,
            patch_request("v1", "--accent: #7c3aed", "--accent: #0891b2"),
        )
        .unwrap();

        assert_eq!(revised.selected_version_tag.as_deref(), Some("v2"));
        assert_eq!(
            revised.artifacts[0].versions[0].content,
            "<style>:root { --accent: #7c3aed; }</style><main>Launch</main>"
        );
        assert_eq!(
            revised.artifacts[0].versions[1].content,
            "<style>:root { --accent: #0891b2; }</style><main>Launch</main>"
        );
    }

    #[test]
    fn patch_revision_rejects_stale_or_ambiguous_matches() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::new(directory.path().to_path_buf());
        store.ensure_thread("thread-1", None, None).unwrap();
        upsert(&store, request("<p>same</p><p>same</p>")).unwrap();

        let ambiguous = upsert(&store, patch_request("v1", "same", "changed")).unwrap_err();
        assert!(ambiguous.contains("matches 2 locations"));

        upsert(&store, patch_request("v1", "<p>same</p>", "<p>first</p>")).unwrap_err();
        let stale = upsert(
            &store,
            ArtifactUpsertRequest {
                content: Some("<p>new</p>".to_string()),
                base_version_tag: None,
                patches: Vec::new(),
                ..request("unused")
            },
        )
        .unwrap();
        assert_eq!(stale.selected_version_tag.as_deref(), Some("v2"));
        let stale_error = upsert(&store, patch_request("v1", "new", "newer")).unwrap_err();
        assert!(stale_error.contains("latest version is 'v2'"));
    }

    #[test]
    fn patch_revision_reports_overlapping_patch_indices() {
        let base = r##"<rect fill="#1e3a5f" stroke="#3b82f6"/><path stroke="#3b82f6"/>"##;
        let error = apply_patches(
            base,
            &[
                ArtifactTextPatch {
                    find: r##"stroke="#3b82f6""##.to_string(),
                    replace: r##"stroke="#60a5fa""##.to_string(),
                    all: true,
                },
                ArtifactTextPatch {
                    find: r##"fill="#1e3a5f" stroke="#3b82f6""##.to_string(),
                    replace: r##"fill="#172554" stroke="#60a5fa""##.to_string(),
                    all: true,
                },
            ],
        )
        .unwrap_err();

        assert_eq!(
            error,
            "patches[1] overlaps with patches[0]; matched regions in the same artifact version must not overlap"
        );

        let reverse_error = apply_patches(
            base,
            &[
                ArtifactTextPatch {
                    find: r##"fill="#1e3a5f" stroke="#3b82f6""##.to_string(),
                    replace: r##"fill="#172554" stroke="#60a5fa""##.to_string(),
                    all: true,
                },
                ArtifactTextPatch {
                    find: r##"stroke="#3b82f6""##.to_string(),
                    replace: r##"stroke="#60a5fa""##.to_string(),
                    all: true,
                },
            ],
        )
        .unwrap_err();
        assert_eq!(
            reverse_error,
            "patches[1] overlaps with patches[0]; matched regions in the same artifact version must not overlap"
        );
    }

    #[test]
    fn patch_revision_applies_disjoint_matches_against_one_base() {
        let revised = apply_patches(
            "alpha beta gamma beta",
            &[
                ArtifactTextPatch {
                    find: "gamma".to_string(),
                    replace: "delta".to_string(),
                    all: false,
                },
                ArtifactTextPatch {
                    find: "beta".to_string(),
                    replace: "B".to_string(),
                    all: true,
                },
            ],
        )
        .unwrap();

        assert_eq!(revised, "alpha B delta B");
    }

    #[test]
    fn patch_revision_rejects_dependent_and_noop_patches_actionably() {
        let dependent = apply_patches(
            "alpha",
            &[
                ArtifactTextPatch {
                    find: "alpha".to_string(),
                    replace: "beta".to_string(),
                    all: false,
                },
                ArtifactTextPatch {
                    find: "beta".to_string(),
                    replace: "gamma".to_string(),
                    all: false,
                },
            ],
        )
        .unwrap_err();
        assert!(dependent.contains("Patch finds do not chain"));

        let noop = apply_patches(
            "alpha",
            &[ArtifactTextPatch {
                find: "alpha".to_string(),
                replace: "alpha".to_string(),
                all: false,
            }],
        )
        .unwrap_err();
        assert_eq!(
            noop,
            "patches[0] does not change its matched text; remove that patch"
        );
    }

    #[test]
    fn patch_preview_uses_the_commit_engine_without_saving() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::new(directory.path().to_path_buf());
        store.ensure_thread("thread-1", None, None).unwrap();
        upsert(&store, request("alpha beta")).unwrap();

        let preview = preview_patch(&store, patch_request("v1", "beta", "gamma")).unwrap();
        assert_eq!(preview, "alpha gamma");

        let reloaded = load_bundle_unlocked(&store, "thread-1").unwrap();
        assert_eq!(reloaded.selected_version_tag.as_deref(), Some("v1"));
        assert_eq!(reloaded.artifacts[0].versions.len(), 1);
        assert_eq!(reloaded.artifacts[0].versions[0].content, "alpha beta");
    }

    #[test]
    fn full_update_rejects_an_identical_version() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::new(directory.path().to_path_buf());
        store.ensure_thread("thread-1", None, None).unwrap();
        upsert(&store, request("same source")).unwrap();

        let error = upsert(&store, request("same source")).unwrap_err();
        assert!(error.contains("identical to the latest artifact version"));
        let reloaded = load_bundle_unlocked(&store, "thread-1").unwrap();
        assert_eq!(reloaded.artifacts[0].versions.len(), 1);
    }

    #[test]
    fn rejects_unsafe_ids_and_oversized_content() {
        let mut unsafe_request = request("content");
        unsafe_request.artifact_id = "../escape".to_string();
        assert!(validate_upsert(&unsafe_request, true).is_err());

        let mut huge = request("content");
        huge.content = Some("x".repeat(MAX_CONTENT_BYTES + 1));
        assert!(validate_upsert(&huge, true).is_err());

        let mut huge_mermaid = request("flowchart LR\nA --> B");
        huge_mermaid.kind = ArtifactKind::Mermaid;
        huge_mermaid.content = Some("x".repeat(MAX_MERMAID_CONTENT_BYTES + 1));
        assert!(validate_upsert(&huge_mermaid, true)
            .unwrap_err()
            .contains("diagram limit"));
    }
}
