import {
  auroraInvoke as invoke,
  auroraListen as listen,
} from "../lib/runtime";

export interface LocalProvider {
  type: "ollama" | "lmstudio";
  name: string;
  baseUrl: string;
  models: LocalModel[];
  version?: string;
}

export interface LocalModel {
  id: string;
  name: string;
  size?: string;
  sizeBytes?: number;
  parameterSize?: string;
  family?: string;
  families?: string[];
  quantization?: string;
  format?: string;
  maxContextLength?: number;
  trainedForToolUse?: boolean;
  vision?: boolean;
  supportsThinking?: boolean;
}

export interface OllamaModelInfo {
  license?: string;
  parameters?: string;
  template?: string;
  system?: string;
  details: {
    parent_model?: string;
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
  capabilities?: string[];
}

export interface PullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
}

export interface OllamaRunningModel {
  name: string;
  model: string;
  size: number;
  sizeVram: number;
  contextLength: number;
  expiresAt: string;
  details: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

export interface DetectionResult {
  providers: LocalProvider[];
  bestProvider: LocalProvider | null;
}

function mapDetectionResult(result: DetectionResult): DetectionResult {
  return {
    providers: result.providers ?? [],
    bestProvider: result.bestProvider ?? null,
  };
}

export async function probeOllama(host = "http://localhost:11434"): Promise<LocalProvider | null> {
  const result = await invoke<LocalProvider | null>("local_provider_probe_custom", {
    url: host,
  });
  return result?.type === "ollama" ? result : null;
}

export async function probeLMStudio(host = "http://localhost:1234"): Promise<LocalProvider | null> {
  const result = await invoke<LocalProvider | null>("local_provider_probe_custom", {
    url: host,
  });
  return result?.type === "lmstudio" ? result : null;
}

export async function probeCustomUrl(url: string): Promise<LocalProvider | null> {
  return invoke<LocalProvider | null>("local_provider_probe_custom", { url });
}

export async function detectLocalProviders(customUrl?: string): Promise<DetectionResult> {
  const result = await invoke<DetectionResult>("local_provider_detect", {
    customUrl,
  });
  return mapDetectionResult(result);
}

export async function showOllamaModel(
  baseUrl: string,
  modelName: string,
): Promise<OllamaModelInfo | null> {
  return invoke<OllamaModelInfo | null>("local_provider_show_ollama_model", {
    baseUrl,
    modelName,
  });
}

export async function pullOllamaModel(
  baseUrl: string,
  modelName: string,
  onProgress: (progress: PullProgress) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  const unlistenProgress = await listen<PullProgress>(
    `local-provider-pull-progress-${requestId}`,
    (event) => onProgress(event.payload),
  );

  const abortHandler = () => {
    invoke("cancel_local_provider_pull", { requestId }).catch(() => {
      // Ignore cleanup races.
    });
  };

  signal?.addEventListener("abort", abortHandler, { once: true });

  try {
    return await invoke<boolean>("local_provider_pull_ollama_model", {
      requestId,
      baseUrl,
      modelName,
    });
  } finally {
    signal?.removeEventListener("abort", abortHandler);
    unlistenProgress();
  }
}

export async function deleteOllamaModel(
  baseUrl: string,
  modelName: string,
): Promise<boolean> {
  return invoke<boolean>("local_provider_delete_ollama_model", {
    baseUrl,
    modelName,
  });
}

export async function getOllamaRunningModels(
  baseUrl: string,
): Promise<OllamaRunningModel[]> {
  return invoke<OllamaRunningModel[]>("local_provider_get_running_models", {
    baseUrl,
  });
}

export async function loadOllamaModel(
  baseUrl: string,
  modelName: string,
  keepAlive = "30m",
): Promise<boolean> {
  return invoke<boolean>("local_provider_load_ollama_model", {
    baseUrl,
    modelName,
    keepAlive,
  });
}

export async function unloadOllamaModel(
  baseUrl: string,
  modelName: string,
): Promise<boolean> {
  return invoke<boolean>("local_provider_unload_ollama_model", {
    baseUrl,
    modelName,
  });
}
