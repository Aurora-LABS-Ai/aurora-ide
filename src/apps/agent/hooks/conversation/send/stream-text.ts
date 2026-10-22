/**
 * Agent Window — send pipeline: streaming-text coalescing.
 *
 * Tokens arrive far faster than the display refreshes (bursty, often several
 * per millisecond). Text deltas collect in an OPEN buffer that is already
 * queued as one patch; the patch reads the buffer when the frame applies it,
 * so every token up to that moment lands in one write. Anything that appends
 * a NON-text timeline event seals the buffer first (`flush`), so text that
 * arrives after it starts a new buffer queued AFTER that event, and the
 * ordered timeline stays exact.
 */

import type { DbMessage } from "@/apps/agent/services/threads/thread-service";
import {
  appendContent,
  appendThinking,
  clearReconnect,
  type TimelineEvent,
} from "@/apps/agent/components/conversation/timeline";

/** Read the in-progress ordered timeline off a message (defaults to empty). */
export function timelineOf(m: DbMessage): TimelineEvent[] {
  const raw = (m as { timeline?: unknown }).timeline;
  return Array.isArray(raw) ? (raw as TimelineEvent[]) : [];
}

type TextDelta = { kind: "content" | "thinking"; text: string };

export interface StreamText {
  /** Add a token to the open buffer, opening one if none is queued. */
  queue: (kind: "content" | "thinking", text: string) => void;
  /** Seal the open buffer so the next token lands after whatever comes now. */
  flush: () => void;
  /**
   * Throw the not-yet-applied text of the current attempt away.
   *
   * Only for a reply the runtime has abandoned: those tokens are about to be
   * re-sent from the start, so applying them would render text that is then
   * immediately truncated — one wasted frame of the duplicate we are here to
   * prevent. Text queued before the attempt began is kept; it is real.
   */
  dropPending: () => void;
  /** A new stream attempt: text queued before this point belongs to an earlier one. */
  beginAttempt: () => void;
}

/**
 * The buffer for one streaming assistant message, writing through
 * `patchMessage` in the order it is called.
 */
export function createStreamText(
  patchMessage: (patch: (m: DbMessage) => DbMessage) => void,
): StreamText {
  let openText: TextDelta[] | null = null;
  // Buffers queued since the current stream attempt began, which a
  // discarded attempt empties before they are applied.
  let attemptText: TextDelta[][] = [];

  const queueTextPatch = (deltas: TextDelta[]) =>
    patchMessage((m) => {
      // Applied now: the next token opens a new buffer. Without this it
      // would land in this one, after it had already been read.
      if (openText === deltas) openText = null;
      if (deltas.length === 0) return m;
      // The retry is streaming, so the "reconnecting" marker has done its
      // job. Removed in the SAME patch that appends the recovered text, so
      // the marker never blinks out a frame before the reply resumes.
      let timeline = clearReconnect(timelineOf(m));
      let content = m.content || "";
      let thinking = m.thinking || "";
      let isThinking = !!m.isThinking;
      for (const d of deltas) {
        if (d.kind === "content") {
          // First content token ends the reasoning phase → thinking block
          // auto-collapses (same trigger the IDE uses via `isThinking`).
          content += d.text;
          timeline = appendContent(timeline, d.text);
          isThinking = false;
        } else {
          thinking += d.text;
          timeline = appendThinking(timeline, d.text);
          isThinking = true;
        }
      }
      return { ...m, content, thinking, isThinking, timeline };
    });

  return {
    queue: (kind, text) => {
      if (!openText) {
        const buffer: TextDelta[] = [];
        openText = buffer;
        attemptText.push(buffer);
        queueTextPatch(buffer);
      }
      const last = openText[openText.length - 1];
      if (last && last.kind === kind) last.text += text;
      else openText.push({ kind, text });
    },
    flush: () => {
      openText = null;
    },
    dropPending: () => {
      for (const buffer of attemptText) buffer.length = 0;
      attemptText = [];
      openText = null;
    },
    beginAttempt: () => {
      openText = null;
      attemptText = [];
    },
  };
}
