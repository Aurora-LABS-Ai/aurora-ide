/** Modules synthesised by Vite plugins rather than present on disk. */

declare module "virtual:aurora-canvas-runtime" {
  /**
   * React + ReactDOM UMD source, concatenated. Inlined into a live canvas's
   * sandbox document. Built by `auroraCanvasRuntime` in `vite.config.ts`.
   */
  export const CANVAS_RUNTIME: string;
  /** `aurora/canvas` component styles, injected into the same document. */
  export const CANVAS_STYLES: string;
  /**
   * `@font-face` rules carrying Inter and JetBrains Mono as data URIs. A frame
   * inherits no font faces from its parent and its CSP blocks fetching them,
   * so without these a canvas silently falls back to a system font.
   */
  export const CANVAS_FONTS: string;
}

declare module "virtual:aurora-canvas-exports" {
  /**
   * Every name `aurora/canvas` exports, read from the SDK source at build
   * time. Its own module so the compile gate can validate a canvas's imports
   * without loading the React runtime text. Built by `auroraCanvasRuntime`.
   */
  export const CANVAS_EXPORTS: string[];
}
