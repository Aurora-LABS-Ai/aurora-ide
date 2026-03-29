import React from 'react';
import { clsx } from 'clsx';
import { ExternalLink, HardDrive, Loader2, Monitor, RefreshCw, Server, WifiOff } from 'lucide-react';
import type { LocalProvider } from '../../services/local-model-detector';
import type { ActiveConnection, DetectionPhase } from './local-provider-utils';
import { settingsCardStyle, settingsInputStyle } from '../modals/settings-shared';

interface Props {
  phase: DetectionPhase;
  allProviders: LocalProvider[];
  activeProviderIndex: number;
  activeConnection: ActiveConnection | null;
  onProviderSelect: (index: number) => void;
  onRescan: () => void;
}

export const LocalServerHeader: React.FC<Props> = ({
  phase, allProviders, activeProviderIndex, activeConnection, onProviderSelect, onRescan,
}) => (
  <div className="rounded-[20px] px-5 py-4" style={settingsCardStyle}>
    <div className="flex items-center justify-between">
      <div>
        <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
          <HardDrive className="w-4 h-4 text-primary" />
          Local AI Models
        </h3>
        <p className="mt-1 text-[11px] leading-relaxed text-text-secondary max-w-md">
          Run models privately on your machine with Ollama or LM Studio.
          Zero API keys required.
        </p>
      </div>
      <button
        onClick={onRescan}
        disabled={phase === 'scanning'}
        className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-[11px] font-semibold text-text-secondary hover:text-text-primary transition-colors"
        style={settingsInputStyle}
      >
        <RefreshCw className={clsx('w-3 h-3', phase === 'scanning' && 'animate-spin')} />
        {phase === 'scanning' ? 'Scanning...' : 'Rescan'}
      </button>
    </div>

    {phase === 'done' && (
      <div className="flex flex-wrap items-center gap-2 mt-3">
        {allProviders.map((p, i) => (
          <button
            key={`${p.type}-${p.baseUrl}`}
            onClick={() => onProviderSelect(i)}
            className={clsx(
              'inline-flex items-center gap-2 rounded-xl px-3 py-1.5 text-[11px] font-medium transition-all',
              activeProviderIndex === i ? 'ring-1 ring-primary/40' : 'opacity-70 hover:opacity-100',
            )}
            style={settingsInputStyle}
          >
            <span className={clsx(
              'w-2 h-2 rounded-full shrink-0',
              activeConnection?.type === p.type ? 'bg-success' : 'bg-primary',
            )} />
            {p.type === 'ollama' ? <Server size={11} /> : <Monitor size={11} />}
            {p.name}
            {p.version && <span className="text-text-disabled">v{p.version}</span>}
            <span className="text-text-disabled">{p.models.length} model{p.models.length !== 1 ? 's' : ''}</span>
          </button>
        ))}
        {allProviders.length === 0 && (
          <div className="flex items-center gap-2 text-[11px] text-text-disabled">
            <WifiOff size={12} />
            No local servers detected
            <span>&middot;</span>
            <a href="https://ollama.com/download" target="_blank" rel="noopener noreferrer"
              className="text-primary hover:text-primary-hover flex items-center gap-0.5">
              Ollama <ExternalLink size={9} />
            </a>
            <a href="https://lmstudio.ai" target="_blank" rel="noopener noreferrer"
              className="text-primary hover:text-primary-hover flex items-center gap-0.5">
              LM Studio <ExternalLink size={9} />
            </a>
          </div>
        )}
      </div>
    )}

    {phase === 'scanning' && allProviders.length === 0 && (
      <div className="flex items-center gap-2 mt-3 text-[11px] text-text-secondary">
        <Loader2 size={12} className="animate-spin text-primary" />
        Scanning localhost for Ollama and LM Studio...
      </div>
    )}
  </div>
);
