import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { useAgentThemeStore } from "@/apps/agent/store/ui/useAgentThemeStore";
import { APPEARANCE_PREFS, TOOL_ICON_SET_IDS } from "@/apps/agent/theme/appearance-prefs";
import { ToolGlyph } from "./ToolGlyph";
import { TOOL_ICON_SETS, TOOL_ICON_SET_LIST, toolMarkGlyph } from "./tool-icon-sets";

describe("tool icon sets", () => {
  it("has one registry entry per preference id, under its own id", () => {
    expect(TOOL_ICON_SET_LIST.map((set) => set.id)).toEqual([...TOOL_ICON_SET_IDS]);
    for (const [key, set] of Object.entries(TOOL_ICON_SETS)) expect(set.id).toBe(key);
    expect(APPEARANCE_PREFS.toolIconSet.default).toBe("classic");
  });

  it("keeps classic as AgentIcon's own drawings", () => {
    expect(Object.keys(TOOL_ICON_SETS.classic.marks)).toEqual([]);
  });

  it("falls back to the classic mark for MCP, unknown sets and undrawn marks", () => {
    expect(toolMarkGlyph("classic", "file-read")).toBeNull();
    expect(toolMarkGlyph("from-a-newer-build", "file-read")).toBeNull();
    expect(toolMarkGlyph("classic", "mcp")).toBeNull();
  });

  // The grouped-runs header shows on almost every turn; falling back to the
  // classic mark there mixed two sets on the same screen (2026-10-24).
  it("draws the grouped-runs header in the isometric set", () => {
    expect(toolMarkGlyph("isometric", "layers")).not.toBeNull();
  });

  // Held for every set, so a drawn set from a probe cannot ship a mark that
  // sits still while running, carries its own colour, or writes at the wrong speed.
  it("holds every drawn set to AgentIcon's frame and the motion vocabulary", () => {
    for (const set of TOOL_ICON_SET_LIST) {
      for (const [mark, shapes] of Object.entries(set.marks)) {
        const where = `${set.id}/${mark}`;
        const svg = renderToStaticMarkup(<svg>{shapes}</svg>);
        expect(svg, `${where} has no data-part`).toContain("data-part=");
        expect(svg, `${where} sets its own colour`).not.toMatch(/(fill|stroke)="(#|rgb|hsl)/);
        for (const part of svg.match(/<[a-z]+[^>]*data-part="(?:line|tick)"[^>]*>/g) ?? []) {
          expect(part, `${where}: a self-writing part needs pathLength="1"`).toContain('pathLength="1"');
        }
      }
    }
  });
});

describe("ToolGlyph", () => {
  const marks = TOOL_ICON_SETS.classic.marks as Record<string, React.ReactNode>;
  afterEach(() => {
    delete marks["file-read"];
    delete marks.mcp;
  });

  it("draws the classic mark when the set has none", () => {
    const html = renderToStaticMarkup(<ToolGlyph name="file-read" size={16} />);
    expect(html).toContain('data-part="lens"');
  });

  it("draws the chosen set's shapes on the same frame", () => {
    useAgentThemeStore.setState({ toolIconSet: "classic" });
    marks["file-read"] = <circle cx="12" cy="12" r="5" data-part="pulse" data-probe="" />;
    const html = renderToStaticMarkup(<ToolGlyph name="file-read" size={16} className="agw-tool-glyph-scan" />);
    expect(html).toContain("data-probe");
    expect(html).not.toContain('data-part="lens"');
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain('class="agw-tool-glyph-scan"');
  });

  it("never redraws an MCP tool's mark", () => {
    marks.mcp = <circle data-probe="" />;
    const html = renderToStaticMarkup(<ToolGlyph name="mcp" size={16} />);
    expect(html).not.toContain("data-probe");
  });
});
