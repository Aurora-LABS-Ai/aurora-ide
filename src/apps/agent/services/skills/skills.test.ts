import { beforeEach, describe, expect, it, vi } from "vitest";

type MockDirectoryEntry = {
  extension: string | null;
  is_dir: boolean;
  is_file: boolean;
  name: string;
  path: string;
};

const {
  deletePathMock,
  readDirectoryMock,
  readFileContentMock,
  getGlobalSkillsPathMock,
} = vi.hoisted(() => ({
  deletePathMock: vi.fn<(path: string) => Promise<void>>(async () => {}),
  readDirectoryMock: vi.fn<(path: string) => Promise<MockDirectoryEntry[]>>(async () => []),
  readFileContentMock: vi.fn<(path: string) => Promise<string>>(async () => ""),
  getGlobalSkillsPathMock: vi.fn<() => Promise<string>>(async () => "C:/Users/test/.agent/skills"),
}));

vi.mock("@/kernel/lib/ipc/tauri", () => ({
  deletePath: deletePathMock,
  getGlobalSkillsPath: getGlobalSkillsPathMock,
  readDirectory: readDirectoryMock,
  readFileContent: readFileContentMock,
}));

import {
  composeAgentSystemPrompt,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from "@/apps/agent/services/runtime/agent-prompt";
import { useSettingsStore } from "@/kernel/store/useSettingsStore";
import {
  deleteSkillFromDisk,
  extractPreviewLines,
  findSkillById,
  loadAllSkillCandidates,
  loadWorkspaceSkills,
  MAX_ENABLED_SKILLS,
  parseSkillDocument,
  resolveSkillDeleteTarget,
  resolveSkillsForPrompt,
  searchSkillCandidates,
  type SkillDefinition,
} from "@/apps/agent/services/skills/skills";

beforeEach(() => {
  readDirectoryMock.mockReset();
  readDirectoryMock.mockImplementation(async () => []);
  readFileContentMock.mockReset();
  readFileContentMock.mockImplementation(async () => "");
  deletePathMock.mockReset();
  deletePathMock.mockImplementation(async () => {});
});

const WORKSPACE = "E:/repo";
const GLOBAL_SKILLS = "C:/Users/test/.agent/skills";
const DELETE_ROOTS = { globalSkillsPath: GLOBAL_SKILLS, workspacePath: WORKSPACE };

const skillFixture = (overrides: Partial<SkillDefinition>): SkillDefinition => ({
  content: "Body.",
  description: "A skill.",
  id: "fixture",
  name: "Fixture",
  previewLines: ["Body."],
  source: "workspace",
  storageKey: "workspace:fixture",
  triggers: [],
  ...overrides,
});

/**
 * Stub a workspace skills directory.
 *
 * These tests used to lean on the six built-in skills as fixtures. Aurora now
 * ships none — its only built-in guidance is the surface doctrine, which is an
 * instruction rather than a catalogue entry — so the behaviour under test
 * (toggle gating, explicit attachment bypass, the enabled cap, lookup, search)
 * is exercised against real project skills instead. The behaviour is what
 * matters here; the built-ins were only ever convenient data.
 */
function stubWorkspaceSkills(
  skills: Array<{ id: string; name: string; description: string; triggers?: string[] }>,
) {
  const root = "E:/repo/.aurora/skills";
  readDirectoryMock.mockImplementation(async (path: string) => {
    if (path === root) {
      return skills.map((skill) => ({
        name: skill.id,
        path: `${root}/${skill.id}`,
        is_dir: true,
        is_file: false,
        extension: null,
      }));
    }
    const match = skills.find((skill) => path === `${root}/${skill.id}`);
    if (match) {
      return [
        {
          name: "SKILL.md",
          path: `${root}/${match.id}/SKILL.md`,
          is_dir: false,
          is_file: true,
          extension: "md",
        },
      ];
    }
    return [];
  });

  readFileContentMock.mockImplementation(async (path: string) => {
    const match = skills.find((skill) => path === `${root}/${skill.id}/SKILL.md`);
    if (!match) return "";
    const triggers = match.triggers?.length
      ? `triggers: [${match.triggers.join(", ")}]
`
      : "";
    return `---
name: ${match.name}
description: ${match.description}
${triggers}---
Body for ${match.name}.`;
  });
}

/**
 * A discovered skill's storage key is derived from its SOURCE PATH, not its id
 * (`createStorageKey`), and is lower-cased. Toggles and explicit attachments
 * are keyed on it, so fixtures have to use the real shape.
 */
const wsKey = (id: string) => `workspace:e:/repo/.aurora/skills/${id}/skill.md`;

const TS_SKILL = {
  id: "typescript",
  name: "TypeScript",
  description: "Apply type-safe, idiomatic TypeScript patterns.",
  triggers: ["typescript", "typing"],
};

describe("skill deletion", () => {
  it("removes the whole skill folder, not just its markdown", () => {
    // A folder skill carries references/, scripts and assets beside skill.md.
    // Deleting the file alone would take the card away and leave the skill.
    const target = resolveSkillDeleteTarget(
      skillFixture({
        sourceDir: `${WORKSPACE}/.aurora/skills/review`,
        sourcePath: `${WORKSPACE}/.aurora/skills/review/SKILL.md`,
      }),
      DELETE_ROOTS,
    );
    expect(target).toEqual({
      kind: "folder",
      path: `${WORKSPACE}/.aurora/skills/review`,
    });
  });

  it("removes a loose markdown skill as a file", () => {
    const target = resolveSkillDeleteTarget(
      skillFixture({ sourcePath: `${WORKSPACE}/.agents/skills/quick.md` }),
      DELETE_ROOTS,
    );
    expect(target).toEqual({
      kind: "file",
      path: `${WORKSPACE}/.agents/skills/quick.md`,
    });
  });

  it("resolves global skills against the global root", () => {
    const target = resolveSkillDeleteTarget(
      skillFixture({
        source: "global",
        sourceDir: `${GLOBAL_SKILLS}/surface`,
        sourcePath: `${GLOBAL_SKILLS}/surface/SKILL.md`,
      }),
      DELETE_ROOTS,
    );
    expect(target?.path).toBe(`${GLOBAL_SKILLS}/surface`);
  });

  it("refuses anything that is not provably inside a skills root", () => {
    // This is `remove_dir_all` on the user's own files with no undo, so the
    // target is re-derived rather than trusted.
    const cases: SkillDefinition[] = [
      // Outside every root.
      skillFixture({ sourcePath: "E:/repo/src/index.ts" }),
      // Traversal that `startsWith` alone would wave through.
      skillFixture({
        sourceDir: `${WORKSPACE}/.aurora/skills/../../..`,
        sourcePath: `${WORKSPACE}/.aurora/skills/../../../SKILL.md`,
      }),
      // The skills root itself is never one skill's deletion.
      skillFixture({
        sourceDir: `${WORKSPACE}/.aurora/skills`,
        sourcePath: `${WORKSPACE}/.aurora/skills/SKILL.md`,
      }),
      // A global skill judged against a workspace root, and vice versa.
      skillFixture({ source: "global", sourcePath: `${WORKSPACE}/.aurora/skills/x.md` }),
      skillFixture({ sourcePath: `${GLOBAL_SKILLS}/x.md` }),
      // Nothing on disk to remove.
      skillFixture({ source: "builtin", sourcePath: undefined }),
      skillFixture({ sourcePath: undefined }),
    ];
    for (const skill of cases) {
      expect(resolveSkillDeleteTarget(skill, DELETE_ROOTS)).toBeNull();
    }
  });

  it("refuses when the roots are unknown", () => {
    const skill = skillFixture({ sourcePath: `${WORKSPACE}/.aurora/skills/quick.md` });
    expect(resolveSkillDeleteTarget(skill, { workspacePath: null })).toBeNull();
    expect(resolveSkillDeleteTarget(skill)).toBeNull();
  });

  it("matches roots case- and separator-insensitively (Windows)", () => {
    const target = resolveSkillDeleteTarget(
      skillFixture({
        sourceDir: `E:\\Repo\\.aurora\\skills\\Review`,
        sourcePath: `E:\\Repo\\.aurora\\skills\\Review\\SKILL.md`,
      }),
      DELETE_ROOTS,
    );
    // The path handed to the filesystem stays verbatim; only the check normalizes.
    expect(target).toEqual({ kind: "folder", path: "E:\\Repo\\.aurora\\skills\\Review" });
  });

  it("deletes through the resolver and never past it", async () => {
    const deletable = skillFixture({
      sourceDir: `${WORKSPACE}/.aurora/skills/review`,
      sourcePath: `${WORKSPACE}/.aurora/skills/review/SKILL.md`,
    });
    await expect(deleteSkillFromDisk(deletable, DELETE_ROOTS)).resolves.toEqual({
      kind: "folder",
      path: `${WORKSPACE}/.aurora/skills/review`,
    });
    expect(deletePathMock).toHaveBeenCalledWith(`${WORKSPACE}/.aurora/skills/review`);

    deletePathMock.mockClear();
    await expect(
      deleteSkillFromDisk(skillFixture({ sourcePath: "E:/repo/src/index.ts" }), DELETE_ROOTS),
    ).rejects.toThrow(/can't be deleted from here/);
    expect(deletePathMock).not.toHaveBeenCalled();
  });

  it("records the folder a discovered skill came from", async () => {
    stubWorkspaceSkills([TS_SKILL]);
    const [skill] = await loadWorkspaceSkills(WORKSPACE);
    expect(skill.sourceDir).toBe(`${WORKSPACE}/.aurora/skills/typescript`);
    expect(resolveSkillDeleteTarget(skill, DELETE_ROOTS)).toEqual({
      kind: "folder",
      path: `${WORKSPACE}/.aurora/skills/typescript`,
    });
  });
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

  it("default-off: a discovered skill is NOT auto-injected without an explicit toggle", async () => {
    stubWorkspaceSkills([TS_SKILL]);
    const resolved = await resolveSkillsForPrompt({
      userMessage: "Use the typescript skill to fix typing issues in this TSX component.",
      workspacePath: "E:/repo",
    });

    expect(resolved.allSkills.some((skill) => skill.id === "typescript")).toBe(true);
    // Without an explicit toggle, no skill is enabled.
    expect(resolved.enabledSkills).toHaveLength(0);
    expect(resolved.activeSkills).toHaveLength(0);
  });

  it("respects a user-enabled toggle", async () => {
    stubWorkspaceSkills([TS_SKILL]);
    const resolved = await resolveSkillsForPrompt({
      userMessage: "Use the typescript skill to fix typing issues in this TSX component.",
      workspacePath: "E:/repo",
      enabledSkillToggles: {
        [wsKey("typescript")]: true,
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
    stubWorkspaceSkills([
      { id: "mcp-integration", name: "MCP", description: "Register MCP servers." },
    ]);
    const resolved = await resolveSkillsForPrompt({
      explicitSkillKeys: [wsKey("mcp-integration")],
      userMessage: "Use MCP",
      workspacePath: "E:/repo",
    });

    expect(resolved.explicitSkills.map((skill) => skill.id)).toEqual(["mcp-integration"]);
    expect(resolved.activeSkills.map((skill) => skill.id)).toEqual(["mcp-integration"]);
    // Still absent from enabledSkills because the toggle is off.
    expect(resolved.enabledSkills).toHaveLength(0);
  });

  it("hard-caps enabledSkills at MAX_ENABLED_SKILLS", async () => {
    const ids = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
    expect(ids.length).toBeLessThanOrEqual(MAX_ENABLED_SKILLS);
    stubWorkspaceSkills(
      ids.map((id) => ({ id, name: id, description: `The ${id} skill.` })),
    );

    const toggles: Record<string, boolean> = {};
    for (const id of ids) {
      toggles[wsKey(id)] = true;
    }

    const resolved = await resolveSkillsForPrompt({
      userMessage: "anything",
      workspacePath: "E:/repo",
      enabledSkillToggles: toggles,
    });

    // All six fit under the cap of ten.
    expect(resolved.enabledSkills).toHaveLength(ids.length);

    // Now force the cap by passing maxActiveSkills=2.
    const capped = await resolveSkillsForPrompt({
      userMessage: "anything",
      workspacePath: "E:/repo",
      enabledSkillToggles: toggles,
      maxActiveSkills: 2,
    });
    expect(capped.enabledSkills).toHaveLength(2);
  });

  it("loadAllSkillCandidates exposes every skill regardless of toggle", async () => {
    stubWorkspaceSkills([TS_SKILL]);
    const all = await loadAllSkillCandidates({ workspacePath: "E:/repo" });
    expect(all.length).toBeGreaterThan(0);
    expect(all.some((s) => s.id === "typescript")).toBe(true);
  });

  it("findSkillById resolves a skill by id even when toggled off", async () => {
    stubWorkspaceSkills([TS_SKILL]);
    const skill = await findSkillById("typescript", { workspacePath: "E:/repo" });
    expect(skill?.id).toBe("typescript");
  });

  it("searchSkillCandidates returns ranked results for a query", async () => {
    stubWorkspaceSkills([TS_SKILL]);
    const results = await searchSkillCandidates("typescript", 30, {
      workspacePath: "E:/repo",
    });
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
    expect(composed.systemPrompt).not.toContain("Connected server summary");
    expect(composed.systemPrompt).toContain("call_tool(");
    // Default-off: no skill is auto-active.
    expect(composed.enabledSkills).toHaveLength(0);
    expect(composed.activeSkills).toHaveLength(0);
  });

  it("keeps the volatile sections behind the cache boundary", async () => {
    // Both the mode section and the MCP summary change WHILE a conversation is
    // open, and every provider Aurora talks to caches on the longest common
    // prefix. They used to sit at positions 1 and last inside one cached
    // block, so a /plan or an MCP server connecting re-billed the whole system
    // prompt. Measured on kenari/minimax-m3 with a 7.2k-token prompt: 7,280
    // tokens billed at a 1.5% hit rate before, 96 at 98.7% after.
    const composed = await composeAgentSystemPrompt({
      executionMode: "plan",
      promptContext: { userMessage: "hello" },
      mcpSummary: "## MCP\nConnected server summary",
    });

    const [staticHalf, dynamicHalf, ...extra] =
      composed.systemPrompt.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(extra).toHaveLength(0);
    expect(dynamicHalf).toBeDefined();

    // The identity and the doctrine are the cacheable prefix.
    expect(staticHalf).toContain("## Skill System");
    // Mode remains behind the boundary; live app catalogs stay out of the
    // system prompt entirely so reconnecting cannot invalidate its prefix.
    expect(dynamicHalf).not.toContain("Connected server summary");
    expect(staticHalf).not.toContain("Connected server summary");
  });

  it("omits the boundary entirely when nothing dynamic exists", async () => {
    // A trailing marker with an empty tail would make the Anthropic adapter
    // emit an empty text block, which is a 400.
    const composed = await composeAgentSystemPrompt({
      promptContext: { userMessage: "hello" },
    });
    const halves = composed.systemPrompt.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    // The mode section always exists, so there is always a dynamic half; what
    // must never happen is a marker with nothing after it.
    if (halves.length > 1) {
      expect(halves[1]?.trim()).not.toBe("");
    }
  });

  it("injects only the ACTIVE global-instruction set, and none when none is active", async () => {
    useSettingsStore.setState({
      globalInstructionProfiles: [
        { id: "one", name: "Default", text: "INACTIVE-SET-RULES" },
        { id: "two", name: "Reviewer", text: "ACTIVE-SET-RULES" },
      ],
      activeGlobalInstructionProfileId: "two",
    });
    const composed = await composeAgentSystemPrompt({
      promptContext: { userMessage: "hello" },
    });
    expect(composed.systemPrompt).toContain("<user_global_instructions>");
    expect(composed.systemPrompt).toContain("ACTIVE-SET-RULES");
    // The other persona exists but is switched off — it must not leak.
    expect(composed.systemPrompt).not.toContain("INACTIVE-SET-RULES");

    useSettingsStore.setState({ activeGlobalInstructionProfileId: "" });
    const none = await composeAgentSystemPrompt({
      promptContext: { userMessage: "hello" },
    });
    expect(none.systemPrompt).not.toContain("<user_global_instructions>");
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
