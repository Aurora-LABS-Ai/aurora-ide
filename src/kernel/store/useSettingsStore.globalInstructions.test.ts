import { beforeEach, describe, expect, it, vi } from "vitest";

// The profile actions all end in `saveToDatabase()`; without this mock the
// debounced save eventually reaches a Tauri invoke that does not exist under
// vitest and logs an error into an unrelated test's output.
vi.mock("@/kernel/services/database", () => ({
  databaseService: {
    saveAppSettings: vi.fn(async () => {}),
    saveAllProviders: vi.fn(async () => {}),
    saveAllToolSettings: vi.fn(async () => {}),
  },
}));

import {
  GLOBAL_INSTRUCTION_NAME_MAX,
  GLOBAL_INSTRUCTION_PROFILE_LIMIT,
  LEGACY_GLOBAL_INSTRUCTION_PROFILE_ID,
  resolveGlobalInstructionState,
  selectActiveGlobalInstructions,
  useSettingsStore,
} from "./useSettingsStore";

/**
 * Global-instruction sets: up to three named "personas", at most one active,
 * and only the active one's text reaches the system prompt. These pin the
 * contracts the settings UI and `agent-prompt.ts` both rely on.
 */
describe("global instruction profiles", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      globalInstructionProfiles: [
        { id: "a", name: "Default", text: "alpha rules" },
        { id: "b", name: "Reviewer", text: "review rules" },
      ],
      activeGlobalInstructionProfileId: "",
    });
  });

  it("creates sets up to the cap of three, then refuses with null", () => {
    const store = useSettingsStore.getState();
    const id = store.addGlobalInstructionProfile();
    expect(id).not.toBeNull();
    expect(useSettingsStore.getState().globalInstructionProfiles).toHaveLength(
      GLOBAL_INSTRUCTION_PROFILE_LIMIT,
    );
    expect(useSettingsStore.getState().addGlobalInstructionProfile()).toBeNull();
    expect(useSettingsStore.getState().globalInstructionProfiles).toHaveLength(
      GLOBAL_INSTRUCTION_PROFILE_LIMIT,
    );
  });

  it("activation is exclusive: switching one on switches the other off", () => {
    const store = useSettingsStore.getState();
    store.setActiveGlobalInstructionProfile("a");
    expect(selectActiveGlobalInstructions(useSettingsStore.getState())).toBe("alpha rules");
    useSettingsStore.getState().setActiveGlobalInstructionProfile("b");
    const state = useSettingsStore.getState();
    expect(state.activeGlobalInstructionProfileId).toBe("b");
    expect(selectActiveGlobalInstructions(state)).toBe("review rules");
  });

  it("deactivating (null) or naming an unknown id sends nothing", () => {
    const store = useSettingsStore.getState();
    store.setActiveGlobalInstructionProfile("a");
    useSettingsStore.getState().setActiveGlobalInstructionProfile(null);
    expect(selectActiveGlobalInstructions(useSettingsStore.getState())).toBe("");
    useSettingsStore.getState().setActiveGlobalInstructionProfile("no-such-set");
    expect(useSettingsStore.getState().activeGlobalInstructionProfileId).toBe("");
  });

  it("deleting the active set deactivates instead of promoting another persona", () => {
    const store = useSettingsStore.getState();
    store.setActiveGlobalInstructionProfile("a");
    useSettingsStore.getState().removeGlobalInstructionProfile("a");
    const state = useSettingsStore.getState();
    expect(state.globalInstructionProfiles.map((p) => p.id)).toEqual(["b"]);
    expect(state.activeGlobalInstructionProfileId).toBe("");
    expect(selectActiveGlobalInstructions(state)).toBe("");
  });

  it("the last remaining set cannot be deleted", () => {
    useSettingsStore.getState().removeGlobalInstructionProfile("a");
    useSettingsStore.getState().removeGlobalInstructionProfile("b");
    expect(useSettingsStore.getState().globalInstructionProfiles).toHaveLength(1);
  });

  it("rename trims, caps the length, and ignores an empty commit", () => {
    const store = useSettingsStore.getState();
    store.renameGlobalInstructionProfile("a", `  ${"x".repeat(80)}  `);
    expect(
      useSettingsStore.getState().globalInstructionProfiles[0].name,
    ).toHaveLength(GLOBAL_INSTRUCTION_NAME_MAX);
    useSettingsStore.getState().renameGlobalInstructionProfile("a", "   ");
    expect(useSettingsStore.getState().globalInstructionProfiles[0].name).not.toBe("");
  });

  it("editing text only touches the named set", () => {
    useSettingsStore.getState().setGlobalInstructionProfileText("b", "changed");
    const [a, b] = useSettingsStore.getState().globalInstructionProfiles;
    expect(a.text).toBe("alpha rules");
    expect(b.text).toBe("changed");
  });
});

describe("resolveGlobalInstructionState (what the DB row becomes on load)", () => {
  it("migrates the legacy single string onto one active Default set", () => {
    // The legacy text WAS injected on every turn, so the set it becomes must
    // stay in effect — a migration that lands inactive silently strips the
    // user's standing rules.
    const resolved = resolveGlobalInstructionState(undefined, "", "be brief");
    expect(resolved.profiles).toEqual([
      { id: LEGACY_GLOBAL_INSTRUCTION_PROFILE_ID, name: "Default", text: "be brief" },
    ]);
    expect(resolved.activeId).toBe(LEGACY_GLOBAL_INSTRUCTION_PROFILE_ID);
  });

  it("a legacy row with no text migrates to one inactive empty set", () => {
    const resolved = resolveGlobalInstructionState(undefined, "", "");
    expect(resolved.profiles).toHaveLength(1);
    expect(resolved.activeId).toBe("");
  });

  it("keeps saved profiles, clamps to the cap, and drops malformed entries", () => {
    const resolved = resolveGlobalInstructionState(
      [
        { id: "one", name: "One", text: "1" },
        { id: "one", name: "Duplicate id", text: "x" },
        { name: "No id", text: "x" },
        { id: "two", name: "  ", text: "2" },
        { id: "three", name: "Three", text: 42 },
        { id: "four", name: "Past the cap", text: "4" },
      ],
      "two",
      "legacy text must lose to saved profiles",
    );
    expect(resolved.profiles.map((p) => p.id)).toEqual(["one", "two", "three"]);
    // A blank name gets a stand-in, a non-string text becomes empty.
    expect(resolved.profiles[1].name).toBe("Persona 2");
    expect(resolved.profiles[2].text).toBe("");
    expect(resolved.activeId).toBe("two");
  });

  it("an active id that names no surviving profile resolves to none active", () => {
    const resolved = resolveGlobalInstructionState(
      [{ id: "one", name: "One", text: "1" }],
      "gone",
      "",
    );
    expect(resolved.activeId).toBe("");
  });
});
