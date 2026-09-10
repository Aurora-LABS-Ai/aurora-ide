/**
 * Claude Code (claude.ai subscription) — provider service.
 *
 * Claude models driven through the same OAuth grant Claude Code uses and
 * metered against the user's Claude Pro/Max plan — no API key. Auth lives in
 * Rust (`api::claude_code`) in Aurora's OWN credential file; the user's
 * `~/.claude` directory is never read or written. The only way in is the
 * Sign in button on the Providers page.
 *
 * The sign-in is a manual two-step flow: Aurora shows a link, the user
 * finishes in a browser and pastes the code the page shows (or the whole
 * callback address) back into the card.
 *
 * This module is the frontend surface: invoke wrappers for the Tauri
 * commands, the seeded provider preset, and formatting helpers for the card.
 */

import { auroraInvoke as invoke } from "@/kernel/lib/ipc/runtime";
import { fmtDuration } from "@/apps/agent/lib/time/duration";
import type { ModelReasoning } from "@/kernel/types/database";
import type { ProviderCatalogPreset } from "@/apps/agent/services/providers/provider-catalog";

// ── Constants ────────────────────────────────────────────────────────────────

export const CLAUDE_CODE_PROVIDER_ID = "claude-code";
export const CLAUDE_CODE_USAGE_URL = "https://claude.ai/settings/usage";

// ── Wire types (mirror Rust `api::claude_code`) ──────────────────────────────

export interface ClaudeCodeAuthStatus {
  signedIn: boolean;
  /** The token can answer a chat. False for a sign-in granted without inference access. */
  canInfer: boolean;
  email: string | null;
  displayName: string | null;
  /** `max`, `pro`, `team`, `enterprise`, or null when unknown. */
  plan: string | null;
  rateLimitTier: string | null;
  accountUuid: string | null;
  expiresAtMs: number | null;
  signedInAt: string | null;
  lastRefresh: string | null;
}

export interface ClaudeCodeUsageWindow {
  /** 0–100. */
  usedPercent: number;
  resetsAtMs: number | null;
  resetsInSeconds: number | null;
}

export interface ClaudeCodeExtraUsage {
  enabled: boolean;
  monthlyLimit: number | null;
  usedCredits: number | null;
  usedPercent: number | null;
}

export interface ClaudeCodeUsageSnapshot {
  /** `max`, `pro`, `team`, `enterprise`, or null. Titles the plan block. */
  plan: string | null;
  fiveHour: ClaudeCodeUsageWindow | null;
  sevenDay: ClaudeCodeUsageWindow | null;
  sevenDayOpus: ClaudeCodeUsageWindow | null;
  sevenDaySonnet: ClaudeCodeUsageWindow | null;
  extraUsage: ClaudeCodeExtraUsage | null;
  fetchedAtMs: number;
}

// ── Commands ─────────────────────────────────────────────────────────────────

export function claudeCodeAuthStatus(): Promise<ClaudeCodeAuthStatus> {
  return invoke<ClaudeCodeAuthStatus>("claude_code_auth_status");
}

/** Starts a sign-in and returns the link the user opens. */
export function claudeCodeAuthBegin(): Promise<string> {
  return invoke<string>("claude_code_auth_begin");
}

/** Finishes the sign-in with the code (or callback address) the user pasted. */
export function claudeCodeAuthComplete(input: string): Promise<ClaudeCodeAuthStatus> {
  return invoke<ClaudeCodeAuthStatus>("claude_code_auth_complete", { input });
}

export function claudeCodeAuthCancel(): Promise<void> {
  return invoke<void>("claude_code_auth_cancel");
}

/** Signs out of Aurora's copy only. Claude Code on this machine is untouched. */
export function claudeCodeAuthLogout(): Promise<void> {
  return invoke<void>("claude_code_auth_logout");
}

export function claudeCodeUsageGet(): Promise<ClaudeCodeUsageSnapshot> {
  return invoke<ClaudeCodeUsageSnapshot>("claude_code_usage_get");
}

// ── Detection / formatting ───────────────────────────────────────────────────

export function isClaudeCodeProvider(provider: { id?: string }): boolean {
  return provider.id === CLAUDE_CODE_PROVIDER_ID;
}

/** "max" → "Max", "pro" → "Pro"; null stays null. */
export function claudeCodePlanLabel(plan: string | null | undefined): string | null {
  if (!plan) return null;
  const trimmed = plan.trim();
  if (!trimmed) return null;
  return trimmed
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * When this window comes back, or `null` when the plan did not say.
 *
 * `null` rather than "resets in 0s": a window with no stated reset is unknown,
 * and a zero reads as one that is about to turn over. Named like every other
 * provider's (`openCodeResetLabel`, `kenariResetLabel`) because `plan-view`
 * captions every limit row the same way.
 */
export function claudeCodeResetLabel(win: ClaudeCodeUsageWindow): string | null {
  if (win.resetsInSeconds == null) return null;
  if (win.resetsInSeconds <= 0) return "resets now";
  return `resets in ${fmtDuration(win.resetsInSeconds)}`;
}

/**
 * The one line under a meter on the provider card: how much is used and when
 * it comes back.
 */
export function claudeCodeWindowMeta(win: ClaudeCodeUsageWindow): string {
  const used = `${Math.round(Math.min(100, Math.max(0, win.usedPercent)))}% used`;
  const reset = claudeCodeResetLabel(win);
  return reset ? `${used} · ${reset}` : used;
}

// ── Seeded provider preset ───────────────────────────────────────────────────

/**
 * The Claude 5 family plus Haiku 4.5. Pricing is pinned to $0 on purpose:
 * usage bills against the claude.ai plan, and a zeroed row also stops the
 * models.dev enrichment pass from backfilling platform API prices that do
 * not apply here.
 */
const CLAUDE_CODE_SEED_MODELS = [
  { id: "claude-sonnet-5", alias: "Claude Sonnet 5" },
  { id: "claude-opus-5", alias: "Claude Opus 5" },
  { id: "claude-fable-5-1", alias: "Claude Fable 5.1" },
  { id: "claude-haiku-4-5-20251001", alias: "Claude Haiku 4.5" },
];

/**
 * The effort picker the Claude 5 family takes, seeded so the composer's
 * reasoning control works on the first chat instead of after a trip to the
 * model row. Haiku 4.5 is left to its own default: it reasons on a token
 * budget, and the composer's budget control is set per model.
 */
const CLAUDE_5_EFFORT: ModelReasoning = {
  type: "effort",
  levels: ["low", "medium", "high", "xhigh", "max"],
  default: "high",
  supported: ["effort", "toggle"],
  toggleable: true,
  enabled: true,
};

export const CLAUDE_CODE_PRESET: ProviderCatalogPreset = {
  id: CLAUDE_CODE_PROVIDER_ID,
  name: "Claude Code (claude.ai)",
  nickname: "Claude Code",
  // Informational only — the Rust adapter pins the real endpoint.
  baseUrl: "https://api.anthropic.com/v1",
  model: CLAUDE_CODE_SEED_MODELS[0].id,
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  supportsThinking: true,
  supportsToolStream: true,
  supportsVision: true,
  providerType: CLAUDE_CODE_PROVIDER_ID,
  requiresApiKey: false,
  customModels: CLAUDE_CODE_SEED_MODELS.map((m) => m.id),
  modelAliases: Object.fromEntries(CLAUDE_CODE_SEED_MODELS.map((m) => [m.id, m.alias])),
  modelPricing: Object.fromEntries(
    CLAUDE_CODE_SEED_MODELS.map((m) => [
      m.id,
      { cacheHitPerMtok: 0, cacheMissPerMtok: 0, outputPerMtok: 0 },
    ]),
  ),
  modelReasoning: {
    "claude-sonnet-5": CLAUDE_5_EFFORT,
    "claude-opus-5": CLAUDE_5_EFFORT,
    "claude-fable-5-1": CLAUDE_5_EFFORT,
  },
};
