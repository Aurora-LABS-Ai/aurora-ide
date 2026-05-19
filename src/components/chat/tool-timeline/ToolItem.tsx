import React, { useEffect, useState } from "react";
import { Check, Folder, Loader2, X } from "lucide-react";
import { motion } from "framer-motion";
import type { ToolCall, ToolProposal } from "../../../types";
import { ShimmerText } from "../../ui/ShimmerText";
import { getProfessionalToolName } from "../../../services/tool-display";
import { getToolIcon } from "../../icons/ToolIcons";
import { ExplorerFileAssetIcon } from "./ExplorerFileAssetIcon";
import {
  cn,
  formatApprovalValue,
  getProfessionalStatusLabel,
} from "./helpers";
import { openFileInEditor } from "./open-file";
import { useToolResultParser } from "./useToolResultParser";
import {
  BrowserScrollView,
  CodeView,
  FileExplorerView,
  GrepResultsView,
  MultiFileResultsView,
  ShellOutputView,
  WebSearchView,
  WorkspaceTreeView,
} from "./views";

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

const FOLDER_TOOLS = new Set([
  "workspace_tree",
  "folder_create",
  "folder_move",
  "folder_delete",
]);

const FILE_MODIFY_TOOLS = new Set([
  "file_create",
  "file_write",
  "file_patch",
  "search_replace",
  "multi_search_replace",
]);

const HIDDEN_ARG_KEYS = new Set([
  "content",
  "path",
  "raw",
  "newContent",
  "todos",
]);

/**
 * One row of the tool timeline. Renders the status dot, the
 * collapsible header, the inline approval card when the runtime is
 * waiting on permission, and routes the parsed result to the correct
 * view component.
 *
 * Wrapped in `React.memo` because tool cards are re-rendered every
 * time a new chat message streams in, but their own state only
 * changes on tool status updates.
 */
export const ToolItem: React.FC<ToolItemProps> = React.memo(
  ({
    tool,
    isLast,
    isActivelyStreaming = false,
    pendingApproval,
    onApprovePending,
    onRejectPending,
    onApprovePendingRemember,
  }) => {
    const isFileModifyTool = FILE_MODIFY_TOOLS.has(tool.name);
    const isFolderTool = FOLDER_TOOLS.has(tool.name);
    const [isOpen, setIsOpen] = useState(false);
    const [showApprovalDetails, setShowApprovalDetails] = useState(false);

    // If the tool claims to be running but we're NOT actively streaming,
    // it's a stale/stuck tool from a previous session — treat as failed.
    const isStale =
      (tool.status === "executing" || tool.status === "pending") &&
      !isActivelyStreaming;
    const effectiveStatus = isStale ? "failed" : tool.status;

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
    const fileName = filePath
      ? filePath.split(/[/\\]/).pop() || filePath
      : "";
    const displayTitle = getProfessionalToolName(tool.name);

    const handleFileClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!filePath) return;
      void openFileInEditor(filePath);
    };

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
      workspaceTreeData,
      grepData,
      webSearchData,
      browserScrollData,
    } = useToolResultParser(tool);

    return (
      <div className="group relative flex gap-3">
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

          {/* Status dot. Failed tools intentionally use the warning
              (amber) palette rather than full error red — a single
              tool failing inside an agent run is "this didn't work,
              recoverable" not "compiler error, stop the world". The
              `X` glyph still carries the "did not complete" signal so
              the colour can stay warm without losing meaning. */}
          <div
            className={cn(
              "relative z-10 flex h-3 w-3 items-center justify-center rounded-full mt-2.5 transition-all text-[8px] leading-none",
              isError
                ? "bg-warning/20 text-warning ring-2 ring-warning/10"
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
        <div className="min-w-0 flex-1 pt-1 pb-1">
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
                  // Failed cards de-emphasize the title rather than
                  // painting it red — the warm badge to the right is
                  // the canonical "this didn't work" signal, and the
                  // title in secondary tone reads as "skipped" instead
                  // of "broken".
                  <span className="text-[11px] font-medium tracking-tight text-text-secondary">
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
                        ? "border-warning/35 bg-warning/10 text-warning"
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
                            ? "Didn't complete"
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

          <motion.div
            initial={false}
            animate={{ height: isOpen ? "auto" : 0, opacity: isOpen ? 1 : 0 }}
            className="overflow-hidden"
          >
            <div className="pt-2 pl-1 border-l border-border ml-1">
              {/* Argument chips — skip the noisy fields we render elsewhere */}
              {Object.keys(tool.args || {}).filter(
                (k) => !HIDDEN_ARG_KEYS.has(k),
              ).length > 0 && (
                <div className="flex flex-wrap gap-1 mb-2">
                  {Object.entries(tool.args || {})
                    .filter(([k]) => !HIDDEN_ARG_KEYS.has(k))
                    .map(([k, v]) => {
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

              {/* todo_write — render the proposed todo list inline */}
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

              {searchReplaceData &&
                (searchReplaceData.oldString ||
                  searchReplaceData.newString) && (
                  <div className="space-y-2 mt-2">
                    {searchReplaceData.oldString && (
                      <CodeView
                        data={searchReplaceData.oldString}
                        fileName={fileName}
                        variant="removed"
                      />
                    )}
                    {searchReplaceData.newString && (
                      <CodeView
                        data={searchReplaceData.newString}
                        fileName={fileName}
                        variant="added"
                      />
                    )}
                  </div>
                )}

              {multiSearchReplaceData && multiSearchReplaceData.length > 0 && (
                <div className="space-y-3 mt-2">
                  {multiSearchReplaceData.map((replacement, idx) => (
                    <div key={idx} className="space-y-1">
                      <div className="flex items-center gap-2 text-[9px] text-text-disabled">
                        <span className="font-mono">#{idx + 1}</span>
                        <span className="flex-1 h-px bg-border"></span>
                      </div>
                      {replacement.oldString && (
                        <CodeView
                          data={replacement.oldString}
                          fileName={fileName}
                          variant="removed"
                        />
                      )}
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

              {workspaceTreeData && (
                <WorkspaceTreeView
                  rootPath={workspaceTreeData.rootPath}
                  tree={workspaceTreeData.tree}
                  stats={workspaceTreeData.stats}
                />
              )}

              {grepData && grepData.matches.length > 0 && (
                <GrepResultsView
                  matches={grepData.matches}
                  pattern={grepData.pattern}
                  totalMatches={grepData.totalMatches}
                  truncated={grepData.truncated}
                />
              )}

              {webSearchData && (
                <WebSearchView
                  action={webSearchData.action}
                  query={webSearchData.query}
                  url={webSearchData.url}
                  results={webSearchData.results}
                  fetchedTitle={webSearchData.fetchedTitle}
                  fetchedUrl={webSearchData.fetchedUrl}
                />
              )}

              {browserScrollData && (
                <BrowserScrollView result={browserScrollData} />
              )}

              {(displayData || tool.error) &&
                !isMultiFileResult &&
                !searchReplaceData &&
                !multiSearchReplaceData &&
                !workspaceTreeData &&
                !(grepData && grepData.matches.length > 0) &&
                !(webSearchData && webSearchData.action === "search") &&
                !browserScrollData &&
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

ToolItem.displayName = "ToolItem";
