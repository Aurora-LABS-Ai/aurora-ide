/**
 * Cursor (subscription) — provider service.
 *
 * Drives the models a Cursor plan can reach through Aurora's own agent loop:
 * Aurora's tools, Aurora's permission gate, Aurora's checkpoints. Cursor
 * supplies the model, nothing else.
 *
 * Sign-in needs no setup. The Rust side reads the Cursor desktop app's own
 * session (read-only — that database backs a running editor) and keeps its
 * refreshed copy separately, so there is no key to paste and no browser hop.
 *
 * ## Why the catalogue lives in its own table
 *
 * An account reaches ~200 model ids, but most of that is the same model
 * repeated at different effort levels: `claude-fable-5` alone ships ten. So
 * ids are grouped by {@link CursorModelView.catalogKey} — the vendor's real
 * model id — which turns 204 rows into about 32. Effort, thinking and Fast
 * become options on a row rather than rows of their own.
 *
 * Capability (vision, context window, pricing) is **not** on Cursor's wire at
 * all. `catalogKey` is the join key into the models.dev catalogue Aurora
 * already uses for every other provider, so nothing here hardcodes a family
 * table that goes stale the next time a vendor ships something.
 */

import { auroraInvoke as invoke } from "@/kernel/lib/ipc/runtime";
import type { ProviderCatalogPreset } from "@/apps/agent/services/providers/provider-catalog";
import { lookupModel, type ModelsDevEntry } from "@/apps/agent/services/providers/models-dev";
import {
  toRunnableModels,
  type CursorRunnableModel,
} from "@/apps/agent/services/providers/cursor-variants";

// ── Constants ────────────────────────────────────────────────────────────────

export const CURSOR_PROVIDER_ID = "cursor";

// ── Wire types (mirror Rust `commands::cursor`) ──────────────────────────────

export interface CursorAuthStatus {
  signedIn: boolean;
  email: string | null;
  /** Raw plan slug — `pro`, `pro_plus`, `free_trial`, … */
  membership: string | null;
  /** RFC3339 expiry of the current token. */
  expiresAt: string | null;
  hasRefreshToken: boolean;
  /** Whether a Cursor desktop install was found to sign in from. */
  cursorAppDetected: boolean;
  lastRefresh: string | null;
}

export interface CursorModelView {
  modelId: string;
  displayModelId: string | null;
  displayName: string | null;
  displayNameShort: string | null;
  aliases: string[];
  supportsThinking: boolean;
  maxMode: boolean;
  enabled: boolean;
  sortOrder: number;
  /** The id with `-fast` removed. */
  baseModelId: string;
  isFast: boolean;
  /** The vendor's own model id, for models.dev. `null` for `auto`. */
  catalogKey: string | null;
  /** An older generation, folded away by default. */
  isLegacy: boolean;
}

export interface CursorModelCatalogue {
  models: CursorModelView[];
  fetchedAt: string | null;
  enabledCount: number;
}

// ── Commands ─────────────────────────────────────────────────────────────────

export function cursorAuthStatus(): Promise<CursorAuthStatus> {
  return invoke<CursorAuthStatus>("cursor_auth_status");
}

/** Adopt the Cursor app's session. No browser, no key. */
export function cursorAuthConnect(): Promise<CursorAuthStatus> {
  return invoke<CursorAuthStatus>("cursor_auth_connect");
}

/** Forget Aurora's copy. The Cursor app stays signed in. */
export function cursorAuthSignOut(): Promise<void> {
  return invoke<void>("cursor_auth_sign_out");
}

/** Where Aurora looked for the Cursor install — shown when it found nothing. */
export function cursorStateDbPath(): Promise<string | null> {
  return invoke<string | null>("cursor_state_db_path");
}

export function cursorModelsList(): Promise<CursorModelCatalogue> {
  return invoke<CursorModelCatalogue>("cursor_models_list");
}

/** Only the models switched on — what the model selector offers. */
export function cursorModelsListEnabled(): Promise<CursorModelView[]> {
  return invoke<CursorModelView[]>("cursor_models_list_enabled");
}

/** Re-pull the catalogue. Enable choices survive. */
export function cursorModelsRefresh(): Promise<CursorModelCatalogue> {
  return invoke<CursorModelCatalogue>("cursor_models_refresh");
}

/** `false` means the id is no longer on the account. */
export function cursorModelSetEnabled(modelId: string, enabled: boolean): Promise<boolean> {
  return invoke<boolean>("cursor_model_set_enabled", { modelId, enabled });
}

export function cursorModelsSetEnabledBulk(
  modelIds: string[],
  enabled: boolean,
): Promise<number> {
  return invoke<number>("cursor_models_set_enabled_bulk", { modelIds, enabled });
}

// ── Detection ────────────────────────────────────────────────────────────────

export function isCursorProvider(provider: { id?: string }): boolean {
  return provider.id === CURSOR_PROVIDER_ID;
}

// ── Seeded provider preset ───────────────────────────────────────────────────

/**
 * The Cursor provider row.
 *
 * `customModels` is deliberately empty: the account decides what exists, and
 * the catalogue is pulled on connect. Seeding a guess here would put models in
 * the picker that a refresh then contradicts.
 *
 * Pricing is likewise absent rather than zeroed — usage bills against the
 * Cursor plan, so there is no per-token rate to state, and a zero would render
 * as a measured `$0.00` instead of "not applicable".
 */
export const CURSOR_PRESET: ProviderCatalogPreset = {
  id: CURSOR_PROVIDER_ID,
  name: "Cursor",
  nickname: "Cursor",
  // Informational only — the Rust adapter pins the real endpoint, so a stale
  // preset cannot misroute a turn.
  baseUrl: "https://api2.cursor.sh",
  // The account's router — the one id that is always reachable, and the model
  // the picker falls back to before anything has been switched on. It must be
  // the id Cursor actually publishes (`cursor-default`), not the word "default":
  // this value is sent verbatim, so a friendly-looking placeholder here would
  // fail the very first turn of a fresh install.
  model: "cursor-default",
  // Replaced per-model from models.dev once the catalogue loads; this is only
  // the floor a row starts at.
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  supportsThinking: true,
  supportsToolStream: true,
  supportsVision: true,
  providerType: "cursor",
  requiresApiKey: false,
  customModels: [],
};

// ── The catalogue, as the provider page shows it ─────────────────────────────

/** One model in the provider page's list. */
export interface CursorCatalogueRow {
  model: CursorRunnableModel;
  /** models.dev metadata, once resolved. `null` while loading or unknown. */
  catalog: ModelsDevEntry | null;
}

/**
 * Collapse the flat catalogue into one row per model.
 *
 * Ordering follows Cursor's own response — the account's ranking puts what it
 * expects you to want first, which beats anything alphabetical.
 */
export function toCatalogueRows(models: CursorModelView[]): CursorCatalogueRow[] {
  return toRunnableModels(models).map((model) => ({ model, catalog: null }));
}

/**
 * Fill in what Cursor does not send — vision, context window, pricing —
 * from models.dev.
 *
 * Failures are silent by design: a lookup miss means the row shows fewer
 * badges, which is a smaller problem than a settings page that refuses to
 * render because a third-party catalogue was unreachable.
 */
export async function enrichCatalogueRows(
  rows: CursorCatalogueRow[],
): Promise<CursorCatalogueRow[]> {
  return Promise.all(
    rows.map(async (row) => {
      // `auto` routes to whichever model Cursor picks, so there is no single
      // entry to look its capabilities up in.
      const key = row.model.catalogKey;
      if (!key) return row;
      try {
        return { ...row, catalog: await lookupModel(key) };
      } catch {
        return row;
      }
    }),
  );
}
