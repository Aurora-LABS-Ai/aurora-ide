/**
 * Agent Window — token → CSS variable mapping (theme concern).
 *
 * Pure helper. The `AgentThemeTokens` contract lives in the module's `types`
 * (leaf layer); this file only derives the inline `--agw-*` custom-property set
 * that `AgentThemeProvider` applies to `.agw-root`.
 */

import type { AgentThemeTokens } from "../types";

/** camelCase token key → `--agw-kebab-case` custom property name. */
function toVarName(key: string): string {
  return `--agw-${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
}

/** Convert a token set into the inline-style record of CSS custom properties. */
export function tokensToCssVars(tokens: AgentThemeTokens): Record<string, string> {
  const out: Record<string, string> = {};
  (Object.keys(tokens) as (keyof AgentThemeTokens)[]).forEach((key) => {
    out[toVarName(key)] = tokens[key];
  });
  return out;
}
