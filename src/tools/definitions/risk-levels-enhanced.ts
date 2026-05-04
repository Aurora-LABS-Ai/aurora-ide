/**
 * Enhanced Risk Levels Configuration
 * Cursor-style: Auto-approve file operations, require approval only for shell commands
 * 
 * PHILOSOPHY:
 * - File operations (read/write/create/edit): LOW risk - Auto-approved for speed
 * - Delete operations: HIGH risk - Require approval (destructive)
 * - Shell commands: HIGH risk - Always require approval (system access)
 * 
 * This gives us Cursor-level speed while maintaining safety for dangerous operations
 */
/**
 * Get list of tools that are auto-approved
 */
export const getAutoApprovedTools = (): string[] => {
  return Object.entries(enhancedToolRiskLevels)
    .filter(([_, level]) => level === 'low')
    .map(([name, _]) => name);
};

/**
 * Get enhanced risk level for a tool
 * This function should replace getToolRiskLevel in production
 */
export const getEnhancedToolRiskLevel = (toolName: string): 'low' | 'medium' | 'high' => {
  return enhancedToolRiskLevels[toolName] || 'medium';
};

/**
 * Get list of tools that require approval
 */
export const getToolsRequiringApproval = (): string[] => {
  return Object.entries(enhancedToolRiskLevels)
    .filter(([_, level]) => level === 'high')
    .map(([name, _]) => name);
};

/**
 * Check if a tool requires approval
 * Only HIGH risk tools require approval
 */
export const requiresApproval = (toolName: string): boolean => {
  const riskLevel = getEnhancedToolRiskLevel(toolName);
  return riskLevel === 'high';
};

export const enhancedToolRiskLevels: Record<string, 'low' | 'medium' | 'high'> = {
  // ============================================
  // FILE TOOLS - MOSTLY AUTO-APPROVED
  // ============================================
  file_create: 'low',        // Changed from 'medium' - auto-approve creates
  file_read: 'low',          // Already low - read is safe
  file_read_lines: 'low',    // Already low - read is safe
  file_write: 'low',         // Changed from 'high' - auto-approve writes for speed
  search_replace: 'low',     // Changed from 'high' - auto-approve edits for speed
  file_delete: 'high',       // KEEP HIGH - deletion is destructive
  file_exists: 'low',        // Already low - check is safe
  file_search: 'low',        // Already low - search is safe
  grep: 'low',               // Search tool - read only operation
  multi_file_read: 'low',    // Parallel file reading - read only operation

  // ============================================
  // WORKSPACE TOOLS - ALL AUTO-APPROVED
  // ============================================
  workspace_tree: 'low',           // Read operation
  workspace_list_files: 'low',     // Read operation
  workspace_find_files: 'low',     // Read operation
  workspace_grep: 'low',           // Read operation
  folder_create: 'low',            // Changed from 'medium' - auto-approve
  folder_move: 'medium',           // Can reorganize project structure
  folder_delete: 'high',           // KEEP HIGH - deletion is destructive
  workspace_info: 'low',           // Read operation

  // ============================================
  // SHELL TOOLS - ALWAYS REQUIRE APPROVAL
  // ============================================
  shell_execute: 'high',           // KEEP HIGH - system access
  shell_spawn: 'high',             // KEEP HIGH - background processes
  shell_kill: 'high',              // Changed from 'medium' - killing processes is risky
  shell_list_processes: 'low',     // Read operation

  // ============================================
  // EDITOR TOOLS - ALL AUTO-APPROVED
  // ============================================
  editor_open_file: 'low',         // UI operation
  editor_get_active_file: 'low',   // Read operation
  editor_get_selection: 'low',     // Read operation
  read_lints: 'low',               // Read operation - get diagnostics
  editor_insert_text: 'low',       // Changed from 'medium' - auto-approve
  editor_get_open_tabs: 'low',     // Read operation
  editor_close_tab: 'low',         // UI operation

  // ============================================
  // TODO TOOLS - AUTO-APPROVED
  // ============================================
  todo_write: 'low',               // UI operation - updates task list

  // ============================================
  // SEARCH TOOLS - AUTO-APPROVED
  // ============================================
  auroro_websearch: 'low',         // Web search/fetch - read only operation

  // ============================================
  // SKILL DISCOVERY TOOLS - AUTO-APPROVED
  // ============================================
  aurora_skill_search: 'low',      // Read-only catalog browse
  aurora_skill_load: 'low',        // Read-only SKILL.md fetch

  // Note: MCP tools are handled separately via mcp-tools.ts
  // Their approval is determined by the server's autoApprove setting
};

/**
 * Summary of risk level changes
 */
export const RISK_LEVEL_CHANGES = {
  autoApprovedNow: [
    'file_create',      // medium → low
    'file_write',       // high → low
    'search_replace',   // high → low
    'folder_create',    // medium → low
    'editor_insert_text', // medium → low
  ],
  stillRequireApproval: [
    'file_delete',      // high (destructive)
    'folder_delete',    // high (destructive)
    'shell_execute',    // high (system access)
    'shell_spawn',      // high (system access)
    'shell_kill',       // high (process management)
  ],
  philosophy: 'Cursor-style speed: auto-approve file ops, require approval only for destructive/system operations',
};

console.log('[RiskLevels] Enhanced risk levels loaded:', {
  autoApproved: getAutoApprovedTools().length,
  requireApproval: getToolsRequiringApproval().length,
  changes: RISK_LEVEL_CHANGES.autoApprovedNow.length,
});
