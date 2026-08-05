/**
 * Agent Window — tool-call card [view].
 *
 * One assistant tool invocation, modelled on the IDE chat's `ToolItem` but
 * deliberately LIGHTER — no boxed wrapper. It's an inline row:
 *
 *   ● Read File  src/foo.ts   Read 142 lines              ▸   ← dot · name · chip · summary
 *     └ (expand) rich result view (tree / grep / shell / diff / code)
 *
 * The result is routed through the isolated parser + `ToolResultView` so a
 * `workspace_tree` renders as a real tree, `multi_file_read` as a file list, etc.
 * — never a raw JSON dump. Everything uses `AgentIcon` (no lucide) and `--agw-*`
 * tokens (no `--aurora-*`); status is inferred (no discrete status field on the
 * persisted call): no result + streaming = running; no result + idle = failed; an
 * `[error]`/`[rejected]` sentinel = failed; anything else = done.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";

import { getProfessionalToolName } from "../../services/tool-display";
import { FileIcon, FolderIcon } from "../../components/explorer/FileIcons";
import { AgentIcon, type AgentIconName } from "../shared/AgentIcon";
import { useAgentArtifactStore } from "../store/useAgentArtifactStore";
import { useAgentChatStore } from "../store/useAgentChatStore";
import { useAgentWorkspaceStore } from "../store/useAgentWorkspaceStore";
import { describeToolActivity, type AgentActivityTarget } from "./activity";
import {
  formatToolDuration,
  toolStatus,
  type ToolCall,
  type ToolStatus,
} from "./tool-call";
import { parseToolResult } from "./tool-views/tool-result";
import { ShellStreamView } from "./tool-views/ShellStreamView";
import { ToolResultView } from "./tool-views/ToolResultView";
import { useShellStream } from "../hooks/useShellStream";
import { useConversationScope } from "../lib/conversation-scope";

/** A header chip: an activity target plus optional per-file diff counts. */
type ChipTarget = AgentActivityTarget & { added?: number; removed?: number };

/** Max file chips shown inline before the strip collapses into a "+N" menu. */
const CHIP_OVERFLOW_VISIBLE = 6;

const FILE_MODIFY_TOOLS = new Set([
  // Current.
  "file_write",
  "file_edit",
  // Legacy (historic threads).
  "file_create",
  "file_patch",
  "search_replace",
  "multi_search_replace",
]);

const FOLDER_TOOLS = new Set([
  "workspace_tree",
  "folder_create",
  "move_path",
  "delete_path",
  // Legacy.
  "folder_move",
  "folder_delete",
]);

/** Args we render specially / that are too noisy for the chip row. */
const HIDDEN_ARG_KEYS = new Set([
  "content",
  "path",
  "file_path",
  "filePath",
  "raw",
  "new_string",
  "newString",
  "old_string",
  "oldString",
  "newContent",
  "todos",
  "edits",
  "replacements",
  "target_paths",
]);

const SHELL_ARG_KEYS = new Set([
  "command",
  "cwd",
  "timeout",
  "timeout_ms",
  "shell",
  "type",
]);

function isShellTool(name: string): boolean {
  return name === "shell_execute" || name === "shell_spawn";
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * Pull a string field out of a PARTIAL (still-streaming) tool-arguments JSON
 * blob — `JSON.parse` can't, because the JSON isn't closed yet. Reads the value
 * of `"key": "..."` char by char, unescaping, until the closing quote OR the end
 * of the truncated buffer. This is what lets the card show a file being written
 * live, before the tool actually runs.
 */
function partialString(raw: string, key: string): string | null {
  const at = raw.indexOf(`"${key}"`);
  if (at < 0) return null;
  const colon = raw.indexOf(":", at + key.length + 2);
  if (colon < 0) return null;
  const open = raw.indexOf('"', colon + 1);
  if (open < 0) return null;
  let out = "";
  for (let i = open + 1; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\") {
      const n = raw[i + 1];
      out += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "" : (n ?? "");
      i++;
      continue;
    }
    if (c === '"') break;
    out += c;
  }
  return out;
}

/** The streaming-content arg key per modify tool (single-edit shapes only). */
function streamKeyFor(name: string): string | null {
  if (name === "file_create" || name === "file_write") return "content";
  if (name === "file_edit" || name === "search_replace" || name === "file_patch")
    return "new_string";
  return null;
}

/** Leading glyph per tool family (AgentIcon — never lucide). */
function toolIcon(name: string): AgentIconName {
  const lower = name.toLowerCase();
  if (lower.startsWith("mcp_")) return "mcp";
  if (lower === "browser_click") return "browser-click";
  if (lower === "browser_fill") return "browser-fill";
  if (lower === "browser_scroll") return "browser-scroll";
  if (lower === "browser_screenshot") return "browser-screenshot";
  if (lower === "browser_get_console_logs") return "terminal";
  if (lower.startsWith("browser_")) return "browser";
  // Dedicated per-action file glyphs (read / write / edit / move / delete),
  // each distinct so a glance at the card header tells you what happened.
  if (lower === "file_read" || lower === "multi_file_read") return "file-read";
  if (lower === "file_write" || lower === "file_create") return "file-write";
  if (
    lower === "file_edit" ||
    lower === "file_patch" ||
    lower === "search_replace" ||
    lower === "multi_search_replace"
  )
    return "file-edit";
  if (lower === "move_path" || lower === "folder_move") return "file-move";
  if (lower === "delete_path" || lower === "file_delete" || lower === "folder_delete")
    return "file-delete";
  if (lower === "editor_open_file") return "files";
  if (lower === "grep") return "search";
  // `glob` finds files, so it takes the file icon rather than grep's
  // magnifier — the icon is the fastest way to tell the two searches apart.
  if (lower === "glob") return "files";
  if (lower === "workspace_tree") return "workspace-tree";
  if (lower === "folder_create") return "files";
  if (lower === "shell_execute" || lower === "shell_spawn") return "terminal";
  if (lower === "shell_kill") return "process-stop";
  if (lower === "shell_list_processes") return "process-list";
  if (lower === "read_lints") return "diagnostics";
  if (lower === "todo") return "checklist";
  if (lower === "auroro_websearch" || lower === "auroro_web_search") return "search";
  if (lower === "ask_question") return "help";
  if (FILE_MODIFY_TOOLS.has(lower)) return "file-edit";
  return "diff";
}

function pathOf(args: Record<string, unknown>): string {
  return (
    (args.path as string) ||
    (args.file_path as string) ||
    (args.filePath as string) ||
    (args.target as string) ||
    ""
  );
}

const DOT_ICON: Record<ToolStatus, AgentIconName | null> = {
  running: null,
  done: "check",
  failed: "close",
};

const CanvasLaunchCard: React.FC<{
  call: ToolCall;
  isActivelyStreaming: boolean;
}> = ({ call, isActivelyStreaming }) => {
  const status = toolStatus(call, isActivelyStreaming);
  let args: Record<string, unknown> = {};
  let result: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
  } catch {
    args = {};
  }
  try {
    result = JSON.parse(call.result || "{}") as Record<string, unknown>;
  } catch {
    result = {};
  }

  const artifactId =
    (typeof args.artifactId === "string" && args.artifactId) ||
    partialString(call.arguments, "artifactId") ||
    "";
  const artifactTitle =
    (typeof args.title === "string" && args.title) ||
    partialString(call.arguments, "title") ||
    "Canvas artifact";
  const versionTag = typeof result.versionTag === "string" ? result.versionTag : "";
  const canOpen = status === "done" && artifactId.length > 0;
  // Artifacts are stored per conversation, so this has to open the artifact of
  // the chat the card is IN — which is not the open chat when the card is being
  // rendered by a conversation docked in the side panel.
  const scope = useConversationScope();

  const openCanvas = () => {
    if (!canOpen) return;
    const threadId =
      scope?.threadId ?? useAgentChatStore.getState().currentThreadId;
    if (!threadId) return;
    useAgentWorkspaceStore.getState().openTab("canvas");
    // Claim the canvas for artifacts up front — `select` also does this on
    // success, but an old card with no version tag (or a failed select) must
    // still land the user on the artifact view they asked for, not on a plan
    // covering it.
    useAgentArtifactStore.getState().setCanvasSource("artifact");
    if (versionTag) {
      void useAgentArtifactStore
        .getState()
        .select(threadId, artifactId, versionTag)
        .catch(() => undefined);
    }
  };

  return (
    <button
      type="button"
      className="agw-canvas-launch"
      data-status={status}
      disabled={!canOpen}
      aria-label={canOpen ? `Open ${artifactTitle}${versionTag ? ` ${versionTag}` : ""} in Canvas` : undefined}
      onClick={openCanvas}
    >
      <span className="agw-canvas-launch-status">
        {status === "running" ? (
          <span className="agw-spinner" aria-hidden />
        ) : (
          <AgentIcon
            name={status === "done" ? "check" : "close"}
            size={13}
            strokeWidth={2.6}
          />
        )}
      </span>
      <span className="agw-canvas-launch-glyph">
        <AgentIcon name="panel-right" size={16} />
      </span>
      <span className="agw-canvas-launch-copy">
        <span className="agw-canvas-launch-kicker">
          {status === "running"
            ? "Creating on Canvas"
            : status === "failed"
              ? "Canvas creation failed"
              : "Open in Canvas"}
        </span>
        <span className="agw-canvas-launch-title">{artifactTitle}</span>
      </span>
      {versionTag && <span className="agw-canvas-launch-version">{versionTag}</span>}
      {canOpen && <AgentIcon name="external" size={14} className="agw-canvas-launch-open" />}
    </button>
  );
};

/**
 * "+N" chip at the end of an overflowing file strip. Opens a portaled list of
 * the files that did NOT fit inline (the visible chips already name the rest —
 * repeating them here would just be noise). Picking one swaps it into the
 * inline strip. Lives inside the card header <button>, so it's a role="button"
 * span — the menu itself portals to the window root where real <button> rows
 * are legal.
 */
const ChipOverflowMenu: React.FC<{
  items: Array<{ target: ChipTarget; index: number }>;
  onSelect: (event: React.SyntheticEvent, index: number) => void;
}> = ({ items, onSelect }) => {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ left: number; top: number } | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    // The card lives inside the transcript scroller — a fixed-position menu
    // can't follow it, so any outside scroll just closes the menu.
    const onScroll = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const toggle = (event: React.SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (open) {
      setOpen(false);
      return;
    }
    const anchor = triggerRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const width = 280;
    const margin = 12;
    setPortalTarget(
      (triggerRef.current?.closest(".agw-root") as HTMLElement) ?? document.body,
    );
    setRect({
      left: Math.min(
        Math.max(margin, anchor.left),
        Math.max(margin, window.innerWidth - width - margin),
      ),
      top: anchor.bottom + 6,
    });
    setOpen(true);
  };

  return (
    <>
      <span
        ref={triggerRef}
        role="button"
        tabIndex={0}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="agw-tool-chip agw-tool-chip-btn agw-tool-chip-more"
        title={`Show ${items.length} more ${items.length === 1 ? "file" : "files"}`}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") toggle(event);
        }}
      >
        +{items.length}
      </span>
      {open &&
        rect &&
        portalTarget &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-label="More files in this tool result"
            className="agw-menu agw-chip-overflow agw-scroll"
            style={{
              position: "fixed",
              left: rect.left,
              top: rect.top,
              width: 280,
              maxHeight: 300,
              overflowY: "auto",
              zIndex: 1000,
            }}
          >
            {items.map(({ target, index }) => (
              <button
                key={`${target.path}:${index}`}
                type="button"
                role="option"
                aria-selected={false}
                className="agw-chip-overflow-item"
                title={target.path}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect(event, index);
                  setOpen(false);
                }}
              >
                {target.kind === "folder" ? (
                  <FolderIcon name={target.name} className="agw-file-ico" />
                ) : (
                  <FileIcon name={target.name} path={target.path} className="agw-file-ico" />
                )}
                <span className="agw-chip-overflow-name">{target.name}</span>
                {(target.added || target.removed) && (
                  <span className="agw-chip-stat">
                    {target.removed ? (
                      <span className="agw-chip-stat-del">−{target.removed}</span>
                    ) : null}
                    {target.added ? (
                      <span className="agw-chip-stat-add">+{target.added}</span>
                    ) : null}
                  </span>
                )}
              </button>
            ))}
          </div>,
          portalTarget,
        )}
    </>
  );
};

const StandardToolCallCard: React.FC<{
  call: ToolCall;
  isActivelyStreaming?: boolean;
}> = ({ call, isActivelyStreaming = false }) => {
  // Derived open state (no setState-in-effect): failed tools default OPEN so the
  // reason is visible; a user toggle overrides that default for this card.
  const [override, setOverride] = useState<boolean | null>(null);
  const [activeFileIndex, setActiveFileIndex] = useState(0);
  const targetStripRef = useRef<HTMLSpanElement>(null);
  const targetDragRef = useRef({
    pointerId: -1,
    startX: 0,
    startScrollLeft: 0,
    moved: false,
  });

  const parsedArgs = useMemo<Record<string, unknown>>(() => {
    try {
      const v = JSON.parse(call.arguments || "{}");
      return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }, [call.arguments]);

  const status = toolStatus(call, isActivelyStreaming);
  const title = getProfessionalToolName(call.name);
  const icon = toolIcon(call.name);
  const activity = useMemo(
    () => describeToolActivity(call.name, call.arguments),
    [call.name, call.arguments],
  );
  const parsed = useMemo(
    () => parseToolResult(call.name, parsedArgs, call.result),
    [call.name, parsedArgs, call.result],
  );

  const path = activity.path || pathOf(parsedArgs);
  const fileName = activity.name || (path ? basename(path) : "");
  const isFolder =
    activity.kind === "folder" || (!activity.kind && FOLDER_TOOLS.has(call.name));
  const narratedTargets: AgentActivityTarget[] =
    activity.targets?.length
      ? activity.targets
      : path || isFolder
        ? [
            {
              kind: isFolder ? "folder" : "file",
              name: fileName || "directory",
              path,
            },
          ]
        : [];
  const resultFileTargets: ChipTarget[] = parsed.multiFile?.length
    ? parsed.multiFile.map((file) => ({
        kind: "file" as const,
        name: basename(file.path),
        path: file.fullPath ?? file.path,
      }))
    : parsed.diffs?.length
      ? parsed.diffs.map((diff, index) => {
          const diffPath = diff.fullPath ?? diff.path ?? `file ${index + 1}`;
          return {
            kind: "file" as const,
            name: basename(diffPath),
            path: diffPath,
            added: diff.added,
            removed: diff.removed,
          };
        })
      : [];
  const activityTargets = resultFileTargets.length > 0 ? resultFileTargets : narratedTargets;
  const isSelectableMultiFileResult = resultFileTargets.length > 1;
  const selectedFileIndex = isSelectableMultiFileResult
    ? Math.min(activeFileIndex, activityTargets.length - 1)
    : 0;
  const showEveryTarget =
    isSelectableMultiFileResult ||
    (activityTargets.length > 1 &&
      (call.name === "file_edit" ||
        call.name === "file_patch" ||
        call.name === "search_replace" ||
        call.name === "multi_search_replace" ||
        call.name === "file_read" ||
        call.name === "multi_file_read"));
  const chipTargets: ChipTarget[] = showEveryTarget
    ? activityTargets
    : activityTargets.slice(0, 1).map((target) => ({
        ...target,
        name: activity.name || target.name,
      }));
  // Long batches collapse to the first chips + a "+N" menu instead of an
  // endless drag strip. The selected file always stays visible (it swaps into
  // the last inline slot when it lives past the cutoff).
  const chipOverflow =
    isSelectableMultiFileResult && chipTargets.length > CHIP_OVERFLOW_VISIBLE;
  const visibleChips: Array<{ target: ChipTarget; index: number }> = chipOverflow
    ? chipTargets.slice(0, CHIP_OVERFLOW_VISIBLE).map((target, index) => ({ target, index }))
    : chipTargets.map((target, index) => ({ target, index }));
  if (chipOverflow && !visibleChips.some((chip) => chip.index === selectedFileIndex)) {
    visibleChips[CHIP_OVERFLOW_VISIBLE - 1] = {
      target: chipTargets[selectedFileIndex],
      index: selectedFileIndex,
    };
  }
  const hiddenChips: Array<{ target: ChipTarget; index: number }> = chipOverflow
    ? chipTargets
        .map((target, index) => ({ target, index }))
        .filter(({ index }) => !visibleChips.some((chip) => chip.index === index))
    : [];

  /**
   * Vertical wheel scrolls the chip strip sideways — bound natively because
   * React delegates `wheel` at the root with `{ passive: true }`, which
   * discards `preventDefault()` (and warns). Without it the transcript scrolls
   * at the same time as the strip, so the card walks away mid-gesture.
   */
  useEffect(() => {
    const strip = targetStripRef.current;
    if (!strip) return;
    const onWheel = (event: WheelEvent) => {
      if (strip.scrollWidth <= strip.clientWidth) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      strip.scrollLeft += event.deltaY;
    };
    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => strip.removeEventListener("wheel", onWheel);
  }, [chipTargets.length]);

  // Live content preview: the file being written, pulled from the partial args.
  const streamingPreview = useMemo(() => {
    if (status !== "running") return null;
    const key = streamKeyFor(call.name);
    if (!key) return null;
    const text = partialString(call.arguments, key);
    return text && text.length > 0 ? text : null;
  }, [status, call.name, call.arguments]);

  const previewRef = React.useRef<HTMLPreElement>(null);
  React.useEffect(() => {
    // Follow the newest written lines as they stream in.
    if (previewRef.current) previewRef.current.scrollTop = previewRef.current.scrollHeight;
  }, [streamingPreview]);

  // Live terminal output, streamed from Rust on the tool call's own channel.
  // Subscribing from the card (which mounts when the call appears, before
  // execution begins) means the listener is in place before the first byte.
  const liveShellOutput = useShellStream(call.id, isShellTool(call.name) && status === "running");
  const liveShellCommand =
    typeof parsedArgs.command === "string" ? parsedArgs.command : undefined;
  const liveShellCwd = typeof parsedArgs.cwd === "string" ? parsedArgs.cwd : undefined;
  const showLiveShell = isShellTool(call.name) && status === "running";

  const argChips = useMemo(
    () =>
      Object.entries(parsedArgs).filter(
        ([k]) => !HIDDEN_ARG_KEYS.has(k) && !(isShellTool(call.name) && SHELL_ARG_KEYS.has(k)),
      ),
    [parsedArgs, call.name],
  );

  const summary = useMemo(() => {
    if (status !== "done") return ""; // running and failure detail live in the dropdown
    return parsed.summary || "";
  }, [status, parsed.summary]);

  const hasResult = Boolean(
    parsed.tree ||
      parsed.multiFile?.length ||
      parsed.grep?.matches.length ||
      // Not `.files.length`: a glob that matched nothing still has a result
      // worth expanding — it says so, and says how to widen the pattern.
      parsed.glob ||
      (parsed.shell && parsed.shell.output) ||
      parsed.fileList?.length ||
      parsed.diff ||
      parsed.diffs?.length ||
      parsed.edit?.removed ||
      parsed.edit?.added ||
      parsed.code ||
      parsed.screenshot?.path ||
      parsed.screenshot?.base64,
  );
  const hasDetail = hasResult || argChips.length > 0 || !!streamingPreview || showLiveShell;
  // Collapsed by DEFAULT — including while a tool is running. A running/settled
  // card is a quiet one-line row; the user clicks it open to inspect args, the
  // live write stream, or the result. A failure that happens LIVE (this turn is
  // still streaming) defaults open so its error is visible without a click —
  // but a failed card loaded from history (or once the turn ends) collapses back
  // like everything else, so old failures don't stay stuck open. `override` wins.
  // A running shell command does NOT auto-open: live output is there for
  // whoever opens the card, but a command starting must never expand the
  // transcript on its own. Only a live failure does, as before.
  const defaultOpen = status === "failed" && isActivelyStreaming;
  const open = (override ?? defaultOpen) && hasDetail;
  const toggle = () => setOverride(!(override ?? defaultOpen));
  const selectFileTarget = (event: React.SyntheticEvent, index: number) => {
    if (targetDragRef.current.moved) {
      event.preventDefault();
      event.stopPropagation();
      targetDragRef.current.moved = false;
      return;
    }
    event.stopPropagation();
    setActiveFileIndex(index);
    if (!open && hasDetail) setOverride(true);
  };
  const onTargetPointerDown = (event: React.PointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0 || event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) {
      return;
    }
    targetDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: event.currentTarget.scrollLeft,
      moved: false,
    };
    // Capture is deferred until real movement: pointer capture retargets the
    // eventual `click` to the strip, which made every chip unclickable
    // whenever the strip overflowed.
  };
  const onTargetPointerMove = (event: React.PointerEvent<HTMLSpanElement>) => {
    const drag = targetDragRef.current;
    if (drag.pointerId !== event.pointerId) return;
    const delta = event.clientX - drag.startX;
    if (!drag.moved && Math.abs(delta) > 3) {
      drag.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.dataset.dragging = "true";
    }
    if (!drag.moved) return;
    event.preventDefault();
    event.currentTarget.scrollLeft = drag.startScrollLeft - delta;
  };
  const finishTargetDrag = (event: React.PointerEvent<HTMLSpanElement>) => {
    if (targetDragRef.current.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.currentTarget.removeAttribute("data-dragging");
    targetDragRef.current.pointerId = -1;
  };
  // WebView2 150.x renderer CHECK (STATUS_BREAKPOINT sad page): a mouse-up
  // while a text selection exists during style/layout churn kills the page —
  // and clicking this header causes exactly that churn (expand animation +
  // highlighter mount). Disarm both halves before the click lands: swallow
  // double/triple-click word selection on the header, and collapse any live
  // transcript selection before layout starts moving.
  const disarmSelectionBeforeClick = (event: React.MouseEvent) => {
    if (event.detail > 1) event.preventDefault();
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) selection.removeAllRanges();
  };

  return (
    // `data-status` on the card itself (not only on the inner dot) so the
    // transcript spine can mark the call that is running right now without
    // reaching into this card's internals.
    <div className="agw-tool-card" data-status={status}>
      <button
        type="button"
        className="agw-tool-head"
        aria-expanded={open}
        onMouseDown={disarmSelectionBeforeClick}
        onClick={() => hasDetail && toggle()}
      >
        <span className={`agw-tool-dot agw-tool-dot-${status}`}>
          {status === "running" ? (
            <span className="agw-spinner" aria-hidden />
          ) : (
            DOT_ICON[status] && <AgentIcon name={DOT_ICON[status]!} size={13} strokeWidth={2.6} />
          )}
        </span>

        <AgentIcon name={icon} size={16} strokeWidth={1.5} />

        <span
          style={{
            color: status === "failed" ? "var(--agw-text-muted)" : "var(--agw-text)",
            fontWeight: "var(--agw-fw-medium)",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </span>

        {chipTargets.length > 0 && (
          <span
            ref={targetStripRef}
            className="agw-tool-targets"
            role={isSelectableMultiFileResult ? "tablist" : undefined}
            aria-label={isSelectableMultiFileResult ? "Files in this tool result" : undefined}
            data-multi={chipTargets.length > 1 ? "true" : undefined}
            onPointerDown={onTargetPointerDown}
            onPointerMove={onTargetPointerMove}
            onPointerUp={finishTargetDrag}
            onPointerCancel={finishTargetDrag}
            onClick={(event) => {
              if (!targetDragRef.current.moved) return;
              event.preventDefault();
              event.stopPropagation();
              targetDragRef.current.moved = false;
            }}
          >
            {visibleChips.map(({ target, index }) => {
              const chipContent = (
                <>
                  {target.kind === "folder" ? (
                    <FolderIcon name={target.name} className="agw-file-ico" />
                  ) : (
                    <FileIcon
                      name={basename(target.path) || target.name}
                      path={target.path}
                      className="agw-file-ico"
                    />
                  )}
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {target.name}
                  </span>
                  {(target.added || target.removed) && (
                    <span className="agw-chip-stat">
                      {target.removed ? (
                        <span className="agw-chip-stat-del">−{target.removed}</span>
                      ) : null}
                      {target.added ? (
                        <span className="agw-chip-stat-add">+{target.added}</span>
                      ) : null}
                    </span>
                  )}
                </>
              );

              return isSelectableMultiFileResult ? (
                <span
                  key={`${target.path}:${index}`}
                  role="tab"
                  tabIndex={selectedFileIndex === index ? 0 : -1}
                  aria-selected={selectedFileIndex === index}
                  className="agw-tool-chip agw-tool-chip-btn"
                  title={target.path}
                  data-index={index}
                  data-selected={selectedFileIndex === index ? "true" : undefined}
                  onClick={(event) => selectFileTarget(event, index)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      selectFileTarget(event, index);
                      return;
                    }
                    const last = activityTargets.length - 1;
                    const next =
                      event.key === "ArrowRight"
                        ? Math.min(index + 1, last)
                        : event.key === "ArrowLeft"
                          ? Math.max(index - 1, 0)
                          : event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? last
                              : null;
                    if (next === null) return;
                    event.preventDefault();
                    selectFileTarget(event, next);
                    // The target chip may only become visible AFTER the swap-in
                    // render (overflowed strips), so focus by index next frame.
                    requestAnimationFrame(() => {
                      targetStripRef.current
                        ?.querySelector<HTMLElement>(`[role="tab"][data-index="${next}"]`)
                        ?.focus();
                    });
                  }}
                >
                  {chipContent}
                </span>
              ) : (
                <span key={`${target.path}:${index}`} className="agw-tool-chip">
                  {chipContent}
                </span>
              );
            })}
            {hiddenChips.length > 0 && (
              <ChipOverflowMenu items={hiddenChips} onSelect={selectFileTarget} />
            )}
          </span>
        )}

        {status === "running" ? (
          <span className="agw-tool-summary agw-shimmer">
            {activity.name ? "Running…" : activity.label}
          </span>
        ) : status === "failed" ? null : parsed.stat &&
          (parsed.stat.added > 0 || parsed.stat.removed > 0) ? (
          <span className="agw-tool-summary" style={{ display: "inline-flex", gap: 8 }}>
            {parsed.stat.removed > 0 && (
              <span style={{ color: "var(--agw-removed)" }}>−{parsed.stat.removed}</span>
            )}
            {parsed.stat.added > 0 && (
              <span style={{ color: "var(--agw-added)" }}>+{parsed.stat.added}</span>
            )}
          </span>
        ) : (
          summary && (
            <span
              className="agw-tool-summary"
              style={{ color: "var(--agw-text-subtle)" }}
            >
              {summary}
            </span>
          )
        )}

        {/* Quiet elapsed time — only once settled, and only when it's long
            enough to mean something (sub-500ms would just be row noise). */}
        {status !== "running" &&
          typeof call.durationMs === "number" &&
          call.durationMs >= 500 && (
            <span className="agw-tool-time">{formatToolDuration(call.durationMs)}</span>
          )}

        <span style={{ flex: 1 }} />

        {hasDetail && (
          <span
            style={{
              color: "var(--agw-text-subtle)",
              display: "inline-flex",
              transform: open ? "rotate(180deg)" : "none",
              transition: "transform 0.15s ease",
            }}
          >
            <AgentIcon name="chevron-down" size={14} />
          </span>
        )}
      </button>

      <AnimatePresence initial={false}>
        {open && hasDetail && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            style={{ overflow: "hidden" }}
          >
            <div className="agw-tool-body">
              {argChips.length > 0 && (
                <div className="agw-tool-args">
                  {argChips.map(([k, v]) => {
                    let val: string;
                    if (v === null || v === undefined) val = "null";
                    else if (typeof v === "object")
                      val = Array.isArray(v) ? `[${v.length} items]` : "{…}";
                    else val = String(v).slice(0, 40);
                    return (
                      <span key={k} className="agw-tool-arg">
                        <span style={{ opacity: 0.6 }}>{k}:</span> {val}
                      </span>
                    );
                  })}
                </div>
              )}

              {showLiveShell ? (
                <ShellStreamView
                  command={liveShellCommand}
                  cwd={liveShellCwd}
                  output={liveShellOutput}
                />
              ) : streamingPreview ? (
                <pre
                  ref={previewRef}
                  className="agw-code agw-scroll agw-diff agw-diff-added agw-tool-stream"
                >
                  {streamingPreview}
                </pre>
              ) : (
                <ToolResultView parsed={parsed} activeMultiFileIndex={selectedFileIndex} />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

/**
 * `plan_write` — the plan is the deliverable of a planning conversation, so its
 * card is a way into the Canvas, not a JSON dump. Mirrors `CanvasLaunchCard`.
 */
const PlanLaunchCard: React.FC<{
  call: ToolCall;
  isActivelyStreaming: boolean;
}> = ({ call, isActivelyStreaming }) => {
  const status = toolStatus(call, isActivelyStreaming);
  let args: Record<string, unknown> = {};
  let result: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
  } catch {
    args = {};
  }
  try {
    result = JSON.parse(call.result || "{}") as Record<string, unknown>;
  } catch {
    result = {};
  }

  const title =
    (typeof args.title === "string" && args.title) ||
    partialString(call.arguments, "title") ||
    "Plan";
  const steps = Array.isArray(result.steps)
    ? result.steps.length
    : Array.isArray(args.steps)
      ? args.steps.length
      : 0;
  const revised = result.revised === true;
  const canOpen = status === "done";

  const openCanvas = () => {
    if (!canOpen) return;
    useAgentWorkspaceStore.getState().openTab("canvas");
  };

  return (
    <button
      type="button"
      className="agw-canvas-launch"
      data-status={status}
      disabled={!canOpen}
      aria-label={canOpen ? `Open plan ${title} in Canvas` : undefined}
      onClick={openCanvas}
    >
      <span className="agw-canvas-launch-status">
        {status === "running" ? (
          <span className="agw-spinner" aria-hidden />
        ) : (
          <AgentIcon
            name={status === "done" ? "check" : "close"}
            size={13}
            strokeWidth={2.6}
          />
        )}
      </span>
      <span className="agw-canvas-launch-glyph">
        <AgentIcon name="task-list" size={16} />
      </span>
      <span className="agw-canvas-launch-copy">
        <span className="agw-canvas-launch-kicker">
          {status === "running"
            ? "Writing plan"
            : status === "failed"
              ? "Plan could not be written"
              : revised
                ? "Plan updated — open in Canvas"
                : "Plan ready — open in Canvas"}
        </span>
        <span className="agw-canvas-launch-title">{title}</span>
      </span>
      {steps > 0 && (
        <span className="agw-canvas-launch-version">
          {steps} step{steps === 1 ? "" : "s"}
        </span>
      )}
      {canOpen && <AgentIcon name="external" size={14} className="agw-canvas-launch-open" />}
    </button>
  );
};

const PLAN_STEP_WORD: Record<string, string> = {
  in_progress: "Started",
  done: "Finished",
  failed: "Failed",
  skipped: "Skipped",
  pending: "Reset",
};

/**
 * `plan_step_update` — a progress beat, not a tool result worth unfolding. One
 * line naming the step and where the plan now stands; the Canvas has the rest.
 */
const PlanStepCard: React.FC<{
  call: ToolCall;
  isActivelyStreaming: boolean;
}> = ({ call, isActivelyStreaming }) => {
  const status = toolStatus(call, isActivelyStreaming);
  let args: Record<string, unknown> = {};
  let result: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
  } catch {
    args = {};
  }
  try {
    result = JSON.parse(call.result || "{}") as Record<string, unknown>;
  } catch {
    result = {};
  }

  const stepId = typeof args.stepId === "string" ? args.stepId : "";
  const newStatus = typeof args.status === "string" ? args.status : "";
  const steps = Array.isArray(result.steps)
    ? (result.steps as Array<Record<string, unknown>>)
    : [];
  const stepTitle =
    (steps.find((s) => s.id === stepId)?.title as string | undefined) ?? stepId;
  const cursor = (result.cursor ?? {}) as Record<string, unknown>;
  const done = typeof cursor.done === "number" ? cursor.done : undefined;
  const total = typeof cursor.total === "number" ? cursor.total : undefined;

  return (
    <button
      type="button"
      className="agw-plan-beat"
      data-status={status}
      data-step-status={newStatus || undefined}
      onClick={() => useAgentWorkspaceStore.getState().openTab("canvas")}
      aria-label={`${PLAN_STEP_WORD[newStatus] ?? "Updated"} ${stepTitle}. Open plan in Canvas.`}
    >
      <span className="agw-plan-beat-dot" aria-hidden />
      <span className="agw-plan-beat-verb">
        {PLAN_STEP_WORD[newStatus] ?? "Updated"}
      </span>
      <span className="agw-plan-beat-title">{stepTitle}</span>
      {done !== undefined && total !== undefined && (
        <span className="agw-plan-beat-count">
          {done}/{total}
        </span>
      )}
    </button>
  );
};

const TODO_STATUS_WORD: Record<string, string> = {
  in_progress: "Started",
  completed: "Finished",
  cancelled: "Dropped",
  pending: "Reset",
};

/**
 * `todo` — a progress beat, like `plan_step_update`, and for the same reason:
 * laying out a checklist or flipping one item is not a tool result worth
 * unfolding, but it IS an event, and a checklist that moves with no trace in
 * the reply reads as if nothing happened.
 *
 * One line, in the transcript's own past-tense rhythm: what happened, to what,
 * and how far along the list now is. It replaces what the transcript used to
 * show, which was the tool's raw result message verbatim — "Marked t2 as
 * completed. Nothing in progress; next up is t3." That string is written for
 * the model. A reader got internal ids instead of the task, and "nothing in
 * progress" read as if the agent had lost its place when it was simply between
 * two items.
 *
 * Static, not a button: the full checklist is one hover away in the header, so
 * a second click target here would lead somewhere the user can already reach.
 */
const TodoBeatCard: React.FC<{
  call: ToolCall;
  isActivelyStreaming: boolean;
}> = ({ call, isActivelyStreaming }) => {
  const status = toolStatus(call, isActivelyStreaming);
  let args: Record<string, unknown> = {};
  let result: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
  } catch {
    args = {};
  }
  try {
    result = JSON.parse(call.result || "{}") as Record<string, unknown>;
  } catch {
    result = {};
  }

  const op =
    (typeof result.op === "string" ? result.op : undefined) ??
    (typeof args.op === "string" ? args.op : "");
  const cursor = (result.cursor ?? {}) as Record<string, unknown>;
  const total =
    typeof cursor.total === "number"
      ? cursor.total
      : Array.isArray(args.todos)
        ? args.todos.length
        : undefined;
  // Closed, matching the header indicator and the checklist panel exactly.
  const done =
    typeof cursor.completed === "number"
      ? cursor.completed + (typeof cursor.cancelled === "number" ? cursor.cancelled : 0)
      : undefined;

  let verb: string;
  let title: string;
  if (op === "set") {
    // Laying out the list. The count IS the news here, so it leads.
    verb = "Planned";
    title = total === 1 ? "1 task" : `${total ?? 0} tasks`;
  } else {
    const newStatus =
      (typeof result.status === "string" ? result.status : undefined) ??
      (typeof args.status === "string" ? args.status : "");
    verb = TODO_STATUS_WORD[newStatus] ?? "Updated";
    // The id is the fallback, never the headline: it means nothing to a reader.
    title =
      (typeof result.title === "string" && result.title) ||
      (typeof args.id === "string" ? args.id : "task");
  }

  return (
    <div className="agw-task-beat" data-status={status} data-task-op={op || undefined}>
      <span className="agw-task-beat-dot" aria-hidden />
      <span className="agw-task-beat-verb">{verb}</span>
      <span className="agw-task-beat-title">{title}</span>
      {done !== undefined && total !== undefined && (
        <span className="agw-task-beat-count">
          {done}/{total}
        </span>
      )}
    </div>
  );
};

export const ToolCallCard: React.FC<{
  call: ToolCall;
  isActivelyStreaming?: boolean;
}> = ({ call, isActivelyStreaming = false }) => {
  if (call.name === "present_artifact") {
    return <CanvasLaunchCard call={call} isActivelyStreaming={isActivelyStreaming} />;
  }
  if (call.name === "plan_write") {
    return <PlanLaunchCard call={call} isActivelyStreaming={isActivelyStreaming} />;
  }
  if (call.name === "plan_step_update") {
    return <PlanStepCard call={call} isActivelyStreaming={isActivelyStreaming} />;
  }
  // `op: "read"` never reaches here — `buildRows` drops it (see
  // `isSilentToolCall`), because a lookup that changes nothing is not an event.
  if (call.name === "todo") {
    return <TodoBeatCard call={call} isActivelyStreaming={isActivelyStreaming} />;
  }
  return <StandardToolCallCard call={call} isActivelyStreaming={isActivelyStreaming} />;
};
