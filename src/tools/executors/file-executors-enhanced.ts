/**
 * Enhanced File Tool Executors with Operation Logging
 * Integrates operation logging for safety and context awareness
 * Includes pre-save syntax validation to catch errors before writing
 * Includes undo/redo integration for AI-made changes
 */
import { deletePath, isTauri, readDirectory, readFileContent, writeFileContent } from "../../lib/tauri";
import { formatValidationForAgent, supportsValidation, validateSyntax } from "../../services/syntax-validator";
// Dynamic import of useUndoRedoStore used in file_create and file_write
import { useSettingsStore } from "../../store/useSettingsStore";
import { FsOperationType, operationLog } from "../operation-log";
import { toolRegistry } from "../registry";
import { isPathExcluded } from "../utils/excluded-paths";
import { getWorkspaceRootPath, resolvePath } from "../utils/path-resolver";

interface GrepFileResult {
  count: number;
  file: string;
  matches: GrepMatch[];
}

// ============================================
// GREP EXECUTOR (Ripgrep-style search with logging)
// ============================================
interface GrepMatch {
  afterContext?: string[];
  beforeContext?: string[];
  content: string;
  file: string;
  lineNumber: number;
}

// Helper to convert escape sequences to actual characters
const processEscapeSequences = (content: string): string => {
  if (!content) return content;
  return content
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\\\/g, '\\');
};

// NO-OP: Rust file watcher handles refresh via fs-changed events
const triggerRefresh = () => { };

// Helper to validate file content before writing
// Returns null if valid, or error message if invalid
const validateBeforeWrite = (content: string, filename: string): string | null => {
  // Check if syntax validation is enabled in settings
  const syntaxValidationEnabled = useSettingsStore.getState().syntaxValidationEnabled;

  if (!syntaxValidationEnabled) {
    return null; // Validation disabled by user
  }

  // Check if this file type supports validation
  if (!supportsValidation(filename)) {
    return null; // No validation for this file type
  }

  const result = validateSyntax(content, filename);
  if (!result.valid) {
    return formatValidationForAgent(result, filename);
  }

  return null; // Valid
};

// ============================================
// FILE CREATE EXECUTOR (Cursor-style: Write immediately, revert on reject)
// ============================================
const fileCreateExecutor = async (
  args: Record<string, any>,
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
  console.log("[file_create] Writing file (Cursor-style):", fullPath);

  try {
    const processedContent = args.content ? processEscapeSequences(args.content) : '';

    // PRE-SAVE VALIDATION: Check syntax before writing
    const validationError = validateBeforeWrite(processedContent, fileName);
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
  args: Record<string, any>,
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
const fileReadExecutor = async (args: Record<string, any>): Promise<string> => {
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
    const totalLines = content.split("\n").length;

    // Safety check: Warn if file is very large
    if (content.length > MAX_FILE_SIZE) {
      console.warn(`[file_read] Large file warning: ${content.length} bytes`);
      return JSON.stringify({
        success: true,
        path: args.path,
        fullPath,
        content: content.substring(0, MAX_FILE_SIZE),
        totalLines,
        truncated: true,
        warning: `File truncated to ${MAX_FILE_SIZE} bytes to prevent context overflow. Original size: ${content.length} bytes.`,
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
  args: Record<string, any>,
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
    const processedContent = processEscapeSequences(args.content);

    // PRE-SAVE VALIDATION: Check syntax before writing
    const validationError = validateBeforeWrite(processedContent, fileName);
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
const grepExecutor = async (args: Record<string, any>): Promise<string> => {
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

  try {
    const flags = caseInsensitive ? "i" : "";
    const regex = isRegex
      ? new RegExp(pattern, flags)
      : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);

    const results: GrepFileResult[] = [];
    let totalMatches = 0;

    const matchesGlob = (filename: string): boolean => {
      if (!globPattern) return true;
      const patterns = globPattern.split(",").map((p: string) => p.trim());
      return patterns.some((p: string) => {
        const regexPattern = p
          .replace(/\./g, "\\.")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".");
        return new RegExp(`^${regexPattern}$`, "i").test(filename);
      });
    };

    const searchFile = async (filePath: string): Promise<GrepFileResult | null> => {
      try {
        const content = await readFileContent(filePath);
        const lines = content.split("\n");
        const matches: GrepMatch[] = [];

        lines.forEach((line, index) => {
          regex.lastIndex = 0; // Reset before test
          if (regex.test(line)) {
            const match: GrepMatch = {
              file: filePath.replace(rootPath + "\\", "").replace(/\\/g, "/"),
              lineNumber: index + 1,
              content: line.trim(),
            };

            if (contextLines > 0) {
              match.beforeContext = lines
                .slice(Math.max(0, index - contextLines), index)
                .map((l) => l.trim());
              match.afterContext = lines
                .slice(index + 1, index + 1 + contextLines)
                .map((l) => l.trim());
            }

            matches.push(match);
          }
        });

        if (matches.length > 0) {
          return {
            file: filePath.replace(rootPath + "\\", "").replace(/\\/g, "/"),
            matches,
            count: matches.length,
          };
        }
        return null;
      } catch (error) {
        // Silently skip files that can't be read
        return null;
      }
    };

    // Comprehensive ignore list for grep searches
    const shouldIgnore = (name: string): boolean => {
      const ignorePatterns = [
        // Hidden files and folders
        /^\./,
        // Dependencies
        'node_modules',
        'bower_components',
        'vendor',
        'packages',
        // Build outputs
        'dist',
        'build',
        'out',
        'target',
        '.next',
        '.nuxt',
        '.output',
        '.vercel',
        '.netlify',
        // Lock files and large data files
        'package-lock.json',
        'yarn.lock',
        'pnpm-lock.yaml',
        'composer.lock',
        'Cargo.lock',
        'Gemfile.lock',
        'poetry.lock',
        'Pipfile.lock',
        // Version control
        '.git',
        '.svn',
        '.hg',
        // IDE and editor folders
        '.vscode',
        '.idea',
        '.vs',
        // Cache folders
        '.cache',
        '.tmp',
        'tmp',
        'temp',
        '.temp',
        '__pycache__',
        '.pytest_cache',
        '.mypy_cache',
        // OS files
        '.DS_Store',
        'Thumbs.db',
        // Test coverage
        'coverage',
        '.coverage',
        '.nyc_output',
        // Documentation builds
        'docs/_build',
        'site',
        // Other common ignores
        'logs',
        '*.log',
      ];

      return ignorePatterns.some(pattern => {
        if (pattern instanceof RegExp) {
          return pattern.test(name);
        }
        return name === pattern || name.endsWith(pattern);
      });
    };

    const searchDir = async (dirPath: string): Promise<void> => {
      if (totalMatches >= maxResults) return;

      try {
        const entries = await readDirectory(dirPath);

        for (const entry of entries) {
          if (totalMatches >= maxResults) break;

          const fullPath = entry.path;

          // Skip ignored files and folders
          if (shouldIgnore(entry.name)) {
            continue;
          }

          if (entry.is_dir) {
            await searchDir(fullPath);
          } else if (entry.is_file && matchesGlob(entry.name)) {
            const result = await searchFile(fullPath);
            if (result) {
              results.push(result);
              totalMatches += result.count;
            }
          }
        }
      } catch (error) {
        // Silently skip directories that can't be read
      }
    };

    // Check if path is a directory by trying to read it
    let isDirectory = false;
    try {
      await readDirectory(searchPath);
      isDirectory = true;
    } catch {
      isDirectory = false;
    }

    if (isDirectory) {
      await searchDir(searchPath);
    } else {
      const result = await searchFile(searchPath);
      if (result) {
        results.push(result);
        totalMatches = result.count;
      }
    }

    if (outputMode === "files_with_matches") {
      return JSON.stringify({
        success: true,
        pattern,
        totalFiles: results.length,
        files: results.map((r) => r.file),
      });
    } else if (outputMode === "count") {
      return JSON.stringify({
        success: true,
        pattern,
        totalMatches,
        counts: results.map((r) => ({ file: r.file, count: r.count })),
      });
    } else {
      const allMatches = results.flatMap((r) => r.matches).slice(0, maxResults);
      return JSON.stringify({
        success: true,
        pattern,
        totalMatches: Math.min(totalMatches, maxResults),
        totalFiles: results.length,
        matches: allMatches,
        truncated: totalMatches > maxResults,
      });
    }
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
  args: Record<string, any>,
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
    path: string;
    success: boolean;
    content?: string;
    lines?: number;
    error?: string;
    blocked?: boolean;
    truncated?: boolean;
    excluded?: boolean;
  }> = [];

  let totalContentSize = 0;
  let contentLimitReached = false;

  // Read all files in parallel
  const promises = paths.map(async (path) => {
    // Safety check: Block reading from excluded directories/files
    const exclusionCheck = isPathExcluded(path);
    if (exclusionCheck.excluded) {
      console.warn("[multi_file_read] Excluded:", path, exclusionCheck.reason);
      return {
        path,
        success: false,
        error: exclusionCheck.reason,
        excluded: true,
      };
    }

    const fullPath = resolvePath(path);

    // Also check the full resolved path
    const fullPathCheck = isPathExcluded(fullPath);
    if (fullPathCheck.excluded) {
      console.warn("[multi_file_read] Excluded (full path):", fullPath, fullPathCheck.reason);
      return {
        path,
        success: false,
        error: fullPathCheck.reason,
        excluded: true,
      };
    }
    try {
      const content = await readFileContent(fullPath);
      const totalLines = content.split("\n").length;

      // Log the read operation
      operationLog.logOperation(FsOperationType.Read, path, {
        fullPath,
        lines: totalLines,
        size: content.length,
        multiFile: true,
      });

      return {
        path,
        success: true,
        content,
        lines: totalLines,
        size: content.length,
      };
    } catch (error) {
      return {
        path,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  const fileResults = await Promise.all(promises);

  // Process results with content size limit
  for (const result of fileResults) {
    if (result.success && 'content' in result && result.content) {
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
      // Error or excluded file
      results.push({
        path: result.path,
        success: result.success,
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
  args: Record<string, any>,
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
    const existingContent = await readFileContent(fullPath);

    // Check if old_string exists in the file
    const occurrences = existingContent.split(oldString).length - 1;

    if (occurrences === 0) {
      return JSON.stringify({
        success: false,
        error: `Could not find the specified text in ${args.path}. Make sure old_string matches EXACTLY (including whitespace, indentation, and newlines).`,
        path: args.path,
        fullPath,
        hint: "The text to find must match exactly. Check for differences in whitespace, indentation, or line endings.",
      });
    }

    if (occurrences > 1 && !replaceAll) {
      return JSON.stringify({
        success: false,
        error: `Found ${occurrences} occurrences of the text. The old_string must be unique. Either include more context to make it unique, or set replace_all=true to replace all occurrences.`,
        path: args.path,
        fullPath,
        occurrences,
        hint: "Add more surrounding code to old_string to make it unique in the file.",
      });
    }

    // Calculate lines added/removed
    const oldLines = oldString.split('\n').length;
    const newLines = newString.split('\n').length;
    const linesRemoved = oldLines * (replaceAll ? occurrences : 1);
    const linesAdded = newLines * (replaceAll ? occurrences : 1);

    // Perform the replacement
    let newContent: string;
    if (replaceAll) {
      newContent = existingContent.split(oldString).join(newString);
    } else {
      newContent = existingContent.replace(oldString, newString);
    }

    // PRE-SAVE VALIDATION: Check syntax before writing
    const validationError = validateBeforeWrite(newContent, fileName);
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
        replacements: replaceAll ? occurrences : 1,
        linesAdded,
        linesRemoved,
      });

      return JSON.stringify({
        success: true,
        pending: false,
        message: `Replaced ${replaceAll ? occurrences : 1} occurrence(s) in ${args.path}`,
        path: args.path,
        fullPath,
        replacements: replaceAll ? occurrences : 1,
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
      replacements: replaceAll ? occurrences : 1,
      linesAdded,
      linesRemoved,
    });

    return JSON.stringify({
      success: true,
      pending: true,
      changeId,
      message: `Replaced ${replaceAll ? occurrences : 1} occurrence(s) in ${args.path} (pending approval)`,
      path: args.path,
      fullPath,
      replacements: replaceAll ? occurrences : 1,
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
interface ReplacementItem {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

const multiSearchReplaceExecutor = async (
  args: Record<string, any>,
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
  const replacements = args.replacements as ReplacementItem[];

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
  }

  try {
    const originalContent = await readFileContent(fullPath);
    let newContent = originalContent;
    let totalReplacements = 0;
    let totalLinesAdded = 0;
    let totalLinesRemoved = 0;
    const replacementDetails: Array<{
      index: number;
      found: boolean;
      occurrences: number;
      replaced: number;
    }> = [];

    // Apply each replacement in order
    for (let i = 0; i < replacements.length; i++) {
      const rep = replacements[i];
      const oldString = rep.old_string;
      const newString = rep.new_string ?? '';
      const replaceAll = rep.replace_all === true;

      // Check if old_string exists in current content
      const occurrences = newContent.split(oldString).length - 1;

      if (occurrences === 0) {
        return JSON.stringify({
          success: false,
          error: `Replacement ${i + 1}: Could not find the specified text. Make sure old_string matches EXACTLY (including whitespace, indentation, and newlines).`,
          path: args.path,
          fullPath,
          failedAt: i + 1,
          replacementsApplied: i,
          hint: "All changes have been rolled back. Fix the old_string and try again.",
        });
      }

      if (occurrences > 1 && !replaceAll) {
        return JSON.stringify({
          success: false,
          error: `Replacement ${i + 1}: Found ${occurrences} occurrences of the text. Either include more context to make it unique, or set replace_all=true for this replacement.`,
          path: args.path,
          fullPath,
          failedAt: i + 1,
          occurrences,
          replacementsApplied: i,
          hint: "All changes have been rolled back. Fix the old_string to be unique or use replace_all.",
        });
      }

      // Calculate lines added/removed
      const oldLines = oldString.split('\n').length;
      const newLines = newString.split('\n').length;
      const replacedCount = replaceAll ? occurrences : 1;
      totalLinesRemoved += oldLines * replacedCount;
      totalLinesAdded += newLines * replacedCount;
      totalReplacements += replacedCount;

      // Apply the replacement
      if (replaceAll) {
        newContent = newContent.split(oldString).join(newString);
      } else {
        newContent = newContent.replace(oldString, newString);
      }

      replacementDetails.push({
        index: i + 1,
        found: true,
        occurrences,
        replaced: replacedCount,
      });
    }

    // PRE-SAVE VALIDATION: Check syntax before writing
    const validationError = validateBeforeWrite(newContent, fileName);
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

  toolRegistry.registerExecutor("file_create", fileCreateExecutor);
  toolRegistry.registerExecutor("file_read", fileReadExecutor);
  toolRegistry.registerExecutor("file_write", fileWriteExecutor);
  toolRegistry.registerExecutor("search_replace", searchReplaceExecutor);
  toolRegistry.registerExecutor("multi_search_replace", multiSearchReplaceExecutor);
  toolRegistry.registerExecutor("file_delete", fileDeleteExecutor);
  toolRegistry.registerExecutor("grep", grepExecutor);
  toolRegistry.registerExecutor("multi_file_read", multiFileReadExecutor);
};

// Maximum content size for a single file read (500KB)
const MAX_FILE_SIZE = 500 * 1024;

// Maximum total content size for multi_file_read (2MB)
const MAX_MULTI_FILE_TOTAL_SIZE = 2 * 1024 * 1024;
