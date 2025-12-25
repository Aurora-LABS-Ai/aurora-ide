/**
 * Workspace Tools - Definitions
 * Tools for workspace operations: tree view, list files, folder operations
 */

import type { ToolDefinition } from '../types';

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

// ============================================
// WORKSPACE LIST FILES TOOL
// ============================================
export const workspaceListFilesTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'workspace_list_files',
    description: 'List all files in a directory (non-recursive). Returns file names, types, and sizes.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The directory path to list. If not provided, uses the workspace root.',
        },
        filter: {
          type: 'string',
          description: 'Optional glob pattern to filter files (e.g., "*.ts", "*.{js,jsx}")',
        },
      },
      required: [],
    },
  },
};

// ============================================
// WORKSPACE FIND FILES TOOL
// ============================================
export const workspaceFindFilesTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'workspace_find_files',
    description: 'Recursively find files matching a pattern in the workspace. Similar to "find" command.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern to match files (e.g., "**/*.tsx", "src/**/*.ts")',
        },
        path: {
          type: 'string',
          description: 'Starting directory for the search. Defaults to workspace root.',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of results to return. Defaults to 100.',
          default: 100,
        },
      },
      required: ['pattern'],
    },
  },
};

// ============================================
// WORKSPACE GREP TOOL
// ============================================
export const workspaceGrepTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'workspace_grep',
    description: 'Search for a pattern across all files in the workspace. Returns matching files and lines.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'The search pattern (supports regex)',
        },
        path: {
          type: 'string',
          description: 'Starting directory for the search. Defaults to workspace root.',
        },
        file_pattern: {
          type: 'string',
          description: 'Glob pattern to filter which files to search (e.g., "*.ts")',
        },
        is_regex: {
          type: 'boolean',
          description: 'Whether the pattern is a regex. Defaults to false.',
          default: false,
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of matching lines to return. Defaults to 50.',
          default: 50,
        },
      },
      required: ['pattern'],
    },
  },
};

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
// WORKSPACE INFO TOOL
// ============================================
export const workspaceInfoTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'workspace_info',
    description: 'Get information about the current workspace including root path, total files, and project type detection.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
};

// Export all workspace tools as an array
export const workspaceTools: ToolDefinition[] = [
  workspaceTreeTool,
  workspaceListFilesTool,
  workspaceFindFilesTool,
  workspaceGrepTool,
  folderCreateTool,
  folderDeleteTool,
  workspaceInfoTool,
];

