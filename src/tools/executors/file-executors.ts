/**
 * File Tool Executors
 * Implementations for file system tools using Tauri commands
 */

import { toolRegistry } from "../registry";
import {
  isTauri,
  readFileContent,
  writeFileContent,
  createFile,
  deletePath,
} from "../../lib/tauri";
import { resolvePath, getWorkspaceRootPath } from "../utils/path-resolver";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";

// Helper to trigger file tree refresh
const triggerRefresh = () => {
  // Small delay to ensure file system operation completes
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
// FILE CREATE EXECUTOR
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
    triggerRefresh(); // Auto-refresh file tree
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
// FILE READ EXECUTOR
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
    return JSON.stringify({
      success: true,
      path: args.path,
      fullPath,
      content,
      lines: content.split("\n").length,
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
// FILE READ LINES EXECUTOR
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
// FILE WRITE EXECUTOR
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
    const processedContent = processEscapeSequences(args.content);
    await writeFileContent(fullPath, processedContent);
    triggerRefresh(); // Auto-refresh file tree
    return JSON.stringify({
      success: true,
      message: `File written: ${args.path}`,
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
// FILE PATCH EXECUTOR
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
    triggerRefresh(); // Auto-refresh file tree

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
// FILE DELETE EXECUTOR
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
    triggerRefresh(); // Auto-refresh file tree
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
// FILE SEARCH EXECUTOR
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
// GREP EXECUTOR (Ripgrep-style search)
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
  const isRegex = args.is_regex !== false; // Default: true
  const caseInsensitive = args.case_insensitive || false;
  const globPattern = args.glob;
  const contextLines = args.context_lines || 0;
  const maxResults = args.max_results || 50;

  console.log("[grep] Searching:", { searchPath, pattern, outputMode, isRegex });

  try {
    // Build regex
    const flags = caseInsensitive ? "gi" : "g";
    const regex = isRegex
      ? new RegExp(pattern, flags)
      : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);

    // Import Tauri fs module for directory traversal
    const { readDir, readTextFile } = await import("@tauri-apps/plugin-fs");
    const { join } = await import("@tauri-apps/api/path");

    const results: GrepFileResult[] = [];
    let totalMatches = 0;

    // Helper function to check if file matches glob
    const matchesGlob = (filename: string): boolean => {
      if (!globPattern) return true;
      // Simple glob matching
      const patterns = globPattern.split(",").map((p: string) => p.trim());
      return patterns.some((p: string) => {
        const regexPattern = p
          .replace(/\./g, "\\.")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".");
        return new RegExp(`^${regexPattern}$`, "i").test(filename);
      });
    };

    // Helper function to search a single file
    const searchFile = async (filePath: string): Promise<GrepFileResult | null> => {
      try {
        const content = await readTextFile(filePath);
        const lines = content.split("\n");
        const matches: GrepMatch[] = [];

        lines.forEach((line, index) => {
          if (regex.test(line)) {
            regex.lastIndex = 0; // Reset regex
            const match: GrepMatch = {
              file: filePath.replace(rootPath + "\\", "").replace(/\\/g, "/"),
              lineNumber: index + 1,
              content: line.trim(),
            };

            // Add context lines
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
      } catch {
        return null; // Skip files that can't be read
      }
    };

    // Recursive directory search
    const searchDir = async (dirPath: string): Promise<void> => {
      if (totalMatches >= maxResults) return;

      try {
        const entries = await readDir(dirPath);

        for (const entry of entries) {
          if (totalMatches >= maxResults) break;

          const fullPath = await join(dirPath, entry.name);

          // Skip hidden files and common ignore patterns
          if (entry.name.startsWith(".") ||
            entry.name === "node_modules" ||
            entry.name === "dist" ||
            entry.name === "target" ||
            entry.name === ".git") {
            continue;
          }

          if (entry.isDirectory) {
            await searchDir(fullPath);
          } else if (entry.isFile && matchesGlob(entry.name)) {
            const result = await searchFile(fullPath);
            if (result) {
              results.push(result);
              totalMatches += result.count;
            }
          }
        }
      } catch {
        // Skip directories that can't be read
      }
    };

    // Check if path is a file or directory
    try {
      await readDir(searchPath);
      // It's a directory, search recursively
      await searchDir(searchPath);
    } catch {
      // It's a file, search just this file
      const result = await searchFile(searchPath);
      if (result) {
        results.push(result);
        totalMatches = result.count;
      }
    }

    // Format output based on mode
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
      // content mode
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
// REGISTER ALL FILE EXECUTORS
// ============================================
export const registerFileExecutors = (): void => {
  toolRegistry.registerExecutor("file_create", fileCreateExecutor);
  toolRegistry.registerExecutor("file_read", fileReadExecutor);
  toolRegistry.registerExecutor("file_read_lines", fileReadLinesExecutor);
  toolRegistry.registerExecutor("file_write", fileWriteExecutor);
  toolRegistry.registerExecutor("file_patch", filePatchExecutor);
  toolRegistry.registerExecutor("file_delete", fileDeleteExecutor);
  toolRegistry.registerExecutor("file_exists", fileExistsExecutor);
  toolRegistry.registerExecutor("file_search", fileSearchExecutor);
  toolRegistry.registerExecutor("grep", grepExecutor);
};
