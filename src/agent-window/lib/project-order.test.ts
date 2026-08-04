import { describe, expect, it } from "vitest";

import type { ThreadSummary } from "../../services/thread-service";
import { compactParentPath, folderName, orderProjects } from "./project-order";

const thread = (
  workspaceRoot: string,
  createdAt: string,
  updatedAt: string,
): ThreadSummary =>
  ({ id: `${workspaceRoot}-${createdAt}`, workspaceRoot, createdAt, updatedAt }) as ThreadSummary;

const A = "E:/code/alpha";
const B = "E:/code/bravo";
const C = "E:/code/charlie";

// alpha touched oldest, charlie newest.
const threads = [
  thread(A, "2026-01-01", "2026-01-02"),
  thread(B, "2026-02-01", "2026-03-01"),
  thread(C, "2026-03-01", "2026-04-01"),
];

const order = (over: Partial<Parameters<typeof orderProjects>[0]> = {}) =>
  orderProjects({
    knownProjects: [A, B, C],
    threads,
    projectRoot: null,
    sortMode: "recent",
    pinned: new Set(),
    ...over,
  });

describe("orderProjects", () => {
  it("sorts by newest activity first under 'recent'", () => {
    expect(order()).toEqual([C, B, A]);
  });

  it("sorts by folder name under 'name'", () => {
    expect(order({ sortMode: "name" })).toEqual([A, B, C]);
  });

  it("sorts by oldest first activity under 'oldest'", () => {
    expect(order({ sortMode: "oldest" })).toEqual([A, B, C]);
  });

  it("floats pinned projects above everything, whatever the sort", () => {
    expect(order({ pinned: new Set([A]) })).toEqual([A, C, B]);
    expect(order({ sortMode: "name", pinned: new Set([C]) })).toEqual([C, A, B]);
  });

  /** A project you just opened has no chats yet; it must still be listed. */
  it("includes the open project even with no threads", () => {
    const fresh = "E:/code/delta";
    expect(order({ projectRoot: fresh })).toContain(fresh);
  });

  it("includes roots that only appear on a thread", () => {
    const orphan = "E:/code/orphan";
    expect(
      order({
        knownProjects: [],
        threads: [thread(orphan, "2026-01-01", "2026-01-01")],
      }),
    ).toEqual([orphan]);
  });

  /** Under 'recent', a project with no activity has nothing to rank on — it
   *  goes last, and ties there fall back to name so the order is stable. */
  it("puts activity-less projects last under 'recent', ordered by name", () => {
    const y = "E:/code/yankee";
    const z = "E:/code/zulu";
    // Only alpha has a thread, so only alpha can be ranked by activity.
    expect(
      order({ knownProjects: [A, z, y], threads: [threads[0]] }),
    ).toEqual([A, y, z]);
  });

  it("never repeats a root that arrives from several sources", () => {
    const result = order({ knownProjects: [A, A, B], projectRoot: A });
    expect(result.filter((root) => root === A)).toHaveLength(1);
  });
});

describe("folderName", () => {
  it("takes the last segment for either separator", () => {
    expect(folderName("E:/code/alpha")).toBe("alpha");
    expect(folderName("E:\\code\\alpha")).toBe("alpha");
  });

  it("names the absence rather than rendering blank", () => {
    expect(folderName(null)).toBe("No project");
  });
});

describe("compactParentPath", () => {
  it("elides from the LEFT so the disambiguating segments survive", () => {
    expect(compactParentPath("E:/a/b/c/d/project")).toBe("…/c/d");
  });

  it("shows a short parent whole", () => {
    expect(compactParentPath("E:/code/project")).toBe("E:/code");
  });

  it("returns nothing when there is no parent to show", () => {
    expect(compactParentPath("project")).toBe("");
  });
});
