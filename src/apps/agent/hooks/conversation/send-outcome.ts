/**
 * What a send through the window pipeline actually did.
 *
 * A send is not always a turn. It can be folded into a turn already running
 * (queued for the next tool boundary), or dropped on the floor because another
 * turn opened on the same thread between the caller's check and the pipeline's
 * own guard. Callers that hand over something they cannot regenerate — a
 * sub-agent's report, a process ending — must know which, or the message is
 * silently gone. That is exactly what happened on 2026-10-08: four reports
 * arrived at once, two drains raced, and the loser returned `void`.
 *
 * - `started`: a new turn opened for this text.
 * - `queued`: a turn was live; the text rides it at the next tool boundary.
 * - `skipped`: nothing was sent. Empty text, no thread to send into, or the
 *   per-thread guard fired. The caller still owns the text.
 */
export type SendOutcome = "started" | "queued" | "skipped";
