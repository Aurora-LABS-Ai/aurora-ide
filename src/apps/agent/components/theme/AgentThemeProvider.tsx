/**
 * Agent Window — theme provider (view).
 *
 * Wraps the agent window in `.agw-root` and applies the active theme's tokens as
 * inline CSS custom properties. Because the variables live on this element (not
 * `document.documentElement`), they cascade ONLY to the agent window subtree —
 * the IDE theme is untouched and cannot bleed in.
 */

import React, { useMemo } from "react";
import { useAgentThemeStore, resolveAgentTheme } from "@/apps/agent/store/ui/useAgentThemeStore";
import { tokensToCssVars } from "@/apps/agent/theme/tokens";
// Bundled typefaces (Inter Variable, JetBrains Mono, Geist, …) register once
// for BOTH windows in kernel/lib/fonts/bundled.ts, imported from main.tsx —
// this provider only decides which of them the agent window asks for, via the
// fontUi/fontCode theme tokens.
import "@/apps/agent/theme/agent-window.css";

interface AgentThemeProviderProps {
  className?: string;
  children: React.ReactNode;
}

export const AgentThemeProvider: React.FC<AgentThemeProviderProps> = ({
  className,
  children,
}) => {
  // Select the raw slices and merge with useMemo so the resolved theme object
  // is only recomputed when something it depends on actually changes (avoids a
  // fresh object — and a re-render — on every unrelated store update).
  const activeThemeId = useAgentThemeStore((s) => s.activeThemeId);
  const customThemes = useAgentThemeStore((s) => s.customThemes);
  const customizations = useAgentThemeStore((s) => s.customizations);
  const contrast = useAgentThemeStore((s) => s.contrast);
  const translucentSidebar = useAgentThemeStore((s) => s.translucentSidebar);
  const reduceMotion = useAgentThemeStore((s) => s.reduceMotion);
  const transcriptSpine = useAgentThemeStore((s) => s.transcriptSpine);
  const transcriptStickyUser = useAgentThemeStore((s) => s.transcriptStickyUser);

  const theme = useMemo(
    () =>
      resolveAgentTheme({
        activeThemeId,
        customThemes,
        customizations,
        contrast,
      } as Parameters<typeof resolveAgentTheme>[0]),
    [activeThemeId, customThemes, customizations, contrast],
  );
  const cssVars = useMemo(() => tokensToCssVars(theme.tokens), [theme.tokens]);

  return (
    <div
      className={className ? `agw-root ${className}` : "agw-root"}
      data-agent-theme={theme.id}
      data-appearance={theme.appearance}
      data-translucent={translucentSidebar || undefined}
      data-reduce-motion={reduceMotion || undefined}
      // Set here, on the root, rather than per row: the spine is a property of
      // the whole transcript, and toggling one attribute high up re-styles every
      // row without re-rendering (or remounting) a single one of them.
      data-transcript-spine={transcriptSpine || undefined}
      // Same reasoning as the spine: pinning is a property of the transcript, so
      // it rides on the root and re-styles every turn wrapper without touching
      // ConversationPane or remounting a single turn.
      data-transcript-sticky-user={transcriptStickyUser || undefined}
      style={cssVars as React.CSSProperties}
    >
      {children}
    </div>
  );
};
