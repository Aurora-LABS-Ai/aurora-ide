/**
 * Agent Window — Team panel [right-dock tab].
 *
 * THE team group chat, docked beside the conversation, messenger-style —
 * member bubbles stack LEFT (neutral material + name chip), the Lead's
 * bubbles stack RIGHT (your side of the room). A long message never grows
 * the bubble: its body is a fixed scroll window, exactly the tool-card
 * output contract. Top-right: the Members dropdown — names shimmer while a
 * member streams; picking one opens that member's individual stream in its
 * OWN dock tab (`MemberPanel`), so chat and member views switch like browser
 * tabs. View-only on purpose: the user talks to the team through the Lead in
 * the main conversation, never directly.
 *
 * ONE rendering pipeline, zero duplicates — the contract of this file: every
 * message (persisted OR streaming) renders through the SAME `MessageBubble`
 * the conversation uses. A live stream (`team_stream` → `liveDrafts`) is the
 * ONLY live layer; the persisted channel is the ONLY settled layer; the
 * store + this component guarantee a message never shows in both at once.
 * Reads `--agw-*` only.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";

import { AgentIcon } from "../../shared/AgentIcon";
import { MessageBubble } from "../MessageBubble";
import { useAgentAutoScroll } from "../../hooks/useAgentAutoScroll";
import { useAgentWorkspaceStore } from "../../store/useAgentWorkspaceStore";
import { useTeamStore, type TeamLiveDraft } from "../../../store/useTeamStore";
import type { AgentRecord, ChannelEvent } from "../../../types/team";
import { LiveDraftTurn, TeamChatSkeleton } from "./team-atoms";
import {
  PHASE_LABEL,
  authorColor,
  displayName,
  hasDraftContent,
  isActivePhase,
  isWaitingOnLead,
  prettifyMentions,
  prettifyRole,
  statusTone,
  statusWord,
  teamProgress,
} from "./team-ui";

/**
 * Terminal outcome of a run lifecycle event, read from its METADATA (never the
 * body text). The dispatcher stamps `meta.terminal` = "done" | "failed" on the
 * one event that ends a run; older brains may carry "success"/"failure".
 */
const terminalOutcome = (e: ChannelEvent): "done" | "failed" | null => {
  const t = e.meta?.terminal;
  if (t === "failed" || t === "failure" || t === false) return "failed";
  if (t === true || t === "done" || t === "complete" || t === "completed" || t === "success")
    return "done";
  return null;
};

const isTerminalStatus = (e: ChannelEvent): boolean => terminalOutcome(e) !== null;

/**
 * Scope the channel to the CURRENT run. The brain's `events.jsonl` is
 * append-only, so a re-dispatch piles the new run's chat on top of every
 * prior run's. Each dispatch stamps `meta.dispatched` on its boundary event.
 */
const currentRunEvents = (channel: ChannelEvent[]): ChannelEvent[] => {
  let start = 0;
  for (let i = channel.length - 1; i >= 0; i -= 1) {
    if (channel[i].meta?.dispatched === true) {
      start = i;
      break;
    }
  }
  return channel.slice(start);
};

/**
 * The group channel, messenger-style: the Lead's messages stack RIGHT (your
 * side of the room), member messages stack LEFT with a name label. Both sides
 * share one neutral bubble material — no per-member colors. System lines
 * (lifecycle) render centered. Live drafts (streaming replies not yet
 * persisted) render at the bottom through the same pipeline.
 */
const ChannelFeed: React.FC<{
  events: ChannelEvent[];
  agents: AgentRecord[];
  drafts: TeamLiveDraft[];
}> = ({ events, agents, drafts }) => {
  const visibleDrafts = useMemo(() => drafts.filter(hasDraftContent), [drafts]);

  const meta = useMemo(() => {
    const roleById = new Map(agents.map((a) => [a.id, a.role]));
    return (id: string): { name: string; color: string } => {
      if (id === "lead") return { name: "Lead", color: "var(--agw-text-muted)" };
      const role = roleById.get(id);
      return {
        name: role ? prettifyRole(role) : prettifyRole(id),
        // Identity lives ONLY in the name chip — bubbles stay neutral.
        color: authorColor(id),
      };
    };
  }, [agents]);

  const mentionNames = useMemo(
    () => agents.map((a) => [a.id, displayName(a)] as const),
    [agents],
  );

  // Real chat plus terminal status lines; blank bookkeeping events are noise.
  const shown = events.filter(
    (e) => (e.kind === "system" ? isTerminalStatus(e) : e.body.trim() !== ""),
  );
  if (shown.length === 0 && visibleDrafts.length === 0) {
    return (
      <div className="agw-team-empty">
        <AgentIcon name="chat" size={22} />
        <span>No team chat yet.</span>
      </div>
    );
  }
  return (
    <div className="agw-team-chat select-text">
      {shown.map((e) => {
        if (e.kind === "system") {
          const failed = terminalOutcome(e) === "failed";
          return (
            <div key={e.id} className="agw-team-status" data-fail={failed || undefined}>
              {prettifyMentions(e.body, mentionNames, { markdown: false })}
            </div>
          );
        }
        const m = meta(e.author);
        const body = prettifyMentions(e.body, mentionNames);
        // The Lead's side of the room: right-stacked; member messages stack
        // left. Both use the SAME neutral bubble material as the main chat's
        // user bubble — identity comes from the name label and the alignment,
        // never from per-member colors. A long message scrolls inside its
        // fixed window (tool-card contract), it never grows the bubble.
        if (e.author === "lead") {
          return (
            <div key={e.id} className="agw-tp-lead">
              <div className="agw-tp-clip agw-scroll">
                <MessageBubble
                  message={{ role: "assistant", content: body }}
                  events={[{ kind: "content", id: `${e.id}-c`, text: body }]}
                  label="Lead"
                  labelColor="var(--agw-text-muted)"
                  showLabel
                  showActions={false}
                />
              </div>
            </div>
          );
        }
        const label =
          e.kind === "message" ? m.name : `${m.name} · ${e.kind.replace(/_/g, " ")}`;
        return (
          <div key={e.id} className="agw-tp-member">
            <div className="agw-tp-clip agw-scroll">
              <MessageBubble
                message={{ role: "assistant", content: body }}
                events={[{ kind: "content", id: `${e.id}-c`, text: body }]}
                label={label}
                labelColor={m.color}
                showLabel
                showActions={false}
              />
            </div>
          </div>
        );
      })}
      {visibleDrafts.map((d) => {
        const m = meta(d.agentId);
        const side = d.agentId === "lead" ? "agw-tp-lead" : "agw-tp-member";
        return (
          <div key={`draft-${d.agentId}`} className={side}>
            <LiveDraftTurn
              draft={{ ...d, text: prettifyMentions(d.text, mentionNames) }}
              label={d.agentId === "lead" ? "Lead" : m.name}
              labelColor={m.color}
              showLabel
            />
          </div>
        );
      })}
    </div>
  );
};

/**
 * The Members dropdown — one row per member: state dot, name (shimmering with
 * the chat's own label shimmer while that member streams), and a status word.
 * Picking a member opens their stream as its own dock tab.
 */
const MembersDropdown: React.FC<{
  members: AgentRecord[];
  liveIds: ReadonlySet<string>;
  onPick: (member: AgentRecord) => void;
}> = ({ members, liveIds, onPick }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const anyLive = members.some((m) => liveIds.has(m.id));
  const waiting = members.some((m) => isWaitingOnLead(m.status));

  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0, marginLeft: "auto" }}>
      <button
        type="button"
        className="agw-tp-members-btn"
        aria-expanded={open}
        title="Members"
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className="agw-tp-dot"
          data-pulse={anyLive || undefined}
          style={{ background: waiting ? "var(--agw-warning)" : "var(--agw-accent)" }}
        />
        Members
        <AgentIcon name="chevron-down" size={12} />
      </button>
      {open && (
        <div className="agw-menu agw-tp-dd" role="menu">
          {members.length === 0 && <div className="agw-tp-dd-label">NO MEMBERS YET</div>}
          {members.map((m) => (
            <button
              key={m.id}
              type="button"
              role="menuitem"
              className="agw-menu-item agw-tp-dd-item"
              onClick={() => {
                onPick(m);
                setOpen(false);
              }}
            >
              <span
                className="agw-tp-dot"
                data-pulse={liveIds.has(m.id) || isWaitingOnLead(m.status) || undefined}
                style={{ background: statusTone(m.status) }}
              />
              <span
                className={liveIds.has(m.id) ? "agw-shimmer" : undefined}
                style={{ fontWeight: "var(--agw-fw-medium)" }}
              >
                {displayName(m)}
              </span>
              <span
                className="agw-tp-dd-state"
                style={isWaitingOnLead(m.status) ? { color: "var(--agw-warning)" } : undefined}
              >
                {statusWord(m.status)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export const TeamPanel: React.FC = () => {
  const snapshot = useTeamStore((s) => s.snapshot);
  const loading = useTeamStore((s) => s.loading);
  const liveDrafts = useTeamStore((s) => s.liveDrafts);
  const openMemberTab = useAgentWorkspaceStore((s) => s.openMemberTab);

  const initialized = !!snapshot?.initialized;
  const agents = useMemo(() => snapshot?.team.agents ?? [], [snapshot]);
  const members = useMemo(() => agents.filter((a) => a.id !== "lead"), [agents]);
  const { done, total } = snapshot ? teamProgress(snapshot) : { done: 0, total: 0 };
  const phase = snapshot?.team.phase ?? "forming";

  const liveIds = useMemo(
    () =>
      new Set(
        Object.values(liveDrafts)
          .filter((d) => !d.done)
          .map((d) => d.agentId),
      ),
    [liveDrafts],
  );

  const runEvents = useMemo(
    () => (snapshot ? currentRunEvents(snapshot.channel) : []),
    [snapshot],
  );

  // The chat shows chat drafts only — a member's WORK stream belongs in their
  // own tab (`MemberPanel`), never in both places at once.
  const groupDrafts = useMemo(
    () =>
      Object.values(liveDrafts).filter(
        (d) => d.phase !== "working" && d.phase !== "building",
      ),
    [liveDrafts],
  );

  const anyLive = useMemo(
    () => Object.values(liveDrafts).some((d) => !d.done),
    [liveDrafts],
  );
  const growthKey = useMemo(() => {
    let n = snapshot?.channel.length ?? 0;
    for (const d of Object.values(liveDrafts)) n += d.text.length + d.thinking.length;
    return n;
  }, [snapshot?.channel.length, liveDrafts]);
  const { containerRef, contentRef } = useAgentAutoScroll({
    isStreaming: anyLive || isActivePhase(phase),
    resetKey: initialized ? "ready" : "load",
    growthKey,
  });

  return (
    <div className="agw-tp-root">
      {/* Header: identity left, Members dropdown right. */}
      <div className="agw-tp-head">
        <AgentIcon name="users" size={15} style={{ color: "var(--agw-text-muted)" }} />
        <span className="agw-tp-title">Team</span>
        {initialized && (
          <span className="agw-tp-meta">
            {PHASE_LABEL[phase] ?? phase}
            {total > 0 ? ` · ${done}/${total}` : ""}
          </span>
        )}
        <MembersDropdown
          members={members}
          liveIds={liveIds}
          onPick={(m) => openMemberTab(m.id, displayName(m))}
        />
      </div>

      {!initialized ? (
        loading ? (
          <div className="agw-tp-body agw-scroll">
            <TeamChatSkeleton />
          </div>
        ) : (
          <div className="agw-team-empty" style={{ flex: 1 }}>
            <AgentIcon name="users" size={24} />
            <span>No team yet for this project.</span>
            <span style={{ fontSize: 12, maxWidth: 300, textAlign: "center", lineHeight: 1.55 }}>
              Give the agent a big task — it will split the work and convene a team here.
            </span>
          </div>
        )
      ) : (
        <>
          <div className="agw-tp-body agw-scroll" ref={containerRef}>
            <div
              ref={contentRef}
              style={{ minHeight: "100%", width: "100%", display: "flex", flexDirection: "column" }}
            >
              <ChannelFeed events={runEvents} agents={agents} drafts={groupDrafts} />
            </div>
          </div>
          {/* No composer, on purpose: you talk to the team through the Lead. */}
          <div className="agw-tp-foot">view only — talk to the team through the Lead</div>
        </>
      )}
    </div>
  );
};
