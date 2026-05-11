import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Cloud,
  Eye,
  EyeOff,
  HardDrive,
  ImageIcon,
  Loader2,
  Plus,
  RefreshCcw,
  Search,
  Sparkles,
  Trash2,
  Wrench,
  X,
  XCircle,
} from 'lucide-react';

import { useSettingsStore, type LLMModel, type LLMProvider } from '../../store/useSettingsStore';
import { formatModelDisplayName, formatProviderNickname } from '../../lib/provider-display';
import {
  detectLocalProviders,
  type LocalProvider,
} from '../../services/local-model-detector';
import { IdeSelect } from '../ui/IdeSelect';
import { IdeSwitch } from '../ui/IdeSwitch';
import { settingsRowDividerColor } from './settings-shared';
import {
  ActionButton,
  FieldLabel,
  FormBlock,
  FormRow,
  FormRowLast,
  IconButton,
  IdeTextInput,
  Section,
  StatusPill,
} from './settings-primitives';
import { ModelEditorDialog, type ModelDraft } from './ModelEditorDialog';
import {
  ProviderEditorDialog,
  type ProviderDraft,
} from './ProviderEditorDialog';

/**
 * Unified Providers hub.
 *
 * Two-level navigation inside one Settings tab:
 *
 *   Level 1 (grid)   — every provider as a square card. Each card
 *                      shows model count, API-key status, kind
 *                      (Cloud/Local), and an enable toggle. Click
 *                      anywhere on the card to drill in. The last
 *                      tile is "Add custom provider" (opens the
 *                      ProviderEditorDialog modal).
 *
 *   Level 2 (detail) — focused view for one provider with a back
 *                      button, the connection settings (endpoint,
 *                      key, format, defaults), and a card grid of
 *                      every model under it. Adding / editing models
 *                      uses ModelEditorDialog.
 *
 * Cloud, custom, and locally-detected providers all live in the same
 * grid because the schema treats them the same: a `baseUrl`, optional
 * `apiKey`, and a roster of `provider_models` rows. Fireworks stays
 * as its own Settings tab (billing/usage/CLI is a different surface).
 */

type ProviderFilter = 'all' | 'cloud' | 'local' | 'disabled';

type View =
  | { kind: 'grid' }
  | { kind: 'detail'; providerId: string };

interface ProvidersHubTabProps {
  fireworksTabEnabled: boolean;
  setFireworksTabEnabled: (next: boolean) => void;
}

// ---------------------------------------------------------------------------
// Shared style tokens
// ---------------------------------------------------------------------------

const cardOuterStyle: React.CSSProperties = {
  backgroundColor:
    'color-mix(in srgb, var(--aurora-title-bar-background) 56%, var(--aurora-sidebar-background) 44%)',
  border: '1px solid color-mix(in srgb, var(--aurora-common-border) 70%, transparent)',
  borderRadius: 8,
};

const modelCardStyle: React.CSSProperties = {
  backgroundColor:
    'color-mix(in srgb, var(--aurora-editor-background) 50%, var(--aurora-sidebar-background) 50%)',
  border: '1px solid color-mix(in srgb, var(--aurora-common-border) 50%, transparent)',
  borderRadius: 8,
};

function isLocalBaseUrl(baseUrl: string): boolean {
  const lower = baseUrl.toLowerCase();
  return lower.includes('localhost') || lower.includes('127.0.0.1');
}

function isProviderReady(provider: LLMProvider): boolean {
  if (!provider.enabled) return false;
  if (isLocalBaseUrl(provider.baseUrl)) return true;
  if (provider.requiresApiKey === false) return true;
  return provider.apiKey.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Small leaf components
// ---------------------------------------------------------------------------

const CapabilityBadge: React.FC<{
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  label: string;
  active: boolean;
}> = ({ icon: Icon, label, active }) => (
  <span
    className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.06em]"
    style={{
      color: active
        ? 'var(--aurora-common-primary)'
        : 'var(--aurora-editor-foreground-muted, var(--aurora-text-disabled))',
      backgroundColor: active
        ? 'color-mix(in srgb, var(--aurora-common-primary) 12%, transparent)'
        : 'transparent',
      border: `1px solid ${active
        ? 'color-mix(in srgb, var(--aurora-common-primary) 30%, transparent)'
        : 'color-mix(in srgb, var(--aurora-common-border) 50%, transparent)'}`,
      borderRadius: 3,
    }}
    title={`${label}: ${active ? 'on' : 'off'}`}
  >
    <Icon className="h-2.5 w-2.5" />
    {label}
  </span>
);

// ---------------------------------------------------------------------------
// Provider grid card (Level 1)
// ---------------------------------------------------------------------------

interface ProviderGridCardProps {
  provider: LLMProvider;
  modelCount: number;
  onOpen: () => void;
}

const ProviderGridCard: React.FC<ProviderGridCardProps> = ({
  provider,
  modelCount,
  onOpen,
}) => {
  const updateProvider = useSettingsStore((s) => s.updateProvider);
  const isLocal = isLocalBaseUrl(provider.baseUrl);
  const ready = isProviderReady(provider);
  const hasKey = provider.apiKey.trim().length > 0;
  const keyRequired = !isLocal && provider.requiresApiKey !== false;

  return (
    // Card is rendered as a div + role="button" rather than a real
    // <button> element because IdeSwitch (and any other interactive
    // control inside) is itself a button — and HTML disallows nested
    // buttons. We preserve a11y with role/tabIndex and a keydown
    // handler that mirrors the native Enter/Space activation.
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      className="group flex flex-col text-left cursor-pointer transition-transform hover:-translate-y-px focus:outline-none"
      style={{
        ...cardOuterStyle,
        // Square-ish proportions; min height keeps short cards from
        // collapsing under the model-count badge.
        minHeight: 168,
      }}
    >
      {/* Header: name + enable toggle. The toggle is interactive so we
          stop propagation to keep clicks from also drilling into detail. */}
      <div
        className="flex items-start justify-between gap-2 px-3.5 pt-3"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] font-semibold text-text-primary truncate">
              {provider.name}
            </span>
            {provider.id === 'fireworks' && (
              <StatusPill variant="info" dot={false}>★</StatusPill>
            )}
          </div>
          <div className="mt-0.5 truncate text-[10.5px] text-text-secondary">
            {formatProviderNickname(provider.name, provider.nickname)}
          </div>
        </div>
        <div onClick={(e) => e.stopPropagation()}>
          <IdeSwitch
            checked={provider.enabled}
            onChange={(next) => updateProvider(provider.id, { enabled: next })}
            ariaLabel={`Toggle ${provider.name}`}
            variant="primary"
            size="sm"
          />
        </div>
      </div>

      {/* Body: counts + key status */}
      <div className="flex-1 px-3.5 pt-3 pb-2 space-y-2">
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{
              backgroundColor:
                modelCount > 0
                  ? 'var(--aurora-common-primary)'
                  : 'var(--aurora-editor-foreground-muted, var(--aurora-text-disabled))',
            }}
          />
          <span className="text-[11.5px] text-text-primary">
            {modelCount} model{modelCount === 1 ? '' : 's'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {hasKey ? (
            <CheckCircle2
              className="h-3 w-3"
              style={{ color: 'var(--aurora-common-success)' }}
            />
          ) : (
            <XCircle
              className="h-3 w-3"
              style={{
                color: keyRequired
                  ? 'var(--aurora-common-warning)'
                  : 'var(--aurora-editor-foreground-muted, var(--aurora-text-disabled))',
              }}
            />
          )}
          <span
            className="text-[11px]"
            style={{
              color: hasKey
                ? 'var(--aurora-editor-foreground)'
                : keyRequired
                  ? 'var(--aurora-common-warning)'
                  : 'var(--aurora-editor-foreground-muted, var(--aurora-text-disabled))',
            }}
          >
            {hasKey ? 'API key set' : keyRequired ? 'No API key' : 'No key needed'}
          </span>
        </div>
      </div>

      {/* Footer: kind + status pill */}
      <div
        className="flex items-center justify-between gap-2 px-3.5 py-2.5"
        style={{ borderTop: `1px solid ${settingsRowDividerColor}` }}
      >
        <div className="flex items-center gap-1.5">
          {isLocal ? (
            <span
              className="inline-flex items-center gap-1 text-[10.5px] font-medium uppercase tracking-[0.08em]"
              style={{ color: 'var(--aurora-common-primary)' }}
            >
              <HardDrive className="h-2.5 w-2.5" />
              Local
            </span>
          ) : (
            <span
              className="inline-flex items-center gap-1 text-[10.5px] font-medium uppercase tracking-[0.08em]"
              style={{ color: 'var(--aurora-editor-foreground)' }}
            >
              <Cloud className="h-2.5 w-2.5" />
              Cloud
            </span>
          )}
        </div>
        {ready && provider.enabled ? (
          <StatusPill variant="success">Ready</StatusPill>
        ) : !provider.enabled ? (
          <StatusPill variant="neutral">Off</StatusPill>
        ) : (
          <StatusPill variant="warning">No Key</StatusPill>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// "Add provider" tile — sits at the end of the grid as if it were a card.
// ---------------------------------------------------------------------------

interface AddProviderTileProps {
  onClick: () => void;
}

const AddProviderTile: React.FC<AddProviderTileProps> = ({ onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="flex flex-col items-center justify-center gap-2 text-center transition-colors focus:outline-none"
    style={{
      minHeight: 168,
      borderRadius: 8,
      border: `1px dashed color-mix(in srgb, var(--aurora-common-border) 80%, transparent)`,
      backgroundColor: 'transparent',
      color: 'var(--aurora-editor-foreground-muted, var(--aurora-text-secondary))',
    }}
  >
    <div
      className="flex h-9 w-9 items-center justify-center rounded-full"
      style={{
        backgroundColor:
          'color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)',
        color: 'var(--aurora-common-primary)',
      }}
    >
      <Plus className="h-4 w-4" />
    </div>
    <div className="space-y-0.5">
      <div
        className="text-[12px] font-semibold"
        style={{ color: 'var(--aurora-editor-foreground)' }}
      >
        Add provider
      </div>
      <div className="text-[10.5px]">Custom OpenAI / Anthropic / local</div>
    </div>
  </button>
);

// ---------------------------------------------------------------------------
// Discover Local Servers — runs detector, surfaces hits as draft cards.
// ---------------------------------------------------------------------------

interface DiscoverPanelProps {
  knownBaseUrls: Set<string>;
  onAccept: (provider: LocalProvider) => void;
  onCancel: () => void;
}

const DiscoverPanel: React.FC<DiscoverPanelProps> = ({
  knownBaseUrls,
  onAccept,
  onCancel,
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<LocalProvider[]>([]);

  const runScan = async () => {
    setLoading(true);
    setError(null);
    try {
      const detection = await detectLocalProviders();
      setResults(detection.providers);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    runScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Section
      title="Discover local servers"
      description="Probes Ollama (11434) and LM Studio (1234). Accept a row to add it as a regular provider with all detected models seeded."
      badge={
        <div className="flex gap-1.5">
          <ActionButton
            variant="secondary"
            onClick={runScan}
            loading={loading}
            icon={<RefreshCcw className="h-3 w-3" />}
          >
            Rescan
          </ActionButton>
          <ActionButton variant="secondary" onClick={onCancel} icon={<X className="h-3 w-3" />}>
            Close
          </ActionButton>
        </div>
      }
    >
      {error && (
        <div
          className="px-4 py-2.5 text-[11.5px]"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--aurora-common-danger) 10%, transparent)',
            color: 'var(--aurora-common-danger)',
            borderBottom: `1px solid ${settingsRowDividerColor}`,
          }}
        >
          Detection failed: {error}
        </div>
      )}
      {loading && results.length === 0 && (
        <div
          className="flex items-center gap-2 px-4 py-3.5 text-[11.5px]"
          style={{ color: 'var(--aurora-editor-foreground)' }}
        >
          <Loader2 className="h-3 w-3 animate-spin" />
          Scanning local ports…
        </div>
      )}
      {!loading && results.length === 0 && !error && (
        <div className="px-4 py-3.5 text-[11.5px] text-text-secondary">
          No local servers found. Make sure Ollama or LM Studio is running, then rescan.
        </div>
      )}
      {results.map((provider) => {
        const alreadyImported = knownBaseUrls.has(provider.baseUrl.toLowerCase());
        return (
          <FormBlock key={`${provider.type}-${provider.baseUrl}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[12.5px] font-semibold text-text-primary">
                    {provider.name}
                  </span>
                  <StatusPill variant="success">{provider.type}</StatusPill>
                  {alreadyImported && (
                    <StatusPill variant="neutral" dot={false}>Imported</StatusPill>
                  )}
                </div>
                <div className="mt-0.5 truncate font-mono text-[10.5px] text-text-secondary">
                  {provider.baseUrl}
                </div>
                <div className="mt-1 text-[11px] text-text-secondary">
                  {provider.models.length} model
                  {provider.models.length === 1 ? '' : 's'}: {provider.models
                    .slice(0, 3)
                    .map((m) => m.name || m.id)
                    .join(', ')}
                  {provider.models.length > 3 && ` +${provider.models.length - 3} more`}
                </div>
              </div>
              <ActionButton
                variant="primary"
                onClick={() => onAccept(provider)}
                disabled={alreadyImported}
                icon={<Plus className="h-3 w-3" />}
              >
                {alreadyImported ? 'Already added' : 'Add'}
              </ActionButton>
            </div>
          </FormBlock>
        );
      })}
    </Section>
  );
};

// ---------------------------------------------------------------------------
// Provider detail view (Level 2)
// ---------------------------------------------------------------------------

interface ProviderDetailViewProps {
  provider: LLMProvider;
  models: LLMModel[];
  onBack: () => void;
  onEditModel: (model: LLMModel) => void;
  onAddModel: () => void;
}

const ProviderDetailView: React.FC<ProviderDetailViewProps> = ({
  provider,
  models,
  onBack,
  onEditModel,
  onAddModel,
}) => {
  const updateProvider = useSettingsStore((s) => s.updateProvider);
  const deleteProvider = useSettingsStore((s) => s.deleteProvider);
  const deleteModel = useSettingsStore((s) => s.deleteModel);
  const setSelectedModel = useSettingsStore((s) => s.setSelectedModel);
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const [showApiKey, setShowApiKey] = useState(false);

  const isLocal = isLocalBaseUrl(provider.baseUrl);
  const ready = isProviderReady(provider);
  const isRecommended = provider.id === 'fireworks';
  const [activeProviderId, activeModelKey] = selectedModel.split(':');

  return (
    <div className="space-y-5 pb-2">
      {/* Breadcrumb / header */}
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-[11.5px] text-text-secondary transition-colors hover:text-text-primary"
        >
          <ArrowLeft className="h-3 w-3" />
          <span>Providers</span>
          <span className="text-text-disabled">/</span>
          <span className="font-semibold text-text-primary">{provider.name}</span>
        </button>
        <div className="flex items-center gap-2">
          {ready && provider.enabled && <StatusPill variant="success">Ready</StatusPill>}
          {!ready && provider.enabled && <StatusPill variant="warning">No Key</StatusPill>}
          {!provider.enabled && <StatusPill variant="neutral">Off</StatusPill>}
          <IdeSwitch
            checked={provider.enabled}
            onChange={(next) => updateProvider(provider.id, { enabled: next })}
            ariaLabel={`Toggle ${provider.name}`}
            variant="primary"
            size="sm"
          />
          {provider.isCustom && (
            <IconButton
              ariaLabel={`Delete ${provider.name}`}
              variant="danger"
              onClick={() => {
                deleteProvider(provider.id);
                onBack();
              }}
            >
              <Trash2 className="h-3 w-3" />
            </IconButton>
          )}
        </div>
      </div>

      {isRecommended && (
        <div
          className="rounded-md px-3.5 py-2.5 text-[11.5px] leading-relaxed"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--aurora-common-primary) 8%, transparent)',
            border:
              '1px solid color-mix(in srgb, var(--aurora-common-primary) 24%, transparent)',
          }}
        >
          <span style={{ color: 'var(--aurora-common-primary)', fontWeight: 600 }}>
            Recommended.
          </span>{' '}
          Fireworks is preconfigured. Paste a Fireworks API key below and Aurora is ready to chat.
        </div>
      )}

      <Section title="Connection">
        {provider.isCustom && (
          <FormRow label="API format" hint="Determines how Aurora signs and structures requests.">
            <div className="w-[220px]">
              <IdeSelect
                ariaLabel="Select provider API format"
                options={[
                  { label: 'OpenAI Compatible', value: 'openai' },
                  { label: 'Anthropic Compatible', value: 'anthropic' },
                  { label: 'Custom (OpenAI-like)', value: 'custom' },
                ]}
                onChange={(next) =>
                  updateProvider(provider.id, {
                    providerType: String(next) as LLMProvider['providerType'],
                  })
                }
                value={provider.providerType || 'openai'}
              />
            </div>
          </FormRow>
        )}

        <FormBlock>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel className="mb-1">Provider name</FieldLabel>
              <IdeTextInput
                value={provider.name}
                onChange={(event) => updateProvider(provider.id, { name: event.target.value })}
                disabled={!provider.isCustom}
              />
            </div>
            <div>
              <FieldLabel className="mb-1">Selector name</FieldLabel>
              <IdeTextInput
                value={provider.nickname || ''}
                onChange={(event) =>
                  updateProvider(provider.id, { nickname: event.target.value })
                }
                placeholder={provider.name}
              />
            </div>
          </div>
        </FormBlock>

        <FormBlock>
          <FieldLabel className="mb-1">Base URL</FieldLabel>
          <IdeTextInput
            value={provider.baseUrl}
            onChange={(event) =>
              updateProvider(provider.id, { baseUrl: event.target.value.trim() })
            }
            style={{ fontFamily: 'monospace' }}
          />
        </FormBlock>

        <FormBlock>
          <FieldLabel className="mb-1">
            API key{' '}
            {isLocal && (
              <span className="font-normal lowercase tracking-normal text-text-disabled">
                — optional for local
              </span>
            )}
          </FieldLabel>
          <div className="flex gap-1.5">
            <div className="flex-1">
              <IdeTextInput
                type={showApiKey ? 'text' : 'password'}
                value={provider.apiKey}
                onChange={(event) =>
                  updateProvider(provider.id, { apiKey: event.target.value })
                }
                placeholder={isLocal ? 'Not required' : 'Enter API key…'}
                style={{ fontFamily: 'monospace' }}
              />
            </div>
            <IconButton
              ariaLabel={showApiKey ? 'Hide key' : 'Show key'}
              onClick={() => setShowApiKey(!showApiKey)}
            >
              {showApiKey ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            </IconButton>
          </div>
        </FormBlock>

        <FormBlock divided={false}>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel className="mb-1">Default context window</FieldLabel>
              <IdeTextInput
                type="number"
                value={provider.contextWindow}
                onChange={(event) =>
                  updateProvider(provider.id, {
                    contextWindow: Number.parseInt(event.target.value, 10) || 32000,
                  })
                }
                style={{ fontFamily: 'monospace' }}
              />
            </div>
            <div>
              <FieldLabel className="mb-1">Default max output</FieldLabel>
              <IdeTextInput
                type="number"
                value={provider.maxOutputTokens}
                onChange={(event) =>
                  updateProvider(provider.id, {
                    maxOutputTokens: Number.parseInt(event.target.value, 10) || 4096,
                  })
                }
                style={{ fontFamily: 'monospace' }}
              />
            </div>
          </div>
        </FormBlock>
      </Section>

      <Section
        title={`Models (${models.length})`}
        description="Capabilities (vision, thinking, tool-stream) and per-model context/output overrides live on each card."
        badge={
          <ActionButton
            variant="primary"
            icon={<Plus className="h-3 w-3" />}
            onClick={onAddModel}
          >
            Add model
          </ActionButton>
        }
      >
        <FormBlock divided={false}>
          {models.length === 0 ? (
            <div
              className="px-3 py-6 text-center text-[11.5px] text-text-secondary"
              style={{
                border: `1px dashed ${settingsRowDividerColor}`,
                borderRadius: 6,
              }}
            >
              No models yet. Click <span className="font-semibold">Add model</span> to register one.
            </div>
          ) : (
            <div
              className="grid gap-2.5"
              style={{
                gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              }}
            >
              {models.map((model) => {
                const isActive =
                  provider.id === activeProviderId && model.modelKey === activeModelKey;
                const ctx =
                  model.contextWindow ?? provider.contextWindow;
                return (
                  <div
                    key={model.id}
                    className="flex flex-col gap-2 px-3 py-2.5"
                    style={{
                      ...modelCardStyle,
                      borderColor: isActive
                        ? 'color-mix(in srgb, var(--aurora-common-primary) 50%, transparent)'
                        : modelCardStyle.border?.toString(),
                    }}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[12px] font-semibold text-text-primary">
                          {formatModelDisplayName(model.modelKey, model.label)}
                        </span>
                        {isActive && (
                          <StatusPill variant="success" dot={false}>Active</StatusPill>
                        )}
                        {!model.enabled && (
                          <StatusPill variant="neutral" dot={false}>Off</StatusPill>
                        )}
                      </div>
                      <div className="truncate font-mono text-[10px] text-text-secondary">
                        {model.modelKey}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-wrap">
                      <CapabilityBadge icon={ImageIcon} label="Vision" active={model.supportsVision} />
                      <CapabilityBadge icon={Sparkles} label="Think" active={model.supportsThinking} />
                      <CapabilityBadge icon={Wrench} label="Stream" active={model.supportsToolStream} />
                    </div>
                    <div
                      className="text-[10.5px] text-text-secondary"
                      style={{ fontFamily: 'monospace' }}
                    >
                      ctx {ctx.toLocaleString()}
                      {model.contextWindow !== undefined && (
                        <span className="ml-1 text-text-disabled">(override)</span>
                      )}
                    </div>
                    <div
                      className="flex items-center justify-between gap-1.5 pt-1.5"
                      style={{ borderTop: `1px solid ${settingsRowDividerColor}` }}
                    >
                      <ActionButton
                        variant="secondary"
                        onClick={() =>
                          setSelectedModel(`${provider.id}:${model.modelKey}`)
                        }
                        disabled={isActive || !model.enabled || !ready}
                        title={
                          !ready
                            ? 'Provider not ready — add an API key first'
                            : !model.enabled
                              ? 'Model is disabled'
                              : 'Use this model'
                        }
                      >
                        {isActive ? 'In use' : 'Use'}
                      </ActionButton>
                      <div className="flex items-center gap-1">
                        <IconButton
                          ariaLabel="Edit model"
                          title="Edit model"
                          onClick={() => onEditModel(model)}
                        >
                          <Wrench className="h-3 w-3" />
                        </IconButton>
                        <IconButton
                          ariaLabel="Delete model"
                          title="Delete model"
                          variant="danger"
                          onClick={() => deleteModel(model.id)}
                          disabled={models.length <= 1}
                        >
                          <X className="h-3 w-3" />
                        </IconButton>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </FormBlock>
      </Section>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main hub
// ---------------------------------------------------------------------------

export const ProvidersHubTab: React.FC<ProvidersHubTabProps> = ({
  fireworksTabEnabled,
  setFireworksTabEnabled,
}) => {
  const providers = useSettingsStore((s) => s.providers);
  const models = useSettingsStore((s) => s.models);
  const addCustomProvider = useSettingsStore((s) => s.addCustomProvider);
  const addModel = useSettingsStore((s) => s.addModel);
  const updateModel = useSettingsStore((s) => s.updateModel);

  const [view, setView] = useState<View>({ kind: 'grid' });
  const [filter, setFilter] = useState<ProviderFilter>('all');
  const [search, setSearch] = useState('');
  const [isAddingProvider, setIsAddingProvider] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);

  // Model editor state (used from the detail view).
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorProviderId, setEditorProviderId] = useState<string | null>(null);
  const [editorInitial, setEditorInitial] = useState<LLMModel | undefined>(undefined);

  const knownBaseUrls = useMemo(
    () => new Set(providers.map((p) => p.baseUrl.toLowerCase())),
    [providers],
  );

  const modelsByProvider = useMemo(() => {
    const map = new Map<string, LLMModel[]>();
    for (const m of models) {
      const list = map.get(m.providerId) ?? [];
      list.push(m);
      map.set(m.providerId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.sortOrder - b.sortOrder);
    }
    return map;
  }, [models]);

  const filteredProviders = useMemo(() => {
    const lowered = search.trim().toLowerCase();
    return providers.filter((p) => {
      if (filter === 'cloud' && isLocalBaseUrl(p.baseUrl)) return false;
      if (filter === 'local' && !isLocalBaseUrl(p.baseUrl)) return false;
      if (filter === 'disabled' && p.enabled) return false;
      if (lowered) {
        const haystack = `${p.name} ${p.nickname || ''} ${p.baseUrl}`.toLowerCase();
        if (!haystack.includes(lowered)) return false;
      }
      return true;
    });
  }, [providers, filter, search]);

  const counts = useMemo(() => {
    const enabledCount = providers.filter((p) => p.enabled).length;
    const readyCount = providers.filter(isProviderReady).length;
    const cloudCount = providers.filter((p) => !isLocalBaseUrl(p.baseUrl)).length;
    const localCount = providers.filter((p) => isLocalBaseUrl(p.baseUrl)).length;
    return { enabledCount, readyCount, cloudCount, localCount, total: providers.length };
  }, [providers]);

  // ── Detail-view bookkeeping: drop the user back to the grid if the
  // provider they were viewing gets deleted underneath them. ──────────
  useEffect(() => {
    if (view.kind !== 'detail') return;
    if (!providers.some((p) => p.id === view.providerId)) {
      setView({ kind: 'grid' });
    }
  }, [view, providers]);

  // ── Action handlers ────────────────────────────────────────────────
  const handleAddProvider = (draft: ProviderDraft) => {
    const init: Omit<LLMProvider, 'id' | 'isCustom'> = {
      name: draft.name,
      nickname: draft.nickname,
      baseUrl: draft.baseUrl,
      apiKey: draft.apiKey,
      model: draft.initialModelKey,
      contextWindow: draft.contextWindow,
      maxOutputTokens: draft.maxOutputTokens,
      supportsThinking: false,
      enabled: true,
      providerType: draft.providerType,
    };
    const newId = addCustomProvider(init);
    setIsAddingProvider(false);
    // Drop into the new provider's detail view immediately so the
    // user can finish setup (add more models, tweak defaults) without
    // having to find their card in the grid first.
    setView({ kind: 'detail', providerId: newId });
  };

  const handleAcceptDiscovered = (detected: LocalProvider) => {
    const aliases: Record<string, string> = {};
    for (const m of detected.models) {
      if (m.name && m.name !== m.id) aliases[m.id] = m.name;
    }
    const init: Omit<LLMProvider, 'id' | 'isCustom'> = {
      name: detected.name,
      nickname: detected.name,
      baseUrl: detected.baseUrl,
      apiKey: '',
      model: detected.models[0]?.id ?? '',
      contextWindow: detected.models[0]?.maxContextLength ?? 128000,
      maxOutputTokens: 8192,
      supportsThinking: detected.models.some((m) => m.supportsThinking),
      enabled: true,
      providerType: detected.type === 'ollama' ? 'ollama' : 'lmstudio',
      requiresApiKey: false,
      customModels: detected.models.map((m) => m.id),
      modelAliases: aliases,
    };
    addCustomProvider(init);
    setIsDiscovering(false);

    // Stamp per-model capability flags from the detector metadata.
    setTimeout(() => {
      const created = useSettingsStore
        .getState()
        .providers.find((p) => p.baseUrl === detected.baseUrl);
      if (!created) return;
      for (const dm of detected.models) {
        const row = useSettingsStore
          .getState()
          .models.find((m) => m.providerId === created.id && m.modelKey === dm.id);
        if (row) {
          updateModel(row.id, {
            supportsVision: !!dm.vision,
            supportsThinking: !!dm.supportsThinking,
            contextWindow: dm.maxContextLength ?? undefined,
          });
        }
      }
    }, 50);
  };

  const openAddModel = (providerId: string) => {
    setEditorProviderId(providerId);
    setEditorInitial(undefined);
    setEditorOpen(true);
  };

  const openEditModel = (providerId: string, model: LLMModel) => {
    setEditorProviderId(providerId);
    setEditorInitial(model);
    setEditorOpen(true);
  };

  const saveModel = (draft: ModelDraft) => {
    if (!editorProviderId) return;
    if (editorInitial) {
      updateModel(editorInitial.id, {
        label: draft.label,
        contextWindow: draft.contextWindow,
        maxOutputTokens: draft.maxOutputTokens,
        supportsVision: draft.supportsVision,
        supportsThinking: draft.supportsThinking,
        supportsToolStream: draft.supportsToolStream,
        enabled: draft.enabled,
      });
    } else {
      addModel(editorProviderId, {
        modelKey: draft.modelKey,
        label: draft.label,
        contextWindow: draft.contextWindow,
        maxOutputTokens: draft.maxOutputTokens,
        supportsVision: draft.supportsVision,
        supportsThinking: draft.supportsThinking,
        supportsToolStream: draft.supportsToolStream,
        enabled: draft.enabled,
      });
    }
    setEditorOpen(false);
  };

  const editorProvider = editorProviderId
    ? providers.find((p) => p.id === editorProviderId)
    : undefined;
  const editorExistingKeys = useMemo(() => {
    if (!editorProviderId) return [] as string[];
    return models
      .filter((m) => m.providerId === editorProviderId)
      .map((m) => m.modelKey);
  }, [editorProviderId, models]);

  // ── Render: detail view? ──────────────────────────────────────────
  if (view.kind === 'detail') {
    const provider = providers.find((p) => p.id === view.providerId);
    if (!provider) return null;
    const ownModels = modelsByProvider.get(provider.id) ?? [];
    return (
      <>
        <ProviderDetailView
          provider={provider}
          models={ownModels}
          onBack={() => setView({ kind: 'grid' })}
          onAddModel={() => openAddModel(provider.id)}
          onEditModel={(model) => openEditModel(provider.id, model)}
        />
        <ModelEditorDialog
          isOpen={editorOpen}
          initial={editorInitial}
          providerName={editorProvider?.name ?? ''}
          providerContextWindow={editorProvider?.contextWindow ?? 128000}
          providerMaxOutput={editorProvider?.maxOutputTokens ?? 8192}
          existingKeys={editorExistingKeys}
          onClose={() => setEditorOpen(false)}
          onSave={saveModel}
        />
      </>
    );
  }

  // ── Render: grid view (default) ───────────────────────────────────
  const FILTER_OPTIONS: Array<{ id: ProviderFilter; label: string; count?: number }> = [
    { id: 'all', label: 'All', count: counts.total },
    { id: 'cloud', label: 'Cloud', count: counts.cloudCount },
    { id: 'local', label: 'Local', count: counts.localCount },
    { id: 'disabled', label: 'Disabled', count: counts.total - counts.enabledCount },
  ];

  return (
    <div className="space-y-5 pb-2">
      {/* Header strip: counts + actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[14px] font-semibold text-text-primary">Providers</h2>
          <StatusPill variant="success">{counts.readyCount} Ready</StatusPill>
          <StatusPill variant="neutral" dot={false}>
            {counts.enabledCount} / {counts.total} On
          </StatusPill>
        </div>
        <div className="flex items-center gap-2">
          <ActionButton
            variant="secondary"
            icon={<Search className="h-3 w-3" />}
            onClick={() => {
              setIsDiscovering(true);
              setIsAddingProvider(false);
            }}
          >
            Discover local
          </ActionButton>
          <ActionButton
            variant="primary"
            icon={<Plus className="h-3 w-3" />}
            onClick={() => {
              setIsAddingProvider(true);
              setIsDiscovering(false);
            }}
          >
            Add provider
          </ActionButton>
        </div>
      </div>

      {/* Filter chips + search */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {FILTER_OPTIONS.map((option) => {
            const isActive = filter === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setFilter(option.id)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium transition-colors"
                style={{
                  color: isActive
                    ? 'var(--aurora-common-primary)'
                    : 'var(--aurora-editor-foreground)',
                  backgroundColor: isActive
                    ? 'color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)'
                    : 'color-mix(in srgb, var(--aurora-editor-background) 50%, transparent)',
                  border: `1px solid ${isActive
                    ? 'color-mix(in srgb, var(--aurora-common-primary) 35%, transparent)'
                    : 'color-mix(in srgb, var(--aurora-common-border) 60%, transparent)'}`,
                  borderRadius: 4,
                }}
              >
                {option.label}
                {typeof option.count === 'number' && (
                  <span className="font-mono text-[10px] opacity-70">
                    {option.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div style={{ width: 220 }}>
          <IdeTextInput
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter by name, nickname, URL…"
          />
        </div>
      </div>

      {/* Discover panel (inline above the grid when active) */}
      {isDiscovering && (
        <DiscoverPanel
          knownBaseUrls={knownBaseUrls}
          onAccept={handleAcceptDiscovered}
          onCancel={() => setIsDiscovering(false)}
        />
      )}

      {/* The grid */}
      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        }}
      >
        {filteredProviders.map((provider) => (
          <ProviderGridCard
            key={provider.id}
            provider={provider}
            modelCount={modelsByProvider.get(provider.id)?.length ?? 0}
            onOpen={() => setView({ kind: 'detail', providerId: provider.id })}
          />
        ))}
        {/* Add tile — only show on the unfiltered "all" view so it
            doesn't visually conflict with a "Disabled" filter etc. */}
        {filter === 'all' && !search && (
          <AddProviderTile onClick={() => setIsAddingProvider(true)} />
        )}
        {filteredProviders.length === 0 && (filter !== 'all' || search) && (
          <div
            className="col-span-full px-3 py-6 text-center text-[11.5px] text-text-secondary"
            style={{
              border: `1px dashed ${settingsRowDividerColor}`,
              borderRadius: 6,
            }}
          >
            No providers match this filter.
          </div>
        )}
      </div>

      <Section
        title="Fireworks Control Center"
        description="Expose the dedicated Fireworks tab for billing, usage, and CLI integration."
      >
        <FormRowLast
          label="Show Fireworks tab"
          hint="Turn off to keep the Settings modal lean. Fireworks remains available as a regular provider in the grid above."
        >
          <IdeSwitch
            checked={fireworksTabEnabled}
            onChange={setFireworksTabEnabled}
            ariaLabel="Toggle Fireworks Control Center"
            variant="primary"
            size="sm"
          />
        </FormRowLast>
      </Section>

      <ProviderEditorDialog
        isOpen={isAddingProvider}
        onClose={() => setIsAddingProvider(false)}
        onSave={handleAddProvider}
      />
    </div>
  );
};
