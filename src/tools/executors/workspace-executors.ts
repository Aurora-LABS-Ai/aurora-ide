/**
 * Workspace Tool Executors
 * Simplified: only essential workspace operations
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

        // Skip common ignore patterns
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "target") {
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
    triggerRefresh();
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
    triggerRefresh();
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
// REGISTER ALL WORKSPACE EXECUTORS
// ============================================
export const registerWorkspaceExecutors = (): void => {
  toolRegistry.registerExecutor("workspace_tree", workspaceTreeExecutor);
  toolRegistry.registerExecutor("folder_create", folderCreateExecutor);
  toolRegistry.registerExecutor("folder_delete", folderDeleteExecutor);
};
