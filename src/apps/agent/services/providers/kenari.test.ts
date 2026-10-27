import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@/kernel/lib/ipc/runtime", () => ({ auroraInvoke: invoke }));

import {
  fetchKenariUsage,
  fmtRupiah,
  kenariResetLabel,
  KENARI_WINDOWS,
} from "@/apps/agent/services/providers/kenari";

/**
 * What crosses the IPC boundary — `api/kenari/usage.rs`'s `KenariUsage`, not
 * kenari's own `/v1/account/quota` body. Rust turns `resets_at` (RFC 3339)
 * into a countdown and an instant, and judges `near_limit` against the
 * account's `alert_pct`, so a fixture copied from the wire would pass through
 * this layer reading `null` for both while looking correct.
 *
 * Values are from a live Studio account on 2026-10-26.
 */
const STUDIO = {
  plan_name: "Studio",
  window_5h: null,
  window_week: {
    used_frac: 0.0088,
    resets_in_secs: 511_359,
    resets_at_ms: 1_793_499_699_000,
    budget_rp: 300_000,
    used_rp: 2_636,
    remaining_rp: 297_364,
  },
  window_month: {
    used_frac: 0.0022,
    resets_in_secs: 2_498_559,
    resets_at_ms: 1_795_486_899_000,
    budget_rp: 1_200_000,
    used_rp: 2_636,
    remaining_rp: 1_197_364,
  },
  coupon: null,
  alert_pct: 80,
  near_limit: false,
  fetched_at_ms: 1_792_988_340_000,
};

beforeEach(() => invoke.mockReset());

describe("kenari plan usage", () => {
  it("asks with the key and reads a fraction as a fraction", async () => {
    invoke.mockResolvedValue(STUDIO);
    const usage = await fetchKenariUsage("kn-test");
    expect(invoke).toHaveBeenCalledWith("kenari_usage", { apiKey: "kn-test" });
    // The wire sends 0.0088, not 0.88. Treated as a percent it would draw the
    // wrong bar — the failure this guards.
    expect(usage.windowWeek?.usedFrac).toBeCloseTo(0.0088, 6);
    expect(usage.windowWeek?.resetsInSecs).toBe(511_359);
    expect(usage.windowWeek?.remainingRp).toBe(297_364);
    expect(usage.fetchedAtMs).toBe(1_792_988_340_000);
  });

  it("leaves a window the plan does not cap absent", async () => {
    invoke.mockResolvedValue(STUDIO);
    const usage = await fetchKenariUsage("kn-test");
    // Studio caps the week and the month and nothing else. Drawn from a null
    // this would be a bar reading "100% spent" over a limit that does not exist.
    expect(usage.window5h).toBeNull();
    expect(usage.windowMonth).not.toBeNull();
  });

  it("keeps a window inside its own track", async () => {
    invoke.mockResolvedValue({ ...STUDIO, window_week: { used_frac: 1.35 } });
    const usage = await fetchKenariUsage("kn-test");
    expect(usage.windowWeek?.usedFrac).toBe(1);
    // No countdown on the wire means no countdown drawn, rather than "resets
    // in 1m" invented from a missing field.
    expect(kenariResetLabel(usage.windowWeek)).toBeNull();
  });

  it("carries the plan, the threshold and a coupon", async () => {
    invoke.mockResolvedValue({
      ...STUDIO,
      near_limit: true,
      coupon: {
        name: "Launch",
        used_rp: 1000,
        remaining_rp: null,
        expires_at_ms: 1_800_000_000_000,
        scope_models: ["glm-5.3", 7],
      },
    });
    const usage = await fetchKenariUsage("kn-test");
    expect(usage.planName).toBe("Studio");
    expect(usage.alertPct).toBe(80);
    expect(usage.nearLimit).toBe(true);
    expect(usage.coupon?.name).toBe("Launch");
    expect(usage.coupon?.remainingRp).toBeNull();
    expect(usage.coupon?.scopeModels).toEqual(["glm-5.3"]);
  });

  it("says how long the window has left the way the other plans do", () => {
    // Two units, matching Codex and OpenCode — a plan resetting "in 4d 15h"
    // here and "4d" elsewhere reads as two different numbers.
    const win = { usedFrac: 0.2, resetsAtMs: null, budgetRp: null, usedRp: null, remainingRp: null };
    expect(kenariResetLabel({ ...win, resetsInSecs: 399_967 })).toBe("resets in 4d 15h");
    expect(kenariResetLabel({ ...win, usedFrac: 1, resetsInSecs: 0 })).toBe("resets now");
    expect(kenariResetLabel(null)).toBeNull();
  });

  it("writes Rupiah the way kenari's pages do", () => {
    expect(fmtRupiah(297_364)).toBe("Rp 297,364");
    expect(fmtRupiah(0)).toBe("Rp 0");
  });

  it("orders the windows by how soon they bite", () => {
    expect(KENARI_WINDOWS.map((w) => w.key)).toEqual([
      "window5h",
      "windowWeek",
      "windowMonth",
    ]);
  });
});
