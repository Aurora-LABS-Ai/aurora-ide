/**
 * Agent Window — the open conversation's sub-agents on the icon rail [view].
 *
 * Probe: Documents/aurora-subagent-rail-designs.html, 03 "Matrix with the
 * initial under it" (picked 2026-10-09). One cell per agent, low on the rail
 * above Providers: a 3×3 mark with the agent's initial under it. The mark is
 * the window's dot matrix while the agent runs and a still grid tinted by how
 * it ended after. A conversation reopened later shows its agents the same way,
 * because the list comes from Rust's records on open (`useSubagentWatch`).
 *
 * Click a cell: its card opens to the right of the rail (`SubagentRailCard`).
 * Double-click, or the card's pin button: the card is pinned and stays over
 * everything, through page changes, until closed. Which cards are out lives in
 * `useSubagentRailStore`; how they stack is `stackCards`.
 *
 * Frame budget, because this sits beside a streaming conversation:
 * - cells re-render only when an agent's name or status changes (memoised on
 *   strings), never per streamed token;
 * - the matrix animates opacity and transform only, so it stays on the
 *   compositor. The header's matrix also animates a filter, which repaints;
 *   this one does not;
 * - card positions are written straight to the DOM when a card opens, closes,
 *   resizes or the window resizes, never through React state and never per
 *   frame.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { prefetchSubagentTranscript } from "@/apps/agent/hooks/subagents/useSubagentTranscript";
import {
  agentInitial,
  MAX_PINNED_CARDS,
  railSlots,
  stackCards,
  type StackCard,
} from "@/apps/agent/lib/subagents/rail-layout";
import { subagentLabel, type SubagentSnapshot } from "@/apps/agent/services/subagents/commands";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import {
  selectSubagents,
  useAgentSubagentStore,
} from "@/apps/agent/store/subagents/useAgentSubagentStore";
import {
  selectOpenAgent,
  selectPinned,
  useSubagentRailStore,
} from "@/apps/agent/store/subagents/useSubagentRailStore";
import { toast } from "@/apps/agent/store/ui/useAgentToastStore";
import { useAgentUiStore } from "@/apps/agent/store/ui/useAgentUiStore";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";
import { SubagentRailCard } from "./SubagentRailCard";

const STATE_WORD: Record<SubagentSnapshot["status"], string> = {
  running: "running",
  completed: "finished",
  failed: "failed",
  killed: "stopped",
};

/**
 * How long a click on an open card's cell waits before closing it: long enough
 * for the second click of a double-click to turn the close into a pin.
 */
const DOUBLE_CLICK_MS = 250;

/** The "+N" list's id in the card stack. */
const MORE_ID = "__more";

const NINE = [0, 1, 2, 3, 4, 5, 6, 7, 8];

const RailAgentCell = React.memo<{
  parentThreadId: string;
  agentId: string;
  label: string;
  status: SubagentSnapshot["status"];
  open: boolean;
  pinned: boolean;
}>(function RailAgentCell({ parentThreadId, agentId, label, status, open, pinned }) {
  const closeTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    [],
  );
  const state = STATE_WORD[status];
  return (
    <button
      type="button"
      className="agw-iconrail-btn agw-iconrail-agent"
      data-subagent={agentId}
      data-status={status}
      data-active={open || pinned || undefined}
      data-pinned={pinned || undefined}
      aria-label={`${label}, ${state}${pinned ? ", pinned" : ""}`}
      aria-haspopup="dialog"
      aria-expanded={open || pinned}
      title={`${label} · ${state}`}
      onPointerEnter={() => prefetchSubagentTranscript(parentThreadId, agentId)}
      onFocus={() => prefetchSubagentTranscript(parentThreadId, agentId)}
      onClick={(event) => {
        // The second click of a double-click: the double-click handler owns it.
        if (event.detail > 1) return;
        const rail = useSubagentRailStore.getState();
        if (open) {
          if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
          closeTimer.current = window.setTimeout(() => {
            closeTimer.current = null;
            rail.toggleOpen(parentThreadId, agentId);
          }, DOUBLE_CLICK_MS);
          return;
        }
        rail.toggleOpen(parentThreadId, agentId);
      }}
      onDoubleClick={() => {
        if (closeTimer.current !== null) {
          window.clearTimeout(closeTimer.current);
          closeTimer.current = null;
        }
        if (!useSubagentRailStore.getState().togglePin(parentThreadId, agentId)) {
          toast("Three cards are pinned. Unpin one to pin another.");
        }
      }}
    >
      <span className="agw-railmx" data-running={status === "running" ? "" : undefined} aria-hidden>
        {NINE.map((i) => (
          <i key={i} />
        ))}
      </span>
      <span className="agw-railmx-init" aria-hidden>
        {agentInitial(label)}
      </span>
    </button>
  );
});

export const SubagentRail: React.FC = () => {
  const parentThreadId = useAgentChatStore((s) => s.currentThreadId);
  const agents = useAgentSubagentStore(selectSubagents(parentThreadId));
  const kill = useAgentSubagentStore((s) => s.kill);
  const openAgentTab = useAgentWorkspaceStore((s) => s.openAgentTab);
  const pinned = useSubagentRailStore(selectPinned(parentThreadId));
  const openId = useSubagentRailStore(selectOpenAgent(parentThreadId));
  // The "+N" list is open FOR a conversation, so switching chats closes it
  // without anything having to reset it.
  const [listOpenFor, setListOpenFor] = useState<string | null>(null);
  const listOpen = listOpenFor !== null && listOpenFor === parentThreadId;
  const setListOpen = useCallback(
    (open: boolean) => setListOpenFor(open ? parentThreadId : null),
    [parentThreadId],
  );

  // A card left open without a pin belongs to the chat it was opened in.
  useEffect(() => {
    useSubagentRailStore.getState().closeOpen();
  }, [parentThreadId]);

  // Put back the cards this conversation had pinned, from its own file. Once
  // per conversation per window; only when it has agents to pin.
  const hasAgents = agents.length > 0;
  useEffect(() => {
    if (parentThreadId && hasAgents) void useSubagentRailStore.getState().hydrate(parentThreadId);
  }, [parentThreadId, hasAgents]);

  const groupRef = useRef<HTMLDivElement | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const attachGroup = useCallback((el: HTMLDivElement | null) => {
    groupRef.current = el;
    if (el) setPortalTarget((el.closest(".agw-root") as HTMLElement) ?? document.body);
  }, []);

  // ── Card placement ──────────────────────────────────────────────────
  // Cards are found by their `data-agent` in the portal rather than through
  // refs: which cards exist changes with the store, and the DOM is the one
  // list that is always current when layout runs.
  const cardsOnScreen = useCallback(
    (): HTMLElement[] =>
      portalTarget
        ? [...portalTarget.querySelectorAll<HTMLElement>(":scope > .agw-railcard[data-agent]")]
        : [],
    [portalTarget],
  );
  const layout = useCallback(() => {
    const rail = groupRef.current?.closest(".agw-iconrail") as HTMLElement | null;
    if (!rail) return;
    const cards = cardsOnScreen();
    if (cards.length === 0) return;
    const railRect = rail.getBoundingClientRect();
    const cells = [...rail.querySelectorAll<HTMLElement>("[data-subagent]")];
    const more = rail.querySelector<HTMLElement>("[data-subagent-more]");
    const input: StackCard[] = [];
    for (const el of cards) {
      const id = el.dataset.agent ?? "";
      // An agent behind "+N" has no cell of its own; its card sits by "+N".
      const anchor = cells.find((cell) => cell.dataset.subagent === id) ?? more;
      if (!anchor) continue;
      input.push({ id, height: el.offsetHeight, anchorBottom: anchor.getBoundingClientRect().bottom });
    }
    const tops = stackCards(input, { top: railRect.top, bottom: railRect.bottom });
    for (const el of cards) {
      const top = tops[el.dataset.agent ?? ""];
      if (top === undefined) continue;
      el.style.top = `${Math.round(top)}px`;
      el.style.left = `${Math.round(railRect.right + 8)}px`;
    }
  }, [cardsOnScreen]);
  const frame = useRef<number | null>(null);
  const scheduleLayout = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      layout();
    });
  }, [layout]);
  // A card's height changes when its tail grows ("Show more") or a finished
  // agent's steps load; a running tail is a fixed window and does not fire this.
  const observer = useRef<ResizeObserver | null>(null);
  const observed = useRef(new Set<HTMLElement>());
  useEffect(() => {
    window.addEventListener("resize", scheduleLayout);
    const watched = observed.current;
    if (typeof ResizeObserver !== "undefined") observer.current = new ResizeObserver(scheduleLayout);
    return () => {
      window.removeEventListener("resize", scheduleLayout);
      observer.current?.disconnect();
      observer.current = null;
      watched.clear();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [scheduleLayout]);
  // Before paint, every render: cells come and go with the list, cards with
  // the store. Measuring a few boxes is cheaper than one frame in the wrong
  // place. New cards are observed once; gone ones are dropped.
  useLayoutEffect(() => {
    const cards = cardsOnScreen();
    const ro = observer.current;
    if (ro) {
      const now = new Set(cards);
      for (const el of observed.current) {
        if (!now.has(el)) {
          ro.unobserve(el);
          observed.current.delete(el);
        }
      }
      for (const el of cards) {
        if (!observed.current.has(el)) {
          ro.observe(el);
          observed.current.add(el);
        }
      }
    }
    layout();
  });

  // ── Dismissal of the unpinned card and the list ─────────────────────
  const anythingLoose = openId !== null || listOpen;
  useEffect(() => {
    if (!anythingLoose) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.(".agw-railcard, .agw-iconrail-agents")) return;
      useSubagentRailStore.getState().closeOpen();
      setListOpenFor(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      useSubagentRailStore.getState().closeOpen();
      setListOpenFor(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [anythingLoose]);

  if (!parentThreadId || agents.length === 0) return null;

  const { shown, hidden } = railSlots(agents);
  const byId = new Map(agents.map((agent) => [agent.agentId, agent]));
  const pinnedAgents = pinned.map((id) => byId.get(id)).filter(Boolean) as SubagentSnapshot[];
  const openAgent = openId ? (byId.get(openId) ?? null) : null;
  const pinFull = pinned.length >= MAX_PINNED_CARDS;

  const renderCard = (agent: SubagentSnapshot, isPinned: boolean) => {
    const label = subagentLabel(agent);
    return (
      <SubagentRailCard
        key={agent.agentId}
        parentThreadId={parentThreadId}
        agent={agent}
        pinned={isPinned}
        pinFull={pinFull}
        onTogglePin={() => {
          if (!useSubagentRailStore.getState().togglePin(parentThreadId, agent.agentId)) {
            toast("Three cards are pinned. Unpin one to pin another.");
          }
        }}
        onClose={() => {
          if (isPinned) useSubagentRailStore.getState().unpin(parentThreadId, agent.agentId);
          else useSubagentRailStore.getState().closeOpen();
        }}
        onOpenTab={() => {
          useAgentUiStore.getState().goHome();
          openAgentTab(parentThreadId, agent.agentId, label);
          if (!isPinned) useSubagentRailStore.getState().closeOpen();
        }}
        onStop={kill}
      />
    );
  };

  return (
    <>
      <span className="agw-iconrail-divider" role="separator" />
      <div ref={attachGroup} className="agw-iconrail-agents" role="group" aria-label="Sub-agents">
        {shown.map((agent) => (
          <RailAgentCell
            key={agent.agentId}
            parentThreadId={parentThreadId}
            agentId={agent.agentId}
            label={subagentLabel(agent)}
            status={agent.status}
            open={openId === agent.agentId}
            pinned={pinned.includes(agent.agentId)}
          />
        ))}
        {hidden.length > 0 && (
          <button
            type="button"
            className="agw-iconrail-btn agw-iconrail-agent-more"
            data-subagent-more=""
            data-active={listOpen || undefined}
            aria-haspopup="dialog"
            aria-expanded={listOpen}
            aria-label={`${hidden.length} more agents`}
            title={`${hidden.length} more agents`}
            onClick={() => setListOpen(!listOpen)}
          >
            +{hidden.length}
          </button>
        )}
      </div>
      <span className="agw-iconrail-divider" role="separator" />
      {portalTarget &&
        createPortal(
          <>
            {pinnedAgents.map((agent) => renderCard(agent, true))}
            {openAgent && !pinned.includes(openAgent.agentId) && renderCard(openAgent, false)}
            {listOpen && hidden.length > 0 && (
              <div
                data-agent={MORE_ID}
                className="agw-railcard agw-railcard-list"
                role="dialog"
                aria-label="More agents"
              >
                {hidden.map((agent) => (
                  <button
                    key={agent.agentId}
                    type="button"
                    className="agw-railcard-row"
                    data-status={agent.status}
                    onClick={() => {
                      setListOpen(false);
                      useSubagentRailStore.getState().openCard(parentThreadId, agent.agentId);
                    }}
                  >
                    <span className="agw-railcard-tile" data-status={agent.status} aria-hidden>
                      {agentInitial(subagentLabel(agent))}
                    </span>
                    <span className="agw-railcard-row-main">
                      <span className="agw-railcard-row-name">{subagentLabel(agent)}</span>
                      <span className="agw-railcard-row-sub">
                        {STATE_WORD[agent.status]}
                        {agent.description.trim() ? ` · ${agent.description.trim()}` : ""}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>,
          portalTarget,
        )}
    </>
  );
};
