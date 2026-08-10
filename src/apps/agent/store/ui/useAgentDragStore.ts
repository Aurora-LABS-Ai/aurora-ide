/**
 * Agent Window — in-window path drag [state].
 *
 * Pointer-driven, NOT HTML5 drag-and-drop: the IDE explorer already settled on
 * mouse events for the same job (`src/hooks/useInternalDrag.ts`) because this is
 * a Tauri webview whose window-level OS drag-drop handler is live, and the agent
 * window has no reason to bet on `dragstart` behaving differently here. It also
 * keeps the drag ghost ours to style.
 *
 * Deliberately separate from the IDE's `useDragStore`: that store's coordinator
 * moves files between folders and drops into the IDE editor, none of which exist
 * in this window, and its drop signal is app-global (see `lib/path-drag.ts` for
 * why that can't address one of several composers).
 *
 * A press is only "pending" until the pointer travels far enough to mean it —
 * below that threshold the press stays an ordinary click that opens the file.
 */

import { create } from "zustand";

/** Pixels the pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD = 5;

/**
 * A `click` landing within this window of a drag ending is that drag's own
 * mouseup echo (press and release on the same row), not a new intent. Browsers
 * fire it immediately, so the window only has to outlast dispatch — it must stay
 * well under the fastest deliberate press-again a person can perform.
 */
const CLICK_SUPPRESS_MS = 250;

interface AgentDragState {
  /** Pressed, but not yet past the threshold. */
  pendingPath: string | null;
  pendingName: string | null;
  pendingIsDir: boolean;
  startX: number;
  startY: number;

  /** Live drag (threshold crossed). */
  path: string | null;
  name: string | null;
  /** A directory, not a file — it lands as a folder mention. */
  isDir: boolean;
  isDragging: boolean;

  /** Pointer position, for the ghost. */
  x: number;
  y: number;

  /** `performance.now()` of the last REAL drag end; 0 if none. */
  endedAt: number;

  prepare: (
    path: string,
    name: string,
    x: number,
    y: number,
    isDir?: boolean,
  ) => void;
  moveTo: (x: number, y: number) => void;
  end: () => void;
}

export const useAgentDragStore = create<AgentDragState>((set, get) => ({
  pendingPath: null,
  pendingName: null,
  pendingIsDir: false,
  startX: 0,
  startY: 0,
  path: null,
  name: null,
  isDir: false,
  isDragging: false,
  x: 0,
  y: 0,
  endedAt: 0,

  prepare: (path, name, x, y, isDir = false) =>
    set({
      pendingPath: path,
      pendingName: name,
      pendingIsDir: isDir,
      startX: x,
      startY: y,
    }),

  moveTo: (x, y) => {
    const s = get();
    if (s.pendingPath && !s.isDragging) {
      const far =
        Math.abs(x - s.startX) > DRAG_THRESHOLD ||
        Math.abs(y - s.startY) > DRAG_THRESHOLD;
      if (far) {
        set({
          path: s.pendingPath,
          name: s.pendingName,
          isDir: s.pendingIsDir,
          isDragging: true,
          pendingPath: null,
          pendingName: null,
          x,
          y,
        });
      }
      return;
    }
    if (s.isDragging) set({ x, y });
  },

  end: () =>
    set((s) => ({
      pendingPath: null,
      pendingName: null,
      pendingIsDir: false,
      path: null,
      name: null,
      isDir: false,
      isDragging: false,
      // Only a drag that actually happened may swallow the click behind it.
      endedAt: s.isDragging ? performance.now() : s.endedAt,
    })),
}));

/**
 * True when the click now being handled is the tail of a drag. Drag sources call
 * this before acting on `onClick`, so releasing a drag over its own row doesn't
 * also open the file.
 */
export function dragJustEnded(): boolean {
  const { endedAt } = useAgentDragStore.getState();
  return endedAt > 0 && performance.now() - endedAt < CLICK_SUPPRESS_MS;
}
