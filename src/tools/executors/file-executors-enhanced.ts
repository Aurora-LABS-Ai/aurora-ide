/**
 * Enhanced File Tool Executors with Operation Logging
 * Integrates operation logging for safety and context awareness
 */

import { toolRegistry } from "../registry";
import {
  isTauri,
  readFileContent,
  writeFileContent,
  createFile,
  deletePath,
  readDirectory,
} from "../../lib/tauri";
import { resolvePath, getWorkspaceRootPath } from "../utils/path-resolver";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import { operationLog, FsOperationType } from "../operation-log";

// Helper to trigger file tree refresh
const triggerRefresh = () => {
  setTimeout(() => {
    useWorkspaceStore.getState().refreshDirectory();
  }, 100);
};

// Helper to convert escape sequences to actual characters
const processEscapeSequences = (content: string): string => {
  if (!content) return content;
  return content
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\\\/g, '\\');
};

// ============================================
// FILE READ EXECUTOR (Enhanced with Logging)
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

  try {
    const content = await readFileContent(fullPath);
    const lines = content.split("\n").length;

    // Log the read operation
    operationLog.logOperation(FsOperationType.Read, args.path, {
      fullPath,
      lines,
      size: content.length,
    });

    return JSON.stringify({
      success: true,
      path: args.path,
      fullPath,
      content,
      lines,
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
// FILE READ LINES EXECUTOR (Enhanced)
// ============================================
const fileReadLinesExecutor = async (
  args: Record<string, any>,
): Promise<string> => {
  if (!isTauri()) {
    return JSON.stringify({
      success: false,
      error: "File operations require desktop app",
    });
  }

  const fullPath = resolvePath(args.path);

  try {
    const content = await readFileContent(fullPath);
    const lines = content.split("\n");
    const startIdx = Math.max(0, (args.start_line || 1) - 1);
    const endIdx = args.end_line
      ? Math.min(lines.length, args.end_line)
      : lines.length;

    const selectedLines = lines.slice(startIdx, endIdx);
    const numberedLines = selectedLines.map((line, i) => ({
      lineNumber: startIdx + i + 1,
      content: line,
    }));

    // Log the read operation
    operationLog.logOperation(FsOperationType.Read, args.path, {
      fullPath,
      totalLines: lines.length,
      readLines: selectedLines.length,
      range: `${args.start_line || 1}-${endIdx}`,
    });

    return JSON.stringify({
      success: true,
      path: args.path,
      fullPath,
      startLine: args.start_line,
      endLine: endIdx,
      totalLines: lines.length,
      lines: numberedLines,
    });
  } catch (error) {
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// ============================================
// FILE CREATE EXECUTOR (Enhanced with Logging)
// ============================================
const fileCreateExecutor = async (
  args: Record<string, any>,
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
  console.log("[file_create] Creating file:", fullPath);

  try {
    await createFile(fullPath);
    if (args.content) {
      const processedContent = processEscapeSequences(args.content);
      await writeFileContent(fullPath, processedContent);
    }

    // Log the create operation
    operationLog.logOperation(FsOperationType.Create, args.path, {
      fullPath,
      hasContent: !!args.content,
      bytes: args.content?.length || 0,
      lines: args.content ? processEscapeSequences(args.content).split("\n").length : 0,
    });

    triggerRefresh();

    return JSON.stringify({
      success: true,
      message: `File created: ${args.path}`,
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
// FILE WRITE EXECUTOR (Enhanced with Safety Check)
// ============================================
const fileWriteExecutor = async (
  args: Record<string, any>,
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
  console.log("[file_write] Writing file:", fullPath);

  try {
    // Check if file exists to determine if it's create or update
    let fileExists = false;
    try {
      await readFileContent(fullPath);
      fileExists = true;
    } catch {
      fileExists = false;
    }

    const processedContent = processEscapeSequences(args.content);
    await writeFileContent(fullPath, processedContent);

    // Log the write operation
    operationLog.logOperation(FsOperationType.Write, args.path, {
      fullPath,
      action: fileExists ? 'updated' : 'created',
      bytes: args.content.length,
      lines: processedContent.split("\n").length,
    });

    triggerRefresh();

    return JSON.stringify({
      success: true,
      message: `File ${fileExists ? 'updated' : 'created'}: ${args.path}`,
      path: args.path,
      fullPath,
      bytes: args.content.length,
    });
  } catch (error) {
    console.error("[file_write] Error:", error);
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// ============================================
// FILE PATCH EXECUTOR (Enhanced with Validation)
// ============================================
const filePatchExecutor = async (
  args: Record<string, any>,
): Promise<string> => {
  if (!isTauri()) {
    return JSON.stringify({
      success: false,
      error: "File operations require desktop app",
    });
  }

  const fullPath = resolvePath(args.path);

  // Validate: file must have been read first (optional safety check)
  // Uncomment to enforce read-before-edit:
  // try {
  //   operationLog.validateEditPermission(args.path);
  // } catch (error) {
  //   return JSON.stringify({
  //     success: false,
  //     error: (error as Error).message,
  //   });
  // }

  try {
    const existingContent = await readFileContent(fullPath);
    const lines = existingContent.split("\n");

    const startIdx = Math.max(0, (args.start_line || 1) - 1);
    const endIdx = Math.min(lines.length, args.end_line || args.start_line);

    const newLines = (args.content || "").split("\n");
    const patchedLines = [
      ...lines.slice(0, startIdx),
      ...newLines,
      ...lines.slice(endIdx),
    ];

    const patchedContent = patchedLines.join("\n");
    await writeFileContent(fullPath, patchedContent);

    // Log the edit operation
    operationLog.logOperation(FsOperationType.Edit, args.path, {
      fullPath,
      linesReplaced: endIdx - startIdx,
      linesInserted: newLines.length,
      startLine: args.start_line,
      endLine: args.end_line,
    });

    triggerRefresh();

    return JSON.stringify({
      success: true,
      message: `File patched: ${args.path}`,
      path: args.path,
      fullPath,
      linesReplaced: endIdx - startIdx,
      linesInserted: newLines.length,
    });
  } catch (error) {
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
// FILE EXISTS EXECUTOR
// ============================================
const fileExistsExecutor = async (
  args: Record<string, any>,
): Promise<string> => {
  if (!isTauri()) {
    return JSON.stringify({
      success: false,
      error: "File operations require desktop app",
    });
  }

  const fullPath = resolvePath(args.path);

  try {
    await readFileContent(fullPath);
    return JSON.stringify({
      success: true,
      exists: true,
      path: args.path,
      fullPath,
    });
  } catch {
    return JSON.stringify({
      success: true,
      exists: false,
      path: args.path,
      fullPath,
    });
  }
};

// ============================================
// FILE SEARCH EXECUTOR (Enhanced with Read Logging)
// ============================================
const fileSearchExecutor = async (
  args: Record<string, any>,
): Promise<string> => {
  if (!isTauri()) {
    return JSON.stringify({
      success: false,
      error: "File operations require desktop app",
    });
  }

  const fullPath = resolvePath(args.path);

  try {
    const content = await readFileContent(fullPath);
    const lines = content.split("\n");

    // Log the read operation (search is a form of reading)
    operationLog.logOperation(FsOperationType.Read, args.path, {
      fullPath,
      operation: 'search',
      pattern: args.pattern,
    });

    const pattern = args.pattern || "";
    const regex = args.is_regex
      ? new RegExp(pattern, "gi")
      : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");

    const matches: Array<{
      lineNumber: number;
      content: string;
      matches: string[];
    }> = [];

    lines.forEach((line, index) => {
      const lineMatches = line.match(regex);
      if (lineMatches) {
        matches.push({
          lineNumber: index + 1,
          content: line,
          matches: lineMatches,
        });
      }
    });

    return JSON.stringify({
      success: true,
      path: args.path,
      fullPath,
      pattern: args.pattern,
      totalMatches: matches.length,
      matches,
    });
  } catch (error) {
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// ============================================
// GREP EXECUTOR (Ripgrep-style search with logging)
// ============================================
interface GrepMatch {
  file: string;
  lineNumber: number;
  content: string;
  beforeContext?: string[];
  afterContext?: string[];
}

interface GrepFileResult {
  file: string;
  matches: GrepMatch[];
  count: number;
}

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
// MULTI FILE READ EXECUTOR (Cursor-style parallel reading)
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

  const startTime = Date.now();
  const results: Array<{
    path: string;
    success: boolean;
    content?: string;
    lines?: number;
    error?: string;
  }> = [];

  // Read all files in parallel
  const promises = paths.map(async (path) => {
    const fullPath = resolvePath(path);
    try {
      const content = await readFileContent(fullPath);
      const lines = content.split("\n").length;

      // Log the read operation
      operationLog.logOperation(FsOperationType.Read, path, {
        fullPath,
        lines,
        size: content.length,
        multiFile: true,
      });

      return {
        path,
        success: true,
        content,
        lines,
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
  results.push(...fileResults);

  const totalTime = Date.now() - startTime;
  const successCount = results.filter(r => r.success).length;
  const errorCount = results.filter(r => !r.success).length;

  return JSON.stringify({
    success: true,
    filesRead: successCount,
    filesError: errorCount,
    totalFiles: paths.length,
    totalTime,
    averageTimePerFile: Math.round(totalTime / paths.length),
    files: results,
  });
};

// ============================================
// REGISTER ENHANCED FILE EXECUTORS
// ============================================
export const registerEnhancedFileExecutors = (): void => {
  console.log("[FileExecutors] Registering enhanced executors with operation logging");

  toolRegistry.registerExecutor("file_create", fileCreateExecutor);
  toolRegistry.registerExecutor("file_read", fileReadExecutor);
  toolRegistry.registerExecutor("file_read_lines", fileReadLinesExecutor);
  toolRegistry.registerExecutor("file_write", fileWriteExecutor);
  toolRegistry.registerExecutor("file_patch", filePatchExecutor);
  toolRegistry.registerExecutor("file_delete", fileDeleteExecutor);
  toolRegistry.registerExecutor("file_exists", fileExistsExecutor);
  toolRegistry.registerExecutor("file_search", fileSearchExecutor);
  toolRegistry.registerExecutor("grep", grepExecutor);
  toolRegistry.registerExecutor("multi_file_read", multiFileReadExecutor);
};
