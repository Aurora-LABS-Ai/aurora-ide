/**
 * Agent Window — one picture in a tool result [view].
 *
 * A captured page, an image the agent opened with `file_read`, or a picture
 * `generate_image` made. Renders from its on-disk copy (via the asset protocol)
 * as a thumbnail; clicking it opens the shared full-size image modal, the same
 * viewer a chat-bubble image uses. Only mounts inside the expanded card, so the
 * image loads on demand rather than while the card is collapsed.
 *
 * A made picture also lives on the Canvas, and the marker says which entry
 * (`artifactId`). That is the one case with somewhere else to go, so it is the
 * one case that shows a way there — a capture has no Canvas entry and gets no
 * dead link.
 *
 * Its own file because both the single-image router and the multi-file view
 * mount it — importing it from the router would make those two circular.
 */

import React, { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { isTauri } from "@/kernel/lib/ipc/tauri";
import { AgentIcon } from "@/apps/agent/shared";
import { AgentImageModal } from "@/apps/agent/components/modals/AgentImageModal";
import { baseName, type ToolImage } from "@/apps/agent/components/tool-views/tool-result";
import { useConversationScope } from "@/apps/agent/lib/thread/conversation-scope";
import { useAgentArtifactStore } from "@/apps/agent/store/artifacts/useAgentArtifactStore";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";

export const ImageResult: React.FC<{ image: ToolImage }> = ({ image }) => {
  const [open, setOpen] = useState(false);
  // Prefer the on-disk file (small, asset-protocol). If it 404s — pruned after
  // an hour, or a reloaded thread whose file is gone — fall back to the base64
  // embedded in the result so the image still renders. Never a dumped blob.
  const [fileBroken, setFileBroken] = useState(false);
  // Artifacts are stored per conversation, so the Canvas entry to open is the
  // one of the chat this card is IN — not the open chat when the card sits in
  // a conversation docked in the side panel.
  const scope = useConversationScope();
  const currentThreadId = useAgentChatStore((state) => state.currentThreadId);
  const threadId = scope?.threadId ?? currentThreadId;
  // The artifact's own title, when the bundle has it; the picture's file name
  // otherwise. `openArtifactTab` re-titles on reopen, so a first-paint fallback
  // corrects itself the next time the tab is opened.
  const artifactTitle = useAgentArtifactStore((state) =>
    image.artifactId && threadId
      ? state.bundles[threadId]?.artifacts.find((entry) => entry.id === image.artifactId)?.title
      : undefined,
  );
  const fileSrc =
    image.path && !fileBroken ? (isTauri() ? convertFileSrc(image.path) : image.path) : null;
  // The marker records what it encoded; a `file_read` image is JPEG, and a data
  // URI that mislabels its bytes as PNG renders as a broken image.
  const dataSrc = image.base64
    ? `data:${image.mediaType ?? "image/png"};base64,${image.base64}`
    : null;
  const src = fileSrc ?? dataSrc;
  if (!src) {
    // Neither a path nor base64 — the header summary already notes the image.
    return null;
  }
  const ratio = image.width && image.height ? `${image.width} / ${image.height}` : undefined;
  const label = image.name
    ? baseName(image.name)
    : image.url
      ? `Screenshot of ${image.url}`
      : "Screenshot";
  const canvasEntry = image.artifactId && threadId ? image.artifactId : null;

  const openInCanvas = () => {
    if (!canvasEntry) return;
    useAgentArtifactStore.getState().setCanvasSource("artifact");
    useAgentWorkspaceStore.getState().openArtifactTab(canvasEntry, artifactTitle ?? label);
  };

  return (
    <div className="agw-tool-shot" data-made={canvasEntry ? "true" : undefined}>
      <button
        type="button"
        className="agw-tool-shot-btn"
        title={`Open ${label}`}
        onClick={() => setOpen(true)}
      >
        <img
          src={src}
          alt={label}
          className="agw-tool-shot-img"
          style={ratio ? { aspectRatio: ratio } : undefined}
          loading="lazy"
          draggable={false}
          onError={() => {
            // On-disk file failed to load — drop to the base64 fallback (if any).
            if (fileSrc && dataSrc) setFileBroken(true);
          }}
        />
      </button>
      {canvasEntry && (
        <button
          type="button"
          className="agw-tool-shot-canvas"
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
