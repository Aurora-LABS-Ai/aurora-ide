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

export const validateMermaidSource = (source: string): Promise<void> =>
  enqueueMermaid(async () => {
    const mermaid = await loadMermaid();
    await mermaid.parse(source, { suppressErrors: false });
  });

export function renderMermaidSource(
  source: string,
  id: string,
  palette: MermaidPalette,
): Promise<string> {
  return enqueueMermaid(async () => {
    const mermaid = await loadMermaid();
    const config: MermaidConfig = {
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

    mermaid.initialize(config);
    await mermaid.parse(source, { suppressErrors: false });
    const { svg } = await mermaid.render(id, source);
    return svg;
  });
}
