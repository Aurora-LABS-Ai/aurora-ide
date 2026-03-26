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
import { X, Server, Layout, Shield, Eye, EyeOff, Plus, Trash2, ChevronDown, Palette, Database, Plug, Info, Sparkles } from 'lucide-react';
import clsx from 'clsx';
import { ToolSettingsTab } from './ToolSettingsTab';
import { ThemeSettingsTab } from './ThemeSettingsTab';
import { SemanticSettingsTab } from './SemanticSettingsTab';
import { McpSettingsTab } from './McpSettingsTab';
import { SkillsSettingsTab } from './SkillsSettingsTab';
import { GeneralSettingsTab } from './GeneralSettingsTab';
import { AboutSettingsTab } from './AboutSettingsTab';
import { TogglePill } from '../ui/TogglePill';
import { SettingsSelect } from '../ui/SettingsSelect';
import { settingsCardStyle, settingsInputStyle, settingsPaneStyle, settingsShellStyle } from './settings-shared';

// ============================================
// ADD PROVIDER FORM
// ============================================

interface AddProviderFormProps {
  onSave: (provider: Omit<LLMProvider, 'id' | 'isCustom'>) => void;
  onCancel: () => void;
}

const AddProviderForm: React.FC<AddProviderFormProps> = ({ onSave, onCancel }) => {
  const [name, setName] = useState('');
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

  return (
    <div className="space-y-3 rounded-[20px] p-4" style={settingsCardStyle}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Add Custom Provider</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
            Create a provider profile with its API format, endpoint, model IDs, and limits.
          </p>
        </div>
        <div className="rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-primary" style={{ backgroundColor: 'color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)' }}>
          Draft
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-text-secondary">Name *</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Local LLM"
            className="w-full rounded-xl px-3 py-2 text-xs font-medium text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-primary"
            style={settingsInputStyle}
          />
        </div>
        <div>
          <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-text-secondary">API Format *</label>
          <SettingsSelect
            ariaLabel="Select provider API format"
            options={[
              { label: 'OpenAI Compatible', value: 'openai' },
              { label: 'Anthropic Compatible', value: 'anthropic' },
              { label: 'Custom (OpenAI-like)', value: 'custom' },
            ]}
            onChange={(nextValue) => setProviderType(String(nextValue) as 'openai' | 'anthropic' | 'custom')}
            value={providerType}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-text-secondary">Model *</label>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="llama3.2"
            className="w-full rounded-xl px-3 py-2 text-xs font-medium text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-primary"
            style={settingsInputStyle}
          />
        </div>
        <div>
          <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-text-secondary">Context Window</label>
          <input
            type="number"
            value={contextWindow}
            onChange={(e) => setContextWindow(parseInt(e.target.value) || 200000)}
            placeholder="200000"
            className="w-full rounded-xl px-3 py-2 text-xs font-medium text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-primary"
            style={settingsInputStyle}
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-text-secondary">Base URL *</label>
        <input
          type="text"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://localhost:11434/v1"
          className="w-full rounded-xl px-3 py-2 text-xs font-medium text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-primary"
          style={settingsInputStyle}
        />
      </div>

      <div>
        <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-text-secondary">API Key (optional)</label>
        <div className="flex gap-1">
          <input
            type={showApiKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Leave empty for local"
            className="flex-1 rounded-xl px-3 py-2 text-xs font-medium text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-primary"
            style={settingsInputStyle}
          />
          <button
            onClick={() => setShowApiKey(!showApiKey)}
            className="rounded-xl px-3 text-text-secondary hover:text-text-primary"
            style={settingsInputStyle}
          >
            {showApiKey ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
          </button>
        </div>
      </div>

      <div>
        <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-text-secondary">Max Output Tokens</label>
        <input
          type="number"
          value={maxOutputTokens}
          onChange={(e) => setMaxOutputTokens(parseInt(e.target.value) || 8192)}
          placeholder="8192"
          className="w-full rounded-xl px-3 py-2 text-xs font-medium text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-primary"
          style={settingsInputStyle}
        />
      </div>

      <div className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ backgroundColor: 'color-mix(in srgb, var(--aurora-common-primary) 5%, transparent)' }}>
        <input
          type="checkbox"
          id="supportsThinking"
          checked={supportsThinking}
          onChange={(e) => setSupportsThinking(e.target.checked)}
          className="w-3 h-3 rounded border-border bg-input accent-primary"
        />
        <label htmlFor="supportsThinking" className="text-[10px] text-text-secondary">
          Supports thinking/reasoning mode
        </label>
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="rounded-xl px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary"
          style={settingsInputStyle}
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!name.trim() || !baseUrl.trim() || !model.trim()}
          className="rounded-xl px-4 py-2 text-xs font-semibold text-primary-foreground transition-colors disabled:opacity-50"
          style={{
            backgroundColor: 'var(--aurora-common-primary)',
            boxShadow: '0 10px 24px color-mix(in srgb, var(--aurora-common-primary) 22%, transparent)',
          }}
        >
          Add
        </button>
      </div>
    </div>
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
    // Don't allow removing the last model
    if (currentModels.length <= 1) return;
    updateProvider(provider.id, {
      customModels: currentModels.filter((m) => m !== modelToRemove),
      // If removing the default model, set a new default
      model: provider.model === modelToRemove ? currentModels.find((m) => m !== modelToRemove) || provider.model : provider.model,
    });
  };

  return (
    <div className="overflow-hidden rounded-[20px]" style={settingsCardStyle}>
      {/* Header */}
      <div
        className="flex cursor-pointer items-center justify-between px-4 py-3 transition-colors"
        style={{ backgroundColor: 'color-mix(in srgb, var(--aurora-title-bar-background) 48%, transparent)' }}
        onClick={onToggleExpand}
      >
        <div className="flex items-center gap-2">
          <ChevronDown className={clsx("w-3.5 h-3.5 text-text-disabled transition-transform", isExpanded && "rotate-180")} />
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-text-primary">{provider.name}</span>
            <span className="text-[11px] text-text-secondary">{provider.baseUrl.replace(/^https?:\/\//, '')}</span>
          </div>
          {provider.isCustom && (
            <span className="rounded-full bg-primary/15 px-2 py-1 text-[9px] font-semibold uppercase tracking-wide text-primary">Custom</span>
          )}
          {isReady && provider.enabled && (
            <span className="rounded-full bg-success/15 px-2 py-1 text-[9px] font-semibold uppercase tracking-wide text-success">Ready</span>
          )}
          {!isReady && (
            <span className="rounded-full bg-warning/15 px-2 py-1 text-[9px] font-semibold uppercase tracking-wide text-warning">No Key</span>
          )}
        </div>
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {provider.isCustom && (
            <button
              onClick={() => deleteProvider(provider.id)}
              className="rounded-xl p-2 text-text-disabled hover:text-danger"
              style={settingsInputStyle}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          <TogglePill
            checked={provider.enabled}
            onChange={(next) => updateProvider(provider.id, { enabled: next })}
            ariaLabel={`Toggle ${provider.name}`}
            variant="primary"
            size="sm"
          />
        </div>
      </div>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="space-y-3 border-t border-border px-4 pb-4 pt-3">
          {/* API Format (only for custom providers) */}
          {provider.isCustom && (
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-text-secondary">API Format</label>
              <SettingsSelect
                ariaLabel="Select provider API format"
                options={[
                  { label: 'OpenAI Compatible', value: 'openai' },
                  { label: 'Anthropic Compatible', value: 'anthropic' },
                  { label: 'Custom (OpenAI-like)', value: 'custom' },
                ]}
                onChange={(nextValue) => updateProvider(provider.id, { providerType: String(nextValue) as LLMProvider['providerType'] })}
                value={provider.providerType || 'openai'}
              />
            </div>
          )}

          {/* Base URL */}
          <div>
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-text-secondary">Base URL</label>
            <input
              type="text"
              value={provider.baseUrl}
              onChange={(e) => updateProvider(provider.id, { baseUrl: e.target.value.trim() })}
              className="w-full rounded-xl px-3 py-2 text-xs font-medium text-text-primary font-mono focus:outline-none focus:border-primary"
              style={settingsInputStyle}
            />
          </div>

          {/* API Key */}
          <div>
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-text-secondary">
              API Key {isLocal && '(optional)'}
            </label>
            <div className="flex gap-1">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={provider.apiKey}
                onChange={(e) => updateProvider(provider.id, { apiKey: e.target.value })}
                placeholder={isLocal ? 'Not required' : 'Enter API key...'}
                className="flex-1 rounded-xl px-3 py-2 text-xs font-medium text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-primary"
                style={settingsInputStyle}
              />
              <button
                onClick={onToggleApiKey}
                className="rounded-xl px-3 text-text-secondary hover:text-text-primary"
                style={settingsInputStyle}
              >
                {showApiKey ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              </button>
            </div>
          </div>

          {/* Context Window & Max Output */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-text-secondary">Context Window</label>
              <input
                type="number"
                value={provider.contextWindow}
                onChange={(e) => updateProvider(provider.id, { contextWindow: parseInt(e.target.value) || 32000 })}
                className="w-full rounded-xl px-3 py-2 text-xs font-medium text-text-primary font-mono focus:outline-none focus:border-primary"
                style={settingsInputStyle}
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-text-secondary">Max Output Tokens</label>
              <input
                type="number"
                value={provider.maxOutputTokens}
                onChange={(e) => updateProvider(provider.id, { maxOutputTokens: parseInt(e.target.value) || 4096 })}
                className="w-full rounded-xl px-3 py-2 text-xs font-medium text-text-primary font-mono focus:outline-none focus:border-primary"
                style={settingsInputStyle}
              />
            </div>
          </div>

          {/* Supports Thinking */}
          <div className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ backgroundColor: 'color-mix(in srgb, var(--aurora-common-primary) 5%, transparent)' }}>
            <input
              type="checkbox"
              id={`thinking-${provider.id}`}
              checked={provider.supportsThinking}
              onChange={(e) => updateProvider(provider.id, { supportsThinking: e.target.checked })}
              className="w-3 h-3 rounded border-border bg-input accent-primary"
            />
            <label htmlFor={`thinking-${provider.id}`} className="text-[10px] text-text-disabled">
              Supports thinking/reasoning mode
            </label>
          </div>

          {/* Add Model ID */}
          <div>
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-text-secondary">Add Model ID</label>
            <div className="flex gap-1">
              <input
                type="text"
                value={newModelId}
                onChange={(e) => setNewModelId(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddModel()}
                placeholder="e.g. gpt-4-turbo, llama3.2:70b"
                className="flex-1 rounded-xl px-3 py-2 text-xs font-medium text-text-primary placeholder:text-text-disabled font-mono focus:outline-none focus:border-primary"
                style={settingsInputStyle}
              />
              <button
                onClick={handleAddModel}
                disabled={!newModelId.trim()}
                className="rounded-xl px-3 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/80 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{
                  backgroundColor: 'var(--aurora-common-primary)',
                  boxShadow: '0 10px 24px color-mix(in srgb, var(--aurora-common-primary) 20%, transparent)',
                }}
              >
                <Plus className="w-3 h-3" />
              </button>
            </div>
          </div>

          {/* Models List */}
          <div>
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-text-secondary">Available Models</label>
            <div className="flex flex-wrap gap-1">
              {(provider.customModels || [provider.model]).map((model) => (
                <span
                  key={model}
                  className="group flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium text-text-secondary font-mono"
                  style={settingsInputStyle}
                >
                  {model}
                  {(provider.customModels?.length || 1) > 1 && (
                    <button
                      onClick={() => handleRemoveModel(model)}
                      className="opacity-0 group-hover:opacity-100 text-text-disabled hover:text-danger transition-opacity"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  )}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================
// MAIN SETTINGS PANEL
// ============================================

export const SettingsPanel: React.FC = () => {
  const { isSettingsOpen, setSettingsOpen } = useUiStore();
  const {
    fontSize,
    setFontSize,
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
  } = useSettingsStore();

  // Note: Thinking, temperature, and maxTokens are now per-provider settings
  // Each provider has its own supportsThinking, defaultTemperature, and defaultMaxTokens

  // Each provider has its own supportsThinking, defaultTemperature, and defaultMaxTokens

  const [activeTab, setActiveTab] = useState<'providers' | 'tools' | 'general' | 'themes' | 'semantic' | 'mcp' | 'skills' | 'about'>('providers');
  const [showApiKey, setShowApiKey] = useState<Record<string, boolean>>({});
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [isAddingProvider, setIsAddingProvider] = useState(false);

  if (!isSettingsOpen) return null;

  const toggleApiKeyVisibility = (id: string) => {
    setShowApiKey((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleAddProvider = (provider: Omit<LLMProvider, 'id' | 'isCustom'>) => {
    addCustomProvider(provider);
    setIsAddingProvider(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'color-mix(in srgb, var(--aurora-common-shadow) 62%, transparent)' }}
    >
      <div
        className="flex h-[820px] w-[1220px] overflow-hidden rounded-[30px]"
        style={settingsShellStyle}
      >
        {/* Sidebar */}
        <div className="flex w-56 flex-col gap-1 border-r border-border p-3" style={settingsPaneStyle}>
          <div className="rounded-[20px] px-3 py-3" style={settingsCardStyle}>
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">Settings</div>
            <div className="mt-2 text-sm font-semibold text-text-primary">Aurora Preferences</div>
            <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
              Configure providers, tools, appearance, and local agent behavior.
            </p>
          </div>

          {[
            { id: 'providers', label: 'Providers', icon: Server },
            { id: 'mcp', label: 'MCP Servers', icon: Plug },
            { id: 'skills', label: 'Skills', icon: Sparkles },
            { id: 'semantic', label: 'Semantic Search', icon: Database },
            { id: 'themes', label: 'Appearance', icon: Palette },
            { id: 'tools', label: 'Tools', icon: Shield },
            { id: 'general', label: 'General', icon: Layout },
            { id: 'about', label: 'About', icon: Info },
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id as typeof activeTab)}
              className={clsx(
                "flex items-center gap-3 rounded-[16px] px-3 py-2.5 text-left text-xs transition-all",
                activeTab === id ? "text-primary font-semibold" : "text-text-secondary hover:text-text-primary"
              )}
              style={
                activeTab === id
                  ? {
                      backgroundColor: 'color-mix(in srgb, var(--aurora-common-primary) 12%, transparent)',
                      boxShadow: `
                        inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 6%, transparent),
                        0 8px 18px color-mix(in srgb, var(--aurora-common-shadow) 10%, transparent)
                      `,
                    }
                  : {
                      backgroundColor: 'transparent',
                    }
              }
            >
              <div
                className="flex h-8 w-8 items-center justify-center rounded-xl"
                style={{
                  backgroundColor: activeTab === id
                    ? 'color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)'
                    : 'color-mix(in srgb, var(--aurora-sidebar-background) 74%, transparent)',
                }}
              >
                <Icon className="w-3.5 h-3.5" />
              </div>
              <span>{label}</span>
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex min-w-0 flex-1 flex-col" style={settingsPaneStyle}>
          <div
            className="flex h-16 items-center justify-between border-b border-border px-6"
            style={{ backgroundColor: 'color-mix(in srgb, var(--aurora-sidebar-background) 68%, transparent)' }}
          >
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">Workspace Settings</div>
              <h2 className="mt-1 text-base font-semibold text-text-primary">
              {activeTab === 'providers' ? 'LLM Providers' :
                activeTab === 'mcp' ? 'MCP Servers' :
                  activeTab === 'skills' ? 'Skills' :
                  activeTab === 'semantic' ? 'Semantic Search' :
                    activeTab === 'themes' ? 'Appearance & Theme' :
                      activeTab === 'tools' ? 'Tool Settings' :
                        activeTab === 'about' ? 'About Aurora' :
                          'General Settings'}
              </h2>
            </div>
            <button
              onClick={() => setSettingsOpen(false)}
              className="rounded-xl p-2 text-text-secondary hover:text-text-primary"
              style={settingsInputStyle}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div
            className="flex-1 overflow-y-auto p-5 scrollbar-thin"
            style={{ scrollbarGutter: 'stable both-edges' }}
          >
            {/* PROVIDERS TAB */}
            {activeTab === 'providers' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between rounded-[20px] px-4 py-4" style={settingsCardStyle}>
                  <div>
                    <p className="text-sm font-semibold text-text-primary">Provider Stack</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
                      Expand a provider to edit endpoint, credentials, models, and output limits.
                    </p>
                  </div>
                  <button
                    onClick={() => setIsAddingProvider(true)}
                    className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-[11px] font-semibold text-primary-foreground transition-colors"
                    style={{
                      backgroundColor: 'var(--aurora-common-primary)',
                      boxShadow: '0 10px 24px color-mix(in srgb, var(--aurora-common-primary) 20%, transparent)',
                    }}
                  >
                    <Plus className="w-3 h-3" />
                    Add Provider
                  </button>
                </div>

                {isAddingProvider && (
                  <AddProviderForm
                    onSave={handleAddProvider}
                    onCancel={() => setIsAddingProvider(false)}
                  />
                )}

                <div className="space-y-2">
                  {providers.map((provider) => (
                    <ProviderCard
                      key={provider.id}
                      provider={provider}
                      isExpanded={expandedProvider === provider.id}
                      onToggleExpand={() => setExpandedProvider(
                        expandedProvider === provider.id ? null : provider.id
                      )}
                      showApiKey={showApiKey[provider.id] || false}
                      onToggleApiKey={() => toggleApiKeyVisibility(provider.id)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* MCP SERVERS TAB */}
            {activeTab === 'mcp' && <McpSettingsTab />}

            {/* SKILLS TAB */}
            {activeTab === 'skills' && <SkillsSettingsTab />}

            {/* SEMANTIC SEARCH TAB */}
            {activeTab === 'semantic' && <SemanticSettingsTab />}

            {/* TOOLS TAB */}
            {activeTab === 'tools' && <ToolSettingsTab />}

            {/* THEMES TAB */}
            {activeTab === 'themes' && <ThemeSettingsTab />}

            {/* GENERAL TAB */}
            {activeTab === 'general' && (
              <GeneralSettingsTab
                autoSave={autoSave}
                fontSize={fontSize}
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

            {/* ABOUT TAB */}
            {activeTab === 'about' && <AboutSettingsTab />}
          </div>
        </div>
      </div>
    </div>
  );
};
