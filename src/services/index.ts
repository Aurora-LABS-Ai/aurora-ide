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
} from './agent-service';

export type {
  AgentConfig,
  AgentCallbacks,
  AgentResponse
} from './agent-service';

export * from './agent-prompt';
export * from './prompt-assets';
export * from './skills';

// Multi-File Service
export { multiFileService, MultiFileService } from './multi-file-service';

export type { FileReadResult, MultiFileReadResult } from './multi-file-service';

// Thread Service (Rust-backed per-message persistence)
export { threadService } from './thread-service';
export type {
  ThreadSummary,
  TokenUsage,
  ContextUsage,
  DbMessage,
  DbThread,
  ApiMessage,
} from './thread-service';

// Token Service (Rust-backed tiktoken)
export { tokenService } from './token-service';
export type { TokenCount, ChatMessageForCount } from './token-service';
