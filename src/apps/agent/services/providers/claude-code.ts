/**
 * Claude Code (claude.ai subscription) — provider service.
 *
 * Claude models driven through the same OAuth grant Claude Code uses and
 * metered against the user's Claude Pro/Max plan — no API key. Auth lives in
 * Rust (`api::claude_code`) in Aurora's OWN account list; several accounts
 * can be stored and one of them (main) serves chats.
 *
 * Two ways in. Sign in is a manual two-step flow: Aurora shows a link, the
 * user finishes in a browser and pastes the code the page shows (or the whole
 * callback address) back into the card. Import copies what Claude Code is
 * signed into: its credentials file is read once, never written.
 *
 * This module is the frontend surface: invoke wrappers for the Tauri
 * commands and formatting helpers for the card. The seeded provider preset
 * lives in kernel (the settings store seeds from it) and is re-exported here.
 */

import { auroraInvoke as invoke } from "@/kernel/lib/ipc/runtime";
import { fmtDuration } from "@/apps/agent/lib/time/duration";
import { CLAUDE_CODE_PROVIDER_ID } from "@/apps/agent/services/providers/presets/claude-code";

export {
  CLAUDE_CODE_PRESET,
  CLAUDE_CODE_PROVIDER_ID,
} from "@/apps/agent/services/providers/presets/claude-code";

// ── Constants ────────────────────────────────────────────────────────────────

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
  /** When the sign-in itself ends (refresh token expiry), when known. */
  refreshExpiresAtMs: number | null;
  /** Set only in the last three days before that, as Claude Code warns. */
  signInAgainInDays: number | null;
}

/** "Sign in again within 2 days…" — null when there is nothing to warn about. */
export function claudeCodeSignInAgainNote(status: ClaudeCodeAuthStatus | null | undefined): string | null {
  const days = status?.signInAgainInDays;
  if (days == null) return null;
  const when = days <= 1 ? "within a day" : `within ${days} days`;
  return `This sign-in ends ${when}. Sign in to this account again to keep using it.`;
}

export interface ClaudeCodeUsageWindow {
  /** 0–100. */
  usedPercent: number;
  resetsAtMs: number | null;
  resetsInSeconds: number | null;
}

export interface ClaudeCodeModelWindow {
  /** The server's own label, e.g. "Fable". */
  model: string;
  window: ClaudeCodeUsageWindow;
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
  /** Other models' weekly windows (Fable), named by the server. */
  sevenDayModels: ClaudeCodeModelWindow[];
  extraUsage: ClaudeCodeExtraUsage | null;
  fetchedAtMs: number;
}

/** How an account arrived. An import shares Claude Code's sign-in. */
export type ClaudeCodeAccountSource = "sign-in" | "claude-code-import";

export interface ClaudeCodeAccountRow {
  id: string;
  addedAt: string;
  source: ClaudeCodeAccountSource;
  /** The account chats go to. Exactly one row is true. */
  isMain: boolean;
  status: ClaudeCodeAuthStatus;
  /** Null when its usage could not be read; the row still lists. */
  usage: ClaudeCodeUsageSnapshot | null;
  usageError: string | null;
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

/** Every stored account, each with its own usage. */
export function claudeCodeAccountsList(): Promise<ClaudeCodeAccountRow[]> {
  return invoke<ClaudeCodeAccountRow[]>("claude_code_accounts_list");
}

export function claudeCodeAccountSetMain(id: string): Promise<void> {
  return invoke<void>("claude_code_account_set_main", { id });
}

/** Forgets one account in Aurora. Claude Code on this machine is untouched. */
export function claudeCodeAccountRemove(id: string): Promise<void> {
  return invoke<void>("claude_code_account_remove", { id });
}

/** Copies the account Claude Code is signed into. Never writes Claude Code's file. */
export function claudeCodeAccountImportCli(): Promise<ClaudeCodeAuthStatus> {
  return invoke<ClaudeCodeAuthStatus>("claude_code_account_import_cli");
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
 * The fullest window on an account, which is the one about to stop it.
 * `null` when the account reported none.
 */
export function claudeCodeHighestUsedPercent(
  usage: ClaudeCodeUsageSnapshot | null | undefined,
): number | null {
  if (!usage) return null;
  const windows = [
    usage.fiveHour,
    usage.sevenDay,
    usage.sevenDayOpus,
    usage.sevenDaySonnet,
    ...(usage.sevenDayModels ?? []).map((m) => m.window),
  ];
  const used = windows.filter((w): w is ClaudeCodeUsageWindow => w != null).map((w) => w.usedPercent);
  return used.length > 0 ? Math.max(...used) : null;
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
