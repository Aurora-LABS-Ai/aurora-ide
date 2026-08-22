/**
 * Agent Window — theme provider (view).
 *
 * Wraps the agent window in `.agw-root` and applies the active theme's tokens as
 * inline CSS custom properties. Because the variables live on this element (not
 * `document.documentElement`), they cascade ONLY to the agent window subtree —
 * the IDE theme is untouched and cannot bleed in.
 */

import React, { useEffect, useMemo } from "react";
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
  const uiVersion = useAgentThemeStore((s) => s.uiVersion);
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

  // The host document's `body` is styled by the shared bundle's IDE stylesheet
  // (`index.css`), so in the agent window it computes to the IDE's font while
  // every visible surface under `.agw-root` uses `--agw-font-ui`. Nothing the
  // user reads paints with the body face — but any portal that ever falls back
  // to `document.body`, and every font probe, then shows the OTHER product's
  // face inside this window. Mirror the resolved UI font onto the body so the
  // whole agent document speaks one face. Path-gated: this document is the
  // agent window's own webview, but the guard keeps a hypothetical mount
  // inside the IDE document from restyling the IDE's body.
  useEffect(() => {
    if (window.location.pathname !== "/agent-window") return;
    const fontUi = theme.tokens.fontUi;
    if (!fontUi) return;
    const body = document.body;
    const previous = body.style.fontFamily;
    body.style.fontFamily = fontUi;
    return () => {
      body.style.fontFamily = previous;
    };
  }, [theme.tokens.fontUi]);

  return (
    <div
      className={className ? `agw-root ${className}` : "agw-root"}
      data-agent-theme={theme.id}
      data-appearance={theme.appearance}
      data-translucent={translucentSidebar || undefined}
      // The design generation. It re-points paint aliases and re-lays-out the
      // densest pages, but never touches a colour of its own — so it composes
      // with whatever theme and token overrides resolved above rather than
      // being a theme. Omitted on classic, so the extra selectors only cost
      // anything for users who opted in.
      data-ui={uiVersion === "v2" ? "v2" : undefined}
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
