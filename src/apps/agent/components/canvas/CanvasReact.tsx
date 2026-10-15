import React, { useEffect, useRef, useState } from "react";

import {
  buildCanvasDocument,
  compileCanvasSource,
  repairCanvasImports,
  CanvasCompileError,
} from "@/apps/agent/services/artifacts/canvas-react";
import { AgentIcon } from "@/apps/agent/shared";
import { openExternalUrl } from "@/apps/agent/adapters/open-external";
import { useAgentThemeStore } from "@/apps/agent/store/ui/useAgentThemeStore";

interface CanvasReactProps {
  source: string;
  title: string;
  refreshKey: number;
  /**
   * `fill` (default) fills its panel, the dock. `content` sizes the frame to
   * what the canvas draws, from the height the frame reports — a canvas
   * inline in a reply, which must never scroll inside itself.
   */
  fit?: "fill" | "content";
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

/** An inline canvas taller than this scrolls inside itself; past a screen it
 *  belongs in the dock, and the prompt says so. */
const MAX_INLINE_HEIGHT = 720;

/** First paint before the frame has reported: a short, quiet space, not a hole. */
const INITIAL_INLINE_HEIGHT = 120;

export const CanvasReact: React.FC<CanvasReactProps> = ({ source, title, refreshKey, fit = "fill" }) => {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [contentHeight, setContentHeight] = useState(INITIAL_INLINE_HEIGHT);
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
          // A saved canvas may predate the gate's import check; showing it
          // imports what it forgot (`repairCanvasImports`). Saving stays strict.
          repairCanvasImports(source).then(compileCanvasSource),
          import("@/apps/agent/services/artifacts/canvas-runtime"),
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
      const data = event.data as {
        source?: string;
        type?: string;
        message?: string;
        href?: string;
        height?: number;
      } | null;
      if (!data || data.source !== "aurora-canvas") return;
      // Several canvases can be on screen (one inline per reply, one in the
      // dock); a size report is only believed from THIS frame.
      if (data.type === "size") {
        if (fit !== "content" || event.source !== frameRef.current?.contentWindow) return;
        const height = Number(data.height);
        if (Number.isFinite(height) && height > 0) setContentHeight(Math.min(height, MAX_INLINE_HEIGHT));
        return;
      }
      if (data.type === "error") {
        setRuntimeError(String(data.message ?? "").slice(0, 2000));
        return;
      }
      // A citation was clicked. The frame cannot navigate anywhere itself — no
      // `allow-popups`, no `allow-top-navigation` — so the href comes here and
      // goes to the user's browser. `openExternalUrl` is what refuses anything
      // that is not http(s); this listener does not vet the string itself.
      if (data.type === "open-url" && typeof data.href === "string") {
        void openExternalUrl(data.href);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [fit]);

  return (
    <div className="agw-canvas-react" ref={hostRef} data-fit={fit}>
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
          ref={frameRef}
          className="agw-canvas-frame"
          title={`${title} canvas`}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={document}
          style={fit === "content" ? { height: contentHeight } : undefined}
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
