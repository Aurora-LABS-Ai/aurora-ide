import { describe, expect, it } from "vitest";

import {
  PROVIDER_DESCRIPTION_MAX,
  normalizeProviderDescription,
} from "@/kernel/store/useSettingsStore";

describe("a provider's description", () => {
  it("is one line with its whitespace collapsed", () => {
    expect(normalizeProviderDescription("  team\n account   for  evals ")).toBe(
      "team account for evals",
    );
  });

  it("is nothing when nothing was written", () => {
    expect(normalizeProviderDescription("")).toBeUndefined();
    expect(normalizeProviderDescription("   \n ")).toBeUndefined();
    expect(normalizeProviderDescription(null)).toBeUndefined();
    expect(normalizeProviderDescription(undefined)).toBeUndefined();
  });

  it("is capped at 150 characters, counted as characters and not bytes", () => {
    const long = "é".repeat(PROVIDER_DESCRIPTION_MAX + 40);
    const capped = normalizeProviderDescription(long);
    expect(Array.from(capped ?? "")).toHaveLength(PROVIDER_DESCRIPTION_MAX);
  });
});
