//! Gathering what the system prompt depends on, from where it lives.
//!
//! The window used to collect these itself: settings from its store, the
//! active plan over IPC, the rule files over IPC. The engine reads the same
//! sources directly: the settings row in SQLite, the plan folder and
//! `.aurora/` on disk. What only the message knows (mode, the switches it was
//! sent with, rules attached with `/`, skills) comes in as [`TurnFacts`].

use std::path::Path;

use crate::agent_runtime::ipc::AgentExecutionMode;
use crate::db::AppSettings;

use super::project_rules::{auto_rules_block, load_project_rules};
use super::prompt::SystemPromptInput;
use super::skills::{load_all_skills, resolve_for_prompt};

/// The most global-instruction sets the window keeps; a set past this is
/// never active (`GLOBAL_INSTRUCTION_PROFILE_LIMIT` in `store/settings/values.ts`).
const GLOBAL_INSTRUCTION_PROFILE_LIMIT: usize = 8;

/// What the turn itself says, beside the settings.
#[derive(Debug, Clone, Default)]
pub struct TurnFacts {
    pub mode: AgentExecutionMode,
    pub workspace_path: Option<String>,
    pub transcript_chapters: bool,
    pub reply_layout: bool,
    pub deep_research: bool,
    pub browser_tools: bool,
    /// Rule files attached with `/` this turn: left out of the standing block.
    pub attached_rules: Vec<String>,
    /// Skills attached with `/` this turn, by storage key.
    pub explicit_skill_keys: Vec<String>,
    /// Where global skills live; [`super::skills::global_skills_root`] in a
    /// real turn, a temporary folder in tests.
    pub global_skills_root: Option<String>,
}

/// Build the system prompt's inputs for one turn.
#[must_use]
pub fn system_prompt_input(settings: &AppSettings, facts: TurnFacts) -> SystemPromptInput {
    let chat = facts.mode.is_chat();
    let workspace = if chat { None } else { facts.workspace_path.clone() };
    let root = workspace.as_deref().map(str::trim).filter(|root| !root.is_empty()).map(Path::new);
    let all_skills = load_all_skills(workspace.as_deref(), facts.global_skills_root.as_deref());
    let skills = resolve_for_prompt(
        &all_skills,
        &settings.skill_toggles,
        settings.skills_enabled,
        workspace.as_deref(),
        &facts.explicit_skill_keys,
    );
    SystemPromptInput {
        mode: facts.mode,
        workspace_access: settings.workspace_access.clone(),
        project_rules: root.and_then(|root| auto_rules_block(&load_project_rules(root), &facts.attached_rules)),
        global_instructions: active_global_instructions(settings),
        has_active_plan: root.is_some_and(has_active_plan),
        transcript_chapters: facts.transcript_chapters,
        reply_layout: facts.reply_layout,
        deep_research: facts.deep_research,
        browser_tools: facts.browser_tools,
        today: today_utc(),
        skills,
        base_prompt: None,
        workspace_path: workspace,
    }
}

/// The text of the active global-instruction set, as the window resolved it
/// (`resolveGlobalInstructionState` + `selectActiveGlobalInstructions`):
/// the first eight sets with a non-empty, unique id; with none saved, the
/// legacy single text counts when it has any.
#[must_use]
pub fn active_global_instructions(settings: &AppSettings) -> String {
    let mut seen = std::collections::HashSet::new();
    let profiles: Vec<_> = settings
        .global_instruction_profiles
        .iter()
        .filter(|profile| !profile.id.is_empty() && seen.insert(profile.id.as_str()))
        .take(GLOBAL_INSTRUCTION_PROFILE_LIMIT)
        .collect();
    if profiles.is_empty() {
        return if settings.global_instructions.trim().is_empty() {
            String::new()
        } else {
            settings.global_instructions.clone()
        };
    }
    profiles
        .into_iter()
        .find(|profile| profile.id == settings.active_global_instruction_profile_id)
        .map(|profile| profile.text.clone())
        .unwrap_or_default()
}

/// Whether the project has a plan to execute against. Unreadable is no plan:
/// the turn must still run.
fn has_active_plan(workspace: &Path) -> bool {
    match crate::plans::store::active(workspace) {
        Ok(plan) => plan.is_some(),
        Err(error) => {
            crate::logging::log_warn("turn_build", &format!("active plan lookup failed: {error}"));
            false
        }
    }
}

/// Today in UTC, `YYYY-MM-DD`, as `new Date().toISOString().slice(0, 10)`.
fn today_utc() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile(id: &str, text: &str) -> serde_json::Value {
        serde_json::json!({ "id": id, "name": id, "text": text })
    }

    fn with_profiles(mut s: AppSettings, profiles: Vec<serde_json::Value>) -> AppSettings {
        s.global_instruction_profiles =
            serde_json::from_value(serde_json::Value::Array(profiles)).expect("profiles");
        s
    }

    fn settings() -> AppSettings {
        AppSettings::default()
    }

    #[test]
    fn the_active_set_is_the_one_named_and_a_legacy_text_counts_when_none_are_saved() {
        let mut s = settings();
        s.global_instructions = "Legacy rules.".into();
        assert_eq!(active_global_instructions(&s), "Legacy rules.");

        let mut s = with_profiles(s, vec![profile("a", "First."), profile("b", "Second.")]);
        s.active_global_instruction_profile_id = "b".into();
        assert_eq!(active_global_instructions(&s), "Second.");
        s.active_global_instruction_profile_id = "missing".into();
        assert_eq!(active_global_instructions(&s), "");
    }

    #[test]
    fn a_set_past_the_eighth_or_a_duplicate_id_is_never_active() {
        let mut s = with_profiles(
            settings(),
            (0..9).map(|i| profile(&format!("p{i}"), &format!("text {i}"))).collect(),
        );
        s.active_global_instruction_profile_id = "p8".into();
        assert_eq!(active_global_instructions(&s), "");
        let mut s = with_profiles(s, vec![profile("d", "kept"), profile("d", "dropped")]);
        s.active_global_instruction_profile_id = "d".into();
        assert_eq!(active_global_instructions(&s), "kept");
    }

    #[test]
    fn rules_and_the_plan_come_from_disk_and_chat_reads_neither() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".aurora")).unwrap();
        std::fs::write(dir.path().join(".aurora/style.md"), "Use tabs.").unwrap();
        std::fs::write(dir.path().join(".aurora/picked.md"), "Attached by hand.").unwrap();
        let root = dir.path().to_string_lossy().to_string();

        let agent = system_prompt_input(
            &settings(),
            TurnFacts {
                workspace_path: Some(root.clone()),
                attached_rules: vec!["picked.md".into()],
                ..Default::default()
            },
        );
        let rules = agent.project_rules.expect("rules block");
        assert!(rules.contains("Use tabs."));
        assert!(!rules.contains("Attached by hand."));
        assert!(!agent.has_active_plan);
        assert_eq!(agent.today.len(), 10);

        let chat = system_prompt_input(
            &settings(),
            TurnFacts { mode: AgentExecutionMode::Chat, workspace_path: Some(root), ..Default::default() },
        );
        assert_eq!(chat.workspace_path, None);
        assert_eq!(chat.project_rules, None);
    }
}
