//! The `aurora` command surface for dispatching and inspecting work.
//!
//! Argument *definitions* only — every `run_*` lives in [`super::run`], so
//! this file stays readable as the thing it is: the contract a user types
//! against. Help text is written to be the documentation, since it is the only
//! documentation most people will read.
//!
//! ```text
//! aurora agent "refactor the timeline service" --model glm-5.2 --follow
//! aurora models glm-5.2
//! aurora threads
//! aurora watch 20260901T142233-7f3a91
//! ```
//!
//! ## `aurora agent` versus `aurora --agent`
//!
//! Two neighbouring things, deliberately kept apart. `--agent` (in
//! [`crate::cli`]) *opens the Agent Window* — it is a launcher flag, the
//! sibling of `aurora .`. The `agent` subcommand here *sends work to it*.
//! Nothing about the launcher changes; this is additive.

use std::path::PathBuf;

use clap::{Args, Subcommand, ValueEnum};

use super::task::TaskMode;
use super::term::ColorChoice;

/// The delegate subcommands, folded into [`crate::cli::CliCommand`].
#[derive(Subcommand, Debug, Clone)]
pub enum DelegateCommand {
    /// Send a task to the running Aurora and watch it work.
    ///
    /// The prompt arrives in the Agent Window as a real user message, scoped
    /// to a workspace, and runs there with the full tool set. Aurora is
    /// started first if it is not already up.
    #[command(
        visible_alias = "run",
        long_about = "\
Send a task to the running Aurora and watch it work.

The prompt lands in the Agent Window as a real user message and executes
there — you can watch it, steer it, and keep the transcript. The terminal
gets a copy of the run, and `--out` writes it to a file another program can
read while it happens.

If Aurora is not running it is started first, and the task waits for it.

EXAMPLES:
  aurora agent \"fix the failing dart test\"
      Dispatch into the current directory's project, using the model the
      Agent Window already has selected.

  aurora agent \"refactor the timeline service\" --model glm-5.2
      Name a model. If more than one provider serves that name you are asked
      which — it is never picked for you.

  aurora agent \"review this diff\" --model fireworks:glm-5.2 --follow
      Qualify the model so nothing is asked, and stream the run here.

  aurora agent \"keep going\" --continue
      Append to the most recent conversation in this project.

  aurora agent \"analyse this codebase\" --out report.jsonl
      Write the transcript to a file as it happens, for something else to
      read. Combine with --follow to also watch it here."
    )]
    Agent(AgentArgs),

    /// List the models Aurora can run, across every configured provider.
    #[command(
        visible_alias = "model",
        long_about = "\
List the models Aurora can run, across every configured provider.

The same model name is often served by several providers at different
context windows, prices, and — for relabelling gateways — occasionally as a
different model entirely. This is how you see which is which, and get the
qualified `provider:model` name to pass to `aurora agent --model`.

EXAMPLES:
  aurora models                 Every configured model, grouped by provider
  aurora models glm-5.2         Just the providers serving that name
  aurora models --provider fireworks
  aurora models --json          Machine-readable, for scripts"
    )]
    Models(ModelsArgs),

    /// List conversations, so you can continue one.
    #[command(
        visible_alias = "thread",
        long_about = "\
List conversations, so you can continue one with `aurora agent --continue`.

Scoped to the current project by default, because that is almost always what
you mean. Pass --all for every project's history.

Thread ids are long; `--continue` accepts any unique prefix, so the first few
characters shown here are enough."
    )]
    Threads(ThreadsArgs),

    /// Watch a task that is already running.
    #[command(
        long_about = "\
Watch a task that is already running, or replay one that has finished.

Use this to reattach after Ctrl-C, or to follow a task dispatched from
another terminal. Interrupting a watch never cancels the task."
    )]
    Watch(WatchArgs),

    /// List dispatched tasks and how they ended.
    #[command(
        long_about = "\
List dispatched tasks and how they ended.

Tasks are kept for a few days after they finish so the record survives you
walking away from the terminal. `aurora tasks --clean` removes the finished
ones now."
    )]
    Tasks(TasksArgs),

    /// Stop a dispatched task.
    #[command(
        visible_alias = "stop",
        long_about = "\
Stop a dispatched task.

A task that has not started yet is dropped and never runs. One that is already
running stops the same way the Stop button in the Agent Window does — the turn
ends once the tool it is currently in returns, so a shell command already
underway finishes first.

Work already done is not undone. Files Aurora has written stay written.

Ids come from `aurora tasks`; any unique prefix will do."
    )]
    Cancel(CancelArgs),

    /// Serve Aurora to other agents over MCP.
    #[command(
        long_about = "\
Serve Aurora to other agents over the Model Context Protocol.

This does not open a window or run anything on its own. It speaks MCP on stdin
and stdout, so it is started BY another agent — Claude Code, or anything else
that reads an MCP config — rather than by you. Add it to that agent's config:

  {\"mcpServers\": {\"aurora\": {\"command\": \"aurora\", \"args\": [\"mcp\"]}}}

The connected agent can then send Aurora a task, watch it work, stop it, and
list conversations and models.

Off by default at the other end: sending work needs the Agent Window open AND
the switch under Settings -> Agent -> \"Let other agents send work to Aurora\".
Until that is on, the tools are visible but every one of them refuses and says
why."
    )]
    Mcp(McpArgs),

    /// Open the interactive view — browse models, conversations and tasks.
    #[command(
        name = "tui",
        visible_alias = "menu",
        long_about = "\
Open the interactive view.

Everything else here is a one-shot command: you type a full instruction and
get an answer. This is for when you do not yet know the model name, the
conversation id, or what is currently running — a menu, live counts, and
browsable lists.

`aurora --cli` is the same thing."
    )]
    Tui(TuiArgs),
}

/// `aurora tui` / `aurora --cli`
#[derive(Args, Debug, Clone, Default)]
pub struct TuiArgs {
    /// Project to scope the view to. Defaults to the current directory.
    #[arg(short = 'C', long = "path", value_name = "DIR")]
    pub path: Option<PathBuf>,
}

/// `aurora agent`
#[derive(Args, Debug, Clone)]
pub struct AgentArgs {
    /// What you want done.
    ///
    /// Joined into one prompt, so it needs quoting only when the shell would
    /// eat something. Omit it in a terminal and you are asked for it.
    ///
    /// Deliberately NOT `trailing_var_arg`. That setting makes everything
    /// after the first word part of the prompt — including flags — so
    /// `aurora agent "do it" --json` sent the model the literal text
    /// `do it --json` and printed the human summary. Flags after the prompt is
    /// the order people actually type, so it has to work; a prompt that really
    /// contains a leading `--` can be passed after a bare `--`.
    #[arg(value_name = "PROMPT")]
    pub prompt: Vec<String>,

    /// Project the task runs in. Defaults to the current directory.
    #[arg(short = 'C', long = "path", value_name = "DIR")]
    pub path: Option<PathBuf>,

    /// Model to run on — `glm-5.2`, or `fireworks:glm-5.2` to be exact.
    ///
    /// Omit it to use whatever the Agent Window has selected.
    #[arg(short = 'm', long, value_name = "MODEL")]
    pub model: Option<String>,

    /// Provider to run on, when the model name alone is ambiguous.
    #[arg(long, value_name = "ID")]
    pub provider: Option<String>,

    /// Continue this project's most recent conversation.
    ///
    /// Deliberately a bare flag with no optional value. An `Option<String>`
    /// here would parse `aurora agent -c "keep going"` as *continue the thread
    /// named "keep going"* with an empty prompt — the trailing prompt and the
    /// optional value are indistinguishable to any argument parser. Naming a
    /// specific conversation is [`Self::thread`] instead, which is
    /// unambiguous because its value is mandatory.
    #[arg(short = 'c', long = "continue")]
    pub continue_latest: bool,

    /// Continue a specific conversation, by id or any unique prefix of one.
    ///
    /// Implies `--continue`. Ids come from `aurora threads`; the first few
    /// characters are enough.
    #[arg(short = 't', long, value_name = "THREAD", conflicts_with = "continue_latest")]
    pub thread: Option<String>,

    /// Run in plan mode: read-only tools, no edits.
    #[arg(long, conflicts_with = "mode")]
    pub plan: bool,

    /// Execution mode. `--plan` is the shorthand for `--mode plan`.
    #[arg(long, value_enum, value_name = "MODE")]
    pub mode: Option<CliTaskMode>,

    /// Stream the run into this terminal.
    #[arg(short = 'f', long)]
    pub follow: bool,

    /// Also write the transcript to this file, as it happens.
    ///
    /// One JSON object per line, ending in a `result` record. Written live, so
    /// another program can read it while the task runs.
    #[arg(short = 'o', long, value_name = "FILE")]
    pub out: Option<PathBuf>,

    /// Machine-readable output.
    ///
    /// On its own, prints one JSON object naming the task id, the thread, and
    /// the transcript path, then exits — so a caller can capture the id and
    /// inspect that task later while others run alongside it. With `--follow`,
    /// streams the raw transcript records instead.
    #[arg(long)]
    pub json: bool,

    /// Include reasoning and token counts in the rendered view.
    #[arg(short = 'v', long)]
    pub verbose: bool,

    /// Fail instead of starting Aurora when it is not already running.
    #[arg(long)]
    pub no_launch: bool,

    /// Seconds to wait for Aurora to pick the task up before giving up.
    ///
    /// Bounds only the wait for the task to *start*. Once it is running it is
    /// allowed to take as long as it takes.
    #[arg(long, value_name = "SECS", default_value_t = 120)]
    pub start_timeout: u64,

    /// Never ask anything; fail instead. For scripts and CI.
    #[arg(long)]
    pub no_input: bool,

    /// When to colour the output.
    #[arg(long, value_enum, value_name = "WHEN", default_value_t = CliColor::Auto)]
    pub color: CliColor,
}

impl AgentArgs {
    /// The prompt as one string.
    pub fn prompt_text(&self) -> String {
        self.prompt.join(" ").trim().to_string()
    }

    /// Which conversation this task should join, if any.
    pub fn continuation(&self) -> Continuation {
        match self.thread.as_deref().map(str::trim) {
            Some(id) if !id.is_empty() => Continuation::Thread(id.to_string()),
            _ if self.continue_latest => Continuation::Latest,
            _ => Continuation::New,
        }
    }

    /// The execution mode this invocation asked for.
    pub fn task_mode(&self) -> TaskMode {
        if self.plan {
            return TaskMode::Plan;
        }
        match self.mode {
            Some(CliTaskMode::Plan) => TaskMode::Plan,
            Some(CliTaskMode::Agent) | None => TaskMode::Agent,
        }
    }

    /// Whether the terminal should stay attached and render the run.
    ///
    /// Deliberately independent of `--json`. The two answer different
    /// questions — `--follow` is *whether to wait*, `--json` is *what the
    /// output looks like* — and conflating them would remove the most useful
    /// combination there is: dispatch several tasks, capture each id as it
    /// returns, and inspect them independently afterwards.
    ///
    /// ```text
    /// a=$(aurora agent "audit api"  -C ./api  --json | jq -r .taskId)
    /// b=$(aurora agent "audit web"  -C ./web  --json | jq -r .taskId)
    /// aurora watch "$a"
    /// ```
    pub fn should_follow(&self) -> bool {
        self.follow
    }

    /// Whether interactive prompts are permitted.
    ///
    /// Suppressed by `--no-input`, and by `--json` — a script parsing the
    /// output stream must never be blocked on a picker it cannot see.
    pub fn interactive(&self) -> bool {
        !self.no_input && !self.json
    }
}

/// `aurora models`
#[derive(Args, Debug, Clone)]
pub struct ModelsArgs {
    /// Filter to models matching this name.
    #[arg(value_name = "QUERY")]
    pub query: Option<String>,

    /// Only models from this provider.
    #[arg(long, value_name = "ID")]
    pub provider: Option<String>,

    /// Machine-readable output.
    #[arg(long)]
    pub json: bool,

    /// When to colour the output.
    #[arg(long, value_enum, value_name = "WHEN", default_value_t = CliColor::Auto)]
    pub color: CliColor,
}

/// `aurora threads`
#[derive(Args, Debug, Clone)]
pub struct ThreadsArgs {
    /// Project whose conversations to list. Defaults to the current directory.
    #[arg(short = 'C', long = "path", value_name = "DIR")]
    pub path: Option<PathBuf>,

    /// Every project's conversations, not just this one's.
    #[arg(long)]
    pub all: bool,

    /// How many to show.
    #[arg(short = 'n', long, value_name = "N", default_value_t = 20)]
    pub limit: usize,

    /// Machine-readable output.
    #[arg(long)]
    pub json: bool,

    /// When to colour the output.
    #[arg(long, value_enum, value_name = "WHEN", default_value_t = CliColor::Auto)]
    pub color: CliColor,
}

/// `aurora watch`
#[derive(Args, Debug, Clone)]
pub struct WatchArgs {
    /// Task id, or any unique prefix of one.
    #[arg(value_name = "TASK")]
    pub task: String,

    /// Replay the transcript from the start rather than from now.
    #[arg(long)]
    pub from_start: bool,

    /// Print raw transcript JSON instead of a rendered view.
    #[arg(long)]
    pub json: bool,

    /// Include reasoning and token counts.
    #[arg(short = 'v', long)]
    pub verbose: bool,

    /// When to colour the output.
    #[arg(long, value_enum, value_name = "WHEN", default_value_t = CliColor::Auto)]
    pub color: CliColor,
}

/// `aurora tasks`
#[derive(Args, Debug, Clone)]
pub struct TasksArgs {
    /// Remove finished tasks now instead of waiting for them to age out.
    #[arg(long)]
    pub clean: bool,

    /// Machine-readable output.
    #[arg(long)]
    pub json: bool,

    /// When to colour the output.
    #[arg(long, value_enum, value_name = "WHEN", default_value_t = CliColor::Auto)]
    pub color: CliColor,
}

/// `aurora cancel`
#[derive(Args, Debug, Clone)]
pub struct CancelArgs {
    /// The task to stop, by id or any unique prefix of one.
    #[arg(value_name = "TASK")]
    pub task: String,

    /// When to colour the output.
    #[arg(long, value_enum, value_name = "WHEN", default_value_t = CliColor::Auto)]
    pub color: CliColor,
}

/// `aurora mcp`
///
/// No arguments today. It exists as a struct rather than a bare variant because
/// everything this could grow — a port for a future HTTP transport, a
/// restricted tool set — belongs here, and adding the struct later would change
/// the shape of the enum every match arm reads.
#[derive(Args, Debug, Clone, Default)]
pub struct McpArgs {}

/// Which conversation a dispatched task joins.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Continuation {
    /// Start a fresh conversation scoped to the workspace.
    New,
    /// Append to the project's most recently updated conversation.
    Latest,
    /// Append to a named one — an id, or a unique prefix of one.
    Thread(String),
}

/// Execution mode, as a CLI value.
///
/// A separate enum from [`TaskMode`] so `--mode` can grow terminal-only
/// spellings without touching the on-disk contract.
#[derive(ValueEnum, Debug, Clone, Copy, PartialEq, Eq)]
#[value(rename_all = "lower")]
pub enum CliTaskMode {
    /// Full tool access.
    Agent,
    /// Read-only tools, plus writing a plan.
    Plan,
}

/// `--color` as a CLI value.
#[derive(ValueEnum, Debug, Clone, Copy, PartialEq, Eq)]
#[value(rename_all = "lower")]
pub enum CliColor {
    /// Colour when writing to a terminal that supports it.
    Auto,
    /// Never colour.
    Never,
    /// Colour even when redirected.
    Always,
}

impl From<CliColor> for ColorChoice {
    fn from(value: CliColor) -> Self {
        match value {
            CliColor::Auto => ColorChoice::Auto,
            CliColor::Never => ColorChoice::Never,
            CliColor::Always => ColorChoice::Always,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    /// A standalone parser so these tests exercise the argument definitions
    /// without dragging in the whole launcher CLI.
    #[derive(Parser, Debug)]
    #[command(name = "aurora")]
    struct Harness {
        #[command(subcommand)]
        command: DelegateCommand,
    }

    fn agent_of(argv: &[&str]) -> AgentArgs {
        match Harness::try_parse_from(argv).expect("parses").command {
            DelegateCommand::Agent(args) => args,
            other => panic!("expected `agent`, got {other:?}"),
        }
    }

    #[test]
    fn a_bare_prompt_needs_no_quoting() {
        let args = agent_of(&["aurora", "agent", "fix", "the", "failing", "test"]);
        assert_eq!(args.prompt_text(), "fix the failing test");
    }

    #[test]
    fn a_quoted_prompt_survives_intact() {
        let args = agent_of(&["aurora", "agent", "fix the failing test"]);
        assert_eq!(args.prompt_text(), "fix the failing test");
    }

    #[test]
    fn flags_after_the_prompt_are_still_flags() {
        // The bug this closes: with `trailing_var_arg`, everything after the
        // first word — flags included — became prompt text. A live dispatch of
        // `agent "reply with: CLI OK" --json` sent the model
        // `reply with: CLI OK --json` and printed the human summary.
        //
        // Flags after the prompt is the order people type, so it has to work.
        let args = agent_of(&["aurora", "agent", "reply with: CLI OK", "--json"]);
        assert_eq!(args.prompt_text(), "reply with: CLI OK");
        assert!(args.json, "--json after the prompt was swallowed");

        let followed = agent_of(&["aurora", "agent", "do it", "--follow", "-v"]);
        assert_eq!(followed.prompt_text(), "do it");
        assert!(followed.follow);
        assert!(followed.verbose);
    }

    #[test]
    fn an_unquoted_prompt_still_works_with_trailing_flags() {
        let args = agent_of(&["aurora", "agent", "fix", "the", "test", "--follow"]);
        assert_eq!(args.prompt_text(), "fix the test");
        assert!(args.follow);
    }

    #[test]
    fn a_prompt_that_looks_like_a_flag_can_be_escaped() {
        // The escape hatch the doc comment promises.
        let args = agent_of(&["aurora", "agent", "--", "--not-a-flag"]);
        assert_eq!(args.prompt_text(), "--not-a-flag");
    }

    #[test]
    fn flags_and_prompt_coexist() {
        let args = agent_of(&[
            "aurora",
            "agent",
            "--model",
            "fireworks:glm-5.2",
            "-C",
            "E:/project",
            "refactor the timeline service",
        ]);
        assert_eq!(args.prompt_text(), "refactor the timeline service");
        assert_eq!(args.model.as_deref(), Some("fireworks:glm-5.2"));
        assert_eq!(args.path.as_deref(), Some(std::path::Path::new("E:/project")));
    }

    #[test]
    fn continue_never_swallows_the_prompt() {
        // The trap this design exists to close: with an optional-value
        // `--continue`, `-c "keep going"` parses the PROMPT as a thread id and
        // dispatches an empty task. A bare flag cannot do that.
        let bare = agent_of(&["aurora", "agent", "-c", "keep going"]);
        assert_eq!(bare.continuation(), Continuation::Latest);
        assert_eq!(bare.prompt_text(), "keep going");
    }

    #[test]
    fn a_named_thread_is_explicit() {
        let named = agent_of(&["aurora", "agent", "--thread", "01JQ8F", "keep going"]);
        assert_eq!(
            named.continuation(),
            Continuation::Thread("01JQ8F".to_string())
        );
        assert_eq!(named.prompt_text(), "keep going");
    }

    #[test]
    fn no_continuation_flag_means_a_new_conversation() {
        assert_eq!(
            agent_of(&["aurora", "agent", "start fresh"]).continuation(),
            Continuation::New
        );
    }

    #[test]
    fn continue_and_thread_cannot_disagree() {
        let clash = Harness::try_parse_from([
            "aurora", "agent", "-c", "--thread", "01JQ8F", "do it",
        ]);
        assert!(clash.is_err(), "--continue --thread should be rejected");
    }

    #[test]
    fn plan_is_shorthand_for_the_mode_flag() {
        assert_eq!(
            agent_of(&["aurora", "agent", "--plan", "look around"]).task_mode(),
            TaskMode::Plan
        );
        assert_eq!(
            agent_of(&["aurora", "agent", "--mode", "plan", "look around"]).task_mode(),
            TaskMode::Plan
        );
        assert_eq!(
            agent_of(&["aurora", "agent", "do it"]).task_mode(),
            TaskMode::Agent
        );
    }

    #[test]
    fn plan_and_mode_cannot_disagree() {
        // Two ways to say the same thing must not be usable to say two
        // different things.
        let clash = Harness::try_parse_from([
            "aurora", "agent", "--plan", "--mode", "agent", "do it",
        ]);
        assert!(clash.is_err(), "--plan --mode agent should be rejected");
    }

    #[test]
    fn json_alone_does_not_wait() {
        // The fan-out case: dispatch several tasks, capture each id, inspect
        // them later. Blocking here would serialise work meant to run at once.
        let args = agent_of(&["aurora", "agent", "--json", "do it"]);
        assert!(!args.should_follow());
    }

    #[test]
    fn json_and_follow_compose() {
        let args = agent_of(&["aurora", "agent", "--json", "--follow", "do it"]);
        assert!(args.should_follow());
        assert!(args.json);
    }

    #[test]
    fn json_and_no_input_both_suppress_prompts() {
        // A script must never block on a picker it cannot answer.
        assert!(!agent_of(&["aurora", "agent", "--json", "x"]).interactive());
        assert!(!agent_of(&["aurora", "agent", "--no-input", "x"]).interactive());
        assert!(agent_of(&["aurora", "agent", "x"]).interactive());
    }

    #[test]
    fn a_prompt_of_only_whitespace_is_empty() {
        let args = agent_of(&["aurora", "agent", "   "]);
        assert!(args.prompt_text().is_empty());
    }

    #[test]
    fn defaults_are_the_quiet_ones() {
        let args = agent_of(&["aurora", "agent", "do it"]);
        assert!(!args.should_follow(), "dispatch returns immediately");
        assert!(!args.verbose);
        assert!(!args.no_launch, "a cold Aurora is started, not an error");
        assert_eq!(args.color, CliColor::Auto);
    }

    #[test]
    fn run_is_an_alias_for_agent() {
        let parsed = Harness::try_parse_from(["aurora", "run", "do it"]).expect("parses");
        assert!(matches!(parsed.command, DelegateCommand::Agent(_)));
    }

    #[test]
    fn models_takes_an_optional_query() {
        match Harness::try_parse_from(["aurora", "models"])
            .expect("parses")
            .command
        {
            DelegateCommand::Models(args) => assert_eq!(args.query, None),
            other => panic!("expected `models`, got {other:?}"),
        }
        match Harness::try_parse_from(["aurora", "models", "glm-5.2"])
            .expect("parses")
            .command
        {
            DelegateCommand::Models(args) => assert_eq!(args.query.as_deref(), Some("glm-5.2")),
            other => panic!("expected `models`, got {other:?}"),
        }
    }

    #[test]
    fn watch_requires_a_task() {
        assert!(Harness::try_parse_from(["aurora", "watch"]).is_err());
        match Harness::try_parse_from(["aurora", "watch", "20260901T142233-7f3a91"])
            .expect("parses")
            .command
        {
            DelegateCommand::Watch(args) => assert_eq!(args.task, "20260901T142233-7f3a91"),
            other => panic!("expected `watch`, got {other:?}"),
        }
    }

    #[test]
    fn colour_choice_maps_across() {
        assert_eq!(ColorChoice::from(CliColor::Auto), ColorChoice::Auto);
        assert_eq!(ColorChoice::from(CliColor::Never), ColorChoice::Never);
        assert_eq!(ColorChoice::from(CliColor::Always), ColorChoice::Always);
    }

    #[test]
    fn the_command_tree_is_internally_valid() {
        // clap's own audit: catches duplicate shorts, bad defaults, and
        // conflicting arg ids at test time rather than at a user's terminal.
        use clap::CommandFactory;
        Harness::command().debug_assert();
    }
}
