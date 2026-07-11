/**
 * Agent Window — tool result router [view].
 *
 * Given a `ParsedToolResult`, renders the single richest applicable view:
 * tree / multi-file / grep / shell / file list / edit diff / cleaned code. This
 * is the agent window's analogue of the IDE's per-tool view routing in
 * `ToolItem`, kept isolated (own `--agw-*` chrome, own icons).
 */

import React, { useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { isTauri } from "../../../lib/tauri";
import { AgentImageModal } from "../AgentImageModal";
import { DiffView } from "./DiffView";
import { GrepResultsView } from "./GrepResultsView";
import { MultiFileResultsView } from "./MultiFileResultsView";
import { ShellOutputView } from "./ShellOutputView";
import { FileListView } from "./FileListView";
import { WorkspaceTreeView } from "./WorkspaceTreeView";
import { baseName, type ParsedToolResult } from "./tool-result";
import {
  extToShikiLang,
  useShikiTokens,
  type ShikiThemeVariant,
} from "../../../components/chat/useShikiTokens";
import { selectActiveAgentTheme, useAgentThemeStore } from "../../store/useAgentThemeStore";

/** Lowercased extension (no dot) of a path, or "" when none. */
function extOf(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * Tool-card file body. Syntax-highlights via the shared Shiki tokenizer when the
 * language is known AND the user has highlighting on; otherwise renders plain
 * text (same flat look as before). The language is derived from the file path
 * the parser carried through (`codePath`).
 */
const ToolCode: React.FC<{ code: string; path: string | null }> = ({ code, path }) => {
  const appearance = useAgentThemeStore((s) => selectActiveAgentTheme(s).appearance);
  const syntaxOn = useAgentThemeStore((s) => s.syntaxHighlighting);
  const variant: ShikiThemeVariant = appearance === "light" ? "light" : "dark";
  const lang = useMemo(
    () => (syntaxOn && path ? extToShikiLang(extOf(path)) : null),
    [syntaxOn, path],
  );
  const tokens = useShikiTokens(code, lang, variant);

  if (!tokens) {
    return <pre className="agw-code agw-scroll agw-tool-result">{code}</pre>;
  }
  return (
    <pre className="agw-code agw-scroll agw-tool-result">
      <code>
        {tokens.map((line, i) => (
          <span key={i} className="agw-code-line">
            {line.length === 0 ? (
              "\n"
            ) : (
              <>
                {line.map((tok, j) => (
                  <span key={j} style={{ color: tok.color }}>
                    {tok.content}
                  </span>
                ))}
                {"\n"}
              </>
            )}
          </span>
        ))}
      </code>
    </pre>
  );
};

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

export const ToolResultView: React.FC<{ parsed: ParsedToolResult }> = ({ parsed }) => {
  if (parsed.screenshot) return <ScreenshotResult shot={parsed.screenshot} />;
  if (parsed.tree) return <WorkspaceTreeView data={parsed.tree} />;
  if (parsed.multiFile && parsed.multiFile.length > 0)
    return <MultiFileResultsView files={parsed.multiFile} />;
  if (parsed.grep && parsed.grep.matches.length > 0)
    return <GrepResultsView data={parsed.grep} />;
  if (parsed.shell && parsed.shell.output) return <ShellOutputView data={parsed.shell} />;
  if (parsed.fileList && parsed.fileList.length > 0)
    return <FileListView files={parsed.fileList} />;

  // Multi-file edit — one labelled diff per file the single call touched.
  if (parsed.diffs && parsed.diffs.length > 0) {
    return (
      <div className="agw-multi-diff">
        {parsed.diffs.map((d, i) => (
          <div className="agw-multi-diff-file" key={d.path ?? d.fullPath ?? i}>
            <div className="agw-multi-diff-head" title={d.path ?? d.fullPath}>
              {baseName(d.path ?? d.fullPath ?? `file ${i + 1}`)}
            </div>
            <DiffView oldText={d.oldText} newText={d.newText} maxHeight={240} />
          </div>
        ))}
      </div>
    );
  }

  // Real line diff (full before/after) — preferred over the args-only hunk.
  if (parsed.diff) {
    return <DiffView oldText={parsed.diff.oldText} newText={parsed.diff.newText} maxHeight={300} />;
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
