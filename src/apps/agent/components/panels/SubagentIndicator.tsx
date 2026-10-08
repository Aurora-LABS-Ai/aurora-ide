/**
 * Agent Window — header sub-agent indicator [view].
 *
 * The task indicator's sibling, for the conversation's sub-agents. It sits in
 * the header beside the checklist and the context ring: a glyph, a count, and
 * a floating card listing every agent this conversation has started, by the
 * name the agent gave it, with its state. A row opens that agent's tab in the
 * dock.
 *
 * Present whenever the conversation HAS agents — a conversation reopened days
 * later shows it without anything running, because the agents and their
 * transcripts are still there. Absent when there are none: an empty
 * affordance in the header is noise.
 *
 * The dock never opens on its own when an agent starts. This is how you learn
 * one did: the indicator appears (or its count moves), and the card shows
 * itself for a moment the way the checklist does when the agent edits it.
 *
 * Hover peeks, click pins, Escape and click-away dismiss — the same contract
 * as `TaskIndicator`, so the two readouts next to each other behave as one.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { createPortal } from "react-dom";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { AgentLead } from "@/apps/agent/components/panels/subagent-parts";
import {
  agentElapsedMs,
  fmtClock,
  useNow,
} from "@/apps/agent/components/panels/subagent-clock";
import { subagentLabel, type SubagentSnapshot } from "@/apps/agent/services/subagents/commands";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import {
  orderForPanel,
  selectSubagents,
  useAgentSubagentStore,
} from "@/apps/agent/store/subagents/useAgentSubagentStore";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";

const STATE_WORD: Record<SubagentSnapshot["status"], string> = {
  running: "Working",
  completed: "Finished",
  failed: "Failed",
  killed: "Stopped",
};

export const SubagentIndicator: React.FC = () => {
  const currentThreadId = useAgentChatStore((s) => s.currentThreadId);
  const agents = useAgentSubagentStore(selectSubagents(currentThreadId));
  const openAgentTab = useAgentWorkspaceStore((s) => s.openAgentTab);

  const [pinned, setPinned] = useState(false);
  const [peeking, setPeeking] = useState(false);
  const [flashing, setFlashing] = useState(false);
  const open = pinned || peeking || flashing;
  const selfOpened = flashing && !pinned && !peeking;
  const reduceMotion = useReducedMotion();

  const closeTimer = useRef<number | null>(null);
  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  const openPeek = useCallback(() => {
    cancelClose();
    setPeeking(true);
  }, [cancelClose]);
  const closePeekSoon = useCallback(() => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setPeeking(false), 140);
  }, [cancelClose]);
  useEffect(() => cancelClose, [cancelClose]);

  const triggerRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ right: number; top: number } | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const attachRoot = useCallback((el: HTMLDivElement | null) => {
    triggerRef.current = el;
    if (el) setPortalTarget((el.closest(".agw-root") as HTMLElement) ?? document.body);
  }, []);
  const place = useCallback(() => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const top = r.bottom + 8;
    const right = Math.max(8, window.innerWidth - r.right);
    setPos((prev) => (prev && prev.top === top && prev.right === right ? prev : { top, right }));
  }, []);

  // The card shows itself when an agent STARTS in this conversation — the
  // one moment the dock not opening would otherwise leave unannounced. A
  // finish is announced by the report card in the transcript, so it does
  // not flash here too.
  const flashTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!currentThreadId) return;
    const unsubscribe = useAgentSubagentStore.subscribe((state, previous) => {
      const next = state.byParent[currentThreadId];
      const prior = previous.byParent[currentThreadId];
      if (next === prior || !next) return;
      const running = (list?: SubagentSnapshot[]) =>
        (list ?? []).filter((a) => a.status === "running").length;
      if (running(next) <= running(prior)) return;
      place();
      setFlashing(true);
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlashing(false), 3500);
    });
    return () => {
      unsubscribe();
      if (flashTimer.current !== null) {
        window.clearTimeout(flashTimer.current);
        flashTimer.current = null;
      }
    };
  }, [currentThreadId, place]);

  useEffect(() => {
    if (!open) return;
    const onMove = () => place();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, place]);

  useEffect(() => {
    if (!pinned && !flashing) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if ((target as HTMLElement).closest?.(".agw-agentpop")) return;
      setPinned(false);
      setFlashing(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPinned(false);
        setPeeking(false);
        setFlashing(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [pinned, flashing]);

  const rows = useMemo(() => orderForPanel(agents), [agents]);
  const runningCount = rows.filter((a) => a.status === "running").length;
  const now = useNow(runningCount > 0);

  if (!currentThreadId || rows.length === 0) return null;

  const state = runningCount > 0 ? "running" : "idle";
  const label =
    runningCount > 0
      ? `${runningCount} of ${rows.length} agent${rows.length === 1 ? "" : "s"} working`
      : `${rows.length} agent${rows.length === 1 ? "" : "s"} in this conversation`;

  const openRow = (agent: SubagentSnapshot) => {
    openAgentTab(currentThreadId, agent.agentId, subagentLabel(agent));
    setPinned(false);
    setPeeking(false);
    setFlashing(false);
  };

  return (
    <div
      ref={attachRoot}
      className="agw-taskind-wrap"
      onMouseEnter={() => {
        place();
        openPeek();
      }}
      onMouseLeave={closePeekSoon}
    >
      <button
        type="button"
        className="agw-taskind agw-agentind"
        data-state={state}
        data-open={open || undefined}
        aria-expanded={open}
        aria-label={label}
        title={label}
        onFocus={() => {
          place();
          openPeek();
        }}
        onBlur={closePeekSoon}
        onClick={() => {
          place();
          setPinned((v) => !v);
        }}
      >
        <AgentIcon name="users" size={13} />
        <span className="agw-taskind-count">
          {runningCount > 0 ? `${runningCount}/${rows.length}` : rows.length}
        </span>
      </button>

      {portalTarget &&
        pos &&
        createPortal(
          <AnimatePresence>
            {open && (
              <motion.div
                layout
                className="agw-menu agw-taskpop agw-agentpop"
                role="menu"
                aria-label="Sub-agents in this conversation"
                style={{
                  position: "fixed",
                  top: pos.top,
                  right: pos.right,
                  zIndex: 12000,
                  transformOrigin: "top right",
                }}
                initial={{ opacity: 0, scale: 0.98, y: -6 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{
                  opacity: 0,
                  scale: 0.98,
                  y: -4,
                  transition: { duration: reduceMotion ? 0 : 0.14, ease: [0.4, 0, 1, 1] },
                }}
                transition={
                  reduceMotion
                    ? { duration: 0 }
                    : selfOpened
                      ? { duration: 0.26, ease: [0, 0, 0.2, 1] }
                      : { duration: 0.16, ease: [0.16, 1, 0.3, 1] }
                }
                onMouseEnter={openPeek}
                onMouseLeave={closePeekSoon}
              >
                <div className="agw-agentpop-head">
                  <span>Agents</span>
                  <span>{label}</span>
                </div>
                {rows.map((agent) => (
                  <button
                    key={agent.agentId}
                    type="button"
                    role="menuitem"
                    className="agw-agentpop-row"
                    data-status={agent.status}
                    onClick={() => openRow(agent)}
                    title={`Open ${subagentLabel(agent)}`}
                  >
                    <span className="agw-agentpop-lead">
                      <AgentLead status={agent.status} />
                    </span>
                    <span className="agw-agentpop-main">
                      <span className="agw-agentpop-name">
                        {/* Inner span: the name's own colour rule loads after
                            `.agw-shimmer` and would paint over the sweep. */}
                        <span className={agent.status === "running" ? "agw-shimmer" : undefined}>
                          {subagentLabel(agent)}
                        </span>
                      </span>
                      <span className="agw-agentpop-sub">
                        {STATE_WORD[agent.status]} · {agent.agentType}
                      </span>
                    </span>
                    <span className="agw-agentpop-time">
                      {fmtClock(agentElapsedMs(agent, now))}
                    </span>
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>,
          portalTarget,
        )}
    </div>
  );
};
