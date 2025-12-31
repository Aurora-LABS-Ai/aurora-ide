# Code Style and Patterns

## Naming Conventions

### Variables and Functions
- **camelCase** for all variables, function names, and object properties
- Boolean variables prefixed with `is`, `has`, `can`, `should`, etc.
- Event handlers prefixed with `handle` or `on`
- React hooks prefixed with `use`

```typescript
// Examples
const userName = "John";
const isLoading = false;
const hasPermission = true;

function handleSubmit() {}
function onFileSelect() {}

const useSettingsStore = create<SettingsState>() => ({});
```

### Types and Interfaces
- **PascalCase** for all type names, interfaces, classes, and enums
- Interface names prefixed with `I` only when necessary to avoid naming conflicts
- Generic type parameters use single uppercase letters (`T`, `U`, `K`, `V`)

```typescript
interface LLMProvider {
  id: string;
  name: string;
}

type ApiResponse<T> = {
  data: T;
  error?: string;
};

enum ProviderType {
  OpenAI = "openai",
  DeepSeek = "deepseek"
}
```

### Files and Directories
- **kebab-case** for file names
- **camelCase** for directory names within `src/`
- React components use **PascalCase** for file names
- Test files end with `.test.ts` or `.test.tsx`

```
src/
├── components/
│   ├── ChatPanel.tsx
│   ├── FileExplorer.tsx
│   └── ui/
│       └── Button.tsx
├── services/
│   ├── database.ts
│   └── llm-provider.ts
└── store/
    └── useSettingsStore.ts
```

### Constants
- **SCREAMING_SNAKE_CASE** for constants
- Group related constants in objects

```typescript
const MAX_TOOL_ITERATIONS = 25;
const PROVIDER_TYPES = {
  OPENAI: "openai",
  DEEPSEEK: "deepseek"
} as const;
```

## Code Organization

### Import Order
1. React imports first
2. Third-party library imports (alphabetically)
3. Internal imports (alphabetically)
4. Type-only imports separated with empty line

```typescript
import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

import { databaseService } from "../services/database";
import type { WorkspaceState } from "../types/database";
```

### File Structure
- **One responsibility per file**
- **Related functionality grouped in directories**
- **Index files** for clean imports from directories

```typescript
// services/index.ts
export { databaseService } from "./database";
export { llmProvider } from "./llm-provider";

// Usage
import { databaseService, llmProvider } from "../services";
```

### Component Organization
- **Custom hooks** for complex logic extraction
- **Utility functions** in separate files
- **Types** defined at the top of component files

```typescript
// hooks/useWorkspaceBootstrap.ts
export function useWorkspaceBootstrap() {
  // Complex initialization logic
}

// components/WorkspaceLoader.tsx
import { useWorkspaceBootstrap } from "../hooks/useWorkspaceBootstrap";

type Props = {
  children: React.ReactNode;
};

export function WorkspaceLoader({ children }: Props) {
  useWorkspaceBootstrap();
  return <>{children}</>;
}
```

## Common Design Patterns

### State Management (Zustand)
- **Store slices** for different domains
- **Actions** return new state instead of mutations
- **Selectors** for computed values
- **Middleware** for persistence and logging

```typescript
interface SettingsState {
  providers: LLMProvider[];
  activeProvider: string | null;

  // Actions
  addProvider: (provider: LLMProvider) => void;
  setActiveProvider: (id: string) => void;

  // Computed
  getActiveProvider: () => LLMProvider | undefined;
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  providers: [],
  activeProvider: null,

  addProvider: (provider) =>
    set((state) => ({
      providers: [...state.providers, provider]
    })),

  setActiveProvider: (id) =>
    set({ activeProvider: id }),

  getActiveProvider: () =>
    get().providers.find(p => p.id === get().activeProvider)
}));
```

### Service Layer Pattern
- **Singleton services** for shared functionality
- **Async methods** with proper error handling
- **Type-safe APIs** with TypeScript

```typescript
class DatabaseService {
  async saveWorkspaceState(state: WorkspaceState): Promise<void> {
    await invoke('save_workspace_state', { state });
  }

  async getWorkspaceState(path?: string): Promise<WorkspaceState | null> {
    try {
      const result = await invoke<WorkspaceState | null>('get_workspace_state', {
        workspacePath: path ?? null,
      });
      return result;
    } catch (error) {
      console.error('Failed to get workspace state:', error);
      return null;
    }
  }
}

export const databaseService = new DatabaseService();
```

### Repository Pattern (Rust Backend)
- **Repository interfaces** for data access
- **Error handling** with custom error types
- **Async operations** with proper error propagation

```rust
// repositories/workspace.rs
pub struct WorkspaceRepository<'a> {
    db: &'a Connection,
}

impl<'a> WorkspaceRepository<'a> {
    pub fn save(&self, state: &WorkspaceState) -> Result<(), DbError> {
        // Implementation
        Ok(())
    }

    pub fn get(&self, workspace_path: Option<&str>) -> Result<Option<WorkspaceState>, DbError> {
        // Implementation
        Ok(None)
    }
}
```

### Error Handling

#### Frontend Error Handling
- **Try-catch blocks** around async operations
- **User-friendly error messages**
- **Graceful degradation** when operations fail
- **Logging** for debugging

```typescript
async function loadWorkspace() {
  try {
    const state = await databaseService.getWorkspaceState();
    if (state) {
      // Update store with loaded state
    }
  } catch (error) {
    console.error('Failed to load workspace:', error);
    // Show user-friendly error or continue with defaults
  }
}
```

#### Backend Error Handling (Rust)
- **Custom error enums** with `thiserror`
- **Result types** for all fallible operations
- **Proper error propagation** up the call stack

```rust
#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("Serialization error: {0}")]
    Serialization(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Migration error: {0}")]
    Migration(String),
}

pub type Result<T> = std::result::Result<T, DbError>;
```

### Logging Strategy
- **Console logging** for development
- **Structured logging** with context
- **Error logging** with stack traces
- **Performance logging** for slow operations

```typescript
// Debug logging
console.debug('Loading workspace state for:', workspacePath);

// Error logging with context
console.error('Failed to save editor state:', {
  filePath,
  error: error.message,
  stack: error.stack
});

// Performance logging
const startTime = performance.now();
// ... operation
const duration = performance.now() - startTime;
console.log(`Operation completed in ${duration}ms`);
```

## Testing Patterns

### Test File Organization
- **Colocated tests** next to implementation files
- **Test file naming**: `*.test.ts` or `*.test.tsx`
- **Test directory structure** mirrors source structure

### Testing Framework Configuration (Vitest)
```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
```

### Test Patterns
- **Describe blocks** for grouping related tests
- **Arrange-Act-Assert** pattern
- **Mock external dependencies**
- **Test both success and error cases**

```typescript
describe('DatabaseService', () => {
  describe('getWorkspaceState', () => {
    it('should return workspace state when found', async () => {
      // Arrange
      const mockState = { /* mock data */ };
      vi.mocked(invoke).mockResolvedValue(mockState);

      // Act
      const result = await databaseService.getWorkspaceState('/path');

      // Assert
      expect(result).toEqual(mockState);
      expect(invoke).toHaveBeenCalledWith('get_workspace_state', {
        workspacePath: '/path'
      });
    });

    it('should return null when workspace not found', async () => {
      // Arrange
      vi.mocked(invoke).mockRejectedValue(new Error('Not found'));

      // Act
      const result = await databaseService.getWorkspaceState('/path');

      // Assert
      expect(result).toBeNull();
    });
  });
});
```

## Formatting Standards

### TypeScript/React Formatting
- **4 spaces** for indentation (configured in Prettier)
- **Single quotes** for strings
- **Semicolons** always required
- **Trailing commas** in multi-line structures
- **Max line length**: 100 characters

### Prettier Configuration
```json
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 4,
  "printWidth": 100,
  "trailingComma": "all"
}
```

### ESLint Configuration
- **React hooks rules** enabled
- **TypeScript strict rules** enabled
- **Import sorting** enforced

## Theming and Styling Rules

### Absolute Prohibition of Hardcoded Styles
❌ **NEVER use hardcoded colors or styles:**
```typescript
// FORBIDDEN - Hardcoded inline styles
<div style={{ backgroundColor: '#1e1e1e', color: '#ffffff' }} />

// FORBIDDEN - Hardcoded Tailwind classes
<div className="bg-gray-800 text-white border-gray-600" />

// FORBIDDEN - Hardcoded CSS-in-JS
const styles = {
  container: { background: '#252526', color: '#cccccc' }
};
```

✅ **ALWAYS use theme tokens via CSS variables:**
```typescript
// CORRECT - CSS variable usage (recommended approach)
<div className="bg-[var(--aurora-editor-background)] text-[var(--aurora-editor-foreground)]" />

// CORRECT - JavaScript object access
import { useTheme } from '../hooks/useTheme';
const theme = useTheme();
<div style={{
  backgroundColor: theme.colors.editor.background,
  color: theme.colors.editor.foreground
}} />
```

### CSS Variable Naming Convention
Theme tokens are converted to CSS variables following the pattern:
- **Token name**: `primaryHover` → `primary-hover`
- **CSS variable**: `--aurora-{category}-{token}`
- **Full example**: `primaryHover` → `--aurora-common-primary-hover`

### Common CSS Variable Examples
```css
/* Editor colors */
--aurora-editor-background: #0d0d0d;
--aurora-editor-foreground: #e4e4e7;
--aurora-editor-cursor: #10b981;

/* Common semantic colors */
--aurora-common-primary: #10b981;
--aurora-common-primary-hover: #059669;
--aurora-common-error: #ef4444;

/* Sidebar colors */
--aurora-sidebar-background: #111111;
--aurora-sidebar-item-hover: #ffffff0d;
```

### Component Styling Checklist
Before committing any component, verify:

- [ ] **No hardcoded colors** in styles or className
- [ ] **No hardcoded Tailwind utility classes** for colors
- [ ] **All colors sourced from theme tokens**
- [ ] **Hover/focus states use theme variants**
- [ ] **Component tested with multiple themes**
- [ ] **Accessible contrast ratios maintained**

### Theme-Aware Component Template
```typescript
import React from 'react';
import { useTheme } from '../hooks/useTheme';

interface MyComponentProps {
  variant?: 'default' | 'active' | 'error';
  children: React.ReactNode;
}

export function MyComponent({ variant = 'default', children }: MyComponentProps) {
  const theme = useTheme();

  const getVariantStyles = () => {
    switch (variant) {
      case 'active':
        return {
          backgroundColor: theme.colors.common.primary,
          color: theme.colors.common.primaryForeground
        };
      case 'error':
        return {
          backgroundColor: theme.colors.common.error,
          color: theme.colors.common.errorForeground || theme.colors.common.primaryForeground
        };
      default:
        return {
          backgroundColor: theme.colors.sidebar.background,
          color: theme.colors.sidebar.foreground
        };
    }
  };

  return (
    <div style={getVariantStyles()}>
      {children}
    </div>
  );
}
```

### Theme Testing Requirements
- **Test components with dark and light themes**
- **Verify accessibility contrast ratios**
- **Test theme switching during runtime**
- **Validate all interactive states (hover, focus, active)**

## Comments and Documentation

### JSDoc Comments
- **All public APIs** must have JSDoc comments
- **Parameter types and descriptions**
- **Return type documentation**
- **Example usage** for complex functions

```typescript
/**
 * Save workspace state (open tabs, panel layout, etc.)
 * @param state - The workspace state to save
 */
async saveWorkspaceState(state: WorkspaceState): Promise<void> {
  await invoke('save_workspace_state', { state });
}
```

### Inline Comments
- **Complex logic** explanations
- **TODO/FIXME** markers for future work
- **Why comments** for non-obvious decisions

```typescript
// TODO: Implement caching for frequently accessed files
// This is needed to improve performance for large workspaces

// Using invoke instead of direct database access for thread safety
await invoke('save_workspace_state', { state });
```

### Code Section Organization
- **Large files** divided into sections with comment headers
- **Related functionality** grouped together
- **Clear visual separation**

```typescript
// ============================================================
// WORKSPACE STATE
// ============================================================

/**
 * Save workspace state (open tabs, panel layout, etc.)
 */
async saveWorkspaceState(state: WorkspaceState): Promise<void> {
  // Implementation
}

// ============================================================
// EDITOR STATE
// ============================================================

/**
 * Save editor state for a file (cursor position, scroll offset, folds)
 */
async saveEditorState(filePath: string, state: EditorState): Promise<void> {
  // Implementation
}
```

## Performance Considerations

### React Optimization Patterns
- **Memoization** with `useMemo` for expensive computations
- **Callback memoization** with `useCallback` for event handlers
- **Component memoization** with `React.memo` for pure components

```typescript
const expensiveValue = useMemo(() => {
  return computeExpensiveValue(dependencies);
}, [dependencies]);

const handleClick = useCallback(() => {
  doSomething();
}, [dependencies]);
```

### Database Optimization
- **Connection pooling** (handled by Tauri/rusqlite)
- **Prepared statements** for repeated queries
- **WAL mode** for concurrent reads/writes
- **Indexes** on frequently queried columns

### Bundle Optimization
- **Code splitting** with dynamic imports
- **Tree shaking** enabled by default with Vite
- **Lazy loading** for heavy components

```typescript
const HeavyComponent = lazy(() => import('./HeavyComponent'));

// In render
<Suspense fallback={<div>Loading...</div>}>
  <HeavyComponent />
</Suspense>
```

## Configuration Management

### Environment Variables
- **Build-time configuration** via Vite env vars
- **Runtime configuration** via settings store
- **Development vs production** differences handled appropriately

### Settings Storage
- **Database** for user settings and state
- **localStorage** for temporary UI state
- **File system** for thread persistence (.aurora/threads/)

```typescript
// Database for persistent settings
await databaseService.saveAppSettings(settings);

// localStorage for UI state
localStorage.setItem('aurora-ui-theme', 'dark');

// File system for threads
const threadPath = `.aurora/threads/${threadId}.json`;
await writeTextFile(threadPath, JSON.stringify(thread));
```
