/**
 * Agent Window — an `image` artifact on the Canvas.
 *
 * The artifact's content is a record naming a file in the conversation's
 * `assets/` folder, not the picture itself, so this loads the file through the
 * asset protocol and fits it to the stage. Under it sits what a person wants
 * to know about a made picture and cannot see in it: the prompt, what made it,
 * its real size, and what it was edited from.
 *
 * A record that does not decode, or a file that is gone, says so in place —
 * the Canvas never shows a broken-image glyph for something it knows the name
 * of (design §3: "not a broken-image icon, not silence").
 */

import React, { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { isTauri } from "@/kernel/lib/ipc/tauri";
import { AgentIcon } from "@/apps/agent/shared";
import { AgentImageModal } from "@/apps/agent/components/modals/AgentImageModal";
import {
  parseImageArtifactContent,
  type ImageArtifactContent,
} from "@/apps/agent/services/artifacts/agent-artifacts";

interface CanvasImageProps {
  source: string;
  title: string;
  /** Bumped by the toolbar's reload; re-mounts the `<img>` so a file that has
   *  since reappeared gets another try. */
  refreshKey: number;
}

const SOURCE_LABEL: Record<ImageArtifactContent["source"], string> = {
  generated: "Generated",
  edited: "Edited",
  attached: "Attached",
};

export const CanvasImage: React.FC<CanvasImageProps> = ({ source, title, refreshKey }) => {
  const record = parseImageArtifactContent(source);
  const [open, setOpen] = useState(false);
  const [missing, setMissing] = useState(false);

  if (!record) {
    return (
      <div className="agw-canvas-empty" role="alert">
        <AgentIcon name="help" size={24} />
        <strong>This image entry can’t be read</strong>
        <span>Its record does not name a picture file. Open Source to see what was stored.</span>
      </div>
    );
  }

  const src = isTauri() ? convertFileSrc(record.path) : record.path;
  const made = SOURCE_LABEL[record.source];
  const by = [record.model, record.provider].filter(Boolean);

  return (
    <div className="agw-canvas-image">
      <div className="agw-canvas-image-stage">
        {missing ? (
          <div className="agw-canvas-empty" role="alert">
            <AgentIcon name="alert" size={24} />
            <strong>The picture file is missing</strong>
            <span>
              {record.asset} is no longer in this conversation’s assets. Reload after restoring
              it, or ask for the image again.
            </span>
          </div>
        ) : (
          <button
            type="button"
            className="agw-canvas-image-btn"
            title="View full size"
            onClick={() => setOpen(true)}
          >
            <img
              key={refreshKey}
              src={src}
              alt={record.prompt ?? title}
              className="agw-canvas-image-img"
              draggable={false}
              onError={() => setMissing(true)}
            />
          </button>
        )}
      </div>
      <dl className="agw-canvas-image-facts">
        {record.prompt && (
          <div className="agw-canvas-image-prompt">
            <dt>Prompt</dt>
            <dd>{record.prompt}</dd>
          </div>
        )}
        <div>
          <dt>{made}</dt>
          <dd>
            {by.length > 0 ? by.join(" · ") : "by the conversation model"}
            {record.parent ? ` · from ${record.parent}` : ""}
          </dd>
        </div>
        <div>
          <dt>File</dt>
          <dd>
            {record.asset}
            {record.width > 0 && record.height > 0
              ? ` · ${record.width}×${record.height} px`
              : ""}
          </dd>
        </div>
      </dl>
      <AgentImageModal
        open={open}
        mode="preview"
        src={open ? src : null}
        onClose={() => setOpen(false)}
      />
    </div>
  );
};
