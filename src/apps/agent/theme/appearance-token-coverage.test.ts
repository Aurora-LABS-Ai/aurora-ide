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

  it("keeps the bubble clamp in ONE place, and shortens it once questions pin", () => {
    // The clamp used to be a number in the CSS and the same number in the TSX,
    // with a comment asking whoever changed one to change the other. It is now
    // declared once and read back, so a pinned question can be shortened
    // without the chevron threshold silently staying at the old height —
    // which would clip lines with no control to reveal them.
    expect(css).toMatch(/^\.agw-root \{[^}]*--agw-bubble-clamp-lines:\s*6;/ms);
    expect(css).toMatch(
      /\.agw-root\[data-transcript-sticky-user\] \{[^}]*--agw-bubble-clamp-lines:\s*3;/s,
    );
    expect(css).toMatch(
      /\.agw-bubble-body\[data-collapsed\]\s*\{[^}]*var\(--agw-bubble-clamp-lines/s,
    );
    expect(messageBubble).toContain('getPropertyValue("--agw-bubble-clamp-lines")');
    // The pinned card's own ceiling is overflow safety for an EXPANDED paste,
    // not the resting height — it is the clamp above that decides how much of
    // the window a pinned question costs.
    expect(css).toMatch(
      /\.agw-root\[data-transcript-sticky-user\] \[data-uturn\] \.agw-bubble-user \{[^}]*max-height:\s*34vh/s,
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
        uiVersion: "v2",
        contrast: 80,
      });
      useAgentThemeStore.getState().resetCustomizations();
      expect(useAgentThemeStore.getState()).toMatchObject({
        syntaxHighlighting: true,
        railGlide: true,
        railGlideMs: DEFAULT_RAIL_GLIDE_MS,
        reduceMotion: false,
        translucentSidebar: false,
        uiVersion: "classic",
        contrast: 50,
      });
    } finally {
      useAgentThemeStore.setState({
        syntaxHighlighting: before.syntaxHighlighting,
        railGlide: before.railGlide,
        railGlideMs: before.railGlideMs,
        reduceMotion: before.reduceMotion,
        translucentSidebar: before.translucentSidebar,
        uiVersion: before.uiVersion,
        contrast: before.contrast,
        customizations: before.customizations,
      });
    }
  });

  it("keeps V2 a switch over the themes, not a theme of its own", () => {
    // Classic has to be a true no-op: the aliases resolve to the exact tokens
    // the cards used before the switch existed, so a user who never opens the
    // control sees byte-identical paint.
    const root = css.match(/^\.agw-root \{(.*?)^\}/ms)?.[1] ?? "";
    expect(root, ".agw-root rule not found").not.toEqual("");
    expect(root).toMatch(/--agw-card-paint:\s*var\(--agw-surface\);/);
    expect(root).toMatch(/--agw-card-line:\s*var\(--agw-border\);/);
    expect(root).toMatch(/--agw-card-lift:\s*none;/);
    expect(root).toMatch(/--agw-control-lift:\s*none;/);
    expect(root).toMatch(/--agw-grain:\s*none;/);

    // V2's PAINT half may only re-point those aliases. The moment it sets a
    // colour of its own it stops composing with the user's theme and becomes a
    // skin. (V2 also changes LAYOUT, which is checked separately below — the
    // rule is that colour and layout never mix in one block.)
    const raised = (css.match(/^\.agw-root\[data-ui="v2"\] \{(.*?)^\}/ms)?.[1] ?? "")
      // Comments carry `:` and `;` of their own, so they have to go before the
      // declarations can be split apart.
      .replace(/\/\*.*?\*\//gs, "");
    expect(raised, "v2 paint block not found").not.toEqual("");
    for (const decl of raised.split(";")) {
      const name = decl.trim().split(":")[0];
      if (!name) continue;
      expect(name, `v2 sets ${name}, which is not a depth alias`).toMatch(
        /^(--agw-card-paint|--agw-card-line|--agw-card-lift|--agw-card-lift-hover|--agw-control-lift|--agw-grain)$/,
      );
    }

    // Every card that opted in reads the aliases; none may reach past them
    // back to the raw tokens, or it would stay flat while its neighbours lift.
    for (const selector of [
      ".agw-set-panel",
      ".agw-set-tile",
      ".agw-set-group",
      ".agw-mcp-card",
      ".agw-appr-card",
      ".agw-skill-card",
      ".agw-prov-detail",
      ".agw-atlas",
      ".agw-proj-stats",
    ]) {
      const rule = css.match(
        new RegExp(`^\\${selector} \\{(.*?)^\\}`, "ms"),
      )?.[1];
      expect(rule, `${selector} rule not found`).toBeTruthy();
      expect(rule, `${selector} still paints from --agw-surface`).toContain(
        "var(--agw-card-paint)",
      );
      expect(rule, `${selector} has no lift`).toMatch(/box-shadow:\s*var\(--agw-(set-shadow|card-lift)\)/);
    }
  });

  it("leaves the Providers page out of V2 entirely", () => {
    // The tabbed Providers layout was built, shipped and pulled back out — it
    // fixed the fold but left the settings nail + provider rail sitting side by
    // side, which is the thing that actually needed solving. Until that is
    // designed, Providers renders ONE layout in both versions. A stray
    // `[data-ui="v2"]` rule in this file means half of it crept back.
    const providers = readFileSync(
      `${cwd}/src/apps/agent/theme/agent-window/22-settings-providers-detail.css`,
      "utf8",
    );
    expect(providers).not.toContain("data-ui");
    const page = readFileSync(`${cwd}/src/apps/agent/settings/ProvidersSettings.tsx`, "utf8");
    expect(page).not.toContain("uiVersion");
  });

  it("gives every secret-reveal toggle an eye, never the globe", () => {
    // `browser` is a globe. It said nothing about revealing anything, and four
    // separate password fields had copied it from each other.
    for (const file of [
      "src/apps/agent/settings/ProvidersSettings.tsx",
      "src/apps/agent/settings/McpSettings.tsx",
      "src/apps/agent/settings/PreferencesSettings.tsx",
    ]) {
      const source = readFileSync(`${cwd}/${file}`, "utf8");
      expect(source, `${file} still uses the globe to reveal a secret`).not.toMatch(
        /\?\s*"inspect"\s*:\s*"browser"/,
      );
    }
    const icons = readFileSync(`${cwd}/src/apps/agent/shared/AgentIcon.tsx`, "utf8");
    expect(icons).toContain('"eye-off"');
  });
});
