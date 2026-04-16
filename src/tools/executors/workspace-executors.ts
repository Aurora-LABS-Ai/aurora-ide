/**
 * Workspace Tool Executors
 * Simplified: only essential workspace operations
 */
import { createFolder, deletePath, isTauri, readDirectory, renamePath } from "../../lib/tauri";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import { toolRegistry } from "../registry";
import { isDirectoryExcluded } from "../utils/excluded-paths";
import { getWorkspaceRootPath, resolvePath } from "../utils/path-resolver";

// Helper to trigger file tree refresh
const triggerRefresh = () => {
  setTimeout(() => {
    useWorkspaceStore.getState().refreshDirectory();
  }, 100);
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
// FOLDER MOVE EXECUTOR
// ============================================
const folderMoveExecutor = async (
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

  if (!args.old_path || !args.new_path) {
    return JSON.stringify({
      success: false,
      error: "old_path and new_path are required",
    });
  }

  const sourcePath = resolvePath(args.old_path);
  const destinationPath = resolvePath(args.new_path);

  try {
    await renamePath(sourcePath, destinationPath);
    triggerRefresh();
    return JSON.stringify({
      success: true,
      message: `Folder moved: ${sourcePath} -> ${destinationPath}`,
      oldPath: sourcePath,
      newPath: destinationPath,
    });
  } catch (error) {
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      oldPath: sourcePath,
      newPath: destinationPath,
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

        // Skip excluded directories (node_modules, build artifacts, etc.)
        if (entry.is_dir && isDirectoryExcluded(entry.name)) {
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
// REGISTER ALL WORKSPACE EXECUTORS
// ============================================
export const registerWorkspaceExecutors = (): void => {
  toolRegistry.registerExecutor("workspace_tree", workspaceTreeExecutor);
  toolRegistry.registerExecutor("folder_create", folderCreateExecutor);
  toolRegistry.registerExecutor("folder_move", folderMoveExecutor);
  toolRegistry.registerExecutor("folder_delete", folderDeleteExecutor);
};
