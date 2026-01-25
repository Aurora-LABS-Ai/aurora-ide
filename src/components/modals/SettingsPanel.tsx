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

import React, { useEffect, useState } from 'react';
import { useUiStore } from '../../store/useUiStore';
import { useSettingsStore, type LLMProvider } from '../../store/useSettingsStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useCheckpointStore } from '../../store/useCheckpointStore';
import { X, Server, Layout, Shield, Eye, EyeOff, Plus, Trash2, ChevronDown, Palette, Database, Plug, Terminal, CheckCircle2, AlertCircle, History, Info, Sparkles, BookOpen, Wrench, Heart } from 'lucide-react';
import clsx from 'clsx';
import { ToolSettingsTab } from './ToolSettingsTab';
import { ThemeSettingsTab } from './ThemeSettingsTab';
import { SemanticSettingsTab } from './SemanticSettingsTab';
import { McpSettingsTab } from './McpSettingsTab';
import { installAuroraCli, uninstallAuroraCli, isAuroraCliInstalled, isTauri } from '../../lib/tauri';
import { TogglePill } from '../ui/TogglePill';

const UI_FONT_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'inter', label: 'Inter' },
  { value: 'segoe', label: 'Segoe UI' },
  { value: 'roboto', label: 'Roboto' },
];

// ============================================
// CHECKPOINT SETTINGS COMPONENT
// ============================================

const CheckpointSettings: React.FC = () => {
  const { rootPath } = useWorkspaceStore();
  const { enabled, setEnabled } = useCheckpointStore();

  if (!rootPath) {
    return (
      <div className="p-3 border border-border rounded-lg bg-titlebar">
        <div className="flex items-center gap-2 mb-2">
          <History className="w-3.5 h-3.5 text-checkpoint" />
          <h3 className="text-xs font-medium text-text-primary">Checkpoints</h3>
        </div>
        <p className="text-[10px] text-text-disabled">
          Open a workspace to configure checkpoint settings.
        </p>
      </div>
    );
  }

  const workspaceName = rootPath.split(/[/\\]/).pop() || rootPath;

  return (
    <div className="p-3 border border-border rounded-lg bg-titlebar">
      <div className="flex items-center gap-2 mb-2">
        <History className="w-3.5 h-3.5 text-checkpoint" />
        <h3 className="text-xs font-medium text-text-primary">Checkpoints</h3>
      </div>
      <p className="text-[10px] text-text-secondary mb-3">
        Checkpoints capture the state of your workspace files before each message.
        You can restore to any checkpoint to undo AI changes.
      </p>

      <div className="flex items-center justify-between">
        <div>
          <p className="text-[10px] text-text-secondary">Enable for this workspace</p>
          <p className="text-[9px] text-text-disabled truncate max-w-[200px]" title={rootPath}>
            {workspaceName}
          </p>
        </div>
        <TogglePill
          checked={enabled}
          onChange={setEnabled}
          ariaLabel="Toggle checkpoints"
          variant="checkpoint"
          size="sm"
        />
      </div>

      {enabled && (
        <div className="mt-2 p-2 bg-checkpoint/10 rounded border border-checkpoint/20">
          <p className="text-[9px] text-checkpoint-foreground">
            Checkpoints are saved when you send messages. Hover over a user message to see the checkpoint indicator.
          </p>
        </div>
      )}
    </div>
  );
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
    uiFontFamily,
    uiScale,
    setUiFontFamily,
    setUiScale,
  } = useSettingsStore();

  // Note: Thinking, temperature, and maxTokens are now per-provider settings
  // Each provider has its own supportsThinking, defaultTemperature, and defaultMaxTokens

  // Each provider has its own supportsThinking, defaultTemperature, and defaultMaxTokens

  const [activeTab, setActiveTab] = useState<'providers' | 'tools' | 'general' | 'themes' | 'semantic' | 'mcp' | 'about'>('providers');
  const [showApiKey, setShowApiKey] = useState<Record<string, boolean>>({});
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [isAddingProvider, setIsAddingProvider] = useState(false);
  
  // CLI installation state
  const [cliStatus, setCliStatus] = useState<'idle' | 'installing' | 'uninstalling' | 'success' | 'error'>('idle');
  const [cliMessage, setCliMessage] = useState<string>('');
  const [cliInstalled, setCliInstalled] = useState<boolean | null>(null);
  const [isCheckingCli, setIsCheckingCli] = useState(false);

  useEffect(() => {
    if (!isSettingsOpen || !isTauri()) {
      return;
    }

    let isActive = true;
    setIsCheckingCli(true);
    isAuroraCliInstalled()
      .then((installed) => {
        if (!isActive) return;
        setCliInstalled(installed);
      })
      .catch(() => {
        if (!isActive) return;
        setCliInstalled(null);
      })
      .finally(() => {
        if (!isActive) return;
        setIsCheckingCli(false);
      });

    return () => {
      isActive = false;
    };
  }, [isSettingsOpen]);

  const handleInstallCli = async () => {
    if (!isTauri()) {
      setCliStatus('error');
      setCliMessage('CLI installation requires the desktop app');
      return;
    }
    
    setCliStatus('installing');
    setCliMessage('Installing Aurora CLI...');
    
    try {
      const result = await installAuroraCli();
      setCliStatus('success');
      setCliMessage(result || 'Aurora CLI installed! Restart your terminal to use "aurora ." command.');
      setCliInstalled(true);
    } catch (error) {
      setCliStatus('error');
      setCliMessage(error instanceof Error ? error.message : 'Failed to install CLI');
    }
  };

  const handleUninstallCli = async () => {
    if (!isTauri()) return;
    
    setCliStatus('uninstalling');
    setCliMessage('Uninstalling Aurora CLI...');
    
    try {
      const result = await uninstallAuroraCli();
      setCliStatus('success');
      setCliMessage(result || 'Aurora CLI uninstalled successfully.');
      setCliInstalled(false);
    } catch (error) {
      setCliStatus('error');
      setCliMessage(error instanceof Error ? error.message : 'Failed to uninstall CLI');
    }
  };

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
            { id: 'mcp', label: 'MCP Servers', icon: Plug },
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
                activeTab === 'mcp' ? 'MCP Servers' :
                  activeTab === 'semantic' ? 'Semantic Search' :
                    activeTab === 'themes' ? 'Appearance & Theme' :
                      activeTab === 'tools' ? 'Tool Settings' :
                        activeTab === 'about' ? 'About Aurora' :
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

            {/* MCP SERVERS TAB */}
            {activeTab === 'mcp' && <McpSettingsTab />}

            {/* SEMANTIC SEARCH TAB */}
            {activeTab === 'semantic' && <SemanticSettingsTab />}

            {/* TOOLS TAB */}
            {activeTab === 'tools' && <ToolSettingsTab />}

            {/* THEMES TAB */}
            {activeTab === 'themes' && <ThemeSettingsTab />}

            {/* GENERAL TAB */}
            {activeTab === 'general' && (
              <div className="space-y-3">
                {/* CLI Installation Section */}
                <div className="p-3 border border-border rounded-lg bg-titlebar">
                  <div className="flex items-center gap-2 mb-2">
                    <Terminal className="w-3.5 h-3.5 text-primary" />
                    <h3 className="text-xs font-medium text-text-primary">Command Line</h3>
                  </div>
                  <p className="text-[10px] text-text-secondary mb-3">
                    Install the <code className="px-1 py-0.5 bg-input rounded text-primary">aurora</code> command to open Aurora from any terminal, like VS Code's <code className="px-1 py-0.5 bg-input rounded">code .</code> command.
                  </p>
                  
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      {cliInstalled ? (
                        <button
                          onClick={handleUninstallCli}
                          disabled={cliStatus === 'installing' || cliStatus === 'uninstalling' || isCheckingCli}
                          className={clsx(
                            "flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-medium rounded transition-colors",
                            cliStatus === 'installing' || cliStatus === 'uninstalling' || isCheckingCli
                              ? "bg-input text-text-disabled cursor-not-allowed"
                              : "text-text-secondary hover:bg-input hover:text-text-primary border border-border"
                          )}
                        >
                          {cliStatus === 'uninstalling' ? 'Uninstalling...' : 'Uninstall'}
                        </button>
                      ) : (
                        <button
                          onClick={handleInstallCli}
                          disabled={cliStatus === 'installing' || cliStatus === 'uninstalling' || isCheckingCli}
                          className={clsx(
                            "flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-medium rounded transition-colors",
                            cliStatus === 'installing' || cliStatus === 'uninstalling' || isCheckingCli
                              ? "bg-input text-text-disabled cursor-not-allowed"
                              : "bg-primary text-white hover:bg-primary/80"
                          )}
                        >
                          {cliStatus === 'installing' || isCheckingCli ? (
                            <>
                              <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                              {isCheckingCli ? 'Checking...' : 'Installing...'}
                            </>
                          ) : (
                            <>
                              <Terminal className="w-3 h-3" />
                              Install CLI
                            </>
                          )}
                        </button>
                      )}
                    </div>
                    
                    {/* Status message */}
                    {cliMessage && (
                      <div className={clsx(
                        "flex items-start gap-2 p-2 rounded text-[10px]",
                        cliStatus === 'success' && "bg-success/10 text-success",
                        cliStatus === 'error' && "bg-danger/10 text-danger",
                        (cliStatus === 'installing' || cliStatus === 'uninstalling') && "bg-primary/10 text-primary"
                      )}>
                        {cliStatus === 'success' && <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
                        {cliStatus === 'error' && <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
                        <span className="whitespace-pre-wrap">{cliMessage}</span>
                      </div>
                    )}
                    
                    <div className="mt-1 p-2 bg-input/50 rounded border border-border">
                      <p className="text-[9px] text-text-disabled font-mono">
                        Usage examples:
                      </p>
                      <div className="mt-1 space-y-0.5 text-[9px] font-mono text-text-secondary">
                        <p><span className="text-primary">aurora .</span> - Open current folder</p>
                        <p><span className="text-primary">aurora /path/to/project</span> - Open specific folder</p>
                        <p><span className="text-primary">aurora file.ts</span> - Open a file</p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Interface Settings Section */}
                <div className="p-3 border border-border rounded-lg bg-titlebar">
                  <h3 className="text-xs font-medium text-text-primary mb-2">Interface</h3>
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <label className="text-[10px] text-text-secondary">UI Font</label>
                      <select
                        value={uiFontFamily}
                        onChange={(e) => setUiFontFamily(e.target.value)}
                        className="bg-input border border-input-border rounded px-2 py-1 text-[10px] text-text-primary"
                      >
                        {UI_FONT_OPTIONS.map(option => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-[10px] text-text-secondary">UI Scale</p>
                        <p className="text-[9px] text-text-disabled">Resize text and UI density</p>
                      </div>
                      <span className="text-[10px] font-mono text-primary">
                        {Math.round(uiScale * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0.9"
                      max="1.3"
                      step="0.05"
                      value={uiScale}
                      onChange={(e) => setUiScale(parseFloat(e.target.value))}
                      className="w-full h-1 bg-input-border rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
                    />
                  </div>
                </div>

                {/* Editor Settings Section */}
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
                      <TogglePill
                        checked={wrapMode}
                        onChange={setWrapMode}
                        ariaLabel="Toggle auto line wrap"
                        variant="primary"
                        size="sm"
                      />
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

                {/* Checkpoint Settings Section */}
                <CheckpointSettings />
              </div>
            )}

            {/* ABOUT TAB */}
            {activeTab === 'about' && (
              <div className="space-y-4">
                {/* Hero Section */}
                <div className="p-6 border border-border rounded-lg bg-titlebar text-center">
                  <h1 className="text-3xl font-bold mb-2" style={{ fontFamily: 'Georgia, serif' }}>
                    Aurora
                  </h1>
                  <p className="text-sm mb-4" style={{ fontFamily: 'Georgia, serif', fontStyle: 'italic' }}>
                    AI-Powered Agentic Code Editor
                  </p>
                  <div className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-primary/20 text-primary text-xs font-medium">
                    <Heart className="w-3 h-3" />
                    Made with Love for the Agent World
                  </div>
                </div>

                {/* Author Section */}
                <div className="p-4 border border-border rounded-lg bg-titlebar">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-12 h-12 rounded-full bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center text-white text-xl font-bold" style={{ fontFamily: 'Georgia, serif' }}>
                      A
                    </div>
                    <div>
                      <h3 className="text-lg font-bold" style={{ fontFamily: 'Georgia, serif' }}>
                        Alvan
                      </h3>
                      <p className="text-xs text-text-secondary" style={{ fontFamily: 'monospace' }}>
                        Creator & Developer
                      </p>
                    </div>
                  </div>
                  <p className="text-sm text-text-secondary" style={{ fontFamily: 'Georgia, serif' }}>
                    This project is developed by <span className="font-bold text-primary">Alvan</span> with passion for building tools that empower developers in the age of AI agents.
                  </p>
                </div>

                {/* Mission Section */}
                <div className="p-4 border border-border rounded-lg bg-titlebar">
                  <h3 className="text-sm font-bold mb-2" style={{ fontFamily: 'Georgia, serif' }}>
                    Our Mission
                  </h3>
                  <p className="text-sm text-text-secondary mb-3" style={{ fontFamily: 'Georgia, serif' }}>
                    Aurora is a free, open-source code editor designed for the agentic world. We believe in building tools that enhance developer productivity while maintaining the freedom to innovate.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-success/20 text-success text-xs font-medium" style={{ fontFamily: 'monospace' }}>
                      <Sparkles className="w-3 h-3" />
                      Free for Everyone
                    </div>
                    <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-primary/20 text-primary text-xs font-medium" style={{ fontFamily: 'monospace' }}>
                      <BookOpen className="w-3 h-3" />
                      Open Source
                    </div>
                    <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-info/20 text-info text-xs font-medium" style={{ fontFamily: 'monospace' }}>
                      <Wrench className="w-3 h-3" />
                      Community Driven
                    </div>
                  </div>
                </div>

                {/* Features Section */}
                <div className="p-4 border border-border rounded-lg bg-titlebar">
                  <h3 className="text-sm font-bold mb-3" style={{ fontFamily: 'Georgia, serif' }}>
                    Key Features
                  </h3>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex items-start gap-2">
                      <span className="text-primary mt-0.5" style={{ fontFamily: 'monospace' }}>▸</span>
                      <div>
                        <p className="text-xs font-medium text-text-primary" style={{ fontFamily: 'Georgia, serif' }}>
                          AI-Native Design
                        </p>
                        <p className="text-[10px] text-text-secondary">
                          Built from the ground up for AI agents
                        </p>
                      </div>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="text-primary mt-0.5" style={{ fontFamily: 'monospace' }}>▸</span>
                      <div>
                        <p className="text-xs font-medium text-text-primary" style={{ fontFamily: 'Georgia, serif' }}>
                          MCP Support
                        </p>
                        <p className="text-[10px] text-text-secondary">
                          Extensible via Model Context Protocol
                        </p>
                      </div>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="text-primary mt-0.5" style={{ fontFamily: 'monospace' }}>▸</span>
                      <div>
                        <p className="text-xs font-medium text-text-primary" style={{ fontFamily: 'Georgia, serif' }}>
                          Git Integration
                        </p>
                        <p className="text-[10px] text-text-secondary">
                          Full Git operations built-in
                        </p>
                      </div>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="text-primary mt-0.5" style={{ fontFamily: 'monospace' }}>▸</span>
                      <div>
                        <p className="text-xs font-medium text-text-primary" style={{ fontFamily: 'Georgia, serif' }}>
                          Beautiful Themes
                        </p>
                        <p className="text-[10px] text-text-secondary">
                          VS Code-inspired with 50+ tokens
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Version Info */}
                <div className="p-4 border border-border rounded-lg bg-titlebar">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-text-secondary" style={{ fontFamily: 'monospace' }}>
                      Version 0.1.1
                    </span>
                    <span className="text-text-secondary" style={{ fontFamily: 'monospace' }}>
                      © 2025 Alvan
                    </span>
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
