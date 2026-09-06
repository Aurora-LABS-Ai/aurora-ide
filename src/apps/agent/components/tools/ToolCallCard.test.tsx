import {
  act,
  createElement,
  forwardRef,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ChecklistBeatCard,
  ToolCallCard,
} from "@/apps/agent/components/tools/ToolCallCard";
import { ToolGroup } from "@/apps/agent/components/tools/ToolGroup";
import {
  formatToolDuration,
  groupChecklistRuns,
  type ToolCall,
} from "@/apps/agent/components/tools/tool-call";

vi.mock("@/kernel/store/useSettingsStore", () => ({
  useSettingsStore: (
    select: (state: { explorerIconPack: string }) => unknown,
  ) => select({ explorerIconPack: "material-icon-theme" }),
}));

/**
 * Motion elements render as their plain tag, keeping `className` and the rest
 * of the DOM props (the target reel's cells are found by class) and forwarding
 * the ref, which the reel uses to measure the cell it is widening to.
 */
vi.mock("framer-motion", () => {
  const passthrough = (tag: "div" | "span" | "button") =>
    forwardRef<HTMLElement, Record<string, unknown>>(function Motion(props, ref) {
      const { children, initial, animate, exit, transition, layout, ...rest } = props;
      void initial;
      void animate;
      void exit;
      void transition;
      void layout;
      return createElement(tag, { ...rest, ref }, children as ReactNode);
    });
  return {
    AnimatePresence: ({ children }: PropsWithChildren) => children,
    motion: {
      div: passthrough("div"),
      span: passthrough("span"),
      // `ToolGroup`'s collapsible header is a motion.button.
      button: passthrough("button"),
    },
  };
});

vi.mock("@/apps/agent/components/tool-views/ToolCode", () => ({
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

  const MULTI_EDIT_ARGS =
    '{"target_paths":["tests/a.test.ts","tests/b.test.ts","tests/c.test.ts","tests/d.test.ts"],"edits":[';

  it("states the count on the row once a call that touched several files settles", () => {
    const html = renderToStaticMarkup(
      <ToolCallCard
        call={{
          id: "edit-1",
          name: "file_edit",
          arguments: MULTI_EDIT_ARGS,
          result: '{"success":true}',
        }}
      />,
    );

    // ONE chip, carrying the count. The names live in the dropdown.
    expect(html.match(/class="agw-tool-chip agw-tool-chip-count"/g)).toHaveLength(1);
    expect(html.match(/class="agw-tool-chip"/g)).toBeNull();
    expect(html).toContain("4 files");
    // The title is the ACT, and it does not change with the count or with the
    // status — no "Edit File" / "Edit Files" one-letter distinction, and no
    // rename to "Editing Multiple Files" halfway through the turn.
    expect(html).toContain(">Edit</span>");
    expect(html).not.toContain("Editing Multiple Files");
    expect(html).not.toContain(">Edit Files</span>");
  });

  it("reads the files by name while the call is still running", () => {
    const html = renderToStaticMarkup(
      <ToolCallCard
        isActivelyStreaming
        call={{ id: "edit-2", name: "file_edit", arguments: MULTI_EDIT_ARGS }}
      />,
    );

    // Same chip as the settled row above — the shape is decided by the
    // argument being a list, not by how much of it has arrived, so there is no
    // moment where one kind of chip is swapped for another.
    expect(html.match(/class="agw-tool-chip agw-tool-chip-count"/g)).toHaveLength(1);
    expect(html).toContain("agw-tool-reel");
    // Saying the first file it will touch, not the count it settles on.
    expect(html).toContain("a.test.ts");
    expect(html).not.toContain("4 files");
  });

  it("never replays the reel for a call that was already finished", () => {
    // A reloaded thread would otherwise narrate every read in it at once.
    const html = renderToStaticMarkup(
      <ToolCallCard
        call={{
          id: "edit-3",
          name: "file_edit",
          arguments: MULTI_EDIT_ARGS,
          result: '{"success":true}',
        }}
      />,
    );

    // `data-live` marks the cell that is reading a name out. A settled card
    // opens on its summary and has none. (The paths themselves are still in
    // the chip's tooltip and the dropdown, which is why this asserts the reel
    // rather than the absence of the word.)
    expect(html).toContain("4 files");
    expect(html).not.toContain("data-live");
  });

  it("keeps its filename on the row when a call touched exactly one file", () => {
    const html = renderToStaticMarkup(
      <ToolCallCard
        call={{
          id: "read-one",
          name: "file_read",
          arguments: JSON.stringify({ path: "src/a.ts" }),
          result: JSON.stringify({ success: true, content: "const a = 1;", lines: 1 }),
        }}
      />,
    );

    // One target has nothing to compact, and its name is the most useful thing
    // on the row — so it is never replaced by "1 file".
    expect(html).toContain("a.ts");
    expect(html).not.toContain("agw-tool-chip-count");
    expect(html).not.toContain("1 file");
  });

  it("stacks one mark per distinct file type, never the same mark twice", () => {
    const sameType = renderToStaticMarkup(
      <ToolCallCard
        call={{
          id: "edit-same",
          name: "file_edit",
          arguments: JSON.stringify({
            target_paths: [".knowledge/knowledge.md", ".knowledge/lesson.md"],
          }),
        }}
      />,
    );
    const mixed = renderToStaticMarkup(
      <ToolCallCard
        call={{
          id: "edit-mixed",
          name: "file_edit",
          arguments: JSON.stringify({ target_paths: ["a.md", "b.ts", "c.py"] }),
        }}
      />,
    );

    const marks = (html: string) => {
      const stack = html.match(/class="agw-chip-stack"[^>]*>(.*?)<\/span>/s)?.[1] ?? "";
      return stack.match(/<svg|<img/g)?.length ?? 0;
    };

    // Two markdown files are ONE kind. Drawing the mark twice reads as a
    // quantity, and it is the wrong quantity — the stack caps at 3 while the
    // count beside it does not.
    expect(marks(sameType)).toBe(1);
    expect(sameType).toContain("2 files");
    expect(marks(mixed)).toBe(3);
  });

  it("counts streamed lines while a write's path has not arrived yet", () => {
    // The model often emits `content` BEFORE `path` — the filename genuinely
    // isn't on the wire yet, so the card can't show a chip. It must show live
    // progress instead of a bare "Writing…".
    const html = renderToStaticMarkup(
      <ToolCallCard
        isActivelyStreaming
        call={{
          id: "write-2",
          name: "file_write",
          arguments: '{"content":"line one\\nline two\\nline three',
        }}
      />,
    );

    expect(html).not.toContain("agw-tool-targets");
    expect(html).toContain("Writing… 3 lines");
  });

  it("narrates a pathless streaming call with its OWN verb, not a generic one", () => {
    // Same situation as above for a tool whose verb is not "Writing". The card
    // reads `activity.verb`, which used to be dropped on the no-target path —
    // so an Edit row narrated itself as "Writing…" while its title said "Edit".
    const html = renderToStaticMarkup(
      <ToolCallCard
        isActivelyStreaming
        call={{
          id: "edit-streaming",
          name: "file_edit",
          arguments: '{"new_string":"line one\\nline two',
        }}
      />,
    );

    expect(html).toContain("Editing… 2 lines");
    expect(html).not.toContain("Writing…");
  });

  it("draws a search scope as the folder it is, using the reader's icon pack", () => {
    // `grep`'s `path` says WHERE to look. It is a directory far more often than
    // a file, and asking the icon set for a file handed back the blank page —
    // the wrong picture, and one word after "Search" it read as the term.
    const folderScope = renderToStaticMarkup(
      <ToolCallCard
        call={{
          id: "grep-folder",
          name: "grep",
          arguments: JSON.stringify({
            path: "src/integrations",
            pattern: "providerProfiles",
          }),
          result: JSON.stringify({ matches: [], pattern: "providerProfiles" }),
        }}
      />,
    );
    // The extension still decides: a path naming a file keeps its file icon.
    const fileScope = renderToStaticMarkup(
      <ToolCallCard
        call={{
          id: "grep-file",
          name: "grep",
          arguments: JSON.stringify({
            path: "src/api/client.rs",
            pattern: "ReasoningReplay",
          }),
          result: JSON.stringify({ matches: [], pattern: "ReasoningReplay" }),
        }}
      />,
    );

    expect(folderScope).toContain("/material-icons/folder-connection.svg");
    expect(folderScope).not.toContain("/material-icons/file.svg");
    expect(fileScope).toContain("/material-icons/rust.svg");
  });

  it("says what a search looked FOR beside where it looked", () => {
    // Two searches of one folder used to draw the identical row. The pattern is
    // the only thing telling them apart, and the collapsed row is most of a
    // transcript.
    const render = (pattern: string) =>
      renderToStaticMarkup(
        <ToolCallCard
          call={{
            id: `grep-${pattern}`,
            name: "grep",
            arguments: JSON.stringify({ path: "src/integrations", pattern }),
            result: JSON.stringify({ matches: [], pattern }),
          }}
        />,
      );

    const first = render("providerProfiles");
    const second = render("extraHeaders");

    expect(first).toContain("agw-tool-chip-pattern");
    expect(first).toContain("providerProfiles");
    expect(second).toContain("extraHeaders");
    expect(first).not.toEqual(second);
  });

  it("states a search pattern once per card, never three times", () => {
    // It heads the result view and now rides the row; a third copy in the raw
    // arg list is the same string stated three times inside one card.
    const html = renderToStaticMarkup(
      <ToolCallCard
        call={{
          id: "grep-dupes",
          name: "grep",
          arguments: JSON.stringify({ path: "src", pattern: "UNIQUE_TOKEN" }),
          result: JSON.stringify({ matches: [], pattern: "UNIQUE_TOKEN" }),
        }}
      />,
    );

    expect(html).not.toContain("pattern:</span>");
  });

  it("shows the pattern even when a search names no path at all", () => {
    // No `path` means the whole workspace — there is no scope chip to hang the
    // pattern off, and the row would otherwise say only "Search".
    const html = renderToStaticMarkup(
      <ToolCallCard
        call={{
          id: "grep-rootless",
          name: "grep",
          arguments: JSON.stringify({ pattern: "BUILTIN_TOOL_COUNT" }),
          result: JSON.stringify({ matches: [], pattern: "BUILTIN_TOOL_COUNT" }),
        }}
      />,
    );

    expect(html).toContain("agw-tool-chip-pattern");
    expect(html).toContain("BUILTIN_TOOL_COUNT");
  });

  it("badges a settled command with the shell that actually ran", () => {
    const html = renderToStaticMarkup(
      <ToolCallCard
        call={{
          id: "sh-1",
          name: "shell_execute",
          // The model asked for bash…
          arguments: JSON.stringify({ command: "echo hi", shell: "bash" }),
          // …but the runtime substituted pwsh — the badge must say pwsh.
          result: JSON.stringify({
            success: true,
            exitCode: 0,
            stdout: "hi",
            shell: "pwsh",
            shellNote: "'bash' is not configured; ran in PowerShell 7 instead.",
          }),
        }}
      />,
    );

    expect(html).toContain("agw-shell-badge");
    expect(html).toContain('data-shell-family="powershell"');
    expect(html).toContain(">pwsh<");
    expect(html).not.toContain(">bash<");
  });

  it("badges a still-streaming command from the requested shell argument", () => {
    const html = renderToStaticMarkup(
      <ToolCallCard
        isActivelyStreaming
        call={{
          id: "sh-2",
          name: "shell_execute",
          // Arguments JSON still open — only the streamed scanner can read it.
          arguments: '{"shell":"cmd","command":"dir /b src',
        }}
      />,
    );

    expect(html).toContain("agw-shell-badge");
    expect(html).toContain('data-shell-family="cmd"');
    expect(html).toContain(">cmd<");
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
    expect(mountedContainer.textContent).toContain("2 files");
    expect(mountedContainer.textContent).not.toContain("Editing Multiple Files");
    // Collapsed, the file names are NOT on the row — that is the whole point.
    expect(mountedContainer.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(header.getAttribute("aria-expanded")).toBe("false");

    await act(async () => header.click());

    const tabs = mountedContainer.querySelectorAll<HTMLElement>('[role="tab"]');
    expect(tabs).toHaveLength(2);
    expect(mountedContainer.textContent).toContain("FIRST_NEW");
    expect(mountedContainer.textContent).not.toContain("SECOND_NEW");

    // Selecting a file still drives which diff shows, exactly as it did when
    // the strip lived on the row.
    await act(async () => tabs[1].click());
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

  it("counts up on a running card once the wait is worth noticing", () => {
    const running = (startedAt: number | undefined, now: number) => {
      vi.setSystemTime(now);
      return renderToStaticMarkup(
        <ToolCallCard
          // A call with no result only counts as running while the turn is
          // live — see `toolStatus`.
          isActivelyStreaming
          call={{
            id: "running-1",
            name: "shell_execute",
            arguments: JSON.stringify({ command: "pnpm lint && pnpm build" }),
            result: null,
            startedAt,
          }}
        />,
      );
    };

    vi.useFakeTimers();
    try {
      const started = 1_000_000;
      // Under two seconds: most calls land here, and a digit that appears and
      // vanishes on every one of six batched reads is worse than none.
      expect(running(started, started + 1_500)).not.toContain("agw-tool-time");
      // Past it, the number is the answer to "is this working or stuck".
      expect(running(started, started + 47_000)).toContain("47s");
      expect(running(started, started + 300_000)).toContain("5m");
      // Rebuilt from history: Rust never persisted a start time, so there is
      // nothing honest to show and the row shows nothing.
      expect(running(undefined, started + 300_000)).not.toContain("agw-tool-time");
    } finally {
      vi.useRealTimers();
    }
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

  it("keeps failure detail in the expanded dropdown, not the tool header", () => {
    const error = "execution failed: no element matches #does-not-exist";
    const html = renderToStaticMarkup(
      <ToolCallCard
        isActivelyStreaming
        call={{
          id: "click-failed",
          name: "browser_click",
          arguments: '{"selector":"#does-not-exist"}',
          result: `[error] ${error}`,
          durationMs: 4_100,
        }}
      />,
    );
    const header = html.match(/<button[^>]*class="agw-tool-head"[\s\S]*?<\/button>/)?.[0];

    expect(header).toBeDefined();
    expect(header).not.toContain(error);
    expect(header).toContain("4.1s");
  });

  /**
   * The structured-failure path: the tool answers `success: false` with a whole
   * sentence, which used to be planted in the header's summary slot and clipped
   * mid-word behind an ellipsis. The row states the outcome; the sentence and
   * its recovery hint belong to the dropdown.
   */
  it("states only the outcome on the row when a tool reports a reasoned failure", () => {
    const error = "Replacement 3: Could not find the specified text in the original file snapshot.";
    const hint = "The text still needs to match the current file content exactly.";
    const html = renderToStaticMarkup(
      <ToolCallCard
        isActivelyStreaming
        call={{
          id: "edit-failed",
          name: "search_replace",
          arguments: JSON.stringify({ path: "src-tauri/src/mod.rs" }),
          result: JSON.stringify({ success: false, error, hint }),
        }}
      />,
    );
    const header = html.match(/<button[^>]*class="agw-tool-head"[\s\S]*?<\/button>/)?.[0];

    expect(header).toBeDefined();
    expect(header).not.toContain("Could not find the specified text");
    expect(header).toContain("Failed");
    // The filename still earns its place on the row — it says WHICH file.
    expect(header).toContain("mod.rs");
  });

  it("leaves a failed card collapsed until the reader opens it, like every other tool", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mountedContainer = document.createElement("div");
    document.body.appendChild(mountedContainer);
    mountedRoot = createRoot(mountedContainer);

    const error = "Replacement 3: Could not find the specified text in the original file snapshot.";
    await act(async () => {
      mountedRoot!.render(
        // Mid-turn: the case that used to force itself open and then stay open
        // for the rest of the turn.
        <ToolCallCard
          isActivelyStreaming
          call={{
            id: "edit-failed-collapse",
            name: "search_replace",
            arguments: JSON.stringify({ path: "src-tauri/src/mod.rs" }),
            result: JSON.stringify({ success: false, error }),
          }}
        />,
      );
    });

    const head = mountedContainer.querySelector<HTMLButtonElement>(".agw-tool-head");
    expect(head).not.toBeNull();
    expect(head!.getAttribute("aria-expanded")).toBe("false");
    expect(mountedContainer.textContent).not.toContain("Could not find the specified text");

    // …and it is still one click from the full reason.
    await act(async () => head!.click());
    expect(head!.getAttribute("aria-expanded")).toBe("true");
    expect(mountedContainer.textContent).toContain(error);
  });
});

describe("the design guideline rule", () => {
  const call = (over: Partial<Parameters<typeof ToolCallCard>[0]["call"]> = {}) => ({
    id: "doctrine-1",
    name: "design_guidelines",
    arguments: JSON.stringify({ topic: "build" }),
    result: "# Surface doctrine\n\n## Authority order\n1. Existing product reality.",
    ...over,
  });

  it("draws a rule across the pane, not a tool row", () => {
    const html = renderToStaticMarkup(<ToolCallCard call={call()} />);

    expect(html).toContain("agw-drule");
    expect(html).toContain("Design guideline");
    // Nothing completed, so no tick; nothing to reveal, so no dropdown.
    expect(html).not.toContain("agw-tool-head");
    expect(html).not.toContain("agw-tool-dot");
    expect(html).not.toContain("aria-expanded");
    expect(html).not.toContain("<button");
  });

  it("never shows the topic — which half was read is not the reader's business", () => {
    const html = renderToStaticMarkup(
      <ToolCallCard call={call({ arguments: JSON.stringify({ topic: "audit" }) })} />,
    );

    expect(html).toContain("agw-drule");
    for (const topic of ["build", "writing", "audit", "redesign"]) {
      expect(html).not.toContain(topic);
    }
  });

  it("says what is happening while it loads, and rests on the plain label", () => {
    const running = renderToStaticMarkup(
      <ToolCallCard isActivelyStreaming call={call({ result: undefined })} />,
    );
    expect(running).toContain("Loading design guideline…");
    expect(running).toContain("agw-shimmer");

    const settled = renderToStaticMarkup(<ToolCallCard call={call()} />);
    expect(settled).not.toContain("agw-shimmer");
    expect(settled).not.toContain("Loading");
  });

  it("hands a failed call back to the standard card, which can show the reason", () => {
    const error = "topic `everything` is not one of [build, writing, audit, redesign, all]";
    const html = renderToStaticMarkup(
      <ToolCallCard call={call({ result: JSON.stringify({ success: false, error }) })} />,
    );

    // A divider carries no message and opens onto nothing — an error needs both.
    expect(html).not.toContain("agw-drule");
    expect(html).toContain("agw-tool-head");
    expect(html).toContain("aria-expanded");
  });

  it("inks the mark from CSS, never from the component", () => {
    const html = renderToStaticMarkup(<ToolCallCard call={call()} />);

    expect(html).toContain("agw-dg-mark");
    for (const disc of ["agw-dg-a", "agw-dg-b", "agw-dg-c"]) {
      expect(html).toContain(disc);
    }
    // A hardcoded hue here could not follow a custom theme, and a
    // `fill-opacity` attribute would be outranked by the rule that sets it.
    expect(html).not.toMatch(/fill="#|fill-opacity=/);
  });
});

/**
 * The checklist beat.
 *
 * A five-task plan is five `TaskCreate` calls in ONE message — the tool shape
 * working — and it used to draw five near-identical rows with a counter
 * climbing `0/1 … 0/5` while nothing had been done. The list is not the
 * transcript's to show: the header indicator holds it, live, and flashes open
 * when it changes.
 */
describe("checklist beat", () => {
  const create = (id: string, subject: string, total: number): ToolCall => ({
    id,
    name: "TaskCreate",
    arguments: JSON.stringify({ subject, description: `Do ${subject}` }),
    result: JSON.stringify({
      success: true,
      task: { id, subject, status: "pending" },
      cursor: { total, completed: 0, cancelled: 0 },
    }),
  });

  const update = (
    id: string,
    status: string,
    title: string,
    cursor: { total: number; completed: number },
  ): ToolCall => ({
    id,
    name: "TaskUpdate",
    arguments: JSON.stringify({ taskId: id, status }),
    result: JSON.stringify({
      success: true,
      taskId: id,
      status,
      title,
      cursor: { ...cursor, cancelled: 0 },
    }),
  });

  it("says only how many tasks were created — the header carries the list", () => {
    const html = renderToStaticMarkup(
      <ChecklistBeatCard
        isActivelyStreaming={false}
        calls={[
          create("1", "Scaffold the notebox package", 5),
          create("2", "Build the CLI commands", 5),
          create("3", "Write tests for storage and CLI", 5),
          create("4", "Run tests and fix failures", 5),
          create("5", "Write README and smoke-test", 5),
        ]}
      />,
    );

    expect(html).toContain("Created");
    expect(html).toContain("5 tasks");
    // One row, and not one subject in it.
    expect(html.match(/agw-task-beat-head/g)).toHaveLength(1);
    expect(html).not.toContain("Scaffold");
    // `0/5` beside a plan nobody has started reads as progress and is not.
    expect(html).not.toContain("agw-task-beat-count");
  });

  it("names what is running now when a run closes one task and starts the next", () => {
    const html = renderToStaticMarkup(
      <ChecklistBeatCard
        isActivelyStreaming={false}
        calls={[
          update("1", "completed", "Scaffold the notebox package", { total: 5, completed: 1 }),
          update("2", "completed", "Build the CLI commands", { total: 5, completed: 2 }),
          update("3", "in_progress", "Write tests for storage and CLI", {
            total: 5,
            completed: 2,
          }),
        ]}
      />,
    );

    expect(html.match(/agw-task-beat-head/g)).toHaveLength(1);
    expect(html).toContain("Started");
    expect(html).toContain("Write tests for storage and CLI");
    expect(html).toContain("2/5");
  });

  /**
   * Three calls, one row. The group header exists to warn a reader that a wall
   * of cards follows; above a single line it only raises the question it was
   * meant to answer — "what were the other two?" — when the answer is that
   * line.
   */
  it("does not put a group header above a checklist run that is one row", () => {
    const html = renderToStaticMarkup(
      <ToolGroup
        isActivelyStreaming={false}
        tools={[
          update("1", "completed", "Scaffold the notebox package", { total: 5, completed: 1 }),
          update("2", "completed", "Build the CLI commands", { total: 5, completed: 2 }),
          update("3", "in_progress", "Write tests for storage and CLI", {
            total: 5,
            completed: 2,
          }),
        ]}
      />,
    );

    expect(html).toContain("agw-task-beat");
    expect(html).not.toContain("3 calls");
  });

  /** A run whose rows are still rows keeps its header. */
  it("still groups when the run holds other tools beside the checklist", () => {
    const write = (id: string): ToolCall => ({
      id,
      name: "file_write",
      arguments: JSON.stringify({ path: `notebox/${id}.py`, content: "x = 1" }),
      result: JSON.stringify({ success: true }),
    });
    const html = renderToStaticMarkup(
      <ToolGroup
        isActivelyStreaming={false}
        tools={[
          write("a"),
          write("b"),
          update("3", "in_progress", "Write tests for storage and CLI", {
            total: 5,
            completed: 2,
          }),
        ]}
      />,
    );

    // Three rows, and the header keeps counting real calls.
    expect(html).toContain("3 calls");
  });

  it("counts the closes when a run closes several and starts nothing", () => {
    const html = renderToStaticMarkup(
      <ChecklistBeatCard
        isActivelyStreaming={false}
        calls={[
          update("4", "completed", "Run tests and fix failures", { total: 5, completed: 4 }),
          update("5", "completed", "Write README and smoke-test", { total: 5, completed: 5 }),
        ]}
      />,
    );

    expect(html).toContain("Finished");
    expect(html).toContain("2 tasks");
    expect(html).toContain("5/5");
  });

  it("names the single task a lone update moved", () => {
    const html = renderToStaticMarkup(
      <ChecklistBeatCard
        isActivelyStreaming={false}
        calls={[update("1", "completed", "Scaffold the notebox package", {
          total: 5,
          completed: 1,
        })]}
      />,
    );

    expect(html).toContain("Finished");
    expect(html).toContain("Scaffold the notebox package");
    expect(html).toContain("1/5");
  });

  it("says what is happening, not to what, while the call is in flight", () => {
    const html = renderToStaticMarkup(
      <ChecklistBeatCard
        isActivelyStreaming
        calls={[{ id: "1", name: "TaskCreate", arguments: '{"subject":' }]}
      />,
    );

    expect(html).toContain("Updating");
    expect(html).not.toContain("agw-task-beat-count");
  });

  it("routes a single checklist call through the same beat", () => {
    const html = renderToStaticMarkup(<ToolCallCard call={create("1", "Only task", 1)} />);

    expect(html).toContain("agw-task-beat");
    expect(html).toContain("1 task");
  });
});

describe("grouping checklist runs", () => {
  const call = (id: string, name: string): ToolCall => ({ id, name, arguments: "{}" });

  it("merges only CONSECUTIVE checklist calls", () => {
    const runs = groupChecklistRuns([
      call("a", "TaskCreate"),
      call("b", "TaskCreate"),
      call("c", "file_write"),
      call("d", "TaskUpdate"),
      call("e", "TaskUpdate"),
    ]);

    expect(runs.map((run) => run.map((c) => c.id))).toEqual([
      ["a", "b"],
      ["c"],
      ["d", "e"],
    ]);
  });

  it("leaves every other tool as a step of its own", () => {
    const runs = groupChecklistRuns([
      call("a", "file_read"),
      call("b", "file_read"),
      call("c", "grep"),
    ]);

    expect(runs).toHaveLength(3);
  });
});
