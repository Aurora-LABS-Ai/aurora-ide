/**
 * Command Code — provider service.
 *
 * ## What it is
 *
 * One subscription that resells around seventy models: DeepSeek V4, GLM-5.3,
 * Kimi K3, MiniMax M3, Qwen 3.8 and the rest of the open set, plus Claude,
 * GPT-5.6, Gemini and Grok on the higher tiers. One key, one bill.
 *
 * ## Two ways to connect, both first-class
 *
 * 1. **Paste a key** from the Studio dashboard into the provider's API key
 *    field. It stores like every other provider's key and needs no CLI.
 * 2. **Let Aurora find `~/.commandcode/auth.json`.** Anyone who already runs
 *    `cmd` is connected the moment they add the provider, with nothing to
 *    paste. Aurora's browser sign-in writes that same file, so signing in here
 *    signs the CLI in too.
 *
 * The pasted key wins when both exist, so someone can point Aurora at a second
 * account without disturbing the terminal they use every day.
 *
 * ## Why this needs Rust and OpenCode Go did not
 *
 * OpenCode Go was a preset and nothing more: an ordinary OpenAI-compatible
 * endpoint with an ordinary bearer key. This is not that. The request body
 * nests the model parameters under `params` beside a mandatory `config` block,
 * and the response is newline-delimited JSON rather than SSE. So the wire lives
 * in `src-tauri/src/api/commandcode/`, and this module only handles the account
 * and the catalog.
 *
 * ## Plans
 *
 * Model access is tiered (Go < GOAT < Pro < Max) and enforced when a request is
 * made, not when the catalog is listed: every plan sees every model, and one
 * outside your tier answers `MODEL_NOT_IN_PLAN` naming the tier it needs. So
 * the import below adds the whole catalog rather than guessing at a plan, and
 * the error explains itself the first time an out-of-tier model is used. A
 * model that silently went missing from the picker would read as a bug.
 */

import { auroraInvoke as invoke } from "@/kernel/lib/ipc/runtime";
import { fmtResetsIn } from "@/apps/agent/lib/time/duration";
import type { ProviderCatalogPreset } from "@/apps/agent/services/providers/provider-catalog";

// ── Constants ────────────────────────────────────────────────────────────────

export const COMMANDCODE_PROVIDER_ID = "commandcode";

/** Where a key is created by hand, for the paste path. */
export const COMMANDCODE_STUDIO_URL = "https://commandcode.ai/studio";

/**
 * Base URL on the provider row.
 *
 * Recorded for the settings page to display, not used to route: the endpoint
 * is fixed in the Rust adapter so a stale row cannot misdirect a subscription
 * call.
 */
export const COMMANDCODE_BASE_URL = "https://api.commandcode.ai";

/** Whether this provider row is Command Code. */
export function isCommandCodeProvider(provider: { id?: string }): boolean {
  return provider.id === COMMANDCODE_PROVIDER_ID;
}

// ── Account ──────────────────────────────────────────────────────────────────

export interface CommandCodeAuthStatus {
  /** A usable key sits in `~/.commandcode/auth.json`. */
  signedIn: boolean;
  userName: string | null;
  keyName: string | null;
  authenticatedAt: string | null;
  /** Where Aurora looked, so a "not found" can name the path. */
  authPath: string | null;
  /** The Command Code CLI is installed on this machine. */
  cliInstalled: boolean;
  /**
   * The version Aurora sends on every request. The header is mandatory and
   * floor-checked, so this tracks the installed CLI when there is one.
   */
  cliVersion: string;
  cliVersionDetected: boolean;
  dashboardUrl: string;
}

/** One rolling spend window. Caps and spend are dollars. */
export interface CommandCodeWindow {
  used: number;
  cap: number;
  exceeded: boolean;
  /** Unix milliseconds, so a card left open keeps counting down. */
  resetAtMs: number | null;
}

export interface CommandCodeCredits {
  monthly: number;
  purchased: number;
  free: number;
  belowThreshold: boolean;
}

export interface CommandCodeUsageSnapshot {
  planId: string | null;
  /** Readable tier: Go, GOAT, Pro, Max. */
  planLabel: string | null;
  status: string | null;
  renewsAt: string | null;
  cancelAtPeriodEnd: boolean;
  credits: CommandCodeCredits;
  fiveHour: CommandCodeWindow | null;
  weekly: CommandCodeWindow | null;
  /** Some plans report no windows; a meter would invent a ceiling. */
  limited: boolean;
  accountName: string | null;
  accountEmail: string | null;
}

export interface CommandCodeModel {
  id: string;
  name: string;
  /** Tokens, when the catalog states one. */
  contextLength: number | null;
}

/** Whether a CLI sign-in exists, and which version header will be sent. */
export function fetchCommandCodeStatus(): Promise<CommandCodeAuthStatus> {
  return invoke<CommandCodeAuthStatus>("commandcode_auth_status");
}

/** Open the browser sign-in and wait for it to land. */
export function commandCodeSignIn(): Promise<CommandCodeAuthStatus> {
  return invoke<CommandCodeAuthStatus>("commandcode_auth_login");
}

export function commandCodeCancelSignIn(): Promise<void> {
  return invoke<void>("commandcode_auth_cancel_login");
}

/**
 * Remove `~/.commandcode/auth.json`.
 *
 * This signs the CLI out too, because it is one shared file. A key pasted into
 * the provider row is untouched.
 */
export function commandCodeSignOut(): Promise<CommandCodeAuthStatus> {
  return invoke<CommandCodeAuthStatus>("commandcode_auth_logout");
}

/**
 * Copy a pasted key into the shared credential file so `cmd` uses the same
 * account. Optional: the provider works without it.
 */
export function commandCodeStoreKey(apiKey: string): Promise<CommandCodeAuthStatus> {
  return invoke<CommandCodeAuthStatus>("commandcode_auth_store_key", { apiKey });
}

/**
 * Plan, both rolling spend windows, and the credit balance.
 *
 * `apiKey` is the provider row's key; empty falls back to the CLI's stored
 * one, which is the same order a real request uses.
 */
export function fetchCommandCodeUsage(apiKey: string): Promise<CommandCodeUsageSnapshot> {
  return invoke<CommandCodeUsageSnapshot>("commandcode_usage_get", { apiKey });
}

/**
 * How much of a window is spent, 0–1.
 *
 * Clamped: a meter drawn past its own track reads as a rendering bug rather
 * than as "over the limit", and `exceeded` carries that fact already.
 */
export function commandCodeWindowRatio(window: CommandCodeWindow): number {
  if (!(window.cap > 0)) return 0;
  return Math.min(1, Math.max(0, window.used / window.cap));
}

/** `resets in 3h 12m`, or null when the window carries no reset time. */
export function commandCodeResetLabel(window: CommandCodeWindow | null): string | null {
  if (!window?.resetAtMs) return null;
  return fmtResetsIn(new Date(window.resetAtMs).toISOString());
}

/**
 * Dollars, at the precision the number deserves.
 *
 * Spend here runs from fractions of a cent to tens of dollars, so a fixed two
 * decimals would render a real charge as `$0.00` — the one rendering that
 * makes a paid request look free.
 */
export function commandCodeMoney(value: number): string {
  if (value === 0) return "$0";
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/**
 * The catalog. `apiKey` is the provider row's key; empty falls back to the
 * CLI's stored one, which is the same order a real request uses.
 */
export function fetchCommandCodeModels(apiKey: string): Promise<CommandCodeModel[]> {
  return invoke<CommandCodeModel[]>("commandcode_list_models", { apiKey });
}

// ── Preset ───────────────────────────────────────────────────────────────────

/**
 * The shipped provider row.
 *
 * `customModels` is empty because the catalog is pulled from the account, and a
 * seeded guess would put ids in the picker that the first refresh contradicts.
 *
 * No pricing. Command Code publishes per-million rates and also bills a
 * subscription, so a hardcoded table would be a maintenance trap that goes
 * quietly wrong; unset renders as "not applicable" rather than as a measured
 * zero. Anyone who wants cost tracking can set rates per model with the same
 * controls every other provider uses.
 *
 * `requiresApiKey` is false: the row works with nothing pasted when the CLI is
 * already signed in. Marking it true would put a "needs a key" warning on a
 * provider that is ready to use.
 */
export const COMMANDCODE_PRESET: ProviderCatalogPreset = {
  id: COMMANDCODE_PROVIDER_ID,
  name: "Command Code",
  baseUrl: COMMANDCODE_BASE_URL,
  // A real id on the cheapest tier, so a fresh install with nothing chosen has
  // something sendable rather than a placeholder that fails on first use.
  model: "zai-org/GLM-5.2",
  contextWindow: 1_000_000,
  maxOutputTokens: 64_000,
  supportsThinking: true,
  supportsToolStream: true,
  supportsVision: false,
  providerType: "commandcode",
  requiresApiKey: false,
  customModels: [],
};

// ── Model import ─────────────────────────────────────────────────────────────

/**
 * Whether a model returns visible reasoning **through this gateway**.
 *
 * Not the same question as "can this model think". Command Code decides the
 * upstream wire per model, and that decision changes the answer:
 *
 * - GLM-5.2 goes out as chat completions and streams `reasoning-delta` with no
 *   prompting at all: 136 deltas and 900 reasoning tokens on a hard puzzle.
 * - Every MiniMax id goes out over the **Anthropic Messages** wire (the API's
 *   own error names the model `anthropic:MiniMaxAI/MiniMax-M3`, and usage comes
 *   back Anthropic-shaped). Extended thinking on that wire has to be asked for
 *   with a `thinking` block, and Command Code sends none — so M3 and M2.7
 *   return zero reasoning deltas and an empty `outputTokenDetails`, however
 *   hard the question.
 *
 * There is no client-side lever: `reasoningEffort`, `reasoning`, `effort` and
 * the `model:effort` suffix are all either rejected or silently dropped, and
 * the echoed upstream body is unchanged by every one of them.
 *
 * So MiniMax is seeded thinking-off here. models.dev correctly says the model
 * reasons, and believing it would put a thinking control on a row that can
 * never produce any — a toggle that does nothing is worse than an absent one.
 * The flag stays editable in the Models section for whenever this changes.
 */
function reasonsOnCommandCode(modelId: string, known: boolean | undefined): boolean {
  if (/^minimax/i.test(modelId)) return false;
  // On unless known otherwise: the endpoint streamed reasoning for every other
  // model tested, including ones models.dev has never heard of.
  return known ?? true;
}

export interface CommandCodeImportResult {
  added: number;
  /** Already listed, and left exactly as the user had them. */
  skipped: number;
}

/**
 * Add catalog models that are not in the list yet.
 *
 * Additive on purpose. Rows already present are left alone: they are ordinary
 * models the user may have renamed, re-priced or set a reasoning tier on, and
 * an import that overwrote them would undo that silently. Anything unwanted
 * comes off with the same delete control every other provider's models use.
 */
export async function importCommandCodeModels(
  apiKey: string,
): Promise<CommandCodeImportResult> {
  const [{ useSettingsStore }, { lookupModel }] = await Promise.all([
    import("@/kernel/store/useSettingsStore"),
    import("@/apps/agent/services/providers/models-dev"),
  ]);

  const catalog = await fetchCommandCodeModels(apiKey);

  const existing = new Set(
    useSettingsStore
      .getState()
      .models.filter((model) => model.providerId === COMMANDCODE_PROVIDER_ID)
      .map((model) => model.modelKey),
  );

  const missing = catalog.filter((model) => !existing.has(model.id));

  const rows = await Promise.all(
    missing.map(async (model) => {
      // models.dev knows things the catalog does not say: whether a model
      // sees images, and which reasoning tiers it takes. It is consulted
      // without a provider hint because these ids are the upstream vendors'
      // own, not Command Code's relabelling.
      const known = await lookupModel(model.id).catch(() => null);
      return {
        modelKey: model.id,
        label: model.name?.trim() || model.id,
        // The catalog's own number wins: it is what this gateway will
        // actually accept, which is not always what the vendor publishes.
        contextWindow: model.contextLength ?? known?.contextWindow,
        maxOutputTokens: known?.maxOutputTokens,
        // Off unless known, because sending an image to a model that cannot
        // read one is an error, not a degraded answer.
        supportsVision: known?.supportsVision ?? false,
        // What this GATEWAY delivers, which is not always what the model can
        // do — see the note on the helper.
        supportsThinking: reasonsOnCommandCode(model.id, known?.supportsThinking),
        supportsToolStream: true,
        priceCacheHitPerMtok: undefined,
        priceCacheMissPerMtok: undefined,
        priceOutputPerMtok: undefined,
        priceCacheWritePerMtok: undefined,
        reasoning: known?.reasoning,
        enabled: true,
      };
    }),
  );

  const store = useSettingsStore.getState();
  for (const row of rows) store.addModel(COMMANDCODE_PROVIDER_ID, row);

  return { added: rows.length, skipped: catalog.length - missing.length };
}

/** Exported for tests. */
export const __test = { reasonsOnCommandCode };
