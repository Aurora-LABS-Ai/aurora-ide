/**
 * Agent Window — toasts [state].
 *
 * A toast is a short fact about something that just happened ("Prompt
 * copied", "Saved") — not page content, so it never takes a place in a page's
 * layout. Any feature calls `toast(text)`; one `AgentToaster` at the window
 * root draws them. Each clears itself; a few can stack, the oldest leaving
 * first when there are too many.
 *
 * Not for errors someone has to read and act on: those belong inline, next
 * to what failed, until dismissed. `tone: "error"` is for a failure that is
 * fully explained by one short line ("Could not copy").
 */

import { create } from "zustand";

import type { AgentIconName } from "@/apps/agent/shared/AgentIcon";

export type ToastTone = "info" | "success" | "error";

export interface AgentToast {
  id: number;
  text: string;
  tone: ToastTone;
  icon?: AgentIconName;
  /** How long it stays, in ms. */
  duration: number;
}

export interface ToastOptions {
  tone?: ToastTone;
  /** Defaults by tone: a check for success, an alert for error, none for info. */
  icon?: AgentIconName;
  duration?: number;
}

/** Long enough to read a few words, short enough not to linger. */
export const TOAST_DURATION_MS = 2200;
/** More than this at once and the oldest goes. */
export const MAX_TOASTS = 3;

const DEFAULT_ICON: Record<ToastTone, AgentIconName | undefined> = {
  info: undefined,
  success: "check",
  error: "alert",
};

interface AgentToastState {
  toasts: AgentToast[];
  /** Show a toast; returns its id. Empty text shows nothing and returns -1. */
  show: (text: string, options?: ToastOptions) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export const useAgentToastStore = create<AgentToastState>()((set, get) => ({
  toasts: [],

  show: (text, options = {}) => {
    const trimmed = text.trim();
    if (!trimmed) return -1;
    const tone = options.tone ?? "success";
    const entry: AgentToast = {
      id: nextId++,
      text: trimmed,
      tone,
      icon: options.icon ?? DEFAULT_ICON[tone],
      duration: options.duration ?? TOAST_DURATION_MS,
    };
    // The same words again replace the old toast rather than stacking twice;
    // past the limit the oldest goes.
    const next = [...get().toasts.filter((existing) => existing.text !== trimmed), entry];
    while (next.length > MAX_TOASTS) next.shift();
    const live = new Set(next.map((existing) => existing.id));
    for (const [id, timer] of timers) {
      if (!live.has(id)) {
        clearTimeout(timer);
        timers.delete(id);
      }
    }
    set({ toasts: next });
    timers.set(
      entry.id,
      setTimeout(() => get().dismiss(entry.id), entry.duration),
    );
    return entry.id;
  },

  dismiss: (id) => {
    clearTimeout(timers.get(id));
    timers.delete(id);
    if (get().toasts.some((entry) => entry.id === id)) {
      set({ toasts: get().toasts.filter((entry) => entry.id !== id) });
    }
  },
}));

/** Show a toast from anywhere — components, hooks or services. */
export const toast = (text: string, options?: ToastOptions): number =>
  useAgentToastStore.getState().show(text, options);
