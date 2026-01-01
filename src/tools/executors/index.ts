/**
 * Tool Executors Index
 * Central registration point for all tool executors
 */

import { registerEnhancedFileExecutors } from './file-executors-enhanced';
import { registerWorkspaceExecutors } from './workspace-executors';
import { registerShellExecutors } from './shell-executors';
import { registerEditorExecutors } from './editor-executors';
import { registerSearchExecutors } from './search-executors';
import { registerTodoExecutors } from './todo-executors';

// Track if executors have been registered
let executorsRegistered = false;

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

  // Register search tool executors (aurora_search)
  registerSearchExecutors();

  // Register todo tool executors
  registerTodoExecutors();

  executorsRegistered = true;
  console.log('Tool executors registered successfully');
};

/**
 * Check if executors have been registered
 */
export const areExecutorsRegistered = (): boolean => {
  return executorsRegistered;
};

// Export individual registration functions for selective registration
export { registerFileExecutors } from './file-executors';
export { registerWorkspaceExecutors } from './workspace-executors';
export { registerShellExecutors } from './shell-executors';
export { registerEditorExecutors } from './editor-executors';
export { registerSearchExecutors } from './search-executors';
export { registerTodoExecutors } from './todo-executors';
