/**
 * Agent Window — picked-element selection store (feature state).
 *
 * Mirrors the IDE's `useChatStore.selectedElements` for the agent window: the
 * Browser tab's inspector adds elements here, the composer renders them as
 * "Selected N" chips, and the send pipeline attaches them to the turn as context
 * (then clears). Kept separate from the IDE store so the two windows don't share
 * selection state.
 */

import { create } from "zustand";
import type { PickedElement } from "@/apps/agent/services/browser/browser-service";
import type { AttachedSelectedElement } from "@/apps/agent/services/threads/thread-service";

export interface SelectedEntry {
  id: string;
  /** 1-based ordinal — the agent refers to picks as "selected 1". */
  index: number;
  element: PickedElement;
}

let seq = 0;

interface AgentSelectionState {
  selected: SelectedEntry[];
  add: (element: PickedElement) => void;
  remove: (id: string) => void;
  clear: () => void;
}

export const useAgentSelectionStore = create<AgentSelectionState>((set) => ({
  selected: [],
  add: (element) =>
    set((state) => {
      // Drop exact duplicates (same selector + url) so a stuttering listener
      // never produces a second pill for the node just clicked.
      const key = `${element.url || ""}|${element.selector}`;
      if (state.selected.some((e) => `${e.element.url || ""}|${e.element.selector}` === key)) {
        return {};
      }
      seq += 1;
      return {
        selected: [
          ...state.selected,
          { id: `pick-${seq}`, index: state.selected.length + 1, element },
        ],
      };
    }),
  remove: (id) =>
    set((state) => ({
      selected: state.selected
        .filter((e) => e.id !== id)
        .map((e, i) => ({ ...e, index: i + 1 })),
    })),
  clear: () => set({ selected: [] }),
}));

/**
 * Serialize the current selection into a context block for the agent turn.
 *
 * Carries enough identity (selector, id, classes, visible text, HTML) for the
 * agent to LOCATE the source file that renders each element — it greps the
 * workspace by id / class / text — so picks map back to code regardless of
 * framework (plain HTML, React, Vue, …).
 */
export function buildSelectionContext(entries: SelectedEntry[]): string | null {
  if (entries.length === 0) return null;
  const blocks = entries.map((e) => {
    const el = e.element;
    const lines = [
      `<element index="${e.index}">`,
      `  selector: ${el.selector}`,
      `  tag: <${el.tagName}>`,
      el.id ? `  id: #${el.id}` : null,
      el.className ? `  classes: ${el.className}` : null,
      el.text ? `  text: ${el.text.slice(0, 200)}` : null,
      el.url ? `  url: ${el.url}` : null,
      el.outerHtml ? `  html: ${el.outerHtml.slice(0, 700)}` : null,
      `</element>`,
    ].filter(Boolean);
    return lines.join("\n");
  });
  return [
    "<selected_elements>",
    "The user picked these elements in the in-app browser. First LOCATE the source",
    "file(s) in this workspace that render them — search (grep) by id, class names,",
    "or the visible text — then make the requested change in that source.",
    ...blocks,
    "</selected_elements>",
  ].join("\n");
}

/**
 * Compact, display-only chips for the user bubble. Mirrors the IDE's
 * `attachedSelectedElements`: enough to render a "Selected N" pill with a
 * tooltip, WITHOUT the heavy outerHTML (that rides to the model via
 * {@link buildSelectionContext}).
 */
export function buildSelectionPills(entries: SelectedEntry[]): AttachedSelectedElement[] {
  return entries.map((e) => ({
    index: e.index,
    selector: e.element.selector,
    tagName: e.element.tagName,
    url: e.element.url,
    text: e.element.text,
    source: e.element.source,
  }));
}
