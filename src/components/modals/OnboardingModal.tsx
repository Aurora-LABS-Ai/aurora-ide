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

import React, { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Cloud,
  Eye,
  EyeOff,
  ExternalLink,
  FolderOpen,
  HardDrive,
  Keyboard,
  Loader2,
  Settings,
  Terminal,
  Zap
} from 'lucide-react';
import { clsx } from 'clsx';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useUiStore } from '../../store/useUiStore';
import { installAuroraContextMenu, isAuroraContextMenuInstalled, isTauri, openFileDialog } from '../../lib/tauri';
import { TogglePill } from '../ui/TogglePill';
import { LocalProviderPanel } from '../settings/LocalProviderPanel';

type StepId = 'welcome' | 'setup' | 'shortcuts';

const STEPS: { id: StepId; label: string }[] = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'setup', label: 'Setup' },
  { id: 'shortcuts', label: 'Shortcuts' },
];

const ShortcutKey: React.FC<{ label: string; keys: string[] }> = ({ label, keys }) => (
  <div className="rounded-xl border border-border bg-editor px-3 py-3">
    <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary mb-2">{label}</p>
    <div className="flex flex-wrap items-center gap-1.5">
      {keys.map((k) => (
        <kbd
          key={k}
          className="min-w-[24px] rounded-md border border-border bg-sidebar px-2 py-1 text-[11px] font-mono text-text-primary text-center"
        >
          {k}
        </kbd>
      ))}
    </div>
  </div>
);

export const OnboardingModal: React.FC = () => {
  const hasSeenOnboarding = useSettingsStore((state) => state.hasSeenOnboarding);
  const setHasSeenOnboarding = useSettingsStore((state) => state.setHasSeenOnboarding);
  const providers = useSettingsStore((state) => state.providers);
  const updateProvider = useSettingsStore((state) => state.updateProvider);
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const setRootPath = useWorkspaceStore((state) => state.setRootPath);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);

  const [currentStep, setCurrentStep] = useState(0);
  const [isOpeningWorkspace, setIsOpeningWorkspace] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [isTestingKey, setIsTestingKey] = useState(false);
  const [keyTestResult, setKeyTestResult] = useState<'success' | 'error' | null>(null);
  const [keyTestMessage, setKeyTestMessage] = useState<string | null>(null);
  const [providerMode, setProviderMode] = useState<'cloud' | 'local'>('cloud');
  const [shouldInstallContextMenu, setShouldInstallContextMenu] = useState(() => isTauri() && typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows'));
  const [contextMenuInstalled, setContextMenuInstalled] = useState(false);
  const [contextMenuMessage, setContextMenuMessage] = useState<string | null>(null);
  const [isApplyingIntegrations, setIsApplyingIntegrations] = useState(false);
  const isWindowsDesktop =
    isTauri() && typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');

  const activeStep = STEPS[currentStep];
  const workspaceReady = Boolean(rootPath);
  const providerReady = useMemo(() => {
    return providers.some((provider) => {
      if (!provider.enabled) return false;

      const baseUrl = provider.baseUrl.toLowerCase();
      const isLocal = baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1');
      const hasApiKey = provider.apiKey.trim().length > 0;
      const needsApiKey = provider.requiresApiKey !== false && !isLocal;

      return needsApiKey ? hasApiKey : true;
    });
  }, [providers]);

  const handleSaveApiKey = async () => {
    const trimmedKey = apiKeyInput.trim();
    if (!trimmedKey) return;

    setIsTestingKey(true);
    setKeyTestResult(null);
    setKeyTestMessage(null);

    try {
      const fireworksProvider = providers.find(p => p.id === 'fireworks');
      if (!fireworksProvider) {
        setKeyTestResult('error');
        setKeyTestMessage('Fireworks provider not found in configuration.');
        return;
      }

      const response = await fetch(`${fireworksProvider.baseUrl}/models`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${trimmedKey}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      });

      if (response.ok || response.status === 200) {
        updateProvider('fireworks', { apiKey: trimmedKey });
        setKeyTestResult('success');
        setKeyTestMessage('Connected successfully! You\'re ready to chat.');
      } else if (response.status === 401 || response.status === 403) {
        setKeyTestResult('error');
        setKeyTestMessage('Invalid API key. Please check and try again.');
      } else {
        updateProvider('fireworks', { apiKey: trimmedKey });
        setKeyTestResult('success');
        setKeyTestMessage('API key saved. Connection will be verified on first use.');
      }
    } catch {
      updateProvider('fireworks', { apiKey: trimmedKey });
      setKeyTestResult('success');
      setKeyTestMessage('API key saved. Connection will be verified on first use.');
    } finally {
      setIsTestingKey(false);
    }
  };

  const handleComplete = async () => {
    if (isWindowsDesktop && shouldInstallContextMenu && !contextMenuInstalled) {
      setIsApplyingIntegrations(true);
      setContextMenuMessage('Adding Aurora to the Windows Explorer context menu...');
      try {
        await installAuroraContextMenu();
        setContextMenuInstalled(true);
        setContextMenuMessage('Aurora was added to the Windows Explorer context menu.');
      } catch (error) {
        setContextMenuMessage(error instanceof Error ? error.message : 'Could not add Aurora to the Explorer context menu.');
        setIsApplyingIntegrations(false);
        return;
      }
      setIsApplyingIntegrations(false);
    }

    setHasSeenOnboarding(true);
  };

  const handleSkip = () => {
    setHasSeenOnboarding(true);
  };

  const handleOpenSettings = () => {
    setSettingsOpen(true);
  };

  const handleOpenWorkspace = async () => {
    if (!isTauri()) {
      setWorkspaceError('Workspace picker is available in the desktop app.');
      return;
    }

    setWorkspaceError(null);
    setIsOpeningWorkspace(true);
    try {
      const selected = await openFileDialog({
        directory: true,
        multiple: false,
      });

      if (typeof selected === 'string' && selected.trim()) {
        setRootPath(selected);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setWorkspaceError(`Could not open workspace picker. ${message}`);
    } finally {
      setIsOpeningWorkspace(false);
    }
  };

  React.useEffect(() => {
    if (!isWindowsDesktop) {
      return;
    }

    let active = true;
    isAuroraContextMenuInstalled()
      .then((installed) => {
        if (active) {
          setContextMenuInstalled(installed);
          if (installed) {
            setShouldInstallContextMenu(true);
          }
        }
      })
      .catch(() => {
        if (active) {
          setContextMenuInstalled(false);
        }
      });

    return () => {
      active = false;
    };
  }, [isWindowsDesktop]);

  if (hasSeenOnboarding) return null;

  return (
    <div className="h-full w-full bg-editor text-text-primary relative overflow-hidden">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(80rem 40rem at -10% -20%, var(--aurora-common-primary), transparent 65%), radial-gradient(70rem 35rem at 110% 120%, var(--aurora-common-info), transparent 70%)',
          opacity: 0.08,
        }}
      />

      <div className="relative h-full w-full p-4 md:p-8">
        <div className="h-full rounded-2xl border border-border bg-sidebar shadow-premium-lg overflow-hidden flex flex-col lg:flex-row">
          <aside className="w-full lg:w-[320px] border-b lg:border-b-0 lg:border-r border-border bg-editor px-6 py-7">
            <div className="flex items-center gap-2 mb-8">
              <div className="h-8 w-8 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center">
                <img src="/empty-state.png" alt="Onboarding" className="w-5 h-5 object-contain" />
              </div>
              <div className="sora-font text-lg font-bold tracking-tight">
                <span className="text-primary">Aurora</span>
                <span className="text-text-secondary"> IDE</span>
              </div>
            </div>

            <div className="space-y-3">
              {STEPS.map((step, index) => {
                const isActive = index === currentStep;
                const isDone = index < currentStep;
                return (
                  <button
                    key={step.id}
                    onClick={() => setCurrentStep(index)}
                    className={clsx(
                      'w-full rounded-xl border px-3 py-2.5 text-left transition-all',
                      isActive ? 'border-primary bg-primary/10' : 'border-border bg-sidebar hover:bg-sidebar-item-hover'
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span className={clsx('text-sm font-medium', isActive ? 'text-text-primary' : 'text-text-secondary')}>
                        {step.label}
                      </span>
                      {isDone && <Check className="w-4 h-4 text-success" />}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="mt-8 rounded-xl border border-border bg-sidebar p-3">
              <p className="text-[11px] uppercase tracking-wide text-text-secondary mb-2">Readiness</p>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-text-secondary">Workspace</span>
                  <span className={workspaceReady ? 'text-success' : 'text-warning'}>
                    {workspaceReady ? 'Connected' : 'Not set'}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-text-secondary">Provider</span>
                  <span className={providerReady ? 'text-success' : 'text-warning'}>
                    {providerReady ? 'Configured' : 'Needs setup'}
                  </span>
                </div>
              </div>
            </div>
          </aside>

          <section className="flex-1 px-6 md:px-10 py-8 flex flex-col">
            <AnimatePresence mode="wait">
              <motion.div
                key={activeStep.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
                className="flex-1"
              >
                {activeStep.id === 'welcome' && (
                  <div className="h-full flex flex-col justify-between gap-8">
                    <div>
                      <p className="text-xs uppercase tracking-[0.16em] text-primary font-semibold mb-3">First Launch</p>
                      <h1 className="text-4xl md:text-5xl font-black leading-tight mb-4">Build faster with agent-first workflows.</h1>
                      <p className="text-base text-text-secondary max-w-2xl">
                        Aurora combines editing, terminal, Git, and AI execution in one workspace. This setup takes less than a minute.
                      </p>
                      <div className="mt-6 inline-flex items-center justify-center rounded-2xl border border-border bg-editor/70 p-3 shadow-premium">
                        <img
                          src="/empty-state.png"
                          alt="Aurora empty state"
                          className="w-24 h-24 object-contain"
                        />
                      </div>
                    </div>

                    <div className="grid md:grid-cols-3 gap-3">
                      <div className="rounded-xl border border-border bg-editor p-4">
                        <Zap className="w-5 h-5 text-primary mb-3" />
                        <p className="text-sm font-semibold mb-1">Agent-native by default</p>
                        <p className="text-xs text-text-secondary">Run edits, commands, and review loops from one chat flow.</p>
                      </div>
                      <div className="rounded-xl border border-border bg-editor p-4">
                        <FolderOpen className="w-5 h-5 text-info mb-3" />
                        <p className="text-sm font-semibold mb-1">Workspace aware</p>
                        <p className="text-xs text-text-secondary">Open a folder and get indexed, contextual code operations.</p>
                      </div>
                      <div className="rounded-xl border border-border bg-editor p-4">
                        <Terminal className="w-5 h-5 text-warning mb-3" />
                        <p className="text-sm font-semibold mb-1">CLI + IDE workflow</p>
                        <p className="text-xs text-text-secondary">Jump in quickly with terminal-first commands like <code>aurora .</code>.</p>
                      </div>
                    </div>
                  </div>
                )}

                {activeStep.id === 'setup' && (
                  <div className="h-full flex flex-col gap-6">
                    <div>
                      <p className="text-xs uppercase tracking-[0.16em] text-primary font-semibold mb-3">Setup Essentials</p>
                      <h2 className="text-3xl font-bold mb-3">Connect your environment</h2>
                      <p className="text-text-secondary">Complete these now, or continue and configure later in Settings.</p>
                    </div>

                    <div className="grid gap-3">
                      <div className="rounded-xl border border-border bg-editor p-4 flex items-start justify-between gap-4">
                        <div>
                          <p className="text-sm font-semibold mb-1">Workspace</p>
                          <p className="text-xs text-text-secondary">
                            {workspaceReady
                              ? `Connected: ${rootPath}`
                              : 'Choose a folder to enable explorer, Git status, and project context.'}
                          </p>
                          {workspaceError && <p className="text-xs text-error mt-2">{workspaceError}</p>}
                        </div>
                        <button
                          onClick={handleOpenWorkspace}
                          disabled={isOpeningWorkspace}
                          className="px-3 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary-hover transition-colors disabled:opacity-70"
                        >
                          {isOpeningWorkspace ? 'Opening...' : workspaceReady ? 'Change Folder' : 'Open Folder'}
                        </button>
                      </div>

                      <div className="rounded-xl border border-border bg-editor p-4">
                        <div className="flex items-start justify-between gap-4 mb-3">
                          <div>
                            <p className="text-sm font-semibold mb-1">AI Provider</p>
                            <p className="text-xs text-text-secondary">
                              {providerReady
                                ? 'Connected and ready. You can start prompting immediately.'
                                : 'Connect a cloud API or use a local model running on your machine.'}
                            </p>
                          </div>
                          <button
                            onClick={handleOpenSettings}
                            className="px-2.5 py-1.5 rounded-lg text-[10px] font-medium text-text-secondary hover:text-text-primary hover:bg-sidebar-item-hover transition-colors flex items-center gap-1.5 border border-border shrink-0"
                            title="Open full settings for other providers"
                          >
                            <Settings className="w-3 h-3" />
                            All Providers
                          </button>
                        </div>

                        {providerReady && (
                          <div className="flex items-center gap-2 rounded-lg bg-success/10 px-3 py-2 mb-3">
                            <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
                            <span className="text-xs text-success font-medium">Provider connected</span>
                          </div>
                        )}

                        {!providerReady && (
                          <>
                            <div className="flex rounded-lg border border-border bg-sidebar p-0.5 mb-4">
                              <button
                                onClick={() => setProviderMode('cloud')}
                                className={clsx(
                                  'flex-1 flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                                  providerMode === 'cloud'
                                    ? 'bg-primary text-primary-foreground'
                                    : 'text-text-secondary hover:text-text-primary'
                                )}
                              >
                                <Cloud size={12} />
                                Cloud API
                              </button>
                              <button
                                onClick={() => setProviderMode('local')}
                                className={clsx(
                                  'flex-1 flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                                  providerMode === 'local'
                                    ? 'bg-primary text-primary-foreground'
                                    : 'text-text-secondary hover:text-text-primary'
                                )}
                              >
                                <HardDrive size={12} />
                                Local Model
                              </button>
                            </div>

                            {providerMode === 'cloud' && (
                              <div className="space-y-2.5">
                                <p className="text-[11px] text-text-secondary font-medium">Fireworks AI (recommended)</p>
                                <div className="flex gap-2">
                                  <div className="flex-1 relative">
                                    <input
                                      type={showApiKey ? 'text' : 'password'}
                                      value={apiKeyInput}
                                      onChange={(e) => {
                                        setApiKeyInput(e.target.value);
                                        setKeyTestResult(null);
                                        setKeyTestMessage(null);
                                      }}
                                      placeholder="fw_..."
                                      className="w-full rounded-lg border border-border bg-sidebar px-3 py-2 pr-9 text-xs text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-primary/50 transition-colors"
                                    />
                                    <button
                                      onClick={() => setShowApiKey(!showApiKey)}
                                      className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-text-secondary hover:text-text-primary transition-colors"
                                      type="button"
                                    >
                                      {showApiKey ? <EyeOff size={12} /> : <Eye size={12} />}
                                    </button>
                                  </div>
                                  <button
                                    onClick={handleSaveApiKey}
                                    disabled={!apiKeyInput.trim() || isTestingKey}
                                    className="px-3 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary-hover transition-colors disabled:opacity-50 flex items-center gap-1.5 shrink-0"
                                  >
                                    {isTestingKey ? (
                                      <>
                                        <Loader2 size={12} className="animate-spin" />
                                        Testing...
                                      </>
                                    ) : 'Connect'}
                                  </button>
                                </div>

                                {keyTestMessage && (
                                  <p className={clsx(
                                    'text-xs',
                                    keyTestResult === 'success' ? 'text-success' : 'text-error'
                                  )}>
                                    {keyTestResult === 'success' && <CheckCircle2 className="w-3 h-3 inline mr-1 -mt-0.5" />}
                                    {keyTestMessage}
                                  </p>
                                )}

                                <div className="flex items-center gap-3 pt-1">
                                  <a
                                    href="https://fireworks.ai/api-keys"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-[10px] text-primary hover:text-primary-hover transition-colors flex items-center gap-1"
                                  >
                                    Get a Fireworks API key <ExternalLink size={9} />
                                  </a>
                                  <span className="text-[10px] text-text-disabled">|</span>
                                  <button
                                    onClick={handleOpenSettings}
                                    className="text-[10px] text-text-secondary hover:text-text-primary transition-colors"
                                  >
                                    Use a different provider
                                  </button>
                                </div>
                              </div>
                            )}

                            {providerMode === 'local' && (
                              <LocalProviderPanel compact />
                            )}
                          </>
                        )}
                      </div>

                      {isWindowsDesktop && (
                        <div className="rounded-xl border border-border bg-editor p-4 flex items-start justify-between gap-4">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold mb-1">Windows Explorer context menu</p>
                            <p className="text-xs text-text-secondary">
                              Add <span className="font-medium text-text-primary">Open with Aurora</span> to folder and directory right-click menus.
                            </p>
                            {contextMenuMessage && (
                              <p className={clsx(
                                'mt-2 text-xs',
                                contextMenuInstalled ? 'text-success' : 'text-warning'
                              )}>
                                {contextMenuMessage}
                              </p>
                            )}
                          </div>
                          <div className="flex flex-col items-end gap-2 shrink-0">
                            {contextMenuInstalled && (
                              <div className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-success">
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                Installed
                              </div>
                            )}
                            <TogglePill
                              checked={shouldInstallContextMenu}
                              onChange={setShouldInstallContextMenu}
                              ariaLabel="Toggle Aurora Explorer context menu installation"
                              variant="success"
                              size="sm"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {activeStep.id === 'shortcuts' && (
                  <div className="h-full flex flex-col gap-6">
                    <div>
                      <p className="text-xs uppercase tracking-[0.16em] text-primary font-semibold mb-3">Workflow</p>
                      <h2 className="text-3xl font-bold mb-3">Move fast with keyboard-first control</h2>
                      <p className="text-text-secondary">These are the highest impact shortcuts for daily use.</p>
                    </div>

                    <div className="grid md:grid-cols-2 gap-3 max-w-2xl">
                      <ShortcutKey label="Command Palette" keys={['Ctrl', 'Shift', 'P']} />
                      <ShortcutKey label="Quick Open" keys={['Ctrl', 'P']} />
                      <ShortcutKey label="Source Control" keys={['Ctrl', 'Shift', 'G']} />
                      <ShortcutKey label="Integrated Terminal" keys={['Ctrl', '`']} />
                    </div>

                    <div className="rounded-xl border border-border bg-editor p-4 flex items-start gap-3 max-w-2xl">
                      <Keyboard className="w-5 h-5 text-primary mt-0.5" />
                      <div>
                        <p className="text-sm font-semibold mb-1">Tip</p>
                        <p className="text-xs text-text-secondary">
                          If onboarding is complete, Aurora opens directly to your workspace on next launch.
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </motion.div>
            </AnimatePresence>

            <div className="mt-6 pt-4 border-t border-border flex items-center justify-between">
                <button
                  onClick={handleSkip}
                  disabled={isApplyingIntegrations}
                  className="text-sm text-text-secondary hover:text-text-primary transition-colors"
                >
                  {isApplyingIntegrations ? 'Applying setup...' : 'Skip for now'}
                </button>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCurrentStep((prev) => Math.max(0, prev - 1))}
                  disabled={currentStep === 0}
                  className="px-4 py-2 rounded-lg border border-border text-sm text-text-secondary hover:bg-sidebar-item-hover disabled:opacity-50 disabled:hover:bg-transparent transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={() => {
                    if (currentStep === STEPS.length - 1) {
                      void handleComplete();
                      return;
                    }
                    setCurrentStep((prev) => Math.min(STEPS.length - 1, prev + 1));
                  }}
                  disabled={isApplyingIntegrations}
                  className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary-hover transition-colors flex items-center gap-2"
                >
                  {currentStep === STEPS.length - 1
                    ? (isApplyingIntegrations ? 'Installing...' : 'Launch Aurora')
                    : 'Continue'}
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};
