import React from 'react';
import { CheckCircle2, Globe, Loader2, Wifi } from 'lucide-react';
import type { LocalProvider } from '../../services/local-model-detector';
import { settingsCardStyle, settingsInputStyle, settingsPrimaryButtonStyle } from '../modals/settings-shared';

interface Props {
  customUrl: string;
  onUrlChange: (v: string) => void;
  customProbing: boolean;
  customResult: LocalProvider | null;
  customError: string | null;
  onErrorClear: () => void;
  onProbe: () => void;
}

export const LocalCustomServerCard: React.FC<Props> = ({
  customUrl, onUrlChange, customProbing, customResult, customError, onErrorClear, onProbe,
}) => (
  <div className="rounded-[20px] px-5 py-4" style={settingsCardStyle}>
    <div className="flex items-center gap-2 mb-2">
      <Globe className="w-3.5 h-3.5 text-text-secondary" />
      <span className="text-[11px] font-semibold text-text-primary tracking-wide uppercase">Custom Server</span>
    </div>
    <p className="text-[10px] text-text-disabled mb-3">
      Connect to Ollama or LM Studio on another machine, Docker, WSL, or a custom port.
    </p>
    <div className="flex gap-2">
      <input
        type="text"
        value={customUrl}
        onChange={(e) => { onUrlChange(e.target.value); onErrorClear(); }}
        placeholder="http://192.168.1.100:11434"
        onKeyDown={(e) => { if (e.key === 'Enter') onProbe(); }}
        className="flex-1 rounded-xl px-3 py-2 text-xs text-text-primary placeholder:text-text-disabled focus:outline-none transition-colors"
        style={settingsInputStyle}
      />
      <button
        onClick={onProbe}
        disabled={!customUrl.trim() || customProbing}
        className="px-4 py-2 rounded-xl text-primary-foreground text-xs font-semibold hover:bg-primary-hover transition-colors disabled:opacity-50 flex items-center gap-1.5 shrink-0"
        style={settingsPrimaryButtonStyle}
      >
        {customProbing ? <><Loader2 size={12} className="animate-spin" /> Probing...</>
          : <><Wifi size={12} /> Probe</>}
      </button>
    </div>
    {customError && <p className="text-[11px] text-danger mt-2">{customError}</p>}
    {customResult && !customError && (
      <p className="text-[11px] text-success mt-2 flex items-center gap-1">
        <CheckCircle2 className="w-3 h-3" />
        Found {customResult.name} with {customResult.models.length} model{customResult.models.length !== 1 ? 's' : ''}
      </p>
    )}
  </div>
);
