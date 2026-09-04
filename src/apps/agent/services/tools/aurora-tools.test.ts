import { beforeEach, describe, expect, it, vi } from "vitest";

const artifactMocks = vi.hoisted(() => ({
  present: vi.fn(),
  previewPatch: vi.fn(),
  loadThread: vi.fn(),
  validateMermaid: vi.fn(),
  currentThreadId: "thread-1" as string | null,
  openTab: vi.fn(),
  openArtifactTab: vi.fn(),
  setExpanded: vi.fn(),
}));

vi.mock("@/apps/agent/services/artifacts/agent-artifacts", () => ({
  previewThreadArtifactPatch: artifactMocks.previewPatch,
}));
vi.mock("@/apps/agent/services/artifacts/mermaid-artifacts", () => ({
  validateMermaidSource: artifactMocks.validateMermaid,
  describeMermaidError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

vi.mock("@/apps/agent/services/skills/skills", () => ({
  findSkillById: vi.fn(),
  searchSkillCandidates: vi.fn(),
}));
vi.mock("@/apps/agent/services/team/team-agent-tools", () => ({
  executeTeamLeadTool: vi.fn(),
  isTeamLeadTool: vi.fn(() => false),
}));
vi.mock("@/apps/agent/store/artifacts/useAgentArtifactStore", () => ({
  useAgentArtifactStore: {
    getState: () => ({
      present: artifactMocks.present,
      loadThread: artifactMocks.loadThread,
    }),
  },
}));
vi.mock("@/apps/agent/store/conversation/useAgentChatStore", () => ({
  useAgentChatStore: {
    getState: () => ({ currentThreadId: artifactMocks.currentThreadId }),
  },
}));
vi.mock("@/apps/agent/store/workspace/useAgentWorkspaceStore", () => ({
  useAgentWorkspaceStore: {
    getState: () => ({
      openTab: artifactMocks.openTab,
      openArtifactTab: artifactMocks.openArtifactTab,
      setExpanded: artifactMocks.setExpanded,
    }),
  },
}));

import { executeAuroraFrontendTool } from "@/apps/agent/services/tools/aurora-tools";
import { findSkillById, searchSkillCandidates } from "@/apps/agent/services/skills/skills";

describe("Aurora skill tools", () => {
  beforeEach(() => {
    vi.mocked(searchSkillCandidates).mockReset().mockResolvedValue([]);
    vi.mocked(findSkillById).mockReset().mockResolvedValue(null);
    artifactMocks.currentThreadId = "thread-1";
    artifactMocks.openTab.mockReset();
    artifactMocks.openArtifactTab.mockReset();
    artifactMocks.setExpanded.mockReset();
    artifactMocks.present.mockReset().mockResolvedValue({
      threadId: "thread-1",
      selectedArtifactId: "release-map",
      selectedVersionTag: "v2",
      artifacts: [],
    });
    artifactMocks.previewPatch.mockReset().mockResolvedValue("flowchart LR\nA --> B");
    artifactMocks.validateMermaid.mockReset().mockResolvedValue(undefined);
    artifactMocks.loadThread.mockReset().mockResolvedValue({
      threadId: "thread-1",
      selectedArtifactId: "release-map",
      selectedVersionTag: "v2",
      artifacts: [
        {
          id: "release-map",
          title: "Release map",
          kind: "html",
          versions: [
            {
              tag: "v1",
              content: "<style>\n:root { --accent: #7c3aed; }\n</style>\n<main>Ready</main>",
              createdAt: "2026-07-17T00:00:00Z",
            },
            {
              tag: "v2",
              content: "<style>\n:root { --accent: #0891b2; }\n</style>\n<main>Ready</main>",
              createdAt: "2026-07-17T00:01:00Z",
            },
          ],
        },
      ],
    });
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

  it("tells the model to use file_read when handed a path instead of a skill id", async () => {
    // The mistake this tool actually gets: a skill's own SKILL.md says to read
    // `references/audit.md` next, and the nearest-looking tool is this one. A
    // bare "Skill not found" left the model guessing at the id — seen in
    // thread `cfa53da5`, which then abandoned the skill's audit step.
    await expect(
      executeAuroraFrontendTool(
        "aurora_skill_load",
        { id: "C:\\Users\\Alvan\\.claude\\skills\\surface-philosophy\\references\\audit.md" },
        { workspacePath: "E:/pinned-project", threadId: "thread-1" },
      ),
    ).rejects.toThrow(/takes a skill id, not a path/);

    await expect(
      executeAuroraFrontendTool(
        "aurora_skill_load",
        { id: "surface-philosophy/references/audit.md" },
        { workspacePath: "E:/pinned-project", threadId: "thread-1" },
      ),
    ).rejects.toThrow(/file_read/);
  });

  it("pins artifact persistence to the dispatching turn and opens current Canvas", async () => {
    const result = await executeAuroraFrontendTool(
      "present_artifact",
      {
        artifactId: "release-map",
        title: "Release map",
        kind: "html",
        content: "<main>Ready</main>",
      },
      { workspacePath: "E:/project", threadId: "thread-1" },
    );

    expect(artifactMocks.present).toHaveBeenCalledWith("thread-1", {
      artifactId: "release-map",
      title: "Release map",
      kind: "html",
      content: "<main>Ready</main>",
    });
    // The artifact's OWN tab, not the Canvas index — Canvas is the list of
    // everything this conversation made, and what you want on a present is the
    // thing that was just presented.
    expect(artifactMocks.openArtifactTab).toHaveBeenCalledWith("release-map", "Release map");
    expect(artifactMocks.openTab).not.toHaveBeenCalled();
    expect(artifactMocks.setExpanded).not.toHaveBeenCalled();
    expect(JSON.parse(result)).toMatchObject({ versionTag: "v2", success: true });
  });

  it("sends focused artifact patches without resending unchanged content", async () => {
    await executeAuroraFrontendTool(
      "present_artifact",
      {
        artifactId: "release-map",
        title: "Release map",
        kind: "html",
        baseVersionTag: "v2",
        patches: [{ find: "--accent: #7c3aed", replace: "--accent: #0891b2" }],
      },
      { workspacePath: "E:/project", threadId: "thread-1" },
    );

    expect(artifactMocks.present).toHaveBeenCalledWith("thread-1", {
      artifactId: "release-map",
      title: "Release map",
      kind: "html",
      baseVersionTag: "v2",
      patches: [{ find: "--accent: #7c3aed", replace: "--accent: #0891b2" }],
    });
    expect(artifactMocks.setExpanded).not.toHaveBeenCalled();
  });

  it("reads an exact saved artifact version or only matching excerpts", async () => {
    const full = JSON.parse(
      await executeAuroraFrontendTool(
        "read_artifact",
        { artifactId: "release-map", versionTag: "v1" },
        { workspacePath: "E:/project", threadId: "thread-1" },
      ),
    );
    expect(full).toMatchObject({
      artifactId: "release-map",
      versionTag: "v1",
      content: "<style>\n:root { --accent: #7c3aed; }\n</style>\n<main>Ready</main>",
    });

    const focused = JSON.parse(
      await executeAuroraFrontendTool(
        "read_artifact",
        { artifactId: "release-map", versionTag: "v1", query: "--accent", contextLines: 0 },
        { workspacePath: "E:/project", threadId: "thread-1" },
      ),
    );
    expect(focused.excerpts).toEqual([
      { startLine: 2, endLine: 2, content: ":root { --accent: #7c3aed; }" },
    ]);
    expect(focused).not.toHaveProperty("content");
  });

  it("does not steal focus when a background conversation presents an artifact", async () => {
    artifactMocks.currentThreadId = "thread-visible";
    await executeAuroraFrontendTool(
      "present_artifact",
      {
        artifactId: "release-map",
        title: "Release map",
        kind: "html",
        content: "<main>Ready</main>",
      },
      { workspacePath: "E:/project", threadId: "thread-background" },
    );

    expect(artifactMocks.present).toHaveBeenCalledWith(
      "thread-background",
      expect.any(Object),
    );
    expect(artifactMocks.openTab).not.toHaveBeenCalled();
    expect(artifactMocks.openArtifactTab).not.toHaveBeenCalled();
  });

  it("validates complete Mermaid source before creating v1", async () => {
    await executeAuroraFrontendTool(
      "present_artifact",
      {
        artifactId: "system-map",
        title: "System map",
        kind: "mermaid",
        content: "flowchart LR\nClient --> API",
      },
      { workspacePath: "E:/project", threadId: "thread-1" },
    );

    expect(artifactMocks.validateMermaid).toHaveBeenCalledWith("flowchart LR\nClient --> API");
    expect(artifactMocks.present).toHaveBeenCalledOnce();
    expect(artifactMocks.previewPatch).not.toHaveBeenCalled();
  });

  it("rejects invalid complete Mermaid source without creating a version", async () => {
    artifactMocks.validateMermaid.mockRejectedValueOnce(new Error("Parse error on line 2"));

    await expect(
      executeAuroraFrontendTool(
        "present_artifact",
        {
          artifactId: "system-map",
          title: "System map",
          kind: "mermaid",
          content: "flowchart LR\nA --",
        },
        { workspacePath: "E:/project", threadId: "thread-1" },
      ),
    ).rejects.toThrow("invalid and was not saved");

    expect(artifactMocks.present).not.toHaveBeenCalled();
  });

  it("uses the backend patch engine and validates Mermaid before committing", async () => {
    artifactMocks.previewPatch.mockResolvedValueOnce("flowchart LR\nClient --> Gateway");

    await executeAuroraFrontendTool(
      "present_artifact",
      {
        artifactId: "system-map",
        title: "System map",
        kind: "mermaid",
        baseVersionTag: "v1",
        patches: [{ find: "Client --> API", replace: "Client --> Gateway" }],
      },
      { workspacePath: "E:/project", threadId: "thread-1" },
    );

    expect(artifactMocks.previewPatch).toHaveBeenCalledWith("thread-1", {
      artifactId: "system-map",
      title: "System map",
      kind: "mermaid",
      baseVersionTag: "v1",
      patches: [{ find: "Client --> API", replace: "Client --> Gateway" }],
    });
    expect(artifactMocks.validateMermaid).toHaveBeenCalledWith(
      "flowchart LR\nClient --> Gateway",
    );
    expect(artifactMocks.present).toHaveBeenCalledOnce();
  });

  it("does not save when patch preflight finds overlap or invalid Mermaid", async () => {
    artifactMocks.previewPatch.mockRejectedValueOnce(
      new Error("patches[1] overlaps with patches[0]"),
    );
    await expect(
      executeAuroraFrontendTool(
        "present_artifact",
        {
          artifactId: "system-map",
          title: "System map",
          kind: "mermaid",
          baseVersionTag: "v1",
          patches: [
            { find: "stroke=blue", replace: "stroke=cyan", all: true },
            { find: "fill=navy stroke=blue", replace: "fill=ink stroke=cyan" },
          ],
        },
        { workspacePath: "E:/project", threadId: "thread-1" },
      ),
    ).rejects.toThrow("patches[1] overlaps with patches[0]");
    expect(artifactMocks.present).not.toHaveBeenCalled();

    artifactMocks.previewPatch.mockResolvedValueOnce("flowchart LR\nA --");
    artifactMocks.validateMermaid.mockRejectedValueOnce(new Error("Parse error on line 2"));
    await expect(
      executeAuroraFrontendTool(
        "present_artifact",
        {
          artifactId: "system-map",
          title: "System map",
          kind: "mermaid",
          baseVersionTag: "v1",
          patches: [{ find: "A --> B", replace: "A --" }],
        },
        { workspacePath: "E:/project", threadId: "thread-1" },
      ),
    ).rejects.toThrow("would create invalid Mermaid source and were not saved");
    expect(artifactMocks.present).not.toHaveBeenCalled();
  });
});
