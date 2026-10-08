/**
 * Agent Window — what an agent tab remembers between mounts [memory].
 *
 * The dock mounts only the active tab, so switching away from an agent and
 * back remounts `SubagentPanel`. Two things survive that here, or the reader
 * is dumped at the top of a transcript they were following:
 *
 * - the transcript last shown, so the remount renders content at once (the
 *   scroll hook anchors to the bottom in a layout effect, and a panel that
 *   says "Loading…" for its first 400 ms has nothing to anchor);
 * - where the reader was: at the bottom (follow again) or a position they had
 *   scrolled to (put them back there).
 *
 * Module-level, keyed by parent + agent, like the parked reports.
 */

import type { DbThread } from "@/apps/agent/services/threads/thread-service";

const transcripts = new Map<string, DbThread>();
const scroll = new Map<string, number | "bottom">();

/** Within this many px of the end counts as "at the bottom". */
export const SUBAGENT_BOTTOM_PX = 140;

export const subagentMemoryKey = (parentThreadId: string, agentId: string): string =>
  `${parentThreadId}:${agentId}`;

export const recallTranscript = (key: string): DbThread | undefined => transcripts.get(key);

export const rememberTranscript = (key: string, thread: DbThread): void => {
  transcripts.set(key, thread);
};

/** The `scrollTop` to put back, or `null` when the reader was at the bottom (or unknown). */
export const recallScrollTop = (key: string): number | null => {
  const remembered = scroll.get(key);
  return typeof remembered === "number" ? remembered : null;
};

/** Record where a scroller was when its tab went away. */
export const rememberScroll = (key: string, el: HTMLElement): void => {
  const fromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
  scroll.set(key, fromBottom <= SUBAGENT_BOTTOM_PX ? "bottom" : el.scrollTop);
};

/** Agents whose live preview is open in the Agents tab, by parent + agent. */
const openPreviews = new Set<string>();

export const isPreviewOpen = (parentThreadId: string, agentId: string): boolean =>
  openPreviews.has(subagentMemoryKey(parentThreadId, agentId));

export const setPreviewOpen = (parentThreadId: string, agentId: string, open: boolean): void => {
  const key = subagentMemoryKey(parentThreadId, agentId);
  if (open) openPreviews.add(key);
  else openPreviews.delete(key);
};

/** Previews grown with "Show more", by parent + agent. */
const grownPreviews = new Set<string>();

export const isPreviewGrown = (parentThreadId: string, agentId: string): boolean =>
  grownPreviews.has(subagentMemoryKey(parentThreadId, agentId));

export const setPreviewGrown = (parentThreadId: string, agentId: string, grown: boolean): void => {
  const key = subagentMemoryKey(parentThreadId, agentId);
  if (grown) grownPreviews.add(key);
  else grownPreviews.delete(key);
};

/** Test seam. */
export const clearSubagentMemory = (): void => {
  transcripts.clear();
  scroll.clear();
  openPreviews.clear();
  grownPreviews.clear();
};
