/**
 * Preferences that belong to the engine, not to one browser.
 *
 * Several clients talk to one engine (the desktop window, a browser on
 * `aurora serve`, later a phone), and one browser can talk to several engines
 * (every `aurora serve` on port 3721 is the same origin, `127.0.0.1:3721`, so
 * they share one browser storage). A preference kept only in browser storage
 * is therefore wrong both ways: it does not follow the user to another client,
 * and it leaks one engine's theme into another engine's page.
 *
 * The keys in {@link ENGINE_PREF_KEYS} are the user's own choices (theme,
 * pinned projects, recent models, …). The engine holds them
 * (`client_prefs_get` / `client_prefs_save`); browser storage keeps a copy so
 * every existing synchronous read still works. {@link hydrateEnginePrefs} runs
 * once in `main.tsx` BEFORE the interface's modules load (`App` is imported
 * after it), so every persisted store is created from the engine's copy.
 * Per-screen things (panel widths, folded sections, drafts) are deliberately
 * NOT here: a phone and a wide monitor should not share them.
 *
 * Writes go through {@link enginePrefsStorage}: the local copy at once, the
 * engine shortly after (batched).
 */

import {
  auroraInvoke,
  getAuroraRuntime,
  isAuroraRuntimeAvailable,
} from "@/kernel/lib/ipc/runtime";

/**
 * Browser-storage keys whose values the engine owns. The owning modules keep
 * their own constants; `engine-pref-keys.test.ts` (agent app) checks each one
 * is listed here, since the kernel cannot import from the apps.
 */
export const ENGINE_PREF_KEYS: readonly string[] = [
  // Agent window theme, typography and transcript preferences.
  "aurora-agent-window-theme",
  // ✦ rewrite: the llama.cpp executable and model, paths on the engine's machine.
  "aurora-agent-window-refine",
  // Rail: pinned projects and the project sort.
  "agw-rail-pinned-projects",
  "agw-rail-project-sort",
  // Model picker: recently used models, Cursor Fast per model.
  "agw:model-recent",
  "agw:cursor-fast",
  // Images page: the chosen model and size per model.
  "agw-images-model",
  "agw-images-size",
  // Providers page: pinned providers.
  "agw-prov-pinned-providers",
];

const ENGINE_KEYS = new Set(ENGINE_PREF_KEYS);

/** How long first paint waits for the engine before using the local copy. */
const HYDRATE_TIMEOUT_MS = 2_000;
/** Writes within this window go to the engine as one call. */
const FLUSH_DELAY_MS = 200;

interface ClientPrefs {
  seeded: boolean;
  values: Record<string, string>;
}

let hydrated = false;
const pending = new Map<string, string | null>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (error) {
    console.warn(`[engine-prefs] could not write ${key} to browser storage`, error);
  }
}

async function readEnginePrefs(): Promise<ClientPrefs | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.warn(
        `[engine-prefs] the engine did not answer within ${HYDRATE_TIMEOUT_MS} ms; using this browser's copy`,
      );
      resolve(null);
    }, HYDRATE_TIMEOUT_MS);
  });
  const read = auroraInvoke<ClientPrefs>("client_prefs_get").catch((error: unknown) => {
    console.warn("[engine-prefs] could not read the engine's preferences; using this browser's copy", error);
    return null;
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Make the local copy of every engine preference equal the engine's. Run once
 * before first paint. An engine that has never held preferences, opened in the
 * desktop window, is given the window's own copy instead: that copy is the
 * user's settings from before the engine held them. A browser never seeds an
 * engine: its storage may belong to a different engine on the same address.
 */
export async function hydrateEnginePrefs(): Promise<void> {
  if (hydrated || !isAuroraRuntimeAvailable()) {
    hydrated = true;
    return;
  }
  const prefs = await readEnginePrefs();
  if (!prefs) {
    hydrated = true;
    return;
  }

  if (!prefs.seeded && getAuroraRuntime().kind === "desktop") {
    const entries: [string, string][] = [];
    for (const key of ENGINE_PREF_KEYS) {
      const value = readLocal(key);
      if (value !== null) entries.push([key, value]);
    }
    try {
      await auroraInvoke("client_prefs_save", { entries });
    } catch (error) {
      console.warn("[engine-prefs] could not hand this window's preferences to the engine", error);
    }
    hydrated = true;
    return;
  }

  for (const key of ENGINE_PREF_KEYS) {
    writeLocal(key, prefs.values[key] ?? null);
  }
  hydrated = true;
}

async function flush(): Promise<void> {
  flushTimer = null;
  if (pending.size === 0) return;
  const entries = [...pending.entries()];
  pending.clear();
  try {
    await auroraInvoke("client_prefs_save", { entries });
  } catch (error) {
    console.warn(
      `[engine-prefs] could not save ${entries.map(([key]) => key).join(", ")} to the engine`,
      error,
    );
  }
}

function queue(key: string, value: string | null): void {
  if (!ENGINE_KEYS.has(key)) {
    console.warn(`[engine-prefs] ${key} is not an engine preference; kept in this browser only`);
    return;
  }
  // Before hydration, a write is a store echoing the old local copy back;
  // sending it would overwrite the engine's value with this browser's.
  if (!hydrated || !isAuroraRuntimeAvailable()) return;
  pending.set(key, value);
  if (flushTimer === null) flushTimer = setTimeout(() => void flush(), FLUSH_DELAY_MS);
}

/**
 * Browser-storage-shaped access for engine preferences: usable directly, and
 * as a zustand `persist` storage (`createJSONStorage(() => enginePrefsStorage)`).
 */
export const enginePrefsStorage = {
  getItem: (key: string): string | null => readLocal(key),
  setItem: (key: string, value: string): void => {
    writeLocal(key, value);
    queue(key, value);
  },
  removeItem: (key: string): void => {
    writeLocal(key, null);
    queue(key, null);
  },
};

if (typeof window !== "undefined") {
  // A tab closing within the batch window would otherwise drop the last change.
  window.addEventListener("pagehide", () => void flush());
}

/** Tests only: forget hydration and queued writes. */
export function resetEnginePrefsForTests(): void {
  hydrated = false;
  pending.clear();
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
}
