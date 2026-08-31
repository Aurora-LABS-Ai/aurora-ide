/**
 * Cursor's switched-on models → Aurora's model list.
 *
 * ## Why this exists
 *
 * Cursor's catalogue lives in its own table, replaced wholesale whenever the
 * account's models change. Aurora's model picker — and the context ring, the
 * cost readout, and the per-conversation model pin — all read the shared model
 * list that every other provider writes to.
 *
 * Without something joining the two, switching a model on in Settings does
 * nothing anywhere else: the row is written, and the picker never hears about
 * it. That is exactly the bug this module fixes.
 *
 * So the account's catalogue stays the source of truth for *what exists*, and
 * this copies *what you chose* into the shared list. One row per model, not
 * per id: `grok-4.6` is one entry whose effort, thinking and Fast are controls
 * on it, not four entries competing for the same line in the picker.
 *
 * The copy is one-directional and idempotent. Re-running it after a refresh,
 * a toggle, or a window reload converges on the same rows.
 */

import { useSettingsStore, type LLMModel } from "@/kernel/store/useSettingsStore";
import type { ModelReasoning } from "@/kernel/types/database";
import { lookupModel, type ModelsDevEntry } from "@/apps/agent/services/providers/models-dev";
import {
  CURSOR_PROVIDER_ID,
  cursorModelsList,
  type CursorModelView,
} from "@/apps/agent/services/providers/cursor";
import {
  clearCursorVariants,
  cursorReasons,
  primeCursorVariants,
  toRunnableModels,
  type CursorEffort,
  type CursorRunnableModel,
} from "@/apps/agent/services/providers/cursor-variants";

/**
 * Turn one Cursor model into a row for the shared list.
 *
 * `previous` is the row already there, if any. Its reasoning **choices** are
 * carried across: the effort tier someone picked and whether they left
 * reasoning on are settings, not catalogue facts, and a refresh must not reset
 * them. The tier is only kept if the account still offers it.
 */
function toModelRow(
  model: CursorRunnableModel,
  previous: LLMModel | undefined,
  catalog: ModelsDevEntry | null,
): Omit<LLMModel, "id" | "providerId" | "sortOrder"> {
  return {
    // The model's own id, with nothing said about how to run it.
    //
    // Effort and Fast are **capabilities the user chooses**, not part of what
    // the model is — so they belong to the controls on this row, and the id
    // that carries them is built at send time (`applyCursorVariant`). Storing a
    // decorated id here instead made `cursor-grok-4.6-high` the model's name in
    // the database and on the provider page, which is not its name; and once
    // that decorated string became what the conversation pinned, it stopped
    // matching this row, so the model's context window could no longer be found
    // and the turn fell back to the provider default.
    modelKey: model.stem,
    label: model.label,
    // What is already on the row wins over models.dev.
    //
    // These two are editable — the same as on every other provider — and the
    // catalogue is replaced wholesale on every refresh, so reading models.dev
    // first would quietly undo a correction on a schedule nobody sees.
    // models.dev seeds a row that has no number yet; it is not an authority
    // that overwrites one. Clearing the field and refreshing re-seeds it.
    contextWindow: previous?.contextWindow ?? catalog?.contextWindow,
    maxOutputTokens: previous?.maxOutputTokens ?? catalog?.maxOutputTokens,
    // Cursor's wire says nothing about modality or price, so models.dev is the
    // only honest source. A miss leaves the flags off rather than guessing —
    // an unclaimed capability degrades to "not offered", a wrongly claimed one
    // fails mid-turn with an image the model cannot read.
    supportsVision: catalog?.supportsVision ?? false,
    // An effort tier is this wire's reasoning control, so a model carrying
    // tiers reasons even with no `-thinking` id anywhere on the account.
    supportsThinking: cursorReasons(model) || (catalog?.supportsThinking ?? false),
    // Every model Cursor's agent service exposes can call tools — that is what
    // the service is for.
    supportsToolStream: true,
    // Usage bills against the subscription. Leaving these unset renders as
    // "not applicable"; a zero would render as a measured $0.00.
    priceCacheHitPerMtok: undefined,
    priceCacheMissPerMtok: undefined,
    priceOutputPerMtok: undefined,
    priceCacheWritePerMtok: undefined,
    reasoning: toReasoning(model, previous?.reasoning),
    enabled: true,
  };
}

/**
 * Reasoning config for a Cursor model.
 *
 * Effort is part of the model **id** here, not a request field, so these
 * controls exist to choose an id — see `cursor-variants`. The mapping:
 *
 * - the account's effort ids become the tier list,
 * - the on/off switch chooses between the `-thinking` ids and the plain ones,
 * - a model whose ids are *all* `-thinking` gets no switch (`toggleable: false`),
 *   because there is no id to switch to.
 *
 * A model with neither is left with no reasoning config at all, so the picker
 * renders no control rather than a dead one.
 */
function toReasoning(
  model: CursorRunnableModel,
  previous: ModelReasoning | undefined,
): ModelReasoning | undefined {
  if (model.efforts.length === 0 && !model.hasThinking) return undefined;

  if (model.efforts.length === 0) {
    return {
      type: "toggle",
      default: previous?.type === "toggle" ? previous.default : true,
      enabled: previous?.enabled,
      toggleable: !model.thinkingOnly,
    };
  }

  const levels: string[] = [...model.efforts];
  // Only carried when the account still offers that tier: a plan change can
  // drop `xhigh`, and keeping a stale tier would compose an id nothing serves.
  const carried =
    typeof previous?.default === "string" && levels.includes(previous.default)
      ? previous.default
      : undefined;

  return {
    type: "effort",
    levels,
    // The tier the representative id already carries — so what the picker
    // shows and what gets sent agree before anyone touches anything.
    default: carried ?? defaultEffortOf(model),
    enabled: previous?.enabled,
    // No thinking ids means nothing to switch off: effort alone runs the model.
    toggleable: model.hasThinking && !model.thinkingOnly,
    supported: ["effort"],
  };
}

function defaultEffortOf(model: CursorRunnableModel): CursorEffort {
  const suffix = model.representativeId.slice(model.stem.length);
  const found = model.efforts.find((tier) => suffix.includes(`-${tier}`));
  return found ?? model.efforts[model.efforts.length - 1];
}

/**
 * Mirror the account's switched-on models into the shared model list.
 *
 * Returns how many models are now offered in the picker.
 *
 * Safe to call when Cursor was never connected: the catalogue comes back
 * empty, the mirror clears, and nothing else in the app notices.
 */
export async function syncCursorModelsIntoStore(): Promise<number> {
  const catalogue = await cursorModelsList();

  // The index is built from the WHOLE catalogue, not just the enabled rows:
  // composing `-fast` or a different effort has to be checked against every id
  // the account carries, and a model can be switched on while the fast twin it
  // would compose to sits in the same group.
  primeCursorVariants(catalogue.models);

  // Enablement is a family-level choice in the UI. Build capabilities from
  // every current variant, then keep families where any member is enabled.
  // This also makes a newly published tier immediately part of an already
  // enabled family instead of leaving the selector with a partial matrix.
  const runnable = toRunnableModels(catalogue.models).filter((model) => model.enabled);

  const catalogs = await Promise.all(
    runnable.map(async (model) => {
      return model.catalogKey ? lookupModel(model.catalogKey).catch(() => null) : null;
    }),
  );

  // Metadata lookup crosses the network. Re-read editable rows after it
  // returns so a context-window or reasoning change made during the refresh is
  // not overwritten by a stale pre-await snapshot.
  const existing = new Map(
    useSettingsStore
      .getState()
      .models.filter((model) => model.providerId === CURSOR_PROVIDER_ID)
      .map((model) => [model.modelKey, model]),
  );
  const rows = runnable.map((model, index) =>
    toModelRow(model, existing.get(model.stem), catalogs[index]),
  );

  useSettingsStore.getState().replaceModelsForProvider(CURSOR_PROVIDER_ID, rows);
  return rows.length;
}

/** Drop the mirror and the index — on disconnect. */
export function clearCursorModelsFromStore(): void {
  clearCursorVariants();
  useSettingsStore.getState().replaceModelsForProvider(CURSOR_PROVIDER_ID, []);
}

/**
 * Sync without letting a failure reach the caller.
 *
 * Used where the sync is a side effect of something else — window start-up,
 * a toggle whose own success the user already saw. A models.dev outage or a
 * revoked session must not turn into an error in front of a user who was
 * doing something unrelated; the picker simply keeps the models it had.
 */
export function syncCursorModelsQuietly(): void {
  void syncCursorModelsIntoStore().catch((err) => {
    console.warn("[cursor] could not refresh the model picker:", err);
  });
}

/** Exported for tests. */
export const __test = { toModelRow, toReasoning, defaultEffortOf };
export type { CursorModelView };
