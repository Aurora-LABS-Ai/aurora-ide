import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setAuroraRuntimeForTests, type AuroraRuntime } from "@/kernel/lib/ipc/runtime";
import {
  enginePrefsStorage,
  hydrateEnginePrefs,
  resetEnginePrefsForTests,
} from "./engine-prefs";

const THEME = "aurora-agent-window-theme";
const PINS = "agw-rail-pinned-projects";

interface Engine {
  seeded: boolean;
  values: Record<string, string>;
  saves: [string, string | null][][];
}

function runtime(kind: "desktop" | "web", engine: Engine): AuroraRuntime {
  return {
    kind,
    isAvailable: () => true,
    listen: async () => () => {},
    invoke: async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (command === "client_prefs_get") {
        return { seeded: engine.seeded, values: { ...engine.values } } as T;
      }
      if (command === "client_prefs_save") {
        const entries = args?.entries as [string, string | null][];
        engine.saves.push(entries);
        for (const [key, value] of entries) {
          if (value === null) delete engine.values[key];
          else engine.values[key] = value;
        }
        engine.seeded = true;
        return undefined as T;
      }
      throw new Error(`unexpected ${command}`);
    },
  };
}

describe("engine preferences", () => {
  beforeEach(() => {
    localStorage.clear();
    resetEnginePrefsForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    setAuroraRuntimeForTests(null);
    vi.useRealTimers();
  });

  it("a browser shows the engine's theme, not the one this address left behind", async () => {
    localStorage.setItem(THEME, "desktop-theme");
    localStorage.setItem(PINS, '["C:/old"]');
    const engine: Engine = { seeded: true, values: { [THEME]: "linux-theme" }, saves: [] };
    setAuroraRuntimeForTests(runtime("web", engine));

    await hydrateEnginePrefs();

    expect(localStorage.getItem(THEME)).toBe("linux-theme");
    expect(localStorage.getItem(PINS)).toBeNull();
    expect(engine.saves).toEqual([]);
  });

  it("a browser on an engine that never held preferences starts from defaults and seeds nothing", async () => {
    localStorage.setItem(THEME, "desktop-theme");
    const engine: Engine = { seeded: false, values: {}, saves: [] };
    setAuroraRuntimeForTests(runtime("web", engine));

    await hydrateEnginePrefs();

    expect(localStorage.getItem(THEME)).toBeNull();
    expect(engine.saves).toEqual([]);
    expect(engine.seeded).toBe(false);
  });

  it("the desktop window hands its own copy to an engine that never held preferences", async () => {
    localStorage.setItem(THEME, "my-theme");
    localStorage.setItem("agw-rail-projects-grown", "[]"); // per screen: stays out
    const engine: Engine = { seeded: false, values: {}, saves: [] };
    setAuroraRuntimeForTests(runtime("desktop", engine));

    await hydrateEnginePrefs();

    expect(engine.values).toEqual({ [THEME]: "my-theme" });
    expect(localStorage.getItem(THEME)).toBe("my-theme");
  });

  it("writes reach the engine in one batch, and a removal removes", async () => {
    const engine: Engine = { seeded: true, values: { [PINS]: "[]" }, saves: [] };
    setAuroraRuntimeForTests(runtime("web", engine));
    await hydrateEnginePrefs();

    enginePrefsStorage.setItem(THEME, "a");
    enginePrefsStorage.setItem(THEME, "b");
    enginePrefsStorage.removeItem(PINS);
    expect(localStorage.getItem(THEME)).toBe("b");
    await vi.runAllTimersAsync();

    expect(engine.saves).toEqual([
      [
        [THEME, "b"],
        [PINS, null],
      ],
    ]);
    expect(engine.values).toEqual({ [THEME]: "b" });
  });

  it("an engine that cannot answer leaves this browser's copy in place", async () => {
    localStorage.setItem(THEME, "kept");
    setAuroraRuntimeForTests({
      ...runtime("web", { seeded: true, values: {}, saves: [] }),
      invoke: async () => {
        throw new Error("unknown command: client_prefs_get");
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await hydrateEnginePrefs();

    expect(localStorage.getItem(THEME)).toBe("kept");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
