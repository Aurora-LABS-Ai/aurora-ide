//! The child's system prompt, and the parent's instructions for using it.
//!
//! The parent's prompt is composed by the window; the child has no window,
//! so its prompt is composed here. It is deliberately short: the definition
//! says what the agent is for, this file says what it means to be a
//! sub-agent, and the runtime appends `<machine_tools>` as it does for every
//! project conversation.

use super::catalog::{AgentDefinition, Catalog};
use crate::tools::subagents::{
    message_parent::MESSAGE_PARENT_TOOL, submit_report::SUBMIT_REPORT_TOOL,
};

/// What a child that ended without `submit_report` is told, once. Arrives as
/// Aurora's note (a process beat in the agent's tab), not as the parent's
/// words.
pub const REPORT_REMINDER: &str = "You ended your turn without calling submit_report. The \
     parent receives nothing until you do: it does not see your messages or your tool calls. \
     Call submit_report now with outcome, summary and the full report of what you did and \
     found (exact paths and line numbers), and changedFiles if you changed any. If the work is \
     not finished, submit what you have with outcome \"partial\" or \"blocked\" and say what is \
     left. Do not start new work.";

/// One line of guidance per native tool a child may hold, in the words the
/// main conversation's prompt (`agent-prompt.ts`) uses, cut to what a child
/// needs. Only the lines for tools the child actually has are included.
///
/// A child used to get its tool SCHEMAS and no guidance at all. On the
/// 2026-10-08 live run three deepseek-flash children made seven calls to tools
/// that do not exist (`read_file`, `read`, `read_file_placeholder`), passing
/// `file_read`'s argument shape under a name from some other agent. A main
/// conversation on the same model, which gets the full guide, does not.
const TOOL_GUIDE: &[(&str, &str)] = &[
    (
        "file_read",
        "`file_read` takes `path` as an ARRAY of paths: one entry for one file, several to read \
         them at once. Start without a line range; a large file says how long it is and where to \
         continue with `start_line`/`end_line`, or pass `force_full_content: true` to take all \
         of it. Every line comes back numbered (`  12<tab>const x = 1;` is line 12): use those \
         numbers when you report `path:line`, never count lines yourself. The number and the \
         tab are not part of the file.",
    ),
    (
        "workspace_tree",
        "`workspace_tree` shows the folder structure (`path`, `depth`). On unfamiliar code, look \
         at the structure first, then read the files that matter.",
    ),
    (
        "glob",
        "`glob` finds files by name (`pattern`, such as `src/**/*.ts`, and an optional `path`).",
    ),
    (
        "grep",
        "`grep` searches file contents (`pattern`; `is_regex: true` for a regular expression; \
         `path` and `glob` narrow it; `context_lines` shows the lines around a match). A match is \
         a location, not yet a reason: read the code around it before you rely on it.",
    ),
    (
        "code",
        "`code` answers questions about structure from Aurora's local code index: `op` \
         `definition`, `usages`, `outline` or `modules` for symbols and files, and `op: \"search\"` \
         with `query` for ranked word matches in source. No usages found is not proof that code \
         is unused; read the source before concluding.",
    ),
    (
        "file_edit",
        "`file_edit` replaces exact text: `path`, `old_string`, `new_string`, or several changes in \
         its `edits` array. `old_string` is the file's literal text exactly as `file_read` printed \
         it after each line's number and tab (never the number or tab), so read the file first. \
         Prefer it to rewriting a whole file.",
    ),
    (
        "file_write",
        "`file_write` writes a whole file (`path`, `content`). Use it for new files; change \
         existing ones with `file_edit`.",
    ),
    (
        "move_path",
        "`move_path`, `delete_path` and `folder_create` move, delete and create files and \
         folders inside the workspace.",
    ),
    (
        "shell_execute",
        "`shell_execute` runs a command. Name the `shell` (bash, pwsh, …) and write the `command` \
         in that shell's syntax only. Every call starts in the workspace root; put `cd sub && …` \
         in the command or pass `cwd`. Pass `timeout` for slow builds and test runs. \
         `timedOut: true` means it was still working when it was stopped, not that it failed. \
         Read the output yourself before you say a check passed.",
    ),
    (
        "shell_spawn",
        "`shell_spawn` starts something with no natural end (a dev server, a watcher). Follow it \
         with `shell_read_output` (`start_line`, `wait_ms`), list what you started with \
         `shell_list_processes`, and stop it with `shell_kill` before you finish.",
    ),
];

/// The "## Your tools" section for a child holding `roster`.
fn tools_section(roster: &[String]) -> String {
    let has = |name: &str| roster.iter().any(|t| t == name);
    let mut names: Vec<&str> = roster.iter().map(String::as_str).collect();
    for own in [MESSAGE_PARENT_TOOL, SUBMIT_REPORT_TOOL] {
        if !names.contains(&own) {
            names.push(own);
        }
    }
    let list = names
        .iter()
        .map(|n| format!("`{n}`"))
        .collect::<Vec<_>>()
        .join(", ");
    let mut out = format!(
        "## Your tools\n\n\
         You have exactly these tools: {list}. Call them by these exact names. No other tool \
         exists here, not `read_file`, `read`, `bash`, `ls`, `edit` or any name you know from \
         somewhere else; a call to any other name fails and wastes a step. If the task needs a \
         tool you do not have, say so with `{MESSAGE_PARENT_TOOL}` and do what you can without \
         it.\n\n"
    );
    for (tool, line) in TOOL_GUIDE {
        // `move_path` speaks for its two siblings; any of the three brings it.
        let present = if *tool == "move_path" {
            has("move_path") || has("delete_path") || has("folder_create")
        } else {
            has(tool)
        };
        if present {
            out.push_str("- ");
            out.push_str(line);
            out.push('\n');
        }
    }
    out.push_str(
        "- Make independent calls together in one step (several reads, several searches) rather \
         than one per step. Only a call that needs an earlier result waits for it.\n",
    );
    if has("file_read") {
        out.push_str(
            "- Large tool output is MOVED to a file, never cut. A result that says `bytes hidden \
             — full output: <path>`, or carries `fullResult`, keeps the rest at that path: read \
             it with `file_read` or search it with `grep`.\n",
        );
    }
    out.push_str(
        "- If the same call fails twice for the same reason, stop repeating it: read the error \
         and change approach.\n",
    );
    out
}

/// Compose a child's full system prompt.
///
/// `workspace` is the project root the child's file tools resolve against.
#[must_use]
pub fn child_system_prompt(def: &AgentDefinition, workspace: Option<&str>) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "You are `{}`, a sub-agent running inside Aurora. A parent agent started you to do one \
         task and carries on with its own work while you do. Nobody watches this conversation: \
         the parent sees only the report you submit at the end.\n\n",
        def.name
    ));
    out.push_str(def.system_prompt.trim());
    out.push_str("\n\n");
    out.push_str(&tools_section(&def.tools));
    out.push_str("\n## Working as a sub-agent\n\n");
    out.push_str(&format!(
        "- There is no user here. Nobody on this conversation can answer a question. The parent \
         can: `{MESSAGE_PARENT_TOOL}` sends it a message while you keep working, and its answer \
         comes back to you as a message. Use it the MOMENT the task cannot be done as asked: a \
         tool you need and do not have (name it), a path that does not exist, a contradiction in \
         the brief, a decision only the parent can make. Say exactly what you need. Do not use it \
         for progress updates or for your report. When you cannot go on without the answer, set \
         `waitForReply: true`: the call holds for up to two minutes and returns the parent's \
         answer, so you act on it in this same run. When you can carry on regardless, leave it \
         off and continue; the answer arrives later as a message.\n\
         - When something is merely ambiguous, pick the reasonable reading, state the assumption \
         in your report, and continue.\n\
         - Stay on the task you were given. Do not start adjacent work, and do not undo or \
         rewrite things outside its scope.\n\
         - The parent may send you a message while you work or after you finish. Treat it as the \
         next instruction, and submit a new report when that work is done.\n"
    ));
    out.push_str("\n## Finishing\n\n");
    out.push_str(&format!(
        "- You finish by calling `{SUBMIT_REPORT_TOOL}`. The parent reads that report and \
         nothing else: not your messages, not your tool calls, not their output. A turn that ends \
         without it leaves the parent with nothing.\n\
         - `outcome`: `done` when the task is complete as asked, `partial` when some of it is, \
         `blocked` when it could not be done. Say which part is missing or what stopped you.\n\
         - `summary`: one to three sentences the parent can act on without reading further.\n\
         - `report`: everything the parent needs and could not see: what you did, what you found \
         with exact file paths and line numbers, what you verified and how (the command and what \
         it printed), and anything left undone or uncertain. Write it to a colleague, not as \
         chat. Do not paste whole files.\n\
         - `changedFiles`: every file you created, changed, moved or deleted. Leave it out if you \
         changed nothing.\n\
         - Then end your turn with one short line and no more tool calls.\n"
    ));
    out.push_str("\n<env>\n");
    match workspace {
        Some(root) if !root.trim().is_empty() => {
            out.push_str(&format!("Workspace: {}\n", root.trim()));
        }
        _ => out.push_str("Workspace: none (no project is open)\n"),
    }
    out.push_str(&format!("Platform: {}\n", std::env::consts::OS));
    out.push_str(&format!(
        "Date: {}\n",
        chrono::Utc::now().format("%Y-%m-%d")
    ));
    out.push_str("</env>");
    out
}

/// The section appended to the PARENT's system prompt when sub-agents are
/// on: when to delegate, what each definition is, and the mechanics of
/// waiting, messaging and background work.
#[must_use]
pub fn parent_instructions(catalog: &Catalog) -> String {
    format!(
        "## Sub-agents\n\n\
         You can start sub-agents: separate agents with their own conversation, their own tool \
         roster and one task, running in this workspace. Use them for work that is parallel, \
         long, or noisy — exploring a large codebase, running a slow verification, reviewing a \
         change — so the detail stays out of this conversation and only the result comes back. \
         Do not use them for small, sequential edits you can make directly; a sub-agent costs a \
         fresh context and sees nothing of this conversation.\n\n\
         Types available:\n{types}\n\n\
         How it works: every agent you start runs in the background. You are told, as messages \
         in this conversation, when an agent finishes (its report) and whenever it needs \
         something from you before that: a tool it lacks, a path that is wrong, a decision only \
         you can make. Answer those with `send_message`. A message titled `Question from` is \
         an agent paused for your answer (for up to two minutes): answer it before anything \
         else, and it continues in the same run. Do not poll, check on or wait for \
         agents. Do work that does not depend on them, or, when there is none, tell the user \
         what is running and end your turn; their reports start you again.\n\n\
         Reports: each one arrives as a `<subagent_report>` with an `outcome` (`done`, \
         `partial`, `blocked`), a `Summary:` line, the files it changed, and the full report. \
         `partial` and `blocked` say what is missing; decide whether to send more work, do it \
         yourself, or tell the user. `outcome=\"not_submitted\"` means the agent never handed in \
         a report and you are reading its last message: check it before relying on it. \
         `outcome=\"stopped\"` means it was stopped before it handed one in; the report says who \
         stopped it and lists what it was doing. When the USER stopped an agent, that is their \
         decision: do not restart it, resume it or redo its work unless they ask. A long \
         report arrives as its head and tail plus the path of a file holding all of it; read \
         that file with `file_read` when you need the middle. A report is the agent's account, \
         not proof: verify anything you are about to build on.\n\n\
         Tools:\n\
         - `spawn_agent` starts one and returns at once with its id. Give it a `description` \
         (3–6 words), the full `prompt` (it sees nothing else — include every path, constraint \
         and acceptance criterion), a short `name` to address it by, and optionally `agentType` \
         and `model`. Start several in one message when their work is independent.\n\
         - `send_message` sends a message to an agent by `name` or id: an answer to what it \
         asked, or more work. A running agent gets it at its next safe point; a finished agent \
         is resumed with it and remembers everything it did before.\n\
         - `get_task_output` looks at a running agent for up to ten seconds and returns its \
         timeline since your last look: tools it ran, what it thought and said, never tool \
         results. It never returns a report; reports arrive only as messages. Use it when you \
         must decide whether to redirect or stop an agent, never to wait for one.\n\
         - `stop_agent` stops a running agent by `name` or id, when it is on the wrong track or \
         no longer needed. You get its report with what it had done.\n\
         - `list_models` lists the models the user has configured, so you can pick a model for a \
         sub-agent instead of guessing — or ask the user which one to use when it matters.\n\n\
         Sub-agents cannot ask the user anything and cannot start sub-agents of their own. Every \
         agent you start is shown to the user in the Agents list under the name you gave it, and \
         its transcript is kept with this conversation.",
        types = catalog.describe()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_prompt_frames_the_definition_and_names_the_workspace() {
        let catalog = Catalog::built_in();
        let def = catalog.get("explore").unwrap();
        let prompt = child_system_prompt(def, Some("E:/work/app"));
        assert!(prompt.starts_with("You are `explore`"));
        assert!(prompt.contains(def.system_prompt.trim()));
        assert!(prompt.contains("Workspace: E:/work/app"));
        assert!(prompt.contains("There is no user here"));
        assert!(prompt.contains("`message_parent`"), "the way back to the parent is taught");
        let no_ws = child_system_prompt(def, None);
        assert!(no_ws.contains("Workspace: none"));
    }

    /// The 2026-10-08 run: children with schemas and no guide invented
    /// `read_file` and `read`. The prompt now names the exact roster and
    /// teaches only the tools the child holds.
    #[test]
    fn a_child_is_told_its_exact_tools_and_only_their_guidance() {
        let catalog = Catalog::built_in();
        let explore = child_system_prompt(catalog.get("explore").unwrap(), Some("E:/w"));
        assert!(
            explore.contains(
                "You have exactly these tools: `file_read`, `glob`, `grep`, `workspace_tree`, \
                 `code`, `message_parent`, `submit_report`."
            ),
            "{explore}"
        );
        assert!(explore.contains("not `read_file`, `read`"));
        assert!(explore.contains("`path` as an ARRAY"), "file_read's shape is taught");
        for absent in ["`shell_execute` runs", "`file_edit` replaces", "`shell_spawn` starts"] {
            assert!(!explore.contains(absent), "explore has no such tool, yet: {absent}");
        }

        let general = child_system_prompt(catalog.get("general-purpose").unwrap(), None);
        for present in ["`shell_execute` runs", "`file_edit` replaces", "`move_path`, `delete_path`"] {
            assert!(general.contains(present), "missing {present}");
        }
    }

    #[test]
    fn a_child_is_told_that_submit_report_is_how_it_finishes() {
        let catalog = Catalog::built_in();
        let prompt = child_system_prompt(catalog.get("reviewer").unwrap(), None);
        assert!(prompt.contains("You finish by calling `submit_report`"));
        for field in ["`outcome`", "`summary`", "`report`", "`changedFiles`"] {
            assert!(prompt.contains(field), "missing {field}");
        }
        assert!(REPORT_REMINDER.contains("submit_report"));
    }

    #[test]
    fn parent_instructions_list_every_type_and_every_tool() {
        let text = parent_instructions(&Catalog::built_in());
        for needle in [
            "`general-purpose`",
            "`explore`",
            "`reviewer`",
            "`spawn_agent`",
            "`send_message`",
            "`get_task_output`",
            "`stop_agent`",
            "`list_models`",
            "`outcome=\"not_submitted\"`",
            "end your turn",
        ] {
            assert!(text.contains(needle), "missing {needle}");
        }
    }
}
