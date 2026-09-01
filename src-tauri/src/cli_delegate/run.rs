//! Executing the delegate subcommands.
//!
//! [`super::command`] defines what a user can type; this is what happens next.
//! The modules underneath do the real work — resolving a model, claiming a
//! file, tailing a transcript — so what lives here is the *order* of those
//! steps and the decisions between them.
//!
//! ## Everything is resolved before anything is written
//!
//! A dispatch validates the workspace, the model, and the thread **first**,
//! and only then writes the request file. The alternative — write, then
//! discover the model does not exist — leaves a task in the inbox that a
//! running Aurora will pick up and fail, in a window the user may not be
//! looking at. Failing in the terminal, before the task exists, keeps the
//! error where the person who caused it is standing.

use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::catalog::{Catalog, CatalogEntry, CatalogError};
use super::command::{AgentArgs, Continuation, ModelsArgs, TasksArgs, ThreadsArgs, WatchArgs};
use super::follow::{follow, FollowOutcome, Tail};
use super::inbox::Inbox;
use super::list;
use super::presence::aurora_is_running;
use super::render::{render, Row};
use super::task::{
    new_task_id, TaskEvent, TaskOrigin, TaskRequest, TASK_FORMAT_VERSION, TRANSCRIPT_SUFFIX,
};
use super::term::{glyph, Style, Term};
use super::threads::{ThreadError, Threads};

/// Exit codes. Distinct values because a caller scripting this needs to tell
/// "the task failed" from "the command was wrong" without parsing text.
pub mod exit {
    /// Everything worked.
    pub const OK: i32 = 0;
    /// The command could not be carried out — bad model, missing project.
    pub const USAGE: i32 = 2;
    /// The task ran and failed.
    pub const TASK_FAILED: i32 = 1;
    /// Nothing claimed the task in time.
    pub const TIMEOUT: i32 = 4;
}

/// How long to wait for a freshly launched Aurora before giving up.
///
/// Longer than [`AgentArgs::start_timeout`]'s default would suggest, because a
/// cold start is a window, a WebView, and a frontend bundle — several seconds
/// on a warm machine and considerably more on a cold one. The user is told
/// this is happening rather than left watching a still cursor.
const COLD_START_GRACE: Duration = Duration::from_secs(45);

/// Dispatch a task. `aurora agent`.
pub fn run_agent(args: AgentArgs) -> i32 {
    let term = Term::new(args.color.into());

    let workspace = match resolve_workspace(args.path.as_deref()) {
        Ok(path) => path,
        Err(message) => return fail(&term, &message),
    };

    let prompt = match resolve_prompt(&term, &args) {
        Ok(prompt) => prompt,
        Err(message) => return fail(&term, &message),
    };

    // Model, then thread — both before the request file exists.
    let model = match resolve_model(&term, &args) {
        Ok(model) => model,
        Err(message) => return fail(&term, &message),
    };

    let thread = match resolve_thread(&term, &args, &workspace) {
        Ok(thread) => thread,
        Err(message) => return fail(&term, &message),
    };

    let inbox = Inbox::open();
    let request = TaskRequest {
        version: TASK_FORMAT_VERSION,
        id: new_task_id(),
        created_at: chrono::Utc::now().to_rfc3339(),
        prompt,
        workspace_path: workspace.to_string_lossy().into_owned(),
        thread_id: thread,
        provider_id: model.as_ref().map(|entry| entry.provider_id.clone()),
        model: model.as_ref().map(|entry| entry.model_key.clone()),
        mode: args.task_mode(),
        out_path: args
            .out
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
        origin: TaskOrigin::capture(),
    };

    if let Err(error) = inbox.write_request(&request) {
        return fail(&term, &format!("could not queue the task: {error}"));
    }

    // Launch only after the request is on disk. A cold Aurora sweeps the inbox
    // as it starts, so a task written first is picked up by that sweep — write
    // second and it waits for the next filesystem event instead.
    let mut launched = false;
    if !aurora_is_running() {
        if args.no_launch {
            return fail(
                &term,
                "Aurora is not running (and --no-launch was passed). \
                 Start it with `agw`, or drop --no-launch to have it started for you.",
            );
        }
        if let Err(error) = launch_aurora(&workspace) {
            return fail(&term, &format!("could not start Aurora: {error}"));
        }
        launched = true;
    }

    let transcript = inbox.transcript_path(&request.id);
    if args.json {
        println!("{}", dispatch_record(&request, &transcript));
    } else {
        print!("{}", dispatch_summary(&term, &request, &transcript, launched));
    }

    if !args.should_follow() {
        return exit::OK;
    }

    let start_timeout = if launched {
        COLD_START_GRACE.max(Duration::from_secs(args.start_timeout))
    } else {
        Duration::from_secs(args.start_timeout)
    };

    watch_transcript(
        &term,
        &transcript,
        start_timeout,
        args.json,
        args.verbose,
        false,
        &request.id,
    )
}

/// `aurora --cli` / `aurora tui` — the interactive view.
///
/// When the user picks "Dispatch a task" the TUI exits and the dispatch flow
/// runs here, in a restored terminal. That split is deliberate: composing a
/// prompt and choosing between providers wants real text entry and a real
/// picker, both of which already exist in [`run_agent`]. Re-implementing them
/// inside an alternate screen would be two versions of the same prompt, and
/// the worse one would be the new.
pub fn run_interactive(path: Option<PathBuf>) -> i32 {
    let workspace = match resolve_workspace(path.as_deref()) {
        Ok(path) => path,
        Err(message) => return fail(&Term::new(super::term::ColorChoice::Auto), &message),
    };
    let workspace_string = workspace.to_string_lossy().into_owned();

    let mut app = super::tui::App::load(Some(workspace_string));
    let code = super::tui::run_with(&mut app);
    if code != exit::OK {
        return code;
    }

    match &app.exit {
        super::tui::Exit::Done => exit::OK,

        super::tui::Exit::Watch(task_id) => run_watch(WatchArgs {
            task: task_id.clone(),
            // From the interactive view, showing the run from its start is
            // what "watch this" means — a finished task would otherwise print
            // nothing at all.
            from_start: true,
            json: false,
            verbose: false,
            color: super::command::CliColor::Auto,
        }),

        super::tui::Exit::Dispatch => run_agent(AgentArgs {
            // No prompt: the flow asks for it, in a restored terminal.
            prompt: Vec::new(),
            path: Some(workspace),
            // Whatever was picked from the lists. A qualified pin, so the
            // resolver has no ambiguity left to ask about.
            model: app
                .chosen_model
                .as_ref()
                .map(|entry| entry.pin()),
            provider: None,
            continue_latest: false,
            thread: app
                .chosen_thread
                .as_ref()
                .map(|summary| summary.id.clone()),
            plan: false,
            mode: None,
            follow: true,
            out: None,
            json: false,
            verbose: false,
            no_launch: false,
            start_timeout: 120,
            no_input: false,
            color: super::command::CliColor::Auto,
        }),
    }
}

/// `aurora models`
pub fn run_models(args: ModelsArgs) -> i32 {
    let term = Term::new(args.color.into());

    let catalog = match Catalog::load() {
        Ok(catalog) => catalog,
        Err(error) => return fail(&term, &error.to_string()),
    };

    let entries: Vec<CatalogEntry> = match args.query.as_deref() {
        Some(query) => {
            let found = catalog.find(query, args.provider.as_deref());
            if found.is_empty() {
                // A filtered view that finds nothing should say what *would*
                // have matched, not just print an empty table.
                match catalog.resolve(query, args.provider.as_deref()) {
                    Err(error) => return fail(&term, &describe_catalog_error(&term, &error)),
                    Ok(entry) => vec![entry],
                }
            } else {
                found
            }
        }
        None => match args.provider.as_deref() {
            Some(provider) => catalog
                .entries
                .iter()
                .filter(|entry| entry.provider_id.eq_ignore_ascii_case(provider))
                .cloned()
                .collect(),
            None => catalog.entries.clone(),
        },
    };

    if args.json {
        println!("{}", models_json(&entries));
        return exit::OK;
    }

    println!("{}", list::models_table(&term, &catalog, &entries));
    exit::OK
}

/// `aurora threads`
pub fn run_threads(args: ThreadsArgs) -> i32 {
    let term = Term::new(args.color.into());

    let workspace = if args.all {
        None
    } else {
        match resolve_workspace(args.path.as_deref()) {
            Ok(path) => Some(path.to_string_lossy().into_owned()),
            Err(message) => return fail(&term, &message),
        }
    };

    let threads = match list::load_threads(workspace.as_deref(), args.limit) {
        Ok(threads) => threads,
        Err(error) => return fail(&term, &error.to_string()),
    };

    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&threads).unwrap_or_else(|_| "[]".to_string())
        );
        return exit::OK;
    }

    println!("{}", list::threads_table(&term, &threads, workspace.is_some()));
    exit::OK
}

/// `aurora watch`
pub fn run_watch(args: WatchArgs) -> i32 {
    let term = Term::new(args.color.into());
    let inbox = Inbox::open();

    let id = match resolve_task_id(&inbox, &args.task) {
        Ok(id) => id,
        Err(message) => return fail(&term, &message),
    };

    let transcript = inbox.transcript_path(&id);
    if !transcript.exists() {
        return fail(&term, &format!("task {id} has no transcript"));
    }

    watch_transcript(
        &term,
        &transcript,
        // Attaching to an existing task: it may be mid-turn and silent for a
        // while, so there is nothing to time out on.
        Duration::from_secs(u64::MAX / 2),
        args.json,
        args.verbose,
        !args.from_start,
        &id,
    )
}

/// `aurora tasks`
pub fn run_tasks(args: TasksArgs) -> i32 {
    let term = Term::new(args.color.into());
    let inbox = Inbox::open();

    if args.clean {
        match inbox.sweep_older_than(0) {
            Ok(removed) => {
                println!(
                    "{} removed {}",
                    term.paint(Style::Success, term.g(glyph::CHECK)),
                    plural_tasks(removed)
                );
                return exit::OK;
            }
            Err(error) => return fail(&term, &error.to_string()),
        }
    }

    let tasks = match collect_tasks(&inbox) {
        Ok(tasks) => tasks,
        Err(error) => return fail(&term, &error.to_string()),
    };

    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&tasks).unwrap_or_else(|_| "[]".to_string())
        );
        return exit::OK;
    }

    if tasks.is_empty() {
        println!("{}", term.paint(Style::Muted, "No tasks dispatched yet."));
        return exit::OK;
    }

    println!("{}", tasks_table(&term, &tasks));
    exit::OK
}

// ── resolution ──────────────────────────────────────────────────────────────

/// Turn `--path` (or its absence) into an absolute directory that exists.
fn resolve_workspace(path: Option<&Path>) -> Result<PathBuf, String> {
    let raw = match path {
        Some(path) => path.to_path_buf(),
        None => std::env::current_dir()
            .map_err(|error| format!("could not read the current directory: {error}"))?,
    };

    let absolute = if raw.is_absolute() {
        raw
    } else {
        std::env::current_dir()
            .map_err(|error| format!("could not read the current directory: {error}"))?
            .join(raw)
    };

    if !absolute.exists() {
        return Err(format!("{} does not exist", absolute.display()));
    }
    if !absolute.is_dir() {
        return Err(format!("{} is not a directory", absolute.display()));
    }

    // `dunce` strips the Windows `\\?\` prefix that canonicalize adds. The
    // workspace string is compared against thread metadata written by the
    // frontend, which never carries that prefix — leaving it on would make
    // every project-scoped lookup miss.
    Ok(dunce::canonicalize(&absolute).unwrap_or(absolute))
}

/// The prompt, asking for it when a terminal is attached and it was omitted.
fn resolve_prompt(term: &Term, args: &AgentArgs) -> Result<String, String> {
    let typed = args.prompt_text();
    if !typed.is_empty() {
        return Ok(typed);
    }

    if !args.interactive() || !std::io::stdin().is_terminal() {
        return Err("no prompt given. Pass one: aurora agent \"what you want done\"".to_string());
    }

    let answer = inquire::Text::new("What should Aurora do?")
        .with_help_message("the task runs in the Agent Window; Esc to cancel")
        .prompt()
        .map_err(|_| "cancelled".to_string())?;

    let answer = answer.trim().to_string();
    if answer.is_empty() {
        return Err("no prompt given".to_string());
    }
    let _ = term;
    Ok(answer)
}

/// Resolve `--model`/`--provider` to one catalogue entry, or `None` when the
/// user named no model and the window's own selection should be used.
fn resolve_model(term: &Term, args: &AgentArgs) -> Result<Option<CatalogEntry>, String> {
    let Some(query) = args.model.as_deref() else {
        // No model named. A `--provider` on its own is not enough to identify
        // one, and silently ignoring it would run on a provider the user did
        // not ask for.
        if let Some(provider) = args.provider.as_deref() {
            return Err(format!(
                "--provider {provider} needs a --model to go with it \
                 (see `aurora models --provider {provider}`)"
            ));
        }
        return Ok(None);
    };

    let catalog = Catalog::load().map_err(|error| error.to_string())?;

    match catalog.resolve(query, args.provider.as_deref()) {
        Ok(entry) => Ok(Some(entry)),
        Err(CatalogError::Ambiguous { candidates, .. }) if args.interactive() => {
            pick_model(term, &candidates).map(Some)
        }
        Err(error) => Err(describe_catalog_error(term, &error)),
    }
}

/// Ask which provider, when a name matches several.
fn pick_model(term: &Term, candidates: &[CatalogEntry]) -> Result<CatalogEntry, String> {
    if !std::io::stdin().is_terminal() {
        return Err(ambiguity_message(term, candidates));
    }

    let options: Vec<String> = candidates
        .iter()
        .map(|entry| {
            let mut line = entry.display_pin();
            let mut detail: Vec<String> = Vec::new();
            if let Some(window) = entry.context_window {
                detail.push(format!("{}k ctx", window / 1_000));
            }
            if let Some(price) = entry.price_output_per_mtok.filter(|price| *price > 0.0) {
                detail.push(format!("${price:.2}/1M out"));
            }
            if entry.selected {
                detail.push("selected".to_string());
            }
            if !detail.is_empty() {
                line.push_str(&format!("  ({})", detail.join(", ")));
            }
            line
        })
        .collect();

    let chosen = inquire::Select::new("That model is on several providers — which one?", options)
        .with_help_message("pass a qualified --model provider:name to skip this next time")
        .raw_prompt()
        .map_err(|_| "cancelled".to_string())?;

    candidates
        .get(chosen.index)
        .cloned()
        .ok_or_else(|| "cancelled".to_string())
}

/// Resolve `--continue` / `--thread` to a thread id, or `None` for a new chat.
fn resolve_thread(
    term: &Term,
    args: &AgentArgs,
    workspace: &Path,
) -> Result<Option<String>, String> {
    let continuation = args.continuation();
    if continuation == Continuation::New {
        return Ok(None);
    }

    let scope = workspace.to_string_lossy().into_owned();
    let threads = Threads::load(Some(&scope)).map_err(|error| error.to_string())?;

    match continuation {
        Continuation::New => Ok(None),
        Continuation::Latest => match threads.latest() {
            Some(summary) => Ok(Some(summary.id.clone())),
            // Continuing "the latest" when there is none is not an error — it
            // is a first task in a new project, and starting a conversation is
            // exactly what the user wanted.
            None => Ok(None),
        },
        Continuation::Thread(query) => match threads.resolve(&query) {
            Ok(summary) => Ok(Some(summary.id)),
            Err(ThreadError::NoMatch { recent, .. }) if args.interactive() && !recent.is_empty() => {
                pick_thread(term, &query, &recent).map(Some)
            }
            Err(ThreadError::Ambiguous { candidates, .. })
                if args.interactive() && !candidates.is_empty() =>
            {
                pick_thread(term, &query, &candidates).map(Some)
            }
            Err(error) => Err(describe_thread_error(term, &error)),
        },
    }
}

/// Offer a list of conversations to continue.
fn pick_thread(
    term: &Term,
    query: &str,
    candidates: &[crate::agent_runtime::session_store::SessionSummary],
) -> Result<String, String> {
    if !std::io::stdin().is_terminal() {
        return Err(thread_miss_message(term, query, candidates));
    }

    let options: Vec<String> = candidates
        .iter()
        .map(|summary| {
            format!(
                "{}  {}",
                list::short_id(&summary.id),
                super::threads::display_title(summary)
            )
        })
        .collect();

    let chosen = inquire::Select::new(
        &format!("No conversation matches {query:?}. Continue which one?"),
        options,
    )
    .with_help_message("Esc to cancel")
    .raw_prompt()
    .map_err(|_| "cancelled".to_string())?;

    candidates
        .get(chosen.index)
        .map(|summary| summary.id.clone())
        .ok_or_else(|| "cancelled".to_string())
}

/// Resolve a task id or unique prefix against the task directory.
fn resolve_task_id(inbox: &Inbox, query: &str) -> Result<String, String> {
    let query = query.trim();
    let mut ids: Vec<String> = Vec::new();
    let entries = std::fs::read_dir(inbox.dir())
        .map_err(|error| format!("could not read the task directory: {error}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(id) = name.strip_suffix(TRANSCRIPT_SUFFIX) {
            ids.push(id.to_string());
        }
    }

    if ids.iter().any(|id| id == query) {
        return Ok(query.to_string());
    }
    let mut prefixed: Vec<String> = ids
        .into_iter()
        .filter(|id| id.starts_with(query) && !query.is_empty())
        .collect();
    prefixed.sort();

    match prefixed.len() {
        1 => Ok(prefixed.remove(0)),
        0 => Err(format!(
            "no task matches {query:?} — see `aurora tasks`"
        )),
        _ => Err(format!(
            "{query:?} matches {} tasks; use more characters:\n  {}",
            prefixed.len(),
            prefixed.join("\n  ")
        )),
    }
}

// ── watching ────────────────────────────────────────────────────────────────

/// Tail a transcript to the terminal until it ends.
#[allow(clippy::too_many_arguments)]
fn watch_transcript(
    term: &Term,
    transcript: &Path,
    start_timeout: Duration,
    json: bool,
    verbose: bool,
    from_end: bool,
    task_id: &str,
) -> i32 {
    let interrupted = Arc::new(AtomicBool::new(false));
    install_interrupt_handler(interrupted.clone());

    let mut tail = if from_end {
        Tail::from_end(transcript)
    } else {
        Tail::new(transcript)
    };

    // Tracks whether the run reported failure, so the exit code matches what
    // the user watched happen.
    let mut failed = false;
    let mut streaming_text = false;

    let outcome = {
        let interrupted = interrupted.clone();
        follow(
            &mut tail,
            Some(start_timeout),
            &move || interrupted.load(Ordering::Relaxed),
            &mut |event| {
                if json {
                    if let Ok(line) = serde_json::to_string(event) {
                        println!("{line}");
                    }
                    if let TaskEvent::Result { subtype, .. } = event {
                        failed = *subtype != super::task::ResultKind::Success;
                    }
                    return;
                }

                if let TaskEvent::Result { subtype, .. } = event {
                    failed = *subtype != super::task::ResultKind::Success;
                }

                match render(term, event, verbose) {
                    Some(Row::Stream(text)) => {
                        print!("{text}");
                        streaming_text = true;
                    }
                    Some(Row::Line(line)) => {
                        // Close an open run of assistant text before starting a
                        // marked row, or the two collide on one line.
                        if streaming_text {
                            println!();
                            streaming_text = false;
                        }
                        println!("{line}");
                    }
                    Some(Row::Pair { head, detail }) => {
                        if streaming_text {
                            println!();
                            streaming_text = false;
                        }
                        println!("{head}");
                        println!("{detail}");
                    }
                    None => {}
                }
            },
        )
    };

    if streaming_text {
        println!();
    }

    match outcome {
        Ok(FollowOutcome::Finished) => {
            if failed {
                exit::TASK_FAILED
            } else {
                exit::OK
            }
        }
        Ok(FollowOutcome::Detached) => {
            if !json {
                println!(
                    "\n{} stopped watching — the task is still running.\n  {} {}",
                    term.paint(Style::Muted, term.g(glyph::MIDDOT)),
                    term.paint(Style::Muted, "reattach with"),
                    term.paint(Style::Hint, &format!("aurora watch {task_id}"))
                );
            }
            exit::OK
        }
        Ok(FollowOutcome::TimedOut) => {
            if !json {
                eprintln!(
                    "\n{} Aurora has not picked this task up yet.\n  {} {}",
                    term.paint(Style::Warning, term.g(glyph::WARN)),
                    term.paint(Style::Muted, "it stays queued; watch it with"),
                    term.paint(Style::Hint, &format!("aurora watch {task_id}"))
                );
            }
            exit::TIMEOUT
        }
        Err(error) => fail(term, &error.to_string()),
    }
}

/// Set the interrupt flag on Ctrl-C rather than killing the process.
///
/// The default handler would terminate the CLI mid-render, leaving the
/// terminal without the "the task is still running" note — and a user who has
/// just pressed Ctrl-C on something called `agent` deserves to be told
/// explicitly that they did not cancel the work.
fn install_interrupt_handler(flag: Arc<AtomicBool>) {
    // A dedicated single-threaded runtime, because the CLI is otherwise
    // synchronous and this is the only async thing it needs. Detached: it
    // lives until the process exits.
    std::thread::spawn(move || {
        let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        else {
            return;
        };
        runtime.block_on(async {
            if tokio::signal::ctrl_c().await.is_ok() {
                flag.store(true, Ordering::Relaxed);
            }
        });
    });
}

// ── output ──────────────────────────────────────────────────────────────────

/// The human-facing dispatch confirmation.
///
/// Names the task id and the transcript path explicitly, because those are the
/// two things a caller needs to inspect *this* task later — and with several
/// dispatched at once, "the last one" is not an identifier.
fn dispatch_summary(
    term: &Term,
    request: &TaskRequest,
    transcript: &Path,
    launched: bool,
) -> String {
    let mut out = String::new();

    out.push_str(&format!(
        "{} {}  {}\n",
        term.paint(Style::Success, term.g(glyph::DOT)),
        term.bold("dispatched"),
        term.paint(Style::Hint, &request.id)
    ));

    let mut row = |label: &str, value: &str| {
        out.push_str(&format!(
            "  {} {:<10} {}\n",
            term.paint(Style::Muted, term.g(glyph::PIPE)),
            term.paint(Style::Muted, label),
            value
        ));
    };

    row("project", &request.workspace_path);
    row(
        "model",
        &request
            .model_pin()
            .unwrap_or_else(|| "(the window's selection)".to_string()),
    );
    if let Some(thread) = &request.thread_id {
        row("thread", &list::short_id(thread));
    }
    row("transcript", &transcript.display().to_string());
    if let Some(out_path) = &request.out_path {
        row("out", out_path);
    }

    if launched {
        out.push_str(&format!(
            "  {} {}\n",
            term.paint(Style::Muted, term.g(glyph::PIPE)),
            term.paint(Style::Muted, "starting Aurora — the task runs once it is up")
        ));
    }

    out.push_str(&format!(
        "\n  {} {}\n",
        term.paint(Style::Muted, "watch:"),
        term.paint(Style::Hint, &format!("aurora watch {}", request.id))
    ));

    out
}

/// The machine-facing dispatch record.
///
/// One object, so `aurora agent … --json | jq -r .taskId` works and several
/// dispatches can be fanned out and tracked independently.
fn dispatch_record(request: &TaskRequest, transcript: &Path) -> String {
    let record = serde_json::json!({
        "type": "dispatched",
        "taskId": request.id,
        "threadId": request.thread_id,
        "workspacePath": request.workspace_path,
        "model": request.model_pin(),
        "transcript": transcript.to_string_lossy(),
        "out": request.out_path,
    });
    serde_json::to_string(&record).unwrap_or_else(|_| "{}".to_string())
}

/// The model catalogue as JSON.
fn models_json(entries: &[CatalogEntry]) -> String {
    let rows: Vec<serde_json::Value> = entries
        .iter()
        .map(|entry| {
            serde_json::json!({
                "id": entry.pin(),
                "name": entry.display_pin(),
                "provider": entry.provider_id,
                "providerName": entry.provider_name,
                "model": entry.model_key,
                "label": entry.label,
                "contextWindow": entry.context_window,
                "maxOutputTokens": entry.max_output_tokens,
                "supportsVision": entry.supports_vision,
                "supportsThinking": entry.supports_thinking,
                "priceOutputPerMTok": entry.price_output_per_mtok,
                "selected": entry.selected,
            })
        })
        .collect();
    serde_json::to_string_pretty(&rows).unwrap_or_else(|_| "[]".to_string())
}

/// One dispatched task, as `aurora tasks` reports it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    pub id: String,
    pub status: &'static str,
    pub workspace_path: String,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub created_at: String,
}

/// Every dispatched task, newest first. The interactive view's task screen.
pub fn collect_task_summaries() -> Result<Vec<TaskSummary>, super::inbox::InboxError> {
    collect_tasks(&Inbox::open())
}

/// Read every task in the directory and work out how each one ended.
fn collect_tasks(inbox: &Inbox) -> Result<Vec<TaskSummary>, super::inbox::InboxError> {
    let mut out: Vec<TaskSummary> = Vec::new();
    let entries = match std::fs::read_dir(inbox.dir()) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = name
            .strip_suffix(super::task::TASK_SUFFIX)
            .or_else(|| name.strip_suffix(super::task::CLAIMED_SUFFIX))
        else {
            continue;
        };
        let Ok(request) = inbox.read_request(&entry.path()) else {
            continue;
        };
        // Read the pin before the struct is taken apart — `model_pin` borrows
        // fields that the initialiser below moves out.
        let model = request.model_pin();
        out.push(TaskSummary {
            id: id.to_string(),
            status: task_status(inbox, id, name.ends_with(super::task::TASK_SUFFIX)),
            workspace_path: request.workspace_path,
            prompt: super::render::summarize(&request.prompt, 60),
            model,
            created_at: request.created_at,
        });
    }

    // Newest first: the tasks you are still thinking about are the recent ones.
    out.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(out)
}

/// A task's state, derived from its files rather than tracked separately.
///
/// Deriving beats recording: a status field would need updating by a process
/// that can die between the update and the truth, leaving a task marked
/// "running" forever. The files cannot disagree with themselves.
fn task_status(inbox: &Inbox, id: &str, pending: bool) -> &'static str {
    if pending {
        return "queued";
    }
    let Ok(body) = std::fs::read_to_string(inbox.transcript_path(id)) else {
        return "running";
    };
    for line in body.lines().rev() {
        let Ok(event) = serde_json::from_str::<TaskEvent>(line) else {
            continue;
        };
        if let TaskEvent::Result { subtype, .. } = event {
            return match subtype {
                super::task::ResultKind::Success => "done",
                super::task::ResultKind::Error => "failed",
                super::task::ResultKind::Cancelled => "stopped",
            };
        }
    }
    "running"
}

/// The `aurora tasks` table.
fn tasks_table(term: &Term, tasks: &[TaskSummary]) -> String {
    use comfy_table::{presets, Cell, ContentArrangement, Table};

    let mut table = Table::new();
    table
        .load_style(presets::NOTHING)
        .set_content_arrangement(ContentArrangement::Dynamic)
        .set_header(
            ["id", "status", "project", "task"]
                .iter()
                .map(|header| Cell::new(term.paint(Style::Muted, &header.to_uppercase())))
                .collect::<Vec<_>>(),
        );

    for task in tasks {
        let style = match task.status {
            "done" => Style::Success,
            "failed" => Style::Error,
            "stopped" => Style::Warning,
            "running" => Style::Active,
            _ => Style::Muted,
        };
        table.add_row(vec![
            Cell::new(term.paint(Style::Hint, &task.id)),
            Cell::new(term.paint(style, task.status)),
            Cell::new(term.paint(Style::Muted, &project_name(&task.workspace_path))),
            Cell::new(&task.prompt),
        ]);
    }
    table.to_string()
}

/// The last path segment — enough to tell two projects apart without spending
/// a table column on a full absolute path.
fn project_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

fn plural_tasks(count: usize) -> String {
    if count == 1 {
        "1 task".to_string()
    } else {
        format!("{count} tasks")
    }
}

// ── errors ──────────────────────────────────────────────────────────────────

/// Print an error and return the usage exit code.
fn fail(term: &Term, message: &str) -> i32 {
    eprintln!(
        "{} {}",
        term.paint(Style::Error, term.g(glyph::CROSS)),
        message
    );
    exit::USAGE
}

/// Render a catalogue failure with the follow-up the user needs.
fn describe_catalog_error(term: &Term, error: &CatalogError) -> String {
    match error {
        CatalogError::Ambiguous { candidates, .. } => ambiguity_message(term, candidates),
        CatalogError::NoMatch { query, near } if !near.is_empty() => format!(
            "no model named {query:?}. Did you mean:\n  {}",
            near.join("\n  ")
        ),
        other => other.to_string(),
    }
}

/// The non-interactive form of "which provider did you mean?".
fn ambiguity_message(term: &Term, candidates: &[CatalogEntry]) -> String {
    let list = candidates
        .iter()
        // The typeable form: a provider id may be a UUID, and this list exists
        // to be copied back into the command.
        .map(|entry| format!("  {}", term.paint(Style::Hint, &entry.display_pin())))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "that model is configured on {} providers — name one:\n{list}",
        candidates.len()
    )
}

fn describe_thread_error(term: &Term, error: &ThreadError) -> String {
    match error {
        ThreadError::NoMatch { query, recent } => thread_miss_message(term, query, recent),
        ThreadError::Ambiguous { query, candidates } => {
            thread_miss_message(term, query, candidates)
        }
        other => other.to_string(),
    }
}

/// "That thread is not here — these are." Printed when there is no terminal to
/// ask through, so the recent list has to travel in the error itself.
fn thread_miss_message(
    term: &Term,
    query: &str,
    candidates: &[crate::agent_runtime::session_store::SessionSummary],
) -> String {
    if candidates.is_empty() {
        return format!("no conversation matches {query:?} in this project");
    }
    let list = candidates
        .iter()
        .map(|summary| {
            format!(
                "  {}  {}",
                term.paint(Style::Hint, &list::short_id(&summary.id)),
                super::threads::display_title(summary)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("no conversation matches {query:?}. Recent conversations:\n{list}")
}

// ── launching ───────────────────────────────────────────────────────────────

/// Start Aurora's Agent Window, detached, scoped to `workspace`.
///
/// Scoping is done through the child's working directory rather than an
/// argument: `aurora --agent` already derives its project from the directory
/// it was run in (see `CliArgs::agent_workspace_root`), so setting `cwd` uses
/// the launcher path exactly as it was designed instead of adding a second
/// way to say the same thing.
fn launch_aurora(workspace: &Path) -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|error| format!("could not locate the Aurora executable: {error}"))?;

    let mut command = std::process::Command::new(exe);
    command
        .arg("--agent")
        .current_dir(workspace)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Detach from this console so the window outlives the terminal that
        // started it, and so closing the terminal does not take Aurora with it.
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_relative_workspace_becomes_absolute() {
        let resolved = resolve_workspace(Some(Path::new("."))).expect("resolves");
        assert!(resolved.is_absolute());
        // The Windows extended-length prefix must not survive: thread metadata
        // written by the frontend never carries it, so a scoped lookup with one
        // attached would match nothing.
        assert!(!resolved.to_string_lossy().starts_with(r"\\?\"));
    }

    #[test]
    fn a_missing_workspace_is_refused() {
        let error = resolve_workspace(Some(Path::new(r"Z:\definitely-not-here"))).unwrap_err();
        assert!(error.contains("does not exist"));
    }

    #[test]
    fn a_file_is_not_a_workspace() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "x").expect("write");
        let error = resolve_workspace(Some(&file)).unwrap_err();
        assert!(error.contains("not a directory"));
    }

    #[test]
    fn a_dispatch_record_names_the_task_and_its_transcript() {
        // The fan-out contract: two tasks, two ids, two transcripts.
        let request = TaskRequest {
            version: TASK_FORMAT_VERSION,
            id: "20260901T142233-7f3a91".to_string(),
            created_at: "2026-09-01T14:22:33Z".to_string(),
            prompt: "do it".to_string(),
            workspace_path: r"E:\project".to_string(),
            thread_id: Some("01JQ8FAAAA".to_string()),
            provider_id: Some("fireworks".to_string()),
            model: Some("glm-5.2".to_string()),
            mode: super::super::task::TaskMode::Agent,
            out_path: None,
            origin: TaskOrigin {
                pid: 1,
                cwd: None,
                host: None,
            },
        };
        let record = dispatch_record(&request, Path::new(r"C:\tasks\20260901T142233-7f3a91.jsonl"));
        let parsed: serde_json::Value = serde_json::from_str(&record).expect("valid JSON");

        assert_eq!(parsed["taskId"], "20260901T142233-7f3a91");
        assert_eq!(parsed["threadId"], "01JQ8FAAAA");
        assert_eq!(parsed["model"], "fireworks:glm-5.2");
        assert!(parsed["transcript"].as_str().expect("path").ends_with(".jsonl"));
    }

    #[test]
    fn the_human_summary_names_the_id_and_the_transcript() {
        let request = TaskRequest {
            version: TASK_FORMAT_VERSION,
            id: "20260901T142233-7f3a91".to_string(),
            created_at: "2026-09-01T14:22:33Z".to_string(),
            prompt: "do it".to_string(),
            workspace_path: r"E:\project".to_string(),
            thread_id: None,
            provider_id: None,
            model: None,
            mode: super::super::task::TaskMode::Agent,
            out_path: None,
            origin: TaskOrigin {
                pid: 1,
                cwd: None,
                host: None,
            },
        };
        let summary = dispatch_summary(
            &Term::plain(),
            &request,
            Path::new(r"C:\tasks\20260901T142233-7f3a91.jsonl"),
            false,
        );
        assert!(summary.contains("20260901T142233-7f3a91"));
        assert!(summary.contains(r"E:\project"));
        assert!(summary.contains("aurora watch 20260901T142233-7f3a91"));
        // No model named: say which model will be used rather than leaving it
        // blank, which would read as "none".
        assert!(summary.contains("the window's selection"));
    }

    #[test]
    fn task_status_is_derived_from_the_transcript() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inbox = Inbox::at(dir.path());
        let id = "20260901T100000-aaa";

        // No transcript yet, already claimed → still running.
        assert_eq!(task_status(&inbox, id, false), "running");

        let finished = format!(
            "{}\n",
            serde_json::to_string(&TaskEvent::Result {
                subtype: super::super::task::ResultKind::Success,
                result: Some("done".to_string()),
                error: None,
                duration_ms: 1,
                num_turns: 1,
            })
            .expect("serialise")
        );
        std::fs::write(inbox.transcript_path(id), finished).expect("write");
        assert_eq!(task_status(&inbox, id, false), "done");

        // A pending file outranks the transcript: it has not started.
        assert_eq!(task_status(&inbox, id, true), "queued");
    }

    #[test]
    fn a_failed_run_is_reported_as_failed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inbox = Inbox::at(dir.path());
        let id = "20260901T100000-bbb";
        let line = format!(
            "{}\n",
            serde_json::to_string(&TaskEvent::Result {
                subtype: super::super::task::ResultKind::Error,
                result: None,
                error: Some("boom".to_string()),
                duration_ms: 1,
                num_turns: 1,
            })
            .expect("serialise")
        );
        std::fs::write(inbox.transcript_path(id), line).expect("write");
        assert_eq!(task_status(&inbox, id, false), "failed");
    }

    #[test]
    fn a_task_id_resolves_from_a_prefix() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inbox = Inbox::at(dir.path());
        std::fs::create_dir_all(dir.path()).expect("mkdir");
        std::fs::write(inbox.transcript_path("20260901T100000-aaa"), "").expect("write");
        std::fs::write(inbox.transcript_path("20260901T110000-bbb"), "").expect("write");

        assert_eq!(
            resolve_task_id(&inbox, "20260901T110000-bbb").expect("exact"),
            "20260901T110000-bbb"
        );
        assert_eq!(
            resolve_task_id(&inbox, "20260901T11").expect("prefix"),
            "20260901T110000-bbb"
        );
        // A prefix shared by both must not silently pick one.
        assert!(resolve_task_id(&inbox, "202609").is_err());
        assert!(resolve_task_id(&inbox, "nope").is_err());
    }

    #[test]
    fn a_provider_without_a_model_is_refused() {
        // `--provider x` alone cannot identify a model, and ignoring it would
        // run somewhere the user did not ask for.
        use crate::cli_delegate::command::CliColor;
        let args = AgentArgs {
            prompt: vec!["do it".to_string()],
            path: None,
            model: None,
            provider: Some("fireworks".to_string()),
            continue_latest: false,
            thread: None,
            plan: false,
            mode: None,
            follow: false,
            out: None,
            json: false,
            verbose: false,
            no_launch: false,
            start_timeout: 120,
            no_input: true,
            color: CliColor::Never,
        };
        let error = resolve_model(&Term::plain(), &args).unwrap_err();
        assert!(error.contains("needs a --model"));
    }

    #[test]
    fn project_names_shorten_to_the_folder() {
        assert_eq!(project_name(r"E:\PayNu-Social\paynu_app"), "paynu_app");
        assert_eq!(project_name("/home/a/project"), "project");
    }

    #[test]
    fn task_counts_are_pluralised() {
        assert_eq!(plural_tasks(0), "0 tasks");
        assert_eq!(plural_tasks(1), "1 task");
        assert_eq!(plural_tasks(4), "4 tasks");
    }

    #[test]
    fn an_ambiguity_message_lists_every_qualified_name() {
        let candidates = vec![
            CatalogEntry {
                provider_id: "fireworks".to_string(),
                provider_name: "Fireworks".to_string(),
                model_key: "glm-5.2".to_string(),
                label: None,
                context_window: None,
                max_output_tokens: None,
                supports_vision: false,
                supports_thinking: false,
                price_output_per_mtok: None,
                selected: false,
            },
            CatalogEntry {
                provider_id: "x5m5x".to_string(),
                provider_name: "x5m5x".to_string(),
                model_key: "glm-5.2".to_string(),
                label: None,
                context_window: None,
                max_output_tokens: None,
                supports_vision: false,
                supports_thinking: false,
                price_output_per_mtok: None,
                selected: false,
            },
        ];
        let message = ambiguity_message(&Term::plain(), &candidates);
        // The provider's NAME, which is what `--provider` accepts and what a
        // user can retype — not the id, which may be a UUID.
        assert!(message.contains("Fireworks:glm-5.2"), "got: {message}");
        assert!(message.contains("x5m5x:glm-5.2"), "got: {message}");
    }
}
