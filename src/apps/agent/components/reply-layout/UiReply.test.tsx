/**
 * The reply language drawn: parts in root order through the same block
 * renderer the fences use, a diagram whose nodes trace their path, a
 * streaming fence that draws what has arrived, and a broken layout that shows
 * the model's text instead of nothing.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const { openExternalUrl } = vi.hoisted(() => ({ openExternalUrl: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/apps/agent/adapters/open-external", () => ({ openExternalUrl }));

import { ReplyLayout } from "./ReplyLayout";
import { traceDiagram as traceFrom } from "@/apps/agent/lib/reply-layout/ui";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const mount = (el: React.ReactElement) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
};
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

const fallback = <pre data-fallback>source</pre>;

const SOURCE = `root = Page("Architecture", [scale, stack, gates, steps])
scale = Stats([Stat("Route handlers", 94), Stat("Client files", 189, "\`\\"use client\\"\`")])
stack = Facts("Stack", ["Runtime | Rust | Tauri backend", "Interface | React"])
gates = Diagram("Gates", [Column("Surfaces", [Node("Admin", "\`app/admin\`"), Node("API")]), Column("Gate", [Node("\`proxy.ts\`")]), Column("Checks", [Node("Layout"), Node("Routes")])])
steps = Flow("Request", ["Enter | Cookie read", "Render | Server component"])
`;

describe("UiReply", () => {
  it("draws every part in root order, row parts through the fences' renderer", () => {
    const el = mount(<ReplyLayout language="aurora-ui" source={SOURCE} closed fallback={fallback} />);
    expect(el.querySelector(".agw-rl-ui-title")?.textContent).toBe("Architecture");
    expect([...el.querySelectorAll(".ac-metric-value")].map((v) => v.textContent)).toEqual(["94", "189"]);
    expect(el.querySelector(".ac-metric-note code")?.textContent).toBe('"use client"');
    expect(el.querySelectorAll(".agw-rl-fact")).toHaveLength(2);
    expect(el.querySelector(".agw-rl-facts .agw-rl-block-title")?.textContent).toBe("Stack");
    expect(el.querySelector(".agw-rl-ui-heading")?.textContent).toBe("Request");
    expect(el.querySelectorAll(".agw-rl-step")).toHaveLength(2);
    expect(el.querySelectorAll(".agw-rl-dia-node")).toHaveLength(5);
    expect(el.querySelector(".agw-rl-problems")).toBeNull();
    expect(el.querySelector("[data-fallback]")).toBeNull();
    const order = [...el.querySelectorAll(".agw-rl-ui-part")].map((p) => p.firstElementChild?.className ?? "");
    expect(order.map((c) => c.split(" ")[0])).toEqual(["agw-rl-ui-title", "ac-metric-grid", "", "agw-rl", ""]);
  });

  it("selecting a node marks it and its path; selecting it again clears the trace", () => {
    const el = mount(<ReplyLayout language="aurora-ui" source={SOURCE} closed fallback={fallback} />);
    const node = (id: string) => el.querySelector<HTMLButtonElement>(`[data-node="${id}"]`)!;
    act(() => node("0:0").click());
    expect(node("0:0").getAttribute("aria-pressed")).toBe("true");
    expect(el.querySelector(".agw-rl-diagram")?.hasAttribute("data-tracing")).toBe(true);
    // Admin → proxy.ts → both checks; the other surface stays unlit.
    expect(["0:0", "1:0", "2:0", "2:1"].every((id) => node(id).hasAttribute("data-on"))).toBe(true);
    expect(node("0:1").hasAttribute("data-on")).toBe(false);
    act(() => node("0:0").click());
    expect(el.querySelector(".agw-rl-diagram")?.hasAttribute("data-tracing")).toBe(false);
  });

  it("traces upstream and downstream, never sideways", () => {
    const edges = [
      { from: [0, 0], to: [1, 0] },
      { from: [0, 1], to: [1, 0] },
      { from: [1, 0], to: [2, 0] },
      { from: [1, 1], to: [2, 1] },
    ] as { from: [number, number]; to: [number, number] }[];
    const fromGate = traceFrom([1, 0], edges);
    expect([...fromGate.nodes].sort()).toEqual(["0:0", "0:1", "1:0", "2:0"]);
    expect([...fromGate.edges].sort()).toEqual([0, 1, 2]);
    // From one surface: up to the gate and on, but not across to the other surface.
    expect([...traceFrom([0, 0], edges).nodes].sort()).toEqual(["0:0", "1:0", "2:0"]);
  });

  it("while streaming, draws the parts that have arrived and names no fault", () => {
    const partial = SOURCE.slice(0, SOURCE.indexOf("gates = ")) + 'gates = Diagram("Gates", [Column(';
    const el = mount(<ReplyLayout language="aurora-ui" source={partial} closed={false} fallback={fallback} />);
    expect(el.querySelectorAll(".ac-metric")).toHaveLength(2);
    expect(el.querySelectorAll(".agw-rl-fact")).toHaveLength(2);
    expect(el.querySelector(".agw-rl-diagram")).toBeNull();
    expect(el.querySelector(".agw-rl-problems")).toBeNull();
  });

  it("draws a link card and source chips that open in the browser, never in the app", () => {
    openExternalUrl.mockClear();
    const source = [
      "root = Page([card, cited])",
      'card = Link("Open BS RoFormer on MVSep", "https://mvsep.com/en", "Official online audio separator", "Paid only")',
      'cited = Sources(["https://a.com/1", "https://b.com/2", "https://c.com/3", "Docs | https://d.com/4", "https://e.com/5"])',
    ].join("\n");
    const el = mount(<ReplyLayout language="aurora-ui" source={source} closed fallback={fallback} />);
    expect(el.querySelector(".agw-rl-link-title")?.textContent).toBe("Open BS RoFormer on MVSep↗");
    expect(el.querySelector(".agw-rl-link-host")?.textContent).toBe("mvsep.com");
    expect(el.querySelector(".agw-rl-link-badge")?.textContent).toBe("Paid only");

    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => el.querySelector(".agw-rl-link-title")!.dispatchEvent(click));
    expect(click.defaultPrevented).toBe(true);
    act(() => el.querySelector<HTMLButtonElement>(".agw-rl-link-open")!.click());
    expect(openExternalUrl.mock.calls).toEqual([["https://mvsep.com/en"], ["https://mvsep.com/en"]]);

    const names = () => [...el.querySelectorAll(".agw-rl-source-name")].map((n) => n.textContent);
    expect(names()).toEqual(["a.com", "b.com", "c.com"]);
    act(() => el.querySelector<HTMLButtonElement>(".agw-rl-source-more")!.click());
    expect(names()).toEqual(["a.com", "b.com", "c.com", "Docs", "e.com"]);
    expect(el.querySelector(".agw-rl-source-more")).toBeNull();
  });

  it("a layout with nothing drawable shows the model's text and says why", () => {
    const el = mount(<ReplyLayout language="aurora-ui" source={'root = Page([a])\na = Chart("x")\n'} closed fallback={fallback} />);
    expect(el.querySelector("[data-fallback]")).not.toBeNull();
    expect(el.querySelector(".agw-rl-problems")?.textContent).toContain('unknown part "Chart"');
  });
});
