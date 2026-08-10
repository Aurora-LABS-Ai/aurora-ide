import { describe, expect, it } from "vitest";
import {
  buildExplorerChangeGroups,
  type AgentFileChangedPayload,
} from "./agent-file-sync";

const change = (
  path: string,
  kind: AgentFileChangedPayload["kind"],
  oldPath?: string,
): AgentFileChangedPayload => ({
  path,
  kind,
  isDirectory: false,
  oldPath,
});

describe("agent file explorer change batching", () => {
  it("dedupes changes and maps them to targeted explorer event kinds", () => {
    expect(
      buildExplorerChangeGroups([
        change("src/a.ts", "created"),
        change("src/a.ts", "created"),
        change("src/b.ts", "modified"),
        change("src/c.ts", "deleted"),
        change("src/new.ts", "renamed", "src/old.ts"),
      ]),
    ).toEqual([
      { kind: "create", paths: ["src/a.ts", "src/new.ts"] },
      { kind: "modify", paths: ["src/b.ts"] },
      { kind: "remove", paths: ["src/c.ts", "src/old.ts"] },
    ]);
  });
});
