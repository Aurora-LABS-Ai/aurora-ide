/**
 * Agent Window — Member panel [right-dock tab].
 *
 * One team member's individual stream in its OWN dock tab (`member:<id>`), so
 * the user can flip between the Team chat tab and any member's work like
 * browser tabs. Renders the member's persisted transcript through the real
 * chat `MessageBubble` (identical tool-call cards) with the store's live
 * draft as the ONLY live layer — the hand-off rule: the draft is dropped the
 * moment the persisted turn covers it, never both at once.
 *
 * A re-dispatch mints new agent ids, so a tab can outlive its member; that
 * renders as an honest "run has ended" state, not an empty feed.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AgentIcon } from "../../shared/AgentIcon";
import { MessageBubble } from "../MessageBubble";
import { useAgentAutoScroll } from "../../hooks/useAgentAutoScroll";
import { useAgentChatStore } from "../../store/useAgentChatStore";
import { useTeamStore } from "../../../store/useTeamStore";
import { getAgentTranscript } from "../../../services/team-client";
import type { AgentTurn } from "../../../types/team";
import { buildMemberBubbles } from "./team-transcript";
import {
  displayName,
  hasDraftContent,
  isWorking,
  prettifyMentions,
  statusTone,
  statusWord,
} from "./team-ui";
import { LiveDraftTurn, TeamChatSkeleton } from "./team-atoms";

/** How often the member's transcript is re-read while the tab is open. */
const TRANSCRIPT_POLL_MS = 800;

export const MemberPanel: React.FC<{ agentId: string }> = ({ agentId }) => {
  const repoPath = useAgentChatStore((s) => s.projectRoot);
  const snapshot = useTeamStore((s) => s.snapshot);
  const draft = useTeamStore((s) => s.liveDrafts[agentId]);

  const agent = snapshot?.team.agents.find((a) => a.id === agentId);
  const rosterNames = useMemo(
    () => (snapshot?.team.agents ?? []).map((a) => [a.id, displayName(a)] as const),
    [snapshot],
  );

  const [turns, setTurns] = useState<AgentTurn[]>([]);
  const [loaded, setLoaded] = useState(false);
  const aliveRef = useRef(true);
  const baselineRef = useRef<{ key: number; count: number } | null>(null);

  const pull = useCallback(() => {
    if (!repoPath) return;
    void getAgentTranscript(repoPath, agentId)
      .then((t) => {
        if (!aliveRef.current) return;
        setTurns(t);
        setLoaded(true);
        // Draft hand-off: while the member streams, remember how many settled
        // bubbles existed; once the stream ends AND the persisted transcript
        // has grown past that baseline, the draft is covered — drop it.
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
          const covered = !base || base.key !== live.startedAt || count > base.count;
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

  // The moment a stream settles, re-read immediately (don't wait a tick).
  const settled = draft?.done ?? false;
  useEffect(() => {
    if (settled) pull();
  }, [settled, pull]);

  const bubbles = useMemo(
    () =>
      buildMemberBubbles(agentId, turns).map((b) => ({
        ...b,
        content: prettifyMentions(b.content, rosterNames),
        events: b.events.map((ev) =>
          ev.kind === "content" || ev.kind === "thinking"
            ? { ...ev, text: prettifyMentions(ev.text, rosterNames) }
            : ev,
        ),
      })),
    [agentId, turns, rosterNames],
  );

  const working = isWorking(agent?.status ?? "idle");
  const draftVisible = !!draft && hasDraftContent(draft);
  const name = agent ? displayName(agent) : "Member";

  // Total painted characters — drives the stick-to-bottom auto scroll.
  const growthKey = useMemo(() => {
    let n = 0;
    for (const b of bubbles) n += b.content.length;
    if (draft) n += draft.text.length + draft.thinking.length;
    return n;
  }, [bubbles, draft]);
  const { containerRef, contentRef } = useAgentAutoScroll({
    isStreaming: working || !!(draft && !draft.done),
    resetKey: agentId,
    growthKey,
  });

  const lastId = bubbles[bubbles.length - 1]?.id;

  return (
    <div className="agw-tp-root">
      <div className="agw-tp-head">
        <span
          className="agw-tp-dot"
          data-pulse={working || undefined}
          style={{ background: statusTone(agent?.status ?? "idle") }}
        />
        <span className="agw-tp-title">{name}</span>
        <span className="agw-tp-meta">{agent ? statusWord(agent.status) : ""}</span>
      </div>

      {!agent ? (
        <div className="agw-team-empty" style={{ flex: 1 }}>
          <AgentIcon name="users" size={22} />
          <span>This member’s run has ended.</span>
          <span style={{ fontSize: 12, maxWidth: 280, textAlign: "center", lineHeight: 1.55 }}>
            The current team lives in the Team tab. You can close this tab.
          </span>
        </div>
      ) : (
        <div className="agw-tp-body agw-scroll" ref={containerRef}>
          <div
            ref={contentRef}
            style={{ minHeight: "100%", width: "100%", display: "flex", flexDirection: "column" }}
          >
            {bubbles.length === 0 && !draftVisible ? (
              !loaded ? (
                <TeamChatSkeleton />
              ) : (
                <div className="agw-team-empty">
                  <AgentIcon name="users" size={22} />
                  <span>{name} hasn’t posted any work yet.</span>
                </div>
              )
            ) : (
              <div className="agw-team-chat select-text">
                {bubbles.map((b) => (
                  <MessageBubble
                    key={b.id}
                    message={{ role: b.role, content: b.content }}
                    events={b.role === "assistant" ? b.events : undefined}
                    showLabel={false}
                    // A WORKING member's latest bubble is "live" — a tool whose
                    // result hasn't landed yet must render as RUNNING, not failed.
                    streaming={working && b.id === lastId}
                    showActions={false}
                  />
                ))}
                {draftVisible && draft && (
                  <LiveDraftTurn
                    draft={{ ...draft, text: prettifyMentions(draft.text, rosterNames) }}
                    showLabel={false}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
