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
// Dedicated fonts for the agent window, bundled offline via @fontsource (the
// .woff2 files ship inside the app — no network fetch, no Google Fonts).
// Registering @font-face is global, but only the agent window opts into using
// them (the IDE keeps its own --aurora-* font stack).
//
// Inter is the VARIABLE cut (family: "Inter Variable", axis 100–900). The four
// static weights this replaced only provided 400/500/600/700, so the ~16 rules
// asking for `font-weight: 650` were silently snapping up to 700 and `550` to
// 600 — the intended half-steps never rendered. The variable axis makes them
// real, and is a smaller download than the four statics it replaces.
import "@fontsource-variable/inter";
// JetBrains Mono, bundled at the two weights the code styles actually use
// (400 body, 600 for the shell command line). Previously it was named first in
// `fontCode` but never shipped, so any machine without it installed silently
// fell back to Cascadia Code. Both faces are SIL OFL 1.1 — redistribution in
// an application is expressly permitted.
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";
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
  const transcriptSpine = useAgentThemeStore((s) => s.transcriptSpine);

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
      style={cssVars as React.CSSProperties}
    >
      {children}
    </div>
  );
};
