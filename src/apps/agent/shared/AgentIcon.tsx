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
 *   <AgentIcon name="home" solid />      // the selected state, where one exists
 *
 * The set is the BOLD OUTLINE family, picked 2026-10-23 from
 * Documents\aurora-icon-direction-designs.html (card 04) after a side-by-side
 * with Claude desktop showed the old set drawing 8–14px with a ~1px line.
 * Conventions for every glyph:
 *   • 24×24 viewBox, live area roughly 3–21
 *   • stroke = currentColor at 2 on the grid, fill = none
 *   • round caps + joins; containers use a 3 corner radius
 *   • few, large shapes — no interior detail that turns to mush at 14px
 *   • small solid accents (dots) opt into fill via `fill="currentColor"`
 *
 * `solid` — THE SELECTED STATE.
 *
 * Glyphs that can be the selected thing (a rail destination, a pinned chat)
 * carry a filled twin in `SOLID`. Inner detail (a door, a hub) is painted in
 * `--agw-icon-cut`, which the container sets to its own fill. A name without a
 * twin falls back to its outline.
 *
 * `data-part` — THE WORKING PART.
 *
 * A running tool card animates its own mark instead of a generic spinner (see
 * 33-tool-glyph-motion.css). A glyph declares which of its elements does the
 * work by tagging them, and the stylesheet owns the motion — geometry lives
 * here, timing lives there, and neither file has to know the other's details.
 *
 * The vocabulary is deliberately small; a new glyph picks from it rather than
 * inventing a movement:
 *
 *   nib       an implement that travels a short diagonal   (pencil, pen, cursor)
 *   line      a stroke that writes itself                  (a line of text, a URL)
 *   lens      a magnifier that sweeps across the mark      (search, read, watch)
 *   caret     a prompt caret that blinks                   (shells)
 *   pulse     an element that swells and settles           (+ , ✕ , a node, a pupil)
 *   flow      siblings that light in sequence              (edges, rows, dots)
 *   travel    a nudge along x                              (arrows pointing right)
 *   travel-y  a nudge along y                              (arrows pointing down)
 *   turn      a half-disc / meridian that turns             (globe, contrast)
 *
 * A glyph with nothing worth nominating is fine: it still gets the scan that
 * passes over every live mark, which is what carries un-tagged glyphs and every
 * MCP tool nobody drew for.
 */

import React from "react";

export type AgentIconName =
  | "alert"
  | "gauge"
  | "panel-left"
  | "panel-right"
  | "chevrons-left"
  | "chevron-down"
  | "chevron-right"
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
  | "pencil"
  | "file-move"
  | "file-delete"
  | "workspace-tree"
  | "code-index"
  | "shell-posix"
  | "shell-pwsh"
  | "shell-cmd"
  | "process-stop"
  | "process-list"
  | "terminal-watch"
  | "shell-output"
  | "diagnostics"
  | "task-list"
  | "checklist"
  | "skill-search"
  | "tool-search"
  | "web-page"
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
  | "wrap"
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
  | "agent-start"
  | "agent-message"
  | "agent-check"
  | "agent-stop"
  | "parent-message"
  | "report-submit"
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
  | "eye-off"
  | "at"
  | "slash"
  | "refine"
  | "facet"
  | "bolt"
  | "book-open"
  | "image"
  | "home"
  | "user"
  | "images"
  | "library"
  | "puzzle"
  | "cpu";

/**
 * Rendered size, as a CSS length that follows Appearance → Interface text size.
 *
 * `size` is the authored pixel size at 100%. Below 100% the glyph tracks the
 * scale exactly; above it, at HALF the rate. Both branches meet at 1, so an
 * untouched install renders the drawn px and nothing moves.
 *
 * The half-rate branch above 100% is the part that matters. Icons live inside
 * fixed-height controls (`.agw-icon-btn` is 28px, a rail row is 34px) that do
 * not grow with the text scale, and a glyph tracking the scale 1:1 fills them.
 */
function scaledLength(size: number): string {
  const drawn = drawnSize(size);
  const half = drawn / 2;
  return `min(calc(${drawn}px * var(--agw-ui-text-scale, 1)), calc(${half}px + ${half}px * var(--agw-ui-text-scale, 1)))`;
}

/**
 * Authored size → drawn size. Call sites were authored across seven sizes
 * (11–18px); the bold set draws at a few, one per place: 14 in rows and
 * inline marks, 16 for search and list glyphs, 18 in the composer, 20 on the
 * rail. Anything 20px or larger was already sized for its box and stays.
 */
function drawnSize(size: number): number {
  if (size <= 10) return size + 3;
  if (size < 14) return 14;
  if (size < 15) return 16;
  if (size < 18) return 18;
  if (size < 20) return 20;
  return size;
}

interface AgentIconProps {
  name: AgentIconName;
  /** Authored pixel size at 100% interface text size (width = height). Defaults to 16. */
  size?: number;
  /** Stroke weight on the 24-grid. Defaults to 2. */
  strokeWidth?: number;
  /** Draw the filled selected-state twin, when the glyph has one. */
  solid?: boolean;
  className?: string;
  style?: React.CSSProperties;
  /** Accessible label; when omitted the icon is decorative (aria-hidden). */
  title?: string;
  /**
   * Shapes to draw in place of this name's entry, on the SAME frame: 24-grid
   * viewBox, currentColor stroke, drawn size and text scaling. An opt-in tool
   * icon set (`components/tools/tool-icons/`) draws through here, so its marks
   * size, scale and animate (`data-part`) exactly like the set they replace.
   */
  glyph?: React.ReactNode;
}

// Shared outlines. A document is the most repeated shape in the set; drawing
// it once keeps every file glyph the same page.
const DOC = "M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z";
const DOC_FOLD = "M14 3v3.5A1.5 1.5 0 0 0 15.5 8H19";
// A document open on its lower right, so a second mark (lens, pencil, arrow)
// can sit in the corner without crossing the page.
const DOC_OPEN = "M10.5 21h-3A2.5 2.5 0 0 1 5 18.5v-13A2.5 2.5 0 0 1 7.5 3H14l5 5v2.5";
const BUBBLE = "M7 4h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-5.5L7 19.5V16a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z";
const FOLDER =
  "M3 7.5A2.5 2.5 0 0 1 5.5 5h3.4a2 2 0 0 1 1.4.6L11.7 7h6.8A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z";
const EYE = "M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z";
const HOUSE = "M4 10.4 12 4l8 6.4V19a1.2 1.2 0 0 1-1.2 1.2H5.2A1.2 1.2 0 0 1 4 19z";
const GEAR =
  "M9.41 5.39 L9.81 3.07 L14.19 3.07 L14.59 5.39 L16.43 6.45 L18.64 5.63 L20.83 9.43 L19.02 10.94 L19.02 13.06 L20.83 14.57 L18.64 18.37 L16.43 17.55 L14.59 18.61 L14.19 20.93 L9.81 20.93 L9.41 18.61 L7.57 17.55 L5.36 18.37 L3.17 14.57 L4.98 13.06 L4.98 10.94 L3.17 9.43 L5.36 5.63 L7.57 6.45Z";
const PUZZLE =
  "M9.5 4.5a2.5 2.5 0 0 1 5 0V6H18v3.5h-1.5a2.5 2.5 0 0 0 0 5H18V18h-3.5v-1.5a2.5 2.5 0 0 0-5 0V18H6v-3.5h1.5a2.5 2.5 0 0 0 0-5H6V6h3.5z";
const PIN_HEAD = "M9 3.5h6l-.8 5.3 3.3 3V14h-11v-2.2l3.3-3z";

/**
 * The detail drawn ON a filled twin (a door, a hub, a horizon) is painted in
 * the colour the mark sits on, not cut as a hole. Even-odd holes shrank by the
 * stroke on every side and the Images twin rendered as a white blob
 * (2026-10-23). A container that shows a solid mark sets `--agw-icon-cut` to
 * its own OPAQUE fill.
 */
const CUT = "var(--agw-icon-cut, var(--agw-canvas))";

/**
 * Filled twins for glyphs that can be the selected thing. Drawn with the same
 * stroke as the outline (so corners stay round) plus a fill; inner detail is
 * painted over it in `CUT`.
 *
 * Declared ABOVE the outline table on purpose: tool-glyph-motion.test.ts reads
 * every entry after that table's declaration as an outline, and a twin there
 * would overwrite its outline (the twins carry no `data-part`).
 */
const SOLID: Partial<Record<AgentIconName, React.ReactNode>> = {
  home: (
    <>
      <path d={HOUSE} />
      <rect x="9.9" y="14.2" width="4.2" height="7" rx="1" fill={CUT} stroke="none" />
    </>
  ),
  images: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <circle cx="9" cy="10" r="1.9" fill={CUT} stroke="none" />
      <path d="m5 16.6 4-3.4 3.4 2.9 2.6-2.1 4 3.1" stroke={CUT} fill="none" />
    </>
  ),
  // Each book keeps its own edge in CUT, or the three fill into one block.
  library: (
    <g stroke={CUT} strokeWidth={1.5}>
      <rect x="2.4" y="3.2" width="6.9" height="17.6" rx="2.2" />
      <rect x="9.6" y="3.2" width="6.9" height="17.6" rx="2.2" />
      <rect x="16.6" y="3.8" width="6" height="17.2" rx="2" transform="rotate(-12 19.6 12.4)" />
    </g>
  ),
  puzzle: <path d={PUZZLE} />,
  settings: (
    <>
      <path d={GEAR} />
      <circle cx="12" cy="12" r="2.8" fill={CUT} stroke="none" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20.5c.8-3.8 3.9-6 7.5-6s6.7 2.2 7.5 6z" />
    </>
  ),
  gauge: (
    <>
      <path d="M2.6 18.6a9.6 9.6 0 1 1 18.8 0z" />
      <path d="M12 14.5l3.8-4.3" stroke={CUT} />
      <circle cx="12" cy="14.5" r="1.5" fill={CUT} stroke="none" />
    </>
  ),
  cpu: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="3" />
      <rect x="10" y="10" width="4" height="4" rx="1" fill={CUT} stroke="none" />
      <path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3" />
    </>
  ),
  database: (
    <>
      <path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13" />
      <ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" />
      <path d="M5 8.6c1.6 1 4.1 1.6 7 1.6s5.4-.6 7-1.6M5 13.4c1.6 1 4.1 1.6 7 1.6s5.4-.6 7-1.6" stroke={CUT} fill="none" strokeWidth={1.6} />
    </>
  ),
  pin: (
    <>
      <path d={PIN_HEAD} />
      <path d="M12 14v6.5" />
    </>
  ),
};

/**
 * Glyph geometry. Each entry returns the inner SVG primitives; the wrapper
 * supplies the shared stroke/fill/cap defaults.
 */
const GLYPHS: Record<AgentIconName, React.ReactNode> = {
  // Layout — left panel with a sidebar column.
  "panel-left": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9.5 4.5v15" />
    </>
  ),

  // Layout — right panel (dock) with the column on the trailing edge.
  "panel-right": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M14.5 4.5v15" pathLength={1} data-part="line" />
    </>
  ),

  // Collapse rail — double chevron pointing left.
  "chevrons-left": (
    <>
      <path d="m11.5 7-5 5 5 5" />
      <path d="m18 7-5 5 5 5" />
    </>
  ),

  // Disclosure chevron.
  "chevron-down": <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />,
  // Breadcrumb separator.
  "chevron-right": <path d="m9.5 6.5 5.5 5.5-5.5 5.5" />,

  // Agent mode — a cut crystal: the outline and its crown line. Pairs with
  // `book` (Plan mode).
  facet: (
    <>
      <path d="M12 3 19 9.5 12 21 5 9.5z" />
      <path d="M5 9.5h14" />
      <path d="M12 9.5V21" />
    </>
  ),

  // Fast lane — a bolt with two streaks driving into it, cut on the same
  // angular grid as `facet` so the two sit together on the model pill.
  bolt: (
    <>
      <path d="M14 3 7 13.5h5L11 21l7-10.5h-5z" data-part="pulse" />
      <path d="M3.5 7H6" />
      <path d="M2.5 11H5" />
    </>
  ),

  // Refine / composer assists — a pen nib over its freshly written line.
  // Deliberately NOT a sparkle.
  refine: (
    <>
      <path d="M8 3.5h8l1.2 6L12 16 6.8 9.5z" />
      <path d="M12 7.5v4" />
      <path d="M5.5 20.5h13" />
    </>
  ),

  // New chat / add.
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),

  // Search.
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" data-part="lens" />
      <path d="m15.5 15.5 5 5" data-part="lens" />
    </>
  ),

  "zoom-in": (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 5 5" />
      <path d="M10.5 7.5v6M7.5 10.5h6" />
    </>
  ),

  "zoom-out": (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 5 5" />
      <path d="M7.5 10.5h6" />
    </>
  ),

  fit: (
    <>
      <path d="M8.5 4H5a1 1 0 0 0-1 1v3.5M15.5 4H19a1 1 0 0 1 1 1v3.5M8.5 20H5a1 1 0 0 1-1-1v-3.5M15.5 20H19a1 1 0 0 0 1-1v-3.5" />
      <rect x="8.5" y="8.5" width="7" height="7" rx="1.5" />
    </>
  ),

  // Conversation bubble — rounded with a bottom-left tail.
  message: <path d={BUBBLE} />,

  // Chat / thread glyph — TURNS, not a bubble: a long bar aligned left and a
  // short one aligned right, this app's own transcript shape in two strokes.
  // Heavier than the set (3 vs 2) because it has no contour to carry weight.
  chat: (
    <>
      <path d="M4.5 8.5h12.5" strokeWidth={3} />
      <path d="M13 15.5h6.5" strokeWidth={3} />
    </>
  ),

  // Overflow actions — three dots.
  more: (
    <>
      <circle cx="5" cy="12" r="1.8" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.8" fill="currentColor" stroke="none" />
    </>
  ),

  // design_guidelines / canvas_guidelines — an artboard with two guides that
  // run past its edges, set off-centre: the rules a surface snaps to.
  "design-guidelines": (
    <>
      <rect x="5" y="5" width="14" height="14" rx="2" />
      <path d="M14 2.5v19" data-part="travel" />
      <path d="M2.5 9.5h19" data-part="travel-y" />
    </>
  ),

  // File diff chip — the page with a change marker.
  diff: (
    <>
      <path d={DOC} />
      <path d={DOC_FOLD} />
      <path d="M9.5 14h5" data-part="pulse" />
      <path d="M12 11.5v5" data-part="pulse" />
    </>
  ),

  // file_read — the page under a lens.
  "file-read": (
    <>
      <path d={DOC_OPEN} />
      <path d={DOC_FOLD} />
      <path d="M8.5 12h3.5" pathLength={1} data-part="line" />
      <circle cx="16" cy="16" r="3.2" data-part="lens" />
      <path d="m18.5 18.5 2.5 2.5" data-part="lens" />
    </>
  ),

  // file_write — the page with a plus: create or overwrite.
  "file-write": (
    <>
      <path d={DOC} />
      <path d={DOC_FOLD} />
      <path d="M12 11v6" data-part="pulse" />
      <path d="M9 14h6" data-part="pulse" />
    </>
  ),

  // file_edit — the page with a pencil in its corner: a surgical edit.
  "file-edit": (
    <>
      <path d={DOC_OPEN} />
      <path d={DOC_FOLD} />
      <path d="M8.5 12h3" pathLength={1} data-part="line" />
      <path d="m17 13 2.5 2.5L14 21h-2.5v-2.5z" data-part="nib" />
    </>
  ),

  // pencil — the bare tool, for editing a value already on screen.
  pencil: (
    <>
      <path d="M15.5 4.5a2.1 2.1 0 0 1 3 0l1 1a2.1 2.1 0 0 1 0 3L9 19l-4.5 1 1-4.5z" />
      <path d="m14 6 4 4" data-part="nib" />
    </>
  ),

  // file_move — the page with an arrow leaving its corner.
  "file-move": (
    <>
      <path d={DOC_OPEN} />
      <path d={DOC_FOLD} />
      <path d="M12.5 16.5h7" pathLength={1} data-part="line" />
      <path d="m17 13.5 3 3-3 3" data-part="travel" />
    </>
  ),

  // file_delete — the page with an X.
  "file-delete": (
    <>
      <path d={DOC} />
      <path d={DOC_FOLD} />
      <path d="m10 12.5 4 4" data-part="pulse" />
      <path d="m14 12.5-4 4" data-part="pulse" />
    </>
  ),

  // The `code` tool — one symbol and the things that reach it: a filled anchor
  // node with three edges arriving. Deliberately NOT angle brackets.
  "code-index": (
    <>
      <circle cx="16.5" cy="12" r="3.2" fill="currentColor" stroke="none" data-part="pulse" />
      <circle cx="5" cy="5.5" r="1.8" />
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="5" cy="18.5" r="1.8" />
      <path d="m6.8 6.6 6.6 4" data-part="flow" />
      <path d="M7 12h6" data-part="flow" />
      <path d="m6.8 17.4 6.6-4" data-part="flow" />
    </>
  ),

  // ── Shell family marks ──────────────────────────────────────────────
  // The fallback for the shell badge when the icon pack has no mark for a
  // family. Real silhouettes, monochrome.
  //
  // POSIX: a terminal window with a prompt caret and a command line.
  "shell-posix": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="m7.5 9.5 3 2.5-3 2.5" />
      <path d="M13 15h4" />
    </>
  ),
  // PowerShell: a leaning parallelogram holding a chevron and an underscore,
  // the frame at half opacity so the chevron reads first.
  "shell-pwsh": (
    <>
      <path d="M5.5 4.5H21l-3.5 15H2z" opacity="0.5" />
      <path d="m8 8.5 5.5 3.5L8 15.5" />
      <path d="M13.5 16h4" />
    </>
  ),
  // cmd: the Windows console window, told apart by its title bar.
  "shell-cmd": (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M3 8.5h18" />
      <path d="m7.5 12.5 2.5 2-2.5 2" />
    </>
  ),

  "workspace-tree": (
    <>
      <circle cx="6.5" cy="6" r="2.2" />
      <path d="M6.5 8.2V18h4" />
      <path d="M6.5 12h4" />
      <circle cx="13.5" cy="12" r="1.8" data-part="flow" />
      <circle cx="13.5" cy="18" r="1.8" data-part="flow" />
      <circle cx="19" cy="6" r="1" fill="currentColor" stroke="none" opacity="0.4" />
    </>
  ),

  "process-stop": (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="3" />
      <path d="m7 9.5 3 2.5-3 2.5" data-part="caret" />
      <path d="m14 10 4 4" data-part="pulse" />
      <path d="m18 10-4 4" data-part="pulse" />
    </>
  ),

  /**
   * The user's own terminal, being read: a pane whose prompt caret sits behind
   * a lens. Deliberately distinct from `terminal` (`shell_execute`) so the
   * transcript never blurs "the agent ran this" with "the agent read what you
   * ran".
   */
  "terminal-watch": (
    <>
      <rect x="2.5" y="4" width="19" height="16" rx="3" />
      <path d="m6.5 9.5 2.5 2-2.5 2" data-part="caret" />
      <path d="M11.5 13.5h1.5" pathLength={1} data-part="line" />
      <circle cx="16.5" cy="15" r="3.4" data-part="lens" />
      <path d="m19 17.5 2.5 2.5" data-part="lens" />
    </>
  ),

  /**
   * Shell output collected from a process the agent started
   * (`shell_read_output`). Not a frame: printed lines and the pull to their end.
   */
  "shell-output": (
    <>
      <path d="M4 6h16" />
      <path d="M4 11h16" />
      <path d="M4 16h7" pathLength={1} data-part="line" />
      <path d="M16.5 13v7" />
      <path d="m13.5 17 3 3 3-3" data-part="travel-y" />
    </>
  ),

  "process-list": (
    <>
      <circle cx="5" cy="6.5" r="1.2" fill="currentColor" stroke="none" opacity="0.7" />
      <path d="M9 6.5h11" data-part="flow" />
      <circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" opacity="0.5" />
      <path d="M9 12h11" data-part="flow" />
      <circle cx="5" cy="17.5" r="1.2" fill="currentColor" stroke="none" opacity="0.3" />
      <path d="M9 17.5h7" data-part="flow" />
    </>
  ),

  diagnostics: (
    <>
      <path d={DOC} />
      <path d={DOC_FOLD} />
      <path d="M9 12h6" />
      <path d="M9 15.5h3" pathLength={1} data-part="line" />
      <path d="m14 17.5 1.5 1.5 3-3" pathLength={1} data-part="tick" />
    </>
  ),

  /**
   * Searching the skill catalog (`aurora_skill_search`): the skill book under
   * a lens, the same relationship `terminal` → `terminal-watch` carries.
   */
  "skill-search": (
    <>
      <path d="M5 4.5h8a2 2 0 0 1 2 2v4" />
      <path d="M5 4.5A1.5 1.5 0 0 0 3.5 6v13A1.5 1.5 0 0 1 5 17.5h5.5" />
      <path d="M7.5 8.5h4" pathLength={1} data-part="line" />
      <circle cx="16.5" cy="15.5" r="3.5" data-part="lens" />
      <path d="m19 18 2.5 2.5" data-part="lens" />
    </>
  ),

  /**
   * Searching the deferred tool roster (`tool_search`): the layer stack under
   * the same lens as `skill-search`, so the pair reads as siblings.
   */
  "tool-search": (
    <>
      <path d="M10 3.5 16.5 7 10 10.5 3.5 7z" />
      <path d="m4 11 6 3 3-1.5" pathLength={1} data-part="line" />
      <circle cx="16.5" cy="15.5" r="3.5" data-part="lens" />
      <path d="m19 18 2.5 2.5" data-part="lens" />
    </>
  ),

  // A page fetched off the web — a sheet carrying `browser`'s meridian.
  "web-page": (
    <>
      <rect x="4.5" y="3.5" width="15" height="17" rx="2.5" />
      <path d="M4.5 9h15" />
      <path d="M12 9c-2 2.5-2 8.5 0 11.5" data-part="turn" />
      <path d="M12 9c2 2.5 2 8.5 0 11.5" data-part="turn-b" />
    </>
  ),

  "task-list": (
    <>
      <rect x="3.5" y="4.5" width="4" height="4" rx="1" data-part="flow" />
      <path d="M11 6.5h9.5" />
      <rect x="3.5" y="10" width="4" height="4" rx="1" data-part="flow" />
      <path d="M11 12h9.5" />
      <rect x="3.5" y="15.5" width="4" height="4" rx="1" data-part="flow" />
      <path d="M11 17.5h6" />
    </>
  ),

  /**
   * The header task indicator's glyph: the first row ticked, the last one
   * short, so it reads as PROGRESS THROUGH a list rather than a list.
   */
  checklist: (
    <>
      <path d="m3.5 6.5 1.8 1.8 3.2-3.5" pathLength={1} data-part="tick" />
      <path d="M11.5 6.5h9" />
      <path d="M4 12.5h4" pathLength={1} data-part="line" />
      <path d="M11.5 12.5h9" />
      <path d="M4 18.5h4" />
      <path d="M11.5 18.5h6" pathLength={1} data-part="line" />
    </>
  ),

  "browser-click": (
    <>
      <path d="m9 9 11 3.8-4.8 1.9-1.9 4.8z" data-part="nib" />
      <path d="m15.2 15.2 3.8 3.8" data-part="nib" />
      <path d="M9 5V3" data-part="pulse" />
      <path d="M5 9H3" data-part="pulse" />
      <path d="M6.2 6.2 4.8 4.8" data-part="pulse" />
    </>
  ),

  "browser-fill": (
    <>
      <rect x="3" y="6.5" width="18" height="11" rx="3" />
      <circle cx="7.5" cy="10.5" r="1" fill="currentColor" stroke="none" opacity="0.7" />
      <circle cx="11" cy="10.5" r="1" fill="currentColor" stroke="none" opacity="0.7" />
      <circle cx="14.5" cy="10.5" r="1" fill="currentColor" stroke="none" opacity="0.7" />
      <path d="M8 14h8" pathLength={1} data-part="line" />
    </>
  ),

  "browser-scroll": (
    <>
      <path d="M12 4.5v15" opacity="0.5" />
      <path d="m8.5 8 3.5-3.5L15.5 8" data-part="travel-y" />
      <path d="m8.5 16 3.5 3.5 3.5-3.5" data-part="travel-y" />
      <circle cx="18.5" cy="12" r="1" fill="currentColor" stroke="none" opacity="0.4" />
    </>
  ),

  "browser-screenshot": (
    <>
      <path d="M3 9a2 2 0 0 1 2-2h2l1.5-2.5h7L17 7h2a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <circle cx="12" cy="13" r="3.2" data-part="pulse" />
      <circle cx="18" cy="10.2" r="0.9" fill="currentColor" stroke="none" opacity="0.5" />
    </>
  ),

  /* The browser tools that act on the PAGE (click, fill, scroll, screenshot)
   * carry their own act above. These four act on the BROWSER — where it goes,
   * what it types, how big it is, what it is built from — so they share the
   * chrome bar of a window frame and differ inside it. */

  "browser-navigate": (
    <>
      <rect x="2.5" y="4.5" width="19" height="15" rx="3" />
      <path d="M2.5 9h19" />
      <path d="M7.5 14.5h7" pathLength={1} data-part="line" />
      <path d="m12.5 12 2.5 2.5-2.5 2.5" data-part="travel" />
    </>
  ),

  "browser-key": (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="3" />
      <circle cx="7" cy="10.5" r="1.1" fill="currentColor" stroke="none" data-part="flow" />
      <circle cx="12" cy="10.5" r="1.1" fill="currentColor" stroke="none" data-part="flow" />
      <circle cx="17" cy="10.5" r="1.1" fill="currentColor" stroke="none" data-part="flow" />
      <path d="M8 14.5h8" pathLength={1} data-part="line" />
    </>
  ),

  // Viewport — a desktop frame with a phone standing beside it.
  "browser-viewport": (
    <>
      <rect x="2.5" y="5" width="12.5" height="13" rx="2.5" />
      <path d="M2.5 9H15" />
      <rect x="17" y="9" width="4.5" height="11" rx="1.5" data-part="pulse" />
    </>
  ),

  // Page structure — the outline / accessibility tree read out of the page.
  "browser-outline": (
    <>
      <rect x="2.5" y="4.5" width="19" height="15" rx="3" />
      <path d="M2.5 9h19" />
      <path d="M6.5 12.5h5" data-part="flow" />
      <path d="M9.5 16h6" data-part="flow" />
    </>
  ),

  // Layers — a stack of sheets: marks a grouped run of many tool calls.
  layers: (
    <>
      <path d="M12 3.5 20.5 8 12 12.5 3.5 8z" />
      <path d="m3.5 12 8.5 4.5 8.5-4.5" />
      <path d="m3.5 16 8.5 4.5 8.5-4.5" />
    </>
  ),

  // Send — an upward arrow; shaft and head share one apex.
  send: (
    <>
      <path d="M12 19V5" />
      <path d="M5.5 11.5 12 5l6.5 6.5" />
    </>
  ),

  // Microphone — speech input.
  mic: (
    <>
      <rect x="8.5" y="3" width="7" height="11.5" rx="3.5" />
      <path d="M5 11.5a7 7 0 0 0 14 0" />
      <path d="M12 18.5V21" />
    </>
  ),

  // Review — git-compare style: two nodes joined by branching arrows.
  review: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5V13a4 4 0 0 0 4 4h4" />
      <path d="m12 15 2.5 2-2.5 2" />
      <path d="M18 15.5V11a4 4 0 0 0-4-4h-4" />
      <path d="m12 5-2.5 2 2.5 2" />
    </>
  ),

  // Files — folder.
  files: <path d={FOLDER} />,

  // Browser — globe with meridians.
  browser: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5c2.7 2.6 2.7 14.4 0 17" data-part="turn" />
      <path d="M12 3.5c-2.7 2.6-2.7 14.4 0 17" data-part="turn-b" />
    </>
  ),

  // Terminal — prompt caret and a command line.
  terminal: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="3" />
      <path d="m7.5 9.5 3 2.5-3 2.5" data-part="caret" />
      <path d="M13 15h4" pathLength={1} data-part="line" />
    </>
  ),

  // Side chat — a foreground bubble with a second one peeking behind.
  "side-chat": (
    <>
      <path d="M3.5 9a2.5 2.5 0 0 1 2.5-2.5h6.5A2.5 2.5 0 0 1 15 9v3a2.5 2.5 0 0 1-2.5 2.5H8.5L5 17.5v-3.3A2.5 2.5 0 0 1 3.5 12z" />
      <path d="M9 4.5A2 2 0 0 1 11 3h7a2.5 2.5 0 0 1 2.5 2.5v3A2.5 2.5 0 0 1 18 11h-.5" />
    </>
  ),

  // Close / dismiss.
  close: (
    <>
      <path d="m6.5 6.5 11 11" />
      <path d="m17.5 6.5-11 11" />
    </>
  ),

  // Check — selection mark (e.g. active model in the selector).
  check: <path d="m4.5 12.5 5 5 10-10.5" />,

  // Alert — a failed check. Triangle + bang, so failure reads without
  // relying on colour alone.
  alert: (
    <>
      <path d="M10.3 4.6a2 2 0 0 1 3.4 0l7.4 13a2 2 0 0 1-1.7 3H4.6a2 2 0 0 1-1.7-3z" />
      <path d="M12 10v4" data-part="pulse" />
      <path d="M12 17.3v.1" data-part="pulse" />
    </>
  ),

  // Copy — two stacked sheets.
  copy: (
    <>
      <rect x="8.5" y="8.5" width="12" height="12" rx="2.5" />
      <path d="M15.5 8.5V6A2.5 2.5 0 0 0 13 3.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5" />
    </>
  ),

  // Wrap — a line that runs to the margin and turns back under itself.
  wrap: (
    <>
      <path d="M4 7h10a3.5 3.5 0 0 1 0 7H8" />
      <path d="m10.5 11.5-2.5 2.5 2.5 2.5" />
      <path d="M20.5 5v14" />
    </>
  ),

  // Retry — clockwise refresh arrow.
  retry: (
    <>
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20 4v4.5h-4.5" />
    </>
  ),

  // External — a box with an arrow leaving its top-right corner.
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4 11.5 12.5" />
      <path d="M18 14v3.5a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 4 17.5v-9A2.5 2.5 0 0 1 6.5 6H10" />
    </>
  ),

  // Columns — side-by-side (split) diff layout.
  columns: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="3" />
      <path d="M12 4.5v15" />
    </>
  ),

  // Rows — stacked (unified) diff layout.
  rows: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="3" />
      <path d="M3 12h18" />
    </>
  ),

  // Inspect element — a pencil picking a node on the page.
  inspect: (
    <>
      <path d="m14.5 6 3.5 3.5" data-part="nib" />
      <path
        d="M16 4.5a2.1 2.1 0 0 1 3 0l.5.5a2.1 2.1 0 0 1 0 3L8.5 19l-4.5 1 1-4.5z"
        data-part="nib"
      />
    </>
  ),

  // Stop — a solid, centred rounded square.
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="currentColor" stroke="none" />,

  // Help — a question mark inside a speech bubble.
  help: (
    <>
      <path d={BUBBLE} />
      <path d="M10 8.6a2 2 0 0 1 3.9.6c0 1.3-1.9 1.6-1.9 2.8" pathLength={1} data-part="line" />
      <circle cx="12" cy="14" r="1" fill="currentColor" stroke="none" data-part="pulse" />
    </>
  ),

  // Settings — a six-tooth cog and its hub.
  settings: (
    <>
      <path d={GEAR} />
      <circle cx="12" cy="12" r="3" />
    </>
  ),

  // Providers — a stacked pair of servers, each with a status LED.
  providers: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="2.5" />
      <rect x="3" y="13" width="18" height="7" rx="2.5" />
      <circle cx="7" cy="7.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="7" cy="16.5" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),

  // Shield — approval / safety, with an inset check.
  shield: (
    <>
      <path d="M12 3 19.5 6v5.5c0 4.6-3.1 7.9-7.5 9.5-4.4-1.6-7.5-4.9-7.5-9.5V6z" />
      <path d="m9 12 2.2 2.2 4-4.2" />
    </>
  ),

  // Plug — external connection (MCP integrations).
  plug: (
    <>
      <path d="M9 3v4M15 3v4" />
      <path d="M6.5 7h11v3.5a5.5 5.5 0 0 1-11 0z" />
      <path d="M12 16v5" />
    </>
  ),

  // Sliders — execution / tuning (two tracks, offset knobs).
  sliders: (
    <>
      <path d="M3.5 8h17" />
      <path d="M3.5 16h17" />
      <circle cx="9" cy="8" r="2.6" fill="var(--agw-dock, #1c1c1f)" />
      <circle cx="15" cy="16" r="2.6" fill="var(--agw-dock, #1c1c1f)" />
    </>
  ),

  // Users — two figures.
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20a6 6 0 0 1 12 0" />
      <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8" />
      <path d="M17.5 14a6 6 0 0 1 3.5 6" />
    </>
  ),

  // ── The sub-agent family ────────────────────────────────────────────────
  // Each is one figure of `users` plus the one act the tool does, the
  // subject-plus-act pairing the set already uses for skill-search.

  // spawn_agent — a person and a plus: someone new joins the work.
  "agent-start": (
    <>
      <circle cx="9.5" cy="8" r="3.5" />
      <path d="M3.5 20a6 6 0 0 1 12 0" />
      <path d="M18.5 4.5v6" data-part="pulse" />
      <path d="M15.5 7.5h6" data-part="pulse" />
    </>
  ),

  // send_message — an arrow arriving at the person.
  "agent-message": (
    <>
      <circle cx="8.5" cy="8" r="3.5" />
      <path d="M2.5 20a6 6 0 0 1 12 0" />
      <path d="M21.5 12.5H15" data-part="travel" />
      <path d="m18 9.5-3 3 3 3" data-part="travel" />
    </>
  ),

  // get_task_output — the person under a lens.
  "agent-check": (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20a6 6 0 0 1 9.5-4.9" />
      <circle cx="17" cy="16" r="3" data-part="lens" />
      <path d="m19.2 18.2 2.3 2.3" data-part="lens" />
    </>
  ),

  // stop_agent — the person and a stop square.
  "agent-stop": (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20a6 6 0 0 1 9.5-4.9" />
      <rect x="14.5" y="13.5" width="7" height="7" rx="1.8" data-part="pulse" />
    </>
  ),

  // message_parent — the child's side: an arrow going up to the person who
  // started it.
  "parent-message": (
    <>
      <circle cx="15" cy="8" r="3.5" />
      <path d="M9 20a6 6 0 0 1 12 0" />
      <path d="M5 20.5V10" data-part="travel-y" />
      <path d="m2.2 12.8 2.8-2.8 2.8 2.8" data-part="travel-y" />
    </>
  ),

  // submit_report — a page with a tick: the work, handed in.
  "report-submit": (
    <>
      <path d={DOC} />
      <path d={DOC_FOLD} />
      <path d="m9 14.5 2.2 2.2 4.3-4.5" pathLength={1} data-part="tick" />
    </>
  ),

  // Arrow-left — back to app.
  "arrow-left": (
    <>
      <path d="M19.5 12h-14" />
      <path d="m11 5.5-6.5 6.5 6.5 6.5" />
    </>
  ),

  // Palette — theme / appearance.
  palette: (
    <>
      <path d="M12 3.5c-4.7 0-8.5 3.6-8.5 8 0 3.6 3 5.5 5.5 5.5.9 0 1.5-.7 1.5-1.5 0-.4-.2-.8-.4-1.1-.2-.3-.4-.6-.4-1 0-.8.7-1.4 1.5-1.4H13c3 0 5.5-2.2 5.5-5C18.5 6.4 15.6 3.5 12 3.5Z" />
      <circle cx="7.5" cy="11" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="7.8" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="16" cy="11" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),

  // Upload — import / drop a file.
  upload: (
    <>
      <path d="M12 15V4" />
      <path d="M7.5 8.5 12 4l4.5 4.5" />
      <path d="M4 15v3a2.5 2.5 0 0 0 2.5 2.5h11A2.5 2.5 0 0 0 20 18v-3" />
    </>
  ),

  // Download — export.
  download: (
    <>
      <path d="M12 4v11" />
      <path d="M7.5 10.5 12 15l4.5-4.5" />
      <path d="M4 15v3a2.5 2.5 0 0 0 2.5 2.5h11A2.5 2.5 0 0 0 20 18v-3" />
    </>
  ),

  // Contrast — half-filled disc.
  contrast: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" stroke="none" data-part="turn" />
    </>
  ),

  // Type — typography / font.
  type: (
    <>
      <path d="M5 7.5V5h14v2.5" />
      <path d="M12 5v14" />
      <path d="M9 19h6" />
    </>
  ),

  // Reset — counter-clockwise rotate to defaults.
  reset: (
    <>
      <path d="M5 8.5a8 8 0 1 1-1 4" />
      <path d="M3.5 4v4.5H8" />
    </>
  ),

  // Book — skill playbook (global skills).
  book: (
    <>
      <path d="M4.5 18.5v-13a2 2 0 0 1 2-2h12v14h-12a2 2 0 0 0 0 4h12" />
      <path d="M8.5 7.5h6" pathLength={1} data-part="line" />
      <path d="M8.5 11h6" pathLength={1} data-part="line" />
    </>
  ),

  // A picture — the frame, a horizon of two hills, and a sun. The sun is the
  // part that works: it swells while the picture is being made.
  image: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="3" />
      <path d="m3.5 16.5 5-4.5 4 3.5 3-2.5 5 4" />
      <circle cx="15.5" cy="9" r="1.8" data-part="pulse" />
    </>
  ),

  // Home — the icon rail's first cell: a house with its door.
  home: (
    <>
      <path d={HOUSE} />
      <path d="M9.6 20.2v-5.4h4.8v5.4" />
    </>
  ),

  // User — one person: the account cell at the foot of the icon rail.
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20.5c.8-3.8 3.9-6 7.5-6s6.7 2.2 7.5 6" />
    </>
  ),

  // Images — the rail's Images page: a framed picture, the sun at the left so
  // it reads apart from the `image` tool glyph.
  images: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m3.5 16.5 5-4.3 3.8 3.3 2.9-2.4 5.3 4.2" />
    </>
  ),

  // Library — two books on a shelf and a third leaning on them.
  library: (
    <>
      <rect x="3.5" y="4" width="5" height="16" rx="1.6" />
      <rect x="10.5" y="4" width="5" height="16" rx="1.6" />
      <rect x="17.2" y="4.6" width="4.4" height="15.6" rx="1.5" transform="rotate(-12 19.4 12.4)" />
    </>
  ),

  // Gauge — the machine the engine runs on (web version): how loaded it is.
  gauge: (
    <>
      <path d="M3.6 18.5a9 9 0 1 1 16.8 0" />
      <path d="M12 14.5l3.8-4.3" />
      <circle cx="12" cy="14.5" r="1.4" />
    </>
  ),

  // CPU — the Providers page: the engines that run the models.
  cpu: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="3" />
      {/* The die: what pulses on a running `list_models` row. */}
      <rect x="10" y="10" width="4" height="4" rx="1" data-part="pulse" />
      <path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3" />
    </>
  ),

  // Puzzle — the Plugins page: things that fit into the agent.
  puzzle: <path d={PUZZLE} />,

  // Plan mode — an OPEN book: two pages meeting at a centre spine.
  "book-open": (
    <>
      <path d="M3.5 5.5A1.5 1.5 0 0 1 5 4h4a3 3 0 0 1 3 3v13a2.5 2.5 0 0 0-2.5-2.5H5A1.5 1.5 0 0 1 3.5 16z" />
      <path d="M20.5 5.5A1.5 1.5 0 0 0 19 4h-4a3 3 0 0 0-3 3v13a2.5 2.5 0 0 1 2.5-2.5H19a1.5 1.5 0 0 0 1.5-1.5z" />
    </>
  ),

  // Folder — project / workspace skills.
  folder: <path d={FOLDER} />,

  // Pin — thumbtack (pin a chat). Trapezoidal head + needle.
  pin: (
    <>
      <path d={PIN_HEAD} />
      <path d="M12 14v6.5" />
    </>
  ),

  // Archive — a lidded box with a pull slot.
  archive: (
    <>
      <rect x="3" y="4" width="18" height="4.5" rx="1.5" />
      <path d="M4.5 8.5V18A2.5 2.5 0 0 0 7 20.5h10a2.5 2.5 0 0 0 2.5-2.5V8.5" />
      <path d="M10 12.5h4" />
    </>
  ),

  // Trash — lidded can with two ribs.
  trash: (
    <>
      <path d="M4 6.5h16" />
      <path d="M9 6.5V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v1.5" />
      <path d="m6 6.5.9 12.1A2 2 0 0 0 8.9 20.5h6.2a2 2 0 0 0 2-1.9L18 6.5" />
      <path d="M10 11v5M14 11v5" />
    </>
  ),

  // Database — stacked cylinder (context window / tokens, Memory).
  database: (
    <>
      <ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" />
      <path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13" />
      <path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8" />
    </>
  ),

  // MCP — a hub node linked to three satellites. Every `mcp_*` tool header.
  mcp: (
    <>
      <circle cx="12" cy="12" r="2.6" data-part="pulse" />
      <circle cx="5.5" cy="5.5" r="2" />
      <circle cx="18.5" cy="5.5" r="2" />
      <circle cx="12" cy="19.5" r="2" />
      <path d="M10.1 10.1 7 7" data-part="flow" />
      <path d="M13.9 10.1 17 7" data-part="flow" />
      <path d="M12 14.6v2.9" data-part="flow" />
    </>
  ),

  // Sort — three descending lines with a down-arrow.
  sort: (
    <>
      <path d="M4 7h11" />
      <path d="M4 12h7.5" />
      <path d="M4 17h4.5" />
      <path d="M18 6v11.5" />
      <path d="m15 14.5 3 3 3-3" />
    </>
  ),

  // Eye — vision capability, and "reveal" on the API key field.
  eye: (
    <>
      <path d={EYE} />
      <circle cx="12" cy="12" r="2.8" data-part="pulse" />
    </>
  ),

  // Eye with a rule through it — "hide". The SAME outline and pupil as `eye`
  // plus one stroke, so the pair reads as one control changing state.
  "eye-off": (
    <>
      <path d={EYE} />
      <circle cx="12" cy="12" r="2.8" />
      <path d="M4 20 20 4" />
    </>
  ),

  // The two composer TRIGGER CHARACTERS, drawn as themselves: the `+` menu's
  // Mention and Actions rows type `@` and `/`, so the glyph is the character.
  at: (
    <>
      <circle cx="12" cy="12" r="3.8" />
      <path d="M15.8 8.2v5.1a2.8 2.8 0 0 0 5.6 0v-1.3A9.5 9.5 0 1 0 17.8 19.5" />
    </>
  ),
  slash: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
      <path d="m14 7.5-4 9" />
    </>
  ),
};

export const AgentIcon: React.FC<AgentIconProps> = ({
  name,
  size = 16,
  strokeWidth = 2,
  solid,
  className,
  style,
  title,
  glyph,
}) => {
  const solidGlyph = solid && !glyph ? SOLID[name] : undefined;
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
      // The width/height ATTRIBUTES above stay as the authored px so the glyph
      // has a correct intrinsic size before styles resolve; these override them
      // with the drawn, scaled length. Caller style still wins, so a component
      // that must pin an exact size can.
      style={{
        flexShrink: 0,
        width: scaledLength(size),
        height: scaledLength(size),
        ...style,
      }}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {solidGlyph ? (
        <g fill="currentColor" data-solid="">
          {solidGlyph}
        </g>
      ) : (
        (glyph ?? GLYPHS[name])
      )}
    </svg>
  );
};

export default AgentIcon;
