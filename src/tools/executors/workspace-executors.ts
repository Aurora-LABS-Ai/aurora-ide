/**
 * Workspace Tool Executors
 * Implementations for workspace tools using Tauri commands
 */

import { toolRegistry } from "../registry";
import {
  isTauri,
  readDirectory,
  readFileContent,
  createFolder,
  deletePath,
} from "../../lib/tauri";
import { resolvePath, getWorkspaceRootPath } from "../utils/path-resolver";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";

// Helper to trigger file tree refresh
const triggerRefresh = () => {
  setTimeout(() => {
    useWorkspaceStore.getState().refreshDirectory();
  }, 100);
};

// ============================================
// WORKSPACE TREE EXECUTOR
// ============================================
const workspaceTreeExecutor = async (
  args: Record<string, any>,
): Promise<string> => {
  if (!isTauri()) {
    return JSON.stringify({
      success: false,
      error: "Workspace operations require desktop app",
    });
  }

  const rootPath = getWorkspaceRootPath();
  if (!rootPath) {
    return JSON.stringify({ success: false, error: "No workspace open" });
  }

  const targetPath = resolvePath(args.path);
  const maxDepth = args.depth ?? 3;
  const includeHidden = args.include_hidden ?? false;

  try {
    const buildTree = async (
      dirPath: string,
      currentDepth: number,
    ): Promise<any[]> => {
      if (maxDepth !== -1 && currentDepth >= maxDepth) {
        return [];
      }

      const entries = await readDirectory(dirPath);
      const tree: any[] = [];

      for (const entry of entries) {
        if (!includeHidden && entry.name.startsWith(".")) {
          continue;
        }

        const node: any = {
          name: entry.name,
          path: entry.path,
          type: entry.is_dir ? "directory" : "file",
        };

        if (entry.is_dir) {
          node.children = await buildTree(entry.path, currentDepth + 1);
        } else if (entry.extension) {
          node.extension = entry.extension;
        }

        tree.push(node);
      }

      return tree;
    };

    const tree = await buildTree(targetPath, 0);

    return JSON.stringify({
      success: true,
      rootPath: targetPath,
      depth: maxDepth,
      tree,
    });
  } catch (error) {
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// ============================================
// WORKSPACE LIST FILES EXECUTOR
// ============================================
const workspaceListFilesExecutor = async (
  args: Record<string, any>,
): Promise<string> => {
  if (!isTauri()) {
    return JSON.stringify({
      success: false,
      error: "Workspace operations require desktop app",
    });
  }

  const rootPath = getWorkspaceRootPath();
  if (!rootPath) {
    return JSON.stringify({ success: false, error: "No workspace open" });
  }

  const targetPath = resolvePath(args.path);

  try {
    const entries = await readDirectory(targetPath);

    let files = entries.map((entry) => ({
      name: entry.name,
      path: entry.path,
      type: entry.is_dir ? "directory" : "file",
      extension: entry.extension,
    }));

    if (args.filter) {
      const filterRegex = new RegExp(
        args.filter
          .replace(/\./g, "\\.")
          .replace(/\*/g, ".*")
          .replace(/\?/g, "."),
      );
      files = files.filter((f) => filterRegex.test(f.name));
    }

    return JSON.stringify({
      success: true,
      path: targetPath,
      count: files.length,
      files,
    });
  } catch (error) {
    return JSON.stringify({
      success: false,
      error: `Directory does not exist: ${targetPath}`,
    });
  }
};

// ============================================
// WORKSPACE FIND FILES EXECUTOR
// ============================================

// Helper to convert glob pattern to regex
const globToRegex = (pattern: string): RegExp => {
  // Handle special glob patterns
  let regexStr = pattern
    // Escape special regex characters except glob wildcards
    .replace(/[.+^${}()|[\]]/g, '\\$&')
    // Handle ** (match any path including /)
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    // Handle * (match anything except /)
    .replace(/\*/g, '[^/\\\\]*')
    // Handle ? (match single character except /)
    .replace(/\?/g, '[^/\\\\]')
    // Restore globstar
    .replace(/{{GLOBSTAR}}/g, '.*');
  
  // If pattern doesn't start with **, anchor it appropriately
  // For patterns like "*.txt", match filename only
  if (!pattern.startsWith('**')) {
    // Match either the full relative path or just the filename
    regexStr = `(^|[/\\\\])${regexStr}$`;
  } else {
    regexStr = `${regexStr}$`;
  }
  
  return new RegExp(regexStr, 'i');
};

const workspaceFindFilesExecutor = async (
  args: Record<string, any>,
): Promise<string> => {
  if (!isTauri()) {
    return JSON.stringify({
      success: false,
      error: "Workspace operations require desktop app",
    });
  }

  const rootPath = getWorkspaceRootPath();
  if (!rootPath) {
    return JSON.stringify({ success: false, error: "No workspace open" });
  }

  const targetPath = resolvePath(args.path);
  const pattern = args.pattern as string;
  const maxResults = args.max_results ?? 100;
  const results: string[] = [];

  // Convert glob pattern to regex
  const patternRegex = globToRegex(pattern);

  try {
    const searchDir = async (dirPath: string): Promise<void> => {
      if (results.length >= maxResults) return;

      let entries: any[];
      try {
        entries = await readDirectory(dirPath);
      } catch {
        return; // Skip directories we can't read
      }

      for (const entry of entries) {
        if (results.length >= maxResults) break;

        // Skip hidden files/folders
        if (entry.name.startsWith(".")) continue;

        // For files, check if pattern matches
        if (!entry.is_dir) {
          const relativePath = entry.path
            .replace(targetPath, "")
            .replace(/^[/\\]/, "")
            .replace(/\\/g, "/"); // Normalize to forward slashes

          if (patternRegex.test(relativePath) || patternRegex.test(entry.name)) {
            results.push(entry.path);
          }
        }

        // Recurse into directories
        if (entry.is_dir) {
          await searchDir(entry.path);
        }
      }
    };

    await searchDir(targetPath);

    return JSON.stringify({
      success: true,
      pattern,
      rootPath: targetPath,
      count: results.length,
      truncated: results.length >= maxResults,
      files: results,
    });
  } catch (error) {
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// ============================================
// WORKSPACE GREP EXECUTOR
// ============================================
const workspaceGrepExecutor = async (
  args: Record<string, any>,
): Promise<string> => {
  if (!isTauri()) {
    return JSON.stringify({
      success: false,
      error: "Workspace operations require desktop app",
    });
  }

  const rootPath = getWorkspaceRootPath();
  if (!rootPath) {
    return JSON.stringify({ success: false, error: "No workspace open" });
  }

  const targetPath = resolvePath(args.path);
  const searchPattern = args.pattern as string;
  const filePattern = args.file_pattern as string | undefined;
  const isRegex = args.is_regex ?? false;
  const caseSensitive = args.case_sensitive ?? false;
  const maxResults = args.max_results ?? 100;

  interface GrepMatch {
    file: string;
    lineNumber: number;
    content: string;
    matches: string[];
  }

  const results: GrepMatch[] = [];

  // Build the search regex
  let searchRegex: RegExp;
  try {
    if (isRegex) {
      searchRegex = new RegExp(searchPattern, caseSensitive ? 'g' : 'gi');
    } else {
      // Escape special regex characters for literal search
      const escaped = searchPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      searchRegex = new RegExp(escaped, caseSensitive ? 'g' : 'gi');
    }
  } catch (e) {
    return JSON.stringify({
      success: false,
      error: `Invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // Build file filter regex if provided
  let fileFilterRegex: RegExp | null = null;
  if (filePattern) {
    fileFilterRegex = globToRegex(filePattern);
  }

  // Text file extensions to search
  const textExtensions = new Set([
    'txt', 'md', 'json', 'js', 'ts', 'jsx', 'tsx', 'css', 'scss', 'less',
    'html', 'htm', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
    'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'py', 'rb', 'php', 'java',
    'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'swift', 'kt', 'scala',
    'sql', 'graphql', 'vue', 'svelte', 'astro', 'mdx', 'log', 'env',
    'gitignore', 'dockerignore', 'editorconfig', 'eslintrc', 'prettierrc',
  ]);

  const isTextFile = (filename: string): boolean => {
    const ext = filename.split('.').pop()?.toLowerCase();
    if (!ext) return false;
    return textExtensions.has(ext);
  };

  try {
    const searchDir = async (dirPath: string): Promise<void> => {
      if (results.length >= maxResults) return;

      let entries: any[];
      try {
        entries = await readDirectory(dirPath);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (results.length >= maxResults) break;

        // Skip hidden files/folders
        if (entry.name.startsWith(".")) continue;

        if (entry.is_dir) {
          await searchDir(entry.path);
        } else if (isTextFile(entry.name)) {
          // Check file pattern filter
          if (fileFilterRegex && !fileFilterRegex.test(entry.name)) {
            continue;
          }

          try {
            const content = await readFileContent(entry.path);
            const lines = content.split('\n');

            for (let i = 0; i < lines.length && results.length < maxResults; i++) {
              const line = lines[i];
              const lineMatches = line.match(searchRegex);

              if (lineMatches) {
                results.push({
                  file: entry.path,
                  lineNumber: i + 1,
                  content: line.length > 200 ? line.substring(0, 200) + '...' : line,
                  matches: [...new Set(lineMatches)],
                });
              }
            }
          } catch {
            // Skip files we can't read
          }
        }
      }
    };

    await searchDir(targetPath);

    return JSON.stringify({
      success: true,
      pattern: searchPattern,
      filePattern: filePattern || '*',
      rootPath: targetPath,
      totalMatches: results.length,
      truncated: results.length >= maxResults,
      matches: results,
    });
  } catch (error) {
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// ============================================
// FOLDER CREATE EXECUTOR
// ============================================
const folderCreateExecutor = async (
  args: Record<string, any>,
): Promise<string> => {
  if (!isTauri()) {
    return JSON.stringify({
      success: false,
      error: "Folder operations require desktop app",
    });
  }

  const rootPath = getWorkspaceRootPath();
  if (!rootPath) {
    return JSON.stringify({ success: false, error: "No workspace open" });
  }

  const targetPath = resolvePath(args.path);

  try {
    await createFolder(targetPath);
    triggerRefresh(); // Auto-refresh file tree
    return JSON.stringify({
      success: true,
      message: `Folder created: ${targetPath}`,
      path: targetPath,
    });
  } catch (error) {
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// ============================================
// FOLDER DELETE EXECUTOR
// ============================================
const folderDeleteExecutor = async (
  args: Record<string, any>,
): Promise<string> => {
  if (!isTauri()) {
    return JSON.stringify({
      success: false,
      error: "Folder operations require desktop app",
    });
  }

  const rootPath = getWorkspaceRootPath();
  if (!rootPath) {
    return JSON.stringify({ success: false, error: "No workspace open" });
  }

  const targetPath = resolvePath(args.path);

  try {
    await deletePath(targetPath);
    triggerRefresh(); // Auto-refresh file tree
    return JSON.stringify({
      success: true,
      message: `Folder deleted: ${targetPath}`,
      path: targetPath,
    });
  } catch (error) {
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// ============================================
// WORKSPACE INFO EXECUTOR
// ============================================
const workspaceInfoExecutor = async (
  _args: Record<string, any>,
): Promise<string> => {
  // This executor needs direct store access for file tree data
  const { rootPath, files } = useWorkspaceStore.getState();

  if (!rootPath) {
    return JSON.stringify({
      success: true,
      hasWorkspace: false,
      message: "No workspace open",
    });
  }

  const countFiles = (nodes: any[]): { files: number; folders: number } => {
    let fileCount = 0;
    let folderCount = 0;

    for (const node of nodes) {
      if (node.type === "folder") {
        folderCount++;
        if (node.children) {
          const childCounts = countFiles(node.children);
          fileCount += childCounts.files;
          folderCount += childCounts.folders;
        }
      } else {
        fileCount++;
      }
    }

    return { files: fileCount, folders: folderCount };
  };

  const counts = countFiles(files);
  const folderName = rootPath.split(/[/\\]/).pop() || "workspace";

  return JSON.stringify({
    success: true,
    hasWorkspace: true,
    rootPath,
    name: folderName,
    totalFiles: counts.files,
    totalFolders: counts.folders,
  });
};

// ============================================
// REGISTER ALL WORKSPACE EXECUTORS
// Note: file_exists is registered in file-executors.ts
// ============================================
export const registerWorkspaceExecutors = (): void => {
  toolRegistry.registerExecutor("workspace_tree", workspaceTreeExecutor);
  toolRegistry.registerExecutor(
    "workspace_list_files",
    workspaceListFilesExecutor,
  );
  toolRegistry.registerExecutor(
    "workspace_find_files",
    workspaceFindFilesExecutor,
  );
  toolRegistry.registerExecutor("workspace_grep", workspaceGrepExecutor);
  toolRegistry.registerExecutor("folder_create", folderCreateExecutor);
  toolRegistry.registerExecutor("folder_delete", folderDeleteExecutor);
  toolRegistry.registerExecutor("workspace_info", workspaceInfoExecutor);
  // Removed duplicate file_exists registration - it's handled in file-executors.ts
};
