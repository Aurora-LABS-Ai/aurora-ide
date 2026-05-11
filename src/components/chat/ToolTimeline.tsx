/**
 * THEME ARCHITECTURE NOTICE:
 *
 * This project uses a centralized theme system. DO NOT use hardcoded colors.
 *
 * Instead of:
 *   - Hardcoded hex values: #ff0000, #1a1a1a
 *   - Hardcoded RGB values: rgb(255, 0, 0)
 *   - Tailwind arbitrary colors: bg-[#1a1a1a], text-[#ff0000]
 *
 * Use theme tokens via CSS variables:
 *   - CSS: var(--aurora-{category}-{token})
 *   - Tailwind: bg-[var(--aurora-editor-background)]
 *   - Component styles: style={{ background: 'var(--aurora-sidebar-background)' }}
 *
 * Available categories: editor, sidebar, chat, terminal, statusBar, titleBar, common
 *
 * See: DOCS/theme-dev.md for full token reference
 * See: src/types/theme.ts for TypeScript interfaces
 * See: src/services/theme-service.ts for theme utilities
 */

import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Check,
  X,
  Loader2,
  Folder,
  File,
  LayoutGrid,
  Terminal,
} from "lucide-react";
import clsx from "clsx";
import { twMerge } from "tailwind-merge";
import { motion } from "framer-motion";
import type { ToolCall, ToolProposal } from "../../types";
import { resolveExplorerIcon } from "../../lib/icon-registry";
import { useSettingsStore } from "../../store/useSettingsStore";
import { ShimmerText } from "../ui/ShimmerText";
import { getProfessionalToolName } from "../../services/tool-display";
import { getToolIcon } from "../icons/ToolIcons";

// --- Utility ---
function cn(...inputs: (string | undefined | null | false)[]) {
  return twMerge(clsx(inputs));
}

const ExplorerFileAssetIcon: React.FC<{
  className?: string;
  fileName: string;
  path?: string;
}> = ({ className, fileName, path }) => {
  const explorerIconPack = useSettingsStore((state) => state.explorerIconPack);
  const icon = resolveExplorerIcon(
    { name: fileName, path, isFolder: false },
    explorerIconPack,
  );

  return (
    <img
      src={icon.src || "/material-icons/file.svg"}
      alt=""
      className={className}
    />
  );
};

const summarizeShellCommand = (command: string): string => {
  const compact = command.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
};

const formatApprovalValue = (value: unknown): string => {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") {
    return value.length > 120 ? `${value.slice(0, 120)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    return json.length > 120 ? `${json.slice(0, 120)}...` : json;
  } catch {
    return "[unserializable]";
  }
};

const getProfessionalStatusLabel = (
  status: ToolCall["status"],
  options?: {
    isAwaitingApproval?: boolean;
    isStale?: boolean;
    simpleMessage?: string | null;
  },
): string => {
  if (options?.isAwaitingApproval) return "Awaiting approval";
  if (options?.isStale) return "Execution interrupted";

  if (options?.simpleMessage) {
    return options.simpleMessage;
  }

  switch (status) {
    case "pending":
      return "Queued";
    case "executing":
      return "In progress";
    case "complete":
      return "Completed";
    case "failed":
      return "Failed";
    case "rejected":
      return "Not approved";
    default:
      return "Completed";
  }
};

// --- 1. File Explorer Component ---
interface FileExplorerProps {
  files: Array<{ name: string; type: "file" | "directory"; path: string }>;
}

const FileExplorerView: React.FC<FileExplorerProps> = ({ files }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const sortedFiles = useMemo(() => {
    return [...files].sort((a, b) => {
      if (!a?.name || !b?.name) return 0;
      if (a.type === b.type) return a.name.localeCompare(b.name);
      return a.type === "directory" ? -1 : 1;
    });
  }, [files]);

  const displayedFiles = isExpanded ? sortedFiles : sortedFiles.slice(0, 6);
  const remainingCount = sortedFiles.length - 6;

  return (
    <div className="mt-1 pl-1 border-l border-border/40">
      <div className="flex items-center gap-2 px-2 py-1">
        <LayoutGrid size={10} className="text-text-secondary" />
        <span className="text-[10px] text-text-secondary uppercase tracking-wider">
          Directory Listing ({files.length})
        </span>
      </div>

      <div className="pl-2 mt-1 grid gap-0.5">
        {displayedFiles.map((file, idx) => (
          <div
            key={idx}
            className="flex items-center gap-2 rounded px-2 py-1 hover:bg-sidebar-item-hover transition-colors"
          >
            {file.type === "directory" ? (
              <Folder size={12} className="text-info/80 fill-info/10" />
            ) : (
              <File size={12} className="text-text-secondary" />
            )}
            <span
              className={cn(
                "truncate text-[10px]",
                file.type === "file"
                  ? "text-text-secondary"
                  : "text-text-primary font-medium",
              )}
            >
              {file.name}
            </span>
          </div>
        ))}
      </div>

      {!isExpanded && remainingCount > 0 && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setIsExpanded(true);
          }}
          className="ml-2 mt-1 text-[10px] text-text-disabled hover:text-text-primary transition-colors flex items-center gap-1"
        >
          <span>+{remainingCount} more...</span>
        </button>
      )}

      {isExpanded && files.length > 6 && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setIsExpanded(false);
          }}
          className="ml-2 mt-1 text-[10px] text-text-disabled hover:text-text-primary transition-colors"
        >
          Show less
        </button>
      )}
    </div>
  );
};

// --- 1.5. Multi-File Read Results Component ---
interface MultiFileResultsProps {
  files: Array<{
    path: string;
    success: boolean;
    lines?: number;
    error?: string;
    content?: string;
  }>;
}

const MultiFileResultsView: React.FC<MultiFileResultsProps> = ({ files }) => {
  const handleFileClick = async (file: {
    path: string;
    success: boolean;
    content?: string;
  }) => {
    if (!file.success || !file.content) return;
    try {
      const { useEditorStore } = await import("../../store/useEditorStore");
      const { resolvePath } = await import("../../tools/utils/path-resolver");
      const fullPath = resolvePath(file.path);
      const filename = fullPath.split(/[/\\]/).pop() || file.path;
      const ext = filename.split(".").pop()?.toLowerCase() || "";
      const langMap: Record<string, string> = {
        ts: "typescript",
        tsx: "typescript",
        js: "javascript",
        jsx: "javascript",
        json: "json",
        css: "css",
        scss: "scss",
        html: "html",
        md: "markdown",
        rs: "rust",
        py: "python",
        go: "go",
      };
      const language = langMap[ext] || "plaintext";
      useEditorStore
        .getState()
        .openFile(fullPath, filename, file.content, language);
    } catch (error) {
      console.error("Failed to open file:", error);
    }
  };

  const getFileName = (path: string) => path.split(/[/\\]/).pop() || path;

  return (
    <div className="flex flex-col gap-0.5 mt-1">
      {files.map((file, idx) => {
        const fileName = getFileName(file.path);
        return (
          <button
            key={idx}
            onClick={() => handleFileClick(file)}
            disabled={!file.success}
            className={cn(
              "w-full flex items-center justify-between gap-2 rounded px-2 py-1 text-left group transition-colors",
              file.success
                ? "hover:bg-success/5 cursor-pointer"
                : "opacity-60 cursor-not-allowed",
            )}
          >
            <div className="flex items-center gap-2 min-w-0 overflow-hidden">
              {file.success ? (
                <Check size={10} className="text-success shrink-0" />
              ) : (
                <X size={10} className="text-error shrink-0" />
              )}
              <ExplorerFileAssetIcon
                fileName={fileName}
                path={file.path}
                className="w-3 h-3 flex-shrink-0"
              />
              <span className="truncate text-[10px] text-text-secondary group-hover:text-text-primary transition-colors">
                {fileName}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
};

// --- 2. Code Block View ---
interface CodeViewProps {
  data?: boolean | number | object | string | null;
  error?: string;
  isStreaming?: boolean;
  fileName?: string;
  variant?: "added" | "removed" | "normal";
  hideHeader?: boolean;
}

interface ShellOutputViewProps {
  command?: string;
  cwd?: string;
  exitCode?: number | null;
  mode?: "inline" | "terminal";
  output?: string | null;
  success?: boolean;
}

/**
 * Unescape JSON string escapes to show actual content
 * Converts \n → newline, \" → ", \\ → \, etc.
 */
const unescapeContent = (str: string): string => {
  if (!str) return str;
  try {
    // Try to parse as JSON string to unescape
    // Wrap in quotes if not already a valid JSON string
    if (!str.startsWith('"')) {
      return str
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
    return JSON.parse(str);
  } catch {
    // Manual unescape if JSON parse fails
    return str
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
};

const CodeView: React.FC<CodeViewProps> = ({
  data,
  error,
  isStreaming,
  fileName,
  variant = "normal",
  hideHeader = false,
}) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  useEffect(() => {
    if (isStreaming && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [data, isStreaming]);

  if (error) {
    return (
      <div className="mt-2 rounded-md bg-error/10 p-2 border border-error/20">
        <div className="font-mono text-[10px] text-error whitespace-pre-wrap">
          <span className="font-bold">Error:</span> {error}
        </div>
      </div>
    );
  }

  if (!data && data !== 0 && data !== false) return null;

  const rawContent =
    typeof data === "string" ? data : JSON.stringify(data, null, 2);

  // Unescape the content to show actual newlines, quotes, etc.
  const content = unescapeContent(rawContent);
  const lines = content.split("\n");
  const isLongContent = lines.length > 8;
  const displayLines = isExpanded ? lines : lines.slice(0, 8);

  // Get file extension for styling
  const ext = fileName?.split(".").pop()?.toLowerCase() || "";
  const isCode = [
    "ts",
    "tsx",
    "js",
    "jsx",
    "py",
    "rs",
    "go",
    "css",
    "scss",
    "html",
    "json",
    "md",
  ].includes(ext);

  return (
    <div
      className={cn(
        "relative mt-2 group border rounded-md overflow-hidden transition-colors",
        variant === "added"
          ? "border-diff-added/20"
          : variant === "removed"
            ? "border-diff-removed/12"
            : "border-border/50",
      )}
    >
      {/* File header bar */}
      {fileName && !hideHeader && (
        <div
          className={cn(
            "flex items-center gap-2 px-3 py-1.5 border-b rounded-t-md",
            variant === "added"
              ? "bg-diff-added/10 border-diff-added/20 text-diff-added"
              : variant === "removed"
                ? "bg-diff-removed/[0.05] border-diff-removed/12 text-diff-removed/85"
                : "bg-code-block border-border/50 text-text-secondary",
          )}
        >
          <ExplorerFileAssetIcon
            fileName={fileName}
            className="w-3.5 h-3.5 flex-shrink-0 opacity-90"
          />
          <span className="text-[10.5px] font-mono tracking-tight">
            {fileName}
          </span>

          <div className="ml-auto flex items-center gap-1.5 ">
            {variant === "added" && (
              <span className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[9px] font-mono bg-diff-added/20 text-diff-added border border-diff-added/20">
                <span className="opacity-80">new</span>
                <span className="font-semibold">+{lines.length}</span>
              </span>
            )}
            {variant === "removed" && (
              <span className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[9px] font-mono bg-diff-removed/[0.08] text-diff-removed/85 border border-diff-removed/12">
                <span className="opacity-80">removed</span>
                <span className="font-semibold">-{lines.length}</span>
              </span>
            )}
            {variant === "normal" && (
              <span className="text-[9px] text-text-disabled">
                {lines.length} lines
              </span>
            )}
          </div>
        </div>
      )}

      <div
        ref={contentRef}
        style={{
          maxHeight: isExpanded ? "400px" : "180px",
          ...(variant === "removed"
            ? {
                backgroundImage:
                  "repeating-linear-gradient(-45deg, transparent, transparent 10px, color-mix(in srgb, currentColor 2%, transparent) 10px, color-mix(in srgb, currentColor 2%, transparent) 20px)",
              }
            : {}),
        }}
        className={cn(
          "font-mono text-[10.5px] leading-[1.65] overflow-y-auto overflow-x-auto scrollbar-thin scrollbar-thumb-scrollbar scrollbar-track-transparent",
          !fileName || hideHeader ? "rounded-md" : "rounded-b-md",
          variant === "added"
            ? "bg-diff-added/[0.04] text-diff-added"
            : variant === "removed"
              ? "bg-diff-removed/[0.025] text-diff-removed/85"
              : "bg-code-block text-text-secondary",
        )}
      >
        <table className="w-full border-collapse">
          <tbody>
            {displayLines.map((line, idx) => (
              <tr
                key={idx}
                className={cn(
                  "hover:bg-sidebar-item-hover transition-colors",
                  variant === "added" && "hover:bg-diff-added/10",
                  variant === "removed" && "hover:bg-diff-removed/[0.06]",
                )}
              >
                {/* Line number */}
                <td
                  className={cn(
                    "text-[9px] text-right pr-3 pl-2 py-0 select-none w-10 align-top border-r",
                    variant === "added"
                      ? "text-diff-added/50 border-diff-added/20"
                      : variant === "removed"
                        ? "text-diff-removed/45 border-diff-removed/12"
                        : "text-text-disabled/50 border-border/40",
                  )}
                >
                  {idx + 1}
                </td>
                {/* Code content */}
                <td className="pl-3 pr-4 py-0">
                  <pre className="whitespace-pre-wrap break-all inline-block w-full">
                    <code
                      className={cn(
                        variant === "added"
                          ? "text-diff-added/90"
                          : variant === "removed"
                            ? "text-diff-removed/80"
                            : isCode
                              ? "text-text-primary"
                              : "text-text-secondary",
                      )}
                    >
                      {line || " "}
                    </code>
                  </pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Expand/Collapse button */}
      {isLongContent && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setIsExpanded(!isExpanded);
          }}
          className={cn(
            "w-full text-center text-[9.5px] py-1 border-t transition-colors",
            variant === "added"
              ? "bg-diff-added/10 border-diff-added/20 text-diff-added/70 hover:text-diff-added"
              : variant === "removed"
                ? "bg-diff-removed/[0.05] border-diff-removed/12 text-diff-removed/65 hover:text-diff-removed/85"
                : "bg-code-block border-border/50 text-text-disabled hover:text-text-primary",
          )}
        >
          {isExpanded ? "Show Less" : `Show ${lines.length - 8} More Lines`}
        </button>
      )}
    </div>
  );
};

const ShellOutputView: React.FC<ShellOutputViewProps> = ({
  command,
  cwd,
  exitCode,
  mode = "inline",
  output,
  success,
}) => {
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
  }, [command, cwd, exitCode, mode, output, success]);

  if (!output && output !== "") return null;

  return (
    <div className="mt-2 overflow-hidden rounded-md border border-border/50 bg-code-block">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/50 bg-input/30 px-3 py-1.5">
        <div className="flex items-center gap-1.5 text-text-primary">
          <Terminal size={12} />
          <span className="text-[10.5px] font-medium">
            {mode === "terminal" ? "IDE Terminal" : "Inline Terminal"}
          </span>
        </div>

        {typeof success === "boolean" && (
          <span
            className={cn(
              "rounded border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide",
              success
                ? "border-success/30 bg-success/10 text-success"
                : "border-error/30 bg-error/10 text-error",
            )}
          >
            {success ? "Success" : "Failed"}
          </span>
        )}

        {typeof exitCode === "number" && (
          <span className="rounded border border-border/70 bg-input/40 px-1.5 py-0.5 text-[9px] font-mono text-text-secondary">
            exit {exitCode}
          </span>
        )}

        <span className="ml-auto text-[9px] uppercase tracking-wide text-text-disabled">
          Scroll inside
        </span>
      </div>

      {(command || cwd) && (
        <div className="flex flex-col gap-1 border-b border-border/40 bg-sidebar/30 px-3 py-2 text-[9.5px] text-text-secondary">
          {command && (
            <div className="flex flex-wrap items-start gap-2">
              <span className="shrink-0 uppercase tracking-wide text-text-disabled">
                Command
              </span>
              <code className="break-all font-mono text-text-primary">
                {command}
              </code>
            </div>
          )}
          {cwd && (
            <div className="flex flex-wrap items-start gap-2">
              <span className="shrink-0 uppercase tracking-wide text-text-disabled">
                Cwd
              </span>
              <code className="break-all font-mono">{cwd}</code>
            </div>
          )}
        </div>
      )}

      <div
        ref={contentRef}
        className="max-h-[240px] overflow-auto scrollbar-thin scrollbar-thumb-scrollbar scrollbar-track-transparent"
      >
        <pre className="min-w-full whitespace-pre-wrap break-all px-3 py-2 font-mono text-[10.5px] leading-[1.6] text-text-secondary">
          <code>{output || "No output"}</code>
        </pre>
      </div>
    </div>
  );
};

// --- 3. Tool Item Logic ---
interface ToolItemProps {
  tool: ToolCall;
  isLast: boolean;
  index: number;
  isActivelyStreaming?: boolean;
  pendingApproval?: ToolProposal | null;
  onApprovePending?: () => void;
  onRejectPending?: () => void;
  onApprovePendingRemember?: () => void;
}

const ToolItem: React.FC<ToolItemProps> = React.memo(
  ({
    tool,
    isLast,
    isActivelyStreaming = false,
    pendingApproval,
    onApprovePending,
    onRejectPending,
    onApprovePendingRemember,
  }) => {
    const isFileModifyTool = [
      "file_create",
      "file_write",
      "file_patch",
      "search_replace",
      "multi_search_replace",
    ].includes(tool.name);
    const isFolderTool = [
      "workspace_tree",
      "folder_create",
      "folder_move",
      "folder_delete",
    ].includes(tool.name);
    const [isOpen, setIsOpen] = useState(false);
    const [showApprovalDetails, setShowApprovalDetails] = useState(false);

    // If the tool claims to be running but we're NOT actively streaming,
    // it's a stale/stuck tool from a previous session - treat as failed.
    const isStale =
      (tool.status === "executing" || tool.status === "pending") &&
      !isActivelyStreaming;
    const effectiveStatus = isStale ? "failed" : tool.status;

    // Auto-expand errors (including stale stuck tools)
    useEffect(() => {
      if (tool.status === "failed" || tool.status === "rejected" || isStale) {
        setIsOpen(true);
      }
    }, [tool.status, isStale]);

    const isRunning =
      effectiveStatus === "executing" || effectiveStatus === "pending";
    const isError =
      effectiveStatus === "failed" || effectiveStatus === "rejected";
    // Awaiting approval whenever the agent runtime has parked on the
    // permission gate for *this* tool. We deliberately do NOT gate on
    // `tool.status === "pending"` — the Rust runtime emits
    // `ToolExecutionStart` (which flips status to "executing") before
    // it calls into the permission-guarded executor, so the card has
    // already advanced past pending by the time the approval event
    // fires. Gating on `pendingApproval.id === tool.id` is sufficient:
    // once the user clicks approve/deny the parent clears
    // `pendingApproval` and this collapses back to false.
    const isAwaitingApproval = Boolean(
      pendingApproval &&
      pendingApproval.id === tool.id &&
      pendingApproval.status === "pending",
    );
    const approvalParameters = pendingApproval?.parameters ?? {};
    const hasApprovalParameters = Object.keys(approvalParameters).length > 0;

    const filePath = tool.args?.path as string;
    const fileName = filePath ? filePath.split(/[/\\]/).pop() || filePath : "";
    const displayTitle = getProfessionalToolName(tool.name);

    // Handle file click to open in editor
    const handleFileClick = async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!filePath) return;

      try {
        const { useEditorStore } = await import("../../store/useEditorStore");
        const { resolvePath } = await import("../../tools/utils/path-resolver");
        const { readFileContent } = await import("../../lib/tauri");

        const fullPath = resolvePath(filePath);
        // Read file content if not a file modify tool (already have content from tool args)

        // safely read content
        let fileContent = "";
        try {
          fileContent = await readFileContent(fullPath);
        } catch (e) {
          console.warn("Could not read file content", e);
        }

        const ext = fileName.split(".").pop()?.toLowerCase() || "";
        const langMap: Record<string, string> = {
          ts: "typescript",
          tsx: "typescript",
          js: "javascript",
          jsx: "javascript",
          json: "json",
          css: "css",
          scss: "scss",
          html: "html",
          md: "markdown",
          rs: "rust",
          py: "python",
          go: "go",
        };
        const language = langMap[ext] || "plaintext";

        useEditorStore
          .getState()
          .openFile(fullPath, fileName, fileContent, language);
      } catch (error) {
        console.error("Failed to open file:", error);
      }
    };

    // Data processing hook
    const {
      displayData,
      simpleMessage,
      isFileList,
      fileList,
      isMultiFileResult,
      multiFileResults,
      searchReplaceData,
      multiSearchReplaceData,
      shellOutputData,
      linesAdded,
      linesRemoved,
    } = useMemo(() => {
      let raw = null;
      let msg = null;
      let isList = false;
      let listData = [];
      let isMultiFile = false;
      let multiFileData = [];
      let linesAddedCount: number | null = null;
      let linesRemovedCount: number | null = null;
      let isFileChangePending = false;

      let shellOutputData: {
        command?: string;
        cwd?: string;
        exitCode?: number | null;
        mode?: "inline" | "terminal";
        output?: string | null;
        success?: boolean;
      } | null = null;

      // file_create, file_write are FILE MODIFY tools so they should show parsed content
      let searchReplaceData: { oldString?: string; newString?: string } | null =
        null;
      let multiSearchReplaceData: Array<{
        oldString?: string;
        newString?: string;
      }> | null = null;

      if (tool.name === "search_replace") {
        // Special handling for search_replace - show old_string and new_string
        const oldStr = tool.args?.old_string as string | undefined;
        const newStr = tool.args?.new_string as string | undefined;
        if (oldStr || newStr) {
          searchReplaceData = { oldString: oldStr, newString: newStr };
        }
      } else if (tool.name === "multi_search_replace") {
        // Handle multi_search_replace - show all replacements
        const replacements = tool.args?.replacements as
          | Array<{ old_string?: string; new_string?: string }>
          | undefined;
        if (
          replacements &&
          Array.isArray(replacements) &&
          replacements.length > 0
        ) {
          multiSearchReplaceData = replacements.map((r) => ({
            oldString: r.old_string,
            newString: r.new_string,
          }));
        }
      } else if (isFileModifyTool || tool.name === "file_read") {
        // Added file_read here to show content
        const contentField =
          tool.name === "file_patch"
            ? tool.args?.newContent
            : tool.args?.content;
        if (contentField) raw = contentField;
        else if (tool.rawArgs) {
          const m = tool.rawArgs.match(
            /"content"\s*:\s*"([\s\S]*?)(?:"\s*[,}]|$)/,
          );
          if (m) raw = m[1];
          // else raw = '...'; // Don't show ... for clean look
        }

        // For file_read, try to get from result
        if (tool.name === "file_read" && tool.result) {
          try {
            const parsed = JSON.parse(tool.result);
            if (parsed.content) raw = parsed.content;
          } catch {
            raw = tool.result;
          }
        }
      }

      if (tool.result) {
        try {
          const parsed = JSON.parse(tool.result);
          if (
            tool.name === "search_replace" ||
            tool.name === "multi_search_replace"
          ) {
            if (parsed.linesAdded) linesAddedCount = parsed.linesAdded;
            if (parsed.linesRemoved) linesRemovedCount = parsed.linesRemoved;
            // For multi_search_replace, aggregate totals from results
            if (tool.name === "multi_search_replace" && parsed.results) {
              let totalAdded = 0;
              let totalRemoved = 0;
              for (const r of parsed.results) {
                if (r.linesAdded) totalAdded += r.linesAdded;
                if (r.linesRemoved) totalRemoved += r.linesRemoved;
              }
              if (totalAdded > 0) linesAddedCount = totalAdded;
              if (totalRemoved > 0) linesRemovedCount = totalRemoved;
            }
          }
          if (parsed.pending) {
            isFileChangePending = true;
            // Don't show "Pending approval" - tools auto-approve
          } else if (tool.name === "shell_execute") {
            const cmd = summarizeShellCommand(
              String(parsed.command || tool.args?.command || "cmd"),
            );
            const out = [];
            if (parsed.stdout) out.push(parsed.stdout);
            if (parsed.stderr) out.push(parsed.stderr);
            if (parsed.error) out.push(parsed.error);

            const mode = parsed.type === "terminal" ? "terminal" : "inline";
            const combinedOutput = out.length > 0 ? out.join("\n") : "";

            shellOutputData = {
              command: String(parsed.command || tool.args?.command || "cmd"),
              cwd:
                typeof parsed.cwd === "string"
                  ? parsed.cwd
                  : typeof tool.args?.cwd === "string"
                    ? (tool.args.cwd as string)
                    : undefined,
              exitCode:
                typeof parsed.exitCode === "number" ? parsed.exitCode : null,
              mode,
              output: combinedOutput,
              success: Boolean(parsed.success),
            };

            if (parsed.success) {
              msg =
                mode === "terminal"
                  ? `Ran in terminal: ${cmd}`
                  : `Ran in inline terminal: ${cmd}`;
            } else {
              msg =
                mode === "terminal"
                  ? `Terminal command failed: ${cmd}`
                  : `Inline terminal command failed: ${cmd}`;
            }

            if (combinedOutput) raw = combinedOutput;
          } else if (tool.name === "multi_file_read" && parsed.success) {
            msg = `Read ${parsed.filesRead || 0} files`;
            if (parsed.files) {
              isMultiFile = true;
              multiFileData = parsed.files;
            }
          } else if (parsed.files) {
            if (tool.name.includes("workspace")) {
              isList = true;
              listData = parsed.files;
            }
          } else if (parsed.content) {
            raw = parsed.content;
          } else if (parsed.message) {
            // Clean up messages - remove long paths, keep it short
            const rawMsg = parsed.message as string;
            if (
              tool.name === "search_replace" ||
              tool.name === "multi_search_replace"
            ) {
              const match = rawMsg.match(/Replaced (\d+) occurrence/);
              msg = match ? `Replaced ${match[1]}` : "Done";
            } else if (
              rawMsg.includes(":\\") ||
              rawMsg.includes(":/") ||
              rawMsg.length > 50
            ) {
              // Message contains path or is too long - simplify it
              if (rawMsg.toLowerCase().includes("created")) msg = "Created";
              else if (rawMsg.toLowerCase().includes("deleted"))
                msg = "Deleted";
              else if (
                rawMsg.toLowerCase().includes("written") ||
                rawMsg.toLowerCase().includes("wrote")
              )
                msg = "Written";
              else if (rawMsg.toLowerCase().includes("updated"))
                msg = "Updated";
              else msg = "Done";
            } else {
              msg = rawMsg;
            }
          } else if (parsed.success) {
            msg = "Done";
          }
        } catch {
          raw = tool.result;
        }
      }

      return {
        displayData: raw,
        simpleMessage: msg,
        isFileList: isList,
        fileList: listData,
        isMultiFileResult: isMultiFile,
        multiFileResults: multiFileData,
        isPendingFileChange: isFileChangePending,
        linesAdded: linesAddedCount,
        linesRemoved: linesRemovedCount,
        searchReplaceData,
        multiSearchReplaceData,
        shellOutputData,
      };
    }, [isFileModifyTool, tool]);

    return (
      <div className="group relative flex gap-3 pb-1">
        {/* Timeline Track */}
        <div className="flex flex-col items-center w-4 flex-shrink-0 relative">
          <div
            className={cn(
              "absolute top-0 bottom-0 w-px transition-colors duration-300",
              isLast
                ? "bg-transparent"
                : "bg-border/20 group-hover:bg-border/40",
            )}
          />

          <div
            className={cn(
              "relative z-10 flex h-3 w-3 items-center justify-center rounded-full mt-2.5 transition-all text-[8px] leading-none",
              isError
                ? "bg-error/20 text-error ring-2 ring-error/10"
                : isRunning
                  ? "bg-task-progress/20 text-task-progress ring-2 ring-task-progress/10"
                  : "bg-success/20 text-success ring-2 ring-success/10",
            )}
          >
            {isError ? (
              <X size={8} className="block" />
            ) : isRunning ? (
              <Loader2 size={8} className="animate-spin block" />
            ) : (
              <Check size={8} className="block" />
            )}
          </div>
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1 pt-1.5 pb-2">
          <div className="flex items-start gap-2">
            <button
              onClick={() => setIsOpen(!isOpen)}
              className="group/header flex min-w-0 flex-1 flex-col items-start gap-1 text-left outline-none"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="flex-shrink-0">
                  {getToolIcon(tool.name, 14)}
                </span>

                {isError ? (
                  <span className="text-[11px] font-medium tracking-tight text-error">
                    {displayTitle}
                  </span>
                ) : isRunning ? (
                  <ShimmerText className="text-[11px] font-medium tracking-tight text-task-progress">
                    {displayTitle}
                  </ShimmerText>
                ) : (
                  <span className="text-[11px] font-medium tracking-tight text-text-primary">
                    {displayTitle}
                  </span>
                )}

                {(isAwaitingApproval || isRunning || isError) && (
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide",
                      isError
                        ? "border-error/30 bg-error/10 text-error"
                        : "border-task-progress/30 bg-task-progress/10 text-task-progress",
                    )}
                  >
                    {isAwaitingApproval
                      ? "Awaiting Approval"
                      : effectiveStatus === "executing"
                        ? "In Progress"
                        : effectiveStatus === "pending"
                          ? "Queued"
                          : effectiveStatus === "failed"
                            ? "Failed"
                            : "Not Approved"}
                  </span>
                )}

                {(fileName || isFolderTool) && (
                  <span
                    onClick={fileName ? handleFileClick : undefined}
                    role={fileName ? "button" : undefined}
                    tabIndex={fileName ? 0 : undefined}
                    className={cn(
                      "inline-flex max-w-full items-center gap-1.5 rounded-sm border border-border bg-input/40 px-1.5 py-0.5 text-[10px] text-text-secondary",
                      fileName &&
                        "cursor-pointer transition-all hover:border-border-hover hover:bg-input/70",
                    )}
                  >
                    {isFolderTool ? (
                      <Folder
                        size={12}
                        className="text-info/80 fill-info/10 flex-shrink-0"
                      />
                    ) : (
                      <ExplorerFileAssetIcon
                        fileName={fileName}
                        path={filePath}
                        className="w-3 h-3 flex-shrink-0"
                      />
                    )}
                    <span
                      className={cn(
                        "truncate opacity-80",
                        fileName &&
                          "underline decoration-transparent underline-offset-2 hover:opacity-100 hover:decoration-border/50",
                      )}
                    >
                      {fileName ||
                        (filePath
                          ? filePath.split(/[/\\]/).pop()
                          : "directory")}
                    </span>
                  </span>
                )}
              </div>

              <span className="flex max-w-full flex-wrap items-center gap-1.5 text-[10px] leading-[1.45] text-text-disabled opacity-80 transition-opacity group-hover/header:opacity-100 whitespace-pre-wrap break-words">
                {/* Line diff stats for search_replace */}
                {(linesAdded !== null || linesRemoved !== null) && (
                  <span className="flex items-center gap-1 font-mono">
                    {linesAdded !== null && linesAdded > 0 && (
                      <span className="text-diff-added">+{linesAdded}</span>
                    )}
                    {linesRemoved !== null && linesRemoved > 0 && (
                      <span className="text-diff-removed">-{linesRemoved}</span>
                    )}
                  </span>
                )}
                {/* Regular status message */}
                {!(linesAdded || linesRemoved) &&
                  getProfessionalStatusLabel(effectiveStatus, {
                    isAwaitingApproval,
                    isStale,
                    simpleMessage,
                  })}
              </span>
            </button>
          </div>

          {isAwaitingApproval && (
            <div className="mt-2 ml-1 rounded-lg border border-border bg-input/30 p-2.5">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                  Approval Needed
                </span>
                <span
                  className={cn(
                    "text-[9px] px-1.5 py-0.5 rounded-full border",
                    pendingApproval?.riskLevel === "high"
                      ? "text-danger border-danger/40 bg-danger/10"
                      : pendingApproval?.riskLevel === "medium"
                        ? "text-warning border-warning/40 bg-warning/10"
                        : "text-success border-success/40 bg-success/10",
                  )}
                >
                  {pendingApproval?.riskLevel ?? "medium"}
                </span>
                <span className="ml-auto text-[10px] text-text-secondary font-mono">
                  {displayTitle}
                </span>
              </div>

              {hasApprovalParameters && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowApprovalDetails((prev) => !prev);
                  }}
                  className="mt-1 text-[10px] text-text-disabled hover:text-text-secondary transition-colors"
                >
                  {showApprovalDetails ? "Hide parameters" : "Show parameters"}
                </button>
              )}

              {showApprovalDetails && hasApprovalParameters && (
                <div className="mt-2 rounded-md border border-border/70 bg-input/40 p-2 space-y-1.5">
                  {Object.entries(approvalParameters).map(([key, value]) => (
                    <div key={key} className="flex gap-2">
                      <span className="w-24 shrink-0 text-[9px] uppercase tracking-wide text-text-secondary">
                        {key}
                      </span>
                      <span className="text-[10px] font-mono text-text-primary break-all">
                        {formatApprovalValue(value)}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRejectPending?.();
                  }}
                  className="px-2.5 py-1 rounded-md border border-border text-[10px] font-medium text-text-secondary hover:text-danger hover:border-danger/50 transition-colors"
                >
                  Reject
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onApprovePending?.();
                  }}
                  className="px-2.5 py-1 rounded-md bg-primary text-primary-foreground text-[10px] font-semibold hover:bg-primary/90 transition-colors"
                >
                  Approve
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onApprovePendingRemember?.();
                  }}
                  className="px-2.5 py-1 rounded-md border border-primary/40 text-[10px] font-medium text-primary hover:bg-primary/10 transition-colors"
                >
                  Approve & remember
                </button>
              </div>
            </div>
          )}

          {/* EXPANDED CONTENT - No Box, just indented */}
          <motion.div
            initial={false}
            animate={{ height: isOpen ? "auto" : 0, opacity: isOpen ? 1 : 0 }}
            className="overflow-hidden"
          >
            <div className="pt-2 pl-1 border-l border-border ml-1">
              {/* Arguments List - Minimal */}
              {Object.keys(tool.args || {}).filter(
                (k) =>
                  !["content", "path", "raw", "newContent", "todos"].includes(
                    k,
                  ),
              ).length > 0 && (
                <div className="flex flex-wrap gap-1 mb-2">
                  {Object.entries(tool.args || {})
                    .filter(
                      ([k]) =>
                        ![
                          "content",
                          "path",
                          "raw",
                          "newContent",
                          "todos",
                        ].includes(k),
                    )
                    .map(([k, v]) => {
                      // Format value properly - handle objects/arrays
                      let displayValue: string;
                      if (v === null || v === undefined) {
                        displayValue = "null";
                      } else if (typeof v === "object") {
                        displayValue = Array.isArray(v)
                          ? `[${v.length} items]`
                          : "{...}";
                      } else {
                        displayValue = String(v).substring(0, 30);
                      }
                      return (
                        <span
                          key={k}
                          className="text-[9px] px-1.5 py-0.5 rounded bg-input/40 text-text-secondary border border-border"
                        >
                          <span className="opacity-60">{k}:</span>{" "}
                          {displayValue}
                        </span>
                      );
                    })}
                </div>
              )}

              {/* Todo List Display - Special handling for todo_write */}
              {tool.name === "todo_write" &&
                tool.args?.todos &&
                Array.isArray(tool.args.todos) && (
                  <div className="mb-2 space-y-1">
                    {(
                      tool.args.todos as Array<{
                        id?: string;
                        content?: string;
                        status?: string;
                      }>
                    ).map((todo, idx) => (
                      <div
                        key={todo.id || idx}
                        className="flex items-center gap-2 text-[10px] px-2 py-1 rounded bg-input/40 border border-border"
                      >
                        <span
                          className={cn(
                            "w-1.5 h-1.5 rounded-full flex-shrink-0",
                            todo.status === "completed"
                              ? "bg-task-completed"
                              : todo.status === "in_progress"
                                ? "bg-task-progress"
                                : todo.status === "cancelled"
                                  ? "bg-task-cancelled"
                                  : "bg-task-pending",
                          )}
                        />
                        <span className="text-text-secondary truncate">
                          {todo.content || "Untitled task"}
                        </span>
                        {todo.status && (
                          <span
                            className={cn(
                              "ml-auto text-[9px] px-1 py-0.5 rounded flex-shrink-0",
                              todo.status === "completed"
                                ? "bg-task-completed/20 text-task-completed"
                                : todo.status === "in_progress"
                                  ? "bg-task-progress/20 text-task-progress"
                                  : todo.status === "cancelled"
                                    ? "bg-task-cancelled/20 text-task-cancelled"
                                    : "bg-task-pending/20 text-task-pending",
                            )}
                          >
                            {todo.status}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}

              {isFileList && fileList.length > 0 && (
                <FileExplorerView files={fileList} />
              )}
              {isMultiFileResult && multiFileResults.length > 0 && (
                <MultiFileResultsView files={multiFileResults} />
              )}
              {/* Search/Replace Diff View */}
              {searchReplaceData &&
                (searchReplaceData.oldString ||
                  searchReplaceData.newString) && (
                  <div className="space-y-2 mt-2">
                    {/* Old String (what was replaced) */}
                    {searchReplaceData.oldString && (
                      <CodeView
                        data={searchReplaceData.oldString}
                        fileName={fileName}
                        variant="removed"
                      />
                    )}
                    {/* New String (replacement) */}
                    {searchReplaceData.newString && (
                      <CodeView
                        data={searchReplaceData.newString}
                        fileName={fileName}
                        variant="added"
                      />
                    )}
                  </div>
                )}

              {/* Multi Search/Replace Diff View */}
              {multiSearchReplaceData && multiSearchReplaceData.length > 0 && (
                <div className="space-y-3 mt-2">
                  {multiSearchReplaceData.map((replacement, idx) => (
                    <div key={idx} className="space-y-1">
                      <div className="flex items-center gap-2 text-[9px] text-text-disabled">
                        <span className="font-mono">#{idx + 1}</span>
                        <span className="flex-1 h-px bg-border"></span>
                      </div>
                      {/* Old String (what was replaced) */}
                      {replacement.oldString && (
                        <CodeView
                          data={replacement.oldString}
                          fileName={fileName}
                          variant="removed"
                        />
                      )}
                      {/* New String (replacement) */}
                      {replacement.newString && (
                        <CodeView
                          data={replacement.newString}
                          fileName={fileName}
                          variant="added"
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}

              {tool.name === "shell_execute" && shellOutputData && (
                <ShellOutputView
                  command={shellOutputData.command}
                  cwd={shellOutputData.cwd}
                  exitCode={shellOutputData.exitCode}
                  mode={shellOutputData.mode}
                  output={shellOutputData.output}
                  success={shellOutputData.success}
                />
              )}

              {(displayData || tool.error) &&
                !isMultiFileResult &&
                !searchReplaceData &&
                !multiSearchReplaceData &&
                tool.name !== "shell_execute" && (
                  <CodeView
                    data={displayData}
                    error={tool.error}
                    isStreaming={isRunning}
                    fileName={fileName}
                    variant={
                      isFileModifyTool && !tool.error ? "added" : "normal"
                    }
                  />
                )}
            </div>
          </motion.div>
        </div>
      </div>
    );
  },
);

interface ToolTimelineProps {
  tools: ToolCall[];
  variant?: "timeline" | "cards";
  isActivelyStreaming?: boolean;
  pendingApproval?: ToolProposal | null;
  onApprovePending?: () => void;
  onRejectPending?: () => void;
  onApprovePendingRemember?: () => void;
}

export const ToolTimeline: React.FC<ToolTimelineProps> = ({
  tools,
  variant = "timeline",
  isActivelyStreaming = false,
  pendingApproval = null,
  onApprovePending,
  onRejectPending,
  onApprovePendingRemember,
}) => {
  if (!tools || tools.length === 0) return null;

  return (
    <div className="w-full mt-2 pl-2">
      {tools.map((tool, idx) => (
        <ToolItem
          key={`${variant}-${tool.id}`}
          tool={tool}
          isLast={idx === tools.length - 1}
          index={idx}
          isActivelyStreaming={isActivelyStreaming}
          pendingApproval={pendingApproval}
          onApprovePending={onApprovePending}
          onRejectPending={onRejectPending}
          onApprovePendingRemember={onApprovePendingRemember}
        />
      ))}
    </div>
  );
};
