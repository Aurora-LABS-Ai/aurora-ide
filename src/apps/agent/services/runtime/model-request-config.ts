/**
 * Per-model request resolution — the single place that turns a model row's
 * reasoning config and Extra request fields into the knobs a turn actually
 * sends.
 *
 * This exists as its own module because two callers must agree exactly:
 * the real turn (`useAgentWindowSend`) and the provider settings
 * connection test. A test that resolved reasoning differently from a turn
 * would report "working" for a configuration that then fails in use —
 * worse than having no test at all.
 */

import {
  reasoningIsOn,
  useSettingsStore,
  type LLMModel,
} from "@/kernel/store/useSettingsStore";
import type { ProviderConfig } from "@/kernel/services/providers/types";

/** Fallback output cap when neither the model nor the provider sets one. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

/**
 * Fill in the fields the runtime treats as required. Shared so the
 * connection test sends the same normalized config a turn sends.
 */
export function withProviderDefaults(config: ProviderConfig): ProviderConfig {
  return {
    ...config,
    providerType: config.providerType || "custom",
    contextWindow: config.contextWindow || 128_000,
    maxOutputTokens: config.maxOutputTokens || DEFAULT_MAX_OUTPUT_TOKENS,
    supportsThinking: config.supportsThinking ?? false,
    supportsToolStream: config.supportsToolStream ?? false,
    supportsVision: config.supportsVision ?? false,
  };
}

export interface ResolvedModelKnobs {
  /** Drives the provider's native `thinking` field. */
  thinkingEnabled: boolean;
  /** Only set for budget-style reasoning models. */
  thinkingBudgetTokens: number | undefined;
}

/**
 * Fold a model row's reasoning settings and extra body fields into
 * `providerConfig`, and report the thinking knobs the runtime needs.
 *
 * Mutates `providerConfig.customParams` — callers pass a config they own.
 *
 * @param thinkingPreference the user's global thinking toggle. A model
 *   that has no reasoning config at all still honours it.
 */
export function resolveModelRequestKnobs(
  providerConfig: ProviderConfig,
  model: LLMModel | null | undefined,
  thinkingPreference: boolean,
): ResolvedModelKnobs {
  const reasoning = model?.reasoning;
  let thinkingEnabled = thinkingPreference && (providerConfig.supportsThinking ?? false);
  // Budget models carry a token number instead of a tier. It rides its own
  // field to the runtime (NOT customParams) because the wire shape differs
  // per provider: Anthropic wants `thinking.budget_tokens`, OpenAI-compat
  // backends mostly want nothing at all.
  let thinkingBudgetTokens: number | undefined;

  if (reasoning) {
    const on = reasoningIsOn(reasoning);
    if (reasoning.type === "budget" && on && typeof reasoning.default === "number") {
      thinkingBudgetTokens = reasoning.default;
    }
    if (reasoning.type === "effort") {
      // Effort models control reasoning with `reasoning_effort` — NOT the
      // `thinking` field. Sending BOTH is rejected by some providers
      // ("cannot specify both 'thinking' and 'reasoning_effort'"), so we never
      // set the `thinking` field for an effort model; the effort level alone
      // turns reasoning on. (A provider that also wants `thinking` can add it
      // via the model's Extra request fields.)
      thinkingEnabled = false;
      if (on && reasoning.default) {
        providerConfig.customParams = {
          ...(providerConfig.customParams || {}),
          // The EXACT level the user picked (low/medium/high/xhigh) — verbatim.
          reasoning_effort: String(reasoning.default),
        };
      }
    } else {
      // toggle / budget — the `thinking` field is the on/off control.
      thinkingEnabled = on;
    }
  }

  // Manual escape hatch: merge the model's extra request-body fields verbatim.
  // These are applied LAST so a user can override anything (including the
  // structured `reasoning_effort` above) per model — e.g. add
  // `{ "thinking": { "type": "enabled" } }` for a provider we don't special-case.
  if (model?.extraBody && Object.keys(model.extraBody).length > 0) {
    providerConfig.customParams = {
      ...(providerConfig.customParams || {}),
      ...model.extraBody,
    };
  }

  return { thinkingEnabled, thinkingBudgetTokens };
}

/**
 * Everything needed to fire one request for a `"providerId:modelKey"`
 * selection, resolved exactly as a real turn resolves it.
 *
 * Returns `null` when the selection names no configured provider.
 */
export function resolveModelRequest(
  selection: string,
  thinkingPreference: boolean,
): { providerConfig: ProviderConfig } & ResolvedModelKnobs | null {
  const store = useSettingsStore.getState();
  const resolved = store.getLLMConfigFor(selection);
  if (!resolved) return null;

  // Clone before mutating: `getLLMConfigFor` may hand back objects that
  // share `customParams` with the provider row.
  const config: ProviderConfig = {
    ...withProviderDefaults(resolved),
    customParams: resolved.customParams ? { ...resolved.customParams } : undefined,
  };

  const knobs = resolveModelRequestKnobs(
    config,
    store.getModelFor(selection),
    thinkingPreference,
  );

  return { providerConfig: config, ...knobs };
}
