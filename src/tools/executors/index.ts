/**
 * Tool Executors Index
 * Central registration point for all tool executors
 */
import { registerEditorExecutors } from "./editor-executors";
import { registerEnhancedFileExecutors } from "./file-executors-enhanced";
import { registerSearchExecutors } from "./search-executors";
import { registerShellExecutors } from "./shell-executors";
import { registerSkillExecutors } from "./skill-executors";
import { registerTodoExecutors } from "./todo-executors";
import { registerWorkspaceExecutors } from "./workspace-executors";

/**
 * Check if executors have been registered
 */
export const areExecutorsRegistered = (): boolean => {
  return executorsRegistered;
};

/**
 * Register all tool executors
 * Should be called once during app initialization
 */
export const registerAllExecutors = (): void => {
  if (executorsRegistered) {
    console.warn('Tool executors already registered');
    return;
  }

  // Register enhanced file tool executors with operation logging
  registerEnhancedFileExecutors();

  // Register workspace tool executors
  registerWorkspaceExecutors();

  // Register shell tool executors
  registerShellExecutors();

  // Register editor tool executors
  registerEditorExecutors();

  // Register search tool executors (auroro_websearch)
  registerSearchExecutors();

  // Register skill discovery tool executors (aurora_skill_search/load)
  registerSkillExecutors();

  // Register todo tool executors
  registerTodoExecutors();

  // Note: MCP tools are executed via mcp-tools.ts service, not through registry

  executorsRegistered = true;
  console.log('Tool executors registered successfully');
};

// Track if executors have been registered
let executorsRegistered = false;

// Export individual registration functions for selective registration
export { registerWorkspaceExecutors } from './workspace-executors';

export { registerShellExecutors } from './shell-executors';

export { registerEditorExecutors } from './editor-executors';

export { registerSearchExecutors } from './search-executors';

export { registerSkillExecutors } from './skill-executors';

export { registerTodoExecutors } from './todo-executors';
