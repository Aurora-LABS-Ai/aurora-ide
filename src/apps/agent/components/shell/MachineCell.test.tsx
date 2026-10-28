import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setAuroraRuntimeForTests, type AuroraRuntime } from "@/kernel/lib/ipc/runtime";
import { MachineCell } from "@/apps/agent/components/shell/MachineCell";
import type { MachineStats } from "@/apps/agent/lib/machine/machine-format";

const STATS: MachineStats = {
  hostname: "quantum-core-technology",
  os: "Linux 24.04 Ubuntu",
  arch: "aarch64",
  cpuModel: "Neoverse-N1",
  cpuCores: 4,
  cpuPercent: 2.4,
  memoryUsed: 3.1e9,
  memoryTotal: 25.1e9,
  disk: { mount: "/", used: 37e9, total: 47e9 },
  gpus: [],
  uptimeSecs: 6 * 7 * 86400,
  processes: [{ name: "next-server", cpuPercent: 0.2, memory: 680e6 }],
};

function runtime(invoke: AuroraRuntime["invoke"]): AuroraRuntime {
  return { kind: "web", isAvailable: () => true, listen: async () => () => {}, invoke };
}

describe("MachineCell", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    container = document.createElement("div");
    container.className = "agw-root";
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    setAuroraRuntimeForTests(null);
    delete (window as { __TAURI__?: unknown }).__TAURI__;
  });

  const render = () =>
    act(() => {
      root = createRoot(container);
      root.render(<MachineCell />);
    });

  it("is absent in the desktop window", () => {
    (window as { __TAURI__?: unknown }).__TAURI__ = {};
    setAuroraRuntimeForTests(runtime(vi.fn()));
    render();
    expect(container.querySelector('[aria-label="This machine"]')).toBeNull();
  });

  it("asks the engine only while open, and shows its numbers as meters", async () => {
    const invoke = vi.fn(async () => STATS as never);
    setAuroraRuntimeForTests(runtime(invoke));
    render();
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="This machine"]');
    expect(button).not.toBeNull();
    expect(invoke).not.toHaveBeenCalled();

    await act(async () => {
      button!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      button!.click();
    });

    expect(invoke).toHaveBeenCalledWith("machine_stats", undefined);
    const card = container.querySelector(".agw-machine-card");
    expect(card?.textContent).toContain("quantum-core-technology");
    expect(card?.textContent).toContain("3.1 of 25.1 GB");
    expect(card?.textContent).toContain("None on this machine");
    // 37 of 47 GB is 79%: past 75%, the disk bar is in the warning tone.
    expect(card?.querySelector('[data-tone="warn"]')).not.toBeNull();

    await act(async () => button!.click());
    expect(container.querySelector(".agw-machine-card")).toBeNull();
  });
});
