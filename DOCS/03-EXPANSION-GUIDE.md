# Expansion Guide

## Getting Started

### Development Environment Setup

1. **Prerequisites**
   - Node.js 18+ and pnpm
   - Rust 1.70+ (for Tauri backend)
   - Git

2. **Clone and Install**
   ```bash
   git clone <repository-url>
   cd aurora-agent-frontend
   pnpm install
   ```

3. **Start Development**
   ```bash
   # Frontend only (http://localhost:5173)
   pnpm dev

   # Full Tauri app (recommended for development)
   pnpm tauri:dev
   ```

### Project Structure Overview

```
aurora-agent-frontend/
├── src/
│   ├── components/     # React components (organized by feature)
│   │   ├── agent/      # Agent-related components
│   │   ├── chat/       # Chat interface components
│   │   ├── editor/     # Code editor components
│   │   ├── explorer/   # File explorer components
│   │   ├── git/        # Git integration components
│   │   ├── icons/      # Icon library
│   │   ├── layout/     # Layout components
│   │   ├── modals/     # Modal dialogs
│   │   ├── search/     # Search components
│   │   ├── terminal/   # Terminal components
│   │   ├── theme/      # Theme components
│   │   └── ui/         # Shared UI components
│   ├── services/       # Business logic and external API calls
│   │   ├── providers/  # LLM provider implementations
│   │   ├── agent-service.ts
│   │   ├── llm-provider.ts
│   │   ├── database.ts
│   │   ├── theme-service.ts
│   │   ├── git.ts
│   │   ├── checkpoint.ts
│   │   ├── mcp-tools.ts
│   │   ├── semantic.ts
│   │   ├── context-builder.ts
│   │   ├── thread-service.ts
│   │   ├── token-service.ts
│   │   └── undo-redo.ts
│   ├── store/         # Zustand state management (18 stores)
│   │   ├── useSettingsStore.ts
│   │   ├── useChatStore.ts
│   │   ├── useThreadStore.ts
│   │   ├── useEditorStore.ts
│   │   ├── useWorkspaceStore.ts
│   │   ├── useUiStore.ts
│   │   ├── useThemeStore.ts
│   │   ├── useGitStore.ts
│   │   ├── useMcpStore.ts
│   │   ├── useCheckpointStore.ts
│   │   ├── useSemanticStore.ts
│   │   ├── useContextStore.ts
│   │   ├── useTerminalStore.ts
│   │   ├── useTaskStore.ts
│   │   ├── useAuditStore.ts
│   │   ├── usePendingChangesStore.ts
│   │   ├── useUndoRedoStore.ts
│   │   └── useDragStore.ts
│   ├── tools/         # AI tool definitions and executors
│   │   ├── definitions/  # Tool schemas
│   │   ├── executors/    # Tool implementations
│   │   ├── registry.ts
│   │   ├── operation-log.ts
│   │   └── types.ts
│   ├── hooks/         # Custom React hooks
│   │   ├── useWorkspaceBootstrap.ts
│   │   ├── useAutoSave.ts
│   │   ├── useWindowClose.ts
│   │   ├── useTauriDragDrop.ts
│   │   ├── useInternalDrag.ts
│   │   ├── useCliOpen.ts
│   │   ├── useGlobalShortcuts.ts
│   │   ├── useUndoRedoShortcuts.ts
│   │   ├── useDetachedChatWindow.ts
│   │   ├── useRustChatSync.ts
│   │   ├── useWindowStateSync.ts
│   │   ├── useThemeImportDrag.ts
│   │   └── useExplorerKeyboard.ts
│   ├── types/         # TypeScript type definitions
│   │   ├── database.ts
│   │   ├── theme.ts
│   │   └── index.ts
│   ├── lib/           # Utility libraries
│   ├── themes/        # UI theme definitions
│   ├── App.tsx        # Main application component
│   └── main.tsx       # Application entry point
├── src-tauri/
│   ├── src/
│   │   ├── commands/  # Tauri command handlers (Rust)
│   │   └── db/        # Database layer (SQLite)
│   └── tauri.conf.json
└── DOCS/              # This documentation
```

## Running the Application

### Development Mode
```bash
# Start Tauri development environment
pnpm tauri:dev
```
This opens the full desktop application with hot reloading.

### Production Build
```bash
# Build for production
pnpm tauri:build
```
Creates platform-specific executables in `src-tauri/target/release/`.

### Frontend Only
```bash
# Run just the React frontend
pnpm dev
```
Useful for UI development without Tauri backend.

## Testing

### Run Tests
```bash
# Run all tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run tests with coverage
pnpm test:coverage
```

### Test Structure
- Tests located next to implementation files
- Naming: `*.test.ts` or `*.test.tsx`
- Framework: Vitest with jsdom environment
- Coverage: v8 provider with HTML/text/JSON reports

## Adding New Features

### Adding a New Component

1. **Choose Location**
   - Feature-specific components in `src/components/`
   - Shared UI components in `src/components/ui/`
   - Complex components get their own subdirectory

2. **Component Template**
   ```typescript
   // src/components/MyNewComponent.tsx
   import React from 'react';

   interface MyNewComponentProps {
     title: string;
     onAction?: () => void;
   }

   export function MyNewComponent({ title, onAction }: MyNewComponentProps) {
     return (
       <div className="my-component">
         <h2>{title}</h2>
         {onAction && (
           <button onClick={onAction}>Action</button>
         )}
       </div>
     );
   }
   ```

3. **Add to Exports** (if needed)
   ```typescript
   // src/components/index.ts
   export { MyNewComponent } from './MyNewComponent';
   ```

### Adding State Management

The application uses 18 specialized Zustand stores for different domains:

**Core Stores:**
- `useSettingsStore` - App settings, LLM providers, editor preferences
- `useChatStore` - Chat messages and loading states
- `useThreadStore` - Conversation thread management
- `useEditorStore` - Code editor tabs and content
- `useWorkspaceStore` - File explorer state
- `useUiStore` - UI state (themes, modals, panels)

**Feature Stores:**
- `useThemeStore` - Theme loading and management
- `useGitStore` - Git repository state
- `useMcpStore` - MCP server state
- `useCheckpointStore` - Checkpoint/restore state
- `useSemanticStore` - Semantic search state
- `useContextStore` - Context building state
- `useTerminalStore` - Terminal state
- `useTaskStore` - Task management

**Utility Stores:**
- `useAuditStore` - Audit logging
- `usePendingChangesStore` - Pending file changes
- `useUndoRedoStore` - Undo/redo history
- `useDragStore` - Drag and drop state

#### Creating a New Store

```typescript
// src/store/useMyFeatureStore.ts
import { create } from 'zustand';

interface MyFeatureState {
  data: any[];
  isLoading: boolean;

  loadData: () => Promise<void>;
  addItem: (item: any) => void;
}

export const useMyFeatureStore = create<MyFeatureState>()((set, get) => ({
  data: [],
  isLoading: false,

  loadData: async () => {
    set({ isLoading: true });
    try {
      const data = await fetchData();
      set({ data, isLoading: false });
    } catch (error) {
      set({ isLoading: false });
      throw error;
    }
  },

  addItem: (item) =>
    set((state) => ({
      data: [...state.data, item]
    }))
}));
```

#### Using a Store in Components

```typescript
import { useMyFeatureStore } from '../store/useMyFeatureStore';

export function MyComponent() {
  const { data, isLoading, loadData, addItem } = useMyFeatureStore();

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (isLoading) return <div>Loading...</div>;

  return (
    <div>
      {data.map(item => <div key={item.id}>{item.name}</div>}
      <button onClick={() => addItem({ id: 1, name: 'New' })}>
        Add Item
      </button>
    </div>
  );
}
   ```

### Adding Database Persistence

1. **Add to Database Types**
   ```typescript
   // src/types/database.ts
   export interface MyFeatureData {
     id: string;
     name: string;
     createdAt: string;
   }
   ```

2. **Add Database Service Methods**
   ```typescript
   // src/services/database.ts
   async saveMyFeatureData(data: MyFeatureData): Promise<void> {
     await invoke('save_my_feature_data', { data });
   }

   async getMyFeatureData(): Promise<MyFeatureData[]> {
     return await invoke('get_my_feature_data');
   }
   ```

3. **Add Tauri Commands** (Rust)
   ```rust
   // src-tauri/src/commands/mod.rs
   pub fn save_my_feature_data(data: MyFeatureData) -> Result<(), String> {
       // Implementation
       Ok(())
   }

   pub fn get_my_feature_data() -> Result<Vec<MyFeatureData>, String> {
       // Implementation
       Ok(vec![])
   }
   ```

4. **Add to Command Handler**
   ```rust
   // src-tauri/src/lib.rs
   .invoke_handler(tauri::generate_handler![
       // ... existing commands
       commands::save_my_feature_data,
       commands::get_my_feature_data,
   ])
   ```

## Adding New Modules

### Frontend Service Module

1. **Create Service File**
   ```typescript
   // src/services/myFeatureService.ts
   export class MyFeatureService {
     async processData(input: string): Promise<string> {
       // Business logic
       return input.toUpperCase();
     }

     validateInput(input: string): boolean {
       return input.length > 0;
     }
   }

   export const myFeatureService = new MyFeatureService();
   ```

2. **Export from Services Index**
   ```typescript
   // src/services/index.ts
   export { myFeatureService } from './myFeatureService';
   ```

### Backend Module (Rust)

1. **Create Module File**
   ```rust
   // src-tauri/src/my_feature.rs
   use serde::{Deserialize, Serialize};

   #[derive(Serialize, Deserialize)]
   pub struct MyFeatureData {
       pub id: String,
       pub name: String,
   }

   pub fn process_feature_data(data: MyFeatureData) -> Result<String, String> {
       // Business logic
       Ok(format!("Processed: {}", data.name))
   }
   ```

2. **Add to lib.rs**
   ```rust
   // src-tauri/src/lib.rs
   mod my_feature;

   // Use in commands
   pub fn my_feature_command(data: MyFeatureData) -> Result<String, String> {
       my_feature::process_feature_data(data)
   }
   ```

## File Creation Checklist

When creating new files, ensure they include:

### TypeScript/React Files
- [ ] Proper TypeScript types/interfaces
- [ ] JSDoc comments for public APIs
- [ ] Error handling for async operations
- [ ] Proper imports/exports
- [ ] Follows naming conventions

### Rust Files
- [ ] Proper error handling with `Result<T, E>`
- [ ] Serde derives for data structures
- [ ] Documentation comments
- [ ] Unit tests where appropriate

### Test Files
- [ ] Tests for happy path and error cases
- [ ] Mock external dependencies
- [ ] Arrange-Act-Assert pattern
- [ ] Descriptive test names

## Common Workflows

### Creating an MCP Tool

1. **Define Tool Schema**
   ```typescript
   // src/tools/definitions/mcp-custom-tools.ts
   export const mcpCustomTools = [
     {
       name: 'my_custom_mcp_tool',
       description: 'Description of what this tool does',
       inputSchema: {
         type: 'object',
         properties: {
           param1: { type: 'string', description: 'Parameter description' }
         },
         required: ['param1']
       }
     }
   ];
   ```

2. **Register Tool in MCP Store**
   ```typescript
   // The MCP store automatically discovers tools from connected servers
   // Tools are available via useMcpStore.getAllTools()
   ```

### Adding Git Operations

1. **Use Git Store**
   ```typescript
   import { useGitStore } from '../store/useGitStore';

   export function GitOperations() {
     const {
       status,
       branches,
       commits,
       loadStatus,
       loadBranches,
       stageFile,
       commit,
       checkout
     } = useGitStore();

     const handleCommit = async () => {
       await stageFile('path/to/file.ts');
       await commit('My commit message');
     };

     return <div>...</div>;
   }
   ```

### Implementing Checkpoints

1. **Use Checkpoint Store**
   ```typescript
   import { useCheckpointStore } from '../store/useCheckpointStore';

   export function CheckpointManager() {
     const {
       checkpoints,
       createCheckpoint,
       restoreToCheckpoint,
       hasCheckpoint
     } = useCheckpointStore();

     const createAndRestore = async (messageId: string) => {
       const created = await createCheckpoint(messageId);
       if (created) {
         const checkpoint = checkpoints.get(messageId);
         if (checkpoint) {
           await restoreToCheckpoint(checkpoint.id);
         }
       }
     };

     return <div>...</div>;
   }
   ```

### Adding Semantic Search

1. **Use Semantic Store**
   ```typescript
   import { useSemanticStore } from '../store/useSemanticStore';

   export function SemanticSearch() {
     const {
       searchResults,
       searchCode,
       buildContext
     } = useSemanticStore();

     const handleSearch = async (query: string) => {
       await searchCode(query);
     };

     return <div>...</div>;
   }
   ```

### Creating Custom Hooks

1. **Create Hook File**
   ```typescript
   // src/hooks/useMyCustomHook.ts
   import { useEffect, useState } from 'react';
   import { useMyFeatureStore } from '../store/useMyFeatureStore';

   export function useMyCustomHook() {
     const [value, setValue] = useState(null);
     const { loadData } = useMyFeatureStore();

     useEffect(() => {
       loadData();
     }, [loadData]);

     return { value, setValue };
   }
   ```

2. **Use Hook in Component**
   ```typescript
   import { useMyCustomHook } from '../hooks/useMyCustomHook';

   export function MyComponent() {
     const { value } = useMyCustomHook();
     return <div>{value}</div>;
   }
   ```

### Database Migration

1. **Update Schema**
   ```rust
   // src-tauri/src/db/schema.rs
   pub const CURRENT_SCHEMA_VERSION: i32 = 2;

   // Add new table definition
   pub const CREATE_NEW_TABLE: &str = "
       CREATE TABLE new_feature (
           id TEXT PRIMARY KEY,
           data TEXT NOT NULL
       );
   ";
   ```

2. **Add Migration**
   ```rust
   // src-tauri/src/db/migrations.rs
   pub fn migrate_to_v2(tx: &Transaction) -> Result<(), DbError> {
       tx.execute(CREATE_NEW_TABLE, [])?;
       Ok(())
   }
   ```

### Adding a New LLM Provider

1. **Add Provider Type**
   ```typescript
   // src/types/llm.ts
   export type ProviderType = "openai" | "deepseek" | "glm" | "anthropic" | "custom" | "newprovider";
   ```

2. **Update Provider Configuration**
   ```typescript
   // src/store/useSettingsStore.ts
   export const PRESET_PROVIDERS: Omit<LLMProvider, "apiKey" | "enabled">[] = [
     // ... existing providers
     {
       id: "newprovider",
       name: "New Provider",
       baseUrl: "https://api.newprovider.com",
       model: "new-model",
       contextWindow: 4096,
       maxOutputTokens: 1024,
       supportsThinking: false,
       providerType: "newprovider",
       defaultTemperature: 0.7,
       requiresApiKey: true,
     }
   ];
   ```

3. **Add Provider-Specific Handling**
   ```typescript
   // src/services/llm-provider.ts
   private buildRequestBody(messages: ChatMessage[], provider: LLMProvider): any {
     switch (provider.providerType) {
       case "newprovider":
         return {
           messages,
           model: provider.model,
           temperature: provider.defaultTemperature,
           // New provider specific fields
         };
       // ... other cases
     }
   }
   ```

### Adding a New Tool

1. **Define Tool Schema**
   ```typescript
   // src/tools/definitions/my-new-tool.ts
   export const myNewTool = {
     name: 'my_new_tool',
     description: 'Description of what this tool does',
     inputSchema: {
       type: 'object',
       properties: {
         param1: { type: 'string', description: 'Parameter description' }
       },
       required: ['param1']
     }
   };
   ```

2. **Create Tool Executor**
   ```typescript
   // src/tools/executors/my-new-tool-executor.ts
   import { invoke } from '@tauri-apps/api/core';

   export async function executeMyNewTool(params: { param1: string }) {
     return await invoke('my_new_tool_command', { params });
   }
   ```

3. **Register Tool**
   ```typescript
   // src/tools/registry.ts
   import { myNewTool } from '../definitions/my-new-tool';
   import { executeMyNewTool } from '../executors/my-new-tool-executor';

   registerTool({
     definition: myNewTool,
     executor: executeMyNewTool,
     riskLevel: 'medium' // 'low' | 'medium' | 'high'
   });
   ```

4. **Add Tauri Command**
   ```rust
   // src-tauri/src/commands/mod.rs
   #[tauri::command]
   pub fn my_new_tool_command(params: MyToolParams) -> Result<String, String> {
       // Implementation
       Ok("Result")
   }
   ```
   ```

## Debugging

### Frontend Debugging

1. **React DevTools**
   - Install React DevTools browser extension
   - Inspect component tree and state

2. **Console Logging**
   ```typescript
   console.debug('Debug info:', { variable, state });
   console.error('Error occurred:', error);
   ```

3. **Zustand Store Inspection**
   ```typescript
   const storeState = useMyStore.getState();
   console.log('Store state:', storeState);
   ```

### Backend Debugging

1. **Tauri DevTools**
   - Automatically opens in development mode
   - Inspect network requests and console logs

2. **Rust Debugging**
   ```rust
   println!("Debug: {:?}", variable);
   eprintln!("Error: {}", error);
   ```

3. **Database Debugging**
   ```rust
   // Log SQL queries
   println!("Executing query: {}", sql);
   ```

### Common Issues

- **Tauri commands not working**: Check command registration in `lib.rs`
- **State not persisting**: Verify database schema and migrations
- **UI not updating**: Check Zustand store subscriptions
- **Build failures**: Ensure Rust dependencies are installed
- **MCP servers not connecting**: Check server configuration and logs
- **Git operations failing**: Verify Git repository initialization
- **Theme not applying**: Check theme store initialization and CSS variables
- **Checkpoints not restoring**: Verify checkpoint creation and file paths
- **Semantic search not working**: Check context builder and embeddings

## Build and Deployment

### Building for Production

```bash
# Build the application
pnpm tauri:build

# The built application will be in:
# - Windows: src-tauri/target/release/
# - macOS: src-tauri/target/release/bundle/
# - Linux: src-tauri/target/release/bundle/
```

### Build Optimization

1. **Bundle Analysis**
   ```bash
   # Analyze bundle size
   pnpm build --mode analyze
   ```

2. **Code Splitting**
   - Use dynamic imports for heavy components
   - Lazy load routes and features

### Deployment Checklist

- [ ] Run full test suite
- [ ] Build passes on all target platforms
- [ ] Database migrations tested
- [ ] Default configuration works
- [ ] Error handling graceful
- [ ] Performance acceptable

## Git Workflow

### Branching Strategy

```
main                    # Production releases
├── feature/xyz         # Feature branches
├── bugfix/abc          # Bug fixes
└── release/v1.2.3      # Release branches
```

### Commit Conventions

```
feat: add new LLM provider support
fix: resolve chat panel scrolling issue
docs: update API documentation
refactor: simplify state management logic
test: add unit tests for database service
```

### Pull Request Requirements

- [ ] Tests pass
- [ ] Code reviewed
- [ ] Documentation updated
- [ ] No console errors
- [ ] Follows code style guidelines

## Performance Tips

### Frontend Performance

1. **Memoization**
   ```typescript
   const expensiveValue = useMemo(() =>
     computeExpensiveValue(deps),
     [deps]
   );
   ```

2. **Virtual Scrolling** for large lists
3. **Image Optimization** with lazy loading
4. **Bundle Splitting** for code organization

### Backend Performance

1. **Database Indexing** on frequently queried columns
2. **Connection Pooling** (handled by rusqlite)
3. **Async Operations** for I/O bound tasks
4. **Caching** for expensive computations

### Memory Management

1. **Clean Up Event Listeners**
   ```typescript
   useEffect(() => {
     const handler = () => {};
     window.addEventListener('event', handler);
     return () => window.removeEventListener('event', handler);
   }, []);
   ```

2. **Avoid Memory Leaks** in long-running components
3. **Large Object Cleanup** when components unmount

## Troubleshooting

### Common Build Issues

**Rust Compilation Errors**
```bash
# Clean and rebuild
cd src-tauri
cargo clean
cargo build
```

**Node.js Dependency Issues**
```bash
# Clear cache and reinstall
rm -rf node_modules pnpm-lock.yaml
pnpm install
```

### Runtime Issues

**Database Connection Errors**
- Check file permissions on database file
- Verify database schema version
- Run migrations manually if needed

**LLM Provider Errors**
- Verify API keys are set
- Check provider endpoints are accessible
- Validate request/response formats

**UI Rendering Issues**
- Check console for React errors
- Verify component props are valid
- Test with minimal reproduction case

### Getting Help

1. **Check Existing Documentation**
   - This expansion guide
   - Architecture documentation
   - Code comments and JSDoc

2. **Debugging Steps**
   - Add console.log statements
   - Use browser dev tools
   - Test isolated components

3. **Community Resources**
   - Tauri documentation
   - React documentation
   - Zustand documentation
