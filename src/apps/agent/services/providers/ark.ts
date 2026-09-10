/**
 * Volcano Ark Coding Plan — a subscription that meters a share, not tokens.
 *
 * One `ark-` key reaches eleven models through one address: Doubao Seed
 * Evolving and the Seed 2.x family, Kimi K3 and K2.7 Code, GLM 5.3 and
 * 5.3 Flash, MiniMax M3, and DeepSeek V4 Pro and Flash. Every one of those ids
 * answered a live request before it was seeded; the twelfth name in Volcano's
 * own docs, `Auto`, is a hard 404 and `ark-code-latest` is the id that reaches
 * the router it describes.
 *
 * ## Two things about this provider that are easy to get wrong
 *
 * **The address is the plan.** `/api/coding/v3` is the subscription's path;
 * Ark's general `/api/v3` takes the same key and bills pay-as-you-go credit
 * instead of the plan, which is Volcano's own documented warning rather than a
 * guess. The preset pins it for that reason.
 *
 * **Quota is a percentage and nothing else.** Volcano meters this plan as a
 * share of three windows and publishes no request count anywhere in the API —
 * the docs' "about 1,200 requests per 5 hours" is an estimate on a marketing
 * page, not a number the account will tell you. So a percentage is the whole
 * truth here, not a summary of counts that exist somewhere underneath.
 *
 * ## Why usage needs a sign-in
 *
 * The `ark-` key reaches the models and nothing else; Volcano's control plane
 * refuses it outright. The documented quota read is an AK/SK-signed
 * control-plane action, and creating an Access Key needs Volcano's real-name
 * verification, which wants Chinese identity documents — so for a large share
 * of accounts the documented route does not exist at all.
 *
 * What does work is the console's own same-origin proxy, which takes a session
 * instead of a signature. See `commands/ark.rs` for how the cookies are taken
 * and why the CSRF token travels as a header.
 */

import { auroraInvoke as invoke } from "@/kernel/lib/ipc/runtime";
import { fmtDuration } from "@/apps/agent/lib/time/duration";
import type { LLMProvider } from "@/kernel/store/useSettingsStore";

export const ARK_PROVIDER_ID = "ark";

/**
 * The Coding Plan's OpenAI-shaped address (chat completions and responses).
 *
 * Not Ark's general inference URL. A request to `/api/v3` with this key
 * succeeds and spends the wrong budget, which is the worst kind of wrong:
 * nothing fails, the quota simply never moves.
 */
export const ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";

/**
 * The Anthropic-shaped address.
 *
 * **A different path, not a different suffix on the same one.** This is where
 * Ark departs from kenari, Modal and Meta, whose three wires all hang off one
 * base URL because the vendor mounts them side by side. Volcano does not:
 * chat and responses live under `/api/coding/v3`, messages under
 * `/api/coding/v1`. So switching wires here has to rewrite the row's base URL,
 * which is what {@link arkBaseUrlForWire} exists for. Leave the URL alone and
 * the row 404s.
 */
export const ARK_MESSAGES_BASE_URL =
  "https://ark.cn-beijing.volces.com/api/coding/v1";

export type ArkWire = "ark" | "ark-messages" | "ark-responses";

/**
 * The wire choices, in the order they are offered.
 *
 * All three were driven against the live account before this list was written;
 * the notes are results, not readings of a docs page.
 *
 * Messages is first and is the default, on two measurements rather than taste:
 *
 * - It is the only wire that returns a `signature` beside each thinking block,
 *   which is what lets reasoning replay intact across a tool loop.
 * - It is the only wire that splits cache WRITES from cache READS
 *   (`cache_creation_input_tokens` / `cache_read_input_tokens`). The other two
 *   send a single `cached_tokens`, a read count with no write figure, so the
 *   context ring's write slice can only ever draw zero — and telling "quietly
 *   re-reading its cache" from "just rebuilt the whole thing" is that row's
 *   entire job.
 *
 * What it costs: about 40 tokens of Volcano's own injected instructions on
 * every call, where chat completions injects none (58 input tokens against 18
 * for the same short prompt). Worth it for the two things above.
 *
 * It does NOT fragment its text: a 120-word reply arrived as 209 deltas into a
 * single text block, so `coalesce_text` — written for a proxy that re-opens a
 * block per token — is not needed here.
 */
export const ARK_WIRES: ReadonlyArray<{
  value: ArkWire;
  label: string;
  /** Shown under the picker so the choice is made with its cost visible. */
  detail: string;
}> = [
  {
    value: "ark-messages",
    label: "Messages",
    detail:
      "Recommended. The only wire that signs its thinking blocks, so reasoning survives a tool loop, and the only one that reports cache writes separately from reads. Costs ~40 tokens of Volcano's own injected instructions per call.",
  },
  {
    value: "ark",
    label: "Chat completions",
    detail:
      "Injects no system prompt of its own, and breaks out a reasoning-token count. But it reports only a cached-read total with no cache-write figure, and its reasoning cannot be replayed across a tool call.",
  },
  {
    value: "ark-responses",
    label: "Responses",
    detail:
      "Works, and calls tools correctly — but it hands back a reasoning SUMMARY instead of the reasoning, and reports caching disabled. Pick it only if you specifically want the Responses shape.",
  },
];

/**
 * Which wire this row is set to. Falls back to Messages, which is both the
 * default and the right answer for a row stored before the picker existed.
 */
export function arkWire(
  provider: Pick<LLMProvider, "id" | "providerType">,
): ArkWire {
  const type = provider.providerType;
  if (type === "ark" || type === "ark-responses") return type;
  return "ark-messages";
}

/**
 * The base URL a wire needs.
 *
 * Switching the provider type alone is not enough on this provider — see
 * {@link ARK_MESSAGES_BASE_URL}.
 */
export function arkBaseUrlForWire(wire: ArkWire): string {
  return wire === "ark-messages" ? ARK_MESSAGES_BASE_URL : ARK_BASE_URL;
}

/**
 * Whether this stored row is carrying a deliberate Ark wire choice.
 *
 * Needed because the launch merge normally lets the catalogue's provider type
 * win, keeping a stored one only when it is a `-` suffixed variant of the
 * preset's (`resolveProviderType`). That test works for kenari, whose preset
 * type is the bare `kenari`. It does NOT work here: Ark's preset type is
 * `ark-messages`, so neither `ark` nor `ark-responses` looks like a variant of
 * it, and both would be rewritten back to Messages on the next launch — the
 * picker would appear to save, work all session, and be reset by morning.
 *
 * Same job as `isAgentRouterWireChoice`, for the mirror-image reason: that
 * provider's wires have no variant prefix to detect, this one's DEFAULT is
 * itself a variant.
 */
export function isArkWireChoice(provider: {
  id?: string;
  providerType?: string;
}): boolean {
  return (
    provider.providerType === "ark" ||
    provider.providerType === "ark-messages" ||
    provider.providerType === "ark-responses"
  );
}

/** Whether this provider row is Volcano Ark, on any of its three wires. */
export function isArkProvider(
  provider: Pick<LLMProvider, "id" | "providerType">,
): boolean {
  return (
    provider.id === ARK_PROVIDER_ID ||
    (provider.providerType ?? "").toLowerCase().startsWith(ARK_PROVIDER_ID)
  );
}

// ── Sign-in ──────────────────────────────────────────────────────────────────

/** Whether Aurora holds a Volcano console sign-in, and whose. */
export interface ArkSessionStatus {
  connected: boolean;
  /** The console's own account id, so two Volcano accounts stay tellable
   *  apart. */
  accountId: string | null;
  /** RFC3339. Displayed only — expiry is discovered by being refused. */
  savedAt: string | null;
}

/** What a completed sign-in reports back. */
export interface ArkAccount {
  accountId: string | null;
}

// ── Usage ────────────────────────────────────────────────────────────────────

/**
 * One metered window.
 *
 * `usedPercent` is a PERCENT (0..100), unlike kenari's fraction — Volcano sends
 * `1.5544235` against a `Cap` of `100` for a window that is 1.55% gone.
 * `resetsAtUnix` is an INSTANT in unix seconds, unlike kenari's duration.
 */
export interface ArkWindow {
  usedPercent: number;
  resetsAtUnix: number | null;
}

/**
 * The plan's headroom.
 *
 * Every window is optional so a level Volcano stops reporting goes absent
 * rather than being drawn at zero, which would say "untouched" about a window
 * nobody measured.
 */
export interface ArkUsage {
  /** `lite` or `pro`. */
  tier: string | null;
  /** The subscription's own word for its state, e.g. `Running`. */
  status: string | null;
  /** The rolling five-hour window. Volcano calls this level `session`. */
  windowSession: ArkWindow | null;
  windowWeek: ArkWindow | null;
  windowMonth: ArkWindow | null;
  /** When the subscription lapses, RFC3339 as the console sends it. */
  expiresAt: string | null;
  /** Volcano's own flag for bonus quota on the account. */
  hasReward: boolean;
}

/** Rust's snake_case, which is what crosses the IPC boundary. */
interface RawWindow {
  used_percent?: unknown;
  resets_at_unix?: unknown;
}

interface RawUsage {
  tier?: unknown;
  status?: unknown;
  window_session?: RawWindow | null;
  window_week?: RawWindow | null;
  window_month?: RawWindow | null;
  expires_at?: unknown;
  has_reward?: unknown;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readWindow(raw: RawWindow | null | undefined): ArkWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const used = num(raw.used_percent);
  // Absent rather than zero: a bar at 0% claims a window is untouched, which
  // is a different statement from "this window was not reported".
  if (used == null) return null;
  return {
    // Clamped, because a meter drawn past its own track reads as a rendering
    // bug rather than as "over the limit".
    usedPercent: Math.min(100, Math.max(0, used)),
    resetsAtUnix: num(raw.resets_at_unix),
  };
}

/** Is there a stored sign-in, and whose. Never throws — no session is a state,
 *  not a failure. */
export async function arkSessionStatus(): Promise<ArkSessionStatus> {
  try {
    const raw = await invoke<{
      connected?: unknown;
      account_id?: unknown;
      saved_at?: unknown;
    }>("ark_session_status");
    return {
      connected: raw.connected === true,
      accountId: str(raw.account_id),
      savedAt: str(raw.saved_at),
    };
  } catch {
    return { connected: false, accountId: null, savedAt: null };
  }
}

/**
 * Open the Coding Plan page and keep the session the person signs in with.
 *
 * Resolves once the cookies have been observed AND proven by a real quota
 * read. The console sets a `csrfToken` for anonymous visitors too, so a jar can
 * look complete while the password is still being typed — storing that buys a
 * card that says connected over an account that is not.
 */
export function arkConnect(): Promise<ArkAccount> {
  return invoke<{ account_id?: unknown }>("ark_connect").then((raw) => ({
    accountId: str(raw.account_id),
  }));
}

/** Forget the stored sign-in. Aurora's copy only — the console stays signed in. */
export function arkDisconnect(): Promise<void> {
  return invoke<void>("ark_disconnect");
}

/**
 * How much of the plan is left.
 *
 * Throws when there is no session or it has expired, and the message says
 * which — the card's answer to an expired session is a button, not red text.
 */
export async function fetchArkUsage(): Promise<ArkUsage> {
  const raw = await invoke<RawUsage>("ark_usage");
  return {
    tier: str(raw.tier),
    status: str(raw.status),
    windowSession: readWindow(raw.window_session),
    windowWeek: readWindow(raw.window_week),
    windowMonth: readWindow(raw.window_month),
    expiresAt: str(raw.expires_at),
    hasReward: raw.has_reward === true,
  };
}

/**
 * One window's rollover, as a sentence — `resets in 4h 39m`, or `null` when the
 * console sent no timestamp.
 *
 * Volcano sends an INSTANT where kenari sends a duration, so this cannot reuse
 * `kenariResetLabel`. It shares `fmtDuration` with every other provider, which
 * is the part that has to match: a plan resetting "in 4h 39m" here and "4h"
 * elsewhere reads as two different numbers.
 */
export function arkResetLabel(window: ArkWindow | null): string | null {
  if (!window || window.resetsAtUnix == null) return null;
  const seconds = window.resetsAtUnix - Date.now() / 1000;
  if (seconds <= 0) return "resets now";
  return `resets in ${fmtDuration(seconds)}`;
}

/**
 * The plan tier, as a word for the card's title. `pro` → `Pro`.
 *
 * Volcano's own two names, capitalised and otherwise untouched. A tier this
 * does not recognise is passed through rather than dropped, so a third plan
 * appearing later shows its real name instead of vanishing.
 */
export function arkTierLabel(tier: string | null): string | null {
  if (!tier) return null;
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

/**
 * The plan's windows, in the order pressure actually arrives.
 *
 * All three, not the tightest one: running out for the next four hours and
 * running out for the rest of the month are different problems, and one blended
 * figure hides which you are in.
 */
export const ARK_WINDOWS: ReadonlyArray<{
  key: "windowSession" | "windowWeek" | "windowMonth";
  label: string;
}> = [
  { key: "windowSession", label: "Right now" },
  { key: "windowWeek", label: "This week" },
  { key: "windowMonth", label: "This month" },
];
