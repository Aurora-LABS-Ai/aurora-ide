import { createRequire, } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { build, type Plugin } from "vite";

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

    /** Bundle local SDK modules, CSS and public exports from one library build.
     * React stays external and uses the sandbox's existing UMD runtime. */
    let sdkBuild: Promise<{ code: string; styles: string; names: string[] }> | undefined;
    const buildSdk = () => sdkBuild ??= (async () => {
        const result = await build({
            configFile: false,
            envFile: false,
            publicDir: false,
            logLevel: "error",
            oxc: { jsx: { runtime: "classic" } },
            css: { postcss: { plugins: [] } },
            build: {
                write: false,
                minify: false,
                target: "es2020",
                lib: { entry: fileURLToPath(sdkEntry), name: "AuroraCanvas", formats: ["iife"] },
                rolldownOptions: { external: ["react"], output: { globals: { react: "React" } } },
            },
        });
        const outputs = (Array.isArray(result) ? result : [result]).flatMap((output) => "output" in output ? output.output : []);
        const entry = outputs.find((output) => output.type === "chunk" && output.isEntry);
        if (!entry || entry.type !== "chunk") throw new Error("The canvas SDK build produced no entry chunk.");
        const styles = outputs.filter((output) => output.type === "asset" && output.fileName.endsWith(".css"))
            .map((output) => output.type === "asset" ? String(output.source) : "").join("\n");
        return { code: entry.code, styles, names: [...entry.exports].sort() };
    })();

    return {
        name: "aurora-canvas-runtime",
        resolveId(id) {
            if (id === VIRTUAL_ID) return RESOLVED_ID;
            if (id === EXPORTS_ID) return RESOLVED_EXPORTS_ID;
            return null;
        },
        async load(id) {
            if (id === RESOLVED_EXPORTS_ID) {
                return `export const CANVAS_EXPORTS = ${JSON.stringify((await buildSdk()).names)};`;
            }
            if (id !== RESOLVED_ID) return null;
            const sdk = await buildSdk();
            const runtime = [
                readUmd("react", "react.production.min.js"),
                readUmd("react-dom", "react-dom.production.min.js"),
                sdk.code,
            ].join("\n");
            return [
                `export const CANVAS_RUNTIME = ${JSON.stringify(runtime)};`,
                `export const CANVAS_STYLES = ${JSON.stringify(sdk.styles)};`,
                `export const CANVAS_FONTS = ${JSON.stringify(readFontFaces())};`,
            ].join("\n");
        },
        /** Editing the SDK must refresh open canvases, not just the window. */
        handleHotUpdate({ file, server }) {
            const sdkPath = fileURLToPath(sdkDir);
            if (!file.startsWith(sdkPath.replace(/\\/g, "/")) && !file.startsWith(sdkPath)) return;
            sdkBuild = undefined;
            for (const virtualId of [RESOLVED_ID, RESOLVED_EXPORTS_ID]) {
                const mod = server.moduleGraph.getModuleById(virtualId);
                if (mod) server.moduleGraph.invalidateModule(mod);
            }
            server.ws.send({ type: "full-reload" });
        },
    };
}
