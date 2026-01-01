/**
 * Tool Definitions Index
 * Central export for all tool definitions
 * 
 * TOOL COUNT: 16 tools total
 * - File: 7 (create, read, write, patch, delete, grep, multi_file_read)
 * - Workspace: 3 (tree, folder_create, folder_delete)
 * - Shell: 4 (execute, spawn, kill, list_processes)
 * - Editor: 1 (open_file)
 * - Search: 1 (aurora_search)
 * - Todo: 1 (todo_write)
 */

export * from './file-tools';
export * from './workspace-tools';
export * from './shell-tools';
export * from './editor-tools';
export * from './search-tools';
export * from './todo-tools';

import { fileTools } from './file-tools';
import { workspaceTools } from './workspace-tools';
import { shellTools } from './shell-tools';
import { editorTools } from './editor-tools';
import { searchTools } from './search-tools';
import { todoTools } from './todo-tools';
import type { ToolDefinition } from '../types';

// All available tools
export const allTools: ToolDefinition[] = [
  ...fileTools,
  ...workspaceTools,
  ...shellTools,
  ...editorTools,
  ...searchTools,
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
    description: 'Tools for navigating and managing directories',
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
  search: {
    name: 'Search',
    description: 'Advanced search tools including semantic search',
    tools: searchTools,
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
  file_write: 'high',
  file_patch: 'high',
  file_delete: 'high',
  grep: 'low',
  multi_file_read: 'low',
  
  // Workspace tools
  workspace_tree: 'low',
  folder_create: 'medium',
  folder_delete: 'high',
  
  // Shell tools
  shell_execute: 'high',
  shell_spawn: 'high',
  shell_kill: 'medium',
  shell_list_processes: 'low',
  
  // Editor tools
  editor_open_file: 'low',

  // Search tools
  aurora_search: 'low', // Read-only semantic search

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
