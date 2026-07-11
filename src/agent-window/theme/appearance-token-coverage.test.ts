import { describe, expect, it } from "vitest";

import {
  AGENT_TOKEN_KEYS,
  DEFAULT_RAIL_GLIDE_MS,
  useAgentThemeStore,
} from "../store/useAgentThemeStore";
// @ts-expect-error The app intentionally omits Node typings; Vitest itself runs in Node.
import { readFileSync } from "node:fs";

const cwd = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd();
const css = readFileSync(`${cwd}/src/agent-window/theme/agent-window.css`, "utf8");
const messageBubble = readFileSync(
  `${cwd}/src/agent-window/components/MessageBubble.tsx`,
  "utf8",
);
const renderedSources = `${css}\n${messageBubble}`;

describe("agent appearance token coverage", () => {
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
