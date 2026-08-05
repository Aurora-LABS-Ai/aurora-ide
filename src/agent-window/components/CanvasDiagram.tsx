import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  describeMermaidError,
  renderMermaidSource,
  type MermaidPalette,
} from "../../services/mermaid-artifacts";
import { AgentIcon } from "../shared";
import { useAgentThemeStore } from "../store/useAgentThemeStore";
import {
  diagramArtworkBox,
  fitDiagramViewport,
  initialDiagramViewport,
  MAX_DIAGRAM_SCALE,
  MIN_DIAGRAM_SCALE,
  readMermaidSvgSize,
} from "../lib/mermaid-svg";

interface CanvasDiagramProps {
  source: string;
  title: string;
  refreshKey: number;
}

interface Size {
  width: number;
  height: number;
}

interface Viewport {
  x: number;
  y: number;
  scale: number;
}

let renderSequence = 0;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/** Wheel/click landed on the floating zoom controls, not the canvas itself. */
const isControl = (target: EventTarget | null) =>
  target instanceof Element && Boolean(target.closest(".agw-diagram-controls"));

const readPalette = (element: HTMLElement): MermaidPalette => {
  const root = element.closest<HTMLElement>(".agw-root") ?? element;
  const styles = getComputedStyle(root);
  const token = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    canvas: token("--agw-conversation", "#111111"),
    surface: token("--agw-surface", "#181818"),
    surfaceElevated: token("--agw-surface-elevated", "#202020"),
    text: token("--agw-text", "#ededed"),
    textMuted: token("--agw-text-muted", "#9a9a9a"),
    border: token("--agw-border-strong", "#444444"),
    accent: token("--agw-accent", "#8b8bff"),
    fontFamily: token("--agw-font-ui", "system-ui, sans-serif"),
  };
};

export const CanvasDiagram: React.FC<CanvasDiagramProps> = ({ source, title, refreshKey }) => {
  const activeThemeId = useAgentThemeStore((state) => state.activeThemeId);
  const activeCustomization = useAgentThemeStore(
    (state) => state.customizations[state.activeThemeId],
  );
  const contrast = useAgentThemeStore((state) => state.contrast);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const renderId = useMemo(() => `agw-mermaid-${++renderSequence}`, []);
  const [svg, setSvg] = useState("");
  const [diagramSize, setDiagramSize] = useState<Size>({ width: 800, height: 600 });
  const [stageSize, setStageSize] = useState<Size>({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 1 });
  const [autoFit, setAutoFit] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      const rect = stage.getBoundingClientRect();
      setStageSize({ width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let cancelled = false;
    const id = `${renderId}-${refreshKey}`;
    setLoading(true);
    setError("");
    setSvg("");
    void renderMermaidSource(source, id, readPalette(stage))
      .then((nextSvg) => {
        if (cancelled) return;
        setDiagramSize(readMermaidSvgSize(nextSvg));
        setSvg(nextSvg);
        setAutoFit(true);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(describeMermaidError(reason) || "The diagram could not be rendered.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
        document.getElementById(id)?.remove();
      });
    return () => {
      cancelled = true;
      document.getElementById(id)?.remove();
    };
  }, [activeCustomization, activeThemeId, contrast, refreshKey, renderId, source]);

  /** Whole-diagram overview — the EXPLICIT action (Fit button, double-click). */
  const fit = useCallback(() => {
    const next = fitDiagramViewport(stageSize, diagramSize);
    if (next) setViewport(next);
  }, [diagramSize, stageSize]);

  /** Where a fresh render opens: the fit, floored at a readable scale. */
  const place = useCallback(() => {
    const next = initialDiagramViewport(stageSize, diagramSize);
    if (next) setViewport(next);
  }, [diagramSize, stageSize]);

  useLayoutEffect(() => {
    if (svg && autoFit) place();
  }, [autoFit, place, svg]);

  /**
   * Scale by `factor`, keeping the point (x, y) — in stage coordinates —
   * pinned under the cursor.
   *
   * Reads the current scale from inside the updater rather than from the
   * render closure so the native wheel listener below can stay bound across
   * viewport changes instead of re-subscribing on every zoom frame.
   */
  const zoomBy = useCallback((factor: number, x: number, y: number) => {
    setAutoFit(false);
    setViewport((current) => {
      const scale = clamp(current.scale * factor, MIN_DIAGRAM_SCALE, MAX_DIAGRAM_SCALE);
      const ratio = scale / current.scale;
      return {
        scale,
        x: x - (x - current.x) * ratio,
        y: y - (y - current.y) * ratio,
      };
    });
  }, []);

  const zoomFromCenter = (factor: number) => {
    zoomBy(factor, stageSize.width / 2, stageSize.height / 2);
  };

  /**
   * Wheel pan/zoom, bound natively because React cannot do it.
   *
   * React 17+ attaches its delegated `wheel` listener at the root container
   * with `{ passive: true }`, so `preventDefault()` from an `onWheel` prop is
   * discarded and the browser warns. The canvas must consume the wheel — if it
   * doesn't, the dock scrolls out from under the diagram mid-zoom — so the
   * listener has to sit on the stage itself with `{ passive: false }`.
   */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !svg) return;
    const onWheel = (event: WheelEvent) => {
      if (isControl(event.target)) return;
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const rect = stage.getBoundingClientRect();
        zoomBy(
          Math.exp(-event.deltaY * 0.002),
          event.clientX - rect.left,
          event.clientY - rect.top,
        );
        return;
      }
      setAutoFit(false);
      setViewport((current) => ({
        ...current,
        x: current.x - event.deltaX,
        y: current.y - event.deltaY,
      }));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [svg, zoomBy]);

  const artwork = diagramArtworkBox(diagramSize, viewport);

  return (
    <div
      ref={stageRef}
      className="agw-diagram-stage"
      data-dragging={dragging || undefined}
      style={{
        backgroundPosition: `${viewport.x}px ${viewport.y}px`,
        backgroundSize: `${clamp(24 * viewport.scale, 12, 48)}px ${clamp(24 * viewport.scale, 12, 48)}px`,
      }}
      role="region"
      aria-label={`${title} diagram canvas`}
      onDoubleClick={(event) => {
        if (isControl(event.target)) return;
        // Explicit overview — autoFit stays OFF so the readable-first initial
        // placement doesn't immediately override the fit the user asked for.
        setAutoFit(false);
        fit();
      }}
      onPointerDown={(event) => {
        if (isControl(event.target) || !svg || (event.button !== 0 && event.button !== 1)) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
          originX: viewport.x,
          originY: viewport.y,
        };
        setAutoFit(false);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        if ((event.buttons & 5) === 0) {
          dragRef.current = null;
          setDragging(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          return;
        }
        setViewport((current) => ({
          ...current,
          x: drag.originX + event.clientX - drag.clientX,
          y: drag.originY + event.clientY - drag.clientY,
        }));
      }}
      onPointerUp={(event) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        dragRef.current = null;
        setDragging(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={(event) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        dragRef.current = null;
        setDragging(false);
      }}
      onLostPointerCapture={(event) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        dragRef.current = null;
        setDragging(false);
      }}
    >
      {svg && (
        <div
          className="agw-diagram-artwork"
          role="img"
          aria-label={`${title} Mermaid diagram`}
          // Zoom is SIZE, panning is transform — see `diagramArtworkBox`. The
          // artwork is a composited layer, and Chromium stretches such a
          // layer's cached bitmap rather than re-rendering it, so a diagram
          // that auto-fit small stayed rasterized small and zooming in only
          // enlarged the blur. Growing the box re-renders the SVG as vector.
          style={{
            width: artwork.width,
            height: artwork.height,
            transform: `translate3d(${artwork.left}px, ${artwork.top}px, 0)`,
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}

      {loading && (
        <div className="agw-diagram-state" aria-live="polite">
          <AgentIcon name="retry" size={18} className="agw-canvas-spin" />
          <span>Rendering diagram…</span>
        </div>
      )}

      {error && (
        <div className="agw-diagram-error" role="alert">
          <AgentIcon name="help" size={18} />
          <div>
            <strong>Diagram source has an error</strong>
            <pre>{error}</pre>
          </div>
        </div>
      )}

      <div className="agw-diagram-controls" aria-label="Diagram viewport controls">
        <button
          type="button"
          disabled={!svg}
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() => zoomFromCenter(0.8)}
        >
          <AgentIcon name="zoom-out" size={14} />
        </button>
        {/* The readout is also the reset: % means "of actual size", and
            clicking it takes you there — one action instead of a hunt through
            zoom steps. */}
        <button
          type="button"
          className="agw-diagram-zoom"
          disabled={!svg}
          aria-label="Zoom to actual size"
          title="Zoom to actual size (100%)"
          aria-live="polite"
          onClick={() => zoomFromCenter(1 / viewport.scale)}
        >
          {Math.round(viewport.scale * 100)}%
        </button>
        <button
          type="button"
          disabled={!svg}
          aria-label="Zoom in"
          title="Zoom in"
          onClick={() => zoomFromCenter(1.25)}
        >
          <AgentIcon name="zoom-in" size={14} />
        </button>
        <span className="agw-diagram-control-sep" aria-hidden />
        <button
          type="button"
          disabled={!svg}
          aria-label="Fit diagram"
          title="Fit diagram"
          onClick={() => {
            setAutoFit(false);
            fit();
          }}
        >
          <AgentIcon name="fit" size={14} />
        </button>
      </div>

      {svg && <div className="agw-diagram-hint">Drag to pan · Ctrl + wheel to zoom</div>}
    </div>
  );
};
