import { describe, expect, it } from "vitest";

import {
  buildBars,
  computeStreaks,
  modelRows,
  monthTotals,
  providerGroups,
  type DayUsage,
  type ProviderRequestUsage,
} from "./profile-data";

const day = (date: string, tokens: number, turns = 1): DayUsage => ({
  date, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, turns,
});
const NOW = new Date("2026-10-01T15:00:00");

describe("profile data", () => {
  it("draws every day in the range, quiet ones as zero", () => {
    // The ledger lists only active days. Plotted back to back, Sep 2 sat next
    // to Sep 9 and the quiet week vanished.
    const bars = buildBars([day("2026-09-02", 5), day("2026-10-01", 7)], "days", NOW);
    expect(bars).toHaveLength(30);
    expect(bars[0].key).toBe("2026-09-02");
    expect(bars[0].tokens).toBe(5);
    expect(bars[1].tokens).toBe(0);
    expect(bars[29]).toMatchObject({ key: "2026-10-01", tokens: 7 });
  });

  it("buckets weeks from Monday and ends on the current week", () => {
    const bars = buildBars([day("2026-09-28", 3), day("2026-10-01", 4)], "weeks", NOW);
    expect(bars).toHaveLength(26);
    expect(bars[25]).toMatchObject({ key: "2026-09-28", tokens: 7, requests: 2 });
  });

  it("totals the current calendar month only", () => {
    const days = [day("2026-09-30", 100, 3), day("2026-10-01", 5, 2)];
    expect(monthTotals(days, NOW)).toEqual({ tokens: 5, requests: 2 });
  });

  it("keeps a streak alive through a quiet today", () => {
    const days = [day("2026-09-29", 1), day("2026-09-30", 1)];
    expect(computeStreaks(days, NOW)).toEqual({ current: 2, longest: 2 });
  });

  it("merges two model keys the catalog labels the same, counting each provider once", () => {
    const rows = modelRows(
      [
        { model: "gpt-5.6-sol", providers: ["kenari", "codex"], requests: 3, tokens: 60 },
        { model: "sol-alias", providers: ["kenari"], requests: 1, tokens: 20 },
        { model: "glm-5.3", providers: ["kenari"], requests: 1, tokens: 20 },
      ],
      [
        { modelKey: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
        { modelKey: "sol-alias", label: "GPT-5.6 Sol" },
      ] as never,
    );
    expect(rows[0]).toMatchObject({ label: "GPT-5.6 Sol", value: 80, aside: "80%", detail: "via 2 providers" });
    expect(rows[1].detail).toBeUndefined();
  });

  it("folds deleted providers into one total and leaves unattributed usage out", () => {
    const usage = (providerId: string, requests: number): ProviderRequestUsage => ({
      providerId, requests, estimatedRequests: 0, inputTokens: 10, outputTokens: 0,
      cacheReadTokens: 0, threads: 1, models: [],
    });
    const groups = providerGroups(
      [usage("", 900), usage("kenari", 50), usage("d840dd0a-uuid", 7), usage("1efcd070-uuid", 3)],
      [{ id: "kenari", name: "Kenari" }],
    );
    expect(groups.active.map((r) => r.label)).toEqual(["Kenari"]);
    expect(groups.removed).toEqual({ count: 2, requests: 10, tokens: 20 });
  });
});
