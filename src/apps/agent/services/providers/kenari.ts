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
 * Wire behavior is model-specific. DeepSeek V4 Pro returned its reasoning on
 * all three when this integration was introduced; GLM 5.3 did not on
 * 2026-08-29. For `glm-5-3`, Chat returned a correct answer plus reasoning,
 * Messages returned text with no reasoning under both budget and adaptive
 * thinking shapes, and Responses returned no reasoning plus a wrong/unrelated
 * answer. The model-row test is therefore the authority, not a blanket claim
 * about the account.
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
import type { LLMProvider } from "@/apps/agent/store/settings/useAgentSettingsStore";

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
      "Anthropic's format. Useful for signed Claude thinking; compatible non-Claude models can return text while silently dropping reasoning, so test the model row.",
  },
  {
    value: "kenari-responses",
    label: "Responses",
    detail:
      "Built for Codex. Model support varies; GLM 5.3 returned no reasoning and failed the deterministic probe. Test before using it.",
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
// Read with the API key: `GET /v1/account/quota` (kenari docs,
// `/en/docs/account-quota`), plus the `x-kenari-plan-remaining` header every
// served chat reply carries, which Rust lays over the last reading
// (`api/kenari/usage.rs`). Until 2026-10-26 the key could not read the
// account and Aurora kept a browser session's cookies for this; that is gone.
//
// An unrestricted key of the account reads it. A shared key or a restricted
// one (model scope, spend cap, token cap) is refused with a reason, which the
// card shows in words.

/**
 * One rolling quota window.
 *
 * `usedFrac` is a FRACTION (0..1), not a percent — the wire sends `0.0088` for
 * a week that is under one percent spent, and reading it as a percent draws a
 * bar over the wrong number. Rupiah figures are whole Rupiah, as the endpoint
 * rounds them (the ceiling down, use up, the remainder down).
 */
export interface KenariWindow {
  usedFrac: number;
  resetsInSecs: number | null;
  resetsAtMs: number | null;
  budgetRp: number | null;
  usedRp: number | null;
  remainingRp: number | null;
}

/** The active coupon, kept apart from the plan: an account can hold one
 *  without a plan. */
export interface KenariCoupon {
  name: string | null;
  usedRp: number | null;
  /** `null` when the coupon has no spending limit. */
  remainingRp: number | null;
  expiresAtMs: number | null;
  scopeModels: string[];
}

/**
 * The plan's headroom.
 *
 * Every window is optional because a plan can leave one uncapped — the
 * endpoint leaves such a window out, and the Studio plan genuinely has no
 * 5-hour cap. An unset window is absent here rather than drawn as a limit that
 * is 100% spent.
 */
export interface KenariUsage {
  planName: string | null;
  window5h: KenariWindow | null;
  windowWeek: KenariWindow | null;
  windowMonth: KenariWindow | null;
  coupon: KenariCoupon | null;
  /** The account's quota-alert threshold: 50, 80 or 90. */
  alertPct: number | null;
  /** A window has reached the account's own threshold — kenari's judgement
   *  (its `alert_pct`), not one Aurora invented. */
  nearLimit: boolean;
  /** When these numbers were read: the endpoint's answer, or the last chat
   *  reply that carried the fractions. */
  fetchedAtMs: number;
}

/** Rust's snake_case, which is what crosses the IPC boundary. */
interface RawWindow {
  used_frac?: unknown;
  resets_in_secs?: unknown;
  resets_at_ms?: unknown;
  budget_rp?: unknown;
  used_rp?: unknown;
  remaining_rp?: unknown;
}

interface RawCoupon {
  name?: unknown;
  used_rp?: unknown;
  remaining_rp?: unknown;
  expires_at_ms?: unknown;
  scope_models?: unknown;
}

interface RawUsage {
  plan_name?: unknown;
  window_5h?: RawWindow | null;
  window_week?: RawWindow | null;
  window_month?: RawWindow | null;
  coupon?: RawCoupon | null;
  alert_pct?: unknown;
  near_limit?: unknown;
  fetched_at_ms?: unknown;
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
    resetsAtMs: num(raw.resets_at_ms),
    budgetRp: num(raw.budget_rp),
    usedRp: num(raw.used_rp),
    remainingRp: num(raw.remaining_rp),
  };
}

function readCoupon(raw: RawCoupon | null | undefined): KenariCoupon | null {
  if (!raw || typeof raw !== "object") return null;
  return {
    name: str(raw.name),
    usedRp: num(raw.used_rp),
    remainingRp: num(raw.remaining_rp),
    expiresAtMs: num(raw.expires_at_ms),
    scopeModels: Array.isArray(raw.scope_models)
      ? raw.scope_models.filter((m): m is string => typeof m === "string")
      : [],
  };
}

/**
 * How much of the plan is left, read with `apiKey`.
 *
 * Throws with a worded reason when the key is missing, refused, shared or
 * restricted — the card shows the words, the ring omits the section.
 */
export async function fetchKenariUsage(apiKey: string): Promise<KenariUsage> {
  const raw = await invoke<RawUsage>("kenari_usage", { apiKey });
  return {
    planName: str(raw.plan_name),
    window5h: readWindow(raw.window_5h),
    windowWeek: readWindow(raw.window_week),
    windowMonth: readWindow(raw.window_month),
    coupon: readCoupon(raw.coupon),
    alertPct: num(raw.alert_pct),
    nearLimit: raw.near_limit === true,
    fetchedAtMs: num(raw.fetched_at_ms) ?? Date.now(),
  };
}

/** Whole Rupiah as kenari's own pages write it: `Rp 297,364`. */
export function fmtRupiah(rp: number): string {
  return `Rp ${Math.round(rp).toLocaleString("en-US")}`;
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
