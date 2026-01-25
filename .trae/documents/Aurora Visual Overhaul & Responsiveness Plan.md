I have analyzed the current theme system implementation and prepared a systematic plan to address your requirements, focusing first on the visual theming overhaul and responsiveness.

## Phase 1: Visual Theming Overhaul (Priority)
**Goal:** Ensure 100% consistent usage of the centralized theme system across all UI components.

1.  **Component Audit & Refactor**:
    *   Scan all components in `src/components/` for hardcoded hex/RGB values or arbitrary Tailwind classes (e.g., `bg-gray-900`, `text-[#...]`).
    *   Replace them with semantic Tailwind classes mapped to theme tokens (e.g., `bg-sidebar`, `text-text-secondary`).
    *   **Focus Areas**: `ChatInput`, `FileExplorer`, `Statusbar`, and `Terminal` components.
2.  **Theme System Enhancement**:
    *   Verify `src/services/theme-service.ts` correctly handles all token injections.
    *   Ensure `tailwind.config.js` mappings are complete for all new tokens found in `src/types/theme.ts`.
3.  **Visual Polish**:
    *   Standardize hover/active states using `item-hover` and `item-active` tokens.
    *   Ensure gradients and glow effects (like in `ChatPanel`) use theme-aware colors (e.g., `primary/20` instead of hardcoded colors).

## Phase 2: Responsiveness & UI Feedback
**Goal:** Improve the "feel" of the application with immediate feedback and smooth states.

1.  **Stop Generation Fix**:
    *   Investigate `ChatInput.tsx` and `ChatPanel.tsx` to ensure the "Stop" button immediately reflects the `streaming` state from `useThreadStore`.
    *   Ensure the abort controller signal is correctly propagated to the agent service.
2.  **Loading States**:
    *   Implement a "Thinking..." or "Preparing..." skeleton loader in the chat timeline before the first token arrives.
    *   Add visual indicators for "Tool Execution" states (pending vs. executing vs. complete) in the timeline.
3.  **Transitions**:
    *   Add `framer-motion` or CSS transitions for message insertion to prevent jarring layout shifts.

## Phase 3: Performance & VS Code Parity
**Goal:** Match VS Code's smoothness and accessibility.

1.  **Monaco Integration**:
    *   Review `convertToMonacoTheme` in `theme-service.ts` to ensure strict parity with VS Code's token color rules.
2.  **Optimization**:
    *   Verify that `ChatMessages.tsx` uses virtualization (or optimized rendering) for long threads.

I will begin with **Phase 1**, specifically auditing `ChatInput.tsx` and `FileExplorer` for theme consistency, as these are high-traffic areas.
