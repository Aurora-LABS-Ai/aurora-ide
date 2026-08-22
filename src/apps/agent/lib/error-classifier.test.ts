import { describe, expect, it, vi } from "vitest";

import { classifyError } from "@/apps/agent/lib/error-classifier";

vi.mock("@/kernel/store/useSettingsStore", () => ({
  useSettingsStore: { getState: () => ({}) },
}));

/**
 * The exact strings kenari returned on 2026-08-21, copied from `aurora.log`.
 * A turn holding 30.7K of a 1,000,000-token window — 3% — was told its
 * conversation was too long, because the second one mentions "context length"
 * in a list of things the gateway had NOT checked.
 */
const UPSTREAM_DOWN =
  'provider returned an error: HTTP 503: {"error":{"code":"all_providers_failed","message":"upstream unavailable for model minimax-m3","param":null,"type":"all_providers_failed"}}';

const GENERIC_REJECTION =
  'invalid request: HTTP 400: {"error":{"code":"upstream_rejected","message":"the model\'s provider rejected the request; check the model id, request fields, and context length","param":null,"type":"invalid_request_error"}}';

describe("classifyError does not invent a cause", () => {
  it("never calls a gateway's catch-all rejection a context overflow", () => {
    const result = classifyError(GENERIC_REJECTION);
    expect(result.title).not.toBe("Context Too Large");
    expect(result.title).toBe("Provider Rejected the Request");
    // It must not assert one of the three causes the gateway listed.
    expect(result.message).not.toContain("too long");
  });

  it("names an unreachable upstream as exactly that", () => {
    const result = classifyError(UPSTREAM_DOWN);
    expect(result.title).toBe("Provider Unavailable");
    expect(result.suggestion).toContain("Nothing is wrong with your conversation");
  });

  it("still recognises a real overflow", () => {
    for (const real of [
      'HTTP 400: {"error":{"code":"context_too_large"}}',
      "This model's maximum context length is 128000 tokens",
      "context_length_exceeded",
      "prompt is too long: 210000 tokens > 200000 maximum",
      "Please reduce the length of the messages",
    ]) {
      expect(classifyError(real).title, real).toBe("Context Too Large");
    }
  });

  it("does not match a bare mention of the subject", () => {
    // Each of these TALKS about context length without claiming it was exceeded.
    for (const notOverflow of [
      "check the model id, request fields, and context length",
      "see the docs for context length guidance",
      "context length: 1000000",
    ]) {
      expect(classifyError(notOverflow).title, notOverflow).not.toBe("Context Too Large");
    }
  });

  it("keeps the classifications that were already right", () => {
    expect(classifyError("HTTP 401 unauthorized").title).toBe("Invalid API Key");
    expect(classifyError("HTTP 429 rate limit").title).toBe("Rate Limit Reached");
    expect(classifyError("fetch failed").title).toBe("Connection Failed");
    expect(classifyError("request timed out").title).toBe("Request Timed Out");
  });
});
