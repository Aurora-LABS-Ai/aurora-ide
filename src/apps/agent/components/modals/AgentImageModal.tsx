/**
 * Agent Window — image modal [view].
 *
 * Two modes share one shell:
 *  - "preview": view an image full-size with an X to close (used when clicking
 *    an image in a chat bubble).
 *  - "annotate": draw on the image with a color marker (pen / rectangle), undo /
 *    clear, then "Done" flattens the strokes into the bitmap and calls `onSave`
 *    (used when clicking a staged attachment in the composer).
 *
 * Strokes are stored in the image's NATURAL pixel space so the exported bitmap
 * is crisp regardless of on-screen scaling. Portaled into `.agw-root` so the
 * `--agw-*` tokens cascade (otherwise it renders unthemed).
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { hideAgentBrowser, showAgentBrowser } from "@/apps/agent/components/panels/BrowserPanel";

type Point = [number, number];
interface Stroke {
  color: string;
  width: number;
  tool: "pen" | "rect";
  points: Point[];
}

const COLORS = ["#ff4d4f", "#ffd60a", "#34c759", "#3994bc", "#ffffff", "#0a0a0a"];

export interface AgentImageModalProps {
  open: boolean;
  mode: "preview" | "annotate";
  /** An image URL, including a local asset or `data:` URL. */
  src: string | null;
  alt?: string;
  onClose: () => void;
  /** annotate mode only — receives the flattened `data:` URL. */
  onSave?: (dataUrl: string) => void;
}

export const AgentImageModal: React.FC<AgentImageModalProps> = ({
  open,
  mode,
  src,
  alt = "Image preview",
  onClose,
  onSave,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const close = useCallback(() => { setFailedSource(null); onClose(); }, [onClose]);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [tool, setTool] = useState<"pen" | "rect">("pen");
  const [color, setColor] = useState(COLORS[0]);
  const drawingRef = useRef<Stroke | null>(null);

  const portalTarget =
    typeof document !== "undefined"
      ? (document.querySelector(".agw-root") as HTMLElement) ?? document.body
      : null;

  // Load the source image and reset transient annotation state. All state
  // writes happen inside the async `onload` callback (not the effect body) so a
  // fresh image always starts with an empty stroke list and a clean canvas.
  useEffect(() => {
    if (!open || !src || mode !== "annotate") return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      imgRef.current = img;
      drawingRef.current = null;
      setStrokes([]);
    };
    img.src = src;
    return () => {
      cancelled = true;
      img.onload = null;
    };
  }, [open, src, mode]);

  // Redraw base + every stroke whenever strokes or the loaded image change.
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    const live = drawingRef.current;
    const all = live ? [...strokes, live] : strokes;
    for (const s of all) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      if (s.tool === "pen") {
        ctx.beginPath();
        s.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.stroke();
      } else if (s.tool === "rect" && s.points.length >= 2) {
        const [x0, y0] = s.points[0];
        const [x1, y1] = s.points[s.points.length - 1];
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      }
    }
  }, [strokes]);

  // Redraw whenever the stroke set changes (also fires right after load, since
  // `onload` resets `strokes`). `redraw` no-ops until the image is present.
  useEffect(() => {
    redraw();
  }, [redraw]);

  useEffect(() => {
    if (!open || !src || mode !== "preview") return;
    const previous = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open, src, mode]);

  // Keep preview keyboard navigation inside the modal, including on failure.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (mode === "preview" && e.key === "Tab") {
        e.preventDefault();
        closeRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, mode, close]);

  // The agent's embedded browser is a NATIVE webview that paints above all DOM,
  // so this modal would otherwise open BEHIND it whenever the Browser panel is
  // showing. Hide the webview while the modal is up; `showAgentBrowser` is
  // self-gating (only re-shows if the Browser tab is still the live surface).
  useEffect(() => {
    if (!open) return;
    void hideAgentBrowser();
    return () => {
      void showAgentBrowser();
    };
  }, [open]);

  const toCanvasPoint = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return [0, 0];
    const r = canvas.getBoundingClientRect();
    const sx = canvas.width / r.width;
    const sy = canvas.height / r.height;
    return [(e.clientX - r.left) * sx, (e.clientY - r.top) * sy];
  };

  const lineWidthForImage = (): number => {
    const canvas = canvasRef.current;
    const base = canvas ? Math.max(canvas.width, canvas.height) : 800;
    return Math.max(2, Math.round(base / 300));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode !== "annotate") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawingRef.current = {
      color,
      width: lineWidthForImage(),
      tool,
      points: [toCanvasPoint(e)],
    };
    redraw();
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode !== "annotate" || !drawingRef.current) return;
    drawingRef.current.points.push(toCanvasPoint(e));
    redraw();
  };
  const onPointerUp = () => {
    if (mode !== "annotate" || !drawingRef.current) return;
    const stroke = drawingRef.current;
    drawingRef.current = null;
    if (stroke.points.length > 0) setStrokes((s) => [...s, stroke]);
  };

  const undo = () => setStrokes((s) => s.slice(0, -1));
  const clear = () => setStrokes([]);
  const done = () => {
    const canvas = canvasRef.current;
    if (canvas && onSave) onSave(canvas.toDataURL("image/png"));
    onClose();
  };

  if (!open || !src || !portalTarget) return null;

  return createPortal(
    <div className="agw-img-overlay" onClick={close}>
      <div
        className="agw-img-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={mode === "preview" ? "Image preview" : "Annotate image"}
      >
        <div className="agw-img-stage">
          {mode === "annotate" ? (
            <canvas
              ref={canvasRef}
              className="agw-img-canvas"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
            />
          ) : (
            failedSource === src ? <p role="alert">Image could not be loaded. Close the preview and try again.</p> :
            <img src={src} alt={alt} className="agw-img-canvas" draggable={false}
              onError={() => setFailedSource(src)} />
          )}
        </div>

        {mode === "annotate" && (
          <div className="agw-img-toolbar" onClick={(e) => e.stopPropagation()}>
            <div className="agw-img-tools">
              <button
                type="button"
                className="agw-img-tool"
                data-active={tool === "pen" || undefined}
                title="Pen"
                onClick={() => setTool("pen")}
              >
                Pen
              </button>
              <button
                type="button"
                className="agw-img-tool"
                data-active={tool === "rect" || undefined}
                title="Rectangle"
                onClick={() => setTool("rect")}
              >
                Box
              </button>
            </div>
            <div className="agw-img-swatches">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="agw-img-swatch"
                  data-active={c === color || undefined}
                  style={{ background: c }}
                  title={c}
                  aria-label={`Color ${c}`}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
            <div className="agw-img-tools">
              <button
                type="button"
                className="agw-img-tool"
                title="Undo"
                disabled={strokes.length === 0}
                onClick={undo}
              >
                Undo
              </button>
              <button
                type="button"
                className="agw-img-tool"
                title="Clear"
                disabled={strokes.length === 0}
                onClick={clear}
              >
                Clear
              </button>
              <button type="button" className="agw-img-done" title="Done" onClick={done}>
                Done
              </button>
            </div>
          </div>
        )}

        <button
          type="button"
          ref={closeRef}
          className="agw-img-close"
          title="Close"
          aria-label="Close"
          onClick={close}
        >
          <AgentIcon name="close" size={16} />
        </button>
      </div>
    </div>,
    portalTarget,
  );
};
