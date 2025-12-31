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
│   ├── services/       # Business logic and external API calls
│   ├── store/         # Zustand state management
│   ├── tools/         # AI tool definitions and executors
│   ├── types/         # TypeScript type definitions
│   ├── hooks/         # Custom React hooks
│   └── themes/        # UI theme definitions
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

1. **Create Store File**
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
         // Load data logic
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

2. **Use in Components**
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
         {data.map(item => <div key={item.id}>{item.name}</div>)}
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

### Creating an API Endpoint

1. **Define Types**
   ```typescript
   // src/types/api.ts
   export interface ApiRequest {
     action: string;
     data: any;
   }

   export interface ApiResponse {
     success: boolean;
     data?: any;
     error?: string;
   }
   ```

2. **Add Frontend Service**
   ```typescript
   // src/services/apiService.ts
   export class ApiService {
     async callEndpoint(request: ApiRequest): Promise<ApiResponse> {
       return await invoke('api_endpoint', { request });
     }
   }
   ```

3. **Add Tauri Command**
   ```rust
   // src-tauri/src/commands/api.rs
   #[tauri::command]
   pub fn api_endpoint(request: ApiRequest) -> Result<ApiResponse, String> {
       match request.action.as_str() {
           "create" => {
               // Handle create action
               Ok(ApiResponse {
                   success: true,
                   data: serde_json::json!({"id": "123"})
               })
           }
           _ => Err("Unknown action".to_string())
       }
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
