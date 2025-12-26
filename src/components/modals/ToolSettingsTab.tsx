/**
 * Tool Settings Tab Component
 * Manages tool approval settings and max tool calls
 */

import React from 'react';
import { useSettingsStore } from '../../store/useSettingsStore';
import { Terminal, FileText, FolderOpen, Code, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';

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
        "px-2 py-0.5 text-[10px] rounded border bg-input",
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
            <h3 className="text-xs font-medium text-text-primary">Global Auto-approve</h3>
            <p className="text-[10px] text-text-secondary">Execute all tools without asking</p>
          </div>
          <button
            onClick={() => setAutoApproveTools(!autoApproveTools)}
            className={clsx(
              "relative w-8 h-4 rounded-full transition-colors",
              autoApproveTools ? "bg-primary" : "bg-input border border-border"
            )}
          >
            <div className={clsx(
              "absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform",
              autoApproveTools ? "translate-x-4" : "translate-x-0.5"
            )} />
          </button>
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

