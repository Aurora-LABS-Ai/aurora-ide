import { describe, expect, it } from "vitest";

import { rankFiles, type MentionFile } from "@/apps/agent/adapters/file-index";

const file = (rel: string): MentionFile => ({
  name: rel.slice(rel.lastIndexOf("/") + 1),
  path: `E:\\proj\\${rel.split("/").join("\\")}`,
  rel,
});

const files = [
  "README.md",
  "src/apps/agent/components/composer/AgentComposer.tsx",
  "src/apps/agent/components/composer/ComposerMenu.tsx",
  "src/apps/agent/components/composer/ContextRing.tsx",
  "src/apps/agent/adapters/file-index.ts",
  "src/apps/ide/features/settings/QuickOpenModal.tsx",
  "src-tauri/src/explorer/file_list.rs",
  ".knowledge/lesson.md",
].map(file);

const rels = (query: string, limit?: number) => rankFiles(files, query, limit).map((f) => f.rel);

describe("rankFiles", () => {
  it("puts a file whose name starts with the query first", () => {
    expect(rels("Agent")[0]).toBe("src/apps/agent/components/composer/AgentComposer.tsx");
  });

  /** On Windows the list used to keep `\` separators, so a typed `/` never
   *  matched a path. Every rel is `/` now, and a typed `\` reads as `/`. */
  it("matches a path typed with either slash", () => {
    expect(rels("composer/Agent")[0]).toBe("src/apps/agent/components/composer/AgentComposer.tsx");
    expect(rels("composer\\Agent")[0]).toBe("src/apps/agent/components/composer/AgentComposer.tsx");
  });

  it("finds a file by its letters in order", () => {
    expect(rels("agcomp")).toContain("src/apps/agent/components/composer/AgentComposer.tsx");
    expect(rels("qom")[0]).toBe("src/apps/ide/features/settings/QuickOpenModal.tsx");
  });

  it("finds the files in a folder named by the query", () => {
    const found = rels("composer");
    expect(found.slice(0, 3)).toEqual(
      expect.arrayContaining([
        "src/apps/agent/components/composer/AgentComposer.tsx",
        "src/apps/agent/components/composer/ComposerMenu.tsx",
        "src/apps/agent/components/composer/ContextRing.tsx",
      ]),
    );
  });

  it("finds files in dot-folders", () => {
    expect(rels("lesson")[0]).toBe(".knowledge/lesson.md");
  });

  it("ranks an exact name above one that only starts with it", () => {
    const list = [file("a/file-index.test.ts"), file("b/file-index.ts")];
    expect(rankFiles(list, "file-index.ts").map((f) => f.rel)).toEqual([
      "b/file-index.ts",
      "a/file-index.test.ts",
    ]);
  });

  it("returns more than eight files when that many match", () => {
    const many = Array.from({ length: 30 }, (_, i) => file(`src/part${i}.ts`));
    expect(rankFiles(many, "part")).toHaveLength(30);
  });

  it("lists the shortest paths first for a bare @", () => {
    expect(rels("", 1)).toEqual(["README.md"]);
  });

  /** Measured on this repository: `agcomp` also returned an example theme and
   *  a review helper, because its letters can be found, far apart, in their
   *  long paths. */
  it("does not match letters scattered across a long path", () => {
    const list = [
      file("src/apps/agent/components/composer/AgentComposer.tsx"),
      file("example-themes/aurora-light-complete.json"),
      file("src/apps/agent/components/files/review.ts"),
    ];
    expect(rankFiles(list, "agcomp").map((f) => f.rel)).toEqual([
      "src/apps/agent/components/composer/AgentComposer.tsx",
    ]);
  });

  it("returns nothing for letters that appear nowhere", () => {
    expect(rels("zzqx")).toEqual([]);
  });
});
