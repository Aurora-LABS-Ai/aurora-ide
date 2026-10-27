/**
 * A model's reasoning choices as the picker lists them, and the short word a
 * row shows for the current one (pure).
 *
 * Every model's reasoning is one list in the effort flyout, whatever its kind:
 *
 *   effort  → Off (when it can be turned off), then its levels
 *   toggle  → Off, Thinking
 *   budget  → Off, then preset sizes, plus the stored size when it is none of them
 *
 * Choosing one writes the model's `reasoning` (what `updateModel` stores) and
 * picks the model. It is a property of the MODEL, every chat that uses it,
 * the same as the selected-model card it replaces.
 */

import { reasoningIsOn, type LLMModel } from "@/apps/agent/store/settings/useAgentSettingsStore";

import { budgetPresets, budgetRange, shortTokens } from "./budget";
import { levelLabel } from "./model-option";

export type Reasoning = NonNullable<LLMModel["reasoning"]>;

export interface ReasoningChoice {
  /** Stable within one model's list; used for keys and DOM ids. */
  key: string;
  label: string;
  /** What `updateModel` is given when this is chosen. */
  next: Reasoning;
  current: boolean;
}

export function reasoningChoices(r: Reasoning | undefined, maxOutputTokens?: number): ReasoningChoice[] {
  if (!r) return [];
  const on = reasoningIsOn(r);
  const canTurnOff = r.toggleable !== false;
  const off: ReasoningChoice[] = canTurnOff
    ? [{ key: "off", label: "Off", next: { ...r, enabled: false }, current: !on }]
    : [];

  if (r.type === "effort") {
    const levels = r.levels ?? [];
    if (levels.length === 0) return [];
    // "none" is a level some APIs accept; beside an explicit Off it would be
    // the same choice twice.
    const shown = canTurnOff ? levels.filter((l) => l.toLowerCase() !== "none") : levels;
    const chosen = String(r.default ?? levels[levels.length - 1] ?? "");
    return [
      ...off,
      ...shown.map((level) => ({
        key: `level:${level}`,
        label: levelLabel(level),
        next: { ...r, enabled: true, default: level },
        current: on && level === chosen,
      })),
    ];
  }

  if (r.type === "toggle") {
    return [...off, { key: "on", label: "Thinking", next: { ...r, enabled: true, default: true }, current: on }];
  }

  if (r.type === "budget") {
    const [min, max] = budgetRange(r, maxOutputTokens);
    const stored = Math.min(max, Math.max(min, typeof r.default === "number" ? r.default : min));
    const presets = budgetPresets(min, max);
    const sizes = presets.some((p) => p.value === stored)
      ? presets
      : [...presets, { value: stored, label: shortTokens(stored) }].sort((a, b) => a.value - b.value);
    return [
      ...off,
      ...sizes.map((p) => ({
        key: `budget:${p.value}`,
        label: p.label,
        next: { ...r, enabled: true, default: p.value },
        current: on && p.value === stored,
      })),
    ];
  }

  return [];
}

/**
 * How strongly a reasoning word is coloured, 0–4 (`data-effort` in CSS):
 * Off/Minimal/Low plain, then Medium, High (and a toggle's "Thinking"),
 * X-High, Max, each a stronger mix of the accent. A budget size ("8K") is not
 * a level and stays plain.
 */
export function effortTier(label: string | null | undefined): number {
  switch ((label ?? "").toLowerCase().replace(/[\s_-]/g, "")) {
    case "medium":
      return 1;
    case "high":
    case "thinking":
      return 2;
    case "xhigh":
      return 3;
    case "max":
      return 4;
    default:
      return 0;
  }
}

/** The word on a row: what the model will do if picked as it stands. */
export function reasoningSummary(r: Reasoning | undefined, maxOutputTokens?: number): string | null {
  const chosen = reasoningChoices(r, maxOutputTokens).find((c) => c.current);
  return chosen?.label ?? null;
}
