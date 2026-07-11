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

import React, { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { getProfessionalToolName } from "../../services/tool-display";
import { FileIcon, FolderIcon } from "../../components/explorer/FileIcons";
import { AgentIcon, type AgentIconName } from "../shared/AgentIcon";
import { useAgentReviewStore } from "../store/useAgentReviewStore";
import { useAgentWorkspaceStore } from "../store/useAgentWorkspaceStore";
import { toolStatus, type ToolCall, type ToolStatus } from "./tool-call";
import { parseToolResult } from "./tool-views/tool-result";
import { ToolResultView } from "./tool-views/ToolResultView";

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

/**
 * Like `partialString`, but returns the value ONLY once its closing quote has
 * arrived — i.e. the field is fully streamed, even if the rest of the JSON is
 * still open. Returns null while the value is mid-stream.
 *
 * This is what the file chip/icon use: reading the path on every partial token
 * makes it flicker through each fragment ("s" → "src" → "src/com" → … →
 * "Foo.tsx"), and since the icon is derived from the name/extension, you see a
 * lightning-fast burst of changing file icons. Withholding until the value is
 * complete shows the real path once, no flicker.
 */
function completedString(raw: string, key: string): string | null {
  const at = raw.indexOf(`"${key}"`);
  if (at < 0) return null;
  const colon = raw.indexOf(":", at + key.length + 2);
  if (colon < 0) return null;
  const open = raw.indexOf('"', colon + 1);
  if (open < 0) return null;
  for (let i = open + 1; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === '"') return raw.slice(open + 1, i).replace(/\\(.)/g, "$1"); // closed → complete
  }
  return null; // ran off the end → still streaming; withhold to avoid flicker
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
  if (lower === "workspace_tree" || lower === "folder_create") return "files";
  if (lower === "shell_execute" || lower === "shell_spawn") return "terminal";
  if (lower === "read_lints" || lower === "todo_write") return "review";
  if (lower === "auroro_websearch" || lower === "auroro_web_search") return "browser";
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

export const ToolCallCard: React.FC<{
  call: ToolCall;
  isActivelyStreaming?: boolean;
}> = ({ call, isActivelyStreaming = false }) => {
  // Derived open state (no setState-in-effect): failed tools default OPEN so the
  // reason is visible; a user toggle overrides that default for this card.
  const [override, setOverride] = useState<boolean | null>(null);

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

  // While args are still streaming, JSON.parse fails — fall back to a partial
  // read for the path chip. Use the COMPLETED-value reader so the chip/icon
  // appear once the path is fully received, never flickering through every
  // fragment ("s" → "src" → … → "Foo.tsx") as tokens arrive.
  const path =
    pathOf(parsedArgs) ||
    (status === "running"
      ? completedString(call.arguments, "path") ||
        completedString(call.arguments, "file_path") ||
        ""
      : "");
  const fileName = path ? basename(path) : "";
  const isFolder = FOLDER_TOOLS.has(call.name);

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

  const parsed = useMemo(
    () => parseToolResult(call.name, parsedArgs, call.result),
    [call.name, parsedArgs, call.result],
  );

  const argChips = useMemo(
    () =>
      Object.entries(parsedArgs).filter(
        ([k]) => !HIDDEN_ARG_KEYS.has(k) && !(isShellTool(call.name) && SHELL_ARG_KEYS.has(k)),
      ),
    [parsedArgs, call.name],
  );

  const summary = useMemo(() => {
    if (status === "running") return ""; // shown as a shimmer label instead
    if (status === "failed") {
      const r = call.result || "";
      const m = r.match(/^\s*\[(?:error|rejected)\]\s*(.*)/i);
      return (m?.[1]?.trim() || "Didn't complete").slice(0, 160);
    }
    return parsed.summary || "";
  }, [status, call.result, parsed.summary]);

  const hasResult = Boolean(
    parsed.tree ||
      parsed.multiFile?.length ||
      parsed.grep?.matches.length ||
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
  const hasDetail = hasResult || argChips.length > 0 || !!streamingPreview;
  // Collapsed by DEFAULT — including while a tool is running. A running/settled
  // card is a quiet one-line row; the user clicks it open to inspect args, the
  // live write stream, or the result. A failure that happens LIVE (this turn is
  // still streaming) defaults open so its error is visible without a click —
  // but a failed card loaded from history (or once the turn ends) collapses back
  // like everything else, so old failures don't stay stuck open. `override` wins.
  const defaultOpen = status === "failed" && isActivelyStreaming;
  const open = (override ?? defaultOpen) && hasDetail;
  const toggle = () => setOverride(!(override ?? defaultOpen));

  // A modify tool with a real diff → the file chip opens the Review panel
  // focused on this file (expand + scroll). For a multi-file edit, focus the
  // first touched file. `getState()` so the card itself doesn't re-render on
  // dock/selection changes.
  const reviewPath = parsed.diff?.path || parsed.diffs?.[0]?.path || path;
  const canReview = Boolean((parsed.diff || parsed.diffs?.length) && reviewPath);
  const openReview = (e: React.MouseEvent) => {
    e.stopPropagation();
    useAgentReviewStore.getState().setSelectedPath(reviewPath);
    useAgentWorkspaceStore.getState().openTab("review");
  };

  return (
    <div className="agw-tool-card">
      <button
        type="button"
        className="agw-tool-head"
        aria-expanded={open}
        onClick={() => hasDetail && toggle()}
      >
        <span className={`agw-tool-dot agw-tool-dot-${status}`}>
          {status === "running" ? (
            <span className="agw-spinner" aria-hidden />
          ) : (
            DOT_ICON[status] && <AgentIcon name={DOT_ICON[status]!} size={13} strokeWidth={2.6} />
          )}
        </span>

        <AgentIcon name={icon} size={14} />

        <span
          style={{
            color: status === "failed" ? "var(--agw-text-muted)" : "var(--agw-text)",
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </span>

        {(fileName || isFolder) &&
          (canReview ? (
            <span
              role="button"
              tabIndex={0}
              className="agw-tool-chip agw-tool-chip-btn"
              title="Open in Review"
              onClick={openReview}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") openReview(e as unknown as React.MouseEvent);
              }}
            >
              {isFolder ? (
                <FolderIcon name={fileName} className="agw-file-ico" />
              ) : (
                <FileIcon name={fileName} path={path} className="agw-file-ico" />
              )}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {fileName || "directory"}
              </span>
            </span>
          ) : (
            <span className="agw-tool-chip">
              {isFolder ? (
                <FolderIcon name={fileName} className="agw-file-ico" />
              ) : (
                <FileIcon name={fileName} path={path} className="agw-file-ico" />
              )}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {fileName || "directory"}
              </span>
            </span>
          ))}

        {status === "running" ? (
          <span className="agw-tool-summary agw-shimmer">Running…</span>
        ) : parsed.stat && (parsed.stat.added > 0 || parsed.stat.removed > 0) ? (
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
              style={{
                color: status === "failed" ? "var(--agw-removed)" : "var(--agw-text-subtle)",
              }}
            >
              {summary}
            </span>
          )
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

              {streamingPreview ? (
                <pre
                  ref={previewRef}
                  className="agw-code agw-scroll agw-diff agw-diff-added agw-tool-stream"
                >
                  {streamingPreview}
                </pre>
              ) : (
                <ToolResultView parsed={parsed} />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
