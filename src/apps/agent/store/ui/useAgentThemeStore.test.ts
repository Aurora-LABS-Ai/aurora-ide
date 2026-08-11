import { beforeEach, describe, expect, it } from "vitest";

import { resolveAgentTheme, useAgentThemeStore } from "./useAgentThemeStore";
import {
  DEFAULT_AGENT_THEME_ID,
  TYPOGRAPHY_DEFAULTS,
} from "@/apps/agent/theme/themes";

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
