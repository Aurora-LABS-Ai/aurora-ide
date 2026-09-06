import { describe, expect, it } from "vitest";

import { SETTINGS_CATALOG } from "@/apps/agent/settings/settings-catalog";
import {
  filterSettingsSearch,
  matchedSearchTerm,
  matchesSettingsSearch,
  normalizeQuery,
  rowSearchState,
  type SettingsSearchEntry,
} from "@/apps/agent/settings/settings-search";

const entries: SettingsSearchEntry[] = [
  {
    id: "preferences",
    navLabel: "Preferences",
    title: "Preferences",
    description: "Personal window preferences.",
    searchTerms: ["transcript", "chapters", "timeline spine"],
  },
  {
    id: "appearance",
    navLabel: "Appearance",
    title: "Appearance",
    description: "Theme the agent window.",
    searchTerms: ["font", "contrast"],
  },
];

describe("settings search", () => {
  it("finds the tool-loading explanation in Agent settings", () => {
    expect(filterSettingsSearch(SETTINGS_CATALOG, "tool loading").map((entry) => entry.id)).toContain("execution");
  });
  it("finds controls that are indexed under their owning settings section", () => {
    expect(filterSettingsSearch(entries, "chapter").map((entry) => entry.id)).toEqual([
      "preferences",
    ]);
  });

  it("matches section metadata case-insensitively", () => {
    expect(matchesSettingsSearch(entries[1], "APPEARANCE")).toBe(true);
  });

  it("keeps every section visible for an empty query", () => {
    expect(filterSettingsSearch(entries, "   ")).toEqual(entries);
  });
});

describe("settings search — in-page results", () => {
  it("ignores a query too short to narrow anything", () => {
    // One character matches nearly every section, so it would mount the whole
    // settings surface to show a list that is not an answer.
    expect(normalizeQuery("c")).toBe("");
    expect(normalizeQuery("  ch  ")).toBe("ch");
  });

  it("finds the section that owns a control by the control's own name", () => {
    // The reported case: "chapter" must reach Preferences, which renders the
    // Chapters row, rather than reporting no match.
    const preferences = {
      id: "preferences",
      navLabel: "Preferences",
      title: "Preferences",
      description: "Personal window preferences.",
      searchTerms: ["transcript", "chapters", "sticky user message"],
    };
    expect(matchesSettingsSearch(preferences, "chapter")).toBe(true);
    expect(matchesSettingsSearch(preferences, "provider")).toBe(false);
  });

  describe("row visibility", () => {
    it("shows every row when nothing is being searched", () => {
      expect(rowSearchState("Chapters", "", false)).toEqual({
        matched: false,
        visible: true,
      });
    });

    it("shows a matching row and hides the rest", () => {
      expect(rowSearchState("Chapters mark a long turn", "chapter", false)).toEqual({
        matched: true,
        visible: true,
      });
      expect(rowSearchState("Open on launch", "chapter", false)).toEqual({
        matched: false,
        visible: false,
      });
    });

    it("shows a non-matching row when its SECTION is the match", () => {
      // Searching a section by name must return the section, not an empty one.
      // `matched` stays false so the section can't claim a hit from rows it is
      // only showing because it matched itself.
      expect(rowSearchState("Open on launch", "preferences", true)).toEqual({
        matched: false,
        visible: true,
      });
    });

    it("matches on the hint, not just the label", () => {
      const haystack = "Chapters Ask the agent to plan a long turn as named chapters";
      expect(rowSearchState(haystack, "plan a long turn", false).matched).toBe(true);
    });
  });
});

describe("settings search — the control a query hit", () => {
  const preferences = entries[0];

  it("names the control so a result is not just the page holding it", () => {
    expect(matchedSearchTerm(preferences, "chapter")).toBe("chapters");
    expect(matchedSearchTerm(preferences, "TIMELINE")).toBe("timeline spine");
  });

  it("stays silent when the SECTION itself is what matched", () => {
    // The section is the answer here, so there is no control to name — and
    // echoing a stray term would narrow the page for no reason.
    expect(matchedSearchTerm(preferences, "preferences")).toBeNull();
  });

  it("stays silent below the length that makes a query a query", () => {
    // A term found from one character would be announced in the result and then
    // handed over as a landing query the settings page ignores.
    expect(matchedSearchTerm(preferences, "c")).toBeNull();
  });

  it("returns nothing when the section does not match at all", () => {
    expect(matchedSearchTerm(preferences, "provider")).toBeNull();
  });
});

describe("settings catalog — one source for both search surfaces", () => {
  it("gives the command center and the settings page the same answer", () => {
    // The command center used to carry its own keyword list, and it drifted:
    // "chapter" found the Chapters switch in Settings and nothing here.
    const hits = filterSettingsSearch(SETTINGS_CATALOG, "chapter");
    expect(hits.map((entry) => entry.id)).toEqual(["preferences"]);
    expect(matchedSearchTerm(hits[0], "chapter")).toBe("chapters");
  });

  it("does not match a word from inside another word", () => {
    // "log" used to reach Skills before Diagnostics, on the strength of
    // "cata(log)". People search for words, so a match must start at one.
    expect(filterSettingsSearch(SETTINGS_CATALOG, "log").map((e) => e.id)).toEqual([
      "diagnostics",
    ]);
    // A prefix of a word still counts — that is how typing narrows.
    expect(matchedSearchTerm(SETTINGS_CATALOG[3], "compact")).toBe("context compaction");
  });

  it("registers every section exactly once", () => {
    const ids = SETTINGS_CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("indexes every section under something searchable", () => {
    for (const entry of SETTINGS_CATALOG) {
      expect(entry.searchTerms?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
