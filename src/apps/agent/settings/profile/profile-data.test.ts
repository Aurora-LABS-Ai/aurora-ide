import { describe, expect, it } from "vitest";

import {
  buildBars,
  cacheHitRate,
  computeStreaks,
  fmtUsd,
  modalEndpoint,
  modelRows,
  monthPace,
  projectRows,
  providerGroups,
  rhythmFacts,
  type DayUsage,
  type ModelTotal,
  type ProviderRequestUsage,
} from "./profile-data";

const day = (date: string, tokens: number, turns = 1): DayUsage => ({
  date, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, turns,
});
const NOW = new Date("2026-10-01T15:00:00");
const total = (model: string, providers: string[], tokens: number, extra: Partial<ModelTotal> = {}): ModelTotal => ({
  model, providers, requests: 1, tokens, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0,
  costUsd: 0, pricedRequests: 0, ...extra,
});

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

  it("gives the year view 364 days ending today", () => {
    const bars = buildBars([day("2026-10-01", 4)], "year", NOW);
    expect(bars).toHaveLength(364);
    expect(bars[363]).toMatchObject({ key: "2026-10-01", tokens: 4 });
  });

  it("compares this month with the same days of last month", () => {
    const now = new Date("2026-10-03T12:00:00");
    const pace = monthPace(
      [day("2026-09-02", 1, 10), day("2026-09-20", 1, 99), day("2026-10-01", 1, 5), day("2026-10-02", 1, 10)],
      now,
    );
    // Sep 20 is after the 3rd, so it is not part of the comparison.
    expect(pace).toMatchObject({ requests: 15, prevRequests: 10, change: 50, dayOfMonth: 3 });
    expect(monthPace([day("2026-10-01", 1, 5)], now).change).toBeNull();
  });

  it("keeps a streak alive through a quiet today", () => {
    const days = [day("2026-09-29", 1), day("2026-09-30", 1)];
    expect(computeStreaks(days, NOW)).toEqual({ current: 2, longest: 2 });
  });

  it("merges two model keys the catalog labels the same, counting each provider once", () => {
    const rows = modelRows(
      [
        total("gpt-5.6-sol", ["kenari", "codex"], 60, { costUsd: 2, pricedRequests: 1 }),
        total("sol-alias", ["kenari", "gone"], 20, { costUsd: 1, pricedRequests: 1 }),
        total("glm-5.3", ["kenari"], 20),
      ],
      [
        { modelKey: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
        { modelKey: "sol-alias", label: "GPT-5.6 Sol" },
      ] as never,
      [{ id: "kenari", name: "Kenari" }, { id: "codex", name: "Codex" }],
    );
    expect(rows[0]).toMatchObject({
      label: "GPT-5.6 Sol", tokens: 80, providers: ["Codex", "Kenari"], removedProviders: 1,
      costUsd: 3, pricedRequests: 2, keys: ["gpt-5.6-sol", "sol-alias"],
    });
    expect(rows[1].providers).toEqual(["Kenari"]);
  });

  it("reads a Modal endpoint key as its model and merges endpoints of one model", () => {
    expect(modalEndpoint("canyaman6879--ep-glm-5-3-server.us-west.modal.direct")).toEqual({
      label: "GLM 5.3", owner: "canyaman6879",
    });
    expect(modalEndpoint("gpt-5.6-sol")).toBeNull();
    expect(modelRows([total("gpt-5-6-luna", [], 1)], [], [])[0].label).toBe("GPT 5.6 Luna");
    const rows = modelRows(
      [
        total("a--ep-glm-5-3-server.us-west.modal.direct", ["modal"], 10),
        total("b--ep-glm-5-3-server.us-west.modal.direct", ["modal"], 5),
      ],
      [],
      [{ id: "modal", name: "Modal" }],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: "GLM 5.3", tokens: 15, modalEndpoints: 2 });
  });

  it("folds deleted providers into one total and leaves unattributed usage out", () => {
    const usage = (providerId: string, requests: number): ProviderRequestUsage => ({
      providerId, requests, estimatedRequests: 0, inputTokens: 10, outputTokens: 0,
      cacheReadTokens: 4, threads: 1, models: [],
    });
    const groups = providerGroups(
      [usage("", 900), usage("kenari", 50), usage("d840dd0a-uuid", 7), usage("1efcd070-uuid", 3)],
      [{ id: "kenari", name: "Kenari" }],
    );
    expect(groups.active.map((r) => r.label)).toEqual(["Kenari"]);
    expect(groups.removed).toEqual({ count: 2, requests: 10, tokens: 20, cacheReadTokens: 8 });
  });

  it("names projects by folder and keeps Aurora Chat as one entry", () => {
    const rows = projectRows([
      { root: "E:\\VOID-EDITOR\\Aurora-Agent-IDE\\", surface: "build", requests: 3, tokens: 30, cacheReadTokens: 0, threads: 2 },
      { root: null, surface: "chat", requests: 1, tokens: 5, cacheReadTokens: 0, threads: 1 },
      { root: null, surface: "build", requests: 1, tokens: 1, cacheReadTokens: 0, threads: 1 },
    ]);
    expect(rows.map((r) => r.label)).toEqual(["Aurora-Agent-IDE", "Aurora Chat", "No folder recorded"]);
  });

  it("finds the busiest hour and day and the weekend share", () => {
    const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    grid[1][4] = 6; // Tuesday 4 AM
    grid[5][14] = 2; // Saturday 2 PM
    grid[6][2] = 2; // Sunday 2 AM
    expect(rhythmFacts(grid)).toMatchObject({ total: 10, topDay: 1, topHour: 4, weekendShare: 40, nightShare: 80 });
  });

  it("formats money and cache hit rates without inventing figures", () => {
    expect(fmtUsd(0)).toBe("$0");
    expect(fmtUsd(0.004)).toBe("<$0.01");
    expect(fmtUsd(1607.94)).toBe("$1,608");
    expect(cacheHitRate(84, 16)).toBe(84);
    expect(cacheHitRate(0, 0)).toBe(0);
  });
});
