/**
 * Golden files for the tool list the window sends with a turn today.
 *
 * `agent_chat_v2` carries the tools the WINDOW runs (skills, `ask_question`,
 * artifacts, MCP); every native tool comes from the Rust registry and is not
 * in this list. `AgentService.buildAvailableTools` filters by mode, by vision
 * and by deep research. Phase 3 moves that choice into the engine; this
 * records the exact list, as JSON, into
 * `src-tauri/src/agent_runtime/turn_build/golden/tools/` for the port to match.
 *
 * The real tool definitions are used. MCP servers are pinned: one connected
 * server with two tools, one disabled and one disconnected (neither may
 * appear).
 *
 * A deliberate change: run with `AURORA_UPDATE_GOLDEN=1` and commit the diff.
 */

// @ts-expect-error The app intentionally omits Node typings; Vitest itself runs in Node.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { AgentService } from "@/apps/agent/services/runtime/agent-service";
import type { AgentExecutionMode } from "@/apps/agent/services/runtime/agent-execution-mode";
import type { ProviderConfig } from "@/apps/agent/services/providers";
import { useMcpStore, type McpServerState } from "@/apps/agent/store/tools/useMcpStore";

const node = (globalThis as unknown as {
  process: { cwd: () => string; env: Record<string, string | undefined> };
}).process;
const GOLDEN_DIR = `${node.cwd()}/src-tauri/src/agent_runtime/turn_build/golden/tools`;
const UPDATE = node.env.AURORA_UPDATE_GOLDEN === "1";

const server = (
  id: string,
  name: string,
  status: McpServerState["status"],
  enabled: boolean,
  tools: McpServerState["tools"],
): McpServerState => ({
  config: {
    id,
    name,
    enabled,
    args: [],
    autoApprove: false,
    autoStart: true,
    env: {},
    headers: {},
    transport: "stdio",
  },
  status,
  resources: [],
  tools,
});

const MCP_SERVERS: McpServerState[] = [
  server("github", "GitHub", "connected", true, [
    {
      name: "search_issues",
      description: "Search issues in a repository.",
      inputSchema: {
        type: "object",
        properties: { repo: { type: "string" }, query: { type: "string" } },
        required: ["repo", "query"],
      },
    },
    { name: "whoami", description: "The signed-in account." },
  ]),
  server("off", "Switched Off", "connected", false, [{ name: "hidden", description: "Must not appear." }]),
  server("down", "Not Running", "disconnected", true, [{ name: "gone", description: "Must not appear." }]),
];

interface ToolCase {
  name: string;
  mode: AgentExecutionMode;
  vision?: boolean;
  deepResearch?: boolean;
  mcp?: boolean;
}

const CASES: ToolCase[] = [
  { name: "agent", mode: "agent", vision: true },
  { name: "agent-no-vision", mode: "agent", vision: false },
  { name: "agent-mcp", mode: "agent", vision: true, mcp: true },
  { name: "plan", mode: "plan", vision: true },
  { name: "plan-mcp", mode: "plan", vision: true, mcp: true },
  { name: "chat", mode: "chat", vision: true },
  { name: "chat-deep-research-mcp", mode: "chat", vision: true, deepResearch: true, mcp: true },
];

const provider = (vision: boolean): ProviderConfig =>
  ({ id: "p", providerType: "anthropic", model: "m", supportsVision: vision }) as ProviderConfig;

describe("tool list golden files", () => {
  beforeAll(() => {
    if (!UPDATE) return;
    mkdirSync(GOLDEN_DIR, { recursive: true });
    // The inputs, for the Rust test (`turn_build/tools.rs`) to compose the
    // same cases. The server fixture is written in the engine's own
    // `McpServerState` shape, which the window's type mirrors.
    const cases = CASES.map((c) => ({
      name: c.name,
      mode: c.mode,
      supportsVision: c.vision ?? true,
      deepResearch: c.deepResearch ?? false,
      servers: c.mcp ? MCP_SERVERS : [],
    }));
    writeFileSync(`${GOLDEN_DIR}/cases.json`, `${JSON.stringify(cases, null, 2)}\n`, "utf8");
  });

  it.each(CASES)("$name", (c) => {
    useMcpStore.setState({ servers: c.mcp ? MCP_SERVERS : [] });
    const service = new AgentService({ executionMode: c.mode, deepResearch: c.deepResearch });
    const tools = (
      service as unknown as {
        buildAvailableTools: (tools: undefined, providerConfig: ProviderConfig) => unknown[];
      }
    ).buildAvailableTools(undefined, provider(c.vision ?? true));
    const json = `${JSON.stringify(tools, null, 2)}\n`;

    const file = `${GOLDEN_DIR}/${c.name}.json`;
    if (UPDATE) {
      writeFileSync(file, json, "utf8");
      return;
    }
    expect(existsSync(file), `missing ${file}; run with AURORA_UPDATE_GOLDEN=1`).toBe(true);
    expect(json).toBe(readFileSync(file, "utf8"));
  });

  it("never sends a tool from a server that is off or not running", () => {
    useMcpStore.setState({ servers: MCP_SERVERS });
    const names = (
      new AgentService({ executionMode: "agent" }) as unknown as {
        buildAvailableTools: (tools: undefined, providerConfig: ProviderConfig) => {
          function: { name: string };
        }[];
      }
    )
      .buildAvailableTools(undefined, provider(true))
      .map((tool) => tool.function.name);
    expect(names.some((name) => name.includes("hidden") || name.includes("gone"))).toBe(false);
    expect(names.some((name) => name.includes("search_issues"))).toBe(true);
  });
});
