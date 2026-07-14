/**
 * Agent Window — Review panel [view].
 *
 * The right dock's diff surface. Aggregates every file the agent changed in the
 * open conversation into a stats-first list (Codex §6.1: "Edited N files · +x/−y"
 * + per-file rows), each expandable into a real line diff (`DiffView`). Clicking
 * a changed file in a tool card focuses it here (expand + scroll) via
 * `useAgentReviewStore`. Themed entirely with `--agw-*`.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";

import { AgentIcon } from "../shared/AgentIcon";
import { FileIcon } from "../../components/explorer/FileIcons";
import { openInIde } from "../adapters/open-in-ide";
import { collectFileChanges, type FileChange, type ReviewScope } from "./review";
import { DiffView } from "./tool-views/DiffView";
import type { DiffMode } from "./tool-views/DiffView";
import { useAgentChatStore } from "../store/useAgentChatStore";
import { useAgentReviewStore } from "../store/useAgentReviewStore";
import { useAgentWorkspaceStore } from "../store/useAgentWorkspaceStore";

const FileRow: React.FC<{
  change: FileChange;
  open: boolean;
  mode: DiffMode;
  onToggle: () => void;
  rowRef: (el: HTMLDivElement | null) => void;
}> = ({ change, open, mode, onToggle, rowRef }) => {
  const dir = change.path.slice(0, change.path.length - change.fileName.length);
  const target = change.fullPath || change.path;
  return (
    <div ref={rowRef} className="agw-rv-file">
      <div className="agw-rv-file-head">
        <button
          type="button"
          className="agw-rv-file-toggle"
          aria-expanded={open}
          onClick={onToggle}
        >
          <span
            style={{
              display: "inline-flex",
              transform: open ? "none" : "rotate(-90deg)",
              transition: "transform 0.15s ease",
              color: "var(--agw-text-subtle)",
            }}
          >
            <AgentIcon name="chevron-down" size={13} />
          </span>
          <FileIcon name={change.fileName} path={change.fullPath || change.path} className="agw-file-ico" />
          <span className="agw-rv-file-path">
            {dir && <span className="agw-rv-file-dir">{dir}</span>}
            <span className="agw-rv-file-name">{change.fileName}</span>
          </span>
        </button>
        <span className="agw-rv-file-stats">
          {change.added > 0 && <span style={{ color: "var(--agw-added)" }}>+{change.added}</span>}
          {change.removed > 0 && <span style={{ color: "var(--agw-removed)" }}>−{change.removed}</span>}
        </span>
        {/* View-only here — editing happens in the IDE. */}
        <button
          type="button"
          className="agw-rv-openide"
          title="Open in IDE editor"
          aria-label={`Open ${change.fileName} in the IDE editor`}
          onClick={() => void openInIde(target)}
        >
          <AgentIcon name="external" size={13} />
        </button>
      </div>
      {open && (
        <div style={{ padding: "0 10px 10px" }}>
          <DiffView oldText={change.oldText} newText={change.newText} mode={mode} maxHeight={9000} />
        </div>
      )}
    </div>
  );
};

export const ReviewPanel: React.FC = () => {
  const currentThread = useAgentChatStore((s) => s.currentThread);
  const messages = useMemo(() => currentThread?.messages ?? [], [currentThread]);
  const [scope, setScope] = useState<ReviewScope>("all");
  const allChanges = useMemo(() => collectFileChanges(messages, "all"), [messages]);
  const changes = useMemo(
    () => (scope === "all" ? allChanges : collectFileChanges(messages, "lastTurn")),
    [scope, allChanges, messages],
  );

  const selectedPath = useAgentReviewStore((s) => s.selectedPath);
  const diffMode = useAgentWorkspaceStore((s) => s.diffMode);
  const setDiffMode = useAgentWorkspaceStore((s) => s.setDiffMode);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Expanded by default for a small change set; collapsed when there are many.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current || changes.length === 0) return;
    initRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time initial expansion
    if (changes.length <= 3) setExpanded(new Set(changes.map((c) => c.path)));
  }, [changes]);

  // A click on a file in the transcript focuses it: expand + scroll into view.
  useEffect(() => {
    if (!selectedPath) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- expand the file the user selected
    setExpanded((prev) => (prev.has(selectedPath) ? prev : new Set(prev).add(selectedPath)));
    // Defer so the row is expanded before we scroll to it.
    const id = window.setTimeout(() => {
      rowRefs.current.get(selectedPath)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 40);
    return () => window.clearTimeout(id);
  }, [selectedPath]);

  const totals = useMemo(
    () =>
      changes.reduce(
        (acc, c) => ({ added: acc.added + c.added, removed: acc.removed + c.removed }),
        { added: 0, removed: 0 },
      ),
    [changes],
  );

  if (allChanges.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          padding: 24,
          textAlign: "center",
        }}
      >
        <AgentIcon name="diff" size={22} style={{ color: "var(--agw-text-subtle)" }} />
        <div style={{ fontSize: 13, color: "var(--agw-text-muted)", fontWeight: 600 }}>
          No file changes yet
        </div>
        <div style={{ fontSize: 12, color: "var(--agw-text-subtle)", maxWidth: 240 }}>
          When the agent edits files in this chat, the diffs show up here for review.
        </div>
      </div>
    );
  }

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const allOpen = expanded.size >= changes.length;
  const toggleAll = () =>
    setExpanded(allOpen ? new Set() : new Set(changes.map((c) => c.path)));

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {/* Summary toolbar */}
      <div className="agw-rv-summary">
        {/* Scope: every change in the chat, or just the latest agent turn. */}
        <button
          type="button"
          className="agw-rv-tool"
          onClick={() => setScope(scope === "all" ? "lastTurn" : "all")}
          title="Change which edits are shown"
        >
          {scope === "all" ? "All changes" : "Last turn"}
        </button>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--agw-text)" }}>
          {changes.length} file{changes.length === 1 ? "" : "s"}
        </span>
        {totals.added > 0 && (
          <span style={{ color: "var(--agw-added)", fontSize: 11, fontFamily: "var(--agw-font-code)" }}>
            +{totals.added}
          </span>
        )}
        {totals.removed > 0 && (
          <span style={{ color: "var(--agw-removed)", fontSize: 11, fontFamily: "var(--agw-font-code)" }}>
            −{totals.removed}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="agw-rv-tool"
          onClick={toggleAll}
          title={allOpen ? "Collapse all diffs" : "Expand all diffs"}
        >
          {allOpen ? "Collapse all" : "Expand all"}
        </button>
        {/* Split (side-by-side) ⇄ unified — Codex defaults to split. */}
        <div className="agw-rv-segment" role="group" aria-label="Diff layout">
          <button
            type="button"
            className="agw-rv-seg"
            data-active={diffMode === "split" || undefined}
            onClick={() => setDiffMode("split")}
            title="Side-by-side diff"
            aria-pressed={diffMode === "split"}
          >
            <AgentIcon name="columns" size={13} />
          </button>
          <button
            type="button"
            className="agw-rv-seg"
            data-active={diffMode === "unified" || undefined}
            onClick={() => setDiffMode("unified")}
            title="Unified diff"
            aria-pressed={diffMode === "unified"}
          >
            <AgentIcon name="rows" size={13} />
          </button>
        </div>
      </div>

      {/* Per-file diffs */}
      <div className="agw-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {changes.length === 0 && (
          <div
            style={{
              padding: "18px 14px",
              fontSize: 12,
              color: "var(--agw-text-subtle)",
              textAlign: "center",
            }}
          >
            No edits in the last turn.{" "}
            <button
              type="button"
              className="agw-rv-link"
              onClick={() => setScope("all")}
            >
              Show all changes
            </button>
          </div>
        )}
        {changes.map((change) => (
          <FileRow
            key={change.path}
            change={change}
            open={expanded.has(change.path)}
            mode={diffMode}
            onToggle={() => toggle(change.path)}
            rowRef={(el) => {
              if (el) rowRefs.current.set(change.path, el);
              else rowRefs.current.delete(change.path);
            }}
          />
        ))}
      </div>
    </div>
  );
};
