import { describe, expect, it } from "vitest";

import {
  buildCanvasDocument,
  CanvasCompileError,
  compileCanvasSource,
} from "./canvas-react";

describe("compileCanvasSource", () => {
  it("compiles a component and emits a default export the sandbox can find", async () => {
    const { code } = await compileCanvasSource(
      `export default function Report() {
         return <div>Fine</div>;
       }`,
    );
    expect(code).toContain("React.createElement");
    expect(code).toMatch(/exports\.default|"default"/);
  });

  it("does NOT yet catch type errors — the documented limit, asserted so it stays honest", async () => {
    // This is a `transpileModule` gate: syntax, imports, and the default
    // export. A type error still compiles. The tool description and
    // `canvas_guidelines` both say so; if semantic checking is added, this
    // test fails and those two must be updated in the same change.
    await expect(
      compileCanvasSource(
        `const total: number = "not a number";
         export default function Report() { return <div>{total}</div>; }`,
      ),
    ).resolves.toBeDefined();
  });

  it("rejects a syntax error with a positioned diagnostic", async () => {
    const failure = (await compileCanvasSource(
      `export default function Report( { return <div>; }`,
    ).catch((error: unknown) => error)) as CanvasCompileError;

    expect(failure).toBeInstanceOf(CanvasCompileError);
    expect(failure.diagnostics.length).toBeGreaterThan(0);
    expect(failure.message).toContain("canvas.tsx:");
  });

  it("names the allowed modules when an import is not one of them", async () => {
    const failure = (await compileCanvasSource(
      `import { format } from "date-fns";
       export default function Report() { return <div>{format}</div>; }`,
    ).catch((error: unknown) => error)) as CanvasCompileError;

    expect(failure).toBeInstanceOf(CanvasCompileError);
    expect(failure.message).toContain('Cannot import "date-fns"');
    expect(failure.message).toContain('"aurora/canvas"');
    // The offending line, not line 1 — the model has to know where to look.
    expect(failure.diagnostics[0].line).toBe(1);
  });

  it("allows react and the reserved canvas surface", async () => {
    await expect(
      compileCanvasSource(
        `import React from "react";
         import {} from "aurora/canvas";
         export default function Report() { return React.createElement("div"); }`,
      ),
    ).resolves.toBeDefined();
  });

  it("refuses source with no default export", async () => {
    const failure = (await compileCanvasSource(
      `export function Report() { return <div>Orphan</div>; }`,
    ).catch((error: unknown) => error)) as CanvasCompileError;

    expect(failure).toBeInstanceOf(CanvasCompileError);
    expect(failure.message).toContain("default-export");
  });
});

describe("buildCanvasDocument", () => {
  const build = (code: string) =>
    buildCanvasDocument(
      { code },
      {
        runtime: "/* react */",
        cssVariables: { "--agw-text": "#ededed", "--agw-conversation": "#111" },
        title: "Cost review",
      },
    );

  it("blocks the network in policy, not merely by convention", () => {
    // A sandboxed iframe can still reach the network; only the CSP stops it.
    // "no fetch" is a rule the guide states, and this is what enforces it.
    const document = build("exports.default = function () {};");
    expect(document).toContain("default-src 'none'");
    expect(document).not.toContain("connect-src");
  });

  it("styles its own scrollbars, because no window rule reaches inside a frame", () => {
    const document = build("exports.default = function () {};");
    expect(document).toContain("--agw-scroll-thumb");
    expect(document).toContain("::-webkit-scrollbar-thumb");
    expect(document).toContain("scrollbar-width:thin");
  });

  it("carries the window's own typeface in, because a frame inherits no @font-face", () => {
    // The failure this pins was silent: `font-family: "Inter Variable"` simply
    // did not resolve inside the frame — no rule, and a CSP that blocks
    // fetching one — so every canvas quietly rendered in Segoe UI beside an app
    // rendered in Inter.
    const document = buildCanvasDocument(
      { code: "exports.default = function () {};" },
      {
        runtime: "",
        fonts: '@font-face{font-family:"Inter Variable";src:url(data:font/woff2;base64,AA) format("woff2")}',
        cssVariables: {},
        title: "t",
      },
    );
    expect(document).toContain("@font-face");
    expect(document).toContain("Inter Variable");
    // data: is the only font source the CSP allows, so it must be the one used.
    expect(document).toContain("url(data:font/woff2");
    expect(document).toContain("font-src data:");
  });

  it("carries the window's live theme tokens into the frame", () => {
    const document = build("exports.default = function () {};");
    expect(document).toContain("--agw-text:#ededed;");
    expect(document).toContain("--agw-conversation:#111;");
  });

  it("cannot be broken out of by canvas source containing a closing script tag", () => {
    const document = build('exports.default = function () { return "</script><script>alert(1)"; };');
    expect(document).not.toContain("</script><script>alert(1)");
    expect(document).toContain("<\\/script>");
  });

  it("escapes the title rather than injecting it as markup", () => {
    const document = buildCanvasDocument(
      { code: "exports.default = function () {};" },
      {
        runtime: "",
        cssVariables: {},
        title: '"><img src=x onerror=alert(1)>',
      },
    );
    expect(document).not.toContain("<img src=x");
    expect(document).toContain("&quot;&gt;&lt;img");
  });
});

describe("component imports are checked against the real SDK surface", () => {
  it("accepts every component aurora/canvas actually exports", async () => {
    const { CANVAS_EXPORTS } = await import("virtual:aurora-canvas-exports");
    const named = CANVAS_EXPORTS.join(", ");
    await expect(
      compileCanvasSource(
        `import { ${named} } from "aurora/canvas";
         export default function R() { return <div>{String([${named}].length)}</div>; }`,
      ),
    ).resolves.toBeDefined();
  });

  it("rejects a component that does not exist, at its own line", async () => {
    const failure = (await compileCanvasSource(
      `import { Section } from "aurora/canvas";
       import { PieChart } from "aurora/canvas";
       export default function R() { return <Section><PieChart /></Section>; }`,
    ).catch((error: unknown) => error)) as CanvasCompileError;

    expect(failure).toBeInstanceOf(CanvasCompileError);
    expect(failure.diagnostics).toHaveLength(1);
    expect(failure.diagnostics[0].line).toBe(2);
    expect(failure.message).toContain('"PieChart" is not exported');
  });

  it("answers `Card` with the shape to use instead, not just a list", async () => {
    // Reaching for Card is the single most likely mistake, because every other
    // component library has one. The error has to teach the alternative.
    const failure = (await compileCanvasSource(
      `import { Card } from "aurora/canvas";
       export default function R() { return <Card />; }`,
    ).catch((error: unknown) => error)) as CanvasCompileError;

    expect(failure.message).toContain("There is no Card");
    expect(failure.message).toContain("List + Row");
  });
});
