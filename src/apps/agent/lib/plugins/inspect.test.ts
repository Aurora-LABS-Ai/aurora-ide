import { describe, expect, it } from "vitest";

import { inspectServers, issueByServer, markOf, tileLine } from "./inspect";
import type { McpServerState } from "@/apps/agent/store/tools/useMcpStore";

const server = (
  id: string,
  name: string,
  partial: Partial<McpServerState["config"]> = {},
  status: McpServerState["status"] = "disconnected",
  error?: string,
): McpServerState => ({
  config: {
    id,
    name,
    transport: "stdio",
    command: "npx.cmd",
    args: ["-y", "some-package"],
    env: {},
    headers: {},
    enabled: true,
    autoStart: false,
    autoApprove: true,
    ...partial,
  },
  status,
  error,
  tools: [],
  resources: [],
});

describe("inspectServers", () => {
  it("flags two rows that start the same command, naming the twin, whichever slashes they use", () => {
    // Alvan's real pair: one row written with forward slashes, one with
    // backslashes, by two different config files. Windows runs the same file.
    const issues = inspectServers([
      server("a", "browser-testing", { command: "node", args: ["E:/tools/bt/index.js"] }),
      server("b", "browser_testing", { command: "Node", args: ["E:\\tools\\bt\\index.js"] }),
      server("c", "other", { command: "node", args: ["E:/tools/other.js"] }),
    ]);
    expect(issues).toEqual([
      { serverId: "a", kind: "duplicate", message: "Same command as browser_testing" },
      { serverId: "b", kind: "duplicate", message: "Same command as browser-testing" },
    ]);
  });

  it("flags the importer's generated name and an empty one", () => {
    const issues = inspectServers([
      server("a", "mcp-1767509230024-pqf9mg17y"),
      server("b", "  ", { args: ["-y", "another"] }),
      server("c", "qg-probe", { args: ["-y", "third"] }),
    ]);
    expect(issues.map((i) => [i.serverId, i.kind])).toEqual([
      ["a", "unnamed"],
      ["b", "unnamed"],
    ]);
  });

  it("carries a failed start with the first line of the server's own error", () => {
    const issues = inspectServers([
      server("a", "aws-mcp", {}, "error", "uvx: command not found\nmore detail"),
      server("b", "quiet", { args: ["x"] }, "error"),
    ]);
    expect(issues).toEqual([
      { serverId: "a", kind: "error", message: "uvx: command not found" },
      { serverId: "b", kind: "error", message: "Could not start" },
    ]);
  });

  it("reports nothing for a healthy, distinct, named set", () => {
    expect(
      inspectServers([
        server("a", "one", { args: ["1"] }, "connected"),
        server("b", "two", { args: ["2"] }),
      ]),
    ).toEqual([]);
  });

  it("issueByServer keeps the first issue per server", () => {
    const map = issueByServer([
      { serverId: "a", kind: "duplicate", message: "dup" },
      { serverId: "a", kind: "error", message: "err" },
    ]);
    expect(map.get("a")?.kind).toBe("duplicate");
  });
});

describe("tileLine", () => {
  it("puts the problem first, then the state, with the tool count only when connected", () => {
    const connected = { ...server("a", "x", { autoStart: true }, "connected"), tools: [{ name: "t" }] };
    expect(tileLine(connected, undefined)).toBe("1 tool · auto-start");
    expect(tileLine(server("b", "y"), undefined)).toBe("Not connected");
    expect(tileLine(server("c", "z", { enabled: false }), undefined)).toBe("Disabled");
    expect(tileLine(server("d", "w", {}, "connecting"), undefined)).toBe("Connecting…");
    expect(tileLine(connected, { serverId: "a", kind: "duplicate", message: "Same command as q" })).toBe(
      "Same command as q",
    );
  });
});

describe("markOf", () => {
  it("takes initials of the first two words, or two letters of a single word", () => {
    expect(markOf("ssh-fastmcp")).toBe("SF");
    expect(markOf("qg-probe")).toBe("QP");
    expect(markOf("TestSprite")).toBe("TE");
    expect(markOf("gadget-and-power_postgres_mcp")).toBe("GA");
    expect(markOf("")).toBe("?");
  });
});
