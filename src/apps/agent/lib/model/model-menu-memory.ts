/**
 * Agent Window — what the model picker remembers between openings.
 *
 * The menu unmounts every time it closes, so anything held in component state
 * is gone by the next click: the tab you were on, the sections you opened, how
 * far you had scrolled. Reopening then dropped you back at the top of a list
 * you had just finished arranging. Everything the user positioned lives here
 * instead.
 *
 * Two lifetimes on purpose. The tab and the folds are **decisions** and go to
 * localStorage, so they survive a restart. The scroll offset is a **position**
 * and lives in a module variable, so it survives the menu closing and dies with
 * the window — restoring last week's scroll would be worse than starting at the
 * top.
 *
 * ## Which sections are open
 *
 * The picker lists every model of every configured provider, which on a machine
 * with thirty-odd providers is hundreds of rows in one scroll. Folded by
 * provider it is a page of names you can read, and the two or three you
 * actually work with stay open.
 *
 * **Closed is the default for a provider never opened before.** A picker that
 * starts fully expanded is the thing this replaces; and nobody is ever looking
 * at nothing, because the Selected and Frequent strips above the groups are not
 * folded.
 *
 * **The state survives the menu closing.** Reopening the picker to find every
 * group shut again would make the fold worse than useless — you would pay the
 * clicks on every visit. Persisted in localStorage rather than component state
 * for the same reason `model-usage` is: the menu unmounts every time it closes.
 *
 * Pure module, the same shape as its sibling `model-usage` — no React, no
 * storage side effects beyond the two explicit read/write helpers, so the
 * parsing is testable on its own.
 */

/** localStorage key. */
export const MODEL_GROUPS_OPEN_KEY = "agw:model-groups-open";

/** `providerId -> is the section open`. Absent means closed. */
export type ModelGroupsOpen = Record<string, boolean>;

/**
 * The Frequent strip's slot in the same record, so one control and one stored
 * shape cover every foldable section in the menu.
 *
 * Two leading underscores because a provider id is a uuid or a preset slug and
 * neither can start with them — the two key spaces cannot collide.
 *
 * **It is open unless the user closes it**, unlike a provider section. Frequent
 * exists to save clicks; shipping it folded would mean the shortcut costs a
 * click to reach, which is the whole thing it was there to avoid.
 */
export const FREQUENT_GROUP_KEY = "__frequent";

/** Whether a section is open, applying each kind's own default. */
export const isModelGroupOpen = (state: ModelGroupsOpen, key: string): boolean =>
  key === FREQUENT_GROUP_KEY ? state[key] !== false : state[key] === true;

export function readModelGroupsOpen(): ModelGroupsOpen {
  try {
    const raw = localStorage.getItem(MODEL_GROUPS_OPEN_KEY);
    if (!raw) return {};
    return parseModelGroupsOpen(JSON.parse(raw) as unknown);
  } catch {
    /* malformed or unavailable — start clean rather than throw in a render */
    return {};
  }
}

/** The pure half of {@link readModelGroupsOpen}, split out so it can be tested. */
export function parseModelGroupsOpen(parsed: unknown): ModelGroupsOpen {
  if (!parsed || typeof parsed !== "object") return {};
  const out: ModelGroupsOpen = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "boolean") continue;
    // Only what DIFFERS from the key's default is worth storing. For a provider
    // that is `true`; for Frequent, which starts open, it is `false`. Writing
    // the rest would grow the record by one entry per provider the user has
    // never touched.
    if (value !== defaultOpen(key)) out[key] = value;
  }
  return out;
}

/** What a section does when the user has never touched it. */
const defaultOpen = (key: string): boolean => key === FREQUENT_GROUP_KEY;

export function writeModelGroupsOpen(state: ModelGroupsOpen): void {
  try {
    localStorage.setItem(MODEL_GROUPS_OPEN_KEY, JSON.stringify(parseModelGroupsOpen(state)));
  } catch {
    // Storage full or blocked — the fold still applies for this session.
  }
}

/**
 * Flip one section, returning a new record.
 *
 * Writes the value only while it differs from that section's default, so a
 * group opened and closed again leaves the record exactly as it found it.
 */
export function toggleModelGroup(state: ModelGroupsOpen, key: string): ModelGroupsOpen {
  const next = { ...state };
  const wanted = !isModelGroupOpen(state, key);
  if (wanted === defaultOpen(key)) delete next[key];
  else next[key] = wanted;
  return next;
}

// ── Which tab was open ───────────────────────────────────────────────────────

/** The picker's two lists: models that talk, and models that draw. */
export type ModelTab = "text" | "image";

export const MODEL_TAB_KEY = "agw:model-tab";

/**
 * The tab to open on.
 *
 * The remembered one wins. `fallback` is what to use when nothing has been
 * remembered yet — the caller passes the tab the CURRENT model lives in, so a
 * first-ever open of a picture chat still lands on the picture list.
 */
export function readModelTab(fallback: ModelTab): ModelTab {
  try {
    const raw = localStorage.getItem(MODEL_TAB_KEY);
    return raw === "image" || raw === "text" ? raw : fallback;
  } catch {
    return fallback;
  }
}

export function writeModelTab(tab: ModelTab): void {
  try {
    localStorage.setItem(MODEL_TAB_KEY, tab);
  } catch {
    // Storage full or blocked — the choice still applies for this session.
  }
}

// ── How far it was scrolled ──────────────────────────────────────────────────

/**
 * Session-only, and deliberately not persisted: a scroll offset is where you
 * were a moment ago, not a preference. Restoring it tomorrow — against a list
 * whose length has changed — would land somewhere arbitrary and read as a bug.
 *
 * Kept per tab, because the two lists have their own lengths and their own
 * places you were looking.
 */
const scrollByTab: Record<ModelTab, number> = { text: 0, image: 0 };

export const readModelScroll = (tab: ModelTab): number => scrollByTab[tab];
export const writeModelScroll = (tab: ModelTab, top: number): void => {
  scrollByTab[tab] = Math.max(0, top);
};
