import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  diagramArtworkBox,
  fitDiagramViewport,
  initialDiagramViewport,
  READABLE_MIN_SCALE,
  readMermaidSvgSize,
  sweepMermaidScratchNodes,
} from "@/apps/agent/lib/render/mermaid-svg";
import { CanvasDiagram } from "@/apps/agent/components/canvas/CanvasDiagram";

/**
 * Stand in for mermaid, reproducing the two things about it that mattered:
 * the id handed to `render` comes back ON the svg root, and a render leaves a
 * scratch container named `d{id}` on the document.
 */
let lastRenderId = "";
vi.mock("@/apps/agent/services/artifacts/mermaid-artifacts", () => ({
  renderMermaidSource: (_source: string, id: string) => {
    lastRenderId = id;
    const scratch = document.createElement("div");
    scratch.id = `d${id}`;
    document.body.appendChild(scratch);
    return Promise.resolve(
      `<svg id="${id}" viewBox="0 0 320 500"><style>#${id} .node{fill:red}</style><g class="node"></g></svg>`,
    );
  },
  describeMermaidError: (error: unknown) => String(error),
}));

vi.mock("@/apps/agent/store/ui/useAgentThemeStore", () => ({
  useAgentThemeStore: (select: (state: unknown) => unknown) =>
    select({ activeThemeId: "agent-dark", customizations: {}, contrast: 1 }),
}));

vi.mock("@/apps/agent/shared", () => ({
  AgentIcon: () => null,
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

describe("readMermaidSvgSize", () => {
  it("uses a valid viewBox before fixed SVG dimensions", () => {
    expect(
      readMermaidSvgSize('<svg viewBox="10 20 640 360" width="100" height="100"></svg>'),
    ).toEqual({ width: 640, height: 360 });
  });

  it("falls back safely when dimensions are missing or malformed", () => {
    expect(readMermaidSvgSize("<svg></svg>")).toEqual({ width: 800, height: 600 });
    expect(readMermaidSvgSize('<svg viewBox="0 0 -10 nope"></svg>')).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("caps pathological diagram dimensions", () => {
    expect(readMermaidSvgSize('<svg viewBox="0 0 999999 888888"></svg>')).toEqual({
      width: 50_000,
      height: 50_000,
    });
  });
});

describe("diagramArtworkBox", () => {
  const size = { width: 640, height: 360 };

  /**
   * The substitution that fixes the blur: zoom grows the box instead of
   * scaling a composited bitmap. It is only safe because both produce the SAME
   * rectangle — `transform-origin: 0 0` grows a scaled layer right-and-down
   * from its top-left corner, which is exactly what a bigger box does.
   */
  it("occupies the rectangle a top-left-origin scale would have", () => {
    const viewport = { x: 120, y: 40, scale: 1.8 };
    const box = diagramArtworkBox(size, viewport);
    // Origin is the pan offset alone — scaling must not move the corner.
    expect(box.left).toBe(viewport.x);
    expect(box.top).toBe(viewport.y);
    // ...and the far edge lands where `scale()` would have put it.
    expect(box.left + box.width).toBeCloseTo(viewport.x + size.width * viewport.scale);
    expect(box.top + box.height).toBeCloseTo(viewport.y + size.height * viewport.scale);
  });

  it("keeps the aspect ratio at every zoom level", () => {
    const ratio = size.width / size.height;
    for (const scale of [0.005, 0.25, 1, 1.8, 4]) {
      const box = diagramArtworkBox(size, { x: 0, y: 0, scale });
      expect(box.width / box.height).toBeCloseTo(ratio);
    }
  });

  /** Zooming must actually enlarge the artwork — the old path enlarged only
   *  the bitmap, which is why 180% still read as unreadably distant. */
  it("grows with the zoom level", () => {
    const fitted = diagramArtworkBox(size, { x: 0, y: 0, scale: 0.1 });
    const zoomed = diagramArtworkBox(size, { x: 0, y: 0, scale: 1.8 });
    expect(zoomed.width).toBeCloseTo(fitted.width * 18);
  });
});

describe("initialDiagramViewport", () => {
  const stage = { width: 900, height: 700 };

  it("keeps the plain fit while it stays readable", () => {
    const diagram = { width: 800, height: 500 };
    expect(initialDiagramViewport(stage, diagram)).toEqual(
      fitDiagramViewport(stage, diagram),
    );
  });

  it("refuses to open a large diagram below the readable floor", () => {
    // The reported failure: a big architecture diagram fit whole into the dock
    // opened at ~25% — every label illegible, and the first act was always the
    // same rescue zoom ("had to zoom 300+").
    const diagram = { width: 4000, height: 3000 };
    const fitted = fitDiagramViewport(stage, diagram);
    const opened = initialDiagramViewport(stage, diagram);
    expect(fitted && fitted.scale).toBeLessThan(READABLE_MIN_SCALE);
    expect(opened?.scale).toBe(READABLE_MIN_SCALE);
  });

  it("anchors a floored diagram at its top, centred, where reading starts", () => {
    const diagram = { width: 4000, height: 3000 };
    const opened = initialDiagramViewport(stage, diagram);
    expect(opened).not.toBeNull();
    // Horizontal centre: equal overflow either side.
    expect(opened!.x).toBeCloseTo((stage.width - diagram.width * opened!.scale) / 2);
    // Top anchored with a small breathing gap, not vertically centred into the
    // middle of the diagram.
    expect(opened!.y).toBeGreaterThan(0);
    expect(opened!.y).toBeLessThan(40);
  });

  it("is null while either box is unmeasured", () => {
    expect(initialDiagramViewport({ width: 0, height: 0 }, { width: 100, height: 100 })).toBeNull();
    expect(initialDiagramViewport(stage, { width: 0, height: 0 })).toBeNull();
  });

  it("never enlarges a small diagram past the fit cap", () => {
    const diagram = { width: 120, height: 80 };
    const opened = initialDiagramViewport(stage, diagram);
    expect(opened?.scale).toBeLessThanOrEqual(2);
    expect(opened?.scale).toBeGreaterThanOrEqual(1);
  });
});

/**
 * The diagram that rendered and then deleted itself.
 *
 * `mermaid.render(id, …)` returns an svg whose ROOT CARRIES THAT ID, and the
 * effect's cleanup called `document.getElementById(id).remove()` to sweep up
 * mermaid's scratch node. Once React had committed the markup, the only element
 * with that id was the diagram, so the sweep deleted the drawing — whenever the
 * commit won a race with the promise's microtask, which is why it rendered on
 * some mounts and not others and almost never survived switching artifacts.
 *
 * What was left behind said nothing: a correctly sized, correctly placed,
 * perfectly empty artwork box, zoom controls live at 65%, no error, no spinner.
 */
describe("the rendered diagram survives its own cleanup", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  const mount = async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<CanvasDiagram source="flowchart TD\n A-->B" title="Map" refreshKey={0} />);
    });
    // Let the render promise and the effect's `finally` both settle.
    await act(async () => { await Promise.resolve(); });
  };

  afterEach(() => {
    if (root) act(() => root!.unmount());
    container?.remove();
    root = null;
    container = null;
    document.querySelectorAll('[id^="dagw-mermaid"]').forEach((node) => node.remove());
  });

  it("leaves the svg inside the artwork", async () => {
    await mount();
    const artwork = container!.querySelector(".agw-diagram-artwork");
    expect(artwork).not.toBeNull();
    expect(artwork!.querySelector("svg")).not.toBeNull();
  });

  it("keeps the id mermaid scopes the diagram's own styles to", async () => {
    await mount();
    const svg = container!.querySelector(".agw-diagram-artwork svg");
    // Stripping the id to dodge the collision would silently unstyle the
    // diagram: mermaid writes `#id .node { … }` into the svg itself.
    expect(svg!.getAttribute("id")).toBe(lastRenderId);
    expect(svg!.querySelector("style")?.textContent).toContain(`#${lastRenderId}`);
  });

  it("still sweeps mermaid's scratch node, which lives outside the stage", async () => {
    await mount();
    expect(document.getElementById(`d${lastRenderId}`)).toBeNull();
  });
});

/**
 * The rule the sweep has to obey, tested on its own.
 *
 * The mount test above cannot prove this: under `act` React always flushes
 * after the render promise settles, so the commit never wins the race and the
 * old code passes it. The ordering that breaks is real but not reproducible in
 * a test, so the guarantee is stated here instead, where it is deterministic.
 */
describe("sweepMermaidScratchNodes", () => {
  const nodeWithId = (id: string, parent: Element) => {
    const node = document.createElement("div");
    node.id = id;
    parent.appendChild(node);
    return node;
  };

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("spares the rendered diagram, which carries the render id", () => {
    const stage = document.createElement("div");
    document.body.appendChild(stage);
    const diagram = nodeWithId("agw-mermaid-7-0", stage);

    sweepMermaidScratchNodes("agw-mermaid-7-0", stage);

    expect(stage.contains(diagram)).toBe(true);
  });

  it("removes mermaid's leftovers, which live outside the stage", () => {
    const stage = document.createElement("div");
    document.body.appendChild(stage);
    nodeWithId("agw-mermaid-7-0", document.body);
    nodeWithId("dagw-mermaid-7-0", document.body);

    sweepMermaidScratchNodes("agw-mermaid-7-0", stage);

    expect(document.getElementById("agw-mermaid-7-0")).toBeNull();
    expect(document.getElementById("dagw-mermaid-7-0")).toBeNull();
  });

  it("sweeps everything when there is no stage to protect", () => {
    nodeWithId("agw-mermaid-7-0", document.body);
    sweepMermaidScratchNodes("agw-mermaid-7-0", null);
    expect(document.getElementById("agw-mermaid-7-0")).toBeNull();
  });
});
