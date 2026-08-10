import { describe, expect, it } from "vitest";

import { fuzzyCommandScore } from "@/apps/agent/lib/command/command-search";
import { matchesCommandShortcut, shortcutFromKeyboardEvent } from "@/apps/agent/lib/command/command-shortcut";

const keyboard = (overrides: Partial<KeyboardEvent> = {}) =>
  ({
    key: "k",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  }) as KeyboardEvent;

describe("agent command center helpers", () => {
  it("records and matches exact modifier chords", () => {
    expect(shortcutFromKeyboardEvent(keyboard({ shiftKey: true }))).toBe("Mod+Shift+K");
    expect(matchesCommandShortcut(keyboard({ shiftKey: true }), "Mod+Shift+K")).toBe(true);
    expect(matchesCommandShortcut(keyboard(), "Mod+Shift+K")).toBe(false);
  });

  it("ranks direct and fuzzy multi-token matches while rejecting misses", () => {
    const item = {
      title: "Providers & models",
      subtitle: "Settings",
      keywords: "api llm",
      group: "Settings",
    };
    expect(fuzzyCommandScore(item, "providers")).toBeGreaterThan(
      fuzzyCommandScore(item, "prv mdl"),
    );
    expect(fuzzyCommandScore(item, "python terminal")).toBe(-1);
  });
});
