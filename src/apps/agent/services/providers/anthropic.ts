/**
 * Anthropic — the built-in row for Anthropic's own API, on a console key.
 *
 * Its provider type is `anthropic-api`, not `anthropic`. `anthropic` is the
 * Messages WIRE that many gateways also speak, and this row sends fields only
 * Anthropic accepts (refusal fallbacks, the thinking-binding control), which a
 * gateway would answer with a 400. The Rust side is `src-tauri/src/api/anthropic_api/`.
 */

import type { LLMModel, LLMProvider } from "@/apps/agent/store/settings/useAgentSettingsStore";

/** The provider type the built-in row carries. */
export const ANTHROPIC_API_TYPE = "anthropic-api";

/** Whether this row is the built-in Anthropic API row. */
export function isAnthropicApiProvider(
  provider: Pick<LLMProvider, "id" | "providerType">,
): boolean {
  return provider.providerType === ANTHROPIC_API_TYPE;
}

// ── Prompt cache length ──────────────────────────────────────────────────────

/**
 * The row setting, kept in the provider's custom params under the same key
 * the Rust adapter reads (`anthropic_api::PROMPT_CACHE_TTL_PARAM`). Rust
 * strips it before the request body is sent.
 */
export const PROMPT_CACHE_TTL_PARAM = "prompt_cache_ttl";

export type PromptCacheTtl = "5m" | "1h";

/** Offered in this order; the first is Anthropic's default. */
export const PROMPT_CACHE_TTLS: ReadonlyArray<{
  value: PromptCacheTtl;
  label: string;
  /** Shown under the picker, so the choice is made with its cost visible. */
  detail: string;
}> = [
  {
    value: "5m",
    label: "5 minutes",
    detail:
      "Anthropic's default. Saving the reused part of a request costs 1.25× input, reading it back costs a tenth. A break longer than 5 minutes saves it again.",
  },
  {
    value: "1h",
    label: "1 hour",
    detail:
      "Survives breaks of up to an hour, so coming back does not pay for the whole conversation again. Saving costs 2× input instead of 1.25×; reading it back still costs a tenth.",
  },
];

/** The cache length this row is set to. Anything unrecognised is the default. */
export function promptCacheTtl(provider: Pick<LLMProvider, "customParams">): PromptCacheTtl {
  return provider.customParams?.[PROMPT_CACHE_TTL_PARAM] === "1h" ? "1h" : "5m";
}

/**
 * The row's custom params with the cache length set. The default is stored as
 * no key at all, so a row that never touched the setting stays as it was.
 */
export function withPromptCacheTtl(
  customParams: Record<string, unknown> | undefined,
  ttl: PromptCacheTtl,
): Record<string, unknown> | undefined {
  const next = { ...(customParams ?? {}) };
  if (ttl === "1h") {
    next[PROMPT_CACHE_TTL_PARAM] = "1h";
  } else {
    delete next[PROMPT_CACHE_TTL_PARAM];
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * What a cache WRITE costs on this model, per 1M tokens.
 *
 * The model row holds the five-minute rate (1.25× input). With the one-hour
 * cache on, Anthropic bills writes at 2× input, and pricing them at the row's
 * figure would under-report every write by more than a third.
 */
export function cacheWritePerMtok(
  provider: Pick<LLMProvider, "providerType" | "customParams"> | undefined,
  model: Pick<LLMModel, "priceCacheWritePerMtok" | "priceCacheMissPerMtok">,
): number | undefined {
  if (
    provider?.providerType === ANTHROPIC_API_TYPE &&
    promptCacheTtl(provider) === "1h" &&
    typeof model.priceCacheMissPerMtok === "number"
  ) {
    return model.priceCacheMissPerMtok * 2;
  }
  return model.priceCacheWritePerMtok;
}
