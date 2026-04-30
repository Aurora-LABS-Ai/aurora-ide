import React from 'react';
import { clsx } from 'clsx';
import {
  ExternalLink,
  HardDrive,
  Loader2,
  Monitor,
  RefreshCw,
  Server,
  WifiOff,
} from 'lucide-react';
import type { LocalProvider } from '../../services/local-model-detector';
import type { ActiveConnection, DetectionPhase } from './local-provider-utils';
import { Section, ActionButton, StatusPill } from '../modals/settings-primitives';

interface Props {
  phase: DetectionPhase;
  allProviders: LocalProvider[];
  activeProviderIndex: number;
  activeConnection: ActiveConnection | null;
  onProviderSelect: (index: number) => void;
  onRescan: () => void;
}

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

export const LocalServerHeader: React.FC<Props> = ({
  phase,
  allProviders,
  activeProviderIndex,
  activeConnection,
  onProviderSelect,
  onRescan,
}) => (
  <Section
    title="Local AI Models"
    description="Run models privately on your machine with Ollama or LM Studio. Zero API keys required."
    icon={<HardDrive className="h-3.5 w-3.5 text-text-secondary" />}
    badge={
      <ActionButton
        variant="secondary"
        icon={
          <RefreshCw
            className={clsx('h-3 w-3', phase === 'scanning' && 'animate-spin')}
          />
        }
        onClick={onRescan}
        disabled={phase === 'scanning'}
      >
        {phase === 'scanning' ? 'Scanning…' : 'Rescan'}
      </ActionButton>
    }
  >
    <div className="px-4 py-3">
      {phase === 'done' && allProviders.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {allProviders.map((provider, index) => {
            const isActive = activeProviderIndex === index;
            const isConnected = activeConnection?.type === provider.type;
            return (
              <button
                key={`${provider.type}-${provider.baseUrl}`}
                onClick={() => onProviderSelect(index)}
                className="inline-flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium transition-colors"
                style={{
                  color: isActive
                    ? 'var(--aurora-common-primary)'
                    : 'var(--aurora-text-secondary, var(--aurora-editor-foreground))',
                  backgroundColor: isActive
                    ? 'color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)'
                    : 'color-mix(in srgb, var(--aurora-editor-background) 50%, var(--aurora-sidebar-background) 50%)',
                  border: `1px solid ${
                    isActive
                      ? 'color-mix(in srgb, var(--aurora-common-primary) 50%, transparent)'
                      : 'color-mix(in srgb, var(--aurora-common-border) 50%, transparent)'
                  }`,
                  borderRadius: 6,
                }}
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{
                    backgroundColor: isConnected
                      ? 'var(--aurora-common-success)'
                      : 'var(--aurora-common-primary)',
                  }}
                />
                {provider.type === 'ollama' ? (
                  <Server size={10} />
                ) : (
                  <Monitor size={10} />
                )}
                <span>{provider.name}</span>
                {provider.version && (
                  <span className="text-text-disabled">v{provider.version}</span>
                )}
                <StatusPill variant="neutral" dot={false}>
                  {provider.models.length} model{provider.models.length === 1 ? '' : 's'}
                </StatusPill>
              </button>
            );
          })}
        </div>
      )}

      {phase === 'done' && allProviders.length === 0 && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-text-disabled">
          <WifiOff size={12} />
          <span>No local servers detected</span>
          <span>·</span>
          <button
            type="button"
            onClick={() => openExternal('https://ollama.com/download')}
            className="inline-flex items-center gap-0.5 hover:underline"
            style={{ color: 'var(--aurora-common-primary)' }}
          >
            Ollama <ExternalLink size={9} />
          </button>
          <button
            type="button"
            onClick={() => openExternal('https://lmstudio.ai')}
            className="inline-flex items-center gap-0.5 hover:underline"
            style={{ color: 'var(--aurora-common-primary)' }}
          >
            LM Studio <ExternalLink size={9} />
          </button>
        </div>
      )}

      {phase === 'scanning' && allProviders.length === 0 && (
        <div className="flex items-center gap-2 text-[11px] text-text-secondary">
          <Loader2
            size={12}
            className="animate-spin"
            style={{ color: 'var(--aurora-common-primary)' }}
          />
          <span>Scanning localhost for Ollama and LM Studio…</span>
        </div>
      )}
    </div>
  </Section>
);
