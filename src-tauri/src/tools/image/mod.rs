//! `generate_image` — Aurora Chat's picture maker.
//!
//! One tool, three operations: `generate` a picture from a prompt, `edit` one
//! the conversation already holds, `list` what it can do. The same shape as
//! `recall`: one name, a typed `op`, so the model does not choose between
//! tools before it can act.
//!
//! ## What happens to a picture
//!
//! 1. The provider is called in the shape ITS format takes (`wire.rs`).
//! 2. The bytes are fetched at once and written into the conversation's own
//!    `assets/` under a name that says what it is (`assets.rs`). The provider's
//!    URL is never what Aurora shows later — it has no cache headers and a
//!    date-bucketed path, which is what a CDN that prunes looks like.
//! 3. The picture is placed in the Canvas as an `image` artifact, so the user
//!    sees it where every other rich result lands, and can come back to it.
//! 4. The model is shown a vision-sized copy through the same `<aurora_image>`
//!    marker `browser_screenshot` uses, so a model with vision can judge what
//!    it made and describe it truthfully rather than from the prompt.
//!
//! ## Where the providers come from
//!
//! The rows live in the frontend's settings and arrive on every chat turn. The
//! turn driver parks them in [`config::set_turn_config`] keyed by
//! conversation; the tool reads them back by `ToolContext::thread_id`. A
//! conversation that has never had a chat turn — a Build thread, say — has no
//! config and the tool says so.

pub mod assets;
pub mod client;
pub mod config;
pub mod ingest;
pub mod minimax;
pub mod qwen;
pub mod wire;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use base64::Engine;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor, ToolRegistry};
use crate::api::aurora_image;
use crate::commands::artifacts::{ArtifactKind, ArtifactUpsertRequest};

use self::assets::{AssetRecord, AssetSource, ImageArtifactContent, NewAsset};
use self::client::ImageClient;
use self::config::{resolve_model, ImageTurnConfig, ResolvedImageModel};
use self::wire::{EditSource, GenerationCall};

pub const TOOL_NAMES: &[&str] = &["generate_image"];

/// Longest prompt the tool forwards. Providers cap around 4 000 characters;
/// a prompt past this is a document, not a description.
const MAX_PROMPT_CHARS: usize = 4_000;
/// Longest artifact title, mirroring `commands::artifacts::MAX_TITLE_LEN`.
const MAX_TITLE_CHARS: usize = 120;
/// Longest title for a picture in the Canvas index.
///
/// Much shorter than [`MAX_TITLE_CHARS`], because it is a NAME in a list and
/// not a caption. A model that passes no `title` falls back to the prompt, and
/// a prompt is a paragraph — one arrived reading "Change the woman's hair
/// colour from light brown to very dark — nearly black with dark chocolate
/// tones. Keep everything e…" and ran the whole width of the dock.
const MAX_IMAGE_TITLE_CHARS: usize = 48;

pub struct GenerateImageTool {
    client: ImageClient,
}

impl GenerateImageTool {
    #[must_use]
    pub fn new() -> Self {
        Self {
            client: ImageClient::new(),
        }
    }
}

impl Default for GenerateImageTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for GenerateImageTool {
    fn name(&self) -> &str {
        "generate_image"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "generate_image".into(),
            description: "Make a picture, or change one this conversation already has.

Three operations:

- `op: \"generate\"` (the default) — a new picture from `prompt`. Describe the subject, the style, \
the composition and the mood in plain sentences; the model reads prose, not keyword lists.
- `op: \"edit\"` — change an existing picture. `source` names it: the file name from an earlier \
result (`001-generated-….png`), or its position (\"1\" for the first picture in this conversation). \
`prompt` says what to change. Only models marked as able to edit can do this; `list` shows which.
- `op: \"list\"` — the image models the user has configured, which of them can edit, their sizes, \
and every picture this conversation holds so far.

Every picture is saved into the conversation and opened in the Canvas beside the chat, so do not \
paste it, link it, or describe its bytes — say what you made and, if useful, what you would change. \
You will be shown the finished picture; describe what is actually in it, not what you asked for.

`model` picks one of the configured image models by name; omit it for the user's default. `size` \
is `WIDTHxHEIGHT` from the model's list; omit it for the model's default. `title` names the Canvas \
entry — a few words — and defaults to the prompt.

Each call makes ONE picture and costs the user money. Do not generate variations the user did not \
ask for."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "op": {
                        "type": "string",
                        "enum": ["generate", "edit", "list"],
                        "description": "Defaults to 'generate'."
                    },
                    "prompt": {
                        "type": "string",
                        "description": "What to make, or for 'edit', what to change. Required for both."
                    },
                    "source": {
                        "type": "string",
                        "description": "For 'edit': the picture to start from — its file name or its position (\"1\" is the first picture in this conversation)."
                    },
                    "model": {
                        "type": "string",
                        "description": "One of the configured image models, by name. Omit for the default."
                    },
                    "size": {
                        "type": "string",
                        "description": "WIDTHxHEIGHT, e.g. 1024x1024. Omit for the model's default."
                    },
                    "title": {
                        "type": "string",
                        "description": "Name for the Canvas entry. Defaults to the prompt."
                    }
                }
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let Some(turn) = config::turn_config(&ctx.thread_id) else {
            return Err(ToolError::Execution(
                "generate_image is an Aurora Chat tool and this conversation was not handed any \
image providers. In Aurora Chat, the user configures them under Settings → Providers → Image \
providers; in Aurora Build the tool is not available."
                    .into(),
            ));
        };
        let op = input.get("op").and_then(Value::as_str).unwrap_or("generate");
        let request = TurnRequest {
            thread_id: &ctx.thread_id,
            turn: &turn,
            client: &self.client,
        };
        let work = async {
            match op {
                "generate" => request.generate(&input).await,
                "edit" => request.edit(&input).await,
                "list" => request.list(),
                other => Err(ToolError::InvalidInput(format!(
                    "Unknown op '{other}'. Use 'generate', 'edit' or 'list'."
                ))),
            }
        };
        tokio::select! {
            result = work => result,
            () = ctx.cancel_token.cancelled() => Err(ToolError::Cancelled),
        }
    }
}

/// One call's working set: the conversation it is for and the client to use.
struct TurnRequest<'a> {
    thread_id: &'a str,
    turn: &'a ImageTurnConfig,
    client: &'a ImageClient,
}

impl TurnRequest<'_> {
    fn assets_dir(&self) -> Result<PathBuf, ToolError> {
        self.turn.store.assets_dir(self.thread_id).ok_or_else(|| {
            ToolError::Execution(
                "this conversation's store has no place for assets — it is a Build thread, and \
generate_image is an Aurora Chat tool."
                    .into(),
            )
        })
    }

    fn previews_dir(&self) -> PathBuf {
        self.turn.store.thread_dir(self.thread_id).join("previews")
    }

    fn list(&self) -> Result<String, ToolError> {
        let providers: Vec<Value> = self
            .turn
            .providers
            .iter()
            .map(|provider| {
                let can_edit_here = provider.edit_url().is_some();
                json!({
                    "provider": provider.name,
                    "format": provider.api_format.label(),
                    "ready": provider.ready(),
                    "models": provider.models.iter().map(|model| json!({
                        "model": model.model_key,
                        "label": model.label,
                        "canEdit": can_edit_here && model.can_edit,
                        "editMode": if provider.api_format == config::ImageApiFormat::MiniMax { "portrait-reference" } else { "edit" },
                        "sizes": model.sizes,
                        "defaultSize": model.default_size,
                    })).collect::<Vec<_>>(),
                })
            })
            .collect();
        let assets = match self.turn.store.assets_dir(self.thread_id) {
            Some(dir) => assets::list(&dir).map_err(ToolError::Execution)?,
            None => Vec::new(),
        };
        let pictures: Vec<Value> = assets
            .iter()
            .enumerate()
            .map(|(index, asset)| {
                json!({
                    "position": index + 1,
                    "asset": asset.name,
                    "source": asset.source,
                    "width": asset.width,
                    "height": asset.height,
                    "prompt": asset.prompt,
                    "model": asset.model,
                    "parent": asset.parent,
                })
            })
            .collect();
        let default = resolve_model(&self.turn.providers, None)
            .ok()
            .map(|resolved| resolved.model.model_key);
        let note = if providers.is_empty() {
            Some(config::ResolveError::NoProviders.to_string())
        } else if !providers.iter().any(|p| p["ready"] == true) {
            Some(config::ResolveError::NoneReady.to_string())
        } else {
            None
        };
        serialize(json!({
            "op": "list",
            "defaultModel": default,
            "providers": providers,
            "pictures": pictures,
            "note": note,
        }))
    }

    async fn generate(&self, input: &Value) -> Result<String, ToolError> {
        let prompt = prompt_of(input, "generate")?;
        let resolved = resolve(&self.turn.providers, input)?;
        let size = size_of(input, &resolved)?;
        let assets_dir = self.assets_dir()?;

        let started = Instant::now();
        let response = self
            .client
            .generate(
                &resolved.provider,
                GenerationCall {
                    model: &resolved.model.model_key,
                    prompt: &prompt,
                    size: size.as_deref(),
                    format: resolved.provider.request_format,
                },
            )
            .await
            .map_err(|error| ToolError::Execution(error.to_string()))?;
        let output = response.images.into_iter().next().ok_or_else(|| {
            ToolError::Execution(wire::WireError::NoImage.to_string())
        })?;
        let bytes = self
            .client
            .materialize(&output, assets::MAX_ASSET_BYTES)
            .await
            .map_err(|error| ToolError::Execution(error.to_string()))?;

        let record = assets::store(
            &assets_dir,
            NewAsset {
                source: AssetSource::Generated,
                hint: prompt.clone(),
                declared_media_type: None,
                prompt: Some(prompt.clone()),
                model: Some(resolved.model.model_key.clone()),
                provider: Some(resolved.provider.name.clone()),
                remote_url: output.url.clone(),
                parent: None,
            },
            &bytes,
        )
        .map_err(ToolError::Execution)?;

        let title = title_of(input, &prompt);
        let artifact_id = self.place_in_canvas(&assets_dir, &record, &title)?;
        Ok(self.result(
            "generate",
            &record,
            bytes,
            &resolved,
            &artifact_id,
            output.revised_prompt.as_deref(),
            started.elapsed().as_secs(),
        ))
    }

    async fn edit(&self, input: &Value) -> Result<String, ToolError> {
        let prompt = prompt_of(input, "edit")?;
        let source_name = input
            .get("source")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                ToolError::InvalidInput(
                    "`source` is required for op 'edit': the picture's file name or its position. \
Use op 'list' to see the pictures this conversation holds."
                        .into(),
                )
            })?;
        let assets_dir = self.assets_dir()?;
        let held = assets::list(&assets_dir).map_err(ToolError::Execution)?;
        let source = assets::find(&held, source_name).cloned().ok_or_else(|| {
            if held.is_empty() {
                ToolError::InvalidInput(
                    "This conversation holds no pictures yet, so there is nothing to edit. Use op \
'generate' first."
                        .into(),
                )
            } else {
                ToolError::InvalidInput(format!(
                    "No picture called '{source_name}' in this conversation. It holds: {}.",
                    held.iter()
                        .enumerate()
                        .map(|(i, a)| format!("{} ({})", a.name, i + 1))
                        .collect::<Vec<_>>()
                        .join(", ")
                ))
            }
        })?;

        let resolved = resolve(&self.turn.providers, input)?;
        if !resolved.provider.can_edit_with(&resolved.model) {
            let editors: Vec<String> = self
                .turn
                .providers
                .iter()
                .filter(|p| p.ready() && p.edit_url().is_some())
                .flat_map(|p| p.models.iter().filter(|m| m.can_edit).map(|m| m.model_key.clone()))
                .collect();
            return Err(ToolError::InvalidInput(if editors.is_empty() {
                format!(
                    "'{}' cannot edit pictures, and no configured image model can. Tell the user \
to mark a model as able to edit under Settings → Providers → Image providers.",
                    resolved.model.model_key
                )
            } else {
                format!(
                    "'{}' cannot edit pictures. Models that can: {}. Pass one as `model`.",
                    resolved.model.model_key,
                    editors.join(", ")
                )
            }));
        }
        let size = size_of(input, &resolved)?;
        let source_path = assets::path_of(&assets_dir, &source);
        let source_bytes = std::fs::read(&source_path).map_err(|error| {
            ToolError::Execution(format!(
                "the picture '{}' is recorded but its file could not be read ({error}). It may \
have been deleted from the conversation's folder.",
                source.name
            ))
        })?;

        let started = Instant::now();
        let response = self
            .client
            .edit(
                &resolved.provider,
                GenerationCall {
                    model: &resolved.model.model_key,
                    prompt: &prompt,
                    size: size.as_deref(),
                    format: resolved.provider.request_format,
                },
                EditSource {
                    bytes: &source_bytes,
                    media_type: &source.media_type,
                    file_name: &source.name,
                    remote_url: source.remote_url.as_deref(),
                },
            )
            .await
            .map_err(|error| ToolError::Execution(error.to_string()))?;
        let output = response.images.into_iter().next().ok_or_else(|| {
            ToolError::Execution(wire::WireError::NoImage.to_string())
        })?;
        let bytes = self
            .client
            .materialize(&output, assets::MAX_ASSET_BYTES)
            .await
            .map_err(|error| ToolError::Execution(error.to_string()))?;

        let record = assets::store(
            &assets_dir,
            NewAsset {
                source: AssetSource::Edited,
                hint: prompt.clone(),
                declared_media_type: None,
                prompt: Some(prompt.clone()),
                model: Some(resolved.model.model_key.clone()),
                provider: Some(resolved.provider.name.clone()),
                remote_url: output.url.clone(),
                parent: Some(source.name.clone()),
            },
            &bytes,
        )
        .map_err(ToolError::Execution)?;

        let title = title_of(input, &prompt);
        let artifact_id = self.place_in_canvas(&assets_dir, &record, &title)?;
        Ok(self.result(
            "edit",
            &record,
            bytes,
            &resolved,
            &artifact_id,
            output.revised_prompt.as_deref(),
            started.elapsed().as_secs(),
        ))
    }

    /// Land the picture in the Canvas. Returns the artifact id.
    fn place_in_canvas(
        &self,
        assets_dir: &Path,
        record: &AssetRecord,
        title: &str,
    ) -> Result<String, ToolError> {
        place_in_canvas(&self.turn.store, self.thread_id, assets_dir, record, title)
            .map_err(ToolError::Execution)
    }
}

/// Land a stored picture in the conversation's Canvas as an `image` artifact.
/// Returns the artifact id. Shared by the tool and the direct path (an image
/// model as the conversation's model), so a picture is one thing wherever it
/// was made.
pub(crate) fn place_in_canvas(
    store: &crate::agent_runtime::session_store::SessionStore,
    thread_id: &str,
    assets_dir: &Path,
    record: &AssetRecord,
    title: &str,
) -> Result<String, String> {
    let artifact_id = assets::artifact_id_for(&record.name);
    let content = serde_json::to_string(&ImageArtifactContent::from_record(assets_dir, record))
        .map_err(|error| format!("could not encode the artifact: {error}"))?;
    crate::commands::artifacts::upsert(
        store,
        ArtifactUpsertRequest {
            thread_id: thread_id.to_string(),
            artifact_id: artifact_id.clone(),
            title: title.to_string(),
            kind: ArtifactKind::Image,
            content: Some(content),
            base_version_tag: None,
            patches: Vec::new(),
            validated: false,
        },
    )
    .map_err(|error| {
        format!(
            "the picture was saved as {} but could not be placed in the Canvas: {error}",
            record.name
        )
    })?;
    Ok(artifact_id)
}

impl TurnRequest<'_> {

    /// The tool result: an `<aurora_image>` block carrying a vision-sized copy,
    /// then a caption saying what was made and how to refer to it.
    ///
    /// The marker's `src` is the PREVIEW, not the asset. History leans the
    /// body away and rehydrates from `src` on every later request, and a 2 MB
    /// PNG re-uploaded per turn is a cost nobody asked for; the JPEG preview is
    /// a tenth of that. The preview lives in the conversation's own folder so
    /// it travels and is deleted with it.
    #[allow(clippy::too_many_arguments)]
    fn result(
        &self,
        op: &str,
        record: &AssetRecord,
        bytes: Vec<u8>,
        resolved: &ResolvedImageModel,
        artifact_id: &str,
        revised_prompt: Option<&str>,
        elapsed_secs: u64,
    ) -> String {
        let (encoded, shown_w, shown_h) = aurora_image::encode_for_vision(bytes);
        let decoded = shown_w != 0 && shown_h != 0;
        let media_type = if decoded {
            aurora_image::ENCODED_MEDIA_TYPE
        } else {
            record.media_type.as_str()
        };
        let preview_src = decoded
            .then(|| write_preview(&self.previews_dir(), record, &encoded))
            .flatten();

        let mut header = format!("media_type=\"{media_type}\"");
        if decoded {
            header.push_str(&format!(" width=\"{shown_w}\" height=\"{shown_h}\""));
        }
        if let Some(src) = &preview_src {
            header.push_str(&format!(" src=\"{}\"", aurora_image::escape_attr(src)));
        }
        header.push_str(&format!(" name=\"{}\"", aurora_image::escape_attr(&record.name)));
        // The Canvas entry this picture landed in, so the tool card can offer
        // "Open in Canvas" without parsing the caption. Attributes survive
        // history leaning; the caption is prose for the model.
        header.push_str(&format!(" artifact=\"{}\"", aurora_image::escape_attr(artifact_id)));
        let body = base64::engine::general_purpose::STANDARD.encode(&encoded);

        let verb = if op == "edit" { "Edited into" } else { "Generated" };
        let mut caption = format!(
            "{verb} {name} ({w}×{h} px, {media}) with {model} via {provider} in {elapsed}s. Saved in \
the conversation's assets and opened in the Canvas as artifact `{artifact}`.",
            name = record.name,
            w = record.width,
            h = record.height,
            media = record.media_type,
            model = resolved.model.model_key,
            provider = resolved.provider.name,
            elapsed = elapsed_secs,
            artifact = artifact_id,
        );
        if let Some(parent) = &record.parent {
            caption.push_str(&format!(" Started from {parent}."));
        }
        if let Some(revised) = revised_prompt.map(str::trim).filter(|r| !r.is_empty()) {
            caption.push_str(&format!(" The provider rewrote the prompt as: {revised}"));
        }
        if decoded && (shown_w, shown_h) != (record.width, record.height) {
            caption.push_str(&format!(" Shown to you downscaled to {shown_w}×{shown_h}."));
        }
        caption.push_str(&format!(
            " To change it, call generate_image with op \"edit\" and source \"{}\".",
            record.name
        ));
        format!(
            "<aurora_image {header}>{body}{close}\n{caption}",
            close = aurora_image::CLOSE
        )
    }
}

/// Write the vision-sized JPEG beside the assets. Best-effort: without a
/// preview the marker keeps its base64 body and the model still sees the
/// picture, at the cost of re-sending it on later turns.
fn write_preview(dir: &Path, record: &AssetRecord, encoded: &[u8]) -> Option<String> {
    std::fs::create_dir_all(dir).ok()?;
    let stem = Path::new(&record.name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&record.name);
    let path = dir.join(format!("{stem}.jpg"));
    std::fs::write(&path, encoded).ok()?;
    Some(assets::display_path(&path))
}

fn prompt_of(input: &Value, op: &str) -> Result<String, ToolError> {
    let prompt = input
        .get("prompt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .ok_or_else(|| {
            ToolError::InvalidInput(format!(
                "`prompt` is required for op '{op}': {}",
                if op == "edit" {
                    "say what to change."
                } else {
                    "describe the picture to make."
                }
            ))
        })?;
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err(ToolError::InvalidInput(format!(
            "`prompt` is {} characters; the limit is {MAX_PROMPT_CHARS}. Describe the picture, do \
not paste a document.",
            prompt.chars().count()
        )));
    }
    Ok(prompt.to_string())
}

fn resolve(
    providers: &[config::ImageProviderConfig],
    input: &Value,
) -> Result<ResolvedImageModel, ToolError> {
    let wanted = input.get("model").and_then(Value::as_str);
    resolve_model(providers, wanted).map_err(|error| match error {
        config::ResolveError::UnknownModel { .. } => ToolError::InvalidInput(error.to_string()),
        _ => ToolError::Execution(error.to_string()),
    })
}

/// The size to ask for: the caller's, checked against the model's list when it
/// has one; else the model's default; else nothing, and the provider decides.
fn size_of(input: &Value, resolved: &ResolvedImageModel) -> Result<Option<String>, ToolError> {
    let asked = input
        .get("size")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let Some(asked) = asked else {
        return Ok(resolved
            .model
            .default_size
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string));
    };
    if !looks_like_a_size(asked) {
        return Err(ToolError::InvalidInput(format!(
            "`size` must be WIDTHxHEIGHT, e.g. 1024x1024 — got '{asked}'."
        )));
    }
    let sizes = &resolved.model.sizes;
    if !sizes.is_empty() && !sizes.iter().any(|s| s.trim().eq_ignore_ascii_case(asked)) {
        return Err(ToolError::InvalidInput(format!(
            "'{}' does not offer size {asked}. Its sizes: {}.",
            resolved.model.model_key,
            sizes.join(", ")
        )));
    }
    Ok(Some(asked.to_string()))
}

fn looks_like_a_size(text: &str) -> bool {
    let Some((w, h)) = text.split_once(['x', 'X', '×']) else {
        return false;
    };
    !w.is_empty()
        && !h.is_empty()
        && w.chars().all(|c| c.is_ascii_digit())
        && h.chars().all(|c| c.is_ascii_digit())
}

fn title_of(input: &Value, prompt: &str) -> String {
    let given = input
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or(prompt);
    let collapsed: String = given.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= MAX_IMAGE_TITLE_CHARS {
        return collapsed;
    }
    // Cut on a word, not mid-syllable: a name ending "dark choc…" reads as a
    // truncation, one ending "dark…" reads as a name.
    let mut title = String::new();
    for word in collapsed.split(' ') {
        let next = if title.is_empty() {
            word.chars().count()
        } else {
            title.chars().count() + 1 + word.chars().count()
        };
        if next > MAX_IMAGE_TITLE_CHARS - 1 {
            break;
        }
        if !title.is_empty() {
            title.push(' ');
        }
        title.push_str(word);
    }
    if title.is_empty() {
        title = collapsed.chars().take(MAX_IMAGE_TITLE_CHARS - 1).collect();
    }
    title.push('…');
    title
}

fn serialize(payload: Value) -> Result<String, ToolError> {
    serde_json::to_string(&payload)
        .map_err(|error| ToolError::Execution(format!("could not serialize result: {error}")))
}

pub fn register(reg: &mut ToolRegistry) {
    reg.register(Arc::new(GenerateImageTool::new()));
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::client::fake_server::{serve, Canned};
    use super::config::{
        clear_turn_config, set_turn_config, ImageApiFormat, ImageModelConfig, ImageProviderConfig,
    };
    use super::*;
    use crate::agent_runtime::session_store::SessionStore;
    use crate::agent_runtime::tool_executor::WorkspaceAccess;
    use tokio_util::sync::CancellationToken;

    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut out = Vec::new();
        image::RgbaImage::from_pixel(w, h, image::Rgba([120, 40, 200, 255]))
            .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    fn provider(base_url: &str, format: ImageApiFormat) -> ImageProviderConfig {
        ImageProviderConfig {
            id: "p1".into(),
            name: "a6api".into(),
            base_url: base_url.into(),
            api_key: Some("sk-test".into()),
            api_format: format,
            generation_path: None,
            edit_path: None,
            request_format: None,
            enabled: true,
            models: vec![
                ImageModelConfig {
                    id: "p1:gpt-image-1.5".into(),
                    provider_id: "p1".into(),
                    model_key: "gpt-image-1.5".into(),
                    label: Some("Fast".into()),
                    can_edit: true,
                    sizes: vec!["1024x1024".into(), "1536x1024".into()],
                    default_size: Some("1024x1024".into()),
                    price_per_image: None,
                },
                ImageModelConfig {
                    id: "p1:no-edit".into(),
                    provider_id: "p1".into(),
                    model_key: "no-edit".into(),
                    label: None,
                    can_edit: false,
                    sizes: vec![],
                    default_size: None,
                    price_per_image: None,
                },
            ],
        }
    }

    struct Harness {
        _dir: tempfile::TempDir,
        store: Arc<SessionStore>,
        thread_id: String,
        ctx: ToolContext,
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            clear_turn_config(&self.thread_id);
        }
    }

    fn context_for(thread_id: &str) -> ToolContext {
        ToolContext {
            turn_id: "turn".into(),
            tool_call_id: "call".into(),
            thread_id: thread_id.into(),
            workspace_root: None,
            workspace_access: WorkspaceAccess::default(),
            spill_dir: None,
            cancel_token: CancellationToken::new(),
        }
    }

    fn harness(name: &str, providers: Vec<ImageProviderConfig>) -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(SessionStore::new_folder(dir.path().join("Chats")));
        let thread_id = format!("img-test-{name}");
        store
            .ensure_thread(&thread_id, Some("pictures".into()), None)
            .unwrap();
        set_turn_config(
            &thread_id,
            ImageTurnConfig {
                providers,
                store: store.clone(),
            },
        );
        Harness {
            _dir: dir,
            store,
            ctx: context_for(&thread_id),
            thread_id,
        }
    }

    #[tokio::test]
    async fn a_generation_saves_the_asset_places_it_in_the_canvas_and_shows_the_model() {
        let picture = png(64, 48);
        let b64 = base64::engine::general_purpose::STANDARD.encode(&picture);
        let server = serve(vec![Canned::json(
            200,
            &format!(r#"{{"data":[{{"b64_json":"{b64}","revised_prompt":"an aurora, painterly"}}]}}"#),
        )])
        .await;
        let h = harness("generate", vec![provider(&server.base_url, ImageApiFormat::A6api)]);
        let tool = GenerateImageTool::new();

        let out = tool
            .execute(
                json!({"prompt": "An aurora over mountains", "title": "Aurora"}),
                &h.ctx,
            )
            .await
            .unwrap();

        // The request went out in the a6api generation shape with the key.
        let sent = server.recorded();
        assert_eq!(sent[0].path, "/v1/images/generations");
        assert_eq!(sent[0].header("authorization"), Some("Bearer sk-test"));
        assert_eq!(sent[0].json()["size"], "1024x1024", "the model's default size");

        // The asset is on disk under the conversation, named for what it is.
        let assets_dir = h.store.assets_dir(&h.thread_id).unwrap();
        let held = assets::list(&assets_dir).unwrap();
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].name, "001-generated-an-aurora-over-mountains.png");
        assert_eq!((held[0].width, held[0].height), (64, 48));
        assert_eq!(held[0].model.as_deref(), Some("gpt-image-1.5"));
        assert_eq!(std::fs::read(assets_dir.join(&held[0].name)).unwrap(), picture);

        // It is in the Canvas as an image artifact whose content names the file.
        let bundle = crate::commands::artifacts::load_bundle_for_test(&h.store, &h.thread_id);
        assert_eq!(bundle.artifacts.len(), 1);
        assert_eq!(bundle.artifacts[0].id, "image-001-generated-an-aurora-over-mountains");
        assert_eq!(bundle.artifacts[0].kind, ArtifactKind::Image);
        assert_eq!(bundle.artifacts[0].title, "Aurora");
        let content: Value =
            serde_json::from_str(&bundle.artifacts[0].versions[0].content).unwrap();
        assert_eq!(content["asset"], "001-generated-an-aurora-over-mountains.png");
        assert!(content["path"].as_str().unwrap().ends_with(".png"));

        // The model sees a marker with a preview `src` and a caption it can act on.
        let marker = aurora_image::find_marker(&out, 0).expect("an <aurora_image> block");
        assert_eq!(marker.media_type(), "image/jpeg");
        assert!(marker.payload().is_some(), "this turn's copy carries the bytes");
        let src = aurora_image::unescape_attr(marker.src().unwrap());
        assert!(src.ends_with("001-generated-an-aurora-over-mountains.jpg"), "{src}");
        assert!(Path::new(&src).exists(), "the preview is on disk");
        assert!(src.contains("previews"), "previews live beside assets, not in them: {src}");
        assert_eq!(marker.attr("name"), Some("001-generated-an-aurora-over-mountains.png"));
        // The card's way into the Canvas, machine-readable rather than scraped
        // from the caption.
        assert_eq!(marker.attr("artifact"), Some("image-001-generated-an-aurora-over-mountains"));
        let caption = &out[marker.end..];
        assert!(caption.contains("Generated 001-generated-an-aurora-over-mountains.png (64×48 px"));
        assert!(caption.contains("gpt-image-1.5 via a6api"));
        assert!(caption.contains("image-001-generated-an-aurora-over-mountains"));
        assert!(caption.contains("rewrote the prompt as: an aurora, painterly"));
        assert!(caption.contains("op \"edit\" and source \"001-generated-an-aurora-over-mountains.png\""));
    }

    #[tokio::test]
    async fn a_url_response_is_downloaded_into_assets_rather_than_linked() {
        // Two servers: the API, and the "CDN" the URL points at.
        let cdn = serve(vec![Canned::png(png(8, 8))]).await;
        let url = format!("{}/2026/09/04/x.png", cdn.base_url);
        let api = serve(vec![Canned::json(200, &format!(r#"{{"data":[{{"url":"{url}"}}]}}"#))]).await;
        let h = harness("url", vec![provider(&api.base_url, ImageApiFormat::A6api)]);

        let out = GenerateImageTool::new()
            .execute(json!({"prompt": "tiny"}), &h.ctx)
            .await
            .unwrap();
        assert_eq!(cdn.recorded()[0].path, "/v1/2026/09/04/x.png");
        let held = assets::list(&h.store.assets_dir(&h.thread_id).unwrap()).unwrap();
        assert_eq!(held[0].remote_url.as_deref(), Some(url.as_str()));
        assert!(!out.contains(&url), "the model is never handed the provider's URL");
    }

    #[tokio::test]
    async fn an_edit_sends_the_source_by_url_records_the_parent_and_numbers_the_child() {
        let first = png(16, 16);
        let b64 = base64::engine::general_purpose::STANDARD.encode(&first);
        let cdn_url = "https://img.example/orig.png";
        let server = serve(vec![
            Canned::json(200, &format!(r#"{{"data":[{{"b64_json":"{b64}","url":"{cdn_url}"}}]}}"#)),
            Canned::json(200, &format!(r#"{{"data":[{{"b64_json":"{b64}"}}]}}"#)),
        ])
        .await;
        let h = harness("edit", vec![provider(&server.base_url, ImageApiFormat::A6api)]);
        let tool = GenerateImageTool::new();
        tool.execute(json!({"prompt": "a cat"}), &h.ctx).await.unwrap();
        let out = tool
            .execute(json!({"op": "edit", "source": "1", "prompt": "make the cat orange"}), &h.ctx)
            .await
            .unwrap();

        let sent = server.recorded();
        assert_eq!(sent[1].path, "/v1/images/edits");
        assert!(sent[1].header("content-type").unwrap().starts_with("application/json"));
        assert_eq!(sent[1].json()["image"], cdn_url, "a6api gets the URL it gave us");
        assert_eq!(sent[1].json()["prompt"], "make the cat orange");

        let held = assets::list(&h.store.assets_dir(&h.thread_id).unwrap()).unwrap();
        assert_eq!(held.len(), 2);
        assert_eq!(held[1].name, "002-edited-make-the-cat-orange.png");
        assert_eq!(held[1].parent.as_deref(), Some("001-generated-a-cat.png"));
        assert!(out.contains("Edited into 002-edited-make-the-cat-orange.png"));
        assert!(out.contains("Started from 001-generated-a-cat.png"));

        let bundle = crate::commands::artifacts::load_bundle_for_test(&h.store, &h.thread_id);
        assert_eq!(bundle.artifacts.len(), 2, "an edit is a new Canvas entry, not a version");
    }

    #[tokio::test]
    async fn an_edit_with_a_model_that_cannot_edit_is_refused_before_any_call() {
        let b64 = base64::engine::general_purpose::STANDARD.encode(png(4, 4));
        let server = serve(vec![Canned::json(200, &format!(r#"{{"data":[{{"b64_json":"{b64}"}}]}}"#))]).await;
        let h = harness("noedit", vec![provider(&server.base_url, ImageApiFormat::A6api)]);
        let tool = GenerateImageTool::new();
        tool.execute(json!({"prompt": "x"}), &h.ctx).await.unwrap();
        let err = tool
            .execute(json!({"op": "edit", "source": "1", "prompt": "y", "model": "no-edit"}), &h.ctx)
            .await
            .unwrap_err();
        let text = err.to_string();
        assert!(text.contains("'no-edit' cannot edit"), "{text}");
        assert!(text.contains("gpt-image-1.5"), "it names the models that can: {text}");
        assert_eq!(server.recorded().len(), 1, "no second request was made");
    }

    #[tokio::test]
    async fn editing_without_pictures_or_with_an_unknown_source_says_what_exists() {
        let h = harness("nosource", vec![provider("http://127.0.0.1:9/v1", ImageApiFormat::A6api)]);
        let tool = GenerateImageTool::new();
        let err = tool
            .execute(json!({"op": "edit", "source": "1", "prompt": "y"}), &h.ctx)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("holds no pictures yet"), "{err}");
        let err = tool
            .execute(json!({"op": "edit", "prompt": "y"}), &h.ctx)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("`source` is required"), "{err}");
    }

    #[tokio::test]
    async fn list_names_models_editability_sizes_and_the_pictures_held() {
        let h = harness("list", vec![provider("http://127.0.0.1:9/v1", ImageApiFormat::A6api)]);
        let out = GenerateImageTool::new()
            .execute(json!({"op": "list"}), &h.ctx)
            .await
            .unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["defaultModel"], "gpt-image-1.5");
        assert_eq!(parsed["providers"][0]["models"][0]["canEdit"], true);
        assert_eq!(parsed["providers"][0]["models"][1]["canEdit"], false);
        assert_eq!(parsed["providers"][0]["models"][0]["sizes"][1], "1536x1024");
        assert_eq!(parsed["pictures"].as_array().unwrap().len(), 0);
        assert!(parsed["note"].is_null());
    }

    #[tokio::test]
    async fn a_provider_error_under_200_reaches_the_model_in_the_provider_s_words() {
        let server = serve(vec![Canned::json(
            200,
            r#"{"error":{"code":"insufficient_quota","message":"You have run out of credit"}}"#,
        )])
        .await;
        let h = harness("quota", vec![provider(&server.base_url, ImageApiFormat::A6api)]);
        let err = GenerateImageTool::new()
            .execute(json!({"prompt": "x"}), &h.ctx)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("run out of credit"), "{err}");
        assert!(assets::list(&h.store.assets_dir(&h.thread_id).unwrap()).unwrap().is_empty());
    }

    #[tokio::test]
    async fn bad_inputs_are_named_before_any_request() {
        let h = harness("inputs", vec![provider("http://127.0.0.1:9/v1", ImageApiFormat::A6api)]);
        let tool = GenerateImageTool::new();
        for (input, expected) in [
            (json!({}), "`prompt` is required"),
            (json!({"prompt": "x", "size": "big"}), "WIDTHxHEIGHT"),
            (json!({"prompt": "x", "size": "512x512"}), "does not offer size 512x512"),
            (json!({"prompt": "x", "model": "dall-e-9"}), "No image model called 'dall-e-9'"),
            (json!({"op": "paint", "prompt": "x"}), "Unknown op 'paint'"),
            (json!({"prompt": "x".repeat(5000)}), "limit is 4000"),
        ] {
            let err = tool.execute(input.clone(), &h.ctx).await.unwrap_err();
            assert!(err.to_string().contains(expected), "{input} → {err}");
        }
    }

    #[tokio::test]
    async fn a_conversation_without_a_turn_config_is_told_why() {
        let ctx = context_for("never-configured");
        let err = GenerateImageTool::new()
            .execute(json!({"prompt": "x"}), &ctx)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("Aurora Chat tool"), "{err}");
    }

    #[tokio::test]
    async fn a_build_store_has_no_assets_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(SessionStore::new(dir.path().join("sessions")));
        let thread_id = "img-test-flat";
        store.ensure_thread(thread_id, None, None).unwrap();
        set_turn_config(
            thread_id,
            ImageTurnConfig {
                providers: vec![provider("http://127.0.0.1:9/v1", ImageApiFormat::A6api)],
                store,
            },
        );
        let err = GenerateImageTool::new()
            .execute(json!({"prompt": "x"}), &context_for(thread_id))
            .await
            .unwrap_err();
        clear_turn_config(thread_id);
        assert!(err.to_string().contains("no place for assets"), "{err}");
    }

    #[test]
    fn titles_default_to_the_prompt_and_are_bounded() {
        assert_eq!(title_of(&json!({}), "an  aurora\nover mountains"), "an aurora over mountains");
        assert_eq!(title_of(&json!({"title": " Aurora "}), "ignored"), "Aurora");
        // A title is a NAME in the Canvas index, so it is held far shorter than
        // an artifact title generally is — a model that passes no `title` falls
        // back to the prompt, and a prompt is a paragraph.
        let long = title_of(&json!({}), &"word ".repeat(100));
        assert!(long.chars().count() <= MAX_IMAGE_TITLE_CHARS, "got {long:?}");
        assert!(long.ends_with('…'));
        // Cut on a word boundary: "dark…" reads as a name, "dark choc…" reads
        // as a truncation.
        let sentence = title_of(
            &json!({}),
            "Change the woman's hair colour from light brown to very dark, nearly black",
        );
        assert!(sentence.ends_with('…'));
        assert!(!sentence.contains("  "));
        assert!(
            sentence.trim_end_matches('…').split(' ').last().is_some_and(|w| {
                "Change the woman's hair colour from light brown to very dark, nearly black"
                    .split(' ')
                    .any(|original| original == w)
            }),
            "the last word should be a whole word: {sentence:?}"
        );
        // A single word longer than the cap still has to end somewhere.
        let one_word = title_of(&json!({}), &"x".repeat(200));
        assert_eq!(one_word.chars().count(), MAX_IMAGE_TITLE_CHARS);
    }

    #[test]
    fn sizes_are_width_x_height() {
        assert!(looks_like_a_size("1024x1024"));
        assert!(looks_like_a_size("1536X1024"));
        assert!(looks_like_a_size("1024×1536"));
        assert!(!looks_like_a_size("large"));
        assert!(!looks_like_a_size("x1024"));
        assert!(!looks_like_a_size("1024x"));
    }
}
