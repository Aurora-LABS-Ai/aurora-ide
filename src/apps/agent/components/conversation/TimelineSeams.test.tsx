import type { ButtonHTMLAttributes, HTMLAttributes, PropsWithChildren } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AgentThinkingBlock } from "@/apps/agent/components/conversation/AgentThinkingBlock";
import { ToolGroup } from "@/apps/agent/components/tools/ToolGroup";

type MotionOnlyProps = {
  initial?: unknown;
  animate?: unknown;
  exit?: unknown;
  transition?: unknown;
};

vi.mock("@/kernel/store/useSettingsStore", () => ({
  useSettingsStore: (select: (state: { explorerIconPack: string }) => unknown) =>
    select({ explorerIconPack: "material-icon-theme" }),
}));

vi.mock("framer-motion", () => {
  const div = (allProps: PropsWithChildren<HTMLAttributes<HTMLDivElement> & MotionOnlyProps>) => {
    const props = { ...allProps };
    const children = props.children;
    delete props.children;
    delete props.initial;
    delete props.animate;
    delete props.exit;
    delete props.transition;
    return <div {...props}>{children}</div>;
  };
  const button = (
    allProps: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement> & MotionOnlyProps>,
  ) => {
    const props = { ...allProps };
    const children = props.children;
    delete props.children;
    delete props.initial;
    delete props.animate;
    delete props.exit;
    delete props.transition;
    return <button {...props}>{children}</button>;
  };
  return {
    AnimatePresence: ({ children }: PropsWithChildren) => children,
    motion: { div, button },
  };
});

describe("assistant timeline seams", () => {
  it("extends the reasoning header with a quiet divider", () => {
    const html = renderToStaticMarkup(
      <AgentThinkingBlock content="Inspecting the implementation" />,
    );

    expect(html).toContain("agw-think-toggle");
    expect(html).toContain("agw-timeline-rule");
    expect(html).toContain('aria-hidden="true"');
  });

  it("extends a collapsed tool-group header with the same divider", () => {
    const tools = Array.from({ length: 6 }, (_, index) => ({
      id: `tool-${index}`,
      name: "read_file",
      arguments: JSON.stringify({ path: `file-${index}.ts` }),
      result: "done",
    }));
    const html = renderToStaticMarkup(<ToolGroup tools={tools} />);

    expect(html).toContain("agw-tool-group-head");
    expect(html).toContain("6 calls · 6 done");
    expect(html).toContain("agw-timeline-rule");
  });
});
