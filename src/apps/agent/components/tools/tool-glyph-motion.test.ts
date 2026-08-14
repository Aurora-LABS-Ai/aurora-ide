/**
 * The live tool mark — coverage, not appearance.
 *
 * A running tool animates its OWN glyph instead of a generic spinner. Two
 * halves have to stay in step across three files, and none of them import each
 * other: AgentIcon tags the working element with `data-part`, ToolCallCard
 * mounts the scan copy, and 33-tool-glyph-motion.css owns the timing. These
 * tests read the sources so a tool added later cannot quietly ship with a dead
 * mark, and a part name cannot be invented without a rule to animate it.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error The app intentionally omits Node typings; Vitest itself runs in Node.
import { readFileSync } from "node:fs";

const cwd = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd();
const iconSource = readFileSync(`${cwd}/src/apps/agent/shared/AgentIcon.tsx`, "utf8");
const cardSource = readFileSync(
  `${cwd}/src/apps/agent/components/tools/ToolCallCard.tsx`,
  "utf8",
);
const motionCss = readFileSync(
  `${cwd}/src/apps/agent/theme/agent-window/33-tool-glyph-motion.css`,
  "utf8",
);
/** The declarations alone. The comments in that file NAME the things they rule
 *  out ("deliberately NOT @media (prefers-reduced-motion)"), so a rule check
 *  run over the raw text would read the prohibition as the offence. */
const motionRules = motionCss.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Marks with nothing to nominate: one indivisible shape, where tagging the only
 * path would just animate the whole glyph. They ride the scan alone, which is
 * exactly the fallback every MCP tool gets. Keep this list SHORT and honest —
 * a test below fails if an entry here actually does have a part.
 */
const SCAN_ONLY = new Set(["files"]);

/** Every icon name `toolIcon()` can hand back. */
function toolIconTargets(): string[] {
  const body = cardSource.match(
    /function toolIcon\(name: string\): AgentIconName \{([\s\S]*?)\n\}/,
  )?.[1];
  expect(body, "toolIcon() not found in ToolCallCard").toBeTruthy();
  return [...new Set([...(body ?? "").matchAll(/return "([a-z-]+)"/g)].map((m) => m[1]))];
}

/**
 * name -> that glyph's source. Entries in GLYPHS sit at exactly two spaces of
 * indent and their geometry at four or more, so the key boundary is
 * unambiguous without parsing TSX.
 */
function glyphChunks(): Map<string, string> {
  const table = iconSource.slice(iconSource.indexOf("const GLYPHS"));
  const chunks = new Map<string, string>();
  for (const chunk of table.split(/\n {2}(?=["a-z])/)) {
    const key = chunk.match(/^"?([a-z-]+)"?:/)?.[1];
    if (key) chunks.set(key, chunk);
  }
  return chunks;
}

describe("live tool marks", () => {
  it("gives every tool glyph a working part, or admits it has none", () => {
    const chunks = glyphChunks();
    for (const name of toolIconTargets()) {
      const glyph = chunks.get(name);
      expect(glyph, `${name} is returned by toolIcon() but has no glyph`).toBeTruthy();
      const hasPart = (glyph ?? "").includes("data-part=");
      if (SCAN_ONLY.has(name)) {
        expect(hasPart, `${name} is listed as scan-only but now has a part`).toBe(false);
      } else {
        expect(hasPart, `${name} has no data-part — it would sit still while running`).toBe(
          true,
        );
      }
    }
  });

  it("animates every part name the glyphs use", () => {
    const used = new Set(
      [...iconSource.matchAll(/data-part="([a-z-]+)"/g)].map((m) => m[1]),
    );
    const animated = new Set(
      [...motionCss.matchAll(/\[data-part="([a-z-]+)"\]/g)].map((m) => m[1]),
    );
    expect(used.size).toBeGreaterThan(0);
    for (const part of used) {
      expect(animated.has(part), `data-part="${part}" has no rule in the stylesheet`).toBe(
        true,
      );
    }
  });

  it("normalises every self-writing stroke so one dash rule fits all of them", () => {
    // `stroke-dasharray: 1` only means "the whole path" when pathLength says so;
    // without it a 3-unit text line and a 19-unit divider write at wildly
    // different speeds, and the short ones finish before the beat starts.
    for (const [, glyph] of glyphChunks()) {
      for (const element of glyph.match(/<[a-z]+[^>]*data-part="(?:line|tick)"[^>]*\/>/g) ??
        []) {
        expect(element, "a self-writing part is missing pathLength").toContain(
          "pathLength={1}",
        );
      }
    }
  });

  it("lets a moving part leave the glyph's own box", () => {
    // Without this the SVG clips its own animation: `search` is a centred
    // r=6.4 lens with 3.85 units of headroom, and the sweep sheared a flat cut
    // across the top of the magnifier every cycle.
    expect(motionRules).toMatch(/\.agw-tool-glyph svg \{[^}]*overflow:\s*visible/s);
  });

  it("keeps the motion colourless", () => {
    // The mark rests at text-muted and rises to text — the same two colours the
    // label shimmer beside it already uses. An accent would make the icon the
    // loudest thing in a row whose whole job is to be scannable.
    expect(motionRules).not.toMatch(/var\(--agw-accent/);
    expect(motionRules).not.toMatch(/var\(--agw-added|var\(--agw-removed/);
  });

  it("drops the spinner from the tool row and mounts the scan only while running", () => {
    const head = cardSource.slice(
      cardSource.indexOf('className="agw-tool-head"'),
      cardSource.indexOf("{chipTargets.length > 0 &&"),
    );
    expect(head).not.toContain("agw-spinner");
    expect(head).toContain('data-live={status === "running" ? "" : undefined}');
    expect(head).toContain("agw-tool-glyph-scan");
    // The Canvas launcher is a different card and keeps its own spinner.
    expect(cardSource.match(/agw-spinner/g)?.length).toBe(2);
  });

  it("takes reduce-motion from Aurora's own switch, never from the OS", () => {
    // The OS query is not a smaller version of this rule — it is a bug. This
    // window animates its transcript unconditionally (08-transcript-flow.css
    // records why), so on a machine that asks Windows for less motion — the
    // owner's does — a media query here switched the marks off while the label
    // shimmer 8px away kept running, and a running row had no live sign left.
    expect(motionRules).toContain("[data-reduce-motion]");
    expect(motionRules).not.toContain("@media (prefers-reduced-motion");
    // …and never the blanket kill that zeroed every transition in the window
    // the last time this was attempted.
    expect(motionRules).not.toMatch(/\.agw-root \*/);
  });
});
