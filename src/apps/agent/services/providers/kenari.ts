/**
 * kenari — one account, one key, three wire formats.
 *
 * kenari is a gateway: a single `kn-` key reaches models from Anthropic,
 * OpenAI, Google, DeepSeek, Qwen, GLM, MiniMax and xAI, billed in Rupiah from a
 * prepaid balance. What makes it unlike Aurora's other providers is that the
 * SAME account answers on three different wires, and the choice is real — each
 * one behaves differently under a tool-calling agent.
 *
 * All three were measured against the live API on `deepseek-v4-pro` before this
 * was written; the notes below are results, not readings of a docs page.
 *
 * **All three return the model's actual reasoning trace, in full.** That is
 * worth stating because the Responses wire delivers it through events named
 * `response.reasoning_summary_text.*` — OpenAI's summary channel, and the only
 * reasoning channel that wire defines. The name is inherited; the content is
 * the raw first-person trace, the same shorthand the other two wires return.
 *
 * Where they genuinely differ:
 *
 * - **Chat** (`/chat/completions`) — the default, and the one to use. The only
 *   wire every chat model serves: all 54 in the live catalogue list
 *   `endpoints: ["chat"]`. Reasoning arrives in `reasoning` + `reasoning_content`,
 *   both of which Aurora's OpenAI reader already handles, and effort is asked
 *   for with the `reasoning_effort` field Aurora already sends.
 * - **Messages** (`/messages`) — the Anthropic shape. The one wire that streams
 *   a `signature` alongside each thinking block, so a Claude model's reasoning
 *   can be replayed intact. Authenticates with `x-api-key` as well as Bearer,
 *   so Aurora's existing Anthropic client works against it unchanged.
 * - **Responses** (`/responses`) — the Codex wire. Stateless only
 *   (`previous_response_id` is a hard 400) and it silently drops any tool that
 *   is not a plain function. It exists upstream because recent Codex CLI has no
 *   chat wire left, which is a reason for kenari to offer it, not a reason for
 *   us to choose it.
 */

import { auroraInvoke as invoke } from "@/kernel/lib/ipc/runtime";
import { fmtDuration } from "@/apps/agent/lib/time/duration";
import type { LLMProvider } from "@/kernel/store/useSettingsStore";

export const KENARI_PROVIDER_ID = "kenari";

/** kenari's base address. Every client appends its own path to this. */
export const KENARI_BASE_URL = "https://kenari.id/v1";

/** The public, keyless catalogue. kenari's own docs say not to hard-code a list. */
export const KENARI_MODELS_URL = `${KENARI_BASE_URL}/models`;

export type KenariWire = "kenari" | "kenari-messages" | "kenari-responses";

/**
 * The wire choices, in the order they are offered. Chat is first because it is
 * the default and the one with no caveats.
 */
export const KENARI_WIRES: ReadonlyArray<{
  value: KenariWire;
  label: string;
  /** Shown under the picker so the choice is made with its cost visible. */
  detail: string;
}> = [
  {
    value: "kenari",
    label: "Chat",
    detail:
      "Recommended. Reaches every model kenari offers, streams the full reasoning trace, and handles tool calls.",
  },
  {
    value: "kenari-messages",
    label: "Messages",
    detail:
      "Anthropic's format. The only one that signs each reasoning block, so a Claude model's thinking survives into the next turn.",
  },
  {
    value: "kenari-responses",
    label: "Responses",
    detail:
      "Built for Codex. Cannot carry a conversation forward on its own, and drops any tool that is not a plain function.",
  },
];

/** Whether this provider row is kenari, on any of its three wires. */
export function isKenariProvider(
  provider: Pick<LLMProvider, "id" | "providerType">,
): boolean {
  return (
    provider.id === KENARI_PROVIDER_ID ||
    (provider.providerType ?? "").startsWith("kenari")
  );
}

/**
 * The wire this provider is set to. Falls back to chat, which is both the
 * default and the safe answer for a row stored before the picker existed.
 */
export function kenariWire(
  provider: Pick<LLMProvider, "id" | "providerType">,
): KenariWire {
  const type = provider.providerType;
  if (type === "kenari-messages" || type === "kenari-responses") return type;
  return "kenari";
}

// ── Plan usage ───────────────────────────────────────────────────────────────
//
// ## Why this needs a sign-in and not the key
//
// The `kn-` key reaches the models. It does not reach the account. Every
// account-shaped read lives on the dashboard's `/api/*` surface, which answers
// `401 no session` to the key as a bearer token, as `x-api-key`, and as a
// cookie — measured on three endpoints, on both a dashboard key and one minted
// by `kenari login`.
//
// That is not an oversight to route around. `openapi.json` lists twenty-one
// paths and not one of them is an account read, and kenari's own CLI contains
// exactly three kenari URLs (`/v1/models`, `/api/cli-auth/token`, and a printed
// dashboard link) with no usage command at all.
//
// **kenari's MCP server is the one exception, and it answers a different
// question.** `https://kenari.id/mcp` exposes a key-authenticated
// `kenari_usage` returning 30 days of per-model requests and tokens. Useful,
// and reachable through Aurora's existing MCP client with no code — but it
// takes no arguments, returns Markdown rather than JSON, and reports WALLET
// cost, which is `Rp 0` for every plan-billed request. It cannot say how much
// of the weekly window is gone, which is the only thing the ring draws.
//
// So the ring reads a session, captured by signing in to kenari's own page in
// a window Aurora opens. See `commands/kenari.rs` for how that is taken and
// why the User-Agent travels with it.

/** Whether Aurora holds a kenari sign-in, and whose. */
export interface KenariSessionStatus {
  connected: boolean;
  email: string | null;
  /** RFC3339. Displayed only — expiry is discovered by being refused. */
  savedAt: string | null;
}

/** What a completed sign-in reports back. */
export interface KenariAccount {
  email: string | null;
  /** kenari's own rate, so a Rupiah figure can be shown in dollars without
   *  Aurora inventing an exchange rate. */
  usdIdrRate: number | null;
}

/**
 * One rolling quota window.
 *
 * `usedFrac` is a FRACTION (0..1), not a percent — the wire sends
 * `0.20203278766666666` for a fifth-spent week, and reading it as a percent
 * draws a 0.2%-full bar over a fifth-spent window.
 */
export interface KenariWindow {
  usedFrac: number;
  resetsInSecs: number | null;
}

/**
 * The plan's headroom.
 *
 * Every window is optional because a plan can leave one unset — `/api/plans`
 * reports `0` for "no limit on this window", and the Studio plan genuinely has
 * no 5-hour or monthly cap. An unset window is absent here rather than drawn as
 * a limit that is 100% spent.
 */
export interface KenariUsage {
  planName: string | null;
  planStatus: string | null;
  window5h: KenariWindow | null;
  windowWeek: KenariWindow | null;
  windowMonth: KenariWindow | null;
  webSearchAllowance: number | null;
  webSearchUsedToday: number | null;
  /** Spend this billing cycle, in micro-Rupiah — kenari's own unit, divided
   *  where it is displayed so nothing is rounded twice. */
  catalogThisCycleMicroIdr: number | null;
  marketThisCycleMicroIdr: number | null;
  /** kenari's own judgement that the account is close to a limit, not a
   *  threshold Aurora invented. */
  nearLimit: boolean;
}

/** Rust's snake_case, which is what crosses the IPC boundary. */
interface RawWindow {
  used_frac?: unknown;
  resets_in_secs?: unknown;
}

interface RawUsage {
  plan_name?: unknown;
  plan_status?: unknown;
  window_5h?: RawWindow | null;
  window_week?: RawWindow | null;
  window_month?: RawWindow | null;
  web_search_allowance?: unknown;
  web_search_used_today?: unknown;
  catalog_this_cycle_micro_idr?: unknown;
  market_this_cycle_micro_idr?: unknown;
  near_limit?: unknown;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readWindow(raw: RawWindow | null | undefined): KenariWindow | null {
  if (!raw || typeof raw !== "object") return null;
  return {
    // Clamped, because a meter drawn past its own track reads as a rendering
    // bug rather than as "over the limit".
    usedFrac: Math.min(1, Math.max(0, num(raw.used_frac) ?? 0)),
    resetsInSecs: num(raw.resets_in_secs),
  };
}

/** Is there a stored sign-in, and whose. Never throws — no session is a state,
 *  not a failure. */
export async function kenariSessionStatus(): Promise<KenariSessionStatus> {
  try {
    const raw = await invoke<{
      connected?: unknown;
      email?: unknown;
      saved_at?: unknown;
    }>("kenari_session_status");
    return {
      connected: raw.connected === true,
      email: str(raw.email),
      savedAt: str(raw.saved_at),
    };
  } catch {
    return { connected: false, email: null, savedAt: null };
  }
}

/**
 * Open kenari's login page and keep the session signed in with.
 *
 * Resolves once a cookie has been observed AND verified — a `kn_session` can
 * exist before a password is accepted, and storing it on sight buys a card that
 * says "connected" over an account that is not. Rejects when the person closes
 * the window or five minutes pass.
 */
export function kenariConnect(): Promise<KenariAccount> {
  return invoke<{ email?: unknown; usd_idr_rate?: unknown }>("kenari_connect").then(
    (raw) => ({ email: str(raw.email), usdIdrRate: num(raw.usd_idr_rate) }),
  );
}

/** Forget the stored sign-in. Aurora's copy only — kenari.id stays signed in. */
export function kenariDisconnect(): Promise<void> {
  return invoke<void>("kenari_disconnect");
}

/**
 * How much of the plan is left.
 *
 * Throws when there is no session or the session has expired, and the message
 * says which — the card's answer to an expired session is a button, not an
 * error in red.
 */
export async function fetchKenariUsage(): Promise<KenariUsage> {
  const raw = await invoke<RawUsage>("kenari_usage");
  return {
    planName: str(raw.plan_name),
    planStatus: str(raw.plan_status),
    window5h: readWindow(raw.window_5h),
    windowWeek: readWindow(raw.window_week),
    windowMonth: readWindow(raw.window_month),
    webSearchAllowance: num(raw.web_search_allowance),
    webSearchUsedToday: num(raw.web_search_used_today),
    catalogThisCycleMicroIdr: num(raw.catalog_this_cycle_micro_idr),
    marketThisCycleMicroIdr: num(raw.market_this_cycle_micro_idr),
    nearLimit: raw.near_limit === true,
  };
}

/**
 * One window's rollover, as a sentence — `resets in 4d 15h`, or `null` when the
 * far end sent no countdown.
 *
 * kenari sends a DURATION where Codex and OpenCode send an instant, so this
 * cannot reuse `fmtResetsIn`. It shares `fmtDuration` with them, which is the
 * part that has to match: a plan resetting "in 4d 15h" here and "4d" elsewhere
 * reads as two different numbers.
 */
export function kenariResetLabel(window: KenariWindow | null): string | null {
  if (!window || window.resetsInSecs == null) return null;
  if (window.resetsInSecs <= 0) return "resets now";
  return `resets in ${fmtDuration(window.resetsInSecs)}`;
}

/**
 * The plan's windows, in the order pressure actually arrives.
 *
 * All of them, not the tightest one: running out weekly on a Tuesday and
 * running out for the next ten minutes are different problems, and a single
 * blended figure hides which one you are in. Windows the plan does not set are
 * absent from the data and so draw nothing.
 */
export const KENARI_WINDOWS: ReadonlyArray<{
  key: "window5h" | "windowWeek" | "windowMonth";
  label: string;
}> = [
  { key: "window5h", label: "Right now" },
  { key: "windowWeek", label: "This week" },
  { key: "windowMonth", label: "This month" },
];
