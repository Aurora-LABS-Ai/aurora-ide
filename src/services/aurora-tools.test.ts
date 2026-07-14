import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./skills", () => ({
  findSkillById: vi.fn(),
  searchSkillCandidates: vi.fn(),
}));
vi.mock("./team-agent-tools", () => ({
  executeTeamLeadTool: vi.fn(),
  isTeamLeadTool: vi.fn(() => false),
}));

import { executeAuroraFrontendTool } from "./aurora-tools";
import { findSkillById, searchSkillCandidates } from "./skills";

describe("Aurora skill tools", () => {
  beforeEach(() => {
    vi.mocked(searchSkillCandidates).mockReset().mockResolvedValue([]);
    vi.mocked(findSkillById).mockReset().mockResolvedValue(null);
  });

  it("uses the dispatching turn's workspace for skill search", async () => {
    await executeAuroraFrontendTool(
      "aurora_skill_search",
      { query: "rust" },
      { workspacePath: "E:/pinned-project", threadId: "thread-1" },
    );

    expect(searchSkillCandidates).toHaveBeenCalledWith("rust", 30, {
      workspacePath: "E:/pinned-project",
    });
  });

  it("uses the dispatching turn's workspace for skill loading", async () => {
    await expect(
      executeAuroraFrontendTool(
        "aurora_skill_load",
        { id: "missing" },
        { workspacePath: "E:/pinned-project", threadId: "thread-1" },
      ),
    ).rejects.toThrow("Skill not found");

    expect(findSkillById).toHaveBeenCalledWith("missing", {
      workspacePath: "E:/pinned-project",
    });
  });
});
