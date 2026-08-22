/**
 * How long until something happens, written the way a person would say it.
 *
 * Split out of the Codex provider because it stopped being about Codex: every
 * subscription Aurora surfaces reports a limit window that refills, and each
 * one needs the same sentence. The alternative was a second copy per provider,
 * which is how "3h 5m" and "3 hours 5 minutes" end up on the same card.
 */

/**
 * Seconds → `2h 14m` / `3d 5h` / `45m`.
 *
 * Two units at most: the third never changes a decision, and a countdown that
 * reads `3d 5h 12m 8s` invites re-reading it as a precise number when it is
 * refreshed once a minute. Anything under a minute rounds UP to `1m` rather
 * than showing `0m`, which reads as "no time left" when the truth is "nearly
 * none".
 */
export function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3_600);
  const minutes = Math.floor((s % 3_600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${Math.max(1, minutes)}m`;
}

/**
 * An RFC3339 instant in the future → `resets in 3h 56m`.
 *
 * `null` for anything that cannot be said honestly — no timestamp, an
 * unparseable one — so a caller renders nothing rather than a placeholder.
 * An instant that has already passed says `resets now`: the window is due to
 * roll over and the next reading will show it.
 */
export function fmtResetsIn(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return null;
  const seconds = (at - Date.now()) / 1000;
  if (seconds <= 0) return "resets now";
  return `resets in ${fmtDuration(seconds)}`;
}
