/**
 * THEME ARCHITECTURE NOTICE:
 * 
 * This project uses a centralized theme system. DO NOT use hardcoded colors.
 * 
 * Instead of:
 *   - Hardcoded hex values: #ff0000, #1a1a1a
 *   - Hardcoded RGB values: rgb(255, 0, 0)
 *   - Tailwind arbitrary colors: bg-[#1a1a1a], text-[#ff0000]
 * 
 * Use theme tokens via CSS variables:
 *   - CSS: var(--aurora-{category}-{token})
 *   - Tailwind: bg-[var(--aurora-editor-background)]
 *   - Component styles: style={{ background: 'var(--aurora-sidebar-background)' }}
 * 
 * Available categories: editor, sidebar, chat, terminal, statusBar, titleBar, common
 * 
 * See: DOCS/theme-dev.md for full token reference
 * See: src/types/theme.ts for TypeScript interfaces
 * See: src/services/theme-service.ts for theme utilities
 */

/**
 * Tool Settings Tab Component
 * Manages tool approval settings and max tool calls
 */

import React from 'react';
import { useSettingsStore } from '../../store/useSettingsStore';
import { Terminal, FileText, FolderOpen, Code, AlertTriangle, Shield, Map } from 'lucide-react';
import clsx from 'clsx';
import { TogglePill } from '../ui/TogglePill';

// Group tools by category for better organization
const TOOL_CATEGORIES = {
  shell: {
    label: 'Shell Commands',
    icon: Terminal,
    description: 'Command execution tools',
    tools: ['shell_execute', 'shell_spawn', 'shell_kill', 'shell_list_processes'],
  },
  fileWrite: {
    label: 'File Modifications',
    icon: FileText,
    description: 'Tools that modify files',
    tools: ['file_write', 'file_create', 'file_delete', 'file_patch'],
  },
  folderOps: {
    label: 'Folder Operations',
    icon: FolderOpen,
    description: 'Tools that modify folders',
    tools: ['folder_create', 'folder_delete'],
  },
  fileRead: {
    label: 'File Reading',
    icon: FileText,
    description: 'Safe read operations',
    tools: ['file_read', 'file_read_lines', 'file_exists', 'file_search'],
  },
  workspace: {
    label: 'Workspace',
    icon: FolderOpen,
    description: 'Workspace navigation',
    tools: ['workspace_info', 'workspace_list_files', 'workspace_tree', 'workspace_find_files', 'workspace_grep'],
  },
  editor: {
    label: 'Editor',
    icon: Code,
    description: 'Editor interactions',
    tools: ['editor_open_file', 'editor_get_active_file', 'editor_get_selection', 'editor_get_open_tabs', 'editor_insert_text', 'editor_close_tab'],
  },
};

// Tool display names
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  shell_execute: 'Execute Command',
  shell_spawn: 'Spawn Background Process',
  shell_kill: 'Kill Process',
  shell_list_processes: 'List Processes',
  file_write: 'Write File',
  file_create: 'Create File',
  file_delete: 'Delete File',
  file_patch: 'Patch File',
  file_read: 'Read File',
  file_read_lines: 'Read Lines',
  file_exists: 'Check Exists',
  file_search: 'Search in File',
  folder_create: 'Create Folder',
  folder_delete: 'Delete Folder',
  workspace_info: 'Get Info',
  workspace_list_files: 'List Files',
  workspace_tree: 'Directory Tree',
  workspace_find_files: 'Find Files',
  workspace_grep: 'Search/Grep',
  editor_open_file: 'Open File',
  editor_get_active_file: 'Get Active File',
  editor_get_selection: 'Get Selection',
  editor_get_open_tabs: 'Get Open Tabs',
  editor_insert_text: 'Insert Text',
  editor_close_tab: 'Close Tab',
};

interface ApprovalSelectProps {
  toolName: string;
  value: 'auto' | 'always_ask' | 'deny';
  onChange: (value: 'auto' | 'always_ask' | 'deny') => void;
}

const ApprovalSelect: React.FC<ApprovalSelectProps> = ({ value, onChange }) => {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as 'auto' | 'always_ask' | 'deny')}
      className={clsx(
        "px-2 py-0.5 text-[10px] rounded border border-input-border bg-input text-text-secondary focus:outline-none",
        value === 'auto' && 'border-success/50 text-success',
        value === 'always_ask' && 'border-warning/50 text-warning',
        value === 'deny' && 'border-danger/50 text-danger'
      )}
    >
      <option value="auto">Auto</option>
      <option value="always_ask">Ask</option>
      <option value="deny">Deny</option>
    </select>
  );
};

export const ToolSettingsTab: React.FC = () => {
  const {
    autoApproveTools,
    setAutoApproveTools,
    autoAcceptChanges,
    setAutoAcceptChanges,
    syntaxValidationEnabled,
    setSyntaxValidationEnabled,
    projectLayoutEnabled,
    setProjectLayoutEnabled,
    maxToolCallsPerRequest,
    setMaxToolCallsPerRequest,
    toolApprovalSettings,
    setToolApproval,
  } = useSettingsStore();

  const setCategoryApproval = (category: keyof typeof TOOL_CATEGORIES, setting: 'auto' | 'always_ask' | 'deny') => {
    const tools = TOOL_CATEGORIES[category].tools;
    tools.forEach(tool => setToolApproval(tool, setting));
  };

  return (
    <div className="space-y-4">
      {/* Global Auto-approve Toggle */}
      <div className="p-3 border border-border rounded-lg bg-titlebar">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-xs font-medium text-text-primary">Auto-approve Tools</h3>
            <p className="text-[10px] text-text-secondary">Execute all tools without asking</p>
          </div>
          <TogglePill
            checked={autoApproveTools}
            onChange={setAutoApproveTools}
            ariaLabel="Toggle auto-approve tools"
            variant="primary"
            size="sm"
          />
        </div>
      </div>

      {/* Auto-accept File Changes Toggle */}
      <div className="p-3 border border-border rounded-lg bg-titlebar">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-xs font-medium text-text-primary">Auto-accept File Changes</h3>
            <p className="text-[10px] text-text-secondary">Skip diff review, accept all file modifications immediately</p>
          </div>
          <TogglePill
            checked={autoAcceptChanges}
            onChange={setAutoAcceptChanges}
            ariaLabel="Toggle auto-accept file changes"
            variant="primary"
            size="sm"
          />
        </div>
        {autoAcceptChanges && (
          <p className="text-[10px] text-warning mt-2">
            File changes will be applied directly without showing the diff viewer.
          </p>
        )}
      </div>

      {/* Agent Guardrails Section */}
      <div className="space-y-2">
        <h3 className="text-xs font-medium text-text-primary flex items-center gap-1.5">
          <Shield className="w-3.5 h-3.5" />
          Agent Guardrails
        </h3>
        <p className="text-[10px] text-text-secondary mb-2">
          Help the agent avoid common mistakes
        </p>

        {/* Syntax Validation Toggle */}
        <div className="p-3 border border-border rounded-lg bg-titlebar">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-xs font-medium text-text-primary">Pre-save Syntax Validation</h3>
              <p className="text-[10px] text-text-secondary">Check syntax before writing files (JSON, JS, TS, JSX, TSX, CSS)</p>
            </div>
          <TogglePill
            checked={syntaxValidationEnabled}
            onChange={setSyntaxValidationEnabled}
            ariaLabel="Toggle pre-save syntax validation"
            variant="success"
            size="sm"
          />
          </div>
          {syntaxValidationEnabled && (
            <p className="text-[10px] text-success mt-2">
              Files with syntax errors will be rejected, forcing the agent to fix them.
            </p>
          )}
        </div>

        {/* Project Layout Toggle */}
        <div className="p-3 border border-border rounded-lg bg-titlebar">
          <div className="flex items-center justify-between">
            <div className="flex items-start gap-2">
              <Map className="w-3.5 h-3.5 text-text-secondary mt-0.5" />
              <div>
                <h3 className="text-xs font-medium text-text-primary">Project File Map</h3>
                <p className="text-[10px] text-text-secondary">Include file tree in first message to help agent understand project structure</p>
              </div>
            </div>
          <TogglePill
            checked={projectLayoutEnabled}
            onChange={setProjectLayoutEnabled}
            ariaLabel="Toggle project file map"
            variant="success"
            size="sm"
          />
          </div>
          {projectLayoutEnabled && (
            <p className="text-[10px] text-success mt-2">
              Agent will receive a file tree snapshot at conversation start for better path awareness.
            </p>
          )}
        </div>
      </div>

      {/* Max Tool Calls */}
      <div className="p-3 border border-border rounded-lg bg-titlebar">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h3 className="text-xs font-medium text-text-primary">Max Tool Calls per Request</h3>
            <p className="text-[10px] text-text-secondary">Limit iterations per conversation turn</p>
          </div>
          <span className="text-xs font-mono text-primary">{maxToolCallsPerRequest}</span>
        </div>
        <input
          type="range"
          min="5"
          max="50"
          step="5"
          value={maxToolCallsPerRequest}
          onChange={(e) => setMaxToolCallsPerRequest(parseInt(e.target.value))}
          className="w-full h-1 bg-input-border rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
        />
      </div>

      {/* Warning */}
      {autoApproveTools && (
        <div className="p-3 border border-warning/30 rounded-lg bg-warning/5">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
            <p className="text-[10px] text-text-secondary">
              Global auto-approve is enabled. Individual tool settings below are ignored.
            </p>
          </div>
        </div>
      )}

      {/* Per-Tool Settings */}
      <div className="space-y-2">
        <h3 className="text-xs font-medium text-text-primary">Per-Tool Approval</h3>
        <p className="text-[10px] text-text-secondary mb-2">
          Configure approval requirements for each tool category
        </p>

        {Object.entries(TOOL_CATEGORIES).map(([categoryKey, category]) => {
          const Icon = category.icon;
          const isDangerous = ['shell', 'fileWrite', 'folderOps'].includes(categoryKey);
          
          return (
            <div 
              key={categoryKey} 
              className={clsx(
                "p-3 border rounded-lg",
                isDangerous ? "border-warning/30 bg-warning/5" : "border-border bg-titlebar"
              )}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Icon className={clsx("w-4 h-4", isDangerous ? "text-warning" : "text-text-secondary")} />
                  <div>
                    <h4 className="text-xs font-medium text-text-primary">{category.label}</h4>
                    <p className="text-[10px] text-text-disabled">{category.description}</p>
                  </div>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => setCategoryApproval(categoryKey as keyof typeof TOOL_CATEGORIES, 'auto')}
                    className="px-2 py-0.5 text-[9px] rounded bg-success/20 text-success hover:bg-success/30"
                  >
                    All Auto
                  </button>
                  <button
                    onClick={() => setCategoryApproval(categoryKey as keyof typeof TOOL_CATEGORIES, 'always_ask')}
                    className="px-2 py-0.5 text-[9px] rounded bg-warning/20 text-warning hover:bg-warning/30"
                  >
                    All Ask
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                {category.tools.map((tool) => (
                  <div key={tool} className="flex items-center justify-between px-2 py-1 rounded bg-input/50">
                    <span className="text-[10px] text-text-secondary truncate">
                      {TOOL_DISPLAY_NAMES[tool] || tool}
                    </span>
                    <ApprovalSelect
                      toolName={tool}
                      value={toolApprovalSettings[tool] || 'always_ask'}
                      onChange={(value) => setToolApproval(tool, value)}
                    />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="p-2 border border-border rounded bg-titlebar">
        <div className="flex items-center gap-4 text-[10px]">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-success"></span>
            <span className="text-text-secondary">Auto: Execute immediately</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-warning"></span>
            <span className="text-text-secondary">Ask: Require approval</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-danger"></span>
            <span className="text-text-secondary">Deny: Block execution</span>
          </span>
        </div>
      </div>
    </div>
  );
};

