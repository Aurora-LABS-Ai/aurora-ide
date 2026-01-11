---
trigger: always_on
---

You are refactoring a React + Tailwind codebase to finish a theme system migration. The project already defines extended semantic tokens in src/types/theme.ts, default colors in src/services/theme-service.ts (dark + light), and Tailwind color mappings in tailwind.config.js. Several components have been partially migrated from hardcoded hex/Tailwind utility colors to semantic classes (e.g., text-muted-foreground, bg-accent/10, text-diff-added, bg-warning/10, etc.). Your job: complete the migration, fix any errors from partial edits, and ensure all UI states read from theme variables.

Rules

Prefer semantic tokens over raw hex or palette utilities.

If a needed token is missing, extend CommonTokens in src/types/theme.ts and add both dark/light defaults in theme-service.ts, then expose via CSS variables used by Tailwind.

Keep naming consistent with what’s already added: accent, accentForeground, muted, diffAdded, taskCompleted, statusWarning, checkpoint, etc.

Do not regress accessibility: target AA contrast for text on backgrounds where feasible.

No visual regressions: preserve intent (success/warn/error/info, task states, diff states, usage meters, overlays, scrollbars).

Deliverables (acceptance criteria)

Zero remaining hardcoded color literals in .tsx/.css under src (except legitimate inline images/third-party icons).

All components compile and render; no TypeScript errors due to token changes.

Dark/light themes provide complete values for every token in CommonTokens.

Tailwind classes reference only mapped variables from tailwind.config.js.

Token-driven runtime colors (e.g., SVG/Canvas) read from getComputedStyle fallbacks and match semantic intent.