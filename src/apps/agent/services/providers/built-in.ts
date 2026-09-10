/**
 * Which providers ship with Aurora, and what order they sit in.
 *
 * Two kinds of provider live in the same list and behave differently, so the
 * Providers page has to be able to tell them apart:
 *
 * - **Shipped with Aurora** — seeded from the provider catalog on first run
 *   (Rust `provider_catalog`, plus the frontend presets for Codex, Atlas Cloud
 *   and AgentRouter). The user fills in a key and picks models; the row itself
 *   is not theirs to remove.
 * - **Added by the user** — created from "Add provider". Theirs entirely,
 *   including deleting it.
 *
 * The stored flag is `isCustom`, written by the store when a provider is
 * seeded (`false`) or added by hand (`true`). Read it through
 * {@link isBuiltInProvider} rather than testing the flag inline, so the one
 * place that defines the boundary stays the one place that has to change.
 */

/**
 * Shipped providers in the order they appear, most-used first.
 *
 * This is a display order, NOT the membership list: a shipped provider that is
 * missing from here still counts as shipped and simply sorts after the ones
 * named, in catalog order. So adding a preset to the catalog can never make it
 * silently disappear from the page.
 */
export const BUILT_IN_PROVIDER_ORDER: readonly string[] = [
  "anthropic",
  "claude-code",
  "openai-responses",
  "codex",
  "cursor",
  "meta",
  "opencode-go",
  "commandcode",
  "deepseek",
  "minimax",
  "kenari",
  "ark",
  "modal",
];

/** Whether this provider came with Aurora rather than being added by the user. */
export function isBuiltInProvider(provider: { isCustom?: boolean }): boolean {
  return !provider.isCustom;
}

/**
 * Sort position within the shipped group. Anything not named in
 * {@link BUILT_IN_PROVIDER_ORDER} sorts after everything that is, keeping its
 * existing relative order.
 */
export function builtInRank(id: string): number {
  const index = BUILT_IN_PROVIDER_ORDER.indexOf(id);
  return index === -1 ? BUILT_IN_PROVIDER_ORDER.length : index;
}

/**
 * Split a provider list into the two groups the page renders, shipped first.
 *
 * Sorting is stable within each group: the shipped group follows
 * {@link BUILT_IN_PROVIDER_ORDER} and then catalog order, and providers the
 * user added keep the order they were added in.
 */
export function groupProviders<T extends { id: string; isCustom?: boolean }>(
  providers: readonly T[],
): { builtIn: T[]; custom: T[] } {
  const builtIn: T[] = [];
  const custom: T[] = [];
  for (const provider of providers) {
    (isBuiltInProvider(provider) ? builtIn : custom).push(provider);
  }
  builtIn.sort((a, b) => builtInRank(a.id) - builtInRank(b.id));
  return { builtIn, custom };
}
