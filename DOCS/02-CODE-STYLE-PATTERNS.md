# Code Style & Patterns

---

## Table of Contents

- [1. Naming Conventions](#1-naming-conventions)
- [2. File & Module Organization](#2-file--module-organization)
- [3. Design Patterns in Use](#3-design-patterns-in-use)
- [4. Import Order & Style](#4-import-order--style)
- [5. Error Handling Strategy](#5-error-handling-strategy)
- [6. Async Patterns](#6-async-patterns)
- [7. Type System Usage](#7-type-system-usage)
- [8. Configuration Management](#8-configuration-management)

---

## 1. Naming Conventions

| Entity | Convention | Example |
|--------|------------|---------|
| Files | kebab-case | `agent-service.ts`, `use-editor-store.ts` |
| Components | PascalCase | `MainLayout.tsx`, `ChatPanel.tsx` |
| Classes | PascalCase | `AgentService`, `ProviderRegistry` |
| Interfaces | PascalCase | `IProvider`, `AgentConfig` |
| Type aliases | PascalCase | `ToolDefinition`, `Message` |
| Functions | camelCase | `createProvider`, `getAgentService` |
| Variables | camelCase | `activeTabId`, `isLoading` |
| Constants | UPPER_SNAKE_CASE | `LARGE_FILE_THRESHOLD`, `DEFAULT_CONTEXT_WINDOWS` |
| Zustand stores | camelCase prefix `use` | `useEditorStore`, `useSettingsStore` |
| React hooks | camelCase prefix `use` | `useAutoSave`, `useWorkspaceBootstrap` |
| Enum members | UPPER_SNAKE_CASE | `BUILT_IN_THEME_IDS.DARK` |

---

## 2. File & Module Organization

Files are grouped by **feature/domain**, not by type:

```
src/
├── components/
│   ├── agent/          # Agent-related components
│   ├── chat/           # Chat panel components
│   ├── editor/         # Monaco editor wrapper
│   └── ...
├── services/           # Business logic
├── store/              # Zustand stores
├── hooks/              # React hooks
├── tools/              # AI tool system
├── types/              # TypeScript types
└── lib/                # Utility functions
```

Each feature folder contains its own index barrel file for clean imports.

---

## 3. Design Patterns in Use

| Pattern | Where Used | Purpose |
|---------|------------|---------|
| **Singleton** | `AgentService`, `ProviderRegistry` | Global service instances |
| **Factory** | `createProvider()` | Provider instantiation by type |
| **Observer** | Zustand stores | Reactive state updates |
| **Command** | Tauri invoke handlers | Decoupled backend operations |
| **Repository** | `src-tauri/src/db/repositories/` | Data access abstraction |
| **Provider/Preset** | `provider-presets.ts` | Centralized provider config |

---

## 4. Import Order & Style

Standard import grouping (from `src/services/agent-service.ts`):

```typescript
// 1. External libraries
import { invoke } from "@tauri-apps/api/core";

// 2. Internal absolute imports
import { getToolsForModel } from "../tools";
import type { ToolDefinition } from "../tools/types";

// 3. Relative imports from same directory
import { AgentToolRunner } from "./agent-tool-runner";
import type { AgentConfig } from "./agent-service.types";
```

Barrel files re-export selectively:

```typescript
// src/services/index.ts
export * from './providers';
export { AgentService, getAgentService } from './agent-service';
export type { AgentConfig } from './agent-service.types';
```

---

## 5. Error Handling Strategy

Frontend: Try/catch with user-friendly messages via callbacks:

```typescript
// From AgentService
private getProvider(): IProvider {
  if (!this.provider) {
    throw new Error("Provider not initialized. Call setProvider first.");
  }
  return this.provider;
}

// Async with callback error handling
await provider.streamChat(params, {
  onError: (error) => callbacks.onError?.(error),
});
```

Rust: Result types with explicit error mapping:

```rust
// From context/types.rs
pub fn get_final_response(&self) -> Option<&str> {
    self.rounds.last().map(|r| r.response.as_str())
}
```

---

## 6. Async Patterns

**async/await** throughout. No callbacks except for streaming:

```typescript
// From agent-service.ts
public async chat(
  userMessage: string,
  callbacks: AgentCallbacks,
): Promise<AgentResponse> {
  const preparedContext = await this.prepareAgentContext(...);
  
  while (this.isRunning && iteration < this.config.maxToolIterations!) {
    const response = await provider.streamChat(params, {
      onToken: callbacks.onToken,
      onThinking: callbacks.onThinking,
    });
    // ...
  }
}
```

**Streaming callbacks** for real-time updates during long operations.

**Tauri invoke pattern** for Rust backend communication:

```typescript
// Async invoke with type safety
const result = await invoke<T>("command_name", { arg1, arg2 });

// Error handling for Rust errors
try {
  await invoke("write_file_content", { path, content });
} catch (error) {
  console.error("Failed to write file:", error);
}
```

---

## 7. Type System Usage

**Strict mode enabled.** Interfaces for object shapes, types for unions:

```typescript
// From src/types/index.ts
export interface Tab {
  id: string;
  path: string;
  filename: string;
  content: string;
  isDirty: boolean;
  language: string;
  type?: 'file' | 'browser';
}

export type TimelineEventType = 'thinking' | 'tool' | 'content';
```

**Generics** for reusable patterns:

```typescript
// From provider types
export interface StreamCallbacks<T> {
  onToken: (token: string) => void;
  onComplete: (response: T) => void;
}
```

**Discriminated unions** for message types:

```typescript
export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };
```

---

## 8. Configuration Management

Settings stored in SQLite via Tauri commands. Access via Zustand stores:

```typescript
// From useSettingsStore.ts
export const useSettingsStore = create<SettingsState>((set, get) => ({
  // State from DB
  providers: [],
  selectedModel: '',
  autoApproveTools: false,
  
  // Initialize from database on app start
  initializeFromDatabase: async () => {
    const settings = await databaseService.getSettings();
    set({ /* ... */ });
  },
  
  // Persist changes back to DB
  saveToDatabase: async () => {
    await databaseService.saveSettings(get());
  },
}));
```

Provider presets are static configuration in `provider-presets.ts`:

```typescript
export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  openai: { baseFormat: 'openai', authType: 'bearer', ... },
  anthropic: { baseFormat: 'anthropic', authType: 'x-api-key', ... },
};
```

### Performance Thresholds

File size thresholds for editor performance optimization (in `useEditorStore.ts`):

| Threshold | Size | Behavior |
|-----------|------|----------|
| `LARGE_FILE_THRESHOLD` | 100KB | Disable features, use plaintext |
| `MEDIUM_FILE_THRESHOLD` | 50KB | Reduced features, keep syntax |
