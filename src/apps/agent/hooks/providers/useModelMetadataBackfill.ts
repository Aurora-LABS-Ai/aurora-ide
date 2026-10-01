/**
 * Agent Window — fill a barren model's metadata from models.dev.
 *
 * A preset or seeded model can arrive with no context window, no prices and
 * every capability `false` as a placeholder. While the Providers page is open
 * this looks each one up once and fills ONLY what is empty — `reasoning` is
 * never touched (the user's to configure), and capabilities are OR-ed in so
 * this can only ever turn one on.
 *
 * The "already done" set is module-level, not a per-mount ref: reopening the
 * page must not re-run the backfill and overwrite the user's manual edits.
 * It lived inside the old Providers settings page; the page changed shape and
 * the behaviour did not.
 */

import { useEffect } from "react";

import { lookupModel } from "@/apps/agent/services/providers/models-dev";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";

const enrichedModelIds = new Set<string>();

export function useModelMetadataBackfill(): void {
  const models = useAgentSettingsStore((s) => s.models);
  const updateModel = useAgentSettingsStore((s) => s.updateModel);

  useEffect(() => {
    const missing = models.filter((m) => !enrichedModelIds.has(m.id) && m.contextWindow == null);
    if (missing.length === 0) return;
    let alive = true;
    void (async () => {
      for (const m of missing) {
        enrichedModelIds.add(m.id);
        const e = await lookupModel(m.modelKey);
        if (!alive || !e) continue;
        updateModel(m.id, {
          contextWindow: m.contextWindow ?? e.contextWindow,
          maxOutputTokens: m.maxOutputTokens ?? e.maxOutputTokens,
          supportsVision: m.supportsVision || e.supportsVision,
          supportsThinking: m.supportsThinking || e.supportsThinking,
          supportsToolStream: m.supportsToolStream || e.supportsToolStream,
          priceCacheHitPerMtok: m.priceCacheHitPerMtok ?? e.priceCacheHitPerMtok,
          priceCacheMissPerMtok: m.priceCacheMissPerMtok ?? e.priceCacheMissPerMtok,
          priceOutputPerMtok: m.priceOutputPerMtok ?? e.priceOutputPerMtok,
          priceCacheWritePerMtok: m.priceCacheWritePerMtok ?? e.priceCacheWritePerMtok,
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, [models, updateModel]);
}
