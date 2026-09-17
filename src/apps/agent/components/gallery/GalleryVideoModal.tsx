import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { VideoResultView } from "@/apps/agent/components/tool-views/VideoResultView";
import {
  hideAgentBrowser,
  showAgentBrowser,
} from "@/apps/agent/components/panels/BrowserPanel";
import type { VideoData } from "@/apps/agent/services/gallery/video-service";

export const GalleryVideoModal: React.FC<{
  video: VideoData;
  onClose: () => void;
  onUpdate: () => void;
}> = ({ video, onClose, onUpdate }) => {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    close.current?.focus();
    void hideAgentBrowser();
    return () => {
      void showAgentBrowser();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
      if (event.key === "Tab") {
        const controls = Array.from(
          dialog.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled), video[controls]",
          ) ?? [],
        );
        const index = controls.indexOf(document.activeElement as HTMLElement);
        if (
          index < 0 ||
          (!event.shiftKey && index === controls.length - 1) ||
          (event.shiftKey && index === 0)
        ) {
          event.preventDefault();
          controls[event.shiftKey ? controls.length - 1 : 0]?.focus();
        }
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);
  return createPortal(
    <div className="agw-img-overlay" onClick={onClose}>
      <div
        ref={dialog}
        className="agw-img-dialog agw-gallery-video-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Video preview"
        onClick={(event) => event.stopPropagation()}
      >
        <VideoResultView video={video} onUpdate={onUpdate} />
        <button
          ref={close}
          type="button"
          className="agw-img-close"
          aria-label="Close video preview"
          title="Close"
          onClick={onClose}
        >
          <AgentIcon name="close" size={16} />
        </button>
      </div>
    </div>,
    document.querySelector(".agw-root") ?? document.body,
  );
};
