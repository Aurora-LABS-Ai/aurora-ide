import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { CodeIndexStatus } from "@/apps/agent/components/conversation/CodeIndexStatus";

const invoke = vi.fn();
vi.mock("@/kernel/lib/ipc/runtime", () => ({
  auroraInvoke: (...args: unknown[]) => invoke(...args),
}));

const PROJECT = "E:/work/app";

const probe = (
  over: Partial<{ ready: boolean; indexableFiles: number; overAutoCap: boolean }> = {},
) => ({ ready: false, indexableFiles: 716, overAutoCap: false, ...over });

describe("CodeIndexStatus", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  const render = () => {
    act(() => {
      root ??= createRoot(container);
      root.render(<CodeIndexStatus />);
    });
  };

  const wrap = () => container.querySelector(".agw-idxstat");
  const phase = () => wrap()?.getAttribute("data-phase") ?? null;
  const trigger = () => container.querySelector<HTMLButtonElement>(".agw-idxstat-btn");
  const panel = () => container.querySelector(".agw-idxstat-pop");
  const action = () => container.querySelector<HTMLButtonElement>(".agw-idxstat-go");

  const flush = async (ms = 0) => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  };

  /**
   * Poll until the condition holds.
   *
   * NOT a fixed number of microtask ticks. This component's state lands after a
   * promise chain that React is free to commit on its own schedule, so counting
   * ticks passes alone and fails intermittently under a loaded full-suite run —
   * which is strictly worse than failing, because it trains you to re-run.
   */
  const waitFor = async (ready: () => boolean, what: string) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (ready()) return;
      await flush(4);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  /**
   * The probe calls only.
   *
   * `invoke` is the window's ONE IPC entry point, so this mock also catches
   * `useSettingsStore` bootstrapping itself — `provider_catalog_get_presets`,
   * `get_app_settings`, `has_providers`, `get_all_providers` — which nothing
   * here triggers or awaits. Asserting on the total call count made this suite
   * pass alone and fail under load, because whether those had landed yet
   * depended on how busy the machine was.
   */
  const probeCalls = () => invoke.mock.calls.filter(([cmd]) => cmd === "code_index_probe");

  /** The probe has been answered and the component has settled on a phase. */
  const probed = async () => {
    await waitFor(() => probeCalls().length > 0, "the probe to be issued");
    await flush(8);
  };

  beforeEach(() => {
    // Without this React does not treat `act()` as authoritative and stops
    // flushing reliably.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    invoke.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    useAgentChatStore.setState({ projectRoot: PROJECT });
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    vi.useRealTimers();
  });

  it("shows nothing when the project already has a usable index", async () => {
    // A project indexed in an earlier session must open with a clean header.
    invoke.mockResolvedValue(probe({ ready: true }));
    render();
    await probed();
    expect(wrap()).toBeNull();
  });

  it("shows nothing when there is no source it could read", async () => {
    invoke.mockResolvedValue(probe({ indexableFiles: 0 }));
    render();
    await probed();
    expect(wrap()).toBeNull();
  });

  it("marks an unindexed project without opening anything", async () => {
    invoke.mockResolvedValue(probe());
    render();
    await waitFor(() => phase() === "offer", "the status to appear");

    expect(panel()).toBeNull();
    // Exactly one probe, and no build: showing the status must never itself
    // parse the workspace.
    expect(probeCalls()).toHaveLength(1);
    expect(probeCalls()[0]?.[1]).toEqual({ workspacePath: PROJECT });
    expect(invoke.mock.calls.some(([cmd]) => cmd === "code_index_rebuild")).toBe(false);
  });

  it("carries its state in the accessible name, not only in the colour", async () => {
    // The glyph is amber and nothing else at rest. Colour cannot be the sole
    // carrier of a state.
    invoke.mockResolvedValue(probe());
    render();
    await waitFor(() => phase() === "offer", "the status to appear");

    const label = trigger()?.getAttribute("aria-label") ?? "";
    expect(label).toContain("not indexed");
    expect(label).toContain("716");
    expect(trigger()?.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens on click as well as hover, so the keyboard can reach it", async () => {
    invoke.mockResolvedValue(probe());
    render();
    await waitFor(() => phase() === "offer", "the status to appear");

    act(() => trigger()?.click());
    expect(panel()).not.toBeNull();
    expect(trigger()?.getAttribute("aria-expanded")).toBe("true");
    expect(panel()?.textContent).toContain("Not indexed");
    expect(action()?.textContent).toBe("Index project");

    act(() => trigger()?.click());
    expect(panel()).toBeNull();
  });

  it("holds its slot through the build instead of vanishing on click", async () => {
    // If the control left the moment work started, a failure and a success
    // would look identical afterwards: an empty header.
    let finish: (v: unknown) => void = () => {};
    invoke.mockImplementation((cmd: string) =>
      cmd === "code_index_probe"
        ? Promise.resolve(probe())
        : new Promise((resolve) => {
            finish = resolve;
          }),
    );
    render();
    await waitFor(() => phase() === "offer", "the status to appear");
    act(() => trigger()?.click());
    act(() => action()?.click());
    await waitFor(() => phase() === "working", "the build to start");

    expect(container.querySelector(".agw-idxstat-spin")).not.toBeNull();

    act(() => finish({ built: true, files: 716, symbols: 31153 }));
    await waitFor(() => phase() === "done", "the build to finish");
  });

  it("retires itself once the project is indexed", async () => {
    // Fake timers from the START, and `shouldAdvanceTime` so the promise-based
    // waits below still progress. Installing them later would not control the
    // linger timeout, because the component schedules it the moment the build
    // resolves — under whichever clock was installed then.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    invoke.mockImplementation((cmd: string) =>
      cmd === "code_index_probe"
        ? Promise.resolve(probe())
        : Promise.resolve({ built: true, files: 716, symbols: 31153 }),
    );
    render();
    await waitFor(() => phase() === "offer", "the status to appear");
    act(() => trigger()?.click());
    act(() => action()?.click());
    await waitFor(() => phase() === "done", "the build to finish");

    await act(async () => {
      vi.advanceTimersByTime(2100);
    });
    expect(wrap()).toBeNull();
  });

  it("keeps the slot and turns red when the build fails", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "code_index_probe"
        ? Promise.resolve(probe())
        : Promise.reject(new Error("permission denied")),
    );
    render();
    await waitFor(() => phase() === "offer", "the status to appear");
    act(() => trigger()?.click());
    act(() => action()?.click());
    await waitFor(() => phase() === "error", "the failure to land");

    // The panel stays OPEN through a failure — unlike success, which closes it,
    // because the reason is the thing the person needs and hiding it behind a
    // second hover would make a failure quieter than a success.
    expect(panel()).not.toBeNull();
    expect(panel()?.textContent).toContain("Indexing failed");
    expect(panel()?.textContent).toContain("permission denied");
    expect(action()?.textContent).toBe("Try again");
  });

  it("has no dismiss control — the state is true until it is fixed", async () => {
    invoke.mockResolvedValue(probe());
    render();
    await waitFor(() => phase() === "offer", "the status to appear");
    act(() => trigger()?.click());

    expect(container.querySelector(".agw-idxstat-x")).toBeNull();
    expect(panel()?.textContent?.toLowerCase()).not.toContain("dismiss");
  });

  it("says a large project will not be indexed on its own", async () => {
    // Past the automatic cap no turn will ever build this, so the panel must
    // not imply it would happen anyway.
    invoke.mockResolvedValue(probe({ indexableFiles: 28400, overAutoCap: true }));
    render();
    await waitFor(() => phase() === "offer", "the status to appear");
    act(() => trigger()?.click());

    expect(panel()?.textContent).toContain("Too large");
    expect(panel()?.textContent).toContain("28,400");
  });
});
