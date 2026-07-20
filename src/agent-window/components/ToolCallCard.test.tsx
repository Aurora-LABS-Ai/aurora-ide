import { act, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToolCallCard } from "./ToolCallCard";
import { formatToolDuration } from "./tool-call";

vi.mock("../../store/useSettingsStore", () => ({
  useSettingsStore: (
    select: (state: { explorerIconPack: string }) => unknown,
  ) => select({ explorerIconPack: "material-icon-theme" }),
}));

vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: PropsWithChildren) => children,
  motion: {
    div: ({ children }: PropsWithChildren) => <div>{children}</div>,
  },
}));

vi.mock("./tool-views/ToolCode", () => ({
  ToolCode: ({ code }: { code: string }) => <pre data-tool-code>{code}</pre>,
}));

let mountedRoot: Root | null = null;
let mountedContainer: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => mountedRoot?.unmount());
  mountedContainer?.remove();
  mountedRoot = null;
  mountedContainer = null;
});

describe("ToolCallCard streamed file targets", () => {
  it("renders present_artifact as a dedicated non-expandable Canvas launcher", () => {
    const html = renderToStaticMarkup(
      <ToolCallCard
        call={{
          id: "canvas-1",
          name: "present_artifact",
          arguments: JSON.stringify({
            artifactId: "particle-wave",
            title: "Particle Wave — Interactive Demo",
            kind: "html",
            content: "<main>Demo</main>",
          }),
          result: JSON.stringify({ success: true, versionTag: "v1" }),
        }}
      />,
    );

    expect(html).toContain("agw-canvas-launch");
    expect(html).toContain("Particle Wave — Interactive Demo");
    expect(html).toContain("v1");
    expect(html).not.toContain("agw-tool-head");
    expect(html).not.toContain("aria-expanded");
  });

  it("shows a write chip before the path string or tool call finishes", () => {
    const html = renderToStaticMarkup(
      <ToolCallCard
        isActivelyStreaming
        call={{
          id: "write-1",
          name: "file_write",
          arguments: '{"path":"voidtask/tests/lib/store-crud.test.ts',
        }}
      />,
    );

    expect(html).toContain("agw-tool-targets");
    expect(html).toContain("store-crud.test.ts");
    expect(html).toContain("Running");
  });

  it("shows every streamed file in a multi-file edit", () => {
    const html = renderToStaticMarkup(
      <ToolCallCard
        isActivelyStreaming
        call={{
          id: "edit-1",
          name: "file_edit",
          arguments:
            '{"target_paths":["tests/a.test.ts","tests/b.test.ts","tests/c.test.ts","tests/d.test.ts"],"edits":[',
        }}
      />,
    );

    expect(html.match(/class="agw-tool-chip"/g)).toHaveLength(4);
    expect(html).toContain("a.test.ts");
    expect(html).toContain("b.test.ts");
    expect(html).toContain("c.test.ts");
    expect(html).toContain("d.test.ts");
  });

  it("shows every file-read target as an individual horizontal chip", () => {
    const html = renderToStaticMarkup(
      <ToolCallCard
        call={{
          id: "read-many",
          name: "file_read",
          arguments: JSON.stringify({ paths: ["src/a.ts", "docs/README.md", "AGENTS.md"] }),
          result: JSON.stringify({
            success: true,
            filesRead: 3,
            files: [
              { path: "src/a.ts", success: true, content: "const a = 1;", lines: 1 },
              { path: "docs/README.md", success: true, content: "# Readme", lines: 1 },
              { path: "AGENTS.md", success: true, content: "# Rules", lines: 1 },
            ],
          }),
        }}
      />,
    );

    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toContain("a.ts");
    expect(html).toContain("README.md");
    expect(html).toContain("AGENTS.md");
    expect(html).not.toContain("+2");
  });

  it("mounts only the selected file and switches content when its chip is clicked", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mountedContainer = document.createElement("div");
    document.body.appendChild(mountedContainer);
    mountedRoot = createRoot(mountedContainer);

    await act(async () => {
      mountedRoot!.render(
        <ToolCallCard
          call={{
            id: "read-switch",
            name: "file_read",
            arguments: JSON.stringify({ paths: ["src/a.ts", "src/b.ts"] }),
            result: JSON.stringify({
              success: true,
              filesRead: 2,
              files: [
                { path: "src/a.ts", success: true, content: "FIRST_FILE", lines: 1 },
                { path: "src/b.ts", success: true, content: "SECOND_FILE", lines: 1 },
              ],
            }),
          }}
        />,
      );
    });

    const header = mountedContainer.querySelector<HTMLButtonElement>(".agw-tool-head");
    await act(async () => header!.click());

    expect(mountedContainer.querySelectorAll("[data-tool-code]")).toHaveLength(1);
    expect(mountedContainer.textContent).toContain("FIRST_FILE");
    expect(mountedContainer.textContent).not.toContain("SECOND_FILE");

    const tabs = mountedContainer.querySelectorAll<HTMLElement>('[role="tab"]');
    expect(tabs).toHaveLength(2);
    await act(async () => tabs[1].click());

    expect(mountedContainer.querySelectorAll("[data-tool-code]")).toHaveLength(1);
    expect(mountedContainer.textContent).not.toContain("FIRST_FILE");
    expect(mountedContainer.textContent).toContain("SECOND_FILE");

    await act(async () => {
      tabs[1].dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }));
    });
    expect(mountedContainer.textContent).toContain("FIRST_FILE");
    expect(mountedContainer.textContent).not.toContain("SECOND_FILE");
  });

  it("shows one multi-file edit diff and switches it from the file chips", async () => {
    mountedContainer = document.createElement("div");
    document.body.appendChild(mountedContainer);
    mountedRoot = createRoot(mountedContainer);

    await act(async () => {
      mountedRoot!.render(
        <ToolCallCard
          call={{
            id: "edit-switch",
            name: "file_edit",
            arguments: JSON.stringify({ target_paths: ["src/a.ts", "src/b.ts"] }),
            result: JSON.stringify({
              success: true,
              multiFile: true,
              filesEdited: 2,
              files: [
                {
                  path: "src/a.ts",
                  oldContent: "FIRST_OLD",
                  newContent: "FIRST_NEW",
                  linesAdded: 1,
                  linesRemoved: 1,
                },
                {
                  path: "src/b.ts",
                  oldContent: "SECOND_OLD",
                  newContent: "SECOND_NEW",
                  linesAdded: 1,
                  linesRemoved: 1,
                },
              ],
            }),
          }}
        />,
      );
    });

    const header = mountedContainer.querySelector<HTMLButtonElement>(".agw-tool-head")!;
    const tabs = mountedContainer.querySelectorAll<HTMLElement>('[role="tab"]');
    expect(tabs).toHaveLength(2);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    await act(async () => tabs[1].click());

    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(mountedContainer.textContent).toContain("SECOND_NEW");
    expect(mountedContainer.textContent).not.toContain("FIRST_NEW");

    await act(async () => tabs[0].click());

    expect(mountedContainer.textContent).toContain("FIRST_NEW");
    expect(mountedContainer.textContent).not.toContain("SECOND_NEW");
  });

  it("expands a single-file edit when its visible file chip is clicked", async () => {
    mountedContainer = document.createElement("div");
    document.body.appendChild(mountedContainer);
    mountedRoot = createRoot(mountedContainer);

    await act(async () => {
      mountedRoot!.render(
        <ToolCallCard
          call={{
            id: "edit-chip-toggle",
            name: "file_edit",
            arguments: JSON.stringify({
              path: "src/hero.tsx",
              old_string: "OLD_HERO",
              new_string: "NEW_HERO",
            }),
            result: "Updated src/hero.tsx",
          }}
        />,
      );
    });

    const header = mountedContainer.querySelector<HTMLButtonElement>(".agw-tool-head")!;
    const chip = mountedContainer.querySelector<HTMLElement>(".agw-tool-chip")!;
    expect(header.getAttribute("aria-expanded")).toBe("false");

    await act(async () => chip.click());

    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(mountedContainer.textContent).toContain("NEW_HERO");

    await act(async () => header.click());

    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(mountedContainer.textContent).not.toContain("NEW_HERO");
  });

  it("drag-scrolls an overflowing file chip strip without opening the card", async () => {
    mountedContainer = document.createElement("div");
    document.body.appendChild(mountedContainer);
    mountedRoot = createRoot(mountedContainer);
    await act(async () => {
      mountedRoot!.render(
        <ToolCallCard
          call={{
            id: "read-scroll",
            name: "file_read",
            arguments: JSON.stringify({ paths: ["a.ts", "b.ts", "c.ts"] }),
            result: JSON.stringify({
              success: true,
              filesRead: 3,
              files: ["a.ts", "b.ts", "c.ts"].map((path) => ({
                path,
                success: true,
                content: path,
                lines: 1,
              })),
            }),
          }}
        />,
      );
    });

    const strip = mountedContainer.querySelector<HTMLElement>(".agw-tool-targets")!;
    let capturedPointer = -1;
    Object.defineProperties(strip, {
      scrollWidth: { configurable: true, value: 600 },
      clientWidth: { configurable: true, value: 180 },
      scrollLeft: { configurable: true, value: 0, writable: true },
      setPointerCapture: {
        configurable: true,
        value: (pointerId: number) => { capturedPointer = pointerId; },
      },
      hasPointerCapture: {
        configurable: true,
        value: (pointerId: number) => capturedPointer === pointerId,
      },
      releasePointerCapture: {
        configurable: true,
        value: (pointerId: number) => {
          if (capturedPointer === pointerId) capturedPointer = -1;
        },
      },
    });

    act(() => {
      strip.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 140,
        pointerId: 7,
      }));
      strip.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true,
        buttons: 1,
        clientX: 80,
        pointerId: 7,
      }));
      strip.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true,
        clientX: 80,
        pointerId: 7,
      }));
      strip.click();
    });

    expect(strip.scrollLeft).toBe(60);
    expect(capturedPointer).toBe(-1);
    expect(mountedContainer.querySelector(".agw-tool-head")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps chip clicks native on an overflowing strip — no capture on a plain press", async () => {
    mountedContainer = document.createElement("div");
    document.body.appendChild(mountedContainer);
    mountedRoot = createRoot(mountedContainer);
    await act(async () => {
      mountedRoot!.render(
        <ToolCallCard
          call={{
            id: "read-plain-press",
            name: "file_read",
            arguments: JSON.stringify({ paths: ["a.ts", "b.ts", "c.ts"] }),
            result: JSON.stringify({
              success: true,
              filesRead: 3,
              files: ["a.ts", "b.ts", "c.ts"].map((path) => ({
                path,
                success: true,
                content: `CONTENT_${path}`,
                lines: 1,
              })),
            }),
          }}
        />,
      );
    });

    const strip = mountedContainer.querySelector<HTMLElement>(".agw-tool-targets")!;
    let captureCalls = 0;
    Object.defineProperties(strip, {
      scrollWidth: { configurable: true, value: 600 },
      clientWidth: { configurable: true, value: 180 },
      setPointerCapture: {
        configurable: true,
        value: () => { captureCalls += 1; },
      },
      hasPointerCapture: { configurable: true, value: () => false },
      releasePointerCapture: { configurable: true, value: () => undefined },
    });

    // A press with sub-threshold jitter (real clicks always wobble a pixel)
    // must never capture the pointer: pointer capture retargets the click to
    // the strip and makes every chip dead — the original bug.
    const tabs = mountedContainer.querySelectorAll<HTMLElement>('[role="tab"]');
    await act(async () => {
      tabs[1].dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 140,
        pointerId: 5,
      }));
      tabs[1].dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true,
        buttons: 1,
        clientX: 139,
        pointerId: 5,
      }));
      tabs[1].dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true,
        clientX: 139,
        pointerId: 5,
      }));
      tabs[1].click();
    });

    expect(captureCalls).toBe(0);
    expect(mountedContainer.textContent).toContain("CONTENT_b.ts");
    expect(mountedContainer.textContent).not.toContain("CONTENT_a.ts");
  });

  it("disarms double-click selection and collapses a live selection on header press", async () => {
    mountedContainer = document.createElement("div");
    document.body.appendChild(mountedContainer);
    mountedRoot = createRoot(mountedContainer);
    await act(async () => {
      mountedRoot!.render(
        <ToolCallCard
          call={{
            id: "read-dblclick",
            name: "file_read",
            arguments: JSON.stringify({ paths: ["a.ts"] }),
            result: JSON.stringify({
              success: true,
              filesRead: 1,
              files: [{ path: "a.ts", success: true, content: "A", lines: 1 }],
            }),
          }}
        />,
      );
    });

    const removeAllRanges = vi.fn();
    const getSelection = vi
      .spyOn(window, "getSelection")
      .mockReturnValue({ isCollapsed: false, removeAllRanges } as unknown as Selection);

    try {
      const header = mountedContainer.querySelector<HTMLElement>(".agw-tool-head")!;
      const secondPress = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        detail: 2,
      });
      await act(async () => {
        header.dispatchEvent(secondPress);
      });

      // Double-click word selection is the WebView2 STATUS_BREAKPOINT trigger.
      expect(secondPress.defaultPrevented).toBe(true);
      expect(removeAllRanges).toHaveBeenCalled();
    } finally {
      getSelection.mockRestore();
    }
  });

  it("formats tool durations compactly", () => {
    expect(formatToolDuration(420)).toBe("0.4s");
    expect(formatToolDuration(1234)).toBe("1.2s");
    expect(formatToolDuration(14_600)).toBe("15s");
    expect(formatToolDuration(72_000)).toBe("1m 12s");
    expect(formatToolDuration(120_000)).toBe("2m");
  });

  it("shows a quiet duration label on a settled card and none while running", () => {
    const settled = renderToStaticMarkup(
      <ToolCallCard
        call={{
          id: "timed-1",
          name: "shell_execute",
          arguments: JSON.stringify({ command: "pnpm test" }),
          result: JSON.stringify({ success: true, exitCode: 0, stdout: "ok" }),
          durationMs: 1234,
        }}
      />,
    );
    expect(settled).toContain("agw-tool-time");
    expect(settled).toContain("1.2s");

    const fast = renderToStaticMarkup(
      <ToolCallCard
        call={{
          id: "timed-2",
          name: "file_read",
          arguments: JSON.stringify({ path: "a.ts" }),
          result: JSON.stringify({ success: true, content: "x" }),
          durationMs: 80,
        }}
      />,
    );
    // Sub-500ms is row noise, not signal.
    expect(fast).not.toContain("agw-tool-time");
  });

  it("collapses a long file strip into visible chips plus a +N overflow menu", async () => {
    mountedContainer = document.createElement("div");
    document.body.appendChild(mountedContainer);
    mountedRoot = createRoot(mountedContainer);
    const paths = Array.from({ length: 9 }, (_, i) => `src/file-${i}.ts`);
    await act(async () => {
      mountedRoot!.render(
        <ToolCallCard
          call={{
            id: "read-overflow",
            name: "file_read",
            arguments: JSON.stringify({ paths }),
            result: JSON.stringify({
              success: true,
              filesRead: paths.length,
              files: paths.map((path) => ({
                path,
                success: true,
                content: `CONTENT_${path}`,
                lines: 1,
              })),
            }),
          }}
        />,
      );
    });

    // 6 inline tabs + the "+3" trigger; the menu lists ONLY the hidden files
    // (the inline chips already name the rest).
    expect(mountedContainer.querySelectorAll('[role="tab"]')).toHaveLength(6);
    const trigger = mountedContainer.querySelector<HTMLElement>(".agw-tool-chip-more")!;
    expect(trigger.textContent).toBe("+3");

    await act(async () => trigger.click());
    const options = document.querySelectorAll<HTMLElement>(".agw-chip-overflow-item");
    expect(options).toHaveLength(3);
    expect(options[0].textContent).toContain("file-6.ts");

    // Selecting a hidden file swaps it into the inline strip and shows it.
    await act(async () => options[2].click());
    expect(mountedContainer.textContent).toContain("CONTENT_src/file-8.ts");
    expect(
      mountedContainer.querySelector('[role="tab"][data-index="8"]'),
    ).not.toBeNull();
    expect(document.querySelectorAll(".agw-chip-overflow-item")).toHaveLength(0);
  });

  it("never exposes a full target path in a failed toolbar summary", () => {
    const html = renderToStaticMarkup(
      <ToolCallCard
        call={{
          id: "write-failed",
          name: "file_write",
          arguments: '{"path":"E:\\\\work\\\\secret\\\\temp_file.ts","content":"x"}',
          result: "[error] Failed to write E:\\work\\secret\\temp_file.ts",
        }}
      />,
    );

    expect(html).toContain("temp_file.ts");
    expect(html).not.toContain("E:\\work\\secret");
  });
});
