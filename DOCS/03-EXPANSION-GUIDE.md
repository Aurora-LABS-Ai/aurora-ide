# Expansion Guide

---

## Table of Contents

- [1. Dev Environment Setup](#1-dev-environment-setup)
- [2. Project Scripts Reference](#2-project-scripts-reference)
- [3. Adding a New Feature — Checklist](#3-adding-a-new-feature--checklist)
- [4. Adding a New LLM Provider](#4-adding-a-new-llm-provider)
- [5. Adding a New AI Tool](#5-adding-a-new-ai-tool)
- [6. Module Creation Checklist](#6-module-creation-checklist)
- [7. Adding Tauri Commands](#7-adding-tauri-commands)
- [8. Adding a Zustand Store](#8-adding-a-zustand-store)

---

## 1. Dev Environment Setup

```bash
# Clone the repository
git clone <repo-url> aurora-ide
cd aurora-ide

# Install dependencies
pnpm install

# Run development server (Tauri + Vite)
pnpm tauri:dev

# Or frontend only (runs on http://localhost:5173)
pnpm dev
```

---

## 2. Project Scripts Reference

| Script | Command | Purpose |
|--------|---------|---------|
| `dev` | `vite` | Frontend dev server only |
| `build` | `tsc -b && vite build` | Production build |
| `preview` | `vite preview` | Preview production build |
| `tauri:dev` | `tauri dev` | Full Tauri dev (Rust rebuilds) |
| `tauri:build` | `tauri build` | Build desktop app installer |
| `test` | `vitest --run` | Run tests once |
| `test:watch` | `vitest` | Run tests in watch mode |
| `test:coverage` | `vitest --run --coverage` | Run tests with coverage |
| `lint` | `eslint .` | Lint code |
| `tauri` | `tauri` | Tauri CLI access |

---

## 3. Adding a New Feature — Checklist

- [ ] Create feature directory under `src/components/<feature>/`
- [ ] Add barrel `index.ts` exporting public API
- [ ] Create Zustand store in `src/store/use<Feature>Store.ts` if state needed
- [ ] Add Tauri commands in `src-tauri/src/commands/<feature>.rs` if backend needed
- [ ] Register commands in `src-tauri/src/lib.rs` invoke handler
- [ ] Add types to `src/types/` if shared
- [ ] Update `App.tsx` or `MainLayout.tsx` to integrate
- [ ] Test with `pnpm tauri:dev`

---

## 4. Adding a New LLM Provider

**Files to modify/create:**

1. **Add preset** in `src/services/providers/provider-presets.ts`:

```typescript
export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  myprovider: {
    id: 'myprovider',
    name: 'MyProvider',
    baseFormat: 'openai',
    chatEndpoint: '/chat/completions',
    authType: 'bearer',
    authHeader: 'Authorization',
    defaultContextWindow: 128000,
    defaultMaxOutput: 8192,
  },
};
```

2. **Create provider class** `src/services/providers/myprovider-provider.ts`:

```typescript
import { OpenAIProvider } from './openai-provider';
export class MyProvider extends OpenAIProvider {
  // Override methods as needed
}
```

3. **Register in factory** `src/services/providers/index.ts`:

```typescript
import { MyProvider } from './myprovider-provider';
// In createProvider():
if (type === 'myprovider') {
  return new MyProvider({ ...config, providerType: type });
}
```

---

## 5. Adding a New AI Tool

**Files to modify/create:**

1. **Define tool** in `src/tools/definitions/<category>/my-tool.ts`:

```typescript
import type { ToolDefinition } from '../../types';

export const myToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'my_tool',
    description: 'Does something useful',
    parameters: {
      type: 'object',
      properties: {
        arg1: { type: 'string', description: 'First argument' },
      },
      required: ['arg1'],
    },
  },
  riskLevel: 'low',
  category: 'filesystem',
};
```

2. **Register in barrel** `src/tools/definitions/<category>/index.ts`:

```typescript
export { myToolDefinition } from './my-tool';
```

3. **Add to registry** in `src/tools/definitions/index.ts`:

```typescript
import { myToolDefinition } from './<category>';
export const allTools = [/* ... */, myToolDefinition];
```

4. **Create executor** in `src/tools/executors/my-tool.ts`:

```typescript
export async function executeMyTool(args: { arg1: string }): Promise<string> {
  // Implementation
  return 'Result';
}
```

5. **Register executor** in `src/tools/executors/index.ts`:

```typescript
import { executeMyTool } from './my-tool';
// In registerAllExecutors():
registry.registerExecutor('my_tool', executeMyTool);
```

---

## 6. Module Creation Checklist

- [ ] File name in kebab-case: `my-module.ts`
- [ ] Main export is the primary class/function
- [ ] Types exported separately with `export type`
- [ ] Barrel file updated if in a folder
- [ ] No `any` types used
- [ ] Async functions return `Promise<T>`
- [ ] Error handling with typed errors
- [ ] Comments for public API methods
- [ ] **Keep files under 300 lines** — split if needed

---

## 7. Adding Tauri Commands

**Files to modify/create:**

1. **Create command file** `src-tauri/src/commands/my_feature.rs`:

```rust
use tauri::State;
use crate::db::Database;
use std::sync::Mutex;

#[tauri::command]
pub async fn my_command(
    arg: String,
    db: State<'_, Mutex<Database>>,
) -> Result<String, String> {
    // Implementation
    Ok(result)
}
```

2. **Export in mod.rs** `src-tauri/src/commands/mod.rs`:

```rust
pub mod my_feature;
pub use my_feature::*;
```

3. **Register in lib.rs** `src-tauri/src/lib.rs`:

```rust
.invoke_handler(tauri::generate_handler![
    // ... existing commands
    commands::my_command,
])
```

---

## 8. Adding a Zustand Store

**Create file** `src/store/useMyFeatureStore.ts`:

```typescript
import { create } from "zustand";
import { databaseService } from "../services/database";

interface MyFeatureState {
  // State
  data: string[];
  isLoading: boolean;
  
  // Actions
  setData: (data: string[]) => void;
  initializeFromDatabase: () => Promise<void>;
  saveToDatabase: () => Promise<void>;
}

export const useMyFeatureStore = create<MyFeatureState>((set, get) => ({
  data: [],
  isLoading: false,
  
  setData: (data) => set({ data }),
  
  initializeFromDatabase: async () => {
    const data = await databaseService.getMyData();
    set({ data });
  },
  
  saveToDatabase: async () => {
    await databaseService.saveMyData(get().data);
  },
}));
```
