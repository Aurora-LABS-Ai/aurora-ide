/**
 * Local Model Detection & Management Service
 *
 * Probes for locally running AI servers (Ollama, LM Studio), discovers
 * available models, fetches model details, and supports Ollama model
 * pull/delete operations.
 *
 * Ollama API:
 *   GET  {host}/api/tags    → list models
 *   POST {host}/api/show    → model details
 *   POST {host}/api/pull    → download model (streaming NDJSON)
 *   DELETE {host}/api/delete → remove model
 *   GET  {host}/api/ps      → running models
 *   GET  {host}/api/version → server version
 *
 * LM Studio API:
 *   GET  {host}/v1/models   → list models (OpenAI-compatible)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LocalProvider {
  type: 'ollama' | 'lmstudio';
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

// ---------------------------------------------------------------------------
// Internal response shapes
// ---------------------------------------------------------------------------

interface OllamaTagsResponse {
  models?: Array<{
    name: string;
    model: string;
    size: number;
    details?: {
      parameter_size?: string;
      family?: string;
      families?: string[];
      format?: string;
      quantization_level?: string;
    };
  }>;
}

interface LMStudioModelsResponse {
  data?: Array<{
    id: string;
    object?: string;
    // Extended fields returned by LM Studio's own API
    type?: string;
    display_name?: string;
    path?: string;
    size_bytes?: number;
    params_string?: string;
    architecture?: string;
    vision?: boolean;
    trained_for_tool_use?: boolean;
    max_context_length?: number;
  }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROBE_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDevServer(): boolean {
  return import.meta.env.DEV;
}

/**
 * In browser dev mode (`pnpm dev`), rewrite localhost URLs to Vite proxy
 * paths so `fetch` doesn't get blocked by CORS.
 */
function maybeProxy(url: string): string {
  if (!isDevServer()) return url;
  if (/^https?:\/\/(localhost|127\.0\.0\.1):11434\b/.test(url)) return '/proxy/ollama';
  if (/^https?:\/\/(localhost|127\.0\.0\.1):1234\b/.test(url)) return '/proxy/lmstudio';
  return url;
}

function getDefaultOllamaHost(): string {
  return isDevServer() ? '/proxy/ollama' : 'http://localhost:11434';
}

function getDefaultLMStudioHost(): string {
  return isDevServer() ? '/proxy/lmstudio' : 'http://localhost:1234';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function ollamaApiHost(baseUrlOrHost: string): string {
  const clean = baseUrlOrHost.replace(/\/+$/, '').replace(/\/v1$/, '');
  return maybeProxy(clean);
}

function lmStudioApiHost(baseUrlOrHost: string): string {
  const clean = baseUrlOrHost.replace(/\/+$/, '').replace(/\/v1$/, '');
  return maybeProxy(clean);
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export async function probeOllama(host: string = getDefaultOllamaHost()): Promise<LocalProvider | null> {
  try {
    const apiHost = ollamaApiHost(host);
    const response = await fetch(`${apiHost}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const data: OllamaTagsResponse = await response.json();
    if (!data.models || !Array.isArray(data.models)) return null;

    const models: LocalModel[] = data.models.map((m) => ({
      id: m.name,
      name: m.name.split(':')[0],
      size: m.size ? formatBytes(m.size) : undefined,
      sizeBytes: m.size,
      parameterSize: m.details?.parameter_size,
      family: m.details?.family,
      families: m.details?.families,
      quantization: m.details?.quantization_level,
      format: m.details?.format,
    }));

    let version: string | undefined;
    try {
      const vRes = await fetch(`${apiHost}/api/version`, {
        signal: AbortSignal.timeout(2000),
      });
      if (vRes.ok) {
        version = (await vRes.json()).version;
      }
    } catch {
      // optional
    }

    // Store the real host URL (not the dev proxy path) so LLM requests work
    const realHost = apiHost.startsWith('/proxy/') ? 'http://localhost:11434' : apiHost;

    return {
      type: 'ollama',
      name: 'Ollama',
      baseUrl: `${realHost}/v1`,
      models,
      version,
    };
  } catch {
    return null;
  }
}

export async function probeLMStudio(host: string = getDefaultLMStudioHost()): Promise<LocalProvider | null> {
  try {
    const cleanHost = lmStudioApiHost(host);
    const response = await fetch(`${cleanHost}/v1/models`, {
      method: 'GET',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const data: LMStudioModelsResponse = await response.json();
    if (!data.data || !Array.isArray(data.data)) return null;

    const models: LocalModel[] = data.data.map((m) => ({
      id: m.id,
      name: m.display_name || m.id.split('/').pop() || m.id,
      size: m.size_bytes ? formatBytes(m.size_bytes) : undefined,
      sizeBytes: m.size_bytes,
      parameterSize: m.params_string,
      family: m.architecture,
      maxContextLength: m.max_context_length,
      trainedForToolUse: m.trained_for_tool_use,
      vision: m.vision,
    }));

    // Store the real host URL (not the dev proxy path) so LLM requests work
    const realHost = cleanHost.startsWith('/proxy/') ? 'http://localhost:1234' : cleanHost;

    return {
      type: 'lmstudio',
      name: 'LM Studio',
      baseUrl: `${realHost}/v1`,
      models,
    };
  } catch {
    return null;
  }
}

export async function probeCustomUrl(url: string): Promise<LocalProvider | null> {
  const host = url.replace(/\/+$/, '').replace(/\/v1$/, '');
  return (await probeOllama(host)) ?? (await probeLMStudio(host));
}

export async function detectLocalProviders(): Promise<DetectionResult> {
  const [ollama, lmStudio] = await Promise.all([probeOllama(), probeLMStudio()]);

  const providers: LocalProvider[] = [];
  if (ollama && ollama.models.length > 0) providers.push(ollama);
  if (lmStudio && lmStudio.models.length > 0) providers.push(lmStudio);

  const bestProvider = providers.length > 0
    ? providers.reduce((best, p) => (p.models.length > best.models.length ? p : best))
    : null;

  return { providers, bestProvider };
}

// ---------------------------------------------------------------------------
// Ollama Model Info  (POST /api/show)
// ---------------------------------------------------------------------------

export async function showOllamaModel(
  baseUrl: string,
  modelName: string,
): Promise<OllamaModelInfo | null> {
  try {
    const apiHost = ollamaApiHost(baseUrl);
    const response = await fetch(`${apiHost}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    return (await response.json()) as OllamaModelInfo;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Ollama Model Pull  (POST /api/pull, streaming NDJSON)
// ---------------------------------------------------------------------------

export async function pullOllamaModel(
  baseUrl: string,
  modelName: string,
  onProgress: (progress: PullProgress) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  const apiHost = ollamaApiHost(baseUrl);
  const response = await fetch(`${apiHost}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelName, stream: true }),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Pull failed (${response.status}): ${errText}`);
  }

  if (!response.body) throw new Error('No response body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let success = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const progress = JSON.parse(trimmed) as PullProgress;
          onProgress(progress);
          if (progress.status === 'success') success = true;
        } catch {
          // skip malformed lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return success;
}

// ---------------------------------------------------------------------------
// Ollama Model Delete  (DELETE /api/delete)
// ---------------------------------------------------------------------------

export async function deleteOllamaModel(
  baseUrl: string,
  modelName: string,
): Promise<boolean> {
  try {
    const apiHost = ollamaApiHost(baseUrl);
    const response = await fetch(`${apiHost}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName }),
      signal: AbortSignal.timeout(10000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Ollama Running Models  (GET /api/ps)
// ---------------------------------------------------------------------------

export async function getOllamaRunningModels(
  baseUrl: string,
): Promise<OllamaRunningModel[]> {
  try {
    const apiHost = ollamaApiHost(baseUrl);
    const response = await fetch(`${apiHost}/api/ps`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return [];
    const data = await response.json();
    if (!data.models || !Array.isArray(data.models)) return [];
    return data.models.map((m: Record<string, unknown>) => ({
      name: m.name as string,
      model: m.model as string,
      size: m.size as number,
      sizeVram: (m.size_vram as number) ?? 0,
      contextLength: (m.context_length as number) ?? 0,
      expiresAt: (m.expires_at as string) ?? '',
      details: (m.details as OllamaRunningModel['details']) ?? {},
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Ollama Load Model  (POST /api/generate with keep_alive)
// A no-prompt generate request preloads the model into VRAM.
// ---------------------------------------------------------------------------

export async function loadOllamaModel(
  baseUrl: string,
  modelName: string,
  keepAlive: string = '30m',
): Promise<boolean> {
  try {
    const apiHost = ollamaApiHost(baseUrl);
    const response = await fetch(`${apiHost}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelName,
        keep_alive: keepAlive,
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) return false;
    // Ollama streams the response even for empty prompts; consume it fully
    await response.text();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Ollama Unload Model  (POST /api/generate with keep_alive=0)
// keep_alive must be the number 0, not a string.
// ---------------------------------------------------------------------------

export async function unloadOllamaModel(
  baseUrl: string,
  modelName: string,
): Promise<boolean> {
  try {
    const apiHost = ollamaApiHost(baseUrl);
    const response = await fetch(`${apiHost}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelName,
        keep_alive: 0,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return false;
    await response.text();
    return true;
  } catch {
    return false;
  }
}
