import { describe, expect, it } from "vitest";

import {
  AGENT_TOKEN_KEYS,
  DEFAULT_RAIL_GLIDE_MS,
  useAgentThemeStore,
} from "@/apps/agent/store/ui/useAgentThemeStore";
// @ts-expect-error The app intentionally omits Node typings; Vitest itself runs in Node.
import { readFileSync, readdirSync } from "node:fs";

const cwd = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd();
// agent-window.css is an @import manifest; the rules live in the partials.
// Sorted directory order == numeric-prefix order == cascade order.
const partialsDir = `${cwd}/src/apps/agent/theme/agent-window`;
const css = (readdirSync(partialsDir) as string[])
  .filter((name) => name.endsWith(".css"))
  .sort()
  .map((name) => readFileSync(`${partialsDir}/${name}`, "utf8"))
  .join("\n");
const messageBubble = readFileSync(
  `${cwd}/src/apps/agent/components/conversation/MessageBubble.tsx`,
  "utf8",
);
const renderedSources = `${css}\n${messageBubble}`;

describe("agent appearance token coverage", () => {
  it("imports every partial from the manifest, in cascade order", () => {
    // A partial on disk that the manifest skips would pass the rule checks
    // below (they read the directory) while never loading in the app.
    const manifest = readFileSync(`${cwd}/src/apps/agent/theme/agent-window.css`, "utf8");
    const imported = [...manifest.matchAll(/@import "\.\/agent-window\/([^"]+)";/g)].map(
      (m) => m[1],
    );
    const onDisk = (readdirSync(partialsDir) as string[])
      .filter((name) => name.endsWith(".css"))
      .sort();
    expect(imported).toEqual(onDisk);
  });

  it("wires every theme token to a rendered consumer", () => {
    for (const token of AGENT_TOKEN_KEYS) {
      const cssName = token.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
      expect(renderedSources, `${token} has no rendered consumer`).toContain(
        `var(--agw-${cssName}`,
      );
    }
  });

  it("keeps modal backdrops and quiet settings controls on their own tokens", () => {
    for (const selector of [
      ".agw-img-overlay",
      ".agw-confirm-overlay",
      ".agw-mic-perm-overlay",
      ".agw-command-overlay",
    ]) {
      expect(css).toMatch(
        new RegExp(`${selector.replace(".", "\\.")}\\s*\\{[^}]*var\\(--agw-overlay\\)`, "s"),
      );
    }
    expect(css).not.toContain("var(--agw-overlay, var(--agw-surface-elevated))");
    expect(css).toMatch(/\.agw-settings-back\s*\{[^}]*var\(--agw-surface\)/s);
    expect(css).toMatch(/\.agw-set-btn\s*\{[^}]*var\(--agw-surface\)/s);
    expect(css).toMatch(/\.agw-shortcut-recorder\s*\{[^}]*var\(--agw-surface\)/s);
  });

  it("aligns transcript pills and treats response skeletons as placeholder text", () => {
    expect(css).toMatch(/\.agw-pill-inline\s*\{[^}]*vertical-align:\s*middle/s);
    expect(css).toMatch(/\.agw-skeleton span\s*\{[^}]*var\(--agw-text-subtle\)/s);
    expect(css).not.toMatch(
      /\.agw-skeleton span\s*\{[^}]*var\(--agw-surface-elevated\)/s,
    );
  });

  it("lets the right-click menu be sized by its own labels, never by a fixed width", () => {
    const railMenu = css.match(/\.agw-rail-menu\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(railMenu, ".agw-rail-menu rule not found").not.toEqual("");
    // The rows are `white-space: nowrap`, so a pinned width clips its longest
    // label — and since every size token multiplies by --agw-ui-text-scale,
    // it clips for a scaled-up interface even when today's labels fit.
    expect(railMenu).toMatch(/width:\s*max-content/);
    expect(railMenu).not.toMatch(/^\s*width:\s*\d/m);
    // Past max-width the label must ellipsize; unbounded nowrap text does not
    // clip, it paints outside the panel.
    expect(css).toMatch(/\.agw-rail-menu-item > span\s*\{[^}]*text-overflow:\s*ellipsis/s);
    // A menu row is a list row, not prose.
    expect(css).toMatch(/\.agw-rail-menu-item\s*\{[^}]*font-size:\s*var\(--agw-fs-ui\)/s);

    const component = readFileSync(
      `${cwd}/src/apps/agent/components/shell/RailMenu.tsx`,
      "utf8",
    );
    // The component clamps from the measured box. A second copy of the
    // geometry here is what drifted from the CSS in the first place.
    expect(component).toContain("offsetWidth");
    expect(component).not.toMatch(/width:\s*RAIL_MENU_WIDTH/);
  });

  it("reset restores every preference owned by Appearance", () => {
    const before = useAgentThemeStore.getState();
    try {
      useAgentThemeStore.setState({
        syntaxHighlighting: false,
        railGlide: false,
        railGlideMs: 900,
        reduceMotion: true,
        translucentSidebar: true,
        contrast: 80,
      });
      useAgentThemeStore.getState().resetCustomizations();
      expect(useAgentThemeStore.getState()).toMatchObject({
        syntaxHighlighting: true,
        railGlide: true,
        railGlideMs: DEFAULT_RAIL_GLIDE_MS,
        reduceMotion: false,
        translucentSidebar: false,
        contrast: 50,
      });
    } finally {
      useAgentThemeStore.setState({
        syntaxHighlighting: before.syntaxHighlighting,
        railGlide: before.railGlide,
        railGlideMs: before.railGlideMs,
        reduceMotion: before.reduceMotion,
        translucentSidebar: before.translucentSidebar,
        contrast: before.contrast,
        customizations: before.customizations,
      });
    }
  });
});
