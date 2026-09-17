import { describe, expect, it } from "vitest";

import { CHAT_DOCK_TABS, DOCK_TAB_LABELS } from "@/apps/agent/types";
import { CHAT_MODE_TOOLS } from "@/apps/agent/services/runtime/agent-execution-mode";

/**
 * Aurora Chat kept offering the user its way into things it cannot do: a Files
 * tab in the dock, an "Open files" row in the command palette, a code-index
 * button in the header, a `+` menu offering a workspace mention. Each was a
 * different file quietly assuming a project was open.
 *
 * The dock roster is the one piece of that with two doors onto it — the dock's
 * `+` menu and the palette — so it is a constant, and this is what stops the
 * two from drifting.
 */
describe("Aurora Chat's dock", () => {
  it("offers only what this side of the app can act on", () => {
    expect([...CHAT_DOCK_TABS]).toEqual(["canvas", "memory", "gallery"]);
  });

  it("names nothing that addresses a project", () => {
    for (const projectSurface of ["files", "browser", "terminal", "review", "team"] as const) {
      expect(CHAT_DOCK_TABS).not.toContain(projectSurface);
    }
  });

  it("every tab it offers has a label to render", () => {
    for (const kind of CHAT_DOCK_TABS) {
      expect(DOCK_TAB_LABELS[kind]).toBeTruthy();
    }
  });

  // Canvas is where chat presents and Memory is what it keeps, so each dock tab
  // has to have a tool behind it — a surface with nothing to fill it is a tab
  // that opens empty forever.
  it("has a tool behind each tab", () => {
    expect(CHAT_MODE_TOOLS.has("present_artifact")).toBe(true);
    expect(CHAT_MODE_TOOLS.has("remember")).toBe(true);
  });
});
