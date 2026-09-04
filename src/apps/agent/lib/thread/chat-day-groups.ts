/**
 * Agent Window — grouping a chat list by day (leaf, non-component).
 *
 * Aurora Chat's rail has no projects to group by, so it groups by WHEN. A chat
 * list is browsed as "when was that", and a flat newest-first list stops being
 * navigable somewhere around forty entries.
 *
 * Buckets are relative to the reader's local midnight, not to fixed 24-hour
 * windows: a chat from 11pm last night belongs in "Yesterday" at 9am today,
 * not in "Today" because it is fourteen hours old.
 */

/** A chat as this module needs to see it. Structural, so tests pass literals. */
export interface DatedThread {
  id: string;
  updatedAt?: string | null;
}

export interface ChatDayGroup<T> {
  /** Stable key for React and for tests. Never the label. */
  id: "today" | "yesterday" | "week" | "month" | "older" | "undated";
  label: string;
  threads: T[];
}

/** Local midnight at the start of the day `date` falls in. */
function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

const DAY_MS = 86_400_000;

const ORDER: ChatDayGroup<unknown>["id"][] = [
  "today",
  "yesterday",
  "week",
  "month",
  "older",
  "undated",
];

const LABEL: Record<ChatDayGroup<unknown>["id"], string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "Previous 7 days",
  month: "Previous 30 days",
  older: "Older",
  // A thread whose sidecar is missing or unparseable still has to appear. It
  // is listed last and told the truth about itself rather than being dated
  // "Today" by a `new Date(undefined)` that silently becomes now.
  undated: "Undated",
};

export function bucketFor(updatedAt: string | null | undefined, now: Date): ChatDayGroup<unknown>["id"] {
  if (!updatedAt) return "undated";
  const time = Date.parse(updatedAt);
  if (!Number.isFinite(time)) return "undated";

  const today = startOfDay(now);
  // A clock skew or a bad sidecar can date a chat in the future. It is not
  // "Older" — it is the most recent thing there is, so it sorts with Today.
  if (time >= today) return "today";
  if (time >= today - DAY_MS) return "yesterday";
  if (time >= today - 7 * DAY_MS) return "week";
  if (time >= today - 30 * DAY_MS) return "month";
  return "older";
}

/**
 * Group `threads` into day buckets, newest bucket first, each bucket newest
 * first. Empty buckets are dropped, so the rail never shows a header with
 * nothing under it.
 *
 * The input is not required to be sorted; the output always is.
 */
export function groupChatsByDay<T extends DatedThread>(
  threads: readonly T[],
  now: Date = new Date(),
): ChatDayGroup<T>[] {
  const buckets = new Map<ChatDayGroup<unknown>["id"], T[]>();
  for (const thread of threads) {
    const id = bucketFor(thread.updatedAt, now);
    const list = buckets.get(id);
    if (list) list.push(thread);
    else buckets.set(id, [thread]);
  }

  return ORDER.flatMap((id) => {
    const list = buckets.get(id);
    if (!list || list.length === 0) return [];
    const sorted = [...list].sort((a, b) =>
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
    );
    return [{ id, label: LABEL[id], threads: sorted } as ChatDayGroup<T>];
  });
}
