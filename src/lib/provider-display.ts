const PROVIDER_NICKNAME_OVERRIDES: Record<string, string> = {
  'Anthropic': 'Claude',
  'Fireworks AI': 'Fireworks',
  'GLM-4.7 (Z.AI)': 'GLM',
  'MiniMax M2.1': 'MiniMax',
};

const MODEL_TOKEN_OVERRIDES: Record<string, string> = {
  api: 'API',
  asr: 'ASR',
  coder: 'Coder',
  deepseek: 'DeepSeek',
  flash: 'Flash',
  glm: 'GLM',
  gpt: 'GPT',
  haiku: 'Haiku',
  instruct: 'Instruct',
  kimi: 'Kimi',
  llama: 'Llama',
  mini: 'Mini',
  minimax: 'MiniMax',
  o1: 'O1',
  ollama: 'Ollama',
  openai: 'OpenAI',
  opus: 'Opus',
  qwen: 'Qwen',
  reasoner: 'Reasoner',
  sonnet: 'Sonnet',
  studio: 'Studio',
  thinking: 'Thinking',
  turbo: 'Turbo',
  vision: 'Vision',
  z: 'Z',
};

const FIREWORKS_MODEL_PREFIX = 'accounts/fireworks/models/';

const formatToken = (token: string): string => {
  if (!token) return '';

  const lower = token.toLowerCase();
  const override = MODEL_TOKEN_OVERRIDES[lower];
  if (override) return override;

  if (/^\d+$/.test(token)) return token;
  if (/^[a-z]\d+$/i.test(token)) return `${token.charAt(0).toUpperCase()}${token.slice(1)}`;
  if (/^\d+p\d+$/i.test(token)) return token.replace(/^(\d+)p(\d+)$/i, '$1.$2');
  if (/^\d+[bk]$/i.test(token)) return token.toUpperCase();

  return token.charAt(0).toUpperCase() + token.slice(1);
};

export const formatProviderNickname = (name: string, nickname?: string | null): string => {
  const trimmed = nickname?.trim();
  if (trimmed) return trimmed;
  return PROVIDER_NICKNAME_OVERRIDES[name] || name;
};

export const formatModelDisplayName = (
  modelId: string,
  alias?: string | null,
): string => {
  const trimmedAlias = alias?.trim();
  if (trimmedAlias) return trimmedAlias;

  const normalizedId = modelId.startsWith(FIREWORKS_MODEL_PREFIX)
    ? modelId.slice(FIREWORKS_MODEL_PREFIX.length)
    : modelId;
  const basename = normalizedId.split('/').pop() || normalizedId;
  const cleaned = basename.replace(/[:_]+/g, '-');

  return cleaned
    .split('-')
    .filter(Boolean)
    .map(formatToken)
    .join(' ');
};
