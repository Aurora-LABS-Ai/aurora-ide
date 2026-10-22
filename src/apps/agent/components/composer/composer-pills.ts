/**
 * Agent Window — composer: the inline pills and the triggers that make them.
 *
 * Everything here is plain DOM, no React: the pills are built imperatively
 * inside a contenteditable, so they cannot mount components. Moved out of
 * `AgentComposer.tsx` on 2026-10-19; the four pill kinds used to each carry
 * their own copy of the same caret-and-range dance, which is now
 * `replaceTriggerWithPill`.
 */

import { resolveExplorerIcon } from "@/kernel/lib/icons/icon-registry";
import { useSettingsStore } from "@/kernel/store/useSettingsStore";
import type { TerminalSessionSummary } from "@/apps/agent/services/terminal/terminal-sessions";
import type { PromptCommand, PromptCommandKind } from "@/apps/agent/adapters/prompt-commands";
import {
  selectionTooltip,
  type SelectedEntry,
} from "@/apps/agent/store/composer/useAgentSelectionStore";

/** `@` mention trigger: at line start, after whitespace or `(`, then the query. */
export const MENTION_RE = /(^|[\s(])@([^\s@]{0,48})$/;
/** `/` directive trigger: at line start or after whitespace, word/dash query. */
export const SLASH_RE = /(^|\s)\/([\w-]{0,48})$/;

/** Commands the `/` menu lists; it scrolls past what fits. */
export const COMMAND_RESULT_LIMIT = 80;

/** How a bare `/` groups its commands, in this order. */
export const COMMAND_GROUP_ORDER: PromptCommandKind[] = ["action", "skill", "rule", "mcp", "image"];
export const COMMAND_GROUP_LABEL: Record<PromptCommandKind, string> = {
  action: "Actions",
  skill: "Skills",
  rule: "Rules",
  mcp: "MCP servers",
  image: "Images",
};

/** Lucide-ish glyph per command kind (skills / rules / MCP / image). */
export const COMMAND_ICON: Record<PromptCommandKind, "book" | "shield" | "plug" | "image" | "refine"> = {
  skill: "book",
  rule: "shield",
  mcp: "plug",
  image: "image",
  action: "refine",
};

/** Positions in `title` that match `query` (as a prefix or anywhere), for highlighting. */
export function titleMatches(title: string, query: string): number[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const at = title.toLowerCase().indexOf(q);
  return at < 0 ? [] : Array.from({ length: q.length }, (_, k) => at + k);
}

/** Raw SVG paths for each command kind — for the INLINE pill, which is built
 *  imperatively (not React), so it can't mount an <AgentIcon>. Mirrors the
 *  `book` / `shield` / `plug` glyphs. */
const COMMAND_ICON_PATHS: Record<PromptCommandKind, string> = {
  skill:
    '<path d="M5 4.5h9.5a2 2 0 0 1 2 2V19a1.5 1.5 0 0 0-1.5-1.5H5z"/><path d="M5 4.5A1.5 1.5 0 0 0 3.5 6v13A1.5 1.5 0 0 1 5 17.5"/><path d="M8 8.5h5.5"/><path d="M8 11.5h5.5"/>',
  rule:
    '<path d="M12 3 19 5.7v5.5c0 4.55-3 7.6-7 8.9-4-1.3-7-4.35-7-8.9V5.7z"/><path d="M9.1 11.9l2.1 2.1 3.7-3.9"/>',
  mcp:
    '<path d="M9 2.75v3.75M15 2.75v3.75"/><path d="M6.75 6.5h10.5v3.25a5.25 5.25 0 0 1-10.5 0z"/><path d="M12 15v6.25"/>',
  image:
    '<rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><path d="M3.5 16.2l4.6-4.4 3.6 3.4 3.1-2.6 5.7 4.6"/><circle cx="15.6" cy="9.1" r="1.7"/>',
  action:
    '<path d="m12 3 1.55 4.7L18.5 9.25l-4.95 1.55L12 15.5l-1.55-4.7L5.5 9.25l4.95-1.55z"/><path d="m19 14 .7 2.1 2.1.7-2.1.7L19 19.6l-.7-2.1-2.1-.7 2.1-.7z"/><path d="m5 15 .55 1.65 1.65.55-1.65.55L5 19.4l-.55-1.65-1.65-.55 1.65-.55z"/>',
};
function commandIconSvg(kind: PromptCommandKind): string {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${COMMAND_ICON_PATHS[kind]}</svg>`;
}

/** The `@terminal` pill's mark: a prompt caret and a cursor bar in a frame. */
const TERMINAL_PILL_ICON_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7.5 10l2.5 2-2.5 2"/><path d="M13 14h3.5"/></svg>';

/** The `inspect` glyph, for the imperatively-built inline selection pill. */
const INSPECT_ICON_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.4 6.1l3.5 3.5"/><path d="M16.1 4.4a1.9 1.9 0 0 1 2.7 0l0.8 0.8a1.9 1.9 0 0 1 0 2.7L8.2 18.9l-4.2 1 1-4.2z"/></svg>';

/**
 * Pills that make the editor worth SENDING — each one carries a reference the
 * model receives even with no prose around it.
 */
export const SENDABLE_PILLS = "[data-rel],[data-term]";
/**
 * Pills that are VISIBLE in the editor. A `/` directive shows but sends nothing
 * of its own, so it hides the placeholder without making the input sendable.
 *
 * Both selectors exist because these two questions were previously asked with
 * inline `querySelector` calls listing pill kinds by hand — and adding the
 * `@terminal` pill missed them, so picking a terminal left the placeholder
 * painted straight over the chip.
 */
export const VISIBLE_PILLS = "[data-rel],[data-term],[data-cmd]";

export function placeCaretAtEnd(el: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/**
 * Build the inline pill for one inspector pick.
 *
 * Browser selections used to sit in their own row ABOVE the input while `@`
 * files and `/` directives lived inline — so the one attachment kind the user
 * did NOT type appeared furthest from where they were typing, detached from the
 * sentence it belonged to. This makes it the same object as the other two:
 * inline at the caret, deleted by Backspace, reconciled against the store.
 */
export function buildSelectionPill(entry: SelectedEntry): HTMLSpanElement {
  const el = entry.element;
  const text = (el.text ?? "").trim();
  const pill = document.createElement("span");
  pill.className = "agw-pill-inline agw-pill-sel";
  pill.contentEditable = "false";
  pill.dataset.sel = entry.id;
  pill.title = selectionTooltip(el);

  const ico = document.createElement("span");
  ico.className = "agw-pill-cmd-ico";
  ico.innerHTML = INSPECT_ICON_SVG;
  pill.appendChild(ico);

  const tag = document.createElement("span");
  tag.className = "agw-sel-tag";
  tag.textContent = `<${el.tagName}>`;
  pill.appendChild(tag);

  if (text) {
    const label = document.createElement("span");
    label.className = "agw-sel-text";
    label.textContent = text.slice(0, 24);
    pill.appendChild(label);
  }
  return pill;
}

/**
 * The `@terminal` pill for one open session. Same anatomy as the file pill
 * because it is the same gesture and the caret rules (backspace deletes the
 * widget whole) are shared by `isPill`.
 */
export function buildTerminalPill(session: TerminalSessionSummary): HTMLSpanElement {
  const pill = document.createElement("span");
  pill.className = "agw-pill-inline agw-pill-term";
  pill.contentEditable = "false";
  pill.dataset.term = session.id;
  pill.dataset.termTitle = session.title;
  pill.title = session.cwd ? `${session.title} — ${session.cwd}` : session.title;
  const ico = document.createElement("span");
  ico.className = "agw-pill-cmd-ico";
  ico.innerHTML = TERMINAL_PILL_ICON_SVG;
  pill.appendChild(ico);
  const label = document.createElement("span");
  label.textContent = session.title;
  pill.appendChild(label);
  return pill;
}

/**
 * A file or folder pill. `rel` is what serializes into the message
 * (`@src\foo.ts`), `path` is the absolute path the file chip and "open in
 * IDE" use. A folder is marked `data-kind="dir"`, read at submit so the model
 * is told it was handed a folder to look inside, not a file to read.
 */
export function buildPathPill(opts: {
  name: string;
  rel: string;
  path: string;
  isDir: boolean;
}): HTMLSpanElement {
  const pill = document.createElement("span");
  pill.className = "agw-pill-inline";
  pill.contentEditable = "false";
  pill.dataset.rel = opts.rel;
  pill.dataset.path = opts.path;
  if (opts.isDir) pill.dataset.kind = "dir";
  try {
    const resolved = resolveExplorerIcon(
      { name: opts.name, path: opts.path, isFolder: opts.isDir },
      useSettingsStore.getState().explorerIconPack,
    );
    if (resolved.src) {
      const img = document.createElement("img");
      img.src = resolved.src;
      img.alt = "";
      img.className = "agw-pill-ico";
      img.draggable = false;
      pill.appendChild(img);
    }
  } catch {
    /* icon optional */
  }
  const label = document.createElement("span");
  label.textContent = opts.name;
  pill.appendChild(label);
  return pill;
}

/** A `/` directive pill (skill / rule / MCP / image). */
export function buildCommandPill(c: PromptCommand): HTMLSpanElement {
  const pill = document.createElement("span");
  pill.className = "agw-pill-inline agw-pill-cmd";
  pill.contentEditable = "false";
  pill.dataset.cmd = c.key;
  pill.dataset.cmdKind = c.kind;
  // What the pill serializes as on send (`/title`) — must match the chip
  // title recorded on the message, or the bubble can't re-pill it in place.
  pill.dataset.cmdTitle = c.title;
  pill.title = `${c.sourceLabel} · ${c.subtitle}`;
  const ico = document.createElement("span");
  ico.className = "agw-pill-cmd-ico";
  ico.innerHTML = commandIconSvg(c.kind);
  pill.appendChild(ico);
  const label = document.createElement("span");
  label.textContent = c.title;
  pill.appendChild(label);
  return pill;
}

/**
 * The text node under the caret and the trigger match before it, or `null`
 * when the caret is not in `el`'s text or nothing matches.
 */
export function triggerBeforeCaret(
  el: HTMLElement,
  re: RegExp,
): { node: Text; offset: number; match: RegExpMatchArray } | null {
  const s = window.getSelection();
  if (!s || s.rangeCount === 0) return null;
  const node = s.anchorNode;
  if (!node || node.nodeType !== Node.TEXT_NODE || !el.contains(node)) return null;
  const offset = s.anchorOffset;
  const before = (node.textContent ?? "").slice(0, offset);
  const match = before.match(re);
  if (!match) return null;
  return { node: node as Text, offset, match };
}

/**
 * Replace the typed trigger (`@query` / `/query`) before the caret with
 * `pill` and a trailing space, and leave the caret after the space. Returns
 * false when no trigger is there to replace.
 */
export function replaceTriggerWithPill(el: HTMLElement, re: RegExp, pill: HTMLElement): boolean {
  const hit = triggerBeforeCaret(el, re);
  if (!hit) return false;
  const { node, offset, match } = hit;
  const at = offset - (match[2].length + 1); // index of the trigger character

  const range = document.createRange();
  range.setStart(node, at);
  range.setEnd(node, offset);
  range.deleteContents();

  const space = document.createTextNode(" ");
  range.insertNode(space);
  range.insertNode(pill);

  const after = document.createRange();
  after.setStartAfter(space);
  after.collapse(true);
  const s = window.getSelection();
  s?.removeAllRanges();
  s?.addRange(after);
  return true;
}

/** Delete the typed trigger before the caret without inserting anything. */
export function deleteTriggerBeforeCaret(el: HTMLElement, re: RegExp): void {
  const hit = triggerBeforeCaret(el, re);
  if (!hit) return;
  const { node, offset, match } = hit;
  const range = document.createRange();
  range.setStart(node, offset - (match[2].length + 1));
  range.setEnd(node, offset);
  range.deleteContents();
}

/**
 * Insert `pill` at the caret (or at the end when the caret is elsewhere),
 * followed by a space, and leave the caret after it. For pills that do not
 * replace a typed trigger: drops and the OS file picker.
 */
export function insertPillAtCaret(el: HTMLElement, pill: HTMLElement): void {
  el.focus();
  const sel0 = window.getSelection();
  if (!sel0 || sel0.rangeCount === 0 || !el.contains(sel0.anchorNode)) {
    placeCaretAtEnd(el);
  }
  const range = window.getSelection()?.getRangeAt(0);
  if (!range) return;
  const space = document.createTextNode(" ");
  range.insertNode(space);
  range.insertNode(pill);
  const after = document.createRange();
  after.setStartAfter(space);
  after.collapse(true);
  const sel2 = window.getSelection();
  sel2?.removeAllRanges();
  sel2?.addRange(after);
}
