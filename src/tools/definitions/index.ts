/**
 * Tool Definitions Index
 * Central export for all tool definitions
 * 
 * TOOL COUNT: 18 tools total
 * - File: 8 (create, read, write, search_replace, multi_search_replace, delete, grep, multi_file_read)
 * - Workspace: 3 (tree, folder_create, folder_delete)
 * - Shell: 4 (execute, spawn, kill, list_processes)
 * - Editor: 2 (open_file, read_lints)
 * - Search: 1 (aurora_search)
 * - Todo: 1 (todo_write)
 * - MCP: Tools are dynamically loaded from connected servers
 */
import type { ToolDefinition } from "../types";
import { editorTools } from "./editor-tools";
import { fileTools } from "./file-tools";
import { getEnhancedToolRiskLevel } from "./risk-levels-enhanced";
import { searchTools } from "./search-tools";
import { shellTools } from "./shell-tools";
import { todoTools } from "./todo-tools";
import { workspaceTools } from "./workspace-tools";

// Get tool definition by name
export const getToolByName = (name: string): ToolDefinition | undefined => {
  return allTools.find(tool => tool.function.name === name);
};

// Get risk level for a tool
export const getToolRiskLevel = (toolName: string): 'low' | 'medium' | 'high' => {
  return getEnhancedToolRiskLevel(toolName);
};

export * from './file-tools';

export * from './workspace-tools';

export * from './shell-tools';

export * from './editor-tools';

export * from './search-tools';

export * from './todo-tools';

// All available tools (MCP tools are added dynamically from connected servers)
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

// Risk levels are centralized in risk-levels-enhanced.ts.
