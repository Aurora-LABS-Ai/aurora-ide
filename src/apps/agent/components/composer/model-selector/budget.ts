/**
 * Thinking-budget maths for budget-type reasoning models (pure).
 *
 * Moved out of the model selector so the slider, the presets and the share
 * line can be tested without rendering anything.
 */

import type { LLMModel } from "@/apps/agent/store/settings/useAgentSettingsStore";

/** Anthropic's hard floor for `thinking.budget_tokens`, and the practical floor
 *  for every other backend that accepts a budget. */
export const BUDGET_FLOOR = 1024;
const BUDGET_FALLBACK_CEILING = 32_000;

/** `16000` → `"16k"`, `1024` → `"1k"`. */
export const shortTokens = (n: number) =>
  n >= 1000 ? `${Math.round(n / 100) / 10}k`.replace(".0k", "k") : String(n);

/** The usable `[min, max]` for a budget model, with sane fallbacks when the
 *  model row carries only a partial range (models.dev often omits one end).
 *
 *  The ceiling is the output cap MINUS ONE: a thinking budget must be strictly
 *  below `max_tokens` or the provider rejects the request, so "Max" has to be a
 *  value the user can actually send. */
export function budgetRange(
  r: LLMModel["reasoning"],
  maxOutputTokens?: number,
): [number, number] {
  const min = Math.max(BUDGET_FLOOR, r?.min ?? BUDGET_FLOOR);
  const advertised = r?.max ?? maxOutputTokens ?? BUDGET_FALLBACK_CEILING;
  const capped = maxOutputTokens ? Math.min(advertised, maxOutputTokens - 1) : advertised;
  return [min, Math.max(min + 1, capped)];
}

/** Slider position (0–1000) ↔ token value, on a log scale.
 *
 *  Linear travel would spend the first 10% of the track on 1k–8k — where the
 *  meaningful choices actually live — and the remaining 90% on values nobody
 *  distinguishes. Log travel gives each doubling equal width. */
export const posToTokens = (pos: number, min: number, max: number) => {
  const raw = Math.exp(Math.log(min) + (pos / 1000) * (Math.log(max) - Math.log(min)));
  const step = raw >= 8000 ? 1000 : 500;
  return Math.min(max, Math.max(min, Math.round(raw / step) * step));
};

export const tokensToPos = (value: number, min: number, max: number) =>
  Math.round(
    ((Math.log(Math.min(max, Math.max(min, value))) - Math.log(min)) /
      (Math.log(max) - Math.log(min))) *
      1000,
  );

/** Preset stops offered under the slider, filtered to the model's own range.
 *  The top stop is always the model's maximum so "as much as it can" is one tap. */
export function budgetPresets(min: number, max: number): { value: number; label: string }[] {
  const stops = [4000, 8000, 16000, 32000, 64000].filter((v) => v > min && v < max).slice(0, 3);
  return [
    { value: min, label: shortTokens(min) },
    ...stops.map((v) => ({ value: v, label: shortTokens(v) })),
    { value: max, label: "Max" },
  ];
}
