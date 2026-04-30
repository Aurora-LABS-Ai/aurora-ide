import React, { useEffect, useState } from 'react';
import { Terminal, FolderOpen } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useCheckpointStore } from '../../store/useCheckpointStore';
import type { AgentExecutionMode } from '../../services/agent-execution-mode';
import {
  isAuroraCliInstalled,
  installAuroraCli,
  isAuroraContextMenuInstalled,
  isTauri,
  installAuroraContextMenu,
  uninstallAuroraCli,
  uninstallAuroraContextMenu,
} from '../../lib/tauri';
import { IdeSwitch } from '../ui/IdeSwitch';
import { IdeSelect } from '../ui/IdeSelect';
import {
  UI_FONT_OPTIONS,
  settingsRowDividerColor,
  settingsCodeBlockStyle,
} from './settings-shared';
import {
  Section,
  FormRow,
  FormRowLast,
  StatusPill,
  ActionButton,
  KeyValue,
  IntegrationBanner,
  IdeSlider,
  type BannerStatus,
} from './settings-primitives';

type AutoSaveMode = 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange';
type IntegrationStatus = BannerStatus;

interface GeneralSettingsTabProps {
  agentExecutionMode: AgentExecutionMode;
  autoSave: AutoSaveMode;
  fontSize: number;
  setAgentExecutionMode: (mode: AgentExecutionMode) => void;
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
  agentExecutionMode,
  autoSave,
  fontSize,
  setAgentExecutionMode,
  setAutoSave,
  setFontSize,
  setUiFontFamily,
  setUiTextScale,
  setWrapMode,
  uiFontFamily,
  uiTextScale,
  wrapMode,
}) => {
  const [cliStatus, setCliStatus] = useState<IntegrationStatus>('idle');
  const [cliMessage, setCliMessage] = useState('');
  const [cliInstalled, setCliInstalled] = useState<boolean | null>(null);
  const [isCheckingCli, setIsCheckingCli] = useState(() => isTauri());
  const isWindowsDesktop =
    isTauri() && typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');
  const [contextMenuStatus, setContextMenuStatus] = useState<IntegrationStatus>('idle');
  const [contextMenuMessage, setContextMenuMessage] = useState('');
  const [contextMenuInstalled, setContextMenuInstalled] = useState<boolean | null>(() =>
    isWindowsDesktop ? null : false,
  );
  const [isCheckingContextMenu, setIsCheckingContextMenu] = useState(() => isWindowsDesktop);

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    isAuroraCliInstalled()
      .then((installed) => {
        if (active) setCliInstalled(installed);
      })
      .catch(() => {
        if (active) setCliInstalled(null);
      })
      .finally(() => {
        if (active) setIsCheckingCli(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!isWindowsDesktop) return;
    let active = true;
    isAuroraContextMenuInstalled()
      .then((installed) => {
        if (active) setContextMenuInstalled(installed);
      })
      .catch(() => {
        if (active) setContextMenuInstalled(null);
      })
      .finally(() => {
        if (active) setIsCheckingContextMenu(false);
      });
    return () => {
      active = false;
    };
  }, [isWindowsDesktop]);

  const handleInstallCli = async () => {
    if (!isTauri()) {
      setCliStatus('error');
      setCliMessage('CLI installation requires the desktop app.');
      return;
    }
    setCliStatus('installing');
    setCliMessage('Installing Aurora CLI...');
    try {
      const result = await installAuroraCli();
      setCliStatus('success');
      setCliMessage(result || 'Aurora CLI installed. Restart the terminal to use `aurora .`.');
      setCliInstalled(true);
    } catch (error) {
      setCliStatus('error');
      setCliMessage(error instanceof Error ? error.message : 'Failed to install the CLI.');
    }
  };

  const handleUninstallCli = async () => {
    if (!isTauri()) return;
    setCliStatus('uninstalling');
    setCliMessage('Uninstalling Aurora CLI...');
    try {
      const result = await uninstallAuroraCli();
      setCliStatus('success');
      setCliMessage(result || 'Aurora CLI removed.');
      setCliInstalled(false);
    } catch (error) {
      setCliStatus('error');
      setCliMessage(error instanceof Error ? error.message : 'Failed to uninstall the CLI.');
    }
  };

  const handleInstallContextMenu = async () => {
    if (!isWindowsDesktop) {
      setContextMenuStatus('error');
      setContextMenuMessage(
        'Windows Explorer context menu integration is only available on Windows desktop builds.',
      );
      return;
    }
    setContextMenuStatus('installing');
    setContextMenuMessage('Adding Aurora to the Explorer context menu...');
    try {
      const result = await installAuroraContextMenu();
      setContextMenuStatus('success');
      setContextMenuMessage(result || 'Aurora added to the Explorer context menu.');
      setContextMenuInstalled(true);
    } catch (error) {
      setContextMenuStatus('error');
      setContextMenuMessage(
        error instanceof Error
          ? error.message
          : 'Failed to add Aurora to the Explorer context menu.',
      );
    }
  };

  const handleUninstallContextMenu = async () => {
    if (!isWindowsDesktop) return;
    setContextMenuStatus('uninstalling');
    setContextMenuMessage('Removing Aurora from the Explorer context menu...');
    try {
      const result = await uninstallAuroraContextMenu();
      setContextMenuStatus('success');
      setContextMenuMessage(result || 'Aurora removed from the Explorer context menu.');
      setContextMenuInstalled(false);
    } catch (error) {
      setContextMenuStatus('error');
      setContextMenuMessage(
        error instanceof Error
          ? error.message
          : 'Failed to remove Aurora from the Explorer context menu.',
      );
    }
  };

  const cliBadge: React.ReactNode = isCheckingCli ? (
    <StatusPill variant="neutral" dot={false}>
      Checking…
    </StatusPill>
  ) : cliInstalled ? (
    <StatusPill variant="success">Installed</StatusPill>
  ) : (
    <StatusPill variant="neutral">Not installed</StatusPill>
  );

  const ctxBadge: React.ReactNode = isCheckingContextMenu ? (
    <StatusPill variant="neutral" dot={false}>
      Checking…
    </StatusPill>
  ) : contextMenuInstalled ? (
    <StatusPill variant="success">Registered</StatusPill>
  ) : (
    <StatusPill variant="neutral">Not registered</StatusPill>
  );

  return (
    <div className="space-y-6 pb-2">
      {/* ============================================================ */}
      {/* Workspace                                                    */}
      {/* ============================================================ */}
      <Section
        title="Workspace"
        description="Default behavior the agent and editor use across this workspace."
      >
        <FormRow
          label="Default agent mode"
          hint="Aurora restores this on launch. You can switch from the input box at any time."
        >
          <IdeSelect
            align="end"
            ariaLabel="Select default agent behavior"
            className="min-w-[150px]"
            options={[
              {
                label: 'Agent mode',
                value: 'agent',
                description: 'Ready to implement requested changes.',
              },
              {
                label: 'Plan mode',
                value: 'plan',
                description: 'Read-only — blocks workspace edits.',
              },
            ]}
            onChange={(nextValue) =>
              setAgentExecutionMode(String(nextValue) as AgentExecutionMode)
            }
            value={agentExecutionMode}
          />
        </FormRow>

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

      {/* ============================================================ */}
      {/* System integrations                                          */}
      {/* ============================================================ */}
      <Section
        title="System Integrations"
        description="Surface Aurora in the operating system shell so users can launch into a workspace from anywhere."
      >
        {/* CLI block */}
        <div className="px-4 py-3.5" style={{ borderBottom: `1px solid ${settingsRowDividerColor}` }}>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 max-w-[58%]">
              <div className="flex items-center gap-2">
                <Terminal className="h-3.5 w-3.5 text-text-secondary" />
                <p className="text-[12.5px] font-medium text-text-primary">Aurora CLI</p>
                {cliBadge}
              </div>
              <p className="mt-1.5 text-[11px] leading-snug text-text-secondary">
                Launch Aurora directly from a terminal with a workspace path or file.
              </p>
            </div>
            <div className="flex shrink-0 items-center justify-end">
              {cliInstalled ? (
                <ActionButton
                  variant="danger"
                  onClick={handleUninstallCli}
                  loading={cliStatus === 'uninstalling'}
                  disabled={cliStatus === 'uninstalling'}
                >
                  {cliStatus === 'uninstalling' ? 'Removing' : 'Uninstall'}
                </ActionButton>
              ) : (
                <ActionButton
                  variant="primary"
                  onClick={handleInstallCli}
                  loading={cliStatus === 'installing' || isCheckingCli}
                  disabled={cliStatus === 'installing' || isCheckingCli}
                >
                  {cliStatus === 'installing' || isCheckingCli ? 'Working' : 'Install CLI'}
                </ActionButton>
              )}
            </div>
          </div>

          <div className="mt-3 px-3 py-2 font-mono text-[11px]" style={settingsCodeBlockStyle}>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-disabled">
              Usage
            </p>
            <div className="space-y-0.5 text-text-secondary">
              <p>
                <span className="text-primary">aurora .</span>
                <span className="ml-2">Open the current folder</span>
              </p>
              <p>
                <span className="text-primary">aurora /path/to/project</span>
                <span className="ml-2">Open a specific workspace</span>
              </p>
              <p>
                <span className="text-primary">aurora file.ts</span>
                <span className="ml-2">Open a file directly</span>
              </p>
            </div>
          </div>
        </div>

        {cliMessage && <IntegrationBanner status={cliStatus} message={cliMessage} />}

        {/* Context menu (Windows only) */}
        {isWindowsDesktop && (
          <>
            <div className="px-4 py-3.5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 max-w-[58%]">
                  <div className="flex items-center gap-2">
                    <FolderOpen className="h-3.5 w-3.5 text-text-secondary" />
                    <p className="text-[12.5px] font-medium text-text-primary">
                      Explorer context menu
                    </p>
                    {ctxBadge}
                  </div>
                  <p className="mt-1.5 text-[11px] leading-snug text-text-secondary">
                    Right-click any folder or folder background and choose{' '}
                    <span className="font-semibold text-text-primary">Open with Aurora</span>.
                  </p>
                </div>
                <div className="flex shrink-0 items-center justify-end">
                  {contextMenuInstalled ? (
                    <ActionButton
                      variant="danger"
                      onClick={handleUninstallContextMenu}
                      loading={contextMenuStatus === 'uninstalling'}
                      disabled={contextMenuStatus === 'uninstalling'}
                    >
                      {contextMenuStatus === 'uninstalling' ? 'Removing' : 'Remove'}
                    </ActionButton>
                  ) : (
                    <ActionButton
                      variant="primary"
                      onClick={handleInstallContextMenu}
                      loading={contextMenuStatus === 'installing' || isCheckingContextMenu}
                      disabled={contextMenuStatus === 'installing' || isCheckingContextMenu}
                    >
                      {contextMenuStatus === 'installing' || isCheckingContextMenu
                        ? 'Working'
                        : 'Add to context menu'}
                    </ActionButton>
                  )}
                </div>
              </div>
            </div>

            {contextMenuMessage && (
              <IntegrationBanner status={contextMenuStatus} message={contextMenuMessage} />
            )}
          </>
        )}
      </Section>

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
