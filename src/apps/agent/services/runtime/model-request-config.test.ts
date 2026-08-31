import { beforeEach, describe, expect, it } from "vitest";

import {
  applyCursorVariant,
  applyOpenCodeWire,
  resolveModelRequest,
  resolveModelRequestKnobs,
  resolveTemperature,
} from "@/apps/agent/services/runtime/model-request-config";
import { resetFastPreferenceCache, setFastOn } from "@/apps/agent/lib/model/cursor-fast";
import { CURSOR_PROVIDER_ID, type CursorModelView } from "@/apps/agent/services/providers/cursor";
import {
  clearCursorVariants,
  primeCursorVariants,
} from "@/apps/agent/services/providers/cursor-variants";
import { OPENCODE_PROVIDER_ID } from "@/apps/agent/services/providers/opencode";
import type { ProviderConfig } from "@/kernel/services/providers/types";
import {
  useSettingsStore,
  type LLMModel,
  type LLMProvider,
} from "@/kernel/store/useSettingsStore";

const model = (temperature?: number): LLMModel =>
  ({
    id: "p::m",
    providerId: "p",
    modelKey: "m",
    supportsVision: false,
    supportsThinking: false,
    supportsToolStream: false,
    enabled: true,
    sortOrder: 0,
    temperature,
  }) as LLMModel;

describe("resolveTemperature", () => {
  it("prefers the model's own value over the provider's", () => {
    expect(resolveTemperature(model(0.2), 0.9)).toBe(0.2);
  });

  it("falls back to the provider default when the model has none", () => {
    expect(resolveTemperature(model(undefined), 0.9)).toBe(0.9);
  });

  /**
   * Aurora used to substitute 0.8 here, so every request carried a sampling
   * setting nobody had chosen — overriding whatever the provider documents for
   * its own models, and getting requests rejected outright by backends that
   * are strict about the field. Untouched must mean untouched.
   */
  it("sends nothing when neither the model nor the provider set one", () => {
    expect(resolveTemperature(model(undefined), undefined)).toBeUndefined();
    expect(resolveTemperature(null, undefined)).toBeUndefined();
  });

  /**
   * The whole reason this is a function and not a `??` chain: 0 is a real
   * setting — "be deterministic" — and `??` on a falsy-but-valid 0 would
   * discard it and fall through to sending nothing.
   */
  it("keeps an explicit 0 at both levels", () => {
    expect(resolveTemperature(model(0), 0.9)).toBe(0);
    expect(resolveTemperature(model(undefined), 0)).toBe(0);
  });
});

// ── Provider-neutral reasoning contract ────────────────────────────────────

const reasoningConfig = (): ProviderConfig =>
  ({
    id: "gateway",
    name: "Gateway",
    providerType: "openai",
    model: "reasoner",
    supportsThinking: true,
  }) as ProviderConfig;

describe("resolveModelRequestKnobs", () => {
  it("keeps effort reasoning enabled without inventing a wire field", () => {
    const cfg = reasoningConfig();
    const row = {
      ...model(),
      supportsThinking: true,
      reasoning: {
        type: "effort" as const,
        levels: ["low", "high"],
        default: "high",
        toggleable: false,
        requestMode: "openai-effort" as const,
      },
    };

    const resolved = resolveModelRequestKnobs(cfg, row, true);

    expect(resolved.reasoning).toEqual({
      enabled: true,
      control: "effort",
      effort: "high",
      budgetTokens: undefined,
      requestMode: "openai-effort",
      replay: "auto",
    });
    expect(cfg.reasoning).toEqual(resolved.reasoning);
    expect(cfg.customParams).toBeUndefined();
  });

  it("migrates the old replay directive into the typed contract", () => {
    const cfg = reasoningConfig();
    const row = {
      ...model(),
      supportsThinking: true,
      reasoning: {
        type: "toggle" as const,
        default: true,
        toggleable: true,
      },
      extraBody: {
        reasoning_replay: "reasoning_content",
        top_p: 0.9,
      },
    };

    const resolved = resolveModelRequestKnobs(cfg, row, true);

    expect(resolved.reasoning.replay).toBe("reasoning_content");
    expect(cfg.customParams).toEqual({ top_p: 0.9 });
    expect(cfg.customParams).not.toHaveProperty("reasoning_replay");
  });

  it("preserves an explicit budget and request-shape override", () => {
    const cfg = reasoningConfig();
    const row = {
      ...model(),
      supportsThinking: true,
      reasoning: {
        type: "budget" as const,
        default: 12_000,
        toggleable: true,
        requestMode: "anthropic-budget" as const,
        replay: "off" as const,
      },
    };

    const resolved = resolveModelRequestKnobs(cfg, row, true);

    expect(resolved.reasoning).toMatchObject({
      enabled: true,
      control: "budget",
      budgetTokens: 12_000,
      requestMode: "anthropic-budget",
      replay: "off",
    });
  });
});

describe("resolveModelRequest", () => {
  it("keeps a fallback provider, model profile, and model-level wire together", () => {
    const previous = useSettingsStore.getState();
    const provider = {
      id: "active",
      name: "Mixed gateway",
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      model: "reasoner",
      providerType: "openai",
      contextWindow: 128_000,
      maxOutputTokens: 16_000,
      supportsThinking: true,
      supportsToolStream: true,
      enabled: true,
    } as LLMProvider;
    const activeModel = {
      ...model(),
      id: "active::reasoner",
      providerId: "active",
      modelKey: "reasoner",
      providerType: "openai-responses",
      supportsThinking: true,
      reasoning: {
        type: "effort" as const,
        levels: ["low", "high"],
        default: "high",
      },
    };

    useSettingsStore.setState({
      providers: [provider],
      models: [activeModel],
      selectedModel: "active:reasoner",
    });

    try {
      // The saved selection no longer exists. The store falls back to the
      // active config; the request resolver must fall back as one whole unit.
      const resolved = resolveModelRequest("deleted:model", true);
      expect(resolved?.model).toBe(activeModel);
      expect(resolved?.providerConfig.id).toBe("active");
      expect(resolved?.providerConfig.model).toBe("reasoner");
      expect(resolved?.providerConfig.providerType).toBe("openai-responses");
      expect(resolved?.reasoning).toMatchObject({
        enabled: true,
        control: "effort",
        effort: "high",
      });
    } finally {
      useSettingsStore.setState({
        providers: previous.providers,
        models: previous.models,
        selectedModel: previous.selectedModel,
      });
    }
  });
});

// ── Cursor: stable row to exact wire id ─────────────────────────────────────

const cursorView = (modelId: string): CursorModelView => ({
  modelId,
  displayModelId: null,
  displayName: null,
  displayNameShort: null,
  aliases: [],
  supportsThinking: false,
  maxMode: false,
  enabled: true,
  sortOrder: 0,
  baseModelId: modelId.replace(/-fast$/, ""),
  isFast: modelId.endsWith("-fast"),
  catalogKey: null,
  isLegacy: false,
});

const cursorConfig = (
  modelKey: string,
  customParams?: Record<string, unknown>,
): ProviderConfig => ({
  id: CURSOR_PROVIDER_ID,
  name: "Cursor",
  providerType: "cursor",
  apiKey: "",
  baseUrl: "https://api2.cursor.sh",
  model: modelKey,
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  supportsThinking: true,
  supportsToolStream: true,
  supportsVision: true,
  customParams,
});

describe("applyCursorVariant", () => {
  beforeEach(() => {
    localStorage.clear();
    resetFastPreferenceCache();
    clearCursorVariants();
  });

  it("sends the exact catalogue id while keeping Cursor knobs out of the body", () => {
    primeCursorVariants(
      ["cursor-grok-4.6-high", "cursor-grok-4.6-high-fast"].map(cursorView),
    );
    const row = {
      ...model(),
      id: "cursor::cursor-grok-4.6",
      providerId: CURSOR_PROVIDER_ID,
      modelKey: "cursor-grok-4.6",
      reasoning: {
        type: "effort" as const,
        levels: ["high"],
        default: "high",
        toggleable: false,
      },
    };
    setFastOn(row.id, true);
    const cfg = cursorConfig(row.modelKey, {
      reasoning_effort: "high",
      keep: true,
    });

    applyCursorVariant(cfg, row);

    expect(cfg.model).toBe("cursor-grok-4.6-high-fast");
    expect(cfg.customParams).toEqual({ keep: true });
  });

  it("fails instead of silently dropping an unsupported Fast choice", () => {
    primeCursorVariants([cursorView("gpt-5.4-low")]);
    const row = {
      ...model(),
      id: "cursor::gpt-5.4",
      providerId: CURSOR_PROVIDER_ID,
      modelKey: "gpt-5.4",
      reasoning: {
        type: "effort" as const,
        levels: ["low"],
        default: "low",
        toggleable: false,
      },
    };
    setFastOn(row.id, true);
    const cfg = cursorConfig(row.modelKey);

    expect(() => applyCursorVariant(cfg, row)).toThrow(/does not offer.*Fast/i);
  });
});

// ── OpenCode Go: the wire comes from the model ───────────────────────────────

const ocModel = (modelKey: string, providerType?: string): LLMModel =>
  ({
    id: `${OPENCODE_PROVIDER_ID}::${modelKey}`,
    providerId: OPENCODE_PROVIDER_ID,
    modelKey,
    supportsVision: false,
    supportsThinking: false,
    supportsToolStream: true,
    enabled: true,
    sortOrder: 0,
    providerType,
  }) as LLMModel;

const config = (id: string, providerType: string, modelKey = "glm-5.2"): ProviderConfig =>
  ({ id, providerType, model: modelKey }) as ProviderConfig;

describe("applyOpenCodeWire", () => {
  it("sends each model to the wire it actually answers on", () => {
    const chat = config(OPENCODE_PROVIDER_ID, "opencode-go", "glm-5.2");
    applyOpenCodeWire(chat, ocModel("glm-5.2"));
    expect(chat.providerType).toBe("opencode-go-chat");

    const messages = config(OPENCODE_PROVIDER_ID, "opencode-go", "qwen3.7-plus");
    applyOpenCodeWire(messages, ocModel("qwen3.7-plus"));
    expect(messages.providerType).toBe("opencode-go-messages");

    const responses = config(OPENCODE_PROVIDER_ID, "opencode-go-chat", "gpt-5.6-luna");
    applyOpenCodeWire(responses, ocModel("gpt-5.6-luna"));
    expect(responses.providerType).toBe("opencode-go");
  });

  /**
   * The regression this replaces. The row-level type used to decide the wire
   * for every model under it, so one setting was wrong for every family but
   * one — and the shipped default (`glm-5.2` on Responses) returned 500 on the
   * first turn of a correctly configured install.
   */
  it("overrules the row's own type rather than deferring to it", () => {
    const cfg = config(OPENCODE_PROVIDER_ID, "opencode-go", "glm-5.2");
    applyOpenCodeWire(cfg, ocModel("glm-5.2"));
    expect(cfg.providerType).not.toBe("opencode-go");
  });

  it("honours a per-model override", () => {
    const cfg = config(OPENCODE_PROVIDER_ID, "opencode-go", "glm-5.2");
    applyOpenCodeWire(cfg, ocModel("glm-5.2", "opencode-go-messages"));
    expect(cfg.providerType).toBe("opencode-go-messages");
  });

  /** A key typed straight into the provider's Model field creates no model row. */
  it("falls back to the config's model id when there is no model row", () => {
    const cfg = config(OPENCODE_PROVIDER_ID, "opencode-go", "qwen3.8-max");
    applyOpenCodeWire(cfg, null);
    expect(cfg.providerType).toBe("opencode-go-messages");
  });

  it("leaves every other provider untouched", () => {
    const cfg = config("openai", "openai-responses", "gpt-5.6-luna");
    applyOpenCodeWire(cfg, ocModel("gpt-5.6-luna"));
    expect(cfg.providerType).toBe("openai-responses");
  });
});
