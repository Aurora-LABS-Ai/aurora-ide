import { beforeEach, describe, expect, it } from "vitest";

import {
  mergeAgentTokens,
  resolveAgentTheme,
  useAgentThemeStore,
} from "./useAgentThemeStore";
import {
  AGENT_THEMES,
  DEFAULT_AGENT_THEME_ID,
  TYPOGRAPHY_DEFAULTS,
} from "@/apps/agent/theme/themes";

/**
 * The accent family.
 *
 * `controlAccent` paints the switches; `accent` paints the sliders, the links
 * and the chips. Both built-in themes ship them equal and the comment beside
 * them says small controls follow the brand, but they did not: changing Accent
 * wrote one and left the other, which is how one settings page ended up drawing
 * a tan slider beside a blue switch with nobody having chosen that.
 */
describe("the control accent follows the brand accent", () => {
  const base = AGENT_THEMES[DEFAULT_AGENT_THEME_ID].tokens;

  beforeEach(() => {
    useAgentThemeStore.setState({
      activeThemeId: DEFAULT_AGENT_THEME_ID,
      customizations: {},
    });
  });

  it("carries a customized accent onto the control accent", () => {
    const tokens = mergeAgentTokens(base, { accent: "#c9b489" });
    expect(tokens.accent).toBe("#c9b489");
    expect(tokens.controlAccent).toBe("#c9b489");
  });

  it("stops following the moment someone sets the control accent", () => {
    // The whole reason the second token exists: a brand that goes neutral
    // needs its switches to keep a hue, and that choice must survive.
    const tokens = mergeAgentTokens(base, {
      accent: "#0d0d0d",
      controlAccent: "#339cff",
    });
    expect(tokens.controlAccent).toBe("#339cff");
  });

  it("leaves an untouched theme exactly as it ships", () => {
    expect(mergeAgentTokens(base, undefined)).toBe(base);
    expect(mergeAgentTokens(base, { radiusMd: "4px" }).controlAccent).toBe(
      base.controlAccent,
    );
  });

  it("reaches what the window renders, not just the merge helper", () => {
    useAgentThemeStore.getState().setToken("accent", "#c9b489");
    const resolved = resolveAgentTheme(useAgentThemeStore.getState());
    expect(resolved.tokens.controlAccent).toBe(resolved.tokens.accent);
  });

  it("and what an export hands to the next machine", () => {
    useAgentThemeStore.getState().setToken("accent", "#c9b489");
    const file = useAgentThemeStore.getState().buildAppearanceExport();
    expect(file.tokens?.controlAccent).toBe("#c9b489");
  });
});

describe("resetTypography", () => {
  beforeEach(() => {
    useAgentThemeStore.setState({
      activeThemeId: DEFAULT_AGENT_THEME_ID,
      customizations: {},
    });
  });

  it("drops every typography override and keeps color overrides", () => {
    const s = useAgentThemeStore.getState();
    s.setTokens({
      fontUi: "Comic Sans MS, sans-serif",
      fontCode: "Courier New, monospace",
      msgFontSize: "18px",
      uiTextScale: "1.15",
      accent: "#ff0000",
    });
    useAgentThemeStore.getState().resetTypography();

    const overrides =
      useAgentThemeStore.getState().customizations[DEFAULT_AGENT_THEME_ID];
    expect(overrides).toBeDefined();
    expect(overrides?.fontUi).toBeUndefined();
    expect(overrides?.fontCode).toBeUndefined();
    expect(overrides?.msgFontSize).toBeUndefined();
    expect(overrides?.uiTextScale).toBeUndefined();
    expect(overrides?.accent).toBe("#ff0000");
  });

  it("removes the whole customization entry when typography was all there was", () => {
    const s = useAgentThemeStore.getState();
    s.setTokens({ fontUi: "Papyrus, fantasy", msgLineHeight: "2" });
    useAgentThemeStore.getState().resetTypography();
    expect(
      useAgentThemeStore.getState().customizations[DEFAULT_AGENT_THEME_ID],
    ).toBeUndefined();
  });

  it("restores the shipped baseline the renderer resolves", () => {
    const s = useAgentThemeStore.getState();
    s.setTokens({ fontUi: "Papyrus, fantasy", msgFontSize: "18px" });
    useAgentThemeStore.getState().resetTypography();

    // What AgentThemeProvider would resolve after the reset.
    const resolved = resolveAgentTheme(useAgentThemeStore.getState());
    expect(resolved.tokens.fontUi).toBe(TYPOGRAPHY_DEFAULTS.fontUi);
    expect(resolved.tokens.msgFontSize).toBe(TYPOGRAPHY_DEFAULTS.msgFontSize);
  });
});

describe("persisted-state migration (v0 → v1)", () => {
  it("prunes retired-default and current-default typography overrides, keeps deliberate ones", () => {
    const migrate = useAgentThemeStore.persist.getOptions().migrate;
    expect(migrate).toBeTypeOf("function");

    const persisted = {
      activeThemeId: DEFAULT_AGENT_THEME_ID,
      customizations: {
        [DEFAULT_AGENT_THEME_ID]: {
          // Retired default the user never chose — must go.
          fontUi: '"Inter", "Segoe UI", system-ui, -apple-system, sans-serif',
          // Identical to today's default — a render no-op, must go.
          fontCode: TYPOGRAPHY_DEFAULTS.fontCode,
          // Deliberate choices — must survive.
          msgFontSize: "17px",
          accent: "#00ff00",
        },
        "agent-light": {
          fontUi: '"Cambria", "Segoe UI", system-ui, -apple-system, sans-serif',
        },
      },
    };

    const out = migrate!(persisted, 0) as typeof persisted;
    const dark = out.customizations[DEFAULT_AGENT_THEME_ID];
    expect(dark.fontUi).toBeUndefined();
    expect(dark.fontCode).toBeUndefined();
    expect(dark.msgFontSize).toBe("17px");
    expect(dark.accent).toBe("#00ff00");
    // A deliberate custom family on another theme is untouched.
    expect(out.customizations["agent-light"].fontUi).toContain("Cambria");
  });

  it("drops a customization entry left empty by pruning", () => {
    const migrate = useAgentThemeStore.persist.getOptions().migrate;
    const persisted = {
      customizations: {
        [DEFAULT_AGENT_THEME_ID]: {
          fontUi: TYPOGRAPHY_DEFAULTS.fontUi,
          fontCode: TYPOGRAPHY_DEFAULTS.fontCode,
        },
      },
    };
    const out = migrate!(persisted, 0) as typeof persisted;
    expect(out.customizations[DEFAULT_AGENT_THEME_ID]).toBeUndefined();
  });
});
