/**
 * Agent Window — Fast mode, per model.
 *
 * Cursor sells a faster lane for most of its models, reached by sending a
 * different model id (`…-high` → `…-high-fast`). It is a way of running a
 * model, not a model of its own — listing both would double a picker that was
 * already too long.
 *
 * So it lives here rather than on the model row: Fast is Cursor's alone, and
 * the shared model schema has no business carrying a column that means
 * nothing to any other provider. Kept per model, because the choice is one
 * people make per model ("Grok always fast, Opus never") rather than once
 * globally.
 *
 * Storage is localStorage, read synchronously — the send path resolves the id
 * to send without awaiting anything, and an IPC round-trip in front of every
 * turn to answer a boolean would be a poor trade.
 *
 * Pure module: no React, no side effects beyond the two explicit read/write
 * helpers, so it is testable on its own.
 */

/** localStorage key. */
export const CURSOR_FAST_KEY = "agw:cursor-fast";

/**
 * Model **row id** (`LLMModel.id`, e.g. `cursor::composer-2.5`) → whether Fast
 * is on. Absent means off.
 *
 * Keyed by the row's database identity, not by a `provider:model` selection
 * string. The selection is composed at runtime, and its spelling changed
 * repeatedly as the Cursor provider took shape — each time, the picker wrote
 * under one spelling and the send path read under another, so the switch
 * showed on while the turn ran on the slow lane, with nothing reporting a
 * miss. A row id cannot drift, and it is the same key the reasoning controls
 * next to this one already use.
 */
export type FastPreferences = Record<string, boolean>;

/**
 * In-memory mirror, so the send path does not parse JSON per turn.
 *
 * `undefined` means "not read yet" — distinct from an empty map, which means
 * "read, and nothing is switched on".
 */
let cache: FastPreferences | undefined;

export function readFastPreferences(): FastPreferences {
  if (cache) return cache;
  cache = load();
  return cache;
}

function load(): FastPreferences {
  try {
    const raw = localStorage.getItem(CURSOR_FAST_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: FastPreferences = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === true) out[key] = true;
    }
    return out;
  } catch {
    // A corrupt or unavailable store must not stop a turn. Off is the safe
    // reading: it sends the id the user actually picked.
    return {};
  }
}

export function writeFastPreferences(next: FastPreferences): void {
  cache = next;
  try {
    localStorage.setItem(CURSOR_FAST_KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked — the in-memory value still holds for this
    // session, which is better than refusing the toggle.
  }
}

/** Whether Fast is on for a stable provider-model row id. */
export function isFastOn(modelRowId: string): boolean {
  return readFastPreferences()[modelRowId] === true;
}

/** Set Fast for one stable provider-model row and return the new map. */
export function setFastOn(modelRowId: string, on: boolean): FastPreferences {
  const current = readFastPreferences();
  const next = { ...current };
  if (on) next[modelRowId] = true;
  else delete next[modelRowId];
  writeFastPreferences(next);
  return next;
}

/** Test seam — drops the in-memory mirror so the next read hits storage. */
export function resetFastPreferenceCache(): void {
  cache = undefined;
}
