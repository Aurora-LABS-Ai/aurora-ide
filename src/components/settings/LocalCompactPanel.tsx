import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  ExternalLink,
  Loader2,
  Monitor,
  RefreshCw,
  Server,
  WifiOff,
  Zap,
} from 'lucide-react';
import type { LocalModel, LocalProvider } from '../../services/local-model-detector';
import type { ActiveConnection, DetectionPhase } from './local-provider-utils';
import { modelToSelectOption } from './local-provider-utils';
import { IdeSelect } from '../ui/IdeSelect';
import { ActionButton } from '../modals/settings-primitives';

interface CompactPanelProps {
  allProviders: LocalProvider[];
  phase: DetectionPhase;
  onConnect: (provider: LocalProvider, model: LocalModel) => void;
  isConnecting: boolean;
  activeConnection: ActiveConnection | null;
  onRescan: () => void;
}

const linkButtonStyle: React.CSSProperties = {
  color: 'var(--aurora-common-primary)',
};

export const LocalCompactPanel: React.FC<CompactPanelProps> = ({
  allProviders,
  phase,
  onConnect,
  isConnecting,
  activeConnection,
  onRescan,
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
      <div
        className="flex flex-col items-center gap-3 p-6 text-center"
        style={{
          backgroundColor:
            'color-mix(in srgb, var(--aurora-editor-background) 60%, var(--aurora-sidebar-background) 40%)',
          border: '1px solid color-mix(in srgb, var(--aurora-common-border) 60%, transparent)',
          borderRadius: 8,
        }}
      >
        <Loader2
          className="h-5 w-5 animate-spin"
          style={{ color: 'var(--aurora-common-primary)' }}
        />
        <p className="text-[12.5px] font-medium text-text-primary">
          Scanning for local servers…
        </p>
        <p className="text-[11px] text-text-secondary">
          Checking Ollama (11434) and LM Studio (1234)
        </p>
      </div>
    );
  }

  if (phase === 'done' && allProviders.length === 0) {
    return (
      <div
        className="flex flex-col items-center gap-3 p-6 text-center"
        style={{
          backgroundColor:
            'color-mix(in srgb, var(--aurora-editor-background) 60%, var(--aurora-sidebar-background) 40%)',
          border: '1px solid color-mix(in srgb, var(--aurora-common-border) 60%, transparent)',
          borderRadius: 8,
        }}
      >
        <WifiOff className="h-5 w-5 text-text-secondary" />
        <p className="text-[12.5px] font-medium text-text-primary">
          No local servers detected
        </p>
        <p className="text-[11px] text-text-secondary">
          Start Ollama or LM Studio, then rescan.
        </p>
        <div className="flex items-center gap-3">
          <a
            href="https://ollama.com/download"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] hover:underline"
            style={linkButtonStyle}
          >
            Install Ollama <ExternalLink size={10} />
          </a>
          <span className="text-[11px] text-text-disabled">·</span>
          <a
            href="https://lmstudio.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] hover:underline"
            style={linkButtonStyle}
          >
            Install LM Studio <ExternalLink size={10} />
          </a>
        </div>
        <ActionButton
          variant="secondary"
          icon={<RefreshCw className="h-3 w-3" />}
          onClick={onRescan}
        >
          Rescan
        </ActionButton>
      </div>
    );
  }

  if (!firstProvider) return null;

  const options = firstProvider.models.map(modelToSelectOption);
  const selectedModel = firstProvider.models.find((model) => model.id === selectedModelId);
  const isConnected = activeConnection?.type === firstProvider.type;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2 text-[11px] text-text-secondary">
        {firstProvider.type === 'ollama' ? <Server size={12} /> : <Monitor size={12} />}
        <span className="font-medium">{firstProvider.name}</span>
        {firstProvider.version && (
          <span className="text-text-disabled">v{firstProvider.version}</span>
        )}
        <span className="ml-auto text-text-disabled">
          {firstProvider.models.length} model
          {firstProvider.models.length === 1 ? '' : 's'}
        </span>
      </div>

      <IdeSelect
        options={options}
        value={selectedModelId}
        onChange={(value) => setSelectedModelId(String(value))}
        placeholder="Select a model"
        ariaLabel="Local model selection"
      />

      {isConnected ? (
        <div
          className="flex w-full items-center justify-center gap-1.5 px-3 py-1.5 text-[11.5px] font-semibold"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--aurora-common-success) 12%, transparent)',
            color: 'var(--aurora-common-success)',
            border:
              '1px solid color-mix(in srgb, var(--aurora-common-success) 30%, transparent)',
            borderRadius: 6,
          }}
        >
          <CheckCircle2 size={12} /> Connected
        </div>
      ) : (
        <ActionButton
          variant="primary"
          className="!w-full !justify-center"
          icon={
            isConnecting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Zap className="h-3 w-3" />
            )
          }
          disabled={!selectedModel || isConnecting}
          onClick={() => {
            if (selectedModel) onConnect(firstProvider, selectedModel);
          }}
        >
          {isConnecting ? 'Connecting…' : 'Connect'}
        </ActionButton>
      )}
    </div>
  );
};
