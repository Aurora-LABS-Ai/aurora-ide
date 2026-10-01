/**
 * Agent Window — the Add directory on the Plugins page.
 *
 * Aurora has no marketplace. What it can honestly offer is a short list of
 * well-known, public MCP servers with their setup already written: pressing +
 * fills the add form with the command, and the user supplies the key. Every
 * entry here is a published package or a public endpoint; nothing is hosted
 * by Aurora and nothing is promised beyond what the package itself does.
 *
 * Servers whose only sign-in is OAuth in a browser (Linear, Sentry, Figma)
 * are reached through `mcp-remote`, which runs the browser sign-in and speaks
 * stdio to Aurora — the one transport every MCP client already supports.
 *
 * `{{KEY}}` in an argument, environment value or header is a value the user
 * must fill in; `needs` names each one so the form can say so up front.
 */

import type { McpServerConfig, McpTransportType } from "@/apps/agent/store/tools/useMcpStore";

export type DirectoryCategory = "popular" | "developer" | "data" | "work";

export const DIRECTORY_CATEGORY_LABEL: Record<DirectoryCategory, string> = {
  popular: "Popular",
  developer: "Developer tools",
  data: "Data & docs",
  work: "Work",
};

export interface DirectoryNeed {
  /** The `{{KEY}}` placeholder this fills. */
  key: string;
  /** What to ask for, in the user's words. */
  label: string;
  /** Leave empty and the server still starts (a token that only lifts a limit). */
  optional?: boolean;
}

export interface DirectoryEntry {
  id: string;
  name: string;
  /** Two letters for the tile when there is no logo. */
  mark: string;
  /** One line, under twelve words. */
  blurb: string;
  category: DirectoryCategory;
  transport: McpTransportType;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  needs: DirectoryNeed[];
  /** How an installed row is recognised as this entry. */
  match: { packageName?: string; urlHost?: string };
  docs: string;
}

const npx = (...args: string[]) => ({ command: "npx", args: ["-y", ...args] });
const uvx = (...args: string[]) => ({ command: "uvx", args });
const remote = (url: string) => npx("mcp-remote", url);

export const DIRECTORY: readonly DirectoryEntry[] = [
  // ── Popular ──────────────────────────────────────────────────────────
  {
    id: "github",
    name: "GitHub",
    mark: "GH",
    blurb: "Issues, pull requests, files and search",
    category: "popular",
    transport: "stdio",
    ...npx("@modelcontextprotocol/server-github"),
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "{{GITHUB_PERSONAL_ACCESS_TOKEN}}" },
    needs: [{ key: "GITHUB_PERSONAL_ACCESS_TOKEN", label: "a GitHub personal access token" }],
    match: { packageName: "@modelcontextprotocol/server-github" },
    docs: "https://www.npmjs.com/package/@modelcontextprotocol/server-github",
  },
  {
    id: "playwright",
    name: "Playwright",
    mark: "PW",
    blurb: "Drive a real browser: navigate, click, read",
    category: "popular",
    transport: "stdio",
    ...npx("@playwright/mcp@latest"),
    needs: [],
    match: { packageName: "@playwright/mcp" },
    docs: "https://github.com/microsoft/playwright-mcp",
  },
  {
    id: "filesystem",
    name: "Filesystem",
    mark: "FS",
    blurb: "Read and write inside folders you choose",
    category: "popular",
    transport: "stdio",
    ...npx("@modelcontextprotocol/server-filesystem", "{{FOLDER}}"),
    needs: [{ key: "FOLDER", label: "the folder the server may touch" }],
    match: { packageName: "@modelcontextprotocol/server-filesystem" },
    docs: "https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem",
  },
  {
    id: "context7",
    name: "Context7",
    mark: "C7",
    blurb: "Current documentation for any library",
    category: "popular",
    transport: "stdio",
    ...npx("@upstash/context7-mcp"),
    needs: [],
    match: { packageName: "@upstash/context7-mcp" },
    docs: "https://github.com/upstash/context7",
  },
  {
    id: "postgres",
    name: "Postgres",
    mark: "PG",
    blurb: "Query and inspect a PostgreSQL database",
    category: "popular",
    transport: "stdio",
    ...npx("@modelcontextprotocol/server-postgres", "{{CONNECTION_STRING}}"),
    needs: [{ key: "CONNECTION_STRING", label: "the postgres:// connection string" }],
    match: { packageName: "@modelcontextprotocol/server-postgres" },
    docs: "https://www.npmjs.com/package/@modelcontextprotocol/server-postgres",
  },
  {
    id: "supabase",
    name: "Supabase",
    mark: "SB",
    blurb: "Manage and query your Supabase projects",
    category: "popular",
    transport: "stdio",
    ...npx("@supabase/mcp-server-supabase@latest", "--access-token", "{{SUPABASE_ACCESS_TOKEN}}"),
    needs: [{ key: "SUPABASE_ACCESS_TOKEN", label: "a Supabase personal access token" }],
    match: { packageName: "@supabase/mcp-server-supabase" },
    docs: "https://github.com/supabase-community/supabase-mcp",
  },

  // ── Developer tools ─────────────────────────────────────────────────
  {
    id: "git",
    name: "Git",
    mark: "GT",
    blurb: "Log, diff, blame and status of local repos (needs uv)",
    category: "developer",
    transport: "stdio",
    ...uvx("mcp-server-git"),
    needs: [],
    match: { packageName: "mcp-server-git" },
    docs: "https://pypi.org/project/mcp-server-git/",
  },
  {
    id: "sentry",
    name: "Sentry",
    mark: "SE",
    blurb: "Errors and releases; signs in through your browser",
    category: "developer",
    transport: "stdio",
    ...remote("https://mcp.sentry.dev/mcp"),
    needs: [],
    match: { urlHost: "mcp.sentry.dev" },
    docs: "https://docs.sentry.io/product/sentry-mcp/",
  },
  {
    id: "linear",
    name: "Linear",
    mark: "LN",
    blurb: "Issues and projects; signs in through your browser",
    category: "developer",
    transport: "stdio",
    ...remote("https://mcp.linear.app/sse"),
    needs: [],
    match: { urlHost: "mcp.linear.app" },
    docs: "https://linear.app/docs/mcp",
  },
  {
    id: "figma",
    name: "Figma",
    mark: "FG",
    blurb: "Read designs and components; signs in through your browser",
    category: "developer",
    transport: "stdio",
    ...remote("https://mcp.figma.com/mcp"),
    needs: [],
    match: { urlHost: "mcp.figma.com" },
    docs: "https://help.figma.com/hc/en-us/articles/32132100833559",
  },
  {
    id: "memory",
    name: "Memory graph",
    mark: "MG",
    blurb: "A knowledge graph the agent can add to and recall",
    category: "developer",
    transport: "stdio",
    ...npx("@modelcontextprotocol/server-memory"),
    needs: [],
    match: { packageName: "@modelcontextprotocol/server-memory" },
    docs: "https://www.npmjs.com/package/@modelcontextprotocol/server-memory",
  },
  {
    id: "sequential-thinking",
    name: "Sequential thinking",
    mark: "ST",
    blurb: "Step-by-step reasoning scratchpad as a tool",
    category: "developer",
    transport: "stdio",
    ...npx("@modelcontextprotocol/server-sequential-thinking"),
    needs: [],
    match: { packageName: "@modelcontextprotocol/server-sequential-thinking" },
    docs: "https://www.npmjs.com/package/@modelcontextprotocol/server-sequential-thinking",
  },
  {
    id: "cloudflare-docs",
    name: "Cloudflare docs",
    mark: "CF",
    blurb: "Search Cloudflare's documentation",
    category: "developer",
    transport: "http",
    url: "https://docs.mcp.cloudflare.com/mcp",
    needs: [],
    match: { urlHost: "docs.mcp.cloudflare.com" },
    docs: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
  },

  // ── Data & docs ─────────────────────────────────────────────────────
  {
    id: "notion",
    name: "Notion",
    mark: "N",
    blurb: "Pages and databases in your workspace",
    category: "data",
    transport: "stdio",
    ...npx("@notionhq/notion-mcp-server"),
    env: {
      OPENAPI_MCP_HEADERS:
        '{"Authorization":"Bearer {{NOTION_TOKEN}}","Notion-Version":"2022-06-28"}',
    },
    needs: [{ key: "NOTION_TOKEN", label: "a Notion internal integration token" }],
    match: { packageName: "@notionhq/notion-mcp-server" },
    docs: "https://github.com/makenotion/notion-mcp-server",
  },
  {
    id: "brave-search",
    name: "Brave Search",
    mark: "BR",
    blurb: "Web search for the agent",
    category: "data",
    transport: "stdio",
    ...npx("@modelcontextprotocol/server-brave-search"),
    env: { BRAVE_API_KEY: "{{BRAVE_API_KEY}}" },
    needs: [{ key: "BRAVE_API_KEY", label: "a Brave Search API key" }],
    match: { packageName: "@modelcontextprotocol/server-brave-search" },
    docs: "https://www.npmjs.com/package/@modelcontextprotocol/server-brave-search",
  },
  {
    id: "fetch",
    name: "Fetch",
    mark: "FE",
    blurb: "Read a web page as text (needs uv)",
    category: "data",
    transport: "stdio",
    ...uvx("mcp-server-fetch"),
    needs: [],
    match: { packageName: "mcp-server-fetch" },
    docs: "https://pypi.org/project/mcp-server-fetch/",
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    mark: "HF",
    blurb: "Models, datasets and Spaces",
    category: "data",
    transport: "http",
    url: "https://huggingface.co/mcp",
    headers: { Authorization: "Bearer {{HF_TOKEN}}" },
    needs: [{ key: "HF_TOKEN", label: "a Hugging Face token", optional: true }],
    match: { urlHost: "huggingface.co" },
    docs: "https://huggingface.co/settings/mcp",
  },

  // ── Work ────────────────────────────────────────────────────────────
  {
    id: "slack",
    name: "Slack",
    mark: "SL",
    blurb: "Read channels and post messages",
    category: "work",
    transport: "stdio",
    ...npx("@modelcontextprotocol/server-slack"),
    env: { SLACK_BOT_TOKEN: "{{SLACK_BOT_TOKEN}}", SLACK_TEAM_ID: "{{SLACK_TEAM_ID}}" },
    needs: [
      { key: "SLACK_BOT_TOKEN", label: "a Slack bot token (xoxb-…)" },
      { key: "SLACK_TEAM_ID", label: "the Slack team id (T…)" },
    ],
    match: { packageName: "@modelcontextprotocol/server-slack" },
    docs: "https://www.npmjs.com/package/@modelcontextprotocol/server-slack",
  },
  {
    id: "stripe",
    name: "Stripe",
    mark: "ST",
    blurb: "Customers, payments and products",
    category: "work",
    transport: "stdio",
    ...npx("@stripe/mcp", "--tools=all", "--api-key={{STRIPE_SECRET_KEY}}"),
    needs: [{ key: "STRIPE_SECRET_KEY", label: "a Stripe secret key" }],
    match: { packageName: "@stripe/mcp" },
    docs: "https://docs.stripe.com/mcp",
  },
];

/** `npx` is `npx.cmd` on Windows; a bare `npx` does not spawn from a Rust process there. */
export function commandForPlatform(command: string, platform: string): string {
  const windows = /^win/i.test(platform);
  return windows && command === "npx" ? "npx.cmd" : command;
}

/**
 * The server config an entry turns into, with its placeholders left visible
 * (`{{KEY}}`) so the form shows exactly what still has to be filled in.
 */
export function templateConfig(
  entry: DirectoryEntry,
  platform: string = typeof navigator === "undefined" ? "" : navigator.platform,
): Omit<McpServerConfig, "id"> {
  return {
    name: entry.id,
    transport: entry.transport,
    command: entry.command ? commandForPlatform(entry.command, platform) : undefined,
    args: entry.args ?? [],
    url: entry.url,
    env: entry.env ?? {},
    headers: entry.headers ?? {},
    enabled: true,
    autoStart: false,
    autoApprove: true,
  };
}

/** Whether one of the user's servers is this directory entry, by package or host. */
export function isInstalled(
  entry: DirectoryEntry,
  servers: readonly Pick<McpServerConfig, "command" | "args" | "url">[],
): boolean {
  return servers.some((server) => {
    if (entry.match.packageName) {
      const text = [server.command ?? "", ...server.args].join(" ");
      if (text.includes(entry.match.packageName)) return true;
    }
    if (entry.match.urlHost) {
      const haystack = [server.url ?? "", ...server.args].join(" ");
      if (haystack.includes(entry.match.urlHost)) return true;
    }
    return false;
  });
}

/** The add form's note for an entry: what to fill in, and where to read more. */
export function seedNote(entry: DirectoryEntry): string {
  if (entry.needs.length === 0) return `Nothing to fill in. Docs: ${entry.docs}`;
  const parts = entry.needs.map(
    (need) => `{{${need.key}}} with ${need.label}${need.optional ? " (optional)" : ""}`,
  );
  return `Replace ${parts.join(", and ")}. Docs: ${entry.docs}`;
}

/** Entries whose name or blurb mention the query; everything when it is empty. */
export function searchDirectory(query: string): DirectoryEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...DIRECTORY];
  return DIRECTORY.filter(
    (entry) =>
      entry.name.toLowerCase().includes(q) ||
      entry.blurb.toLowerCase().includes(q) ||
      entry.id.includes(q),
  );
}
