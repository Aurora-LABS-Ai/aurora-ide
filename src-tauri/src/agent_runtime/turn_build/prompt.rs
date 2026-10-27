//! The system prompt, composed by the engine.
//!
//! A port of `composeAgentSystemPrompt` (`src/apps/agent/services/runtime/
//! agent-prompt.ts`). Same sections, same order, same bytes: the tests below
//! compose every case in `golden/system-prompt/cases.json` and compare with
//! the file the window wrote for it.
//!
//! The prompt has two halves. The static half is the same for the whole
//! conversation and sits in the provider's prompt cache; the dynamic half
//! (mode, skills) follows [`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`], which the
//! Anthropic adapter splits on and every other adapter strips.
//!
//! What this does not decide: which skills exist and which are on (the skill
//! resolver, its own port), whether the project has an active plan (read
//! from disk by the caller), and the date (passed in, so a turn and its test
//! agree).

use serde::Deserialize;

use crate::agent_runtime::ipc::AgentExecutionMode;
use crate::api::provider_kernel_adapter::SYSTEM_PROMPT_DYNAMIC_BOUNDARY;

const BASE: &str = include_str!("prompts/base.md");
const CHAT_BASE: &str = include_str!("prompts/chat-base.md");
const DEEP_RESEARCH: &str = include_str!("prompts/deep-research.md");
const MODE_AGENT: &str = include_str!("prompts/mode-agent.md");
const MODE_AGENT_ACTIVE_PLAN: &str = include_str!("prompts/mode-agent-active-plan.md");
const MODE_PLAN: &str = include_str!("prompts/mode-plan.md");
const SURFACE_DOCTRINE: &str = include_str!("prompts/surface-doctrine.md");
const CANVAS: &str = include_str!("prompts/canvas.md");
const ANSWER_BOX_BUILD: &str = include_str!("prompts/answer-box-build.md");
const ANSWER_BOX_CHAT: &str = include_str!("prompts/answer-box-chat.md");
const REPLY_LAYOUT: &str = include_str!("prompts/reply-layout.md");
const SKILL_SYSTEM: &str = include_str!("prompts/skill-system.md");
const CHAPTERS: &str = include_str!("prompts/chapters.md");
const BROWSER: &str = include_str!("prompts/browser.md");
const OPTIONAL_TOOLS: &str = include_str!("prompts/optional-tools.md");
const OPTIONAL_TOOLS_CHAT: &str = include_str!("prompts/optional-tools-chat.md");
const ACCESS_READ: &str = include_str!("prompts/access-read.md");
const ACCESS_FULL: &str = include_str!("prompts/access-full.md");

/// A skill preview line is cut at this many UTF-16 units, as the window did.
const MAX_PREVIEW_SNIPPET_UNITS: usize = 200;

/// Everything the system prompt depends on.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SystemPromptInput {
    pub mode: AgentExecutionMode,
    pub workspace_path: Option<String>,
    /// `"workspace"`, `"read"` or `"full"` (Settings → file access).
    pub workspace_access: String,
    /// The project's `.aurora/*.md` rules, already rendered as `<project_rules>`.
    pub project_rules: Option<String>,
    /// The active global instruction set's text; empty when none.
    pub global_instructions: String,
    pub has_active_plan: bool,
    pub transcript_chapters: bool,
    pub reply_layout: bool,
    /// Fixed when an Aurora Chat conversation is created.
    pub deep_research: bool,
    /// The same value sent as the request's `browserTools` (default on).
    #[serde(default = "default_true")]
    pub browser_tools: bool,
    /// `YYYY-MM-DD`.
    pub today: String,
    pub skills: PromptSkills,
    /// A caller's own base prompt. The default base is chosen when absent or
    /// equal to it.
    pub base_prompt: Option<String>,
}

fn default_true() -> bool {
    true
}

/// The skills the resolver picked for this turn.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PromptSkills {
    /// Every skill that exists, enabled or not.
    pub total_count: usize,
    /// Switched on for this workspace: previewed in the catalogue.
    pub enabled: Vec<PromptSkill>,
    /// Attached to this message with `/`: authoritative for the turn.
    pub explicit: Vec<PromptSkill>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PromptSkill {
    pub id: String,
    pub description: String,
    pub preview_lines: Vec<String>,
    /// `"workspace"`, `"global"` or `"builtin"`.
    pub source: String,
    pub source_path: Option<String>,
}

/// Compose the system prompt for one turn.
#[must_use]
pub fn compose_system_prompt(input: &SystemPromptInput) -> String {
    let chat = input.mode.is_chat();
    let workspace = if chat { None } else { input.workspace_path.as_deref() };
    let has_active_plan = !chat && input.has_active_plan;

    // ── Static half: the same bytes for the whole conversation.
    // Aurora Chat REPLACES the coding prompt rather than appending to it; a
    // caller's own prompt still wins in either mode.
    let custom = input
        .base_prompt
        .as_deref()
        .map(str::trim)
        .filter(|requested| !requested.is_empty() && *requested != BASE.trim());
    let mut sections: Vec<String> =
        vec![custom.map_or_else(|| if chat { CHAT_BASE } else { BASE }.to_string(), str::to_string)];

    if !chat {
        sections.push(format_environment(workspace, &input.workspace_access, &input.today));
        sections.push(input.project_rules.as_deref().unwrap_or_default().trim().to_string());
        sections.push(SURFACE_DOCTRINE.to_string());
    }
    sections.push(CANVAS.to_string());
    sections.push(if chat { ANSWER_BOX_CHAT } else { ANSWER_BOX_BUILD }.to_string());
    if !chat {
        sections.push(SKILL_SYSTEM.to_string());
    }
    if chat && input.deep_research {
        sections.push(DEEP_RESEARCH.to_string());
    }
    if input.browser_tools && !chat {
        sections.push(BROWSER.to_string());
    }
    if input.transcript_chapters {
        sections.push(CHAPTERS.to_string());
    }
    if input.reply_layout {
        sections.push(REPLY_LAYOUT.to_string());
    }
    sections.push(if chat { OPTIONAL_TOOLS_CHAT } else { OPTIONAL_TOOLS }.to_string());
    if !chat {
        let global = input.global_instructions.trim();
        if !global.is_empty() {
            sections.insert(1, format_global_instructions(global));
        }
    }

    // ── Dynamic half: mode and skills.
    let mut dynamic: Vec<String> = vec![mode_section(input.mode, has_active_plan).to_string()];
    if !chat && !input.skills.enabled.is_empty() {
        dynamic.push(format_skill_catalog(&input.skills.enabled, input.skills.total_count));
    }
    if !input.skills.explicit.is_empty() {
        dynamic.push(format_skill_references(&input.skills.explicit, "required_skills"));
    }

    let static_text = join_present(&sections);
    let dynamic_text = join_present(&dynamic);
    if dynamic_text.is_empty() {
        static_text
    } else {
        format!("{static_text}\n\n{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\n\n{dynamic_text}")
    }
}

/// Join the non-empty sections with a blank line, as `filter(Boolean)` did.
fn join_present(parts: &[String]) -> String {
    parts
        .iter()
        .filter(|part| !part.is_empty())
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn mode_section(mode: AgentExecutionMode, has_active_plan: bool) -> &'static str {
    match mode {
        AgentExecutionMode::Chat => "",
        AgentExecutionMode::Plan => MODE_PLAN,
        AgentExecutionMode::Agent if has_active_plan => MODE_AGENT_ACTIVE_PLAN,
        AgentExecutionMode::Agent => MODE_AGENT,
    }
}

/// Where the model is working, stated once in the cached half.
fn format_environment(workspace: Option<&str>, access: &str, today: &str) -> String {
    let Some(root) = workspace.map(str::trim).filter(|root| !root.is_empty()) else {
        return String::new();
    };
    let mut lines = vec![
        "Here is some useful information about the environment you are running in:".to_string(),
        "<env>".to_string(),
        format!("  Workspace root: {root}"),
        format!("  Today's date: {today}"),
        "</env>".to_string(),
        "You are working inside this project directory. Use your tools (code, workspace_tree, file_read, grep, …) to explore and edit files here.".to_string(),
    ];
    let rule = match access {
        "read" => ACCESS_READ,
        "full" => ACCESS_FULL,
        _ => "",
    };
    if !rule.is_empty() {
        lines.push(rule.to_string());
    }
    lines.join("\n")
}

fn format_global_instructions(instructions: &str) -> String {
    format!(
        "<user_global_instructions>\nThe user has set the following global instructions that apply to EVERY workspace and task. Treat them as standing rules with high priority — follow them unless the user's explicit message this turn directs otherwise.\n\n{instructions}\n</user_global_instructions>"
    )
}

/// Cut a preview line the way JavaScript's `slice` did: by UTF-16 units.
fn clip_preview_line(line: &str) -> String {
    let units: Vec<u16> = line.encode_utf16().collect();
    if units.len() <= MAX_PREVIEW_SNIPPET_UNITS {
        return line.to_string();
    }
    format!("{}…", String::from_utf16_lossy(&units[..MAX_PREVIEW_SNIPPET_UNITS - 1]))
}

fn source_label(skill: &PromptSkill) -> &'static str {
    match skill.source.as_str() {
        "workspace" => "project",
        "global" => "global",
        _ => "built-in",
    }
}

fn plural(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
}

/// The `<agent_skills>` catalogue: id, description and a short preview of each
/// enabled skill, never the full body (`aurora_skill_load` fetches that).
fn format_skill_catalog(enabled: &[PromptSkill], total: usize) -> String {
    let count = enabled.len();
    let remaining = total.saturating_sub(count);
    let blocks: Vec<String> = enabled
        .iter()
        .map(|skill| {
            let preview: Vec<String> = skill.preview_lines.iter().map(|l| clip_preview_line(l)).collect();
            let section = if preview.is_empty() {
                "  (no preview available — load with aurora_skill_load to read the full body)".to_string()
            } else {
                preview.iter().map(|line| format!("  {line}")).collect::<Vec<_>>().join("\n")
            };
            format!(
                "### `{}` ({})\n{}\nPreview (first {} non-empty line{}):\n{}",
                skill.id,
                source_label(skill),
                skill.description,
                preview.len(),
                plural(preview.len()),
                section,
            )
        })
        .collect();
    let footer = if remaining > 0 {
        format!(
            "\n\n{remaining} additional skill{} available. Use `aurora_skill_search` to browse them or `aurora_skill_load` to fetch a specific one.",
            if remaining == 1 { " is" } else { "s are" },
        )
    } else {
        String::new()
    };
    format!(
        "<agent_skills count=\"{count}\" total=\"{total}\">\nThe user has enabled {count} skill{} for this workspace. Apply them when the task benefits; load the full SKILL.md via `aurora_skill_load` if the preview suggests it is relevant.\n\n{}{footer}\n</agent_skills>",
        plural(count),
        blocks.join("\n\n"),
    )
}

/// Skills attached to this message, as an authoritative block.
fn format_skill_references(skills: &[PromptSkill], label: &str) -> String {
    let refs: Vec<String> = skills
        .iter()
        .map(|skill| {
            let preview: Vec<String> = skill.preview_lines.iter().map(|l| clip_preview_line(l)).collect();
            let section = if preview.is_empty() {
                String::new()
            } else {
                format!(
                    "\n  Preview:\n{}",
                    preview.iter().map(|line| format!("    {line}")).collect::<Vec<_>>().join("\n"),
                )
            };
            match skill.source_path.as_deref().filter(|path| !path.is_empty()) {
                Some(path) => format!(
                    "- `{}` — {}\n  Path: {path} (load via aurora_skill_load if you need the full body).{section}",
                    skill.id, skill.description,
                ),
                None => format!("- `{}` — {}{section}", skill.id, skill.description),
            }
        })
        .collect();
    format!(
        "<{label} count=\"{}\">\nThe user explicitly attached the following skill{} to this turn. Treat them as authoritative.\n\n{}\n</{label}>",
        skills.len(),
        plural(skills.len()),
        refs.join("\n"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOLDEN_DIR: &str =
        concat!(env!("CARGO_MANIFEST_DIR"), "/src/agent_runtime/turn_build/golden/system-prompt");

    #[derive(Deserialize)]
    struct GoldenCase {
        name: String,
        input: SystemPromptInput,
    }

    fn cases() -> Vec<GoldenCase> {
        let raw = std::fs::read_to_string(format!("{GOLDEN_DIR}/cases.json"))
            .expect("golden cases.json (written by agent-prompt.golden.test.ts)");
        serde_json::from_str(&raw).expect("cases.json parses")
    }

    /// The engine composes, for every case the window recorded, the exact
    /// bytes the window sent.
    #[test]
    fn composes_the_same_prompt_the_window_did() {
        let cases = cases();
        assert!(cases.len() >= 12, "only {} cases", cases.len());
        for case in cases {
            let expected = std::fs::read_to_string(format!("{GOLDEN_DIR}/{}.txt", case.name))
                .unwrap_or_else(|e| panic!("golden {}: {e}", case.name));
            let composed = compose_system_prompt(&case.input);
            if composed != expected {
                let at = composed
                    .chars()
                    .zip(expected.chars())
                    .position(|(a, b)| a != b)
                    .unwrap_or_else(|| composed.chars().count().min(expected.chars().count()));
                let window = |s: &str| s.chars().skip(at.saturating_sub(80)).take(200).collect::<String>();
                panic!(
                    "case {}: differs at char {at}\n--- engine ---\n{}\n--- window ---\n{}",
                    case.name,
                    window(&composed),
                    window(&expected),
                );
            }
        }
    }

    #[test]
    fn a_long_preview_line_is_cut_by_utf16_units() {
        let line = "😀".repeat(150); // 300 UTF-16 units
        let clipped = clip_preview_line(&line);
        assert_eq!(clipped.encode_utf16().count(), 200);
        assert!(clipped.ends_with('…'));
        assert_eq!(clip_preview_line("short"), "short");
    }

    #[test]
    fn a_custom_base_prompt_replaces_the_default_but_the_default_text_does_not() {
        let mut input = SystemPromptInput { browser_tools: true, ..Default::default() };
        input.base_prompt = Some(format!("  {}  ", BASE.trim()));
        assert!(compose_system_prompt(&input).starts_with(BASE));
        input.base_prompt = Some("You are a reviewer.".into());
        assert!(compose_system_prompt(&input).starts_with("You are a reviewer.\n\n"));
    }
}
