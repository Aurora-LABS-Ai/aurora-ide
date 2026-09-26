import { describe, expect, it, vi } from "vitest";

import { classifyError } from "@/apps/agent/lib/error-classifier";

vi.mock("@/apps/agent/store/settings/useAgentSettingsStore", () => ({
  useAgentSettingsStore: { getState: () => ({}) },
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

/**
 * A spent subscription window and a spent free allowance both arrive as 429,
 * and neither is congestion. kenari's docs are explicit that once the window is
 * gone the request is REFUSED rather than billed to balance — so the generic
 * 429 advice ("wait a moment and try again") is not merely unhelpful here, it
 * describes a recovery that cannot happen.
 */
const PLAN_LIMIT =
  'provider returned an error: HTTP 429: {"error":{"code":"plan_limit_reached","message":"plan limit reached"}}';

const FREE_QUOTA =
  'provider returned an error: HTTP 429: {"error":{"code":"free_quota_daily","message":"daily free quota exhausted"}}';

describe("classifyError separates a spent quota from a rate limit", () => {
  it("does not tell someone to wait out a plan window", () => {
    const result = classifyError(PLAN_LIMIT);
    expect(result.title).toBe("Plan Quota Spent");
    expect(result.title).not.toBe("Rate Limit Reached");
    // Retrying is the one thing that cannot work until the window rolls.
    expect(result.action).not.toBe("retry");
    expect(result.suggestion).toMatch(/pay-as-you-go/i);
  });

  it("keeps the free lane's daily allowance distinct from the paid window", () => {
    // Separately counted and separately reset — plan quota left says nothing
    // about this one, so the two must not share a message.
    const result = classifyError(FREE_QUOTA);
    expect(result.title).toBe("Free Daily Quota Spent");
    expect(result.message).toContain("Paid models are unaffected");
  });

  it("still calls an ordinary 429 a rate limit", () => {
    // The new branches are matched on their codes, not on the status, so a
    // genuine rate limit must be untouched by them.
    expect(classifyError("HTTP 429 too many requests").title).toBe("Rate Limit Reached");
    expect(classifyError("HTTP 429 rate limit").action).toBe("retry");
    // Named codes that ARE ordinary rate limits keep the ordinary advice —
    // waiting is exactly right for both, and the docs say `Retry-After` on the
    // RPM one is accurate.
    expect(classifyError("HTTP 429 rate_limit_exceeded").title).toBe("Rate Limit Reached");
    expect(classifyError("HTTP 429 free_quota_rpm").title).toBe("Rate Limit Reached");
  });
});

/**
 * Three codes that arrive on a status whose generic advice points at the wrong
 * thing. Each was misclassified before: a self-imposed spending cap and an
 * empty prepaid balance both read as "check your payment method", and a
 * subscription-only model read as a key without permissions.
 *
 * Codes and statuses are from kenari's error table.
 */
describe("classifyError does not blame the payment method or the key", () => {
  it("calls a self-imposed spending cap what it is", () => {
    const result = classifyError(
      'HTTP 402: {"error":{"code":"payg_limit_reached","message":"payg limit reached"}}',
    );
    expect(result.title).toBe("Spending Limit Reached");
    // The card is fine. Saying otherwise sends someone to their bank.
    expect(result.message).toContain("Billing is working normally");
  });

  it("sends an empty prepaid balance to a top-up, not to a card", () => {
    const result = classifyError(
      'HTTP 402: {"error":{"code":"insufficient_balance","message":"insufficient balance"}}',
    );
    expect(result.title).toBe("Balance Empty");
    expect(result.suggestion).toMatch(/top up/i);
    expect(result.suggestion).not.toMatch(/payment method/i);
  });

  it("does not blame the key for a subscription-only model", () => {
    const result = classifyError(
      'HTTP 403: {"error":{"code":"subscribers_only","message":"subscribers only"}}',
    );
    expect(result.title).toBe("Subscription Required");
    expect(result.message).toContain("API key is fine");
  });

  it("leaves the generic billing and access branches reachable", () => {
    // The named branches sit in front of them, so a provider that sends only a
    // status must still land somewhere sensible.
    expect(classifyError("HTTP 402 payment required").title).toBe("Billing Issue");
    expect(classifyError("HTTP 403 forbidden").title).toBe("Access Denied");
  });
});
