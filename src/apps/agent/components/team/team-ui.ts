/**
 * Agent Window — Team screen presentation helpers (leaf, non-component).
 *
 * Pure formatting/derivation over the real `TeamProjectState` — no runtime
 * calls, no mock data. Shared by the Team screen and the left-rail Team entry.
 */

import type { AgentRecord, AgentStatus, TeamProjectState } from "@/kernel/types/team";
import type { TeamLiveDraft } from "@/apps/agent/store/team/useTeamStore";
import type { TimelineEvent } from "@/apps/agent/components/conversation/timeline";

/** Whether a live draft has anything worth painting yet. */
export function hasDraftContent(draft: TeamLiveDraft): boolean {
  return draft.text.trim() !== "" || draft.thinking.trim() !== "";
}

/** Ordered timeline events for a live draft (thinking above visible text). */
export function draftEvents(d: TeamLiveDraft): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  if (d.thinking.trim() !== "") {
    events.push({ kind: "thinking", id: `${d.agentId}-live-th`, text: d.thinking });
  }
  if (d.text.trim() !== "") {
    events.push({ kind: "content", id: `${d.agentId}-live-c`, text: d.text });
  }
  return events;
}

/**
 * Clean title from a role slug: `widgets-theme-owner` → "Widgets Theme",
 * `ui_core_owner` → "UI Core". Falls back to "Engineer" for an empty role.
 * Use this for member names everywhere (roster, channel, transcript) so a raw
 * id like `widgets-theme-owner-9fba12` never leaks into the UI.
 */
export function prettifyRole(role: string): string {
  const cleaned = role
    .replace(/[-_\s]*owner$/i, "")
    .replace(/-[0-9a-f]{4,}$/i, "") // drop a trailing id hash if a full id slipped in
    .replace(/[-_]+/g, " ")
    .trim();
  if (!cleaned) return "Engineer";
  return cleaned
    .split(/\s+/)
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * Curated worker palette — a cohesive family (all one lightness/saturation, so
 * they read like a designed set, not random dye) that sits well on the agent
 * window's surfaces in both dark and light themes. Evenly-spaced hues keep
 * adjacent workers easy to tell apart. Replaces the old hash-to-360 random HSL
 * that could land on muddy / clashing tones. Order is intentional: the first
 * few assigned colors are the most distinct from each other and from the accent.
 */
const WORKER_PALETTE: readonly string[] = [
  "hsl(211 64% 60%)", // blue
  "hsl(159 52% 50%)", // teal-green
  "hsl(265 58% 66%)", // violet
  "hsl(36 76% 58%)", // amber
  "hsl(344 68% 64%)", // rose
  "hsl(188 60% 52%)", // cyan
  "hsl(128 44% 54%)", // green
  "hsl(20 74% 60%)", // orange
];

/**
 * Deterministic per-author color: Lead = the theme accent, `system` = subtle,
 * each worker a STABLE pick from the curated {@link WORKER_PALETTE} (hashed by
 * id so the same worker always keeps the same on-brand color across renders and
 * transcript re-reads).
 */
export function authorColor(id: string): string {
  if (id === "lead") return "var(--agw-accent)";
  if (id === "system") return "var(--agw-text-subtle)";
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return WORKER_PALETTE[h % WORKER_PALETTE.length];
}

/**
 * Replace raw `@agent-id` mentions (e.g. `@widget-builder-edc6e7`) with the
 * member's clean display name. Raw ids are wire identity for the agents; the
 * user should only ever see names. Longer ids are replaced first so one id
 * can never partially eat another.
 *
 * Markdown mode emits a mention LINK — `[@Widget Builder](#mention-<id>)` —
 * which `AgentMarkdown` renders as an identity CHIP (`.agw-mention-chip`),
 * never as a real anchor. Plain mode (system banners) stays bare text.
 */
export function prettifyMentions(
  body: string,
  names: ReadonlyArray<readonly [id: string, display: string]>,
  opts?: { markdown?: boolean },
): string {
  if (body.indexOf("@") === -1) return body;
  const markdown = opts?.markdown ?? true;
  let out = body;
  const all = [...names, ["lead", "Lead"] as const];
  for (const [id, display] of all.sort((a, b) => b[0].length - a[0].length)) {
    if (!id) continue;
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const shown = markdown
      ? `[@${display}](#mention-${encodeURIComponent(id)})`
      : `@${display}`;
    out = out.replace(new RegExp(`@${escaped}`, "gi"), shown);
  }
  return out;
}

/** Human display name for an agent (Lead / clean role title). */
export function displayName(agent: AgentRecord): string {
  return agent.id === "lead" ? "Lead" : prettifyRole(agent.role);
}

/** Human word for a member's status (dropdown rows, member tab header). */
export function statusWord(status: AgentStatus): string {
  switch (status) {
    case "waiting_input":
      return "waiting on you";
    case "done":
      return "done";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "idle":
      return "idle";
    default:
      return "working";
  }
}

/** Status dot color for a member (dropdown rows, member tab header). */
export function statusTone(status: AgentStatus): string {
  switch (status) {
    case "waiting_input":
      return "var(--agw-warning)";
    case "done":
      return "var(--agw-added)";
    case "blocked":
    case "failed":
      return "var(--agw-removed)";
    case "idle":
      return "var(--agw-text-subtle)";
    default:
      return "var(--agw-accent)";
  }
}

/** Whether a status should pulse (agent is actively working). */
export function isWorking(status: AgentStatus): boolean {
  return (
    status === "working" ||
    status === "waiting_input" ||
    // Legacy values from brains written before the actor engine.
    status === "building" ||
    status === "planning" ||
    status === "reviewing"
  );
}

/** Whether the member is paused on a question to the Lead (input-required). */
export function isWaitingOnLead(status: AgentStatus): boolean {
  return status === "waiting_input";
}

/** Short human phase label for the header / rail tag. */
export const PHASE_LABEL: Record<string, string> = {
  forming: "Starting",
  working: "Working",
  done: "Done",
  disbanded: "Disbanded",
  // Legacy phases from old brains.
  planning: "Starting",
  building: "Working",
  integrating: "Working",
};

/** Phases where the team is actively running (drives the rail's live tag). */
export function isActivePhase(phase: string): boolean {
  return (
    phase === "forming" ||
    phase === "working" ||
    // Legacy phases from old brains.
    phase === "planning" ||
    phase === "building" ||
    phase === "integrating"
  );
}

/** IC completion count for the header "3/5" style progress (Lead excluded). */
export function teamProgress(state: TeamProjectState): { done: number; total: number } {
  const ics = state.team.agents.filter((a) => a.id !== "lead");
  return { done: ics.filter((a) => a.status === "done").length, total: ics.length };
}
