import { describe, expect, it } from "vitest";
import {
  normalizeExplorerIconRequest,
  resolveExplorerIconFromPack,
} from "./icon-packs";

describe("explorer icon packs", () => {
  it("derives a missing file name from the path before resolving", () => {
    const request = normalizeExplorerIconRequest({
      name: undefined as unknown as string,
      path: "E:\\workspace\\src\\main.ts",
      isFolder: false,
    });

    expect(request.name).toBe("main.ts");
  });

  it("does not throw when a persisted file tree node has no name", () => {
    expect(() =>
      resolveExplorerIconFromPack(
        {
          name: undefined as unknown as string,
          path: "E:\\workspace\\src\\main.ts",
          isFolder: false,
        },
        "vscode",
      ),
    ).not.toThrow();
  });
});
