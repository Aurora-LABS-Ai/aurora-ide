import { describe, expect, it } from "vitest";

import { resolveTemperature } from "@/apps/agent/services/runtime/model-request-config";
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
