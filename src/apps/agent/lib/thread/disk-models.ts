/**
 * Agent Window — folding the models a listing read from disk into the
 * window's per-conversation copy [pure].
 *
 * The sidecar on disk is the truth about which model a conversation is on.
 * The window keeps a copy (`useAgentChatStore.threadModels`) and refreshes it
 * from every listing, with one exception: a conversation whose model this
 * window is writing right now. A listing that left before that write landed
 * carries the OLD model, and adopting it would flip the composer back to the
 * model the user just moved away from.
 */

interface ListedModel {
  id: string;
  model?: string | null;
}

/**
 * `current` with every listed conversation's model taken from `rows`, except
 * the ones in `writing`. Returns `current` itself when nothing changed, so a
 * listing that agrees with the window re-renders nothing.
 */
export function mergeDiskModels(
  current: Record<string, string>,
  rows: readonly ListedModel[],
  writing: ReadonlyMap<string, unknown>,
): Record<string, string> {
  let next: Record<string, string> | null = null;
  for (const row of rows) {
    if (!row.model || writing.has(row.id)) continue;
    if (current[row.id] === row.model) continue;
    next ??= { ...current };
    next[row.id] = row.model;
  }
  return next ?? current;
}
