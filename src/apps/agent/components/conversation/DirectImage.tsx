/**
 * Agent Window — a picture made DIRECTLY, in the transcript.
 *
 * Card 01 of the placeholder probe: no frame, no label. The conversation's
 * model is an image model, you typed the prompt, so there is nothing to
 * caption — the reply IS the picture. While it is being made the silk
 * placeholder holds exactly the space the picture will take, at the requested
 * aspect, and the picture crossfades in over it when it lands. A failure keeps
 * the same hole and says why in it, so the transcript never jumps.
 *
 * Model-CALLED pictures are not this component. They are tool calls and
 * render as tool cards (`ImageResult`), which is where the frame lives.
 */

import React, { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { isTauri } from "@/kernel/lib/ipc/tauri";
import { AgentIcon } from "@/apps/agent/shared";
import { AgentImageModal } from "@/apps/agent/components/modals/AgentImageModal";
import { SilkPlaceholder } from "@/apps/agent/components/theme/SilkPlaceholder";
import { useConversationScope } from "@/apps/agent/lib/thread/conversation-scope";
import { useAgentArtifactStore } from "@/apps/agent/store/artifacts/useAgentArtifactStore";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";
import type { DirectImageEvent } from "./timeline";

const aspectOf = (image: DirectImageEvent): string =>
  image.width > 0 && image.height > 0 ? `${image.width} / ${image.height}` : "1 / 1";

export const DirectImage: React.FC<{ image: DirectImageEvent }> = ({ image }) => {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [missing, setMissing] = useState(false);
  const scope = useConversationScope();
  const currentThreadId = useAgentChatStore((state) => state.currentThreadId);
  const threadId = scope?.threadId ?? currentThreadId;
  const artifactTitle = useAgentArtifactStore((state) =>
    image.artifactId && threadId
      ? state.bundles[threadId]?.artifacts.find((entry) => entry.id === image.artifactId)?.title
      : undefined,
  );

  const aspectRatio = aspectOf(image);
  const label = image.prompt?.trim() || "Generated picture";
  const src =
    image.status === "ready" && image.path
      ? isTauri()
        ? convertFileSrc(image.path)
        : image.path
      : null;

  const openInCanvas = () => {
    if (!image.artifactId || !threadId) return;
    useAgentArtifactStore.getState().setCanvasSource("artifact");
    useAgentWorkspaceStore.getState().openArtifactTab(image.artifactId, artifactTitle ?? label);
  };

  if (image.status === "failed") {
    return (
      <div className="agw-direct-image" style={{ aspectRatio }} role="alert">
        <div className="agw-direct-image-failed">
          <AgentIcon name="help" size={20} />
          <strong>The picture wasn’t made</strong>
          <span>{image.error || "The image provider returned nothing."}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="agw-direct-image" style={{ aspectRatio }} data-ready={loaded || undefined}>
      {/* The placeholder stays mounted under the picture until it has painted,
          which is what turns the arrival into a crossfade instead of a blank
          frame. Once painted it is unmounted so the shader stops running. */}
      {!loaded && <SilkPlaceholder aspectRatio={aspectRatio} className="agw-direct-image-silk" />}
      {src && !missing && (
        <button
          type="button"
          className="agw-direct-image-btn"
          title="Open picture"
          onClick={() => setOpen(true)}
        >
          <img
            src={src}
            alt={label}
            className="agw-direct-image-img"
            draggable={false}
            onLoad={() => setLoaded(true)}
            onError={() => {
              setMissing(true);
              setLoaded(true);
            }}
          />
        </button>
      )}
      {missing && (
        <div className="agw-direct-image-failed" role="alert">
          <AgentIcon name="help" size={20} />
          <strong>This picture’s file is gone</strong>
          <span>{image.asset ? `${image.asset} is no longer in the conversation’s assets.` : "Its file could not be read."}</span>
        </div>
      )}
      {loaded && !missing && image.artifactId && (
        <button
          type="button"
          className="agw-direct-image-canvas"
          onClick={openInCanvas}
          aria-label={`Open ${artifactTitle ?? label} in Canvas`}
        >
          <span>Open in Canvas</span>
          <AgentIcon name="external" size={12} />
        </button>
      )}
      <AgentImageModal
        open={open}
        mode="preview"
        src={open ? src : null}
        onClose={() => setOpen(false)}
      />
    </div>
  );
};
