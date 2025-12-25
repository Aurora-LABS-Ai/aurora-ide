/**
 * Workspace Tool Executors
 * Implementations for workspace tools using Tauri commands
 */

import { toolRegistry } from "../registry";
import {
  isTauri,
  readDirectory,
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
  const patternRegex = new RegExp(
    pattern
      .replace(/\*\*/g, "{{GLOBSTAR}}")
      .replace(/\./g, "\\.")
      .replace(/\*/g, "[^/\\\\]*")
      .replace(/\?/g, ".")
      .replace(/{{GLOBSTAR}}/g, ".*"),
    "i", // Case insensitive
  );

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

        const relativePath = entry.path
          .replace(targetPath, "")
          .replace(/^[/\\]/, "");

        if (patternRegex.test(relativePath) || patternRegex.test(entry.name)) {
          results.push(entry.path);
        }

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

  return JSON.stringify({
    success: true,
    message:
      "Grep functionality requires shell_execute tool for full implementation",
    pattern: args.pattern,
    rootPath,
    suggestion: "Use shell_execute with grep or ripgrep command for searching",
  });
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
