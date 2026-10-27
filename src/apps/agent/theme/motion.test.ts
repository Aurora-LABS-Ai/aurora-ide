import { describe, expect, it } from "vitest";

import { AGW_DURATION, AGW_EASE } from "@/apps/agent/theme/motion";
// @ts-expect-error The app intentionally omits Node typings; Vitest itself runs in Node.
import { readdirSync, readFileSync } from "node:fs";

const cwd = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd();
const root: string = readFileSync(`${cwd}/src/apps/agent/theme/agent-window/01-root.css`, "utf8");

/** The value a custom property is declared with in 01-root.css. */
const declared = (name: string): string => {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(root);
  expect(match, `${name} is not declared in 01-root.css`).not.toBeNull();
  return (match?.[1] ?? "").trim();
};

describe("JS motion tokens", () => {
  it("match the CSS durations", () => {
    for (const [name, seconds] of Object.entries(AGW_DURATION)) {
      expect(declared(`--agw-dur-${name}`)).toBe(`${seconds}s`);
    }
  });

  it("match the CSS curves", () => {
    for (const [name, points] of Object.entries(AGW_EASE)) {
      expect(declared(`--agw-ease-${name}`)).toBe(`cubic-bezier(${points.join(", ")})`);
    }
  });
});

describe("stylesheet motion", () => {
  const dir = `${cwd}/src/apps/agent/theme/agent-window`;
  const partials: Array<{ file: string; css: string }> = (readdirSync(dir) as string[])
    .filter((file) => file.endsWith(".css"))
    .map((file) => ({ file, css: readFileSync(`${dir}/${file}`, "utf8") as string }));

  // A keyframe name is global: a second `@keyframes agw-pop-in` later in the
  // cascade silently replaced the first for every menu that used it.
  it("declares every keyframe name once", () => {
    const seen = new Map<string, string>();
    for (const { file, css } of partials) {
      for (const match of css.matchAll(/@keyframes\s+([\w-]+)/g)) {
        const name = match[1];
        expect(seen.get(name), `@keyframes ${name} in ${file} and ${seen.get(name)}`).toBeUndefined();
        seen.set(name, file);
      }
    }
  });

  // Menus open in one frame, and the JS-animated popovers that carry
  // `.agw-menu` (model picker, rail chips, checklist) must have one animator:
  // a CSS entrance on the shared class ran beside framer's and jolted them.
  it("gives the shared menu class no CSS entrance", () => {
    const shell = partials.find((p) => p.file === "02-shell.css")?.css ?? "";
    const rule = /\.agw-menu,\s*\.agw-ctx-card\s*\{([\s\S]*?)\n\}/.exec(shell);
    expect(rule, "the shared .agw-menu rule moved").not.toBeNull();
    expect(rule?.[1]).not.toMatch(/(^|\s)animation\s*:/);
  });
});
