/**
 * Provider Presets - Centralized Configuration for All LLM Providers
 * 
 * This file contains all provider-specific configurations in one place,
 * eliminating scattered provider-specific checks throughout the codebase.
 * 
 * Each preset defines:
 * - API format (OpenAI vs Anthropic)
 * - Authentication method
 * - Thinking mode configuration
 * - Default parameters
 * - Parameter restrictions
 */

// ============================================================
// TYPES
// ============================================================
export interface ProviderPreset {
  authHeader: string;

  // Authentication
  authType: AuthType;

  // API Format
  baseFormat: BaseFormat;
  chatEndpoint: string;

  // Context defaults
  defaultContextWindow: number;
  defaultMaxOutput: number;

  // Default request parameters for this provider
  defaultParams?: Record<string, unknown>;
  id: string;

  /** Whether to include stream_options in request */
  includeStreamOptions?: boolean;
  name: string;

  // Required headers (besides auth)
  requiredHeaders?: Record<string, string>;

  // Parameter restrictions
  /** Skip temperature for certain models (e.g., DeepSeek reasoner) */
  skipTemperature?: (model: string) => boolean;

  // Thinking Mode
  thinkingConfig?: ThinkingConfig;
}

export interface ThinkingConfig {
  /** Parameter to add to request body to enable thinking */
  requestParam?: Record<string, unknown>;

  /** Field name in response where thinking content appears */
  responseField?: 'reasoning_content' | 'thinking';

  /** Whether thinking is returned as content blocks (Anthropic style) */
  usesContentBlocks?: boolean;
}

export type AuthType = 'bearer' | 'x-api-key';

export type BaseFormat = 'openai' | 'anthropic';

/**
 * Build authentication header based on preset
 */
export function buildAuthHeader(
  preset: ProviderPreset,
  apiKey: string
): Record<string, string> {
  if (!apiKey) return {};

  if (preset.authType === 'bearer') {
    return { [preset.authHeader]: `Bearer ${apiKey}` };
  } else {
    return { [preset.authHeader]: apiKey };
  }
}

/**
 * Build all headers for a request
 */
export function buildRequestHeaders(
  preset: ProviderPreset,
  apiKey: string,
  customHeaders?: Record<string, string>
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...buildAuthHeader(preset, apiKey),
    ...(preset.requiredHeaders || {}),
    ...(customHeaders || {}),
  };
}

/**
 * Build thinking parameters for request body
 */
export function buildThinkingParams(
  preset: ProviderPreset,
  thinkingEnabled: boolean
): Record<string, unknown> {
  if (!thinkingEnabled || !preset.thinkingConfig?.requestParam) {
    return {};
  }
  return preset.thinkingConfig.requestParam;
}

/**
 * Detect provider type from base URL and model
 */
export function detectProviderType(baseUrl: string, model: string): string {
  const url = baseUrl.toLowerCase();
  const modelLower = model.toLowerCase();

  // Anthropic
  if (url.includes('anthropic.com') || modelLower.includes('claude')) {
    return 'anthropic';
  }

  // MiniMax (check before OpenAI since it can use both formats)
  if (url.includes('minimax') || modelLower.includes('minimax')) {
    // If using /anthropic endpoint, use anthropic format
    if (url.includes('/anthropic')) {
      return 'minimax';
    }
    // Otherwise fall through to openai
  }

  // DeepSeek
  if (url.includes('deepseek.com') || modelLower.includes('deepseek')) {
    return 'deepseek';
  }

  // GLM / Z.AI
  if (url.includes('z.ai') || url.includes('zhipuai') || modelLower.includes('glm')) {
    return 'glm';
  }

  // OpenAI
  if (url.includes('openai.com') || modelLower.includes('gpt') || modelLower.includes('o1')) {
    return 'openai';
  }

  // Default to custom
  return 'custom';
}

/**
 * Get the full API URL for chat completions
 */
export function getChatUrl(baseUrl: string, preset: ProviderPreset): string {
  // Remove trailing slash from base URL
  const base = baseUrl.replace(/\/+$/, '');
  
  // If the base URL already ends with the chat endpoint, don't append it again
  // This handles cases where users provide full URLs like:
  // - http://localhost:1234/v1/chat/completions
  // - http://localhost:11434/v1/chat/completions
  const endpoint = preset.chatEndpoint;
  if (base.endsWith(endpoint) || base.endsWith(endpoint.replace(/^\//, ''))) {
    return base;
  }
  
  // If base URL ends with /v1 and endpoint starts with /chat, just append
  // This handles: http://localhost:1234/v1 + /chat/completions
  if (base.endsWith('/v1') && endpoint.startsWith('/chat')) {
    return `${base}${endpoint}`;
  }
  
  // Standard case: append endpoint to base
  return `${base}${endpoint}`;
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Get preset for a provider type
 */
export function getProviderPreset(providerType: string): ProviderPreset {
  return PROVIDER_PRESETS[providerType] || PROVIDER_PRESETS.custom;
}

/**
 * Check if temperature should be skipped for this model
 */
export function shouldSkipTemperature(preset: ProviderPreset, model: string): boolean {
  return preset.skipTemperature?.(model) ?? false;
}

// ============================================================
// PROVIDER PRESETS
// ============================================================
export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  // ============================================
  // GLM / Z.AI (GLM-4.7, GLM-4.6, etc.)
  // ============================================
  glm: {
    id: 'glm',
    name: 'GLM / Z.AI',
    baseFormat: 'openai',
    chatEndpoint: '/chat/completions',
    authType: 'bearer',
    authHeader: 'Authorization',
    thinkingConfig: {
      // GLM-4.7: thinking enabled by default, clear_thinking: false preserves reasoning across turns
      // This enables "Preserved Thinking" for multi-turn conversations
      requestParam: { thinking: { type: 'enabled', clear_thinking: false } },
      responseField: 'reasoning_content',
    },
    // tool_stream is handled in buildRequestBody for GLM models
    defaultParams: {},
    includeStreamOptions: true,
    defaultContextWindow: 200000,
    defaultMaxOutput: 128000,
  },

  // ============================================
  // DeepSeek
  // ============================================
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    baseFormat: 'openai',
    chatEndpoint: '/chat/completions',
    authType: 'bearer',
    authHeader: 'Authorization',
    thinkingConfig: {
      requestParam: { thinking: { type: 'enabled' } },
      responseField: 'reasoning_content',
    },
    // DeepSeek reasoner model ignores temperature
    skipTemperature: (model: string) => model.includes('reasoner'),
    includeStreamOptions: true,
    defaultContextWindow: 64000,
    defaultMaxOutput: 64000,
  },

  // ============================================
  // OpenAI
  // ============================================
  openai: {
    id: 'openai',
    name: 'OpenAI',
    baseFormat: 'openai',
    chatEndpoint: '/chat/completions',
    authType: 'bearer',
    authHeader: 'Authorization',
    // OpenAI doesn't have native thinking mode (except o1 models which are different)
    thinkingConfig: undefined,
    includeStreamOptions: true,
    defaultContextWindow: 128000,
    defaultMaxOutput: 16384,
  },

  // ============================================
  // Anthropic (Claude)
  // ============================================
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    baseFormat: 'anthropic',
    chatEndpoint: '/messages',
    authType: 'x-api-key',
    authHeader: 'x-api-key',
    requiredHeaders: {
      'anthropic-version': '2023-06-01',
    },
    thinkingConfig: {
      // Anthropic returns thinking as content blocks natively
      usesContentBlocks: true,
      responseField: 'thinking',
    },
    defaultContextWindow: 200000,
    defaultMaxOutput: 8192,
  },

  // ============================================
  // MiniMax M2.1 (Anthropic-compatible API)
  // ============================================
  minimax: {
    id: 'minimax',
    name: 'MiniMax M2.1',
    baseFormat: 'anthropic',
    chatEndpoint: '/messages',
    authType: 'x-api-key',
    authHeader: 'x-api-key',
    requiredHeaders: {
      'anthropic-version': '2023-06-01',
    },
    thinkingConfig: {
      // MiniMax returns thinking as content blocks like Anthropic
      usesContentBlocks: true,
      responseField: 'thinking',
    },
    defaultContextWindow: 200000,
    defaultMaxOutput: 128000,
  },

  // ============================================
  // LM Studio (Local OpenAI-compatible server)
  // Uses raw HTTP streaming via Rust for reliable local model support
  // Supports local reasoning models that return `reasoning` field
  // (Rust normalizes both `reasoning` and `reasoning_content` to `reasoning_content`)
  // ============================================
  lmstudio: {
    id: 'lmstudio',
    name: 'LM Studio',
    baseFormat: 'openai',
    chatEndpoint: '/chat/completions',
    authType: 'bearer',
    authHeader: 'Authorization',
    // Support for local reasoning models
    // Note: Different models use different param names - some ignore reasoning_effort
    // but include reasoning in output by default
    thinkingConfig: {
      requestParam: { reasoning_effort: 'high' },
      // Local models use 'reasoning' field, Rust normalizes to reasoning_content
      responseField: 'reasoning_content',
    },
    // LM Studio supports stream_options for usage tracking
    includeStreamOptions: true,
    defaultContextWindow: 128000,
    defaultMaxOutput: 8192,
    // Flag to use native Rust HTTP streaming instead of frontend HTTP fetch
    useNativeOpenAI: true,
  } as ProviderPreset & { useNativeOpenAI?: boolean },

  // ============================================
  // Ollama (Local OpenAI-compatible server)
  // ============================================
  ollama: {
    id: 'ollama',
    name: 'Ollama',
    baseFormat: 'openai',
    chatEndpoint: '/chat/completions',
    authType: 'bearer',
    authHeader: 'Authorization',
    thinkingConfig: undefined,
    includeStreamOptions: false,
    defaultContextWindow: 128000,
    defaultMaxOutput: 8192,
    useNativeOpenAI: true,
  } as ProviderPreset & { useNativeOpenAI?: boolean },

  // ============================================
  // Custom (OpenAI-compatible fallback)
  // ============================================
  custom: {
    id: 'custom',
    name: 'Custom Provider',
    baseFormat: 'openai',
    chatEndpoint: '/chat/completions',
    authType: 'bearer',
    authHeader: 'Authorization',
    // Custom providers can configure thinking via customParams
    thinkingConfig: undefined,
    includeStreamOptions: false, // Don't assume custom providers support this
    defaultContextWindow: 128000,
    defaultMaxOutput: 8192,
  },
};
