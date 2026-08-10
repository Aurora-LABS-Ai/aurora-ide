/**
 * Services Index
 * Central export for all services
 */

// Enterprise Provider System
export * from './providers';

// Agent Service
export {
  AgentService,
  getAgentService,
  initAgentService
} from '@/apps/agent/services/runtime/agent-service';

export type { PromptOverhead } from '@/apps/agent/services/runtime/agent-service';

export type {
  AgentConfig,
  AgentCallbacks,
  AgentResponse
} from '@/apps/agent/services/runtime/agent-service.types';

export * from '@/apps/agent/services/runtime/agent-prompt';
export * from '@/apps/agent/services/skills/prompt-assets';
export * from '@/apps/agent/services/skills/skills';

// Thread Service (Rust-backed per-message persistence)
export { threadService } from '@/apps/agent/services/threads/thread-service';
export type {
  ThreadSummary,
  TokenUsage,
  ContextUsage,
  DbMessage,
  DbThread,
  ApiMessage,
} from '@/apps/agent/services/threads/thread-service';

// Token Service (Rust-backed tiktoken)
export { tokenService } from '@/apps/agent/services/runtime/token-service';
export type { TokenCount, ChatMessageForCount } from '@/apps/agent/services/runtime/token-service';
