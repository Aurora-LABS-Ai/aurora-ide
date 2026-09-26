/**
 * Volcano Ark — the one piece of Ark knowledge the settings store needs.
 * Sign-in, quota and wire routing live with the agent window
 * (`apps/agent/services/providers/ark.ts`).
 */

/**
 * Whether this stored row is carrying a deliberate Ark wire choice.
 *
 * Needed because the launch merge normally lets the catalogue's provider type
 * win, keeping a stored one only when it is a `-` suffixed variant of the
 * preset's (`resolveProviderType`). That test works for kenari, whose preset
 * type is the bare `kenari`. It does NOT work here: Ark's preset type is
 * `ark-messages`, so neither `ark` nor `ark-responses` looks like a variant of
 * it, and both would be rewritten back to Messages on the next launch — the
 * picker would appear to save, work all session, and be reset by morning.
 *
 * Same job as `isAgentRouterWireChoice`, for the mirror-image reason: that
 * provider's wires have no variant prefix to detect, this one's DEFAULT is
 * itself a variant.
 */
export function isArkWireChoice(provider: {
  id?: string;
  providerType?: string;
}): boolean {
  return (
    provider.providerType === "ark" ||
    provider.providerType === "ark-messages" ||
    provider.providerType === "ark-responses"
  );
}
