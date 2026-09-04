import React from 'react';
import { FolderOpen } from 'lucide-react';
import { useWorkspaceStore } from '@/kernel/store/useWorkspaceStore';
import { useCheckpointStore } from '@/kernel/store/useCheckpointStore';
import { isTauri } from '@/kernel/lib/ipc/tauri';
import { IdeSwitch } from '@/kernel/ui/IdeSwitch';
import { IdeSelect } from '@/kernel/ui/IdeSelect';
import { UI_FONT_OPTIONS } from './settings-shared';
import {
  Section,
  FormRow,
  FormRowLast,
  StatusPill,
  KeyValue,
  IdeSlider,
} from './settings-primitives';

type AutoSaveMode = 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange';

interface GeneralSettingsTabProps {
  autoSave: AutoSaveMode;
  fontSize: number;
  setAutoSave: (mode: AutoSaveMode) => void;
  setFontSize: (value: number) => void;
  setUiFontFamily: (font: string) => void;
  setUiTextScale: (scale: number) => void;
  setWrapMode: (value: boolean) => void;
  uiFontFamily: string;
  uiTextScale: number;
  wrapMode: boolean;
}

// ---------------------------------------------------------------------------
// Checkpoint section
// ---------------------------------------------------------------------------

const CheckpointSection: React.FC = () => {
  const { rootPath } = useWorkspaceStore();
  const { enabled, setEnabled } = useCheckpointStore();

  if (!rootPath) {
    return (
      <Section
        title="Checkpoints"
        description="Capture workspace state before each agent request so edits can be rolled back."
        badge={<StatusPill variant="neutral">No workspace</StatusPill>}
      >
        <div className="flex items-center gap-3 px-4 py-4">
          <p className="text-[11.5px] text-text-secondary">
            Open a workspace to configure checkpoint snapshots.
          </p>
        </div>
      </Section>
    );
  }

  const workspaceName = rootPath.split(/[/\\]/).pop() || rootPath;

  return (
    <Section
      title="Checkpoints"
      description="Capture workspace state before each agent request so edits can be rolled back."
      badge={
        <StatusPill variant={enabled ? 'success' : 'neutral'}>
          {enabled ? 'Enabled' : 'Disabled'}
        </StatusPill>
      }
    >
      <FormRow
        label="Enable checkpoints for this workspace"
        hint="Aurora creates a hidden git snapshot in app data — your real repo is untouched."
      >
        <IdeSwitch
          checked={enabled}
          onChange={setEnabled}
          ariaLabel="Toggle checkpoints"
          variant="primary"
          size="sm"
        />
      </FormRow>
      <FormRowLast label="Workspace" hint={rootPath} align="top">
        <span
          className="inline-flex items-center gap-2 rounded-[4px] px-2 py-1 text-[11.5px] font-mono"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--aurora-editor-background) 60%, transparent)',
            border: '1px solid color-mix(in srgb, var(--aurora-common-border) 50%, transparent)',
            color: 'var(--aurora-editor-foreground)',
          }}
          title={rootPath}
        >
          <FolderOpen className="h-3 w-3 text-text-secondary" />
          {workspaceName}
        </span>
      </FormRowLast>
    </Section>
  );
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const GeneralSettingsTab: React.FC<GeneralSettingsTabProps> = ({
  autoSave,
  fontSize,
  setAutoSave,
  setFontSize,
  setUiFontFamily,
  setUiTextScale,
  setWrapMode,
  uiFontFamily,
  uiTextScale,
  wrapMode,
}) => {
  return (
    <div className="space-y-6 pb-2">
      {/* ============================================================ */}
      {/* Workspace                                                    */}
      {/* ============================================================ */}
      {/* The agent's default execution mode lived here. It moved to the agent
          window's Settings › Agent, which owns agent behavior end to end. */}
      <Section
        title="Workspace"
        description="Default editor behavior across this workspace."
      >
        <FormRow
          label="Auto save"
          hint="Persist edits automatically without manual Ctrl/Cmd+S."
        >
          <IdeSelect
            align="end"
            ariaLabel="Select auto save mode"
            className="min-w-[180px]"
            options={[
              { label: 'Off', value: 'off' },
              { label: 'After delay', value: 'afterDelay', meta: '1s' },
              { label: 'On focus change', value: 'onFocusChange' },
              { label: 'On window change', value: 'onWindowChange' },
            ]}
            onChange={(nextValue) => setAutoSave(String(nextValue) as AutoSaveMode)}
            value={autoSave}
          />
        </FormRow>

        <FormRow
          label="Auto line wrap"
          hint="Wrap long lines in the editor and chat preview surfaces."
        >
          <IdeSwitch
            checked={wrapMode}
            onChange={setWrapMode}
            ariaLabel="Toggle auto line wrap"
            variant="primary"
            size="sm"
          />
        </FormRow>

        <FormRowLast label="Editor font size" hint="Affects the Monaco editor only.">
          <IdeSelect
            align="end"
            ariaLabel="Select editor font size"
            className="min-w-[110px]"
            options={[12, 14, 16, 18].map((size) => ({
              label: `${size}px`,
              value: size,
            }))}
            onChange={(nextValue) => setFontSize(Number(nextValue))}
            value={fontSize}
          />
        </FormRowLast>
      </Section>

      {/* ============================================================ */}
      {/* Appearance                                                   */}
      {/* ============================================================ */}
      <Section
        title="Appearance"
        description="Tune typography for chrome surfaces — labels, panels, and menus."
      >
        <FormRow label="UI font family" hint="Applied to chrome, labels, and panels.">
          <IdeSelect
            align="end"
            ariaLabel="Select UI font"
            className="min-w-[170px]"
            options={UI_FONT_OPTIONS.map((option) => ({
              label: option.label,
              value: option.value,
            }))}
            onChange={(nextValue) => setUiFontFamily(String(nextValue))}
            value={uiFontFamily}
          />
        </FormRow>

        <FormRowLast
          label="UI text scale"
          hint="Adjust text density without scaling the entire app."
        >
          <IdeSlider
            value={uiTextScale}
            min={0.85}
            max={1.4}
            step={0.05}
            onChange={setUiTextScale}
            ariaLabel="UI text scale"
            formatValue={(v) => `${Math.round(v * 100)}%`}
          />
        </FormRowLast>
      </Section>

      {/* ============================================================ */}
      {/* Checkpoints                                                  */}
      {/* ============================================================ */}
      <CheckpointSection />

      {/* System integrations — the Aurora CLI and the Explorer right-click
          menu — moved to the agent window's Settings › Preferences › General,
          beside Startup. Both exist to LAUNCH Aurora, and what they launch you
          into is the agent window; the reason to install the CLI now is
          `aurora agent` and `aurora mcp`, neither of which the editor owns. */}

      {/* ============================================================ */}
      {/* About workspace details (read-only summary)                  */}
      {/* ============================================================ */}
      <Section
        title="Diagnostics"
        description="Quick reference for support requests and bug reports."
      >
        <div
          className="grid grid-cols-2 gap-x-6 gap-y-2.5 px-4 py-3.5"
          style={{ borderBottom: 'none' }}
        >
          <KeyValue label="Runtime" value={isTauri() ? 'Tauri Desktop' : 'Browser'} />
          <KeyValue label="Platform" value={typeof navigator !== 'undefined' ? navigator.platform : '—'} />
          <KeyValue label="UI Scale" value={`${Math.round(uiTextScale * 100)}%`} mono />
          <KeyValue label="Editor Font" value={`${fontSize}px`} mono />
          <KeyValue label="UI Font" value={uiFontFamily} mono />
          <KeyValue
            label="Auto Save"
            value={
              autoSave === 'off'
                ? 'Off'
                : autoSave === 'afterDelay'
                  ? '1s delay'
                  : autoSave === 'onFocusChange'
                    ? 'Focus change'
                    : 'Window change'
            }
          />
        </div>
      </Section>
    </div>
  );
};
