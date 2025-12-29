# Enterprise-Grade Context Builder - Task Tracking

This document tracks all implementation tasks for the enterprise-grade context builder system.

---

## Completed Tasks

### 1. Circular Context Window UI ✅

**Completed:** Color thresholds fixed
- Cold (cyan) until 30%
- Yellow from 30% to 80%
- Red after 80%

**Files updated:**
- `src/components/chat/ContextUsageIndicator.tsx`

---

### 2. Conversation Threads with Full Persistence ✅

**Completed:** Full token/context usage persistence

**2.1 DB Schema Updates:**
- Added `token_usage` field to threads table
- Added `context_usage` field to threads table
- Bumped schema version to 3
- Created migration v3

**Files updated:**
- `src-tauri/src/db/schema.rs`
- `src-tauri/src/db/migrations.rs`
- `src-tauri/src/db/models.rs` (added TokenUsage, ContextUsage structs)
- `src-tauri/src/db/repositories/threads.rs`

**2.2 Thread Store Updates:**
- Added TokenUsage and ContextUsage types
- Added `updateThreadUsage()` method
- Auto-saves token/context usage to DB

**Files updated:**
- `src/store/useThreadStore.ts`
- `src/lib/tauri.ts` (added DbTokenUsage, DbContextUsage types)

**2.3 Detached Window Thread Sync:**
- Already implemented via `useWindowStateSync` hook
- Both windows share same thread UUID

**Files verified:**
- `src/hooks/useWindowStateSync.ts`
- `src/hooks/useDetachedChatWindow.ts`

---

### 3. Modular API Provider System ✅

**Completed:** Enterprise-grade modular provider architecture

**3.1 Provider Types & Interface:**
- Complete type system for all providers
- ContentBlock types (text, thinking, tool_use, tool_result, image)
- Message types with KiloCode-style context management fields

**Files created:**
- `src/services/providers/types.ts`

**3.2 Base Provider:**
- Abstract base class with common functionality
- Token counting integration
- Abort handling
- Context window from config

**Files created:**
- `src/services/providers/base-provider.ts`

**3.3 Token Counter (Enterprise):**
- Character-based estimation with content type detection
- 1.5x fudge factor for accuracy
- Handles text, code, JSON, images
- Request/history token estimation

**Files created:**
- `src/services/providers/token-counter.ts`

**3.4 OpenAI Provider:**
- Full OpenAI-compatible API support
- DeepSeek support (with reasoning)
- GLM/Z.AI support (with thinking)
- Streaming with usage tracking
- Custom base URL support

**Files created:**
- `src/services/providers/openai-provider.ts`

**3.5 Anthropic Provider:**
- Native Claude API format
- Extended thinking blocks
- Tool use with native format
- Streaming with content block deltas
- MiniMax M2.1 compatibility
- Custom base URL support

**Files created:**
- `src/services/providers/anthropic-provider.ts`

**3.6 Context Manager (Enterprise):**
- KiloCode-style context management
- Sliding window truncation
- Non-destructive message tagging
- Rewind capability
- 10% buffer zone
- Force reduction on overflow

**Files created:**
- `src/services/providers/context-manager.ts`

**3.7 Provider Registry:**
- Central provider management
- Auto-detection of provider type
- Default context windows for known models
- Singleton pattern

**Files created:**
- `src/services/providers/index.ts`

---

### 4. Wire Context Window from DB ✅

**Completed:** Provider system reads context window from DB config

- Provider config includes `contextWindow` from DB
- `getContextWindow()` method on all providers
- Default context windows defined in provider registry
- Agent reads from provider config

**Files updated:**
- `src/services/providers/base-provider.ts` (getContextWindow method)
- `src/services/providers/index.ts` (DEFAULT_CONTEXT_WINDOWS)

---

### 5. Documentation Updates ✅

**Completed:** Full Anthropic provider documentation

- CLAUDE.md updated with provider architecture
- Anthropic streaming format documented
- Context window handling documented
- Provider-specific notes added

**Files updated:**
- `CLAUDE.md`

---

### 6. Detached Window Thread Sync ✅

**Verified:** Already implemented and working

- `useWindowStateSync` syncs thread state across windows
- Both windows share same thread UUID
- State sync includes threads, chat, tasks

**Files verified:**
- `src/hooks/useWindowStateSync.ts`
- `src/hooks/useDetachedChatWindow.ts`

---

### 7. Settings Panel Updates ✅

**Completed:** Full provider type support in settings UI

**7.1 Anthropic Preset Provider:**
- Added Anthropic as a preset provider
- Models: claude-opus-4-5, claude-sonnet-4, claude-3-5-sonnet, claude-3-5-haiku
- Context window: 200k, Max output: 8192
- Thinking mode supported

**Files updated:**
- `src/store/useSettingsStore.ts` (PRESET_PROVIDERS, added 'minimax' to providerType)

**7.2 Provider Type Dropdown:**
- Added API Format dropdown to AddProviderForm (OpenAI/Anthropic/Custom)
- Added API Format dropdown to ProviderCard for custom providers
- Updated default context window to 200k
- Updated default max output tokens to 8192

**Files updated:**
- `src/components/modals/SettingsPanel.tsx`

---

### 8. MiniMax M2.1 Provider & Per-Provider Settings ✅

**Completed:** Professional per-provider settings architecture

**8.1 MiniMax M2.1 Preset Provider:**
- Added MiniMax M2.1 as preset provider
- Uses Anthropic-compatible API (`https://api.minimax.io/anthropic`)
- Model: `MiniMax-M2.1`
- Context window: 1M tokens (1,000,000)
- Interleaved thinking support

**8.2 Per-Provider Settings (Professional Architecture):**
- Removed global `thinkingEnabled`, `temperature`, `maxTokens` settings
- Each provider now uses its own:
  - `supportsThinking` - whether thinking mode is available
  - `defaultTemperature` - provider's optimal temperature
  - `defaultMaxTokens` - provider's default output tokens
- ChatPanel now reads from provider config instead of global settings

**8.3 Removed Thinking Tab:**
- Removed unnecessary "Thinking" tab from Settings
- Settings now has 3 tabs: Providers, Tools, General
- Temperature/maxTokens are per-provider, not global

**8.4 Tool Iterations:**
- `maxToolCallsPerRequest` setting is properly wired
- Agent service respects this limit in tool execution loop
- Configurable in Tools tab (default: 25)

**Files updated:**
- `src/store/useSettingsStore.ts` (added MiniMax preset, 5 providers total)
- `src/components/chat/ChatPanel.tsx` (uses provider settings)
- `src/components/modals/SettingsPanel.tsx` (removed Thinking tab)

---

## All Tasks Complete

The enterprise-grade context builder system is now **FULLY WIRED** and ready for production:

1. **Context Builder** (`src/services/context-builder.ts`) - Ready for Cursor-style context
2. **Context Manager** (`src/services/providers/context-manager.ts`) - Ready for KiloCode-style context management
3. **Provider System** (`src/services/providers/`) - Complete with 5 providers (GLM, Anthropic, MiniMax, DeepSeek, OpenAI)
4. **Settings UI** - Professional per-provider settings, no global overrides
5. **Tool Iterations** - Properly wired via `maxToolCallsPerRequest`
6. **Agent Service** - **NOW USES ENTERPRISE PROVIDER SYSTEM** ✅

---

### 9. Agent Service Migration to Enterprise Providers ✅

**Completed:** Full migration from legacy provider to enterprise system with Tauri CORS bypass

**9.1 Agent Service Updates:**
- Removed dependency on legacy `llm-provider.ts`
- Now uses enterprise `createProvider()` from `src/services/providers/`
- Provider set via `agent.setProvider(providerConfig)`
- Supports all provider types (OpenAI, Anthropic, DeepSeek, GLM, MiniMax)

**9.2 Service Exports:**
- `src/services/index.ts` now exports enterprise providers
- Removed legacy `LLMProvider` exports
- Clean enterprise-grade architecture

**9.3 ChatPanel Integration:**
- `ChatPanel.tsx` builds `ProviderConfig` from settings
- Calls `agent.setProvider(config)` before each request
- All provider types now work correctly (including MiniMax with Anthropic format)

**9.4 Tauri CORS Bypass (CRITICAL FIX):**
- ✅ `BaseProvider` uses `invoke('llm_request')` instead of browser `fetch()`
- ✅ `AnthropicProvider.streamChat()` uses `invoke('llm_stream_request')` with Tauri events
- ✅ `OpenAIProvider.streamChat()` uses `invoke('llm_stream_request')` with Tauri events
- ✅ All API calls go through Rust HTTP (no CORS issues)
- ✅ Works for all providers (MiniMax, Claude, GLM, DeepSeek, OpenAI)

**Files updated:**
- `src/services/agent-service.ts` (full enterprise migration)
- `src/services/index.ts` (export enterprise providers)
- `src/components/chat/ChatPanel.tsx` (use ProviderConfig)
- `src/services/providers/base-provider.ts` (Tauri HTTP for non-streaming)
- `src/services/providers/anthropic-provider.ts` (Tauri streaming)
- `src/services/providers/openai-provider.ts` (Tauri streaming - RECREATED)

**Benefits:**
- ✅ MiniMax now uses correct Anthropic endpoint (`/messages` not `/chat/completions`)
- ✅ All providers route correctly (OpenAI, Anthropic, DeepSeek, GLM, MiniMax)
- ✅ Thinking mode works for all supported providers
- ✅ **NO CORS ERRORS** - all requests go through Tauri/Rust
- ✅ Clean, modular architecture
- ✅ Easy to add new providers

---

## Architecture Notes

### Provider Type Detection
```typescript
type ProviderType = 'openai' | 'anthropic' | 'deepseek' | 'glm' | 'minimax' | 'custom'
```

### Context Window Colors
```
0-30%:   Cold (blue/cyan) - #22d3ee (cyan-400) or #3b82f6 (blue-500)
30-80%:  Slow yellow gradient - #fbbf24 (amber-400) to #f59e0b (amber-500)
80-100%: Red warning - #ef4444 (red-500)
```

### Thread Persistence Schema
```sql
ALTER TABLE threads ADD COLUMN token_usage TEXT;    -- JSON
ALTER TABLE threads ADD COLUMN context_usage TEXT;  -- JSON
```

### Provider Interface
```typescript
interface LLMProviderInterface {
  streamChat(messages: ChatMessage[], callbacks: StreamCallbacks): Promise<AssistantMessage>
  getContextWindow(): number
  getMaxOutputTokens(): number
  supportsThinking(): boolean
  supportsToolStream(): boolean
}
```
