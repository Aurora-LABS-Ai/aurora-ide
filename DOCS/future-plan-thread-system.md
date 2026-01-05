# Future Plan: Full Rust Thread Service (Option 5)

> **Purpose**: This document provides a comprehensive roadmap for refactoring the thread/conversation management system from TypeScript to Rust. When implementing this plan, developers can follow these steps sequentially without needing to re-analyze the entire codebase.

---

## 📋 Executive Summary

**Goal**: Move all thread management, message persistence, and conversation history from TypeScript (frontend) to Rust (backend) for:
- Per-message persistence (no data loss on crash)
- Single source of truth (eliminates sync bugs)
- Multi-window support via Tauri events
- Rock-solid 1-year+ thread reliability

**Estimated Timeline**: 2-4 weeks

---

## 🎯 Current Architecture (Before)

```
┌─────────────────────────────────────────────────────────────┐
│                     FRONTEND (TypeScript)                    │
├─────────────────────────────────────────────────────────────┤
│  useThreadStore.ts    - Thread state, messages, CRUD        │
│  useChatStore.ts      - Loading state, pending approval     │
│  thread-converter.ts  - UI → API message format             │
│  agent-service.ts     - Conversation history, LLM calls     │
│  ChatPanel.tsx        - Orchestrates everything             │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ invoke() - Only for save/load
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      BACKEND (Rust)                          │
├─────────────────────────────────────────────────────────────┤
│  commands/threads.rs  - Simple CRUD only                    │
│  db/repositories/threads.rs - SQLite access                 │
└─────────────────────────────────────────────────────────────┘
```

---

## 🎯 Target Architecture (After)

```
┌─────────────────────────────────────────────────────────────┐
│                     FRONTEND (TypeScript)                    │
├─────────────────────────────────────────────────────────────┤
│  useThreadStore.ts    - READ-ONLY cache, subscribes to      │
│                         Tauri events                        │
│  useChatStore.ts      - UI-only state (input focus, etc.)   │
│  ChatPanel.tsx        - Pure UI, sends actions to Rust      │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ invoke() - All mutations
                              │ listen() - All updates
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      BACKEND (Rust)                          │
├─────────────────────────────────────────────────────────────┤
│  services/thread_service.rs   - Business logic              │
│  commands/threads.rs          - Tauri command handlers      │
│  db/repositories/threads.rs   - SQLite persistence          │
│  services/api_converter.rs    - UI → API format (Rust!)     │
└─────────────────────────────────────────────────────────────┘
```

---

## 📁 Files to Modify/Create

### TypeScript Files to MODIFY (Frontend)

| File | Current Responsibility | New Responsibility |
|------|----------------------|-------------------|
| `src/store/useThreadStore.ts` | Owns thread state, CRUD, persistence | Read-only cache, subscribes to Rust events |
| `src/store/useChatStore.ts` | Loading state, pending approval | UI-only state (keep minimal) |
| `src/services/thread-converter.ts` | Converts UI → API messages | **DELETE** (move to Rust) |
| `src/services/agent-service.ts` | Manages conversation history | Calls Rust for history, removes local storage |
| `src/components/chat/ChatPanel.tsx` | Orchestrates thread/message flow | Calls Rust commands, listens to events |
| `src/components/chat/ChatInput.tsx` | Sends messages | Calls Rust `thread_add_user_message` |
| `src/components/chat/ThreadHistory.tsx` | Lists/loads threads | Calls Rust, receives updates via events |
| `src/hooks/useRustChatSync.ts` | Basic chat state sync | Expand to full thread sync |
| `src/lib/tauri.ts` | Thread DB functions | Add new thread service functions |

### TypeScript Files to DELETE

| File | Reason |
|------|--------|
| `src/services/thread-converter.ts` | Logic moves to Rust |

### Rust Files to CREATE (Backend)

| File | Purpose |
|------|---------|
| `src-tauri/src/services/mod.rs` | Services module declaration |
| `src-tauri/src/services/thread_service.rs` | **Core thread business logic** |
| `src-tauri/src/services/api_converter.rs` | UI message → API message conversion |
| `src-tauri/src/services/stream_manager.rs` | Manages active streaming responses |

### Rust Files to MODIFY (Backend)

| File | Changes |
|------|---------|
| `src-tauri/src/commands/threads.rs` | Add new commands for full thread management |
| `src-tauri/src/commands/mod.rs` | Export new thread commands |
| `src-tauri/src/db/repositories/threads.rs` | Add per-message operations |
| `src-tauri/src/db/models.rs` | May need new message-level models |
| `src-tauri/src/db/schema.rs` | Potentially add `messages` table |
| `src-tauri/src/db/migrations.rs` | Migration for new schema |
| `src-tauri/src/lib.rs` | Register new commands |

---

## 🔧 Implementation Phases

### Phase 1: Foundation (Week 1, Days 1-3)

#### 1.1 Create Rust Thread Service Structure

**Create**: `src-tauri/src/services/mod.rs`
```
- Declare thread_service module
- Declare api_converter module
- Declare stream_manager module
```

**Create**: `src-tauri/src/services/thread_service.rs`
```
- ThreadService struct with db reference
- create_thread() -> ThreadState
- load_thread(id) -> ThreadState
- delete_thread(id)
- list_threads() -> Vec<ThreadSummary>
- get_thread_messages(id) -> Vec<Message>
```

#### 1.2 Add Per-Message Persistence

**Modify**: `src-tauri/src/db/schema.rs`
```
- Consider: separate messages table for better querying
- Or: keep embedded JSON but add message-level operations
```

**Modify**: `src-tauri/src/db/repositories/threads.rs`
```
- add_message(thread_id, message) -> Message
- update_message(thread_id, message_id, updates)
- get_messages(thread_id) -> Vec<Message>
```

### Phase 2: Message Operations (Week 1, Days 4-5)

#### 2.1 User Message Handling

**Add to**: `src-tauri/src/services/thread_service.rs`
```
- add_user_message(thread_id, content, attachments) -> Message
  - Creates message with UUID
  - Persists immediately to SQLite
  - Updates thread title if first message
  - Emits "thread-message-added" event
```

**Add to**: `src-tauri/src/commands/threads.rs`
```
#[tauri::command]
fn thread_add_user_message(thread_id, content, attachments) -> Message
```

#### 2.2 Assistant Response Streaming

**Create**: `src-tauri/src/services/stream_manager.rs`
```
- StreamState struct (tokens, thinking, tool_calls, timeline)
- start_assistant_response(thread_id) -> stream_id
- append_token(stream_id, token)
- append_thinking(stream_id, thinking)
- add_tool_call(stream_id, tool_call)
- complete_tool(stream_id, tool_id, result)
- finalize_response(stream_id) -> Message
```

**Add to**: `src-tauri/src/commands/threads.rs`
```
#[tauri::command]
fn thread_start_response(thread_id) -> String  // returns stream_id

#[tauri::command]
fn thread_append_token(stream_id, token)

#[tauri::command]  
fn thread_append_thinking(stream_id, thinking)

#[tauri::command]
fn thread_add_tool_call(stream_id, tool_call)

#[tauri::command]
fn thread_complete_tool(stream_id, tool_id, result)

#[tauri::command]
fn thread_finalize_response(stream_id) -> Message
```

### Phase 3: API History Conversion (Week 2, Days 1-2)

#### 3.1 Move thread-converter.ts to Rust

**Create**: `src-tauri/src/services/api_converter.rs`
```
- convert_thread_to_api_history(messages: Vec<Message>) -> Vec<ApiMessage>
- extract_from_timeline(timeline: Value) -> (content, reasoning, tool_calls, tool_results)
- ApiMessage enum { User, Assistant, Tool }
```

**Add to**: `src-tauri/src/commands/threads.rs`
```
#[tauri::command]
fn thread_get_api_history(thread_id) -> Vec<ApiMessage>
```

#### 3.2 Update Agent Service

**Modify**: `src/services/agent-service.ts`
```
- Remove local conversationHistory array
- Call invoke('thread_get_api_history', { threadId }) before each request
- Remove setHistory() and getHistory() methods
```

### Phase 4: Frontend Refactor (Week 2, Days 3-5)

#### 4.1 Convert useThreadStore to Read-Only Cache

**Modify**: `src/store/useThreadStore.ts`
```
- Remove: All mutation logic (addMessageToThread, updateMessageInThread, etc.)
- Remove: saveCurrentThread, loadThreadFromFile
- Keep: threads cache (read-only)
- Keep: currentThreadId
- Add: Subscribe to Tauri events for updates
- Add: Simple setters that only update local cache (called from event handlers)
```

#### 4.2 Update ChatPanel

**Modify**: `src/components/chat/ChatPanel.tsx`
```
- Replace addMessageToThread() with invoke('thread_add_user_message')
- Replace updateMessageInThread() with invoke('thread_append_token'), etc.
- Listen for 'thread-updated', 'thread-message-added' events
- Remove timeline management (handled by Rust)
```

#### 4.3 Update ThreadHistory

**Modify**: `src/components/chat/ThreadHistory.tsx`
```
- loadAllThreadsFromFiles() -> invoke('thread_list_threads')
- loadThread() -> invoke('thread_load_thread')
- deleteThread() -> invoke('thread_delete_thread')
```

### Phase 5: Event System (Week 3, Days 1-2)

#### 5.1 Implement Tauri Events

**Add to**: `src-tauri/src/services/thread_service.rs`
```
- Emit events after each operation:
  - "thread-created" { thread: ThreadState }
  - "thread-loaded" { thread: ThreadState }
  - "thread-deleted" { thread_id: String }
  - "thread-message-added" { thread_id, message: Message }
  - "thread-message-updated" { thread_id, message_id, updates }
  - "thread-token-received" { thread_id, stream_id, token }
  - "thread-tool-added" { thread_id, stream_id, tool_call }
  - "thread-tool-completed" { thread_id, stream_id, tool_id, result }
```

#### 5.2 Frontend Event Listeners

**Modify**: `src/store/useThreadStore.ts` or create `src/hooks/useThreadSync.ts`
```
- listen('thread-created', updateThreadCache)
- listen('thread-loaded', setCurrentThread)
- listen('thread-message-added', appendMessageToCache)
- listen('thread-token-received', updateStreamingMessage)
- etc.
```

### Phase 6: Cleanup & Testing (Week 3-4)

#### 6.1 Delete Obsolete Code

- Delete `src/services/thread-converter.ts`
- Remove unused functions from `useThreadStore.ts`
- Remove thread-related code from `useChatStore.ts` (keep UI-only state)

#### 6.2 Add Rust Unit Tests

**Create**: `src-tauri/src/services/thread_service_tests.rs`
```
- test_create_thread()
- test_add_user_message()
- test_streaming_response()
- test_api_history_conversion()
- test_thread_persistence()
```

#### 6.3 Integration Testing

- Test multi-window sync
- Test crash recovery
- Test loading threads after long time (1 year simulation)
- Test large threads (1000+ messages)

---

## 🗄️ Database Schema Changes

### Option A: Keep Embedded Messages (Simpler)

No schema change, but add message-level repository methods:
```rust
// Add to threads.rs repository
fn append_message(&self, thread_id: &str, message: &Message) -> DbResult<()>;
fn update_message(&self, thread_id: &str, message_id: &str, updates: MessageUpdate) -> DbResult<()>;
```

### Option B: Separate Messages Table (More Scalable)

```sql
-- New migration
CREATE TABLE thread_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL,  -- 'user', 'assistant', 'system', 'tool'
    content TEXT NOT NULL,
    thinking TEXT,
    timeline TEXT,  -- JSON
    tool_calls TEXT,  -- JSON
    sequence INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(thread_id, sequence)
);

CREATE INDEX idx_thread_messages_thread ON thread_messages(thread_id);
CREATE INDEX idx_thread_messages_sequence ON thread_messages(thread_id, sequence);
```

**Recommendation**: Start with Option A for faster implementation, migrate to Option B if performance issues arise with large threads.

---

## 📡 New Tauri Commands Summary

| Command | Input | Output | Description |
|---------|-------|--------|-------------|
| `thread_create` | - | `ThreadState` | Create new thread |
| `thread_load` | `id` | `ThreadState` | Load thread with messages |
| `thread_delete` | `id` | - | Delete thread |
| `thread_list` | - | `Vec<ThreadSummary>` | List all threads |
| `thread_add_user_message` | `thread_id, content, attachments?` | `Message` | Add user message |
| `thread_start_response` | `thread_id` | `stream_id` | Start assistant response |
| `thread_append_token` | `stream_id, token` | - | Append streaming token |
| `thread_append_thinking` | `stream_id, thinking` | - | Append thinking content |
| `thread_add_tool_call` | `stream_id, tool_call` | - | Add tool call to response |
| `thread_complete_tool` | `stream_id, tool_id, result` | - | Complete tool execution |
| `thread_finalize_response` | `stream_id` | `Message` | Finalize and persist response |
| `thread_get_api_history` | `thread_id` | `Vec<ApiMessage>` | Get API-formatted history |
| `thread_update_title` | `thread_id, title` | - | Update thread title |

---

## 🔄 Migration Strategy

### Step 1: Parallel Implementation
- Build new Rust thread service alongside existing TS code
- Feature flag to switch between old/new implementation

### Step 2: Gradual Migration
- Start with read operations (load, list)
- Then write operations (create, add message)
- Finally streaming operations

### Step 3: Validation
- Compare behavior between old and new
- Ensure data integrity
- Test edge cases

### Step 4: Cutover
- Remove feature flag
- Delete old TS code
- Update documentation

---

## ⚠️ Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Data loss during migration | Backup SQLite DB before any schema changes |
| Breaking existing threads | Write migration that preserves all existing data |
| Performance regression | Benchmark before/after, optimize Rust code |
| Multi-window bugs | Extensive testing with 2+ windows |
| Streaming issues | Keep streaming logic simple, test thoroughly |

---

## 📚 References

- Current thread store: `src/store/useThreadStore.ts`
- Current thread converter: `src/services/thread-converter.ts`
- Current Rust threads: `src-tauri/src/commands/threads.rs`
- Current DB models: `src-tauri/src/db/models.rs`
- Tauri events docs: https://tauri.app/v1/guides/features/events/

---

## ✅ Definition of Done

- [ ] All thread mutations go through Rust commands
- [ ] Per-message persistence (each message saved immediately)
- [ ] API history conversion happens in Rust
- [ ] Multi-window sync works perfectly
- [ ] No data loss on crash/restart
- [ ] Threads load correctly after 1+ year
- [ ] Old thread-converter.ts deleted
- [ ] Unit tests for Rust thread service
- [ ] Integration tests passing
- [ ] Documentation updated
