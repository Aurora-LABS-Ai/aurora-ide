/**
 * One model as the selector shows it: availability joined with the models-slice
 * row for capabilities, reasoning and ordering.
 */

import type { LLMModel } from "@/apps/agent/store/settings/useAgentSettingsStore";

export interface RichOption {
  providerId: string;
  providerName: string;
  model: string; // modelKey
  label: string;
  /** Matching `LLMModel.id` (present when the model lives in the models slice). */
  id?: string;
  vision: boolean;
  tools: boolean;
  reasoning?: LLMModel["reasoning"];
  /** Model's own output cap — the ceiling a thinking budget must stay under. */
  maxOutputTokens?: number;
  /** ms epoch for "recently added" sort (0 when unknown). */
  createdAt: number;
  sortOrder: number;
  /**
   * An IMAGE model (Aurora Chat only). Picking it makes the conversation a
   * picture-making one: the reply to every message is a generated image, no
   * language model in between. It has no reasoning, no tools, no vision, and
   * reads no history.
   */
  image?: boolean;
  /**
   * An image model that can also be handed an EXISTING picture to change.
   * Provider and model both have to allow it, so it cannot be read off either
   * alone — and it is the one thing that genuinely differs between two
   * picture models in the same list.
   */
  canEdit?: boolean;
}

/** Effort ids as people say them. Providers send lowercase wire ids, and `xhigh`
 *  capitalised mechanically reads "Xhigh". Used by the card and the trigger. */
const LEVEL_LABELS: Record<string, string> = { xhigh: "X-High", xlow: "X-Low" };
export const levelLabel = (level: string) =>
  LEVEL_LABELS[level.toLowerCase()] ?? (level ? level.charAt(0).toUpperCase() + level.slice(1) : level);

/** The selection string a row stands for: `"providerId:modelKey"`. */
export const optionKey = (o: Pick<RichOption, "providerId" | "model">) =>
  `${o.providerId}:${o.model}`;
