use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use time::OffsetDateTime;

#[allow(dead_code)]
fn deserialize_ignored<'de, T, D>(deserializer: D) -> Result<Option<T>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    // Accept and discard a value. Used to swallow legacy fields the
    // frontend may still send during the v15 cutover (custom_models,
    // model_aliases, supports_vision, supports_thinking) without
    // forcing a frontend-then-backend deploy order.
    let _ = serde::de::IgnoredAny::deserialize(deserializer)?;
    Ok(None)
}

// ============================================================
// WORKSPACE STATE
// ============================================================

/// Workspace state representing open tabs and panel layout
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceState {
    pub workspace_path: Option<String>,
    pub open_tabs: Vec<TabState>,
    pub panel_sizes: Option<PanelSizes>,
    pub last_opened_at: String, // ISO timestamp string from frontend
    #[serde(default = "default_checkpoint_enabled")]
    pub checkpoint_enabled: bool, // Whether checkpoints are enabled for this workspace (default: true)
}

fn default_checkpoint_enabled() -> bool {
    true
}

impl WorkspaceState {
    /// Convert the ISO timestamp string to OffsetDateTime
    #[allow(dead_code)]
    pub fn get_last_opened_at(&self) -> OffsetDateTime {
        OffsetDateTime::parse(
            &self.last_opened_at,
            &time::format_description::well_known::Rfc3339,
        )
        .unwrap_or_else(|_| OffsetDateTime::now_utc())
    }
}

/// Individual tab state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabState {
    pub path: String,
    pub is_active: bool,
    pub is_dirty: bool,
}

/// Panel size configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PanelSizes {
    pub explorer: f64, // Percentage (0-100)
    pub editor: f64,   // Percentage (0-100)
    pub chat: f64,     // Percentage (0-100)
}

// ============================================================
// EDITOR STATE
// ============================================================

/// Editor state for a specific file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditorState {
    pub file_path: String,
    pub cursor_line: Option<u32>,
    pub cursor_col: Option<u32>,
    pub scroll_offset: Option<f64>,
    pub folded_regions: Option<Vec<FoldedRegion>>,
    pub last_edited_at: String, // ISO timestamp string from frontend
}

impl EditorState {
    /// Convert the ISO timestamp string to OffsetDateTime
    #[allow(dead_code)]
    pub fn get_last_edited_at(&self) -> OffsetDateTime {
        OffsetDateTime::parse(
            &self.last_edited_at,
            &time::format_description::well_known::Rfc3339,
        )
        .unwrap_or_else(|_| OffsetDateTime::now_utc())
    }
}

/// A folded/collapsed code region
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FoldedRegion {
    pub start_line: u32,
    pub end_line: u32,
}

// ============================================================
// EXPLORER STATE
// ============================================================

/// File explorer state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExplorerState {
    pub workspace_path: String,
    pub expanded_folders: Vec<String>,
    pub selected_file: Option<String>,
}

// ============================================================
// THREAD STATE
// ============================================================

/// Token usage tracking for a thread
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    /// `Some(true)` when these counts are a local tiktoken estimate (the
    /// provider returned no usage), so the UI can flag them with a `~`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated: Option<bool>,
}

/// Context usage tracking for a thread
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsage {
    pub used_tokens: i64,
    pub context_window: i64,
    pub percentage: f64,
}

/// Thread/conversation state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadState {
    pub id: String,
    pub title: String,
    pub summary: Option<String>,
    pub messages: Vec<Message>,
    pub token_usage: Option<TokenUsage>,
    pub context_usage: Option<ContextUsage>,
    pub created_at: String, // ISO string or timestamp string
    pub updated_at: String, // ISO string or timestamp string
}

/// Chat message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    #[serde(alias = "sender")]
    pub role: String, // "user", "assistant", "system", "tool"
    pub content: String,
    pub timestamp: String, // ISO string or timestamp string
    pub tool_calls: Option<Vec<ToolCall>>,
    pub thinking: Option<String>,
    #[serde(default, alias = "isThinking")]
    pub is_thinking: Option<bool>,
    #[serde(default)]
    pub tools: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    pub timeline: Option<serde_json::Value>,
    #[serde(rename = "toolProposal", default)]
    pub tool_proposal: Option<serde_json::Value>,
    /// Browser-inspector element chips attached to a user message, loaded
    /// back from the session JSONL so they re-render above the bubble on
    /// thread reopen. `None` for assistant/tool messages.
    #[serde(
        rename = "attachedSelectedElements",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub attached_selected_elements:
        Option<Vec<crate::agent_runtime::types::AttachedSelectedElement>>,
    #[serde(
        rename = "attachedPromptChips",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub attached_prompt_chips: Option<Vec<crate::agent_runtime::types::AttachedPromptChip>>,
}

/// Tool call in a message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
    pub result: Option<String>,
}

// ============================================================
// APP SETTINGS
// ============================================================

/// Application setting (key-value)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSetting {
    pub key: String,
    pub value: String, // JSON string value
    pub updated_at: String,
}

// ============================================================
// LLM PROVIDER
// ============================================================

/// LLM Provider configuration.
///
/// As of schema v15 a provider holds **transport, auth, and defaults**
/// only. Per-model capabilities (vision, thinking, tool-stream) and
/// per-model context/output overrides live on [`ProviderModel`] rows
/// keyed by `provider_id`. The legacy fields on this struct
/// (`supports_thinking`, `supports_vision`, `custom_models`,
/// `model_aliases`) are accepted on input but ignored — kept here so
/// the IPC layer doesn't reject older frontend payloads during a hot
/// reload, but never round-tripped to the database.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LLMProvider {
    pub id: String,
    pub name: String,
    pub nickname: Option<String>,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub context_window: i64,
    pub max_output_tokens: i64,
    pub supports_tool_stream: bool,
    pub enabled: bool,
    pub is_custom: bool,
    pub custom_headers: Option<serde_json::Value>,
    pub custom_params: Option<serde_json::Value>,
    /// API-key POOL as a JSON array of strings. When it holds more than
    /// one key the runtime rotates them round-robin per turn and fails
    /// over to the next on an auth / rate-limit / server error. `None` /
    /// `[]` → the single `api_key` is used. Generic across providers
    /// (AgentRouter is the first consumer).
    #[serde(default)]
    pub api_keys: Option<serde_json::Value>,
    pub provider_type: Option<String>,
    pub default_temperature: Option<f64>,
    pub default_max_tokens: Option<i64>,
    pub requires_api_key: bool,
    pub sort_order: i32,
    pub created_at: String,
    pub updated_at: String,
    // ── Legacy v14 fields ──────────────────────────────────────────
    // Accepted on input so an out-of-date frontend payload doesn't
    // make `save_provider` fail; never written or returned. The data
    // these once held now lives in `provider_models`.
    #[serde(
        default,
        skip_serializing,
        deserialize_with = "deserialize_ignored",
        rename = "supportsThinking"
    )]
    #[allow(dead_code)]
    pub _legacy_supports_thinking: Option<bool>,
    #[serde(
        default,
        skip_serializing,
        deserialize_with = "deserialize_ignored",
        rename = "supportsVision"
    )]
    #[allow(dead_code)]
    pub _legacy_supports_vision: Option<bool>,
    #[serde(
        default,
        skip_serializing,
        deserialize_with = "deserialize_ignored",
        rename = "customModels"
    )]
    #[allow(dead_code)]
    pub _legacy_custom_models: Option<Vec<String>>,
    #[serde(
        default,
        skip_serializing,
        deserialize_with = "deserialize_ignored",
        rename = "modelAliases"
    )]
    #[allow(dead_code)]
    pub _legacy_model_aliases: Option<HashMap<String, String>>,
}

// ============================================================
// PROVIDER MODEL (per-model capability profile)
// ============================================================

/// One model exposed by a provider.
///
/// `context_window` and `max_output_tokens` are nullable: `None` means
/// "inherit the provider's default". Capability flags are always
/// per-model — that's the whole point of splitting them out of
/// [`LLMProvider`] in v15.
///
/// `price_*_per_mtok` columns (v16+) are USD per one million tokens,
/// `None` means "unset — don't display cost in the UI for this model."
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    /// `{providerId}::{modelKey}` — primary key on the table.
    pub id: String,
    pub provider_id: String,
    pub model_key: String,
    pub label: Option<String>,
    pub context_window: Option<i64>,
    pub max_output_tokens: Option<i64>,
    #[serde(default)]
    pub supports_vision: bool,
    #[serde(default)]
    pub supports_thinking: bool,
    #[serde(default)]
    pub supports_tool_stream: bool,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub sort_order: i32,
    /// Pricing (USD per 1M tokens). All four fields are optional; the
    /// UI only displays cost when at least `price_cache_miss_per_mtok`
    /// and `price_output_per_mtok` are populated.
    #[serde(default)]
    pub price_cache_hit_per_mtok: Option<f64>,
    #[serde(default)]
    pub price_cache_miss_per_mtok: Option<f64>,
    #[serde(default)]
    pub price_output_per_mtok: Option<f64>,
    /// USD per 1M cache-CREATION tokens.
    ///
    /// `None` means "bill cache writes at `price_cache_miss_per_mtok`", which
    /// is what OpenAI-compatible gateways charge. Set it explicitly for
    /// providers that price cache creation differently — Anthropic's native
    /// API charges 1.25x the base input rate, so leaving this unset there
    /// under-reports cached turns by about a quarter of their write cost.
    ///
    /// It is never zero by omission: cache-creation tokens were previously
    /// dropped from the cost entirely because no column existed for them.
    #[serde(default)]
    pub price_cache_write_per_mtok: Option<f64>,
    /// Currency code. `None` is treated as `"USD"`. Reserved for
    /// future EUR/GBP support — today the UI always renders `$`.
    #[serde(default)]
    pub price_currency: Option<String>,
    /// Reasoning capability + chosen default, mirrored from models.dev:
    /// `{type:"effort"|"toggle"|"budget", levels?:[..], min?, max?, default?}`.
    /// `None` means the model has no reasoning controls.
    #[serde(default)]
    pub reasoning: Option<serde_json::Value>,
    /// Extra request-body fields the user added manually for this model, merged
    /// verbatim into the outgoing request (e.g. `{"thinking":{"type":"enabled"}}`).
    /// `None` means no extra fields.
    #[serde(default)]
    pub extra_body: Option<serde_json::Value>,
    /// Sampling temperature for this model. `None` inherits the provider's
    /// `default_temperature`, then Aurora's own default.
    ///
    /// Set here rather than globally because it is a property of the model: the
    /// same key addresses one model that wants 0.2 and another that rejects the
    /// parameter outright. Models that reject sampling (Claude 5 and newer —
    /// see `anthropic_surface`) have it stripped from the request whatever this
    /// says, so a value left here is inert rather than a 400.
    #[serde(default)]
    pub temperature: Option<f64>,
    /// Wire format for THIS model. `None` inherits the provider's own type,
    /// which is what every provider whose format is a row-wide property does.
    ///
    /// Set per model because on some surfaces the format belongs to the model,
    /// not the account. OpenCode Go answers all three of `/chat/completions`,
    /// `/messages` and `/responses` on one base URL and one key, and each model
    /// accepts only its own: GLM-5.2 returns 500 on anything but chat
    /// completions, GPT 5.6 Luna returns 500 on anything but responses, and the
    /// Qwen and MiniMax ids want messages. A row-wide setting is wrong for all
    /// but one of them at a time.
    #[serde(default)]
    pub provider_type: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

fn default_true() -> bool {
    true
}

// ============================================================
// TOOL SETTINGS
// ============================================================

/// Per-tool approval setting
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSetting {
    pub tool_name: String,
    pub approval_mode: String, // 'auto' | 'always_ask' | 'deny'
    pub updated_at: String,
}

// ============================================================
// SETTINGS STATE (Complete app settings)
// ============================================================

/// One named global-instruction set (Settings → Agent). The user keeps up to
/// three and activates at most one; the active one's text is what reaches the
/// system prompt.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalInstructionProfile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub text: String,
}

/// Complete application settings state
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    // General settings
    pub selected_model: String,
    pub agent_execution_mode: String,
    // Agent Team (see DOCS/aurora-agent-team-ground-truth.md §11)
    pub team_enabled: bool,
    pub max_team_size: i32,
    /// Provider/model the Lead runs on, as a `"providerId:modelKey"`
    /// selection drawn from the user's configured providers. Empty string
    /// means "use my active chat model" (the team rides the chat provider).
    #[serde(default)]
    pub team_lead_model: String,
    /// Provider/model the IC team members run on, same `"providerId:modelKey"`
    /// shape. Empty string falls back to the active chat model. Lets the user
    /// pin the Lead to one provider and the team to another.
    #[serde(default)]
    pub team_member_model: String,
    /// Legacy single global-instruction text. Kept as a mirror of the ACTIVE
    /// profile in `global_instruction_profiles` so builds that predate the
    /// profile list still read the right rules. Empty string means none.
    #[serde(default)]
    pub global_instructions: String,
    /// Named global-instruction sets (Settings → Agent), up to three. The
    /// frontend owns the cap and the editing UI; this is storage only.
    #[serde(default)]
    pub global_instruction_profiles: Vec<GlobalInstructionProfile>,
    /// Id of the profile injected into the system prompt. Empty = none active.
    #[serde(default)]
    pub active_global_instruction_profile_id: String,
    /// Context-compaction trigger as a % of the context window (50–95).
    #[serde(default)]
    pub compaction_threshold_pct: f64,
    /// `max_output_tokens` budget for the compaction summary call (2k–16k).
    #[serde(default)]
    pub compaction_summary_budget: i32,
    /// Provider/model the compaction summary runs on (`"providerId:modelKey"`).
    /// Empty string summarizes on the conversation's own model.
    #[serde(default)]
    pub compaction_model: String,
    /// AI title maker — when enabled, the first message of a NEW chat is sent to
    /// an OpenAI-compatible endpoint to generate a short title (fallback to the
    /// derived title on any error). All `serde(default)` so legacy rows load.
    #[serde(default)]
    pub title_maker_enabled: bool,
    /// Title source: `"off"` (derived from the first message), `"local"`
    /// (the prompt-refine llama.cpp model), or `"cloud"` (the endpoint
    /// below). Empty string = legacy row; the frontend derives the mode
    /// from `title_maker_enabled`.
    #[serde(default)]
    pub title_maker_mode: String,
    #[serde(default)]
    pub title_maker_base_url: String,
    #[serde(default)]
    pub title_maker_api_key: String,
    #[serde(default)]
    pub title_maker_model: String,
    /// When true, read-only file tools may read files outside the workspace.
    #[serde(default)]
    pub allow_outside_workspace: bool,
    /// When true, the agent is told to split long turns into named chapters and
    /// is given the `chapter` tool to mark them. Affects the system prompt and
    /// the tool roster, so it must survive a restart.
    #[serde(default)]
    pub transcript_chapters: bool,
    /// Header flash + rail dot when a chat's turn finishes. Default on.
    #[serde(default = "default_true")]
    pub notify_on_turn_complete: bool,
    /// Replace the header title with a live activity line while streaming.
    #[serde(default = "default_true")]
    pub show_activity_in_title: bool,
    /// Whether the browser toolset is advertised to the model. Default on.
    #[serde(default = "default_true")]
    pub browser_tools: bool,
    /// Hold optional tool buckets out of the roster behind `tool_search`.
    /// Default off — it changes how the model reaches a tool.
    #[serde(default)]
    pub defer_tools: bool,
    pub auto_approve_tools: bool,
    pub auto_accept_changes: bool,
    pub explorer_icon_pack: String,
    pub font_size: i32,
    pub wrap_mode: bool,
    pub theme: String,
    pub thinking_enabled: bool,
    pub syntax_validation_enabled: bool,
    pub project_layout_enabled: bool,
    pub ui_font_family: String,
    pub ui_scale: f64,
    pub ui_text_scale: f64,
    pub max_tokens: i32,
    pub temperature: f64,

    // Autosave settings
    pub auto_save: String,
    pub auto_save_delay: i32,

    // Tool settings
    pub max_tool_calls_per_request: i32,
    pub skills_enabled: bool,
    /// Per-workspace skill enablement: `scopeKey -> (skillStorageKey -> bool)`.
    /// `scopeKey` is the normalized workspace root path (or `__global__` when
    /// no project is open). Stored nested so each project's selection is
    /// independent. Legacy flat `{ storageKey: bool }` values fail to
    /// deserialize and fall back to the empty default, which intentionally
    /// prunes the old global toggles on first load.
    #[serde(default)]
    pub skill_toggles: HashMap<String, HashMap<String, bool>>,
    pub fireworks_tab_enabled: bool,
    pub fireworks_account_id: String,
    /// Provider ids the user has REMOVED from the Providers page. Built-in
    /// presets (Fireworks, GLM, MiniMax, LM Studio, Ollama, Atlas Cloud, …)
    /// are otherwise re-injected on every launch, so a plain delete wouldn't
    /// stick; instead the frontend records the id here and filters it out of
    /// the seeded list. Reversible — clearing an id "restores" that provider.
    #[serde(default)]
    pub removed_provider_ids: Vec<String>,

    // Speech input settings
    pub speech_enabled: bool,
    pub speech_engine: String,
    pub speech_runtime_path: String,
    pub speech_model_path: String,
    pub speech_backend: String,
    pub speech_device_preference: String,
    pub speech_threads: i32,
    pub speech_language: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            selected_model: "fireworks:accounts/fireworks/routers/kimi-k2p6-turbo".to_string(),
            agent_execution_mode: "agent".to_string(),
            team_enabled: false,
            max_team_size: 5,
            team_lead_model: String::new(),
            team_member_model: String::new(),
            global_instructions: String::new(),
            global_instruction_profiles: Vec::new(),
            active_global_instruction_profile_id: String::new(),
            compaction_threshold_pct: 80.0,
            compaction_summary_budget: 8192,
            compaction_model: String::new(),
            title_maker_enabled: false,
            title_maker_mode: String::new(),
            title_maker_base_url: String::new(),
            title_maker_api_key: String::new(),
            title_maker_model: String::new(),
            allow_outside_workspace: false,
            transcript_chapters: false,
            notify_on_turn_complete: true,
            show_activity_in_title: true,
            browser_tools: true,
            defer_tools: false,
            auto_approve_tools: false,
            auto_accept_changes: false,
            explorer_icon_pack: "material".to_string(),
            font_size: 14,
            wrap_mode: true,
            theme: "dark".to_string(),
            thinking_enabled: true,
            syntax_validation_enabled: true,
            project_layout_enabled: true,
            ui_font_family: "system".to_string(),
            ui_scale: 1.0,
            ui_text_scale: 1.0,
            max_tokens: 8192,
            temperature: 1.0,
            auto_save: "off".to_string(),
            auto_save_delay: 1000,
            max_tool_calls_per_request: 25,
            skills_enabled: true,
            skill_toggles: HashMap::new(),
            fireworks_tab_enabled: false,
            fireworks_account_id: String::new(),
            removed_provider_ids: Vec::new(),
            speech_enabled: false,
            speech_engine: "qwen3-rust".to_string(),
            speech_runtime_path: String::new(),
            speech_model_path: String::new(),
            speech_backend: "auto".to_string(),
            speech_device_preference: "auto".to_string(),
            speech_threads: 4,
            speech_language: "auto".to_string(),
        }
    }
}

// ============================================================
// CUSTOM THEMES
// ============================================================

/// Custom theme definition
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomTheme {
    pub id: String,
    pub name: String,
    pub author: String,
    pub version: String,
    #[serde(rename = "type")]
    pub theme_type: String, // "light" or "dark" (mapped from 'type' in JSON)
    pub colors: String,       // JSON string of colors object
    pub token_colors: String, // JSON string of tokenColors array
    pub created_at: String,
    pub updated_at: String,
}
