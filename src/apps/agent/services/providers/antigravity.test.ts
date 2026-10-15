/**
 * The Antigravity card's pure helpers and the shape of its seeded row.
 *
 * The fixtures are the 2026-10-12 live reply, trimmed: all Gemini models drew
 * from one quota and Claude + GPT-OSS from another, and the backend attached
 * its own notices to some models. The pool grouping is what keeps the card
 * from drawing fourteen bars that say two things.
 */

import { describe, expect, it } from "vitest";

import {
  ANTIGRAVITY_PRESET,
  ANTIGRAVITY_PROVIDER_ID,
  antigravityModelRow,
  antigravityNotices,
  antigravityBucketLabel,
  antigravityBucketMeta,
  antigravityPlanLabel,
  antigravityResetLabel,
  antigravityRingBucket,
  isAntigravityProvider,
  type AntigravityAuthStatus,
  type AntigravityModel,
  type AntigravityQuota,
} from "./antigravity";
import { antigravityPlanView } from "./plan-view";

const RESET = "2026-10-19T05:44:37Z";
const NOW = Date.parse("2026-10-12T05:44:37Z");

function model(over: Partial<AntigravityModel>): AntigravityModel {
  return {
    id: "m",
    label: "Gemini 3.8 Flash (High)",
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    supportsImages: true,
    supportsThinking: true,
    vendor: "google",
    remainingPercent: 98,
    resetsAt: RESET,
    noticeTitle: null,
    notice: null,
    ...over,
  };
}

const LIVE: AntigravityModel[] = [
  model({ id: "gemini-3.8-flash-high" }),
  model({ id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)", noticeTitle: "Leaving Soon", notice: "Use Gemini 3.8 Flash!" }),
  model({ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)", vendor: "anthropic", remainingPercent: 95, resetsAt: "2026-10-19T05:44:54Z", noticeTitle: "Notice", notice: "Access ends November 2, 2026." }),
  model({ id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)", vendor: "openai", supportsImages: false, remainingPercent: 95, resetsAt: "2026-10-19T05:44:54Z", noticeTitle: "Notice", notice: "Access ends November 2, 2026." }),
];

describe("Antigravity preset", () => {
  it("needs no key and routes to the Antigravity adapter", () => {
    expect(ANTIGRAVITY_PRESET.id).toBe(ANTIGRAVITY_PROVIDER_ID);
    expect(ANTIGRAVITY_PRESET.providerType).toBe("antigravity");
    expect(ANTIGRAVITY_PRESET.requiresApiKey).toBe(false);
    expect(ANTIGRAVITY_PRESET.customModels).toEqual([]);
    expect(isAntigravityProvider({ id: "antigravity" })).toBe(true);
    expect(isAntigravityProvider({ id: "claude-code" })).toBe(false);
  });
});

/** The Google AI Pro reply from 2026-10-12: two groups, weekly + 5-hour each. */
const PRO: AntigravityQuota = {
  plan: "Google AI Pro",
  fetchedAtMs: NOW,
  groups: [
    {
      name: "Gemini Models",
      description: "Models within this group: Gemini Flash, Gemini Pro",
      buckets: [
        { id: "gemini-weekly", label: "Weekly Limit Remaining", window: "weekly", remainingPercent: 99.6, resetsAt: RESET },
        { id: "gemini-5h", label: "Five Hour Limit Remaining", window: "5h", remainingPercent: 100, resetsAt: "2026-10-12T10:44:37Z" },
      ],
    },
    {
      name: "Claude and GPT models",
      description: null,
      buckets: [
        { id: "3p-weekly", label: "Weekly Limit Remaining", window: "weekly", remainingPercent: 100, resetsAt: RESET },
        { id: "3p-5h", label: "Five Hour Limit Remaining", window: "5h", remainingPercent: 40, resetsAt: "2026-10-12T10:44:37Z" },
      ],
    },
  ],
};

describe("quota buckets", () => {
  it("names the windows plainly and says what is left and when it refills", () => {
    const [weekly, fiveHour] = PRO.groups[0].buckets;
    expect(antigravityBucketLabel(weekly)).toBe("Weekly limit");
    expect(antigravityBucketLabel(fiveHour)).toBe("5-hour limit");
    expect(antigravityBucketLabel({ ...weekly, window: "daily", label: "Daily Limit Remaining" })).toBe("Daily Limit");
    expect(antigravityBucketMeta(weekly, NOW)).toBe("100% left · resets in 7d");
    expect(antigravityBucketMeta(fiveHour, NOW)).toBe("100% left · resets in 5h");
    expect(antigravityResetLabel(null, NOW)).toBeNull();
    expect(antigravityResetLabel("not a date", NOW)).toBeNull();
    expect(antigravityResetLabel("2026-10-01T00:00:00Z", NOW)).toBe("resets now");
  });

  it("gives the ring the 5-hour bucket, or the weekly one on a plan without it", () => {
    expect(antigravityRingBucket(PRO.groups[1])?.id).toBe("3p-5h");
    const free = { ...PRO.groups[0], buckets: [PRO.groups[0].buckets[0]] };
    expect(antigravityRingBucket(free)?.id).toBe("gemini-weekly");
    expect(antigravityRingBucket({ ...free, buckets: [] })).toBeNull();
  });

  it("the ring view has one 5-hour line per group, titled with the plan", () => {
    const view = antigravityPlanView(PRO);
    expect(view?.title).toBe("Antigravity · Google AI Pro");
    expect(view?.limits.map((l) => l.name)).toEqual([
      "Gemini Models · 5-hour",
      "Claude and GPT models · 5-hour",
    ]);
    expect(view?.limits[1].value).toBe("40% left");
    expect(antigravityPlanView(null)).toBeNull();
    expect(antigravityPlanView({ ...PRO, groups: [] })).toBeNull();
  });
});

describe("plan label", () => {
  const status = (over: Partial<AntigravityAuthStatus>): AntigravityAuthStatus => ({
    signedIn: true,
    email: null,
    name: null,
    projectId: null,
    tierId: null,
    tierName: null,
    expiresAtMs: null,
    signedInAt: null,
    lastRefresh: null,
    ...over,
  });

  it("prefers the backend's own plan name, else makes the tier id readable", () => {
    expect(antigravityPlanLabel(status({ tierName: "Antigravity Starter Quota", tierId: "free-tier" }))).toBe(
      "Antigravity Starter Quota",
    );
    expect(antigravityPlanLabel(status({ tierId: "free-tier" }))).toBe("Free");
    expect(antigravityPlanLabel(status({ tierId: "g1-pro-tier" }))).toBe("G1 Pro");
    expect(antigravityPlanLabel(status({}))).toBeNull();
    expect(antigravityPlanLabel(null)).toBeNull();
  });
});

describe("notices", () => {
  it("shows each distinct notice once with the models it covers", () => {
    const notices = antigravityNotices(LIVE);
    expect(notices).toHaveLength(2);
    expect(notices[1]).toEqual({
      title: "Notice",
      text: "Access ends November 2, 2026.",
      models: ["Claude Sonnet 4.6 (Thinking)", "GPT-OSS 120B (Medium)"],
    });
  });
});

describe("model rows", () => {
  it("carries the account's limits and capabilities, no price", () => {
    const row = antigravityModelRow(LIVE[3], undefined);
    expect(row.modelKey).toBe("gpt-oss-120b-medium");
    expect(row.label).toBe("GPT-OSS 120B (Medium)");
    expect(row.contextWindow).toBe(1_048_576);
    expect(row.supportsVision).toBe(false);
    expect(row.supportsToolStream).toBe(true);
    expect(row.priceCacheMissPerMtok).toBeUndefined();
    expect(row.reasoning?.type).toBe("toggle");
  });

  it("keeps what the person changed on the existing row", () => {
    const previous = {
      ...antigravityModelRow(LIVE[0], undefined),
      id: "antigravity::gemini-3.8-flash-high",
      providerId: "antigravity",
      sortOrder: 0,
      contextWindow: 500_000,
      enabled: false,
      reasoning: { type: "toggle" as const, default: false, enabled: false, toggleable: true },
    };
    const row = antigravityModelRow(LIVE[0], previous);
    expect(row.contextWindow).toBe(500_000);
    expect(row.enabled).toBe(false);
    expect(row.reasoning?.default).toBe(false);
    expect(row.reasoning?.enabled).toBe(false);
  });

  it("gives a model that cannot think no reasoning control", () => {
    expect(antigravityModelRow(model({ supportsThinking: false }), undefined).reasoning).toBeUndefined();
  });
});
