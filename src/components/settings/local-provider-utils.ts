import type { DetectionResult, LocalModel, LocalProvider } from '../../services/local-model-detector';
import type { SettingsSelectOption } from '../ui/SettingsSelect';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DetectionPhase = 'idle' | 'scanning' | 'done';

export interface ActiveConnection {
  type: string;
  model: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const THINKING_PATTERNS = ['qwen3', 'qwq', 'deepseek-r1', 'phi-4-reasoning'];

export const DEFAULT_BASES = new Set([
  'http://localhost:11434/v1',
  'http://localhost:1234/v1',
]);

// ---------------------------------------------------------------------------
// Module-level detection cache
// Persists across modal open/close cycles so reopening the settings tab
// does NOT trigger a full rescan with a loading spinner.
// ---------------------------------------------------------------------------

let _cachedDetection: DetectionResult | null = null;
let _cachedCustomResult: LocalProvider | null = null;
let _lastDetectionTime = 0;
const CACHE_TTL_MS = 120_000;

export function getCachedDetection(): DetectionResult | null {
  return _cachedDetection;
}

export function getCachedCustomResult(): LocalProvider | null {
  return _cachedCustomResult;
}

export function isCacheFresh(): boolean {
  return !!_cachedDetection && (Date.now() - _lastDetectionTime) < CACHE_TTL_MS;
}

export function setCachedDetection(
  result: DetectionResult,
  customResult: LocalProvider | null,
): void {
  _cachedDetection = result;
  _cachedCustomResult = customResult;
  _lastDetectionTime = Date.now();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isThinkingModel(model: LocalModel): boolean {
  if (typeof model.supportsThinking === "boolean") {
    return model.supportsThinking;
  }
  const lower = model.id.toLowerCase();
  return THINKING_PATTERNS.some((p) => lower.includes(p));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function modelToSelectOption(m: LocalModel): SettingsSelectOption {
  const descParts: string[] = [];
  if (m.family) descParts.push(m.family);
  if (m.parameterSize) descParts.push(m.parameterSize);

  const metaParts: string[] = [];
  if (m.quantization) metaParts.push(m.quantization);
  if (m.size) metaParts.push(m.size);

  return {
    value: m.id,
    label: m.id,
    description: descParts.join(' · ') || undefined,
    meta: metaParts.join(' · ') || undefined,
  };
}
