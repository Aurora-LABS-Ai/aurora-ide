import React from 'react';
import type { LocalModel, LocalProvider } from '../../services/local-model-detector';
import { useSettingsStore } from '../../store/useSettingsStore';
import { isThinkingModel } from './local-provider-utils';
import { useLocalProviderState } from './useLocalProviderState';
import { LocalCompactPanel } from './LocalCompactPanel';
import { LocalServerHeader } from './LocalServerHeader';
import { LocalModelSelection } from './LocalModelSelection';
import { LocalModelDetails } from './LocalModelDetails';
import { LocalParametersCard } from './LocalParametersCard';
import { LocalDownloadCard } from './LocalDownloadCard';
import { LocalCustomServerCard } from './LocalCustomServerCard';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface LocalProviderPanelProps {
  compact?: boolean;
  onProviderConnected?: () => void;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const LocalProviderPanel: React.FC<LocalProviderPanelProps> = ({
  compact = false,
  onProviderConnected,
}) => {
  const state = useLocalProviderState(onProviderConnected);

  const updateProvider = useSettingsStore((s) => s.updateProvider);
  const setSelectedModelGlobal = useSettingsStore((s) => s.setSelectedModel);

  // ---------------------------------------------------------------------------
  // Compact mode (Onboarding)
  // ---------------------------------------------------------------------------

  if (compact) {
    const handleCompactConnect = (provider: LocalProvider, model: LocalModel) => {
      const providerId = provider.type;
      const allModelIds = provider.models.map((m) => m.id);
      updateProvider(providerId, {
        baseUrl: provider.baseUrl,
        model: model.id,
        enabled: true,
        customModels: allModelIds,
        supportsThinking: isThinkingModel(model),
      });
      setSelectedModelGlobal(`${providerId}:${model.id}`);
      state.setConnectedProvider({ type: provider.type, model: model.id });
      onProviderConnected?.();
    };

    return (
      <LocalCompactPanel
        allProviders={state.allProviders}
        phase={state.phase}
        onConnect={handleCompactConnect}
        isConnecting={state.isLoadingModel}
        activeConnection={state.activeConnection}
        onRescan={() => state.runDetection()}
      />
    );
  }

  // ---------------------------------------------------------------------------
  // Full settings layout
  // ---------------------------------------------------------------------------

  const { currentProvider, isOllama } = state;

  return (
    <div className="space-y-4">
      {/* ── Header: Server status badges ── */}
      <LocalServerHeader
        phase={state.phase}
        allProviders={state.allProviders}
        activeProviderIndex={state.activeProviderIndex}
        activeConnection={state.activeConnection}
        onProviderSelect={state.setActiveProviderIndex}
        onRescan={() => state.runDetection()}
      />

      {/* ── Two-column: Model Selection + Model Details ── */}
      {currentProvider && (
        <div className="grid grid-cols-[1.2fr_1fr] gap-4">
          <LocalModelSelection
            currentProvider={currentProvider}
            selectedModelId={state.selectedModelId}
            onModelChange={state.setSelectedModelId}
            isConnected={state.isConnected}
            isOllama={isOllama ?? false}
            isLoadingModel={state.isLoadingModel}
            isUnloadingModel={state.isUnloadingModel}
            currentModelRunning={state.currentModelRunning}
            runningModels={state.runningModels}
            onLoad={state.handleLoadModel}
            onUnload={state.handleUnloadModel}
          />
          <LocalModelDetails
            selectedModel={state.selectedModel}
            modelInfo={state.modelInfo}
            loadingInfo={state.loadingInfo}
          />
        </div>
      )}

      {/* ── Parameters (3-column inline grid) ── */}
      {currentProvider && (
        <LocalParametersCard
          currentProvider={currentProvider}
          contextWindow={state.contextWindow}
          maxOutputTokens={state.maxOutputTokens}
          thinkingEnabled={state.thinkingEnabled}
          onContextWindowChange={state.setContextWindow}
          onMaxOutputChange={state.setMaxOutputTokens}
          onThinkingChange={(v) => {
            state.setThinkingEnabled(v);
            if (currentProvider) {
              updateProvider(currentProvider.type, { supportsThinking: v });
            }
          }}
          onBlurSave={state.handleParamSave}
        />
      )}

      {/* ── Two-column: Download Model + Custom Server (Ollama) ── */}
      {currentProvider && isOllama && (
        <div className="grid grid-cols-2 gap-4">
          <LocalDownloadCard
            currentProvider={currentProvider}
            selectedModelId={state.selectedModelId}
            pullModelName={state.pullModelName}
            onPullModelNameChange={state.setPullModelName}
            pulling={state.pulling}
            pullProgress={state.pullProgress}
            pullError={state.pullError}
            onPullErrorClear={() => state.setPullError(null)}
            pullSuccess={state.pullSuccess}
            onPullSuccessClear={() => state.setPullSuccess(false)}
            onPull={state.handlePull}
            onCancelPull={state.handleCancelPull}
            deleting={state.deleting}
            deleteConfirm={state.deleteConfirm}
            onDeleteConfirm={state.setDeleteConfirm}
            onDelete={state.handleDelete}
          />
          <LocalCustomServerCard
            customUrl={state.customUrl}
            onUrlChange={state.setCustomUrl}
            customProbing={state.customProbing}
            customResult={state.customResult}
            customError={state.customError}
            onErrorClear={() => state.setCustomError(null)}
            onProbe={state.handleProbeCustom}
          />
        </div>
      )}

      {/* ── Full-width Custom Server (LM Studio or no provider) ── */}
      {currentProvider && !isOllama && (
        <LocalCustomServerCard
          customUrl={state.customUrl}
          onUrlChange={state.setCustomUrl}
          customProbing={state.customProbing}
          customResult={state.customResult}
          customError={state.customError}
          onErrorClear={() => state.setCustomError(null)}
          onProbe={state.handleProbeCustom}
        />
      )}

      {/* ── Show custom server when no providers detected ── */}
      {!currentProvider && state.phase === 'done' && (
        <LocalCustomServerCard
          customUrl={state.customUrl}
          onUrlChange={state.setCustomUrl}
          customProbing={state.customProbing}
          customResult={state.customResult}
          customError={state.customError}
          onErrorClear={() => state.setCustomError(null)}
          onProbe={state.handleProbeCustom}
        />
      )}
    </div>
  );
};
