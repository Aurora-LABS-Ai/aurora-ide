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
  FolderOpen,
  Keyboard,
  Settings,
  Sparkles,
  Terminal,
  Zap
} from 'lucide-react';
import { clsx } from 'clsx';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useUiStore } from '../../store/useUiStore';
import { isTauri, openFileDialog } from '../../lib/tauri';

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
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const setRootPath = useWorkspaceStore((state) => state.setRootPath);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);

  const [currentStep, setCurrentStep] = useState(0);
  const [isOpeningWorkspace, setIsOpeningWorkspace] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);

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

  const handleComplete = () => {
    setHasSeenOnboarding(true);
  };

  const handleOpenSettings = () => {
    setSettingsOpen(true);
    setHasSeenOnboarding(true);
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
                <Sparkles className="w-4 h-4 text-primary" />
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

                      <div className="rounded-xl border border-border bg-editor p-4 flex items-start justify-between gap-4">
                        <div>
                          <p className="text-sm font-semibold mb-1">AI Provider</p>
                          <p className="text-xs text-text-secondary">
                            {providerReady
                              ? 'A provider is configured. You can start prompting immediately.'
                              : 'Add or verify model credentials to enable chat and agent actions.'}
                          </p>
                        </div>
                        <button
                          onClick={handleOpenSettings}
                          className="px-3 py-2 rounded-lg bg-secondary text-secondary-foreground text-xs font-semibold hover:bg-secondary-hover transition-colors flex items-center gap-1.5"
                        >
                          <Settings className="w-3.5 h-3.5" />
                          Settings
                        </button>
                      </div>
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
                onClick={handleComplete}
                className="text-sm text-text-secondary hover:text-text-primary transition-colors"
              >
                Skip for now
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
                      handleComplete();
                      return;
                    }
                    setCurrentStep((prev) => Math.min(STEPS.length - 1, prev + 1));
                  }}
                  className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary-hover transition-colors flex items-center gap-2"
                >
                  {currentStep === STEPS.length - 1 ? 'Launch Aurora' : 'Continue'}
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
