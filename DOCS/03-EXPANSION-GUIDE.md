# Aurora Agent Frontend — Expansion & Contribution Guide

## Table of Contents
1. [Getting Started](#getting-started)
2. [Project Setup](#project-setup)
3. [Running the Application](#running-the-application)
4. [Testing](#testing)
5. [Adding New Features](#adding-new-features)
6. [Adding New Modules & Components](#adding-new-modules--components)
7. [File Creation Checklist](#file-creation-checklist)
8. [Common Workflows](#common-workflows)
9. [Debugging](#debugging)
10. [Build & Deployment](#build--deployment)
11. [Git Workflow](#git-workflow)
12. [Performance Tips](#performance-tips)
13. [Troubleshooting](#troubleshooting)

## Getting Started
- Install **Node.js 18+** and **pnpm** globally (`npm install -g pnpm`).
- Install **Rust** and **Tauri prerequisites** for your OS (see [Tauri setup docs](https://tauri.app/v1/guides/getting-started/prerequisites)).
- Clone the repository and ensure submodules/plugins are fetched if introduced later.

## Project Setup
```bash
pnpm install
```
This installs both frontend and Tauri dependencies because the repo uses a PNPM workspace.

Optional: run `pnpm tauri` to verify the Rust CLI is available (downloads via devDependencies).

## Running the Application
- **Web preview (no Tauri APIs):** `pnpm dev`
- **Lint:** `pnpm lint`
- **Type-check + bundle:** `pnpm build`
- **Tauri desktop app (dev):** `pnpm tauri dev` (runs `pnpm dev` + spawns the desktop shell)
- **Tauri production build:** `pnpm tauri build`

## Testing
Automated tests are not yet configured. Recommended additions:
1. Add Vitest + React Testing Library for component tests.
2. Mock Tauri APIs (using dependency injection or module mocking) for services.
3. Validate Zustand store transitions with unit tests (import store creator and invoke actions).

## Adding New Features
1. **Plan data flow**: identify which store or service owns the new state.
2. **Touch minimal areas**: prefer extending existing stores/services to scattering logic across components.
3. **Guard native calls**: wrap Tauri-specific logic with `isTauri()` checks to keep the web preview functional.
4. **Update docs**: describe new tools/services in `DOCS/01-ARCHITECTURE.md` and coding rules in `DOCS/02-CODE-STYLE-PATTERNS.md`.
5. **Persist state**: when adding new workspace/session data, extend `databaseService` plus the Rust commands.

## Adding New Modules & Components
- **Components**: colocate under `src/components/<domain>`. Expose index files for shared exports if needed.
- **Hooks**: place reusable logic in `src/hooks`. Prefix with `use` and document expected side effects.
- **Stores**: follow existing `use<Name>Store.ts` pattern—define interface, initial state, actions, and export `create` call from Zustand.
- **Services**: add to `src/services`, keeping implementation framework-agnostic and thoroughly commented.
- **Tools**: add JSON-schema definitions under `src/tools/definitions`, implement executors under `src/tools/executors`, and register them via `registerAllExecutors`.

## File Creation Checklist
1. Use TypeScript (`.ts`/`.tsx`) unless a build constraint requires plain JS.
2. Import Tailwind classes for styling; avoid ad-hoc inline styles.
3. Add module header comments for non-trivial services/hooks.
4. Export types/interfaces if consumed elsewhere.
5. Update relevant index barrels (`components/ui/index.ts`, `services/index.ts`, etc.).
6. Add documentation references in DOCS folder when introducing major concepts.

## Common Workflows
- **Creating a new tool:**
  1. Define schema in `src/tools/definitions`.
  2. Implement executor under `src/tools/executors` consuming Tauri helpers.
  3. Register executor within `registerAllExecutors`.
  4. Document approval level + risk.
- **Persisting UI state:**
  1. Extend `databaseService` interfaces (`src/types/database.ts`).
  2. Add invoke call to Rust backend.
  3. Update Zustand store to read/write through the service.
- **Adding a settings toggle:**
  1. Update `useSettingsStore` to include state/action.
  2. Reflect the toggle inside Settings modal UI.
  3. Persist via `databaseService.saveAppSettings`.

## Debugging
- Use browser devtools for React component state while running `pnpm dev`.
- When inside Tauri, use `tauri dev -- --open-devtools` or enable Tauri devtools to inspect the Rust bridge.
- Add temporary `console.log` statements sparingly—prefer structured logs with context (module prefix).
- Timeline events in chat provide insight into tool execution order; inspect `timelineRef` when diagnosing race conditions.

## Build & Deployment
- `pnpm build` produces the Vite `dist/` folder.
- Tauri bundling (`pnpm tauri build`) packages the frontend output plus the Rust binary with configured icons (`src-tauri/icons`).
- Release artifacts target all OSes (`bundle.targets = "all"`). For Windows-specific installers, update `tauri.conf.json` accordingly.
- Ensure environment variables (API keys, model URLs) are stored in the SQLite settings via the Settings modal before distributing builds.

## Git Workflow
1. Create feature branches from `main` using descriptive names (`feature/tool-approval-ui`).
2. Keep commits scoped—reference files changed and rationale.
3. Run `pnpm lint` and `pnpm build` before opening PRs.
4. Use PR templates (if added later) to document testing.
5. Request review for changes touching agent tooling or persistence to ensure safety.

## Performance Tips
- Avoid unnecessary rerenders by selecting store slices (`const value = useUiStore((s) => s.value)`).
- Debounce expensive operations (search, file tree refresh) if triggered via UI interactions.
- Use streaming responses (`LLMProvider.streamChatCompletion`) for all conversational flows to keep UI responsive.
- When adding new panels, prefer lazy mounting or suspense boundaries to prevent initial load bloat.

## Troubleshooting
| Issue | Fix |
| --- | --- |
| **Tauri command not found** | Ensure `pnpm tauri` installed (devDependency) and Rust toolchain is up to date. Run `pnpm tauri -V`. |
| **Workspace fails to load outside Tauri** | Expected: filesystem APIs are stubbed. Use Tauri dev mode for full functionality. |
| **LLM requests failing** | Verify Settings → Provider contains base URL, API key, and supported model. Check console logs from `LLMProvider`. |
| **Tool approvals stuck** | Ensure `registerAllExecutors` runs (ChatPanel mount) and pending approval modal is not hidden behind detached windows. |
| **Theme not toggling** | Confirm `useUiStore.toggleTheme` is called and `document.documentElement` has `dark` class; Tailwind must be configured with `darkMode: 'class'`. |
