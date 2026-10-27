import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FileEntry } from "@/kernel/lib/ipc/tauri";

/** Each read waits until the test answers it, so the in-between can be seen. */
const pending: Array<{ path: string; answer: (entries: FileEntry[]) => void }> = [];

vi.mock("@/kernel/lib/ipc/tauri", () => ({
  readDirectory: (path: string) =>
    new Promise<FileEntry[]>((resolve) => pending.push({ path, answer: resolve })),
}));

const { useAgentFilesStore } = await import("./useAgentFilesStore");

const file = (name: string): FileEntry =>
  ({ name, path: `/p/${name}`, is_dir: false, is_file: true }) as FileEntry;

/** Answer the oldest read of `path` and let the store apply it. */
async function answer(path: string, names: string[]): Promise<void> {
  const index = pending.findIndex((p) => p.path === path);
  expect(index, `no read of ${path} is waiting`).toBeGreaterThanOrEqual(0);
  const [read] = pending.splice(index, 1);
  read.answer(names.map(file));
  await new Promise((r) => setTimeout(r, 0));
}

const names = () => useAgentFilesStore.getState().childrenByDir["/p"]?.map((e) => e.name);

beforeEach(async () => {
  pending.length = 0;
  useAgentFilesStore.getState().setRoot(null);
  useAgentFilesStore.getState().setRoot("/p");
  await answer("/p", ["a.ts"]);
});

describe("files tree refresh", () => {
  it("keeps a folder's old listing on screen while a watcher change re-reads it", async () => {
    useAgentFilesStore.getState().applyFsChange(["/p/b.ts"]);
    // The read is out; the folder must not render empty meanwhile.
    expect(names()).toEqual(["a.ts"]);
    await answer("/p", ["a.ts", "b.ts"]);
    expect(names()).toEqual(["a.ts", "b.ts"]);
  });

  it("keeps the whole tree on screen through Refresh", async () => {
    useAgentFilesStore.getState().refresh();
    expect(names()).toEqual(["a.ts"]);
    await answer("/p", ["a.ts", "c.ts"]);
    expect(names()).toEqual(["a.ts", "c.ts"]);
  });

  it("counts a change against the file, however its path is spelled", async () => {
    const { fileStampKey } = await import("./useAgentFilesStore");
    useAgentFilesStore.getState().applyFsChange(["C:\\Work\\A.ts"]);
    const stamp = () => useAgentFilesStore.getState().fileStamp[fileStampKey("c:/work/a.ts")];
    expect(stamp()).toBe(1);
    useAgentFilesStore.getState().applyFsChange(["c:/work/a.ts"]);
    expect(stamp()).toBe(2);
  });

  it("reads again when the folder changes while a read is already out", async () => {
    useAgentFilesStore.getState().applyFsChange(["/p/b.ts"]);
    // A second change lands before the first read returns: that read may
    // predate it, so one more read must follow.
    useAgentFilesStore.getState().applyFsChange(["/p/c.ts"]);
    await answer("/p", ["a.ts", "b.ts"]);
    expect(pending.map((p) => p.path)).toEqual(["/p"]);
    await answer("/p", ["a.ts", "b.ts", "c.ts"]);
    expect(names()).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
});
