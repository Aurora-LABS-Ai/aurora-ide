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
 * ## Which surface, and why it is a per-MODEL setting
 *
 * This endpoint answers on three shapes, and **the model decides which one**,
 * not the account. From OpenCode's own endpoint table, confirmed live:
 *
 * - `/chat/completions` — GLM, Kimi, DeepSeek, MiMo, Hy3, Ox.
 * - `/messages` — every MiniMax and Qwen id. The Anthropic shape: it
 *   authenticates with `x-api-key`, **rejects a bearer token with 401**, and
 *   returns native `thinking` blocks.
 * - `/responses` — Grok 4.5, GPT 5.6 Luna, Muse Spark. Returns reasoning as
 *   `response.reasoning_summary_text.delta` plus `reasoning.encrypted_content`.
 *
 * Sending a model to the wrong one fails hard: `glm-5.2` on Responses answers
 * **500**, `gpt-5.6-luna` on Chat answers **500**, and `qwen3.7-plus` on
 * Responses answers **401** with `Model … is not supported for format openai` —
 * a status that reads as a rejected key and sends you to check your billing.
 *
 * So the wire lives on the model row (`LLMModel.providerType`), defaulted per
 * id by {@link defaultOpenCodeWire} and overridable there. A row-wide setting
 * could only ever be right for one family at a time; this used to be one, which
 * meant the shipped default model on the shipped default wire returned 500.
 *
 * The override is not a power-user escape hatch either. The plan already serves
 * six models the documentation does not list, and nothing on the wire says
 * which format a new one wants, so being able to try the other two is how a
 * model added next month becomes usable the same day.
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
 * The provider types a model on this plan can carry.
 *
 * `opencode-go` — the bare id — is Responses, and that is deliberate: the base
 * type has to be a PREFIX of its variants for a stored choice to survive a
 * relaunch (`resolveProviderType`), and it doubles as the fallback when a row
 * arrives with no type at all.
 */
export type OpenCodeWire = "opencode-go" | "opencode-go-chat" | "opencode-go-messages";

/**
 * The three shapes this endpoint answers on.
 *
 * All three are real, and an earlier note here was wrong to dismiss `/messages`
 * as "reachable but answers 400 for every model". It was measured against a
 * chat-completions model. Sent a model that belongs to it, `/messages` returns
 * 200 with native `thinking` blocks. It authenticates with `x-api-key` and
 * **rejects a bearer token outright**, which is why it maps to the Anthropic
 * adapter rather than to a variant of the OpenAI one.
 *
 * Carries no description per option, unlike kenari's. There, three wires serve
 * one account and the user is choosing between them, so the trade-off has to be
 * on screen. Here the right answer is already selected and the picker exists
 * only for the rare model whose default is wrong, so a paragraph under every
 * row would repeat itself down the whole list without helping anyone.
 */
export const OPENCODE_WIRES: ReadonlyArray<{
  value: OpenCodeWire;
  label: string;
}> = [
  { value: "opencode-go-chat", label: "Chat" },
  { value: "opencode-go-messages", label: "Messages" },
  { value: "opencode-go", label: "Responses" },
];

/**
 * Which wire each model answers on, from OpenCode's own endpoint table.
 *
 * This is a lookup rather than something discovered at runtime because the
 * plan's `/models` endpoint publishes nothing but `id`, `object`, `created` and
 * `owned_by`. The mapping exists only in the documentation, so it is copied
 * here — and, because a copied table goes stale, every model row can override
 * it (see {@link openCodeWireFor}).
 *
 * Sending the wrong one is not a soft failure. GLM-5.2 on Responses returns
 * 500, GPT 5.6 Luna on Chat returns 500, and a Qwen id on Responses returns
 * **401** with `Model … is not supported for format openai` — a status that
 * reads as a bad key.
 */
const OPENCODE_MODEL_WIRES: Readonly<Record<string, OpenCodeWire>> = {
  "grok-4.5": "opencode-go",
  "gpt-5.6-luna": "opencode-go",
  "muse-spark-1.2-contributor": "opencode-go",

  "minimax-m3": "opencode-go-messages",
  "minimax-m2.7": "opencode-go-messages",
  "minimax-m2.5": "opencode-go-messages",
  "qwen3.8-max": "opencode-go-messages",
  "qwen3.7-max": "opencode-go-messages",
  "qwen3.7-plus": "opencode-go-messages",
  "qwen3.6-plus": "opencode-go-messages",

  "glm-5.3": "opencode-go-chat",
  "glm-5.2": "opencode-go-chat",
  "glm-5.1": "opencode-go-chat",
  "kimi-k3": "opencode-go-chat",
  "kimi-k2.7-code": "opencode-go-chat",
  "kimi-k2.6": "opencode-go-chat",
  "deepseek-v4-pro": "opencode-go-chat",
  "deepseek-v4-flash": "opencode-go-chat",
  "deepseek-v4-flash-vision-exp": "opencode-go-chat",
  "mimo-v2.5": "opencode-go-chat",
  "mimo-v2.5-pro": "opencode-go-chat",
  hy3: "opencode-go-chat",
  "ox-alpha-free": "opencode-go-chat",
};

/**
 * The wire a model id defaults to.
 *
 * The table above is the answer where it has one. Everything else follows the
 * family, because the plan lists more models than the documentation does —
 * `kimi-k2.5`, `glm-5`, `qwen3.5-plus`, `mimo-v2-pro`, `mimo-v2-omni` and
 * `hy3-preview` were all live and undocumented when this was written.
 *
 * The family rule is measured, not assumed: every one of the 29 ids the plan
 * served was sent to the wire this function picks, and all 23 that were
 * runnable answered 200 on the first try, the four undocumented ones included.
 * The other six failed for reasons that have nothing to do with the format —
 * two DeepSeek ids are region-locked to China, Muse Spark needs a data-policy
 * opt-in, and three are simply retired upstream — so no wire would have helped
 * them and none is at fault.
 *
 * A `-free` suffix is a tier, not a different model, so it is stripped before
 * matching.
 */
export function defaultOpenCodeWire(modelKey: string): OpenCodeWire {
  const id = modelKey.trim().toLowerCase().replace(/-free$/, "");
  const known = OPENCODE_MODEL_WIRES[id];
  if (known) return known;

  if (/^(qwen|minimax)/.test(id)) return "opencode-go-messages";
  if (/^(gpt|grok|muse)/.test(id)) return "opencode-go";
  return "opencode-go-chat";
}

/**
 * The wire one model row will actually use: what the user set, else the
 * default for its id.
 *
 * The override is what makes a new model usable on the day it appears rather
 * than on the day this file is updated — the failure is loud and immediate, so
 * trying the other two takes seconds.
 */
export function openCodeWireFor(model: {
  modelKey: string;
  providerType?: string | null;
}): OpenCodeWire {
  const chosen = model.providerType;
  if (chosen === "opencode-go" || chosen === "opencode-go-chat" || chosen === "opencode-go-messages") {
    return chosen;
  }
  return defaultOpenCodeWire(model.modelKey);
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
  // The row-level type is only a fallback now: every turn resolves the wire
  // from the MODEL (`applyOpenCodeWire`). It is set to the wire `model` above
  // actually answers on, so that even a fallback lands somewhere that works —
  // this shipped as Responses while the default model was GLM-5.2, which is a
  // guaranteed 500 on the first turn of a fresh install.
  providerType: "opencode-go-chat",
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
