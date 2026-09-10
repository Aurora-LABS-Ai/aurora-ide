import { describe, expect, it } from "vitest";

import {
  CONTRIBUTOR_NOTICE,
  META_BASE_URL,
  META_RATE_LIMITS,
  META_WIRES,
  isContributorModel,
  isMetaProvider,
  metaRateLimitTier,
  metaWire,
} from "./meta";

describe("meta provider", () => {
  it("recognises the row by id and by any of its three wires", () => {
    expect(isMetaProvider({ id: "meta", providerType: undefined })).toBe(true);
    for (const wire of ["meta", "meta-responses", "meta-messages"] as const) {
      expect(isMetaProvider({ id: "whatever", providerType: wire })).toBe(true);
    }
    // A user-added row on another provider must not be claimed.
    expect(isMetaProvider({ id: "openai", providerType: "openai" })).toBe(false);
    expect(isMetaProvider({ id: "x", providerType: undefined })).toBe(false);
  });

  /**
   * Responses is the fallback, not Chat. A row stored before the wire picker
   * existed carries no `providerType`, and defaulting it to Chat would quietly
   * drop reasoning between tool calls — the failure Meta's own docs warn about,
   * and one that looks like the model being bad rather than a wire being wrong.
   */
  it("falls back to the responses wire, not chat", () => {
    expect(metaWire({ id: "meta", providerType: undefined })).toBe("meta-responses");
    expect(metaWire({ id: "meta", providerType: "openai" })).toBe("meta-responses");
    expect(metaWire({ id: "meta", providerType: "meta" })).toBe("meta");
    expect(metaWire({ id: "meta", providerType: "meta-messages" })).toBe("meta-messages");
    expect(metaWire({ id: "meta", providerType: "meta-responses" })).toBe("meta-responses");
  });

  it("offers the recommended wire first", () => {
    expect(META_WIRES[0]?.value).toBe("meta-responses");
    // Every wire is explained, or the picker is three words and a guess.
    for (const wire of META_WIRES) {
      expect(wire.detail.length).toBeGreaterThan(0);
    }
  });

  it("addresses all three wires through one base url", () => {
    expect(META_BASE_URL).toBe("https://api.meta.ai/v1");
  });

  /**
   * A suffix test, so a model Meta ships later is classified the day it
   * appears. Getting this wrong is not cosmetic: it decides whether the UI
   * tells someone their code is training data.
   */
  it("identifies the contributor tier by suffix", () => {
    expect(isContributorModel("muse-spark-1.3-contributor")).toBe(true);
    expect(isContributorModel("muse-spark-1.2-contributor")).toBe(true);
    // A version that does not exist yet must still be caught.
    expect(isContributorModel("muse-spark-9.9-contributor")).toBe(true);
    expect(isContributorModel("MUSE-SPARK-1.3-CONTRIBUTOR")).toBe(true);
    expect(isContributorModel("  muse-spark-1.3-contributor  ")).toBe(true);

    expect(isContributorModel("muse-spark-1.3")).toBe(false);
    expect(isContributorModel("muse-spark-1.1")).toBe(false);
    expect(isContributorModel("")).toBe(false);
  });

  it("says what the contributor tier costs you, and names the alternative", () => {
    expect(CONTRIBUTOR_NOTICE).toMatch(/trains on/i);
    // The escape hatch has to be in the notice; a warning with no alternative
    // is just an obstacle.
    expect(CONTRIBUTOR_NOTICE).toMatch(/Contributor/);
  });

  it("maps each tier to its published ceiling", () => {
    expect(metaRateLimitTier("muse-spark-1.3-contributor")).toBe("contributor");
    expect(metaRateLimitTier("muse-spark-1.3")).toBe("standard");

    // The contributor tier is the tight one — 100 rpm is reachable by an agent
    // in a fast tool loop, which is the whole reason these numbers are here.
    expect(META_RATE_LIMITS.contributor.requestsPerMin).toBe(100);
    expect(META_RATE_LIMITS.standard.requestsPerMin).toBe(3_000);
    expect(META_RATE_LIMITS.contributor.requestsPerMin).toBeLessThan(
      META_RATE_LIMITS.standard.requestsPerMin,
    );
  });
});
