//! Agent definitions — the templates a sub-agent is started from.
//!
//! A definition is a name, a description the parent reads when choosing, a
//! system prompt, default tools, a capability ceiling, and optionally a model. Five
//! ship built in; the user adds more as one Markdown file each under
//! `~/.aurora/agents/`, in the shape skills already use:
//!
//! ```markdown
//! ---
//! name: migration-writer
//! description: Writes a database migration for one schema change
//! tools: file_read, file_write, grep, glob
//! model: anthropic:claude-opus-5-5
//! ---
//! You write migrations. Read the current schema first ...
//! ```
//!
//! `name` falls back to the file stem, `tools` to the general-purpose roster,
//! and `model` to whatever the parent decides. The body is the prompt.
//!
//! ## The roster is an allow-list
//!
//! A definition names what its child MAY call. Nothing is subtracted from the
//! parent's roster: a tool added to Aurora next month is unavailable to every
//! child until a definition names it. That is the same discipline Aurora Chat's
//! roster uses, and for the same reason — a deny-list is only right for the
//! tools that existed when it was written. On top of the allow-list sits
//! [`NEVER_FOR_CHILDREN`], which no definition can override.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Default definition when the parent names none.
pub const DEFAULT_AGENT_TYPE: &str = "general-purpose";

/// Tools no child may ever call, whatever its definition says.
///
/// - The sub-agent tools themselves: one level of delegation is the
///   supported shape, and the guard is here rather than in a prompt.
/// - Anything that asks the user something or waits on the window. A child
///   has no composer; its question would hang until the parent gave up.
/// - The parent's checklist and plan tools. Those render in the parent's
///   header and plan canvas keyed by thread, and a child writing them would
///   draw its own bookkeeping over the user's.
/// - Chat-only tools, which need a chat store the child does not have.
pub const NEVER_FOR_CHILDREN: &[&str] = &[
    "spawn_agent",
    "send_message",
    "get_task_output",
    "stop_agent",
    "list_models",
    "ask_question",
    "present_artifact",
    "read_artifact",
    "chapter",
    "plan_write",
    "plan_read",
    "plan_step_update",
    "TaskCreate",
    "TaskUpdate",
    "TaskList",
    "recall",
    "remember",
    "generate_image",
    "generate_video",
    "report_aurora_issue",
    "tool_search",
    "call_tool",
];

/// The original file/shell roster, retained for legacy grants and custom defaults.
///
/// This is the contract's "read, search, file edit, file write, shell, and
/// nothing else to start with", plus `code`, which is how Aurora searches a
/// codebase structurally and belongs with `grep`.
pub const GENERAL_PURPOSE_TOOLS: &[&str] = &[
    "file_read",
    "file_edit",
    "file_write",
    "move_path",
    "delete_path",
    "folder_create",
    "glob",
    "grep",
    "workspace_tree",
    "code",
    "shell_execute",
    "shell_spawn",
    "shell_kill",
    "shell_list_processes",
    "shell_read_output",
];

/// The read-only roster: look, never touch.
pub const READ_ONLY_TOOLS: &[&str] = &["file_read", "glob", "grep", "workspace_tree", "code"];

/// Where a definition came from. Recorded on the child's sidecar so a resume
/// months later can say which file it was built from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "path")]
pub enum DefinitionSource {
    BuiltIn,
    User(PathBuf),
}

/// One reusable agent template.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentDefinition {
    pub name: String,
    pub description: String,
    /// The child's instructions. The runtime wraps this in the sub-agent
    /// framing (`super::prompt`); this is only the part that says what the
    /// agent is for.
    pub system_prompt: String,
    /// Tools the child may call, already filtered against
    /// [`NEVER_FOR_CHILDREN`]. Order is the roster order.
    pub tools: Vec<String>,
    /// Capability ceiling. A per-spawn grant may narrow this, never exceed it.
    pub allowed_tools: Vec<String>,
    /// `providerId:modelKey` the child should run on, when the definition
    /// pins one. `None` defers to the parent's choice.
    pub model: Option<String>,
    pub source: DefinitionSource,
}

impl AgentDefinition {
    /// Whether this definition lets its child call `tool`.
    #[must_use]
    pub fn allows(&self, tool: &str) -> bool {
        !NEVER_FOR_CHILDREN.contains(&tool) && self.allowed_tools.iter().any(|t| t == tool)
    }

    fn built_in(name: &str, description: &str, prompt: &str, tools: &[&str], allowed: &[&str]) -> Self {
        Self {
            name: name.to_string(),
            description: description.to_string(),
            system_prompt: prompt.trim().to_string(),
            tools: filter_tools(tools.iter().map(|t| (*t).to_string())),
            allowed_tools: filter_tools(allowed.iter().map(|t| (*t).to_string())),
            model: None,
            source: DefinitionSource::BuiltIn,
        }
    }
}

/// Drop anything a child may never have, keep order, drop duplicates.
fn filter_tools(tools: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tool in tools {
        let tool = tool.trim().to_string();
        if tool.is_empty() || NEVER_FOR_CHILDREN.contains(&tool.as_str()) {
            continue;
        }
        if !out.contains(&tool) {
            out.push(tool);
        }
    }
    out
}

const GENERAL_PURPOSE_PROMPT: &str = r"
You are a general-purpose coding agent. You take one well-defined task — a
change to make, a question to answer about the code, a command to run and
interpret — and carry it through to a result the parent agent can act on
without redoing your work.

Work the way a careful engineer would: read before you change, make the
smallest change that is correct, run what verifies it, and report exactly what
you did and what you saw. If the task turns out to be impossible or
ill-defined, say so plainly and say what you learned trying.
";

const EXPLORE_PROMPT: &str = r"
You are a code explorer. You answer questions about a codebase by reading it:
where something is defined, how a feature flows, what calls what, which files
would be touched by a change. You never modify anything.

Be concrete. Every claim names a file and a line. When the answer is 'it is not
there', say where you looked. Prefer the code index and grep over guessing from
names, and say when a result is a text match rather than a confirmed
relationship.
";

const REVIEWER_PROMPT: &str = r"
You are a code reviewer. You read a change — a diff, a set of files, a branch —
and report what is wrong with it, in order of how much it matters: bugs and
behaviour changes first, then missing error handling, then anything that will
mislead the next reader. You do not fix anything; you report.

For each finding give the file and line, what the code does, what it should
do, and how you know. Skip style unless it hides a bug. If the change is
sound, say so in one line and stop.
";

/// Every definition available right now.
#[derive(Debug, Clone, Default)]
pub struct Catalog {
    by_name: BTreeMap<String, AgentDefinition>,
}

impl Catalog {
    /// The five built-ins and nothing else.
    #[must_use]
    pub fn built_in() -> Self {
        let mut catalog = Self::default();
        let mut general = GENERAL_PURPOSE_TOOLS.to_vec();
        general.extend(["auroro_websearch", "design_guidelines"]);
        let mut general_allowed = general.clone();
        general_allowed.push("canvas_guidelines");
        let mut research = READ_ONLY_TOOLS.to_vec();
        research.push("auroro_websearch");
        let mut read_allowed = research.clone();
        read_allowed.extend(["design_guidelines", "canvas_guidelines"]);
        let mut verifier = READ_ONLY_TOOLS.to_vec();
        verifier.extend(["shell_execute", "shell_spawn", "shell_kill", "shell_list_processes", "shell_read_output"]);
        for def in [
            AgentDefinition::built_in(
                DEFAULT_AGENT_TYPE,
                "Does one coding task end to end, with files, shell, web research and design guidance.",
                GENERAL_PURPOSE_PROMPT,
                &general,
                &general_allowed,
            ),
            AgentDefinition::built_in(
                "explore",
                "Answers a question about the codebase by reading it. Read-only.",
                EXPLORE_PROMPT,
                READ_ONLY_TOOLS,
                &read_allowed,
            ),
            AgentDefinition::built_in(
                "reviewer",
                "Reviews a change and reports problems in order of severity. Read-only.",
                REVIEWER_PROMPT,
                READ_ONLY_TOOLS,
                &read_allowed,
            ),
            AgentDefinition::built_in(
                "researcher",
                "Researches source code and official web documentation. No file editing or shell tools.",
                "You research one question using source code and primary documentation. Cite real file locations and source URLs. Distinguish facts from inference, record uncertainty, and never invent findings.",
                &research,
                &read_allowed,
            ),
            AgentDefinition::built_in(
                "verifier",
                "Runs tests, builds and checks, then reports commands, results and failures. No file editing tools.",
                "You verify one implementation. Read the project instructions and relevant code, run the actual checks, and report the commands, exit codes and useful output. Do not fix source code or change scope. Stop processes you started before submitting your report. A passing command proves only what it checked.",
                &verifier,
                &verifier,
            ),
        ] {
            catalog.by_name.insert(def.name.clone(), def);
        }
        catalog
    }

    /// Built-ins plus every readable definition under `user_dir`.
    ///
    /// A user file with the same name as a built-in replaces it — the user's
    /// idea of a reviewer wins over Aurora's. A file that cannot be parsed is
    /// skipped with a logged warning rather than failing the whole catalog:
    /// one broken definition must not take sub-agents away.
    #[must_use]
    pub fn load(user_dir: &Path) -> Self {
        let mut catalog = Self::built_in();
        let Ok(entries) = std::fs::read_dir(user_dir) else {
            return catalog;
        };
        let mut paths: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "md"))
            .collect();
        paths.sort();
        for path in paths {
            match std::fs::read_to_string(&path) {
                Ok(text) => match parse_definition_file(&path, &text) {
                    Ok(def) => {
                        catalog.by_name.insert(def.name.clone(), def);
                    }
                    Err(why) => crate::logging::log_warn(
                        "subagents.catalog",
                        &format!("skipping agent definition {}: {why}", path.display()),
                    ),
                },
                Err(err) => crate::logging::log_warn(
                    "subagents.catalog",
                    &format!("could not read agent definition {}: {err}", path.display()),
                ),
            }
        }
        catalog
    }

    /// The user's definitions directory: `~/.aurora/agents/`.
    #[must_use]
    pub fn user_dir() -> PathBuf {
        crate::paths::aurora_home_dir().join("agents")
    }

    #[must_use]
    pub fn get(&self, name: &str) -> Option<&AgentDefinition> {
        self.by_name.get(name.trim())
    }

    /// Definitions in name order — the order the parent is shown them in.
    pub fn iter(&self) -> impl Iterator<Item = &AgentDefinition> {
        self.by_name.values()
    }

    #[must_use]
    pub fn names(&self) -> Vec<String> {
        self.by_name.keys().cloned().collect()
    }

    /// Resolve the parent's `agentType`, or explain what it could have been.
    ///
    /// The error lists every available type, because the model that got the
    /// name wrong needs the right names to try again and has no other way to
    /// see them.
    pub fn resolve(&self, agent_type: Option<&str>) -> Result<&AgentDefinition, String> {
        let wanted = agent_type
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_AGENT_TYPE);
        self.get(wanted).ok_or_else(|| {
            format!(
                "unknown agentType {wanted:?}. Available: {}",
                self.names().join(", ")
            )
        })
    }

    /// One line per definition, for the spawn tool's description and for the
    /// system prompt's sub-agent section.
    #[must_use]
    pub fn describe(&self) -> String {
        self.iter()
            .map(|def| format!("- `{}`: {} Default tools: {}. Allowed tools: {}.",
                def.name, def.description, def.tools.join(", "), def.allowed_tools.join(", ")))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// Parse one `~/.aurora/agents/*.md` file.
fn parse_definition_file(path: &Path, text: &str) -> Result<AgentDefinition, String> {
    let (front, body) = split_frontmatter(text);
    let mut fields: BTreeMap<String, String> = BTreeMap::new();
    for line in front.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            return Err(format!("frontmatter line {line:?} is not `key: value`"));
        };
        fields.insert(
            key.trim().to_ascii_lowercase(),
            value.trim().trim_matches('"').trim_matches('\'').to_string(),
        );
    }
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("agent")
        .to_string();
    let name = fields.get("name").cloned().unwrap_or(stem);
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!(
            "name {name:?} must be letters, digits, `-` or `_` (it is used as a tool argument)"
        ));
    }
    let description = fields
        .get("description")
        .cloned()
        .filter(|d| !d.is_empty())
        .ok_or_else(|| "`description` is required — the parent chooses by it".to_string())?;
    let prompt = body.trim();
    if prompt.is_empty() {
        return Err("the body (the agent's prompt) is empty".to_string());
    }
    let tools = match fields.get("tools") {
        Some(list) if !list.trim().is_empty() => {
            let parsed = filter_tools(list.split(',').map(str::to_string));
            if parsed.is_empty() {
                return Err(format!(
                    "`tools: {list}` names nothing a sub-agent may call"
                ));
            }
            parsed
        }
        _ => filter_tools(GENERAL_PURPOSE_TOOLS.iter().map(|t| (*t).to_string())),
    };
    let model = fields
        .get("model")
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty());
    let allowed_tools = fields.get("allowed-tools").map(|list| {
        filter_tools(list.split(',').map(str::to_string))
    }).unwrap_or_else(|| tools.clone());
    if tools.iter().any(|tool| !allowed_tools.contains(tool)) {
        return Err("`allowed-tools` must include every default tool named in `tools`".into());
    }
    Ok(AgentDefinition {
        name,
        description,
        system_prompt: prompt.to_string(),
        tools,
        allowed_tools,
        model,
        source: DefinitionSource::User(path.to_path_buf()),
    })
}

/// Split `---\n…\n---\nbody` into (frontmatter, body). A file without a
/// frontmatter block is all body.
fn split_frontmatter(text: &str) -> (&str, &str) {
    let trimmed = text.trim_start_matches('\u{feff}');
    let Some(rest) = trimmed.strip_prefix("---") else {
        return ("", trimmed);
    };
    let rest = rest.trim_start_matches(['\r', '\n']);
    // The closing fence is a line that is exactly `---`.
    let mut offset = 0usize;
    for line in rest.split_inclusive('\n') {
        if line.trim_end_matches(['\r', '\n']) == "---" {
            let front = &rest[..offset];
            let body = &rest[offset + line.len()..];
            return (front, body);
        }
        offset += line.len();
    }
    ("", trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_ins_exist_and_never_carry_forbidden_tools() {
        let catalog = Catalog::built_in();
        assert_eq!(catalog.names(), vec!["explore", "general-purpose", "researcher", "reviewer", "verifier"]);
        for def in catalog.iter() {
            for tool in &def.tools {
                assert!(
                    !NEVER_FOR_CHILDREN.contains(&tool.as_str()),
                    "{} carries forbidden tool {tool}",
                    def.name
                );
            }
            assert!(!def.allows("spawn_agent"));
            assert!(!def.allows("ask_question"));
        }
        assert!(catalog.get("general-purpose").unwrap().allows("file_write"));
        assert!(!catalog.get("explore").unwrap().allows("file_write"));
        assert!(catalog.get("explore").unwrap().allows("grep"));
    }

    #[test]
    fn resolve_defaults_and_lists_the_alternatives_on_a_miss() {
        let catalog = Catalog::built_in();
        assert_eq!(catalog.resolve(None).unwrap().name, DEFAULT_AGENT_TYPE);
        assert_eq!(catalog.resolve(Some("  ")).unwrap().name, DEFAULT_AGENT_TYPE);
        let err = catalog.resolve(Some("janitor")).unwrap_err();
        assert!(err.contains("janitor"), "{err}");
        assert!(err.contains("explore") && err.contains("reviewer"), "{err}");
    }

    #[test]
    fn a_user_file_parses_and_overrides_a_built_in() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("reviewer.md"),
            "---\nname: reviewer\ndescription: My reviewer\ntools: file_read, grep, spawn_agent, ask_question\nmodel: fireworks:glm-5.2\n---\nReview like I would.\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("docs.md"),
            "---\ndescription: Writes docs\n---\nWrite the docs.\n",
        )
        .unwrap();
        // Broken: no description. Skipped, not fatal.
        std::fs::write(dir.path().join("broken.md"), "---\nname: broken\n---\nbody\n").unwrap();
        // Not a definition at all.
        std::fs::write(dir.path().join("notes.txt"), "ignore me").unwrap();

        let catalog = Catalog::load(dir.path());
        let reviewer = catalog.get("reviewer").unwrap();
        assert_eq!(reviewer.description, "My reviewer");
        assert_eq!(reviewer.tools, vec!["file_read", "grep"], "forbidden tools are dropped");
        assert_eq!(reviewer.model.as_deref(), Some("fireworks:glm-5.2"));
        assert_eq!(reviewer.system_prompt, "Review like I would.");
        assert!(matches!(reviewer.source, DefinitionSource::User(_)));

        let docs = catalog.get("docs").unwrap();
        assert_eq!(docs.name, "docs", "name falls back to the file stem");
        assert_eq!(docs.tools, GENERAL_PURPOSE_TOOLS);

        assert!(catalog.get("broken").is_none());
        assert_eq!(catalog.names().len(), 6);
    }

    #[test]
    fn a_missing_user_dir_is_just_the_built_ins() {
        let dir = tempfile::tempdir().unwrap();
        let catalog = Catalog::load(&dir.path().join("does-not-exist"));
        assert_eq!(catalog.names().len(), 5);
    }

    #[test]
    fn frontmatter_splits_on_the_closing_fence_only() {
        let (front, body) = split_frontmatter("---\na: 1\n---\nbody --- not a fence\n");
        assert_eq!(front, "a: 1\n");
        assert_eq!(body, "body --- not a fence\n");
        let (front, body) = split_frontmatter("no front\n");
        assert_eq!(front, "");
        assert_eq!(body, "no front\n");
    }
}
