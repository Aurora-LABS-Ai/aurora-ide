/**
 * Live canvases: compiling and sandboxing a `react` artifact.
 *
 * A `react` artifact is ONE component file the agent writes. Unlike every other
 * artifact kind — which we display as authored — this one is compiled and then
 * *run* beside the conversation, so it can have working controls instead of
 * being a picture of an interface.
 *
 * Two rules shape everything here:
 *
 * 1. **It must not be able to save something broken.** `compileCanvasSource`
 *    runs before the write, exactly as `validateMermaidSource` does, and a
 *    failure rejects the tool call with the compiler's own diagnostics so the
 *    model repairs its source instead of being told it succeeded.
 *
 *    What that covers today is precise, and the tool description must not
 *    overstate it: **syntax**, the **import allow-list**, and the **required
 *    default export**. It is `transpileModule`, so it does NOT yet catch type
 *    errors — `<Table colums={…}>` compiles and fails at run time, where the
 *    frame reports it back into the panel.
 *
 *    Full semantic checking needs a `ts.createProgram` over a virtual host
 *    carrying `lib.*.d.ts` plus React's types, and the natural moment to pay
 *    that cost is when `aurora/canvas` ships its own type definitions — the
 *    same declarations are what make checking worth anything. The compiler is
 *    already here and the seam is `diagnose()` below; nothing else changes.
 *    (This is also why the compile step is TypeScript rather than a Rust
 *    transform: `oxc`/`swc` strip types and could never grow into it.)
 *
 * 2. **It must not gain privileges the other kinds do not have.** Canvas code
 *    runs in the same sandboxed iframe html/svg artifacts already use — no
 *    same-origin access — plus a `default-src 'none'` CSP, which is what
 *    actually stops `fetch()`. (Sandboxing alone does not: a sandboxed frame
 *    can still reach the network.) Data belongs *in* the canvas.
 */

/** One compiler complaint, positioned in the agent's own source. */
export interface CanvasDiagnostic {
  line: number;
  column: number;
  message: string;
}

export class CanvasCompileError extends Error {
  readonly diagnostics: CanvasDiagnostic[];

  constructor(diagnostics: CanvasDiagnostic[]) {
    super(formatCanvasDiagnostics(diagnostics));
    this.name = "CanvasCompileError";
    this.diagnostics = diagnostics;
  }
}

/**
 * Compiler-style `file:line:col — message` lines, capped so a cascade of
 * downstream errors cannot flood the turn. The first few are always the real
 * ones.
 */
export const formatCanvasDiagnostics = (diagnostics: CanvasDiagnostic[]): string => {
  if (diagnostics.length === 0) return "The canvas could not be compiled.";
  const shown = diagnostics
    .slice(0, 8)
    .map((entry) => `canvas.tsx:${entry.line}:${entry.column} — ${entry.message}`);
  const hidden = diagnostics.length - shown.length;
  return hidden > 0 ? `${shown.join("\n")}\n…and ${hidden} more` : shown.join("\n");
};

type TypeScriptApi = typeof import("typescript");

let typescriptModule: Promise<TypeScriptApi> | null = null;

/**
 * The TypeScript compiler is large and only a canvas needs it, so it loads on
 * first use and stays cached — the same lazy shape `mermaid` uses.
 */
const loadTypeScript = (): Promise<TypeScriptApi> => {
  typescriptModule ??= import("typescript").then((module) => module.default ?? module);
  return typescriptModule;
};

/**
 * Modules a canvas is allowed to import. Anything else fails at compile time
 * with a message naming what IS available, rather than at run time as a blank
 * panel. `aurora/canvas` is reserved for the component surface and is not
 * populated yet — the shim exists so the import path is stable from v1.
 */
const CANVAS_MODULES = new Set(["react", "react-dom", "aurora/canvas"]);

/** Compiled output plus the imports it actually asked for. */
export interface CompiledCanvas {
  code: string;
}

export const compileCanvasSource = async (source: string): Promise<CompiledCanvas> => {
  const ts = await loadTypeScript();

  const output = ts.transpileModule(source, {
    fileName: "canvas.tsx",
    reportDiagnostics: true,
    compilerOptions: {
      jsx: ts.JsxEmit.React,
      target: ts.ScriptTarget.ES2020,
      // CommonJS, deliberately: it turns every `import` into a `require` call
      // the sandbox can intercept, which is how the allow-list below is
      // enforced at all. An ES module emit would need a real module resolver
      // inside the frame.
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      isolatedModules: true,
    },
  });

  const diagnostics = (output.diagnostics ?? []).map((diagnostic): CanvasDiagnostic => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
    if (diagnostic.file && typeof diagnostic.start === "number") {
      const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      return { line: line + 1, column: character + 1, message };
    }
    return { line: 1, column: 1, message };
  });
  if (diagnostics.length > 0) throw new CanvasCompileError(diagnostics);

  const imports = readRequiredModules(output.outputText);
  const unknown = imports.filter((id) => !CANVAS_MODULES.has(id));
  if (unknown.length > 0) {
    throw new CanvasCompileError(
      unknown.map((id) => ({
        line: findImportLine(source, id),
        column: 1,
        message: `Cannot import "${id}". A canvas is one self-contained file; only ${[...CANVAS_MODULES]
          .map((name) => `"${name}"`)
          .join(", ")} are available. Embed the data you need directly in the file.`,
      })),
    );
  }

  await checkCanvasImports(source, ts);

  if (!/exports\.default\s*=|exports\s*,\s*"default"/.test(output.outputText)) {
    throw new CanvasCompileError([
      {
        line: 1,
        column: 1,
        message:
          "A canvas must default-export its top-level component: `export default function MyCanvas() { … }`.",
      },
    ]);
  }

  return { code: output.outputText };
};

/**
 * Names a canvas asks for that `aurora/canvas` does not have.
 *
 * This is the one piece of real semantic checking the gate does today, and it
 * is the highest-value one: reaching for a component that does not exist is
 * the most likely way a canvas fails, and it fails at RUN time as a blank
 * panel. Catching it here turns that into a compile error naming the right
 * component instead.
 */
const CANVAS_SUBSTITUTIONS: Record<string, string> = {
  Card: "There is no Card — a column of identical cards is the shape this surface exists to avoid. Use Section for grouping and List + Row for items.",
  Panel: "There is no Panel. Use Section.",
  Grid: "There is no Grid. Use Stats for a row of figures, or Table for tabular data.",
  Chart: "There is no Chart yet. Present the numbers with Table or Stat.",
  Heading: "There is no Heading — Canvas and Section own the headings.",
  Button: "A canvas has no actions to submit; the only interaction is sorting a Table.",
};

const checkCanvasImports = async (source: string, ts: TypeScriptApi): Promise<void> => {
  const file = ts.createSourceFile(
    "canvas.tsx",
    source,
    ts.ScriptTarget.ES2020,
    true,
    ts.ScriptKind.TSX,
  );

  const requested: Array<{ name: string; line: number; column: number }> = [];
  file.statements.forEach((statement) => {
    if (!ts.isImportDeclaration(statement)) return;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier) || specifier.text !== "aurora/canvas") return;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return;
    bindings.elements.forEach((element) => {
      const { line, character } = file.getLineAndCharacterOfPosition(element.getStart(file));
      requested.push({
        name: (element.propertyName ?? element.name).text,
        line: line + 1,
        column: character + 1,
      });
    });
  });
  if (requested.length === 0) return;

  const { CANVAS_EXPORTS } = await import("virtual:aurora-canvas-exports");
  const available = new Set<string>(CANVAS_EXPORTS);
  const unknown = requested.filter((entry) => !available.has(entry.name));
  if (unknown.length === 0) return;

  throw new CanvasCompileError(
    unknown.map(({ name, line, column }) => ({
      line,
      column,
      message:
        `"${name}" is not exported by "aurora/canvas". ` +
        (CANVAS_SUBSTITUTIONS[name] ?? `Available: ${CANVAS_EXPORTS.join(", ")}.`),
    })),
  );
};

/** Module ids the emitted CommonJS actually requires. */
const readRequiredModules = (code: string): string[] => {
  const found = new Set<string>();
  const pattern = /require\(\s*["']([^"']+)["']\s*\)/g;
  let match = pattern.exec(code);
  while (match) {
    found.add(match[1]);
    match = pattern.exec(code);
  }
  return [...found];
};

/** Best-effort line for an offending import so the message points somewhere. */
const findImportLine = (source: string, moduleId: string): number => {
  const lines = source.split("\n");
  const index = lines.findIndex((line) => line.includes(`"${moduleId}"`) || line.includes(`'${moduleId}'`));
  return index >= 0 ? index + 1 : 1;
};

const escapeForScript = (code: string): string =>
  code.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");

const escapeAttribute = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Build the sandbox document for a compiled canvas.
 *
 * `runtime` is the React + ReactDOM UMD pair, passed in by the caller so this
 * module stays testable without pulling ~140 KB of vendor text into every test.
 */
export const buildCanvasDocument = (
  compiled: CompiledCanvas,
  options: {
    runtime: string;
    /** `aurora/canvas` component styles, injected with the components. */
    styles?: string;
    /**
     * `@font-face` rules with the font data inlined. Required for the window's
     * typeface to exist in here at all: a frame inherits no `@font-face` from
     * its parent, and the CSP permits only `data:` font sources.
     */
    fonts?: string;
    cssVariables: Record<string, string>;
    title: string;
  },
): string => {
  const variables = Object.entries(options.cssVariables)
    .map(([name, value]) => `${name}:${value};`)
    .join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<title>${escapeAttribute(options.title)}</title>
<style>${options.fonts ?? ""}</style>
<style>
:root{${variables}}
html,body{margin:0;background:var(--agw-conversation,#111);color:var(--agw-text,#ededed)}
body{font-family:var(--agw-font-ui,system-ui,sans-serif);font-size:13px;line-height:1.55;-webkit-font-smoothing:antialiased}
*,*::before,*::after{box-sizing:border-box}
#root{padding:20px}

/* Scrollbars. A canvas is its own document, so NOTHING the window styles
   reaches it — including \`.agw-root *\`, which exists precisely to stop stray
   containers from rendering unthemed bars. Without this the frame draws the
   platform's default chrome scrollbar against a dark themed panel, which is
   the single most obvious way a canvas reads as "not part of the app".
   Same tokens, same geometry as the window's own rule. */
html{scrollbar-width:thin;scrollbar-color:var(--agw-scroll-thumb,#80808033) transparent}
*::-webkit-scrollbar{width:10px;height:10px}
*::-webkit-scrollbar-track{background:transparent}
*::-webkit-scrollbar-thumb{background:var(--agw-scroll-thumb,#80808033);border-radius:var(--agw-radius-md,8px);border:2px solid transparent;background-clip:content-box}
*::-webkit-scrollbar-thumb:hover{background:var(--agw-scroll-thumb-hover,#80808066);background-clip:content-box}
*::-webkit-scrollbar-corner{background:transparent}
</style>
<style>${options.styles ?? ""}
.canvas-crash{margin:20px;padding:14px 16px;border:1px solid var(--agw-border-strong,#444);border-radius:8px;background:var(--agw-surface,#181818)}
.canvas-crash strong{display:block;margin-bottom:6px;font-size:13px}
.canvas-crash pre{margin:0;white-space:pre-wrap;font-family:var(--agw-font-code,ui-monospace,monospace);font-size:12px;color:var(--agw-text-muted,#9a9a9a)}
</style>
</head>
<body>
<div id="root"></div>
<script>${escapeForScript(options.runtime)}</script>
<script>
(function () {
  var report = function (message) {
    try { parent.postMessage({ source: "aurora-canvas", type: "error", message: String(message) }, "*"); } catch (e) {}
    var node = document.createElement("div");
    node.className = "canvas-crash";
    node.innerHTML = "<strong>This canvas stopped running</strong>";
    var detail = document.createElement("pre");
    detail.textContent = String(message);
    node.appendChild(detail);
    document.body.appendChild(node);
  };
  window.addEventListener("error", function (event) { report(event.message); });
  window.addEventListener("unhandledrejection", function (event) { report(event.reason); });

  // The allow-list from compileCanvasSource, enforced again at run time so a
  // require that somehow slipped through fails loudly instead of silently
  // yielding undefined.
  var modules = {
    "react": React,
    "react-dom": ReactDOM,
    "aurora/canvas": typeof AuroraCanvas === "undefined" ? {} : AuroraCanvas
  };
  function require(id) {
    if (Object.prototype.hasOwnProperty.call(modules, id)) return modules[id];
    throw new Error('Canvas cannot import "' + id + '".');
  }

  try {
    var module = { exports: {} };
    var exports = module.exports;
    (function (module, exports, require, React, ReactDOM) {
${escapeForScript(compiled.code)}
    })(module, exports, require, React, ReactDOM);

    var Component = module.exports && (module.exports.default || module.exports);
    if (typeof Component !== "function") {
      throw new Error("The canvas did not default-export a component function.");
    }
    ReactDOM.createRoot(document.getElementById("root")).render(
      React.createElement(React.StrictMode, null, React.createElement(Component))
    );
  } catch (error) {
    report(error && error.stack ? error.stack : error);
  }
})();
</script>
</body>
</html>`;
};
