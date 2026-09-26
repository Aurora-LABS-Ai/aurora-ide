/**
 * OpenCode Go's plan models → Aurora's ordinary model list.
 *
 * ## Why there is so little here
 *
 * Cursor needed a table of its own, a variant index and a mirror: its ~200 ids
 * belong to the account, get replaced wholesale on refresh, and encode effort
 * and speed in the id itself. None of that is true here.
 *
 * OpenCode Go publishes stable, public model ids with no variants. So they are
 * just models: added to Aurora's normal list, shown by the normal Models
 * section, edited and deleted with the normal controls. This module only
 * exists to save typing 29 ids by hand.
 *
 * Everything a model *is* — vision, reasoning levels, context window — comes
 * from models.dev, because OpenCode's wire carries nothing but the id. Under
 * `opencode-go` specifically: models.dev lists the same model under many
 * providers with different facts (`kimi-k3` offers low/high/max on Moonshot's
 * own API and only `max` here), and the entry chosen decides what the picker
 * offers.
 */

import { useAgentSettingsStore, type LLMModel } from "@/apps/agent/store/settings/useAgentSettingsStore";
import { lookupModel, type ModelsDevEntry } from "@/apps/agent/services/providers/models-dev";
import {
  fetchOpenCodeModels,
  OPENCODE_PROVIDER_ID,
  type OpenCodeModel,
} from "@/apps/agent/services/providers/opencode";

/**
 * Look one model up in models.dev under this plan.
 *
 * The provider hint is matched as a **substring**, and models.dev lists both
 * `opencode-go` (this plan) and `opencode` (Zen's credit catalogue). Passing
 * `"opencode"` matches both and takes whichever comes first, so this passes the
 * exact id — only `opencode-go` contains it.
 */
function lookupForGo(model: OpenCodeModel): Promise<ModelsDevEntry | null> {
  // `-free` models are the same model on a free tier, so the suffix comes off
  // before looking up — models.dev knows the model, not the tier.
  return lookupModel(model.id.replace(/-free$/, ""), OPENCODE_PROVIDER_ID).catch(() => null);
}

function toModelRow(
  model: OpenCodeModel,
  catalog: ModelsDevEntry | null,
): Omit<LLMModel, "id" | "providerId" | "sortOrder"> {
  return {
    modelKey: model.id,
    label: catalog?.name?.trim() || model.label,
    contextWindow: catalog?.contextWindow,
    maxOutputTokens: catalog?.maxOutputTokens,
    supportsVision: catalog?.supportsVision ?? false,
    supportsThinking: catalog?.supportsThinking ?? false,
    // Every model on this surface answers the tools field — verified against
    // the live endpoint, which returned standard `tool_calls` deltas.
    supportsToolStream: true,
    // Usage bills against the subscription, so there is no per-token rate. Left
    // unset renders as "not applicable"; a zero would render as a measured
    // $0.00.
    priceCacheHitPerMtok: undefined,
    priceCacheMissPerMtok: undefined,
    priceOutputPerMtok: undefined,
    priceCacheWritePerMtok: undefined,
    reasoning: catalog?.reasoning,
    enabled: true,
  };
}

export interface ImportResult {
  added: number;
  /** Already present, and left exactly as the user had them. */
  skipped: number;
}

/**
 * Add the plan's models that aren't in the list yet.
 *
 * Additive on purpose. Models already there are left alone — they are ordinary
 * rows the user may have renamed, re-priced or set a reasoning tier on, and an
 * import that overwrote them would undo that silently. Anything unwanted is
 * removed with the same delete control every other provider's models use.
 *
 * The free tier is skipped: those are previews and contributor builds, not what
 * a subscriber came for, and they can still be added by hand.
 */
export async function importOpenCodeModels(): Promise<ImportResult> {
  const plan = (await fetchOpenCodeModels()).filter((model) => !model.isFree);

  const existing = new Set(
    useAgentSettingsStore
      .getState()
      .models.filter((m) => m.providerId === OPENCODE_PROVIDER_ID)
      .map((m) => m.modelKey),
  );

  const missing = plan.filter((model) => !existing.has(model.id));
  const rows = await Promise.all(
    missing.map(async (model) => toModelRow(model, await lookupForGo(model))),
  );

  const store = useAgentSettingsStore.getState();
  for (const row of rows) store.addModel(OPENCODE_PROVIDER_ID, row);

  return { added: rows.length, skipped: plan.length - missing.length };
}

/** Exported for tests. */
export const __test = { toModelRow };
