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
 * commands and formatting helpers for the usage card. The seeded provider
 * preset lives in kernel (the settings store seeds from it) and is
 * re-exported here.
 */

import { auroraInvoke as invoke } from "@/kernel/lib/ipc/runtime";
import { fmtDuration } from "@/apps/agent/lib/time/duration";
import { CODEX_PROVIDER_ID } from "@/apps/agent/services/providers/presets/codex";

export { CODEX_PRESET, CODEX_PROVIDER_ID } from "@/apps/agent/services/providers/presets/codex";

// ── Constants ────────────────────────────────────────────────────────────────

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

/** Signs out of the account serving requests. Codex CLI keeps its own. */
export function codexAuthLogout(): Promise<void> {
  return invoke<void>("codex_auth_logout");
}

export function codexUsageGet(): Promise<CodexUsageSnapshot> {
  return invoke<CodexUsageSnapshot>("codex_usage_get");
}

// ── Accounts ─────────────────────────────────────────────────────────────────

export interface CodexAccountRow {
  accountId: string;
  email: string | null;
  planType: string | null;
  addedAt: string;
  /** The account the user chose. Exactly one row is true. */
  isMain: boolean;
  /** What the next request will use — differs from `isMain` only while main is spent. */
  isActive: boolean;
  /** When the window is expected back. Detail — `spent` is the decision. */
  exhaustedUntilMs: number | null;
  /** Resolved against the backend's clock, so the view never reads one of its own. */
  spent: boolean;
  usage: CodexUsageSnapshot | null;
  usageError: string | null;
}

export interface CodexAccountsSnapshot {
  accounts: CodexAccountRow[];
  /** Credits pooled across every account whose balance parsed as a number. */
  totalCredits: number | null;
  anyUnlimited: boolean;
  /** How many accounts the total covers, so the card never implies it read all of them. */
  counted: number;
  total: number;
}

export function codexAccountsList(): Promise<CodexAccountsSnapshot> {
  return invoke<CodexAccountsSnapshot>("codex_accounts_list");
}

export function codexAccountSetMain(accountId: string): Promise<void> {
  return invoke<void>("codex_account_set_main", { accountId });
}

export function codexAccountRemove(accountId: string): Promise<void> {
  return invoke<void>("codex_account_remove", { accountId });
}

export function codexAccountClearLimit(accountId: string): Promise<void> {
  return invoke<void>("codex_account_clear_limit", { accountId });
}

/** Adds whatever Codex CLI is signed into, without disturbing it. */
export function codexAccountImportCli(): Promise<string> {
  return invoke<string>("codex_account_import_cli");
}

/** Compact credit figure for the header — `3,850`, not `3850.0000001`. */
export function codexFmtCredits(value: number): string {
  return Math.round(value).toLocaleString();
}

/**
 * The credit balance as one readable phrase, or `null` when there is nothing
 * true to say about it.
 *
 * Deliberately more permissive than the account switcher's `rowCredits`, which
 * requires `hasCredits`. Once a plan window is spent, credits are the only
 * thing still answering "can I keep working" — so a balance the backend
 * reported is shown even if that flag says otherwise. Silence in that moment
 * reads as "you are out", which is the opposite of the truth.
 *
 * The balance arrives as a STRING and is formatted only when it parses as a
 * number: the backend has been seen to send `3850.0000001`, and it may equally
 * send something already worded, which must survive untouched.
 */
export function codexCreditsLabel(credits: CodexCredits | null | undefined): string | null {
  if (!credits) return null;
  if (credits.unlimited) return "Unlimited";
  const raw = credits.balance?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? codexFmtCredits(parsed) : raw;
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

/**
 * Seconds → "2h 14m" / "3d 5h" / "45m".
 *
 * Kept under its Codex name because the call sites read as Codex's, but the
 * wording is shared with every other subscription Aurora shows a limit window
 * for — see `lib/time/duration`. Two plans that refill should not describe the
 * same three hours differently.
 */
export const codexFmtDuration = fmtDuration;
