import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ErrorBoundary } from "@/kernel/ui/ErrorBoundary";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  return act(async () => root!.render(node));
}

function Explodes({ when }: { when: boolean }) {
  if (when) throw new TypeError("e.split is not a function");
  return <span data-ok>fine</span>;
}

describe("ErrorBoundary", () => {
  it("draws the fallback instead of unmounting everything around it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await mount(
      <div>
        <span data-sibling>still here</span>
        <ErrorBoundary where="test" fallback={(error) => <em data-fallback>{error.message}</em>}>
          <Explodes when />
        </ErrorBoundary>
      </div>,
    );
    expect(container!.querySelector("[data-sibling]")?.textContent).toBe("still here");
    expect(container!.querySelector("[data-fallback]")?.textContent).toBe(
      "e.split is not a function",
    );
  });

  it("logs the failure through console.error so it reaches aurora.log", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await mount(
      <ErrorBoundary where="tool step" fallback={() => null}>
        <Explodes when />
      </ErrorBoundary>,
    );
    const ours = spy.mock.calls.find(
      (args) => typeof args[0] === "string" && args[0].includes("render failed in tool step"),
    );
    expect(ours).toBeDefined();
  });

  it("retries the children when resetKey changes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Host = ({ broken }: { broken: boolean }) => (
      <ErrorBoundary where="test" resetKey={broken} fallback={() => <em data-fallback />}>
        <Explodes when={broken} />
      </ErrorBoundary>
    );
    await mount(<Host broken />);
    expect(container!.querySelector("[data-fallback]")).not.toBeNull();
    await act(async () => root!.render(<Host broken={false} />));
    expect(container!.querySelector("[data-fallback]")).toBeNull();
    expect(container!.querySelector("[data-ok]")).not.toBeNull();
  });
});
