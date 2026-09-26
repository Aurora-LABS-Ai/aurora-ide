import { expect, it, vi } from "vitest";
import { startIndexBuild, buildProgress, deleteIndexStorage } from "./code-index";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/kernel/lib/ipc/runtime", () => ({ auroraInvoke: mocks.invoke }));
it("builds locally without a provider configuration", async () => {
  await startIndexBuild("A");
  expect(mocks.invoke).toHaveBeenCalledWith("code_index_start_build", { workspacePath: "A" });
});
it("deletes using an inventory ID rather than a filesystem path", async () => {
  await deleteIndexStorage("project-a");
  expect(mocks.invoke).toHaveBeenCalledWith("code_index_delete_storage", { projectId: "project-a" });
});
it("reports actual processed files", () => {
  expect(buildProgress({ id:"a", workspace:"A", phase:"indexing", startedAt:0, finishedAt:null,
    completedFiles:3, totalFiles:20, currentSource:"auth.ts", error:null })).toBe("3 of 20 files checked. auth.ts");
});
