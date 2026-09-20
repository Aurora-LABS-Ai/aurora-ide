/**
 * DeepSeek — one account, three wires, and a balance the key can read.
 *
 * ## The wire is a real choice here, not a preference
 *
 * DeepSeek serves the same two models and the same `sk-` key on three request
 * shapes, and they are not interchangeable. Measured against a live account on
 * 2026-09-20:
 *
 * - **Chat Completions** (`/v1/chat/completions`) — the default. The only wire
 *   with DeepSeek's strict-tool beta branch, and the only one that REFUSES a
 *   tool loop when the chain-of-thought is not passed back: drop
 *   `reasoning_content` and the next request is a 400.
 * - **Anthropic Messages** (`/anthropic/v1/messages`) — a genuine Messages
 *   API. Returns signed `thinking` blocks, so reasoning replays across a tool
 *   loop the way it does on Anthropic, and reports cache reads BESIDE
 *   `input_tokens` rather than inside them. `cache_control` is ignored, which
 *   costs nothing: DeepSeek caches automatically.
 * - **Responses** (`/v1/responses`) — returns the chain-of-thought as plain
 *   `reasoning_text` with no encrypted payload, and is the one wire that does
 *   NOT reject a tool loop with the reasoning missing. Aurora replays it as a
 *   plain reasoning item anyway, because dropping it throws away the thinking
 *   that justified the tool call.
 *
 * ## Why the balance needs no sign-in
 *
 * kenari's key cannot read its own account, and Volcano's control plane
 * refuses its key outright — both cards therefore ask for a browser session
 * beside a working key. DeepSeek is the easy case: `GET /user/balance` is in
 * the public reference and answers to the same key that serves chat.
 *
 * ## Peak and off-peak are the same tokens at two prices
 *
 * DeepSeek bills double between 01:00–04:00 and 06:00–10:00 UTC on weekdays.
 * Aurora's catalogue holds one price per model and it holds the off-peak one,
 * because that is what the clock says for 133 hours of every 168. So the cost
 * figures on the context ring are right most of the time and half the truth
 * for the rest — which is why the rate window is stated wherever those figures
 * are read, rather than left for someone to discover on the invoice.
 */

import { auroraInvoke as invoke } from "@/kernel/lib/ipc/runtime";
import { fmtDuration } from "@/apps/agent/lib/time/duration";
import type { LLMProvider } from "@/kernel/store/useSettingsStore";

export const DEEPSEEK_PROVIDER_ID = "deepseek";

/** Where a person tops up and sees the same figure on DeepSeek's own page. */
export const DEEPSEEK_CONSOLE_URL = "https://platform.deepseek.com/usage";

// ── Wires ────────────────────────────────────────────────────────────────────

/** The three request shapes, as provider types. Mirrors `api/deepseek.rs`. */
export type DeepSeekWire = "deepseek" | "deepseek-messages" | "deepseek-responses";

/**
 * The picker's options, in the order they are offered.
 *
 * `detail` is what the choice COSTS, not what it is — the label already says
 * that. Each of the two non-default wires gives something up, and a picker
 * that only names them leaves the person to find out which.
 */
export const DEEPSEEK_WIRES: {
  value: DeepSeekWire;
  label: string;
  detail: string;
  baseUrl: string;
}[] = [
  {
    value: "deepseek",
    label: "Chat",
    detail:
      "DeepSeek's own format. Strict tool schemas are available here and nowhere else. Cache hits are reported inside the prompt total.",
    baseUrl: "https://api.deepseek.com/v1",
  },
  {
    value: "deepseek-messages",
    label: "Messages",
    detail:
      "Anthropic's format. Thinking comes back signed, so it replays across a tool loop, and cache reads are reported separately from fresh input. No strict tool mode.",
    baseUrl: "https://api.deepseek.com/anthropic/v1",
  },
  {
    value: "deepseek-responses",
    label: "Responses",
    detail:
      "OpenAI's format. Thinking is returned as plain text with no signature, so Aurora replays it verbatim. No strict tool mode, and prompt_cache_key is ignored.",
    baseUrl: "https://api.deepseek.com/v1",
  },
];

/** Which wire a row is set to. Anything unrecognised is the default one. */
export function deepseekWire(
  provider: Pick<LLMProvider, "id" | "providerType">,
): DeepSeekWire {
  const type = (provider.providerType ?? "").toLowerCase();
  if (type === "deepseek-messages" || type === "deepseek-responses") return type;
  return "deepseek";
}

/**
 * The base URL a wire needs.
 *
 * Written alongside the type when the picker changes, the way Volcano Ark's
 * is: Messages lives on a different PATH (`/anthropic`), not a different
 * suffix of one, so changing only the type would leave the row pointed at
 * something that 404s.
 */
export function deepseekBaseUrlForWire(wire: DeepSeekWire): string {
  return DEEPSEEK_WIRES.find((w) => w.value === wire)?.baseUrl ?? DEEPSEEK_WIRES[0].baseUrl;
}

/**
 * Whether this provider row is DeepSeek.
 *
 * Both spellings, because the built-in row is `deepseek` while a row someone
 * added themselves carries a UUID and declares itself through `providerType` —
 * and on that row the type is whichever of the three wires they picked.
 */
export function isDeepSeekProvider(
  provider: Pick<LLMProvider, "id" | "providerType">,
): boolean {
  if (provider.id === DEEPSEEK_PROVIDER_ID) return true;
  const type = (provider.providerType ?? "").toLowerCase();
  return (
    type === "deepseek" || type === "deepseek-messages" || type === "deepseek-responses"
  );
}

// ── Balance ──────────────────────────────────────────────────────────────────

/** One wallet, in one currency. */
export interface DeepSeekBalance {
  /** `CNY` or `USD`, as DeepSeek reported it. */
  currency: string;
  /** Everything spendable: granted plus topped up. */
  total: number;
  granted: number;
  toppedUp: number;
}

export interface DeepSeekBalanceSnapshot {
  /** DeepSeek's own answer to "can this account still call the API". */
  isAvailable: boolean;
  /** Every wallet the account reports, in the order it reported them. */
  balances: DeepSeekBalance[];
  fetchedAtMs: number;
}

/**
 * How much is left on the account.
 *
 * Throws with a sentence a person can act on — a rejected key and an
 * unreachable host are both fixable, and a card that silently shows nothing
 * would read as "no balance", which on a pay-as-you-go account is the one
 * reading that is never true.
 */
export function fetchDeepSeekBalance(
  apiKey: string,
  baseUrl?: string,
): Promise<DeepSeekBalanceSnapshot> {
  return invoke<DeepSeekBalanceSnapshot>("deepseek_balance_get", { apiKey, baseUrl });
}

/** `8.99` USD → `$8.99`. Two decimals, because money. */
export function deepseekMoney(currency: string, amount: number): string {
  const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : "";
  const value = amount.toFixed(2);
  return symbol ? `${symbol}${value}` : `${value} ${currency}`;
}

/**
 * Every funded wallet on one line: `$8.99 · ¥13.79`.
 *
 * Both currencies, because a live account returns both and picking one here
 * would mean guessing which the next request spends from. Empty wallets are
 * dropped — a `¥0.00` beside a funded dollar balance reads as a problem and is
 * not one. An account with nothing anywhere still shows a zero, because that
 * IS the reading.
 */
export function deepseekBalanceLabel(snap: DeepSeekBalanceSnapshot): string {
  const funded = snap.balances.filter((b) => b.total > 0);
  if (funded.length === 0) {
    const first = snap.balances[0];
    return first ? deepseekMoney(first.currency, first.total) : "—";
  }
  return funded.map((b) => deepseekMoney(b.currency, b.total)).join(" · ");
}

// ── Peak / off-peak ──────────────────────────────────────────────────────────

/**
 * The hours DeepSeek charges double, in UTC, Monday to Friday.
 *
 * Half-open: `[start, end)`. Taken from the published pricing table, where
 * off-peak is stated as exactly half of peak.
 */
const PEAK_HOURS_UTC: [number, number][] = [
  [1, 4],
  [6, 10],
];

/** Which rate is running, and how long that lasts. */
export interface DeepSeekRateWindow {
  /** True while tokens cost double the catalogue price. */
  peak: boolean;
  /** Milliseconds until the rate changes. */
  changesInMs: number;
}

function isPeakAt(d: Date): boolean {
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = d.getUTCHours();
  return PEAK_HOURS_UTC.some(([from, to]) => hour >= from && hour < to);
}

/**
 * Which rate is running now, and when it flips.
 *
 * The rate can only change on the hour, at one of four points in the day, so
 * the next flip is found by walking those boundaries rather than by stepping
 * through time. Eight days of them is enough to cross a whole weekend from any
 * starting point, which is the longest run either state can have.
 *
 * Chinese public holidays are off-peak in full and Aurora does not know when
 * they are. That only ever errs toward quoting the HIGHER rate on a day that
 * is actually cheap, which is the safe direction for a cost figure, and it is
 * said out loud on the card rather than hidden in this comment.
 */
export function deepseekRateWindow(now: Date = new Date()): DeepSeekRateWindow {
  const peak = isPeakAt(now);
  const boundaries = [0, ...PEAK_HOURS_UTC.flat()];
  for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
    for (const hour of boundaries) {
      const at = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate() + dayOffset,
          hour,
        ),
      );
      if (at.getTime() <= now.getTime()) continue;
      if (isPeakAt(at) !== peak) {
        return { peak, changesInMs: at.getTime() - now.getTime() };
      }
    }
  }
  // Unreachable: every state flips inside eight days. Falling through to a
  // day rather than throwing keeps a wrong clock from breaking the card.
  return { peak, changesInMs: 86_400_000 };
}

/**
 * The rate window as the sentence that goes next to a cost figure.
 *
 * Says the price relationship, not just the state: "peak" alone means nothing
 * to someone who has not read DeepSeek's pricing page, and the whole point of
 * the line is that the numbers above it are the other rate.
 */
export function deepseekRateLabel(window: DeepSeekRateWindow): string {
  const when = fmtDuration(window.changesInMs / 1000);
  return window.peak
    ? `Peak rates for another ${when} — tokens cost double the prices shown.`
    : `Off-peak for another ${when} — prices shown are the off-peak rate, and peak is double.`;
}
