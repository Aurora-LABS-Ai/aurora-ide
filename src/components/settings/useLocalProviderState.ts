import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  deleteOllamaModel,
  detectLocalProviders,
  getOllamaRunningModels,
  loadOllamaModel,
  probeCustomUrl,
  probeOllama,
  pullOllamaModel,
  showOllamaModel,
  unloadOllamaModel,
  type DetectionResult,
  type LocalProvider,
  type OllamaModelInfo,
  type OllamaRunningModel,
  type PullProgress,
} from '../../services/local-model-detector';
import { useSettingsStore } from '../../store/useSettingsStore';
import {
  DEFAULT_BASES,
  getCachedCustomResult,
  getCachedDetection,
  isCacheFresh,
  isThinkingModel,
  setCachedDetection,
  type ActiveConnection,
  type DetectionPhase,
} from './local-provider-utils';

/**
 * Central state hook for the Local Provider settings panel.
 *
 * Key fix: detection results are cached at module level so that reopening the
 * settings modal does NOT re-trigger a scanning animation. The `runDetection`
 * callback is stable (empty deps) and reads mutable state via refs to avoid
 * the effect-cascade that previously caused the "refresh every time" bug.
 */
export function useLocalProviderState(onProviderConnected?: () => void) {
  const updateProvider = useSettingsStore((s) => s.updateProvider);
  const setSelectedModel = useSettingsStore((s) => s.setSelectedModel);
  const storeProviders = useSettingsStore((s) => s.providers);
  const globalSelectedModel = useSettingsStore((s) => s.selectedModel);

  const storedOllama = storeProviders.find((p) => p.id === 'ollama');
  const storedLMStudio = storeProviders.find((p) => p.id === 'lmstudio');

  const storedBaseUrl = useMemo(() => {
    for (const sp of [storedOllama, storedLMStudio]) {
      if (!sp?.baseUrl || !sp.enabled) continue;
      if (!DEFAULT_BASES.has(sp.baseUrl)) {
        return sp.baseUrl.replace(/\/v1$/, '');
      }
    }
    return '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedOllama?.baseUrl, storedOllama?.enabled, storedLMStudio?.baseUrl, storedLMStudio?.enabled]);

  // Ref so runDetection can read the latest value without being re-created
  const storedBaseUrlRef = useRef(storedBaseUrl);
  storedBaseUrlRef.current = storedBaseUrl;

  // ---------------------------------------------------------------------------
  // Detection state -- seed from module cache when available
  // ---------------------------------------------------------------------------
  const [phase, setPhase] = useState<DetectionPhase>(isCacheFresh() ? 'done' : 'idle');
  const [result, setResult] = useState<DetectionResult | null>(getCachedDetection());

  // Custom URL
  const [customUrl, setCustomUrl] = useState(storedBaseUrl);
  const [customProbing, setCustomProbing] = useState(false);
  const [customResult, setCustomResult] = useState<LocalProvider | null>(getCachedCustomResult());
  const [customError, setCustomError] = useState<string | null>(null);

  // Active provider
  const [activeProviderIndex, setActiveProviderIndex] = useState(0);
  const [selectedModelId, setSelectedModelId] = useState('');

  // Model info
  const [modelInfo, setModelInfo] = useState<OllamaModelInfo | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(false);

  // Parameters -- hydrate from persisted store
  const [contextWindow, setContextWindow] = useState(() => {
    const sp = storedOllama?.enabled ? storedOllama : storedLMStudio?.enabled ? storedLMStudio : null;
    return sp?.contextWindow && sp.contextWindow > 0 ? sp.contextWindow : 131072;
  });
  const [maxOutputTokens, setMaxOutputTokens] = useState(() => {
    const sp = storedOllama?.enabled ? storedOllama : storedLMStudio?.enabled ? storedLMStudio : null;
    return sp?.maxOutputTokens && sp.maxOutputTokens > 0 ? sp.maxOutputTokens : 8192;
  });
  const [thinkingEnabled, setThinkingEnabled] = useState(() => {
    const sp = storedOllama?.enabled ? storedOllama : storedLMStudio?.enabled ? storedLMStudio : null;
    return sp?.supportsThinking ?? false;
  });

  // Pull
  const [pullModelName, setPullModelName] = useState('');
  const [pulling, setPulling] = useState(false);
  const [pullProgress, setPullProgress] = useState<PullProgress | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);
  const [pullSuccess, setPullSuccess] = useState(false);
  const pullAbortRef = useRef<AbortController | null>(null);

  // Running models
  const [runningModels, setRunningModels] = useState<OllamaRunningModel[]>([]);
  const [isLoadingModel, setIsLoadingModel] = useState(false);
  const [isUnloadingModel, setIsUnloadingModel] = useState(false);

  // Delete
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // Connection -- prioritise whichever local provider is the globally selected model
  const existingConnection = useMemo<ActiveConnection | null>(() => {
    const ollama = storeProviders.find((p) => p.id === 'ollama');
    const lms = storeProviders.find((p) => p.id === 'lmstudio');

    const ollamaOk = ollama?.enabled && ollama.model && ollama.model !== 'llama3';
    const lmsOk = lms?.enabled && lms.model && lms.model !== 'local-model';

    const activeProviderId = globalSelectedModel.split(':')[0];

    if (activeProviderId === 'lmstudio' && lmsOk) {
      return { type: 'lmstudio', model: lms!.model };
    }
    if (activeProviderId === 'ollama' && ollamaOk) {
      return { type: 'ollama', model: ollama!.model };
    }
    if (lmsOk) return { type: 'lmstudio', model: lms!.model };
    if (ollamaOk) return { type: 'ollama', model: ollama!.model };
    return null;
  }, [storeProviders, globalSelectedModel]);

  const [connectedProvider, setConnectedProvider] = useState<ActiveConnection | null>(null);
  const activeConnection = connectedProvider ?? existingConnection;

  // Computed providers
  const allProviders = useMemo(() => {
    const list = [...(result?.providers ?? [])];
    if (customResult && !list.some((p) => p.baseUrl === customResult.baseUrl)) {
      list.push(customResult);
    }
    return list;
  }, [result, customResult]);

  const currentProvider = allProviders[activeProviderIndex] ?? null;
  const selectedModel = currentProvider?.models.find((m) => m.id === selectedModelId);
  const isConnected = activeConnection?.type === currentProvider?.type && activeConnection?.model === selectedModelId;
  const isOllama = currentProvider?.type === 'ollama';

  // ---------------------------------------------------------------------------
  // Detection -- STABLE callback (no deps that change on store writes)
  // ---------------------------------------------------------------------------
  const runDetection = useCallback(async (remoteUrlOverride?: string) => {
    // Guard: onClick handlers pass a MouseEvent as the first arg -- ignore it
    const safeOverride = typeof remoteUrlOverride === 'string' ? remoteUrlOverride : undefined;

    setPhase('scanning');
    let newCustomResult: LocalProvider | null = null;
    try {
      const detected = await detectLocalProviders();
      const providers = [...detected.providers];

      const remoteToProbe = safeOverride ?? storedBaseUrlRef.current;
      if (remoteToProbe) {
        const alreadyFound = providers.some((p) => {
          const pHost = p.baseUrl.replace(/\/v1$/, '').toLowerCase();
          return pHost === remoteToProbe.toLowerCase();
        });
        if (!alreadyFound) {
          const remote = await probeCustomUrl(remoteToProbe);
          if (remote) {
            providers.push(remote);
            setCustomResult(remote);
            newCustomResult = remote;
          }
        }
      }

      const bestProvider = providers.length > 0
        ? providers.reduce((best, p) => (p.models.length > best.models.length ? p : best))
        : null;

      const detectionResult: DetectionResult = { providers, bestProvider };
      setResult(detectionResult);
      setCachedDetection(detectionResult, newCustomResult);
    } catch {
      const emptyResult: DetectionResult = { providers: [], bestProvider: null };
      setResult(emptyResult);
    } finally {
      setPhase('done');
    }
  }, []);

  // Run detection ONCE on mount -- skip if module cache is fresh
  const hasInitiallyScanned = useRef(false);
  useEffect(() => {
    if (hasInitiallyScanned.current) return;
    hasInitiallyScanned.current = true;
    if (isCacheFresh()) return; // Already seeded from cache in useState init
    runDetection();
  }, [runDetection]);

  // Auto-select provider tab matching existing store connection
  useEffect(() => {
    if (!result || !existingConnection) return;
    const idx = result.providers.findIndex((p) => p.type === existingConnection.type);
    if (idx >= 0) setActiveProviderIndex(idx);
    // Only re-run when the connection type or result identity change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, existingConnection?.type]);

  // Auto-select first model when provider tab switches
  useEffect(() => {
    if (!currentProvider || currentProvider.models.length === 0) return;
    const existing = activeConnection?.type === currentProvider.type ? activeConnection.model : null;
    const match = existing ? currentProvider.models.find((m) => m.id === existing) : null;
    setSelectedModelId(match?.id ?? currentProvider.models[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProvider?.type, currentProvider?.models.length, activeConnection?.type, activeConnection?.model]);

  // Fetch model details when selection changes (Ollama only)
  useEffect(() => {
    if (!currentProvider || currentProvider.type !== 'ollama' || !selectedModelId) {
      setModelInfo(null);
      return;
    }
    let cancelled = false;
    setLoadingInfo(true);
    showOllamaModel(currentProvider.baseUrl, selectedModelId).then((info) => {
      if (cancelled) return;
      setModelInfo(info);
      setLoadingInfo(false);
      if (info?.details) {
        const model = currentProvider.models.find((m) => m.id === selectedModelId);
        if (model) {
          setThinkingEnabled(isThinkingModel(model) || (info.capabilities?.includes('reasoning') ?? false));
        }
      }
    });
    return () => { cancelled = true; };
  }, [currentProvider, selectedModelId]);

  // Sync params from store when active provider type changes
  useEffect(() => {
    if (!currentProvider) return;
    const storeP = storeProviders.find((p) => p.id === currentProvider.type);
    if (!storeP) return;
    setContextWindow(storeP.contextWindow > 0 ? storeP.contextWindow : 131072);
    setMaxOutputTokens(storeP.maxOutputTokens > 0 ? storeP.maxOutputTokens : 8192);
    setThinkingEnabled(storeP.supportsThinking);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProvider?.type]);

  // Poll running models for Ollama providers
  const refreshRunningModels = useCallback(async () => {
    if (!currentProvider || currentProvider.type !== 'ollama') {
      setRunningModels([]);
      return;
    }
    const models = await getOllamaRunningModels(currentProvider.baseUrl);
    setRunningModels(models);
  }, [currentProvider]);

  useEffect(() => {
    refreshRunningModels();
    const interval = setInterval(refreshRunningModels, 8000);
    return () => clearInterval(interval);
  }, [refreshRunningModels]);

  const currentModelRunning = useMemo(() => {
    if (!selectedModelId) return null;
    return runningModels.find(
      (rm) => rm.name === selectedModelId || rm.model === selectedModelId
        || rm.name.startsWith(selectedModelId.split(':')[0]),
    ) ?? null;
  }, [runningModels, selectedModelId]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleLoadModel = useCallback(async () => {
    if (!currentProvider || !selectedModelId) return;
    setIsLoadingModel(true);
    try {
      const providerId = currentProvider.type;
      const allModelIds = currentProvider.models.map((m) => m.id);

      updateProvider(providerId, {
        baseUrl: currentProvider.baseUrl,
        model: selectedModelId,
        enabled: true,
        customModels: allModelIds,
        contextWindow,
        maxOutputTokens,
        supportsThinking: thinkingEnabled,
      });
      setSelectedModel(`${providerId}:${selectedModelId}`);

      if (currentProvider.type === 'ollama') {
        await loadOllamaModel(currentProvider.baseUrl, selectedModelId, '30m');
        await refreshRunningModels();
      }

      setConnectedProvider({ type: currentProvider.type, model: selectedModelId });
      onProviderConnected?.();
    } finally {
      setIsLoadingModel(false);
    }
  }, [currentProvider, selectedModelId, contextWindow, maxOutputTokens, thinkingEnabled, updateProvider, setSelectedModel, onProviderConnected, refreshRunningModels]);

  const handleUnloadModel = useCallback(async () => {
    if (!currentProvider || !selectedModelId) return;
    setIsUnloadingModel(true);
    try {
      if (currentProvider.type === 'ollama') {
        const ok = await unloadOllamaModel(currentProvider.baseUrl, selectedModelId);
        if (ok) await new Promise((r) => setTimeout(r, 1000));
        await refreshRunningModels();
        setTimeout(refreshRunningModels, 2000);
      }
    } finally {
      setIsUnloadingModel(false);
    }
  }, [currentProvider, selectedModelId, refreshRunningModels]);

  const handleParamSave = useCallback(() => {
    if (!currentProvider) return;
    updateProvider(currentProvider.type, { contextWindow, maxOutputTokens, supportsThinking: thinkingEnabled });
  }, [currentProvider, contextWindow, maxOutputTokens, thinkingEnabled, updateProvider]);

  const handleProbeCustom = useCallback(async () => {
    const url = customUrl.trim();
    if (!url) return;
    setCustomProbing(true);
    setCustomError(null);
    setCustomResult(null);
    try {
      const found = await probeCustomUrl(url);
      if (found) {
        setCustomResult(found);
        updateProvider(found.type, {
          baseUrl: found.baseUrl,
          enabled: true,
          customModels: found.models.map((m) => m.id),
        });
        await runDetection(url.replace(/\/+$/, '').replace(/\/v1$/, ''));
      } else {
        setCustomError('No Ollama or LM Studio server found. Check the URL and ensure the server is running.');
      }
    } catch {
      setCustomError('Connection failed. Verify the URL and try again.');
    } finally {
      setCustomProbing(false);
    }
  }, [customUrl, runDetection, updateProvider]);

  const handlePull = useCallback(async () => {
    if (!currentProvider || currentProvider.type !== 'ollama' || !pullModelName.trim()) return;
    setPulling(true);
    setPullError(null);
    setPullSuccess(false);
    setPullProgress(null);

    const controller = new AbortController();
    pullAbortRef.current = controller;

    try {
      const success = await pullOllamaModel(
        currentProvider.baseUrl,
        pullModelName.trim(),
        (p) => setPullProgress(p),
        controller.signal,
      );
      if (success) {
        setPullSuccess(true);
        setPullModelName('');
        const refreshed = await probeOllama(currentProvider.baseUrl.replace(/\/v1$/, ''));
        if (refreshed && result) {
          const newProviders = result.providers.map((p) => p.type === 'ollama' ? refreshed : p);
          const updated = { ...result, providers: newProviders };
          setResult(updated);
          setCachedDetection(updated, customResult);
        }
      }
    } catch (err) {
      if (controller.signal.aborted) {
        setPullError('Download cancelled.');
      } else {
        setPullError(err instanceof Error ? err.message : 'Pull failed.');
      }
    } finally {
      setPulling(false);
      pullAbortRef.current = null;
    }
  }, [currentProvider, pullModelName, result, customResult]);

  const handleCancelPull = useCallback(() => {
    pullAbortRef.current?.abort();
  }, []);

  const handleDelete = useCallback(async (modelId: string) => {
    if (!currentProvider || currentProvider.type !== 'ollama') return;
    setDeleting(modelId);
    try {
      const success = await deleteOllamaModel(currentProvider.baseUrl, modelId);
      if (success) {
        const refreshed = await probeOllama(currentProvider.baseUrl.replace(/\/v1$/, ''));
        if (refreshed && result) {
          const newProviders = result.providers.map((p) => p.type === 'ollama' ? refreshed : p);
          const updated = { ...result, providers: newProviders };
          setResult(updated);
          setCachedDetection(updated, customResult);
        }
        if (selectedModelId === modelId) {
          setSelectedModelId(currentProvider.models[0]?.id ?? '');
        }
      }
    } finally {
      setDeleting(null);
      setDeleteConfirm(null);
    }
  }, [currentProvider, result, customResult, selectedModelId]);

  return {
    phase, allProviders, runDetection,
    activeProviderIndex, setActiveProviderIndex, currentProvider,
    selectedModelId, setSelectedModelId, selectedModel, modelInfo, loadingInfo,
    activeConnection, isConnected, connectedProvider, setConnectedProvider,
    runningModels, currentModelRunning, refreshRunningModels,
    handleLoadModel, handleUnloadModel, isLoadingModel, isUnloadingModel,
    contextWindow, setContextWindow, maxOutputTokens, setMaxOutputTokens,
    thinkingEnabled, setThinkingEnabled, handleParamSave,
    pullModelName, setPullModelName, pulling, pullProgress, pullError,
    setPullError, pullSuccess, setPullSuccess, handlePull, handleCancelPull,
    deleting, deleteConfirm, setDeleteConfirm, handleDelete,
    customUrl, setCustomUrl, customProbing, customResult, customError, setCustomError, handleProbeCustom,
    updateProvider, setSelectedModel, isOllama, storeProviders,
  };
}

export type LocalProviderState = ReturnType<typeof useLocalProviderState>;
