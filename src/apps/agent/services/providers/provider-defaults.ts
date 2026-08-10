export const DEFAULT_CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4-turbo': 128000,
  'gpt-4': 8192,
  'gpt-3.5-turbo': 16385,
  'o1': 200000,
  'o1-mini': 128000,
  'gpt-5': 400000,
  'claude-opus-4-5-20251101': 200000,
  'claude-sonnet-4-20250514': 200000,
  'claude-3-opus': 200000,
  'claude-3-sonnet': 200000,
  'claude-3-haiku': 200000,
  'deepseek-chat': 128000,
  'deepseek-reasoner': 128000,
  // DeepSeek V4 ships a 1M-token context window (per the official
  // model card / pricing page). The V3 family above stays at 128K.
  'deepseek-v4-pro': 1000000,
  'deepseek-v4-flash': 1000000,
  'glm-4.7': 200000,
  'glm-4.6': 200000,
  'glm-4.5': 128000,
  'MiniMax-M2.1': 200000,
  'gemini-2.0-flash': 1000000,
  'gemini-3-pro': 1000000,
  default: 200000,
};

const PROVIDER_DEFAULTS: Record<string, { contextWindow: number; maxOutput: number }> = {
  anthropic: { contextWindow: 200000, maxOutput: 8192 },
  custom: { contextWindow: 128000, maxOutput: 8192 },
  // DeepSeek V4 — 1M context, 384K max output. V3 models with a
  // tighter window inherit via DEFAULT_CONTEXT_WINDOWS lookup above.
  deepseek: { contextWindow: 1000000, maxOutput: 384000 },
  fireworks: { contextWindow: 200000, maxOutput: 32768 },
  glm: { contextWindow: 200000, maxOutput: 128000 },
  lmstudio: { contextWindow: 128000, maxOutput: 8192 },
  minimax: { contextWindow: 200000, maxOutput: 128000 },
  ollama: { contextWindow: 128000, maxOutput: 8192 },
  openai: { contextWindow: 128000, maxOutput: 16384 },
  // Responses API targets the reasoning-model families (GPT-5.x),
  // which ship a 400K context window and large output budgets.
  'openai-responses': { contextWindow: 400000, maxOutput: 128000 },
};

export function getDefaultContextWindow(model: string): number {
  if (DEFAULT_CONTEXT_WINDOWS[model]) {
    return DEFAULT_CONTEXT_WINDOWS[model];
  }

  for (const [key, value] of Object.entries(DEFAULT_CONTEXT_WINDOWS)) {
    if (model.toLowerCase().includes(key.toLowerCase())) {
      return value;
    }
  }

  return DEFAULT_CONTEXT_WINDOWS.default;
}

export function getPresetContextWindow(providerType: string): number {
  return PROVIDER_DEFAULTS[providerType]?.contextWindow ?? DEFAULT_CONTEXT_WINDOWS.default;
}

export function getPresetMaxOutput(providerType: string): number {
  return PROVIDER_DEFAULTS[providerType]?.maxOutput ?? 8192;
}
