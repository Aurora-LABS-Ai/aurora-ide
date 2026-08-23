import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@/kernel/lib/ipc/runtime", () => ({ auroraInvoke: invoke }));

import {
  fetchKenariUsage,
  kenariResetLabel,
  kenariSessionStatus,
  KENARI_WINDOWS,
} from "@/apps/agent/services/providers/kenari";

/**
 * What crosses the IPC boundary — `commands/kenari.rs`'s `KenariUsage`, not
 * kenari's own `/api/subscription` body.
 *
 * The distinction is the point. Rust flattens `web_search: {allowance,
 * used_today}` into two sibling fields, so a fixture copied from the wire
 * passes through this layer reading `null` for both while looking correct. It
 * did, the first time this test was written.
 *
 * Values are from a live Studio account on 2026-08-23.
 */
const STUDIO = {
  plan_name: "Studio",
  plan_status: "active",
  window_5h: null,
  window_week: { used_frac: 0.20203278766666666, resets_in_secs: 399967 },
  window_month: null,
  web_search_allowance: 200,
  web_search_used_today: 0,
  catalog_this_cycle_micro_idr: 235069296880,
  market_this_cycle_micro_idr: 299652167845,
  near_limit: false,
};

beforeEach(() => invoke.mockReset());

describe("kenari plan usage", () => {
  it("reads a fraction as a fraction", async () => {
    invoke.mockResolvedValue(STUDIO);
    const usage = await fetchKenariUsage();
    // The wire sends 0.202, not 20.2. Treated as a percent it would draw a
    // 0.2%-full bar over a fifth-spent week — the failure this guards.
    expect(usage.windowWeek?.usedFrac).toBeCloseTo(0.20203, 5);
    expect(usage.windowWeek?.resetsInSecs).toBe(399967);
  });

  it("leaves a window the plan does not set absent", async () => {
    invoke.mockResolvedValue(STUDIO);
    const usage = await fetchKenariUsage();
    // Studio caps the week and nothing else. Drawn from a null these would be
    // two bars reading "100% spent" over limits that do not exist.
    expect(usage.window5h).toBeNull();
    expect(usage.windowMonth).toBeNull();
  });

  it("keeps a window inside its own track", async () => {
    invoke.mockResolvedValue({ ...STUDIO, window_week: { used_frac: 1.35 } });
    const usage = await fetchKenariUsage();
    expect(usage.windowWeek?.usedFrac).toBe(1);
    // No countdown on the wire means no countdown drawn, rather than "resets
    // in 1m" invented from a missing field.
    expect(kenariResetLabel(usage.windowWeek)).toBeNull();
  });

  it("carries the plan and the web-search allowance", async () => {
    invoke.mockResolvedValue(STUDIO);
    const usage = await fetchKenariUsage();
    expect(usage.planName).toBe("Studio");
    // Metered and reset separately from the quota windows, so this has to
    // survive the boundary on its own.
    expect(usage.webSearchAllowance).toBe(200);
    expect(usage.webSearchUsedToday).toBe(0);
    expect(usage.nearLimit).toBe(false);
  });

  it("says how long the window has left the way the other plans do", () => {
    // Two units, matching Codex and OpenCode — a plan resetting "in 4d 15h"
    // here and "4d" elsewhere reads as two different numbers.
    expect(kenariResetLabel({ usedFrac: 0.2, resetsInSecs: 399967 })).toBe("resets in 4d 15h");
    expect(kenariResetLabel({ usedFrac: 1, resetsInSecs: 0 })).toBe("resets now");
    expect(kenariResetLabel(null)).toBeNull();
  });

  it("reports no sign-in as a state rather than throwing", async () => {
    // Rust refuses when there is no session, and the card has to render that
    // as an offer to connect — not as an unhandled rejection.
    // Scoped to this one call on purpose: a rejecting implementation left
    // installed is invoked again after the test body and fails the run.
    invoke.mockRejectedValueOnce(new Error("Sign in to kenari to see plan usage."));
    const status = await kenariSessionStatus();
    expect(status).toEqual({ connected: false, email: null, savedAt: null });
  });

  it("orders the windows by how soon they bite", () => {
    expect(KENARI_WINDOWS.map((w) => w.key)).toEqual([
      "window5h",
      "windowWeek",
      "windowMonth",
    ]);
  });
});
