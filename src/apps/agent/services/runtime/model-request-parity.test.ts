import { describe, expect, it } from "vitest";
import fixtureData from "@/kernel/services/providers/model-request-fixtures.json";

import { resolveModelRequestKnobs } from "./model-request-config";
import type { LLMModel } from "@/apps/agent/store/settings/useAgentSettingsStore";
import type { ProviderConfig, ReasoningRequestConfig } from "@/kernel/services/providers/types";
import type { ModelReasoning } from "@/kernel/types/database";

interface Fixture {
  name: string;
  supportsThinking: boolean;
  thinkingPreference: boolean;
  reasoning?: ModelReasoning;
  extraBody?: Record<string, unknown>;
  expected: Omit<ReasoningRequestConfig, "effort" | "budgetTokens"> & {
    effort: string | null;
    budgetTokens: number | null;
  };
}

const fixtures = fixtureData as Fixture[];

describe("backend and frontend model request parity", () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      const row: LLMModel = {
        id: "p::m", providerId: "p", modelKey: "m", supportsThinking: fixture.supportsThinking,
        supportsVision: false, supportsToolStream: false, enabled: true, sortOrder: 0,
        reasoning: fixture.reasoning, extraBody: fixture.extraBody,
      };
      const config: ProviderConfig = {
        id: "p", name: "Provider", apiKey: "test", baseUrl: "https://example.invalid", model: "m",
        supportsThinking: fixture.supportsThinking, supportsToolStream: false, supportsVision: false,
        providerType: "openai", contextWindow: 128000, maxOutputTokens: 16000,
      };
      const resolved = resolveModelRequestKnobs(config, row, fixture.thinkingPreference);
      expect({ ...resolved.reasoning,
        effort: resolved.reasoning.effort ?? null,
        budgetTokens: resolved.reasoning.budgetTokens ?? null,
      }).toEqual(fixture.expected);
      expect(config.customParams ?? {}).not.toHaveProperty("reasoning_replay");
    });
  }
});
