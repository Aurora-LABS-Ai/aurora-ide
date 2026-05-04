/**
 * Tool Settings Tab — enterprise layout (Section + FormRow).
 * Manages tool approval settings and max tool calls.
 */

import React from 'react';
import {
  AlertTriangle,
  Code,
  FileText,
  FolderOpen,
  Map,
  Search,
  Shield,
  Terminal,
  CheckSquare,
} from 'lucide-react';
import clsx from 'clsx';
import { useSettingsStore } from '../../store/useSettingsStore';
import { IdeSwitch } from '../ui/IdeSwitch';
import { IdeSelect } from '../ui/IdeSelect';
import { getProfessionalToolName } from '../../services/tool-display';
import {
  Section,
  FormRow,
  FormRowLast,
  FormBlock,
  StatusPill,
  ActionButton,
  IdeSlider,
} from './settings-primitives';
import { settingsRowDividerColor } from './settings-shared';

type ApprovalMode = 'auto' | 'always_ask' | 'deny';

interface ToolCategory {
  description: string;
  icon: typeof Terminal;
  label: string;
  tools: string[];
  dangerous?: boolean;
}

const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  shell: {
    label: 'Shell Commands',
    icon: Terminal,
    description: 'Command execution and background process tools.',
    dangerous: true,
    tools: ['shell_execute', 'shell_spawn', 'shell_kill', 'shell_list_processes'],
  },
  fileWrite: {
    label: 'File Modifications',
    icon: FileText,
    description: 'Tools that create, update, patch, or delete files.',
    dangerous: true,
    tools: [
      'file_write',
      'file_create',
      'file_delete',
      'file_patch',
      'search_replace',
      'multi_search_replace',
    ],
  },
  folderOps: {
    label: 'Folder Operations',
    icon: FolderOpen,
    description: 'Tools that create, move, or delete folders.',
    dangerous: true,
    tools: ['folder_create', 'folder_move', 'folder_delete'],
  },
  fileRead: {
    label: 'File Reading',
    icon: FileText,
    description: 'Safe read and search operations across the workspace.',
    tools: ['file_read', 'multi_file_read', 'grep'],
  },
  workspace: {
    label: 'Workspace',
    icon: FolderOpen,
    description: 'Workspace navigation and structure inspection.',
    tools: ['workspace_tree'],
  },
  editor: {
    label: 'Editor',
    icon: Code,
    description: 'Editor interactions and diagnostics.',
    tools: ['editor_open_file', 'read_lints'],
  },
  search: {
    label: 'Search',
    icon: Search,
    description: 'Web search tools.',
    tools: ['auroro_websearch'],
  },
  task: {
    label: 'Task Management',
    icon: CheckSquare,
    description: 'Task tracking tools used during multi-step work.',
    tools: ['todo_write'],
  },
};

interface ApprovalSelectProps {
  value: ApprovalMode;
  onChange: (value: ApprovalMode) => void;
  className?: string;
}

const ApprovalSelect: React.FC<ApprovalSelectProps> = ({ value, onChange, className }) => (
  <IdeSelect
    align="end"
    ariaLabel="Select tool approval mode"
    className={clsx('min-w-[100px]', className)}
    options={[
      { label: 'Auto', value: 'auto', tone: 'success' },
      { label: 'Ask', value: 'always_ask', tone: 'warning' },
      { label: 'Deny', value: 'deny', tone: 'danger' },
    ]}
    onChange={(nextValue) => onChange(String(nextValue) as ApprovalMode)}
    value={value}
  />
);

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

  const setCategoryApproval = (
    category: keyof typeof TOOL_CATEGORIES,
    setting: ApprovalMode,
  ) => {
    const tools = TOOL_CATEGORIES[category].tools;
    tools.forEach((tool) => setToolApproval(tool, setting));
  };

  return (
    <div className="space-y-6 pb-2">
      {/* ============================================================ */}
      {/* Global controls                                              */}
      {/* ============================================================ */}
      <Section
        title="Approval Defaults"
        description="Global controls that override per-tool settings when enabled."
        badge={
          autoApproveTools ? (
            <StatusPill variant="warning">Global auto-approve on</StatusPill>
          ) : undefined
        }
      >
        <FormRow
          label="Auto-approve all tools"
          hint="Execute every tool without asking. Per-tool settings below are ignored when this is on."
        >
          <IdeSwitch
            checked={autoApproveTools}
            onChange={setAutoApproveTools}
            ariaLabel="Toggle auto-approve tools"
            variant="primary"
            size="sm"
          />
        </FormRow>

        <FormRowLast
          label="Auto-accept file changes"
          hint="Skip the diff viewer and apply file modifications immediately."
          align="top"
        >
          <IdeSwitch
            checked={autoAcceptChanges}
            onChange={setAutoAcceptChanges}
            ariaLabel="Toggle auto-accept file changes"
            variant="primary"
            size="sm"
          />
        </FormRowLast>
      </Section>

      {/* ============================================================ */}
      {/* Guardrails                                                   */}
      {/* ============================================================ */}
      <Section
        title="Agent Guardrails"
        description="Quality checks that help the agent avoid common mistakes."
      >
        <FormRow
          label="Pre-save syntax validation"
          hint="Reject writes containing syntax errors (JSON, YAML, TOML, JS/TS, JSX/TSX). The agent must fix and retry."
        >
          <IdeSwitch
            checked={syntaxValidationEnabled}
            onChange={setSyntaxValidationEnabled}
            ariaLabel="Toggle pre-save syntax validation"
            variant="success"
            size="sm"
          />
        </FormRow>

        <FormRowLast
          label="Project file map"
          hint="Inject a workspace tree snapshot into the first message so the agent knows the project layout."
        >
          <IdeSwitch
            checked={projectLayoutEnabled}
            onChange={setProjectLayoutEnabled}
            ariaLabel="Toggle project file map"
            variant="success"
            size="sm"
          />
        </FormRowLast>
      </Section>

      {/* ============================================================ */}
      {/* Limits                                                       */}
      {/* ============================================================ */}
      <Section
        title="Limits"
        description="Caps on agent execution to keep runs predictable."
      >
        <FormRowLast
          label="Max tool calls per request"
          hint="Maximum iterations the agent can take in a single conversation turn."
        >
          <IdeSlider
            value={maxToolCallsPerRequest}
            min={5}
            max={50}
            step={5}
            onChange={setMaxToolCallsPerRequest}
            ariaLabel="Max tool calls per request"
            formatValue={(v) => `${v}`}
            trackWidth={160}
          />
        </FormRowLast>
      </Section>

      {/* Auto-approve warning */}
      {autoApproveTools && (
        <div
          className="flex items-start gap-2.5 px-4 py-3 text-[11.5px]"
          style={{
            backgroundColor: 'color-mix(in srgb, var(--aurora-common-warning) 12%, transparent)',
            border: '1px solid color-mix(in srgb, var(--aurora-common-warning) 30%, transparent)',
            borderRadius: 6,
            color: 'var(--aurora-editor-foreground)',
          }}
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <span>
            Global auto-approve is on. Individual tool settings below are ignored
            until you turn this off.
          </span>
        </div>
      )}

      {/* ============================================================ */}
      {/* Per-tool approval                                            */}
      {/* ============================================================ */}
      {(Object.entries(TOOL_CATEGORIES) as [keyof typeof TOOL_CATEGORIES, ToolCategory][])
        .map(([categoryKey, category]) => {
          const Icon = category.icon;
          const isDangerous = !!category.dangerous;
          const lastIndex = category.tools.length - 1;

          return (
            <Section
              key={categoryKey}
              title={category.label}
              description={category.description}
              badge={
                isDangerous ? (
                  <StatusPill variant="danger">High risk</StatusPill>
                ) : (
                  <StatusPill variant="neutral">Read-only</StatusPill>
                )
              }
            >
              {/* Bulk actions header */}
              <div
                className="flex items-center justify-between gap-3 px-4 py-2.5"
                style={{
                  borderBottom: `1px solid ${settingsRowDividerColor}`,
                  backgroundColor:
                    'color-mix(in srgb, var(--aurora-sidebar-background) 40%, transparent)',
                }}
              >
                <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
                  <Icon className="h-3.5 w-3.5" />
                  Bulk actions
                </div>
                <div className="flex gap-1.5">
                  <ActionButton
                    variant="secondary"
                    onClick={() => setCategoryApproval(categoryKey, 'auto')}
                  >
                    All auto
                  </ActionButton>
                  <ActionButton
                    variant="secondary"
                    onClick={() => setCategoryApproval(categoryKey, 'always_ask')}
                  >
                    All ask
                  </ActionButton>
                </div>
              </div>

              {/* Per-tool rows */}
              {category.tools.map((tool, index) => {
                const isLast = index === lastIndex;
                const RowComp = isLast ? FormRowLast : FormRow;
                return (
                  <RowComp
                    key={tool}
                    label={getProfessionalToolName(tool)}
                    hint={tool}
                  >
                    <ApprovalSelect
                      value={(toolApprovalSettings[tool] || 'always_ask') as ApprovalMode}
                      onChange={(value) => setToolApproval(tool, value)}
                    />
                  </RowComp>
                );
              })}
            </Section>
          );
        })}

      {/* ============================================================ */}
      {/* Legend                                                       */}
      {/* ============================================================ */}
      <Section title="Legend" description="What each approval mode means.">
        <FormBlock divided={false}>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[11.5px]">
            <span className="flex items-center gap-2">
              <Shield className="h-3 w-3 text-success" />
              <span className="font-mono text-success">Auto</span>
              <span className="text-text-secondary">Execute immediately</span>
            </span>
            <span className="flex items-center gap-2">
              <Shield className="h-3 w-3 text-warning" />
              <span className="font-mono text-warning">Ask</span>
              <span className="text-text-secondary">Require user approval</span>
            </span>
            <span className="flex items-center gap-2">
              <Map className="h-3 w-3 text-danger" />
              <span className="font-mono text-danger">Deny</span>
              <span className="text-text-secondary">Block execution outright</span>
            </span>
          </div>
        </FormBlock>
      </Section>
    </div>
  );
};
