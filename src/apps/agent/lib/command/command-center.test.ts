import { describe, expect, it } from "vitest";

import { fuzzyCommandScore } from "@/apps/agent/lib/command/command-search";
import { settingsCommands } from "@/apps/agent/lib/command/settings-commands";
import { matchesCommandShortcut, shortcutFromKeyboardEvent } from "@/apps/agent/lib/command/command-shortcut";

/** What the command center would list under Settings for this query. */
const settingsResults = (query: string): string[] =>
  settingsCommands(query)
    .map((item) => ({ item, score: fuzzyCommandScore(item, query) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item.id);

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

describe("command center — settings", () => {
  it("finds the page that owns a control, by the control's name", () => {
    // The reported gap: the command center is also where people look for a
    // setting, and it used to answer "no match" for a control the settings
    // page could find.
    expect(settingsResults("chapter")[0]).toBe("settings:preferences");
    expect(settingsResults("approval")[0]).toBe("settings:tools");
    expect(settingsResults("compaction")[0]).toBe("settings:execution");
    // The log had no route into the app at all before Diagnostics existed;
    // asking for it by the word people use must land there.
    expect(settingsResults("log")[0]).toBe("settings:diagnostics");
    expect(settingsResults("crash")[0]).toBe("settings:diagnostics");
  });

  it("names the control it matched instead of only the page", () => {
    const preferences = settingsCommands("chapter").find(
      (item) => item.id === "settings:preferences",
    );
    expect(preferences?.subtitle).toBe("Settings · chapters");
  });

  it("says only 'Settings' when the page itself is what was asked for", () => {
    const appearance = settingsCommands("appearance").find(
      (item) => item.id === "settings:appearance",
    );
    expect(appearance?.subtitle).toBe("Settings");
  });

  it("stays quiet for a query that means nothing here", () => {
    // Guards the reason only the matched term reaches the item: with every
    // indexed term in the searchable text, the fuzzy subsequence fallback
    // matches almost any typing against almost every section.
    expect(settingsResults("python")).toEqual([]);
  });
});
