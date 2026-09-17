import { auroraInvoke } from "@/kernel/lib/ipc/runtime";
import type { ImageProvider } from "@/apps/agent/services/providers/image-providers";

export interface VideoData {
  jobId: string;
  threadId: string;
  providerId: string;
  taskId?: string | null;
  model: string;
  prompt: string;
  duration: number;
  resolution: string;
  status: string;
  path?: string | null;
  error?: string | null;
  /**
   * The shape the finished clip will have, as width / height.
   *
   * Sent by `jobs::result()` so a queued card can reserve the video's real box
   * while it waits. Older job records predate the field, so a missing or
   * nonsensical value falls back to 16:9 rather than collapsing the card.
   */
  aspectRatio?: number;
  /** RFC 3339, from the job record. Drives the elapsed clock while queued. */
  createdAt?: string;
}

/** `m:ss` since the task was submitted, or `null` when that is not knowable. */
export function elapsedSince(createdAt: string | null | undefined): string | null {
  const started = Date.parse(createdAt ?? "");
  if (!Number.isFinite(started)) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  // A clock that reads "874:13" after a week is noise, not information.
  if (seconds >= 60 * 60 * 24) return null;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Default shape for a video whose request did not name one.
 *
 * Unlike an image, a video request carries no `size`: it carries a `ratio`
 * (`16:9`), and often only a `resolution` (`768P`) which says nothing about
 * shape. Landscape is what every text-to-video default produces.
 */
export const DEFAULT_VIDEO_ASPECT = "16 / 9";

/**
 * A requested `ratio` argument as a CSS `aspect-ratio`.
 *
 * `adaptive` means the provider takes the shape from an input picture, which
 * is not knowable before the clip exists, so it falls back like an absent
 * value. Arguments stream in a character at a time, so a half-arrived `"16:"`
 * must read as "not yet known" rather than briefly reserving a broken box.
 */
export function aspectRatioOfVideoRatio(ratio: string | null | undefined): string {
  const match = /^\s*(\d+)\s*:\s*(\d+)\s*$/.exec(ratio ?? "");
  if (!match) return DEFAULT_VIDEO_ASPECT;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  )
    return DEFAULT_VIDEO_ASPECT;
  return `${width} / ${height}`;
}

/** The video's shape as a CSS `aspect-ratio`, never a broken one. */
export const videoAspectRatio = (video: VideoData): string => {
  const ratio = video.aspectRatio;
  return typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0.1 && ratio < 10
    ? `${ratio} / 1`
    : "16 / 9";
};

export function parseVideo(value: unknown): VideoData | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (
    ![
      "jobId",
      "threadId",
      "providerId",
      "model",
      "prompt",
      "resolution",
      "status",
    ].every((key) => typeof row[key] === "string")
  )
    return null;
  if (typeof row.duration !== "number" || !Number.isFinite(row.duration))
    return null;
  if (
    ["path", "error", "taskId"].some(
      (key) => row[key] != null && typeof row[key] !== "string",
    )
  )
    return null;
  // Optional, and older records simply do not carry it. A present-but-wrong
  // value is rejected here so the card never sizes itself from nonsense.
  if (
    row.aspectRatio != null &&
    (typeof row.aspectRatio !== "number" || !Number.isFinite(row.aspectRatio))
  )
    return null;
  return row as unknown as VideoData;
}

export async function refreshVideo(
  video: VideoData,
  provider: ImageProvider,
): Promise<VideoData> {
  const result = await auroraInvoke<{ video: unknown }>("chat_video_refresh", {
    threadId: video.threadId,
    jobId: video.jobId,
    provider,
  });
  const updated = parseVideo(result.video);
  if (!updated || updated.jobId !== video.jobId)
    throw new Error("MiniMax returned an invalid video task");
  return updated;
}

export const videoStatus = (video: VideoData): string =>
  video.path
    ? "Ready"
    : ({
        submitting: "Submission pending",
        queued: "Queued",
        running: "Generating",
        succeeded: "Ready to download",
        failed: "Generation failed",
        cancelled: "Cancelled",
        unknown: "Submission unconfirmed",
      }[video.status] ?? video.status);
