/**
 * When a conversation last moved, said two ways at once.
 *
 * The rail lists conversations by a title generated from their first message,
 * which means a project worked on for a week produces ten rows reading
 * "Architecture of account-managemen…" and nothing else. The title cannot tell
 * them apart — only the clock can — and there was nowhere on the row, or in its
 * tooltip, that said when anything happened.
 *
 * Both halves earn their place. The relative half ("2 hours ago") is what
 * someone scanning for "the one from this morning" actually reads. The absolute
 * half is what they need the moment two rows are both "3 days ago", and it is
 * the only half that stays true in a screenshot.
 */

/** Ten identical-looking rows is the case this exists for. */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "just now" / "12 minutes ago" / "3 hours ago" / "5 days ago".
 *
 * Stops at days on purpose: past a week the absolute date beside it is the
 * more useful reading, and "7 weeks ago" is a number nobody converts back.
 */
export function relativeTime(then: Date, now: Date = new Date()): string {
  const delta = now.getTime() - then.getTime();
  // A clock skew or a row written a moment ago should not read "in -1 minutes".
  if (delta < MINUTE) return "just now";
  if (delta < HOUR) {
    const minutes = Math.floor(delta / MINUTE);
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  if (delta < DAY) {
    const hours = Math.floor(delta / HOUR);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(delta / DAY);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return "";
}

/**
 * The same reading, short enough to sit on a row in a 248px rail.
 *
 * "3h", not "3 hours ago". The rail's job is to let someone pick one row out of
 * ten with the same generated title; it does not need a sentence, and a
 * sentence would push the title itself out of the way.
 *
 * Past a week it gives the date instead, because "9w" is a number nobody
 * converts back and the month is what a person actually remembers.
 */
export function compactRelative(
  value: string | null | undefined,
  now: Date = new Date(),
): string | null {
  const then = parse(value);
  if (!then) return null;
  const delta = now.getTime() - then.getTime();
  if (delta < MINUTE) return "now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  const days = Math.floor(delta / DAY);
  if (days < 7) return `${days}d`;
  return then.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/**
 * The exact moment, in the reader's own locale and timezone.
 *
 * `Intl` rather than a hand-rolled format: this is the half someone compares
 * against their own memory of the day, so it has to match how their machine
 * writes dates everywhere else.
 */
export function absoluteTime(then: Date): string {
  return then.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * One line for a conversation row's tooltip.
 *
 * `Created` only appears when it differs from `Updated` by more than a minute
 * — on a chat sent once and never returned to they are the same instant, and
 * printing it twice makes the reader look for a difference that is not there.
 *
 * Returns `null` for an unparseable or missing timestamp rather than a
 * fabricated date. A tooltip that says nothing is honest; one that says
 * "Invalid Date" is a bug report.
 */
export function describeThreadTime(
  updatedAt: string | null | undefined,
  createdAt?: string | null,
  /** Injectable so the wording can be pinned against a fixed clock. */
  now: Date = new Date(),
): string | null {
  const updated = parse(updatedAt);
  if (!updated) return null;

  const relative = relativeTime(updated, now);
  const absolute = absoluteTime(updated);
  const head = relative ? `Updated ${relative} · ${absolute}` : `Updated ${absolute}`;

  const created = parse(createdAt);
  if (!created || Math.abs(updated.getTime() - created.getTime()) < MINUTE) return head;
  return `${head}\nStarted ${absoluteTime(created)}`;
}

function parse(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
