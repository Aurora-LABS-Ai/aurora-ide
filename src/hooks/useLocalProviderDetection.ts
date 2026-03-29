import { useEffect, useRef } from 'react';
import { detectLocalProviders } from '../services/local-model-detector';
import { useSettingsStore } from '../store/useSettingsStore';

const THINKING_PATTERNS = ['qwen3', 'qwq', 'deepseek-r1', 'phi-4-reasoning'];

/**
 * Background hook that probes for local AI servers (Ollama / LM Studio)
 * once after app startup. If no cloud provider has an API key configured,
 * and a local server with models is found, it auto-configures the provider
 * so the user can start chatting immediately.
 *
 * Runs silently -- no UI interruptions. The status bar and model selector
 * will reflect the change.
 */
export function useLocalProviderDetection() {
  const hasRun = useRef(false);

  const isInitialized = useSettingsStore((s) => s.isInitialized);
  const providers = useSettingsStore((s) => s.providers);
  const updateProvider = useSettingsStore((s) => s.updateProvider);
  const setSelectedModel = useSettingsStore((s) => s.setSelectedModel);

  useEffect(() => {
    if (!isInitialized || hasRun.current) return;
    hasRun.current = true;

    const hasCloudProvider = providers.some((p) => {
      if (!p.enabled) return false;
      const url = p.baseUrl.toLowerCase();
      const isLocal = url.includes('localhost') || url.includes('127.0.0.1');
      return !isLocal && p.apiKey.trim().length > 0;
    });

    const ollamaAlreadyConfigured = providers.some(
      (p) => p.id === 'ollama' && p.customModels && p.customModels.length > 0,
    );
    const lmStudioAlreadyConfigured = providers.some(
      (p) => p.id === 'lmstudio' && p.customModels && p.customModels.length > 0,
    );

    if (hasCloudProvider && ollamaAlreadyConfigured) return;
    if (hasCloudProvider && lmStudioAlreadyConfigured) return;

    detectLocalProviders().then((detection) => {
      if (detection.providers.length === 0) return;

      for (const localProvider of detection.providers) {
        const providerId = localProvider.type === 'ollama' ? 'ollama' : 'lmstudio';
        const storeProvider = providers.find((p) => p.id === providerId);
        if (!storeProvider) continue;

        const alreadyConfigured =
          storeProvider.customModels && storeProvider.customModels.length > 0;
        if (alreadyConfigured) continue;

        const allModelIds = localProvider.models.map((m) => m.id);
        const bestModel = localProvider.models[0];
        if (!bestModel) continue;

        const thinking = THINKING_PATTERNS.some((pat) =>
          bestModel.id.toLowerCase().includes(pat),
        );

        updateProvider(providerId, {
          baseUrl: localProvider.baseUrl,
          model: bestModel.id,
          enabled: true,
          customModels: allModelIds,
          supportsThinking: thinking,
        });

        if (!hasCloudProvider) {
          setSelectedModel(`${providerId}:${bestModel.id}`);
        }
      }
    }).catch(() => {
      // Silently ignore detection failures
    });
  }, [isInitialized, providers, updateProvider, setSelectedModel]);
}
