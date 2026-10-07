import {
  buildProviderConfigForSelection,
  resolveModel,
  type LLMProvider,
} from "../provider-model";
import type { SettingsGet, SettingsState } from "../state";

/** Resolving the selected and compaction models into provider configs. */
export const createLlmConfigSlice = (get: SettingsGet) =>
  ({
  // Get current LLM provider config based on selectedModel.
  //
  // v15+: capability flags (supportsVision, supportsThinking,
  // supportsToolStream) and per-model context/output overrides come
  // from the resolved active `LLMModel`, not from the provider row.
  // This is what drives `browser_screenshot` tool gating in
  // agent-service and `<aurora_image>` routing in the API adapters.
  getLLMConfig: () => {
    const state = get();
    const [providerId, modelKey] = state.selectedModel.split(":");
    const provider = state.providers.find(
      (p: LLMProvider) => p.id === providerId,
    );
    const activeModel =
      provider &&
      state.models.find(
        (m) => m.providerId === providerId && m.modelKey === modelKey,
      );

    if (provider) {
      const resolved = activeModel ? resolveModel(activeModel, provider) : undefined;
      return {
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        apiKeys: provider.apiKeys,
        model: resolved?.modelKey || modelKey || provider.model,
        maxOutputTokens: resolved?.resolvedMaxOutputTokens ?? provider.maxOutputTokens,
        contextWindow: resolved?.resolvedContextWindow ?? provider.contextWindow,
        supportsThinking: resolved?.supportsThinking ?? false,
        supportsToolStream:
          resolved?.supportsToolStream ?? provider.supportsToolStream ?? false,
        supportsVision: resolved?.supportsVision ?? false,
        providerType:
          (resolved?.providerType as LLMProvider["providerType"] | undefined) ??
          provider.providerType ??
          "custom",
        customHeaders: provider.customHeaders,
        customParams: provider.customParams,
        defaultTemperature: provider.defaultTemperature,
        // Explicit override only — see `toLlmConfig`. Falling back to the
        // provider row here lets a stale 8192 outrank the per-model cap.
        defaultMaxTokens: provider.defaultMaxTokens ?? undefined,
      };
    }

    // Fallback to first available provider with API key
    const fallback = state.providers.find(
      (p: LLMProvider) => p.enabled && p.apiKey,
    );
    if (fallback) {
      const fallbackModel = state.models
        .filter((m) => m.providerId === fallback.id && m.enabled)
        .sort((a, b) => a.sortOrder - b.sortOrder)[0];
      const resolved = fallbackModel
        ? resolveModel(fallbackModel, fallback)
        : undefined;
      return {
        id: fallback.id,
        name: fallback.name,
        baseUrl: fallback.baseUrl,
        apiKey: fallback.apiKey,
        apiKeys: fallback.apiKeys,
        model: resolved?.modelKey || fallback.model,
        maxOutputTokens: resolved?.resolvedMaxOutputTokens ?? fallback.maxOutputTokens,
        contextWindow: resolved?.resolvedContextWindow ?? fallback.contextWindow,
        supportsThinking: resolved?.supportsThinking ?? false,
        supportsToolStream:
          resolved?.supportsToolStream ?? fallback.supportsToolStream ?? false,
        supportsVision: resolved?.supportsVision ?? false,
        providerType:
          (resolved?.providerType as LLMProvider["providerType"] | undefined) ??
          fallback.providerType ??
          "custom",
        customHeaders: fallback.customHeaders,
        customParams: fallback.customParams,
        defaultTemperature: fallback.defaultTemperature,
        // Explicit override only — see `toLlmConfig`.
        defaultMaxTokens: fallback.defaultMaxTokens ?? undefined,
      };
    }

    // No provider available
    return null;
  },

  getLLMConfigFor: (selection) => {
    if (!selection) return get().getLLMConfig();
    const { providers, models } = get();
    return (
      buildProviderConfigForSelection(selection, providers, models) ??
      get().getLLMConfig()
    );
  },

  // Returns `null` rather than falling back to the chat config, because the
  // runtime already summarizes on the conversation's own model when it gets
  // no override — and an unresolvable pin (deleted provider) must degrade to
  // that same default rather than to whichever model is selected right now.
  getCompactionConfig: () => {
    const { compactionModel, providers, models } = get();
    if (!compactionModel) return null;
    return buildProviderConfigForSelection(compactionModel, providers, models);
  },
  }) satisfies Partial<SettingsState>;
