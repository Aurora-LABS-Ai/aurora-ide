/**
 * Agent Window — one picture in a tool result [view].
 *
 * A captured page, or an image the agent opened with `file_read`. Renders from
 * its on-disk copy (via the asset protocol) as a thumbnail; clicking it opens
 * the shared full-size image modal, the same viewer a chat-bubble image uses.
 * Only mounts inside the expanded card, so the image loads on demand rather
 * than while the card is collapsed.
 *
 * Its own file because both the single-image router and the multi-file view
 * mount it — importing it from the router would make those two circular.
 */

import React, { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { isTauri } from "@/kernel/lib/ipc/tauri";
import { AgentImageModal } from "@/apps/agent/components/modals/AgentImageModal";
import { baseName, type ToolImage } from "@/apps/agent/components/tool-views/tool-result";

export const ImageResult: React.FC<{ image: ToolImage }> = ({ image }) => {
  const [open, setOpen] = useState(false);
  // Prefer the on-disk file (small, asset-protocol). If it 404s — pruned after
  // an hour, or a reloaded thread whose file is gone — fall back to the base64
  // embedded in the result so the image still renders. Never a dumped blob.
  const [fileBroken, setFileBroken] = useState(false);
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
  return (
    <div className="agw-tool-shot">
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
      <AgentImageModal
        open={open}
        mode="preview"
        src={open ? src : null}
        onClose={() => setOpen(false)}
      />
    </div>
  );
};
