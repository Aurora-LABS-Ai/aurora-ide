import React from 'react';
import { Eye, Loader2, Wrench, Zap } from 'lucide-react';
import type { LocalModel, OllamaModelInfo } from '../../services/local-model-detector';
import { isThinkingModel } from './local-provider-utils';
import { settingsCardStyle } from '../modals/settings-shared';

interface Props {
  selectedModel: LocalModel | undefined;
  modelInfo: OllamaModelInfo | null;
  loadingInfo: boolean;
}

export const LocalModelDetails: React.FC<Props> = ({ selectedModel, modelInfo, loadingInfo }) => {
  if (!selectedModel) {
    return (
      <div className="rounded-[20px] px-5 py-4 flex items-center justify-center" style={settingsCardStyle}>
        <p className="text-[11px] text-text-disabled text-center">
          Select a model to view details
        </p>
      </div>
    );
  }

  const hasCapabilities = modelInfo
    || selectedModel.vision
    || selectedModel.trainedForToolUse
    || isThinkingModel(selectedModel);

  return (
    <div className="rounded-[20px] px-5 py-4 space-y-4" style={settingsCardStyle}>
      <span className="text-[11px] font-semibold text-text-primary tracking-wide uppercase">Model Details</span>

      {/* Metadata grid */}
      <div className="grid grid-cols-2 gap-x-5 gap-y-2 text-[11px]">
        {selectedModel.family && (
          <div>
            <span className="text-text-disabled block text-[10px]">Family</span>
            <span className="text-text-secondary font-medium">{selectedModel.family}</span>
          </div>
        )}
        {selectedModel.parameterSize && (
          <div>
            <span className="text-text-disabled block text-[10px]">Parameters</span>
            <span className="text-text-secondary font-medium">{selectedModel.parameterSize}</span>
          </div>
        )}
        {selectedModel.quantization && (
          <div>
            <span className="text-text-disabled block text-[10px]">Quantization</span>
            <span className="text-text-secondary font-medium">{selectedModel.quantization}</span>
          </div>
        )}
        {selectedModel.format && (
          <div>
            <span className="text-text-disabled block text-[10px]">Format</span>
            <span className="text-text-secondary font-medium">{selectedModel.format}</span>
          </div>
        )}
        {selectedModel.size && (
          <div>
            <span className="text-text-disabled block text-[10px]">Disk Size</span>
            <span className="text-text-secondary font-medium">{selectedModel.size}</span>
          </div>
        )}
      </div>

      {/* Capability badges */}
      {hasCapabilities && (
        <div className="flex flex-wrap gap-1.5">
          {isThinkingModel(selectedModel) && (
            <span className="inline-flex items-center gap-1 rounded-full bg-info/10 px-2 py-0.5 text-[9px] font-semibold text-info">
              <Zap size={8} /> Thinking
            </span>
          )}
          {(selectedModel.vision || modelInfo?.capabilities?.includes('vision')) && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[9px] font-semibold text-primary">
              <Eye size={8} /> Vision
            </span>
          )}
          {(selectedModel.trainedForToolUse || modelInfo?.capabilities?.includes('tools')) && (
            <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[9px] font-semibold text-success">
              <Wrench size={8} /> Tool Use
            </span>
          )}
          {modelInfo?.capabilities?.includes('code') && (
            <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[9px] font-semibold text-warning">
              Code
            </span>
          )}
        </div>
      )}

      {loadingInfo && (
        <div className="flex items-center gap-1.5 text-[10px] text-text-disabled">
          <Loader2 size={10} className="animate-spin" /> Loading details...
        </div>
      )}
    </div>
  );
};
