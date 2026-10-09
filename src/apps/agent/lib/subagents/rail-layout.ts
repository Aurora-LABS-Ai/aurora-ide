/**
 * Agent Window — where sub-agents sit on the icon rail, and where their cards
 * go [pure].
 *
 * Probe: Documents/aurora-subagent-rail-designs.html (03, picked 2026-10-09).
 *
 * Two questions, both answered without the DOM so they can be tested:
 *
 * - Which agents get a cell. All of them while they fit; past that, running
 *   agents first, then the most recently started, with the rest behind a
 *   "+N" cell. Cells keep the order the agents started in, so a cell never
 *   moves while someone is reaching for it.
 * - Where the open cards go. Each card ends level with the bottom of its own
 *   cell; the stack is resolved from the lowest cell up so no card covers
 *   another, and when the top runs out of room the whole stack slides down as
 *   far as the window allows. Only a window too short for all of them makes
 *   cards overlap.
 */

import type { SubagentSnapshot } from "@/apps/agent/services/subagents/commands";

/** Cells the rail gives sub-agents, the "+N" cell included when it shows. */
export const RAIL_AGENT_SLOTS = 5;

/** Cards that can be pinned at once, beside the one open without a pin. */
export const MAX_PINNED_CARDS = 3;

/** An agent's letter: the first letter or digit of its name. */
export function agentInitial(label: string): string {
  const match = label.match(/[\p{L}\p{N}]/u);
  return (match?.[0] ?? "A").toUpperCase();
}

export interface RailSlots {
  /** Agents with their own cell, in start order. */
  shown: SubagentSnapshot[];
  /** Agents behind the "+N" cell, running first, then newest. */
  hidden: SubagentSnapshot[];
}

export function railSlots(
  agents: SubagentSnapshot[],
  slots: number = RAIL_AGENT_SLOTS,
): RailSlots {
  if (agents.length <= slots) return { shown: agents, hidden: [] };
  const ranked = agents.slice().sort((a, b) => {
    const ra = a.status === "running" ? 0 : 1;
    const rb = b.status === "running" ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return b.startedAtMs - a.startedAtMs;
  });
  // One slot goes to the "+N" cell itself.
  const keep = new Set(ranked.slice(0, slots - 1).map((agent) => agent.agentId));
  return {
    shown: agents.filter((agent) => keep.has(agent.agentId)),
    hidden: ranked.filter((agent) => !keep.has(agent.agentId)),
  };
}

export interface StackCard {
  id: string;
  /** The card's rendered height. */
  height: number;
  /** Bottom edge of the cell it belongs to, in viewport px. */
  anchorBottom: number;
}

/**
 * Top edge for each card, in viewport px.
 *
 * `top`/`bottom` bound the space cards may use (the window body under the
 * titlebar). `margin` keeps cards off those edges, `gap` apart from each other.
 */
export function stackCards(
  cards: StackCard[],
  bounds: { top: number; bottom: number },
  margin = 8,
  gap = 8,
): Record<string, number> {
  const lowestFirst = cards.slice().sort((a, b) => b.anchorBottom - a.anchorBottom);
  const minTop = bounds.top + margin;
  const maxBottom = bounds.bottom - margin;
  let ceiling = maxBottom;
  const placed = lowestFirst.map((card) => {
    // A card ends at its cell, a little below its centre line; never past the
    // card above it, and never so high that it would start above the window.
    const bottom = Math.min(ceiling, Math.max(card.anchorBottom + 6, minTop + card.height));
    const top = bottom - card.height;
    ceiling = top - gap;
    return { id: card.id, top, bottom };
  });
  if (placed.length === 0) return {};
  // Ran out of room at the top: slide everything down, as far as the lowest
  // card can go before it leaves the window.
  const deficit = minTop - Math.min(...placed.map((card) => card.top));
  const slack = maxBottom - placed[0].bottom;
  const shift = Math.max(0, Math.min(deficit, slack));
  const tops: Record<string, number> = {};
  for (const card of placed) tops[card.id] = Math.max(minTop, card.top + shift);
  return tops;
}
