/**
 * The rail's Recent shortcut — the last few chats across every project.
 *
 * Every chat in the rail otherwise lives inside a project row you have to
 * expand first, so getting back to yesterday's work means remembering which
 * folder it was in. This is the one flat route back to it.
 *
 * Deliberately a TAKE, not a sort: the listing already arrives newest-first
 * from the session store (see `list_summaries_returns_threads_sorted_newest_first`
 * in `session_store.rs`), with in-flight chats folded in at the front. Re-sorting
 * here would be a second opinion about recency that could disagree with the
 * project rows' own ordering, which is exactly the bug worth not having.
 */

import type { ThreadSummary } from "@/apps/agent/services/threads/thread-service";

/** How many rows Recent carries — enough for a session's worth of switching. */
export const RECENT_LIMIT = 5;

/**
 * The `limit` most recent chats from an already-newest-first list.
 *
 * Pinned chats are skipped: the Pinned section sits directly above, and a chat
 * printed in both reads as two different chats with the same name.
 */
export function recentChats(
  threads: readonly ThreadSummary[],
  limit: number = RECENT_LIMIT,
): ThreadSummary[] {
  if (limit <= 0) return [];
  const out: ThreadSummary[] = [];
  for (const thread of threads) {
    if (thread.pinned) continue;
    out.push(thread);
    if (out.length === limit) break;
  }
  return out;
}
