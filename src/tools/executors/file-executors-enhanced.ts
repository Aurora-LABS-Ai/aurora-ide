/**
 * Enhanced File Tool Executors with Operation Logging
 * Integrates operation logging for safety and context awareness
 * Includes pre-save syntax validation to catch errors before writing
 * Includes undo/redo integration for AI-made changes
 */
import { deletePath, isTauri, readFileContent, ripgrepSearch, writeFileContent } from "../../lib/tauri";
import {
  applyMultiSearchReplaceNative,
  applySearchReplaceNative,
  type NativeReplacementItem,
  type NativeSearchReplaceResponse,
} from "../../lib/native-editor-ops";
import { formatValidationForAgent, supportsValidation, validateSyntax } from "../../services/syntax-validator";
// Dynamic import of useUndoRedoStore used in file_create and file_write
import { useSettingsStore } from "../../store/useSettingsStore";
import { FsOperationType, operationLog } from "../operation-log";
import { toolRegistry } from "../registry";
import type { ToolExecutor } from "../types";
import { isPathExcluded } from "../utils/excluded-paths";
import { getWorkspaceRootPath, resolvePath } from "../utils/path-resolver";
import {
  DEFAULT_LINE_WINDOW,
  MAX_SINGLE_READ_LINES,
  isLargeFileByLines,
  normalizeLineRange,
  sliceLineRange,
  splitLines,
} from "./file-read-policy";
import type { SearchReplaceReplacement } from "./search-replace-utils";

// ============================================
// GREP EXECUTOR (Ripgrep-style search with logging)
// ============================================

// NOTE: processEscapeSequences was REMOVED
// JSON.parse() already handles escape sequences correctly when parsing tool arguments.
// Double-processing caused bugs like unterminated string literals when AI wrote code
// containing backslashes (e.g., regex patterns, Windows paths, escape sequences).
// The AI sends properly escaped JSON - we must NOT double-process it.

// NO-OP: Rust file watcher handles refresh via fs-changed events
const triggerRefresh = () => { };

const DEFAULT_GREP_TIMEOUT_MS = 30_000;
const MAX_GREP_TIMEOUT_MS = 300_000;
const MIN_GREP_TIMEOUT_MS = 1_000;

interface FileExecutorArgs extends Record<string, unknown> {
  case_insensitive?: boolean;
  content: string;
  context_lines?: number;
  end_line?: number;
  glob?: string;
  is_regex?: boolean;
  max_results?: number;
  max_lines?: number;
  new_string: string;
  old_string: string;
  output_mode?: "content" | "files_with_matches" | "count";
  path: string;
  paths: string[];
  pattern: string;
  replace_all?: boolean;
  replacements: SearchReplaceReplacement[];
  start_line?: number;
  timeout?: number;
  timeout_ms?: number;
}

const asToolExecutor = (
  executor: (args: FileExecutorArgs, toolCallId?: string) => Promise<string>,
): ToolExecutor => (args, toolCallId) =>
  executor(args as FileExecutorArgs, toolCallId);

const normalizeGrepTimeoutMs = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_GREP_TIMEOUT_MS;
  }

  return Math.min(
    Math.max(Math.trunc(value), MIN_GREP_TIMEOUT_MS),
    MAX_GREP_TIMEOUT_MS,
  );
};

// Convert agent-supplied replacement objects into the camelCase shape Rust expects.
const toNativeReplacement = (rep: SearchReplaceReplacement): NativeReplacementItem => ({
  oldString: rep.old_string,
  newString: rep.new_string ?? "",
  replaceAll: rep.replace_all === true,
});

// Render a structured planning failure (NotFound / NotUnique / Overlap) into the
// same JSON shape the legacy TS planner produced, so the agent's downstream
// behavior is unchanged.
const renderPlanningFailure = (
  result: NativeSearchReplaceResponse,
  args: FileExecutorArgs,
  fullPath: string,
  context: "search_replace" | "multi_search_replace",
): string | null => {
  if (result.status === "ok") {
    return null;
  }

  const isMulti = context === "multi_search_replace";
  const rollbackHint = isMulti ? " All changes have been rolled back." : "";

  if (result.status === "not_found") {
    return JSON.stringify({
      success: false,
      error: isMulti
        ? `Replacement ${result.failedAt}: Could not find the specified text in the original file snapshot. Line endings are handled automatically, so check indentation, surrounding context, or reread the file.`
        : `Could not find the specified text in ${args.path}. Line endings are handled automatically, so check indentation, surrounding context, or reread the file before retrying.`,
      path: args.path,
      fullPath,
      ...(isMulti && { failedAt: result.failedAt }),
      hint: isMulti
        ? "The text still needs to match the current file content exactly."
        : "The text still needs to match the current file content. Include enough nearby code to make the match exact and unique.",
    });
  }

  if (result.status === "not_unique") {
    return JSON.stringify({
      success: false,
      error: isMulti
        ? `Replacement ${result.failedAt}: Found ${result.occurrences} occurrences of the text. Either include more context to make it unique, or set replace_all=true for this replacement.`
        : `Found ${result.occurrences} occurrences of the text. The old_string must be unique. Either include more context to make it unique, or set replace_all=true to replace all occurrences.`,
      path: args.path,
      fullPath,
      occurrences: result.occurrences,
      ...(isMulti && { failedAt: result.failedAt }),
      hint:
        (isMulti
          ? "Fix the old_string to be unique or use replace_all."
          : "Add more surrounding code to old_string to make it unique in the file.") + rollbackHint,
    });
  }

  if (result.status === "overlap") {
    return JSON.stringify({
      success: false,
      error: `Replacement ${result.failedAt} overlaps with replacement ${result.conflictingReplacement}. Combine nearby edits into one larger replacement or make the snippets non-overlapping.`,
      path: args.path,
      fullPath,
      failedAt: result.failedAt,
      conflictingReplacement: result.conflictingReplacement,
      hint:
        "Batch edits can target the same file, but their matched regions cannot overlap." + rollbackHint,
    });
  }

  return null;
};

// Helper to validate file content before writing
// Returns null if valid, or error message if invalid
const validateBeforeWrite = async (content: string, filename: string): Promise<string | null> => {
  // Check if syntax validation is enabled in settings
  const syntaxValidationEnabled = useSettingsStore.getState().syntaxValidationEnabled;

  if (!syntaxValidationEnabled) {
    return null; // Validation disabled by user
  }

  // Check if this file type supports validation
  if (!supportsValidation(filename)) {
    return null; // No validation for this file type
  }

  const result = await validateSyntax(content, filename);
  if (!result.valid) {
    return formatValidationForAgent(result, filename);
  }

  return null; // Valid
};

// ============================================
// FILE CREATE EXECUTOR (Cursor-style: Write immediately, revert on reject)
// ============================================
const fileCreateExecutor = async (
  args: FileExecutorArgs,
  toolCallId?: string,
): Promise<string> => {
  if (!isTauri()) {
    return JSON.stringify({
      success: false,
      error: "File operations require desktop app",
    });
  }

  if (!getWorkspaceRootPath()) {
    return JSON.stringify({ success: false, error: "No workspace open" });
  }

  const fullPath = resolvePath(args.path);
  const fileName = fullPath.split(/[/\\]/).pop() || args.path;
  console.log("[file_create] Writing file (Cursor-style):", fullPath);

  try {
    // Content is already properly escaped by JSON.parse - use directly
    const processedContent = args.content ?? '';

    // PRE-SAVE VALIDATION: Check syntax before writing
    const validationError = await validateBeforeWrite(processedContent, fileName);
    if (validationError) {
      console.warn("[file_create] Syntax validation failed:", fileName);
      return JSON.stringify({
        success: false,
        error: validationError,
        validation_failed: true,
        path: args.path,
        fullPath,
      });
    }

    // CURSOR-STYLE: Write to disk immediately
    await writeFileContent(fullPath, processedContent);
    triggerRefresh();

    // Record in undo/redo service and store for AI-created files
    try {
      const { useUndoRedoStore } = await import('../../store/useUndoRedoStore');
      await useUndoRedoStore.getState().recordChange(
        fullPath,
        '', // Empty string for new file
        processedContent,
        'ai_tool',
        `AI file_create: ${fileName}`
      );
    } catch (e) {
      console.warn('[file_create] Failed to record undo:', e);
    }

    // Check if auto-accept is enabled BEFORE adding to pending changes
    const autoAccept = useSettingsStore.getState().autoAcceptChanges;

    if (autoAccept) {
      // Auto-accept mode: File is already written, just update editor if open
      import('../../store/useEditorStore').then(({ useEditorStore }) => {
        const tab = useEditorStore.getState().tabs.find(t => t.path === fullPath);
        if (tab) {
          useEditorStore.getState().reloadTabContent(tab.id, processedContent);
        }
      }).catch(() => { });

      operationLog.logOperation(FsOperationType.Create, args.path, {
        fullPath,
        pending: false,
        autoAccepted: true,
        bytes: processedContent.length,
      });

      return JSON.stringify({
        success: true,
        pending: false,
        message: `File created: ${args.path}`,
        path: args.path,
        fullPath,
        bytes: processedContent.length,
      });
    }

    // Import pending changes store (only when NOT auto-accept)
    const { usePendingChangesStore } = await import('../../store/usePendingChangesStore');

    // Track the change for potential rollback (originalContent undefined = new file, delete on reject)
    const changeId = usePendingChangesStore.getState().addChange({
      filePath: fullPath,
      fileName,
      content: processedContent,
      originalContent: undefined, // New file - delete on reject
      operation: 'create',
      toolCallId: toolCallId || '',
    });

    // Automatically open the file in the editor so the user sees the diff
    import('../../store/useEditorStore').then(({ useEditorStore }) => {
      const filename = fullPath.split(/[/\\]/).pop() || args.path;
      const ext = filename.split('.').pop()?.toLowerCase() || '';
      const langMap: Record<string, string> = {
        'ts': 'typescript', 'tsx': 'typescript',
        'js': 'javascript', 'jsx': 'javascript',
        'json': 'json', 'css': 'css', 'scss': 'scss',
        'html': 'html', 'md': 'markdown',
        'rs': 'rust', 'toml': 'toml',
        'yaml': 'yaml', 'yml': 'yaml',
        'py': 'python', 'go': 'go',
      };
      const language = langMap[ext] || 'plaintext';
      useEditorStore.getState().openFile(fullPath, filename, processedContent, language);
    });

    // Log the create operation
    operationLog.logOperation(FsOperationType.Create, args.path, {
      fullPath,
      pending: true,
      changeId,
      hasContent: !!args.content,
      bytes: processedContent.length,
    });

    return JSON.stringify({
      success: true,
      pending: true,
      changeId,
      message: `File created (pending approval): ${args.path}`,
      path: args.path,
      fullPath,
    });
  } catch (error) {
    console.error("[file_create] Error:", error);
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// ============================================
// FILE DELETE EXECUTOR (Enhanced with Logging)
// ============================================
const fileDeleteExecutor = async (
  args: FileExecutorArgs,
): Promise<string> => {
  if (!isTauri()) {
    return JSON.stringify({
      success: false,
      error: "File operations require desktop app",
    });
  }

  const fullPath = resolvePath(args.path);
  console.log("[file_delete] Deleting file:", fullPath);

  try {
    await deletePath(fullPath);

    // Log the delete operation
    operationLog.logOperation(FsOperationType.Delete, args.path, {
      fullPath,
    });

    triggerRefresh();

    return JSON.stringify({
      success: true,
      message: `File deleted: ${args.path}`,
      path: args.path,
      fullPath,
    });
  } catch (error) {
    console.error("[file_delete] Error:", error);
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// ============================================
// FILE READ EXECUTOR (Enhanced with Logging + Safety)
// ============================================
const fileReadExecutor = async (args: FileExecutorArgs): Promise<string> => {
  if (!isTauri()) {
    return JSON.stringify({
      success: false,
      error: "File operations require desktop app",
    });
  }

  const fullPath = resolvePath(args.path);
  console.log("[file_read] Reading file:", fullPath);

  // Safety check: Block reading from excluded directories/files
  const exclusionCheck = isPathExcluded(args.path);
  if (exclusionCheck.excluded) {
    console.warn("[file_read] Excluded:", exclusionCheck.reason);
    return JSON.stringify({
      success: false,
      error: exclusionCheck.reason,
      excluded: true,
    });
  }

  // Also check the full resolved path
  const fullPathCheck = isPathExcluded(fullPath);
  if (fullPathCheck.excluded) {
    console.warn("[file_read] Excluded (full path):", fullPathCheck.reason);
    return JSON.stringify({
      success: false,
      error: fullPathCheck.reason,
      excluded: true,
    });
  }

  try {
    const content = await readFileContent(fullPath);
    const lines = splitLines(content);
    const totalLines = lines.length;
    const range = normalizeLineRange(
      {
        endLine: args.end_line,
        maxLines: args.max_lines,
        startLine: args.start_line,
      },
      totalLines,
    );

    if (range) {
      const result = sliceLineRange(lines, range);

      operationLog.logOperation(FsOperationType.Read, args.path, {
        fullPath,
        lineRange: `${result.startLine}-${result.endLine}`,
        lines: totalLines,
        size: content.length,
      });

      return JSON.stringify({
        success: true,
        path: args.path,
        fullPath,
        content: result.content,
        totalLines,
        size: content.length,
        largeFile: isLargeFileByLines(totalLines),
        range: {
          startLine: result.startLine,
          endLine: result.endLine,
        },
        truncated: result.truncated,
        omittedLinesBefore: result.omittedLinesBefore,
        omittedLinesAfter: result.omittedLinesAfter,
        warning: result.truncated
          ? `Returned lines ${result.startLine}-${result.endLine} of ${totalLines}. Use start_line/end_line to read another range.`
          : undefined,
      });
    }

    // Safety check: never return oversized files by accident, even if they
    // have unusually long lines and are below the line-count threshold.
    if (content.length > MAX_FILE_SIZE) {
      console.warn(`[file_read] Large file warning: ${content.length} bytes`);
      return JSON.stringify({
        success: true,
        path: args.path,
        fullPath,
        totalLines,
        size: content.length,
        largeFile: true,
        requiresLineRange: true,
        content: "",
        warning: `File is too large to return safely (${content.length} bytes, ${totalLines} lines). Call file_read with start_line/end_line; maximum ${MAX_SINGLE_READ_LINES} lines per call.`,
        suggestedRange: {
          startLine: 1,
          endLine: Math.min(DEFAULT_LINE_WINDOW, totalLines),
        },
      });
    }

    // Log the read operation
    operationLog.logOperation(FsOperationType.Read, args.path, {
      fullPath,
      lines: totalLines,
      size: content.length,
    });

    return JSON.stringify({
      success: true,
      path: args.path,
      fullPath,
      content,
      totalLines,
      size: content.length,
      largeFile: false,
    });
  } catch (error) {
    console.error("[file_read] Error:", error);
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// ============================================
// FILE WRITE EXECUTOR (Cursor-style: Write immediately, revert on reject)
// ============================================
const fileWriteExecutor = async (
  args: FileExecutorArgs,
  toolCallId?: string,
): Promise<string> => {
  if (!isTauri()) {
    return JSON.stringify({
      success: false,
      error: "File operations require desktop app",
    });
  }

  const rootPath = getWorkspaceRootPath();
  if (!rootPath) {
    return JSON.stringify({ success: false, error: "No workspace open" });
  }

  const fullPath = resolvePath(args.path);
  const fileName = fullPath.split(/[/\\]/).pop() || args.path;
  console.log("[file_write] Writing file (Cursor-style):", fullPath);

  try {
    // Content is already properly escaped by JSON.parse - use directly
    const processedContent = args.content ?? '';

    // PRE-SAVE VALIDATION: Check syntax before writing
    const validationError = await validateBeforeWrite(processedContent, fileName);
    if (validationError) {
      console.warn("[file_write] Syntax validation failed:", fileName);
      return JSON.stringify({
        success: false,
        error: validationError,
        validation_failed: true,
        path: args.path,
        fullPath,
      });
    }

    // Check if auto-accept is enabled BEFORE loading original content (saves time)
    const autoAccept = useSettingsStore.getState().autoAcceptChanges;

    // Load original content BEFORE writing (for undo/redo)
    let originalContent = '';
    try {
      originalContent = await readFileContent(fullPath);
    } catch {
      // File doesn't exist yet, originalContent stays empty
    }

    // CURSOR-STYLE: Write to disk immediately
    await writeFileContent(fullPath, processedContent);
    triggerRefresh();

    // Record in undo/redo service and store for AI-made changes
    try {
      const { useUndoRedoStore } = await import('../../store/useUndoRedoStore');
      await useUndoRedoStore.getState().recordChange(
        fullPath,
        originalContent,
        processedContent,
        'ai_tool',
        `AI file_write: ${fileName}`
      );
    } catch (e) {
      console.warn('[file_write] Failed to record undo:', e);
    }

    if (autoAccept) {
      // Auto-accept mode: File is already written, just update editor if open
      import('../../store/useEditorStore').then(({ useEditorStore }) => {
        const tab = useEditorStore.getState().tabs.find(t => t.path === fullPath);
        if (tab) {
          useEditorStore.getState().reloadTabContent(tab.id, processedContent);
        }
      }).catch(() => { });

      operationLog.logOperation(FsOperationType.Write, args.path, {
        fullPath,
        pending: false,
        autoAccepted: true,
        bytes: processedContent.length,
        lines: processedContent.split("\n").length,
      });

      return JSON.stringify({
        success: true,
        pending: false,
        message: `File written: ${args.path}`,
        path: args.path,
        fullPath,
        bytes: processedContent.length,
      });
    }

    // Import pending changes store (only when NOT auto-accept)
    const { usePendingChangesStore, loadOriginalContent } = await import('../../store/usePendingChangesStore');

    // Use already loaded original content (or reload if needed)
    const pendingOriginal = originalContent || await loadOriginalContent(fullPath);

    // Track the change for potential rollback
    const changeId = usePendingChangesStore.getState().addChange({
      filePath: fullPath,
      fileName,
      content: processedContent,
      originalContent: pendingOriginal, // Store original for revert on reject
      operation: 'write',
      toolCallId: toolCallId || '',
    });

    // Automatically open the file in the editor so the user sees the diff
    import('../../store/useEditorStore').then(({ useEditorStore }) => {
      const filename = fullPath.split(/[/\\]/).pop() || args.path;
      const ext = filename.split('.').pop()?.toLowerCase() || '';
      const langMap: Record<string, string> = {
        'ts': 'typescript', 'tsx': 'typescript',
        'js': 'javascript', 'jsx': 'javascript',
        'json': 'json', 'css': 'css', 'scss': 'scss',
        'html': 'html', 'md': 'markdown',
        'rs': 'rust', 'toml': 'toml',
        'yaml': 'yaml', 'yml': 'yaml',
        'py': 'python', 'go': 'go',
      };
      const language = langMap[ext] || 'plaintext';
      useEditorStore.getState().openFile(fullPath, filename, processedContent, language);
    });

    // Log the write operation
    operationLog.logOperation(FsOperationType.Write, args.path, {
      fullPath,
      pending: true,
      changeId,
      bytes: processedContent.length,
      lines: processedContent.split("\n").length,
    });

    return JSON.stringify({
      success: true,
      pending: true,
      changeId,
      message: `File written (pending approval): ${args.path}`,
      path: args.path,
      fullPath,
      bytes: processedContent.length,
    });
  } catch (error) {
    console.error("[file_write] Error:", error);
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
const grepExecutor = async (args: FileExecutorArgs): Promise<string> => {
  if (!isTauri()) {
    return JSON.stringify({
      success: false,
      error: "File operations require desktop app",
    });
  }

  const rootPath = getWorkspaceRootPath();
  if (!rootPath) {
    return JSON.stringify({ success: false, error: "No workspace open" });
  }

  const searchPath = resolvePath(args.path || ".");
  const pattern = args.pattern;
  const outputMode = args.output_mode || "content";
  const isRegex = args.is_regex !== false;
  const caseInsensitive = args.case_insensitive || false;
  const globPattern = args.glob;
  const contextLines = args.context_lines || 0;
  const maxResults = args.max_results || 50;
  const timeoutMs = normalizeGrepTimeoutMs(args.timeout ?? args.timeout_ms);

  try {
    const toRelativePath = (filePath: string): string => {
      const normalizedRootPath = rootPath.replace(/\\/g, "/").replace(/\/$/, "");
      const normalizedFilePath = filePath.replace(/\\/g, "/");

      if (normalizedFilePath.startsWith(`${normalizedRootPath}/`)) {
        return normalizedFilePath.slice(normalizedRootPath.length + 1);
      }

      return normalizedFilePath;
    };

    const result = await ripgrepSearch({
      caseInsensitive,
      contextLines,
      glob: globPattern,
      isRegex,
      maxResults,
      outputMode,
      path: searchPath,
      pattern,
      timeoutMs,
    });

    if (!result.success) {
      return JSON.stringify(result);
    }

    if (result.files) {
      result.files = result.files.map(toRelativePath);
    }

    if (result.counts) {
      result.counts = result.counts.map((entry) => ({
        ...entry,
        file: toRelativePath(entry.file),
      }));
    }

    if (result.matches) {
      result.matches = result.matches.map((match) => ({
        ...match,
        file: toRelativePath(match.file),
      }));
    }

    return JSON.stringify(result);
  } catch (error) {
    console.error("[grep] Error:", error);
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// ============================================
// MULTI FILE READ EXECUTOR (Cursor-style parallel reading + Safety)
// ============================================
const multiFileReadExecutor = async (
  args: FileExecutorArgs,
): Promise<string> => {
  if (!isTauri()) {
    return JSON.stringify({
      success: false,
      error: "File operations require desktop app",
    });
  }

  const paths = args.paths as string[];

  if (!Array.isArray(paths) || paths.length === 0) {
    return JSON.stringify({
      success: false,
      error: "paths must be a non-empty array of file paths",
    });
  }

  // Safety: Limit number of files that can be read at once
  const MAX_FILES = 20;
  if (paths.length > MAX_FILES) {
    return JSON.stringify({
      success: false,
      error: `Too many files requested (${paths.length}). Maximum is ${MAX_FILES} files per request to prevent context overflow.`,
    });
  }

  const startTime = Date.now();
  const results: Array<{
    blocked?: boolean;
    content?: string;
    error?: string;
    excluded?: boolean;
    largeFile?: boolean;
    lines?: number;
    path: string;
    requiresLineRange?: boolean;
    size?: number;
    success: boolean;
    suggestedRange?: {
      endLine: number;
      startLine: number;
    };
    truncated?: boolean;
    warning?: string;
  }> = [];

  let totalContentSize = 0;
  let contentLimitReached = false;

  // Resolve every path up-front and run the exclusion gate once. Anything
  // that survives is sent to the Rust batch reader, which fans out across
  // rayon's thread pool — so 20 cold reads happen roughly in the time of
  // the slowest single read instead of the sum of all of them.
  type ResolvedEntry = { path: string; fullPath: string };
  const allowed: ResolvedEntry[] = [];
  const blockedResults: Array<{
    path: string;
    success: false;
    error?: string;
    excluded?: boolean;
  }> = [];

  for (const path of paths) {
    const fullPath = resolvePath(path);
    const exclusionCheck = isPathExcluded(path);
    if (exclusionCheck.excluded) {
      console.warn("[multi_file_read] Excluded:", path, exclusionCheck.reason);
      blockedResults.push({
        path,
        success: false,
        error: exclusionCheck.reason,
        excluded: true,
      });
      continue;
    }
    const fullPathCheck = isPathExcluded(fullPath);
    if (fullPathCheck.excluded) {
      console.warn("[multi_file_read] Excluded (full path):", fullPath, fullPathCheck.reason);
      blockedResults.push({
        path,
        success: false,
        error: fullPathCheck.reason,
        excluded: true,
      });
      continue;
    }
    allowed.push({ path, fullPath });
  }

  type ReadResult =
    | {
        path: string;
        success: true;
        content: string;
        largeFile: boolean;
        lines: number;
        size: number;
      }
    | {
        path: string;
        success: false;
        error?: string;
        excluded?: boolean;
      };

  const fileResults: ReadResult[] = [...blockedResults];

  if (allowed.length > 0) {
    const { readFilesBatch } = await import("../../lib/file-cache");
    const contentMap = await readFilesBatch(allowed.map((entry) => entry.fullPath));

    for (const entry of allowed) {
      const content = contentMap.get(entry.fullPath);
      if (typeof content !== "string") {
        fileResults.push({
          path: entry.path,
          success: false,
          error: `Failed to read ${entry.fullPath}`,
        });
        continue;
      }

      const lines = splitLines(content);
      const totalLines = lines.length;

      operationLog.logOperation(FsOperationType.Read, entry.path, {
        fullPath: entry.fullPath,
        lines: totalLines,
        size: content.length,
        multiFile: true,
      });

      fileResults.push({
        path: entry.path,
        success: true,
        content,
        largeFile: isLargeFileByLines(totalLines) || content.length > MAX_FILE_SIZE,
        lines: totalLines,
        size: content.length,
      });
    }
  }

  // Process results with content size limit
  for (const result of fileResults) {
    if (result.success) {
      if (result.largeFile) {
        results.push({
          path: result.path,
          success: true,
          content: "",
          lines: result.lines,
          size: result.size,
          largeFile: true,
          requiresLineRange: true,
          warning: `File is too large for multi_file_read (${result.lines} lines, ${result.size} bytes). Use file_read with start_line/end_line.`,
          suggestedRange: {
            startLine: 1,
            endLine: Math.min(DEFAULT_LINE_WINDOW, result.lines ?? DEFAULT_LINE_WINDOW),
          },
        });
        continue;
      }

      const contentSize = result.content.length;

      // Check if adding this file would exceed the limit
      if (totalContentSize + contentSize > MAX_MULTI_FILE_TOTAL_SIZE) {
        if (!contentLimitReached) {
          contentLimitReached = true;
          // Truncate this file to fit remaining space
          const remainingSpace = MAX_MULTI_FILE_TOTAL_SIZE - totalContentSize;
          if (remainingSpace > 1000) {
            results.push({
              path: result.path,
              success: true,
              content: result.content.substring(0, remainingSpace),
              lines: result.lines,
              truncated: true,
            });
            totalContentSize += remainingSpace;
          } else {
            results.push({
              path: result.path,
              success: false,
              error: 'Content limit reached. File skipped to prevent context overflow.',
            });
          }
        } else {
          // Skip remaining files
          results.push({
            path: result.path,
            success: false,
            error: 'Content limit reached. File skipped to prevent context overflow.',
          });
        }
      } else {
        // File fits, add it
        totalContentSize += contentSize;
        results.push({
          path: result.path,
          success: true,
          content: result.content,
          lines: result.lines,
        });
      }
    } else {
      // success: false — narrowed branch carries optional error/excluded.
      results.push({
        path: result.path,
        success: false,
        error: result.error,
        excluded: result.excluded,
      });
    }
  }

  const totalTime = Date.now() - startTime;
  const successCount = results.filter(r => r.success).length;
  const errorCount = results.filter(r => !r.success).length;
  const excludedCount = results.filter(r => r.excluded).length;

  return JSON.stringify({
    success: true,
    filesRead: successCount,
    filesError: errorCount,
    filesExcluded: excludedCount,
    totalFiles: paths.length,
    totalContentSize,
    contentLimitReached,
    totalTime,
    averageTimePerFile: Math.round(totalTime / paths.length),
    files: results,
    ...(contentLimitReached && {
      warning: `Content limit (${MAX_MULTI_FILE_TOTAL_SIZE / 1024 / 1024}MB) reached. Some files were truncated or skipped.`
    }),
  });
};

// ============================================
// SEARCH REPLACE EXECUTOR (Cursor-style: Find exact text and replace)
// ============================================
const searchReplaceExecutor = async (
  args: FileExecutorArgs,
  toolCallId?: string,
): Promise<string> => {
  if (!isTauri()) {
    return JSON.stringify({
      success: false,
      error: "File operations require desktop app",
    });
  }

  const fullPath = resolvePath(args.path);
  const fileName = fullPath.split(/[/\\]/).pop() || args.path;
  const oldString = args.old_string;
  const newString = args.new_string ?? '';
  const replaceAll = args.replace_all === true;

  console.log("[search_replace] Editing file (Cursor-style):", fullPath);

  if (!oldString) {
    return JSON.stringify({
      success: false,
      error: "old_string is required - provide the exact text to find and replace",
    });
  }

  try {
    // NATIVE FAST PATH: read+plan happens in Rust (memchr SIMD scan) and
    // returns both the new content and the original snapshot, so the entire
    // hot loop avoids JS string copies of large files.
    const planResult = await applySearchReplaceNative({
      path: fullPath,
      replacement: toNativeReplacement({
        old_string: oldString,
        new_string: newString,
        replace_all: replaceAll,
      }),
      write: false,
    });

    const failureResponse = renderPlanningFailure(planResult, args, fullPath, "search_replace");
    if (failureResponse) {
      return failureResponse;
    }

    if (planResult.status !== "ok") {
      return JSON.stringify({
        success: false,
        error: "Failed to plan the replacement.",
        path: args.path,
        fullPath,
      });
    }

    const existingContent = planResult.originalContent;
    const newContent = planResult.newContent;
    const replacementsCount = planResult.totalReplacements;
    const linesAdded = planResult.linesAdded;
    const linesRemoved = planResult.linesRemoved;

    // PRE-SAVE VALIDATION: Check syntax before writing
    const validationError = await validateBeforeWrite(newContent, fileName);
    if (validationError) {
      console.warn("[search_replace] Syntax validation failed:", fileName);
      return JSON.stringify({
        success: false,
        error: validationError,
        validation_failed: true,
        path: args.path,
        fullPath,
      });
    }

    // CURSOR-STYLE: Write to disk immediately
    await writeFileContent(fullPath, newContent);
    triggerRefresh();

    // Check if auto-accept is enabled
    const autoAccept = useSettingsStore.getState().autoAcceptChanges;

    if (autoAccept) {
      // Auto-accept mode: File is already written, just update editor if open
      import('../../store/useEditorStore').then(({ useEditorStore }) => {
        const tab = useEditorStore.getState().tabs.find(t => t.path === fullPath);
        if (tab) {
          useEditorStore.getState().reloadTabContent(tab.id, newContent);
        }
      }).catch(() => { });

      operationLog.logOperation(FsOperationType.Edit, args.path, {
        fullPath,
        pending: false,
        autoAccepted: true,
        replacements: replacementsCount,
        linesAdded,
        linesRemoved,
      });

      return JSON.stringify({
        success: true,
        pending: false,
        message: `Replaced ${replacementsCount} occurrence(s) in ${args.path}`,
        path: args.path,
        fullPath,
        replacements: replacementsCount,
        linesAdded,
        linesRemoved,
      });
    }

    // Import pending changes store (only when NOT auto-accept)
    const { usePendingChangesStore } = await import('../../store/usePendingChangesStore');

    // Track the change for potential rollback
    const changeId = usePendingChangesStore.getState().addChange({
      filePath: fullPath,
      fileName,
      content: newContent,
      originalContent: existingContent, // Store original for revert on reject
      operation: 'patch',
      toolCallId: toolCallId || '',
    });

    // Automatically open the file in the editor so the user sees the change
    import('../../store/useEditorStore').then(({ useEditorStore }) => {
      const ext = fileName.split('.').pop()?.toLowerCase() || '';
      const langMap: Record<string, string> = {
        'ts': 'typescript', 'tsx': 'typescript',
        'js': 'javascript', 'jsx': 'javascript',
        'json': 'json', 'css': 'css', 'scss': 'scss',
        'html': 'html', 'md': 'markdown',
        'rs': 'rust', 'toml': 'toml',
        'yaml': 'yaml', 'yml': 'yaml',
        'py': 'python', 'go': 'go',
      };
      const language = langMap[ext] || 'plaintext';
      useEditorStore.getState().openFile(fullPath, fileName, newContent, language);
    });

    // Log the edit operation
    operationLog.logOperation(FsOperationType.Edit, args.path, {
      fullPath,
      pending: true,
      changeId,
      replacements: replacementsCount,
      linesAdded,
      linesRemoved,
    });

    return JSON.stringify({
      success: true,
      pending: true,
      changeId,
      message: `Replaced ${replacementsCount} occurrence(s) in ${args.path} (pending approval)`,
      path: args.path,
      fullPath,
      replacements: replacementsCount,
      linesAdded,
      linesRemoved,
    });
  } catch (error) {
    console.error("[search_replace] Error:", error);
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// ============================================
// MULTI SEARCH REPLACE EXECUTOR (Batch replacements in one file)
// ============================================
const multiSearchReplaceExecutor = async (
  args: FileExecutorArgs,
  toolCallId?: string,
): Promise<string> => {
  if (!isTauri()) {
    return JSON.stringify({
      success: false,
      error: "File operations require desktop app",
    });
  }

  const fullPath = resolvePath(args.path);
  const fileName = fullPath.split(/[/\\]/).pop() || args.path;
  const replacements = args.replacements as SearchReplaceReplacement[];

  console.log("[multi_search_replace] Editing file with batch replacements:", fullPath);

  if (!replacements || !Array.isArray(replacements) || replacements.length === 0) {
    return JSON.stringify({
      success: false,
      error: "replacements must be a non-empty array of {old_string, new_string} objects",
    });
  }

  // Validate each replacement
  for (let i = 0; i < replacements.length; i++) {
    const rep = replacements[i];
    if (!rep.old_string) {
      return JSON.stringify({
        success: false,
        error: `Replacement ${i + 1}: old_string is required`,
      });
    }

    if (typeof rep.new_string !== "string") {
      return JSON.stringify({
        success: false,
        error: `Replacement ${i + 1}: new_string is required`,
      });
    }
  }

  try {
    // NATIVE FAST PATH: full atomic batch plan executed in Rust. The entire
    // file content stays on the Rust side until we know the plan succeeded;
    // we only ship the new content back over IPC if everything validated.
    const planResult = await applyMultiSearchReplaceNative({
      path: fullPath,
      replacements: replacements.map(toNativeReplacement),
      write: false,
    });

    const failureResponse = renderPlanningFailure(
      planResult,
      args,
      fullPath,
      "multi_search_replace",
    );
    if (failureResponse) {
      return failureResponse;
    }

    if (planResult.status !== "ok") {
      return JSON.stringify({
        success: false,
        error: "Failed to plan batch replacements.",
        path: args.path,
        fullPath,
      });
    }

    const originalContent = planResult.originalContent;
    const newContent = planResult.newContent;
    const totalReplacements = planResult.totalReplacements;
    const totalLinesAdded = planResult.linesAdded;
    const totalLinesRemoved = planResult.linesRemoved;
    const replacementDetails = planResult.replacementDetails;

    // PRE-SAVE VALIDATION: Check syntax before writing
    const validationError = await validateBeforeWrite(newContent, fileName);
    if (validationError) {
      console.warn("[multi_search_replace] Syntax validation failed:", fileName);
      return JSON.stringify({
        success: false,
        error: validationError,
        validation_failed: true,
        path: args.path,
        fullPath,
        hint: "All changes have been rolled back due to syntax errors.",
      });
    }

    // CURSOR-STYLE: Write to disk immediately
    await writeFileContent(fullPath, newContent);
    triggerRefresh();

    // Check if auto-accept is enabled
    const autoAccept = useSettingsStore.getState().autoAcceptChanges;

    if (autoAccept) {
      // Auto-accept mode: File is already written, just update editor if open
      import('../../store/useEditorStore').then(({ useEditorStore }) => {
        const tab = useEditorStore.getState().tabs.find(t => t.path === fullPath);
        if (tab) {
          useEditorStore.getState().reloadTabContent(tab.id, newContent);
        }
      }).catch(() => { });

      operationLog.logOperation(FsOperationType.Edit, args.path, {
        fullPath,
        pending: false,
        autoAccepted: true,
        replacements: totalReplacements,
        batchSize: replacements.length,
        linesAdded: totalLinesAdded,
        linesRemoved: totalLinesRemoved,
      });

      return JSON.stringify({
        success: true,
        pending: false,
        message: `Applied ${replacements.length} replacement(s) with ${totalReplacements} total change(s) in ${args.path}`,
        path: args.path,
        fullPath,
        replacementsRequested: replacements.length,
        results: replacementDetails,
        totalReplacements,
        linesAdded: totalLinesAdded,
        linesRemoved: totalLinesRemoved,
      });
    }

    // Import pending changes store (only when NOT auto-accept)
    const { usePendingChangesStore } = await import('../../store/usePendingChangesStore');

    // Track the change for potential rollback
    const changeId = usePendingChangesStore.getState().addChange({
      filePath: fullPath,
      fileName,
      content: newContent,
      originalContent, // Store original for revert on reject
      operation: 'patch',
      toolCallId: toolCallId || '',
    });

    // Automatically open the file in the editor so the user sees the change
    import('../../store/useEditorStore').then(({ useEditorStore }) => {
      const ext = fileName.split('.').pop()?.toLowerCase() || '';
      const langMap: Record<string, string> = {
        'ts': 'typescript', 'tsx': 'typescript',
        'js': 'javascript', 'jsx': 'javascript',
        'json': 'json', 'css': 'css', 'scss': 'scss',
        'html': 'html', 'md': 'markdown',
        'rs': 'rust', 'toml': 'toml',
        'yaml': 'yaml', 'yml': 'yaml',
        'py': 'python', 'go': 'go',
      };
      const language = langMap[ext] || 'plaintext';
      useEditorStore.getState().openFile(fullPath, fileName, newContent, language);
    });

    // Log the edit operation
    operationLog.logOperation(FsOperationType.Edit, args.path, {
      fullPath,
      pending: true,
      changeId,
      replacements: totalReplacements,
      batchSize: replacements.length,
      linesAdded: totalLinesAdded,
      linesRemoved: totalLinesRemoved,
    });

    return JSON.stringify({
      success: true,
      pending: true,
      changeId,
      message: `Applied ${replacements.length} replacement(s) with ${totalReplacements} total change(s) in ${args.path} (pending approval)`,
      path: args.path,
      fullPath,
      replacementsRequested: replacements.length,
      results: replacementDetails,
      totalReplacements,
      linesAdded: totalLinesAdded,
      linesRemoved: totalLinesRemoved,
    });
  } catch (error) {
    console.error("[multi_search_replace] Error:", error);
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// ============================================
// REGISTER ENHANCED FILE EXECUTORS
// ============================================
export const registerEnhancedFileExecutors = (): void => {
  console.log("[FileExecutors] Registering enhanced executors with operation logging");

  toolRegistry.registerExecutor("file_create", asToolExecutor(fileCreateExecutor));
  toolRegistry.registerExecutor("file_read", asToolExecutor(fileReadExecutor));
  toolRegistry.registerExecutor("file_write", asToolExecutor(fileWriteExecutor));
  toolRegistry.registerExecutor("search_replace", asToolExecutor(searchReplaceExecutor));
  toolRegistry.registerExecutor(
    "multi_search_replace",
    asToolExecutor(multiSearchReplaceExecutor),
  );
  toolRegistry.registerExecutor("file_delete", asToolExecutor(fileDeleteExecutor));
  toolRegistry.registerExecutor("grep", asToolExecutor(grepExecutor));
  toolRegistry.registerExecutor("multi_file_read", asToolExecutor(multiFileReadExecutor));
};

// Maximum content size for a single file read (500KB)
const MAX_FILE_SIZE = 500 * 1024;

// Maximum total content size for multi_file_read (2MB)
const MAX_MULTI_FILE_TOTAL_SIZE = 2 * 1024 * 1024;
