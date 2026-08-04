import { describe, expect, it } from "vitest";

import {
  buildStarterPrompts,
  type StarterPromptKind,
} from "./workspace-starter-prompts";
import type { WorkspaceSummary } from "./workspace-summary";

const summaryOf = (over: Partial<WorkspaceSummary> = {}): WorkspaceSummary => ({
  name: "aurora",
  fileCount: 120,
  languages: [],
  framework: null,
  hasGit: false,
  hasTsConfig: false,
  hasPackageJson: false,
  ...over,
});

describe("buildStarterPrompts", () => {
  it("offers generic ways to start when no workspace is open", () => {
    const prompts = buildStarterPrompts("", null);

    expect(prompts.map((p) => p.kind)).toEqual([
      "getting-started",
      "architecture",
      "plan",
      "debug",
    ]);
  });

  it("names every prompt after the workspace once the scan resolves", () => {
    const prompts = buildStarterPrompts("E:/code/aurora", summaryOf());

    for (const p of prompts) {
      expect(p.title).toContain("aurora");
      expect(p.prompt).toContain("aurora");
    }
  });

  it("describes the Tauri split when the scan found a Tauri project", () => {
    const [architecture] = buildStarterPrompts(
      "E:/code/aurora",
      summaryOf({ framework: "Tauri" }),
    );

    expect(architecture.prompt).toContain("React frontend");
    expect(architecture.prompt).toContain("Rust backend");
  });

  it("frames the review as current state when the project is tracked in git", () => {
    const untracked = buildStarterPrompts("E:/code/aurora", summaryOf());
    const tracked = buildStarterPrompts(
      "E:/code/aurora",
      summaryOf({ hasGit: true }),
    );

    expect(untracked[1].title).toBe("Review aurora for bugs and risky areas");
    expect(tracked[1].title).toBe("Review the current state of aurora");
    expect(tracked[1].kind).toBe("review");
  });

  it("suggests what to read first for a non-JS project with a dominant language", () => {
    const prompts = buildStarterPrompts(
      "E:/code/aurora",
      summaryOf({ languages: ["Rust", "Python"] }),
    );

    expect(prompts[2].kind).toBe("read-first");
    expect(prompts[2].title).toBe(
      "Show me the core Rust and Python files to read first",
    );
  });

  it("keeps the improvement prompt when the project has a JS/TS manifest", () => {
    const prompts = buildStarterPrompts(
      "E:/code/aurora",
      summaryOf({ languages: ["TypeScript"], hasPackageJson: true }),
    );

    expect(prompts[2].kind).toBe("plan");
  });

  /**
   * Both empty states render four rows and key them by `kind`. A duplicate kind
   * within one result set would collide as a React key and silently drop a row.
   */
  it("always returns four prompts with unique kinds, in every branch", () => {
    const branches: Array<[string, WorkspaceSummary | null]> = [
      ["", null],
      ["E:/code/aurora", null],
      ["E:/code/aurora", summaryOf()],
      ["E:/code/aurora", summaryOf({ hasGit: true, framework: "Tauri" })],
      ["E:/code/aurora", summaryOf({ languages: ["Go"], hasGit: true })],
      [
        "E:/code/aurora",
        summaryOf({ languages: ["TypeScript"], hasTsConfig: true }),
      ],
    ];

    for (const [rootPath, summary] of branches) {
      const prompts = buildStarterPrompts(rootPath, summary);
      const kinds = prompts.map((p) => p.kind);

      expect(prompts).toHaveLength(4);
      expect(new Set<StarterPromptKind>(kinds).size).toBe(4);
      for (const p of prompts) {
        expect(p.title.trim()).not.toBe("");
        expect(p.prompt.trim()).not.toBe("");
      }
    }
  });
});
