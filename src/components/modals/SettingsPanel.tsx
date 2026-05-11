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

import React, { useState } from 'react';
import { useUiStore } from '../../store/useUiStore';
import { useSettingsStore, type LLMProvider } from '../../store/useSettingsStore';
import { formatModelDisplayName, formatProviderNickname } from '../../lib/provider-display';
import { getAppVersion, PACKAGE_VERSION } from '../../lib/app-version';
import {
  X,
  Server,
  Layout,
  Shield,
  Eye,
  EyeOff,
  Plus,
  Trash2,
  ChevronDown,
  Palette,
  Plug,
  Info,
  Sparkles,
  Flame,
  HardDrive,
  Mic,
} from 'lucide-react';
import clsx from 'clsx';
import { ToolSettingsTab } from './ToolSettingsTab';
import { ThemeSettingsTab } from './ThemeSettingsTab';
import { SpeechSettingsTab } from './SpeechSettingsTab';
import { McpSettingsTab } from './McpSettingsTab';
import { SkillsSettingsTab } from './SkillsSettingsTab';
import { GeneralSettingsTab } from './GeneralSettingsTab';
import { AboutSettingsTab } from './AboutSettingsTab';
import { FireworksSettingsTab } from './FireworksSettingsTab';
import { IdeSwitch } from '../ui/IdeSwitch';
import { IdeSelect } from '../ui/IdeSelect';
import { LocalProviderPanel } from '../settings/LocalProviderPanel';
import {
  settingsShellStyle,
  settingsRowDividerColor,
} from './settings-shared';
import {
  Section,
  FormRow,
  FormRowLast,
  FormBlock,
  StatusPill,
  ActionButton,
  IconButton,
  IdeTextInput,
  FieldLabel,
} from './settings-primitives';

// ============================================
// SETTINGS SHELL CHROME
// ============================================

const sidebarStyle: React.CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--aurora-title-bar-background) 60%, var(--aurora-sidebar-background) 40%)',
  borderRight: '1px solid color-mix(in srgb, var(--aurora-common-border) 70%, transparent)',
};

const headerStyle: React.CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--aurora-title-bar-background) 50%, var(--aurora-sidebar-background) 50%)',
  borderBottom: '1px solid color-mix(in srgb, var(--aurora-common-border) 70%, transparent)',
};

// ============================================
// ADD PROVIDER FORM
// ============================================

interface AddProviderFormProps {
  onSave: (provider: Omit<LLMProvider, 'id' | 'isCustom'>) => void;
  onCancel: () => void;
}

const AddProviderForm: React.FC<AddProviderFormProps> = ({ onSave, onCancel }) => {
  const [name, setName] = useState('');
  const [nickname, setNickname] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [contextWindow, setContextWindow] = useState(200000);
  const [maxOutputTokens, setMaxOutputTokens] = useState(8192);
  const [supportsThinking, setSupportsThinking] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [providerType, setProviderType] = useState<'openai' | 'anthropic' | 'custom'>('openai');

  const handleSubmit = () => {
    if (!name.trim() || !baseUrl.trim() || !model.trim()) return;
    onSave({
      name: name.trim(),
      nickname: nickname.trim() || name.trim(),
      baseUrl: baseUrl.trim().replace(/\/$/, ''),
      apiKey: apiKey.trim(),
      model: model.trim(),
      contextWindow,
      maxOutputTokens,
      supportsThinking,
      enabled: true,
      customModels: [model.trim()],
      providerType,
    });
  };

  const isValid = name.trim() && baseUrl.trim() && model.trim();

  return (
    <Section
      title="Add Custom Provider"
      description="Create a new provider profile with its API format, endpoint, model IDs, and limits."
      badge={<StatusPill variant="info" dot={false}>Draft</StatusPill>}
    >
      <FormBlock>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel className="mb-1">Name *</FieldLabel>
            <IdeTextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Local LLM"
            />
          </div>
          <div>
            <FieldLabel className="mb-1">Selector Name</FieldLabel>
            <IdeTextInput
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="Local"
            />
          </div>
        </div>
      </FormBlock>

      <FormBlock>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel className="mb-1">API Format *</FieldLabel>
            <IdeSelect
              ariaLabel="Select provider API format"
              options={[
                { label: 'OpenAI Compatible', value: 'openai' },
                { label: 'Anthropic Compatible', value: 'anthropic' },
                { label: 'Custom (OpenAI-like)', value: 'custom' },
              ]}
              onChange={(nextValue) =>
                setProviderType(String(nextValue) as 'openai' | 'anthropic' | 'custom')
              }
              value={providerType}
            />
          </div>
          <div>
            <FieldLabel className="mb-1">Default Model *</FieldLabel>
            <IdeTextInput
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="llama3.2"
              style={{ fontFamily: 'monospace' }}
            />
          </div>
        </div>
      </FormBlock>

      <FormBlock>
        <FieldLabel className="mb-1">Base URL *</FieldLabel>
        <IdeTextInput
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://localhost:11434/v1"
          style={{ fontFamily: 'monospace' }}
        />
      </FormBlock>

      <FormBlock>
        <FieldLabel className="mb-1">API Key (optional)</FieldLabel>
        <div className="flex gap-1.5">
          <div className="flex-1">
            <IdeTextInput
              type={showApiKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Leave empty for local providers"
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
            <FieldLabel className="mb-1">Context Window</FieldLabel>
            <IdeTextInput
              type="number"
              value={contextWindow}
              onChange={(e) => setContextWindow(parseInt(e.target.value) || 200000)}
              placeholder="200000"
              style={{ fontFamily: 'monospace' }}
            />
          </div>
          <div>
            <FieldLabel className="mb-1">Max Output Tokens</FieldLabel>
            <IdeTextInput
              type="number"
              value={maxOutputTokens}
              onChange={(e) => setMaxOutputTokens(parseInt(e.target.value) || 8192)}
              placeholder="8192"
              style={{ fontFamily: 'monospace' }}
            />
          </div>
        </div>
      </FormBlock>

      <FormRow
        label="Supports thinking / reasoning mode"
        hint="Enable when this provider exposes a `reasoning_content` or thinking blocks field."
      >
        <IdeSwitch
          checked={supportsThinking}
          onChange={setSupportsThinking}
          ariaLabel="Toggle thinking support"
          variant="primary"
          size="sm"
        />
      </FormRow>

      <FormRowLast
        label="Save provider"
        hint={isValid ? 'Profile is ready to be added.' : 'Name, Base URL, and Default Model are required.'}
      >
        <div className="flex gap-2">
          <ActionButton variant="secondary" onClick={onCancel}>
            Cancel
          </ActionButton>
          <ActionButton variant="primary" onClick={handleSubmit} disabled={!isValid}>
            Add Provider
          </ActionButton>
        </div>
      </FormRowLast>
    </Section>
  );
};

// ============================================
// PROVIDER CARD
// ============================================

interface ProviderCardProps {
  provider: LLMProvider;
  isExpanded: boolean;
  onToggleExpand: () => void;
  showApiKey: boolean;
  onToggleApiKey: () => void;
}

const providerCardOuterStyle: React.CSSProperties = {
  backgroundColor:
    'color-mix(in srgb, var(--aurora-title-bar-background) 56%, var(--aurora-sidebar-background) 44%)',
  border: '1px solid color-mix(in srgb, var(--aurora-common-border) 70%, transparent)',
  borderRadius: 8,
};

const ProviderCard: React.FC<ProviderCardProps> = ({
  provider,
  isExpanded,
  onToggleExpand,
  showApiKey,
  onToggleApiKey,
}) => {
  const { updateProvider, deleteProvider } = useSettingsStore();
  const [newModelId, setNewModelId] = useState('');
  const isLocal = provider.baseUrl.includes('localhost') || provider.baseUrl.includes('127.0.0.1');
  const hasKey = !!provider.apiKey;
  const isReady = isLocal || hasKey;
  const isRecommendedProvider = provider.id === 'fireworks';
  const selectorName = formatProviderNickname(provider.name, provider.nickname);

  const handleAddModel = () => {
    if (!newModelId.trim()) return;
    const currentModels = provider.customModels || [provider.model];
    if (currentModels.includes(newModelId.trim())) {
      setNewModelId('');
      return;
    }
    updateProvider(provider.id, {
      customModels: [...currentModels, newModelId.trim()],
    });
    setNewModelId('');
  };

  const handleRemoveModel = (modelToRemove: string) => {
    const currentModels = provider.customModels || [provider.model];
    if (currentModels.length <= 1) return;
    updateProvider(provider.id, {
      customModels: currentModels.filter((m) => m !== modelToRemove),
      model:
        provider.model === modelToRemove
          ? currentModels.find((m) => m !== modelToRemove) || provider.model
          : provider.model,
    });
  };

  const handleModelAliasChange = (modelId: string, alias: string) => {
    const nextAliases = { ...(provider.modelAliases || {}) };
    const trimmedAlias = alias.trim();
    if (trimmedAlias) {
      nextAliases[modelId] = trimmedAlias;
    } else {
      delete nextAliases[modelId];
    }
    updateProvider(provider.id, {
      modelAliases: Object.keys(nextAliases).length > 0 ? nextAliases : undefined,
    });
  };

  return (
    <div className="overflow-hidden" style={providerCardOuterStyle}>
      {/* Header row */}
      <div
        className="flex cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5 transition-colors"
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
              <span className="text-[12.5px] font-semibold text-text-primary">{provider.name}</span>
              {provider.isCustom && (
                <StatusPill variant="info" dot={false}>
                  Custom
                </StatusPill>
              )}
              {isRecommendedProvider && (
                <StatusPill variant="info" dot={false}>
                  Recommended
                </StatusPill>
              )}
              {isReady && provider.enabled && (
                <StatusPill variant="success">Ready</StatusPill>
              )}
              {!isReady && <StatusPill variant="warning">No Key</StatusPill>}
            </div>
            <p className="mt-0.5 truncate text-[11px] leading-snug text-text-secondary">
              {selectorName} · {provider.baseUrl.replace(/^https?:\/\//, '')}
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
          {isRecommendedProvider && (
            <div
              className="px-4 py-2.5 text-[11.5px] leading-relaxed"
              style={{
                backgroundColor:
                  'color-mix(in srgb, var(--aurora-common-primary) 8%, transparent)',
                borderBottom: `1px solid ${settingsRowDividerColor}`,
                color: 'var(--aurora-editor-foreground)',
              }}
            >
              <span style={{ color: 'var(--aurora-common-primary)', fontWeight: 600 }}>
                Recommended.
              </span>{' '}
              Fireworks is preconfigured as Aurora&apos;s default provider. Paste a Fireworks API
              key below and you can start using agent mode immediately.
            </div>
          )}

          {provider.isCustom && (
            <FormRow label="API Format" hint="Determines how Aurora signs and structures requests.">
              <div className="w-[220px]">
                <IdeSelect
                  ariaLabel="Select provider API format"
                  options={[
                    { label: 'OpenAI Compatible', value: 'openai' },
                    { label: 'Anthropic Compatible', value: 'anthropic' },
                    { label: 'Custom (OpenAI-like)', value: 'custom' },
                  ]}
                  onChange={(nextValue) =>
                    updateProvider(provider.id, {
                      providerType: String(nextValue) as LLMProvider['providerType'],
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
                <FieldLabel className="mb-1">Provider Name</FieldLabel>
                <IdeTextInput
                  value={provider.name}
                  onChange={(e) => updateProvider(provider.id, { name: e.target.value })}
                  disabled={!provider.isCustom}
                />
              </div>
              <div>
                <FieldLabel className="mb-1">Selector Name</FieldLabel>
                <IdeTextInput
                  value={provider.nickname || ''}
                  onChange={(e) => updateProvider(provider.id, { nickname: e.target.value })}
                  placeholder={provider.name}
                />
              </div>
            </div>
          </FormBlock>

          <FormBlock>
            <FieldLabel className="mb-1">Base URL</FieldLabel>
            <IdeTextInput
              value={provider.baseUrl}
              onChange={(e) => updateProvider(provider.id, { baseUrl: e.target.value.trim() })}
              style={{ fontFamily: 'monospace' }}
            />
          </FormBlock>

          <FormBlock>
            <FieldLabel className="mb-1">
              API Key {isLocal && <span className="font-normal lowercase tracking-normal text-text-disabled">— optional for local</span>}
            </FieldLabel>
            <div className="flex gap-1.5">
              <div className="flex-1">
                <IdeTextInput
                  type={showApiKey ? 'text' : 'password'}
                  value={provider.apiKey}
                  onChange={(e) => updateProvider(provider.id, { apiKey: e.target.value })}
                  placeholder={isLocal ? 'Not required' : 'Enter API key…'}
                  style={{ fontFamily: 'monospace' }}
                />
              </div>
              <IconButton ariaLabel={showApiKey ? 'Hide key' : 'Show key'} onClick={onToggleApiKey}>
                {showApiKey ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              </IconButton>
            </div>
          </FormBlock>

          <FormBlock>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <FieldLabel className="mb-1">Context Window</FieldLabel>
                <IdeTextInput
                  type="number"
                  value={provider.contextWindow}
                  onChange={(e) =>
                    updateProvider(provider.id, {
                      contextWindow: parseInt(e.target.value) || 32000,
                    })
                  }
                  style={{ fontFamily: 'monospace' }}
                />
              </div>
              <div>
                <FieldLabel className="mb-1">Max Output Tokens</FieldLabel>
                <IdeTextInput
                  type="number"
                  value={provider.maxOutputTokens}
                  onChange={(e) =>
                    updateProvider(provider.id, {
                      maxOutputTokens: parseInt(e.target.value) || 4096,
                    })
                  }
                  style={{ fontFamily: 'monospace' }}
                />
              </div>
            </div>
          </FormBlock>

          <FormRow
            label="Supports thinking / reasoning mode"
            hint="Enable when this provider exposes reasoning_content or native thinking blocks."
          >
            <IdeSwitch
              checked={!!provider.supportsThinking}
              onChange={(next) => updateProvider(provider.id, { supportsThinking: next })}
              ariaLabel="Toggle thinking support"
              variant="primary"
              size="sm"
            />
          </FormRow>

          <FormRow
            label="Vision capable"
            hint="Tick if the active model accepts image inputs (Claude 3+, GPT-4V, Llama-vision, etc.). When on, the agent gains the browser_screenshot tool and screenshot tool results are sent as real images so the model can see the page."
          >
            <IdeSwitch
              checked={!!provider.supportsVision}
              onChange={(next) => updateProvider(provider.id, { supportsVision: next })}
              ariaLabel="Toggle vision support"
              variant="primary"
              size="sm"
            />
          </FormRow>

          {/* Models section */}
          <FormBlock>
            <FieldLabel className="mb-2">Add Model ID</FieldLabel>
            <div className="flex gap-1.5">
              <div className="flex-1">
                <IdeTextInput
                  value={newModelId}
                  onChange={(e) => setNewModelId(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddModel()}
                  placeholder="e.g. gpt-4-turbo, llama3.2:70b"
                  style={{ fontFamily: 'monospace' }}
                />
              </div>
              <ActionButton
                variant="primary"
                onClick={handleAddModel}
                disabled={!newModelId.trim()}
                icon={<Plus className="h-3 w-3" />}
              >
                Add
              </ActionButton>
            </div>
          </FormBlock>

          <FormBlock divided={false}>
            <FieldLabel className="mb-2">Available Models</FieldLabel>
            <div className="space-y-1.5">
              {(provider.customModels || [provider.model]).map((model) => (
                <div
                  key={model}
                  className="grid grid-cols-[minmax(0,1.3fr)_minmax(160px,0.8fr)_auto] items-center gap-2 px-2.5 py-2"
                  style={{
                    backgroundColor:
                      'color-mix(in srgb, var(--aurora-editor-background) 50%, var(--aurora-sidebar-background) 50%)',
                    border: '1px solid color-mix(in srgb, var(--aurora-common-border) 50%, transparent)',
                    borderRadius: 6,
                  }}
                >
                  <div className="min-w-0">
                    <div className="truncate text-[11.5px] font-medium text-text-primary">
                      {formatModelDisplayName(model, provider.modelAliases?.[model])}
                    </div>
                    <div className="truncate font-mono text-[10px] text-text-secondary">
                      {model}
                    </div>
                  </div>
                  <IdeTextInput
                    value={provider.modelAliases?.[model] || ''}
                    onChange={(e) => handleModelAliasChange(model, e.target.value)}
                    placeholder={formatModelDisplayName(model)}
                  />
                  {(provider.customModels?.length || 1) > 1 && (
                    <IconButton
                      ariaLabel="Remove model"
                      title="Remove model"
                      variant="danger"
                      onClick={() => handleRemoveModel(model)}
                    >
                      <X className="h-3 w-3" />
                    </IconButton>
                  )}
                </div>
              ))}
            </div>
          </FormBlock>
        </div>
      )}
    </div>
  );
};

// ============================================
// PROVIDERS TAB
// ============================================

interface ProvidersTabProps {
  fireworksTabEnabled: boolean;
  setFireworksTabEnabled: (next: boolean) => void;
  setActiveTab: (tab: SettingsTabKey) => void;
  isAddingProvider: boolean;
  setIsAddingProvider: (next: boolean) => void;
  onAddProvider: (provider: Omit<LLMProvider, 'id' | 'isCustom'>) => void;
  providers: LLMProvider[];
  expandedProvider: string | null;
  setExpandedProvider: (id: string | null) => void;
  showApiKey: Record<string, boolean>;
  toggleApiKeyVisibility: (id: string) => void;
}

const ProvidersTab: React.FC<ProvidersTabProps> = ({
  fireworksTabEnabled,
  setFireworksTabEnabled,
  setActiveTab,
  isAddingProvider,
  setIsAddingProvider,
  onAddProvider,
  providers,
  expandedProvider,
  setExpandedProvider,
  showApiKey,
  toggleApiKeyVisibility,
}) => {
  const enabledCount = providers.filter((p) => p.enabled).length;
  const readyCount = providers.filter((p) => {
    const isLocal = p.baseUrl.includes('localhost') || p.baseUrl.includes('127.0.0.1');
    return p.enabled && (isLocal || !!p.apiKey);
  }).length;

  return (
    <div className="space-y-6 pb-2">
      <Section
        title="Provider Stack"
        description="Configure the LLM providers Aurora can route to. Expand any provider to edit endpoint, credentials, models, and limits."
        badge={
          <div className="flex gap-1.5">
            <StatusPill variant="success">{readyCount} Ready</StatusPill>
            <StatusPill variant="neutral" dot={false}>
              {enabledCount} / {providers.length} On
            </StatusPill>
          </div>
        }
      >
        <FormRowLast
          label="Add a new provider"
          hint="Create a custom provider profile alongside the built-in catalog."
        >
          <ActionButton
            variant="primary"
            icon={<Plus className="h-3 w-3" />}
            onClick={() => setIsAddingProvider(true)}
          >
            Add Provider
          </ActionButton>
        </FormRowLast>
      </Section>

      <Section
        title="Fireworks Control Center"
        description="Expose the dedicated Fireworks tab for richer overview and model catalog management."
      >
        <FormRowLast
          label="Show Fireworks tab"
          hint="Turn off to keep the Settings modal lean. Fireworks remains available as a regular provider."
        >
          <IdeSwitch
            checked={fireworksTabEnabled}
            onChange={(next) => {
              setFireworksTabEnabled(next);
              if (!next) setActiveTab('providers');
            }}
            ariaLabel="Toggle Fireworks Control Center"
            variant="primary"
            size="sm"
          />
        </FormRowLast>
      </Section>

      {isAddingProvider && (
        <AddProviderForm
          onSave={onAddProvider}
          onCancel={() => setIsAddingProvider(false)}
        />
      )}

      <Section
        title="Configured Providers"
        description="Click a provider to expand and edit. Use the toggle to enable or disable without losing settings."
      >
        <div
          className="space-y-1.5 p-1.5"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--aurora-sidebar-background) 50%, transparent)',
          }}
        >
          {providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              isExpanded={expandedProvider === provider.id}
              onToggleExpand={() =>
                setExpandedProvider(
                  expandedProvider === provider.id ? null : provider.id,
                )
              }
              showApiKey={showApiKey[provider.id] || false}
              onToggleApiKey={() => toggleApiKeyVisibility(provider.id)}
            />
          ))}
        </div>
      </Section>
    </div>
  );
};

// ============================================
// MAIN SETTINGS PANEL
// ============================================

type SettingsTabKey =
  | 'providers'
  | 'local'
  | 'fireworks'
  | 'tools'
  | 'general'
  | 'themes'
  | 'speech'
  | 'mcp'
  | 'skills'
  | 'about';

interface SidebarItem {
  id: SettingsTabKey;
  label: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  group: 'connect' | 'workspace' | 'system';
}

const TAB_TITLES: Record<SettingsTabKey, { eyebrow: string; title: string; description: string }> = {
  providers: {
    eyebrow: 'Connectivity',
    title: 'LLM Providers',
    description: 'Manage cloud and local model providers, API keys, and selector models.',
  },
  local: {
    eyebrow: 'Connectivity',
    title: 'Local Models',
    description: 'Detect and configure Ollama, LM Studio, and custom OpenAI-compatible servers.',
  },
  fireworks: {
    eyebrow: 'Connectivity',
    title: 'Fireworks Control Center',
    description: 'Account sync, usage exports, and Fireworks model catalog management.',
  },
  mcp: {
    eyebrow: 'Connectivity',
    title: 'MCP Servers',
    description: 'Connect Model Context Protocol servers to expose external tools to the agent.',
  },
  skills: {
    eyebrow: 'Workspace',
    title: 'Skills',
    description: 'Curate which workspace and global skill packs Aurora injects into the agent prompt.',
  },
  speech: {
    eyebrow: 'Workspace',
    title: 'Speech Input',
    description: 'CrispASR runtime, devices, and dictation behavior for voice-to-chat.',
  },
  themes: {
    eyebrow: 'Appearance',
    title: 'Appearance & Theme',
    description: 'Built-in themes, custom themes, and import/export for VS Code-compatible packs.',
  },
  tools: {
    eyebrow: 'System',
    title: 'Tool Settings',
    description: 'Approval modes, auto-accept rules, and per-tool risk configuration.',
  },
  general: {
    eyebrow: 'System',
    title: 'General Settings',
    description: 'Editor, agent execution mode, UI font, OS integrations, and workspace defaults.',
  },
  about: {
    eyebrow: 'System',
    title: 'About Aurora',
    description: 'Version, capabilities overview, and credits.',
  },
};

export const SettingsPanel: React.FC = () => {
  const {
    isSettingsOpen,
    setSettingsOpen,
    settingsInitialTab,
    consumeSettingsInitialTab,
  } = useUiStore();
  const {
    agentExecutionMode,
    fireworksTabEnabled,
    fontSize,
    setFontSize,
    setFireworksTabEnabled,
    wrapMode,
    setWrapMode,
    providers,
    addCustomProvider,
    autoSave,
    setAutoSave,
    uiFontFamily,
    uiTextScale,
    setUiFontFamily,
    setUiTextScale,
    setAgentExecutionMode,
  } = useSettingsStore();

  const [activeTab, setActiveTab] = useState<SettingsTabKey>('providers');
  const [appVersion, setAppVersion] = useState(PACKAGE_VERSION);

  React.useEffect(() => {
    if (isSettingsOpen && settingsInitialTab) {
      setActiveTab(settingsInitialTab);
      consumeSettingsInitialTab();
    }
  }, [isSettingsOpen, settingsInitialTab, consumeSettingsInitialTab]);

  // Load app version
  React.useEffect(() => {
    getAppVersion().then(setAppVersion).catch(() => setAppVersion(PACKAGE_VERSION));
  }, []);

  const [showApiKey, setShowApiKey] = useState<Record<string, boolean>>({});
  const [expandedProvider, setExpandedProvider] = useState<string | null>('fireworks');
  const [isAddingProvider, setIsAddingProvider] = useState(false);

  if (!isSettingsOpen) return null;

  const toggleApiKeyVisibility = (id: string) => {
    setShowApiKey((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleAddProvider = (provider: Omit<LLMProvider, 'id' | 'isCustom'>) => {
    addCustomProvider(provider);
    setIsAddingProvider(false);
  };

  const sidebarItems: SidebarItem[] = [
    { id: 'providers', label: 'Providers', icon: Server, group: 'connect' },
    { id: 'local', label: 'Local Models', icon: HardDrive, group: 'connect' },
    ...(fireworksTabEnabled
      ? ([{ id: 'fireworks' as const, label: 'Fireworks', icon: Flame, group: 'connect' as const }])
      : []),
    { id: 'mcp', label: 'MCP Servers', icon: Plug, group: 'connect' },
    { id: 'skills', label: 'Skills', icon: Sparkles, group: 'workspace' },
    { id: 'speech', label: 'Speech', icon: Mic, group: 'workspace' },
    { id: 'themes', label: 'Appearance', icon: Palette, group: 'system' },
    { id: 'tools', label: 'Tools', icon: Shield, group: 'system' },
    { id: 'general', label: 'General', icon: Layout, group: 'system' },
    { id: 'about', label: 'About', icon: Info, group: 'system' },
  ];

  const groupedItems: Array<{ label: string; items: SidebarItem[] }> = [
    { label: 'Connectivity', items: sidebarItems.filter((i) => i.group === 'connect') },
    { label: 'Workspace', items: sidebarItems.filter((i) => i.group === 'workspace') },
    { label: 'System', items: sidebarItems.filter((i) => i.group === 'system') },
  ];

  const meta = TAB_TITLES[activeTab];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{
        backgroundColor: 'color-mix(in srgb, var(--aurora-common-shadow) 62%, transparent)',
      }}
    >
      <div
        className="flex h-[820px] w-[1240px] overflow-hidden"
        style={{ ...settingsShellStyle, borderRadius: 12 }}
      >
        {/* ============================================ */}
        {/* SIDEBAR                                       */}
        {/* ============================================ */}
        <aside className="flex w-[228px] flex-col" style={sidebarStyle}>
          {/* Sidebar header */}
          <div
            className="px-4 py-3.5"
            style={{
              borderBottom: `1px solid ${settingsRowDividerColor}`,
            }}
          >
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">
              Aurora
            </div>
            <div className="mt-0.5 text-[13px] font-semibold text-text-primary">
              Preferences
            </div>
          </div>

          {/* Grouped nav */}
          <nav className="flex-1 overflow-y-auto p-2 scrollbar-thin">
            {groupedItems.map((group, groupIdx) => (
              <div key={group.label} className={clsx(groupIdx > 0 && 'mt-3')}>
                <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-text-disabled">
                  {group.label}
                </div>
                <div className="space-y-0.5">
                  {group.items.map(({ id, label, icon: Icon }) => {
                    const isActive = activeTab === id;
                    return (
                      <button
                        key={id}
                        onClick={() => setActiveTab(id)}
                        className={clsx(
                          'group flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left text-[12px] transition-colors',
                          isActive
                            ? 'font-semibold'
                            : 'font-medium text-text-secondary hover:text-text-primary',
                        )}
                        style={{
                          color: isActive
                            ? 'var(--aurora-common-primary)'
                            : undefined,
                          backgroundColor: isActive
                            ? 'color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)'
                            : 'transparent',
                          borderRadius: 4,
                          borderLeft: isActive
                            ? '2px solid var(--aurora-common-primary)'
                            : '2px solid transparent',
                          paddingLeft: isActive ? 8 : 10,
                        }}
                      >
                        <Icon
                          className="h-3.5 w-3.5 shrink-0"
                          style={{
                            color: isActive
                              ? 'var(--aurora-common-primary)'
                              : 'var(--aurora-text-secondary, var(--aurora-editor-foreground))',
                          }}
                        />
                        <span className="truncate">{label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>

          {/* Sidebar footer */}
          <div
            className="px-4 py-2.5 text-[10px] text-text-disabled"
            style={{
              borderTop: `1px solid ${settingsRowDividerColor}`,
            }}
          >
            <span className="font-mono">v{appVersion}</span>
          </div>
        </aside>

        {/* ============================================ */}
        {/* CONTENT                                       */}
        {/* ============================================ */}
        <main className="flex min-w-0 flex-1 flex-col">
          {/* Tab header */}
          <header
            className="flex h-14 shrink-0 items-center justify-between gap-4 px-6"
            style={headerStyle}
          >
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">
                {meta.eyebrow}
              </div>
              <h2 className="mt-0.5 truncate text-[14px] font-semibold text-text-primary">
                {meta.title}
              </h2>
            </div>
            <button
              onClick={() => setSettingsOpen(false)}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center text-text-secondary transition-colors hover:text-text-primary"
              style={{
                backgroundColor:
                  'color-mix(in srgb, var(--aurora-common-secondary) 60%, var(--aurora-title-bar-background) 40%)',
                border:
                  '1px solid color-mix(in srgb, var(--aurora-common-border) 60%, transparent)',
                borderRadius: 6,
              }}
              aria-label="Close settings"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </header>

          {/* Tab content */}
          <div
            className="flex-1 overflow-y-auto px-6 py-5 scrollbar-thin"
            style={{
              scrollbarGutter: 'stable',
              backgroundColor:
                'color-mix(in srgb, var(--aurora-editor-background) 60%, var(--aurora-sidebar-background) 40%)',
            }}
          >
            {/* PROVIDERS TAB */}
            {activeTab === 'providers' && (
              <ProvidersTab
                fireworksTabEnabled={fireworksTabEnabled}
                setFireworksTabEnabled={setFireworksTabEnabled}
                setActiveTab={setActiveTab}
                isAddingProvider={isAddingProvider}
                setIsAddingProvider={setIsAddingProvider}
                onAddProvider={handleAddProvider}
                providers={providers}
                expandedProvider={expandedProvider}
                setExpandedProvider={setExpandedProvider}
                showApiKey={showApiKey}
                toggleApiKeyVisibility={toggleApiKeyVisibility}
              />
            )}

            {activeTab === 'local' && <LocalProviderPanel />}
            {activeTab === 'fireworks' && fireworksTabEnabled && <FireworksSettingsTab />}
            {activeTab === 'mcp' && <McpSettingsTab />}
            {activeTab === 'skills' && <SkillsSettingsTab />}
            {activeTab === 'speech' && <SpeechSettingsTab />}
            {activeTab === 'tools' && <ToolSettingsTab />}
            {activeTab === 'themes' && <ThemeSettingsTab />}

            {activeTab === 'general' && (
              <GeneralSettingsTab
                agentExecutionMode={agentExecutionMode}
                autoSave={autoSave}
                fontSize={fontSize}
                setAgentExecutionMode={setAgentExecutionMode}
                setAutoSave={setAutoSave}
                setFontSize={setFontSize}
                setUiFontFamily={setUiFontFamily}
                setUiTextScale={setUiTextScale}
                setWrapMode={setWrapMode}
                uiFontFamily={uiFontFamily}
                uiTextScale={uiTextScale}
                wrapMode={wrapMode}
              />
            )}

            {activeTab === 'about' && <AboutSettingsTab />}
          </div>
        </main>
      </div>
    </div>
  );
};
