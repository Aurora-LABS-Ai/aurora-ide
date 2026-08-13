/**
 * Agent Window — custom icon system [shared primitive].
 *
 * A SINGLE, dedicated icon component for the entire agent window. Every glyph
 * here is hand-authored SVG owned by this module — NO `lucide-react`, no public
 * icon font, no third-party set. This keeps the agent window's visual language
 * bespoke and fully under our control (stroke weight, corner radius, optical
 * sizing) and lets us evolve the set without a dependency.
 *
 * Usage:
 *   <AgentIcon name="send" size={14} />
 *   <AgentIcon name="chat" />            // defaults to 16px
 *
 * Conventions for every glyph:
 *   • 24×24 viewBox, drawn on a 1.5px optical grid
 *   • stroke = currentColor, fill = none (so it inherits text color)
 *   • round caps + joins for a soft, modern feel
 *   • small solid accents (dots) opt into fill via `fill="currentColor"`
 */

import React from "react";

export type AgentIconName =
  | "alert"
  | "panel-left"
  | "panel-right"
  | "chevrons-left"
  | "chevron-down"
  | "plus"
  | "search"
  | "zoom-in"
  | "zoom-out"
  | "fit"
  | "message"
  | "chat"
  | "more"
  | "diff"
  | "design-guidelines"
  | "file-read"
  | "file-write"
  | "file-edit"
  | "file-move"
  | "file-delete"
  | "workspace-tree"
  | "code-index"
  | "process-stop"
  | "process-list"
  | "terminal-watch"
  | "shell-output"
  | "diagnostics"
  | "task-list"
  | "checklist"
  | "skill-search"
  | "browser-click"
  | "browser-fill"
  | "browser-scroll"
  | "browser-screenshot"
  | "browser-navigate"
  | "browser-key"
  | "browser-viewport"
  | "browser-outline"
  | "layers"
  | "send"
  | "mic"
  | "review"
  | "files"
  | "browser"
  | "terminal"
  | "side-chat"
  | "close"
  | "check"
  | "copy"
  | "retry"
  | "help"
  | "external"
  | "columns"
  | "rows"
  | "inspect"
  | "stop"
  | "settings"
  | "providers"
  | "shield"
  | "plug"
  | "mcp"
  | "sliders"
  | "users"
  | "arrow-left"
  | "palette"
  | "upload"
  | "download"
  | "contrast"
  | "type"
  | "reset"
  | "book"
  | "folder"
  | "pin"
  | "archive"
  | "trash"
  | "database"
  | "sort"
  | "eye"
  | "refine"
  | "facet"
  | "book-open";

interface AgentIconProps {
  name: AgentIconName;
  /** Pixel size (width = height). Defaults to 16. */
  size?: number;
  /** Stroke weight on the 24-grid. Defaults to 1.8. */
  strokeWidth?: number;
  className?: string;
  style?: React.CSSProperties;
  /** Accessible label; when omitted the icon is decorative (aria-hidden). */
  title?: string;
}

/**
 * Glyph geometry. Each entry returns the inner SVG primitives; the wrapper
 * supplies the shared stroke/fill/cap defaults.
 */
const GLYPHS: Record<AgentIconName, React.ReactNode> = {
  // Layout — left panel with a thin sidebar column.
  "panel-left": (
    <>
      <rect x="3.25" y="4.25" width="17.5" height="15.5" rx="2.6" />
      <line x1="9" y1="4.75" x2="9" y2="19.25" />
    </>
  ),

  // Layout — right panel (dock) with the column on the trailing edge.
  "panel-right": (
    <>
      <rect x="3.25" y="4.25" width="17.5" height="15.5" rx="2.6" />
      <line x1="15" y1="4.75" x2="15" y2="19.25" />
    </>
  ),

  // Collapse rail — double chevron pointing left.
  "chevrons-left": (
    <>
      <path d="M11 7l-4.5 5 4.5 5" />
      <path d="M17.5 7L13 12l4.5 5" />
    </>
  ),

  // Disclosure chevron.
  "chevron-down": <path d="M5.5 9.5l6.5 6 6.5-6" />,

  // Agent mode — an original faceted mark (a cut crystal / entity). Bespoke,
  // not a stock glyph. Pairs with `book` (Plan mode).
  facet: (
    <>
      <path d="M12 3l6.5 6-6.5 12-6.5-12z" />
      <path d="M5.5 9h13" />
      <path d="M12 3v18" />
    </>
  ),

  // Refine / composer assists — a fountain-pen nib above its freshly written
  // line. Bespoke mark (pairs with `facet`); deliberately NOT a sparkle.
  refine: (
    <>
      <path d="M8 4.5h8l1 5.5-5 6.5-5-6.5z" />
      <circle cx="12" cy="8" r="1" />
      <path d="M12 9.6v3.4" />
      <path d="M6.5 20.5h11" />
    </>
  ),

  // New chat / add.
  plus: (
    <>
      <path d="M12 5.5v13" />
      <path d="M5.5 12h13" />
    </>
  ),

  // Search.
  search: (
    <>
      <circle cx="11" cy="11" r="6.4" />
      <path d="M20 20l-4.3-4.3" />
    </>
  ),

  "zoom-in": (
    <>
      <circle cx="10.5" cy="10.5" r="6.25" />
      <path d="M15.2 15.2 20 20" />
      <path d="M10.5 7.7v5.6M7.7 10.5h5.6" />
    </>
  ),

  "zoom-out": (
    <>
      <circle cx="10.5" cy="10.5" r="6.25" />
      <path d="M15.2 15.2 20 20" />
      <path d="M7.7 10.5h5.6" />
    </>
  ),

  fit: (
    <>
      <path d="M9 4.5H4.5V9M15 4.5h4.5V9M9 19.5H4.5V15M15 19.5h4.5V15" />
      <rect x="8" y="8" width="8" height="8" rx="1.5" />
    </>
  ),

  // Conversation bubble (rail list rows) — rounded with a bottom-left tail.
  message: (
    <path d="M7 4h10a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3h-6l-4 3.2V15a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z" />
  ),

  // Chat / thread glyph (rail rows + conversation header) — TURNS, not a bubble.
  //
  // Two pill bars: a long one aligned LEFT, a short one aligned RIGHT. That is
  // this app's own transcript shape (incoming stacks left, the reply stacks
  // right) reduced to two strokes, so the mark says "a conversation with turns"
  // instead of borrowing the generic speech balloon every other chat app uses.
  //
  // Why it survives 14px, where the old outlined bubble did not: no contour to
  // enclose anything, no interior detail competing with it — two heavy strokes
  // (2.7 vs the set's 1.8) with round caps, held 6 units apart so the gap is
  // still ~3 device px at the sizes this is actually rendered at. The staggered
  // alignment is what keeps it from reading as a list or a menu icon.
  chat: (
    <>
      <path d="M4.5 8.6h12.5" strokeWidth={2.9} />
      <path d="M13.5 15.4h6" strokeWidth={2.9} />
    </>
  ),

  // Overflow actions — three dots.
  more: (
    <>
      <circle cx="5.2" cy="12" r="1.65" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.65" fill="currentColor" stroke="none" />
      <circle cx="18.8" cy="12" r="1.65" fill="currentColor" stroke="none" />
    </>
  ),

  // design_guidelines / canvas_guidelines — an artboard with two layout guides
  // running across it. Bespoke (pairs with `facet` and `refine`).
  //
  // It used to fall through to `diff`, so the tool that hands over the design
  // doctrine wore a document-with-a-folded-corner — the file family's mark, on
  // a tool that touches no file. What this tool uniquely carries is the RULES a
  // surface is held to, so the mark is the thing you snap to: guides that run
  // past the edges of the frame (a guide belongs to the canvas, not to the box)
  // and sit deliberately OFF-centre, which reads as considered proportion
  // rather than as a grid or a crop.
  "design-guidelines": (
    <>
      <path d="M5 5h14v14H5z" />
      <path d="M14 2.5v19" />
      <path d="M2.5 9.5h19" />
    </>
  ),

  // File diff chip — document with a folded corner and a change marker.
  diff: (
    <>
      <path d="M8 3.5h5.5L18 8v10.5A1.5 1.5 0 0 1 16.5 20h-9A1.5 1.5 0 0 1 6 18.5v-13A1.5 1.5 0 0 1 7.5 4z" />
      <path d="M13.5 3.5V8H18" />
      <path d="M9.5 13.5h5" />
      <path d="M12 11v5" />
    </>
  ),

  // file_read — a document showing text lines (reading existing content).
  "file-read": (
    <>
      <path d="M6 3.5h6.5L16 7v4.3" />
      <path d="M12.5 3.5V7H16" />
      <path d="M6 3.5v17h6" />
      <path d="M8.8 11h3.3" />
      <circle cx="16.2" cy="16.2" r="3.4" />
      <path d="m18.7 18.7 2.3 2.3" />
    </>
  ),

  // file_write — a document with a plus: create or overwrite with new content.
  "file-write": (
    <>
      <path d="M8 3.5h5.5L18 8v10.5A1.5 1.5 0 0 1 16.5 20h-9A1.5 1.5 0 0 1 6 18.5v-13A1.5 1.5 0 0 1 7.5 4z" />
      <path d="M13.5 3.5V8H18" />
      <path d="M12 11.3v5.4" />
      <path d="M9.3 14h5.4" />
    </>
  ),

  // file_edit — a document with a pencil over a line: a surgical edit.
  "file-edit": (
    <>
      <path d="M8 3.5h5.5L18 8v4.2" />
      <path d="M8 3.5A1.5 1.5 0 0 0 6 5v13.5A1.5 1.5 0 0 0 7.5 20H10" />
      <path d="M8.8 12.2h3" />
      <path d="M15.7 12.5l1.9 1.9-4.4 4.4-2.4.5.5-2.4z" />
    </>
  ),

  // file_move — an open document with an arrow exiting right (move / rename).
  "file-move": (
    <>
      <path d="M7 4h4.8L15 7.2V11" />
      <path d="M7 4A1.45 1.45 0 0 0 5.55 5.45V18.55A1.45 1.45 0 0 0 7 20h3.2" />
      <path d="M12.5 16.5h6" />
      <path d="M16 14l2.5 2.5L16 19" />
    </>
  ),

  // file_delete — a document with an X (remove).
  "file-delete": (
    <>
      <path d="M8 3.5h5.5L18 8v10.5A1.5 1.5 0 0 1 16.5 20h-9A1.5 1.5 0 0 1 6 18.5v-13A1.5 1.5 0 0 1 7.5 4z" />
      <path d="M13.5 3.5V8H18" />
      <path d="M10 12.4l4 4" />
      <path d="M14 12.4l-4 4" />
    </>
  ),

  // The `code` tool — one symbol and the things that reach it. Bespoke, and
  // deliberately NOT angle brackets: `<>` says "source code" generically, which
  // is every other tool here too. What this tool uniquely knows is the EDGES —
  // where a definition sits and who depends on it — so the mark is a filled
  // anchor node with three lines arriving. Reads distinctly from `search`
  // (grep's magnifier) and from `workspace-tree` at 16px.
  "code-index": (
    <>
      <circle cx="16.5" cy="12" r="3" fill="currentColor" stroke="none" />
      <circle cx="5" cy="5.5" r="1.6" />
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="5" cy="18.5" r="1.6" />
      <path d="M6.6 5.9L13.6 10.6" />
      <path d="M6.6 12h6.9" />
      <path d="M6.6 18.1l7-4.7" />
    </>
  ),

  "workspace-tree": (
    <>
      <circle cx="6.5" cy="6" r="2" />
      <path d="M6.5 8v10h3.5" />
      <path d="M6.5 12h3.5" />
      <circle cx="13" cy="12" r="1.6" />
      <circle cx="13" cy="18" r="1.6" />
      <circle cx="18.5" cy="6.5" r="0.9" fill="currentColor" stroke="none" opacity="0.4" />
    </>
  ),

  "process-stop": (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
      <path d="M7.5 9.5l3 2.5-3 2.5" />
      <path d="M14.5 10.5l4 4" />
      <path d="M18.5 10.5l-4 4" />
    </>
  ),

  /**
   * The user's own terminal, being read.
   *
   * A pane with a prompt caret inside it, and the caret sits BEHIND a magnifier
   * lens rather than beside one: the act is looking at a shell somebody else is
   * driving, not running something. Deliberately distinct from `terminal`
   * (`shell_execute`) so the transcript never blurs "the agent ran this" with
   * "the agent read what you ran".
   */
  "terminal-watch": (
    <>
      <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
      <path d="M6.5 9.5l2.5 2-2.5 2" />
      <path d="M11.5 13.5h3" />
      <circle cx="16.5" cy="15" r="3.6" />
      <path d="M19.2 17.6L21.5 20" />
    </>
  ),

  /**
   * Shell output collected from a process the agent started (`shell_read_output`).
   *
   * Deliberately NOT a terminal frame: the other two shell marks are about the
   * box (the agent runs a command / watches one of yours), and this one is about
   * what came OUT of it — printed lines and the pull to their end, which is
   * literally what the tool does. It also had to survive at 14px next to the
   * frame glyphs without reading as a third rectangle.
   */
  "shell-output": (
    <>
      <path d="M3.75 6h15.5" />
      <path d="M3.75 11h15.5" />
      <path d="M3.75 16h7.5" />
      <path d="M16.5 13v6.5" />
      <path d="M13.6 17l2.9 2.9 2.9-2.9" />
    </>
  ),

  "process-list": (
    <>
      <circle cx="5" cy="6.5" r="1" fill="currentColor" stroke="none" opacity="0.7" />
      <path d="M9 6.5h11" />
      <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" opacity="0.5" />
      <path d="M9 12h11" />
      <circle cx="5" cy="17.5" r="1" fill="currentColor" stroke="none" opacity="0.3" />
      <path d="M9 17.5h7" />
    </>
  ),

  diagnostics: (
    <>
      <path d="M8 3.5h5.5L18 8v10.5A1.5 1.5 0 0 1 16.5 20h-9A1.5 1.5 0 0 1 6 18.5v-13A1.5 1.5 0 0 1 7.5 4z" />
      <path d="M13.5 3.5V8H18" />
      <path d="M9 12h6" />
      <path d="M9 15h3" />
      <path d="M14.2 17l1.4 1.4 3-3" />
    </>
  ),

  /**
   * Searching the skill catalog (`aurora_skill_search`).
   *
   * The book is the skill mark everywhere else in this window — the `/` picker,
   * the transcript chip, Settings → Skills — so finding one is that same book
   * under a magnifier, exactly the relationship `terminal` → `terminal-watch`
   * already carries. The spine is dropped so the lens has room; at 14px a
   * second vertical line beside the circle turned into mush.
   */
  "skill-search": (
    <>
      <path d="M4.75 4.5h8a2 2 0 0 1 2 2v4.4" />
      <path d="M4.75 4.5A1.5 1.5 0 0 0 3.25 6v13a1.5 1.5 0 0 1 1.5-1.5h6" />
      <path d="M7.25 8.5h4.5" />
      <circle cx="16.6" cy="15.1" r="3.7" />
      <path d="M19.3 17.8l2.2 2.2" />
    </>
  ),

  "task-list": (
    <>
      <rect x="4" y="5" width="3" height="3" rx="0.7" />
      <path d="M10 6.5h10" />
      <rect x="4" y="10.5" width="3" height="3" rx="0.7" />
      <path d="M10 12h10" />
      <rect x="4" y="16" width="3" height="3" rx="0.7" />
      <path d="M10 17.5h7" />
    </>
  ),

  /**
   * The header task indicator's glyph.
   *
   * Distinct from `task-list` on purpose. That one is three empty boxes — it
   * says "a list exists". This one ticks its first row and shortens the last,
   * so at 13px it reads as PROGRESS THROUGH a list, which is the single thing
   * the header indicator is there to communicate.
   */
  checklist: (
    <>
      <path d="M3.6 6.4l1.6 1.6 3-3.2" />
      <path d="M11 6h9.4" />
      <path d="M3.6 12.6h4.2" />
      <path d="M11 12h9.4" />
      <path d="M3.6 18.2h4.2" />
      <path d="M11 18h6" />
    </>
  ),

  "browser-click": (
    <>
      <path d="M9.5 9.5l10 3.5-4.5 2-2 4.5z" />
      <path d="M14.8 14.8l3.7 3.7" />
      <path d="M9 5.5v-2" />
      <path d="M5.5 9h-2" />
      <path d="M6 6 4.5 4.5" />
    </>
  ),

  "browser-fill": (
    <>
      <rect x="3.5" y="7.5" width="17" height="10" rx="2" />
      <circle cx="7.5" cy="11" r="0.8" fill="currentColor" stroke="none" opacity="0.7" />
      <circle cx="11" cy="11" r="0.8" fill="currentColor" stroke="none" opacity="0.7" />
      <circle cx="14.5" cy="11" r="0.8" fill="currentColor" stroke="none" opacity="0.7" />
      <circle cx="17.5" cy="11" r="0.8" fill="currentColor" stroke="none" opacity="0.4" />
      <path d="M8 14.5h8" />
    </>
  ),

  "browser-scroll": (
    <>
      <path d="M12 4v16" opacity="0.5" />
      <path d="m8.5 7.5 3.5-3.5 3.5 3.5" />
      <path d="m8.5 16.5 3.5 3.5 3.5-3.5" />
      <circle cx="18.5" cy="12" r="0.9" fill="currentColor" stroke="none" opacity="0.4" />
    </>
  ),

  "browser-screenshot": (
    <>
      <path d="M3.5 8.5H7l2-3h6l2 3h3.5v10H3.5z" />
      <circle cx="12" cy="13" r="3.2" />
      <circle cx="12" cy="13" r="0.9" fill="currentColor" stroke="none" opacity="0.7" />
      <circle cx="18.2" cy="10.6" r="0.7" fill="currentColor" stroke="none" opacity="0.4" />
    </>
  ),

  /* The browser tools that act on the PAGE (click, fill, scroll, screenshot)
   * carry their own act above. These four are the ones that act on the BROWSER
   * — where it goes, what it types, how big it is, what it is built from — so
   * they share the chrome bar of a window frame and differ inside it. Eleven
   * browser tools reading as one generic globe made the transcript say
   * "something happened in the browser" and nothing more. */

  "browser-navigate": (
    <>
      <rect x="2.75" y="4.75" width="18.5" height="14.5" rx="2.5" />
      <path d="M2.75 9h18.5" />
      <path d="M8 14.5h6.5" />
      <path d="M12.4 12.1l2.4 2.4-2.4 2.4" />
    </>
  ),

  "browser-key": (
    <>
      <rect x="2.5" y="6.25" width="19" height="11.5" rx="2.4" />
      <circle cx="7" cy="10.6" r="0.85" fill="currentColor" stroke="none" />
      <circle cx="12" cy="10.6" r="0.85" fill="currentColor" stroke="none" />
      <circle cx="17" cy="10.6" r="0.85" fill="currentColor" stroke="none" />
      <path d="M8 14.4h8" />
    </>
  ),

  // Viewport — a desktop frame with a phone standing beside it: the tool sets
  // the device metrics, and two sizes side by side is what that means.
  "browser-viewport": (
    <>
      <rect x="2.5" y="5.5" width="12.5" height="12.5" rx="2.2" />
      <path d="M2.5 9h12.5" />
      <rect x="16.75" y="9.5" width="4.75" height="10.5" rx="1.6" />
    </>
  ),

  // Page structure — the outline / accessibility tree: an indented list read
  // out of the page rather than drawn on it.
  "browser-outline": (
    <>
      <rect x="2.75" y="4.75" width="18.5" height="14.5" rx="2.5" />
      <path d="M2.75 9h18.5" />
      <path d="M6.25 12.3h5" />
      <path d="M9.25 15.6h6.5" />
    </>
  ),

  // Layers — a stack of sheets: marks a grouped run of many tool calls.
  layers: (
    <>
      <path d="M12 3.5 20 7.5 12 11.5 4 7.5z" />
      <path d="M4.4 11.8 12 15.6l7.6-3.8" />
      <path d="M4.4 15.8 12 19.6l7.6-3.8" />
    </>
  ),

  // Send — a clean, centered upward arrow. Shaft and arrowhead share ONE apex at
  // (12,5.5); the head is a symmetric 45° chevron so it reads crisp at any size.
  send: (
    <>
      <path d="M12 19V5.5" />
      <path d="M6.5 11 12 5.5 17.5 11" />
    </>
  ),

  // Microphone — speech input.
  mic: (
    <>
      <rect x="9" y="3.25" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
      <path d="M12 17.5v3.25" />
      <path d="M8.75 20.75h6.5" />
    </>
  ),

  // Review — git-compare style: two nodes joined by branching arrows.
  review: (
    <>
      <circle cx="6.25" cy="6.25" r="2.4" />
      <circle cx="17.75" cy="17.75" r="2.4" />
      <path d="M6.25 8.65V13a4 4 0 0 0 4 4h3.6" />
      <path d="M12 15l2.4 2-2.4 2" fill="none" />
      <path d="M17.75 15.35V11a4 4 0 0 0-4-4h-3.6" />
      <path d="M12 5l-2.4 2 2.4 2" fill="none" />
    </>
  ),

  // Files — folder.
  files: (
    <path d="M3.5 7a1.5 1.5 0 0 1 1.5-1.5h3.7L11 7.7h7.5A1.5 1.5 0 0 1 20.5 9.2v8.3A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />
  ),

  // Browser — globe with meridians.
  browser: (
    <>
      <circle cx="12" cy="12" r="8.3" />
      <path d="M3.7 12h16.6" />
      <path d="M12 3.7c2.6 2.5 2.6 14.1 0 16.6" />
      <path d="M12 3.7c-2.6 2.5-2.6 14.1 0 16.6" />
    </>
  ),

  // Terminal — prompt caret and a command line.
  terminal: (
    <>
      <rect x="3.25" y="4.5" width="17.5" height="15" rx="2.6" />
      <path d="M7.5 9.5l3 3-3 3" />
      <path d="M13 15.5h4" />
    </>
  ),

  // Side chat — a foreground bubble with a second bubble peeking behind.
  "side-chat": (
    <>
      <path d="M3.75 8a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v3.5a2 2 0 0 1-2 2H8l-3.25 2.6V13.5a2 2 0 0 1-1-1.7z" />
      <path d="M9 5.7V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v3.5a2 2 0 0 1-2 2h-1" />
    </>
  ),

  // Close / dismiss.
  close: (
    <>
      <path d="M6.75 6.75l10.5 10.5" />
      <path d="M17.25 6.75L6.75 17.25" />
    </>
  ),

  // Check — selection mark (e.g. active model in the selector).
  check: <path d="M5 12.5l4.5 4.5L19 7" />,

  // Alert — a failed check. Triangle + bang, so failure reads without
  // relying on colour alone.
  alert: (
    <>
      <path d="M12 4.4L21 19.6H3z" />
      <path d="M12 10v4.2" />
      <path d="M12 17.1v.05" />
    </>
  ),

  // Copy — two stacked sheets (message bubble actions).
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2.2" />
      <path d="M5.5 15H5a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 5 4h8A1.5 1.5 0 0 1 14.5 5.5V6" />
    </>
  ),

  // Retry — clockwise refresh arrow (resend the last turn).
  retry: (
    <>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M19.7 4.5V9h-4.5" />
    </>
  ),

  // External — hand a file off to the IDE editor (open in new surface): a box
  // with an arrow leaving its top-right corner.
  external: (
    <>
      <path d="M14 4.75h5.25V10" />
      <path d="M19.25 4.75L11.5 12.5" />
      <path d="M18 13.5v4A1.75 1.75 0 0 1 16.25 19.25h-9.5A1.75 1.75 0 0 1 5 17.5v-9.5A1.75 1.75 0 0 1 6.75 6.25H11" />
    </>
  ),

  // Columns — side-by-side (split) diff layout.
  columns: (
    <>
      <rect x="3.5" y="4.75" width="17" height="14.5" rx="2.2" />
      <line x1="12" y1="4.75" x2="12" y2="19.25" />
    </>
  ),

  // Rows — stacked (unified) diff layout.
  rows: (
    <>
      <rect x="3.5" y="4.75" width="17" height="14.5" rx="2.2" />
      <line x1="3.5" y1="12" x2="20.5" y2="12" />
    </>
  ),

  // Inspect element — a pencil (pick / annotate a node on the page).
  inspect: (
    <>
      <path d="M14.4 6.1l3.5 3.5" />
      <path d="M16.1 4.4a1.9 1.9 0 0 1 2.7 0l0.8 0.8a1.9 1.9 0 0 1 0 2.7L8.2 18.9l-4.2 1 1-4.2z" />
    </>
  ),

  // Stop — a solid, perfectly centered rounded square (cancel an in-flight turn).
  stop: <rect x="7" y="7" width="10" height="10" rx="2.5" fill="currentColor" stroke="none" />,

  // Help — a question mark inside a speech bubble (the Questions prompt header).
  help: (
    <>
      <path d="M7 4h10a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3h-6l-4 3.2V15a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z" />
      <path d="M10.2 8.5a1.9 1.9 0 0 1 3.6.85c0 1.25-1.8 1.55-1.8 2.75" />
      <circle cx="12" cy="13.6" r="0.55" fill="currentColor" stroke="none" />
    </>
  ),

  // Settings — the canonical cog (notched ring + hub), drawn round for a soft feel.
  settings: (
    <>
      <path d="M12.22 2.75h-.44a1.85 1.85 0 0 0-1.85 1.85v.18a1.85 1.85 0 0 1-.93 1.6l-.5.29a1.85 1.85 0 0 1-1.85 0l-.15-.08a1.85 1.85 0 0 0-2.52.68l-.22.38a1.85 1.85 0 0 0 .68 2.52l.15.09a1.85 1.85 0 0 1 .92 1.6v.58a1.85 1.85 0 0 1-.92 1.6l-.15.09a1.85 1.85 0 0 0-.68 2.52l.22.38a1.85 1.85 0 0 0 2.52.68l.15-.08a1.85 1.85 0 0 1 1.85 0l.5.29a1.85 1.85 0 0 1 .93 1.6v.18A1.85 1.85 0 0 0 11.78 21.25h.44a1.85 1.85 0 0 0 1.85-1.85v-.18a1.85 1.85 0 0 1 .93-1.6l.5-.29a1.85 1.85 0 0 1 1.85 0l.15.08a1.85 1.85 0 0 0 2.52-.68l.22-.38a1.85 1.85 0 0 0-.68-2.52l-.15-.09a1.85 1.85 0 0 1-.92-1.6v-.58a1.85 1.85 0 0 1 .92-1.6l.15-.09a1.85 1.85 0 0 0 .68-2.52l-.22-.38a1.85 1.85 0 0 0-2.52-.68l-.15.08a1.85 1.85 0 0 1-1.85 0l-.5-.29a1.85 1.85 0 0 1-.93-1.6V4.6a1.85 1.85 0 0 0-1.85-1.85z" />
      <circle cx="12" cy="12" r="2.9" />
    </>
  ),

  // Providers — a stacked pair of servers, each with a status LED.
  providers: (
    <>
      <rect x="3.5" y="4.25" width="17" height="6.5" rx="1.9" />
      <rect x="3.5" y="13.25" width="17" height="6.5" rx="1.9" />
      <circle cx="7" cy="7.5" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="7" cy="16.5" r="0.7" fill="currentColor" stroke="none" />
    </>
  ),

  // Shield — approval / safety, with an inset check.
  shield: (
    <>
      <path d="M12 3 19 5.7v5.5c0 4.55-3 7.6-7 8.9-4-1.3-7-4.35-7-8.9V5.7z" />
      <path d="M9.1 11.9l2.1 2.1 3.7-3.9" />
    </>
  ),

  // Plug — external connection (MCP integrations).
  plug: (
    <>
      <path d="M9 2.75v3.75M15 2.75v3.75" />
      <path d="M6.75 6.5h10.5v3.25a5.25 5.25 0 0 1-10.5 0z" />
      <path d="M12 15v6.25" />
    </>
  ),

  // Sliders — execution / tuning (two tracks, offset knobs).
  sliders: (
    <>
      <line x1="4" y1="8.25" x2="20" y2="8.25" />
      <line x1="4" y1="15.75" x2="20" y2="15.75" />
      <circle cx="9" cy="8.25" r="2.4" fill="var(--agw-dock, #1c1c1f)" />
      <circle cx="15" cy="15.75" r="2.4" fill="var(--agw-dock, #1c1c1f)" />
    </>
  ),

  // Users — the agent team (two figures).
  users: (
    <>
      <circle cx="9" cy="8" r="3.1" />
      <path d="M3.4 19.5a5.6 5.6 0 0 1 11.2 0" />
      <path d="M16 5.2a3.1 3.1 0 0 1 0 5.9" />
      <path d="M17.2 13.4a5.6 5.6 0 0 1 3.4 6.1" />
    </>
  ),

  // Arrow-left — back to app.
  "arrow-left": (
    <>
      <path d="M19 12H5.25" />
      <path d="M11 5.75 4.75 12 11 18.25" />
    </>
  ),

  // Palette — theme / appearance.
  palette: (
    <>
      <path d="M12 3.5c-4.7 0-8.5 3.6-8.5 8 0 3.6 3 5.5 5.5 5.5.9 0 1.5-.7 1.5-1.5 0-.4-.2-.8-.4-1.1-.2-.3-.4-.6-.4-1 0-.8.7-1.4 1.5-1.4H13c3 0 5.5-2.2 5.5-5C18.5 6.4 15.6 3.5 12 3.5Z" />
      <circle cx="7.5" cy="11" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="16" cy="11" r="1" fill="currentColor" stroke="none" />
    </>
  ),

  // Upload — import / drop a file.
  upload: (
    <>
      <path d="M12 15.5V4.5" />
      <path d="M7.5 9 12 4.5 16.5 9" />
      <path d="M4.5 15.5v2.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-2.5" />
    </>
  ),

  // Download — export.
  download: (
    <>
      <path d="M12 4.5v11" />
      <path d="M7.5 11 12 15.5 16.5 11" />
      <path d="M4.5 15.5v2.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-2.5" />
    </>
  ),

  // Contrast — half-filled disc.
  contrast: (
    <>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 3.75a8.25 8.25 0 0 1 0 16.5Z" fill="currentColor" stroke="none" />
    </>
  ),

  // Type — typography / font.
  type: (
    <>
      <path d="M5 7V5.5h14V7" />
      <path d="M12 5.5v13" />
      <path d="M9.5 18.5h5" />
    </>
  ),

  // Reset — counter-clockwise rotate to defaults.
  reset: (
    <>
      <path d="M5 8.5a8 8 0 1 1-1.2 4.3" />
      <path d="M3.2 4.5v4.2h4.2" />
    </>
  ),

  // Book — skill playbook (global skills).
  book: (
    <>
      <path d="M5 4.5h9.5a2 2 0 0 1 2 2V19a1.5 1.5 0 0 0-1.5-1.5H5z" />
      <path d="M5 4.5A1.5 1.5 0 0 0 3.5 6v13A1.5 1.5 0 0 1 5 17.5" />
      <path d="M8 8.5h5.5" />
      <path d="M8 11.5h5.5" />
    </>
  ),

  // Plan mode — an OPEN book: two pages meeting at a single vertical centre
  // spine (no text lines). Distinct from `book` (the closed skill playbook).
  "book-open": (
    <>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H12v16H6.5A2.5 2.5 0 0 0 4 21z" />
      <path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H12v16h5.5A2.5 2.5 0 0 1 20 21z" />
    </>
  ),

  // Folder — project / workspace skills.
  folder: (
    <path d="M3.5 7a1.5 1.5 0 0 1 1.5-1.5h3.7L11 7.7h7.5A1.5 1.5 0 0 1 20.5 9.2v8.3A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />
  ),

  // Pin — thumbtack (pin a chat). Trapezoidal head + needle.
  pin: (
    <>
      <path d="M9.4 3.75h5.2l-.7 5.15 2.6 2.45v1.4H7.5v-1.4l2.6-2.45z" />
      <path d="M12 13.25v6.9" />
    </>
  ),

  // Archive — a lidded box with a pull slot (archive a chat).
  archive: (
    <>
      <rect x="3.5" y="4.25" width="17" height="4" rx="1.2" />
      <path d="M5 8.25v9.75A1.75 1.75 0 0 0 6.75 19.75h10.5A1.75 1.75 0 0 0 19 18V8.25" />
      <path d="M10 11.75h4" />
    </>
  ),

  // Trash — lidded can with two ribs (permanent delete in the archive view).
  trash: (
    <>
      <path d="M4 6.5h16" />
      <path d="M9.5 6.5V5a1.25 1.25 0 0 1 1.25-1.25h2.5A1.25 1.25 0 0 1 14.5 5v1.5" />
      <path d="M6.25 6.5l.85 12.05A1.6 1.6 0 0 0 8.7 20h6.6a1.6 1.6 0 0 0 1.6-1.45L17.75 6.5" />
      <path d="M10.25 10.5v5.5M13.75 10.5v5.5" />
    </>
  ),

  // Database — stacked cylinder (context window / tokens).
  database: (
    <>
      <ellipse cx="12" cy="5.5" rx="7" ry="2.75" />
      <path d="M5 5.5v13c0 1.52 3.13 2.75 7 2.75s7-1.23 7-2.75v-13" />
      <path d="M5 12c0 1.52 3.13 2.75 7 2.75s7-1.23 7-2.75" />
    </>
  ),

  // MCP — a hub node linked to three satellite nodes (connected tools /
  // protocol). Used for every `mcp_*` tool-call header.
  mcp: (
    <>
      <circle cx="12" cy="12" r="2.3" />
      <circle cx="6" cy="6" r="1.7" />
      <circle cx="18" cy="6" r="1.7" />
      <circle cx="12" cy="19" r="1.7" />
      <path d="M10.37 10.37 7.2 7.2" />
      <path d="M13.63 10.37 16.8 7.2" />
      <path d="M12 14.3v3" />
    </>
  ),

  // Sort — three descending lines with a down-arrow (change list ordering).
  sort: (
    <>
      <path d="M4 7h11" />
      <path d="M4 12h7.5" />
      <path d="M4 17h4.5" />
      <path d="M18 8.5v8.5" />
      <path d="M15.25 14.25 18 17l2.75-2.75" />
    </>
  ),

  // Eye — vision capability badge in the model row.
  eye: (
    <>
      <path d="M2.75 12S6.25 5.5 12 5.5 21.25 12 21.25 12 17.75 18.5 12 18.5 2.75 12 2.75 12z" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
};

export const AgentIcon: React.FC<AgentIconProps> = ({
  name,
  size = 16,
  strokeWidth = 1.8,
  className,
  style,
  title,
}) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flexShrink: 0, ...style }}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {GLYPHS[name]}
    </svg>
  );
};

export default AgentIcon;
