/**
 * MCP server lane — grouping, naming, and what a line says came back.
 *
 * The three things this replaced were all wrong in ways a test can hold:
 * the server was repeated on every row, the operation was a raw identifier
 * title-cased into "Pg Execute SQL", and the row said "Completed" where the
 * result was.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { McpServerLane } from "./McpServerLane";
import { mcpServerIdForCard } from "./mcp-card";
import { groupToolRuns, type ToolCall } from "./tool-call";
import { mcpOperationLabel } from "@/apps/agent/services/tools/mcp-tools";
import { useMcpStore, type McpServerState } from "@/apps/agent/store/tools/useMcpStore";

vi.mock("@/apps/agent/components/tool-views/ToolCode", () => ({
  ToolCode: ({ code }: { code: string }) => <pre className="agw-tool-result">{code}</pre>,
}));

const server = (
  id: string,
  name: string,
  tools: string[],
  overrides: Partial<McpServerState["config"]> = {},
): McpServerState => ({
  config: {
    args: [],
    autoApprove: false,
    autoStart: false,
    enabled: true,
    env: {},
    headers: {},
    id,
    name,
    transport: "stdio",
    ...overrides,
  },
  resources: [],
  status: "connected",
  tools: tools.map((toolName) => ({ name: toolName })),
});

const call = (id: string, name: string, extra: Partial<ToolCall> = {}): ToolCall => ({
  id,
  name,
  arguments: "{}",
  ...extra,
});

/**
 * The lane SUBSCRIBES to the MCP store, so it can gain the server's real name
 * and transport when the config finishes loading. `renderToStaticMarkup` serves
 * zustand's *initial* snapshot rather than the current one, so anything that
 * asserts on store-derived facts has to mount for real.
 */
let container: HTMLDivElement | null = null;
let root: Root | null = null;

const mount = async (node: React.ReactElement): Promise<string> => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
  return container.innerHTML;
};

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

beforeEach(() => {
  useMcpStore.setState({
    servers: [
      server("pgsrv", "aurora_labs_postgres_mcp", [
        "pg_execute_sql",
        "pg_list_tables",
        "pg_manage_transaction",
      ]),
      server("probe", "qg-probe", ["click", "capture", "dump_tree"]),
      server("aws", "aws-mcp", ["aws___run_script", "aws___list_regions"], {
        transport: "http",
        autoApprove: true,
      }),
    ],
  });
});

describe("grouping a run into one lane", () => {
  it("collects consecutive calls to the SAME server", () => {
    const runs = groupToolRuns([
      call("a", "mcp_pgsrv_pg_execute_sql"),
      call("b", "mcp_pgsrv_pg_list_tables"),
      call("c", "mcp_aws_aws___run_script"),
    ]);

    expect(runs.map((run) => run.map((c) => c.id))).toEqual([["a", "b"], ["c"]]);
  });

  it("does not group across a call to something else", () => {
    const runs = groupToolRuns([
      call("a", "mcp_pgsrv_pg_execute_sql"),
      call("b", "file_read"),
      call("c", "mcp_pgsrv_pg_list_tables"),
    ]);

    expect(runs.map((run) => run.map((c) => c.id))).toEqual([["a"], ["b"], ["c"]]);
  });

  it("keeps a call whose server left the config out of its neighbour's lane", () => {
    // Two different vendors under one header would be a lie, and an unresolved
    // name cannot be split into server and tool.
    const runs = groupToolRuns([
      call("a", "mcp_gone_one_thing"),
      call("b", "mcp_gone_other_thing"),
    ]);

    expect(runs).toHaveLength(2);
    expect(mcpServerIdForCard(runs[0][0])).not.toBe(mcpServerIdForCard(runs[1][0]));
  });

  it("leaves a native tool alone", () => {
    expect(mcpServerIdForCard(call("a", "file_read"))).toBeNull();
  });
});

describe("the operation, as words", () => {
  it("drops the segment every tool on that server shares", () => {
    // The whole catalog is `pg_*`, so `pg` separates nothing inside the lane.
    expect(mcpOperationLabel("mcp_pgsrv_pg_execute_sql")).toBe("Execute SQL");
    expect(mcpOperationLabel("mcp_pgsrv_pg_manage_transaction")).toBe("Manage transaction");
  });

  it("keeps names whole when the catalog shares no prefix", () => {
    expect(mcpOperationLabel("mcp_probe_dump_tree")).toBe("Dump tree");
  });

  it("sentence-cases rather than title-cases", () => {
    expect(mcpOperationLabel("mcp_aws_aws___run_script")).toBe("Run script");
  });

  it("returns the raw identifier when the server is gone", () => {
    expect(mcpOperationLabel("mcp_gone_some_tool")).toBe("gone_some_tool");
  });
});

describe("the lane", () => {
  it("names the server once, not once per call", () => {
    const html = renderToStaticMarkup(
      <McpServerLane
        calls={[
          call("a", "mcp_pgsrv_pg_execute_sql", { result: '{"ok":true}' }),
          call("b", "mcp_pgsrv_pg_list_tables", { result: '{"ok":true}' }),
        ]}
      />,
    );

    expect(html.split("aurora_labs_postgres_mcp").length - 1).toBe(2); // text + title attr
    expect(html).toContain("2 calls");
    expect(html).toContain("Execute SQL");
    expect(html).toContain("List tables");
  });

  it("says a remote server left this machine", async () => {
    const html = await mount(
      <McpServerLane calls={[call("a", "mcp_aws_aws___run_script", { result: "{}" })]} />,
    );

    expect(html).toContain("remote, left this machine");
    expect(html).toContain("1 call");
  });

  it("says a stdio server did not", async () => {
    const html = await mount(
      <McpServerLane calls={[call("a", "mcp_pgsrv_pg_execute_sql", { result: "{}" })]} />,
    );

    expect(html).toContain("stdio, on this machine");
  });

  it("reports the result's own top-level fields, not the word Completed", () => {
    const html = renderToStaticMarkup(
      <McpServerLane
        calls={[
          call("a", "mcp_pgsrv_pg_execute_sql", {
            result: '{"ok":true,"command_tag":"GRANT","affected_rows":null,"execution_time_ms":521.58}',
          }),
        ]}
      />,
    );

    expect(html).toContain("ok · GRANT · 522 ms");
    expect(html).not.toContain("Completed");
  });

  it("describes a non-JSON result by shape instead of quoting its first line", () => {
    const html = renderToStaticMarkup(
      <McpServerLane
        calls={[call("a", "mcp_probe_dump_tree", { result: "line one\nline two\nline three" })]}
      />,
    );

    expect(html).toContain("text · 3 lines");
  });

  it("bounds a long run so one lane cannot fill the message", () => {
    const calls = Array.from({ length: 7 }, (_, index) =>
      call(`c${index}`, "mcp_pgsrv_pg_list_tables", { result: "{}" }),
    );
    const html = renderToStaticMarkup(<McpServerLane calls={calls} />);

    expect(html).toContain('data-scroll=""');
  });

  it("leaves a short run unbounded, so an open card is not trapped behind a scrollbar", () => {
    const html = renderToStaticMarkup(
      <McpServerLane calls={[call("a", "mcp_pgsrv_pg_list_tables", { result: "{}" })]} />,
    );

    expect(html).not.toContain("data-scroll");
  });
});
