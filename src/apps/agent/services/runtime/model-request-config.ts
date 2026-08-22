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
import { CURSOR_PROVIDER_ID } from "@/apps/agent/services/providers/cursor";
import { cursorWireModel } from "@/apps/agent/services/providers/cursor-variants";
import { isFastOn } from "@/apps/agent/lib/model/cursor-fast";

/** Fallback output cap when neither the model nor the provider sets one. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

/**
 * The temperature a turn should send: the model's own value, else the
 * provider's default, else **nothing at all**.
 *
 * Aurora used to substitute 0.8 here, so every request carried a sampling
 * setting nobody had chosen. That is not a neutral default — it overrides
 * whatever the provider documents for its own models, and some backends reject
 * the parameter or accept it only in a narrower form than a float gives you.
 * OpenCode's Go surface fails the whole request over decimal places.
 *
 * `undefined` means the field is omitted and the provider applies its own
 * default, which is what an untouched setting should do. Set one per model in
 * Settings → Providers when you actually want to.
 *
 * `0` is a legitimate setting — "be deterministic" — so this checks for a
 * number rather than truthiness; `??` on a `0` would discard it.
 */
export function resolveTemperature(
  model: LLMModel | null | undefined,
  providerDefault: number | undefined,
): number | undefined {
  if (typeof model?.temperature === "number") return model.temperature;
  if (typeof providerDefault === "number") return providerDefault;
  return undefined;
}

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

  const model = store.getModelFor(selection);
  const knobs = resolveModelRequestKnobs(config, model, thinkingPreference);

  applyCursorVariant(config, model, selection);

  return { providerConfig: config, ...knobs };
}

/**
 * Cursor: fold reasoning and Fast into the model **id**.
 *
 * Every other provider takes effort as a field in the request body. Cursor has
 * no such field — its account carries a separate id per effort tier, per
 * thinking mode, and per speed lane (`cursor-grok-4.6-high-fast`). There is no
 * plain `cursor-grok-4.6` to send with knobs attached; it does not exist.
 *
 * So the controls the user touched in the picker are resolved here into the
 * one id that expresses them, checked against the account's real catalogue so
 * a model with no fast twin is never sent `-fast`. And `reasoning_effort` is
 * dropped: Aurora set it a moment ago because the model row says "effort", but
 * on this wire it is a field nothing reads, and leaving it in the body would
 * be a control that looks connected and is not.
 *
 * A no-op for every other provider.
 */
export function applyCursorVariant(
  config: ProviderConfig,
  model: LLMModel | null | undefined,
  selection: string,
): void {
  if (config.id !== CURSOR_PROVIDER_ID) return;

  if (config.customParams && "reasoning_effort" in config.customParams) {
    const rest = { ...config.customParams };
    delete rest.reasoning_effort;
    config.customParams = Object.keys(rest).length > 0 ? rest : undefined;
  }

  const reasoning = model?.reasoning;
  const on = reasoning ? reasoningIsOn(reasoning) : false;

  config.model = cursorWireModel(config.model, {
    // `toggleable: false` models have thinking ids and nothing else, so the
    // switch is absent and thinking is simply how they run.
    thinking: reasoning ? on : undefined,
    effort:
      reasoning?.type === "effort" && on && typeof reasoning.default === "string"
        ? reasoning.default
        : undefined,
    fast: isFastOn(selection),
  });
}
