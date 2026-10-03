/**
 * Agent Window — which image model the Images page draws with.
 *
 * The page has no conversation to pin a model on, so the choice lives here:
 * the ready image models flattened from the provider rows, and the user's last
 * pick remembered in localStorage. A pick that stopped being ready (provider
 * disabled, key removed, model deleted) falls back to the first ready model
 * rather than to nothing — the page should never open with a dead picker.
 *
 * Kept out of the settings store on purpose: that store persists to the
 * `app_settings` table behind a key list a test guards, and a per-page
 * convenience is not a setting.
 */

import {
  imageModelSelection,
  imageProviderReady,
  type ImageModel,
  type ImageProvider,
} from "@/apps/agent/services/providers/image-providers";

export interface ReadyImageModel {
  provider: ImageProvider;
  model: ImageModel;
  /** `"<providerId>:<modelKey>"`, the same pin a picture-making chat carries. */
  selection: string;
  /** What the picker shows. */
  label: string;
}

const CHOICE_KEY = "agw-images-model";

/** Every model of every provider that can be called right now, in row order. */
export function readyImageModels(providers: readonly ImageProvider[]): ReadyImageModel[] {
  return providers.filter(imageProviderReady).flatMap((provider) =>
    provider.models.map((model) => ({
      provider,
      model,
      selection: imageModelSelection(model),
      label: model.label?.trim() || model.modelKey,
    })),
  );
}

export function loadImageModelChoice(): string | null {
  try {
    return localStorage.getItem(CHOICE_KEY);
  } catch {
    return null;
  }
}

export function saveImageModelChoice(selection: string): void {
  try {
    localStorage.setItem(CHOICE_KEY, selection);
  } catch {
    /* private mode / quota — the page still works for this session */
  }
}

const SIZE_KEY = "agw-images-size";

/**
 * The size last chosen for each model, by selection. Per model, because a
 * size one model offers is not a size the next one takes.
 */
function readSizes(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

export function loadImageSizeChoice(selection: string): string | null {
  const size = readSizes()[selection];
  return typeof size === "string" ? size : null;
}

export function saveImageSizeChoice(selection: string, size: string): void {
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify({ ...readSizes(), [selection]: size }));
  } catch {
    /* private mode / quota — the page still works for this session */
  }
}

/** The remembered pick while it is still ready; otherwise the first ready model; otherwise none. */
export function pickImageModel(
  models: readonly ReadyImageModel[],
  saved: string | null,
): ReadyImageModel | null {
  return models.find((entry) => entry.selection === saved) ?? models[0] ?? null;
}
