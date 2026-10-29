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
pub const REPORT_REMINDER: &str = "This work run ended without calling submit_report. The \
     parent needs the work result, not a repeated acknowledgement or a tool transcript. \
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
        "auroro_websearch",
        "`auroro_websearch` searches the web and reads source pages. Use primary documentation for technical claims, read the supporting page, and include the source URL in your report.",
    ),
    (
        "design_guidelines",
        "Call `design_guidelines` before creating or reviewing user-facing UI or copy. Choose its `topic` for the work: `build`, `writing`, `audit`, or `redesign`, and name the `platform`: `web`, `desktop`, or `mobile`.",
    ),
    (
        "canvas_guidelines",
        "Read `canvas_guidelines` before writing Aurora canvas code. Use its actual SDK and contracts rather than inventing component APIs.",
    ),
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
        "`move_path` moves files or folders inside the workspace.",
    ),
    ("delete_path", "`delete_path` deletes a file or folder inside the workspace. Check the exact target first."),
    ("folder_create", "`folder_create` creates folders inside the workspace."),
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
        "`shell_spawn` starts something with no natural end, such as a dev server or watcher. Keep its process id. If you lack the tools to read or stop it, ask the parent to manage that process.",
    ),
    ("shell_read_output", "`shell_read_output` reads a background process's output. Use `start_line` and `wait_ms` to follow it."),
    ("shell_list_processes", "`shell_list_processes` lists tracked processes. Check ownership before acting on one."),
    ("shell_kill", "`shell_kill` stops a tracked process. Stop processes you started before finishing unless the parent explicitly wants them kept running."),
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
        if has(tool) {
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
             it with `file_read`.\n",
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
         task and carries on with its own work while you do. The parent receives messages you \
         send with message_parent and the work report you submit at the end.\n\n",
        def.name
    ));
    out.push_str(def.system_prompt.trim());
    out.push_str("\n\n");
    out.push_str(&tools_section(&def.tools));
    out.push_str("\n## Working as a sub-agent\n\n");
    out.push_str(&format!(
        "- There is no user here. Nobody on this conversation can answer a question. The parent \
         can: `{MESSAGE_PARENT_TOOL}` is your one messaging tool. Choose kind `question` for \
         an answer or decision, `message` for useful information, and `reply` to answer the \
         parent. Every kind reaches and wakes an idle parent. Its answer \
         comes back to you as a message. Use it the MOMENT the task cannot be done as asked: a \
         tool you need and do not have (name it), a path that does not exist, a contradiction in \
         the brief, a decision only the parent can make. Say exactly what you need. Do not use it \
         for progress updates or for your report. A `question` waits for the answer by default: \
         the call holds for up to two minutes and returns the parent's answer, so you act on it \
         in this same run. If you can carry on without it, set `waitForReply: false` and \
         continue; the answer then arrives later as a message. Only questions wait.\n\
         - When something is merely ambiguous, pick the reasonable reading, state the assumption \
         in your report, and continue.\n\
         - Stay on the task you were given. Do not start adjacent work, and do not undo or \
         rewrite things outside its scope.\n\
         - Parent communication has an explicit purpose: `message` is information, discussion \
         or acknowledgement and does not assign work; `reply` answers your question so you can \
         continue the existing task; `task` assigns or changes work and requires a fresh report \
         covering it. A message such as thanks or good job does not require repeating your \
         report or rerunning checks. If you need to answer during work, use `message_parent`.\n"
    ));
    out.push_str("\n## Finishing\n\n");
    out.push_str(&format!(
        "- You finish a work assignment by calling `{SUBMIT_REPORT_TOOL}`. The parent needs \
         this work report because it cannot see your tool calls or their output. Ordinary \
         messages and acknowledgements do not create another work assignment.\n\
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

/// An idle child answering a message has its history, but no task tools or report obligation.
pub fn message_system_prompt(def: &AgentDefinition, workspace: Option<&str>) -> String {
    format!(
        "You are `{}`, an Aurora sub-agent answering a message from your parent. Your earlier \
         conversation is available for context. This exchange is conversation only. It does \
         not assign new work. Do not repeat your old work report, changed-file list or checks. \
         Answer the actual message briefly. For thanks or acknowledgement, one short sentence \
         is sufficient. Do not claim new verification or changes.\n\n\
         Your only tool is `message_parent`, for a question or information that must reach the \
         parent before you finish. It wakes an idle parent. A `question` waits for the reply by \
         default; set `waitForReply: false` if you can answer without it. You have no file, shell, browser, delegation or \
         submit_report tool. Your final text is delivered to the parent automatically as a \
         conversation reply, so do not also send that same text through message_parent.\n\n\
         Parent messages are marked message, reply or task. Only an explicit task starts work \
         again; the runtime will then give you your saved task tools and require a new report.\n\n\
         Workspace: {}\nPlatform: {}",
        def.name, workspace.unwrap_or("none"), std::env::consts::OS
    )
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
         you can make. Answer those with `send_message` kind `reply`. A message titled `Question from` is \
         an agent paused for your answer (for up to two minutes): answer it before anything \
         else, and it continues in the same run. Do not poll, check on or wait for \
         agents. What you gave an agent is its job now: do not read, explore or redo that part \
         yourself while it runs — you would pay twice for one answer. Do other work that does \
         not overlap with any agent's task, or, when there is none, tell the user what is \
         running and end your turn; their reports start you again.\n\n\
         While any agent runs, every tool result you get ends with an `<agents_running>` \
         block: each running agent by name with its last two steps (a tool it ran, or what it \
         was thinking or saying). That is your view of them; it comes free with your own work, \
         so do not call `get_task_output` just to look. An agent that has finished is not in \
         it: its report is a message of its own. Use it to notice one that is off track or \
         stuck, and redirect or stop it then.\n\n\
         When several agents are out, each report starts you again and says which are still \
         running. Take in what it says. If you can act on it now, do; if what you need waits \
         on the others, write one short line — who finished, who is still running — and end \
         your turn. That short turn is expected, not wasted, and it is not a reason to start \
         work an agent is already doing. Give your answer once the last report is in.\n\n\
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
         and `model`. Use `tools` to choose exact native task tools within that type's allowed \
         tools; omit it for defaults, or pass an empty array for only the child's communication \
         tools. The grant is saved and preserved on resume. A tool grant does not bypass user \
         permissions. Start several in one message when their work is independent.\n\
         - `send_message` is your one tool for talking to an agent by `name` or id. Always \
         choose `kind`: `message` for information, discussion, thanks or acknowledgement; \
         `reply` to answer its question; `task` for new or changed work. A running agent reads \
         it at a safe boundary, and a held question takes a reply immediately. Only task \
         requires a new work report. A finished child answers message or reply briefly with \
         its history but no task tools or report reminder. That response reaches you and \
         wakes you if idle. Do not send acknowledgements back and forth or thank an agent \
         again merely because it acknowledged you. Use task only when actual work is needed.\n\
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
        for present in ["`shell_execute` runs", "`file_edit` replaces", "`move_path` moves", "`delete_path` deletes"] {
            assert!(general.contains(present), "missing {present}");
        }
    }

    #[test]
    fn a_child_is_told_that_submit_report_is_how_it_finishes() {
        let catalog = Catalog::built_in();
        let prompt = child_system_prompt(catalog.get("reviewer").unwrap(), None);
        assert!(prompt.contains("You finish a work assignment by calling `submit_report`"));
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

    /// The code waits on a question unless told not to (`message_parent`:
    /// `wait = explicit.unwrap_or(kind == Question)`). The instructions said
    /// the opposite — "set waitForReply: true when you cannot go on … leave it
    /// off when you can carry on" — so an agent following them paused up to
    /// two minutes for answers it did not need.
    #[test]
    fn the_instructions_state_the_waiting_default_the_code_has() {
        let catalog = Catalog::built_in();
        let def = catalog.get("general-purpose").expect("a built-in type");
        for text in [child_system_prompt(def, Some("E:/p")), message_system_prompt(def, Some("E:/p"))] {
            assert!(text.contains("waits for the"), "{text}");
            assert!(text.contains("`waitForReply: false`"), "{text}");
            assert!(!text.contains("set `waitForReply: true`"), "{text}");
            assert!(!text.contains("Set `waitForReply: true`"), "{text}");
        }
    }

    /// 2026-10-12, four explorers out: the parent re-read the areas it had
    /// handed to them, and at each report debated whether a one-line turn was
    /// allowed. Both are now said outright.
    #[test]
    fn parent_instructions_say_an_agents_task_is_its_job_and_what_to_do_between_reports() {
        let text = parent_instructions(&Catalog::built_in());
        assert!(text.contains("What you gave an agent is its job now"), "{text}");
        assert!(text.contains("do not read, explore or redo that part"), "{text}");
        assert!(text.contains("says which are still running"), "{text}");
        assert!(text.contains("That short turn is expected, not wasted"), "{text}");
        assert!(text.contains("once the last report is in"), "{text}");
    }

    /// The trailer only helps if the parent knows what it is and that it
    /// replaces looking.
    #[test]
    fn parent_instructions_explain_the_running_agents_trailer() {
        let text = parent_instructions(&Catalog::built_in());
        assert!(text.contains("`<agents_running>`"), "{text}");
        assert!(text.contains("last two steps"), "{text}");
        assert!(
            text.contains("do not call `get_task_output` just to look"),
            "{text}"
        );
    }
}
