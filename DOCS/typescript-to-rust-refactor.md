# TypeScript to Rust Refactor Opportunities

> **Purpose**: This document catalogs all TypeScript functionality that currently runs in the frontend but could be moved to Rust for better performance, reliability, and native OS integration.

---

## 📊 Overview

Aurora currently has significant business logic in TypeScript that could benefit from Rust's:
- **Native performance** - No JS runtime overhead
- **Better concurrency** - Tokio async runtime
- **Memory safety** - No garbage collection pauses
- **OS integration** - Direct syscalls, native APIs
- **Single source of truth** - Eliminates frontend/backend sync bugs

---

## 🔴 High Priority (Should Move to Rust)

### 1. Thread & Conversation Management

| TypeScript File | Current Functionality | Why Move to Rust |
|-----------------|----------------------|------------------|
| `src/store/useThreadStore.ts` | Thread CRUD, message storage, persistence | Per-message persistence, crash recovery, multi-window sync |
| `src/services/thread-converter.ts` | UI → API message format conversion | Eliminate JS serialization bugs, single source of truth |
| `src/services/agent-service.ts` | Conversation history management | History should live in Rust DB, not JS memory |

**Rust Location**: `src-tauri/src/services/thread_service.rs` (new)

**Benefits**:
- Messages saved immediately (not after streaming ends)
- No data loss on crash
- Perfect multi-window synchronization
- 1-year+ thread reliability guaranteed

---

### 2. Token Estimation & Context Management

| TypeScript File | Current Functionality | Why Move to Rust |
|-----------------|----------------------|------------------|
| `src/services/token-estimator.ts` | Character-based token estimation | Rust can use actual tokenizers (tiktoken-rs) |
| `src/store/useContextStore.ts` | Context window tracking | Should be computed by Rust from actual data |
| `src/services/providers/token-counter.ts` | Provider-specific counting | Native tokenizer libraries available in Rust |

**Rust Location**: `src-tauri/src/services/token_service.rs` (new)

**Benefits**:
- Accurate token counts using real tokenizers
- 10-100x faster than JS estimation
- No approximation errors

---

### 3. File Operations & Caching

| TypeScript File | Current Functionality | Why Move to Rust |
|-----------------|----------------------|------------------|
| `src/lib/file-cache.ts` | Frontend file content cache | Rust has better memory management |
| `src/services/multi-file-service.ts` | Batch file reading | Native parallel I/O in Rust |
| `src/lib/file-utils.ts` | File path utilities | OS-native path handling |

**Rust Location**: Already partially in `src-tauri/src/commands/mod.rs`

**Benefits**:
- No JS↔Rust serialization overhead for file content
- Native filesystem watching
- Better memory efficiency for large files

---

### 4. Tool Execution System

| TypeScript File | Current Functionality | Why Move to Rust |
|-----------------|----------------------|------------------|
| `src/tools/registry.ts` | Tool registration & execution | Native execution, better error handling |
| `src/tools/executors/*.ts` | File, shell, workspace tools | Already call Rust - eliminate middleman |
| `src/tools/operation-log.ts` | File operation tracking | Should be DB-backed for audit trail |

**Rust Location**: `src-tauri/src/services/tool_service.rs` (new)

**Benefits**:
- Direct execution without JS overhead
- Atomic operations with rollback
- Persistent audit log in SQLite

---

## 🟡 Medium Priority (Good to Move)

### 5. Settings & Configuration

| TypeScript File | Current Functionality | Why Move to Rust |
|-----------------|----------------------|------------------|
| `src/store/useSettingsStore.ts` | App settings, provider configs | Already backed by SQLite - reduce duplication |
| `src/services/database.ts` | Database service wrapper | Thin wrapper, could be direct invoke calls |

**Current State**: Settings already persist to Rust SQLite, but TS maintains duplicate state.

**Improvement**: Make Rust the single source, TS subscribes to changes via events.

---

### 6. Git Integration

| TypeScript File | Current Functionality | Why Move to Rust |
|-----------------|----------------------|------------------|
| `src/store/useGitStore.ts` | Git state management | Reduce JS↔Rust round trips |
| `src/services/git.ts` | Git operations wrapper | Direct git2-rs calls in Rust |

**Current State**: Already uses Rust commands, but maintains duplicate state in JS.

**Improvement**: Git state computed in Rust, pushed to frontend via events.

---

### 7. Semantic Search

| TypeScript File | Current Functionality | Why Move to Rust |
|-----------------|----------------------|------------------|
| `src/store/useSemanticStore.ts` | Index state, search settings | State should live in Rust |
| `src/services/semantic.ts` | Search service wrapper | Thin wrapper over Rust commands |

**Current State**: Core search is in Rust (aurora-semantic crate), but state duplicated in JS.

**Improvement**: Rust owns all state, JS only displays results.

---

## 🟢 Low Priority (Nice to Have)

### 8. Theme Management

| TypeScript File | Current Functionality | Why Move to Rust |
|-----------------|----------------------|------------------|
| `src/store/useThemeStore.ts` | Theme state, custom themes | Already DB-backed |
| `src/services/theme-service.ts` | Theme parsing, validation | Could validate in Rust |

**Current State**: Works fine, themes are small JSON files.

**Potential**: Move VS Code theme parsing to Rust for consistency.

---

### 9. Editor State

| TypeScript File | Current Functionality | Why Move to Rust |
|-----------------|----------------------|------------------|
| `src/store/useEditorStore.ts` | Tab state, cursor positions | Already persists to Rust DB |

**Current State**: Monaco editor requires JS state for real-time editing.

**Note**: Editor state needs to stay in JS for Monaco integration, but persistence is already in Rust.

---

### 10. Task/Todo Management

| TypeScript File | Current Functionality | Why Move to Rust |
|-----------------|----------------------|------------------|
| `src/store/useTaskStore.ts` | Task list display | Simple UI state |
| `src/tools/executors/todo-executors.ts` | Todo tool execution | Could persist to DB |

**Current State**: Tasks are ephemeral per-thread UI state.

**Potential**: Persist tasks to thread in Rust for continuity.

---

## 📈 Current TypeScript → Rust Call Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│                    CURRENT PATTERN (Inefficient)                │
└─────────────────────────────────────────────────────────────────┘

User Action
    │
    ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  React UI   │ ──▶ │   Zustand   │ ──▶ │   Service   │
│  Component  │     │    Store    │     │   (TS)      │
└─────────────┘     └─────────────┘     └─────────────┘
                                              │
                                              │ invoke()
                                              ▼
                                        ┌─────────────┐
                                        │    Rust     │
                                        │   Command   │
                                        └─────────────┘
                                              │
                                              │ return
                                              ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  React UI   │ ◀── │   Zustand   │ ◀── │   Service   │
│  (re-render)│     │  (update)   │     │   (TS)      │
└─────────────┘     └─────────────┘     └─────────────┘

Problems:
- Data duplicated in Zustand AND SQLite
- Race conditions between stores
- Stale closures capture old state
- No atomic operations
```

---

## 📈 Target Pattern (Rust-First)

```
┌─────────────────────────────────────────────────────────────────┐
│                    TARGET PATTERN (Rust-First)                   │
└─────────────────────────────────────────────────────────────────┘

User Action
    │
    ▼
┌─────────────┐
│  React UI   │ ────────────────────────────────────┐
│  Component  │                                     │ invoke()
└─────────────┘                                     ▼
       ▲                                      ┌─────────────┐
       │                                      │    Rust     │
       │ listen()                             │   Service   │
       │                                      └─────────────┘
       │                                            │
       │                                            │ persist
       │                                            ▼
       │                                      ┌─────────────┐
       │                                      │   SQLite    │
       │                                      │     DB      │
       │                                      └─────────────┘
       │                                            │
       │          emit event                        │
       └────────────────────────────────────────────┘

Benefits:
- Single source of truth (SQLite)
- No sync bugs
- Atomic operations
- Multi-window support via events
- Crash recovery guaranteed
```

---

## 📋 Migration Checklist by Store

### Stores That Should Become Read-Only Caches

| Store | Current Lines | Mutations to Remove | Keep |
|-------|--------------|---------------------|------|
| `useThreadStore.ts` | ~400 | addMessageToThread, updateMessageInThread, saveCurrentThread | threads cache, currentThreadId |
| `useSettingsStore.ts` | ~500 | saveProvider, deleteProvider | Read from Rust on init |
| `useGitStore.ts` | ~200 | All fetch operations | Display state only |
| `useSemanticStore.ts` | ~300 | Index management | Search results display |

### Stores That Are Already Correct

| Store | Reason |
|-------|--------|
| `useEditorStore.ts` | Monaco requires JS state |
| `useUiStore.ts` | Pure UI state (modals, panels) |
| `useDragStore.ts` | Pure UI state (drag operations) |
| `useTerminalStore.ts` | PTY handled by Rust plugin |

### Services to Eliminate/Simplify

| Service | Lines | Action |
|---------|-------|--------|
| `thread-converter.ts` | ~150 | **DELETE** - move to Rust |
| `token-estimator.ts` | ~100 | Replace with Rust tokenizer |
| `database.ts` | ~230 | Keep as thin invoke wrapper |
| `semantic.ts` | ~360 | Keep as thin invoke wrapper |
| `git.ts` | ~210 | Keep as thin invoke wrapper |

---

## 🏗️ Recommended Implementation Order

### Phase 1: Thread System (Week 1-2)
1. Move thread management to Rust
2. Move message persistence to Rust
3. Move API history conversion to Rust
4. Delete `thread-converter.ts`

### Phase 2: Token Counting (Week 3)
1. Add tiktoken-rs to Cargo.toml
2. Create Rust token service
3. Replace `token-estimator.ts` with Rust calls
4. Update context tracking

### Phase 3: Tool System (Week 4)
1. Move tool registry to Rust
2. Direct tool execution in Rust
3. Add persistent audit log
4. Remove JS executor middlemen

### Phase 4: State Consolidation (Week 5)
1. Make settings store read-only
2. Make git store event-driven
3. Make semantic store event-driven
4. Remove duplicate state

---

## 📊 Expected Benefits Summary

| Metric | Current (TS-Heavy) | Target (Rust-First) |
|--------|-------------------|---------------------|
| Data Loss Risk | Medium (crash during stream) | None (per-message persist) |
| Multi-Window Sync | Buggy | Perfect |
| Token Estimation | ±20% error | <1% error |
| File Operations | JS overhead | Native speed |
| Memory Usage | Higher (GC) | Lower (manual) |
| Thread Load (1yr old) | Sometimes fails | Always works |
| Code Duplication | High | Low |

---

## 🔗 Related Documents

- [Thread System Future Plan](./future-plan-thread-system.md) - Detailed implementation plan for thread refactor
- [CLAUDE.md](../CLAUDE.md) - Project architecture overview
- [Provider Presets](../src/services/providers/provider-presets.ts) - LLM provider configuration

---

## ✅ Quick Reference: What Stays in TypeScript

These MUST stay in TypeScript:

1. **React Components** - UI rendering
2. **Monaco Editor Integration** - Editor state
3. **UI State** - Modals, panels, drag states
4. **Event Handlers** - User interactions
5. **Styling** - Tailwind, CSS

Everything else is a candidate for Rust migration.
