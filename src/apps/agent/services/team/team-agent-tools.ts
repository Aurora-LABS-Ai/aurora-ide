/**
 * Lead chat-facing team-control tools (Phase 5, ground truth §13/§5).
 *
 * These are the tools the **Lead** calls from the main IDE chat to drive the
 * Aurora Agent Team while the user keeps talking. They are dispatched through
 * the same frontend bridge as the skill tools (see `aurora-tools.ts`), but
 * unlike skills they orchestrate the team: every mutation lands in Rust via
 * the `team_*` commands (`team-client.ts`), so the safety/scope logic
 * stays server-side. This file is only the thin chat→command shim plus the
 * `show_team` window launch.
 *
 * Approval: the team flow needs no per-tool approval — the user opts in by
 * enabling Team in Agent settings and selecting Team mode in the input box.
 * Execution is still hard-gated on `teamEnabled` so a stray call without the
 * feature on fails deterministically instead of half-running.
 *
 * Contract: each executor returns a JSON-serialized string (the uniform
 * tool-result shape). Failures throw; the bridge wraps them in `{ error,
 * tool }` with `isError=true`.
 */
import { AgentRuntimeClient } from "@/apps/agent/services/runtime/agent-runtime-client";
import type { ProviderConfigSnapshot } from "@/apps/agent/services/runtime/agent-runtime-client";
import * as team from "@/apps/agent/services/team/team-client";
import { requestOpenTeamView } from "@/apps/agent/services/team/team-view-bridge";
import { useSettingsStore } from "@/kernel/store/useSettingsStore";
import { useThreadStore } from "@/apps/agent/store/conversation/useThreadStore";
import { useWorkspaceStore } from "@/kernel/store/useWorkspaceStore";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import type {
  DispatchMember,
  TeamDispatchOrigin,
  TeamProjectState,
} from "@/kernel/types/team";

/**
 * Tool names the Lead uses to control the team. Kept in one Set so the bridge
 * (`isTeamLeadTool`) and the dispatcher (`executeTeamLeadTool`) can't drift.
 */
const TEAM_LEAD_TOOLS = new Set<string>([
  "team_show",
  "team_status",
  "team_chat",
  "team_message",
  "team_reply",
  "team_grant_scope",
  "team_dispatch",
  "team_remove_agent",
  "team_disband",
]);

/** `true` when `toolName` is a Lead team-control tool handled on the frontend. */
export function isTeamLeadTool(toolName: string): boolean {
  return TEAM_LEAD_TOOLS.has(toolName);
}

/**
 * The dispatching turn's authoritative identity, threaded from the runtime tool
 * seam (`agent-runtime-client` → `aurora-tools`). Team tools MUST use these over
 * the global stores: the global workspace root / open thread track whatever
 * project+chat is on screen, which drifts the instant a background turn drives
 * the team while another chat is open — the root cause of the "team ran against
 * the wrong project" mismatch. `undefined` fields fall back to the stores.
 */
export interface TeamToolContext {
  /** The turn's pinned workspace root (authoritative over `useWorkspaceStore`). */
  workspacePath?: string | null;
  /** The turn's thread id (authoritative over the currently-open chat). */
  threadId?: string;
}

// ── shared helpers ────────────────────────────────────────────────────

/**
 * Resolve the repo root the team should run against, or throw a model-readable
 * error. Prefers the dispatching turn's pinned `workspacePath` and only falls
 * back to the global store when no turn context is present (legacy callers).
 */
function requireRepoPath(ctx?: TeamToolContext): string {
  const pinned =
    typeof ctx?.workspacePath === "string" ? ctx.workspacePath.trim() : "";
  const raw = pinned !== "" ? pinned : useWorkspaceStore.getState().rootPath;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(
      "No workspace is open. Open a folder before running the team.",
    );
  }
  return raw;
}

/** Hard gate: the team flow only runs when the user enabled it in settings. */
function requireTeamEnabled(): void {
  if (!useSettingsStore.getState().teamEnabled) {
    throw new Error(
      "Agent Team is disabled. Ask the user to enable it in the Agent Window under Settings → Team, then retry.",
    );
  }
}

/**
 * Providers for the background run. The Lead and worker calls can use separate
 * settings, each falling back to the active chat model.
 */
function providerSnaps(): {
  lead: ProviderConfigSnapshot;
  member: ProviderConfigSnapshot;
} {
  const settings = useSettingsStore.getState();
  const leadConfig = settings.getTeamLeadConfig();
  const memberConfig = settings.getTeamMemberConfig();
  if (!leadConfig || !memberConfig) {
    throw new Error(
      "No model is configured. Set Team models under Settings → Team, or select an active chat model.",
    );
  }
  return {
    lead: AgentRuntimeClient.buildProviderConfigSnapshot(leadConfig),
    member: AgentRuntimeClient.buildProviderConfigSnapshot(memberConfig),
  };
}

function dispatchOrigin(ctx?: TeamToolContext): TeamDispatchOrigin | undefined {
  // Route the completion report back to the thread that DISPATCHED (from the
  // turn ctx), not whatever chat is open now — a background turn can dispatch
  // while the user is viewing a different chat. Team mode only runs in the
  // agent window today, so that is the surface for a ctx-driven dispatch.
  const turnThreadId = ctx?.threadId?.trim();
  if (turnThreadId) {
    return { originThreadId: turnThreadId, originSurface: "agent-window" };
  }

  const agentWindowThreadId = useAgentChatStore.getState().currentThreadId;
  if (agentWindowThreadId) {
    return { originThreadId: agentWindowThreadId, originSurface: "agent-window" };
  }

  const mainThreadId = useThreadStore.getState().currentThreadId;
  return mainThreadId
    ? { originThreadId: mainThreadId, originSurface: "main-ide" }
    : undefined;
}

const requireString = (args: Record<string, unknown>, key: string): string => {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`'${key}' is required`);
  }
  return value.trim();
};

/** Compact, model-friendly digest of the brain after an operation. */
function summarize(state: TeamProjectState): Record<string, unknown> {
  const agents = state.team.agents;
  return {
    phase: state.team.phase,
    agents: agents.map((a) => ({
      id: a.id,
      role: a.role,
      model: a.model ?? null,
      status: a.status,
    })),
    tasks: {
      total: state.tasks.tasks.length,
      done: state.tasks.tasks.filter((t) => t.status === "done").length,
    },
    contracts: state.scopeMap.assignments.flatMap((a) => a.ownedContracts),
  };
}

// ── individual tools ──────────────────────────────────────────────────

async function runShow(ctx?: TeamToolContext): Promise<string> {
  requireRepoPath(ctx);
  requestOpenTeamView();
  return JSON.stringify({
    ok: true,
    message: "Opened the Team panel beside the chat. The user can watch the team live there.",
  });
}

async function runStatus(ctx?: TeamToolContext): Promise<string> {
  const repoPath = requireRepoPath(ctx);
  const state = await team.getTeamState(repoPath, 0);
  const run = await team.getRunStatus(repoPath);
  return JSON.stringify({
    ok: true,
    initialized: state.initialized,
    run: {
      state: run.state,
      phase: run.phase ?? null,
      goal: run.goal ?? null,
      error: run.error ?? null,
    },
    // Live per-member states while running; each member's own report once done.
    members: (run.members ?? []).map((m) => ({
      id: m.id,
      role: m.role,
      status: m.status,
      changedFiles: m.changedCount,
    })),
    reports: (run.reports ?? []).map((r) => ({
      role: r.role,
      status: r.status,
      summary: r.summary,
      changedFiles: r.changedFiles,
    })),
    ...summarize(state),
  });
}

/**
 * Read the team's group chat — the live conversation between the Lead and the
 * ICs (messages, boundary questions, published contracts, review verdicts,
 * lifecycle notes). This is how the Lead "looks in" on what the team is saying
 * while it works in the background.
 */
async function runChat(
  args: Record<string, unknown>,
  ctx?: TeamToolContext,
): Promise<string> {
  const repoPath = requireRepoPath(ctx);
  const limit = optionalCount(args, "limit") ?? 40;
  const events = await team.getChannelTail(repoPath, limit);
  const run = await team.getRunStatus(repoPath);
  const messages = events.map((e) => ({
    from: e.author,
    kind: e.kind,
    text: e.body,
    ts: e.ts,
  }));
  return JSON.stringify({
    ok: true,
    run: { state: run.state, phase: run.phase ?? null },
    count: messages.length,
    messages,
  });
}

/** Optional positive integer arg, floored; `undefined` when absent/invalid. */
const optionalCount = (
  args: Record<string, unknown>,
  key: string,
): number | undefined => {
  const raw = args[key];
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : NaN;
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.floor(n);
};

/**
 * Parse the `members` array from a `team_dispatch` call: the dispatching agent
 * defines each member's role, instructions, and owned paths itself. Throws a
 * model-readable error when an entry is unusable, so the model fixes the call
 * instead of a member silently doing nothing.
 */
function requireMembers(args: Record<string, unknown>): DispatchMember[] {
  const raw = args.members;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      "'members' is required: define your team — one entry per member with role, task (their full instructions), and scope (paths they own).",
    );
  }
  return raw.map((entry, i) => {
    const m = (entry ?? {}) as Record<string, unknown>;
    const role = typeof m.role === "string" ? m.role.trim() : "";
    const task = typeof m.task === "string" ? m.task.trim() : "";
    const scope = Array.isArray(m.scope)
      ? m.scope.filter((s): s is string => typeof s === "string" && s.trim() !== "")
      : [];
    if (!role) throw new Error(`members[${i}] needs a 'role'`);
    if (!task) {
      throw new Error(
        `members[${i}] ('${role}') needs a 'task' — its full instructions; the member sees nothing else.`,
      );
    }
    if (scope.length === 0) {
      throw new Error(
        `members[${i}] ('${role}') needs a non-empty 'scope' — the repo paths it owns and may write.`,
      );
    }
    return { role, task, scope };
  });
}

/**
 * Dispatch the whole team in the background and return IMMEDIATELY (the team is
 * its own engine). The caller defines the team in the call (roles, tasks,
 * scopes); the engine convenes exactly that roster and runs the workers while
 * the Lead stays free to keep chatting. The Lead learns the outcome from the
 * run status injected into its context every message — it does NOT wait.
 */
async function runDispatch(
  args: Record<string, unknown>,
  ctx?: TeamToolContext,
): Promise<string> {
  requireTeamEnabled();
  const repoPath = requireRepoPath(ctx);
  const goal = requireString(args, "goal");
  const members = requireMembers(args);
  // Loop breaker: a run with this EXACT goal that just finished must not be
  // silently re-run. Models sometimes react to the automatic completion
  // notification by dispatching the same goal again, which redoes all the work
  // in an endless cycle. A genuinely new effort has a new goal; a deliberate
  // re-run of the same goal is still possible once the cooldown passes (or the
  // user rephrases it).
  try {
    const last = await team.getRunStatus(repoPath);
    if (
      last.state === "done" &&
      typeof last.goal === "string" &&
      last.goal.trim() === goal &&
      last.finishedAt &&
      Date.now() - Date.parse(last.finishedAt) < 3 * 60_000
    ) {
      throw new Error(
        "A team run with this exact goal just finished — its work is already done. " +
          "Do not re-dispatch it. Report the outcome to the user instead (team_status / team_chat); " +
          "only dispatch again if the user explicitly asks for a new run.",
      );
    }
  } catch (err) {
    if (err instanceof Error && /just finished/.test(err.message)) throw err;
    // Status read failed (no runtime / no run yet) — dispatch proceeds normally.
  }
  const { lead, member } = providerSnaps();
  // The "Maximum workers" setting IS the worker (IC) ceiling — the Lead is
  // separate and always present, not counted here. The Rust runtime, however,
  // counts the Lead inside `maxSize` (`ic_cap = maxSize - 1`), so we pass
  // `workers + 1` as the total and staff up to `workerCap` members.
  const workerCap = Math.max(1, useSettingsStore.getState().maxTeamSize);
  const staffed = members.slice(0, workerCap);
  const origin = dispatchOrigin(ctx);
  // Reveal the embedded Team screen so the user watches the run stream in live.
  requestOpenTeamView();
  // Fire-and-return: this resolves as soon as the run is dispatched, NOT when
  // it finishes. Throws if a run is already in progress for this workspace.
  const state = await team.dispatchTeam(
    repoPath,
    goal,
    staffed,
    lead,
    member,
    workerCap + 1, // total roster incl. the Lead → runtime allows `workerCap` members
    origin,
  );
  const sizeNote =
    staffed.length < members.length
      ? ` (staffed the first ${staffed.length} of ${members.length} members; your Maximum workers setting is ${workerCap} — ask the user to raise it under Settings → Team to run more)`
      : "";
  return JSON.stringify({
    ok: true,
    dispatched: true,
    message:
      `Team dispatched${sizeNote}. The workers are handling their assignments in the background — this did NOT block. ` +
      "Tell the user the team is on it and that you'll report back when they finish. Do NOT wait or re-dispatch: their live status rides with every message and streams in the Team screen; use team_status or team_chat to check in whenever you like.",
    members: staffed.map((m) => m.role),
    ...summarize(state),
  });
}

/**
 * Say something to the team as the Lead: posted in the group chat AND
 * delivered directly into the working members' live conversations, so they
 * read it mid-work — real steering, not a note they might never see.
 */
async function runMessage(
  args: Record<string, unknown>,
  ctx?: TeamToolContext,
): Promise<string> {
  requireTeamEnabled();
  const repoPath = requireRepoPath(ctx);
  const text = requireString(args, "text");
  const to =
    typeof args.to === "string" && args.to.trim() !== ""
      ? args.to.trim()
      : undefined;
  const { delivered } = await team.leadMessage(repoPath, text, to);
  return JSON.stringify({
    ok: true,
    delivered,
    message:
      delivered.length > 0
        ? `Delivered into ${delivered.length} member conversation(s); also posted in the team chat.`
        : "Posted in the team chat. No member is live right now (the run may have finished), so nobody received it directly.",
  });
}

/**
 * Answer a member's ask_lead question. The member is paused (waiting_input)
 * until this lands; it resumes immediately with the answer.
 */
async function runReply(
  args: Record<string, unknown>,
  ctx?: TeamToolContext,
): Promise<string> {
  requireTeamEnabled();
  const repoPath = requireRepoPath(ctx);
  const questionId = requireString(args, "questionId");
  const text = requireString(args, "text");
  const resumed = await team.leadReply(repoPath, questionId, text);
  return JSON.stringify({
    ok: true,
    resumed,
    message: resumed
      ? "Answer delivered — the member resumed with it."
      : "The member had already stopped waiting (timeout); your answer is posted in the team chat where they'll see it.",
  });
}

/**
 * Grant a member write access to additional paths. Structured — the grant
 * transfers ownership (never overlaps) and is announced in the team chat.
 */
async function runGrantScope(
  args: Record<string, unknown>,
  ctx?: TeamToolContext,
): Promise<string> {
  requireTeamEnabled();
  const repoPath = requireRepoPath(ctx);
  const agentId = requireString(args, "agentId");
  const raw = args.paths;
  const paths = Array.isArray(raw)
    ? raw.filter((p): p is string => typeof p === "string" && p.trim() !== "")
    : [];
  if (paths.length === 0) {
    throw new Error("'paths' must name at least one repo-relative path");
  }
  const state = await team.grantScope(repoPath, agentId, paths);
  return JSON.stringify({
    ok: true,
    message: `Granted ${paths.join(", ")} to ${agentId}. The team was told in the chat.`,
    ...summarize(state),
  });
}

async function runRemoveAgent(
  args: Record<string, unknown>,
  ctx?: TeamToolContext,
): Promise<string> {
  requireTeamEnabled();
  const repoPath = requireRepoPath(ctx);
  const agentId = requireString(args, "agentId");
  if (agentId === "lead") {
    throw new Error("The Lead can't remove itself. Use team_disband to stop the team.");
  }
  const state = await team.removeAgent(repoPath, agentId);
  return JSON.stringify({
    ok: true,
    message: `Removed '${agentId}' — its scope was released and tasks unassigned.`,
    ...summarize(state),
  });
}

async function runDisband(ctx?: TeamToolContext): Promise<string> {
  const repoPath = requireRepoPath(ctx);
  const state = await team.disbandTeam(repoPath);
  return JSON.stringify({
    ok: true,
    message: "Team disbanded. The shared brain is preserved on disk.",
    ...summarize(state),
  });
}

/**
 * Dispatch a Lead team-control tool. Returns the JSON-stringified result;
 * throws on failure (the bridge wraps the message in `{ error, tool }`).
 */
export async function executeTeamLeadTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx?: TeamToolContext,
): Promise<string> {
  switch (toolName) {
    case "team_show":
      return runShow(ctx);
    case "team_status":
      return runStatus(ctx);
    case "team_chat":
      return runChat(args, ctx);
    case "team_message":
      return runMessage(args, ctx);
    case "team_reply":
      return runReply(args, ctx);
    case "team_grant_scope":
      return runGrantScope(args, ctx);
    case "team_dispatch":
      return runDispatch(args, ctx);
    case "team_remove_agent":
      return runRemoveAgent(args, ctx);
    case "team_disband":
      return runDisband(ctx);
    default:
      throw new Error(`Team lead tool '${toolName}' has no executor`);
  }
}
