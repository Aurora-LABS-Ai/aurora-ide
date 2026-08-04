/**
 * Tool Definitions Index
 * Central export for all tool definitions.
 *
 * NOTE: tools flagged `nativeRustOwned` are NOT sent to the model from
 * here — the Rust runtime's registry is their single source of truth
 * (see `AgentService.buildAvailableTools`, which filters them out). These
 * definitions remain only as frontend metadata (risk/approval/display).
 *
 * - File: 6 (read, write, edit, move_path, delete_path, grep)
 * - Workspace: 2 (tree, folder_create)
 * - Shell: 4 (execute, spawn, kill, list_processes)
 * - Editor: 2 (open_file, read_lints)
 * - Search: 1 (auroro_websearch)
 * - Todo: 1 (todo_write — legacy IDE chat only; the agent uses Rust's `todo`)
 * - MCP: Tools are dynamically loaded from connected servers
 */
import type { ToolDefinition } from "../types";
import { artifactTools } from "./artifact-tools";
import { editorTools } from "./editor-tools";
import { fileTools } from "./file-tools";
import { getEnhancedToolRiskLevel } from "./risk-levels-enhanced";
import { questionTools } from "./question-tools";
import { searchTools } from "./search-tools";
import { shellTools } from "./shell-tools";
import { skillTools } from "./skill-tools";
import { teamTools } from "./team-tools";
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

export * from './skill-tools';

export * from './team-tools';

export * from './question-tools';

export * from './todo-tools';

export * from './artifact-tools';

// All available tools (MCP tools are added dynamically from connected servers)
export const allTools: ToolDefinition[] = [
  ...artifactTools,
  ...fileTools,
  ...workspaceTools,
  ...shellTools,
  ...editorTools,
  ...searchTools,
  ...skillTools,
  ...teamTools,
  ...questionTools,
  ...todoTools,
];

// Tool categories for UI organization
export const toolCategories = {
  artifact: {
    name: 'Artifact Canvas',
    description: 'Tools for presenting persistent visual and interactive artifacts.',
    tools: artifactTools,
  },
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
    description: 'Web search and page fetch tools.',
    tools: searchTools,
  },
  skills: {
    name: 'Skills',
    description: 'Discovery tools for the Aurora skill catalog.',
    tools: skillTools,
  },
  team: {
    name: 'Agent Team',
    description: "Lead tools to convene, plan, build, integrate, and manage the agent team.",
    tools: teamTools,
  },
  question: {
    name: 'User Prompts',
    description: 'Interactive prompts that ask the user a structured question.',
    tools: questionTools,
  },
  todo: {
    name: 'Task Management',
    description: 'Tools for managing task lists',
    tools: todoTools,
  },
};

// Risk levels are centralized in risk-levels-enhanced.ts.
