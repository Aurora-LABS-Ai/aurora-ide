/**
 * Agent Window — opt-in drawing sets for tool-row marks [pure registry].
 *
 * Appearance → Layout → Tool icons picks one (`toolIconSet` in
 * `theme/appearance-prefs.ts`). `classic` draws nothing of its own: every
 * mark comes from AgentIcon, exactly as before this registry existed.
 *
 * A set is keyed by the CLASSIC icon name, not by tool name. `toolIcon()` in
 * ToolCallCard stays the one place a tool name becomes a mark ("file-read",
 * "terminal", …); a set only says "draw `file-read` like this". Anything a set
 * leaves out falls back to the classic drawing, so a tool added later, or one
 * the set never drew, still has a mark.
 *
 * Every drawing follows AgentIcon's frame (it is drawn through
 * `AgentIcon glyph`): 24×24 grid, stroke in currentColor, no fixed colours,
 * and the working part tagged with a `data-part` from the motion vocabulary
 * (33-tool-glyph-motion.css), so a running row still animates its own mark.
 * `tool-icon-sets.test.tsx` holds every set to that.
 *
 * MCP tools are excluded on purpose: their mark says "this came from a
 * server", and the type below does not let a set redraw it.
 */

import type React from "react";

import type { AgentIconName } from "@/apps/agent/shared/AgentIcon";
import type { ToolIconSetId } from "@/apps/agent/theme/appearance-prefs";
import { ISOMETRIC_MARKS } from "./isometric";

/** The marks a set may redraw: every tool-row mark except MCP's. */
export type ToolMark = Exclude<AgentIconName, "mcp">;

export interface ToolIconSet {
  id: ToolIconSetId;
  /** Shown in the Tool icons dropdown. */
  name: string;
  /** Shapes per mark, drawn on AgentIcon's 24-grid frame. */
  marks: Partial<Record<ToolMark, React.ReactNode>>;
}

/**
 * One entry per id in `TOOL_ICON_SET_IDS`; the `Record` makes a missing entry
 * a type error. Order is the dropdown's order.
 */
export const TOOL_ICON_SETS: Record<ToolIconSetId, ToolIconSet> = {
  classic: { id: "classic", name: "Classic", marks: {} },
  isometric: { id: "isometric", name: "Isometric", marks: ISOMETRIC_MARKS },
};

export const TOOL_ICON_SET_LIST: ToolIconSet[] = Object.values(TOOL_ICON_SETS);

/**
 * The shapes the active set draws for this mark, or null to draw the classic
 * one. An id this build does not know (a value saved by a newer build) also
 * returns null rather than drawing nothing.
 */
export function toolMarkGlyph(setId: string, mark: AgentIconName): React.ReactNode | null {
  if (mark === "mcp") return null;
  const set = (TOOL_ICON_SETS as Record<string, ToolIconSet | undefined>)[setId];
  return set?.marks[mark] ?? null;
}
