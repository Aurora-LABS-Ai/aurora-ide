/**
 * Agent Window — picked-element selection store (feature state).
 *
 * The Browser tab's inspector adds elements here, the composer renders them as
 * "Selected N" chips, and the send pipeline attaches them to the turn as context
 * (then clears).
 */

import { create } from "zustand";
import type {
  PickedElement,
  PickedElementAttribute,
} from "@/apps/agent/services/browser/browser-service";
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

/** How much of the element's own HTML rides to the model. */
export const SELECTION_HTML_MAX_CHARS = 2000;
/** How much of its visible text. The page script already stops at 400. */
export const SELECTION_TEXT_MAX_CHARS = 400;
/** Attributes shown besides id and class, which have their own lines. */
const SELECTION_ATTRIBUTES_MAX = 12;

/** `name=value; name=value`, values with `;` or newlines flattened. */
function pairs(list: PickedElementAttribute[] | null | undefined): string | null {
  if (!list || list.length === 0) return null;
  return list
    .map((p) => `${p.name}=${p.value.replace(/\s*\n\s*/g, " ")}`)
    .join("; ");
}

/**
 * One picked element as the lines the model reads. Text-only on purpose: a
 * pick must say the same thing to a model with no vision, so the picture is
 * replaced by what a picture would have told it — size, computed styles, the
 * row of siblings, and the component that owns the node.
 */
export function formatSelectedElement(e: SelectedEntry): string {
  const el = e.element;
  const text = (el.text ?? "").trim();
  const rect = el.boundingRect;
  const size =
    rect && (rect.width > 0 || rect.height > 0)
      ? `${Math.round(rect.width)}×${Math.round(rect.height)} at x=${Math.round(rect.x)}, y=${Math.round(rect.y)}`
      : null;
  const component = el.component
    ? `${el.component}${el.framework ? ` (${el.framework})` : ""}`
    : el.framework
      ? `none named (${el.framework} page)`
      : null;
  const attributes = pairs(
    (el.attributes ?? [])
      .filter((a) => a.name !== "id" && a.name !== "class")
      .slice(0, SELECTION_ATTRIBUTES_MAX),
  );
  const html = el.outerHtml
    ? el.outerHtml.length > SELECTION_HTML_MAX_CHARS
      ? `${el.outerHtml.slice(0, SELECTION_HTML_MAX_CHARS)}… [cut]`
      : el.outerHtml
    : null;
  const lines = [
    `<element index="${e.index}">`,
    `  tag: <${el.tagName}>`,
    text ? `  text: ${text.slice(0, SELECTION_TEXT_MAX_CHARS)}` : null,
    el.id ? `  id: #${el.id}` : null,
    el.className ? `  classes: ${el.className}` : null,
    el.path ? `  path: ${el.path}` : null,
    `  selector: ${el.selector}`,
    el.url ? `  url: ${el.url}` : null,
    size ? `  size: ${size}` : null,
    component ? `  component: ${component}` : null,
    pairs(el.props) ? `  props: ${pairs(el.props)}` : null,
    pairs(el.styles) ? `  styles: ${pairs(el.styles)}` : null,
    attributes ? `  attributes: ${attributes}` : null,
    el.parent ? `  parent: ${el.parent}` : null,
    el.siblings && el.siblings.length > 0
      ? `  siblings:\n${el.siblings.map((s) => `    ${s}`).join("\n")}`
      : null,
    html ? `  html: ${html}` : null,
    `</element>`,
  ].filter(Boolean);
  return lines.join("\n");
}

/**
 * Serialize the current selection into a context block for the agent turn.
 *
 * Carries enough identity (component, path, classes, visible text, HTML) for
 * the agent to LOCATE the source file that renders each element — it greps the
 * workspace — so picks map back to code regardless of framework (plain HTML,
 * React, Vue, …).
 */
export function buildSelectionContext(entries: SelectedEntry[]): string | null {
  if (entries.length === 0) return null;
  return [
    "<selected_elements>",
    "The user picked these elements in the in-app browser. A token like",
    "`@element:2` in their message marks WHERE in the sentence they meant the",
    "element with index=\"2\" below. First LOCATE the source file(s) in this",
    "workspace that render them — search (grep) by the component name, the id,",
    "the class names, or the visible text — then make the requested change in",
    "that source. `size` and `styles` are what the element looks like on the",
    "page right now; `siblings` is the row it sits in, the pick marked.",
    ...entries.map(formatSelectedElement),
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
    component: e.element.component ?? null,
    path: e.element.path ?? null,
  }));
}

/** The lines a pill's tooltip shows: what it is and where it lives. */
export function selectionTooltip(el: PickedElement): string {
  return [
    `<${el.tagName}>${el.id ? `#${el.id}` : ""}`,
    el.component ? `component: ${el.component}` : null,
    el.path ? `in: ${el.path}` : null,
    el.className ? `class: ${el.className}` : null,
    el.boundingRect
      ? `size: ${Math.round(el.boundingRect.width)}×${Math.round(el.boundingRect.height)}`
      : null,
    el.url ? `url: ${el.url}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}
