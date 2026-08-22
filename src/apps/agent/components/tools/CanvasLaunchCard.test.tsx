import { type PropsWithChildren } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ToolCallCard } from "@/apps/agent/components/tools/ToolCallCard";
import { presentArtifactTool } from "@/apps/agent/tools/definitions/artifact-tools";
import {
  ARTIFACT_CATEGORY_IDS,
  DEFAULT_ARTIFACT_CATEGORY,
  artifactCategoryDescription,
  normalizeArtifactCategory,
} from "@/apps/agent/lib/artifacts/artifact-category";

vi.mock("@/kernel/store/useSettingsStore", () => ({
  useSettingsStore: (select: (state: { explorerIconPack: string }) => unknown) =>
    select({ explorerIconPack: "material-icon-theme" }),
}));

vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: PropsWithChildren) => children,
  motion: { div: ({ children }: PropsWithChildren) => <div>{children}</div> },
}));

vi.mock("@/apps/agent/components/tool-views/ToolCode", () => ({
  ToolCode: ({ code }: { code: string }) => <pre>{code}</pre>,
}));

const render = (args: string, opts: { result?: string; streaming?: boolean } = {}) =>
  renderToStaticMarkup(
    <ToolCallCard
      call={{
        id: "call-1",
        name: "present_artifact",
        arguments: args,
        result: opts.result,
      }}
      isActivelyStreaming={opts.streaming ?? false}
    />,
  );

/**
 * The rename is the whole fix for a card that sat unlabelled through 25% of real
 * writes. If someone renames these back to `title`/`kind`, this fails — the same
 * guard `affected_paths` carries on the write tools.
 */
describe("present_artifact header fields reach the UI before the body", () => {
  const props = presentArtifactTool.function.parameters.properties as Record<string, unknown>;

  it("sorts every header field ahead of content and patches ALPHABETICALLY", () => {
    const keys = Object.keys(props).sort();
    const body = ["content", "patches"].map((k) => keys.indexOf(k));
    const header = ["artifactCategory", "artifactId", "artifactKind", "artifactTitle"].map((k) =>
      keys.indexOf(k),
    );

    expect(header.every((i) => i >= 0)).toBe(true);
    expect(Math.max(...header)).toBeLessThan(Math.min(...body.filter((i) => i >= 0)));
  });

  it("sorts every header field ahead of the body in the AUTHORED order too", () => {
    const keys = Object.keys(props);
    expect(keys.indexOf("artifactTitle")).toBeLessThan(keys.indexOf("content"));
    expect(keys.indexOf("artifactKind")).toBeLessThan(keys.indexOf("content"));
    expect(keys.indexOf("artifactCategory")).toBeLessThan(keys.indexOf("content"));
  });

  it("requires the four header fields", () => {
    expect(presentArtifactTool.function.parameters.required).toEqual([
      "artifactCategory",
      "artifactId",
      "artifactKind",
      "artifactTitle",
    ]);
  });

  it("advertises exactly the categories the card can draw", () => {
    expect((props.artifactCategory as { enum: string[] }).enum).toEqual([
      ...ARTIFACT_CATEGORY_IDS,
    ]);
    // The prose and the enum are built from one array so they cannot disagree.
    for (const id of ARTIFACT_CATEGORY_IDS) {
      expect(artifactCategoryDescription()).toContain(`- ${id}:`);
    }
  });
});

describe("artifact category", () => {
  it("falls back rather than throwing on anything unrecognised", () => {
    expect(normalizeArtifactCategory("diagram")).toBe(DEFAULT_ARTIFACT_CATEGORY);
    expect(normalizeArtifactCategory(undefined)).toBe(DEFAULT_ARTIFACT_CATEGORY);
    expect(normalizeArtifactCategory(42)).toBe(DEFAULT_ARTIFACT_CATEGORY);
    expect(normalizeArtifactCategory("  METRICS ")).toBe("metrics");
  });
});

describe("canvas card", () => {
  it("draws an honest skeleton, never a placeholder noun, before the title arrives", () => {
    const html = render('{"artifactCategory":"metrics","artifactId":"a1"', {
      streaming: true,
    });
    expect(html).toContain("agw-canvas-launch-skel");
    // The old card showed this for the whole write and it read as the title.
    expect(html).not.toContain("Canvas artifact");
  });

  it("draws the declared category while the source is still streaming", () => {
    const html = render('{"artifactCategory":"architecture","artifactId":"a1"', {
      streaming: true,
    });
    expect(html).toContain('data-category="architecture"');
    expect(html).toContain("agw-cm-anim");
  });

  it("stops animating once the write lands", () => {
    const html = render(
      '{"artifactCategory":"flow","artifactId":"a1","artifactKind":"mermaid","artifactTitle":"Turn loop"}',
      { result: '{"versionTag":"v1"}' },
    );
    expect(html).toContain('data-category="flow"');
    expect(html).not.toContain("agw-cm-anim");
    expect(html).toContain("Turn loop");
    expect(html).toContain("Flow");
    expect(html).toContain("v1");
  });

  it("still renders a thread written before the rename", () => {
    const html = render('{"artifactId":"a1","title":"Old thread","kind":"markdown"}', {
      result: '{"versionTag":"v2"}',
    });
    expect(html).toContain("Old thread");
    expect(html).not.toContain("agw-canvas-launch-skel");
    // No category was ever sent, so it falls back rather than drawing nothing.
    expect(html).toContain(`data-category="${DEFAULT_ARTIFACT_CATEGORY}"`);
  });

  // A thrown tool error reaches the card as this exact sentinel string, which is
  // what `useAgentWindowSend` writes and what `toolStatus` keys off. It is NOT
  // JSON, so a card reading `result.error` finds nothing on every real failure.
  it("says the failure reason on the card instead of hiding it behind an expand", () => {
    const html = render(
      '{"artifactCategory":"ui","artifactId":"a1","artifactKind":"react","artifactTitle":"Composer"}',
      {
        result:
          "[error] Error: present_artifact: the canvas did not compile and was not saved.\nMissing default export",
      },
    );
    expect(html).toContain("Couldn’t save");
    expect(html).toContain("the canvas did not compile");
    // The wrapper and the tool's own name carry nothing for the reader.
    expect(html).not.toContain("present_artifact:");
    expect(html).not.toContain("[error]");
  });

  it("survives a failure that carries no reason at all", () => {
    const html = render(
      '{"artifactCategory":"ui","artifactId":"a1","artifactKind":"react","artifactTitle":"Composer"}',
      { result: "[error]" },
    );
    expect(html).toContain("Couldn’t save");
    expect(html).toContain("Composer");
  });

  it("marks a patch revision as revised", () => {
    const html = render(
      '{"artifactCategory":"roadmap","artifactId":"a1","artifactKind":"markdown","artifactTitle":"Roadmap","baseVersionTag":"v2","patches":[{"find":"a","replace":"b"}]}',
      { result: '{"versionTag":"v3"}' },
    );
    expect(html).toContain("revised");
    expect(html).toContain("v3");
  });

  it("shows a size that moves while writing, and no size once done", () => {
    const streaming = render(
      '{"artifactCategory":"report","artifactId":"a1","artifactTitle":"Findings","content":"' +
        "x".repeat(3000),
      { streaming: true },
    );
    expect(streaming).toMatch(/\d+\.\d KB/);
    expect(streaming).toContain("agw-canvas-launch-rail");

    const done = render(
      '{"artifactCategory":"report","artifactId":"a1","artifactKind":"markdown","artifactTitle":"Findings"}',
      { result: '{"versionTag":"v1"}' },
    );
    expect(done).not.toMatch(/\d+\.\d KB/);
    expect(done).not.toContain("agw-canvas-launch-rail");
  });
});
