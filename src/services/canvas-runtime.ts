/**
 * The React runtime a live canvas is served with, as text.
 *
 * Inlined rather than fetched: the canvas frame runs under
 * `default-src 'none'`, so it cannot load a script over the network even from
 * ourselves — which is the point. Kept in its own module so the ~140 KB of
 * vendor text lands in a lazily-imported chunk instead of the window's initial
 * bundle.
 *
 * The reading happens in `vite.config.ts` (`auroraCanvasRuntime`), because
 * `react-dom` does not publish its UMD path in `exports`. See that plugin for
 * the resolution and for what to do when React drops UMD entirely.
 */
export { CANVAS_RUNTIME, CANVAS_STYLES, CANVAS_FONTS } from "virtual:aurora-canvas-runtime";
