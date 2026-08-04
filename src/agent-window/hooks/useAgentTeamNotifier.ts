/**
 * Agent Window — team completion notifier.
 *
 * The team runs on its own background engine, so when it finishes the Lead
 * (your chat model) would otherwise stay silent — the run just ends and nothing
 * appears in the chat. This closes that gap: it listens for the dispatcher's
 * terminal lifecycle events (identified by structured `meta.terminal` =
 * "done" | "failed", never body text) on the `team_event` channel and submits a
 * visible follow-up turn to the Lead so it verifies and reports the outcome the
 * moment the run ends.
 *
 * Agent-window specific (the IDE's `useTeamRunNotifier` is welded to the main
 * window + IDE stores + `agentExecutionMode === "team"`, none of which hold
 * here — the agent window runs Team mode *effectively* from `teamEnabled`).
 *
 * Robustness: the subscription is app-lifetime (module scope, started once).
 * If the run finishes while the Team screen is open — so the conversation (and
 * its sender) is unmounted — the report is STASHED and delivered the moment a
 * sender re-registers, so the Lead never silently misses a completion.
 *
 * Belt-and-suspenders: a live `team_event` can be missed entirely (the window
 * wasn't listening yet, the broadcast was dropped, or the run ended during a
 * reconnect gap). So alongside the stream we run a low-frequency **status poll**
 * that reads the dispatcher's terminal `team_run_status` for the active project
 * and delivers the same report. Both paths dedupe on the run id, so a completion
 * is reported exactly once no matter which path sees it first.
 */
import { useEffect } from "react";

import {
  ackRunStatus,
  getRunStatus,
  leadInbox,
  resolveProjectId,
  subscribeTeamEvents,
} from "../../services/team-client";
import { isAuroraRuntimeAvailable } from "../../lib/runtime";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useAgentChatStore } from "../store/useAgentChatStore";
import type {
  TeamEventPayload,
  TeamLifecycleMeta,
  TeamRunStatus,
} from "../../types/team";

type SendFn = (text: string) => Promise<void>;
type TerminalState = "done" | "failed";
type Notice = {
  text: string;
  projectId: string;
  originThreadId?: string;
  originSurface?: string;
  /** Dispatcher run id — used to ack the run durably at delivery time. */
  runId?: string;
  /**
   * What this notice is. Completion reports ack the run at delivery;
   * member questions must NOT (the run is still going).
   */
  kind?: "completion" | "question";
};

const AGENT_WINDOW_SURFACE = "agent-window";

/** How often the safety poll reads `team_run_status` for the active project. */
const RUN_STATUS_POLL_MS = 7000;

/**
 * How often the lead-inbox poll checks for member questions. Faster than the
 * status poll: a member asking the Lead is paused (`waiting_input`) until the
 * answer arrives, so latency here is a member's idle time.
 */
const LEAD_INBOX_POLL_MS = 2500;

// Module scope: one subscription + one active sender + pending reports.
let activeSender: SendFn | null = null;
let subscriptionStarted = false;
let pollStarted = false;
let flushingPending = false;
let pollInFlight = false;
let projectIdCache: { root: string; projectId: string } | null = null;
const pendingByThread = new Map<string, Notice>();
const pendingByProject = new Map<string, Notice>();
const handledEventIds = new Set<string>();
// Dedupe DELIVERY across the live stream and the safety poll: keyed by run so a
// completion is reported once even when both paths observe it.
const handledRuns = new Set<string>();
// Member questions already injected into the Lead's conversation (by ticket id).
const handledQuestions = new Set<string>();
let inboxPollStarted = false;
let inboxPollInFlight = false;

/**
 * Stable per-run key shared by both delivery paths. Prefers the dispatcher's
 * `runId`; falls back to `projectId:finishedAt` (always set on a terminal run)
 * so the poll can still dedupe when no id is present. `null` means "no stable
 * key" — callers must not dedupe (or repeatedly deliver) on a null key.
 */
function runKey(
  runId?: string,
  projectId?: string,
  finishedAt?: string,
): string | null {
  if (runId && runId.trim() !== "") return `run:${runId.trim()}`;
  if (projectId && finishedAt) return `fin:${projectId}:${finishedAt}`;
  return null;
}

const completionPrompt = (): string =>
  "[Automatic team notification — the background team run just FINISHED] " +
  "Call team_status and team_chat for what each member actually built, " +
  "then give me a clear report (what was built, by whom, and anything left to decide). " +
  "Do NOT call team_dispatch again for the same effort automatically. Report the worker outcome, then wait for the user unless they asked you for a follow-up.";

const failurePrompt = (body: string): string =>
  `[Automatic team notification — the background team run FAILED] ${body} ` +
  "Read team_status and team_chat, then tell me exactly what went wrong in plain language. " +
  "Do NOT call team_dispatch again on your own and do NOT retry anything automatically — " +
  "explain the failure, suggest options, and wait for the user to decide.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object";

const pickString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
};

function lifecycleMeta(payload: TeamEventPayload): TeamLifecycleMeta {
  const meta = isRecord(payload.event.meta) ? payload.event.meta : {};
  return {
    terminal: payload.terminal ?? (meta.terminal as TeamLifecycleMeta["terminal"]),
    originThreadId: pickString(payload.originThreadId, meta.originThreadId),
    originSurface: pickString(payload.originSurface, meta.originSurface),
    runId: pickString(payload.runId, meta.runId),
  };
}

function terminalState(payload: TeamEventPayload): TerminalState | null {
  const { terminal } = lifecycleMeta(payload);
  if (typeof terminal === "string") {
    const normalized = terminal.toLowerCase();
    if (normalized === "failed" || normalized === "failure") return "failed";
    if (
      normalized === "done" ||
      normalized === "complete" ||
      normalized === "completed" ||
      normalized === "success"
    ) {
      return "done";
    }
    return null;
  }
  // Boolean tolerance only — the dispatcher emits explicit "done"/"failed"
  // strings, so this never has to fall back to parsing the message body.
  if (terminal === true) return "done";
  if (terminal === false) return "failed";
  return null;
}

function noticeFromPayload(payload: TeamEventPayload): Notice | null {
  if (payload.event.kind !== "system" || payload.event.author !== "lead") return null;
  const terminal = terminalState(payload);
  if (!terminal) return null;
  const meta = lifecycleMeta(payload);
  return {
    text: terminal === "done" ? completionPrompt() : failurePrompt(payload.event.body),
    projectId: payload.projectId,
    originThreadId: meta.originThreadId,
    originSurface: meta.originSurface,
    runId: meta.runId,
  };
}

/**
 * Build the same completion report from a polled {@link TeamRunStatus} snapshot
 * (the fallback path). Returns `null` unless the run is in a terminal state.
 */
function noticeFromStatus(
  status: TeamRunStatus,
  projectId: string,
): Notice | null {
  if (status.state !== "done" && status.state !== "failed") return null;
  const failureBody = pickString(status.error) ?? "The team run failed.";
  return {
    text: status.state === "done" ? completionPrompt() : failurePrompt(failureBody),
    projectId,
    originThreadId: pickString(status.originThreadId),
    originSurface: pickString(status.originSurface),
    runId: pickString(status.runId),
  };
}

function acceptsSurface(notice: Notice): boolean {
  return !notice.originSurface || notice.originSurface === AGENT_WINDOW_SURFACE;
}

async function activeProjectMatches(projectId: string): Promise<boolean> {
  const root = useAgentChatStore.getState().projectRoot;
  if (!root) return false;
  if (projectIdCache?.root === root) return projectIdCache.projectId === projectId;
  try {
    const resolved = await resolveProjectId(root);
    projectIdCache = { root, projectId: resolved };
    return resolved === projectId;
  } catch {
    return false;
  }
}

function buffer(notice: Notice): void {
  if (notice.originThreadId) {
    pendingByThread.set(notice.originThreadId, notice);
  } else {
    pendingByProject.set(notice.projectId, notice);
  }
}

function sendNow(notice: Notice): void {
  const send = activeSender;
  if (!send) {
    buffer(notice);
    return;
  }
  const chat = useAgentChatStore.getState();
  // Durable exactly-once: flip the dispatcher's `acknowledged` flag the moment
  // the report is actually handed to the Lead. A window reload after this point
  // can never re-deliver the completion (and so never re-trigger the work).
  // Member QUESTIONS never ack — the run is still going.
  const root = chat.projectRoot;
  if (root && notice.kind !== "question") {
    void ackRunStatus(root, notice.runId).catch(() => {
      /* best-effort; the in-memory handledRuns set still dedupes this session */
    });
  }
  const threadId = notice.originThreadId ?? chat.currentThreadId;
  // Only ride the mid-turn queue when THAT specific thread is actively
  // streaming. `sending` is a global flag (true if *any* thread streams), but
  // the queued slot only drains at the end of a live turn on its own thread —
  // enqueuing to an idle thread would strand the report. Check the per-thread
  // `liveTurns` entry instead, and otherwise submit a fresh turn now.
  if (threadId && chat.liveTurns[threadId]) {
    void chat.enqueueMessage(threadId, notice.text);
    return;
  }
  void send(notice.text);
}

async function deliverOrBuffer(notice: Notice): Promise<void> {
  if (!useSettingsStore.getState().teamEnabled) return;
  if (!acceptsSurface(notice)) return;

  const currentThreadId = useAgentChatStore.getState().currentThreadId;
  if (notice.originThreadId && currentThreadId !== notice.originThreadId) {
    buffer(notice);
    return;
  }
  if (!(await activeProjectMatches(notice.projectId))) {
    buffer(notice);
    return;
  }
  sendNow(notice);
}

async function flushPendingForActive(): Promise<void> {
  if (flushingPending || !activeSender) return;
  flushingPending = true;
  try {
    const currentThreadId = useAgentChatStore.getState().currentThreadId;
    if (currentThreadId) {
      const notice = pendingByThread.get(currentThreadId);
      if (
        notice &&
        acceptsSurface(notice) &&
        (await activeProjectMatches(notice.projectId)) &&
        useAgentChatStore.getState().currentThreadId === currentThreadId
      ) {
        pendingByThread.delete(currentThreadId);
        sendNow(notice);
      }
    }

    for (const [projectId, notice] of pendingByProject) {
      if (
        acceptsSurface(notice) &&
        (await activeProjectMatches(projectId)) &&
        !notice.originThreadId
      ) {
        pendingByProject.delete(projectId);
        sendNow(notice);
      }
    }
  } finally {
    flushingPending = false;
  }
}

function onTeamEvent(payload: TeamEventPayload): void {
  const notice = noticeFromPayload(payload);
  if (!notice) return;
  // Live stream + safety poll can surface the same run twice — dedupe on both
  // the raw event id (re-broadcasts) and the run id (cross-path).
  if (handledEventIds.has(payload.event.id)) return;
  handledEventIds.add(payload.event.id);
  const { runId } = lifecycleMeta(payload);
  const key = runKey(runId, payload.projectId);
  if (key) {
    if (handledRuns.has(key)) return;
    handledRuns.add(key);
  }
  void deliverOrBuffer(notice);
}

/**
 * Safety poll: read the dispatcher's terminal run status for the active project
 * and deliver the completion report the live stream may have missed. Deduped
 * against {@link onTeamEvent} via {@link handledRuns}. No-ops when Team is off,
 * no project is active, or the run isn't terminal.
 */
async function pollRunStatusOnce(): Promise<void> {
  if (pollInFlight) return;
  if (!isAuroraRuntimeAvailable()) return;
  if (!useSettingsStore.getState().teamEnabled) return;
  const root = useAgentChatStore.getState().projectRoot;
  if (!root) return;
  pollInFlight = true;
  try {
    const status = await getRunStatus(root);
    if (status.state !== "done" && status.state !== "failed") return;
    // Already reported to the Lead (this window or a previous one) — the
    // dispatcher's flag is the durable source of truth, so never re-deliver.
    if (status.acknowledged) return;
    const projectId = await resolveProjectId(root);
    // A terminal run always carries a stable key (runId, else finishedAt); if it
    // somehow doesn't, skip rather than risk re-delivering every poll tick.
    const key = runKey(status.runId, projectId, status.finishedAt);
    if (!key || handledRuns.has(key)) return;
    const notice = noticeFromStatus(status, projectId);
    if (!notice) return;
    handledRuns.add(key);
    await deliverOrBuffer(notice);
  } catch {
    // Transient (runtime unavailable, project not initialized) — try next tick.
  } finally {
    pollInFlight = false;
  }
}

const questionPrompt = (q: {
  id: string;
  role: string;
  from: string;
  question: string;
}): string =>
  `[Team question — ${q.role} is paused, waiting on your answer]
${q.question}

` +
  `Answer NOW with team_reply(questionId: "${q.id}", text: "<your answer>"). ` +
  "If they asked for write access to specific paths and you agree, also call " +
  `team_grant_scope(agentId: "${q.from}", paths: [...]). ` +
  "Be concrete and decisive — the member resumes the moment your reply lands, and it gives up waiting after a few minutes.";

/**
 * Lead-inbox poll: pick up questions members routed to the real Lead
 * (ask_lead → `waiting_input`) and inject each into the Lead's conversation
 * exactly once. The member is paused until the Lead's team_reply lands, so
 * this runs at a tighter interval than the completion safety poll.
 */
async function pollLeadInboxOnce(): Promise<void> {
  if (inboxPollInFlight) return;
  if (!isAuroraRuntimeAvailable()) return;
  if (!useSettingsStore.getState().teamEnabled) return;
  const root = useAgentChatStore.getState().projectRoot;
  if (!root) return;
  inboxPollInFlight = true;
  try {
    const questions = await leadInbox(root);
    if (questions.length === 0) return;
    const projectId = await resolveProjectId(root);
    for (const q of questions) {
      if (handledQuestions.has(q.id)) continue;
      handledQuestions.add(q.id);
      await deliverOrBuffer({
        text: questionPrompt(q),
        projectId,
        runId: q.runId,
        kind: "question",
      });
    }
  } catch {
    // Transient — try next tick.
  } finally {
    inboxPollInFlight = false;
  }
}

/**
 * Register `handleSend` as the completion-report sender (flushing any report
 * that landed while no sender was mounted) and, once per window, start the
 * team-event subscription.
 */
export function useAgentTeamNotifier(handleSend: SendFn): void {
  useEffect(() => {
    activeSender = handleSend;
    void flushPendingForActive();
    // Opportunistic catch-up: a completion may have landed while no sender was
    // mounted and the live event was missed — check the status right away.
    void pollRunStatusOnce();
    const unsubscribe = useAgentChatStore.subscribe((state, prev) => {
      if (
        state.currentThreadId !== prev.currentThreadId ||
        state.projectRoot !== prev.projectRoot
      ) {
        void flushPendingForActive();
        void pollRunStatusOnce();
      }
    });
    return () => {
      unsubscribe();
      if (activeSender === handleSend) activeSender = null;
    };
  }, [handleSend]);

  useEffect(() => {
    if (!isAuroraRuntimeAvailable()) return;
    // App-lifetime subscription — never unlistened, so the team can finish at
    // any time (even while the user is elsewhere) and still be reported.
    if (!subscriptionStarted) {
      subscriptionStarted = true;
      void subscribeTeamEvents((payload) => {
        onTeamEvent(payload);
      }).catch(() => {
        subscriptionStarted = false; // allow a later retry
      });
    }
    // App-lifetime safety poll behind the live stream (deduped on run id). Not
    // torn down on unmount — like the subscription, it must outlive any single
    // conversation so a background run is always reported.
    if (!pollStarted) {
      pollStarted = true;
      window.setInterval(() => {
        void pollRunStatusOnce();
      }, RUN_STATUS_POLL_MS);
    }
    // App-lifetime lead-inbox poll: member questions reach the real Lead
    // while it (and the user) sit in the conversation.
    if (!inboxPollStarted) {
      inboxPollStarted = true;
      window.setInterval(() => {
        void pollLeadInboxOnce();
      }, LEAD_INBOX_POLL_MS);
    }
  }, []);
}
