import React, { useEffect, useRef, useState } from "react";
import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import {
  galleryImageTitle,
  galleryFileSrc,
  galleryThumbnail,
  type GalleryImage,
} from "@/apps/agent/services/gallery/gallery-service";
import { videoStatus } from "@/apps/agent/services/gallery/video-service";

export const GalleryTile: React.FC<{
  image: GalleryImage;
  onOpen: () => void;
  onPreview?: () => void;
  onMenu?: (
    event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>,
  ) => void;
}> = ({ image, onOpen, onPreview, onMenu }) => {
  const button = useRef<HTMLButtonElement>(null);
  const [src, setSrc] = useState<string>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const title = galleryImageTitle(image);
  const { threadId, name, path } = image;
  const isVideo = !!image.video;

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (isVideo) {
        setSrc(path ? galleryFileSrc(path) : undefined);
        return;
      }
      void galleryThumbnail({ threadId, name }).then(
        (url) => {
          if (!cancelled) {
            setSrc(url);
            setError("");
          }
        },
        (cause) => {
          if (!cancelled) setError(String(cause));
        },
      );
    };
    if (!button.current || typeof IntersectionObserver === "undefined") {
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
      { rootMargin: "200px" },
    );
    observer.observe(button.current);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [threadId, name, path, isVideo, attempt]);

  return (
    <div className="agw-gallery-item">
      <button
        ref={button}
        type="button"
        className="agw-gallery-tile"
        style={{
          aspectRatio: Math.max(0.4, image.width / Math.max(1, image.height)),
        }}
        aria-label={`Open ${title}`}
        title={`${title}\n${image.threadTitle}`}
        onClick={onOpen}
        onDoubleClick={onPreview}
        onContextMenu={onMenu}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onPreview?.();
          }
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          )
            onMenu?.(event);
        }}
      >
        {src && !error && isVideo ? (
          <video
            src={`${src}#t=0.1`}
            muted
            playsInline
            preload="metadata"
            tabIndex={-1}
            aria-hidden="true"
            onError={() => setError("Video preview could not be loaded")}
          />
        ) : src && !error ? (
          <img
            src={src}
            alt={title}
            loading="lazy"
            decoding="async"
            onError={() => setError("Preview could not be loaded")}
          />
        ) : (
          <span className="agw-gallery-placeholder">
            <AgentIcon name="image" size={24} />
            <span>
              {error
                ? "Preview unavailable"
                : image.video
                  ? videoStatus(image.video)
                  : "Loading image"}
            </span>
          </span>
        )}
        {image.video && (
          <span className="agw-gallery-video-badge">
            Video / {image.video.duration}s
          </span>
        )}
        <span className="agw-gallery-caption">{title}</span>
      </button>
      {error && (
        <button
          className="agw-gallery-retry"
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
