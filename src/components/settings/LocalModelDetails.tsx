import React from 'react';
import { Eye, Info, Loader2, Wrench, Zap } from 'lucide-react';
import type { LocalModel, OllamaModelInfo } from '../../services/local-model-detector';
import { isThinkingModel } from './local-provider-utils';
import {
  Section,
  FormBlock,
  KeyValue,
  StatusPill,
} from '../modals/settings-primitives';

interface Props {
  selectedModel: LocalModel | undefined;
  modelInfo: OllamaModelInfo | null;
  loadingInfo: boolean;
}

export const LocalModelDetails: React.FC<Props> = ({
  selectedModel,
  modelInfo,
  loadingInfo,
}) => {
  if (!selectedModel) {
    return (
      <Section
        title="Model Details"
        icon={<Info className="h-3.5 w-3.5 text-text-secondary" />}
      >
        <FormBlock divided={false} className="!py-6">
          <p className="text-center text-[11px] text-text-disabled">
            Select a model to view details
          </p>
        </FormBlock>
      </Section>
    );
  }

  const hasCapabilities = Boolean(
    modelInfo ||
    selectedModel.vision ||
    selectedModel.trainedForToolUse ||
    isThinkingModel(selectedModel),
  );

  return (
    <Section
      title="Model Details"
      icon={<Info className="h-3.5 w-3.5 text-text-secondary" />}
    >
      <FormBlock divided={hasCapabilities || loadingInfo}>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          {selectedModel.family && (
            <KeyValue label="Family" value={selectedModel.family} />
          )}
          {selectedModel.parameterSize && (
            <KeyValue label="Parameters" value={selectedModel.parameterSize} />
          )}
          {selectedModel.quantization && (
            <KeyValue label="Quantization" value={selectedModel.quantization} />
          )}
          {selectedModel.format && (
            <KeyValue label="Format" value={selectedModel.format} />
          )}
          {selectedModel.size && (
            <KeyValue label="Disk Size" value={selectedModel.size} />
          )}
        </div>
      </FormBlock>

      {hasCapabilities && (
        <FormBlock divided={loadingInfo}>
          <div className="flex flex-wrap gap-1.5">
            {isThinkingModel(selectedModel) && (
              <StatusPill variant="info" dot={false}>
                <Zap size={8} className="mr-0.5" />
                Thinking
              </StatusPill>
            )}
            {(selectedModel.vision || modelInfo?.capabilities?.includes('vision')) && (
              <StatusPill variant="info" dot={false}>
                <Eye size={8} className="mr-0.5" />
                Vision
              </StatusPill>
            )}
            {(selectedModel.trainedForToolUse ||
              modelInfo?.capabilities?.includes('tools')) && (
              <StatusPill variant="success" dot={false}>
                <Wrench size={8} className="mr-0.5" />
                Tool Use
              </StatusPill>
            )}
            {modelInfo?.capabilities?.includes('code') && (
              <StatusPill variant="warning" dot={false}>
                Code
              </StatusPill>
            )}
          </div>
        </FormBlock>
      )}

      {loadingInfo && (
        <FormBlock divided={false}>
          <div className="flex items-center gap-1.5 text-[10px] text-text-disabled">
            <Loader2 size={10} className="animate-spin" />
            Loading details…
          </div>
        </FormBlock>
      )}
    </Section>
  );
};
