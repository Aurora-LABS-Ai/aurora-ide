import { describe, expect, it, vi } from "vitest";

type MockDirectoryEntry = {
  extension: string | null;
  is_dir: boolean;
  is_file: boolean;
  name: string;
  path: string;
};

const {
  readDirectoryMock,
  readFileContentMock,
  getGlobalSkillsPathMock,
} = vi.hoisted(() => ({
  readDirectoryMock: vi.fn<(path: string) => Promise<MockDirectoryEntry[]>>(async () => []),
  readFileContentMock: vi.fn<(path: string) => Promise<string>>(async () => ""),
  getGlobalSkillsPathMock: vi.fn<() => Promise<string>>(async () => "C:/Users/test/.agent/skills"),
}));

vi.mock("../lib/tauri", () => ({
  getGlobalSkillsPath: getGlobalSkillsPathMock,
  readDirectory: readDirectoryMock,
  readFileContent: readFileContentMock,
}));

import { composeAgentSystemPrompt } from "./agent-prompt";
import { loadWorkspaceSkills, parseSkillDocument, resolveSkillsForPrompt } from "./skills";

describe("skills", () => {
  it("parses markdown skill frontmatter", () => {
    const skill = parseSkillDocument(
      `---
id: custom-review
name: Custom Review
description: Review code for regressions.
triggers:
  - review
  - regression
---
Check changed files first and focus on correctness.`,
      {
        fallbackId: "fallback",
        source: "workspace",
        sourcePath: "E:/repo/.aurora/skills/custom-review.md",
      }
    );

    expect(skill).not.toBeNull();
    expect(skill?.id).toBe("custom-review");
    expect(skill?.name).toBe("Custom Review");
    expect(skill?.triggers).toEqual(["review", "regression"]);
    expect(skill?.content).toContain("focus on correctness");
  });

  it("activates explicit builtin skills from the user message", async () => {
    const resolved = await resolveSkillsForPrompt({
      userMessage: "Use the typescript skill to fix typing issues in this TSX component.",
    });

    expect(resolved.activeSkills.some((skill) => skill.id === "typescript")).toBe(true);
  });

  it("loads project skills from folder-based SKILL.md layout", async () => {
    readDirectoryMock.mockImplementation(async (path: string) => {
      if (path === "E:/repo/.aurora/skills") {
        return [
          {
            name: "custom-review",
            path: "E:/repo/.aurora/skills/custom-review",
            is_dir: true,
            is_file: false,
            extension: null,
          },
        ];
      }

      if (path === "E:/repo/.aurora/skills/custom-review") {
        return [
          {
            name: "SKILL.md",
            path: "E:/repo/.aurora/skills/custom-review/SKILL.md",
            is_dir: false,
            is_file: true,
            extension: "md",
          },
        ];
      }

      return [];
    });

    readFileContentMock.mockResolvedValue(`---
name: Custom Review
description: Review changed code carefully.
triggers: [review, correctness]
---
Check changed files first.`);

    const skills = await loadWorkspaceSkills("E:/repo");

    expect(skills).toHaveLength(1);
    expect(skills[0]?.id).toBe("custom-review");
    expect(skills[0]?.storageKey).toContain("workspace:");
  });

  it("filters disabled skills out of the prompt resolver", async () => {
    const resolved = await resolveSkillsForPrompt({
      userMessage: "Use the typescript skill to fix typing issues in this TSX component.",
      enabledSkillToggles: {
        "builtin:typescript": false,
      },
    });

    expect(resolved.allSkills.some((skill) => skill.id === "typescript")).toBe(false);
    expect(resolved.activeSkills.some((skill) => skill.id === "typescript")).toBe(false);
  });

  it("uses explicitly attached skills instead of auto-matched skills", async () => {
    const resolved = await resolveSkillsForPrompt({
      explicitSkillKeys: ["builtin:mcp-integration"],
      userMessage: "Use the typescript skill to fix typing and MCP work together.",
    });

    expect(resolved.activeSkills.map((skill) => skill.id)).toEqual(["mcp-integration"]);
  });

  it("composes a layered system prompt with catalog and active skills", async () => {
    const composed = await composeAgentSystemPrompt({
      promptContext: {
        userMessage: "We need MCP marketplace integration and server tool routing.",
      },
      mcpSummary: "## MCP\nConnected server summary",
    });

    expect(composed.systemPrompt).toContain("<available_skills>");
    expect(composed.systemPrompt).toContain("<active_skills");
    expect(composed.systemPrompt).toContain("Connected server summary");
    expect(composed.activeSkills.some((skill) => skill.id === "mcp-integration")).toBe(true);
  });
});
