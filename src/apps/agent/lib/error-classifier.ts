import { useSettingsStore } from '@/kernel/store/useSettingsStore';

export interface ClassifiedError {
  title: string;
  message: string;
  suggestion: string;
  action?: 'open-settings' | 'retry' | 'check-network';
  actionLabel?: string;
  severity: 'warning' | 'error' | 'info';
}

export function classifyError(error: Error | string): ClassifiedError {
  const msg = typeof error === 'string' ? error : error.message;
  const lower = msg.toLowerCase();

  // A gateway that fans out to several upstreams reports its own failures, not
  // the model's. Both of these are catch-alls, and naming them for what they are
  // is the only honest answer — the alternative is picking one cause off a list
  // and asserting it, which is exactly how a 3%-full conversation came to be
  // called "too long".
  if (lower.includes('all_providers_failed') || lower.includes('upstream unavailable')) {
    return {
      title: 'Provider Unavailable',
      message: 'The gateway could not reach any upstream for this model.',
      suggestion: 'Nothing is wrong with your conversation. Retry, or switch model — the gateway routes each one to a different upstream.',
      action: 'retry',
      actionLabel: 'Try Again',
      severity: 'warning',
    };
  }

  if (lower.includes('upstream_rejected')) {
    return {
      title: 'Provider Rejected the Request',
      message: 'The gateway passed the request upstream and it came back refused, without saying why.',
      suggestion: 'The gateway names three possible causes and picks none: the model id, a request field, or the context length. Retry first — this often follows a dropped upstream. If it repeats, try another model.',
      action: 'retry',
      actionLabel: 'Try Again',
      severity: 'error',
    };
  }

  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid api key') || lower.includes('incorrect api key')) {
    return {
      title: 'Invalid API Key',
      message: 'The AI provider rejected your API key.',
      suggestion: 'Double-check that your API key is correct and hasn\'t expired.',
      action: 'open-settings',
      actionLabel: 'Update API Key',
      severity: 'error',
    };
  }

  if (lower.includes('403') || lower.includes('forbidden') || lower.includes('access denied')) {
    return {
      title: 'Access Denied',
      message: 'Your account doesn\'t have permission to use this model.',
      suggestion: 'Verify your API key has the right permissions, or try a different model.',
      action: 'open-settings',
      actionLabel: 'Check Settings',
      severity: 'error',
    };
  }

  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests')) {
    return {
      title: 'Rate Limit Reached',
      message: 'Too many requests sent to the AI provider.',
      suggestion: 'Wait a moment and try again. If this persists, check your plan\'s rate limits.',
      action: 'retry',
      actionLabel: 'Try Again',
      severity: 'warning',
    };
  }

  if (lower.includes('402') || lower.includes('payment required') || lower.includes('insufficient') || lower.includes('billing')) {
    return {
      title: 'Billing Issue',
      message: 'Your AI provider account needs attention.',
      suggestion: 'Check your provider\'s billing dashboard to ensure your payment method is active.',
      action: 'open-settings',
      actionLabel: 'Check Settings',
      severity: 'error',
    };
  }

  if (lower.includes('500') || lower.includes('internal server error') || lower.includes('server error')) {
    return {
      title: 'Provider Error',
      message: 'The AI provider is experiencing issues.',
      suggestion: 'This is usually temporary. Wait a minute and try again.',
      action: 'retry',
      actionLabel: 'Try Again',
      severity: 'warning',
    };
  }

  if (lower.includes('502') || lower.includes('503') || lower.includes('504') || lower.includes('service unavailable') || lower.includes('gateway')) {
    return {
      title: 'Provider Unavailable',
      message: 'The AI provider is temporarily down or overloaded.',
      suggestion: 'The service should recover shortly. Try again in a few moments.',
      action: 'retry',
      actionLabel: 'Try Again',
      severity: 'warning',
    };
  }

  if (lower.includes('network') || lower.includes('fetch failed') || lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('dns')) {
    return {
      title: 'Connection Failed',
      message: 'Can\'t reach the AI provider.',
      suggestion: 'Check your internet connection. If using a local model, make sure it\'s running.',
      action: 'check-network',
      actionLabel: 'Try Again',
      severity: 'error',
    };
  }

  if (lower.includes('cors') || lower.includes('blocked by') || lower.includes('not allowed by access-control')) {
    return {
      title: 'Connection Blocked',
      message: 'The browser blocked the request to the AI provider.',
      suggestion: 'This provider may need a different base URL or a proxy configuration.',
      action: 'open-settings',
      actionLabel: 'Update Base URL',
      severity: 'error',
    };
  }

  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('deadline exceeded')) {
    return {
      title: 'Request Timed Out',
      message: 'The AI provider took too long to respond.',
      suggestion: 'Try again with a shorter prompt, or check if the provider is experiencing high load.',
      action: 'retry',
      actionLabel: 'Try Again',
      severity: 'warning',
    };
  }

  if (lower.includes('model not found') || lower.includes('does not exist') || lower.includes('invalid model')) {
    return {
      title: 'Model Not Found',
      message: 'The selected model isn\'t available from this provider.',
      suggestion: 'Switch to a different model in the model selector, or check that the model name is correct.',
      action: 'open-settings',
      actionLabel: 'Change Model',
      severity: 'error',
    };
  }

  // OVERFLOW PATTERNS — deliberately specific, and kept in step with the curated
  // Rust list in `agent_runtime/api_client.rs::is_context_overflow`.
  //
  // The bare substring `context length` used to be in here, and it matched the
  // phrase "check the model id, request fields, and context length" — a
  // gateway's list of things it had NOT checked. Aurora then told the reader
  // their conversation was too long while its own ring read 3% of 1M tokens. A
  // needle has to match a claim of overflow, never a mention of the subject.
  const OVERFLOW_PATTERNS = [
    'context_too_large',
    'context_length_exceeded',
    'context length exceeded',
    'exceeds the context window',
    'maximum context length',
    'prompt is too long',
    'input is too long',
    'too many total text bytes',
    'reduce the length of the messages',
    'too many tokens',
  ];
  if (OVERFLOW_PATTERNS.some((needle) => lower.includes(needle))) {
    return {
      title: 'Context Too Large',
      message: 'The conversation is too long for the model\'s context window.',
      suggestion: 'Start a new conversation, or reduce the number of attached files.',
      severity: 'warning',
    };
  }

  return {
    title: 'Something Went Wrong',
    message: msg || 'An unexpected error occurred.',
    suggestion: 'Try again. If the issue persists, check your provider settings.',
    action: 'retry',
    actionLabel: 'Try Again',
    severity: 'error',
  };
}

export function isProviderConfigured(): boolean {
  try {
    const config = useSettingsStore.getState().getLLMConfig();
    return config !== null;
  } catch {
    return false;
  }
}
