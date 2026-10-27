//! A turn the engine builds from `{thread, message, mode}` alone.
//!
//! The desktop window still builds most of its request and lets the engine
//! compare (`engine_prompt.shadow`). A host with no window has nothing to
//! compare with: it names the conversation and the message, and the engine
//! fills in everything else from disk. The conversation's own sidecar gives
//! its project, model, mode and deep-research flag; Settings gives the rest
//! (compaction, file access, chapters, sub-agents, image providers); the
//! prompt, the tool list and the provider snapshot are the ported composers
//! (`turn_build`), switched on with no shadow.
//!
//! What only a window knows, and what a turn here does without:
//! - Transcript → Reply layout and Cursor's per-row Fast switch live in
//!   browser storage: off.
//! - Open files, inspector picks, `/` rules, skills and MCP names: none
//!   attached, so no per-message context.
//! - The window's clean-up of old model pins (`normalizeThreadModelSelection`:
//!   a Modal endpoint that moved, a Cursor or Antigravity tier stored in the
//!   pin) and Aurora Chat's shortlist: not ported yet. A pin that no longer
//!   names a row falls back the way the resolver does (the active model, then
//!   the first provider with a key).
//! - The deep-research seed for a new Aurora Chat conversation: a new
//!   conversation here starts without it.

use std::sync::Arc;

use super::{resolve_engine_model, AgentRegistry, EventEmitter, TurnDriver};
use crate::agent_runtime::error::RuntimeError;
use crate::agent_runtime::events::TurnCompletion;
use crate::agent_runtime::ipc::{AgentChatRequest, AgentExecutionMode, EnginePromptRequest};
use crate::agent_runtime::session_store::SessionMetadata;
use crate::agent_runtime::turn_build::provider::{apply, EngineModelFacts, ResolvedTurnModel};
use crate::db::AppSettings;

/// What a host with no window says about a turn.
#[derive(Debug, Clone, Default)]
pub struct EngineTurn {
    pub thread_id: String,
    pub message: String,
    /// Agent, Plan or Chat. `None`: the conversation's own mode; for a new
    /// conversation, the mode Settings opens Build in.
    pub mode: Option<AgentExecutionMode>,
    /// The project, for a new project conversation. An existing one keeps
    /// its own; Aurora Chat has none.
    pub workspace: Option<String>,
    /// Which surface the message came from (`"web"` for a browser), told to
    /// the model in the message's `<message_source>`.
    pub client: Option<String>,
}

/// An existing conversation, as the engine found it on disk.
#[derive(Debug, Clone)]
pub(super) struct ExistingThread {
    /// It lives in Aurora Chat's store, not a project's.
    pub in_chat_store: bool,
    pub meta: SessionMetadata,
}

/// What the turn runs as, decided before the model is resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct TurnPlan {
    pub mode: AgentExecutionMode,
    pub workspace: Option<String>,
    /// `"providerId:modelKey"`: the conversation's pin, else Settings' model.
    pub selection: String,
    pub deep_research: bool,
}

pub(super) fn plan_turn(
    turn: &EngineTurn,
    existing: Option<&ExistingThread>,
    settings: &AppSettings,
) -> Result<TurnPlan, String> {
    let saved_mode = existing.and_then(|thread| {
        if thread.in_chat_store {
            Some(AgentExecutionMode::Chat)
        } else {
            thread.meta.execution_mode
        }
    });
    let mode = turn
        .mode
        .or(saved_mode)
        .unwrap_or(match settings.agent_execution_mode.as_str() {
            "plan" => AgentExecutionMode::Plan,
            _ => AgentExecutionMode::Agent,
        });

    if let Some(thread) = existing {
        if thread.in_chat_store != mode.is_chat() {
            return Err(format!(
                "conversation {} belongs to the other Aurora surface",
                turn.thread_id
            ));
        }
    }

    let workspace = if mode.is_chat() {
        None
    } else {
        existing
            .and_then(|thread| thread.meta.workspace_root.clone())
            .or_else(|| turn.workspace.clone())
            .filter(|root| !root.trim().is_empty())
    };
    if !mode.is_chat() && workspace.is_none() {
        return Err("a project conversation needs a project folder".to_string());
    }

    let selection = existing
        .and_then(|thread| thread.meta.model.clone())
        .filter(|model| !model.trim().is_empty())
        .unwrap_or_else(|| settings.selected_model.clone());

    Ok(TurnPlan {
        mode,
        workspace,
        selection,
        deep_research: mode.is_chat() && existing.is_some_and(|thread| thread.meta.deep_research),
    })
}

/// The full request, from the plan, Settings and the resolved model. Every
/// engine part is on and none is a shadow.
pub(super) fn build_request(
    turn: &EngineTurn,
    plan: &TurnPlan,
    settings: &AppSettings,
    model: ResolvedTurnModel,
    browser_available: bool,
) -> AgentChatRequest {
    let image_providers = if plan.mode.is_chat() {
        image_providers(settings)
    } else {
        Vec::new()
    };
    let mut request = AgentChatRequest {
        turn_id: uuid::Uuid::new_v4().to_string(),
        thread_id: turn.thread_id.clone(),
        user_message: turn.message.clone(),
        user_message_origin: Default::default(),
        user_message_summary: None,
        user_message_agent: None,
        provider_id: String::new(),
        model: String::new(),
        model_selection: Some(plan.selection.clone()),
        workspace_path: plan.workspace.clone(),
        execution_mode: plan.mode,
        cli_task_id: None,
        provider_config: model.provider_config.clone(),
        system_prompt: None,
        ide_context: None,
        client: turn.client.clone(),
        tools: Vec::new(),
        temperature: None,
        max_output_tokens: None,
        thinking_enabled: None,
        thinking_budget_tokens: None,
        context_window: None,
        compaction_threshold_pct: Some(settings.compaction_threshold_pct as f32),
        compaction_summary_budget: u32::try_from(settings.compaction_summary_budget)
            .ok()
            .filter(|budget| *budget > 0),
        compaction_provider_config: None,
        workspace_access: Some(settings.workspace_access.clone())
            .filter(|access| !access.is_empty()),
        allow_outside_workspace: Some(settings.allow_outside_workspace),
        transcript_chapters: Some(settings.transcript_chapters),
        // The prompt describes the browser whenever this is on, so it must be
        // off where the host registered no browser tools.
        browser_tools: Some(settings.browser_tools && browser_available),
        defer_tools: Some(settings.defer_tools),
        engine_prompt: Some(EnginePromptRequest {
            reply_layout: false,
            deep_research: plan.deep_research,
            explicit_skill_keys: Vec::new(),
            attached_rule_files: Vec::new(),
            context: None,
            // Resolved here already, so a turn nothing resolves for fails
            // before it starts instead of running on an empty snapshot.
            model: None,
            mcp: true,
            tools: true,
            shadow: false,
        }),
        attached_selected_elements: None,
        attached_prompt_chips: None,
        image_providers,
        subagents_enabled: Some(settings.subagents_enabled),
        subagent_model: settings.subagent_model.clone(),
    };
    apply(&mut request, model);
    request
}

/// Settings' image providers, which Rust otherwise holds opaquely.
fn image_providers(
    settings: &AppSettings,
) -> Vec<crate::tools::image::config::ImageProviderConfig> {
    if settings.image_providers.is_null() {
        return Vec::new();
    }
    serde_json::from_value(settings.image_providers.clone()).unwrap_or_else(|error| {
        crate::logging::log_warn(
            "agent_v2",
            &format!("could not read the image providers for a turn: {error}"),
        );
        Vec::new()
    })
}

impl<E: EventEmitter> TurnDriver<E> {
    /// Run a turn the engine builds itself: the host names the conversation
    /// and the message, nothing else. See the module docs for what is read
    /// from disk and what a window-less turn goes without.
    pub async fn run_engine_turn(&self, turn: EngineTurn) -> Result<TurnCompletion, RuntimeError> {
        let registry = self.registry.clone();
        let lookup = turn.clone();
        let (settings, plan) = tokio::task::spawn_blocking(move || {
            let settings = registry.app_settings();
            let existing = find_thread(&registry, &lookup.thread_id)?;
            let plan = plan_turn(&lookup, existing.as_ref(), &settings)
                .map_err(RuntimeError::InvalidState)?;
            Ok::<_, RuntimeError>((settings, plan))
        })
        .await
        .map_err(|error| RuntimeError::InvalidState(format!("the turn setup stopped: {error}")))??;

        let model = resolve_engine_model(&self.registry, plan.selection.clone(), EngineModelFacts::default())
            .await
            .map_err(RuntimeError::InvalidState)?
            .ok_or_else(|| {
                RuntimeError::InvalidState(format!(
                    "no model to run on: {} names no provider, and no provider has an API key",
                    plan.selection
                ))
            })?;

        let browser_available = self.registry.tools().get("browser_navigate").is_some();
        let request = build_request(&turn, &plan, &settings, model, browser_available);
        self.run_turn(request).await
    }
}

fn find_thread(
    registry: &Arc<AgentRegistry>,
    thread_id: &str,
) -> Result<Option<ExistingThread>, RuntimeError> {
    let Some(store) = registry.store_for_thread(thread_id)? else {
        return Ok(None);
    };
    Ok(Some(ExistingThread {
        in_chat_store: Arc::ptr_eq(&store, registry.chat_store()),
        meta: store.load_metadata(thread_id)?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> AppSettings {
        AppSettings {
            selected_model: "oa:gpt-5".into(),
            ..AppSettings::default()
        }
    }

    fn turn(mode: Option<AgentExecutionMode>, workspace: Option<&str>) -> EngineTurn {
        EngineTurn {
            thread_id: "t-1".into(),
            message: "hello".into(),
            mode,
            workspace: workspace.map(str::to_string),
            client: Some("web".into()),
        }
    }

    fn existing(in_chat_store: bool, edit: impl FnOnce(&mut SessionMetadata)) -> ExistingThread {
        let mut meta = SessionMetadata::new("t-1");
        edit(&mut meta);
        ExistingThread { in_chat_store, meta }
    }

    #[test]
    fn a_new_project_chat_runs_on_the_settings_model_in_its_project() {
        let plan = plan_turn(&turn(None, Some("E:/work")), None, &settings()).unwrap();
        assert_eq!(
            plan,
            TurnPlan {
                mode: AgentExecutionMode::Agent,
                workspace: Some("E:/work".into()),
                selection: "oa:gpt-5".into(),
                deep_research: false,
            }
        );
    }

    #[test]
    fn a_new_build_chat_opens_in_the_mode_settings_names() {
        let mut settings = settings();
        settings.agent_execution_mode = "plan".into();
        let plan = plan_turn(&turn(None, Some("E:/work")), None, &settings).unwrap();
        assert_eq!(plan.mode, AgentExecutionMode::Plan);
    }

    #[test]
    fn an_existing_conversation_keeps_its_project_model_and_mode() {
        let thread = existing(false, |meta| {
            meta.workspace_root = Some("E:/theirs".into());
            meta.model = Some("an:claude".into());
            meta.execution_mode = Some(AgentExecutionMode::Plan);
        });
        let plan = plan_turn(&turn(None, Some("E:/other")), Some(&thread), &settings()).unwrap();
        assert_eq!(plan.mode, AgentExecutionMode::Plan);
        assert_eq!(plan.workspace.as_deref(), Some("E:/theirs"));
        assert_eq!(plan.selection, "an:claude");
    }

    #[test]
    fn an_aurora_chat_conversation_is_chat_with_no_project() {
        let thread = existing(true, |meta| meta.deep_research = true);
        let plan = plan_turn(&turn(None, Some("E:/work")), Some(&thread), &settings()).unwrap();
        assert_eq!(plan.mode, AgentExecutionMode::Chat);
        assert_eq!(plan.workspace, None);
        assert!(plan.deep_research);
    }

    #[test]
    fn a_turn_cannot_move_a_conversation_to_the_other_surface() {
        let thread = existing(true, |_| {});
        let error = plan_turn(&turn(Some(AgentExecutionMode::Agent), Some("E:/w")), Some(&thread), &settings())
            .unwrap_err();
        assert!(error.contains("other Aurora surface"), "{error}");
    }

    #[test]
    fn a_project_conversation_without_a_folder_is_refused() {
        let error = plan_turn(&turn(None, None), None, &settings()).unwrap_err();
        assert!(error.contains("project folder"), "{error}");
    }

    fn resolved() -> ResolvedTurnModel {
        ResolvedTurnModel {
            provider_id: "oa".into(),
            model: "gpt-5".into(),
            provider_config: crate::api::ProviderConfigSnapshot {
                provider_id: "oa".into(),
                provider_type: None,
                base_url: "https://api.example.com/v1".into(),
                api_key: "sk-test".into(),
                api_keys: None,
                model: "gpt-5".into(),
                custom_headers: None,
                custom_params: None,
                default_temperature: None,
                default_max_tokens: None,
                supports_thinking: false,
                reasoning: None,
                supports_vision: false,
                tool_images_in_result: false,
            },
            temperature: Some(0.5),
            max_output_tokens: 64_000,
            context_window: 262_000,
            thinking_enabled: Some(false),
            thinking_budget_tokens: None,
            compaction_provider_config: None,
        }
    }

    #[test]
    fn the_request_turns_every_engine_part_on_with_no_shadow() {
        let mut settings = settings();
        settings.workspace_access = "read".into();
        settings.transcript_chapters = true;
        settings.subagents_enabled = true;
        let turn = turn(None, Some("E:/work"));
        let plan = plan_turn(&turn, None, &settings).unwrap();
        let request = build_request(&turn, &plan, &settings, resolved(), false);

        let engine = request.engine_prompt.as_ref().expect("engine parts on");
        assert!(engine.tools && engine.mcp && !engine.shadow);
        assert!(engine.model.is_none(), "the model was resolved before the request");
        assert_eq!(request.system_prompt, None);
        assert_eq!(request.model, "gpt-5");
        assert_eq!(request.provider_config.api_key, "sk-test");
        assert_eq!(request.model_selection.as_deref(), Some("oa:gpt-5"));
        assert_eq!(request.context_window, Some(262_000));
        assert_eq!(request.workspace_path.as_deref(), Some("E:/work"));
        assert_eq!(request.workspace_access.as_deref(), Some("read"));
        assert_eq!(request.transcript_chapters, Some(true));
        assert_eq!(request.subagents_enabled, Some(true));
        assert_eq!(request.client.as_deref(), Some("web"));
    }

    #[test]
    fn browser_tools_stay_off_where_the_host_has_no_browser() {
        let settings = settings();
        assert!(settings.browser_tools, "on by default in Settings");
        let turn = turn(None, Some("E:/work"));
        let plan = plan_turn(&turn, None, &settings).unwrap();
        let without = build_request(&turn, &plan, &settings, resolved(), false);
        let with = build_request(&turn, &plan, &settings, resolved(), true);
        assert_eq!(without.browser_tools, Some(false));
        assert_eq!(with.browser_tools, Some(true));
    }
}
