import { useMemo } from "react";
import type { ToolCall } from "../../../types";
import { summarizeShellCommand } from "./helpers";
import { salvageTruncatedToolResult } from "./salvage";
import type {
  BrowserScrollResult,
  FileListEntry,
  GrepData,
  GrepMatch,
  MultiFileEntry,
  SearchReplaceData,
  ShellOutputData,
  WebSearchData,
  WebSearchResultItem,
  WorkspaceTreeData,
  WorkspaceTreeNode,
} from "./types";

const FILE_MODIFY_TOOLS = new Set([
  "file_create",
  "file_write",
  "file_patch",
  "search_replace",
  "multi_search_replace",
]);

export interface ParsedToolResult {
  /** Plain content to feed `CodeView` when no rich renderer fires. */
  displayData: boolean | number | object | string | null;
  /** Status-line summary ("3 files", "Replaced 2", etc.). */
  simpleMessage: string | null;
  isFileList: boolean;
  fileList: FileListEntry[];
  isMultiFileResult: boolean;
  multiFileResults: MultiFileEntry[];
  searchReplaceData: SearchReplaceData | null;
  multiSearchReplaceData: SearchReplaceData[] | null;
  shellOutputData: ShellOutputData | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  workspaceTreeData: WorkspaceTreeData | null;
  grepData: GrepData | null;
  webSearchData: WebSearchData | null;
  browserScrollData: BrowserScrollResult | null;
}

/**
 * Single source of truth for converting a `tool.result` JSON payload
 * into the per-renderer data the view layer consumes. Each branch
 * peels one tool's shape; we deliberately keep the branches flat
 * (sequential `else if`s) rather than a dispatch table because the
 * payloads overlap (e.g. `parsed.files` is used by grep AND workspace_*).
 *
 * When `JSON.parse` fails (clipped truncation tail from JSONL replay),
 * `salvageTruncatedToolResult` attempts a best-effort recovery so the
 * UI degrades to a partial tree / "(truncated)" notice instead of
 * dumping raw bytes.
 */
export function useToolResultParser(tool: ToolCall): ParsedToolResult {
  const isFileModifyTool = FILE_MODIFY_TOOLS.has(tool.name);

  return useMemo(() => {
    let raw: ParsedToolResult["displayData"] = null;
    let msg: string | null = null;
    let isList = false;
    let listData: FileListEntry[] = [];
    let isMultiFile = false;
    let multiFileData: MultiFileEntry[] = [];
    let linesAddedCount: number | null = null;
    let linesRemovedCount: number | null = null;

    let shellOutputData: ShellOutputData | null = null;
    let workspaceTreeData: WorkspaceTreeData | null = null;
    let grepData: GrepData | null = null;
    let webSearchData: WebSearchData | null = null;
    let browserScrollData: BrowserScrollResult | null = null;

    let searchReplaceData: SearchReplaceData | null = null;
    let multiSearchReplaceData: SearchReplaceData[] | null = null;

    if (tool.name === "search_replace") {
      const oldStr = tool.args?.old_string as string | undefined;
      const newStr = tool.args?.new_string as string | undefined;
      if (oldStr || newStr) {
        searchReplaceData = { oldString: oldStr, newString: newStr };
      }
    } else if (tool.name === "multi_search_replace") {
      const replacements = tool.args?.replacements as
        | Array<{ old_string?: string; new_string?: string }>
        | undefined;
      if (Array.isArray(replacements) && replacements.length > 0) {
        multiSearchReplaceData = replacements.map((r) => ({
          oldString: r.old_string,
          newString: r.new_string,
        }));
      }
    } else if (isFileModifyTool || tool.name === "file_read") {
      const contentField =
        tool.name === "file_patch"
          ? tool.args?.newContent
          : tool.args?.content;
      if (contentField) {
        raw = contentField as string;
      } else if (tool.rawArgs) {
        const m = tool.rawArgs.match(
          /"content"\s*:\s*"([\s\S]*?)(?:"\s*[,}]|$)/,
        );
        if (m) raw = m[1];
      }

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
          // Pending file-change approval — no extra render needed; the
          // approval card lives in the parent.
        } else if (tool.name === "shell_execute") {
          const cmd = summarizeShellCommand(
            String(parsed.command || tool.args?.command || "cmd"),
          );
          const out: string[] = [];
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

          msg = parsed.success
            ? mode === "terminal"
              ? `Ran in terminal: ${cmd}`
              : `Ran in inline terminal: ${cmd}`
            : mode === "terminal"
              ? `Terminal command failed: ${cmd}`
              : `Inline terminal command failed: ${cmd}`;

          if (combinedOutput) raw = combinedOutput;
        } else if (tool.name === "multi_file_read" && parsed.success) {
          msg = `Read ${parsed.filesRead || 0} files`;
          if (parsed.files) {
            isMultiFile = true;
            multiFileData = parsed.files as MultiFileEntry[];
          }
        } else if (
          tool.name === "workspace_tree" &&
          Array.isArray(parsed.tree)
        ) {
          workspaceTreeData = {
            rootPath:
              typeof parsed.rootPath === "string" ? parsed.rootPath : undefined,
            tree: parsed.tree as WorkspaceTreeNode[],
            stats: parsed.stats,
          };
          const fileCount =
            typeof parsed.stats?.filesRead === "number"
              ? parsed.stats.filesRead
              : undefined;
          msg = fileCount !== undefined ? `${fileCount} files` : "Done";
        } else if (
          tool.name === "grep" &&
          (Array.isArray(parsed.matches) || Array.isArray(parsed.files))
        ) {
          if (Array.isArray(parsed.matches)) {
            grepData = {
              matches: parsed.matches as GrepMatch[],
              pattern:
                typeof parsed.pattern === "string"
                  ? parsed.pattern
                  : typeof tool.args?.pattern === "string"
                    ? (tool.args.pattern as string)
                    : undefined,
              totalMatches:
                typeof parsed.total_matches === "number"
                  ? parsed.total_matches
                  : typeof parsed.totalMatches === "number"
                    ? parsed.totalMatches
                    : undefined,
              truncated: Boolean(parsed.truncated),
            };
            const hits = grepData.matches.length;
            const files = new Set(grepData.matches.map((m) => m.file)).size;
            msg = `${hits} ${hits === 1 ? "match" : "matches"} · ${files} files`;
          } else {
            isList = true;
            listData = (parsed.files as string[]).map((p) => ({
              name: p.split(/[/\\]/).pop() || p,
              type: "file" as const,
              path: p,
            }));
            msg = `${listData.length} files`;
          }
        } else if (tool.name === "browser_scroll" && parsed.scroll) {
          browserScrollData = parsed.scroll as BrowserScrollResult;
          if (browserScrollData.mode === "to_selector") {
            msg = `Scrolled to ${browserScrollData.selector}`;
          } else if (browserScrollData.direction === "top") {
            msg = "Scrolled to top";
          } else if (browserScrollData.direction === "bottom") {
            msg = "Scrolled to bottom";
          } else {
            const delta = Math.abs(browserScrollData.deltaY ?? 0);
            const dir = browserScrollData.direction ?? "down";
            msg = `Scrolled ${dir} ${delta}px`;
          }
        } else if (tool.name === "auroro_websearch" && parsed.success) {
          const action =
            typeof parsed.action === "string"
              ? parsed.action
              : tool.args?.action === "fetch"
                ? "fetch"
                : "search";
          const rawResults = Array.isArray(parsed.results)
            ? parsed.results
            : Array.isArray(parsed.results?.results)
              ? parsed.results.results
              : undefined;
          const fetchedContent =
            parsed.content && typeof parsed.content === "object"
              ? (parsed.content as Record<string, unknown>)
              : undefined;
          webSearchData = {
            action,
            query:
              typeof parsed.query === "string"
                ? parsed.query
                : typeof tool.args?.query === "string"
                  ? (tool.args.query as string)
                  : undefined,
            url:
              typeof parsed.url === "string"
                ? parsed.url
                : typeof tool.args?.url === "string"
                  ? (tool.args.url as string)
                  : undefined,
            results: rawResults as WebSearchResultItem[] | undefined,
            fetchedTitle:
              typeof fetchedContent?.title === "string"
                ? (fetchedContent.title as string)
                : undefined,
            fetchedUrl:
              typeof fetchedContent?.url === "string"
                ? (fetchedContent.url as string)
                : typeof parsed.url === "string"
                  ? parsed.url
                  : undefined,
          };
          if (
            action === "fetch" &&
            typeof fetchedContent?.content === "string"
          ) {
            raw = fetchedContent.content as string;
          }
          msg =
            action === "fetch"
              ? "Fetched page"
              : `${rawResults?.length ?? 0} results`;
        } else if (parsed.files) {
          if (tool.name.includes("workspace")) {
            isList = true;
            listData = parsed.files;
          }
        } else if (parsed.content) {
          raw = parsed.content;
        } else if (parsed.message) {
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
            if (rawMsg.toLowerCase().includes("created")) msg = "Created";
            else if (rawMsg.toLowerCase().includes("deleted")) msg = "Deleted";
            else if (
              rawMsg.toLowerCase().includes("written") ||
              rawMsg.toLowerCase().includes("wrote")
            )
              msg = "Written";
            else if (rawMsg.toLowerCase().includes("updated")) msg = "Updated";
            else msg = "Done";
          } else {
            msg = rawMsg;
          }
        } else if (parsed.success) {
          msg = "Done";
        }
      } catch {
        // Truncated JSONL replay (see salvage.ts).
        const salvaged = salvageTruncatedToolResult(tool.name, tool.result);
        if (salvaged?.workspaceTree) {
          workspaceTreeData = salvaged.workspaceTree;
          msg = salvaged.message ?? "Result truncated";
        } else if (salvaged?.grep) {
          grepData = salvaged.grep;
          msg = salvaged.message ?? "Result truncated";
        } else if (salvaged?.message) {
          msg = salvaged.message;
        } else {
          raw = tool.result;
        }
      }
    }

    return {
      displayData: raw,
      simpleMessage: msg,
      isFileList: isList,
      fileList: listData,
      isMultiFileResult: isMultiFile,
      multiFileResults: multiFileData,
      linesAdded: linesAddedCount,
      linesRemoved: linesRemovedCount,
      searchReplaceData,
      multiSearchReplaceData,
      shellOutputData,
      workspaceTreeData,
      grepData,
      webSearchData,
      browserScrollData,
    };
  }, [isFileModifyTool, tool]);
}
