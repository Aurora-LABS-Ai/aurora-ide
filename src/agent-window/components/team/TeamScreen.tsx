/**
 * Agent Window — Team screen [view].
 *
 * A CENTER-column takeover (the rail + dock stay): opened from the left-rail
 * "Team" entry or the Lead's `team_show` / `team_dispatch` tools. Renders the
 * live team over the real shared brain — `useTeamStore` (snapshot + `team_event`
 * stream) for phase/roster/gate/channel, and `team_get_agent_transcript` for a
 * selected member's work.
 *
 * ONE rendering pipeline, zero duplicates — that's the contract of this file:
 * every message (persisted OR streaming) renders through the SAME
 * `MessageBubble` the normal conversation uses, just labeled with the member's
 * name. A live stream (`team_stream` → `liveDrafts`) is the ONLY live layer;
 * the persisted channel/transcript is the ONLY settled layer; the store + this
 * component guarantee a message never shows in both at once. Reads `--agw-*`
 * only.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AgentIcon } from "../../shared/AgentIcon";
import { MessageBubble } from "../MessageBubble";
import { useAgentAutoScroll } from "../../hooks/useAgentAutoScroll";
import { useAgentChatStore } from "../../store/useAgentChatStore";
import { useAgentUiStore } from "../../store/useAgentUiStore";
import { useTeamStore, type TeamLiveDraft } from "../../../store/useTeamStore";
import { getAgentTranscript } from "../../../services/team-client";
import type { AgentRecord, AgentTurn, ChannelEvent } from "../../../types/team";
import type { TimelineEvent } from "../timeline";
import { buildMemberBubbles } from "./team-transcript";
import {
  PHASE_LABEL,
  authorColor,
  isActivePhase,
  isWorking,
  prettifyMentions,
  prettifyRole,
  teamProgress,
} from "./team-ui";

/** How often the selected member's transcript is re-read while open. */
const TRANSCRIPT_POLL_MS = 800;

/** Human display name for an agent (Lead / clean role title). */
const displayName = (agent: AgentRecord): string =>
  agent.id === "lead" ? "Lead" : prettifyRole(agent.role);

/**
 * One roster row — the member's name in the normal text color; while that
 * member is actually streaming tokens the name breathes with the SAME shimmer
 * the chat's "Aurora" label uses when a turn is live. No status words, no
 * colored dots — real activity is the only signal.
 */
const RosterRow: React.FC<{
  agent: AgentRecord;
  active: boolean;
  live: boolean;
  onClick: () => void;
}> = ({ agent, active, live, onClick }) => (
  <button type="button" className="agw-team-member" data-active={active || undefined} onClick={onClick}>
    <span className={live ? "agw-team-member-name agw-shimmer" : "agw-team-member-name"}>
      {displayName(agent)}
    </span>
  </button>
);

/**
 * Terminal outcome of a run lifecycle event, read from its METADATA (never the
 * body text). The dispatcher stamps `meta.terminal` = "done" | "failed" on the
 * one event that ends a run; older brains may carry "success"/"failure", so we
 * fold those in. Anything else → not terminal.
 */
const terminalOutcome = (e: ChannelEvent): "done" | "failed" | null => {
  const t = e.meta?.terminal;
  if (t === "failed" || t === "failure" || t === false) return "failed";
  if (t === true || t === "done" || t === "complete" || t === "completed" || t === "success")
    return "done";
  return null;
};

/** A run lifecycle event worth surfacing in the group chat (has a terminal outcome). */
const isTerminalStatus = (e: ChannelEvent): boolean => terminalOutcome(e) !== null;

/**
 * Gate status for an integration-gate note, from `meta.gate`/`meta.gateStatus`
 * (the integration runner stamps these instead of a "▶/✅/❌" prefix). Returns
 * the status word for coloring, or null when the event isn't a gate note.
 */
const gateStatus = (e: ChannelEvent): string | null => {
  if (e.meta?.gate !== true) return null;
  const s = e.meta?.gateStatus;
  return typeof s === "string" && s.trim() !== "" ? s : "running";
};

/**
 * Scope the channel to the CURRENT run. The brain's `events.jsonl` is
 * append-only, so a re-dispatch piles the new run's chat on top of every prior
 * run's. Each dispatch stamps `meta.dispatched` on its boundary event, so we
 * slice from the LAST one — the Team chat then shows only this run, not a
 * confusing history of old ones. (No marker yet → show everything.)
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

/** Per-member bubble tint: a soft wash + border of the member's color. */
const bubbleTint = (color: string): React.CSSProperties => ({
  background: `color-mix(in srgb, ${color} 6%, var(--agw-canvas))`,
  borderColor: `color-mix(in srgb, ${color} 30%, var(--agw-border))`,
});

/** Ordered timeline events for a live draft (thinking above visible text). */
const draftEvents = (d: TeamLiveDraft): TimelineEvent[] => {
  const events: TimelineEvent[] = [];
  if (d.thinking.trim() !== "") {
    events.push({ kind: "thinking", id: `${d.agentId}-live-th`, text: d.thinking });
  }
  if (d.text.trim() !== "") {
    events.push({ kind: "content", id: `${d.agentId}-live-c`, text: d.text });
  }
  return events;
};

/**
 * A live, in-flight reply — the token stream (`team_stream`) before the
 * authoritative content persists. Rendered through the REAL `MessageBubble`,
 * so a streaming teammate looks exactly like the main chat streaming once real
 * content exists: shimmer label, live thinking block, markdown with a trailing
 * cursor. Empty start frames are intentionally suppressed by callers so opening
 * Team chat never flashes blank author bubbles.
 */
const LiveDraftTurn: React.FC<{
  draft: TeamLiveDraft;
  label?: string;
  labelColor?: string;
  showLabel: boolean;
}> = ({ draft, label, labelColor, showLabel }) => (
  <MessageBubble
    message={{
      role: "assistant",
      content: draft.text,
      isThinking: !draft.done && draft.thinking.trim() !== "" && draft.text.trim() === "",
    }}
    events={draftEvents(draft)}
    label={label}
    labelColor={labelColor}
    showLabel={showLabel}
    streaming={!draft.done}
    showActions={false}
  />
);

const hasDraftContent = (draft: TeamLiveDraft): boolean =>
  draft.text.trim() !== "" || draft.thinking.trim() !== "";

/**
 * Shimmer placeholder shown while a view's messages are still loading (the
 * first snapshot, or a member's first transcript pull). Replaces the bare
 * empty-state flash — an empty bordered bubble reads as "broken", a skeleton
 * reads as "loading".
 */
const TeamChatSkeleton: React.FC = () => (
  <div className="agw-team-chat" aria-hidden>
    {[0, 1, 2].map((i) => (
      <div key={i} className="agw-team-skel">
        <div className="agw-team-skel-label" />
        <div className="agw-team-skel-line" style={{ width: "94%" }} />
        <div className="agw-team-skel-line" style={{ width: "80%" }} />
        <div className="agw-team-skel-line" style={{ width: "88%" }} />
      </div>
    ))}
  </div>
);

/**
 * The group channel — the actual CONVERSATION between the Lead and the members
 * (messages, scope claims, boundary questions, contracts, reviews), the
 * integration-gate notes, and the terminal run status. The dispatcher's
 * orchestration log (scope/task assignments) is DROPPED — it's bookkeeping, not
 * chat. Every message renders through the conversation's own `MessageBubble`,
 * labeled with the member's name — the SAME chat interface as the main chat.
 * Any live `drafts` (streaming replies not yet persisted) render at the bottom
 * through the same component.
 */
const ChannelFeed: React.FC<{
  events: ChannelEvent[];
  agents: AgentRecord[];
  drafts: TeamLiveDraft[];
}> = ({ events, agents, drafts }) => {
  const visibleDrafts = useMemo(() => drafts.filter(hasDraftContent), [drafts]);

  // Stable per-author identity from the roster: clean name + a fixed color.
  const meta = useMemo(() => {
    const roleById = new Map(agents.map((a) => [a.id, a.role]));
    return (id: string): { name: string; color: string } => {
      if (id === "lead") return { name: "Lead", color: authorColor("lead") };
      const role = roleById.get(id);
      return {
        name: role ? prettifyRole(role) : prettifyRole(id),
        color: authorColor(id),
      };
    };
  }, [agents]);

  // id → display name pairs for rewriting raw `@agent-id` mentions to clean
  // names in every rendered body (messages, system lines, live drafts).
  const mentionNames = useMemo(
    () => agents.map((a) => [a.id, displayName(a)] as const),
    [agents],
  );

  // Show real chat plus terminal status lines. Blank historical events are
  // bookkeeping noise; rendering them creates the empty labeled cards shown
  // while a Team chat snapshot is reconciling.
  const shown = events.filter(
    (e) =>
      e.kind === "system"
        ? isTerminalStatus(e) || gateStatus(e) !== null
        : e.body.trim() !== "",
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
          const failed = terminalOutcome(e) === "failed" || gateStatus(e) === "failed";
          return (
            <div key={e.id} className="agw-team-status" data-fail={failed || undefined}>
              {prettifyMentions(e.body, mentionNames, { markdown: false })}
            </div>
          );
        }
        const m = meta(e.author);
        const label =
          e.kind === "message" ? m.name : `${m.name} · ${e.kind.replace(/_/g, " ")}`;
        const body = prettifyMentions(e.body, mentionNames);
        return (
          <div key={e.id} className="agw-team-bubble" style={bubbleTint(m.color)}>
            <MessageBubble
              message={{ role: "assistant", content: body }}
              events={[{ kind: "content", id: `${e.id}-c`, text: body }]}
              label={label}
              labelColor={m.color}
              showLabel
              showActions={false}
            />
          </div>
        );
      })}
      {visibleDrafts.map((d) => {
        const m = meta(d.agentId);
        return (
          <div key={`draft-${d.agentId}`} className="agw-team-bubble" style={bubbleTint(m.color)}>
            <LiveDraftTurn
              draft={{ ...d, text: prettifyMentions(d.text, mentionNames) }}
              label={m.name}
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
 * A selected member's transcript, rendered through the real chat `MessageBubble`
 * so an IC's work shows the identical tool-call cards. Owns its own poll (keyed
 * by agent, so switching members starts fresh) — `team_get_agent_transcript`
 * every {@link TRANSCRIPT_POLL_MS} while mounted, plus an immediate pull the
 * moment the live stream ends so the persisted turn takes over without a gap.
 *
 * Hand-off rule (no duplicates, ever): while the member streams, its live
 * draft is the ONLY place that turn shows; once the stream ends, the draft
 * stays until the transcript grows past the count it had when the draft
 * started — then the persisted bubble (with its tool cards) is the only copy.
 */
const MemberTranscript: React.FC<{
  agentId: string;
  name: string;
  repoPath: string;
  working: boolean;
  draft?: TeamLiveDraft;
  /** id → display name pairs for rewriting raw `@agent-id` mentions. */
  mentionNames: ReadonlyArray<readonly [string, string]>;
}> = ({ agentId, name, repoPath, working, draft, mentionNames }) => {
  const [turns, setTurns] = useState<AgentTurn[]>([]);
  // Whether the FIRST transcript pull has returned — until then we can't tell
  // "no work yet" from "still loading", so we show a skeleton instead of the
  // empty state (which flashed for up to a poll interval on every open).
  const [loaded, setLoaded] = useState(false);
  const aliveRef = useRef(true);
  // Baseline: how many persisted bubbles this member had while its current
  // draft streamed (the in-flight turn never persists before its `end`).
  // Written only inside the pull callback — never during render.
  const baselineRef = useRef<{ key: number; count: number } | null>(null);
  const pull = useCallback(() => {
    void getAgentTranscript(repoPath, agentId)
      .then((t) => {
        if (!aliveRef.current) return;
        setTurns(t);
        setLoaded(true);
        // Hand-off: while the draft streams, keep the baseline in sync; once
        // it settles, drop it from the STORE the moment the transcript grows
        // past the baseline — the persisted bubble (with its tool cards) is
        // then the only copy. Never both.
        const live = useTeamStore.getState().liveDrafts[agentId];
        if (!live) {
          baselineRef.current = null;
          return;
        }
        const count = buildMemberBubbles(agentId, t).length;
        if (!live.done) {
          baselineRef.current = { key: live.startedAt, count };
        } else {
          const base = baselineRef.current;
          const covered =
            !base || base.key !== live.startedAt || count > base.count;
          if (covered) {
            baselineRef.current = null;
            useTeamStore.getState().clearDraft(agentId);
          }
        }
      })
      .catch(() => {
        /* transient — the next tick retries */
      });
  }, [repoPath, agentId]);

  useEffect(() => {
    aliveRef.current = true;
    pull();
    const timer = setInterval(pull, TRANSCRIPT_POLL_MS);
    return () => {
      aliveRef.current = false;
      clearInterval(timer);
    };
  }, [pull]);

  // The instant a stream settles, pull immediately — the persisted turn (with
  // tool cards) takes over in one round-trip instead of a full poll tick.
  const settled = draft?.done ?? false;
  useEffect(() => {
    if (settled) pull();
  }, [settled, pull]);

  // Rewrite raw `@agent-id` mentions to clean names in the member's prose
  // (content + thinking); tool cards keep their raw arguments untouched.
  const bubbles = useMemo(
    () =>
      buildMemberBubbles(agentId, turns).map((b) => ({
        ...b,
        content: prettifyMentions(b.content, mentionNames),
        events: b.events.map((ev) =>
          ev.kind === "content" || ev.kind === "thinking"
            ? { ...ev, text: prettifyMentions(ev.text, mentionNames) }
            : ev,
        ),
      })),
    [agentId, turns, mentionNames],
  );
  // The store's draft is the single live layer: present → render it; the pull
  // callback above (or the store's own reconcile) removes it once superseded.
  const draftVisible = !!draft && hasDraftContent(draft);

  if (bubbles.length === 0 && !draftVisible) {
    // First pull still in flight → skeleton, not the "nothing yet" empty state.
    if (!loaded) return <TeamChatSkeleton />;
    return (
      <div className="agw-team-empty">
        <AgentIcon name="users" size={22} />
        <span>{name} hasn’t posted any work yet.</span>
      </div>
    );
  }
  const lastId = bubbles[bubbles.length - 1]?.id;
  return (
    <div className="agw-team-chat select-text">
      {bubbles.map((b) => (
        <MessageBubble
          key={b.id}
          message={{ role: b.role, content: b.content }}
          events={b.role === "assistant" ? b.events : undefined}
          showLabel={false}
          // A WORKING member's latest bubble is "live" — a tool whose result
          // hasn't landed yet must render as RUNNING, not failed. This holds
          // even while the next turn's draft streams below: the tool executes
          // exactly in that window, and flipping the flag off there is what
          // showed the false "Didn't complete".
          streaming={working && b.id === lastId}
          showActions={false}
        />
      ))}
      {draftVisible && draft && (
        <LiveDraftTurn
          draft={{ ...draft, text: prettifyMentions(draft.text, mentionNames) }}
          showLabel={false}
        />
      )}
    </div>
  );
};

export const TeamScreen: React.FC = () => {
  const closeTeam = useAgentUiStore((s) => s.closeTeam);
  const repoPath = useAgentChatStore((s) => s.projectRoot);
  const snapshot = useTeamStore((s) => s.snapshot);
  const loading = useTeamStore((s) => s.loading);
  const liveDrafts = useTeamStore((s) => s.liveDrafts);

  const [selected, setSelected] = useState<string | null>(null); // null = group channel
  // How many chat messages the user had seen when they last LEFT the Team chat
  // view — new messages beyond it light the unread badge on the Team chat row
  // (like an app notification). Updated only in click handlers, so viewing the
  // chat itself never needs an effect.
  const [seenChatCount, setSeenChatCount] = useState(0);

  // The group channel streams planning/integration replies (Lead plan, IC
  // standups, peer reviews); a member's build-phase stream belongs in that
  // member's transcript, not the shared channel.
  const groupDrafts = useMemo(
    () => Object.values(liveDrafts).filter((d) => d.phase !== "building"),
    [liveDrafts],
  );

  const initialized = !!snapshot?.initialized;
  const agents = snapshot?.team.agents ?? [];
  // No "Lead" row — the Lead is the agent you're already chatting with in the
  // main conversation (the one that dispatched the team). The roster is the
  // builders; the Lead's voice shows up inside Team chat.
  const ics = agents.filter((a) => a.id !== "lead");
  const { done, total } = snapshot ? teamProgress(snapshot) : { done: 0, total: 0 };
  const phase = snapshot?.team.phase ?? "forming";
  // A re-dispatch gives members NEW ids, so a selection from a prior run points
  // at nobody — fall back to Team chat instead of a dead/empty transcript.
  const validSelected = selected !== null && ics.some((a) => a.id === selected) ? selected : null;

  // id → display name pairs for rewriting raw `@agent-id` mentions anywhere a
  // member's prose renders (the member transcript view). Derived from the
  // store snapshot directly (a stable reference, unlike the `?? []` fallback).
  const rosterNames = useMemo(
    () => (snapshot?.team.agents ?? []).map((a) => [a.id, displayName(a)] as const),
    [snapshot],
  );

  // This run's chat events (what the Team chat view shows) + the count that
  // drives the unread badge while a member's transcript is open.
  const runEvents = useMemo(
    () => (snapshot ? currentRunEvents(snapshot.channel) : []),
    [snapshot],
  );
  const chatCount = useMemo(
    () => runEvents.filter((e) => e.kind !== "system").length,
    [runEvents],
  );
  const chatUnread = validSelected !== null && chatCount > seenChatCount;

  // Stick-to-bottom auto-scroll — the SAME hook the conversation uses. While
  // the team is running (or anyone is streaming) the view follows new content;
  // the moment the user scrolls up to read, it stops chasing until they return
  // to the bottom. Switching between Team chat and a member snaps to latest.
  const anyLive = useMemo(
    () => Object.values(liveDrafts).some((d) => !d.done),
    [liveDrafts],
  );
  // Growth signal for the stick-to-bottom follow: it must move on EVERY kind of
  // growth, not just when a channel message settles. During a live run the
  // visible content grows token-by-token inside `liveDrafts` (whose count never
  // changes), so fold the streaming text/thinking length in — otherwise the view
  // only jumped when a whole message landed and looked "stuck" mid-stream.
  const growthKey = useMemo(() => {
    let n = snapshot?.channel.length ?? 0;
    for (const d of Object.values(liveDrafts)) n += d.text.length + d.thinking.length;
    return n;
  }, [snapshot?.channel.length, liveDrafts]);
  const { containerRef, contentRef } = useAgentAutoScroll({
    isStreaming: anyLive || isActivePhase(phase),
    // Include readiness so the anchor re-fires when the scroller actually mounts
    // (it's rendered only once `initialized`); otherwise the first snap runs
    // against a not-yet-present container and the view opens scrolled to the top.
    resetKey: `${initialized ? "ready" : "load"}:${validSelected ?? "team-chat"}`,
    growthKey,
  });

  return (
    <div className="agw-zone" style={{ background: "var(--agw-conversation)", display: "flex", flexDirection: "column" }}>
      {/* Header — back · title · phase · progress. */}
      <div className="agw-team-head">
        <button type="button" className="agw-icon-btn" title="Back to chat" aria-label="Back to chat" onClick={closeTeam}>
          <AgentIcon name="arrow-left" size={16} />
        </button>
        <AgentIcon name="users" size={16} style={{ color: "var(--agw-text-muted)" }} />
        <span className="agw-team-title">Team</span>
        {initialized && <span className="agw-team-phase">{PHASE_LABEL[phase] ?? phase}</span>}
        <div style={{ flex: 1 }} />
        {initialized && total > 0 && (
          <>
            <span className="agw-team-progress-label">{done}/{total} done</span>
            <div className="agw-team-progress">
              <div className="agw-team-progress-fill" style={{ width: `${(done / total) * 100}%` }} />
            </div>
          </>
        )}
      </div>

      {!initialized ? (
        loading ? (
          <div className="agw-team-main agw-scroll" style={{ flex: 1 }}>
            <TeamChatSkeleton />
          </div>
        ) : (
          <div className="agw-team-empty" style={{ flex: 1 }}>
            <AgentIcon name="users" size={26} />
            <span>No team yet for this project.</span>
            <span style={{ fontSize: 12.5, maxWidth: 380, textAlign: "center", lineHeight: 1.55 }}>
              Enable the team under Settings → Team, then give the agent a big task — it’ll split the work by scope and convene a team here.
            </span>
          </div>
        )
      ) : (
        <div className="agw-team-body">
          <aside className="agw-team-side agw-scroll">
            <button
              type="button"
              className="agw-team-member agw-team-chat-row"
              data-active={validSelected === null || undefined}
              onClick={() => {
                setSelected(null);
                setSeenChatCount(chatCount);
              }}
            >
              <AgentIcon name="chat" size={15} />
              <span className="agw-team-member-name">Team chat</span>
              {chatUnread && (
                <span className="agw-team-unread" data-pulse aria-label="New team messages" />
              )}
            </button>

            {ics.length > 0 && <div className="agw-team-side-label" style={{ marginTop: 10 }}>Members</div>}
            {ics.map((a) => (
              <RosterRow
                key={a.id}
                agent={a}
                active={validSelected === a.id}
                live={!!liveDrafts[a.id] && !liveDrafts[a.id].done}
                onClick={() => {
                  // Leaving the Team chat view — everything shown so far is seen.
                  setSeenChatCount(chatCount);
                  setSelected(a.id);
                }}
              />
            ))}
            {ics.length === 0 && isActivePhase(phase) && (
              <div className="agw-team-side-note">Assembling the team…</div>
            )}
          </aside>

          <div className="agw-team-main agw-scroll" role="main" ref={containerRef}>
            <div
              ref={contentRef}
              style={{
                minHeight: "100%",
                width: "100%",
                display: "flex",
                flexDirection: "column",
              }}
            >
              {validSelected === null || !repoPath ? (
                <ChannelFeed
                  events={runEvents}
                  agents={agents}
                  drafts={groupDrafts}
                />
              ) : (
                (() => {
                  const sel = agents.find((a) => a.id === validSelected);
                  const memberDraft =
                    liveDrafts[validSelected]?.phase === "building"
                      ? liveDrafts[validSelected]
                      : undefined;
                  return (
                    <MemberTranscript
                      key={validSelected}
                      agentId={validSelected}
                      name={sel ? displayName(sel) : "This member"}
                      repoPath={repoPath}
                      working={isWorking(sel?.status ?? "idle")}
                      draft={memberDraft}
                      mentionNames={rosterNames}
                    />
                  );
                })()
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
