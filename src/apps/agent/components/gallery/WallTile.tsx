/**
 * Agent Window — one tile on the media wall [view].
 *
 * ONE component for a picture and for a picture still being made, because the
 * two are the same slot at different moments. A job is the silk placeholder;
 * when it finishes it shows the finished file straight away (the command
 * returned its path), and when the gallery lists that picture under the same
 * key, React keeps this very component — so the picture never blinks out and
 * back in while its thumbnail loads. `src` only ever moves forward: a new
 * source replaces the old one once it has loaded, not before.
 *
 * Hover (or keyboard focus) shows two actions in the corner: the eye blurs the
 * picture — just the blur, no label — and the trash asks to delete it. The
 * blur is a property of the picture, remembered in its manifest.
 */

import React, { useEffect, useRef, useState } from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { SilkPlaceholder } from "@/apps/agent/components/theme/SilkPlaceholder";
import {
  cachedGalleryThumbnail,
  isDecodedSrc,
  markDecodedSrc,
  galleryFileSrc,
  galleryImageTitle,
  galleryThumbnail,
  type GalleryImage,
} from "@/apps/agent/services/gallery/gallery-service";
import { videoStatus } from "@/apps/agent/services/gallery/video-service";
import type { ImageJob } from "@/apps/agent/store/images/useAgentImagesStore";

export interface WallTileProps {
  image?: GalleryImage;
  job?: ImageJob;
  hidden: boolean;
  selected: boolean;
  onOpen?: () => void;
  onPreview?: () => void;
  onMenu?: (event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>) => void;
  onToggleHidden?: () => void;
  onDelete?: () => void;
  onRetry?: () => void;
  onDismiss?: () => void;
}

export const WallTile: React.FC<WallTileProps> = ({
  image,
  job,
  hidden,
  selected,
  onOpen,
  onPreview,
  onMenu,
  onToggleHidden,
  onDelete,
  onRetry,
  onDismiss,
}) => {
  const root = useRef<HTMLDivElement>(null);
  // A tile seen before this session starts on its thumbnail, already drawn:
  // no shimmer and no fade on a page switch.
  const [src, setSrc] = useState<string | undefined>(() =>
    image && !image.video ? cachedGalleryThumbnail(image) : undefined,
  );
  const [loaded, setLoaded] = useState(() =>
    isDecodedSrc(src ?? (job?.result ? galleryFileSrc(job.result.path) : undefined)),
  );
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  const isVideo = !!image?.video;
  const threadId = image?.threadId;
  const name = image?.name;
  const path = image?.path ?? job?.result?.path;

  // A finished job's own file, the moment it exists, until a thumbnail lands.
  const shownSrc = src ?? (job?.result ? galleryFileSrc(job.result.path) : undefined);

  // The gallery thumbnail, loaded when the tile comes near the viewport.
  useEffect(() => {
    if (!threadId || !name) return;
    if (!isVideo && attempt === 0 && cachedGalleryThumbnail({ threadId, name })) return;
    let cancelled = false;
    const load = () => {
      if (isVideo) {
        if (path) setSrc(galleryFileSrc(path));
        return;
      }
      void galleryThumbnail({ threadId, name }).then(
        (url) => {
          if (cancelled) return;
          // Decode before swapping, so a tile already showing a picture keeps
          // it until the thumbnail is ready instead of flashing the shimmer.
          const probe = new Image();
          probe.onload = () => !cancelled && setSrc(url);
          probe.onerror = () => !cancelled && setSrc(url);
          probe.src = url;
          setError("");
        },
        (cause) => !cancelled && setError(String(cause)),
      );
    };
    const node = root.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      load();
      return () => {
        cancelled = true;
      };
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          load();
        }
      },
      { rootMargin: "300px" },
    );
    observer.observe(node);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [threadId, name, path, isVideo, attempt]);

  // ── A picture being made, or one that failed ─────────────────────────────
  if (job && !image && job.status !== "done") {
    const failed = job.status === "failed";
    return (
      <div
        ref={root}
        className="agw-wall-tile"
        data-state={job.status}
        role={failed ? "alert" : "status"}
        aria-label={failed ? `Could not make: ${job.prompt}` : `Making: ${job.prompt}`}
      >
        {failed ? (
          <div className="agw-wall-failed">
            <p>{job.error || "The picture could not be made."}</p>
            <div className="agw-wall-failed-actions">
              <button type="button" onClick={onRetry}>
                <AgentIcon name="reset" size={13} />
                Retry
              </button>
              <button type="button" onClick={onDismiss}>
                <AgentIcon name="close" size={13} />
                Dismiss
              </button>
            </div>
          </div>
        ) : (
          <SilkPlaceholder className="agw-wall-silk" aspectRatio={job.aspectRatio} label="Making the picture" />
        )}
        <span className="agw-wall-caption" title={job.prompt}>
          {job.modelLabel} · {job.prompt}
        </span>
      </div>
    );
  }

  // ── A picture (or video), or a job whose picture has just landed ─────────
  const title = image ? galleryImageTitle(image) : job?.prompt ?? "";
  return (
    <div
      ref={root}
      className="agw-wall-tile"
      data-state={loaded ? "ready" : "loading"}
      data-hidden={hidden || undefined}
      data-selected={selected || undefined}
    >
      <button
        type="button"
        className="agw-wall-open"
        // A blurred picture shows nothing of what it is — not even its prompt
        // in a tooltip or to a screen reader.
        aria-label={hidden ? "Open picture" : `Open ${title}`}
        title={hidden ? undefined : image ? `${title}\n${image.threadTitle}` : title}
        onClick={onOpen}
        onDoubleClick={onPreview}
        onContextMenu={onMenu}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onPreview?.();
          }
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) onMenu?.(event);
        }}
      >
        {shownSrc && !error && isVideo ? (
          <video
            src={`${shownSrc}#t=0.1`}
            muted
            playsInline
            preload="metadata"
            tabIndex={-1}
            aria-hidden="true"
            onLoadedData={() => setLoaded(true)}
            onError={() => setError("Video preview could not be loaded")}
          />
        ) : shownSrc && !error ? (
          <img
            src={shownSrc}
            alt={hidden ? "" : title}
            decoding="async"
            onLoad={(event) => {
              markDecodedSrc(event.currentTarget.getAttribute("src") ?? "");
              setLoaded(true);
            }}
            onError={() => setError("Preview could not be loaded")}
          />
        ) : null}
        {(error || (image?.video && !shownSrc)) && (
          <span className="agw-wall-placeholder">
            <AgentIcon name="image" size={20} />
            <span>{error ? "Preview unavailable" : videoStatus(image!.video!)}</span>
          </span>
        )}
        {image?.video && <span className="agw-wall-badge">Video · {image.video.duration}s</span>}
        {!hidden && <span className="agw-wall-caption">{title}</span>}
      </button>
      {image && (
        <span className="agw-wall-actions">
          {!isVideo && (
            <button
              type="button"
              className="agw-wall-action"
              aria-pressed={hidden}
              aria-label={hidden ? "Unblur picture" : `Blur ${title}`}
              title={hidden ? "Unblur" : "Blur"}
              onClick={onToggleHidden}
            >
              <AgentIcon name={hidden ? "eye-off" : "eye"} size={14} />
            </button>
          )}
          <button
            type="button"
            className="agw-wall-action"
            aria-label={hidden ? "Delete picture" : `Delete ${title}`}
            title="Delete"
            onClick={onDelete}
          >
            <AgentIcon name="trash" size={14} />
          </button>
        </span>
      )}
      {error && image && (
        <button
          className="agw-wall-retry"
          type="button"
          title={error}
          onClick={() => {
            setError("");
            setAttempt((value) => value + 1);
          }}
        >
          Retry preview
        </button>
      )}
    </div>
  );
};
