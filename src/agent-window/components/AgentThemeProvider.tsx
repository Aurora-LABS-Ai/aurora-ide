/**
 * Agent Window — theme provider (view).
 *
 * Wraps the agent window in `.agw-root` and applies the active theme's tokens as
 * inline CSS custom properties. Because the variables live on this element (not
 * `document.documentElement`), they cascade ONLY to the agent window subtree —
 * the IDE theme is untouched and cannot bleed in.
 */

import React, { useMemo } from "react";
import { useAgentThemeStore, resolveAgentTheme } from "../store/useAgentThemeStore";
import { tokensToCssVars } from "../theme/tokens";
// Dedicated UI font for the agent window. Bundled offline via @fontsource so
// `--agw-font-ui: "Inter"` renders a real face instead of falling back to the
// system UI font. Registering @font-face is global, but only the agent window
// opts into using it (the IDE keeps its own --aurora-* font stack).
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "../theme/agent-window.css";

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
      style={cssVars as React.CSSProperties}
    >
      {children}
    </div>
  );
};
