//! What an image provider IS, as Rust sees it, and how one conversation's turn
//! learns which ones it may use.
//!
//! The rows live in the frontend's app settings
//! (`services/providers/image-providers.ts` owns the shape and the editing
//! UI), and arrive on every chat turn as `AgentChatRequest::image_providers`.
//! The turn driver parks them here, keyed by conversation, before the turn
//! runs; `generate_image` reads them back through its `ToolContext::thread_id`.
//!
//! That indirection exists because [`crate::agent_runtime::tool_executor::ToolContext`]
//! is built at seventy-odd sites and a field for one tool's settings does not
//! belong on all of them. `tool_search::revealed` keeps its per-conversation
//! state the same way, for the same reason.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::agent_runtime::session_store::SessionStore;

/// How a provider speaks on the wire. Not a label: it decides the request body,
/// and getting it wrong is an HTTP 400 rather than a degraded picture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ImageApiFormat {
    /// OpenAI's own shape. Generation is JSON; an edit is
    /// `multipart/form-data` with the source image as a file part.
    #[serde(rename = "openai-images")]
    OpenaiImages,
    /// a6api. Generation is OpenAI-shaped and then three things differ, every
    /// one measured against the live service on 2026-09-04:
    /// 1. `/images/edits` REJECTS multipart. It wants JSON with `image` as a
    ///    URL.
    /// 2. Errors arrive under HTTP 200. The body is parsed every time.
    /// 3. `/models/{id}` is unreliable — it denied a model `/models` listed.
    ///    Discovery uses the list, never the lookup.
    #[serde(rename = "a6api")]
    A6api,
    #[serde(rename = "minimax-native")]
    MiniMax,
    /// Qwen / DashScope's own shape. Generation and editing are the SAME
    /// endpoint, the prompt is chat-shaped (`input.messages`), and `size` is
    /// spelled with an asterisk. Qwen's OpenAI-compatible endpoint exists and
    /// is reachable as [`Self::OpenaiImages`], but it cannot edit, so a row
    /// that should do both speaks this instead. See `super::qwen`.
    #[serde(rename = "qwen-dashscope")]
    Qwen,
    /// The user's own ChatGPT subscription, through the Codex backend. No key,
    /// no address, no `/images` endpoint: it is the Responses API with the
    /// hosted `image_generation` tool, and the credentials are the OAuth
    /// tokens Settings → Providers → Codex already holds. See [`super::codex`].
    #[serde(rename = "codex-responses")]
    CodexResponses,
}

/// Qwen generates and edits on one endpoint, so both defaults point at it.
const QWEN_IMAGE_PATH: &str = "/api/v1/services/aigc/multimodal-generation/generation";

impl ImageApiFormat {
    /// Request paths this format uses when the provider row leaves them blank.
    #[must_use]
    pub const fn default_generation_path(self) -> &'static str {
        match self {
            Self::MiniMax => "/v1/image_generation",
            Self::Qwen => QWEN_IMAGE_PATH,
            // The URL is fixed in code and the row has no address to join to.
            Self::CodexResponses => "",
            _ => "/images/generations",
        }
    }

    #[must_use]
    pub const fn default_edit_path(self) -> &'static str {
        match self {
            Self::MiniMax => "/v1/image_generation",
            Self::Qwen => QWEN_IMAGE_PATH,
            Self::CodexResponses => "",
            _ => "/images/edits",
        }
    }

    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::OpenaiImages => "OpenAI images",
            Self::A6api => "a6api",
            Self::MiniMax => "MiniMax native",
            Self::Qwen => "Qwen (DashScope)",
            Self::CodexResponses => "ChatGPT (Codex)",
        }
    }

    /// Whether a row in this format carries its own credentials.
    ///
    /// Every other format is an address and a key. Codex is neither: it signs
    /// in once under Providers → Codex and every request reads that. A row
    /// that demanded a key would be permanently "not ready" with no field the
    /// user could fill in to fix it.
    #[must_use]
    pub const fn uses_api_key(self) -> bool {
        !matches!(self, Self::CodexResponses)
    }
}

/// The `response_format` to put on the request, when the row asks for one.
///
/// Mirrors `ImageRequestFormat` in `image-providers.ts`. **`None` on the
/// provider means send nothing and take whatever arrives** — the safe default,
/// and the only correct setting for OpenAI's own `gpt-image-*`, which answers
/// 400 to the field rather than ignoring it.
///
/// It replaces `responseShape`, which described what to EXPECT and was read by
/// nothing. apikl, probed live on 2026-09-04 with `gpt-image-2-pro`, returned
/// `b64_json` from `/images/generations` and a `url` from `/images/edits` on
/// one key and one model — so no single description of a provider's output is
/// true, and asking for one shape is what makes both endpoints agree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageRequestFormat {
    Url,
    B64Json,
}

impl ImageRequestFormat {
    /// The value to send as `response_format`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Url => "url",
            Self::B64Json => "b64_json",
        }
    }
}

/// One model under a provider. Mirrors `ImageModel` in
/// `image-providers.ts`, field for field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageModelConfig {
    pub id: String,
    pub provider_id: String,
    /// What the API is called, e.g. `gpt-image-1.5`.
    pub model_key: String,
    #[serde(default)]
    pub label: Option<String>,
    /// Whether this model can EDIT an existing image. Generation and editing
    /// are separate capabilities; a generator that cannot edit answers an
    /// edit with a 400, so the tool refuses before spending the call.
    #[serde(default)]
    pub can_edit: bool,
    #[serde(default)]
    pub sizes: Vec<String>,
    #[serde(default)]
    pub default_size: Option<String>,
    #[serde(default)]
    pub price_per_image: Option<f64>,
}

impl ImageModelConfig {
    /// The name a person uses for it.
    #[must_use]
    pub fn display_name(&self) -> &str {
        self.label
            .as_deref()
            .filter(|label| !label.trim().is_empty())
            .unwrap_or(&self.model_key)
    }
}

/// One provider row. Mirrors `ImageProvider` in `image-providers.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageProviderConfig {
    pub id: String,
    pub name: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key: Option<String>,
    pub api_format: ImageApiFormat,
    #[serde(default)]
    pub generation_path: Option<String>,
    /// Where an edit goes. `Some("")` — the field was filled in and then
    /// emptied — means this provider cannot edit at all; `None` means it was
    /// never touched and the format's default applies. The two are different
    /// answers and both have to survive the wire, which is why this is not
    /// flattened to a string.
    #[serde(default)]
    pub edit_path: Option<String>,
    /// `None` = send no `response_format`. See [`ImageRequestFormat`].
    #[serde(default)]
    pub request_format: Option<ImageRequestFormat>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub models: Vec<ImageModelConfig>,
}

fn default_true() -> bool {
    true
}

impl ImageProviderConfig {
    /// Switched on, addressed, and holding a key. A stored key is not a
    /// checked one: whether it works is answered by the first call.
    #[must_use]
    pub fn ready(&self) -> bool {
        self.not_ready_reason().is_none()
    }

    /// Why this row cannot be used, in words the user can act on.
    #[must_use]
    pub fn not_ready_reason(&self) -> Option<&'static str> {
        if !self.enabled {
            return Some("switched off");
        }
        if !self.api_format.uses_api_key() {
            // Its address and its credentials both live in code. Whether the
            // user is actually signed in is not knowable without a round trip,
            // so it is answered by the call, in the call's own words.
            return None;
        }
        if self.base_url.trim().is_empty() {
            return Some("no address");
        }
        if self.api_key().is_empty() {
            return Some("no API key");
        }
        None
    }

    /// `wanted` names this row: its id exactly, or its name ignoring case.
    #[must_use]
    pub fn is_named(&self, wanted: &str) -> bool {
        self.id == wanted || self.name.trim().eq_ignore_ascii_case(wanted)
    }

    #[must_use]
    pub fn api_key(&self) -> &str {
        self.api_key.as_deref().map(str::trim).unwrap_or("")
    }

    /// The generation endpoint this provider posts to.
    #[must_use]
    pub fn generation_url(&self) -> String {
        if self.api_format == ImageApiFormat::CodexResponses {
            return crate::api::codex::CODEX_RESPONSES_URL.to_string();
        }
        join_url(
            &self.base_url,
            self.generation_path
                .as_deref()
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .unwrap_or(self.api_format.default_generation_path()),
        )
    }

    /// The edit endpoint, or `None` when this provider cannot edit.
    #[must_use]
    pub fn edit_url(&self) -> Option<String> {
        if self.api_format == ImageApiFormat::CodexResponses {
            // Same endpoint; the tool's `action` is what makes it an edit.
            return Some(crate::api::codex::CODEX_RESPONSES_URL.to_string());
        }
        match self.edit_path.as_deref().map(str::trim) {
            Some("") => None,
            Some(path) => Some(join_url(&self.base_url, path)),
            None => Some(join_url(
                &self.base_url,
                self.api_format.default_edit_path(),
            )),
        }
    }

    /// `GET /models`, for discovery.
    #[must_use]
    pub fn models_url(&self) -> String {
        join_url(&self.base_url, if self.api_format == ImageApiFormat::MiniMax { "/v1/models" } else { "/models" })
    }

    /// Provider and model both willing.
    #[must_use]
    pub fn can_edit_with(&self, model: &ImageModelConfig) -> bool {
        self.edit_url().is_some() && model.can_edit
    }
}

/// Join a base and a path without doubling or dropping the separator.
#[must_use]
pub fn join_url(base: &str, path: &str) -> String {
    let left = base.trim().trim_end_matches('/');
    let right = path.trim().trim_start_matches('/');
    if right.is_empty() {
        left.to_string()
    } else {
        format!("{left}/{right}")
    }
}

/// A ready provider and one of its models, resolved for a call.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedImageModel {
    pub provider: ImageProviderConfig,
    pub model: ImageModelConfig,
}

/// Which provider and model a call should use.
///
/// `wanted_provider` names a row by id or name; `wanted_model` is a model key,
/// a label, or nothing. Matching is case-insensitive and exact; a substring
/// match was considered and rejected, because `gpt-image-1` is a substring of
/// `gpt-image-1.5` and a silent upgrade is not a match.
///
/// Only READY providers count. A row missing its key is not an option the
/// model can pick its way around, so it is not offered as one.
///
/// A model name alone that two ready providers both carry is refused, not
/// guessed. Gateways resell the same model ids, and taking the first row sent
/// a request the user meant for one gateway to another: a different bill, a
/// different refusal, and a test result that tested nothing.
pub fn resolve_model(
    providers: &[ImageProviderConfig],
    wanted_provider: Option<&str>,
    wanted_model: Option<&str>,
) -> Result<ResolvedImageModel, ResolveError> {
    let wanted_provider = wanted_provider.map(str::trim).filter(|w| !w.is_empty());
    let wanted_model = wanted_model.map(str::trim).filter(|w| !w.is_empty());
    if providers.is_empty() {
        return Err(ResolveError::NoProviders);
    }
    let ready: Vec<&ImageProviderConfig> = match wanted_provider {
        Some(name) => {
            let provider = providers.iter().find(|p| p.is_named(name)).ok_or_else(|| {
                ResolveError::UnknownProvider {
                    wanted: name.to_string(),
                    ready: ready_names(providers),
                }
            })?;
            if let Some(reason) = provider.not_ready_reason() {
                return Err(ResolveError::ProviderNotReady {
                    provider: provider.name.clone(),
                    reason,
                });
            }
            vec![provider]
        }
        None => providers.iter().filter(|p| p.ready()).collect(),
    };
    if ready.is_empty() {
        return Err(ResolveError::NoneReady);
    }
    let candidates: Vec<(&ImageProviderConfig, &ImageModelConfig)> = ready
        .iter()
        .flat_map(|provider| provider.models.iter().map(move |model| (*provider, model)))
        .collect();
    if candidates.is_empty() {
        return Err(ResolveError::NoModels {
            provider: wanted_provider.map(|_| ready[0].name.clone()),
        });
    }
    let Some(wanted) = wanted_model else {
        let (provider, model) = candidates[0];
        return Ok(ResolvedImageModel {
            provider: provider.clone(),
            model: model.clone(),
        });
    };
    let hits: Vec<&(&ImageProviderConfig, &ImageModelConfig)> = candidates
        .iter()
        .filter(|(_, model)| {
            model.model_key.eq_ignore_ascii_case(wanted)
                || model
                    .label
                    .as_deref()
                    .is_some_and(|label| label.trim().eq_ignore_ascii_case(wanted))
        })
        .collect();
    let Some((provider, model)) = hits.first() else {
        return Err(ResolveError::UnknownModel {
            wanted: wanted.to_string(),
            provider: wanted_provider.map(|_| ready[0].name.clone()),
            available: candidates
                .iter()
                .map(|(_, model)| model.model_key.clone())
                .collect(),
        });
    };
    let mut carriers: Vec<String> = Vec::new();
    for (p, _) in &hits {
        if !carriers.contains(&p.name) {
            carriers.push(p.name.clone());
        }
    }
    if carriers.len() > 1 {
        return Err(ResolveError::AmbiguousModel {
            wanted: wanted.to_string(),
            providers: carriers,
        });
    }
    Ok(ResolvedImageModel {
        provider: (*provider).clone(),
        model: (*model).clone(),
    })
}

fn ready_names(providers: &[ImageProviderConfig]) -> Vec<String> {
    providers
        .iter()
        .filter(|p| p.ready())
        .map(|p| p.name.clone())
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveError {
    NoProviders,
    NoneReady,
    /// `provider` is set when the caller named the row that has none.
    NoModels {
        provider: Option<String>,
    },
    UnknownModel {
        wanted: String,
        /// The row the caller named, when it named one.
        provider: Option<String>,
        available: Vec<String>,
    },
    UnknownProvider {
        wanted: String,
        ready: Vec<String>,
    },
    ProviderNotReady {
        provider: String,
        reason: &'static str,
    },
    /// Several ready providers carry this model name and none was named.
    AmbiguousModel {
        wanted: String,
        providers: Vec<String>,
    },
}

impl ResolveError {
    /// A mistake in the call the model can fix itself, as opposed to settings
    /// only the user can change.
    #[must_use]
    pub const fn is_caller_error(&self) -> bool {
        matches!(
            self,
            Self::UnknownModel { .. } | Self::UnknownProvider { .. } | Self::AmbiguousModel { .. }
        )
    }
}

impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoProviders => write!(
                f,
                "No image provider is configured. Tell the user to add one under Settings → \
Providers → Image providers (Aurora Chat), with its address, key and at least one model."
            ),
            Self::NoneReady => write!(
                f,
                "An image provider is configured but not ready — it is switched off, has no \
address, or has no API key. Tell the user which to check under Settings → Providers → Image \
providers."
            ),
            Self::NoModels { provider } => write!(
                f,
                "{} has no models. Tell the user to add one under Settings → Providers → Image \
providers, or to use its Discover models button.",
                provider.as_deref().unwrap_or("The image provider")
            ),
            Self::UnknownModel {
                wanted,
                provider: Some(provider),
                available,
            } => write!(
                f,
                "{provider} has no image model called '{wanted}'. Its models: {}. Use one of \
those, or omit `model` for its first.",
                available.join(", ")
            ),
            Self::UnknownModel {
                wanted,
                provider: None,
                available,
            } => write!(
                f,
                "No image model called '{wanted}'. Available: {}. Use one of those, or omit \
`model` for the default.",
                available.join(", ")
            ),
            Self::UnknownProvider { wanted, ready } => {
                if ready.is_empty() {
                    write!(f, "No image provider called '{wanted}', and none is ready.")
                } else {
                    write!(
                        f,
                        "No image provider called '{wanted}'. Ready providers: {}.",
                        ready.join(", ")
                    )
                }
            }
            Self::ProviderNotReady { provider, reason } => write!(
                f,
                "The image provider {provider} is not ready: {reason}. Tell the user to fix it \
under Settings → Providers → Image providers, or pick another provider."
            ),
            Self::AmbiguousModel { wanted, providers } => write!(
                f,
                "'{wanted}' is offered by more than one ready provider ({}). Nothing was sent. \
Pass `provider` to say which one; if the user did not say, ask them.",
                providers.join(", ")
            ),
        }
    }
}

/// Everything one conversation's `generate_image` needs that is not in the
/// call itself: the providers it may use, and the store whose `assets/` its
/// pictures land in.
#[derive(Clone)]
pub struct ImageTurnConfig {
    pub providers: Vec<ImageProviderConfig>,
    pub store: Arc<SessionStore>,
}

fn store() -> &'static Mutex<HashMap<String, ImageTurnConfig>> {
    static STORE: OnceLock<Mutex<HashMap<String, ImageTurnConfig>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Record what `thread_id`'s next turns may generate with. Called by the turn
/// driver before every chat turn, so a provider added mid-conversation is
/// usable from the next message.
pub fn set_turn_config(thread_id: &str, config: ImageTurnConfig) {
    if thread_id.is_empty() {
        return;
    }
    store()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(thread_id.to_string(), config);
}

/// What `thread_id` may generate with, if a chat turn has run for it.
#[must_use]
pub fn turn_config(thread_id: &str) -> Option<ImageTurnConfig> {
    store()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(thread_id)
        .cloned()
}

/// Drop one conversation's config. A deleted chat should not keep a key in
/// memory; tests use it to keep the process-wide map from leaking between them.
pub fn clear_turn_config(thread_id: &str) {
    store()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(thread_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(id: &str, models: &[(&str, bool)]) -> ImageProviderConfig {
        ImageProviderConfig {
            id: id.into(),
            name: id.into(),
            base_url: "https://api.example.com/v1/".into(),
            api_key: Some("sk-test".into()),
            api_format: ImageApiFormat::A6api,
            generation_path: None,
            edit_path: None,
            request_format: None,
            enabled: true,
            models: models
                .iter()
                .map(|(key, can_edit)| ImageModelConfig {
                    id: format!("{id}:{key}"),
                    provider_id: id.into(),
                    model_key: (*key).into(),
                    label: None,
                    can_edit: *can_edit,
                    sizes: vec![],
                    default_size: None,
                    price_per_image: None,
                })
                .collect(),
        }
    }

    /// The wire shape is the frontend's, byte for byte: camelCase keys, the
    /// hyphenated format id, and every optional field allowed to be absent.
    #[test]
    fn deserializes_the_frontend_shape() {
        let json = r#"{
            "id": "p1", "name": "a6api", "baseUrl": "https://api.a6api.com/v1",
            "apiKey": "sk-x", "apiFormat": "a6api", "responseShape": "url", "enabled": true,
            "models": [{"id": "p1:gpt-image-1.5", "providerId": "p1", "modelKey": "gpt-image-1.5",
                        "canEdit": true, "sizes": ["1024x1024"], "defaultSize": "1024x1024"}]
        }"#;
        let parsed: ImageProviderConfig = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.api_format, ImageApiFormat::A6api);
        assert_eq!(parsed.models[0].model_key, "gpt-image-1.5");
        assert!(parsed.models[0].can_edit);
        assert!(parsed.ready());
    }

    /// `editPath: ""` and a missing `editPath` are different answers.
    #[test]
    fn an_explicitly_empty_edit_path_means_cannot_edit() {
        let mut p = provider("p", &[("m", true)]);
        assert_eq!(
            p.edit_url().as_deref(),
            Some("https://api.example.com/v1/images/edits")
        );
        p.edit_path = Some(String::new());
        assert_eq!(p.edit_url(), None);
        assert!(!p.can_edit_with(&p.models[0]));
        p.edit_path = Some("/v2/edit".into());
        assert_eq!(p.edit_url().as_deref(), Some("https://api.example.com/v1/v2/edit"));
    }

    #[test]
    fn urls_join_without_doubling_the_separator() {
        assert_eq!(join_url("https://x.com/v1/", "/models"), "https://x.com/v1/models");
        assert_eq!(join_url("https://x.com/v1", "models"), "https://x.com/v1/models");
        assert_eq!(join_url("https://x.com/v1/", ""), "https://x.com/v1");
    }

    #[test]
    fn readiness_needs_switch_address_and_key() {
        let mut p = provider("p", &[]);
        assert!(p.ready());
        p.enabled = false;
        assert!(!p.ready());
        p.enabled = true;
        p.api_key = Some("  ".into());
        assert!(!p.ready());
        p.api_key = Some("k".into());
        p.base_url = String::new();
        assert!(!p.ready());
    }

    #[test]
    fn the_default_model_is_the_first_of_the_first_ready_provider() {
        let mut off = provider("off", &[("never", false)]);
        off.enabled = false;
        let on = provider("on", &[("first", false), ("second", true)]);
        let resolved = resolve_model(&[off, on], None, None).unwrap();
        assert_eq!(resolved.provider.id, "on");
        assert_eq!(resolved.model.model_key, "first");
    }

    #[test]
    fn a_named_model_matches_key_or_label_exactly_and_case_insensitively() {
        let mut p = provider("p", &[("gpt-image-1", false), ("gpt-image-1.5", true)]);
        p.models[1].label = Some("Fast".into());
        let list = [p];
        assert_eq!(
            resolve_model(&list, None, Some("GPT-IMAGE-1.5")).unwrap().model.model_key,
            "gpt-image-1.5"
        );
        assert_eq!(
            resolve_model(&list, None, Some("fast")).unwrap().model.model_key,
            "gpt-image-1.5"
        );
        // A prefix is not a match — `gpt-image-1` must not resolve to 1.5.
        assert_eq!(
            resolve_model(&list, None, Some("gpt-image-1")).unwrap().model.model_key,
            "gpt-image-1"
        );
    }

    /// The 2026-09-24 chat: `gpt-image-2.5-flare` was listed under both the
    /// ChatGPT row and APIKEY-FAN, the user asked for APIKEY-FAN, and the call
    /// went to ChatGPT because it came first.
    #[test]
    fn a_model_two_ready_providers_share_is_refused_until_a_provider_is_named() {
        let chatgpt = provider("ChatGPT", &[("gpt-image-2.5-flare", true)]);
        let fan = provider("APIKEY-FAN", &[("gpt-image-2.5-flare", true), ("gpt-image-2.5", false)]);
        let list = [chatgpt, fan];

        let err = resolve_model(&list, None, Some("gpt-image-2.5-flare")).unwrap_err();
        assert!(err.is_caller_error());
        let text = err.to_string();
        assert!(text.contains("ChatGPT, APIKEY-FAN") && text.contains("Nothing was sent"), "{text}");

        let picked = resolve_model(&list, Some("apikey-fan"), Some("gpt-image-2.5-flare")).unwrap();
        assert_eq!(picked.provider.name, "APIKEY-FAN", "names match ignoring case");
        // A name only one provider carries still needs no provider.
        assert_eq!(
            resolve_model(&list, None, Some("gpt-image-2.5")).unwrap().provider.name,
            "APIKEY-FAN"
        );
        // A provider alone means its first model.
        assert_eq!(
            resolve_model(&list, Some("APIKEY-FAN"), None).unwrap().model.model_key,
            "gpt-image-2.5-flare"
        );
    }

    #[test]
    fn a_named_provider_is_checked_before_anything_is_sent() {
        let mut off = provider("CODER-PLAN", &[("gpt-image-2.5-flare-2k", true)]);
        off.enabled = false;
        let on = provider("APIKEY-FAN", &[("gpt-image-2.5", false)]);
        let list = [off, on];

        // Switched off: said so, with the reason, not "unknown".
        let text = resolve_model(&list, Some("CODER-PLAN"), None).unwrap_err().to_string();
        assert!(text.contains("CODER-PLAN is not ready: switched off"), "{text}");
        // Unknown: the ready ones are named.
        let text = resolve_model(&list, Some("A6"), None).unwrap_err().to_string();
        assert!(text.contains("'A6'") && text.contains("Ready providers: APIKEY-FAN"), "{text}");
        // A model the named provider does not carry is not borrowed from another.
        let text = resolve_model(&list, Some("APIKEY-FAN"), Some("gpt-image-2.5-flare-2k"))
            .unwrap_err()
            .to_string();
        assert!(text.starts_with("APIKEY-FAN has no image model called"), "{text}");
        assert!(text.contains("Its models: gpt-image-2.5"), "{text}");
        // The row id works as well as the name.
        assert_eq!(
            resolve_model(&list, Some("APIKEY-FAN"), None).unwrap().provider.id,
            "APIKEY-FAN"
        );
    }

    /// Each failure names what to do, and an unknown model lists the real ones.
    #[test]
    fn resolve_errors_are_actionable() {
        assert_eq!(resolve_model(&[], None, None), Err(ResolveError::NoProviders));
        let mut off = provider("p", &[("m", false)]);
        off.api_key = None;
        assert_eq!(off.not_ready_reason(), Some("no API key"));
        assert_eq!(resolve_model(&[off], None, None), Err(ResolveError::NoneReady));
        assert_eq!(
            resolve_model(&[provider("p", &[])], None, None),
            Err(ResolveError::NoModels { provider: None })
        );
        let err = resolve_model(&[provider("p", &[("a", false), ("b", false)])], None, Some("zzz"))
            .unwrap_err();
        let text = err.to_string();
        assert!(text.contains("zzz") && text.contains("a, b"), "{text}");
        assert!(ResolveError::NoProviders.to_string().contains("Image providers"));
    }

    #[test]
    fn turn_config_is_per_conversation_and_clearable() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(SessionStore::new_folder(dir.path().join("Chats")));
        set_turn_config(
            "cfg-t1",
            ImageTurnConfig {
                providers: vec![provider("p", &[])],
                store: store.clone(),
            },
        );
        assert_eq!(turn_config("cfg-t1").unwrap().providers.len(), 1);
        assert!(turn_config("cfg-other").is_none());
        clear_turn_config("cfg-t1");
        assert!(turn_config("cfg-t1").is_none());
    }
}
