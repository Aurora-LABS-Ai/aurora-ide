/**
 * Cursor run preferences and exact variant resolution.
 *
 * This is the only bridge between Aurora's model-row controls and Cursor's
 * model ids. The picker uses it to decide which controls are valid, and the
 * send path uses it to choose the wire id. Keeping both callers here prevents
 * the UI from describing one run while the request silently sends another.
 */

import { isFastOn } from "@/apps/agent/lib/model/cursor-fast";
import {
  cursorVariantCapabilities,
  resolveCursorVariant,
  splitCursorVariant,
  type CursorRunOptions,
  type CursorVariantResolution,
} from "@/apps/agent/services/providers/cursor-variants";
import { reasoningIsOn } from "@/apps/agent/store/settings/useAgentSettingsStore";
import type { ModelReasoning } from "@/kernel/types/database";

export interface CursorRunModel {
  /** Stable Cursor model key, such as `cursor-grok-4.6`. */
  modelKey: string;
  /** Stable provider-model row id, used for the per-model Fast preference. */
  id?: string;
  reasoning?: ModelReasoning;
}

/** Translate the row's controls into one semantic Cursor run tuple. */
export function cursorRunOptions(
  model: CursorRunModel,
  fast = model.id ? isFastOn(model.id) : splitCursorVariant(model.modelKey).fast,
): Required<Pick<CursorRunOptions, "thinking" | "fast">> &
  Pick<CursorRunOptions, "effort"> {
  const own = splitCursorVariant(model.modelKey);
  const capabilities = cursorVariantCapabilities(model.modelKey);
  const reasoningOn = model.reasoning ? reasoningIsOn(model.reasoning) : false;
  const thinking = capabilities?.hasThinking
    ? capabilities.thinkingOnly || (model.reasoning ? reasoningOn : own.thinking)
    : own.thinking;
  const effort =
    model.reasoning?.type === "effort" && typeof model.reasoning.default === "string"
      ? model.reasoning.default
      : own.effort;
  return { thinking, effort, fast };
}

/** Resolve the exact raw id for the row and its currently stored controls. */
export function resolveCursorModelRun(
  model: CursorRunModel,
  fast = model.id ? isFastOn(model.id) : splitCursorVariant(model.modelKey).fast,
): CursorVariantResolution {
  return resolveCursorVariant(model.modelKey, cursorRunOptions(model, fast));
}

/** Whether Fast exists for this row's current thinking and effort selection. */
export function resolveCursorFast(model: CursorRunModel): CursorVariantResolution {
  const { thinking, effort } = cursorRunOptions(model, false);
  return resolveCursorVariant(model.modelKey, { thinking, effort, fast: true });
}

export function cursorFastAvailable(model: CursorRunModel): boolean {
  return resolveCursorFast(model).ok;
}
