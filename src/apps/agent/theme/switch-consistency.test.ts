/**
 * Every switch in the agent window turns on the same colour.
 *
 * This exists because they did not. A settings page drew a green switch, a blue
 * switch and a tan slider at once: `AgwSwitch` took a `tone` chosen per call
 * site and three of forty-five call sites passed `success`, while the composer's
 * own reasoning switch read the BRAND accent instead of the control accent and
 * would part company with the rest the moment a theme went neutral.
 *
 * Both checks read the real call sites rather than a list written here. A list
 * would guard the list: a forty-sixth switch, or a new one with its own class,
 * has to fail this on the day it is added, not on the day someone remembers to
 * come back and add it.
 */

import { describe, expect, it } from "vitest";

// @ts-expect-error The app intentionally omits Node typings; Vitest itself runs in Node.
import { readFileSync, readdirSync } from "node:fs";

const cwd = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd();
const agentDir = `${cwd}/src/apps/agent`;

/** Every `.tsx` under `src/apps/agent`, as one blob with its paths kept. */
function collectTsx(dir: string, out: { path: string; src: string }[] = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }) as {
    name: string;
    isDirectory: () => boolean;
  }[]) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) collectTsx(full, out);
    else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) {
      out.push({ path: full, src: readFileSync(full, "utf8") });
    }
  }
  return out;
}

const sources = collectTsx(agentDir);

/** Cascade order is directory order; for this check only the text matters. */
const css = (readdirSync(`${agentDir}/theme/agent-window`) as string[])
  .filter((name) => name.endsWith(".css"))
  .sort()
  .map((name) => readFileSync(`${agentDir}/theme/agent-window/${name}`, "utf8"))
  .join("\n");

describe("switch consistency", () => {
  it("gives no switch its own on-colour", () => {
    // The `tone` prop is gone. This catches it coming back by the route it
    // arrived the first time: one screen wanting to say something extra with
    // a hue, where the label beside the switch is the place to say it.
    const offenders = sources
      .filter(({ src }) => /<AgwSwitch\b[^>]*?\btone=/s.test(src))
      .map(({ path }) => path.slice(cwd.length + 1));
    expect(offenders).toEqual([]);
  });

  it("paints every switch's on state from the control accent", () => {
    // Collected from `role="switch"`, so this covers the shared primitive and
    // the control that is a switch without using it — the chat shortlist chip.
    // (The composer's own mini switch is gone: the model menu's Fast toggle is
    // the shared `AgwSwitch` now.)
    const classes = new Set<string>();
    for (const { src } of sources) {
      for (const match of src.matchAll(/role="switch"[\s\S]{0,400}?className="([^"{]+)"/g)) {
        const name = match[1].split(/\s+/).find((c) => c.startsWith("agw-"));
        if (name) classes.add(name);
      }
    }
    // A regex that silently matches nothing would make this test a no-op, and
    // it is the kind that passes forever after a refactor renames an attribute.
    expect(classes.size).toBeGreaterThanOrEqual(2);

    for (const name of classes) {
      // The element's OWN on-rule, not a descendant like the knob: the
      // `\s*\{` is what keeps `.agw-switch[data-on] .agw-switch-knob` out.
      const rule = new RegExp(`\\.${name}\\[data-on\\]\\s*\\{([^}]*)\\}`).exec(css);
      expect(rule, `${name} has no [data-on] rule of its own`).not.toBeNull();
      expect(rule?.[1], `${name} turns on in a colour of its own`).toContain(
        "--agw-control-accent",
      );
    }
  });
});
