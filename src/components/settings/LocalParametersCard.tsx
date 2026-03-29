import React from 'react';
import type { LocalProvider } from '../../services/local-model-detector';
import { TogglePill } from '../ui/TogglePill';
import { settingsCardStyle, settingsInputStyle } from '../modals/settings-shared';

interface Props {
  currentProvider: LocalProvider;
  contextWindow: number;
  maxOutputTokens: number;
  thinkingEnabled: boolean;
  onContextWindowChange: (v: number) => void;
  onMaxOutputChange: (v: number) => void;
  onThinkingChange: (v: boolean) => void;
  onBlurSave: () => void;
}

export const LocalParametersCard: React.FC<Props> = ({
  contextWindow, maxOutputTokens, thinkingEnabled,
  onContextWindowChange, onMaxOutputChange, onThinkingChange, onBlurSave,
}) => (
  <div className="rounded-[20px] px-5 py-4 space-y-4" style={settingsCardStyle}>
    <div className="flex items-center gap-2">
      <span className="text-[11px] font-semibold text-text-primary tracking-wide uppercase">Parameters</span>
      <span className="text-[10px] text-text-disabled ml-auto">Auto-saved on change</span>
    </div>

    <div className="grid grid-cols-[1fr_1fr_auto] gap-4 items-end">
      {/* Context Window */}
      <div className="space-y-1.5">
        <label className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-text-secondary">Context Window</span>
          <span className="text-[10px] text-text-disabled font-mono">{contextWindow.toLocaleString()}</span>
        </label>
        <input
          type="number"
          value={contextWindow}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (!isNaN(v) && v > 0) onContextWindowChange(v);
          }}
          onBlur={onBlurSave}
          min={1024}
          max={2097152}
          step={1024}
          className="w-full rounded-xl px-3 py-2 text-xs text-text-primary placeholder:text-text-disabled focus:outline-none transition-colors"
          style={settingsInputStyle}
        />
      </div>

      {/* Max Output Tokens */}
      <div className="space-y-1.5">
        <label className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-text-secondary">Max Output</span>
          <span className="text-[10px] text-text-disabled font-mono">{maxOutputTokens.toLocaleString()}</span>
        </label>
        <input
          type="number"
          value={maxOutputTokens}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (!isNaN(v) && v > 0) onMaxOutputChange(v);
          }}
          onBlur={onBlurSave}
          min={256}
          max={131072}
          step={256}
          className="w-full rounded-xl px-3 py-2 text-xs text-text-primary placeholder:text-text-disabled focus:outline-none transition-colors"
          style={settingsInputStyle}
        />
      </div>

      {/* Thinking Mode */}
      <div className="flex flex-col items-center gap-1.5 pb-0.5">
        <span className="text-[11px] font-medium text-text-secondary whitespace-nowrap">Thinking</span>
        <TogglePill
          checked={thinkingEnabled}
          onChange={onThinkingChange}
          ariaLabel="Toggle thinking mode"
          size="sm"
        />
      </div>
    </div>
  </div>
);
