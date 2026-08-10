/**
 * Codex (ChatGPT subscription) — provider service.
 *
 * OpenAI's Codex-tier models (GPT-5.5, GPT-5.4, …) driven through the
 * ChatGPT backend and metered against the user's ChatGPT Plus/Pro plan —
 * no API key. Auth lives in Rust (`api::codex`): `~/.codex/auth.json` is
 * shared with Codex CLI, so an existing CLI sign-in works immediately and
 * Aurora's own browser sign-in also signs the CLI in.
 *
 * This module is the frontend surface: invoke wrappers for the Tauri
 * commands, the seeded provider preset, and formatting helpers for the
 * usage card.
 */

import { auroraInvoke as invoke } from "@/kernel/lib/ipc/runtime";
import type { ProviderCatalogPreset } from "@/apps/agent/services/providers/provider-catalog";

// ── Constants ────────────────────────────────────────────────────────────────

export const CODEX_PROVIDER_ID = "codex";
export const CODEX_USAGE_URL = "https://chatgpt.com/codex/settings/usage";

// ── Wire types (mirror Rust `api::codex`) ────────────────────────────────────

export interface CodexAuthStatus {
  signedIn: boolean;
  /** "chatgpt" (subscription) or "apikey" (not routed through this provider). */
  authMode: string | null;
  email: string | null;
  /** ChatGPT plan, e.g. "plus", "pro", "team". */
  planType: string | null;
  accountId: string | null;
  lastRefresh: string | null;
}

export interface CodexUsageWindow {
  /** 0–100. */
  usedPercent: number;
  /** Window length in minutes (300 = 5-hour, 10080 = weekly). */
  windowMinutes: number | null;
  resetsInSeconds: number | null;
  resetsAtMs: number | null;
}

export interface CodexCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface CodexUsageSnapshot {
  planType: string | null;
  limitReached: boolean;
  /** Rolling 5-hour window. */
  primary: CodexUsageWindow | null;
  /** Weekly window. */
  secondary: CodexUsageWindow | null;
  credits: CodexCredits | null;
  fetchedAtMs: number;
}

// ── Commands ─────────────────────────────────────────────────────────────────

export function codexAuthStatus(): Promise<CodexAuthStatus> {
  return invoke<CodexAuthStatus>("codex_auth_status");
}

/** Opens the system browser and resolves once sign-in completes. */
export function codexAuthLogin(): Promise<CodexAuthStatus> {
  return invoke<CodexAuthStatus>("codex_auth_login");
}

export function codexAuthCancelLogin(): Promise<void> {
  return invoke<void>("codex_auth_cancel_login");
}

/** Removes `~/.codex/auth.json` — signs out Codex CLI on this machine too. */
export function codexAuthLogout(): Promise<void> {
  return invoke<void>("codex_auth_logout");
}

export function codexUsageGet(): Promise<CodexUsageSnapshot> {
  return invoke<CodexUsageSnapshot>("codex_usage_get");
}

// ── Detection / formatting ───────────────────────────────────────────────────

export function isCodexProvider(provider: { id?: string }): boolean {
  return provider.id === CODEX_PROVIDER_ID;
}

/** "plus" → "Plus", "pro" → "Pro". */
export function codexPlanLabel(planType: string | null | undefined): string | null {
  if (!planType) return null;
  return planType
    .split(/[_-]/)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

/** 300 → "5-hour limit", 10080 → "Weekly limit". */
export function codexWindowLabel(win: CodexUsageWindow | null, fallback: string): string {
  const minutes = win?.windowMinutes;
  if (!minutes) return fallback;
  if (minutes % 10080 === 0) {
    const weeks = minutes / 10080;
    return weeks === 1 ? "Weekly limit" : `${weeks}-week limit`;
  }
  if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  return `${minutes}-minute limit`;
}

/** Seconds → "2h 14m" / "3d 5h" / "45m". */
export function codexFmtDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3_600);
  const minutes = Math.floor((s % 3_600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${Math.max(1, minutes)}m`;
}

// ── Seeded provider preset ───────────────────────────────────────────────────

/**
 * Codex-entitled model roster. Pricing is pinned to $0 on purpose: usage
 * bills against the ChatGPT subscription, and a zeroed row also stops the
 * models.dev enrichment pass from backfilling platform API prices that
 * don't apply here.
 */
const CODEX_SEED_MODELS = [
  { id: "gpt-5.6", alias: "GPT-5.6" },
  { id: "gpt-5.6-terra", alias: "GPT-5.6 Terra" },
  { id: "gpt-5.6-luna", alias: "GPT-5.6 Luna" },
  { id: "gpt-5.5", alias: "GPT-5.5" },
  { id: "gpt-5.4", alias: "GPT-5.4" },
  { id: "gpt-5.4-mini", alias: "GPT-5.4 Mini" },
  { id: "gpt-5.3-codex", alias: "GPT-5.3 Codex" },
  { id: "gpt-5.3-codex-spark", alias: "GPT-5.3 Codex Spark" },
];

export const CODEX_PRESET: ProviderCatalogPreset = {
  id: CODEX_PROVIDER_ID,
  name: "Codex (ChatGPT)",
  nickname: "Codex",
  // Informational only — the Rust adapter pins the real endpoint.
  baseUrl: "https://chatgpt.com/backend-api/codex",
  model: CODEX_SEED_MODELS[0].id,
  // Follows the seed default (GPT-5.6): the 5.4+ tier carries ~1.05M. The
  // mini and Codex Spark rows are narrower and get their real limits from
  // the models.dev enrichment pass.
  contextWindow: 1_050_000,
  maxOutputTokens: 128_000,
  supportsThinking: true,
  supportsToolStream: true,
  providerType: "codex",
  requiresApiKey: false,
  customModels: CODEX_SEED_MODELS.map((m) => m.id),
  modelAliases: Object.fromEntries(CODEX_SEED_MODELS.map((m) => [m.id, m.alias])),
  modelPricing: Object.fromEntries(
    CODEX_SEED_MODELS.map((m) => [
      m.id,
      { cacheHitPerMtok: 0, cacheMissPerMtok: 0, outputPerMtok: 0 },
    ]),
  ),
};
