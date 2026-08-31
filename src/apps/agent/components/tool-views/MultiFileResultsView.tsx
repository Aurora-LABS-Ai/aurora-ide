/**
 * Agent Window — multi_file_read view [tool result].
 *
 * The header owns file selection. This body mounts exactly one file at a time so
 * a large batch read cannot instantiate several syntax highlighters at once.
 */

import React from "react";

import { FileIcon } from "@/kernel/ui/FileIcons";
import { ImageResult } from "@/apps/agent/components/tool-views/ImageResult";
import { baseName, type MultiFileEntry } from "@/apps/agent/components/tool-views/tool-result";
import { ToolCode } from "@/apps/agent/components/tool-views/ToolCode";

export const MultiFileResultsView: React.FC<{
  files: MultiFileEntry[];
  activeIndex?: number;
}> = ({ files, activeIndex = 0 }) => {
  const selectedIndex = Math.min(Math.max(activeIndex, 0), files.length - 1);
  const file = files[selectedIndex];
  if (!file) return null;

  return (
    <div className="agw-rv">
      <div className="agw-rv-head">
        <FileIcon name={baseName(file.path)} path={file.path} className="agw-file-ico" />
        <span className="agw-rv-title-file">{baseName(file.path)}</span>
        <span className="agw-rv-stats">
          {/* A picture has no lines. Its size is its dimensions, and those are
              the ones on screen — the original's are in the caption the model
              was given. */}
          {file.image?.width && file.image.height ? (
            <span>
              {file.image.width}×{file.image.height}
            </span>
          ) : file.window ? (
            <span>
              L{file.window.start}–{file.window.end}
              {typeof file.lines === "number" && ` of ${file.lines.toLocaleString()}`}
            </span>
          ) : (
            typeof file.lines === "number" && <span>{file.lines.toLocaleString()} L</span>
          )}
          <span>{selectedIndex + 1} / {files.length}</span>
        </span>
      </div>
      {/* A picture is this file's content. It goes through the same one-at-a-time
          mount as the code below, so a read of eight screens never puts eight
          images on the page at once. */}
      {file.image ? (
        <div className="agw-multi-read">
          <ImageResult image={file.image} />
        </div>
      ) : file.content !== undefined ? (
        <div className="agw-multi-read">
          <ToolCode code={file.content} path={file.fullPath ?? file.path} />
          {/* Only ever about SIZE. A window omitting lines is the window doing
              its job, and the range in the header already says so. */}
          {file.truncated && !file.window && (
            <div className="agw-rv-trunc-note" role="note">
              Showing the beginning — the full file was too large to keep in
              this conversation.
            </div>
          )}
        </div>
      ) : (
        <div className="agw-multi-read-error" role="status">
          {file.error || "This file could not be read."}
        </div>
      )}
    </div>
  );
};
