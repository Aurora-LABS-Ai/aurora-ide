/**
 * `plan-view` — one shape for five subscriptions that do not agree on anything.
 *
 * These tests exist because the context card now renders a LIST and knows
 * nothing about who filled it. Everything provider-specific happens here, so
 * this is the only place a provider's own units, wording and absences can be
 * checked.
 */

import { describe, expect, it } from "vitest";

import {
  arkPlanView,
  claudeCodePlanView,
  codexPlanView,
  commandCodePlanView,
  cursorPlanView,
  kenariPlanView,
  limitTone,
  minimaxPlanView,
  openCodePlanView,
} from "./plan-view";
import type { ArkUsage } from "./ark";
import type { ClaudeCodeUsageSnapshot } from "./claude-code";
import type { MinimaxQuota, MinimaxUsageSnapshot } from "./minimax";
import type { CodexUsageSnapshot } from "./codex";
import type { CommandCodeUsageSnapshot } from "./commandcode";
import type { CursorUsageSnapshot } from "./cursor";
import type { KenariUsage } from "./kenari";
import type { OpenCodeUsage } from "./opencode";

const codexSnap = (over: Partial<CodexUsageSnapshot> = {}): CodexUsageSnapshot => ({
  planType: "pro",
  limitReached: false,
  primary: null,
  secondary: null,
  credits: null,
  fetchedAtMs: 0,
  ...over,
});

const claudeSnap = (over: Partial<ClaudeCodeUsageSnapshot> = {}): ClaudeCodeUsageSnapshot => ({
  plan: "max",
  fiveHour: null,
  sevenDay: null,
  sevenDayOpus: null,
  sevenDaySonnet: null,
  extraUsage: null,
  fetchedAtMs: 0,
  ...over,
});

const claudeWindow = (usedPercent: number, resetsInSeconds: number | null = null) => ({
  usedPercent,
  resetsAtMs: null,
  resetsInSeconds,
});

describe("limitTone", () => {
  it("uses the same bands as the ring", () => {
    expect(limitTone(0)).toBe("good");
    expect(limitTone(59)).toBe("good");
    expect(limitTone(60)).toBe("warn");
    expect(limitTone(84)).toBe("warn");
    expect(limitTone(85)).toBe("bad");
    expect(limitTone(100)).toBe("bad");
  });
});

describe("claudeCodePlanView", () => {
  it("names the account by its plan", () => {
    const view = claudeCodePlanView(claudeSnap({ fiveHour: claudeWindow(10) }));
    expect(view?.title).toBe("Claude Max plan");
  });

  it("falls back to a plain title when the plan is unknown", () => {
    const view = claudeCodePlanView(claudeSnap({ plan: null, fiveHour: claudeWindow(10) }));
    expect(view?.title).toBe("Claude plan");
  });

  it("states what is LEFT, and when it comes back", () => {
    const view = claudeCodePlanView(claudeSnap({ fiveHour: claudeWindow(34, 3_900) }));
    expect(view?.limits[0]).toMatchObject({
      name: "Right now",
      value: "66% left",
      fillPercent: 34,
      caption: "resets in 1h 5m",
      tone: "good",
    });
  });

  it("draws only the windows the account actually reported", () => {
    // The per-model weekly buckets exist on some plans and not others. An
    // absent one rendered as zero would say "spent" about a limit that does
    // not exist on this account.
    const view = claudeCodePlanView(
      claudeSnap({ fiveHour: claudeWindow(12), sevenDaySonnet: claudeWindow(88) }),
    );
    expect(view?.limits.map((l) => l.name)).toEqual(["Right now", "Sonnet this week"]);
    expect(view?.limits[1].tone).toBe("bad");
  });

  it("meters extra usage against its cap rather than as a share", () => {
    const view = claudeCodePlanView(
      claudeSnap({
        sevenDay: claudeWindow(96),
        extraUsage: {
          enabled: true,
          monthlyLimit: 100,
          usedCredits: 12.5,
          usedPercent: 12.5,
        },
      }),
    );
    const extra = view?.limits.at(-1);
    expect(extra).toMatchObject({
      name: "Extra usage",
      value: "12.5 of 100",
      caption: "billed on top of the plan",
      fillPercent: 12.5,
    });
  });

  it("leaves extra usage out when the account has it switched off", () => {
    const view = claudeCodePlanView(
      claudeSnap({
        fiveHour: claudeWindow(4),
        extraUsage: { enabled: false, monthlyLimit: 100, usedCredits: 0, usedPercent: 0 },
      }),
    );
    expect(view?.limits.map((l) => l.name)).toEqual(["Right now"]);
  });

  it("says nothing rather than showing an empty section", () => {
    // On a plan that stops serving when it runs out, blank space under a
    // heading reads as "no limits" — the opposite of the truth.
    expect(claudeCodePlanView(null)).toBeNull();
    expect(claudeCodePlanView(claudeSnap())).toBeNull();
  });

  it("invents no flag of its own", () => {
    // Every other provider's flag is that provider's own judgement. This
    // endpoint makes none, and a threshold picked here would read as one.
    const view = claudeCodePlanView(claudeSnap({ fiveHour: claudeWindow(99) }));
    expect(view?.flag).toBeNull();
    expect(view?.balance).toBeNull();
  });
});

describe("codexPlanView", () => {
  it("states what is LEFT, not what is spent", () => {
    const view = codexPlanView(
      codexSnap({
        primary: { usedPercent: 34, windowMinutes: 300, resetsInSeconds: 8040, resetsAtMs: null },
      }),
    );
    expect(view?.limits[0].value).toBe("66% left");
    expect(view?.limits[0].fillPercent).toBe(34);
    expect(view?.limits[0].caption).toMatch(/^resets in /);
  });

  /**
   * The bug that started this work. A spent month with credits paying for the
   * turn rendered nothing at all, because the section was gated on windows.
   */
  it("keeps the section when only credits are left to report", () => {
    const view = codexPlanView(
      codexSnap({ credits: { hasCredits: true, unlimited: false, balance: "3850" } }),
    );
    expect(view).not.toBeNull();
    expect(view?.limits).toHaveLength(0);
    expect(view?.balance).toEqual({ label: "Credits", value: "3,850" });
  });

  it("says nothing at all when there is nothing to say", () => {
    expect(codexPlanView(codexSnap())).toBeNull();
    expect(codexPlanView(null)).toBeNull();
  });
});

describe("arkPlanView", () => {
  /** The live shape from a real Coding Plan Pro account, verbatim. */
  const base: ArkUsage = {
    tier: "pro",
    status: "Running",
    windowSession: { usedPercent: 1.5544235, resetsAtUnix: null },
    windowWeek: { usedPercent: 0.20725646, resetsAtUnix: null },
    windowMonth: { usedPercent: 0.10362823, resetsAtUnix: null },
    expiresAt: "2026-10-11T15:59:59Z",
    hasReward: false,
  };

  /**
   * Already a PERCENT on the wire, unlike kenari's fraction. Multiplied by 100
   * it would draw a full bar over a barely-touched window — the exact mistake
   * the two providers' opposite units invite.
   */
  it("reads the wire's percentage as a percentage", () => {
    const view = arkPlanView(base);
    expect(view?.limits[0].fillPercent).toBeCloseTo(1.5544235);
    expect(view?.limits[0].value).toBe("98% left");
  });

  it("draws all three windows, in the order pressure arrives", () => {
    expect(arkPlanView(base)?.limits.map((l) => l.name)).toEqual([
      "Right now",
      "This week",
      "This month",
    ]);
  });

  /** A level Volcano stops reporting goes absent rather than reading as spent. */
  it("omits a window the account did not report", () => {
    const view = arkPlanView({ ...base, windowWeek: null });
    expect(view?.limits.map((l) => l.name)).toEqual(["Right now", "This month"]);
  });

  it("names the tier when the subscription lookup found one", () => {
    expect(arkPlanView(base)?.title).toBe("Coding Plan Pro");
    expect(arkPlanView({ ...base, tier: null })?.title).toBe("Coding Plan");
  });

  /**
   * "Running" is the ordinary state. Printed on every card it becomes a row
   * nobody reads, and then says nothing on the day the plan actually lapses.
   */
  it("says nothing about an ordinary subscription state", () => {
    expect(arkPlanView(base)?.notice).toBeNull();
    expect(arkPlanView({ ...base, status: "Expired" })?.notice).toBe(
      "Subscription status: Expired",
    );
  });

  it("carries Volcano's own bonus-quota flag rather than inventing one", () => {
    expect(arkPlanView({ ...base, hasReward: true })?.flag).toBe("bonus quota");
    expect(arkPlanView(base)?.flag).toBeNull();
  });

  /**
   * An empty section reads as "no limits", which is the opposite of the truth
   * on a plan that refuses requests when a window runs out.
   */
  it("is absent rather than empty when no window came back", () => {
    expect(arkPlanView(null)).toBeNull();
    expect(
      arkPlanView({
        ...base,
        windowSession: null,
        windowWeek: null,
        windowMonth: null,
      }),
    ).toBeNull();
  });
});

describe("kenariPlanView", () => {
  const base: KenariUsage = {
    planName: "Studio",
    planStatus: "active",
    window5h: null,
    windowWeek: { usedFrac: 0.202, resetsInSecs: 400_000 },
    windowMonth: null,
    webSearchAllowance: null,
    webSearchUsedToday: null,
    catalogThisCycleMicroIdr: null,
    marketThisCycleMicroIdr: null,
    nearLimit: false,
  };

  /**
   * A FRACTION on the wire, not a percent. Passed through raw it draws a
   * 0.2%-full bar over a fifth-spent week.
   */
  it("reads the wire's fraction as a percentage", () => {
    const view = kenariPlanView(base);
    expect(view.limits[0].fillPercent).toBeCloseTo(20.2);
    expect(view.limits[0].value).toBe("80% left");
  });

  /**
   * A plan reports an unset window as absent rather than as zero, and drawing
   * one renders "no limit" as a bar that is fully spent.
   */
  it("draws only the windows the plan actually sets", () => {
    const view = kenariPlanView(base);
    expect(view.limits.map((l) => l.name)).toEqual(["This week"]);
  });

  /** Counts, not a percentage of 200 — "37 left" is what someone acts on. */
  it("counts web searches in searches", () => {
    const view = kenariPlanView({
      ...base,
      webSearchAllowance: 200,
      webSearchUsedToday: 163,
    });
    const search = view.limits.find((l) => l.name === "Web searches");
    expect(search?.value).toBe("37 of 200 left");
    expect(search?.fillPercent).toBeCloseTo(81.5);
  });

  it("carries kenari's own near-limit judgement rather than inventing one", () => {
    expect(kenariPlanView({ ...base, nearLimit: true }).flag).toBe("near limit");
    expect(kenariPlanView(base).flag).toBeNull();
  });

  it("names the plan when it has a name", () => {
    expect(kenariPlanView(base).title).toBe("Studio plan");
    expect(kenariPlanView({ ...base, planName: null }).title).toBe("kenari plan");
  });
});

describe("openCodePlanView", () => {
  it("keeps all three windows in pressure order", () => {
    const usage: OpenCodeUsage = {
      rolling: { status: "ok", percent: 62, resetsAt: null },
      weekly: { status: "ok", percent: 41, resetsAt: null },
      monthly: { status: "ok", percent: 12, resetsAt: null },
    };
    const view = openCodePlanView(usage);
    expect(view.limits.map((l) => l.name)).toEqual(["Right now", "This week", "This month"]);
    expect(view.limits.map((l) => l.value)).toEqual(["38% left", "59% left", "88% left"]);
  });

  it("skips a window the account did not report", () => {
    const view = openCodePlanView({
      rolling: { status: "ok", percent: 5, resetsAt: null },
      weekly: null,
      monthly: null,
    });
    expect(view.limits).toHaveLength(1);
  });
});

describe("commandCodePlanView", () => {
  const snap = (over: Partial<CommandCodeUsageSnapshot> = {}): CommandCodeUsageSnapshot => ({
    planId: "goat",
    planLabel: "GOAT",
    status: "active",
    renewsAt: null,
    cancelAtPeriodEnd: false,
    credits: { monthly: 10, purchased: 2.4, free: 0, belowThreshold: false },
    fiveHour: { used: 2.14, cap: 8, exceeded: false, resetAtMs: null },
    weekly: null,
    limited: true,
    accountName: null,
    accountEmail: null,
    ...over,
  });

  /** Dollars against a cap. A percentage is a unit this provider never used. */
  it("states money, not a share", () => {
    const view = commandCodePlanView(snap());
    expect(view.limits[0].value).toBe("$2.14 of $8.00");
    expect(view.limits[0].value).not.toMatch(/%/);
  });

  /** Some plans report no windows, and a meter would invent a ceiling. */
  it("draws no windows on an unlimited plan, but still reports credits", () => {
    const view = commandCodePlanView(snap({ limited: false }));
    expect(view.limits).toHaveLength(0);
    expect(view.balance?.value).toBe("$12.40 left");
  });

  it("colours an exceeded window as the hard stop it is", () => {
    const view = commandCodePlanView(
      snap({ fiveHour: { used: 9, cap: 8, exceeded: true, resetAtMs: null } }),
    );
    expect(view.limits[0].tone).toBe("bad");
  });
});

describe("minimaxPlanView", () => {
  const quota = (over: Partial<MinimaxQuota> = {}): MinimaxQuota => ({
    modelName: "general",
    intervalRemainingPercent: 100,
    intervalResetsInMs: 15_477_074,
    weeklyRemainingPercent: 100,
    weeklyResetsInMs: 375_477_074,
    intervalTotalCount: 0,
    intervalUsageCount: 0,
    weeklyTotalCount: 0,
    weeklyUsageCount: 0,
    ...over,
  });
  const snap = (quotas: MinimaxQuota[]): MinimaxUsageSnapshot => ({
    quotas,
    fetchedAtMs: 0,
  });

  /**
   * MiniMax reports what is REMAINING. Every other provider here reports what
   * is spent, and passing this through unflipped would draw a full red bar
   * over an untouched plan.
   */
  it("flips remaining into spent for the bar, and keeps remaining for the value", () => {
    const view = minimaxPlanView(
      snap([quota({ intervalRemainingPercent: 62, weeklyRemainingPercent: 91 })]),
    );
    expect(view?.limits[0]).toMatchObject({
      name: "Right now",
      fillPercent: 38,
      value: "62% left",
      tone: "good",
    });
    expect(view?.limits[1]).toMatchObject({ name: "This week", value: "91% left" });
  });

  /** A DURATION in milliseconds, not an instant. Read as a timestamp it lands in 1970. */
  it("reads the reset as a duration", () => {
    const view = minimaxPlanView(snap([quota()]));
    expect(view?.limits[0].caption).toMatch(/^resets in /);
    expect(view?.limits[0].caption).not.toMatch(/1970/);
  });

  /**
   * The text bucket reports zero counts on a live plan because it is metered
   * as a share; `video` is the one that carries real counts. Drawing video
   * would put a bar on the card for something a coding turn cannot spend.
   */
  it("draws the text bucket and ignores video", () => {
    const view = minimaxPlanView(
      snap([
        quota({ modelName: "video", intervalTotalCount: 3, weeklyTotalCount: 21 }),
        quota({ modelName: "general", intervalRemainingPercent: 40 }),
      ]),
    );
    expect(view?.limits).toHaveLength(2);
    expect(view?.limits[0].value).toBe("40% left");
  });

  it("colours a nearly spent window as the hard stop it is", () => {
    const view = minimaxPlanView(snap([quota({ intervalRemainingPercent: 4 })]));
    expect(view?.limits[0].tone).toBe("bad");
  });

  /** An empty section reads as "no limits", which is the opposite of the truth. */
  it("says nothing when there is no text bucket to report", () => {
    expect(minimaxPlanView(null)).toBeNull();
    expect(minimaxPlanView(snap([]))).toBeNull();
    expect(minimaxPlanView(snap([quota({ modelName: "video" })]))).toBeNull();
  });
});

describe("cursorPlanView", () => {
  const snap = (windows: CursorUsageSnapshot["windows"]): CursorUsageSnapshot => ({
    windows,
    totalPercentUsed: null,
    bonusUsd: null,
    notice: null,
    resetsAtMs: null,
    source: "dashboard",
    fetchedAtMs: 0,
  });

  it("takes however many buckets Cursor reports", () => {
    const view = cursorPlanView(
      snap([
        { label: "Cursor Models", kind: "quota", usedPercent: 16, usedUsd: null, limitUsd: null },
        { label: "Other Models", kind: "quota", usedPercent: 100, usedUsd: null, limitUsd: null },
        { label: "On-Demand", kind: "spend", usedPercent: 100, usedUsd: 70.46, limitUsd: 70 },
      ]),
    );
    expect(view.limits).toHaveLength(3);
    expect(view.limits[0].value).toBe("84% left");
    expect(view.limits[1].value).toBe("0% left");
  });

  /**
   * An overage bills PAST the cap. "-1% left" is not what that means, so the
   * amount is stated against its ceiling and the pair speaks for itself.
   */
  it("states an overage as money, not as negative headroom", () => {
    const view = cursorPlanView(
      snap([{ label: "On-Demand", kind: "spend", usedPercent: 100, usedUsd: 70.46, limitUsd: 70 }]),
    );
    expect(view.limits[0].value).toBe("$70.46 of $70");
    expect(view.limits[0].value).not.toMatch(/-/);
    expect(view.limits[0].tone).toBe("bad");
    expect(view.limits[0].caption).toBe("billed on top of the subscription");
  });

  it("carries Cursor's own sentence verbatim", () => {
    const view = cursorPlanView({
      ...snap([]),
      notice: "You've hit your usage limit for Other Models.",
    });
    expect(view.notice).toBe("You've hit your usage limit for Other Models.");
  });

  it("reports a bonus balance only when there is one", () => {
    expect(cursorPlanView({ ...snap([]), bonusUsd: 5 }).balance).toEqual({
      label: "Bonus",
      value: "$5",
    });
    expect(cursorPlanView({ ...snap([]), bonusUsd: 0 }).balance).toBeNull();
    expect(cursorPlanView(snap([])).balance).toBeNull();
  });
});
