/**
 * Agent Window — what is wrong with the installed MCP servers, read from the
 * configuration itself.
 *
 * A list of twenty rows hides its own problems: two rows that start the same
 * command, a row the importer named `mcp-1767509230024-…` because the pasted
 * JSON carried no name, a server that failed to start. Each is a one-line
 * fact about the config, so the page can say it on the tile and count them in
 * the header instead of leaving them for the user to notice eleven cards
 * apart.
 */

import type { McpServerState } from "@/apps/agent/store/tools/useMcpStore";

export type ServerIssueKind = "duplicate" | "unnamed" | "error";

export interface ServerIssue {
  serverId: string;
  kind: ServerIssueKind;
  /** One line for the tile. */
  message: string;
}

/** The importer's fallback name: `mcp-<13-digit time>-<9 base36 chars>`. */
const GENERATED_NAME = /^mcp-\d{13}-[a-z0-9]{9}$/;

/**
 * One spelling for a path or command word, so `E:/x/index.js` and
 * `E:\x\index.js` (and `Node` / `node`) compare equal: Windows treats them as
 * the same thing, and two rows the importer wrote from two different config
 * files were exactly this far apart.
 */
const normalizeWord = (word: string): string =>
  word.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** What a row actually runs, so two rows that differ only in name compare equal. */
function launchKey(server: McpServerState): string | null {
  const { config } = server;
  if (config.transport === "stdio") {
    const command = normalizeWord(config.command ?? "");
    if (!command) return null;
    return `stdio ${[command, ...config.args.map(normalizeWord)].filter(Boolean).join(" ")}`;
  }
  const url = normalizeWord(config.url ?? "");
  return url ? `${config.transport} ${url}` : null;
}

export function inspectServers(servers: readonly McpServerState[]): ServerIssue[] {
  const issues: ServerIssue[] = [];

  const byLaunch = new Map<string, McpServerState[]>();
  for (const server of servers) {
    const key = launchKey(server);
    if (!key) continue;
    const group = byLaunch.get(key) ?? [];
    group.push(server);
    byLaunch.set(key, group);
  }

  for (const server of servers) {
    const { config } = server;
    const key = launchKey(server);
    const twins = key ? (byLaunch.get(key) ?? []) : [];
    if (twins.length > 1) {
      const other = twins.find((twin) => twin.config.id !== config.id);
      issues.push({
        serverId: config.id,
        kind: "duplicate",
        message: other ? `Same command as ${other.config.name}` : "Same command twice",
      });
    }
    if (GENERATED_NAME.test(config.name) || config.name.trim() === "") {
      issues.push({ serverId: config.id, kind: "unnamed", message: "Needs a name" });
    }
    if (server.status === "error") {
      issues.push({
        serverId: config.id,
        kind: "error",
        message: server.error?.trim() ? firstLine(server.error) : "Could not start",
      });
    }
  }
  return issues;
}

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

/** The first issue per server, which is what a one-line tile can show. */
export function issueByServer(issues: readonly ServerIssue[]): Map<string, ServerIssue> {
  const map = new Map<string, ServerIssue>();
  for (const issue of issues) if (!map.has(issue.serverId)) map.set(issue.serverId, issue);
  return map;
}

/** The tile's one line: the problem if there is one, otherwise the state. */
export function tileLine(server: McpServerState, issue: ServerIssue | undefined): string {
  if (issue) return issue.message;
  const { config, status, tools } = server;
  if (!config.enabled) return "Disabled";
  if (status === "connected") {
    const count = `${tools.length} ${tools.length === 1 ? "tool" : "tools"}`;
    return config.autoStart ? `${count} · auto-start` : count;
  }
  if (status === "connecting") return "Connecting…";
  return config.autoStart ? "Not connected · auto-start" : "Not connected";
}

/** Two letters for a tile with no logo: initials of the first two words. */
export function markOf(name: string): string {
  const words = name
    .split(/[\s\-_./]+/)
    .map((word) => word.trim())
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
