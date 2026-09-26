import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
// @ts-expect-error The app intentionally omits Node typings; Vitest itself runs in Node.
import { readFileSync } from "node:fs";
import { CodeIndexCard } from "./CodeIndexCard";
import type { BuildSnapshot } from "@/apps/agent/services/code-index/code-index";

const cwd = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd();
const settingsCss = readFileSync(
  `${cwd}/src/apps/agent/theme/agent-window/17-settings-core.css`,
  "utf8",
);

const mocks = vi.hoisted(() => ({ root: "A", read: vi.fn(), save: vi.fn(), start: vi.fn(), cancel: vi.fn(), list: vi.fn(), remove: vi.fn() }));
vi.mock("@/apps/agent/store/conversation/useAgentChatStore", () => ({
  useAgentChatStore: (select: (s: { projectRoot: string }) => unknown) => select({ projectRoot: mocks.root }),
}));
vi.mock("@/apps/agent/services/code-index/code-index", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/apps/agent/services/code-index/code-index")>(),
  readIndexBuild: mocks.read, saveIndexSettings: mocks.save, startIndexBuild: mocks.start, cancelIndexBuild: mocks.cancel,
  listIndexStorage: mocks.list, deleteIndexStorage: mocks.remove,
  isIndexBuilding: (job: BuildSnapshot["job"]) => !!job && ["queued", "indexing", "indexing"].includes(job.phase),
  buildProgress: (job: NonNullable<BuildSnapshot["job"]>) => `${job.phase} ${job.completedFiles} of ${job.totalFiles}`,
}));

const snapshot = (workspace = "A"): BuildSnapshot => ({
  index: { workspace, built: true, files: workspace === "A" ? 42 : 7, symbols: 100, refs: 200, buildMs: 10, skippedGenerated: 0, skippedDirs: [], cachePath: "", cacheBytes: 1234, reusedFiles: 0 },
  settings: { autoBuild: true, searchResults: 8, searchBytes: 24000 }, job: null,
});
let container: HTMLDivElement;
let root: Root;
const render = async () => { await act(async () => root.render(<CodeIndexCard />)); };
const button = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === text);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  mocks.root = "A";
  mocks.list.mockReset().mockResolvedValue([{ projectId: "a", workspace: "A", bytes: 1234, building: false, workspaceExists: true, updatedAt: null }]);
  mocks.remove.mockReset().mockResolvedValue(undefined);
  mocks.read.mockReset().mockImplementation(async (workspace: string) => snapshot(workspace));
  mocks.save.mockReset().mockResolvedValue(undefined);
  mocks.start.mockReset().mockResolvedValue(undefined);
  mocks.cancel.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

it("opening settings never builds or calls a model", async () => {
  await render();
  expect(container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
  expect(button("Rebuild")?.disabled).toBe(false);
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
});

it("saves automatic indexing for this project without building", async () => {
  await render();
  await act(async () => container.querySelector<HTMLButtonElement>('[role="switch"]')?.click());
  expect(mocks.save).toHaveBeenCalledWith("A", { autoBuild: false, searchResults: 8, searchBytes: 24000 });
  expect(container.textContent).not.toContain("Indexing model");
  expect(container.textContent).not.toContain("AI indexing");
  expect(mocks.start).not.toHaveBeenCalled();
});

it("lists storage without an open project and confirms before deletion", async () => {
  mocks.root = "";
  await render();
  expect(container.textContent).toContain("1.2 KB");
  await act(async () => button("Delete index")?.click());
  expect(mocks.remove).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Keeps source files, conversations, and settings");
  await act(async () => document.querySelector<HTMLButtonElement>(".agw-confirm-primary")?.click());
  expect(mocks.remove).toHaveBeenCalledWith("a");
});

it("blocks deleting an active build", async () => {
  mocks.list.mockResolvedValue([{ projectId:"a", workspace:"A", bytes:1234, building:true, workspaceExists:true, updatedAt:null }]);
  await render();
  expect(button("Delete index")?.disabled).toBe(true);
});

it("keeps a build attached to A while B displays its own index", async () => {
  await render();
  let finish!: () => void;
  mocks.start.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
  await act(async () => button("Rebuild")?.click());
  expect(mocks.start).toHaveBeenCalledWith("A");
  mocks.root = "B";
  await render();
  expect(container.querySelector(".agw-cidx-stat-value")?.textContent).toBe("7");
  await act(async () => finish());
  expect(container.querySelector(".agw-cidx-stat-value")?.textContent).toBe("7");
  expect(mocks.cancel).not.toHaveBeenCalled();
});

it("shows a running build again after the page remounts, and Stop targets that project", async () => {
  const running = snapshot();
  running.job = { id: "a", workspace: "A", phase: "indexing", startedAt: 0, finishedAt: null, completedFiles: 2, totalFiles: 8, error: null };
  mocks.read.mockResolvedValue(running);
  await render();
  expect(container.textContent).toContain("2 of 8");
  expect(container.textContent).toContain("You can switch projects");
  expect(container.querySelector<HTMLButtonElement>('[role="switch"]')?.disabled).toBe(false);
  expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("2");
  expect(container.textContent).toContain("25% of files");
  await act(async () => button("Stop build")?.click());
  expect(mocks.cancel).toHaveBeenCalledWith("A");
  expect(mocks.start).not.toHaveBeenCalled();
});

it("keeps an action error visible when the next status poll succeeds", async () => {
  await render();
  mocks.start.mockRejectedValue(new Error("Provider unavailable"));
  await act(async () => button("Rebuild")?.click());
  await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Provider unavailable");
  expect(button("Rebuild")?.disabled).toBe(false);
});


it("keeps unsaved search settings through polling and saves them only for this project", async () => {
  const saved = snapshot("A");
  mocks.read.mockImplementation(async () => structuredClone(saved));
  mocks.save.mockImplementation(async (_workspace, settings) => { saved.settings = settings; });
  await render();
  const input = container.querySelector<HTMLInputElement>('[aria-label="Source output limit"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "32000");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
  expect(input.value).toBe("32000");
  expect(button("Rebuild")?.disabled).toBe(true);
  expect(mocks.save).not.toHaveBeenCalled();
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(mocks.save).toHaveBeenCalledWith("A", expect.objectContaining({ searchBytes: 32000 }));
  expect(button("Rebuild")?.disabled).toBe(false);
  expect(mocks.start).not.toHaveBeenCalled();
});

// ── Saved project indexes, at the size a long-lived install reaches ──────────

const manyProjects = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    projectId: `p${i}`,
    workspace: `C:\\work\\project-${i}`,
    // Descending, the order the Rust inventory returns.
    bytes: (count - i) * 1024,
    building: false,
    workspaceExists: true,
    updatedAt: null,
  }));

it("holds a hundred saved indexes in one bounded, scrollable list", async () => {
  mocks.list.mockResolvedValue(manyProjects(100));
  await render();
  const list = container.querySelector<HTMLElement>(".agw-cidx-list")!;
  // Every project stays reachable — the section is bounded by its own scroll
  // box, not by dropping rows the user then cannot find or delete.
  expect(list.querySelectorAll(".agw-set-row")).toHaveLength(100);
  expect(list.classList.contains("agw-scroll")).toBe(true);
  expect(container.textContent).toContain("100 projects");
});

// The stylesheet is the other half of the bound above, and jsdom loads no CSS,
// so the rule is read where it is written. Without it the list renders a
// hundred full-height rows straight into the page.
it("bounds the saved index list in the stylesheet, not just in markup", () => {
  const rule = settingsCss.match(/\.agw-cidx-list\s*\{[^}]*\}/)?.[0] ?? "";
  expect(rule).toMatch(/max-height:\s*clamp\(/);
  expect(rule).toMatch(/overflow-y:\s*auto/);
});

it("filters the saved index list and says how many of the total are showing", async () => {
  mocks.list.mockResolvedValue(manyProjects(100));
  await render();
  const find = container.querySelector<HTMLInputElement>('[aria-label="Search saved project indexes"]')!;
  const type = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(find, value);
      find.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  // `project-7` plus `project-7x`; a path typed with forward slashes still
  // matches a workspace stored with backslashes.
  await type("work/project-7");
  const rows = container.querySelectorAll(".agw-cidx-list .agw-set-row");
  expect(rows).toHaveLength(11);
  expect(container.querySelector(".agw-cidx-find-count")?.textContent).toBe("11 / 100");
  await type("nothing-like-this");
  expect(container.querySelectorAll(".agw-cidx-list .agw-set-row")).toHaveLength(0);
  expect(container.textContent).toContain("No project matches");
});

it("offers no filter for a handful of projects", async () => {
  mocks.list.mockResolvedValue(manyProjects(4));
  await render();
  expect(container.querySelector('[aria-label="Search saved project indexes"]')).toBeNull();
  expect(container.querySelectorAll(".agw-cidx-list .agw-set-row")).toHaveLength(4);
});

it("polls saved index sizes slowly until a build makes them move", async () => {
  mocks.list.mockResolvedValue(manyProjects(100));
  await render();
  const afterFirst = mocks.list.mock.calls.length;
  // A hundred projects is a hundred cache-directory walks per tick. Nothing is
  // building, so the panel must not pay that every five seconds.
  await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
  expect(mocks.list.mock.calls.length).toBe(afterFirst);

  const building = manyProjects(100);
  building[0].building = true;
  mocks.list.mockResolvedValue(building);
  await act(async () => { await vi.advanceTimersByTimeAsync(25_000); });
  const afterIdleTick = mocks.list.mock.calls.length;
  expect(afterIdleTick).toBeGreaterThan(afterFirst);
  await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
  expect(mocks.list.mock.calls.length).toBeGreaterThan(afterIdleTick);
});

it("refreshes saved indexes on demand", async () => {
  mocks.list.mockResolvedValue(manyProjects(100));
  await render();
  const before = mocks.list.mock.calls.length;
  await act(async () => button("Refresh")?.click());
  expect(mocks.list.mock.calls.length).toBe(before + 1);
});

it("does not claim a percentage until the amount of work is known", async () => {
  const saved = snapshot();
  saved.job = { id: "a", workspace: "A", phase: "indexing", startedAt: 0, finishedAt: null, completedFiles: 0, totalFiles: 0, error: null };
  mocks.read.mockResolvedValue(saved);
  await render();
  expect(container.querySelector('[role="progressbar"]')?.hasAttribute("aria-valuenow")).toBe(false);
  expect(container.textContent).not.toContain("% of files");
});
