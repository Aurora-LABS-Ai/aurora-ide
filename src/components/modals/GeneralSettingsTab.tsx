import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, FolderOpen, History, Laptop, Save, Terminal, Type, WrapText } from 'lucide-react';
import clsx from 'clsx';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useCheckpointStore } from '../../store/useCheckpointStore';
import {
  isAuroraCliInstalled,
  installAuroraCli,
  isAuroraContextMenuInstalled,
  isTauri,
  installAuroraContextMenu,
  uninstallAuroraCli,
  uninstallAuroraContextMenu,
} from '../../lib/tauri';
import { TogglePill } from '../ui/TogglePill';
import { SettingsSelect } from '../ui/SettingsSelect';
import { settingsCardStyle, settingsPrimaryButtonStyle, settingsSubtlePanelStyle, UI_FONT_OPTIONS } from './settings-shared';

type AutoSaveMode = 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange';
type IntegrationStatus = 'idle' | 'installing' | 'uninstalling' | 'success' | 'error';

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

const innerPanelStyle: React.CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--aurora-common-secondary) 76%, var(--aurora-sidebar-background) 24%)',
  border: '1px solid color-mix(in srgb, var(--aurora-common-border) 58%, transparent)',
};

const CheckpointSettingsCard: React.FC = () => {
  const { rootPath } = useWorkspaceStore();
  const { enabled, setEnabled } = useCheckpointStore();

  if (!rootPath) {
    return (
      <div className="rounded-[20px] p-4" style={settingsCardStyle}>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <History className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Checkpoints</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
              Open a workspace to configure checkpoint snapshots.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const workspaceName = rootPath.split(/[/\\]/).pop() || rootPath;

  return (
    <div className="rounded-[20px] p-4" style={settingsCardStyle}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <History className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text-primary">Checkpoints</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
              Capture workspace state before each request so you can roll back AI edits cleanly.
            </p>
          </div>
        </div>
        <TogglePill
          checked={enabled}
          onChange={setEnabled}
          ariaLabel="Toggle checkpoints"
          variant="checkpoint"
          size="sm"
          className="shrink-0"
        />
      </div>

      <div className="mt-4 rounded-2xl px-3 py-3" style={innerPanelStyle}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">Workspace Scope</p>
            <p className="mt-1 text-xs font-medium text-text-primary">{workspaceName}</p>
          </div>
          <div className="rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
            {enabled ? 'Enabled' : 'Disabled'}
          </div>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-text-secondary" title={rootPath}>
          {rootPath}
        </p>
      </div>
    </div>
  );
};

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
  const [cliStatus, setCliStatus] = useState<IntegrationStatus>('idle');
  const [cliMessage, setCliMessage] = useState('');
  const [cliInstalled, setCliInstalled] = useState<boolean | null>(null);
  const [isCheckingCli, setIsCheckingCli] = useState(() => isTauri());
  const isWindowsDesktop =
    isTauri() && typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');
  const [contextMenuStatus, setContextMenuStatus] = useState<IntegrationStatus>('idle');
  const [contextMenuMessage, setContextMenuMessage] = useState('');
  const [contextMenuInstalled, setContextMenuInstalled] = useState<boolean | null>(() => (isWindowsDesktop ? null : false));
  const [isCheckingContextMenu, setIsCheckingContextMenu] = useState(() => isWindowsDesktop);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }

    let active = true;
    isAuroraCliInstalled()
      .then((installed) => {
        if (active) {
          setCliInstalled(installed);
        }
      })
      .catch(() => {
        if (active) {
          setCliInstalled(null);
        }
      })
      .finally(() => {
        if (active) {
          setIsCheckingCli(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!isWindowsDesktop) {
      return;
    }

    let active = true;
    isAuroraContextMenuInstalled()
      .then((installed) => {
        if (active) {
          setContextMenuInstalled(installed);
        }
      })
      .catch(() => {
        if (active) {
          setContextMenuInstalled(null);
        }
      })
      .finally(() => {
        if (active) {
          setIsCheckingContextMenu(false);
        }
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
    if (!isTauri()) {
      return;
    }

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
      setContextMenuMessage('Windows Explorer context menu integration is only available on Windows desktop builds.');
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
      setContextMenuMessage(error instanceof Error ? error.message : 'Failed to add Aurora to the Explorer context menu.');
    }
  };

  const handleUninstallContextMenu = async () => {
    if (!isWindowsDesktop) {
      return;
    }

    setContextMenuStatus('uninstalling');
    setContextMenuMessage('Removing Aurora from the Explorer context menu...');

    try {
      const result = await uninstallAuroraContextMenu();
      setContextMenuStatus('success');
      setContextMenuMessage(result || 'Aurora removed from the Explorer context menu.');
      setContextMenuInstalled(false);
    } catch (error) {
      setContextMenuStatus('error');
      setContextMenuMessage(error instanceof Error ? error.message : 'Failed to remove Aurora from the Explorer context menu.');
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-[20px] p-4" style={settingsCardStyle}>
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Type className="h-4 w-4" />
          </div>
          <p className="mt-4 text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">UI Text</p>
          <p className="mt-1 text-xl font-semibold text-text-primary">{Math.round(uiTextScale * 100)}%</p>
          <p className="mt-1 text-[11px] text-text-secondary">Global interface text scale.</p>
        </div>
        <div className="rounded-[20px] p-4" style={settingsCardStyle}>
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <WrapText className="h-4 w-4" />
          </div>
          <p className="mt-4 text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">Wrap Mode</p>
          <p className="mt-1 text-xl font-semibold text-text-primary">{wrapMode ? 'On' : 'Off'}</p>
          <p className="mt-1 text-[11px] text-text-secondary">Editor and preview line wrapping.</p>
        </div>
        <div className="rounded-[20px] p-4" style={settingsCardStyle}>
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Save className="h-4 w-4" />
          </div>
          <p className="mt-4 text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">Auto Save</p>
          <p className="mt-1 text-xl font-semibold text-text-primary">{autoSave === 'off' ? 'Off' : 'On'}</p>
          <p className="mt-1 text-[11px] text-text-secondary">Current mode: {autoSave}</p>
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] gap-4">
        <div className="space-y-4">
          <div className="rounded-[20px] p-4" style={settingsCardStyle}>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Laptop className="h-4 w-4" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-text-primary">Interface</h3>
                <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
                  Tune reading comfort without breaking theme consistency.
                </p>
              </div>
            </div>

            <div className="mt-4 space-y-4">
              <div className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] items-center gap-3">
                <div>
                  <label className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">UI Font</label>
                  <p className="mt-1 text-[11px] text-text-secondary">Applied to chrome, labels, and panels.</p>
                </div>
                <SettingsSelect
                  ariaLabel="Select UI font"
                  options={UI_FONT_OPTIONS.map((option) => ({
                    label: option.label,
                    value: option.value,
                  }))}
                  onChange={(nextValue) => setUiFontFamily(String(nextValue))}
                  value={uiFontFamily}
                />
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">Text Scale</p>
                    <p className="mt-1 text-[11px] text-text-secondary">Adjust text density without scaling the whole app.</p>
                  </div>
                  <div className="rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
                    {Math.round(uiTextScale * 100)}%
                  </div>
                </div>
                <input
                  type="range"
                  min="0.85"
                  max="1.4"
                  step="0.05"
                  value={uiTextScale}
                  onChange={(event) => setUiTextScale(Number(event.target.value))}
                  className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-input-border [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
                />
              </div>
            </div>
          </div>

          <div className="rounded-[20px] p-4" style={settingsCardStyle}>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Terminal className="h-4 w-4" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-text-primary">CLI Integration</h3>
                <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
                  Launch Aurora directly from a terminal with a workspace or file path.
                </p>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl px-3 py-3" style={innerPanelStyle}>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">CLI Status</p>
                <p className="mt-1 text-xs font-medium text-text-primary">
                  {isCheckingCli ? 'Checking installation...' : cliInstalled ? 'Installed and ready' : 'Not installed'}
                </p>
              </div>
              {cliInstalled ? (
                <button
                  onClick={handleUninstallCli}
                  disabled={cliStatus === 'uninstalling'}
                  className="rounded-xl px-3 py-2 text-xs font-semibold text-danger disabled:opacity-50"
                  style={{
                    ...settingsSubtlePanelStyle,
                    backgroundColor: 'color-mix(in srgb, var(--aurora-common-danger) 10%, var(--aurora-common-secondary))',
                    border: '1px solid color-mix(in srgb, var(--aurora-common-danger) 26%, transparent)',
                  }}
                >
                  {cliStatus === 'uninstalling' ? 'Removing...' : 'Uninstall CLI'}
                </button>
              ) : (
                <button
                  onClick={handleInstallCli}
                  disabled={cliStatus === 'installing' || isCheckingCli}
                  className="rounded-xl px-3 py-2 text-xs font-semibold text-success-foreground disabled:opacity-50"
                  style={{
                    ...settingsPrimaryButtonStyle,
                    backgroundColor: 'var(--aurora-common-success)',
                    boxShadow: '0 10px 24px color-mix(in srgb, var(--aurora-common-success) 22%, transparent)',
                  }}
                >
                  {cliStatus === 'installing' || isCheckingCli ? 'Working...' : 'Install CLI'}
                </button>
              )}
            </div>

            {cliMessage && (
              <div
                className={clsx(
                  'mt-3 flex items-start gap-2 rounded-2xl px-3 py-3 text-[11px]',
                  cliStatus === 'success' && 'text-success',
                  cliStatus === 'error' && 'text-danger',
                  (cliStatus === 'installing' || cliStatus === 'uninstalling') && 'text-primary',
                )}
                style={{
                  backgroundColor:
                    cliStatus === 'success'
                      ? 'color-mix(in srgb, var(--aurora-common-success) 12%, transparent)'
                      : cliStatus === 'error'
                        ? 'color-mix(in srgb, var(--aurora-common-danger) 12%, transparent)'
                        : 'color-mix(in srgb, var(--aurora-common-primary) 12%, transparent)',
                }}
              >
                {cliStatus === 'success' && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}
                {cliStatus === 'error' && <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
                {(cliStatus === 'installing' || cliStatus === 'uninstalling') && (
                  <Terminal className="mt-0.5 h-4 w-4 shrink-0" />
                )}
                <span>{cliMessage}</span>
              </div>
            )}

            <div className="mt-3 rounded-2xl px-3 py-3 font-mono text-[11px]" style={innerPanelStyle}>
              <p className="font-semibold text-text-primary">Usage</p>
              <div className="mt-2 space-y-1 text-text-secondary">
                <p><span className="text-primary">aurora .</span> Open the current folder</p>
                <p><span className="text-primary">aurora /path/to/project</span> Open a specific workspace</p>
                <p><span className="text-primary">aurora file.ts</span> Open a file directly</p>
              </div>
            </div>
          </div>

          {isWindowsDesktop && (
            <div className="rounded-[20px] p-4" style={settingsCardStyle}>
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <FolderOpen className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-text-primary">Explorer Context Menu</h3>
                  <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
                    Add Aurora to the Windows right-click menu for folders, drives, and open folder backgrounds.
                  </p>
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl px-3 py-3" style={innerPanelStyle}>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">Integration Status</p>
                  <p className="mt-1 text-xs font-medium text-text-primary">
                    {isCheckingContextMenu ? 'Checking registration...' : contextMenuInstalled ? 'Registered in Explorer' : 'Not registered'}
                  </p>
                </div>
                {contextMenuInstalled ? (
                  <button
                    onClick={handleUninstallContextMenu}
                    disabled={contextMenuStatus === 'uninstalling'}
                    className="rounded-xl px-3 py-2 text-xs font-semibold text-danger disabled:opacity-50"
                    style={{
                      ...settingsSubtlePanelStyle,
                      backgroundColor: 'color-mix(in srgb, var(--aurora-common-danger) 10%, var(--aurora-common-secondary))',
                      border: '1px solid color-mix(in srgb, var(--aurora-common-danger) 26%, transparent)',
                    }}
                  >
                    {contextMenuStatus === 'uninstalling' ? 'Removing...' : 'Remove Context Menu'}
                  </button>
                ) : (
                  <button
                    onClick={handleInstallContextMenu}
                    disabled={contextMenuStatus === 'installing' || isCheckingContextMenu}
                    className="rounded-xl px-3 py-2 text-xs font-semibold text-success-foreground disabled:opacity-50"
                    style={{
                      ...settingsPrimaryButtonStyle,
                      backgroundColor: 'var(--aurora-common-success)',
                      boxShadow: '0 10px 24px color-mix(in srgb, var(--aurora-common-success) 22%, transparent)',
                    }}
                  >
                    {contextMenuStatus === 'installing' || isCheckingContextMenu ? 'Working...' : 'Add to Context Menu'}
                  </button>
                )}
              </div>

              {contextMenuMessage && (
                <div
                  className={clsx(
                    'mt-3 flex items-start gap-2 rounded-2xl px-3 py-3 text-[11px]',
                    contextMenuStatus === 'success' && 'text-success',
                    contextMenuStatus === 'error' && 'text-danger',
                    (contextMenuStatus === 'installing' || contextMenuStatus === 'uninstalling') && 'text-primary',
                  )}
                  style={{
                    backgroundColor:
                      contextMenuStatus === 'success'
                        ? 'color-mix(in srgb, var(--aurora-common-success) 12%, transparent)'
                        : contextMenuStatus === 'error'
                          ? 'color-mix(in srgb, var(--aurora-common-danger) 12%, transparent)'
                          : 'color-mix(in srgb, var(--aurora-common-primary) 12%, transparent)',
                  }}
                >
                  {contextMenuStatus === 'success' && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}
                  {contextMenuStatus === 'error' && <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
                  {(contextMenuStatus === 'installing' || contextMenuStatus === 'uninstalling') && (
                    <FolderOpen className="mt-0.5 h-4 w-4 shrink-0" />
                  )}
                  <span>{contextMenuMessage}</span>
                </div>
              )}

              <div className="mt-3 rounded-2xl px-3 py-3 text-[11px] text-text-secondary" style={innerPanelStyle}>
                Right-click any folder or folder background in Explorer and choose <span className="font-semibold text-text-primary">Open with Aurora</span>.
              </div>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="rounded-[20px] p-4" style={settingsCardStyle}>
            <h3 className="text-sm font-semibold text-text-primary">Editor</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
              Set the text density and save behavior used by code editing and previews.
            </p>

            <div className="mt-4 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">Font Size</p>
                  <p className="mt-1 text-[11px] text-text-secondary">Editor text size only.</p>
                </div>
                <SettingsSelect
                  ariaLabel="Select editor font size"
                  className="w-[110px]"
                  options={[12, 14, 16, 18].map((size) => ({
                    label: `${size}px`,
                    value: size,
                  }))}
                  onChange={(nextValue) => setFontSize(Number(nextValue))}
                  value={fontSize}
                />
              </div>

              <div className="flex items-center justify-between gap-3 rounded-2xl px-3 py-3" style={innerPanelStyle}>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">Auto Line Wrap</p>
                  <p className="mt-1 text-[11px] text-text-secondary">Controls wrapping in editors and previews.</p>
                </div>
                <TogglePill
                  checked={wrapMode}
                  onChange={setWrapMode}
                  ariaLabel="Toggle auto line wrap"
                  variant="primary"
                  size="sm"
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">Auto Save</p>
                  <p className="mt-1 text-[11px] text-text-secondary">Persist changes automatically.</p>
                </div>
                <SettingsSelect
                  align="end"
                  ariaLabel="Select auto save mode"
                  className="w-[170px]"
                  options={[
                    { label: 'Off', value: 'off' },
                    { label: 'After Delay (1s)', value: 'afterDelay' },
                    { label: 'On Focus Change', value: 'onFocusChange' },
                    { label: 'On Window Change', value: 'onWindowChange' },
                  ]}
                  onChange={(nextValue) => setAutoSave(String(nextValue) as AutoSaveMode)}
                  value={autoSave}
                />
              </div>
            </div>
          </div>

          <CheckpointSettingsCard />
        </div>
      </div>
    </div>
  );
};
