import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import { auroraCanvasRuntime } from "./vite-canvas-plugin";

// https://vite.dev/config/
export default defineConfig({
    plugins: [react(), auroraCanvasRuntime()],

    // Mirrors tsconfig.app.json `paths` and vitest.config.ts `resolve.alias`.
    // All three must agree or `@/…` resolves in the editor and fails at build.
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
        },
    },

    build: {
        // Aurora ships as a Tauri desktop bundle — chunks are loaded
        // off the local disk, not the network, so large chunks are fine.
        //
        // Set just above the two chunks that legitimately exceed it, so a
        // NEW oversized chunk still trips the warning instead of hiding in
        // noise that fires on every build:
        //   ts.worker  ~6.6 MB — Monaco's bundled TypeScript compiler, run in
        //                        a web worker and only when a TS file opens.
        //                        It is the compiler; there is nothing to split.
        //   monaco     ~4.1 MB — its own manualChunk, loaded by the IDE
        //                        surface alone (see src/App.tsx).
        // Raise this only after checking WHICH chunk grew. If it is neither
        // of those two, the answer is a code split, not a bigger number.
        chunkSizeWarningLimit: 7000,

        // Vite 8 — Rolldown replaces Rollup, but the option key is renamed.
        // Plugin/output shape is Rollup-compatible, so the body is unchanged.
        rolldownOptions: {
            // Suppress mixed static/dynamic import warnings (intentional for Tauri)
            onwarn(warning, warn) {
                // Skip warnings about mixed imports - these are intentional
                if (
                    warning.code === "MIXED_EXPORTS" ||
                    warning.message?.includes("dynamically imported by") ||
                    warning.message?.includes("dynamic import will not move")
                ) {
                    return;
                }
                warn(warning);
            },

            output: {
                // Only split out the few genuinely-massive libraries that
                // benefit from their own chunk. Everything else stays in
                // Rollup's auto-split — manually carving up the React /
                // markdown / icon ecosystem caused circular-eval TDZ
                // crashes in release builds (Vite + manualChunks foot-gun:
                // chunk A holds a class, chunk B imports it but is
                // evaluated first → "Cannot access X before init"). Keep
                // this list conservative.
                manualChunks(id) {
                    if (!id.includes("node_modules")) return;

                    // Monaco editor (~2-3 MB parsed). Standalone — no
                    // shared deps with the rest of the app.
                    if (id.includes("monaco-editor")) return "monaco";

                    // XTerm terminal stack.
                    if (
                        id.includes("/@xterm/") ||
                        id.includes("/xterm/") ||
                        id.includes("\\@xterm\\") ||
                        id.includes("\\xterm\\")
                    ) {
                        return "xterm";
                    }

                    // Mermaid diagram engine (~1 MB+). Lazy-loaded by the
                    // markdown renderer.
                    if (id.includes("/mermaid/") || id.includes("\\mermaid\\")) {
                        return "mermaid";
                    }
                },
            },
        },

        // Vite 8: Oxc is the native minifier — drops the legacy esbuild
        // step from the pipeline and produces smaller output for ES2022.
        minify: "oxc",

        // Target modern browsers for smaller output
        target: "esnext",

        // Enable source maps only in dev
        sourcemap: false,
    },

    // Optimize dependencies
    optimizeDeps: {
        include: ["react", "react-dom", "zustand", "@monaco-editor/react"],
        // Where the dependency scanner is allowed to start.
        //
        // Left to itself it crawls every source file under the project root,
        // which includes `thirdparty/` — vendored copies of other agents
        // (opencode, claude-code-cli, …) that are here to be READ, never built.
        // Their imports resolve against their own workspaces, so the scan ended
        // every `tauri dev` with a page of "could not be resolved: solid-js,
        // @opencode-ai/ui, @sentry/solid …" and the line "Skipping dependency
        // pre-bundling". Nothing was broken — the app ran — but a warning that
        // names nine missing packages on every start reads exactly like a
        // failure, and it costs the pre-bundling it skipped.
        //
        // Naming the real entry points is the whole fix: Aurora is one HTML
        // page and one `src/` tree.
        entries: ["index.html", "src/**/*.{ts,tsx}"],
    },

    // Dev server config
    server: {
        // Aurora's own port, and it must stay in step with `devUrl` in
        // `src-tauri/tauri.conf.json`.
        //
        // Not Vite's 5173. `tauri dev` does not discover the dev server, it is
        // TOLD where to look — so when 5173 was already serving another Vite
        // app, Vite quietly moved Aurora to 5174 and Tauri opened a window
        // onto the other project. The app looked like it had been replaced.
        // 5273 is two digits off the family so it still reads as a dev server,
        // and nothing defaults to it.
        port: 5273,
        // The half that actually prevents the bug. Without it Vite treats a
        // busy port as a suggestion and slides to the next free one, while
        // `devUrl` stays pointed at the old number — so the failure is silent
        // and arrives as the wrong application. With it, a busy port is an
        // error before the window ever opens.
        strictPort: true,
        // The vendored agents are read by people and by the agent, never by
        // the bundler. Watching them costs file handles and wakes HMR for
        // edits that can never reach the app.
        watch: {
            ignored: ["**/thirdparty/**"],
        },
        proxy: {
            "/proxy/ollama": {
                target: "http://localhost:11434",
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/proxy\/ollama/, ""),
            },
            "/proxy/lmstudio": {
                target: "http://localhost:1234",
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/proxy\/lmstudio/, ""),
            },
        },
    },

    // Reduce console output
    logLevel: "warn",
});
