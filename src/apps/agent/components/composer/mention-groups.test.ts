import { describe, expect, it } from "vitest";

import type { MentionFile } from "@/apps/agent/adapters/file-index";
import type { TerminalSessionSummary } from "@/apps/agent/services/terminal/terminal-sessions";
import {
  buildMentionGroups,
  chatFiles,
  flattenGroups,
  openFiles,
} from "@/apps/agent/components/composer/mention-groups";

const ROOT = "E:\\proj";
const file = (rel: string): MentionFile => ({
  name: rel.slice(rel.lastIndexOf("/") + 1),
  path: `${ROOT}\\${rel.split("/").join("\\")}`,
  rel,
});
const files = [
  "README.md",
  "src/apps/agent/components/composer/AgentComposer.tsx",
  "src/apps/agent/components/tools/ToolGroup.tsx",
  "src/apps/agent/adapters/file-index.ts",
  "src-tauri/src/explorer/file_list.rs",
].map(file);
const terminal: TerminalSessionSummary = {
  id: "t1",
  title: "pnpm tauri:dev",
  shell: "pwsh",
  cwd: ROOT,
  running: true,
  lines: 10,
  attached: true,
};

const call = (args: Record<string, unknown>) => ({ arguments: JSON.stringify(args) });

describe("chatFiles", () => {
  it("lists the files this chat's tool calls touched, newest first, once each", () => {
    const messages = [
      { tool_calls: [call({ path: "src/apps/agent/adapters/file-index.ts" })] },
      { tool_calls: [call({ path: ["src/apps/agent/components/tools/ToolGroup.tsx"] })] },
      // An absolute Windows path and a repeat: same file, listed once.
      { tool_calls: [call({ file_path: "E:\\proj\\src\\apps\\agent\\adapters\\file-index.ts" })] },
    ];
    expect(chatFiles(messages, files, ROOT).map((f) => f.rel)).toEqual([
      "src/apps/agent/adapters/file-index.ts",
      "src/apps/agent/components/tools/ToolGroup.tsx",
    ]);
  });

  it("skips paths that are not in the project and arguments that are not JSON", () => {
    const messages = [
      { tool_calls: [{ arguments: "{not json" }, call({ path: "gone.ts" }), call({ command: "ls" })] },
    ];
    expect(chatFiles(messages, files, ROOT)).toEqual([]);
  });
});

describe("buildMentionGroups", () => {
  const base = {
    files,
    root: ROOT,
    open: openFiles([`${ROOT}\\src\\apps\\agent\\components\\composer\\AgentComposer.tsx`], files, ROOT),
    inChat: [file("src/apps/agent/components/composer/AgentComposer.tsx"), file("src/apps/agent/components/tools/ToolGroup.tsx")],
    terminals: [terminal],
  };

  /** A bare @ used to list README and config files first. */
  it("leads a bare @ with what is in front of the user", () => {
    const groups = buildMentionGroups({ ...base, query: "" });
    expect(groups.map((g) => g.label)).toEqual(["Open", "In this chat", "Terminals", "Project"]);
    // A file already under Open is not repeated under In this chat.
    expect(groups[1].rows).toHaveLength(1);
    expect(groups[3].rows.map((r) => (r.kind === "folder" ? r.file.rel : ""))).toEqual(["src", "src-tauri"]);
  });

  it("leaves out groups with nothing in them", () => {
    const groups = buildMentionGroups({ ...base, query: "", open: [], inChat: [], terminals: [] });
    expect(groups.map((g) => g.label)).toEqual(["Project"]);
  });

  it("searches files and folders once something is typed, terminals only when named", () => {
    const groups = buildMentionGroups({ ...base, query: "agcomp" });
    expect(groups.map((g) => g.label)).toEqual(["Files"]);
    const row = groups[0].rows[0];
    expect(row.kind === "file" && row.file.name).toBe("AgentComposer.tsx");
    expect(row.kind === "file" && row.matches).toEqual([0, 1, 5, 6, 7, 8]);

    expect(buildMentionGroups({ ...base, query: "term" }).map((g) => g.label)[0]).toBe("Terminals");
    expect(buildMentionGroups({ ...base, query: "explorer" }).map((g) => g.label)).toEqual(["Files", "Folders"]);
  });

  it("flattens to the order ↑ ↓ move through", () => {
    const rows = flattenGroups(buildMentionGroups({ ...base, query: "" }));
    expect(rows[0].kind === "file" && rows[0].file.name).toBe("AgentComposer.tsx");
    expect(rows.some((r) => r.kind === "terminal")).toBe(true);
  });
});
