/**
 * OpenCode Go — provider service.
 *
 * ## Go, not Zen
 *
 * OpenCode sells two things through one domain, and they are not variants of
 * each other:
 *
 * - **Zen** (`/zen/v1`) is a credit-based API. You top up a balance and pay per
 *   token. It is an ordinary paid API key, no different in kind from OpenAI's.
 * - **Go** (`/zen/go/v1`) is the **subscription**: a flat plan, and its own
 *   smaller model list.
 *
 * Aurora ships **Go only**, deliberately. Zen would add a provider that gives
 * a subscriber nothing they cannot already get by adding a custom
 * OpenAI-compatible row, and it bills separately — the exact thing a
 * subscription exists to avoid. The two even use different keys: OpenCode's own
 * credential file stores them under separate names, and a Zen key on the Go
 * endpoint answers `CreditsError: No payment method`, which would surface as a
 * billing failure on a plan already paid for.
 *
 * ## Why this is a preset and not an integration
 *
 * Unlike Cursor, there was nothing to reverse-engineer. It is an ordinary
 * HTTPS API with a plain `sk-…` bearer key and **no other headers of any
 * kind** — the `x-opencode-*` headers OpenCode's own CLI sends are not
 * required — so an existing Rust adapter drives it and this feature adds no
 * Rust to the request path at all.
 *
 * ## Which surface, and why it matters
 *
 * The endpoint answers on **both** shapes, and they are not equivalent:
 *
 * - `/chat/completions` — works, streams, calls tools, reports usage with
 *   `prompt_tokens_details.cached_tokens`. But it returns **no reasoning at
 *   all**. Measured against `gpt-5.6-luna` with `reasoning_effort: "xhigh"`,
 *   with `reasoning: {effort, summary}`, and with `include_reasoning: true`:
 *   every one answered 200 and every one carried zero reasoning fields. The
 *   parameters are accepted and the thinking is dropped.
 * - `/responses` — the same model, same key, same question: 162
 *   `response.reasoning_summary_text.delta` events plus
 *   `reasoning.encrypted_content` items, and it closes on `response.completed`.
 *
 * So the preset speaks **Responses**, and the provider page offers the switch
 * (`OPENCODE_WIRES`) the way kenari's does — the choice changes real behaviour,
 * so it belongs on the page with its cost written under it rather than buried
 * in an extra-fields box. On chat completions a reasoning model silently reads
 * as one that does not think, which is the worst of both: the plan is billed
 * for the reasoning either way.
 *
 * Two quirks of the chat-completions surface, worth keeping written down
 * because `openai_compat.rs` still meets them through custom rows: it sends
 * **no `[DONE]`** and leaves `finish_reason` null on every chunk, closing
 * instead on a choice-less usage frame followed by `{"choices":[],"cost":"0"}`
 * — which Aurora reads as a goodbye (see `openai_compat.rs`), and without that
 * every completed reply looked like a dropped connection.
 */

import { auroraInvoke as invoke } from "@/kernel/lib/ipc/runtime";
import { fmtResetsIn } from "@/apps/agent/lib/time/duration";
import type { ProviderCatalogPreset } from "@/apps/agent/services/providers/provider-catalog";

// ── Constants ────────────────────────────────────────────────────────────────

export const OPENCODE_PROVIDER_ID = "opencode-go";

/** The subscription surface. `/zen/v1` — the credit API — is deliberately unused. */
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

/** Where a subscriber gets their key. Linked rather than described. */
export const OPENCODE_KEY_URL = "https://opencode.ai/auth";

// ── Detection ────────────────────────────────────────────────────────────────

export function isOpenCodeProvider(provider: { id?: string }): boolean {
  return provider.id === OPENCODE_PROVIDER_ID;
}

// ── Which wire ───────────────────────────────────────────────────────────────

/**
 * The provider types this row can carry.
 *
 * `opencode-go` — the bare id — is Responses, and that is deliberate: the base
 * type has to be a PREFIX of its variants for a stored choice to survive a
 * relaunch (`resolveProviderType`), and it doubles as the fallback when a row
 * arrives with no type at all, so a half-written row still lands on the wire
 * that works.
 */
export type OpenCodeWire = "opencode-go" | "opencode-go-chat";

/**
 * The two shapes this endpoint answers on, and what choosing one costs.
 *
 * There is no third. `/messages` — the Anthropic shape — is reachable and
 * authenticates with `x-api-key`, but answers **400 with an empty assistant
 * message** for every model on the plan, streaming or not. It is not offered
 * rather than offered-and-broken.
 */
export const OPENCODE_WIRES: ReadonlyArray<{
  value: OpenCodeWire;
  label: string;
  /** Shown under the picker, so the choice is made with its cost visible. */
  detail: string;
}> = [
  {
    value: "opencode-go",
    label: "Responses",
    detail:
      "Recommended. The only format that shows the model's reasoning and carries it into the next turn.",
  },
  {
    value: "opencode-go-chat",
    label: "Chat",
    detail:
      "A fallback. Streams replies and runs tools, but reasoning never comes back on this format.",
  },
];

/** Which wire this row is on. Unknown / missing reads as the default. */
export function openCodeWire(provider: { providerType?: string | null }): OpenCodeWire {
  return provider.providerType === "opencode-go-chat" ? "opencode-go-chat" : "opencode-go";
}

// ── Importing the key the OpenCode CLI already has ───────────────────────────

/**
 * The Go subscription key from a local OpenCode install, or `null`.
 *
 * Reads OpenCode's own credential file, the way the Cursor provider reads the
 * Cursor app's session — a subscription someone already set up should not have
 * to be set up twice.
 *
 * Specifically the `opencode-go` entry. The same file also holds an `opencode`
 * key for Zen, the credit-billed API, and the two are **not** interchangeable:
 * a Zen key on the Go endpoint answers `CreditsError: No payment method`,
 * which sends a subscriber to a billing page for a plan they already pay for.
 */
export function openCodeLocalKey(): Promise<string | null> {
  return invoke<string | null>("opencode_local_key");
}

/** Where Aurora looked — shown when it found nothing. */
export function openCodeAuthPath(): Promise<string | null> {
  return invoke<string | null>("opencode_auth_path");
}

// ── Seeded provider preset ───────────────────────────────────────────────────

/**
 * The OpenCode Go provider row.
 *
 * `customModels` is empty: the plan decides what exists and the list is pulled
 * from the account, so seeding a guess would put models in the picker that a
 * refresh then contradicts.
 *
 * No pricing, because usage bills against the subscription — a zero would
 * render as a measured `$0.00` rather than "not applicable".
 */
export const OPENCODE_PRESET: ProviderCatalogPreset = {
  id: OPENCODE_PROVIDER_ID,
  name: "OpenCode Go",
  nickname: "OpenCode",
  baseUrl: OPENCODE_GO_BASE_URL,
  // A real id on the Go list, so a fresh install with nothing chosen still has
  // something sendable rather than a placeholder that fails on first use.
  model: "glm-5.2",
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  supportsThinking: true,
  supportsToolStream: true,
  supportsVision: false,
  // Responses by default, switchable to Chat on the provider page. See the
  // surface note at the top of this file and `OPENCODE_WIRES`.
  providerType: "opencode-go",
  requiresApiKey: true,
  customModels: [],
};

// ── Model discovery ──────────────────────────────────────────────────────────

export interface OpenCodeModel {
  /** The id sent as `model`. */
  id: string;
  /** A readable name derived from the id — the wire carries none. */
  label: string;
  /**
   * A free tier the plan does not bill for. Folded away by default: these are
   * previews and contributor builds, not what a subscriber came for.
   */
  isFree: boolean;
}

interface ModelsResponse {
  data?: Array<{ id?: unknown }>;
}

/**
 * The models this plan can reach.
 *
 * The endpoint needs **no authentication at all**, which is why the catalogue
 * renders before a key is pasted — someone can see what the subscription
 * reaches before setting it up, and a key that turns out to be wrong fails at
 * the first turn rather than by showing an empty list.
 *
 * Fetched through Rust, not `fetch`: `opencode.ai` sends no
 * `Access-Control-Allow-Origin`, so the browser refuses the request before it
 * leaves — in the packaged app as much as the dev server, because the webview
 * is still a browser. Rust has no such restriction.
 */
export async function fetchOpenCodeModels(): Promise<OpenCodeModel[]> {
  const body = await invoke<ModelsResponse>("opencode_models");

  const seen = new Set<string>();
  const models: OpenCodeModel[] = [];
  for (const entry of body.data ?? []) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: prettyLabel(id), isFree: id.endsWith("-free") });
  }
  return models;
}

// ── Plan usage ───────────────────────────────────────────────────────────────

/** One limit window. `percent` is how much of it this plan has spent. */
export interface OpenCodeUsageWindow {
  status: string;
  percent: number;
  /** RFC3339 instant the window rolls over. */
  resetsAt: string | null;
}

/**
 * How much of the plan is left, per window.
 *
 * A subscription has no per-token price, so the honest thing to show is not a
 * cost but **headroom** — and the far end publishes exactly that. All three
 * windows are surfaced rather than the smallest: hitting the weekly cap on a
 * Tuesday and hitting the rolling cap for ten minutes are different problems,
 * and a single blended number would hide which one you are in.
 */
export interface OpenCodeUsage {
  rolling: OpenCodeUsageWindow | null;
  weekly: OpenCodeUsageWindow | null;
  monthly: OpenCodeUsageWindow | null;
}

interface UsageResponse {
  usage?: Record<string, { status?: unknown; percent?: unknown; resetsAt?: unknown }>;
}

/**
 * Read the plan's remaining headroom.
 *
 * Needs the subscription key — unlike the model list, this one is about the
 * account. Throws with the status so a revoked or mistyped key says so on the
 * provider page rather than at the start of the next turn.
 */
export async function fetchOpenCodeUsage(apiKey: string): Promise<OpenCodeUsage> {
  const body = await invoke<UsageResponse>("opencode_usage", { apiKey });
  return {
    rolling: readWindow(body.usage?.rolling),
    weekly: readWindow(body.usage?.weekly),
    monthly: readWindow(body.usage?.monthly),
  };
}

/**
 * One window's rollover, as a sentence — `resets in 3h 56m`, or `null` when
 * the far end sent no timestamp.
 *
 * Lives here rather than in either card because both of them say it: the
 * provider page and the context ring read the same three windows, and a plan
 * that resets "in 3h 56m" in one place and "3h" in the other reads as two
 * different numbers.
 */
export function openCodeResetLabel(window: OpenCodeUsageWindow | null): string | null {
  return fmtResetsIn(window?.resetsAt);
}

function readWindow(raw: unknown): OpenCodeUsageWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as { status?: unknown; percent?: unknown; resetsAt?: unknown };
  return {
    status: typeof entry.status === "string" ? entry.status : "unknown",
    // Clamped, because a meter drawn past its own track reads as a rendering
    // bug rather than as "over the limit".
    percent:
      typeof entry.percent === "number" && Number.isFinite(entry.percent)
        ? Math.max(0, Math.min(100, entry.percent))
        : 0,
    resetsAt: typeof entry.resetsAt === "string" ? entry.resetsAt : null,
  };
}

/**
 * `glm-5.2` → `GLM 5.2`, `deepseek-v4-pro` → `DeepSeek V4 Pro`.
 *
 * The wire carries no display name, so this is the only name there is. Known
 * acronyms are spelled the way their vendors spell them: a row reading
 * "Glm 5.2" next to "Kimi K3" reads as a bug rather than as a style.
 */
const ACRONYMS: Record<string, string> = {
  glm: "GLM",
  gpt: "GPT",
  hy3: "HY3",
  qwen3: "Qwen3",
  deepseek: "DeepSeek",
  minimax: "MiniMax",
  kimi: "Kimi",
  mimo: "MiMo",
  grok: "Grok",
  ox: "OX",
};

function prettyLabel(id: string): string {
  return id
    .split("-")
    .map((part) => {
      const known = ACRONYMS[part.toLowerCase()];
      if (known) return known;
      // `v4`, `k3`, `m2.7`, `5.2` — a letter glued to a number, or a bare
      // version. Upper-case the letter and leave the number alone.
      if (/^[a-z]?[\d.]/.test(part)) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

/** Exported for tests. */
export const __test = { prettyLabel };
