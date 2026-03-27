import React, { useEffect, useMemo, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Flame,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  TerminalSquare,
  WalletCards,
  X,
} from 'lucide-react';

import { formatModelDisplayName, formatProviderNickname } from '../../lib/provider-display';
import { useSettingsStore } from '../../store/useSettingsStore';
import {
  detectFireworksCli,
  exportFireworksUsage,
  fetchFireworksOverview,
  type FireworksCliStatus,
  type FireworksOverview,
  type FireworksUsageSummary,
} from '../../services/fireworks';
import {
  settingsCardStyle,
  settingsInputStyle,
  settingsPrimaryButtonStyle,
  settingsSubtlePanelStyle,
} from './settings-shared';

const FIREWORKS_PROVIDER_ID = 'fireworks';
const FIREWORKS_CLI_DOCS_URL = 'https://docs.fireworks.ai/tools-sdks/firectl/firectl';

type NoticeTone = 'error' | 'neutral' | 'success';

const openExternal = async (url: string) => {
  try {
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(url);
    return;
  } catch {
    if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }
};

const summaryCardStyle: React.CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--aurora-common-primary) 5%, transparent)',
  border: '1px solid color-mix(in srgb, var(--aurora-common-border) 58%, transparent)',
};

const noticeStyles: Record<NoticeTone, React.CSSProperties> = {
  error: {
    backgroundColor: 'color-mix(in srgb, var(--aurora-common-danger) 10%, transparent)',
    border: '1px solid color-mix(in srgb, var(--aurora-common-danger) 28%, transparent)',
  },
  neutral: {
    backgroundColor: 'color-mix(in srgb, var(--aurora-common-muted) 76%, transparent)',
    border: '1px solid color-mix(in srgb, var(--aurora-common-border) 58%, transparent)',
  },
  success: {
    backgroundColor: 'color-mix(in srgb, var(--aurora-common-success) 10%, transparent)',
    border: '1px solid color-mix(in srgb, var(--aurora-common-success) 26%, transparent)',
  },
};

const buttonClassName =
  'inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50';

const formatInteger = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return 'Unavailable';
  return Math.round(value).toLocaleString();
};

const formatCurrency = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value)) return 'Unavailable';

  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `$${value.toFixed(2)}`;
  }
};

const formatRelativeTime = (isoTimestamp: string | null) => {
  if (!isoTimestamp) return 'No usage synced yet';

  try {
    return formatDistanceToNow(new Date(isoTimestamp), { addSuffix: true });
  } catch {
    return 'No usage synced yet';
  }
};

export const FireworksSettingsTab: React.FC = () => {
  const {
    fireworksAccountId,
    providers,
    selectedModel,
    setFireworksAccountId,
    setSelectedModel,
    updateProvider,
  } = useSettingsStore();

  const [newModelId, setNewModelId] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [overview, setOverview] = useState<FireworksOverview | null>(null);
  const [usageSummary, setUsageSummary] = useState<FireworksUsageSummary | null>(null);
  const [cliStatus, setCliStatus] = useState<FireworksCliStatus | null>(null);
  const [isRefreshingOverview, setIsRefreshingOverview] = useState(false);
  const [isCheckingCli, setIsCheckingCli] = useState(false);
  const [isSyncingUsage, setIsSyncingUsage] = useState(false);
  const [notice, setNotice] = useState<{ message: string; tone: NoticeTone } | null>(null);

  const fireworks = providers.find((provider) => provider.id === FIREWORKS_PROVIDER_ID);
  const modelList = useMemo(
    () =>
      Array.from(
        new Set(
          (fireworks?.customModels?.length ? fireworks.customModels : fireworks ? [fireworks.model] : []).filter(Boolean),
        ),
      ),
    [fireworks],
  );

  if (!fireworks) {
    return (
      <div className="rounded-[20px] p-5" style={settingsCardStyle}>
        <p className="text-sm font-semibold text-text-primary">Fireworks provider is not available.</p>
        <p className="mt-2 text-xs leading-relaxed text-text-secondary">
          Re-enable the built-in Fireworks provider in the Providers tab before opening this section.
        </p>
      </div>
    );
  }

  const hasApiKey = fireworks.apiKey.trim().length > 0;
  const selectorName = formatProviderNickname(fireworks.name, fireworks.nickname);
  const activeFireworksModel = selectedModel.startsWith(`${FIREWORKS_PROVIDER_ID}:`)
    ? selectedModel.slice(`${FIREWORKS_PROVIDER_ID}:`.length)
    : null;
  const defaultFireworksModel = fireworks.model;
  const resolvedAccountId = overview?.resolvedAccountId || fireworksAccountId.trim() || null;

  const syncCliStatus = async (showFeedback = true) => {
    setIsCheckingCli(true);
    try {
      const nextStatus = await detectFireworksCli();
      setCliStatus(nextStatus);
      if (showFeedback) {
        setNotice({
          message: nextStatus.available ? 'Fireworks CLI detected.' : nextStatus.message,
          tone: nextStatus.available ? 'success' : 'neutral',
        });
      }
      return nextStatus;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to check Fireworks CLI.';
      setCliStatus({
        available: false,
        message,
        version: null,
      });
      if (showFeedback) {
        setNotice({ message, tone: 'error' });
      }
      return null;
    } finally {
      setIsCheckingCli(false);
    }
  };

  const refreshOverview = async (showFeedback = true) => {
    if (!hasApiKey) {
      if (showFeedback) {
        setNotice({ message: 'Add a Fireworks API key before refreshing account data.', tone: 'error' });
      }
      return;
    }

    setIsRefreshingOverview(true);
    try {
      const nextOverview = await fetchFireworksOverview(fireworks.apiKey, fireworksAccountId);
      setOverview(nextOverview);

      if (!fireworksAccountId.trim() && nextOverview.resolvedAccountId) {
        setFireworksAccountId(nextOverview.resolvedAccountId);
      }

      if (showFeedback) {
        setNotice({
          message: nextOverview.account
            ? `Loaded Fireworks account ${nextOverview.account.displayName}.`
            : 'No Fireworks account metadata was returned.',
          tone: nextOverview.account ? 'success' : 'neutral',
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to refresh Fireworks account data.';
      if (showFeedback) {
        setNotice({ message, tone: 'error' });
      }
    } finally {
      setIsRefreshingOverview(false);
    }
  };

  const syncUsage = async () => {
    if (!hasApiKey) {
      setNotice({ message: 'Add a Fireworks API key before syncing usage.', tone: 'error' });
      return;
    }

    setIsSyncingUsage(true);
    try {
      const currentCliStatus = cliStatus?.available ? cliStatus : await detectFireworksCli();
      setCliStatus(currentCliStatus);

      if (!currentCliStatus.available) {
        throw new Error(currentCliStatus.message);
      }

      const nextUsage = await exportFireworksUsage(fireworks.apiKey, resolvedAccountId || undefined);
      setUsageSummary(nextUsage);
      setNotice({
        message: `Usage synced from Fireworks CLI for the last 30 days.`,
        tone: 'success',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to sync Fireworks usage.';
      setNotice({ message, tone: 'error' });
    } finally {
      setIsSyncingUsage(false);
    }
  };

  const syncAll = async () => {
    await refreshOverview();
    await syncCliStatus();
    await syncUsage();
  };

  useEffect(() => {
    void syncCliStatus(false);
  }, []);

  useEffect(() => {
    if (!hasApiKey) {
      setOverview(null);
      setUsageSummary(null);
      return;
    }

    void refreshOverview(false);
  }, [fireworks.apiKey]);

  const handleMakeDefaultModel = (modelId: string) => {
    updateProvider(fireworks.id, { model: modelId });
    setNotice({
      message: `${formatModelDisplayName(modelId, fireworks.modelAliases?.[modelId])} is now the default Fireworks model.`,
      tone: 'success',
    });
  };

  const handleUseModelNow = (modelId: string) => {
    setSelectedModel(`${fireworks.id}:${modelId}`);
    setNotice({
      message: `${formatModelDisplayName(modelId, fireworks.modelAliases?.[modelId])} is active in the selector now.`,
      tone: 'success',
    });
  };

  const handleAddModel = () => {
    const trimmedModelId = newModelId.trim();
    if (!trimmedModelId || modelList.includes(trimmedModelId)) {
      setNewModelId('');
      return;
    }

    updateProvider(fireworks.id, {
      customModels: [...modelList, trimmedModelId],
    });
    setNewModelId('');
    setNotice({
      message: `${trimmedModelId} was added to the Fireworks selector catalog.`,
      tone: 'success',
    });
  };

  const handleRemoveModel = (modelId: string) => {
    if (modelList.length <= 1) return;

    const nextModels = modelList.filter((entry) => entry !== modelId);
    const nextDefaultModel = fireworks.model === modelId ? nextModels[0] : fireworks.model;

    updateProvider(fireworks.id, {
      customModels: nextModels,
      model: nextDefaultModel,
    });

    if (selectedModel === `${fireworks.id}:${modelId}`) {
      setSelectedModel(`${fireworks.id}:${nextDefaultModel}`);
    }

    setNotice({
      message: `${formatModelDisplayName(modelId, fireworks.modelAliases?.[modelId])} was removed from the Fireworks catalog.`,
      tone: 'neutral',
    });
  };

  const handleAliasChange = (modelId: string, alias: string) => {
    const nextAliases = { ...(fireworks.modelAliases || {}) };
    const trimmedAlias = alias.trim();

    if (trimmedAlias) {
      nextAliases[modelId] = trimmedAlias;
    } else {
      delete nextAliases[modelId];
    }

    updateProvider(fireworks.id, {
      modelAliases: Object.keys(nextAliases).length > 0 ? nextAliases : undefined,
    });
  };

  return (
    <div className="space-y-6">
      <div className="rounded-[24px] p-5" style={settingsCardStyle}>
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Flame className="h-5 w-5" />
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-text-disabled">
                  Fireworks Control Center
                </p>
                <h3 className="mt-1 text-xl font-semibold text-text-primary">Fireworks</h3>
              </div>
            </div>
            <p className="max-w-3xl text-sm leading-relaxed text-text-secondary">
              Configure Fireworks access, synchronize account data, review usage exports, and manage the model catalog shown in Aurora.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => void refreshOverview()}
              disabled={isRefreshingOverview || !hasApiKey}
              className={`${buttonClassName} text-text-primary`}
              style={settingsInputStyle}
            >
              {isRefreshingOverview ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh Account
            </button>
            <button
              onClick={() => void syncUsage()}
              disabled={isSyncingUsage || !hasApiKey}
              className={`${buttonClassName} text-text-primary`}
              style={settingsInputStyle}
            >
              {isSyncingUsage ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Activity className="h-3.5 w-3.5" />}
              Sync Usage
            </button>
            <button
              onClick={() => void syncAll()}
              disabled={isRefreshingOverview || isSyncingUsage || isCheckingCli || !hasApiKey}
              className={`${buttonClassName} text-primary-foreground`}
              style={settingsPrimaryButtonStyle}
            >
              {(isRefreshingOverview || isSyncingUsage || isCheckingCli) ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              Sync All
            </button>
          </div>
        </div>

        {notice && (
          <div className="mt-4 rounded-2xl px-4 py-3 text-sm" style={noticeStyles[notice.tone]}>
            <div className="flex items-start gap-3">
              {notice.tone === 'error' ? (
                <AlertCircle className="mt-0.5 h-4 w-4 text-danger" />
              ) : notice.tone === 'success' ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" />
              ) : (
                <TerminalSquare className="mt-0.5 h-4 w-4 text-text-secondary" />
              )}
              <p className="leading-relaxed text-text-primary">{notice.message}</p>
            </div>
          </div>
        )}

        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
          <div className="rounded-2xl p-4" style={summaryCardStyle}>
            <div className="flex items-center gap-2 text-text-secondary">
              <KeyRound className="h-3.5 w-3.5" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em]">API Key</span>
            </div>
            <p className="mt-3 text-base font-semibold text-text-primary">{hasApiKey ? 'Connected' : 'Missing'}</p>
            <p className="mt-2 text-xs leading-relaxed text-text-secondary">
              {hasApiKey ? 'Fireworks can serve requests immediately.' : 'Add a Fireworks API key to unlock account sync and inference.'}
            </p>
          </div>

          <div className="rounded-2xl p-4" style={summaryCardStyle}>
            <div className="flex items-center gap-2 text-text-secondary">
              <WalletCards className="h-3.5 w-3.5" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em]">Account</span>
            </div>
            <p className="mt-3 truncate text-base font-semibold text-text-primary">
              {overview?.account?.displayName || resolvedAccountId || 'Not synced'}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-text-secondary">
              {overview?.account ? `${overview.accounts.length} accessible account${overview.accounts.length === 1 ? '' : 's'}.` : 'Use Refresh Account to load Fireworks account metadata.'}
            </p>
          </div>

          <div className="rounded-2xl p-4" style={summaryCardStyle}>
            <div className="flex items-center gap-2 text-text-secondary">
              <Sparkles className="h-3.5 w-3.5" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em]">Default Model</span>
            </div>
            <p className="mt-3 truncate text-base font-semibold text-text-primary">
              {formatModelDisplayName(defaultFireworksModel, fireworks.modelAliases?.[defaultFireworksModel])}
            </p>
            <p className="mt-2 truncate font-mono text-[10px] text-text-secondary">{defaultFireworksModel}</p>
          </div>

          <div className="rounded-2xl p-4" style={summaryCardStyle}>
            <div className="flex items-center gap-2 text-text-secondary">
              <Activity className="h-3.5 w-3.5" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em]">Active In Selector</span>
            </div>
            <p className="mt-3 truncate text-base font-semibold text-text-primary">
              {activeFireworksModel
                ? formatModelDisplayName(activeFireworksModel, fireworks.modelAliases?.[activeFireworksModel])
                : 'Another provider is active'}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-text-secondary">
              {activeFireworksModel ? 'This is what the chat input is using right now.' : 'Fireworks remains configured even when another provider is selected.'}
            </p>
          </div>

          <div className="rounded-2xl p-4" style={summaryCardStyle}>
            <div className="flex items-center gap-2 text-text-secondary">
              <TerminalSquare className="h-3.5 w-3.5" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em]">CLI Status</span>
            </div>
            <p className="mt-3 text-base font-semibold text-text-primary">
              {cliStatus?.available ? 'Ready' : 'Not installed'}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-text-secondary">
              {cliStatus?.available ? (cliStatus.version || 'firectl detected.') : 'Usage sync needs `firectl` on PATH.'}
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-6 2xl:grid-cols-[minmax(0,0.92fr)_minmax(0,1.18fr)]">
        <div className="space-y-6">
          <div className="rounded-[24px] p-5" style={settingsCardStyle}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h4 className="text-base font-semibold text-text-primary">Connection and Identity</h4>
                <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                  Update the selector label, API key, optional account scope, and endpoint for the Fireworks provider.
                </p>
              </div>
              <button
                onClick={() => openExternal('https://docs.fireworks.ai')}
                className={`${buttonClassName} text-text-secondary hover:text-text-primary`}
                style={settingsInputStyle}
              >
                Docs
                <ExternalLink className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="mt-5 space-y-4">
              <div>
                <label className="mb-2 block text-[10px] font-medium uppercase tracking-[0.18em] text-text-secondary">
                  Selector Name
                </label>
                <input
                  type="text"
                  value={fireworks.nickname || ''}
                  onChange={(event) => updateProvider(fireworks.id, { nickname: event.target.value })}
                  placeholder="Fireworks"
                  className="w-full rounded-xl px-3 py-2.5 text-sm font-medium text-text-primary placeholder:text-text-disabled focus:border-primary focus:outline-none"
                  style={settingsInputStyle}
                />
              </div>

              <div>
                <label className="mb-2 block text-[10px] font-medium uppercase tracking-[0.18em] text-text-secondary">
                  API Key
                </label>
                <div className="flex gap-2">
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    value={fireworks.apiKey}
                    onChange={(event) => updateProvider(fireworks.id, { apiKey: event.target.value })}
                    placeholder="fw_..."
                    className="flex-1 rounded-xl px-3 py-2.5 text-sm font-medium text-text-primary placeholder:text-text-disabled focus:border-primary focus:outline-none"
                    style={settingsInputStyle}
                  />
                  <button
                    onClick={() => setShowApiKey((current) => !current)}
                    className={`${buttonClassName} min-w-[84px] text-text-primary`}
                    style={settingsInputStyle}
                  >
                    {showApiKey ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>

              <div>
                <label className="mb-2 block text-[10px] font-medium uppercase tracking-[0.18em] text-text-secondary">
                  Account ID
                </label>
                <input
                  type="text"
                  value={fireworksAccountId}
                  onChange={(event) => setFireworksAccountId(event.target.value)}
                  placeholder="Optional. Used for account-scoped sync and CLI exports."
                  className="w-full rounded-xl px-3 py-2.5 text-sm font-medium text-text-primary placeholder:text-text-disabled focus:border-primary focus:outline-none"
                  style={settingsInputStyle}
                />
                <p className="mt-2 text-xs leading-relaxed text-text-secondary">
                  If left empty, Aurora uses the first account Fireworks returns during account sync.
                </p>
              </div>

              <div>
                <label className="mb-2 block text-[10px] font-medium uppercase tracking-[0.18em] text-text-secondary">
                  Endpoint
                </label>
                <div className="rounded-xl px-3 py-2.5 font-mono text-[12px] text-text-secondary" style={settingsInputStyle}>
                  {fireworks.baseUrl}
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-[24px] p-5" style={settingsCardStyle}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h4 className="text-base font-semibold text-text-primary">Live Account and Usage</h4>
                <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                  Account metadata is loaded from the Fireworks API. Usage totals are imported from `firectl billing export-metrics` for the last 30 days.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {!cliStatus?.available && (
                  <button
                    onClick={() => openExternal(FIREWORKS_CLI_DOCS_URL)}
                    className={`${buttonClassName} text-text-primary`}
                    style={settingsInputStyle}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Download CLI
                  </button>
                )}
                <button
                  onClick={() => void syncCliStatus()}
                  disabled={isCheckingCli}
                  className={`${buttonClassName} text-text-primary`}
                  style={settingsInputStyle}
                >
                  {isCheckingCli ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <TerminalSquare className="h-3.5 w-3.5" />}
                  Check CLI
                </button>
              </div>
            </div>

            {!cliStatus?.available ? (
              <div className="mt-5 space-y-3">
                <div className="rounded-2xl p-4" style={settingsSubtlePanelStyle}>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">CLI Required For Usage Sync</p>
                  <p className="mt-3 text-lg font-semibold text-text-primary">Fireworks CLI not detected</p>
                  <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                    Account metadata can still be loaded from the Fireworks API. Usage import is unavailable until `firectl` is installed and accessible on PATH.
                  </p>
                </div>

                <div className="grid gap-3 xl:grid-cols-2">
                  <div className="rounded-2xl p-4" style={settingsSubtlePanelStyle}>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">Resolved Account</p>
                    <p className="mt-3 text-lg font-semibold text-text-primary">
                      {overview?.account?.displayName || resolvedAccountId || 'Not synced'}
                    </p>
                    <p className="mt-2 text-xs leading-relaxed text-text-secondary">
                      {overview?.account?.state ? `State: ${overview.account.state}` : 'Account metadata has not been loaded yet.'}
                    </p>
                  </div>

                  <div className="rounded-2xl p-4" style={settingsSubtlePanelStyle}>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">Account Scope</p>
                    <p className="mt-3 text-lg font-semibold text-text-primary">{resolvedAccountId || 'Automatic'}</p>
                    <p className="mt-2 text-xs leading-relaxed text-text-secondary">
                      If no account ID is provided, Aurora uses the account returned by the Fireworks API during sync.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-5 grid gap-3 2xl:grid-cols-2">
                <div className="rounded-2xl p-4" style={settingsSubtlePanelStyle}>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">Resolved Account</p>
                  <p className="mt-3 text-lg font-semibold text-text-primary">
                    {overview?.account?.displayName || resolvedAccountId || 'Not synced'}
                  </p>
                  <p className="mt-2 text-xs leading-relaxed text-text-secondary">
                    {overview?.account?.state ? `State: ${overview.account.state}` : 'Account metadata has not been loaded yet.'}
                  </p>
                </div>

                <div className="rounded-2xl p-4" style={settingsSubtlePanelStyle}>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">Account Scope</p>
                  <p className="mt-3 text-lg font-semibold text-text-primary">{resolvedAccountId || 'Automatic'}</p>
                  <p className="mt-2 text-xs leading-relaxed text-text-secondary">
                    If no account ID is provided, Aurora uses the account returned by the Fireworks API during sync.
                  </p>
                </div>

                <div className="rounded-2xl p-4" style={settingsSubtlePanelStyle}>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">30d Spend</p>
                  <p className="mt-3 text-lg font-semibold text-text-primary">{formatCurrency(usageSummary?.cost ?? null)}</p>
                  <p className="mt-2 text-xs leading-relaxed text-text-secondary">
                    {usageSummary ? `${usageSummary.records.toLocaleString()} exported metric rows.` : 'Usage data has not been imported yet.'}
                  </p>
                </div>

                <div className="rounded-2xl p-4" style={settingsSubtlePanelStyle}>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">30d Tokens</p>
                  <p className="mt-3 text-lg font-semibold text-text-primary">{formatInteger(usageSummary?.totalTokens ?? null)}</p>
                  <p className="mt-2 text-xs leading-relaxed text-text-secondary">
                    Prompt {formatInteger(usageSummary?.promptTokens ?? null)} · Completion {formatInteger(usageSummary?.completionTokens ?? null)}
                  </p>
                </div>

                <div className="rounded-2xl p-4" style={settingsSubtlePanelStyle}>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">Latest Activity</p>
                  <p className="mt-3 text-lg font-semibold text-text-primary">{formatRelativeTime(usageSummary?.latestActivityAt ?? null)}</p>
                  <p className="mt-2 text-xs leading-relaxed text-text-secondary">
                    Based on the newest timestamp present in the exported Fireworks usage CSV.
                  </p>
                </div>

                <div className="rounded-2xl p-4" style={settingsSubtlePanelStyle}>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">Top Model In Usage</p>
                  <p className="mt-3 truncate text-lg font-semibold text-text-primary">
                    {usageSummary?.topModel ? formatModelDisplayName(usageSummary.topModel.model) : 'Not synced'}
                  </p>
                  <p className="mt-2 text-xs leading-relaxed text-text-secondary">
                    {usageSummary?.topModel ? `${usageSummary.topModel.count.toLocaleString()} records in the last 30 days.` : 'Usage data has not been imported yet.'}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="rounded-[24px] p-5" style={settingsCardStyle}>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h4 className="text-base font-semibold text-text-primary">Model Catalog</h4>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-text-secondary">
                Manage the Fireworks models available in Aurora. `Make Default` updates the provider default. `Use Now` switches the current selector value immediately.
              </p>
            </div>
            <div className="rounded-full px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-primary" style={{ backgroundColor: 'color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)' }}>
              Selector Label {selectorName}
            </div>
          </div>

          <div className="mt-5 flex flex-col gap-2 md:flex-row">
            <input
              type="text"
              value={newModelId}
              onChange={(event) => setNewModelId(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && handleAddModel()}
              placeholder="Add a Fireworks model ID"
              className="flex-1 rounded-xl px-3 py-2.5 text-sm font-medium text-text-primary placeholder:text-text-disabled focus:border-primary focus:outline-none"
              style={settingsInputStyle}
            />
            <button
              onClick={handleAddModel}
              disabled={!newModelId.trim()}
              className={`${buttonClassName} min-w-[104px] text-primary-foreground`}
              style={settingsPrimaryButtonStyle}
            >
              <Plus className="h-3.5 w-3.5" />
              Add Model
            </button>
          </div>

          <div className="mt-5 space-y-3">
            {modelList.map((modelId) => {
              const isDefaultModel = defaultFireworksModel === modelId;
              const isActiveModel = activeFireworksModel === modelId;

              return (
                <div key={modelId} className="rounded-[20px] p-4" style={settingsSubtlePanelStyle}>
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-base font-semibold text-text-primary">
                          {formatModelDisplayName(modelId, fireworks.modelAliases?.[modelId])}
                        </p>
                        {isDefaultModel && (
                          <span className="rounded-full bg-primary/15 px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-primary">
                            Default Model
                          </span>
                        )}
                        {isActiveModel && (
                          <span className="rounded-full bg-success/15 px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-success">
                            Active In Selector
                          </span>
                        )}
                      </div>
                      <p className="mt-2 truncate font-mono text-[11px] text-text-secondary">{modelId}</p>
                    </div>

                    <div className="flex flex-wrap gap-2 xl:justify-end">
                      {!isActiveModel && (
                        <button
                          onClick={() => handleUseModelNow(modelId)}
                          className={`${buttonClassName} text-text-primary`}
                          style={settingsInputStyle}
                        >
                          Use Now
                        </button>
                      )}
                      <button
                        onClick={() => handleMakeDefaultModel(modelId)}
                        disabled={isDefaultModel}
                        className={`${buttonClassName} text-primary-foreground`}
                        style={settingsPrimaryButtonStyle}
                      >
                        {isDefaultModel ? 'Default Model' : 'Make Default'}
                      </button>
                      <button
                        onClick={() => handleRemoveModel(modelId)}
                        disabled={modelList.length <= 1}
                        className={`${buttonClassName} text-text-secondary hover:text-danger`}
                        style={settingsInputStyle}
                        title="Remove model"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
                    <div>
                      <label className="mb-2 block text-[10px] font-medium uppercase tracking-[0.18em] text-text-secondary">
                        Selector Alias
                      </label>
                      <input
                        type="text"
                        value={fireworks.modelAliases?.[modelId] || ''}
                        onChange={(event) => handleAliasChange(modelId, event.target.value)}
                        placeholder={formatModelDisplayName(modelId)}
                        className="w-full rounded-xl px-3 py-2.5 text-sm font-medium text-text-primary placeholder:text-text-disabled focus:border-primary focus:outline-none"
                        style={settingsInputStyle}
                      />
                    </div>

                    <div className="rounded-xl px-3 py-2.5 text-xs leading-relaxed text-text-secondary" style={settingsInputStyle}>
                      {isDefaultModel && isActiveModel
                        ? 'This model is the saved default and the current selection.'
                        : isDefaultModel
                          ? 'This model is saved as the Fireworks default.'
                          : isActiveModel
                            ? 'This model is currently selected in Aurora.'
                            : 'This model is available in the selector.'}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
