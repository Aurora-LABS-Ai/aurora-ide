import React, { useMemo, useState } from 'react';
import clsx from 'clsx';
import {
  ChevronDown,
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

/**
 * Unified Providers hub — replaces the old `Providers` + `Local Models`
 * tabs. Cloud, custom, and locally-detected providers all live in the
 * same list because the schema treats them the same: a `baseUrl`,
 * optional `apiKey`, and a roster of `provider_models` rows. The
 * Fireworks tab stays separate (billing/usage/CLI is a different
 * surface entirely).
 */

type ProviderFilter = 'all' | 'cloud' | 'local' | 'disabled';

interface ProvidersHubTabProps {
  fireworksTabEnabled: boolean;
  setFireworksTabEnabled: (next: boolean) => void;
}

const cardOuterStyle: React.CSSProperties = {
  backgroundColor:
    'color-mix(in srgb, var(--aurora-title-bar-background) 56%, var(--aurora-sidebar-background) 44%)',
  border: '1px solid color-mix(in srgb, var(--aurora-common-border) 70%, transparent)',
  borderRadius: 8,
};

const modelRowStyle: React.CSSProperties = {
  backgroundColor:
    'color-mix(in srgb, var(--aurora-editor-background) 50%, var(--aurora-sidebar-background) 50%)',
  border: '1px solid color-mix(in srgb, var(--aurora-common-border) 50%, transparent)',
  borderRadius: 6,
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
// Capability badges
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
// Add cloud provider — slim inline form (transport + auth only).
//
// Per-model capabilities and ctx/output overrides land in ModelEditorDialog.
// The provider gets seeded with a single model row using `model` as the
// initial key; the user can then add more via the "Add Model" button on the
// expanded provider card.
// ---------------------------------------------------------------------------

interface AddProviderInlineProps {
  onSave: (init: Omit<LLMProvider, 'id' | 'isCustom'>) => void;
  onCancel: () => void;
}

const AddProviderInline: React.FC<AddProviderInlineProps> = ({ onSave, onCancel }) => {
  const [name, setName] = useState('');
  const [nickname, setNickname] = useState('');
  const [providerType, setProviderType] = useState<'openai' | 'anthropic' | 'custom'>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [model, setModel] = useState('');
  const [contextWindow, setContextWindow] = useState(200000);
  const [maxOutputTokens, setMaxOutputTokens] = useState(8192);

  const handleSave = () => {
    if (!name.trim() || !baseUrl.trim() || !model.trim()) return;
    onSave({
      name: name.trim(),
      nickname: nickname.trim() || name.trim(),
      baseUrl: baseUrl.trim().replace(/\/$/, ''),
      apiKey: apiKey.trim(),
      model: model.trim(),
      contextWindow,
      maxOutputTokens,
      supportsThinking: false,
      enabled: true,
      providerType,
    });
  };

  const isValid = !!(name.trim() && baseUrl.trim() && model.trim());

  return (
    <Section
      title="Add cloud provider"
      description="Endpoint, auth, and defaults. Capabilities (vision, thinking) are set on each model after creation."
      badge={<StatusPill variant="info" dot={false}>Draft</StatusPill>}
    >
      <FormBlock>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel className="mb-1">Name *</FieldLabel>
            <IdeTextInput
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="My OpenRouter"
            />
          </div>
          <div>
            <FieldLabel className="mb-1">Selector name</FieldLabel>
            <IdeTextInput
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              placeholder={name || 'OpenRouter'}
            />
          </div>
        </div>
      </FormBlock>
      <FormBlock>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel className="mb-1">API format *</FieldLabel>
            <IdeSelect
              ariaLabel="Select provider API format"
              options={[
                { label: 'OpenAI Compatible', value: 'openai' },
                { label: 'Anthropic Compatible', value: 'anthropic' },
                { label: 'Custom (OpenAI-like)', value: 'custom' },
              ]}
              onChange={(next) => setProviderType(String(next) as typeof providerType)}
              value={providerType}
            />
          </div>
          <div>
            <FieldLabel className="mb-1">Initial model ID *</FieldLabel>
            <IdeTextInput
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="gpt-4o-mini"
              style={{ fontFamily: 'monospace' }}
            />
          </div>
        </div>
      </FormBlock>
      <FormBlock>
        <FieldLabel className="mb-1">Base URL *</FieldLabel>
        <IdeTextInput
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://api.openrouter.ai/v1"
          style={{ fontFamily: 'monospace' }}
        />
      </FormBlock>
      <FormBlock>
        <FieldLabel className="mb-1">API key (optional for local)</FieldLabel>
        <div className="flex gap-1.5">
          <div className="flex-1">
            <IdeTextInput
              type={showApiKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="sk-…"
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
      <FormBlock>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel className="mb-1">Default context window</FieldLabel>
            <IdeTextInput
              type="number"
              value={contextWindow}
              onChange={(event) => setContextWindow(Number.parseInt(event.target.value, 10) || 200000)}
              style={{ fontFamily: 'monospace' }}
            />
          </div>
          <div>
            <FieldLabel className="mb-1">Default max output</FieldLabel>
            <IdeTextInput
              type="number"
              value={maxOutputTokens}
              onChange={(event) => setMaxOutputTokens(Number.parseInt(event.target.value, 10) || 8192)}
              style={{ fontFamily: 'monospace' }}
            />
          </div>
        </div>
      </FormBlock>
      <FormRowLast
        label="Save provider"
        hint={isValid ? 'Provider seeded with one model — add more from its card.' : 'Name, Base URL, and Initial model ID are required.'}
      >
        <div className="flex gap-2">
          <ActionButton variant="secondary" onClick={onCancel}>
            Cancel
          </ActionButton>
          <ActionButton variant="primary" onClick={handleSave} disabled={!isValid}>
            Add provider
          </ActionButton>
        </div>
      </FormRowLast>
    </Section>
  );
};

// ---------------------------------------------------------------------------
// Discover local servers — runs `detectLocalProviders` and surfaces hits.
// User picks which detected provider to import; the import seeds models
// from the detector's response (capability flags inferred from model
// metadata where available).
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

  React.useEffect(() => {
    runScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Section
      title="Discover local servers"
      description="Probes Ollama (11434) and LM Studio (1234). Accept a row to add it as a regular provider with all its detected models seeded."
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
            backgroundColor: 'color-mix(in srgb, var(--aurora-common-danger) 10%, transparent)',
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
                  {provider.models.length} model{provider.models.length === 1 ? '' : 's'}: {provider.models
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
// Provider card with model roster
// ---------------------------------------------------------------------------

interface ProviderCardProps {
  provider: LLMProvider;
  models: LLMModel[];
  isExpanded: boolean;
  onToggleExpand: () => void;
  onEditModel: (model: LLMModel) => void;
  onAddModel: () => void;
}

const ProviderCardWithModels: React.FC<ProviderCardProps> = ({
  provider,
  models,
  isExpanded,
  onToggleExpand,
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
  const selectorName = formatProviderNickname(provider.name, provider.nickname);
  const [activeProviderId, activeModelKey] = selectedModel.split(':');

  return (
    <div className="overflow-hidden" style={cardOuterStyle}>
      {/* Header */}
      <div
        className="flex cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5"
        onClick={onToggleExpand}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <ChevronDown
            className={clsx(
              'h-3 w-3 shrink-0 text-text-disabled transition-transform',
              isExpanded && 'rotate-180',
            )}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[12.5px] font-semibold text-text-primary">
                {provider.name}
              </span>
              {isLocal ? (
                <StatusPill variant="info" dot={false}>
                  <HardDrive className="h-2.5 w-2.5" />
                  Local
                </StatusPill>
              ) : (
                <StatusPill variant="neutral" dot={false}>
                  <Cloud className="h-2.5 w-2.5" />
                  Cloud
                </StatusPill>
              )}
              {provider.isCustom && (
                <StatusPill variant="info" dot={false}>Custom</StatusPill>
              )}
              {isRecommended && (
                <StatusPill variant="info" dot={false}>Recommended</StatusPill>
              )}
              {ready && provider.enabled && <StatusPill variant="success">Ready</StatusPill>}
              {!ready && provider.enabled && (
                <StatusPill variant="warning">No Key</StatusPill>
              )}
              {!provider.enabled && <StatusPill variant="neutral">Off</StatusPill>}
            </div>
            <p className="mt-0.5 truncate text-[11px] leading-snug text-text-secondary">
              {selectorName} · {provider.baseUrl.replace(/^https?:\/\//, '')} · {models.length} model{models.length === 1 ? '' : 's'}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {provider.isCustom && (
            <IconButton
              ariaLabel={`Delete ${provider.name}`}
              variant="danger"
              onClick={() => deleteProvider(provider.id)}
            >
              <Trash2 className="h-3 w-3" />
            </IconButton>
          )}
          <IdeSwitch
            checked={provider.enabled}
            onChange={(next) => updateProvider(provider.id, { enabled: next })}
            ariaLabel={`Toggle ${provider.name}`}
            variant="primary"
            size="sm"
          />
        </div>
      </div>

      {/* Expanded body */}
      {isExpanded && (
        <div style={{ borderTop: `1px solid ${settingsRowDividerColor}` }}>
          {isRecommended && (
            <div
              className="px-4 py-2.5 text-[11.5px] leading-relaxed"
              style={{
                backgroundColor: 'color-mix(in srgb, var(--aurora-common-primary) 8%, transparent)',
                borderBottom: `1px solid ${settingsRowDividerColor}`,
              }}
            >
              <span style={{ color: 'var(--aurora-common-primary)', fontWeight: 600 }}>
                Recommended.
              </span>{' '}
              Fireworks is preconfigured. Paste a Fireworks API key below and Aurora is ready to chat.
            </div>
          )}

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
                  onChange={(event) => updateProvider(provider.id, { nickname: event.target.value })}
                  placeholder={provider.name}
                />
              </div>
            </div>
          </FormBlock>

          <FormBlock>
            <FieldLabel className="mb-1">Base URL</FieldLabel>
            <IdeTextInput
              value={provider.baseUrl}
              onChange={(event) => updateProvider(provider.id, { baseUrl: event.target.value.trim() })}
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
                  onChange={(event) => updateProvider(provider.id, { apiKey: event.target.value })}
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

          <FormBlock>
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

          {/* ── Models ───────────────────────────────────────── */}
          <FormBlock>
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <FieldLabel>Models</FieldLabel>
                <p className="mt-1 text-[11px] text-text-secondary">
                  Capabilities (vision, thinking, tool-stream) and limits are per-model.
                  The selected model determines what tools the agent gets.
                </p>
              </div>
              <ActionButton
                variant="primary"
                onClick={onAddModel}
                icon={<Plus className="h-3 w-3" />}
              >
                Add model
              </ActionButton>
            </div>
            <div className="space-y-1.5">
              {models.length === 0 && (
                <div
                  className="px-2.5 py-3 text-center text-[11px] text-text-secondary"
                  style={{
                    border: `1px dashed ${settingsRowDividerColor}`,
                    borderRadius: 6,
                  }}
                >
                  No models yet. Click <span className="font-semibold">Add model</span> to register one.
                </div>
              )}
              {models.map((model) => {
                const isActive =
                  provider.id === activeProviderId && model.modelKey === activeModelKey;
                return (
                  <div
                    key={model.id}
                    className="grid grid-cols-[minmax(0,1.25fr)_minmax(180px,auto)_auto_auto] items-center gap-2 px-2.5 py-2"
                    style={{
                      ...modelRowStyle,
                      borderColor: isActive
                        ? 'color-mix(in srgb, var(--aurora-common-primary) 50%, transparent)'
                        : modelRowStyle.border?.toString(),
                    }}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[11.5px] font-medium text-text-primary">
                          {formatModelDisplayName(model.modelKey, model.label)}
                        </span>
                        {isActive && <StatusPill variant="success" dot={false}>Active</StatusPill>}
                        {!model.enabled && (
                          <StatusPill variant="neutral" dot={false}>Off</StatusPill>
                        )}
                      </div>
                      <div className="truncate font-mono text-[10px] text-text-secondary">
                        {model.modelKey}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <CapabilityBadge icon={ImageIcon} label="Vision" active={model.supportsVision} />
                      <CapabilityBadge icon={Sparkles} label="Think" active={model.supportsThinking} />
                      <CapabilityBadge icon={Wrench} label="Stream" active={model.supportsToolStream} />
                    </div>
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
                );
              })}
            </div>
          </FormBlock>
        </div>
      )}
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

  const [filter, setFilter] = useState<ProviderFilter>('all');
  const [search, setSearch] = useState('');
  const [isAddingProvider, setIsAddingProvider] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Model editor state
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorProviderId, setEditorProviderId] = useState<string | null>(null);
  const [editorInitial, setEditorInitial] = useState<LLMModel | undefined>(undefined);

  const knownBaseUrls = useMemo(
    () => new Set(providers.map((p) => p.baseUrl.toLowerCase())),
    [providers],
  );

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

  const handleAddProvider = (init: Omit<LLMProvider, 'id' | 'isCustom'>) => {
    addCustomProvider(init);
    setIsAddingProvider(false);
  };

  const handleAcceptDiscovered = (detected: LocalProvider) => {
    // Build an LLMProvider seed that addCustomProvider can ingest.
    // The seeded models slice is populated via the legacy
    // `customModels` field; addCustomProvider's reconciler turns
    // that into ProviderModel rows with capabilities preserved.
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

    // After the provider is created, walk back through the detected
    // models and stamp per-model capability flags using the detector's
    // metadata (vision, supportsThinking). This is a separate pass so
    // we don't have to extend addCustomProvider's signature.
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

  const FILTER_OPTIONS: Array<{ id: ProviderFilter; label: string; count?: number }> = [
    { id: 'all', label: 'All', count: counts.total },
    { id: 'cloud', label: 'Cloud', count: counts.cloudCount },
    { id: 'local', label: 'Local', count: counts.localCount },
    { id: 'disabled', label: 'Disabled', count: counts.total - counts.enabledCount },
  ];

  return (
    <div className="space-y-6 pb-2">
      <Section
        title="Provider stack"
        description="Cloud, custom, and local-detected providers all live here. Per-model capabilities (vision, thinking) are set on each model row inside a provider."
        badge={
          <div className="flex gap-1.5">
            <StatusPill variant="success">{counts.readyCount} Ready</StatusPill>
            <StatusPill variant="neutral" dot={false}>
              {counts.enabledCount} / {counts.total} On
            </StatusPill>
          </div>
        }
      >
        <FormRowLast
          label="Add or detect"
          hint="Create a custom provider or scan your machine for running Ollama / LM Studio servers."
        >
          <div className="flex gap-2">
            <ActionButton
              variant="secondary"
              icon={<Search className="h-3 w-3" />}
              onClick={() => {
                setIsDiscovering(true);
                setIsAddingProvider(false);
              }}
            >
              Discover local servers
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
        </FormRowLast>
      </Section>

      <Section
        title="Fireworks Control Center"
        description="Expose the dedicated Fireworks tab for billing, usage, and CLI integration."
      >
        <FormRowLast
          label="Show Fireworks tab"
          hint="Turn off to keep the Settings modal lean. Fireworks remains available as a regular provider."
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

      {isAddingProvider && (
        <AddProviderInline
          onSave={handleAddProvider}
          onCancel={() => setIsAddingProvider(false)}
        />
      )}

      {isDiscovering && (
        <DiscoverPanel
          knownBaseUrls={knownBaseUrls}
          onAccept={handleAcceptDiscovered}
          onCancel={() => setIsDiscovering(false)}
        />
      )}

      <Section
        title="Configured providers"
        description="Click a provider to expand and edit endpoint, credentials, and model roster."
      >
        {/* Filter / search bar */}
        <div
          className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
          style={{ borderBottom: `1px solid ${settingsRowDividerColor}` }}
        >
          <div className="flex flex-wrap gap-1">
            {FILTER_OPTIONS.map((option) => {
              const isActive = filter === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setFilter(option.id)}
                  className={clsx(
                    'inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium transition-colors',
                  )}
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

        <div
          className="space-y-1.5 p-1.5"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--aurora-sidebar-background) 50%, transparent)',
          }}
        >
          {filteredProviders.length === 0 && (
            <div className="px-3 py-6 text-center text-[11.5px] text-text-secondary">
              No providers match this filter.
            </div>
          )}
          {filteredProviders.map((provider) => {
            const ownModels = models
              .filter((m) => m.providerId === provider.id)
              .sort((a, b) => a.sortOrder - b.sortOrder);
            return (
              <ProviderCardWithModels
                key={provider.id}
                provider={provider}
                models={ownModels}
                isExpanded={expandedId === provider.id}
                onToggleExpand={() =>
                  setExpandedId(expandedId === provider.id ? null : provider.id)
                }
                onAddModel={() => openAddModel(provider.id)}
                onEditModel={(model) => openEditModel(provider.id, model)}
              />
            );
          })}
        </div>
      </Section>

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
    </div>
  );
};
