import { beforeEach, describe, expect, it, vi } from "vitest";

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
import {
  extractPreviewLines,
  findSkillById,
  loadAllSkillCandidates,
  loadWorkspaceSkills,
  MAX_ENABLED_SKILLS,
  parseSkillDocument,
  resolveSkillsForPrompt,
  searchSkillCandidates,
} from "./skills";

beforeEach(() => {
  readDirectoryMock.mockReset();
  readDirectoryMock.mockImplementation(async () => []);
  readFileContentMock.mockReset();
  readFileContentMock.mockImplementation(async () => "");
});

describe("skills", () => {
  it("parses markdown skill frontmatter and captures preview lines", () => {
    const skill = parseSkillDocument(
      `---
id: custom-review
name: Custom Review
description: Review code for regressions.
triggers:
  - review
  - regression
---
Check changed files first and focus on correctness.

Add tests for any regression you fix.`,
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
    expect(skill?.previewLines.length).toBeGreaterThan(0);
    expect(skill?.previewLines[0]).toBe("Check changed files first and focus on correctness.");
  });

  it("extractPreviewLines collapses blank lines and caps at the limit", () => {
    const preview = extractPreviewLines(
      `\n\nfirst line\n   \nsecond line\n\nthird line\nfourth line\nfifth line\nsixth line`,
      5
    );
    expect(preview).toEqual([
      "first line",
      "second line",
      "third line",
      "fourth line",
      "fifth line",
    ]);
  });

  it("default-off: built-in skills are NOT auto-injected without an explicit toggle", async () => {
    const resolved = await resolveSkillsForPrompt({
      userMessage: "Use the typescript skill to fix typing issues in this TSX component.",
    });

    expect(resolved.allSkills.some((skill) => skill.id === "typescript")).toBe(true);
    // Without an explicit toggle, no skill is enabled.
    expect(resolved.enabledSkills).toHaveLength(0);
    expect(resolved.activeSkills).toHaveLength(0);
  });

  it("respects a user-enabled toggle", async () => {
    const resolved = await resolveSkillsForPrompt({
      userMessage: "Use the typescript skill to fix typing issues in this TSX component.",
      enabledSkillToggles: {
        "builtin:typescript": true,
      },
    });

    expect(resolved.enabledSkills.map((skill) => skill.id)).toEqual(["typescript"]);
    expect(resolved.activeSkills.map((skill) => skill.id)).toEqual(["typescript"]);
  });

  it("loads project skills from both .aurora/skills and agents/skills", async () => {
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

      if (path === "E:/repo/.agents/skills") {
        return [
          {
            name: "shared-style",
            path: "E:/repo/.agents/skills/shared-style",
            is_dir: true,
            is_file: false,
            extension: null,
          },
        ];
      }

      if (path === "E:/repo/.agents/skills/shared-style") {
        return [
          {
            name: "SKILL.md",
            path: "E:/repo/.agents/skills/shared-style/SKILL.md",
            is_dir: false,
            is_file: true,
            extension: "md",
          },
        ];
      }

      return [];
    });

    readFileContentMock.mockImplementation(async (path: string) => {
      if (path === "E:/repo/.aurora/skills/custom-review/SKILL.md") {
        return `---
name: Custom Review
description: Review changed code carefully.
triggers: [review, correctness]
---
Check changed files first.`;
      }
      if (path === "E:/repo/.agents/skills/shared-style/SKILL.md") {
        return `---
name: Shared Style
description: Cross-agent style guide.
---
Use 2-space indentation.`;
      }
      return "";
    });

    const skills = await loadWorkspaceSkills("E:/repo");

    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.id).sort()).toEqual(["custom-review", "shared-style"]);
    expect(skills.every((s) => s.storageKey.startsWith("workspace:"))).toBe(true);
  });

  it("explicit attachments bypass the toggle gate", async () => {
    const resolved = await resolveSkillsForPrompt({
      explicitSkillKeys: ["builtin:mcp-integration"],
      userMessage: "Use MCP",
    });

    expect(resolved.explicitSkills.map((skill) => skill.id)).toEqual(["mcp-integration"]);
    expect(resolved.activeSkills.map((skill) => skill.id)).toEqual(["mcp-integration"]);
    // mcp-integration is NOT in enabledSkills because the toggle is off.
    expect(resolved.enabledSkills).toHaveLength(0);
  });

  it("hard-caps enabledSkills at MAX_ENABLED_SKILLS", async () => {
    const builtinIds = [
      "project-overview",
      "typescript",
      "react-frontend",
      "tauri-rust",
      "mcp-integration",
      "testing-debugging",
    ];
    expect(builtinIds.length).toBeLessThanOrEqual(MAX_ENABLED_SKILLS);

    const toggles: Record<string, boolean> = {};
    for (const id of builtinIds) {
      toggles[`builtin:${id}`] = true;
    }

    const resolved = await resolveSkillsForPrompt({
      userMessage: "anything",
      enabledSkillToggles: toggles,
    });

    // All 6 fit under the cap of 10.
    expect(resolved.enabledSkills).toHaveLength(builtinIds.length);

    // Now force the cap by passing maxActiveSkills=2.
    const capped = await resolveSkillsForPrompt({
      userMessage: "anything",
      enabledSkillToggles: toggles,
      maxActiveSkills: 2,
    });
    expect(capped.enabledSkills).toHaveLength(2);
  });

  it("loadAllSkillCandidates exposes every skill regardless of toggle", async () => {
    const all = await loadAllSkillCandidates();
    expect(all.length).toBeGreaterThan(0);
    expect(all.some((s) => s.id === "typescript")).toBe(true);
  });

  it("findSkillById resolves a skill by id even when toggled off", async () => {
    const skill = await findSkillById("typescript");
    expect(skill?.id).toBe("typescript");
  });

  it("searchSkillCandidates returns ranked results for a query", async () => {
    const results = await searchSkillCandidates("typescript");
    expect(results[0]?.id).toBe("typescript");
  });

  it("searchSkillCandidates returns an empty list when nothing matches", async () => {
    const results = await searchSkillCandidates("zzz-nothing-matches-this");
    expect(results).toHaveLength(0);
  });

  it("composeAgentSystemPrompt emits the Skill System block and skill discovery hint when nothing is enabled", async () => {
    const composed = await composeAgentSystemPrompt({
      promptContext: {
        userMessage: "We need MCP marketplace integration and server tool routing.",
      },
      mcpSummary: "## MCP\nConnected server summary",
    });

    expect(composed.systemPrompt).toContain("## Skill System");
    expect(composed.systemPrompt).toContain("aurora_skill_search");
    expect(composed.systemPrompt).toContain("aurora_skill_load");
    expect(composed.systemPrompt).toContain("Connected server summary");
    // Default-off: no skill is auto-active.
    expect(composed.enabledSkills).toHaveLength(0);
    expect(composed.activeSkills).toHaveLength(0);
  });

  it("adds plan mode restrictions to the system prompt", async () => {
    const composed = await composeAgentSystemPrompt({
      executionMode: "plan",
      promptContext: {
        userMessage: "Review the change before implementation.",
      },
    });

    expect(composed.systemPrompt).toContain("Active Execution Mode: Plan");
    expect(composed.systemPrompt).toContain("must not create, edit, delete");
  });
});
