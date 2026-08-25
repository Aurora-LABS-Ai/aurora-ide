import { describe, expect, it } from "vitest";

import {
  applyOpenCodeWire,
  resolveTemperature,
} from "@/apps/agent/services/runtime/model-request-config";
import { OPENCODE_PROVIDER_ID } from "@/apps/agent/services/providers/opencode";
import type { ProviderConfig } from "@/kernel/services/providers/types";
import type { LLMModel } from "@/kernel/store/useSettingsStore";

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
