import { describe, expect, it } from "vitest";

import {
  DEFAULT_TEMPERATURE,
  resolveTemperature,
} from "@/apps/agent/services/runtime/model-request-config";
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

  it("falls back to Aurora's default when neither is set", () => {
    expect(resolveTemperature(model(undefined), undefined)).toBe(DEFAULT_TEMPERATURE);
    expect(resolveTemperature(null, undefined)).toBe(DEFAULT_TEMPERATURE);
  });

  /**
   * The whole reason this is a function and not a `??` chain: 0 is a real
   * setting — "be deterministic" — and `??` on a falsy-but-valid 0 would
   * silently promote it to the default the user was overriding.
   */
  it("keeps an explicit 0 at both levels", () => {
    expect(resolveTemperature(model(0), 0.9)).toBe(0);
    expect(resolveTemperature(model(undefined), 0)).toBe(0);
  });

  /** Not 1.0: this is a tool-calling loop, not chat. Not 0: that gets stuck. */
  it("defaults to 0.8", () => {
    expect(DEFAULT_TEMPERATURE).toBe(0.8);
  });
});
