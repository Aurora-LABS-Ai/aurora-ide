/**
 * Agent Window — tool result router [view].
 *
 * Given a `ParsedToolResult`, renders the single richest applicable view:
 * tree / multi-file / grep / shell / file list / edit diff / cleaned code. This
 * is the agent window's analogue of the IDE's per-tool view routing in
 * `ToolItem`, kept isolated (own `--agw-*` chrome, own icons).
 */

import React from "react";

import { FileIcon } from "@/kernel/ui/FileIcons";
import { DiffView } from "@/apps/agent/components/tool-views/DiffView";
import { GlobResultsView } from "@/apps/agent/components/tool-views/GlobResultsView";
import { GrepResultsView } from "@/apps/agent/components/tool-views/GrepResultsView";
import { ImageResult } from "@/apps/agent/components/tool-views/ImageResult";
import { MultiFileResultsView } from "@/apps/agent/components/tool-views/MultiFileResultsView";
import { ShellOutputView } from "@/apps/agent/components/tool-views/ShellOutputView";
import { FileListView } from "@/apps/agent/components/tool-views/FileListView";
import { WebResultsView } from "@/apps/agent/components/tool-views/WebResultsView";
import { WorkspaceTreeView } from "@/apps/agent/components/tool-views/WorkspaceTreeView";
import { baseName, type ParsedToolResult } from "@/apps/agent/components/tool-views/tool-result";
import { ToolCode } from "@/apps/agent/components/tool-views/ToolCode";

export const ToolResultView: React.FC<{
  parsed: ParsedToolResult;
  activeMultiFileIndex?: number;
}> = ({ parsed, activeMultiFileIndex = 0 }) => {
  // A result that is one picture. Several pictures ride on `multiFile` below,
  // where they share the file chips with the text files read beside them.
  if (parsed.image) return <ImageResult image={parsed.image} />;
  // Not gated on a non-empty hit list: "nothing came back" is a real answer to
  // a search, and its own panel says so. The fallback would dump raw JSON.
  if (parsed.web) return <WebResultsView data={parsed.web} />;
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
          <DiffView oldText={diff.oldText} newText={diff.newText} maxHeight={300} path={path} />
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
        <DiffView
          oldText={parsed.diff.oldText}
          newText={parsed.diff.newText}
          maxHeight={300}
          path={parsed.diff.fullPath ?? parsed.diff.path ?? null}
        />
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
