import React, { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { CheckCircle2, ExternalLink, Loader2, Monitor, RefreshCw, Server, WifiOff, Zap } from 'lucide-react';
import type { LocalModel, LocalProvider } from '../../services/local-model-detector';
import type { ActiveConnection, DetectionPhase } from './local-provider-utils';
import { modelToSelectOption } from './local-provider-utils';
import { SettingsSelect } from '../ui/SettingsSelect';
import { settingsPrimaryButtonStyle } from '../modals/settings-shared';

interface CompactPanelProps {
  allProviders: LocalProvider[];
  phase: DetectionPhase;
  onConnect: (provider: LocalProvider, model: LocalModel) => void;
  isConnecting: boolean;
  activeConnection: ActiveConnection | null;
  onRescan: () => void;
}

export const LocalCompactPanel: React.FC<CompactPanelProps> = ({
  allProviders, phase, onConnect, isConnecting, activeConnection, onRescan,
}) => {
  const firstProvider = allProviders[0];
  const [selectedModelId, setSelectedModelId] = useState(firstProvider?.models[0]?.id ?? '');

  useEffect(() => {
    if (firstProvider && !selectedModelId) {
      setSelectedModelId(firstProvider.models[0]?.id ?? '');
    }
  }, [firstProvider, selectedModelId]);

  if (phase === 'scanning') {
    return (
      <div className="flex flex-col items-center gap-3 text-center rounded-xl border border-border bg-editor p-6">
        <Loader2 className="w-6 h-6 text-primary animate-spin" />
        <p className="text-sm font-medium text-text-primary">Scanning for local servers...</p>
        <p className="text-[11px] text-text-secondary">Checking Ollama (11434) and LM Studio (1234)</p>
      </div>
    );
  }

  if (phase === 'done' && allProviders.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 text-center rounded-xl border border-border bg-editor p-6">
        <WifiOff className="w-6 h-6 text-text-secondary" />
        <p className="text-sm font-medium text-text-primary">No local servers detected</p>
        <p className="text-[11px] text-text-secondary mt-1">Start Ollama or LM Studio, then rescan.</p>
        <div className="flex items-center gap-3 mt-2">
          <a href="https://ollama.com/download" target="_blank" rel="noopener noreferrer"
            className="text-[11px] text-primary hover:text-primary-hover transition-colors flex items-center gap-1">
            Install Ollama <ExternalLink size={10} />
          </a>
          <span className="text-text-disabled text-[11px]">&middot;</span>
          <a href="https://lmstudio.ai" target="_blank" rel="noopener noreferrer"
            className="text-[11px] text-primary hover:text-primary-hover transition-colors flex items-center gap-1">
            Install LM Studio <ExternalLink size={10} />
          </a>
        </div>
        <button onClick={onRescan} className="mt-2 text-[11px] text-primary hover:text-primary-hover flex items-center gap-1">
          <RefreshCw size={10} /> Rescan
        </button>
      </div>
    );
  }

  if (!firstProvider) return null;

  const options = firstProvider.models.map(modelToSelectOption);
  const selectedModel = firstProvider.models.find((m) => m.id === selectedModelId);
  const isConnected = activeConnection?.type === firstProvider.type;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[11px] text-text-secondary">
        {firstProvider.type === 'ollama' ? <Server size={12} /> : <Monitor size={12} />}
        <span className="font-medium">{firstProvider.name}</span>
        {firstProvider.version && <span className="text-text-disabled">v{firstProvider.version}</span>}
        <span className="ml-auto text-text-disabled">
          {firstProvider.models.length} model{firstProvider.models.length !== 1 ? 's' : ''}
        </span>
      </div>

      <SettingsSelect
        options={options}
        value={selectedModelId}
        onChange={(v) => setSelectedModelId(String(v))}
        placeholder="Select a model"
        ariaLabel="Local model selection"
      />

      <button
        onClick={() => { if (selectedModel) onConnect(firstProvider, selectedModel); }}
        disabled={!selectedModel || isConnecting}
        className={clsx(
          'w-full py-2.5 rounded-xl text-xs font-semibold transition-colors flex items-center justify-center gap-1.5',
          isConnected
            ? 'bg-success/10 text-success border border-success/30 hover:bg-success/20'
            : 'text-primary-foreground hover:bg-primary-hover disabled:opacity-50',
        )}
        style={!isConnected ? settingsPrimaryButtonStyle : undefined}
      >
        {isConnecting ? <><Loader2 size={12} className="animate-spin" /> Connecting...</>
          : isConnected ? <><CheckCircle2 size={12} /> Connected</>
          : <><Zap size={12} /> Connect</>}
      </button>
    </div>
  );
};
