/**
 * Agent Window — the text forms of a provider's advanced fields.
 *
 * A leaf (no JSX) behind `ProviderAdvanced.tsx`: model aliases as `alias=id`
 * lines, extra request parameters as a JSON object, and a number field that
 * means "unset" when empty. Kept out of the component file so they can be
 * tested on their own and so the component file exports only a component.
 */

/** `alias=model-key` per line → record. Blank and malformed lines are skipped. */
export function parseAliases(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const alias = line.slice(0, eq).trim();
    const target = line.slice(eq + 1).trim();
    if (alias && target) out[alias] = target;
  }
  return out;
}

export function stringifyAliases(record: Record<string, string> | undefined): string {
  return Object.entries(record ?? {})
    .map(([alias, target]) => `${alias}=${target}`)
    .join("\n");
}

/** A JSON object, or a reason it is not one. Empty text is an empty object. */
export function parseParams(text: string): { value?: Record<string, unknown>; error?: string } {
  if (!text.trim()) return { value: {} };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: 'Extra parameters must be a JSON object, like {"top_p": 0.9}.' };
    }
    return { value: parsed as Record<string, unknown> };
  } catch (cause) {
    return { error: `Not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
}

/** The number in a field, or undefined for empty or unparseable text (= unset). */
export function numberOrUndefined(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}
