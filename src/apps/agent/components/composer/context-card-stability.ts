/**
 * Agent Window — the two rules that keep the context card readable while a
 * turn runs.
 *
 * A turn issues one request per tool iteration, so a long turn can produce
 * fifty-odd responses in a couple of minutes. The card is fed by four stores
 * that each update on every one of them. Left alone that produces two distinct
 * problems, and they need two distinct fixes:
 *
 * 1. **The card resizes.** Roughly twenty of its rows are conditionally
 *    rendered on a value that crosses zero — a cost line, a disclosure, a whole
 *    section. Each flip changes the card's HEIGHT, and everything below it
 *    jumps. Under a hover card, with the pointer holding it open, that is the
 *    single worst thing the layout can do. → {@link useSticky}
 *
 * 2. **The digits strobe.** Seventeen numbers re-rendering fifty times in
 *    ninety seconds is not information; nothing holds still long enough to be
 *    read. → {@link useThrottled}
 *
 * Neither changes what the card says. A throttled value is still the real
 * value, only later; a reserved row still shows the real number, or a dash
 * when there genuinely isn't one.
 */

import { useEffect, useRef, useState } from "react";

/**
 * How long a displayed figure holds still before it may change again.
 *
 * Chosen against how the card is actually read: money and token counts are
 * scanned, not watched, so a second of latency costs nothing and buys a number
 * that can be finished being read. Trailing-edge, so the last update of a turn
 * always lands — the settled figure is never the stale one.
 */
export const CARD_SETTLE_MS = 1_000;

/**
 * The value, but changing at most once per `ms`.
 *
 * Only useful for values with a stable identity between renders (store slices,
 * memoized objects). Handing it a fresh object every render would schedule a
 * timer every render and defeat the point.
 */
export function useThrottled<T>(value: T, ms: number = CARD_SETTLE_MS): T {
  // The first value is shown immediately — a card that opened blank for a
  // second and then filled in would trade one flicker for a worse one.
  const [shown, setShown] = useState(value);
  // ...and that counts as a publish. The window has to start when the card
  // opens; left unstamped, the first change after mount measured its delay
  // against the beginning of time and went straight through, so a turn's
  // opening burst got one free unthrottled repaint.
  //
  // Stamped in the effect, never in the ref initializer: `performance.now()`
  // is impure, and reading a clock during render makes the value depend on
  // when React happened to re-run the component.
  const lastPublished = useRef<number | null>(null);

  useEffect(() => {
    if (lastPublished.current === null) {
      // First run. `value` and `shown` are still the same object here — the
      // initial render already published it — so this only records when.
      lastPublished.current = performance.now();
    }
    if (Object.is(value, shown)) return;
    const elapsed = performance.now() - lastPublished.current;
    // Always published from the timer callback, never synchronously from the
    // effect body — a synchronous setState here cascades an extra render on
    // every store update, which on a fifty-request turn is the cost this hook
    // exists to avoid. A due update simply gets a zero delay.
    const timer = window.setTimeout(
      () => {
        lastPublished.current = performance.now();
        setShown(value);
      },
      Math.max(0, ms - elapsed),
    );
    // Cleared when `value` changes again inside the window, so a burst of
    // fifty updates publishes once at the end of it rather than fifty times.
    return () => window.clearTimeout(timer);
  }, [value, shown, ms]);

  return shown;
}

/**
 * True from the first moment `present` is true, and true forever after.
 *
 * Turns "render this row only when it has something to say" into "give this
 * row a slot the moment it first has something to say, and keep it". The row
 * still tells the truth when its value returns to zero — it shows a dash — but
 * it stops taking its space back and shoving the rest of the card around.
 *
 * Scoped to the mounted card, which is the only span that matters: the card is
 * portaled on hover and unmounted on leave, so each time you open it the rows
 * settle once and then hold for as long as you are looking at them.
 */
export function useSticky(present: boolean): boolean {
  // Adjusted during render rather than in an effect, which is the documented
  // React pattern for deriving state from a prop: the latch is monotonic, so
  // re-running it is idempotent and the sticky row is never one render late.
  // A ref would be simpler and is wrong — mutating one during render is what
  // makes a component not re-render when the latch flips.
  const [ever, setEver] = useState(false);
  if (present && !ever) setEver(true);
  return ever || present;
}

/** The cost lines a section can show, in the order they are always rendered. */
export const COST_LINE_ORDER = [
  "fresh input",
  "cache write",
  "cached input",
  "output",
] as const;

export type CostLineName = (typeof COST_LINE_ORDER)[number];

/**
 * Which cost lines get a slot, given what they are worth right now.
 *
 * A line earns its place by having been non-zero at least once while the card
 * has been open, and keeps it afterwards. That beats both alternatives: always
 * rendering all four leaves two permanently dead rows on a provider that has
 * no cache, and rendering only the non-zero ones is the bug — it is what makes
 * the card resize mid-hover.
 *
 * Returns them in {@link COST_LINE_ORDER}, never in the order they appeared,
 * so a line arriving late does not reshuffle the ones above it.
 */
export function useReservedCostLines(
  values: Record<CostLineName, number>,
): Array<[CostLineName, number]> {
  const [earned, setEarned] = useState<ReadonlySet<CostLineName>>(EMPTY_LINES);
  const newlyEarned = COST_LINE_ORDER.filter(
    (name) => values[name] > 0 && !earned.has(name),
  );
  if (newlyEarned.length > 0) {
    setEarned((prev) => new Set([...prev, ...newlyEarned]));
  }
  // Includes what was just earned as well as what is stored, so a line shows
  // up on the very render it first has a value — waiting for the state to
  // commit would drop the first figure it ever displays.
  const shown = new Set([...earned, ...newlyEarned]);
  return COST_LINE_ORDER.filter((name) => shown.has(name)).map((name) => [
    name,
    values[name],
  ]);
}

const EMPTY_LINES: ReadonlySet<CostLineName> = new Set();
