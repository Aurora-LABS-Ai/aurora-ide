# Aurora Agent Frontend — Code Style & Patterns

## Table of Contents
1. [Naming Conventions](#naming-conventions)
2. [Code Organization](#code-organization)
3. [Design Patterns](#design-patterns)
4. [Error Handling](#error-handling)
5. [Logging & Telemetry](#logging--telemetry)
6. [Testing Approach](#testing-approach)
7. [Formatting Standards](#formatting-standards)
8. [Comments & Documentation](#comments--documentation)
9. [Performance Practices](#performance-practices)
10. [Configuration Management](#configuration-management)

## Naming Conventions
- **Files & directories**: kebab-case for directories (`use-workspace-bootstrap`), PascalCase for React components, camelCase for hooks/stores (`useUiStore.ts`).
- **State stores**: `use<Name>Store.ts` exporting Zustand hooks with typed interfaces.
- **Types & interfaces**: PascalCase (`AgentConfig`, `ToolProposal`). Shared types live in `src/types`.
- **Constants**: UPPER_SNAKE_CASE only when exported; otherwise prefer `camelCase` inside modules.
- **CSS/Classes**: Tailwind utility classes dominate; custom CSS limited to root-level styles (`index.css`).

## Code Organization
- Colocate UI logic by domain (chat, editor, explorer). Shared primitives go in `components/ui`.
- Hooks encapsulate cross-cutting concerns (`useWindowStateSync`, `useWorkspaceBootstrap`).
- `services/` holds side-effectful logic (LLM provider, agent orchestration, persistence, filesystem). Keep them framework-agnostic.
- Zustand stores act as single source of truth; UI components read slices via selectors to prevent over-renders.
- Tools system split into definitions, registry, executors to keep contracts (JSON schema vs runtime capabilities) explicit.

## Design Patterns
- **Singleton services**: `getAgentService`, `initLLMProvider`, and `databaseService` expose single instances for the app session.
- **Observer/store pattern**: Zustand stores manage state, while React components subscribe via hooks (Flux-lite architecture).
- **Command pattern**: Tool calls (OpenAI function requests) map to executor functions that wrap Tauri commands.
- **Modular composition**: Layout built with `react-resizable-panels` to compose independent panes without tight coupling.
- **Cross-window sync**: `windowSync` utilities plus hooks implement a pub/sub channel between main window and detached chat.

## Error Handling
- Services wrap Tauri invocations with `try/catch`, logging errors to console while returning safe fallbacks (`null`, empty arrays).
- Agent/tool execution traps executor failures and feeds structured error responses back to the LLM via tool messages to maintain conversation integrity.
- Workspace/bootstrap hooks guard against multiple initializations using refs and environment checks (`isTauri()`).
- UI interactions degrade gracefully when running in a browser-only environment (logs warnings instead of crashing when Tauri is absent).

## Logging & Telemetry
- Console logging is used for tracing (e.g., `LLMProvider` request metadata, agent responses, workspace restoration). No external telemetry pipeline is configured.
- Tool execution emits console logs via executor implementations; future production builds should replace with structured logging or event bus.

## Testing Approach
- No automated tests are present in the repo. Recommended strategy:
  1. Use React Testing Library for view logic (component rendering, interactions).
  2. Add integration tests for Zustand stores (state transitions) using Vitest.
  3. Mock Tauri invocations when testing services to keep tests browser-compatible.

## Formatting Standards
- ESLint (flat config) with `@eslint/js`, `typescript-eslint`, `eslint-plugin-react-hooks`, and `eslint-plugin-react-refresh` enforces lint rules.
- TypeScript is configured in `tsconfig.app.json` with strict mode, `noUnused` flags, and bundler resolution.
- Use modern ES modules everywhere (`import/export`). No semi-colons by default (consistent with lint config).
- Tailwind handles most styling; custom CSS limited to global theming and utility classes.

## Comments & Documentation
- Prefer inline comments only when logic is non-obvious (e.g., timeline handling in `ChatPanel`).
- Multi-line documentation blocks describe module responsibilities at the top of service files.
- When adding new tools/services, include a header comment summarizing purpose and usage expectations.

## Performance Practices
- Lazy execution of heavy actions: workspace loading only runs inside Tauri builds; LLM provider initialized per request.
- Streaming APIs (SSE) and incremental timeline updates avoid blocking the UI while responses arrive.
- Zustand selectors limit component rerenders; `useRef` caches timeline state to avoid redundant renders in `ChatPanel`.
- Monaco editor containers sized via flexbox to prevent layout thrashing.

## Configuration Management
- App configuration stored via SQLite through `databaseService` (LLM providers, tool approval policies, workspace metadata).
- Environment detection (`isTauri`) ensures filesystem/shell APIs only run when native bindings exist.
- `package.json` scripts cover Vite dev/build, linting, and Tauri bundling. PNPM manages workspace dependencies.
- Tailwind config centralizes theme tokens (`editor`, `sidebar`, `primary`, etc.) to keep dark-mode palette consistent across components.
