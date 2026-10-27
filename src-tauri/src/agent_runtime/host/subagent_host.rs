//! Agent runtime IPC — running a sub-agent.
//!
//! [`AgentV2SubagentHost`] is the [`SubagentHost`] the turn driver hands to
//! the parent's sub-agent tools. It turns a spawn request into a child
//! conversation and drives it through the same [`TurnDriver`] the parent is
//! running on — same journal, same mutex, same save, same closing event —
//! against a store inside the parent's thread folder and with the
//! definition's roster instead of the mode's.
//!
//! What this file decides:
//!
//! - **which model** the child runs on: an explicit `model` on the call, else
//!   the definition's, else the user's sub-agent default, else the parent's.
//!   A pin the parent is not on is resolved through the registry's
//!   [`ProviderLookup`], which reads the user's providers from the database.
//! - **which token** stops it: a synchronous child's token is a child of the
//!   parent turn's, so Stop stops both; a background child gets its own.
//! - **what the parent is told**: the report the child handed in with
//!   `submit_report`. A child that ends without one is asked once; after that
//!   its last message stands in, marked as never submitted. A waiting parent
//!   gets the report as the tool result. A background child's report is
//!   claimed once (`TaskRecord::claim_notification`) and then either queued
//!   into the parent's running turn — it lands at the next tool boundary as
//!   an `AgentReport` block — or, when the parent is idle, handed to the
//!   window as a `Report` event to start a turn with. `get_task_output` never
//!   carries or claims it. A report too long to deliver whole is written to
//!   the parent's tool-results folder and arrives as head, tail and path. On
//!   an error or a kill the parent still gets whatever the child managed to
//!   submit or say.
//! - **how a follow-up reaches a child**: a running child's queue is the same
//!   per-conversation slot a person's mid-turn message uses; a finished or
//!   forgotten child is resumed from its files under the same id.

use super::*;
use std::time::Instant;

use crate::agent_runtime::subagents::{
    catalog::{Catalog, DEFAULT_AGENT_TYPE},
    host::{
        Activity, MessageDelivery, ModelChoice, ParentMessenger, ParentResponse, ParentTurn, SendOutcome,
        SpawnOutcome, SpawnRequest, StopOutcome, SubagentError, SubagentHost, SubagentUsage,
        SubmittedReport,
    },
    new_agent_id, new_child_turn_id,
    messaging::{ChildMessageKind, ParentMessageKind},
    prompt::{child_system_prompt, message_system_prompt, REPORT_REMINDER},
    record::{StopBy, TaskRecord, TaskSnapshot, TaskStatus},
    report,
    store::{self as child_store, AgentSidecar},
    AgentDefinition, SubagentEvent,
};
use crate::agent_runtime::types::{AgentReportMeta, ContentBlock, InjectedOrigin};

#[path = "subagent_messaging.rs"]
mod messaging;

/// Steps of a run that ended without a report listed in that report: enough
/// to see where it got to, few enough to read at a glance.
const RECENT_STEPS_IN_REPORT: usize = 12;

/// The [`SubagentHost`] bound to one registry and one emitter.
pub struct AgentV2SubagentHost<E: EventEmitter> {
    registry: Arc<AgentRegistry>,
    emitter: Arc<E>,
    /// Where user definitions are read from. Overridable so a test does not
    /// read the real `~/.aurora/agents/`.
    catalog_dir: PathBuf,
}

impl<E: EventEmitter> AgentV2SubagentHost<E> {
    #[must_use]
    pub fn new(registry: Arc<AgentRegistry>, emitter: Arc<E>) -> Self {
        Self {
            registry,
            emitter,
            catalog_dir: Catalog::user_dir(),
        }
    }

    #[must_use]
    pub fn with_catalog_dir(mut self, dir: PathBuf) -> Self {
        self.catalog_dir = dir;
        self
    }

    fn catalog(&self) -> Catalog {
        Catalog::load(&self.catalog_dir)
    }

    fn resolve_tools(
        &self,
        parent: &ParentTurn,
        definition: &AgentDefinition,
        requested: Option<&[String]>,
        model: &ChildModel,
    ) -> Result<Vec<String>, SubagentError> {
        if parent.request.execution_mode != AgentExecutionMode::Agent {
            return Err(SubagentError::Unavailable);
        }
        let available: Vec<String> = self.registry.tools().names().into_iter().filter(|name| {
            !super::tool_policy::is_withdrawn_tool(name)
                && super::tool_policy::is_tool_available_this_turn(name,
                    parent.request.execution_mode, false, false,
                    parent.request.browser_tools.unwrap_or(true))
                && (model.config.supports_vision || !crate::tools::browser::VISION_REQUIRED_TOOLS.contains(&name.as_str()))
        }).collect();
        crate::agent_runtime::subagents::grant::resolve(definition, requested, &available)
    }

    /// The parent's own model, as a request-ready bundle.
    fn parents_model(parent: &ParentTurn) -> ChildModel {
        let req = &parent.request;
        ChildModel {
            provider_id: req.provider_id.clone(),
            wire_model: req.model.clone(),
            pin: pin_for(req.model_selection.as_deref(), &req.model, &req.provider_id),
            config: req.provider_config.clone(),
            context_window: req.context_window,
            max_output_tokens: req.max_output_tokens,
            temperature: req.temperature,
        }
    }

    /// The model a child runs on, as a request-ready bundle.
    fn pick_model(
        &self,
        parent: &ParentTurn,
        def: &AgentDefinition,
        explicit: Option<&str>,
    ) -> Result<ChildModel, SubagentError> {
        let req = &parent.request;
        let own = Self::parents_model(parent);
        let wanted = explicit
            .or(def.model.as_deref())
            .or(req.subagent_model.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let Some(pin) = wanted else {
            return Ok(own);
        };
        if pin == own.pin {
            return Ok(own);
        }
        if let Some(lookup) = self.registry.provider_lookup() {
            return lookup
                .resolve(pin, req.thinking_enabled.unwrap_or(false))
                .map(|resolved| ChildModel {
                    pin: format!("{}:{}", resolved.provider_id, resolved.model_key),
                    provider_id: resolved.provider_id,
                    wire_model: resolved.model_key,
                    temperature: resolved.config.default_temperature,
                    config: resolved.config,
                    context_window: resolved.context_window,
                    max_output_tokens: resolved.max_output_tokens,
                });
        }
        // No database to ask. A different model on the PARENT's provider is
        // still answerable: same key, same URL, another model name.
        if let Some((provider, key)) = pin.split_once(':') {
            if provider == req.provider_id && !key.trim().is_empty() {
                let mut swapped = own;
                swapped.wire_model = key.trim().to_string();
                swapped.config.model = key.trim().to_string();
                swapped.pin = pin.to_string();
                // The parent's window belongs to the parent's model.
                swapped.context_window = None;
                swapped.max_output_tokens = None;
                return Ok(swapped);
            }
        }
        Err(SubagentError::UnknownModel(format!(
            "model {pin:?} cannot be resolved here; use the conversation's own model or one on \
             provider {:?}",
            req.provider_id
        )))
    }

    /// The child's request: the parent's settings, copied, with the child's
    /// identity, prompt, model and roster switches.
    fn child_request(
        parent: &ParentTurn,
        def: &AgentDefinition,
        model: &ChildModel,
        agent_id: &str,
        child_turn_id: &str,
        prompt: &str,
    ) -> AgentChatRequest {
        let p = &parent.request;
        let browser = def.tools.iter().any(|t| t.starts_with("browser_"));
        AgentChatRequest {
            cli_task_id: None,
            turn_id: child_turn_id.to_string(),
            thread_id: agent_id.to_string(),
            user_message: prompt.to_string(),
            user_message_origin: InjectedOrigin::User,
            user_message_summary: None,
            user_message_agent: None,
            provider_id: model.provider_id.clone(),
            model: model.wire_model.clone(),
            // The pin is `provider_id:model` — see `pin_for`. A selection
            // string is a Cursor detail the child does not inherit.
            model_selection: None,
            workspace_path: p.workspace_path.clone(),
            execution_mode: AgentExecutionMode::Agent,
            provider_config: model.config.clone(),
            system_prompt: Some(child_system_prompt(def, p.workspace_path.as_deref())),
            ide_context: None,
            client: None,
            // No frontend-bridged tools: a child's roster is natives only.
            tools: Vec::new(),
            temperature: model.temperature,
            max_output_tokens: model.max_output_tokens.or(p.max_output_tokens),
            thinking_enabled: p.thinking_enabled,
            thinking_budget_tokens: p.thinking_budget_tokens,
            context_window: model.context_window,
            compaction_threshold_pct: p.compaction_threshold_pct,
            compaction_summary_budget: p.compaction_summary_budget,
            compaction_provider_config: p.compaction_provider_config.clone(),
            workspace_access: p.workspace_access.clone(),
            allow_outside_workspace: p.allow_outside_workspace,
            transcript_chapters: Some(false),
            browser_tools: Some(browser),
            defer_tools: Some(false),
            attached_selected_elements: None,
            attached_prompt_chips: None,
            image_providers: Vec::new(),
            // One level. Enforced again by the child roster, which cannot
            // name the spawn tools; this is the request saying the same.
            subagents_enabled: Some(false),
            subagent_model: None,
        }
    }

    /// The store the parent's children live in.
    fn store_for(parent: &ParentTurn) -> Arc<SessionStore> {
        Arc::new(child_store::child_store_for(&parent.store, &parent.thread_id))
    }

    /// Find a child by the parent's name for it or by id — live first, then
    /// on disk.
    fn locate(
        &self,
        parent: &ParentTurn,
        store: &SessionStore,
        to: &str,
    ) -> Option<(Option<Arc<TaskRecord>>, AgentSidecar)> {
        let tasks = self.registry.subagent_tasks();
        if let Some(record) = tasks.resolve(&parent.thread_id, to) {
            let sidecar = AgentSidecar::load(store, &record.agent_id).ok()?;
            return Some((Some(record), sidecar));
        }
        // Not in memory: this process never ran it, or it was evicted. The
        // files are the truth.
        let by_id = AgentSidecar::load(store, to).ok();
        let sidecar = by_id.or_else(|| {
            AgentSidecar::list_in(store)
                .into_iter()
                .filter(|s| s.name.as_deref() == Some(to))
                .last()
        })?;
        if sidecar.parent_thread_id != parent.thread_id {
            return None;
        }
        Some((None, sidecar))
    }

    /// Put a finished or forgotten agent back to work with `message`.
    async fn resume(
        &self,
        parent: &ParentTurn,
        store: Arc<SessionStore>,
        existing: Option<Arc<TaskRecord>>,
        mut sidecar: AgentSidecar,
        message: &str,
        kind: ParentMessageKind,
    ) -> Result<SendOutcome, SubagentError> {
        let agent_id = sidecar.agent_id.clone();
        let catalog = self.catalog();
        let (mut def, mut note) = match catalog.get(&sidecar.agent_type) {
            Some(def) => (def.clone(), None),
            None => (
                catalog
                    .get(DEFAULT_AGENT_TYPE)
                    .cloned()
                    .ok_or_else(|| SubagentError::Start("no general-purpose definition".into()))?,
                Some(format!(
                    "its original definition {:?} no longer exists; it is running as \
                     general-purpose",
                    sidecar.agent_type
                )),
            ),
        };
        // The model it ran on before, if that is still resolvable; the
        // parent's otherwise. A resume must not fail because a provider was
        // removed since — the transcript is what matters, not the pin.
        let model = match self.pick_model(parent, &def, sidecar.model.as_deref()) {
            Ok(model) => model,
            Err(SubagentError::UnknownModel(why)) => {
                crate::logging::log_warn(
                    "subagents",
                    &format!("{agent_id}: {why}; resuming on the parent's model"),
                );
                Self::parents_model(parent)
            }
            Err(other) => return Err(other),
        };

        let legacy_grant = if sidecar.tool_grant.is_none()
            && ((sidecar.agent_type == DEFAULT_AGENT_TYPE
                && (sidecar.source.is_none() || sidecar.source == Some(crate::agent_runtime::subagents::catalog::DefinitionSource::BuiltIn)))
                || note.is_some()) {
            Some(crate::agent_runtime::subagents::catalog::GENERAL_PURPOSE_TOOLS.iter()
                .map(|tool| (*tool).to_string()).collect::<Vec<_>>())
        } else { None };
        let requested = sidecar.tool_grant.as_deref().or(legacy_grant.as_deref());
        let grant = self.resolve_tools(parent, &def, requested, &model)?;
        if sidecar.tool_grant.is_none() {
            let legacy_note = "This older agent had no saved tool grant. The resolved grant is now saved and will remain stable on resume.";
            note = Some(note.map_or_else(|| legacy_note.to_string(), |old| format!("{old}. {legacy_note}")));
        }
        def.tools = grant.clone();
        sidecar.tool_grant = Some(grant);

        let message_only = kind != ParentMessageKind::Task;
        if message_only {
            sidecar = sidecar.as_loaded();
        } else {
            sidecar.record_resume(message);
        }
        let work_before = message_only.then(|| existing.as_ref().map_or_else(
            || TaskSnapshot::from_sidecar(&sidecar), |record| record.snapshot()
        ));
        sidecar.model = Some(model.pin.clone());
        sidecar.save(&store)
            .map_err(|e| SubagentError::Start(format!("could not update agent.json: {e}")))?;

        let cancel = CancellationToken::new();
        let record = match existing {
            Some(record) => {
                if message_only {
                    record.resume_message(cancel.clone());
                } else {
                    record.resume(cancel.clone());
                }
                record
            }
            None => {
                let record = Arc::new(TaskRecord::resumed_from_disk(&sidecar, cancel.clone()));
                if message_only {
                    record.resume_message(cancel.clone());
                }
                self.registry.subagent_tasks().insert(record.clone());
                record
            }
        };
        record.set_model(Some(model.pin.clone()));

        let child_turn_id = new_child_turn_id();
        let output_file = child_store::output_file(&store, &agent_id)
            .to_string_lossy()
            .into_owned();
        let request = Self::child_request(parent, &def, &model, &agent_id, &child_turn_id, message);

        self.emitter.emit_subagent(&SubagentEvent::Started {
            agent_id: agent_id.clone(),
            parent_thread_id: parent.thread_id.clone(),
            parent_turn_id: Some(parent.turn_id.clone()),
            turn_id: child_turn_id,
            agent_type: def.name.clone(),
            name: sidecar.name.clone(),
            description: sidecar.description.clone(),
            model: Some(model.pin.clone()),
            background: true,
            resumed: true,
            output_file: output_file.clone(),
        });

        let run = ChildRun {
            message_only,
            work_before,
            message_prompt: message_system_prompt(&def, parent.request.workspace_path.as_deref()),
            registry: self.registry.clone(),
            emitter: self.emitter.clone(),
            store,
            record,
            sidecar,
            allow: def.tools.clone(),
            cancel,
            request,
            output_file: output_file.clone(),
            parent_results_dir: parent.store.tool_results_dir(&parent.thread_id),
        };
        tokio::spawn(async move {
            let _ = run.execute().await;
        });
        if message_only {
            Ok(SendOutcome::Messaging { agent_id })
        } else {
            Ok(SendOutcome::Resumed { agent_id, output_file, note })
        }
    }
}

/// A model choice resolved for a child.
#[derive(Debug, Clone)]
struct ChildModel {
    provider_id: String,
    wire_model: String,
    pin: String,
    config: crate::api::ProviderConfigSnapshot,
    context_window: Option<u32>,
    max_output_tokens: Option<u32>,
    temperature: Option<f32>,
}

#[async_trait::async_trait]
impl<E: EventEmitter> SubagentHost for AgentV2SubagentHost<E> {
    async fn activity(&self, parent: &ParentTurn, task_id: &str) -> Option<Activity> {
        // From the live log, never the session: the running turn holds the
        // session's lock until it ends, and a check that took it waited for
        // the end.
        let record = self.registry.subagent_tasks().resolve(&parent.thread_id, task_id)?;
        if record.parent_thread_id != parent.thread_id {
            return None;
        }        let digest = record.take_activity();
        Some(Activity {
            steps: digest.steps,
            tool_calls: digest.tool_calls,
            timeline: digest.timeline,
            omitted: digest.omitted,
            in_progress: digest.in_progress,
        })
    }

    async fn stop(&self, parent: &ParentTurn, to: &str) -> Result<StopOutcome, SubagentError> {
        let store = Self::store_for(parent);
        let Some((record, sidecar)) = self.locate(parent, &store, to) else {
            return Err(SubagentError::NotFound(to.to_string()));
        };
        match record {
            Some(record) if record.kill(StopBy::Parent) => Ok(StopOutcome::Stopped {
                agent_id: record.agent_id.clone(),
            }),
            Some(record) => Ok(StopOutcome::NotRunning {
                agent_id: record.agent_id.clone(),
                status: record.status().as_str().to_string(),
            }),
            None => Ok(StopOutcome::NotRunning {
                agent_id: sidecar.agent_id.clone(),
                status: sidecar.as_loaded().status.as_str().to_string(),
            }),
        }
    }

    async fn spawn(
        &self,
        parent: &ParentTurn,
        request: SpawnRequest,
    ) -> Result<SpawnOutcome, SubagentError> {
        let admission = tokio::select! {
            guard = self.registry.subagent_tasks().lock_agent(&parent.thread_id) => guard,
            () = parent.cancel.cancelled() => return Err(SubagentError::Unavailable),
        };
        self.registry.ensure_thread_live(&parent.thread_id)
            .map_err(|e| SubagentError::Start(e.to_string()))?;
        let catalog = self.catalog();
        let mut def = catalog
            .resolve(request.agent_type.as_deref())
            .map_err(SubagentError::Invalid)?
            .clone();
        let model = self.pick_model(parent, &def, request.model.as_deref())?;
        let grant = self.resolve_tools(parent, &def, request.tools.as_deref(), &model)?;
        def.tools = grant.clone();

        let agent_id = new_agent_id();
        let child_turn_id = new_child_turn_id();
        let store = Self::store_for(parent);
        store
            .ensure_thread(
                &agent_id,
                Some(request.description.clone()),
                parent.request.workspace_path.clone(),
            )
            .map_err(|e| SubagentError::Start(e.to_string()))?;
        let output_file = child_store::output_file(&store, &agent_id)
            .to_string_lossy()
            .into_owned();

        let now = Utc::now().to_rfc3339();
        let sidecar = AgentSidecar {
            agent_id: agent_id.clone(),
            parent_thread_id: parent.thread_id.clone(),
            agent_type: def.name.clone(),
            name: request.name.clone(),
            description: request.description.clone(),
            prompt: request.prompt.clone(),
            model: Some(model.pin.clone()),
            background: request.background,
            source: Some(def.source.clone()),
            tool_grant: Some(grant),
            status: TaskStatus::Running,
            created_at: now.clone(),
            updated_at: now,
            ended_at: None,
            result: None,
            error: None,
            usage: SubagentUsage::default(),
            runs: 1,
            context_tokens: None,
        };
        sidecar
            .save(&store)
            .map_err(|e| SubagentError::Start(format!("could not write agent.json: {e}")))?;

        // Cancellation symmetry: a waiting parent's Stop stops the child; a
        // background child outlives the parent's turn and is stopped only by
        // an explicit kill.
        let cancel = if request.background {
            CancellationToken::new()
        } else {
            parent.cancel.child_token()
        };
        let record = Arc::new(TaskRecord::new(
            agent_id.clone(),
            parent.thread_id.clone(),
            def.name.clone(),
            request.name.clone(),
            request.description.clone(),
            request.background,
            cancel.clone(),
        ));
        record.set_model(Some(model.pin.clone()));
        self.registry.subagent_tasks().insert(record.clone());

        let child_request = Self::child_request(
            parent,
            &def,
            &model,
            &agent_id,
            &child_turn_id,
            &request.prompt,
        );

        self.emitter.emit_subagent(&SubagentEvent::Started {
            agent_id: agent_id.clone(),
            parent_thread_id: parent.thread_id.clone(),
            parent_turn_id: Some(parent.turn_id.clone()),
            turn_id: child_turn_id.clone(),
            agent_type: def.name.clone(),
            name: request.name.clone(),
            description: request.description.clone(),
            model: Some(model.pin.clone()),
            background: request.background,
            resumed: false,
            output_file: output_file.clone(),
        });

        let run = ChildRun {
            message_only: false,
            work_before: None,
            message_prompt: message_system_prompt(&def, parent.request.workspace_path.as_deref()),
            registry: self.registry.clone(),
            emitter: self.emitter.clone(),
            store,
            record,
            sidecar,
            allow: def.tools.clone(),
            cancel,
            request: child_request,
            output_file: output_file.clone(),
            parent_results_dir: parent.store.tool_results_dir(&parent.thread_id),
        };
        drop(admission);

        if request.background {
            tokio::spawn(async move {
                let _ = run.execute().await;
            });
            return Ok(SpawnOutcome::Launched {
                agent_id,
                output_file,
            });
        }

        let finished = run.execute().await;
        Ok(SpawnOutcome::Finished {
            agent_id,
            state: finished.status.as_str().to_string(),
            result: finished.result,
            error: finished.error,
            usage: finished.usage,
            output_file,
        })
    }

    async fn send_message(
        &self,
        parent: &ParentTurn,
        to: &str,
        message: &str,
    ) -> Result<SendOutcome, SubagentError> {
        self.send_message_kind(parent, to, message, ParentMessageKind::Task).await
    }

    async fn send_message_kind(
        &self,
        parent: &ParentTurn,
        to: &str,
        message: &str,
        kind: ParentMessageKind,
    ) -> Result<SendOutcome, SubagentError> {
        let message = message.trim();
        if message.is_empty() {
            return Err(SubagentError::Invalid("`message` is empty".into()));
        }
        let _parent_admission = tokio::select! {
            guard = self.registry.subagent_tasks().lock_agent(&parent.thread_id) => guard,
            () = parent.cancel.cancelled() => return Err(SubagentError::Unavailable),
        };
        self.registry.ensure_thread_live(&parent.thread_id)
            .map_err(|e| SubagentError::Start(e.to_string()))?;
        let store = Self::store_for(parent);
        let Some((_, located)) = self.locate(parent, &store, to) else {
            return Err(SubagentError::NotFound(to.to_string()));
        };
        let _handoff = self.registry.subagent_tasks().lock_agent(&located.agent_id).await;
        let Some((record, sidecar)) = self.locate(parent, &store, &located.agent_id) else {
            return Err(SubagentError::NotFound(to.to_string()));
        };
        if let Some(record) = record.as_ref().filter(|r| r.is_running()) {
            // Into the child's own conversation queue, delivered at its next
            // tool boundary. To the child, the parent IS its user, so the
            // mid-turn framing a person's message gets is the right one. But
            // appended, never replacing: a person's composer has one pending
            // message, the parent may send three and every one must arrive,
            // in order. If the run ends before another boundary, `execute`
            // runs it again with what is still queued.
            //
            // A child holding in `message_parent` for this very answer takes it
            // from the queue at once (`ChildMessenger::wait_for_reply`); read
            // the flag before waking it, since the wake ends the hold.
            let taken_now = kind == ParentMessageKind::Reply && record.is_waiting_for_reply();
            self.registry
                .enqueue_child_message(&record.agent_id, message.to_string(), InjectedOrigin::User, Some(kind))
                .map_err(SubagentError::Start)?;
            self.emitter.emit_subagent(&SubagentEvent::Message {
                agent_id: record.agent_id.clone(),
                parent_thread_id: parent.thread_id.clone(),
                text: message.to_string(),
                delivered: false,
            });
            record.notify_reply();
            return Ok(SendOutcome::Queued {
                agent_id: record.agent_id.clone(),
                taken_now,
            });
        }
        self.resume(parent, store, record, sidecar, message, kind).await
    }

    async fn output(
        &self,
        parent: &ParentTurn,
        task_id: &str,
        wait: Option<std::time::Duration>,
    ) -> Result<TaskSnapshot, SubagentError> {
        let store = Self::store_for(parent);
        let Some((record, sidecar)) = self.locate(parent, &store, task_id) else {
            return Err(SubagentError::NotFound(task_id.to_string()));
        };
        let Some(record) = record else {
            // Finished in an earlier process: the files say how.
            return Ok(TaskSnapshot::from_sidecar(&sidecar.as_loaded()));
        };
        // A check only looks. It never claims the report: the report reaches
        // the parent through the conversation, which has no size cap. A check
        // that took it once handed a 15 KB report to the 8 KiB tool-result
        // cap, which dropped it whole, and the report never came again.
        if let Some(wait) = wait {
            record.wait_finished(wait).await;
        }
        Ok(record.snapshot())
    }

    fn list(&self, parent_thread_id: &str) -> Vec<TaskSnapshot> {
        self.registry
            .subagent_tasks()
            .for_parent(parent_thread_id)
            .iter()
            .map(|r| r.snapshot())
            .collect()
    }

    fn models(&self, parent: &ParentTurn) -> Result<Vec<ModelChoice>, SubagentError> {
        let req = &parent.request;
        let parent_pin = pin_for(req.model_selection.as_deref(), &req.model, &req.provider_id);
        match self.registry.provider_lookup() {
            Some(lookup) => lookup
                .models()
                .map(|mut models| {
                    for m in &mut models {
                        m.current = m.pin == parent_pin;
                    }
                    models
                })
                .map_err(SubagentError::Start),
            None => Ok(vec![ModelChoice {
                pin: parent_pin,
                provider: req.provider_id.clone(),
                model: req.model.clone(),
                label: None,
                context_window: req.context_window.map(i64::from),
                price_output_per_mtok: None,
                current: true,
            }]),
        }
    }

    fn describe_definitions(&self) -> String {
        self.catalog().describe()
    }
}

/// Every agent a parent has, for the window: the files are the list, the
/// live records are the current state of whichever ones are running now.
#[must_use]
pub fn list_agents_for(registry: &AgentRegistry, parent_store: &SessionStore, parent_thread_id: &str) -> Vec<TaskSnapshot> {
    let store = child_store::child_store_for(parent_store, parent_thread_id);
    let tasks = registry.subagent_tasks();
    AgentSidecar::list_in(&store)
        .into_iter()
        .map(|sidecar| match tasks.get(&sidecar.agent_id) {
            Some(record) => record.snapshot(),
            None => TaskSnapshot::from_sidecar(&sidecar.as_loaded()),
        })
        .collect()
}

/// One run of one child, from "start the turn" to "record how it ended".
struct ChildRun<E: EventEmitter> {
    message_only: bool,
    work_before: Option<TaskSnapshot>,
    message_prompt: String,
    registry: Arc<AgentRegistry>,
    emitter: Arc<E>,
    store: Arc<SessionStore>,
    record: Arc<TaskRecord>,
    sidecar: AgentSidecar,
    allow: Vec<String>,
    /// The record's token: what `kill` and a parent's Stop cancel.
    cancel: CancellationToken,
    request: AgentChatRequest,
    output_file: String,
    /// The parent thread's tool-results folder: where a report too long to
    /// deliver whole is written, because the parent's `file_read` can always
    /// open it.
    parent_results_dir: PathBuf,
}

/// How a run ended, in the parent's terms.
pub(crate) struct ChildFinish {
    pub status: TaskStatus,
    pub result: String,
    pub error: Option<String>,
    pub usage: SubagentUsage,
}

impl<E: EventEmitter> ChildRun<E> {
    async fn execute(mut self) -> ChildFinish {
        let started = Instant::now();
        let agent_id = self.request.thread_id.clone();
        let turn_id = self.request.turn_id.clone();
        // Every event the child streams passes through its record on the way
        // to the window, so a parent's check reads what the child is doing
        // without touching the session the running turn holds locked.
        let emitter = Arc::new(RecordingEmitter {
            inner: self.emitter.clone() as Arc<dyn EventEmitter>,
            record: self.record.clone(),
        });
        let driver = TurnDriver::new(self.registry.clone(), emitter);
        let messenger: Arc<dyn ParentMessenger> = Arc::new(ChildMessenger {
            registry: self.registry.clone(),
            emitter: self.emitter.clone(),
            record: self.record.clone(),
        });

        // One run can take several turns, all under the same turn id so the
        // window's live view simply continues:
        // - a message the parent sends while the child writes its final
        //   reply has no tool boundary left to land on, and the parent was
        //   told it was queued, so the child carries on with it;
        // - a child that ends without `submit_report` is asked for it once.
        //   Claude Code holds an agent to its `StructuredOutput` call the same
        //   way, with a stop hook. A second miss falls back to its last
        //   message, which the report then says was never submitted.
        let mut request = self.request.clone();
        let task_prompt = request.system_prompt.clone();
        let mut usage = SubagentUsage::default();
        let mut tool_uses = 0u64;
        let mut asked_for_report = false;
        // The stream's counts at the start of this run, so a run that is
        // stopped mid-turn (whose turn never reports its usage) is still
        // credited with the work it did.
        let streamed_before = self.record.activity_totals();
        // The last thing it said in any of the run's turns. A reminder turn
        // that only calls `submit_report` says nothing new.
        let mut last_said = String::new();
        let mut finishing = None;
        let outcome: Result<(), RuntimeError> = loop {
            let report_required = self.record.requires_report();
            request.system_prompt = if report_required { task_prompt.clone() } else { Some(self.message_prompt.clone()) };
            // No person watches a child's turn, so a tool set to "ask" is
            // refused with the reason rather than parked on a prompt. See
            // `prompter.rs`.
            crate::tools::permissions::prompter::mark_no_prompt_turn(&turn_id);
            let outcome = driver
                .run_turn_in_store(
                    request.clone(),
                    self.store.clone(),
                    TurnKind::Child {
                        report_required,
                        allow: if report_required { self.allow.clone() } else { Vec::new() },
                        cancel: self.cancel.clone(),
                        messenger: Some(messenger.clone()),
                    },
                )
                .await;
            crate::tools::permissions::prompter::clear_no_prompt_turn(&turn_id);
            let completion = match outcome {
                Ok(completion) => completion,
                // The work before the reminder stands: a provider hiccup on
                // "please submit" must not turn a finished run into a failed
                // one. It reports from its last message instead.
                Err(err) if asked_for_report && !err.is_cancellation() => {
                    crate::logging::log_warn(
                        "subagents",
                        &format!("{agent_id}: the turn asking for its report failed: {err}"),
                    );
                    break Ok(());
                }
                Err(err) => break Err(err),
            };
            usage.add(&SubagentUsage::from_turn(
                &completion.usage,
                completion.iterations,
                count_tool_uses(&completion.assistant_messages),
                0,
            ));
            tool_uses += count_tool_uses(&completion.assistant_messages);
            let said = final_text(&completion.assistant_messages);
            if !said.is_empty() {
                last_said = said;
            }
            if self.cancel.is_cancelled() {
                break Err(RuntimeError::Cancelled);
            }
            let handoff = self.registry.subagent_tasks().lock_agent(&agent_id).await;
            let waiting = self.registry.take_queued_messages(&agent_id);
            if !waiting.is_empty() {
                request.user_message = waiting
                    .into_iter()
                    .map(|m| m.subagent_kind.map_or_else(|| m.text.clone(), |kind| kind.frame(&m.text)))
                    .collect::<Vec<_>>()
                    .join("\n\n");
                request.user_message_origin = InjectedOrigin::User;
                request.user_message_summary = None;
                asked_for_report = false;
                drop(handoff);
                continue;
            }
            if self.record.requires_report() && self.record.submitted_report().is_none() && !asked_for_report {
                asked_for_report = true;
                request.user_message = REPORT_REMINDER.to_string();
                // Aurora's words, not the parent's: the agent's tab draws it
                // as a one-line beat, never as a message from the parent.
                request.user_message_origin = InjectedOrigin::Process;
                request.user_message_summary = Some("Asked for its report".to_string());
                drop(handoff);
                continue;
            }
            finishing = Some(handoff);
            break Ok(());
        };
        let _finishing = match finishing {
            Some(guard) => guard,
            None => self.registry.subagent_tasks().lock_agent(&agent_id).await,
        };
        let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        usage.duration_ms = duration_ms;
        usage.tool_calls = tool_uses;
        if outcome.is_err() {
            // The turn that was stopped or failed never handed back its
            // usage. What its stream showed is the best count there is.
            let streamed = self.record.activity_totals().since(&streamed_before);
            usage.tool_calls = usage.tool_calls.max(streamed.tool_calls as u64);
            usage.iterations = usage.iterations.max(streamed.steps as u64);
            usage.input_tokens = usage.input_tokens.max(streamed.input_tokens);
            usage.output_tokens = usage.output_tokens.max(streamed.output_tokens);
        }

        let (status, said, error) = match outcome {
            Ok(()) => (TaskStatus::Completed, last_said, None),
            Err(err) => {
                // Partial beats silent: whatever the child said before it
                // died is still the best answer there is.
                let partial = if last_said.is_empty() {
                    self.partial_answer(&agent_id).await
                } else {
                    last_said
                };
                let status = if err.is_cancellation() {
                    TaskStatus::Killed
                } else {
                    TaskStatus::Failed
                };
                let error = (!err.is_cancellation()).then(|| err.to_string());
                (status, partial, error)
            }
        };
        if !self.record.requires_report() {
            return self.finish_message(status, &said, error.as_deref(), &usage, &turn_id);
        }
        if self.message_only {
            let task = self.record.task_hint().unwrap_or_else(|| "Additional work received during messaging".into());
            self.sidecar.record_resume(&task);
            self.request.user_message = task;
        }
        // What it handed in wins over what it last said, whatever the ending:
        // a report submitted before a failure is still its report.
        let submitted = self.record.submitted_report();
        let result = submitted.as_ref().map_or_else(|| said.clone(), SubmittedReport::as_text);

        self.sidecar
            .record_finish(status, Some(&result), error.as_deref(), &usage);
        self.sidecar.context_tokens = self.record.context_tokens().or(self.sidecar.context_tokens);
        if let Err(e) = self.sidecar.save(&self.store) {
            crate::logging::log_warn(
                "subagents",
                &format!("agent.json for {agent_id} was not updated after the run: {e}"),
            );
        }

        // A waiting parent gets the answer as its tool result and nothing
        // else reports it. A background child reports through the parent
        // conversation — once. Reported BEFORE the record says finished, so
        // a check waiting on this run wakes with the report already in the
        // parent's queue: it lands right after the check's result instead of
        // racing the turn's next tool boundary.
        let body = match &submitted {
            Some(report) => report::ReportBody::Submitted(report),
            None => report::ReportBody::LastMessage(&said),
        };
        let recent = if status == TaskStatus::Completed {
            Vec::new()
        } else {
            self.record.recent_activity(RECENT_STEPS_IN_REPORT)
        };
        // The parent's other agents still out, by the name it gave them, so
        // the report can say who is still to come (or that this was the last).
        let still_running: Vec<String> = self
            .registry
            .subagent_tasks()
            .for_parent(&self.record.parent_thread_id)
            .into_iter()
            .filter(|other| other.agent_id != self.record.agent_id && other.is_running())
            .map(|other| other.name.clone().unwrap_or_else(|| other.description.clone()))
            .collect();
        let ending = report::RunEnding {
            stopped_by: self.record.stopped_by(),
            recent: &recent,
            run: Some((self.record.snapshot().runs, self.request.user_message.as_str())),
            still_running: Some(&still_running),
        };
        let reported_to_parent = self.record.is_background()
            && self.report_to_parent(status, body, error.as_deref(), &usage, ending);
        self.record
            .finish(status, Some(result.clone()), error.clone(), usage.clone());

        self.emitter.emit_subagent(&SubagentEvent::Finished {
            agent_id,
            parent_thread_id: self.record.parent_thread_id.clone(),
            turn_id,
            status,
            result: result.clone(),
            error: error.clone(),
            usage: usage.clone(),
            reported_to_parent,
        });

        ChildFinish {
            status,
            result,
            error,
            usage,
        }
    }

    /// Hand the report to the parent conversation, exactly once per run.
    /// This is the only way a report reaches the parent; `get_task_output`
    /// never carries it. Returns whether anything was sent.
    fn report_to_parent(
        &self,
        status: TaskStatus,
        body: report::ReportBody<'_>,
        error: Option<&str>,
        usage: &SubagentUsage,
        ending: report::RunEnding<'_>,
    ) -> bool {
        if self.registry.ensure_thread_live(&self.record.parent_thread_id).is_err() {
            return false;
        }
        if !self.record.claim_notification() {
            return false;
        }
        // One file per run, so a resumed agent's second report never
        // overwrites the first one the parent may still be reading.
        let file_name = format!(
            "agent-report-{}-run{}.md",
            self.record.agent_id,
            self.record.snapshot().runs
        );
        let report = report::build(
            &self.record.agent_id,
            self.record.name.as_deref(),
            &self.record.agent_type,
            &self.record.description,
            status,
            body,
            error,
            usage,
            &self.output_file,
            Some(report::ReportFile {
                dir: &self.parent_results_dir,
                name: &file_name,
            }),
            ending,
        );
        deliver_to_parent(
            &self.registry,
            self.emitter.as_ref(),
            &self.record,
            status.as_str(),
            report,
        )
        .is_ok()
    }

    /// The last thing the child said, read back from its session.
    async fn partial_answer(&self, agent_id: &str) -> String {
        let Ok(session) = self.registry.load_session_from_store(agent_id, &self.store) else {
            return String::new();
        };
        let guard = session.lock().await;
        let assistant: Vec<ConversationMessage> = guard
            .messages()
            .iter()
            .filter(|m| m.role == crate::agent_runtime::types::MessageRole::Assistant)
            .cloned()
            .collect();
        final_text(&assistant)
    }
}

/// Put one report or message in front of the parent.
///
/// The parent has a turn running: it goes into that turn's queue — the same
/// slot a person's mid-turn message uses — and lands on the next tool message
/// as an `AgentReport` block, which the window draws as the agent's card. If
/// the turn ends before another boundary, the driver's end-of-turn sweep
/// hands the leftover to [`wake_parent`]. The parent is idle: [`wake_parent`]
/// records it in the registry's outbox and sends the `Report` event; the
/// window starts a turn with it and claims it.
fn deliver_to_parent<E: EventEmitter + ?Sized>(
    registry: &AgentRegistry,
    emitter: &E,
    record: &TaskRecord,
    status: &str,
    report: report::Report,
) -> Result<MessageDelivery, String> {
    let meta = AgentReportMeta {
        agent_id: record.agent_id.clone(),
        name: record.name.clone(),
        status: status.to_string(),
    };
    let parent = &record.parent_thread_id;
    registry.ensure_thread_live(parent).map_err(|e| e.to_string())?;
    if registry.is_turn_active(parent) {
        registry
            .enqueue_with_agent(
                parent,
                report.detail,
                Some(report.summary),
                None,
                InjectedOrigin::Subagent,
                Some(meta),
            )
            .map_err(|e| {
                let why = format!("could not queue {}'s message into {parent}: {e}", record.agent_id);
                crate::logging::log_warn("subagents", &why);
                why
            })?;
        // The parent's turn may have ended between the check and the
        // enqueue, after its own end-of-turn sweep: then nothing would ever
        // read the queue. Sweep again; the drain is atomic, so a report the
        // turn's sweep already took is not sent twice.
        if !registry.is_turn_active(parent) {
            super::turn_driver::sweep_leftover_reports(registry, emitter, parent);
            return Ok(MessageDelivery::WokeParent);
        }
        return Ok(MessageDelivery::QueuedIntoTurn);
    }
    wake_parent(registry, emitter, parent, meta, report.summary, report.detail);
    Ok(MessageDelivery::WokeParent)
}

/// Wake an idle parent with a report: record it in the outbox FIRST, then
/// announce it. The window starts a turn from whichever copy reaches it
/// first (the event, or its next list poll reading the outbox) and claims
/// the entry by id once that turn has opened, so a report is carried once
/// and never depends on one event being processed.
pub(super) fn wake_parent<E: EventEmitter + ?Sized>(
    registry: &AgentRegistry,
    emitter: &E,
    parent_thread_id: &str,
    agent: AgentReportMeta,
    summary: String,
    detail: String,
) {
    let Some(wake) = registry
        .wake_outbox()
        .push(parent_thread_id, agent, summary, detail) else { return; };
    emitter.emit_subagent(&SubagentEvent::Report {
        agent_id: wake.agent.agent_id.clone(),
        parent_thread_id: parent_thread_id.to_string(),
        agent: wake.agent,
        summary: wake.summary,
        detail: wake.detail,
        wake_id: wake.id,
    });
}

/// The child's hand back to its parent while it runs (`message_parent`).
struct ChildMessenger<E: EventEmitter> {
    registry: Arc<AgentRegistry>,
    emitter: Arc<E>,
    record: Arc<TaskRecord>,
}

#[async_trait::async_trait]
impl<E: EventEmitter> ParentMessenger for ChildMessenger<E> {
    fn message_parent(&self, text: &str, waiting: bool) -> Result<MessageDelivery, SubagentError> {
        self.message_parent_kind(text, if waiting { ChildMessageKind::Question } else { ChildMessageKind::Message }, waiting)
    }

    fn message_parent_kind(&self, text: &str, kind: ChildMessageKind, waiting: bool) -> Result<MessageDelivery, SubagentError> {
        let text = text.trim();
        if text.is_empty() {
            return Err(SubagentError::Invalid("`message` must not be empty".into()));
        }
        let report = report::message_with_kind(
            &self.record.agent_id,
            self.record.name.as_deref(),
            &self.record.agent_type,
            &self.record.description,
            text,
            kind,
            waiting,
        );
        deliver_to_parent(
            &self.registry,
            self.emitter.as_ref(),
            &self.record,
            TaskStatus::Running.as_str(),
            report,
        )
        .map_err(SubagentError::Start)
    }

    fn submit_report(&self, report: SubmittedReport) -> Result<bool, SubagentError> {
        if !self.record.requires_report() {
            return Err(SubagentError::Invalid("this is a conversation-only response; no work report is required".into()));
        }
        // Held on the record, delivered by `ChildRun::execute` when the run
        // ends: once, whatever the ending, never while it is still working.
        self.registry.submit_subagent_report(&self.record.agent_id, report)
            .map_err(SubagentError::Invalid)
    }

    async fn wait_for_reply(
        &self,
        timeout: std::time::Duration,
        cancel: &CancellationToken,
    ) -> Option<String> {
        match self.wait_for_response(timeout, cancel).await {
            Some(ParentResponse::Answer(text)) => Some(text),
            _ => None,
        }
    }

    async fn wait_for_response(
        &self,
        timeout: std::time::Duration,
        cancel: &CancellationToken,
    ) -> Option<ParentResponse> {
        // The parent's answer is whatever it sends this agent while it holds:
        // `send_message` queues it in this agent's own queue and wakes the
        // record. Taken from the queue here, so it is not injected a second
        // time at the agent's next step. Only the parent's words: anything
        // else queued (a process ending) stays for normal delivery.
        let agent_id = self.record.agent_id.clone();
        let registry = self.registry.clone();
        let answer = self
            .record
            .wait_for_reply(timeout, cancel, || {
                if registry.has_child_task(&agent_id) {
                    return Some(ParentResponse::TaskChanged);
                }
                let taken = registry.take_child_replies(&agent_id);
                (!taken.is_empty()).then(|| {
                    taken
                        .into_iter()
                        .map(|m| m.text)
                        .collect::<Vec<_>>()
                        .join("\n\n")
                })
                .map(ParentResponse::Answer)
            })
            .await?;
        let ParentResponse::Answer(text) = &answer else { return Some(answer); };
        // Tell the window the waiting message was taken in, so the agent's
        // views stop showing it as pending.
        self.emitter.emit_subagent(&SubagentEvent::Message {
            agent_id: self.record.agent_id.clone(),
            parent_thread_id: self.record.parent_thread_id.clone(),
            text: text.clone(),
            delivered: true,
        });
        Some(answer)
    }
}

/// A child's emitter: everything goes to the window as before, and each
/// streamed event is also folded into the child's activity log on the way.
///
/// Not generic over the inner emitter: the child's driver builds a host whose
/// spawns would wrap THIS type again, and a generic wrapper would nest
/// without end at compile time.
pub(crate) struct RecordingEmitter {
    inner: Arc<dyn EventEmitter>,
    record: Arc<TaskRecord>,
}

impl EventEmitter for RecordingEmitter {
    fn emit_event(&self, envelope: &AgentEventEnvelope) {
        self.record.observe(&envelope.event);
        self.inner.emit_event(envelope);
    }

    fn emit_turn_complete(&self, turn_id: &str, summary: &TurnCompletion) {
        self.inner.emit_turn_complete(turn_id, summary);
    }

    fn emit_turn_error(&self, turn_id: &str, error: &str, recovery_hint: Option<RecoveryHint>) {
        self.inner.emit_turn_error(turn_id, error, recovery_hint);
    }

    fn emit_tool_pending(&self, request: &ToolBridgeRequest) {
        EventEmitter::emit_tool_pending(self.inner.as_ref(), request);
    }

    fn emit_subagent(&self, event: &SubagentEvent) {
        self.inner.emit_subagent(event);
    }
}

/// The child's report: the text of its last assistant message that has any,
/// which is the message that ended the turn.
pub(crate) fn final_text(assistant_messages: &[ConversationMessage]) -> String {
    for message in assistant_messages.iter().rev() {
        let text = message
            .blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } if !text.trim().is_empty() => Some(text.trim()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        if !text.is_empty() {
            return text;
        }
    }
    String::new()
}

pub(crate) fn count_tool_uses(assistant_messages: &[ConversationMessage]) -> u64 {
    assistant_messages
        .iter()
        .flat_map(|m| m.blocks.iter())
        .filter(|b| matches!(b, ContentBlock::ToolUse { .. }))
        .count() as u64
}
