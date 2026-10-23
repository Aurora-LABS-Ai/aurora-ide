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
    .filter(([, level]) => level === 'low')
    .map(([name]) => name);
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
    .filter(([, level]) => level === 'high')
    .map(([name]) => name);
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
  // Current file tools (post 16→10 refine)
  file_read: 'low',          // read (single or batch) is safe
  file_write: 'low',         // auto-approve writes for speed
  file_edit: 'low',          // exact-text edit — auto-approve for speed
  move_path: 'medium',       // move/rename file or folder — can reorganize
  delete_path: 'high',       // KEEP HIGH - deletion is destructive
  grep: 'low',               // Search tool - read only operation
  glob: 'low',               // Find files by name - read only operation
  // Legacy file tools (historic threads / decoration only)
  file_create: 'low',
  file_read_lines: 'low',
  search_replace: 'low',
  file_delete: 'high',
  file_exists: 'low',
  file_search: 'low',
  multi_file_read: 'low',

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
  editor_insert_text: 'low',       // Changed from 'medium' - auto-approve
  editor_get_open_tabs: 'low',     // Read operation
  editor_close_tab: 'low',         // UI operation

  // ============================================
  // TODO TOOLS - AUTO-APPROVED
  // ============================================
  TaskCreate: 'low',               // UI operation - the agent's own checklist
  TaskUpdate: 'low',
  TaskList: 'low',                 // read-only
  // Sub-agents. Starting or messaging one is bookkeeping; the child's OWN
  // tools carry their own risk and go through the same gate in Rust, where a
  // tool set to ask is refused for a child rather than prompted.
  spawn_agent: 'low',
  send_message: 'low',
  get_task_output: 'low',
  // Stops work the agent itself started; the transcript is kept.
  stop_agent: 'low',
  list_models: 'low',
  message_parent: 'low',
  submit_report: 'low',
  todo: 'low',                     // retired names, kept so a stale roster can't escalate
  todo_write: 'low',

  // ============================================
  // TRANSCRIPT ANNOTATION - AUTO-APPROVED
  // ============================================
  // Naming the part of the work it is starting. Touches nothing; listed so the
  // unknown-tool default ('medium') never applies to it.
  chapter: 'low',

  // ============================================
  // SEARCH TOOLS - AUTO-APPROVED
  // ============================================
  auroro_websearch: 'low',         // Web search/fetch - read only operation

  // ============================================
  // SKILL DISCOVERY TOOLS - AUTO-APPROVED
  // ============================================
  aurora_skill_search: 'low',      // Read-only catalog browse
  aurora_skill_load: 'low',        // Read-only SKILL.md fetch

  // ============================================
  // TERMINAL PANEL
  // ============================================
  // Starts commands and types into the agent's own tabs, so it carries the
  // shell tools' level; the approval gate in Rust decides per the user's
  // Settings → Tools mode.
  terminal: 'high',

  // ============================================
  // INTERACTIVE PROMPT - AUTO-APPROVED (UI is the consent)
  // ============================================
  ask_question: 'low',             // Renders a prompt; user answers in the UI

  present_artifact: 'low',
  read_artifact: 'low',

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
    'terminal',         // high (starts commands in the Terminal panel)
  ],
  philosophy: 'Cursor-style speed: auto-approve file ops, require approval only for destructive/system operations',
};

console.log('[RiskLevels] Enhanced risk levels loaded:', {
  autoApproved: getAutoApprovedTools().length,
  requireApproval: getToolsRequiringApproval().length,
  changes: RISK_LEVEL_CHANGES.autoApprovedNow.length,
});
