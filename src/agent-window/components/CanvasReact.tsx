import React, { useEffect, useRef, useState } from "react";

import {
  buildCanvasDocument,
  compileCanvasSource,
  CanvasCompileError,
} from "../../services/canvas-react";
import { AgentIcon } from "../shared";
import { useAgentThemeStore } from "../store/useAgentThemeStore";

interface CanvasReactProps {
  source: string;
  title: string;
  refreshKey: number;
}

/**
 * Tokens the sandbox needs even when they are declared in the stylesheet rather
 * than applied inline by `AgentThemeProvider`. Everything else is picked up
 * from the inline custom properties, so the frame follows the live theme
 * automatically as new tokens are added.
 *
 * This list is a safety net, not the mechanism: it names exactly what
 * `canvas-sdk/canvas.css` and the frame's own reset consume, so a canvas can
 * never fall back to platform defaults for something the SDK paints.
 */
const REQUIRED_TOKENS = [
  "--agw-conversation",
  "--agw-surface",
  "--agw-surface-elevated",
  "--agw-text",
  "--agw-text-muted",
  "--agw-text-subtle",
  "--agw-border",
  "--agw-border-strong",
  "--agw-accent",
  "--agw-ring",
  "--agw-hover",
  "--agw-chip-surface",
  "--agw-code-surface",
  "--agw-added",
  "--agw-warning",
  "--agw-removed",
  "--agw-font-ui",
  "--agw-font-code",
  // The frame draws its own scrollbars from these; without them it falls back
  // to the platform's, which is instantly recognisable as foreign.
  "--agw-scroll-thumb",
  "--agw-scroll-thumb-hover",
  "--agw-radius-md",
];

/**
 * Every `--agw-*` custom property currently in force, so a canvas is themed by
 * the same tokens as the window around it and cannot drift into its own palette.
 */
const readThemeVariables = (element: HTMLElement): Record<string, string> => {
  const root = element.closest<HTMLElement>(".agw-root") ?? element;
  const variables: Record<string, string> = {};

  const inline = root.style;
  for (let index = 0; index < inline.length; index += 1) {
    const name = inline.item(index);
    if (name.startsWith("--agw-")) variables[name] = inline.getPropertyValue(name).trim();
  }

  const computed = getComputedStyle(root);
  REQUIRED_TOKENS.forEach((name) => {
    if (variables[name]) return;
    const value = computed.getPropertyValue(name).trim();
    if (value) variables[name] = value;
  });

  return variables;
};

export const CanvasReact: React.FC<CanvasReactProps> = ({ source, title, refreshKey }) => {
  const activeThemeId = useAgentThemeStore((state) => state.activeThemeId);
  const activeCustomization = useAgentThemeStore(
    (state) => state.customizations[state.activeThemeId],
  );
  const contrast = useAgentThemeStore((state) => state.contrast);
  const hostRef = useRef<HTMLDivElement>(null);
  const [document, setDocument] = useState("");
  const [compiling, setCompiling] = useState(true);
  const [compileError, setCompileError] = useState("");
  const [runtimeError, setRuntimeError] = useState("");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    setCompiling(true);
    setCompileError("");
    setRuntimeError("");

    void (async () => {
      try {
        const [compiled, { CANVAS_RUNTIME, CANVAS_STYLES, CANVAS_FONTS }] = await Promise.all([
          compileCanvasSource(source),
          import("../../services/canvas-runtime"),
        ]);
        if (cancelled) return;
        setDocument(
          buildCanvasDocument(compiled, {
            runtime: CANVAS_RUNTIME,
            styles: CANVAS_STYLES,
            fonts: CANVAS_FONTS,
            cssVariables: readThemeVariables(host),
            title,
          }),
        );
      } catch (error: unknown) {
        if (cancelled) return;
        setDocument("");
        setCompileError(
          error instanceof CanvasCompileError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error),
        );
      } finally {
        if (!cancelled) setCompiling(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeCustomization, activeThemeId, contrast, refreshKey, source, title]);

  /**
   * A canvas that throws at run time used to be indistinguishable from a canvas
   * that renders nothing — the failure mode html artifacts still have. The
   * frame reports its own crashes and they surface here, next to the thing that
   * broke.
   */
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: string; type?: string; message?: string } | null;
      if (!data || data.source !== "aurora-canvas" || data.type !== "error") return;
      setRuntimeError(String(data.message ?? "").slice(0, 2000));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <div className="agw-canvas-react" ref={hostRef}>
      {compiling && (
        <div className="agw-diagram-state" aria-live="polite">
          <AgentIcon name="retry" size={18} className="agw-canvas-spin" />
          <span>Compiling canvas…</span>
        </div>
      )}

      {compileError && (
        <div className="agw-diagram-error" role="alert">
          <AgentIcon name="help" size={18} />
          <div>
            <strong>Canvas source has an error</strong>
            <pre>{compileError}</pre>
          </div>
        </div>
      )}

      {document && (
        <iframe
          key={`${refreshKey}:${document.length}`}
          className="agw-canvas-frame"
          title={`${title} canvas`}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={document}
        />
      )}

      {runtimeError && (
        <div className="agw-canvas-runtime-error" role="alert">
          <AgentIcon name="help" size={14} />
          <pre>{runtimeError}</pre>
        </div>
      )}
    </div>
  );
};
