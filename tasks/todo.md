# Task Checklist

- [completed] Fix the existing ESLint warnings in `AgentModeLayout.tsx`.
- [completed] Run frontend-only lint validation for the touched file and record the result.

# Review

- Removed the stale hook dependency warnings in `AgentModeLayout.tsx` by aligning the effect and callback dependency lists with the values actually used.
- Removed one unused `selectedModel` binding that surfaced after the dependency cleanup.
- Verified with `pnpm exec eslint src\\components\\agent\\AgentModeLayout.tsx`.
