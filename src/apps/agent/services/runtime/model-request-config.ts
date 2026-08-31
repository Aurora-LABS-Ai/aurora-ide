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
import type {
  ProviderConfig,
  ReasoningRequestConfig,
} from "@/kernel/services/providers/types";
import type { ReasoningReplayMode } from "@/kernel/types/database";
import { CURSOR_PROVIDER_ID } from "@/apps/agent/services/providers/cursor";
import { resolveCursorModelRun } from "@/apps/agent/services/providers/cursor-run";
import { cursorVariantFailureMessage } from "@/apps/agent/services/providers/cursor-variants";
import {
  openCodeWireFor,
  OPENCODE_PROVIDER_ID,
} from "@/apps/agent/services/providers/opencode";

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
  /** The one provider-neutral reasoning contract every request path uses. */
  reasoning: ReasoningRequestConfig;
  /** @deprecated Read `reasoning.enabled`. Kept for old callers during cutover. */
  thinkingEnabled: boolean;
  /** @deprecated Read `reasoning.budgetTokens`. */
  thinkingBudgetTokens: number | undefined;
}

function legacyReplayMode(model: LLMModel | null | undefined): ReasoningReplayMode {
  const value = model?.extraBody?.["reasoning_replay"];
  if (value === false) return "off";
  if (typeof value !== "string") return "auto";
  const normalized = value.trim().toLowerCase();
  if (normalized === "reasoning_content" || normalized === "reasoning") {
    return normalized;
  }
  return ["off", "none", "drop", "false"].includes(normalized) ? "off" : "auto";
}

/**
 * Fold a model row's reasoning settings and extra body fields into
 * `providerConfig`, and report the semantic reasoning request the runtime
 * needs. This function does not encode an API body. Rust's selected adapter
 * owns that translation.
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
  let thinkingBudgetTokens: number | undefined;
  let effort: string | undefined;

  if (reasoning) {
    const on = reasoningIsOn(reasoning);
    if (reasoning.type === "budget" && on && typeof reasoning.default === "number") {
      thinkingBudgetTokens = reasoning.default;
    }
    if (reasoning.type === "effort") {
      // This is semantic state, not a decision to emit a `thinking` object.
      // The old code set this false to avoid sending both fields on OpenAI
      // Chat Completions. That also disabled Responses summaries and the
      // DeepSeek adapter's own reasoning branch. Keep intent true here and let
      // each adapter choose the field it actually supports.
      thinkingEnabled = on;
      if (on && reasoning.default) {
        effort = String(reasoning.default);
      }
    } else {
      thinkingEnabled = on;
    }
  }

  const resolvedReasoning: ReasoningRequestConfig = {
    enabled: !!providerConfig.supportsThinking && thinkingEnabled,
    control: reasoning?.type ?? (providerConfig.supportsThinking ? "toggle" : "none"),
    effort,
    budgetTokens: thinkingBudgetTokens,
    requestMode: reasoning?.requestMode ?? "auto",
    replay: reasoning?.replay ?? legacyReplayMode(model),
  };
  providerConfig.reasoning = resolvedReasoning;

  // Manual escape hatch: merge the model's extra request-body fields verbatim.
  // These are applied LAST by the Rust adapter so a user can override anything
  // per model — e.g. add
  // `{ "thinking": { "type": "enabled" } }` for a provider we don't special-case.
  if (model?.extraBody && Object.keys(model.extraBody).length > 0) {
    // `reasoning_replay` used to be smuggled through this map. It now has a
    // typed home above and must never look like an upstream API parameter.
    const wireFields = { ...model.extraBody };
    delete wireFields.reasoning_replay;
    providerConfig.customParams = {
      ...(providerConfig.customParams || {}),
      ...wireFields,
    };
  }

  return {
    reasoning: resolvedReasoning,
    thinkingEnabled: resolvedReasoning.enabled,
    thinkingBudgetTokens: resolvedReasoning.budgetTokens,
  };
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
): { providerConfig: ProviderConfig; model: LLMModel | null } & ResolvedModelKnobs | null {
  const store = useSettingsStore.getState();
  const resolved = store.getLLMConfigFor(selection);
  if (!resolved) return null;

  // Clone before mutating: `getLLMConfigFor` may hand back objects that
  // share `customParams` with the provider row.
  const config: ProviderConfig = {
    ...withProviderDefaults(resolved),
    customParams: resolved.customParams ? { ...resolved.customParams } : undefined,
  };

  // `getLLMConfigFor` deliberately falls back to the active provider when a
  // saved selection was deleted. Resolve the model row from the config it
  // actually returned, not blindly from the stale selection, or the fallback
  // would send the active model with no reasoning profile of its own.
  const selectedModel = store.getModelFor(selection);
  const model =
    selectedModel?.providerId === config.id && selectedModel.modelKey === config.model
      ? selectedModel
      : store.models.find(
          (candidate) =>
            candidate.providerId === config.id && candidate.modelKey === config.model,
        ) ?? null;
  const knobs = resolveModelRequestKnobs(config, model, thinkingPreference);

  applyCursorVariant(config, model);
  applyOpenCodeWire(config, model);

  return { providerConfig: config, model, ...knobs };
}

/**
 * OpenCode Go: pick the wire from the **model**, not the provider row.
 *
 * One base URL and one key answer `/chat/completions`, `/messages` and
 * `/responses`, and each model accepts only its own. A row-wide type is
 * therefore wrong for every family but one, and wrong loudly: GLM on Responses
 * is a 500, GPT 5.6 Luna on Chat is a 500, and a Qwen id on Responses is a 401
 * that reads as a rejected key.
 *
 * Resolution is override first, then the id's documented default. The row's own
 * `providerType` is deliberately not consulted — if it were, a row left on one
 * format would keep overriding models that cannot speak it, which is the bug
 * this replaces.
 *
 * A no-op for every other provider.
 */
export function applyOpenCodeWire(
  config: ProviderConfig,
  model: LLMModel | null | undefined,
): void {
  if (config.id !== OPENCODE_PROVIDER_ID) return;

  // `config.model` rather than `model.modelKey`: the turn sends that id, and a
  // row can exist with no model record behind it (a key typed straight into the
  // provider's Model field never creates one).
  config.providerType = openCodeWireFor({
    modelKey: model?.modelKey || config.model,
    providerType: model?.providerType,
  });
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
 * an unsupported combination fails before the request starts. And `reasoning_effort` is
 * dropped: Aurora set it a moment ago because the model row says "effort", but
 * on this wire it is a field nothing reads, and leaving it in the body would
 * be a control that looks connected and is not.
 *
 * A no-op for every other provider.
 */
export function applyCursorVariant(
  config: ProviderConfig,
  model: LLMModel | null | undefined,
): void {
  if (config.id !== CURSOR_PROVIDER_ID) return;

  if (config.customParams && "reasoning_effort" in config.customParams) {
    const rest = { ...config.customParams };
    delete rest.reasoning_effort;
    config.customParams = Object.keys(rest).length > 0 ? rest : undefined;
  }

  const resolved = resolveCursorModelRun(
    model ?? { modelKey: config.model },
  );
  if (!resolved.ok) throw new Error(cursorVariantFailureMessage(resolved));
  config.model = resolved.wireModel;
}
