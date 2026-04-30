import React, { useEffect, useMemo, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
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
import { settingsRowDividerColor } from './settings-shared';
import {
  Section,
  FormRowLast,
  FormBlock,
  FieldLabel,
  StatusPill,
  ActionButton,
  IconButton,
  KeyValue,
  IdeTextInput,
} from './settings-primitives';

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

const NOTICE_VARIANT: Record<NoticeTone, 'success' | 'danger' | 'neutral'> = {
  success: 'success',
  error: 'danger',
  neutral: 'neutral',
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
          (fireworks?.customModels?.length
            ? fireworks.customModels
            : fireworks
              ? [fireworks.model]
              : []
          ).filter(Boolean),
        ),
      ),
    [fireworks],
  );

  if (!fireworks) {
    return (
      <Section
        title="Fireworks Provider Missing"
        description="Re-enable the built-in Fireworks provider in the Providers tab before opening this section."
      >
        <FormBlock divided={false}>
          <p className="text-[11.5px] text-text-secondary">
            The Fireworks provider profile could not be located. Restore it from the Providers
            tab to access this control center.
          </p>
        </FormBlock>
      </Section>
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
      setCliStatus({ available: false, message, version: null });
      if (showFeedback) setNotice({ message, tone: 'error' });
      return null;
    } finally {
      setIsCheckingCli(false);
    }
  };

  const refreshOverview = async (showFeedback = true) => {
    if (!hasApiKey) {
      if (showFeedback)
        setNotice({ message: 'Add a Fireworks API key before refreshing account data.', tone: 'error' });
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
      const message =
        error instanceof Error ? error.message : 'Failed to refresh Fireworks account data.';
      if (showFeedback) setNotice({ message, tone: 'error' });
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
      if (!currentCliStatus.available) throw new Error(currentCliStatus.message);
      const nextUsage = await exportFireworksUsage(fireworks.apiKey, resolvedAccountId || undefined);
      setUsageSummary(nextUsage);
      setNotice({
        message: 'Usage synced from Fireworks CLI for the last 30 days.',
        tone: 'success',
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to sync Fireworks usage.';
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
    updateProvider(fireworks.id, { customModels: [...modelList, trimmedModelId] });
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
    <div className="space-y-6 pb-2">
      {/* ============================================================ */}
      {/* Status header: Fireworks brand + sync actions                 */}
      {/* ============================================================ */}
      <Section
        title="Fireworks Status"
        description="Account sync, usage exports, and Fireworks model catalog management."
        badge={
          <div className="flex gap-1.5">
            {hasApiKey ? (
              <StatusPill variant="success">Connected</StatusPill>
            ) : (
              <StatusPill variant="warning">No Key</StatusPill>
            )}
            {cliStatus?.available && (
              <StatusPill variant="info" dot={false}>
                CLI Ready
              </StatusPill>
            )}
          </div>
        }
      >
        <FormBlock>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div
                className="flex h-8 w-8 shrink-0 items-center justify-center"
                style={{
                  backgroundColor:
                    'color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)',
                  color: 'var(--aurora-common-primary)',
                  borderRadius: 6,
                }}
              >
                <Flame className="h-4 w-4" />
              </div>
              <div>
                <p className="text-[12.5px] font-semibold text-text-primary">Fireworks AI</p>
                <p className="text-[11px] text-text-secondary">
                  Selector label: <span className="font-mono">{selectorName}</span>
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <ActionButton
                variant="secondary"
                icon={<RefreshCw className="h-3 w-3" />}
                loading={isRefreshingOverview}
                disabled={!hasApiKey}
                onClick={() => void refreshOverview()}
              >
                Refresh Account
              </ActionButton>
              <ActionButton
                variant="secondary"
                icon={<Activity className="h-3 w-3" />}
                loading={isSyncingUsage}
                disabled={!hasApiKey}
                onClick={() => void syncUsage()}
              >
                Sync Usage
              </ActionButton>
              <ActionButton
                variant="primary"
                icon={<Sparkles className="h-3 w-3" />}
                loading={isRefreshingOverview || isSyncingUsage || isCheckingCli}
                disabled={!hasApiKey}
                onClick={() => void syncAll()}
              >
                Sync All
              </ActionButton>
            </div>
          </div>
        </FormBlock>

        {notice && (
          <FormBlock>
            <div className="flex items-start gap-2">
              {notice.tone === 'error' ? (
                <AlertCircle
                  className="mt-0.5 h-3.5 w-3.5 shrink-0"
                  style={{ color: 'var(--aurora-common-danger)' }}
                />
              ) : notice.tone === 'success' ? (
                <CheckCircle2
                  className="mt-0.5 h-3.5 w-3.5 shrink-0"
                  style={{ color: 'var(--aurora-common-success)' }}
                />
              ) : (
                <TerminalSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-secondary" />
              )}
              <p className="text-[11.5px] leading-relaxed text-text-primary">{notice.message}</p>
              <StatusPill variant={NOTICE_VARIANT[notice.tone]} dot={false} className="ml-auto">
                {notice.tone}
              </StatusPill>
            </div>
          </FormBlock>
        )}

        {/* Status summary grid */}
        <FormBlock divided={false} className="!py-3">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 lg:grid-cols-3 xl:grid-cols-5">
            <div>
              <div className="flex items-center gap-1 text-text-disabled">
                <KeyRound className="h-3 w-3" />
                <FieldLabel>API Key</FieldLabel>
              </div>
              <p className="mt-1 text-[12px] font-semibold text-text-primary">
                {hasApiKey ? 'Connected' : 'Missing'}
              </p>
            </div>
            <div>
              <div className="flex items-center gap-1 text-text-disabled">
                <WalletCards className="h-3 w-3" />
                <FieldLabel>Account</FieldLabel>
              </div>
              <p className="mt-1 truncate text-[12px] font-semibold text-text-primary">
                {overview?.account?.displayName || resolvedAccountId || 'Not synced'}
              </p>
            </div>
            <div>
              <div className="flex items-center gap-1 text-text-disabled">
                <Sparkles className="h-3 w-3" />
                <FieldLabel>Default</FieldLabel>
              </div>
              <p
                className="mt-1 truncate text-[12px] font-semibold text-text-primary"
                title={defaultFireworksModel}
              >
                {formatModelDisplayName(
                  defaultFireworksModel,
                  fireworks.modelAliases?.[defaultFireworksModel],
                )}
              </p>
            </div>
            <div>
              <div className="flex items-center gap-1 text-text-disabled">
                <Activity className="h-3 w-3" />
                <FieldLabel>Active</FieldLabel>
              </div>
              <p
                className="mt-1 truncate text-[12px] font-semibold text-text-primary"
                title={activeFireworksModel ?? ''}
              >
                {activeFireworksModel
                  ? formatModelDisplayName(
                      activeFireworksModel,
                      fireworks.modelAliases?.[activeFireworksModel],
                    )
                  : 'Not selected'}
              </p>
            </div>
            <div>
              <div className="flex items-center gap-1 text-text-disabled">
                <TerminalSquare className="h-3 w-3" />
                <FieldLabel>CLI</FieldLabel>
              </div>
              <p className="mt-1 text-[12px] font-semibold text-text-primary">
                {cliStatus?.available ? 'Ready' : 'Not installed'}
              </p>
            </div>
          </div>
        </FormBlock>
      </Section>

      {/* ============================================================ */}
      {/* Connection & Identity                                         */}
      {/* ============================================================ */}
      <Section
        title="Connection & Identity"
        description="Update the selector label, API key, optional account scope, and endpoint for the Fireworks provider."
        badge={
          <ActionButton
            variant="secondary"
            icon={<ExternalLink className="h-3 w-3" />}
            onClick={() => openExternal('https://docs.fireworks.ai')}
          >
            Docs
          </ActionButton>
        }
      >
        <FormBlock>
          <FieldLabel className="mb-1">Selector Name</FieldLabel>
          <IdeTextInput
            value={fireworks.nickname || ''}
            onChange={(event) =>
              updateProvider(fireworks.id, { nickname: event.target.value })
            }
            placeholder="Fireworks"
          />
        </FormBlock>

        <FormBlock>
          <FieldLabel className="mb-1">API Key</FieldLabel>
          <div className="flex gap-1.5">
            <div className="flex-1">
              <IdeTextInput
                type={showApiKey ? 'text' : 'password'}
                value={fireworks.apiKey}
                onChange={(event) =>
                  updateProvider(fireworks.id, { apiKey: event.target.value })
                }
                placeholder="fw_..."
                style={{ fontFamily: 'monospace' }}
              />
            </div>
            <IconButton
              ariaLabel={showApiKey ? 'Hide key' : 'Show key'}
              onClick={() => setShowApiKey((current) => !current)}
            >
              {showApiKey ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            </IconButton>
          </div>
        </FormBlock>

        <FormBlock>
          <FieldLabel className="mb-1">Account ID (optional)</FieldLabel>
          <IdeTextInput
            value={fireworksAccountId}
            onChange={(event) => setFireworksAccountId(event.target.value)}
            placeholder="If empty, Aurora uses the first account Fireworks returns."
          />
          <p className="mt-1.5 text-[10.5px] text-text-secondary">
            Used for account-scoped sync and CLI exports.
          </p>
        </FormBlock>

        <FormRowLast label="Endpoint" hint="The Fireworks API base URL.">
          <span
            className="inline-flex h-7 items-center px-2.5 font-mono text-[11px] text-text-primary"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--aurora-editor-background) 70%, var(--aurora-title-bar-background) 30%)',
              border:
                '1px solid color-mix(in srgb, var(--aurora-common-border) 60%, transparent)',
              borderRadius: 6,
            }}
          >
            {fireworks.baseUrl}
          </span>
        </FormRowLast>
      </Section>

      {/* ============================================================ */}
      {/* Live Account & Usage                                          */}
      {/* ============================================================ */}
      <Section
        title="Live Account & Usage"
        description="Account metadata is loaded from the Fireworks API. Usage totals come from `firectl billing export-metrics` for the last 30 days."
        badge={
          !cliStatus?.available ? (
            <div className="flex gap-1.5">
              <ActionButton
                variant="secondary"
                icon={<ExternalLink className="h-3 w-3" />}
                onClick={() => openExternal(FIREWORKS_CLI_DOCS_URL)}
              >
                Get CLI
              </ActionButton>
              <ActionButton
                variant="secondary"
                icon={<TerminalSquare className="h-3 w-3" />}
                loading={isCheckingCli}
                onClick={() => void syncCliStatus()}
              >
                Check
              </ActionButton>
            </div>
          ) : (
            <ActionButton
              variant="secondary"
              icon={<TerminalSquare className="h-3 w-3" />}
              loading={isCheckingCli}
              onClick={() => void syncCliStatus()}
            >
              Check CLI
            </ActionButton>
          )
        }
      >
        {!cliStatus?.available ? (
          <FormBlock divided={false}>
            <div className="space-y-2.5">
              <div className="flex items-start gap-2">
                <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-disabled" />
                <div>
                  <p className="text-[12px] font-semibold text-text-primary">
                    Fireworks CLI not detected
                  </p>
                  <p className="mt-0.5 text-[11px] leading-snug text-text-secondary">
                    Account metadata can still be loaded from the Fireworks API. Usage import is
                    unavailable until <code className="font-mono">firectl</code> is installed and
                    on PATH.
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 pt-1">
                <KeyValue
                  label="Account"
                  value={overview?.account?.displayName || resolvedAccountId || 'Not synced'}
                />
                <KeyValue
                  label="Scope"
                  value={resolvedAccountId || 'Automatic'}
                  mono
                />
                <KeyValue
                  label="State"
                  value={overview?.account?.state || 'Not loaded'}
                />
                <KeyValue
                  label="Accounts"
                  value={overview?.accounts.length ?? 0}
                />
              </div>
            </div>
          </FormBlock>
        ) : (
          <FormBlock divided={false}>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 lg:grid-cols-3">
              <KeyValue
                label="Account"
                value={overview?.account?.displayName || resolvedAccountId || 'Not synced'}
              />
              <KeyValue label="Scope" value={resolvedAccountId || 'Automatic'} mono />
              <KeyValue
                label="State"
                value={overview?.account?.state || 'Not loaded'}
              />
              <KeyValue
                label="30d Spend"
                value={formatCurrency(usageSummary?.cost ?? null)}
              />
              <KeyValue
                label="30d Tokens"
                value={formatInteger(usageSummary?.totalTokens ?? null)}
              />
              <KeyValue
                label="Latest"
                value={formatRelativeTime(usageSummary?.latestActivityAt ?? null)}
              />
              <KeyValue
                label="Prompt"
                value={formatInteger(usageSummary?.promptTokens ?? null)}
              />
              <KeyValue
                label="Completion"
                value={formatInteger(usageSummary?.completionTokens ?? null)}
              />
              <KeyValue
                label="Top Model"
                value={
                  usageSummary?.topModel
                    ? formatModelDisplayName(usageSummary.topModel.model)
                    : 'Not synced'
                }
              />
            </div>
          </FormBlock>
        )}
      </Section>

      {/* ============================================================ */}
      {/* Model Catalog                                                 */}
      {/* ============================================================ */}
      <Section
        title="Model Catalog"
        description="Manage the Fireworks models available in Aurora. Make Default updates the provider default; Use Now switches the current selector value immediately."
        badge={
          <StatusPill variant="info" dot={false}>
            {modelList.length} model{modelList.length === 1 ? '' : 's'}
          </StatusPill>
        }
      >
        <FormBlock>
          <FieldLabel className="mb-1.5">Add Model ID</FieldLabel>
          <div className="flex gap-1.5">
            <div className="flex-1">
              <IdeTextInput
                value={newModelId}
                onChange={(event) => setNewModelId(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && handleAddModel()}
                placeholder="e.g. accounts/fireworks/models/llama-v3p1-405b-instruct"
                style={{ fontFamily: 'monospace' }}
              />
            </div>
            <ActionButton
              variant="primary"
              icon={<Plus className="h-3 w-3" />}
              disabled={!newModelId.trim()}
              onClick={handleAddModel}
            >
              Add
            </ActionButton>
          </div>
        </FormBlock>

        <FormBlock divided={false}>
          <div className="space-y-1.5">
            {modelList.map((modelId) => {
              const isDefaultModel = defaultFireworksModel === modelId;
              const isActiveModel = activeFireworksModel === modelId;

              return (
                <div
                  key={modelId}
                  className="px-3 py-2.5"
                  style={{
                    backgroundColor:
                      'color-mix(in srgb, var(--aurora-editor-background) 50%, var(--aurora-sidebar-background) 50%)',
                    border:
                      '1px solid color-mix(in srgb, var(--aurora-common-border) 50%, transparent)',
                    borderRadius: 6,
                  }}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="truncate text-[12.5px] font-semibold text-text-primary">
                          {formatModelDisplayName(modelId, fireworks.modelAliases?.[modelId])}
                        </p>
                        {isDefaultModel && (
                          <StatusPill variant="info" dot={false}>
                            Default
                          </StatusPill>
                        )}
                        {isActiveModel && (
                          <StatusPill variant="success">Active</StatusPill>
                        )}
                      </div>
                      <p
                        className="mt-0.5 truncate font-mono text-[10.5px] text-text-secondary"
                        title={modelId}
                      >
                        {modelId}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-1.5">
                      {!isActiveModel && (
                        <ActionButton
                          variant="secondary"
                          onClick={() => handleUseModelNow(modelId)}
                        >
                          Use Now
                        </ActionButton>
                      )}
                      <ActionButton
                        variant="primary"
                        disabled={isDefaultModel}
                        onClick={() => handleMakeDefaultModel(modelId)}
                      >
                        {isDefaultModel ? 'Default' : 'Make Default'}
                      </ActionButton>
                      <IconButton
                        ariaLabel="Remove model"
                        title="Remove model"
                        variant="danger"
                        disabled={modelList.length <= 1}
                        onClick={() => handleRemoveModel(modelId)}
                      >
                        <X className="h-3 w-3" />
                      </IconButton>
                    </div>
                  </div>

                  <div
                    className="mt-2 pt-2"
                    style={{ borderTop: `1px solid ${settingsRowDividerColor}` }}
                  >
                    <FieldLabel className="mb-1">Selector Alias</FieldLabel>
                    <IdeTextInput
                      value={fireworks.modelAliases?.[modelId] || ''}
                      onChange={(event) => handleAliasChange(modelId, event.target.value)}
                      placeholder={formatModelDisplayName(modelId)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </FormBlock>
      </Section>
    </div>
  );
};
