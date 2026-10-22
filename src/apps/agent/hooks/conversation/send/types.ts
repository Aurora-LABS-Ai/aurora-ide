/**
 * Agent Window — send pipeline: the shapes callers see.
 *
 * Moved out of `useAgentWindowSend.ts` on 2026-10-19 so a caller that only
 * needs a type (the CLI task runner, the docked chat) does not read the
 * pipeline to find it.
 */

import type { AgentReportMeta } from "@/apps/agent/services/subagents/events";
import type { SendOutcome } from "@/apps/agent/hooks/conversation/send-outcome";
import type {
  AttachedPromptChip,
  DbThread,
} from "@/apps/agent/services/threads/thread-service";

/** A tool waiting on the user because its approval mode is `always_ask`. */
export interface PendingApproval {
  id: string;
  toolName: string;
  /** Raw JSON arguments (provider format), for the prompt preview. */
  args: string;
}

/** Per-send options that are not part of the message itself. */
export interface SendOptions {
  /**
   * Execution mode for THIS turn only, overriding the window's setting.
   *
   * `aurora agent --plan` is the caller. Per-turn rather than through
   * `setAgentExecutionMode` because that setter is global: it would leave the
   * window in plan mode after a dispatched task finished, and two concurrent
   * dispatches in different modes would each clobber the other's.
   */
  executionMode?: "agent" | "plan";
  /**
   * The `aurora agent` task this send fulfils, when a terminal dispatched it.
   *
   * Forwarded to Rust, which tees the turn's events into that task's
   * transcript so `aurora agent --follow` watches the same work this window
   * renders. Absent for every send a person makes.
   */
  cliTaskId?: string | null;
  /**
   * The model for THIS turn only, as `providerId:modelKey`.
   *
   * `aurora agent --model` and the `aurora_agent_dispatch` tool are the
   * callers. Per-turn for the same reason {@link SendOptions.executionMode} is,
   * plus one specific to the model: a dispatch that starts a NEW conversation
   * cannot express its choice through the thread at all.
   *
   * `setThreadModel` records a pin by mapping over `threads`/`allThreads`, and
   * a freshly created thread is deliberately in neither — `refreshThreads`
   * keeps 0-message threads out of the rail, so no row exists until the first
   * message lands. The pin therefore no-opped in memory, `resolveThreadModel`
   * found nothing, and the turn fell back to the user's default: a task
   * dispatched with `--model luna` ran on whatever the window had selected,
   * and only the transcript's echo of the *requested* model made it look
   * right.
   */
  model?: string | null;
  /**
   * Who is starting this turn. Defaults to the user, which is every send a
   * person makes.
   *
   * `"process"` is the background report: a process ended while this
   * conversation was idle, so nothing was going to tell the model unless
   * something started a turn. The message is real and gets answered, but it is
   * persisted as a process event rather than as words anybody typed — no user
   * bubble, no pill, no title derived from it.
   */
  origin?: "user" | "process" | "subagent";
  /** The transcript's one line when {@link SendOptions.origin} is `"process"` or `"subagent"`. */
  summary?: string | null;
  /** The agent a `"subagent"` report is about. */
  agent?: AgentReportMeta | null;
}

export interface AgentWindowSend {
  /** True while a turn is streaming. */
  sending: boolean;
  /**
   * Send (or resend) a turn. Resolves to what happened: a turn `started`,
   * the text was `queued` into a turn already running, or it was `skipped`
   * (empty text, no thread, or a turn opened on the thread first). A caller
   * handing over something it cannot regenerate — a sub-agent's report, a
   * process ending — keeps it on `skipped`.
   */
  send: (
    text: string,
    fileChips?: AttachedPromptChip[],
    options?: SendOptions,
  ) => Promise<SendOutcome>;
  /** Compact the open thread immediately. No-op when no idle thread is open. */
  compact: () => Promise<void>;
  /** Cancel the in-flight turn. */
  stop: () => void;
  /** The tool currently awaiting approval, or `null`. */
  pendingApproval: PendingApproval | null;
  /** Approve the pending tool once. */
  approve: () => void;
  /** Approve + remember (flip the tool to auto for future turns). */
  approveAlways: () => void;
  /** Reject the pending tool. */
  reject: () => void;
}

export interface BackgroundSendTarget {
  threadId: string;
  projectRoot: string | null;
  seed: DbThread;
  /**
   * True when a PERSON pressed send on this thread's own composer, as opposed
   * to the pipeline resubmitting on their behalf (the post-turn queue flush).
   *
   * It decides whether the turn consumes what a composer staged — images, `/`
   * directives, inspector picks — and whether sending mid-turn queues instead
   * of being dropped. A resubmit must do neither: the staged items belong to
   * the next thing the user types, not to a message they already sent.
   */
  interactive?: boolean;
  /**
   * The `aurora agent` task this send is fulfilling, when a terminal
   * dispatched it.
   *
   * Forwarded to Rust, which tees the turn's events into that task's
   * transcript so the terminal can follow the same work. Absent for every
   * send a person makes, which is the overwhelming majority.
   */
  cliTaskId?: string | null;
}

/**
 * Which conversation a send pipeline drives.
 *
 * Omitted, the pipeline follows the OPEN chat — the main pane's behaviour. A
 * chat docked in the side panel passes its own binding, so its composer, stop
 * button and approval prompt act on ITS thread while the main pane keeps
 * driving another one. Both can stream at the same time; the runtime already
 * locks per thread and the store already keys live turns by thread id.
 */
export interface BoundConversation {
  threadId: string;
  projectRoot: string | null;
  /**
   * This panel's loaded transcript, used to seed a live turn.
   *
   * A function, not a value: the seed is read at send time, so a transcript
   * that finished loading (or grew) after mount is still the one used. Without
   * it a docked send would open its live turn on an empty stub and the history
   * above the new message would vanish until the turn ended.
   */
  getSeed: () => DbThread | null;
}
