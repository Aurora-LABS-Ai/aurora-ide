import { describe, expect, it } from "vitest";
// @ts-expect-error The app intentionally omits Node typings; Vitest itself runs in Node.
import { existsSync } from "node:fs";

import {
  shellBrandAsset,
  shellFallbackIcon,
} from "@/apps/agent/components/tool-views/shell-icon";
import { shellMeta } from "@/apps/agent/components/tool-views/shell-meta";

const cwd = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd();

describe("shell badge marks", () => {
  it("uses the pack the user chose, not a pack of its own", () => {
    // Picking one here would let the transcript disagree with the file tree.
    expect(shellBrandAsset("posix", "material")).toContain("/material-icons/");
    expect(shellBrandAsset("posix", "vscode")).toContain("/vscode-icons/");
  });

  it("falls back when the active pack has no mark for a family", () => {
    // This is the ordinary path, not an edge case: Material ships no cmd icon,
    // so on the DEFAULT pack one of the three families always draws its own.
    expect(shellBrandAsset("cmd", "material")).toBeNull();
    expect(shellBrandAsset("cmd", "vscode")).not.toBeNull();
  });

  it("falls back for a custom pack, which cannot be assumed to contain anything", () => {
    expect(shellBrandAsset("posix", "my-imported-pack")).toBeNull();
    expect(shellBrandAsset("powershell", null)).toBeNull();
  });

  it("gives every family a drawn mark, including one it does not recognise", () => {
    expect(shellFallbackIcon("posix")).toBe("shell-posix");
    expect(shellFallbackIcon("powershell")).toBe("shell-pwsh");
    expect(shellFallbackIcon("cmd")).toBe("shell-cmd");
    // An unknown shell id is still a shell; a terminal is the honest picture.
    expect(shellFallbackIcon("other")).toBe("shell-posix");
  });

  it("covers every family `shellMeta` can produce", () => {
    // The two tables are written by hand and drift silently: a family with no
    // arm here renders nothing at all in the badge.
    const families = ["bash", "sh", "zsh", "pwsh", "powershell", "cmd", "fish"].map(
      (id) => shellMeta(id)?.family,
    );
    for (const family of families) {
      expect(family).toBeDefined();
      expect(shellFallbackIcon(family!)).toMatch(/^shell-/);
    }
  });

  it("points every brand asset at a file that is actually on disk", () => {
    // The shape check alone would pass a typo. These are files under `public/`,
    // served by path, so a wrong name is a 404 that shows up only as a broken
    // image in a shipped transcript — the `onError` swap hides it, which means
    // nothing would ever report it. This is the check that does.
    const packs = ["material", "vscode"] as const;
    const families = ["posix", "powershell", "cmd"] as const;
    let checked = 0;

    for (const pack of packs) {
      for (const family of families) {
        const asset = shellBrandAsset(family, pack);
        if (asset === null) continue;
        expect(asset).toMatch(/^\/(material-icons|vscode-icons)\/[a-z0-9-]+\.svg$/);
        expect(
          existsSync(`${cwd}/public${asset}`),
          `${pack}/${family} points at ${asset}, which does not exist`,
        ).toBe(true);
        checked += 1;
      }
    }

    // Guards the loop itself: a table that resolved to nothing would make every
    // assertion above vacuous.
    expect(checked).toBe(5);
  });
});
