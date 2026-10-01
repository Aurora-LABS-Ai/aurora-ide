import { describe, expect, it } from "vitest";

import {
  DIRECTORY,
  commandForPlatform,
  isInstalled,
  searchDirectory,
  seedNote,
  templateConfig,
} from "./directory";

describe("the Add directory", () => {
  it("has unique ids and every entry can actually be started", () => {
    const ids = DIRECTORY.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of DIRECTORY) {
      expect(entry.mark.length).toBeGreaterThan(0);
      expect(entry.mark.length).toBeLessThanOrEqual(2);
      expect(entry.blurb.split(" ").length).toBeLessThanOrEqual(12);
      if (entry.transport === "stdio") {
        expect(entry.command, entry.id).toBeTruthy();
        expect(entry.url, entry.id).toBeUndefined();
      } else {
        expect(entry.url, entry.id).toMatch(/^https:\/\//);
        expect(entry.command, entry.id).toBeUndefined();
      }
    }
  });

  it("declares a need for every placeholder it leaves in the config", () => {
    for (const entry of DIRECTORY) {
      const text = [
        ...(entry.args ?? []),
        ...Object.values(entry.env ?? {}),
        ...Object.values(entry.headers ?? {}),
      ].join(" ");
      const placeholders = [...text.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]);
      expect(new Set(placeholders), entry.id).toEqual(new Set(entry.needs.map((n) => n.key)));
    }
  });
});

describe("templateConfig", () => {
  it("writes npx as npx.cmd on Windows and leaves it alone elsewhere", () => {
    expect(commandForPlatform("npx", "Win32")).toBe("npx.cmd");
    expect(commandForPlatform("npx", "MacIntel")).toBe("npx");
    expect(commandForPlatform("uvx", "Win32")).toBe("uvx");
    const github = DIRECTORY.find((entry) => entry.id === "github")!;
    expect(templateConfig(github, "Win32").command).toBe("npx.cmd");
    expect(templateConfig(github, "Linux x86_64").command).toBe("npx");
  });

  it("keeps the placeholders visible so the form shows what to fill", () => {
    const github = DIRECTORY.find((entry) => entry.id === "github")!;
    const config = templateConfig(github, "Win32");
    expect(config.env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("{{GITHUB_PERSONAL_ACCESS_TOKEN}}");
    expect(config.enabled).toBe(true);
    expect(config.autoStart).toBe(false);
  });
});

describe("isInstalled", () => {
  const entry = (id: string) => DIRECTORY.find((e) => e.id === id)!;

  it("recognises a package by its name anywhere in the command line, and a remote by its host", () => {
    const servers = [
      { command: "npx.cmd", args: ["-y", "@playwright/mcp@latest"], url: undefined },
      { command: "cmd", args: ["/c", "npx", "-y", "mcp-remote", "https://mcp.linear.app/sse"], url: undefined },
      { command: undefined, args: [], url: "https://docs.mcp.cloudflare.com/mcp" },
    ];
    expect(isInstalled(entry("playwright"), servers)).toBe(true);
    expect(isInstalled(entry("linear"), servers)).toBe(true);
    expect(isInstalled(entry("cloudflare-docs"), servers)).toBe(true);
    expect(isInstalled(entry("github"), servers)).toBe(false);
  });
});

describe("seedNote", () => {
  it("names each placeholder and what fills it, or says there is nothing to fill", () => {
    const slack = DIRECTORY.find((e) => e.id === "slack")!;
    expect(seedNote(slack)).toBe(
      "Replace {{SLACK_BOT_TOKEN}} with a Slack bot token (xoxb-…), and {{SLACK_TEAM_ID}} with the Slack team id (T…). Docs: https://www.npmjs.com/package/@modelcontextprotocol/server-slack",
    );
    const playwright = DIRECTORY.find((e) => e.id === "playwright")!;
    expect(seedNote(playwright)).toBe("Nothing to fill in. Docs: https://github.com/microsoft/playwright-mcp");
    const hf = DIRECTORY.find((e) => e.id === "huggingface")!;
    expect(seedNote(hf)).toContain("(optional)");
  });
});

describe("searchDirectory", () => {
  it("matches name, blurb or id, case-insensitively, and returns all for an empty query", () => {
    expect(searchDirectory("").length).toBe(DIRECTORY.length);
    expect(searchDirectory("BROWSER").map((e) => e.id)).toContain("playwright");
    expect(searchDirectory("brave").map((e) => e.id)).toEqual(["brave-search"]);
  });
});
