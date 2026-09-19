/**
 * The appearance export/import round trip.
 *
 * The bug this exists for: export wrote `{ id, name, appearance, tokens }` and
 * import applied tokens only, so every switch, slider and segmented control on
 * the Appearance page was dropped. Nothing threw and no test failed — the
 * fields simply were not in anyone's hand-written list.
 *
 * So the important test here is NOT "these fields round trip". It is
 * `every preference setter has a table row`, which fails when someone adds a
 * preference to the store and forgets the table. A test that checks a list
 * guards the list; this one guards the class (see `.knowledge/lesson.md`).
 */

import { beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error The app intentionally omits Node typings; Vitest runs in Node.
import { readFileSync } from "node:fs";

import {
  AGENT_TOKEN_KEYS,
  useAgentThemeStore,
} from "@/apps/agent/store/ui/useAgentThemeStore";
import {
  APPEARANCE_PREFS,
  type AppearancePrefKey,
  defaultAppearancePrefs,
} from "./appearance-prefs";
import { agentLight } from "./themes";

const cwd = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd();

const PREF_KEYS = Object.keys(APPEARANCE_PREFS) as AppearancePrefKey[];
const EXPORTED_KEYS = PREF_KEYS.filter((k) => APPEARANCE_PREFS[k].exported);

/** A value that is definitely not this preference's default. */
function nonDefault(key: AppearancePrefKey): unknown {
  const spec = APPEARANCE_PREFS[key];
  if (typeof spec.default === "boolean") return !spec.default;
  if (typeof spec.default === "number") return key === "contrast" ? 73 : 240;
  if (key === "uiVersion") return "v2";
  if (key === "modelSelectorPosition") return "top";
  return "changed";
}

function resetStore() {
  useAgentThemeStore.setState({
    activeThemeId: "agent-dark",
    customThemes: {},
    customizations: {},
    ...defaultAppearancePrefs(),
  });
}

describe("appearance export/import", () => {
  beforeEach(resetStore);

  it("has a table row for every preference setter on the store", () => {
    // THE drift guard. A new `setFoo` action whose `foo` has no row means a
    // preference that persists by luck, never exports, and is not cleared by
    // Reset — the exact failure this module was built to end.
    const source = readFileSync(
      `${cwd}/src/apps/agent/store/ui/useAgentThemeStore.ts`,
      "utf8",
    );
    // Actions on the state INTERFACE, which is where a new field is declared.
    const declared = [...source.matchAll(/^\s{2}(set[A-Z]\w*):\s*\(/gm)].map((m) => m[1]);
    // Setters that deliberately own something other than a preference.
    const notPreferences = new Set([
      "setActiveTheme", // theme identity, exported as `themeId`
      "setToken", // one colour/type token
      "setTokens", // several tokens
    ]);
    const missing = declared
      .filter((name) => !notPreferences.has(name))
      .map((name) => `${name[3].toLowerCase()}${name.slice(4)}`)
      .filter((field) => !(field in APPEARANCE_PREFS));
    expect(
      missing,
      `these store setters have no row in APPEARANCE_PREFS, so they will not export: ${missing.join(", ")}`,
    ).toEqual([]);
    // And the reverse: a row nobody can set is dead weight.
    const settable = new Set(
      declared.map((name) => `${name[3].toLowerCase()}${name.slice(4)}`),
    );
    expect(PREF_KEYS.filter((k) => !settable.has(k))).toEqual([]);
  });

  it("round trips a fully non-default appearance", () => {
    const store = useAgentThemeStore.getState();

    // Everything moved off its default: theme, a token, every preference.
    store.setActiveTheme(agentLight.id);
    store.setToken("accent", "#ff0066");
    store.setToken("radiusMd", "3px");
    for (const key of PREF_KEYS) {
      useAgentThemeStore.setState({ [key]: nonDefault(key) } as never);
    }

    const before = useAgentThemeStore.getState();
    const beforePrefs = Object.fromEntries(PREF_KEYS.map((k) => [k, before[k]]));
    const json = JSON.stringify(before.buildAppearanceExport("seti"));

    resetStore();
    const result = useAgentThemeStore.getState().importAppearanceJson(json);

    const after = useAgentThemeStore.getState();
    expect(after.activeThemeId).toBe(agentLight.id);
    expect(result.themeSwitched).toBe(true);
    expect(result.iconPack).toBe("seti");

    // Every EXPORTED preference is back.
    for (const key of EXPORTED_KEYS) {
      expect(after[key], `${key} did not survive the round trip`).toEqual(
        beforePrefs[key],
      );
    }
    // Every token is back, including the ones never touched — an export
    // carries the merged set, not just the overrides.
    const tokens = { ...agentLight.tokens, ...after.customizations[after.activeThemeId] };
    expect(tokens.accent).toBe("#ff0066");
    expect(tokens.radiusMd).toBe("3px");
    expect(result.tokenCount).toBe(AGENT_TOKEN_KEYS.length);
  });

  it("leaves absent fields exactly as they are", () => {
    const store = useAgentThemeStore.getState();
    store.setUiVersion("v2");
    store.setContrast(80);
    store.setTranslucentSidebar(true);

    // A colours-only file, which is what every Cursor/Claude theme is.
    store.importAppearanceJson(JSON.stringify({ accent: "#00ff00" }));

    const after = useAgentThemeStore.getState();
    expect(after.uiVersion).toBe("v2");
    expect(after.contrast).toBe(80);
    expect(after.translucentSidebar).toBe(true);
    expect(after.customizations[after.activeThemeId]?.accent).toBe("#00ff00");
  });

  it("skips values it cannot trust rather than coercing them", () => {
    const store = useAgentThemeStore.getState();
    const result = store.importAppearanceJson(
      JSON.stringify({
        preferences: {
          reduceMotion: "yes", // a string where a boolean belongs
          uiVersion: "v3", // an enum value that does not exist
          contrast: 5000, // out of range, but a real intent
          translucentSidebar: true, // fine
        },
      }),
    );
    const after = useAgentThemeStore.getState();
    expect(after.reduceMotion).toBe(false);
    expect(after.uiVersion).toBe("classic");
    expect(after.translucentSidebar).toBe(true);
    // Numbers CLAMP, because a value past our ceiling is still a direction.
    expect(after.contrast).toBe(100);
    expect(result.skipped).toEqual(["uiVersion", "reduceMotion"]);
  });

  it("never carries the command-center shortcut in either direction", () => {
    const store = useAgentThemeStore.getState();
    store.setCommandCenterShortcut("Mod+Shift+P");

    const file = store.buildAppearanceExport();
    expect("commandCenterShortcut" in file.preferences).toBe(false);

    // And a hand-edited file cannot rebind it either. The file carries a real
    // colour too, so this tests the shortcut being ignored inside an otherwise
    // valid import rather than the whole file being rejected.
    const result = store.importAppearanceJson(
      JSON.stringify({
        accent: "#123456",
        preferences: { commandCenterShortcut: "Mod+J", reduceMotion: true },
      }),
    );
    const after = useAgentThemeStore.getState();
    expect(after.commandCenterShortcut).toBe("Mod+Shift+P");
    expect(after.reduceMotion).toBe(true);
    expect(after.customizations[after.activeThemeId]?.accent).toBe("#123456");
    expect(result.skipped).toEqual(["commandCenterShortcut"]);

    // A file carrying ONLY the shortcut has nothing this window will act on,
    // so it is rejected outright rather than reported as a silent success.
    expect(() =>
      store.importAppearanceJson(
        JSON.stringify({ preferences: { commandCenterShortcut: "Mod+J" } }),
      ),
    ).toThrow(/recognizable/);
  });

  it("picks a base theme by appearance when the file names an unknown one", () => {
    // Someone else's custom theme id. We keep their light/dark, which is what
    // `data-appearance` and every light-mode rule read.
    const result = useAgentThemeStore.getState().importAppearanceJson(
      JSON.stringify({ themeId: "someone-elses-theme", appearance: "light", accent: "#111" }),
    );
    expect(result.themeSwitched).toBe(true);
    expect(useAgentThemeStore.getState().activeThemeId).toBe(agentLight.id);
  });

  it("refuses a file with nothing recognizable in it", () => {
    const store = useAgentThemeStore.getState();
    expect(() => store.importAppearanceJson("not json at all")).toThrow(/valid JSON/);
    expect(() => store.importAppearanceJson('{"unrelated":"app"}')).toThrow(
      /recognizable/,
    );
  });

  it("clears only what Reset appearance is meant to clear", () => {
    for (const key of PREF_KEYS) {
      useAgentThemeStore.setState({ [key]: nonDefault(key) } as never);
    }
    useAgentThemeStore.getState().resetCustomizations();

    const after = useAgentThemeStore.getState();
    for (const key of PREF_KEYS) {
      if (APPEARANCE_PREFS[key].reset) {
        expect(after[key], `${key} should have been reset`).toEqual(
          APPEARANCE_PREFS[key].default,
        );
      } else {
        expect(after[key], `${key} is not the Reset button's to clear`).toEqual(
          nonDefault(key),
        );
      }
    }
  });

  it("requires a stated reason for any preference that opts out", () => {
    // `exported: false` / `reset: false` are real decisions, not defaults to
    // fall into. An unexplained one is how a field goes missing quietly.
    for (const key of PREF_KEYS) {
      const spec = APPEARANCE_PREFS[key];
      if (!spec.exported || !spec.reset) {
        expect(spec.note, `${key} opts out of export or reset without saying why`)
          .toBeTruthy();
      }
    }
  });
});
