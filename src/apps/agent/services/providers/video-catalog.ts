import { auroraInvoke } from "@/kernel/lib/ipc/runtime";

/**
 * One row of the native video roster.
 *
 * The list is owned by Rust (`tools/video/catalog.rs`) and shared by the
 * model-facing `generate_video` tool and this settings view, so a model can
 * never be offered here while the tool refuses it. There is no second list.
 */
export interface VideoModelRow {
  model: string;
  label: string;
  /** Which service serves it: `MiniMax` or `Qwen`. Rows are grouped by this. */
  vendor: string;
  api: string;
  access: string;
  input: string;
  duration: number[];
  resolutions: string[];
  note: string;
}

export interface VideoCatalog {
  models: VideoModelRow[];
  defaultModel: string;
}

/** Local built-ins, not an account entitlement or quota probe. */
export const loadVideoCatalog = (): Promise<VideoCatalog> =>
  auroraInvoke("video_model_catalog");

/** The catalogue's rows for one service, in catalogue order. */
export const videoModelsFor = (
  catalog: VideoCatalog | null,
  vendor: string,
): VideoModelRow[] =>
  catalog?.models.filter((row) => row.vendor === vendor) ?? [];
