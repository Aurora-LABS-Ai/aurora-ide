/**
 * DeepSeek — the wire picker, the balance, and the clock that doubles the bill.
 *
 * Two of these three are arithmetic somebody has to get right rather than
 * behaviour anyone can see in the app, which is why they are tested here:
 *
 * - The wire decides the request SHAPE and the base URL together. Setting one
 *   without the other posts an Anthropic body to a path that 404s, and the
 *   failure looks like a broken key rather than a wrong address.
 * - The rate window decides whether the cost figures shown everywhere else are
 *   the real charge or half of it. It is read from the clock, in UTC, with a
 *   weekday rule — three chances to be quietly wrong.
 */

import { describe, expect, it } from "vitest";

import {
  deepseekBalanceLabel,
  deepseekBaseUrlForWire,
  deepseekMoney,
  deepseekRateLabel,
  deepseekRateWindow,
  deepseekWire,
  isDeepSeekProvider,
  type DeepSeekBalanceSnapshot,
} from "./deepseek";

const snap = (
  balances: DeepSeekBalanceSnapshot["balances"],
  isAvailable = true,
): DeepSeekBalanceSnapshot => ({ isAvailable, balances, fetchedAtMs: 0 });

const wallet = (currency: string, total: number) => ({
  currency,
  total,
  granted: 0,
  toppedUp: total,
});

describe("the wire a row is on", () => {
  it("reads the row's type, and treats anything unrecognised as Chat", () => {
    expect(deepseekWire({ id: "deepseek", providerType: "deepseek" })).toBe("deepseek");
    expect(deepseekWire({ id: "deepseek", providerType: "deepseek-messages" })).toBe(
      "deepseek-messages",
    );
    expect(deepseekWire({ id: "deepseek", providerType: "deepseek-responses" })).toBe(
      "deepseek-responses",
    );
    // A row saved before the picker existed carries no type at all.
    expect(deepseekWire({ id: "deepseek", providerType: undefined })).toBe("deepseek");
  });

  it("puts Messages on its own path, because that is where DeepSeek serves it", () => {
    // The whole reason the picker writes the URL as well as the type. Chat and
    // Responses share `/v1`; Messages does not, and a row left on `/v1` would
    // post Anthropic bodies to an endpoint that does not exist.
    expect(deepseekBaseUrlForWire("deepseek")).toBe("https://api.deepseek.com/v1");
    expect(deepseekBaseUrlForWire("deepseek-responses")).toBe("https://api.deepseek.com/v1");
    expect(deepseekBaseUrlForWire("deepseek-messages")).toBe(
      "https://api.deepseek.com/anthropic/v1",
    );
  });

  it("recognises the built-in row and a hand-added one on any wire", () => {
    expect(isDeepSeekProvider({ id: "deepseek", providerType: undefined })).toBe(true);
    // A row somebody added themselves carries a UUID and declares itself
    // through its type — on every one of the three wires.
    expect(isDeepSeekProvider({ id: "a-uuid", providerType: "deepseek-messages" })).toBe(true);
    expect(isDeepSeekProvider({ id: "a-uuid", providerType: "deepseek-responses" })).toBe(true);
    expect(isDeepSeekProvider({ id: "a-uuid", providerType: "openai" })).toBe(false);
  });
});

describe("the balance", () => {
  it("shows every funded wallet, because a live account returns two", () => {
    expect(deepseekBalanceLabel(snap([wallet("CNY", 13.79), wallet("USD", 8.99)]))).toBe(
      "¥13.79 · $8.99",
    );
  });

  it("drops an empty wallet beside a funded one", () => {
    // A `¥0.00` next to a funded dollar balance reads as a problem and is not
    // one — an unused currency is not an empty account.
    expect(deepseekBalanceLabel(snap([wallet("CNY", 0), wallet("USD", 8.99)]))).toBe("$8.99");
  });

  it("still shows a zero when there is nothing anywhere", () => {
    // The one case where zero IS the reading, and hiding it would leave the
    // row blank on the account that most needs to be read.
    expect(deepseekBalanceLabel(snap([wallet("USD", 0)]))).toBe("$0.00");
  });

  it("names a currency it has no symbol for rather than dropping it", () => {
    expect(deepseekMoney("EUR", 4.2)).toBe("4.20 EUR");
  });
});

describe("peak and off-peak", () => {
  // Peak is 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday. 2026-09-21 is a
  // Monday; 2026-09-20 is a Sunday.
  const utc = (iso: string) => new Date(iso);

  it("is peak inside a weekday peak block", () => {
    expect(deepseekRateWindow(utc("2026-09-21T02:00:00Z")).peak).toBe(true);
    expect(deepseekRateWindow(utc("2026-09-21T09:59:00Z")).peak).toBe(true);
  });

  it("is off-peak in the gap between the two blocks", () => {
    // 04:00–06:00 is the hole in the middle of the weekday. Treating peak as
    // one 01:00–10:00 run would quote double for two hours that are not.
    expect(deepseekRateWindow(utc("2026-09-21T05:00:00Z")).peak).toBe(false);
  });

  it("is off-peak all weekend", () => {
    // Sunday 02:00 is inside the peak HOURS and outside the peak DAYS.
    expect(deepseekRateWindow(utc("2026-09-20T02:00:00Z")).peak).toBe(false);
  });

  it("counts to the next flip, not to the next boundary", () => {
    // 02:00 Monday → peak ends at 04:00, two hours away.
    const inPeak = deepseekRateWindow(utc("2026-09-21T02:00:00Z"));
    expect(inPeak.changesInMs).toBe(2 * 3_600_000);
    // 05:00 Monday → the next peak starts at 06:00, one hour away.
    const inGap = deepseekRateWindow(utc("2026-09-21T05:00:00Z"));
    expect(inGap.changesInMs).toBe(3_600_000);
  });

  it("crosses a whole weekend to find Monday's first peak", () => {
    // Saturday 00:00 → the next peak is Monday 01:00, 49 hours away. A search
    // that only looked at today and tomorrow would find nothing and report a
    // made-up countdown.
    const sat = deepseekRateWindow(utc("2026-09-19T00:00:00Z"));
    expect(sat.peak).toBe(false);
    expect(sat.changesInMs).toBe(49 * 3_600_000);
  });

  it("says what the rate MEANS, not just which one is running", () => {
    // "Peak" alone means nothing to someone who has not read DeepSeek's
    // pricing page, and the point of the line is that the cost figures beside
    // it are the other rate.
    expect(deepseekRateLabel(deepseekRateWindow(utc("2026-09-21T02:00:00Z")))).toContain(
      "double",
    );
    expect(deepseekRateLabel(deepseekRateWindow(utc("2026-09-20T02:00:00Z")))).toContain(
      "off-peak rate",
    );
  });
});
