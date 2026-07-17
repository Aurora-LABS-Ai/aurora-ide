import type { PropsWithChildren } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ToolCallCard } from "./ToolCallCard";

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

describe("ToolCallCard streamed file targets", () => {
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
