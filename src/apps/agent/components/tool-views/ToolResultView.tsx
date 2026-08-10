/**
 * Agent Window — tool result router [view].
 *
 * Given a `ParsedToolResult`, renders the single richest applicable view:
 * tree / multi-file / grep / shell / file list / edit diff / cleaned code. This
 * is the agent window's analogue of the IDE's per-tool view routing in
 * `ToolItem`, kept isolated (own `--agw-*` chrome, own icons).
 */

import React, { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { isTauri } from "@/kernel/lib/ipc/tauri";
import { FileIcon } from "@/kernel/ui/FileIcons";
import { AgentImageModal } from "@/apps/agent/components/modals/AgentImageModal";
import { DiffView } from "@/apps/agent/components/tool-views/DiffView";
import { GlobResultsView } from "@/apps/agent/components/tool-views/GlobResultsView";
import { GrepResultsView } from "@/apps/agent/components/tool-views/GrepResultsView";
import { MultiFileResultsView } from "@/apps/agent/components/tool-views/MultiFileResultsView";
import { ShellOutputView } from "@/apps/agent/components/tool-views/ShellOutputView";
import { FileListView } from "@/apps/agent/components/tool-views/FileListView";
import { WorkspaceTreeView } from "@/apps/agent/components/tool-views/WorkspaceTreeView";
import { baseName, type ParsedToolResult } from "@/apps/agent/components/tool-views/tool-result";
import { ToolCode } from "@/apps/agent/components/tool-views/ToolCode";

/**
 * Screenshot result body. Renders the captured PNG from its on-disk path (via
 * the asset protocol) as a thumbnail; clicking it opens the shared full-size
 * image modal — the same viewer a chat-bubble image uses. Only mounts inside the
 * expanded card, so the image loads on demand, not while the card is collapsed.
 */
const ScreenshotResult: React.FC<{
  shot: NonNullable<ParsedToolResult["screenshot"]>;
}> = ({ shot }) => {
  const [open, setOpen] = useState(false);
  // Prefer the on-disk file (small, asset-protocol). If it 404s — pruned after
  // an hour, or a reloaded thread whose file is gone — fall back to the base64
  // embedded in the result so the image still renders. Never a dumped blob.
  const [fileBroken, setFileBroken] = useState(false);
  const fileSrc =
    shot.path && !fileBroken ? (isTauri() ? convertFileSrc(shot.path) : shot.path) : null;
  const dataSrc = shot.base64 ? `data:image/png;base64,${shot.base64}` : null;
  const src = fileSrc ?? dataSrc;
  if (!src) {
    // Neither a path nor base64 — the header summary already notes the capture.
    return null;
  }
  const ratio = shot.width && shot.height ? `${shot.width} / ${shot.height}` : undefined;
  return (
    <div className="agw-tool-shot">
      <button
        type="button"
        className="agw-tool-shot-btn"
        title="Open screenshot"
        onClick={() => setOpen(true)}
      >
        <img
          src={src}
          alt={shot.url ? `Screenshot of ${shot.url}` : "Screenshot"}
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
      <AgentImageModal open={open} mode="preview" src={open ? src : null} onClose={() => setOpen(false)} />
    </div>
  );
};

export const ToolResultView: React.FC<{
  parsed: ParsedToolResult;
  activeMultiFileIndex?: number;
}> = ({ parsed, activeMultiFileIndex = 0 }) => {
  if (parsed.screenshot) return <ScreenshotResult shot={parsed.screenshot} />;
  if (parsed.tree) return <WorkspaceTreeView data={parsed.tree} />;
  if (parsed.multiFile && parsed.multiFile.length > 0)
    return <MultiFileResultsView files={parsed.multiFile} activeIndex={activeMultiFileIndex} />;
  if (parsed.grep && parsed.grep.matches.length > 0)
    return <GrepResultsView data={parsed.grep} />;
  // Not gated on a non-empty list: "nothing matched" is a real answer for a
  // name search, and its own view says so plus how to widen the pattern. The
  // fallback would otherwise dump the raw JSON.
  if (parsed.glob) return <GlobResultsView data={parsed.glob} />;
  if (parsed.shell && parsed.shell.output) return <ShellOutputView data={parsed.shell} />;
  if (parsed.fileList && parsed.fileList.length > 0)
    return <FileListView files={parsed.fileList} />;

  if (parsed.diffs && parsed.diffs.length > 0) {
    const selectedIndex = Math.min(Math.max(activeMultiFileIndex, 0), parsed.diffs.length - 1);
    const diff = parsed.diffs[selectedIndex];
    const path = diff.fullPath ?? diff.path ?? `file ${selectedIndex + 1}`;
    return (
      <div className="agw-rv">
        <div className="agw-rv-head">
          <FileIcon name={baseName(path)} path={path} className="agw-file-ico" />
          <span className="agw-rv-title-file">{baseName(path)}</span>
          <span className="agw-rv-stats">
            <span>{selectedIndex + 1} / {parsed.diffs.length}</span>
          </span>
        </div>
        <div className="agw-multi-read">
          <DiffView oldText={diff.oldText} newText={diff.newText} maxHeight={300} />
        </div>
        {diff.truncated && (
          <div className="agw-rv-trunc-note" role="note">
            Showing the beginning — the full change was too large to keep in
            this conversation. The line counts above are complete.
          </div>
        )}
      </div>
    );
  }

  // Real line diff (full before/after) — preferred over the args-only hunk.
  if (parsed.diff) {
    return (
      <>
        <DiffView oldText={parsed.diff.oldText} newText={parsed.diff.newText} maxHeight={300} />
        {parsed.diff.truncated && (
          <div className="agw-rv-trunc-note" role="note">
            Showing the beginning — the full change was too large to keep in
            this conversation.
          </div>
        )}
      </>
    );
  }

  if (parsed.edit && (parsed.edit.removed || parsed.edit.added)) {
    return (
      <>
        {parsed.edit.removed && (
          <pre className="agw-code agw-scroll agw-diff agw-diff-removed">{parsed.edit.removed}</pre>
        )}
        {parsed.edit.added && (
          <pre className="agw-code agw-scroll agw-diff agw-diff-added">{parsed.edit.added}</pre>
        )}
      </>
    );
  }

  if (parsed.code) {
    return <ToolCode code={parsed.code} path={parsed.codePath} />;
  }

  return null;
};
