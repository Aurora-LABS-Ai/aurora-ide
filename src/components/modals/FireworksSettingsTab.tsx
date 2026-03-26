import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Flame,
  Gauge,
  KeyRound,
  Plus,
  Sparkles,
  WalletCards,
  X,
} from 'lucide-react';

import { formatModelDisplayName, formatProviderNickname } from '../../lib/provider-display';
import { useSettingsStore } from '../../store/useSettingsStore';
import {
  settingsCardStyle,
  settingsInputStyle,
  settingsPrimaryButtonStyle,
  settingsSubtlePanelStyle,
} from './settings-shared';

const FIREWORKS_PROVIDER_ID = 'fireworks';

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

  const fireworks = providers.find((provider) => provider.id === FIREWORKS_PROVIDER_ID);
  const modelList = useMemo(
    () => Array.from(new Set((fireworks?.customModels?.length ? fireworks.customModels : fireworks ? [fireworks.model] : []).filter(Boolean))),
    [fireworks],
  );

  if (!fireworks) {
    return (
      <div className="rounded-[20px] p-4" style={settingsCardStyle}>
        <p className="text-sm font-semibold text-text-primary">Fireworks provider is not available.</p>
        <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
          Re-enable the built-in Fireworks provider in the providers list before opening this tab.
        </p>
      </div>
    );
  }

  const hasApiKey = fireworks.apiKey.trim().length > 0;
  const selectorName = formatProviderNickname(fireworks.name, fireworks.nickname);
  const selectedFireworksModel = selectedModel.startsWith(`${FIREWORKS_PROVIDER_ID}:`)
    ? selectedModel.slice(`${FIREWORKS_PROVIDER_ID}:`.length)
    : fireworks.model;

  const handleSetDefaultModel = (modelId: string) => {
    updateProvider(fireworks.id, { model: modelId });
    setSelectedModel(`${fireworks.id}:${modelId}`);
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
    <div className="space-y-4">
      <div className="rounded-[20px] p-4" style={settingsCardStyle}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Flame className="h-4 w-4" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-text-primary">Fireworks Control Center</h3>
                <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
                  Overview and model controls for the Fireworks path inside Aurora. Add your API key, set the account scope, and curate exactly what the selector shows.
                </p>
              </div>
            </div>
          </div>
          <div className="rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-primary" style={{ backgroundColor: 'color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)' }}>
            Overview + Models
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl px-3 py-3" style={summaryCardStyle}>
            <div className="flex items-center gap-2 text-text-secondary">
              <KeyRound className="h-3.5 w-3.5" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em]">API Key</span>
            </div>
            <div className="mt-3 flex items-center gap-2">
              {hasApiKey ? (
                <CheckCircle2 className="h-4 w-4 text-success" />
              ) : (
                <AlertCircle className="h-4 w-4 text-warning" />
              )}
              <p className="text-sm font-semibold text-text-primary">{hasApiKey ? 'Connected' : 'Needs key'}</p>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
              {hasApiKey ? 'Fireworks requests are ready from the selector.' : 'Paste a Fireworks API key to activate the provider.'}
            </p>
          </div>

          <div className="rounded-2xl px-3 py-3" style={summaryCardStyle}>
            <div className="flex items-center gap-2 text-text-secondary">
              <WalletCards className="h-3.5 w-3.5" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em]">Account Scope</span>
            </div>
            <p className="mt-3 truncate text-sm font-semibold text-text-primary">
              {fireworksAccountId.trim() || 'Optional account ID'}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
              Persisted now so billing, quota, and usage sync can attach to the correct Fireworks account later.
            </p>
          </div>

          <div className="rounded-2xl px-3 py-3" style={summaryCardStyle}>
            <div className="flex items-center gap-2 text-text-secondary">
              <Sparkles className="h-3.5 w-3.5" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em]">Default Model</span>
            </div>
            <p className="mt-3 truncate text-sm font-semibold text-text-primary">
              {formatModelDisplayName(selectedFireworksModel, fireworks.modelAliases?.[selectedFireworksModel])}
            </p>
            <p className="mt-1 truncate font-mono text-[10px] text-text-secondary">{selectedFireworksModel}</p>
          </div>

          <div className="rounded-2xl px-3 py-3" style={summaryCardStyle}>
            <div className="flex items-center gap-2 text-text-secondary">
              <Gauge className="h-3.5 w-3.5" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em]">Selector Catalog</span>
            </div>
            <p className="mt-3 text-sm font-semibold text-text-primary">{modelList.length} models visible</p>
            <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
              Displayed in Aurora using the Fireworks nickname <span className="font-semibold text-text-primary">{selectorName}</span>.
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.25fr)]">
        <div className="space-y-4">
          <div className="rounded-[20px] p-4" style={settingsCardStyle}>
            <h4 className="text-sm font-semibold text-text-primary">Connection</h4>
            <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
              Keep Fireworks setup isolated here so the provider card stays light and the dedicated tab handles the deeper controls.
            </p>

            <div className="mt-4 space-y-3">
              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-text-secondary">Selector Name</label>
                <input
                  type="text"
                  value={fireworks.nickname || ''}
                  onChange={(event) => updateProvider(fireworks.id, { nickname: event.target.value })}
                  placeholder="Fireworks"
                  className="w-full rounded-xl px-3 py-2 text-xs font-medium text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-primary"
                  style={settingsInputStyle}
                />
              </div>

              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-text-secondary">API Key</label>
                <div className="flex gap-2">
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    value={fireworks.apiKey}
                    onChange={(event) => updateProvider(fireworks.id, { apiKey: event.target.value })}
                    placeholder="fw_..."
                    className="flex-1 rounded-xl px-3 py-2 text-xs font-medium text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-primary"
                    style={settingsInputStyle}
                  />
                  <button
                    onClick={() => setShowApiKey((current) => !current)}
                    className="rounded-xl px-3 py-2 text-xs font-semibold text-text-secondary hover:text-text-primary"
                    style={settingsInputStyle}
                  >
                    {showApiKey ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>

              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-text-secondary">Account ID</label>
                <input
                  type="text"
                  value={fireworksAccountId}
                  onChange={(event) => setFireworksAccountId(event.target.value)}
                  placeholder="Optional, for account-scoped usage and billing sync"
                  className="w-full rounded-xl px-3 py-2 text-xs font-medium text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-primary"
                  style={settingsInputStyle}
                />
              </div>

              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-text-secondary">Endpoint</label>
                <div className="rounded-xl px-3 py-2 font-mono text-[11px] text-text-secondary" style={settingsInputStyle}>
                  {fireworks.baseUrl}
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-[20px] p-4" style={settingsCardStyle}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold text-text-primary">Billing and Usage</h4>
                <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
                  The dedicated overview is in place. Live balance, quota, invoices, and usage cards can be wired next through the Fireworks CLI or API using the stored account scope.
                </p>
              </div>
              <button
                onClick={() => openExternal('https://fireworks.ai/docs')}
                className="inline-flex items-center gap-1 rounded-xl px-3 py-2 text-[11px] font-semibold text-text-secondary hover:text-text-primary"
                style={settingsInputStyle}
              >
                Docs
                <ExternalLink className="h-3 w-3" />
              </button>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-3">
              {[
                {
                  title: 'Balance',
                  value: 'CLI/API sync',
                  description: 'Wire `firectl` or a billing endpoint to show live credit status here.',
                },
                {
                  title: 'Quota',
                  value: fireworksAccountId.trim() ? 'Account-scoped ready' : 'Needs account ID',
                  description: 'Persisted account ID lets quota panels target the correct Fireworks account.',
                },
                {
                  title: 'Usage',
                  value: hasApiKey ? 'Provider ready' : 'Awaiting API key',
                  description: 'Request-level token usage already flows through the provider once the key is configured.',
                },
              ].map((item) => (
                <div key={item.title} className="rounded-2xl px-3 py-3" style={settingsSubtlePanelStyle}>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">{item.title}</p>
                  <p className="mt-2 text-sm font-semibold text-text-primary">{item.value}</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">{item.description}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="rounded-[20px] p-4" style={settingsCardStyle}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h4 className="text-sm font-semibold text-text-primary">Models</h4>
              <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
                Curate the Fireworks catalog that Aurora exposes. Every alias here is reused by the main model selector.
              </p>
            </div>
            <div className="rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-primary" style={{ backgroundColor: 'color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)' }}>
              Shared With Selector
            </div>
          </div>

          <div className="mt-4 flex gap-2">
            <input
              type="text"
              value={newModelId}
              onChange={(event) => setNewModelId(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && handleAddModel()}
              placeholder="Add another Fireworks model ID"
              className="flex-1 rounded-xl px-3 py-2 text-xs font-medium text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-primary"
              style={settingsInputStyle}
            />
            <button
              onClick={handleAddModel}
              disabled={!newModelId.trim()}
              className="inline-flex items-center gap-1 rounded-xl px-3 py-2 text-[11px] font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
              style={settingsPrimaryButtonStyle}
            >
              <Plus className="h-3 w-3" />
              Add
            </button>
          </div>

          <div className="mt-4 space-y-2">
            {modelList.map((modelId) => {
              const isDefaultModel = fireworks.model === modelId;
              const isSelectedModel = selectedModel === `${fireworks.id}:${modelId}`;

              return (
                <div
                  key={modelId}
                  className="grid gap-2 rounded-2xl px-3 py-3 xl:grid-cols-[minmax(0,1.1fr)_minmax(180px,0.75fr)_auto_auto]"
                  style={settingsSubtlePanelStyle}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-semibold text-text-primary">
                        {formatModelDisplayName(modelId, fireworks.modelAliases?.[modelId])}
                      </p>
                      {isDefaultModel && (
                        <span className="rounded-full bg-primary/15 px-2 py-1 text-[9px] font-semibold uppercase tracking-wide text-primary">
                          Default
                        </span>
                      )}
                      {isSelectedModel && !isDefaultModel && (
                        <span className="rounded-full bg-success/15 px-2 py-1 text-[9px] font-semibold uppercase tracking-wide text-success">
                          Active
                        </span>
                      )}
                    </div>
                    <p className="mt-1 truncate font-mono text-[10px] text-text-secondary">{modelId}</p>
                  </div>

                  <input
                    type="text"
                    value={fireworks.modelAliases?.[modelId] || ''}
                    onChange={(event) => handleAliasChange(modelId, event.target.value)}
                    placeholder={formatModelDisplayName(modelId)}
                    className="w-full rounded-xl px-3 py-2 text-xs font-medium text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-primary"
                    style={settingsInputStyle}
                  />

                  <button
                    onClick={() => handleSetDefaultModel(modelId)}
                    className="rounded-xl px-3 py-2 text-[11px] font-semibold text-primary-foreground"
                    style={settingsPrimaryButtonStyle}
                  >
                    Set Default
                  </button>

                  <button
                    onClick={() => handleRemoveModel(modelId)}
                    disabled={modelList.length <= 1}
                    className="rounded-xl px-3 py-2 text-[11px] font-semibold text-text-secondary hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
                    style={settingsInputStyle}
                    title="Remove model"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
