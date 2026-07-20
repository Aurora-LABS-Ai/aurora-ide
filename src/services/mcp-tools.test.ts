/**
 * parseMcpToolName — server-prefix disambiguation.
 *
 * Tool names are `mcp_{sanitizedServerId}_{toolName}`, and server ids can be
 * prefixes of each other after sanitization ("browser" vs "browser-testing").
 * These tests pin the routing rules: advertised tool wins, then longest
 * prefix; a first-match scan must never send a "browser-testing" call to the
 * "browser" server.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  type McpServerConfig,
  type McpServerState,
  useMcpStore,
} from "../store/useMcpStore";
import { parseMcpToolName } from "./mcp-tools";

function makeServer(
  id: string,
  name: string,
  toolNames: string[],
  status: McpServerState["status"] = "connected",
): McpServerState {
  const config: McpServerConfig = {
    id,
    name,
    transport: "stdio",
    command: "cmd",
    args: [],
    env: {},
    headers: {},
    enabled: true,
    autoStart: false,
    autoApprove: false,
  };
  return {
    config,
    status,
    tools: toolNames.map((toolName) => ({ name: toolName })),
    resources: [],
  };
}

describe("parseMcpToolName", () => {
  beforeEach(() => {
    useMcpStore.setState({ servers: [] });
  });

  it("routes to the advertising server when one server id is a prefix of another", () => {
    useMcpStore.setState({
      servers: [
        // "browser" listed FIRST — the old first-match scan picked it.
        makeServer("browser", "browser", ["navigate", "click"]),
        makeServer("browser-testing", "browser-testing", [
          "browser_connect",
          "browser_open_url",
        ]),
      ],
    });

    const parsed = parseMcpToolName("mcp_browser_testing_browser_connect");
    expect(parsed).not.toBeNull();
    expect(parsed?.serverId).toBe("browser-testing");
    expect(parsed?.originalToolName).toBe("browser_connect");
  });

  it("falls back to the longest matching prefix when no server advertises the tool", () => {
    useMcpStore.setState({
      servers: [
        // Tools not loaded yet (e.g. both disconnected).
        makeServer("browser", "browser", [], "disconnected"),
        makeServer("browser-testing", "browser-testing", [], "disconnected"),
      ],
    });

    const parsed = parseMcpToolName("mcp_browser_testing_browser_connect");
    expect(parsed?.serverId).toBe("browser-testing");
    expect(parsed?.originalToolName).toBe("browser_connect");
  });

  it("still resolves the short-id server for its own tools", () => {
    useMcpStore.setState({
      servers: [
        makeServer("browser", "browser", ["navigate"]),
        makeServer("browser-testing", "browser-testing", ["browser_connect"]),
      ],
    });

    const parsed = parseMcpToolName("mcp_browser_navigate");
    expect(parsed?.serverId).toBe("browser");
    expect(parsed?.originalToolName).toBe("navigate");
  });

  it("prefers an advertised tool over a longer non-advertised prefix", () => {
    useMcpStore.setState({
      servers: [
        // "browser" genuinely owns a tool that happens to start with
        // "testing_" — advertisement must beat prefix length.
        makeServer("browser", "browser", ["testing_browser_connect"]),
        makeServer("browser-testing", "browser-testing", ["browser_open_url"]),
      ],
    });

    const parsed = parseMcpToolName("mcp_browser_testing_browser_connect");
    expect(parsed?.serverId).toBe("browser");
    expect(parsed?.originalToolName).toBe("testing_browser_connect");
  });

  it("returns null when no configured server matches", () => {
    useMcpStore.setState({
      servers: [makeServer("browser", "browser", ["navigate"])],
    });

    expect(parseMcpToolName("mcp_unknown_server_tool")).toBeNull();
    expect(parseMcpToolName("file_read")).toBeNull();
  });

  it("re-parses after the server list changes (cache invalidation)", () => {
    useMcpStore.setState({
      servers: [makeServer("browser", "browser", [], "disconnected")],
    });
    // Ambiguous name resolves to the only match for now.
    expect(parseMcpToolName("mcp_browser_testing_browser_connect")?.serverId).toBe(
      "browser",
    );

    useMcpStore.setState({
      servers: [
        makeServer("browser", "browser", [], "disconnected"),
        makeServer("browser-testing", "browser-testing", ["browser_connect"]),
      ],
    });
    expect(parseMcpToolName("mcp_browser_testing_browser_connect")?.serverId).toBe(
      "browser-testing",
    );
  });
});
