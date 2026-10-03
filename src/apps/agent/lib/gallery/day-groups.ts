/**
 * Group a newest-first list of media under day headings (pure).
 *
 * Today, Yesterday, the weekday for the rest of this week, then dates — with
 * the year only when it is not this one. Order inside a group is the order
 * given, so a list already sorted newest first stays that way. Days are the
 * viewer's LOCAL days: a picture made at 23:30 belongs to that evening, not to
 * tomorrow in UTC.
 */

export interface DayGroup<T> {
  /** `YYYY-MM-DD` in local time, or `"undated"`. */
  key: string;
  label: string;
  items: T[];
}

const pad = (n: number) => String(n).padStart(2, "0");
const localKey = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** The local day a timestamp falls on, or null when it is not a date. */
export function dayKey(timestamp: string | undefined): string | null {
  if (!timestamp) return null;
  const time = Date.parse(timestamp);
  return Number.isNaN(time) ? null : localKey(new Date(time));
}

export function dayLabel(key: string, now: Date): string {
  if (key === "undated") return "Earlier";
  const [y, m, d] = key.split("-").map(Number);
  const day = new Date(y, m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysAgo = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (daysAgo === 0) return "Today";
  if (daysAgo === 1) return "Yesterday";
  if (daysAgo > 1 && daysAgo < 7) return day.toLocaleDateString(undefined, { weekday: "long" });
  return day.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(day.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

export function groupByDay<T>(
  items: readonly T[],
  dateOf: (item: T) => string | undefined,
  now: Date = new Date(),
): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  const byKey = new Map<string, DayGroup<T>>();
  for (const item of items) {
    const key = dayKey(dateOf(item)) ?? "undated";
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: dayLabel(key, now), items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}
