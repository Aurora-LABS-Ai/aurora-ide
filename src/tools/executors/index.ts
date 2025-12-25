/**
 * Tool Executors Index
 * Central registration point for all tool executors
 */

import { registerFileExecutors } from './file-executors';
import { registerWorkspaceExecutors } from './workspace-executors';
import { registerShellExecutors } from './shell-executors';

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

  // Register file tool executors
  registerFileExecutors();
  
  // Register workspace tool executors
  registerWorkspaceExecutors();
  
  // Register shell tool executors
  registerShellExecutors();
  
  // TODO: Register editor tool executors
  // registerEditorExecutors();

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

