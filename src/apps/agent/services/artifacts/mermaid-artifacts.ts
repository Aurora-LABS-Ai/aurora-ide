import type { MermaidConfig } from "mermaid";

type MermaidApi = (typeof import("mermaid"))["default"];

export interface MermaidPalette {
  canvas: string;
  surface: string;
  surfaceElevated: string;
  text: string;
  textMuted: string;
  border: string;
  accent: string;
  fontFamily: string;
}

let mermaidModule: Promise<MermaidApi> | null = null;
let operationQueue = Promise.resolve();

const loadMermaid = (): Promise<MermaidApi> => {
  mermaidModule ??= import("mermaid").then((module) => module.default);
  return mermaidModule;
};

const enqueueMermaid = <T>(operation: () => Promise<T>): Promise<T> => {
  const task = operationQueue.then(operation);
  operationQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
};

export const describeMermaidError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error:\s*/i, "").split("\n").slice(0, 5).join("\n").trim();
};

/**
 * Layout-neutral palette for validation renders. The colours are irrelevant —
 * only the LAYOUT phase can fail — but `initialize` demands a full config, and
 * using the same config shape as the live render keeps the two paths from
 * diverging in which errors they surface.
 */
const VALIDATION_PALETTE: MermaidPalette = {
  canvas: "#111111",
  surface: "#181818",
  surfaceElevated: "#202020",
  text: "#ededed",
  textMuted: "#9a9a9a",
  border: "#444444",
  accent: "#8b8bff",
  fontFamily: "system-ui, sans-serif",
};

let validationSequence = 0;

/**
 * Validate by rendering the WHOLE diagram, not just parsing it.
 *
 * `mermaid.parse` accepts sources the renderer then rejects — a subgraph id
 * colliding with a node id ("Setting RELAY as parent of RELAY would create a
 * cycle") only fails in layout. Parse-only validation let those save with a
 * green tool result: the model believed the diagram worked while the Canvas
 * showed an error card the model never saw. Rendering here means the write is
 * refused with the renderer's exact message — the same words the user would
 * have seen — so the model can fix the source instead of being told it
 * succeeded.
 */
export const validateMermaidSource = (source: string): Promise<void> =>
  enqueueMermaid(async () => {
    const mermaid = await loadMermaid();
    const id = `agw-mermaid-validate-${++validationSequence}`;
    mermaid.initialize(buildMermaidConfig(VALIDATION_PALETTE));
    try {
      await mermaid.parse(source, { suppressErrors: false });
      await mermaid.render(id, source);
    } finally {
      // Mermaid parks its work in elements named after the id; a failed render
      // can leave them behind.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  });

function buildMermaidConfig(palette: MermaidPalette): MermaidConfig {
  return {
      startOnLoad: false,
      suppressErrorRendering: true,
      securityLevel: "strict",
      theme: "base",
      fontFamily: palette.fontFamily,
      flowchart: { curve: "basis", htmlLabels: true, useMaxWidth: false },
      sequence: { useMaxWidth: false, wrap: true },
      themeVariables: {
        background: palette.canvas,
        primaryColor: palette.surface,
        primaryTextColor: palette.text,
        primaryBorderColor: palette.border,
        secondaryColor: palette.surfaceElevated,
        secondaryTextColor: palette.text,
        secondaryBorderColor: palette.accent,
        tertiaryColor: palette.canvas,
        tertiaryTextColor: palette.text,
        tertiaryBorderColor: palette.border,
        lineColor: palette.textMuted,
        textColor: palette.text,
        mainBkg: palette.surface,
        nodeBorder: palette.border,
        clusterBkg: palette.surfaceElevated,
        clusterBorder: palette.border,
        edgeLabelBackground: palette.canvas,
        actorBkg: palette.surface,
        actorBorder: palette.border,
        actorTextColor: palette.text,
        actorLineColor: palette.textMuted,
        signalColor: palette.textMuted,
        signalTextColor: palette.text,
        labelBackground: palette.canvas,
        labelTextColor: palette.text,
        noteBkgColor: palette.surfaceElevated,
        noteBorderColor: palette.accent,
        noteTextColor: palette.text,
        activationBkgColor: palette.surfaceElevated,
        activationBorderColor: palette.accent,
      },
  };
}

export function renderMermaidSource(
  source: string,
  id: string,
  palette: MermaidPalette,
): Promise<string> {
  return enqueueMermaid(async () => {
    const mermaid = await loadMermaid();
    mermaid.initialize(buildMermaidConfig(palette));
    await mermaid.parse(source, { suppressErrors: false });
    const { svg } = await mermaid.render(id, source);
    return svg;
  });
}
