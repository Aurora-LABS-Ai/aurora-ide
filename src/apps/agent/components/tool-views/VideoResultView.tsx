/**
 * Agent Window — a generated video, in every state it passes through.
 *
 * Card 01 of `aurora-video-result-designs.html`. A video wait is the same kind
 * of wait as an image's, only far longer, and it OUTLIVES the tool call: the
 * submit returns in a second and the clip arrives minutes later, so the hole
 * has to live in the result rather than in the tool card.
 *
 * So the queued state is the same silk placeholder image generation uses, at
 * the video's real aspect, with the state, the facts and the refresh as one
 * overlay line inside the box. The clip then crossfades into the shape it
 * already reserved instead of shoving the transcript down.
 *
 * The states that are NOT a wait get no shader and no refresh. A failed task
 * cannot be refreshed into a good one, so the control is removed rather than
 * disabled — a control that can never do anything should not be drawn.
 */

import React, { useEffect, useState } from "react";
import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { SilkPlaceholder } from "@/apps/agent/components/theme/SilkPlaceholder";
import { useSettingsStore } from "@/kernel/store/useSettingsStore";
import { galleryFileSrc } from "@/apps/agent/services/gallery/gallery-service";
import {
  elapsedSince,
  refreshVideo,
  videoAspectRatio,
  videoStatus,
  type VideoData,
} from "@/apps/agent/services/gallery/video-service";

/** States where nothing more is coming, whatever the user does. */
const FINISHED = ["failed", "cancelled"];

export const VideoResultView: React.FC<{
  video: VideoData;
  onUpdate?: () => void;
}> = ({ video: initial, onUpdate }) => {
  const [updated, setUpdated] = useState<{
    source: VideoData;
    video: VideoData;
  } | null>(null);
  const video = updated?.source === initial ? updated.video : initial;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const provider = useSettingsStore((state) =>
    state.imageProviders?.find((row) => row.id === video.providerId),
  );

  const saved = !!video.path;
  const dead = FINISHED.includes(video.status);
  const expired = video.status === "unknown";
  const waiting = !saved && !dead && !expired;
  const canQuery = waiting && !!video.taskId;
  const aspectRatio = videoAspectRatio(video);

  // The clock only ticks while something is actually pending, so a transcript
  // full of finished videos is not re-rendering once a second forever.
  const [elapsed, setElapsed] = useState(() => elapsedSince(video.createdAt));
  useEffect(() => {
    if (!waiting) return;
    setElapsed(elapsedSince(video.createdAt));
    const timer = setInterval(
      () => setElapsed(elapsedSince(video.createdAt)),
      1000,
    );
    return () => clearInterval(timer);
  }, [waiting, video.createdAt]);

  const check = async () => {
    if (busy) return;
    if (!provider?.enabled || !provider.apiKey?.trim()) {
      setError("Add this provider's key in Settings to check the task.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      setUpdated({ source: initial, video: await refreshVideo(video, provider) });
      onUpdate?.();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const facts = `${video.duration}s · ${video.resolution} · ${video.model}`;

  return (
    <div className="agw-video-result">
      {saved ? (
        <video
          key={video.path}
          controls
          playsInline
          preload="metadata"
          style={{ aspectRatio }}
          src={galleryFileSrc(video.path!)}
          aria-label={video.prompt || "Generated video"}
          onError={() =>
            setError(
              "Video could not be played. Open its saved file to check codec support.",
            )
          }
        />
      ) : (
        <div
          className="agw-video-hole"
          style={{ aspectRatio }}
          data-dead={dead || expired ? "true" : undefined}
        >
          {/* No shader on a state that is not a wait: an animation that says
              "working" over a failed task is a lie about what is happening. */}
          {waiting && (
            <SilkPlaceholder
              className="agw-video-silk"
              aspectRatio={aspectRatio}
            />
          )}
          {(dead || expired) && (
            <span className="agw-video-badge" data-tone={dead ? "bad" : "warn"}>
              <AgentIcon name={dead ? "close" : "alert"} size={11} />
              {dead ? videoStatus(video) : "Expired"}
            </span>
          )}
          {waiting && (
            <div className="agw-video-overlay">
              <span role="status">
                {busy ? "Checking..." : videoStatus(video)}
              </span>
              <span className="agw-video-facts">{facts}</span>
              {elapsed && <span className="agw-video-clock">{elapsed}</span>}
              {canQuery && (
                <button
                  type="button"
                  className="agw-video-check"
                  disabled={busy}
                  aria-busy={busy || undefined}
                  title="Check status"
                  aria-label="Check status"
                  onClick={() => void check()}
                >
                  <AgentIcon name="reset" size={13} />
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {/* Once the clip is here the box speaks for itself, so the facts drop to
          a quiet caption rather than staying pinned over the picture. */}
      {(saved || dead || expired) && (
        <div className="agw-video-meta">
          <span role="status">{videoStatus(video)}</span>
          <span>{facts}</span>
        </div>
      )}
      {(error || video.error) && <p role="alert">{error || video.error}</p>}
    </div>
  );
};
