import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { CodeIndexStatus } from "@/apps/agent/components/conversation/CodeIndexStatus";
import type { BuildSnapshot, BuildStatus } from "@/apps/agent/services/code-index/code-index";

const { invoke, readBuild, startBuild } = vi.hoisted(() => ({ invoke: vi.fn(), readBuild: vi.fn(), startBuild: vi.fn() }));
vi.mock("@/kernel/lib/ipc/runtime", () => ({
  auroraInvoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("@/apps/agent/store/conversation/useAgentChatStore", async () => {
  const { create } = await import("zustand");
  return { useAgentChatStore: create(() => ({ projectRoot: "" })) };
});
vi.mock("@/apps/agent/services/code-index/code-index", () => ({
  readIndexBuild: readBuild,
  startIndexBuild: startBuild,
  isIndexBuilding: (job: BuildStatus) => ["queued", "indexing", "indexing"].includes(job.phase),
  buildProgress: (job: BuildStatus) => job.error ?? job.phase,
}));

const snapshot = (job: BuildStatus | null = null) => ({
  settings: { autoBuild: true, searchResults: 8, searchBytes: 24000 },
  index: { built: true, files: 716, symbols: 31153 }, job,
}) as BuildSnapshot;
const job = (phase: BuildStatus["phase"] = "indexing") => ({ id: "build-a", phase }) as BuildStatus;

const PROJECT = "E:/work/app";

const probe = (
  over: Partial<{ ready: boolean; indexableFiles: number; overAutoCap: boolean }> = {},
) => ({ ready: false, indexableFiles: 716, overAutoCap: false, ...over });

describe("CodeIndexStatus", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  const render = async () => {
    await act(async () => {
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
   * `useAgentSettingsStore` bootstrapping itself — `provider_catalog_get_presets`,
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
    readBuild.mockReset().mockResolvedValue(snapshot());
    startBuild.mockReset().mockResolvedValue(job());
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
    await render();
    await probed();
    expect(wrap()).toBeNull();
  });

  it("shows nothing when there is no source it could read", async () => {
    invoke.mockResolvedValue(probe({ indexableFiles: 0 }));
    await render();
    await probed();
    expect(wrap()).toBeNull();
  });

  it("marks an unindexed project without opening anything", async () => {
    invoke.mockResolvedValue(probe());
    await render();
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
    await render();
    await waitFor(() => phase() === "offer", "the status to appear");

    const label = trigger()?.getAttribute("aria-label") ?? "";
    expect(label).toContain("not indexed");
    expect(label).toContain("716");
    expect(trigger()?.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens on click as well as hover, so the keyboard can reach it", async () => {
    invoke.mockResolvedValue(probe());
    await render();
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
    vi.useFakeTimers({ shouldAdvanceTime: true });
    invoke.mockResolvedValue(probe());
    await render();
    await waitFor(() => phase() === "offer", "the status to appear");
    act(() => trigger()?.click());
    act(() => action()?.click());
    await waitFor(() => phase() === "working", "the build to start");

    expect(container.querySelector(".agw-idxstat-spin")).not.toBeNull();

    readBuild.mockResolvedValue(snapshot(job("complete")));
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    await waitFor(() => phase() === "done", "the build to finish");
  });

  it("retires itself once the project is indexed", async () => {
    // Fake timers from the START, and `shouldAdvanceTime` so the promise-based
    // waits below still progress. Installing them later would not control the
    // linger timeout, because the component schedules it the moment the build
    // resolves — under whichever clock was installed then.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    invoke.mockResolvedValue(probe());
    await render();
    await waitFor(() => phase() === "offer", "the status to appear");
    act(() => trigger()?.click());
    act(() => action()?.click());
    await waitFor(() => startBuild.mock.calls.length > 0, "the job to start");
    readBuild.mockResolvedValue(snapshot(job("complete")));
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    await waitFor(() => phase() === "done", "the build to finish");

    await act(async () => {
      vi.advanceTimersByTime(2100);
    });
    expect(wrap()).toBeNull();
  });

  it("keeps the slot and turns red when the build fails", async () => {
    invoke.mockResolvedValue(probe());
    startBuild.mockRejectedValue(new Error("permission denied"));
    await render();
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
    await render();
    await waitFor(() => phase() === "offer", "the status to appear");
    act(() => trigger()?.click());

    expect(container.querySelector(".agw-idxstat-x")).toBeNull();
    expect(panel()?.textContent?.toLowerCase()).not.toContain("dismiss");
  });

  it("says a large project will not be indexed on its own", async () => {
    // Past the automatic cap no turn will ever build this, so the panel must
    // not imply it would happen anyway.
    invoke.mockResolvedValue(probe({ indexableFiles: 28400, overAutoCap: true }));
    await render();
    await waitFor(() => phase() === "offer", "the status to appear");
    act(() => trigger()?.click());

    expect(panel()?.textContent).toContain("Too large");
    expect(panel()?.textContent).toContain("28,400");
  });

  it("observes an existing background build after returning to its project", async () => {
    invoke.mockResolvedValue(probe({ ready: true }));
    readBuild.mockResolvedValue(snapshot(job("indexing")));
    await render();
    await waitFor(() => phase() === "working", "background build progress");
    expect(startBuild).not.toHaveBeenCalled();
    act(() => trigger()?.click());
    expect(panel()?.textContent).toContain("You can switch projects");
  });

  // ── The offer has to stop being true when the project gets an index ────────

  it("stops offering after a build it never saw running finishes", async () => {
    // Reported from the running app: the header read "Not indexed · 96 files"
    // over a project whose index had been built minutes earlier from Settings.
    // A full build of that project takes well under a second, so it starts and
    // finishes inside one tick of this control's one-second poll — the poll
    // never observes a running job, and the offer, probed once at mount, never
    // expired.
    invoke.mockResolvedValue(probe());
    await render();
    await waitFor(() => phase() === "offer", "the offer to appear");

    invoke.mockResolvedValue(probe({ ready: true }));
    readBuild.mockResolvedValue(
      snapshot({ ...job("complete"), id: "elsewhere", finishedAt: Date.now() + 1 } as BuildStatus),
    );
    // One tick of the one-second poll, which is where the finished job is seen.
    await flush(1400);
    expect(phase()).toBe("done");
    expect(startBuild).not.toHaveBeenCalled();
  });

  it("keeps offering when a build it never saw running failed", async () => {
    invoke.mockResolvedValue(probe());
    await render();
    await waitFor(() => phase() === "offer", "the offer to appear");
    readBuild.mockResolvedValue(
      snapshot({ ...job("failed"), id: "elsewhere", finishedAt: Date.now() + 1 } as BuildStatus),
    );
    await flush(1400);
    expect(phase()).toBe("offer");
  });

  it("ignores a build that had already finished before the header existed", async () => {
    // The mount probe is the answer for those. Re-probing would hash every
    // source file a second time for nothing.
    invoke.mockResolvedValue(probe());
    readBuild.mockResolvedValue(
      snapshot({ ...job("complete"), id: "earlier", finishedAt: Date.now() - 60_000 } as BuildStatus),
    );
    await render();
    await waitFor(() => phase() === "offer", "the offer to appear");
    const afterMount = probeCalls().length;
    await flush(1400);
    expect(phase()).toBe("offer");
    expect(probeCalls().length).toBe(afterMount);
  });

  it("checks again when the offer is opened to be read", async () => {
    // The agent's own first message builds an index without ever creating a
    // job, so nothing in the poll can notice. Opening the panel is the moment
    // its claim has to be true.
    invoke.mockResolvedValue(probe());
    await render();
    await waitFor(() => phase() === "offer", "the offer to appear");
    const afterMount = probeCalls().length;

    invoke.mockResolvedValue(probe({ ready: true }));
    act(() => trigger()?.click());
    await waitFor(() => probeCalls().length > afterMount, "the re-check");
    await waitFor(() => phase() === "done", "the offer to clear");
  });

  it("does not hash the project again on every hover", async () => {
    invoke.mockResolvedValue(probe());
    await render();
    await waitFor(() => phase() === "offer", "the offer to appear");
    act(() => trigger()?.click());
    await waitFor(() => probeCalls().length > 1, "the first re-check");
    const afterFirst = probeCalls().length;
    act(() => trigger()?.click());
    act(() => trigger()?.click());
    await flush(30);
    expect(probeCalls().length).toBe(afterFirst);
  });

  it("ignores a late build reply after switching projects", async () => {
    invoke.mockResolvedValue(probe());
    let resolveStart!: (value: BuildStatus) => void;
    startBuild.mockReturnValue(new Promise((resolve) => { resolveStart = resolve; }));
    await render();
    await waitFor(() => phase() === "offer", "project A offer");
    act(() => trigger()?.click());
    act(() => action()?.click());
    await waitFor(() => startBuild.mock.calls.length > 0, "project A start");
    invoke.mockResolvedValue(probe({ ready: true }));
    act(() => useAgentChatStore.setState({ projectRoot: "E:/work/b" }));
    await flush(10);
    await act(async () => resolveStart(job()));
    expect(wrap()).toBeNull();
    expect(startBuild.mock.calls[0]?.[0]).toBe(PROJECT);
  });
});
