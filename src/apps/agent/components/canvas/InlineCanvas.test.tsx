/**
 * An inline canvas reads its source from the conversation's artifact store
 * by id and version, without changing the dock's selection, and draws the
 * frame sized to its content; a missing or non-react artifact says so.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const { listThreadArtifacts } = vi.hoisted(() => ({ listThreadArtifacts: vi.fn() }));
vi.mock("@/apps/agent/services/artifacts/agent-artifacts", () => ({ listThreadArtifacts }));
vi.mock("@/apps/agent/components/canvas/CanvasReact", () => ({
  CanvasReact: (props: { source: string; fit?: string }) => (
    <div data-canvas data-fit={props.fit}>{props.source}</div>
  ),
}));
vi.mock("@/apps/agent/shared/AgentIcon", () => ({ AgentIcon: () => null }));

import { InlineCanvas } from "./InlineCanvas";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const mount = async (el: React.ReactElement) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(el));
  return host;
};
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  listThreadArtifacts.mockReset();
});

const bundle = (kind: string) => ({
  threadId: "t1",
  selectedArtifactId: null,
  selectedVersionTag: null,
  artifacts: [
    { id: "pick", title: "Projects", kind, versions: [{ tag: "v1", content: "export default () => null", createdAt: "" }] },
  ],
});

describe("InlineCanvas", () => {
  it("draws the saved version in a content-sized frame, with a way to the dock", async () => {
    listThreadArtifacts.mockResolvedValue(bundle("react"));
    const open = vi.fn();
    const el = await mount(<InlineCanvas threadId="t1" artifactId="pick" versionTag="v1" title="Projects" onOpenInDock={open} />);
    expect(listThreadArtifacts).toHaveBeenCalledWith("t1");
    expect(el.querySelector("[data-canvas]")?.getAttribute("data-fit")).toBe("content");
    expect(el.querySelector("[data-canvas]")?.textContent).toBe("export default () => null");
    expect(el.querySelector(".agw-canvas-inline-title")?.textContent).toBe("Projects");
    act(() => el.querySelector<HTMLButtonElement>(".agw-canvas-inline-open")!.click());
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("says so when the artifact is gone or is not a react canvas", async () => {
    listThreadArtifacts.mockResolvedValue(bundle("markdown"));
    const el = await mount(<InlineCanvas threadId="t1" artifactId="pick" versionTag="v1" title="Projects" onOpenInDock={() => {}} />);
    expect(el.querySelector("[data-canvas]")).toBeNull();
    expect(el.querySelector(".agw-canvas-inline-missing")?.textContent).toContain("react");
    act(() => root?.unmount());
    host?.remove();
    listThreadArtifacts.mockResolvedValue({ ...bundle("react"), artifacts: [] });
    const gone = await mount(<InlineCanvas threadId="t1" artifactId="pick" versionTag="v1" title="Projects" onOpenInDock={() => {}} />);
    expect(gone.querySelector(".agw-canvas-inline-missing")?.textContent).toContain("no longer");
  });
});
