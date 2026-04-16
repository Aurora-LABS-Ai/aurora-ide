/**
 * Workspace Tools - Definitions
 * Essential workspace operations only
 */
import type { ToolDefinition } from "../types";

// ============================================
// FOLDER CREATE TOOL
// ============================================
export const folderCreateTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'folder_create',
    description: 'Create a new folder/directory at the specified path. Creates parent directories if they do not exist.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The full path of the folder to create',
        },
      },
      required: ['path'],
    },
  },
};

// ============================================
// FOLDER MOVE TOOL
// ============================================
export const folderMoveTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'folder_move',
    description: 'Move or rename a folder from one path to another path. This fails if the source folder does not exist or the destination already exists.',
    parameters: {
      type: 'object',
      properties: {
        old_path: {
          type: 'string',
          description: 'The current full path of the folder',
        },
        new_path: {
          type: 'string',
          description: 'The new full path for the folder',
        },
      },
      required: ['old_path', 'new_path'],
    },
  },
};

// ============================================
// FOLDER DELETE TOOL
// ============================================
export const folderDeleteTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'folder_delete',
    description: 'Delete a folder and all its contents. This action is irreversible.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The full path of the folder to delete',
        },
      },
      required: ['path'],
    },
  },
};

// ============================================
// WORKSPACE TREE TOOL
// ============================================
export const workspaceTreeTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'workspace_tree',
    description: 'Get the directory tree structure of the workspace or a specific directory. Returns a hierarchical view of files and folders.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The directory path to get the tree for. If not provided, uses the workspace root.',
        },
        depth: {
          type: 'number',
          description: 'Maximum depth to traverse. Defaults to 3. Use -1 for unlimited depth.',
          default: 3,
        },
        include_hidden: {
          type: 'boolean',
          description: 'Whether to include hidden files (starting with dot). Defaults to false.',
          default: false,
        },
      },
      required: [],
    },
  },
};

// Export all workspace tools as an array
export const workspaceTools: ToolDefinition[] = [
  workspaceTreeTool,
  folderCreateTool,
  folderMoveTool,
  folderDeleteTool,
];
