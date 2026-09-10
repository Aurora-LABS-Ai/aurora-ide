/**
 * Meta Model API (Muse) — the frontend half of the provider row.
 *
 * Meta serves three wires off one address and one key, so this file is shaped
 * like {@link ./kenari} rather than like Command Code or Cursor: there is no
 * adapter to speak to, only a choice of which existing one to use.
 *
 * The Rust side that matches this lives in `src-tauri/src/api/meta.rs`, and it
 * carries the measurements — including the one rule that is Meta's alone, that
 * `tool_choice` accepts nothing but `"auto"`.
 *
 * ## The key reaches the models, not the account
 *
 * Same wall kenari has. An `LLM_…` key is accepted by `/v1/models`,
 * `/v1/responses`, `/v1/chat/completions` and `/v1/messages`, and is refused
 * by everything account-shaped — every usage, billing, credit and identity
 * path answers a clean JSON 404 from Meta's own router, and `dev.meta.ai`
 * hands the key a login page. Meta's published API surface is six resources
 * (Responses, Chat Completions, Messages, Files, Models, Status) and not one
 * of them reports usage. Responses carry no rate-limit headers either.
 *
 * So account figures need a sign-in, exactly as kenari's do. Muse Code's own
 * sign-in is an OIDC **device flow** — `muse` prints a code, you approve it in
 * a browser — against `auth.meta.com` with client id `1031625952748946`,
 * storing the result at `~/.config/muse/auth.json`. That flow is live and
 * verified; whether the token it grants also reads billing is the open
 * question, because the launcher only ever uses it to authenticate release
 * downloads.
 */

import type { LLMProvider } from "@/kernel/store/useSettingsStore";

export const META_PROVIDER_ID = "meta";

/** One address for all three wires; each client appends its own path. */
export const META_BASE_URL = "https://api.meta.ai/v1";

/** The live catalogue. Needs the key — unlike kenari's, it is not public. */
export const META_MODELS_URL = `${META_BASE_URL}/models`;

/** Where a key is created. Linked from the provider row. */
export const META_KEYS_URL = "https://dev.meta.ai/";

export type MetaWire = "meta" | "meta-messages" | "meta-responses";

/**
 * The wire choices, in the order they are offered.
 *
 * Responses is first because it is the default and the only one that keeps
 * reasoning across a tool call — Meta's own guidance for coding agents.
 */
export const META_WIRES: ReadonlyArray<{
  value: MetaWire;
  label: string;
  /** Shown under the picker so the choice is made with its cost visible. */
  detail: string;
}> = [
  {
    value: "meta-responses",
    label: "Responses",
    detail:
      "Recommended. Carries the model's reasoning from one tool call to the next, which is what keeps long agent runs coherent.",
  },
  {
    value: "meta",
    label: "Chat",
    detail:
      "OpenAI's format. Works, but drops the reasoning between turns — Meta warns this makes multi-step runs erratic. Use it for single questions.",
  },
  {
    value: "meta-messages",
    label: "Messages",
    detail:
      "Anthropic's format. Useful if you are porting something already written against it; it offers nothing the Responses wire does not.",
  },
];

/** Whether this provider row is Meta, on any of its three wires. */
export function isMetaProvider(
  provider: Pick<LLMProvider, "id" | "providerType">,
): boolean {
  return (
    provider.id === META_PROVIDER_ID ||
    (provider.providerType ?? "").startsWith("meta")
  );
}

/**
 * The wire this provider is set to.
 *
 * Falls back to Responses, which is both the default and the right answer for
 * a row stored before the picker existed.
 */
export function metaWire(
  provider: Pick<LLMProvider, "id" | "providerType">,
): MetaWire {
  const type = provider.providerType;
  if (type === "meta" || type === "meta-messages") return type;
  return "meta-responses";
}

// ── The contributor tier ─────────────────────────────────────────────────────

/**
 * Does this model id run on the contributor tier?
 *
 * Meta sells the same model twice. `muse-spark-1.3` and
 * `muse-spark-1.3-contributor` are one model; the second costs roughly a
 * twelfth as much and is priced that way because Meta keeps what you send it.
 *
 * This is a suffix test rather than a list so a `1.4-contributor` released
 * tomorrow is caught the day it appears, instead of quietly reading as the
 * private tier until someone updates a constant.
 */
export function isContributorModel(model: string): boolean {
  return model.trim().toLowerCase().endsWith("-contributor");
}

/**
 * What the contributor tier actually costs you, for display next to the model.
 *
 * Stated as consequence and scope, not as alarm: it is a legitimate trade that
 * Meta's own dashboard recommends, and the person choosing it on a hobby repo
 * is choosing correctly. The words that matter are which models it applies to
 * and what leaves the machine — someone scanning a model picker should not
 * have to open pricing docs to learn that this row is the training-data one.
 */
export const CONTRIBUTOR_NOTICE =
  "Meta trains on what you send this model, including your code and its replies. The same model without “Contributor” costs more and is not used for training.";

// ── Rate limits ──────────────────────────────────────────────────────────────

/**
 * Meta's published per-minute ceilings, by tier.
 *
 * Worth holding in the app because the contributor limit is genuinely tight
 * for an agent: 100 requests a minute is a couple of dozen tool calls, and a
 * fast loop can reach it. The standard tier's 3,000 effectively cannot be hit
 * by one person.
 *
 * These are per team, not per key — Meta's docs are explicit that keys on the
 * same team share them, so a second key is not a way around a limit.
 */
export const META_RATE_LIMITS: Readonly<
  Record<"standard" | "contributor", { requestsPerMin: number; tokensPerMin: number }>
> = {
  standard: { requestsPerMin: 3_000, tokensPerMin: 4_000_000 },
  contributor: { requestsPerMin: 100, tokensPerMin: 3_000_000 },
};

/** The rate-limit tier a model runs under. */
export function metaRateLimitTier(model: string): "standard" | "contributor" {
  return isContributorModel(model) ? "contributor" : "standard";
}
