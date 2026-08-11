/**
 * Agent Window — live "the connection dropped, getting it back" marker.
 *
 * Shown in place of the half-reply that died, while the runtime re-requests
 * the same model call. It is the only marker in the transcript that is meant
 * to DISAPPEAR: the moment the retry streams a token it is removed, and
 * nothing about the recovered turn records that it was ever here. That is the
 * point — the conversation genuinely did not change, so a healed hiccup should
 * not leave a scar in the reading order.
 *
 * Shape is `.agw-notice`'s, in the warning role, so the transcript keeps one
 * vocabulary for "this is not the model talking" (user note → accent,
 * runtime → warning). The spinner rather than the static triangle is what
 * separates "working on it" from "this went wrong", so the state is carried by
 * more than the tint — and if the retry fails for good, the triangle notice is
 * what lands in its place.
 */

export function ReconnectCard({
  attempt,
  maxAttempts,
  reason,
}: {
  attempt: number;
  maxAttempts: number;
  /** The raw provider/transport error, for the hover title only — the visible
   *  line stays plain, because "stream error: error decoding response body"
   *  tells the person waiting nothing they can act on. */
  reason?: string;
}) {
  // `attempt` is the try that failed, so the one now in flight is the next.
  const running = Math.min(attempt + 1, maxAttempts);
  const label = `Connection lost — retrying (${running} of ${maxAttempts})`;

  return (
    <div className="agw-reconnect" role="status" aria-live="polite" title={reason}>
      <span className="agw-reconnect-spinner" aria-hidden />
      <span>{label}</span>
    </div>
  );
}
