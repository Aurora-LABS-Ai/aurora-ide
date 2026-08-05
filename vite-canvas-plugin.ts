import { createRequire, } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { transformWithEsbuild, type Plugin } from "vite";

/**
 * `virtual:aurora-canvas-runtime` — the React UMD pair as one string.
 *
 * A live canvas (`react` artifact) runs in a sandboxed frame under
 * `default-src 'none'`, so its React has to be inlined into the document; it
 * cannot be fetched, not even from ourselves. The UMD builds are the ones that
 * attach `React` / `ReactDOM` as globals, which is what the frame's module
 * shim hands to the compiled component.
 *
 * They are read here rather than imported because `react-dom`'s `exports` field
 * does not publish `./umd/*` — importing that path is reaching around a
 * boundary the package deliberately drew. Resolving from `./package.json` (which
 * IS exported) keeps us on supported ground while still getting the file.
 *
 * React 19 stopped publishing UMD. If that upgrade happens this throws at build
 * time with the reason, instead of the canvas silently rendering nothing.
 */
export function auroraCanvasRuntime(): Plugin {
    const VIRTUAL_ID = "virtual:aurora-canvas-runtime";
    const RESOLVED_ID = `\0${VIRTUAL_ID}`;
    const EXPORTS_ID = "virtual:aurora-canvas-exports";
    const RESOLVED_EXPORTS_ID = `\0${EXPORTS_ID}`;
    const require = createRequire(import.meta.url);

    const readUmd = (pkg: string, file: string): string => {
        const root = dirname(require.resolve(`${pkg}/package.json`));
        const path = join(root, "umd", file);
        try {
            return readFileSync(path, "utf8");
        } catch (cause) {
            throw new Error(
                `Aurora canvases need the UMD build of ${pkg} at ${path}, and it is not there. ` +
                    `React 19+ no longer ships UMD — replace this with a prebuilt IIFE bundle of ` +
                    `react + react-dom/client and keep exposing the same two globals.`,
                { cause },
            );
        }
    };

    const sdkDir = new URL("./src/canvas-sdk/", import.meta.url);
    const sdkEntry = new URL("index.tsx", sdkDir);

    /**
     * The window's fonts, embedded in the canvas document.
     *
     * `@fontsource` registers its `@font-face` rules in the WINDOW's document.
     * A canvas is a separate document that inherits none of them, and its CSP
     * (`font-src data:`) blocks fetching the files even if it had the rules —
     * so `font-family: "Inter Variable"` simply failed and every canvas fell
     * through the stack to Segoe UI. Against an app rendered entirely in Inter
     * that reads as a different program embedded in the panel.
     *
     * Inlining as data URIs is the only route that keeps the no-network
     * guarantee intact. ~91 KB of woff2 for the Latin subsets, in the same
     * lazily-loaded chunk as the React runtime.
     */
    const readFontFaces = (): string => {
        const face = (
            pkg: string,
            file: string,
            family: string,
            weight: string,
        ): string => {
            const root = dirname(require.resolve(`${pkg}/package.json`));
            const data = readFileSync(join(root, "files", file)).toString("base64");
            return `@font-face{font-family:"${family}";font-style:normal;font-display:swap;font-weight:${weight};src:url(data:font/woff2;charset=utf-8;base64,${data}) format("woff2")}`;
        };
        return [
            face(
                "@fontsource-variable/inter",
                "inter-latin-wght-normal.woff2",
                "Inter Variable",
                "100 900",
            ),
            face(
                "@fontsource/jetbrains-mono",
                "jetbrains-mono-latin-400-normal.woff2",
                "JetBrains Mono",
                "400",
            ),
            face(
                "@fontsource/jetbrains-mono",
                "jetbrains-mono-latin-600-normal.woff2",
                "JetBrains Mono",
                "600",
            ),
        ].join("\n");
    };

    /**
     * `aurora/canvas`, transformed for the frame.
     *
     * The SDK is authored as ordinary TSX in `src/canvas-sdk/` so it
     * type-checks with the rest of the app. Here it is transformed to
     * CommonJS, which turns its `import … from "react"` into a `require`
     * call the wrapper below intercepts — the exact mechanism the agent's own
     * compiled canvas already goes through, rather than a second one. A
     * single file with one external import needs no bundler.
     *
     * `transformWithEsbuild` is deprecated in favour of `transformWithOxc`,
     * which CANNOT replace it here: oxc transforms syntax but does not convert
     * module format, so there is no CommonJS output to intercept. When the
     * esbuild helper is finally removed, the migration is to run this file
     * through Vite's own `build()` in library mode with `format: "iife"` and
     * `globalName: "AuroraCanvas"`, marking `react` external — same output,
     * real bundler. Nothing outside this function changes.
     */
    const buildSdk = async (): Promise<string> => {
        const source = readFileSync(sdkEntry, "utf8");
        const { code } = await transformWithEsbuild(source, "canvas-sdk/index.tsx", {
            loader: "tsx",
            format: "cjs",
            target: "es2020",
            jsx: "transform",
        });
        return `var AuroraCanvas = (function () {
  var module = { exports: {} };
  var exports = module.exports;
  function require(id) {
    if (id === "react") return React;
    throw new Error('aurora/canvas cannot import "' + id + '".');
  }
  (function (module, exports, require) {
${code}
  })(module, exports, require);
  return module.exports;
})();`;
    };

    /**
     * The SDK's export names, in their own module so the compile gate can
     * check an `import { Card } from "aurora/canvas"` without pulling 140 KB
     * of React text in behind it. Read from the source rather than maintained
     * by hand — a list that can drift is a list that will.
     */
    const readSdkExportNames = (): string[] => {
        const source = readFileSync(sdkEntry, "utf8");
        const names = new Set<string>();
        for (const match of source.matchAll(/^export (?:function|const) (\w+)/gm)) {
            names.add(match[1]);
        }
        return [...names].sort();
    };

    return {
        name: "aurora-canvas-runtime",
        resolveId(id) {
            if (id === VIRTUAL_ID) return RESOLVED_ID;
            if (id === EXPORTS_ID) return RESOLVED_EXPORTS_ID;
            return null;
        },
        async load(id) {
            if (id === RESOLVED_EXPORTS_ID) {
                return `export const CANVAS_EXPORTS = ${JSON.stringify(readSdkExportNames())};`;
            }
            if (id !== RESOLVED_ID) return null;
            const runtime = [
                readUmd("react", "react.production.min.js"),
                readUmd("react-dom", "react-dom.production.min.js"),
                await buildSdk(),
            ].join("\n");
            const styles = readFileSync(new URL("canvas.css", sdkDir), "utf8");
            return [
                `export const CANVAS_RUNTIME = ${JSON.stringify(runtime)};`,
                `export const CANVAS_STYLES = ${JSON.stringify(styles)};`,
                `export const CANVAS_FONTS = ${JSON.stringify(readFontFaces())};`,
            ].join("\n");
        },
        /** Editing the SDK must refresh open canvases, not just the window. */
        handleHotUpdate({ file, server }) {
            const sdkPath = fileURLToPath(sdkDir);
            if (!file.startsWith(sdkPath.replace(/\\/g, "/")) && !file.startsWith(sdkPath)) return;
            for (const virtualId of [RESOLVED_ID, RESOLVED_EXPORTS_ID]) {
                const mod = server.moduleGraph.getModuleById(virtualId);
                if (mod) server.moduleGraph.invalidateModule(mod);
            }
            server.ws.send({ type: "full-reload" });
        },
    };
}
