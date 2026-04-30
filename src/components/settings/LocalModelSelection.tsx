import React from 'react';
import { CheckCircle2, CircleStop, HardDrive, Loader2, Play, Wrench, Zap } from 'lucide-react';
import type {
  LocalModel,
  LocalProvider,
  OllamaRunningModel,
} from '../../services/local-model-detector';
import { IdeSelect, type IdeSelectOption } from '../ui/IdeSelect';
import { formatBytes, modelToSelectOption } from './local-provider-utils';
import {
  Section,
  FormBlock,
  ActionButton,
  KeyValue,
} from '../modals/settings-primitives';

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
  currentProvider,
  selectedModelId,
  onModelChange,
  isConnected,
  isOllama,
  isLoadingModel,
  isUnloadingModel,
  currentModelRunning,
  runningModels,
  onLoad,
  onUnload,
}) => {
  const modelOptions: IdeSelectOption[] = currentProvider.models.map(modelToSelectOption);
  const selectedModel: LocalModel | undefined = currentProvider.models.find(
    (model) => model.id === selectedModelId,
  );

  return (
    <Section
      title="Model Selection"
      icon={<Wrench className="h-3.5 w-3.5 text-text-secondary" />}
    >
      <FormBlock>
        <IdeSelect
          options={modelOptions}
          value={selectedModelId}
          onChange={(value) => onModelChange(String(value))}
          placeholder="Choose a model"
          ariaLabel="Local model selection"
        />
      </FormBlock>

      {/* VRAM status when loaded */}
      {currentModelRunning && (
        <FormBlock>
          <div
            className="space-y-1.5 px-3 py-2.5"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--aurora-common-success) 6%, transparent)',
              border:
                '1px solid color-mix(in srgb, var(--aurora-common-success) 28%, transparent)',
              borderRadius: 6,
            }}
          >
            <div className="flex items-center gap-2">
              <span
                className="h-1.5 w-1.5 animate-pulse rounded-full"
                style={{ backgroundColor: 'var(--aurora-common-success)' }}
              />
              <span
                className="text-[11px] font-semibold"
                style={{ color: 'var(--aurora-common-success)' }}
              >
                Model Loaded in VRAM
              </span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {currentModelRunning.sizeVram > 0 && (
                <KeyValue label="VRAM" value={formatBytes(currentModelRunning.sizeVram)} mono />
              )}
              {currentModelRunning.contextLength > 0 && (
                <KeyValue
                  label="Context"
                  value={currentModelRunning.contextLength.toLocaleString()}
                  mono
                />
              )}
              {currentModelRunning.expiresAt && (
                <div className="col-span-2">
                  <KeyValue
                    label="Expires"
                    value={(() => {
                      const remaining =
                        new Date(currentModelRunning.expiresAt).getTime() - Date.now();
                      if (remaining <= 0) return 'soon';
                      const mins = Math.ceil(remaining / 60000);
                      return mins > 60
                        ? `${Math.floor(mins / 60)}h ${mins % 60}m`
                        : `${mins}m`;
                    })()}
                    mono
                  />
                </div>
              )}
            </div>
          </div>
        </FormBlock>
      )}

      <FormBlock divided={false}>
        {isOllama ? (
          <div className="flex gap-1.5">
            {currentModelRunning ? (
              <>
                <div
                  className="flex flex-1 items-center justify-center gap-1.5 px-3 py-1.5 text-[11.5px] font-semibold"
                  style={{
                    backgroundColor:
                      'color-mix(in srgb, var(--aurora-common-success) 12%, transparent)',
                    color: 'var(--aurora-common-success)',
                    border:
                      '1px solid color-mix(in srgb, var(--aurora-common-success) 30%, transparent)',
                    borderRadius: 6,
                  }}
                >
                  <CheckCircle2 size={12} /> Ready
                </div>
                <ActionButton
                  variant="danger"
                  icon={
                    isUnloadingModel ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <CircleStop className="h-3 w-3" />
                    )
                  }
                  disabled={isUnloadingModel}
                  onClick={onUnload}
                >
                  {isUnloadingModel ? 'Unloading…' : 'Unload'}
                </ActionButton>
              </>
            ) : (
              <ActionButton
                variant="primary"
                className="!w-full !justify-center"
                icon={
                  isLoadingModel ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Play className="h-3 w-3" />
                  )
                }
                disabled={!selectedModel || isLoadingModel}
                onClick={onLoad}
              >
                {isLoadingModel ? 'Loading into VRAM…' : 'Load Model'}
              </ActionButton>
            )}
          </div>
        ) : (
          <div className="flex">
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
                <CheckCircle2 size={12} /> Connected — {selectedModelId}
              </div>
            ) : (
              <ActionButton
                variant="primary"
                className="!w-full !justify-center"
                icon={
                  isLoadingModel ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Zap className="h-3 w-3" />
                  )
                }
                disabled={!selectedModel || isLoadingModel}
                onClick={onLoad}
              >
                {isLoadingModel ? 'Connecting…' : 'Connect Model'}
              </ActionButton>
            )}
          </div>
        )}

        {runningModels.length > 0 && isOllama && (
          <div className="mt-2 flex items-center gap-1.5 text-[10px] text-text-disabled">
            <HardDrive size={10} />
            {runningModels.length} model{runningModels.length === 1 ? '' : 's'} loaded (
            {formatBytes(runningModels.reduce((acc, model) => acc + model.sizeVram, 0))} total)
          </div>
        )}
      </FormBlock>
    </Section>
  );
};
