/**
 * Tool Definitions Index
 * Central export for all tool definitions
 */

export * from './file-tools';
export * from './workspace-tools';
export * from './shell-tools';
export * from './editor-tools';
export * from './todo-tools';

import { fileTools } from './file-tools';
import { workspaceTools } from './workspace-tools';
import { shellTools } from './shell-tools';
import { editorTools } from './editor-tools';
import { todoTools } from './todo-tools';
import type { ToolDefinition } from '../types';

// All available tools
export const allTools: ToolDefinition[] = [
  ...fileTools,
  ...workspaceTools,
  ...shellTools,
  ...editorTools,
  ...todoTools,
];

// Tool categories for UI organization
export const toolCategories = {
  file: {
    name: 'File Operations',
    description: 'Tools for reading, writing, and managing files',
    tools: fileTools,
  },
  workspace: {
    name: 'Workspace',
    description: 'Tools for navigating and searching the workspace',
    tools: workspaceTools,
  },
  shell: {
    name: 'Shell',
    description: 'Tools for executing shell commands',
    tools: shellTools,
  },
  editor: {
    name: 'Editor',
    description: 'Tools for interacting with the code editor',
    tools: editorTools,
  },
  todo: {
    name: 'Task Management',
    description: 'Tools for managing task lists',
    tools: todoTools,
  },
};

// Risk levels for tools (used for approval flow)
export const toolRiskLevels: Record<string, 'low' | 'medium' | 'high'> = {
  // File tools
  file_create: 'medium',
  file_read: 'low',
  file_read_lines: 'low',
  file_write: 'high',
  file_patch: 'high',
  file_delete: 'high',
  file_exists: 'low',
  file_search: 'low',
  
  // Workspace tools
  workspace_tree: 'low',
  workspace_list_files: 'low',
  workspace_find_files: 'low',
  workspace_grep: 'low',
  folder_create: 'medium',
  folder_delete: 'high',
  workspace_info: 'low',
  
  // Shell tools
  shell_execute: 'high',
  shell_spawn: 'high',
  shell_kill: 'medium',
  shell_list_processes: 'low',
  
  // Editor tools
  editor_open_file: 'low',
  editor_get_active_file: 'low',
  editor_get_selection: 'low',
  editor_insert_text: 'medium',
  editor_get_open_tabs: 'low',
  editor_close_tab: 'low',

  // Todo tools
  todo_write: 'low', // Auto-approve - just updates UI task list
};

// Get risk level for a tool
export const getToolRiskLevel = (toolName: string): 'low' | 'medium' | 'high' => {
  return toolRiskLevels[toolName] || 'medium';
};

// Get tool definition by name
export const getToolByName = (name: string): ToolDefinition | undefined => {
  return allTools.find(tool => tool.function.name === name);
};

