/**
 * Agent Window — can this language provider be called right now?
 *
 * A leaf (no JSX) shared by the provider detail and the Providers page tiles,
 * so "ready" means one thing everywhere: switched on, and either local, or
 * not needing a key, or holding at least one non-blank key (single field or
 * pool).
 */

import type { LLMProvider } from "@/apps/agent/store/settings/provider-model";

export function hasAnyKey(p: LLMProvider): boolean {
  if (p.apiKey.trim().length > 0) return true;
  return !!p.apiKeys && p.apiKeys.some((k) => k.trim().length > 0);
}

export function providerReady(p: LLMProvider): boolean {
  if (!p.enabled) return false;
  const local = /localhost|127\.0\.0\.1/.test(p.baseUrl.toLowerCase());
  return local || p.requiresApiKey === false || hasAnyKey(p);
}

/** A provider tile's one line, truthful about why it cannot be used yet. */
export function providerLine(provider: LLMProvider, modelCount: number): string {
  if (!provider.enabled) return "Disabled";
  if (!providerReady(provider)) return "No key";
  return `${modelCount} ${modelCount === 1 ? "model" : "models"}`;
}
