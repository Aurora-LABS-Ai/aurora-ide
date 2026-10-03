import { describe, expect, it } from "vitest";

import { AGW_DURATION, AGW_EASE } from "@/apps/agent/theme/motion";
// @ts-expect-error The app intentionally omits Node typings; Vitest itself runs in Node.
import { readFileSync } from "node:fs";

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
