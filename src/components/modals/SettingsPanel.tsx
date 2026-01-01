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
import { X, Server, Layout, Shield, Eye, EyeOff, Plus, Trash2, ChevronDown, Palette, Database } from 'lucide-react';
import clsx from 'clsx';
import { ToolSettingsTab } from './ToolSettingsTab';
import { ThemeSettingsTab } from './ThemeSettingsTab';
import { SemanticSettingsTab } from './SemanticSettingsTab';

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
    <div className="p-3 border border-primary/30 rounded-lg bg-primary/5 space-y-2">
      <h3 className="text-xs font-medium text-text-primary">Add Custom Provider</h3>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] text-text-secondary block mb-0.5">Name *</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Local LLM"
            className="w-full bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-primary"
          />
        </div>
        <div>
          <label className="text-[10px] text-text-secondary block mb-0.5">API Format *</label>
          <select
            value={providerType}
            onChange={(e) => setProviderType(e.target.value as 'openai' | 'anthropic' | 'custom')}
            className="w-full bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:border-primary"
          >
            <option value="openai">OpenAI Compatible</option>
            <option value="anthropic">Anthropic Compatible</option>
            <option value="custom">Custom (OpenAI-like)</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] text-text-secondary block mb-0.5">Model *</label>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="llama3.2"
            className="w-full bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-primary"
          />
        </div>
        <div>
          <label className="text-[10px] text-text-secondary block mb-0.5">Context Window</label>
          <input
            type="number"
            value={contextWindow}
            onChange={(e) => setContextWindow(parseInt(e.target.value) || 200000)}
            placeholder="200000"
            className="w-full bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-primary"
          />
        </div>
      </div>

      <div>
        <label className="text-[10px] text-text-secondary block mb-0.5">Base URL *</label>
        <input
          type="text"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://localhost:11434/v1"
          className="w-full bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-primary"
        />
      </div>

      <div>
        <label className="text-[10px] text-text-secondary block mb-0.5">API Key (optional)</label>
        <div className="flex gap-1">
          <input
            type={showApiKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Leave empty for local"
            className="flex-1 bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-primary"
          />
          <button
            onClick={() => setShowApiKey(!showApiKey)}
            className="p-1.5 rounded bg-input border border-input-border text-text-secondary hover:text-text-primary"
          >
            {showApiKey ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
          </button>
        </div>
      </div>

      <div>
        <label className="text-[10px] text-text-secondary block mb-0.5">Max Output Tokens</label>
        <input
          type="number"
          value={maxOutputTokens}
          onChange={(e) => setMaxOutputTokens(parseInt(e.target.value) || 8192)}
          placeholder="8192"
          className="w-full bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-primary"
        />
      </div>

      <div className="flex items-center gap-2">
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
        <button onClick={onCancel} className="px-3 py-1 text-xs text-text-secondary hover:text-text-primary">
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!name.trim() || !baseUrl.trim() || !model.trim()}
          className="px-3 py-1 text-xs font-medium text-white bg-primary hover:bg-primary/80 rounded transition-colors disabled:opacity-50"
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
    <div className="border border-border rounded-lg bg-titlebar overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-input/30"
        onClick={onToggleExpand}
      >
        <div className="flex items-center gap-2">
          <ChevronDown className={clsx("w-3.5 h-3.5 text-text-disabled transition-transform", isExpanded && "rotate-180")} />
          <span className="text-xs font-medium text-text-primary">{provider.name}</span>
          {provider.isCustom && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-primary/20 text-primary">Custom</span>
          )}
          {isReady && provider.enabled && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-success/20 text-success">Ready</span>
          )}
          {!isReady && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-warning/20 text-warning">No Key</span>
          )}
        </div>
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {provider.isCustom && (
            <button
              onClick={() => deleteProvider(provider.id)}
              className="p-1 rounded text-text-disabled hover:text-danger hover:bg-danger/10"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={() => updateProvider(provider.id, { enabled: !provider.enabled })}
            className={clsx(
              "relative w-8 h-4 rounded-full transition-colors",
              provider.enabled ? "bg-primary" : "bg-input border border-border"
            )}
          >
            <div className={clsx(
              "absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform",
              provider.enabled ? "translate-x-4" : "translate-x-0.5"
            )} />
          </button>
        </div>
      </div>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="px-3 pb-3 pt-1 border-t border-border space-y-2">
          {/* API Format (only for custom providers) */}
          {provider.isCustom && (
            <div>
              <label className="text-[10px] text-text-disabled block mb-0.5">API Format</label>
              <select
                value={provider.providerType || 'openai'}
                onChange={(e) => updateProvider(provider.id, { providerType: e.target.value as LLMProvider['providerType'] })}
                className="w-full bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:border-primary"
              >
                <option value="openai">OpenAI Compatible</option>
                <option value="anthropic">Anthropic Compatible</option>
                <option value="custom">Custom (OpenAI-like)</option>
              </select>
            </div>
          )}

          {/* Base URL */}
          <div>
            <label className="text-[10px] text-text-disabled block mb-0.5">Base URL</label>
            <input
              type="text"
              value={provider.baseUrl}
              onChange={(e) => updateProvider(provider.id, { baseUrl: e.target.value.trim() })}
              className="w-full bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary font-mono focus:outline-none focus:border-primary"
            />
          </div>

          {/* API Key */}
          <div>
            <label className="text-[10px] text-text-disabled block mb-0.5">
              API Key {isLocal && '(optional)'}
            </label>
            <div className="flex gap-1">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={provider.apiKey}
                onChange={(e) => updateProvider(provider.id, { apiKey: e.target.value })}
                placeholder={isLocal ? 'Not required' : 'Enter API key...'}
                className="flex-1 bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-primary"
              />
              <button
                onClick={onToggleApiKey}
                className="p-1.5 rounded bg-input border border-input-border text-text-secondary hover:text-text-primary"
              >
                {showApiKey ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              </button>
            </div>
          </div>

          {/* Context Window & Max Output */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-text-disabled block mb-0.5">Context Window</label>
              <input
                type="number"
                value={provider.contextWindow}
                onChange={(e) => updateProvider(provider.id, { contextWindow: parseInt(e.target.value) || 32000 })}
                className="w-full bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary font-mono focus:outline-none focus:border-primary"
              />
            </div>
            <div>
              <label className="text-[10px] text-text-disabled block mb-0.5">Max Output Tokens</label>
              <input
                type="number"
                value={provider.maxOutputTokens}
                onChange={(e) => updateProvider(provider.id, { maxOutputTokens: parseInt(e.target.value) || 4096 })}
                className="w-full bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary font-mono focus:outline-none focus:border-primary"
              />
            </div>
          </div>

          {/* Supports Thinking */}
          <div className="flex items-center gap-2">
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
            <label className="text-[10px] text-text-disabled block mb-0.5">Add Model ID</label>
            <div className="flex gap-1">
              <input
                type="text"
                value={newModelId}
                onChange={(e) => setNewModelId(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddModel()}
                placeholder="e.g. gpt-4-turbo, llama3.2:70b"
                className="flex-1 bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary placeholder:text-text-disabled font-mono focus:outline-none focus:border-primary"
              />
              <button
                onClick={handleAddModel}
                disabled={!newModelId.trim()}
                className="px-2 py-1.5 rounded bg-primary text-white text-xs font-medium hover:bg-primary/80 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Plus className="w-3 h-3" />
              </button>
            </div>
          </div>

          {/* Models List */}
          <div>
            <label className="text-[10px] text-text-disabled block mb-1">Available Models</label>
            <div className="flex flex-wrap gap-1">
              {(provider.customModels || [provider.model]).map((model) => (
                <span
                  key={model}
                  className="group flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-input text-text-secondary font-mono border border-border hover:border-primary/50"
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
  } = useSettingsStore();

  // Note: Thinking, temperature, and maxTokens are now per-provider settings
  // Each provider has its own supportsThinking, defaultTemperature, and defaultMaxTokens

  // Each provider has its own supportsThinking, defaultTemperature, and defaultMaxTokens

  const [activeTab, setActiveTab] = useState<'providers' | 'tools' | 'general' | 'themes' | 'semantic'>('providers');
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
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-editor border border-border rounded-xl shadow-2xl w-[910px] h-[650px] flex overflow-hidden">
        {/* Sidebar */}
        <div className="w-40 border-r border-border bg-sidebar p-2 flex flex-col gap-0.5">
          <div className="px-2 py-1.5 text-[10px] font-semibold text-text-disabled uppercase tracking-wider">Settings</div>

          {[
            { id: 'providers', label: 'Providers', icon: Server },
            { id: 'semantic', label: 'Semantic Search', icon: Database },
            { id: 'themes', label: 'Appearance', icon: Palette },
            { id: 'tools', label: 'Tools', icon: Shield },
            { id: 'general', label: 'General', icon: Layout },
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id as typeof activeTab)}
              className={clsx(
                "flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors text-left",
                activeTab === id ? "bg-primary/10 text-primary font-medium" : "text-text-secondary hover:bg-input/50 hover:text-text-primary"
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="h-10 border-b border-border flex items-center justify-between px-4 bg-sidebar">
            <h2 className="text-xs font-medium text-text-primary">
              {activeTab === 'providers' ? 'LLM Providers' :
                activeTab === 'semantic' ? 'Semantic Search' :
                  activeTab === 'themes' ? 'Appearance & Theme' :
                    activeTab === 'tools' ? 'Tool Settings' :
                      'General Settings'}
            </h2>
            <button
              onClick={() => setSettingsOpen(false)}
              className="p-1 rounded text-text-secondary hover:bg-input hover:text-text-primary"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 bg-sidebar scrollbar-thin">
            {/* PROVIDERS TAB */}
            {activeTab === 'providers' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] text-text-secondary">
                    Click provider to expand and edit Base URL, API Key, Models
                  </p>
                  <button
                    onClick={() => setIsAddingProvider(true)}
                    className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-white bg-primary hover:bg-primary/80 rounded transition-colors"
                  >
                    <Plus className="w-3 h-3" />
                    Add
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

            {/* SEMANTIC SEARCH TAB */}
            {activeTab === 'semantic' && <SemanticSettingsTab />}

            {/* TOOLS TAB */}
            {activeTab === 'tools' && <ToolSettingsTab />}

            {/* THEMES TAB */}
            {activeTab === 'themes' && <ThemeSettingsTab />}

            {/* GENERAL TAB */}
            {activeTab === 'general' && (
              <div className="space-y-3">
                <div className="p-3 border border-border rounded-lg bg-titlebar">
                  <h3 className="text-xs font-medium text-text-primary mb-2">Editor</h3>
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <label className="text-[10px] text-text-secondary">Font Size</label>
                      <select
                        value={fontSize}
                        onChange={(e) => setFontSize(Number(e.target.value))}
                        className="bg-input border border-input-border rounded px-2 py-1 text-[10px] text-text-primary"
                      >
                        {[12, 14, 16, 18].map(s => <option key={s} value={s}>{s}px</option>)}
                      </select>
                    </div>
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-[10px] text-text-secondary">Auto line wrap</p>
                        <p className="text-[9px] text-text-disabled">Controls wrapping in editors and previews</p>
                      </div>
                      <button
                        onClick={() => setWrapMode(!wrapMode)}
                        className={clsx(
                          "relative w-9 h-4 rounded-full transition-all duration-200 flex-shrink-0 overflow-hidden",
                          wrapMode ? "bg-primary shadow-[0_0_8px_rgba(99,102,241,0.35)]" : "bg-input border border-border"
                        )}
                        aria-pressed={wrapMode}
                        aria-label="Toggle auto line wrap"
                      >
                        <span
                          className={clsx(
                            "absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform duration-200",
                            wrapMode ? "translate-x-4" : "translate-x-0"
                          )}
                        />
                      </button>
                    </div>
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-[10px] text-text-secondary">Auto Save</p>
                        <p className="text-[9px] text-text-disabled">Automatically save files</p>
                      </div>
                      <select
                        value={autoSave}
                        onChange={(e) => setAutoSave(e.target.value as 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange')}
                        className="bg-input border border-input-border rounded px-2 py-1 text-[10px] text-text-primary"
                      >
                        <option value="off">Off</option>
                        <option value="afterDelay">After Delay (1s)</option>
                        <option value="onFocusChange">On Focus Change</option>
                        <option value="onWindowChange">On Window Change</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
