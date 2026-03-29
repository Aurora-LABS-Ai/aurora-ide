import React from 'react';
import { clsx } from 'clsx';
import { CheckCircle2, CircleStop, HardDrive, Loader2, Play, Wrench, Zap } from 'lucide-react';
import type { LocalModel, LocalProvider, OllamaRunningModel } from '../../services/local-model-detector';
import type { SettingsSelectOption } from '../ui/SettingsSelect';
import { SettingsSelect } from '../ui/SettingsSelect';
import { formatBytes, modelToSelectOption } from './local-provider-utils';
import { settingsCardStyle, settingsPrimaryButtonStyle } from '../modals/settings-shared';

interface Props {
  currentProvider: LocalProvider;
  selectedModelId: string;
  onModelChange: (id: string) => void;
  isConnected: boolean;
  isOllama: boolean;
  isLoadingModel: boolean;
  isUnloadingModel: boolean;
  currentModelRunning: OllamaRunningModel | null;
  runningModels: OllamaRunningModel[];
  onLoad: () => void;
  onUnload: () => void;
}

export const LocalModelSelection: React.FC<Props> = ({
  currentProvider, selectedModelId, onModelChange,
  isConnected, isOllama,
  isLoadingModel, isUnloadingModel,
  currentModelRunning, runningModels,
  onLoad, onUnload,
}) => {
  const modelOptions: SettingsSelectOption[] = currentProvider.models.map(modelToSelectOption);
  const selectedModel: LocalModel | undefined = currentProvider.models.find((m) => m.id === selectedModelId);

  return (
    <div className="rounded-[20px] px-5 py-4 space-y-4 flex flex-col" style={settingsCardStyle}>
      <div className="flex items-center gap-2">
        <Wrench className="w-3.5 h-3.5 text-text-secondary" />
        <span className="text-[11px] font-semibold text-text-primary tracking-wide uppercase">Model Selection</span>
      </div>

      <SettingsSelect
        options={modelOptions}
        value={selectedModelId}
        onChange={(v) => onModelChange(String(v))}
        placeholder="Choose a model"
        ariaLabel="Local model selection"
      />

      {/* VRAM status when loaded */}
      {currentModelRunning && (
        <div className="rounded-xl border border-success/30 bg-success/5 px-3 py-2.5 space-y-1.5">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-success animate-pulse" />
            <span className="text-[11px] font-semibold text-success">Model Loaded in VRAM</span>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] text-text-secondary">
            {currentModelRunning.sizeVram > 0 && (
              <div className="flex justify-between">
                <span>VRAM</span>
                <span className="font-mono text-text-primary">{formatBytes(currentModelRunning.sizeVram)}</span>
              </div>
            )}
            {currentModelRunning.contextLength > 0 && (
              <div className="flex justify-between">
                <span>Context</span>
                <span className="font-mono text-text-primary">{currentModelRunning.contextLength.toLocaleString()}</span>
              </div>
            )}
            {currentModelRunning.expiresAt && (
              <div className="col-span-2 flex justify-between">
                <span>Expires</span>
                <span className="font-mono text-text-primary">
                  {(() => {
                    const remaining = new Date(currentModelRunning.expiresAt).getTime() - Date.now();
                    if (remaining <= 0) return 'soon';
                    const mins = Math.ceil(remaining / 60000);
                    return mins > 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
                  })()}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Load / Ready / Unload buttons */}
      <div className="mt-auto">
        {isOllama ? (
          <div className="flex gap-2">
            {currentModelRunning ? (
              <>
                <div className="flex-1 py-2.5 rounded-xl text-xs font-semibold bg-success/10 text-success border border-success/30 flex items-center justify-center gap-1.5">
                  <CheckCircle2 size={12} /> Ready
                </div>
                <button
                  onClick={onUnload}
                  disabled={isUnloadingModel}
                  className="px-4 py-2.5 rounded-xl text-xs font-semibold text-error border border-error/30 bg-error/5 hover:bg-error/10 transition-colors flex items-center gap-1.5 disabled:opacity-50"
                >
                  {isUnloadingModel
                    ? <><Loader2 size={12} className="animate-spin" /> Unloading...</>
                    : <><CircleStop size={12} /> Unload</>}
                </button>
              </>
            ) : (
              <button
                onClick={onLoad}
                disabled={!selectedModel || isLoadingModel}
                className="w-full py-2.5 rounded-xl text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
                style={settingsPrimaryButtonStyle}
              >
                {isLoadingModel
                  ? <><Loader2 size={12} className="animate-spin" /> Loading into VRAM...</>
                  : <><Play size={12} /> Load Model</>}
              </button>
            )}
          </div>
        ) : (
          <button
            onClick={onLoad}
            disabled={!selectedModel || isLoadingModel}
            className={clsx(
              'w-full py-2.5 rounded-xl text-xs font-semibold transition-colors flex items-center justify-center gap-1.5',
              isConnected
                ? 'bg-success/10 text-success border border-success/30 hover:bg-success/20'
                : 'text-primary-foreground hover:bg-primary-hover disabled:opacity-50',
            )}
            style={!isConnected ? settingsPrimaryButtonStyle : undefined}
          >
            {isLoadingModel ? <><Loader2 size={12} className="animate-spin" /> Connecting...</>
              : isConnected ? <><CheckCircle2 size={12} /> Connected &mdash; {selectedModelId}</>
              : <><Zap size={12} /> Connect Model</>}
          </button>
        )}

        {/* Running models summary */}
        {runningModels.length > 0 && isOllama && (
          <div className="mt-3 text-[10px] text-text-disabled flex items-center gap-1.5">
            <HardDrive size={10} />
            {runningModels.length} model{runningModels.length > 1 ? 's' : ''} loaded
            ({formatBytes(runningModels.reduce((acc, rm) => acc + rm.sizeVram, 0))} total)
          </div>
        )}
      </div>
    </div>
  );
};
